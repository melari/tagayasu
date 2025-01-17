import NDK, { NDKEvent, NDKRelay, NDKRelayStatus } from "@nostr-dev-kit/ndk";
import { delay } from "./common.js"

/**
 *  A low level cache of raw nostr events. These can belong to any user and will not be decrypted.
 *  Unlike Database, this cache is not persisted between page loads.
 */
export class Relay {
    // which tags are indexed in tagIndex
    // #d is not included since it is the primary index
    static INDEXED_TAGS = ['a'];
    static DELETE_EVENT_KIND = 5;

    // "kind:hexpubkey:dTag" => Note (singular)
    primaryIndex = {};

    // "kind:hexpubkey:tagKind:TagValue" => Set{"primaryKey1", ... }
    tagIndex = {};

    static instance = new Relay();
    constructor() {
        if (!!Relay.instance) { throw new Error('Use singletone instance'); }
    }

    async fetchEvent(filters) {
        return new Promise((resolve, reject) => {
            const cached = this.readByFilter(filters);
            if (cached.size > 0) {
                resolve(this.latest(cached));
            } else {
                window.ndk.fetchEvent(filters).then((event) => {
                    this.write(event);
                    resolve(event);
                });
            }
        });
    }

    async fetchEvents(filters) {
        return new Promise((resolve, reject) => {
            const cached = this.readByFilter(filters);
            if (cached.size > 0) {
                resolve(cached);
            } else {
                window.ndk.fetchEvents(filters).then((events) => {
                    events.forEach(e => this.write(e));
                    resolve(events);
                });
            }
        });
    }

    // subscribe does a combination of checking cache and external relays
    // cached results trigger the callback immediately but don't block pulling events from external relays.
    async subscribe(filters, callback, closeOnEose = true) {
        const subscription = await window.ndk.subscribe(filters, { closeOnEose: closeOnEose });
        subscription.on("event", async (event) => {
            this.write(event)
            callback(event);
        });

        const cached = this.readByFilter(filters);
        [...cached].forEach(event => callback(event));

        return subscription;
    }

    // Build & Publishes a note to all relays, and adds it to the local cache as well
    async buildAndPublish(kind, content, tags, hexpubkey) {
        const event = this.buildEvent(kind, content, tags, hexpubkey);
        return await this.publish(event);
    }

    // Publishes a note to all relays, and adds it to the local cache as well
    async publish(event) {
        if (event.kind !== Relay.DELETE_EVENT_KIND) {
            this.write(event);
        }

        return event.publish().then(_relaySet => event);
    }

    // Builds an unsigned NDKEvent
    buildEvent(kind, content, tags, hexpubkey) {
        if (hexpubkey && hexpubkey !== window.ndk.activeUser?.hexpubkey) {
            throw new Error('NDK is configured with an unexpected pubkey');
        }

        const event = new NDKEvent(window.ndk);
        event.kind = kind;
        event.content = content;
        event.tags = tags;
        event.pubkey = window.ndk.activeUser?.hexpubkey;
        event.id = event.getEventHash();

        return event;
    }

    // Publishes a kind 5 (delete request) event to relays,
    // and removes the event from the cache as well.
    // Returns a Promise that is fulfilled once the deletion event has been pushed to external relays
    async del(noteIds) {
        Object.keys(this.primaryIndex).forEach((dTag) => {
            if (noteIds.includes(this.primaryIndex[dTag].id)) {
                delete this.primaryIndex[dTag];
                Object.keys(this.tagIndex).forEach((tagIndexKey) => {
                    this.tagIndex[tagIndexKey].delete(dTag);
                });
            }
        });

        const tags = [];
        noteIds.forEach(noteId => tags.push(['e', noteId]));
        return this.buildAndPublish(Relay.DELETE_EVENT_KIND, 'This note has been deleted', tags);
    }

