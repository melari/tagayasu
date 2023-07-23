/**
 * /<page name>/...  always overrides to that page
 * 
 * Otherwise a default page is chosen based on the environment:
 * 1) If we're on a known editor domain, go to the editor
 * 2) If there is a npub TXT record on the domain, go to the browser
 * 3) If there's no npub, show the dnslink help page
 */

class Router {
    editorDomains = [
        'app.tagayasu.xyz',
        'melari-organic-goggles-g4q45x579r2v4w6-8080.app.github.dev'
    ];

    static EDITOR = 'editor';
    static BROWSER = 'browser';
    static DNSLINK_HELP = 'dnslinkHelp';
    static ALL_PAGES = [Router.EDITOR, Router.BROWSER, Router.DNSLINK_HELP];

    _pageName = null;
    get pageName() {
        if (!!this._pageName) { return this._pageName; }
        throw new Error('Call route() first');
    }

    _defaultPageName = null;
    get defaultPageName() {
        if (!!this._defaultPageName) { return this._defaultPageName; }
        throw new Error('call route() first');
    }

    _inlineParams = null;
    get inlineParams() {
        if (!!this._inlineParams) { return this._inlineParams; }
        throw new Error('call route() first');
    }

    async route() {
        if (this.editorDomains.includes(window.location.hostname)) {
            this._defaultPageName = Router.EDITOR;
        } else if (!!(await PageContext.instance.dnslinkNpub())) {
            this._defaultPageName = Router.BROWSER;
        } else {
            this._defaultPageName = Router.DNSLINK_HELP;
        }

        const urlParts = window.location.pathname.split('/').filter(x => x);
        if (Router.ALL_PAGES.includes(urlParts[0])) {
            this._pageName = urlParts[0];
            this._parseInlineParams(this._pageName, urlParts.slice(1));
            return this;
        }
        
        this._pageName = this._defaultPageName;
        this._parseInlineParams(this._pageName, urlParts);
        return this;
    }

    urlFor(pageName, postFix) {
        if (!Router.ALL_PAGES.includes(pageName)) {
            throw new Error(pageName + " is not a valid page");
        }

        const postFixWithSlash = postFix.startsWith("/") ? postFix : "/" + postFix;
        if (pageName == this.defaultPageName) {
            return window.location.origin + postFixWithSlash;
        } else {
            return window.location.origin + "/" + pageName + postFixWithSlash;
        }
    }

    _parseInlineParams(pageName, urlParts) {
        this._inlineParams = {};
        this._inlineParams[PageContext.NADDR_PARAM_NAME] = urlParts[0];
    }
}
window.Router = Router;