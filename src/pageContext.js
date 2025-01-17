import { noteFilterFromIdentifier, npubToHexpubkey } from "./common.js";
import { Note } from "./note.js";

class PageContext {
    static NOTE_IN_FOCUS_CHANGED = "note-in-focus-changed";
    static NADDR_PARAM_NAME = "n";

    static instance = new PageContext();
    constructor() {
        if (!!PageContext.instance) { throw new Error('Use singleton instance'); }
    }

    get note() { return this._note; }
    setNote(note) { // note should be an instance of `Note`
        this._note = note;
        window.dispatchEvent(new Event(PageContext.NOTE_IN_FOCUS_CHANGED));
    }
    async setNoteByNostrEvent(event) {
        this.setNote(await Note.fromNostrEvent(event));
    }

    _dnslinkNpub = null;
    dnslinkNpub() {
        if (this._dnslinkNpub !== null) { return this._dnslinkNpub; }

        const npubFromDomain = window.router.dnslinkNpub;
        if (npubFromDomain === null || !npubFromDomain.startsWith('npub')) { this._dnslinkNpub = ''; }
        else { this._dnslinkNpub = npubFromDomain; }
        return this._dnslinkNpub;
    }

    dnslinkHexpubkey() {
        const npub = this.dnslinkNpub();
        return npub && npubToHexpubkey(npub);
    }

    noteFilterFromUrl() {
        return noteFilterFromIdentifier(this.noteIdentifierFromUrl());
    }

    noteIdentifierFromUrl() {
        return this._urlParam(PageContext.NADDR_PARAM_NAME);
    }

    noteTitleFromUrl() {
        const filter = this.noteFilterFromUrl();
        if (!filter) { return ''; }
        return filter["#d"][0];
    }

    _urlParam(name) {
        if (window.router.inlineParams[name]) { return window.router.inlineParams[name]; }
        var results = new RegExp('[\?&]' + name + '=([^&#]*)').exec(window.location.href);
        if (results==null) {
          return null;
        }
        return decodeURI(results[1]) || 0;
    }
}
window.PageContext = PageContext;