    write(note) {
        if (!note) { return; }

        const primaryKey = this.primaryIndexKey(note.kind, note.pubkey, note.dTag);
        if (note.dTag) {
            const existing = this.primaryIndex[primaryKey];
            if (!existing || existing.created_at < note.created_at) {
                this.primaryIndex[primaryKey] = note;
            }
        }

        note.tags.filter(t => Relay.INDEXED_TAGS.includes(t[0])).forEach(([tagKind, tagValue]) => {
            const tagKey = this.tagIndexKey(note.kind, note.pubkey, tagKind, tagValue);
            if (!this.tagIndex[tagKey]) { this.tagIndex[tagKey] = new Set(); }
            if (this.tagIndex[tagKey].has(primaryKey)) { return; }
            this.tagIndex[tagKey].add(primaryKey);
        });
    }

    // True if the relay is online, false otherwise.
    // If the relay requires auth, this returns true without attempting or requiring a successful auth.
    async getRelayStatus(url, timeout = 10000) {
        window.ndk.pool.addRelay(new NDKRelay(url, undefined, window.ndk), false);
        const relay = window.ndk.pool.relays.get(url);
        try { await relay.connect(timeout, false); } catch (e) {}

        const check_freq = 10; // we'll check for connection status every 10ms until timeout
        for (let i = 0; i < timeout / check_freq; i++) {
          await delay(check_freq)
          if (relay.connectivity.status >= NDKRelayStatus.CONNECTED) { return true; }
        }

        return false;
    }

    // Tries to load events from the cache using the filter. Not all possible
    // filters are supported. The expectation is to have:
    // - EXACTLY ONE hexpubkey
    // - ONE OR MORE kind
    // - EXACTLY ONE type of tag:
    //   - "#d" tag
    //   - other tag in INDEXED_TAGS
    // - ONE OR MORE values for the tag
    //
    // Example structure of nostr filter:
    // {
    //   #d: ['value', 'sha1234abcd'],
    //   authors: ['hexpubkey'],
    //   kinds: [30023, 31234]
    // }
    //
    // Performance: there will be one index lookup PER kind/tag pair
    // For the above example, we will 4 lookups:
    // [['value', 30023], ['value', 31234], ['sha1234abcd', 30023], ['sha1234abcd', 31234]]
    //
    // TODO: support conjunctive normal form to reduce lookups
    readByFilter(filter) {
        const supportedTags = ['#d', ...Relay.INDEXED_TAGS.map(t => `#${t}`)];
        const tagsGiven = supportedTags.filter(t => !!filter[t]);
        if (!filter.authors || !filter.kinds || tagsGiven.length !== 1) {
            return new Set();
        }

        const tagToUse = tagsGiven[0];

        if (filter.authors.length > 1) {
            return new Set();
        }

        const hexpubkey = filter.authors[0];
        const tagKind = tagToUse.slice(1);
        const tagValues = filter[tagToUse];
        const kinds = filter.kinds;

        const searchBranches = tagValues.flatMap(tagValue => kinds.map(kind => ({tagValue, kind})));

        return searchBranches.reduce((acc, { tagValue, kind }) => {
            const result = tagToUse === '#d'
                ? this.readPrimaryIndex(kind, hexpubkey, tagValue)
                : this.readTagIndex(kind, hexpubkey, tagKind, tagValue);
            for (const item of result) { acc.add(item); }
            return acc;
        }, new Set());
    }

    readPrimaryIndex(kind, hexpubkey, dTag) {
        const note = this.primaryIndex[this.primaryIndexKey(kind, hexpubkey, dTag)];
        if (!note) { return new Set(); }
        return new Set([note]);
    }

    readTagIndex(kind, hexpubkey, tagKind, tagValue) {
        const primaryKeys = this.tagIndex[this.tagIndexKey(kind, hexpubkey, tagKind, tagValue)];
        if (!primaryKeys) { return new Set(); }
        return new Set([...primaryKeys].map(k => this.primaryIndex[k]));
    }

    primaryIndexKey(kind, hexpubkey, dTag) {
        return `${kind}:${hexpubkey}:${dTag}`;
    }

    tagIndexKey(kind, hexpubkey, tagKind, tagValue) {
        return `${kind}:${hexpubkey}:${tagKind}/${tagValue}`;
    }

    latest(eventSet) {
        let result = undefined;
        for (const event of eventSet) {
            if (!result || event.created_at > result.created_at) {
                result = event;
            }
        }
        return result;
    }
}
window.Relay = Relay;
