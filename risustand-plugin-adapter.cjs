'use strict';
/**
 * RisuStand Backend Plugin Adapter (RisuAI API v3.0 Host & Sandboxed GUI Bridge)
 *
 * Executes installed/uploaded RisuAI API v3 plugins inside the relay server using
 * RisuAI's real hooks (`beforeRequest`, `afterRequest`, `chatOutput`, `editinput`,
 * `editprocess`, `editoutput`, `bodyIntercepter`) without relying on `sendChat()`.
 *
 * Storage & DB operations proxy directly through PC RisuAI's shared `pluginStorage`,
 * `safeLocalStorage`, `getLocalPluginStorage()`, and `DB` (`dbWrite`) via fast Host RPC
 * so data created remotely is immediately usable natively inside RisuAI and vice versa.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const {
    CompressionStream,
    DecompressionStream,
    ReadableStream,
    WritableStream,
    TransformStream,
} = require('stream/web');

function toHostUint8View(v) {
    if (!v) return new Uint8Array(0);
    if (v instanceof Uint8Array) return v;
    if (Buffer.isBuffer(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (ArrayBuffer.isView(v) || (typeof v === 'object' && typeof v.byteLength === 'number' && v.buffer && typeof v.buffer.byteLength === 'number')) {
        return new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength);
    }
    if (v instanceof ArrayBuffer || (typeof v === 'object' && typeof v.byteLength === 'number' && typeof v.slice === 'function')) {
        return new Uint8Array(v);
    }
    return new Uint8Array(0);
}

function createSandboxCrypto() {
    const rawSubtle = crypto.webcrypto && crypto.webcrypto.subtle;
    const normAlgo = (alg) => {
        if (!alg || typeof alg !== 'object') return alg;
        const copy = { ...alg };
        for (const k of ['iv', 'additionalData', 'salt', 'counter', 'label', 'info']) {
            if (copy[k] && typeof copy[k] === 'object' && typeof copy[k].byteLength === 'number') {
                copy[k] = toHostUint8View(copy[k]);
            }
        }
        return copy;
    };
    const subtle = rawSubtle ? {
        digest: (alg, data) => rawSubtle.digest(normAlgo(alg), toHostUint8View(data)),
        importKey: (fmt, keyData, alg, extractable, usages) => rawSubtle.importKey(
            fmt,
            isBinaryLike(keyData) ? toHostUint8View(keyData) : keyData,
            normAlgo(alg),
            extractable,
            usages
        ),
        exportKey: (fmt, key) => rawSubtle.exportKey(fmt, key),
        sign: (alg, key, data) => rawSubtle.sign(normAlgo(alg), key, toHostUint8View(data)),
        verify: (alg, key, sig, data) => rawSubtle.verify(normAlgo(alg), key, toHostUint8View(sig), toHostUint8View(data)),
        encrypt: (alg, key, data) => rawSubtle.encrypt(normAlgo(alg), key, toHostUint8View(data)),
        decrypt: (alg, key, data) => rawSubtle.decrypt(normAlgo(alg), key, toHostUint8View(data)),
        deriveBits: (alg, baseKey, len) => rawSubtle.deriveBits(normAlgo(alg), baseKey, len),
        deriveKey: (alg, baseKey, derivedAlg, extractable, usages) => rawSubtle.deriveKey(normAlgo(alg), baseKey, normAlgo(derivedAlg), extractable, usages),
        generateKey: (alg, extractable, usages) => rawSubtle.generateKey(normAlgo(alg), extractable, usages),
        wrapKey: (fmt, key, wrapKey, alg) => rawSubtle.wrapKey(fmt, key, wrapKey, normAlgo(alg)),
        unwrapKey: (fmt, wrapped, unwrapKey, unwrapAlg, unwrappedAlg, extractable, usages) => rawSubtle.unwrapKey(fmt, toHostUint8View(wrapped), unwrapKey, normAlgo(unwrapAlg), normAlgo(unwrappedAlg), extractable, usages),
    } : undefined;

    return {
        subtle,
        randomUUID: () => crypto.randomUUID(),
        getRandomValues: (typedArr) => {
            if (!typedArr || typeof typedArr.byteLength !== 'number') {
                throw new TypeError('Failed to execute getRandomValues on Crypto: argument is not an ArrayBufferView');
            }
            const len = typedArr.byteLength;
            if (len > 0) {
                const tmp = crypto.randomBytes(len);
                const view = toHostUint8View(typedArr);
                if (view.byteLength === len) {
                    view.set(tmp);
                } else {
                    for (let i = 0; i < Math.min(len, typedArr.length || len); i += 1) {
                        typedArr[i] = tmp[i];
                    }
                }
            }
            return typedArr;
        },
    };
}

const URL_BLACKLIST = Object.freeze(['risuai.xyz', 'risuai.net', 'sionyw.com']);

function cloneJson(val) {
    if (val === undefined || val === null) return val;
    if (typeof val !== 'object') return val;
    return JSON.parse(JSON.stringify(val));
}

function isBinaryLike(v) {
    if (!v || typeof v !== 'object') return false;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return true;
    const tag = Object.prototype.toString.call(v);
    if (tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') return true;
    return typeof v.byteLength === 'number' && v.buffer && typeof v.buffer.byteLength === 'number';
}

function toNodeBuffer(v) {
    if (!v) return Buffer.alloc(0);
    if (Buffer.isBuffer(v)) return v;
    if (ArrayBuffer.isView(v) || (typeof v === 'object' && typeof v.byteLength === 'number' && v.buffer && typeof v.buffer.byteLength === 'number')) {
        return Buffer.from(v.buffer, v.byteOffset || 0, v.byteLength);
    }
    if (v instanceof ArrayBuffer || Object.prototype.toString.call(v) === '[object ArrayBuffer]') {
        return Buffer.from(v);
    }
    if (typeof v === 'object' && typeof v.__b64 === 'string') {
        return Buffer.from(String(v.__b64).replace(/\s+/g, ''), 'base64');
    }
    if (typeof v === 'string') {
        const m = v.match(/^data:[^;]+;base64,([\s\S]+)$/i);
        if (m) return Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
        return Buffer.from(v, 'utf8');
    }
    return Buffer.alloc(0);
}

function detectImageMimeFromBuf(buf) {
    if (buf && buf.length >= 12) {
        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
        if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
        if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
        if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
        if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'image/avif';
    }
    return 'image/png';
}

function parsePluginHeader(sourceText, fallbackName = '') {
    const text = String(sourceText || '');
    const head = text.slice(0, 32768);
    let name = '';
    let displayName = '';
    let apiVersion = '3.0';
    let version = '';
    let link = '';
    const allowedIPC = [];
    const argDefs = [];

    for (const rawLine of head.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith('//@')) continue;
        const body = line.slice(3).trim();
        const m = body.match(/^([^\s]+)(?:\s+([\s\S]*))?$/);
        if (!m) continue;
        const directive = m[1].toLowerCase();
        const rest = String(m[2] || '').trim();
        if (directive === 'name' && !name) {
            name = rest;
        } else if (directive === 'display-name' && !displayName) {
            displayName = rest;
        } else if (directive === 'api') {
            apiVersion = rest || '3.0';
        } else if ((directive === 'version' || directive === 'plugin-version') && !version) {
            version = rest;
        } else if (directive === 'link' && !link) {
            link = rest;
        } else if (directive === 'allowed-ipc') {
            for (const peer of rest.split(/\s+/)) {
                if (peer) allowedIPC.push(peer);
            }
        } else if (directive === 'arg' || directive === 'risu-arg') {
            const am = rest.match(/^(\S+)\s+(int|string)(?:\s+([\s\S]*))?$/i);
            if (am) {
                const rawKey = am[1].trim();
                const cleanKey = rawKey.includes('::') ? rawKey.split('::').slice(1).join('::') : rawKey;
                const argType = am[2].toLowerCase() === 'int' ? 'int' : 'string';
                const description = String(am[3] || '').trim();
                let defaultValue = argType === 'int' ? 0 : '';
                const meta = {};
                // Check inline hints used by Librarian / RisuAI plugins (optional default=...)
                const blankMatch = description.match(/blank uses ([^;.\n]+)/i);
                if (blankMatch && argType === 'string') {
                    meta.placeholder = blankMatch[1].trim();
                }
                argDefs.push({ key: cleanKey, type: argType, description, defaultValue, ...meta });
            }
        }
    }

    const baseFallback = String(fallbackName || '')
        .replace(/\.[a-z0-9]+$/i, '')
        .replace(/[^a-zA-Z0-9_.-]/g, '_');
    const resolvedName = String(name || baseFallback || `plugin_${crypto.randomBytes(4).toString('hex')}`).trim();
    return {
        name: resolvedName,
        displayName: displayName || resolvedName,
        apiVersion,
        version: version || '0.0.0',
        link,
        allowedIPC: Array.from(new Set(allowedIPC)),
        args: argDefs,
    };
}

function checkUrlAllowed(rawUrl) {
    const parsed = new URL(String(rawUrl || ''), 'http://127.0.0.1');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
    }
    const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
    for (const blocked of URL_BLACKLIST) {
        if (hostname === blocked || hostname.endsWith(`.${blocked}`)) {
            throw new Error(`Requests to ${blocked} are blocked by RisuAI plugin security policy.`);
        }
    }
    return parsed;
}

function attrNameToDatasetKey(attrName) {
    return String(attrName || '')
        .replace(/^data-/i, '')
        .replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function parseAttributesFromHtml(html) {
    const attrs = new Map();
    const s = String(html || '').trim();
    const openMatch = s.match(/^<([a-zA-Z0-9_-]+)([\s\S]*?)(?:\/?>|$)/);
    if (!openMatch) return { tagName: 'button', attrs };
    const tagName = openMatch[1].toLowerCase();
    const rawAttrStr = openMatch[2] || '';
    const rx = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let m;
    while ((m = rx.exec(rawAttrStr)) !== null) {
        const k = m[1];
        const v = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : ''));
        attrs.set(k, v);
    }
    return { tagName, attrs };
}

function createHeadlessMockDom() {
    function matchSimpleSelector(el, token) {
        if (!el || el.nodeType !== 1 || !token) return false;
        let rest = token.trim();
        if (!rest) return false;
        if (rest === '*') return true;

        const tagMatch = rest.match(/^([a-zA-Z0-9_-]+)/);
        if (tagMatch) {
            if (el.tagName !== tagMatch[1].toUpperCase()) return false;
            rest = rest.slice(tagMatch[1].length);
        }

        while (rest.length > 0) {
            if (rest.startsWith('#')) {
                const m = rest.match(/^#([a-zA-Z0-9_-]+)/);
                if (!m || el.id !== m[1]) return false;
                rest = rest.slice(m[0].length);
            } else if (rest.startsWith('.')) {
                const m = rest.match(/^\.([a-zA-Z0-9_-]+)/);
                if (!m || !el.classList || !el.classList.contains(m[1])) return false;
                rest = rest.slice(m[0].length);
            } else if (rest.startsWith('[')) {
                const m = rest.match(/^\[([a-zA-Z0-9_:-]+)(?:\s*([*^$|~]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/);
                if (!m) return false;
                const aName = m[1];
                const op = m[2] || '';
                const expected = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : (m[5] !== undefined ? m[5].trim() : ''));
                const actual = el.attributes && el.attributes.has(aName) ? el.attributes.get(aName) : null;
                if (actual === null) return false;
                if (op === '=' && actual !== expected) return false;
                if (op === '*=' && !actual.includes(expected)) return false;
                if (op === '^=' && !actual.startsWith(expected)) return false;
                if (op === '$=' && !actual.endsWith(expected)) return false;
                rest = rest.slice(m[0].length);
            } else {
                return false;
            }
        }
        return true;
    }

    function matchSingleChain(el, chainStr) {
        const parts = String(chainStr || '').trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return false;
        if (!matchSimpleSelector(el, parts[parts.length - 1])) return false;
        let cur = el.parentNode;
        for (let i = parts.length - 2; i >= 0; i -= 1) {
            while (cur && !matchSimpleSelector(cur, parts[i])) {
                cur = cur.parentNode;
            }
            if (!cur) return false;
            cur = cur.parentNode;
        }
        return true;
    }

    function matchesSelector(el, selectorList) {
        const chains = String(selectorList || '').split(',').map((s) => s.trim()).filter(Boolean);
        return chains.some((ch) => matchSingleChain(el, ch));
    }

    const listeners = new Map();
    let seq = 0;
    const elementListeners = new WeakMap();

    class MockElement {
        constructor(tagName = 'div') {
            this.tagName = String(tagName || 'div').toUpperCase();
            this.nodeName = this.tagName;
            this.nodeType = 1;
            this.id = '';
            this.className = '';
            this.style = new Proxy({}, { set: () => true, get: () => '' });
            this.dataset = {};
            this.attributes = new Map();
            this.children = [];
            this.childNodes = this.children;
            this.parentNode = null;
            this.parentElement = null;
            this._innerHTML = '';
            this._outerHTMLOverride = '';
            this._textContent = '';
            this._rect = { top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 };
            this.value = '';
            this.checked = false;
            this.disabled = false;
            const self = this;
            this.classList = {
                add: (...cls) => {
                    const set = new Set(String(self.className || '').split(/\s+/).filter(Boolean));
                    for (const c of cls) set.add(String(c));
                    self.className = Array.from(set).join(' ');
                },
                remove: (...cls) => {
                    const set = new Set(String(self.className || '').split(/\s+/).filter(Boolean));
                    for (const c of cls) set.delete(String(c));
                    self.className = Array.from(set).join(' ');
                },
                contains: (c) => String(self.className || '').split(/\s+/).includes(String(c)),
                toggle: (c, force) => {
                    const has = self.classList.contains(c);
                    const next = force === undefined ? !has : Boolean(force);
                    if (next) self.classList.add(c);
                    else self.classList.remove(c);
                    return next;
                },
            };
        }
        get innerHTML() { return this._innerHTML; }
        set innerHTML(v) { this._innerHTML = String(v ?? ''); }
        get outerHTML() {
            if (this._outerHTMLOverride) return this._outerHTMLOverride;
            const tag = this.tagName.toLowerCase();
            const attrPairs = [];
            if (this.id && !this.attributes.has('id')) attrPairs.push(`id="${this.id}"`);
            if (this.className && !this.attributes.has('class')) attrPairs.push(`class="${this.className}"`);
            for (const [k, v] of this.attributes.entries()) {
                const escaped = String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
                attrPairs.push(v === '' ? `${k}=""` : `${k}="${escaped}"`);
            }
            const open = attrPairs.length ? `<${tag} ${attrPairs.join(' ')}>` : `<${tag}>`;
            return `${open}${this._innerHTML || this._textContent || ''}</${tag}>`;
        }
        get textContent() { return this._textContent; }
        set textContent(v) { this._textContent = String(v ?? ''); }
        async setInnerHTML(v) { this._innerHTML = String(v ?? ''); }
        async getInnerHTML() { return this._innerHTML; }
        async getOuterHTML() { return this.outerHTML; }
        async setOuterHTML(v) { this._outerHTMLOverride = String(v ?? ''); }
        async setTextContent(v) { this._textContent = String(v ?? ''); }
        async getTextContent() { return this._textContent; }
        async setStyle() {}
        async getStyle() { return ''; }
        async setClassName(v) { this.className = String(v ?? ''); }
        async getClassName() { return this.className; }
        async addClass(c) { this.classList.add(c); }
        async removeClass(c) { this.classList.remove(c); }
        async hasClass(c) { return this.classList.contains(c); }
        setAttribute(k, v) {
            const key = String(k);
            const val = String(v ?? '');
            this.attributes.set(key, val);
            if (key === 'id') this.id = val;
            if (key === 'class') this.className = val;
            if (key.startsWith('data-')) this.dataset[attrNameToDatasetKey(key)] = val;
        }
        getAttribute(k) { return this.attributes.has(String(k)) ? this.attributes.get(String(k)) : null; }
        removeAttribute(k) {
            const key = String(k);
            this.attributes.delete(key);
            if (key.startsWith('data-')) delete this.dataset[attrNameToDatasetKey(key)];
        }
        appendChild(ch) {
            if (ch && typeof ch === 'object') {
                ch.parentNode = this;
                ch.parentElement = this;
                this.children.push(ch);
            }
            return ch;
        }
        prepend(ch) {
            if (ch && typeof ch === 'object') {
                ch.parentNode = this;
                ch.parentElement = this;
                this.children.unshift(ch);
            }
        }
        removeChild(ch) {
            const idx = this.children.indexOf(ch);
            if (idx >= 0) {
                this.children.splice(idx, 1);
                ch.parentNode = null;
                ch.parentElement = null;
            }
            return ch;
        }
        remove() {
            if (this.parentNode && typeof this.parentNode.removeChild === 'function') {
                this.parentNode.removeChild(this);
            }
        }
        contains(target) {
            if (target === this) return true;
            return this.children.some((c) => typeof c.contains === 'function' && c.contains(target));
        }
        closest(sel) {
            let cur = this;
            while (cur && cur.nodeType === 1) {
                if (matchesSelector(cur, sel)) return cur;
                cur = cur.parentNode;
            }
            return null;
        }
        querySelector(sel) {
            const walk = (node) => {
                for (const c of node.children || []) {
                    if (c.nodeType === 1) {
                        if (matchesSelector(c, sel)) return c;
                        const sub = walk(c);
                        if (sub) return sub;
                    }
                }
                return null;
            };
            return walk(this);
        }
        querySelectorAll(sel) {
            const out = [];
            const walk = (node) => {
                for (const c of node.children || []) {
                    if (c.nodeType === 1) {
                        if (matchesSelector(c, sel)) out.push(c);
                        walk(c);
                    }
                }
            };
            walk(this);
            return out;
        }
        addEventListener(ev, fn) {
            if (typeof fn !== 'function') return '';
            const id = `el-ev-${++seq}`;
            let map = elementListeners.get(this);
            if (!map) {
                map = new Map();
                elementListeners.set(this, map);
            }
            map.set(id, { ev: String(ev), fn });
            return id;
        }
        removeEventListener(ev, idOrFn) {
            const map = elementListeners.get(this);
            if (!map) return;
            map.delete(idOrFn);
            for (const [k, v] of map.entries()) {
                if (v.ev === ev && v.fn === idOrFn) map.delete(k);
            }
        }
        async dispatchEvent(evObj) {
            const map = elementListeners.get(this);
            const evName = String((evObj && evObj.type) || '');
            if (map) {
                for (const rec of [...map.values()]) {
                    if (rec.ev === evName) await rec.fn(evObj);
                }
            }
            return true;
        }
        focus() {}
        blur() {}
        async click() {
            const rect = await this.getBoundingClientRect();
            const x = (rect.left || 0) + Math.min(10, Math.floor((rect.width || 20) / 2));
            const y = (rect.top || 0) + Math.min(10, Math.floor((rect.height || 20) / 2));
            await dispatchSurfaceClick(this, x, y);
        }
        getBoundingClientRect() { return { ...this._rect }; }
    }

    const head = new MockElement('head');
    const body = new MockElement('body');
    const chatScreen = new MockElement('div');
    chatScreen.className = 'default-chat-screen rs-chat-surface';
    chatScreen._rect = { top: 0, left: 0, right: 1024, bottom: 900, width: 1024, height: 900 };
    body.appendChild(chatScreen);

    const documentElement = new MockElement('html');
    documentElement.appendChild(head);
    documentElement.appendChild(body);

    async function dispatchDocListeners(type, eventObj) {
        const list = [...listeners.values()].filter((v) => v.ev === type);
        for (const rec of list) {
            await rec.fn(eventObj);
        }
    }

    async function dispatchSurfaceClick(targetEl, x = 24, y = 24) {
        const makeEv = (type) => ({
            type,
            clientX: x,
            clientY: y,
            pageX: x,
            pageY: y,
            button: 0,
            buttons: type === 'mousedown' ? 1 : 0,
            target: targetEl,
            currentTarget: documentElement,
            defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() {},
            stopImmediatePropagation() {},
        });
        const downEv = makeEv('mousedown');
        await dispatchDocListeners('mousedown', downEv);
        if (targetEl && typeof targetEl.dispatchEvent === 'function') {
            await targetEl.dispatchEvent(downEv);
        }
        const clickEv = makeEv('click');
        await dispatchDocListeners('click', clickEv);
        if (targetEl && typeof targetEl.dispatchEvent === 'function') {
            await targetEl.dispatchEvent(clickEv);
        }
        return true;
    }

    function mountSurfaceActionElement(actionHtml, dataset = {}) {
        const parsed = parseAttributesFromHtml(actionHtml);
        const el = new MockElement(parsed.tagName || 'button');
        for (const [k, v] of parsed.attrs.entries()) {
            el.setAttribute(k, v);
        }
        if (dataset && typeof dataset === 'object') {
            for (const [k, v] of Object.entries(dataset)) {
                const attrName = k.startsWith('data-')
                    ? k
                    : `data-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
                el.setAttribute(attrName, String(v ?? ''));
            }
        }
        el._rect = { top: 10, left: 10, right: 180, bottom: 50, width: 170, height: 40 };
        chatScreen.appendChild(el);
        return el;
    }

    const doc = {
        nodeType: 9,
        documentElement,
        head,
        body,
        createElement: async (tag) => new MockElement(tag),
        createTextNode: async (txt) => ({ nodeType: 3, textContent: String(txt ?? ''), data: String(txt ?? '') }),
        getElementById: async (id) => documentElement.querySelector(`#${id}`),
        querySelector: async (sel) => documentElement.querySelector(sel),
        querySelectorAll: async (sel) => documentElement.querySelectorAll(sel),
        addEventListener: async (ev, fn, opts) => {
            const id = `doc-ev-${++seq}`;
            listeners.set(id, { ev: String(ev), fn, opts: opts || false });
            return id;
        },
        removeEventListener: async (ev, idOrFn) => {
            listeners.delete(idOrFn);
            for (const [k, v] of listeners.entries()) {
                if (v.ev === ev && v.fn === idOrFn) listeners.delete(k);
            }
        },
    };
    const syncDoc = {
        ...doc,
        createElement: (tag) => new MockElement(tag),
        createTextNode: (txt) => ({ nodeType: 3, textContent: String(txt ?? ''), data: String(txt ?? '') }),
        getElementById: (id) => documentElement.querySelector(`#${id}`),
        querySelector: (sel) => documentElement.querySelector(sel),
        querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
        addEventListener: (ev, fn, opts) => {
            const id = `doc-ev-${++seq}`;
            listeners.set(id, { ev: String(ev), fn, opts: opts || false });
            return id;
        },
        removeEventListener: (ev, idOrFn) => {
            listeners.delete(idOrFn);
            for (const [k, v] of listeners.entries()) {
                if (v.ev === ev && v.fn === idOrFn) listeners.delete(k);
            }
        },
    };
    return {
        asyncDoc: doc,
        syncDoc,
        MockElement,
        chatScreen,
        dispatchSurfaceClick,
        mountSurfaceActionElement,
        getListenerCount: () => listeners.size,
    };
}

/**
 * Generates an isolated sandboxed iframe HTML (`srcdoc`) that implements RisuAI API v3
 * for rendering a plugin's real native GUI (`registerSetting` / `registerButton` / `getRootDocument`).
 */
function buildPluginGuiSrcdoc({ plugin, entryId = '', theme = 'dark' }) {
    const pName = String((plugin && plugin.name) || '');
    const pScript = String((plugin && plugin.script) || '');
    const pUiItems = Array.isArray(plugin && plugin.uiItems) ? plugin.uiItems : [];
    const safeScriptJson = JSON.stringify(pScript).replace(/<\//g, '<\\/');
    const safeMetaJson = JSON.stringify({
        name: pName,
        displayName: String((plugin && plugin.displayName) || pName),
        entryId: String(entryId || ''),
        knownUiItems: pUiItems,
        theme: theme === 'light' ? 'light' : 'dark',
    }).replace(/<\//g, '<\\/');

    return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root {
    color-scheme: ${theme === 'light' ? 'light' : 'dark'};
    --bg: ${theme === 'light' ? '#ffffff' : '#0f172a'};
    --text: ${theme === 'light' ? '#1b1c1d' : '#e2e8f0'};
  }
  html, body {
    margin: 0;
    padding: 0;
    min-height: 100%;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Malgun Gothic", sans-serif;
  }
  #__rs_boot_state {
    padding: 20px;
    font-size: 13px;
    opacity: 0.72;
  }
</style>
</head>
<body>
<div id="__rs_boot_state">플러그인 GUI를 불러오는 중...</div>
<script id="__rs_meta" type="application/json">${safeMetaJson}</script>
<script id="__rs_plugin_code" type="application/json">${safeScriptJson}</script>
<script>
(function() {
  const meta = JSON.parse(document.getElementById('__rs_meta').textContent || '{}');
  const pluginCode = JSON.parse(document.getElementById('__rs_plugin_code').textContent || '""');
  let rpcSeq = 0;
  const pendingRpc = new Map();

  function rpcCall(method, args) {
    return new Promise((resolve, reject) => {
      const reqId = 'gui_' + (++rpcSeq) + '_' + Date.now();
      const timer = setTimeout(() => {
        pendingRpc.delete(reqId);
        reject(new Error('GUI RPC timeout: ' + method));
      }, 45000);
      pendingRpc.set(reqId, { resolve, reject, timer });
      window.parent.postMessage({
        __rsGuiRpc: 1,
        reqId,
        pluginName: meta.name,
        method,
        args: Array.isArray(args) ? args : [],
      }, '*');
    });
  }

  window.addEventListener('message', (ev) => {
    const d = ev && ev.data;
    if (!d || typeof d !== 'object') return;
    if (d.__rsGuiRpcRes === 1 && d.reqId && pendingRpc.has(d.reqId)) {
      const p = pendingRpc.get(d.reqId);
      pendingRpc.delete(d.reqId);
      clearTimeout(p.timer);
      if (d.ok) p.resolve(d.value);
      else p.reject(new Error(d.error || 'RPC error'));
      return;
    }
    if (d.__rsGuiInvokeEntry === 1) {
      invokeEntry(d.entryId || '');
      return;
    }
    if (d.__rsGuiChannelDeliver === 1 && d.channel) {
      const fn = channelListeners.get(String(d.channel));
      if (typeof fn === 'function') {
        try { fn(d.message, { sender: String(d.sender || ''), channel: String(d.channel) }); } catch (e) { console.error(e); }
      }
    }
  });

  // RisuAI SafeElement / SafeDocument compatibility helpers on DOM prototypes
  try {
    const ep = Element.prototype;
    if (!ep.setInnerHTML) ep.setInnerHTML = async function(v) { this.innerHTML = String(v ?? ''); };
    if (!ep.getInnerHTML) ep.getInnerHTML = async function() { return this.innerHTML; };
    if (!ep.setTextContent) ep.setTextContent = async function(v) { this.textContent = String(v ?? ''); };
    if (!ep.getTextContent) ep.getTextContent = async function() { return this.textContent; };
    if (!ep.setStyle) ep.setStyle = async function(k, v) { this.style[k] = String(v ?? ''); };
    if (!ep.getStyle) ep.getStyle = async function(k) { return this.style[k] || ''; };
    if (!ep.setClassName) ep.setClassName = async function(v) { this.className = String(v ?? ''); };
    if (!ep.getClassName) ep.getClassName = async function() { return this.className; };
    if (!ep.addClass) ep.addClass = async function() { this.classList.add.apply(this.classList, arguments); };
    if (!ep.removeClass) ep.removeClass = async function() { this.classList.remove.apply(this.classList, arguments); };
    if (!ep.hasClass) ep.hasClass = async function(c) { return this.classList.contains(c); };
    if (!ep.getValue) ep.getValue = async function() { return this.value; };
    if (!ep.setValue) ep.setValue = async function(v) { this.value = String(v ?? ''); };
    if (!ep.getChecked) ep.getChecked = async function() { return Boolean(this.checked); };
    if (!ep.setChecked) ep.setChecked = async function(v) { this.checked = Boolean(v); };
  } catch (_) {}

  const uiRegistry = [];
  const channelListeners = new Map();
  let uiSeq = 0;
  let invokerTimer = null;
  let autoOpened = false;

  function reportUiItems() {
    window.parent.postMessage({
      __rsGuiItems: 1,
      pluginName: meta.name,
      items: uiRegistry.map((u) => ({
        id: u.id,
        name: u.name,
        kind: u.kind,
        location: u.location || '',
        icon: u.icon || '',
        iconType: u.iconType || 'none',
      })),
    }, '*');
  }

  async function invokeEntry(targetId) {
    const pick = targetId
      ? uiRegistry.find((u) => u.id === targetId || u.name === targetId)
      : (uiRegistry[0] || null);
    if (!pick || typeof pick.callback !== 'function') return false;
    const boot = document.getElementById('__rs_boot_state');
    if (boot) boot.remove();
    autoOpened = true;
    try {
      await pick.callback();
    } catch (e) {
      const box = document.createElement('pre');
      box.style.cssText = 'margin:16px;padding:12px;border-radius:10px;background:#450a0a;color:#fecaca;white-space:pre-wrap;font-size:12px;';
      box.textContent = 'GUI 실행 오류: ' + (e && e.stack ? e.stack : String(e));
      document.body.appendChild(box);
    }
    return true;
  }

  function scheduleAutoOpen() {
    if (invokerTimer) clearTimeout(invokerTimer);
    invokerTimer = setTimeout(() => {
      if (autoOpened) return;
      if (uiRegistry.length) {
        invokeEntry(meta.entryId);
      } else {
        const boot = document.getElementById('__rs_boot_state');
        if (boot) {
          boot.textContent = '이 플러그인은 별도의 GUI 설정 화면(registerSetting/registerButton)을 등록하지 않았습니다.';
        }
      }
    }, 350);
  }

  function decodeBase64ToBytes(b64) {
    const bin = atob(String(b64 || ''));
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  function encodeBytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function packAssetArg(data) {
    if (data instanceof Uint8Array) return { __b64: encodeBytesToBase64(data) };
    if (data instanceof ArrayBuffer) return { __b64: encodeBytesToBase64(new Uint8Array(data)) };
    if (ArrayBuffer.isView(data)) return { __b64: encodeBytesToBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) };
    return data;
  }

  const baseApi = {
    apiVersion: '3.0',
    apiVersionCompatibleWith: ['3.0'],
    getArgument: (k) => rpcCall('getArgument', [String(k || '')]),
    setArgument: (k, v) => rpcCall('setArgument', [String(k || ''), v]),
    getArg: (k) => rpcCall('getArg', [String(k || '')]),
    setArg: (k, v) => rpcCall('setArg', [String(k || ''), v]),

    pluginStorage: {
      getItem: (k) => rpcCall('pluginStorage.getItem', [String(k ?? '')]),
      setItem: (k, v) => rpcCall('pluginStorage.setItem', [String(k ?? ''), v]),
      removeItem: (k) => rpcCall('pluginStorage.removeItem', [String(k ?? '')]),
      clear: () => rpcCall('pluginStorage.clear', []),
      keys: () => rpcCall('pluginStorage.keys', []),
      key: (i) => rpcCall('pluginStorage.key', [Number(i)]),
      length: () => rpcCall('pluginStorage.length', []),
    },
    safeLocalStorage: {
      getItem: (k) => rpcCall('safeLocalStorage.getItem', [String(k ?? '')]),
      setItem: (k, v) => rpcCall('safeLocalStorage.setItem', [String(k ?? ''), String(v ?? '')]),
      removeItem: (k) => rpcCall('safeLocalStorage.removeItem', [String(k ?? '')]),
      clear: () => rpcCall('safeLocalStorage.clear', []),
      keys: () => rpcCall('safeLocalStorage.keys', []),
      key: (i) => rpcCall('safeLocalStorage.key', [Number(i)]),
      length: () => rpcCall('safeLocalStorage.length', []),
    },
    getLocalPluginStorage: async () => ({
      __classType: 'REMOTE_REQUIRED',
      getItem: (k) => rpcCall('localPluginStorage.getItem', [String(k ?? '')]),
      setItem: (k, v) => rpcCall('localPluginStorage.setItem', [String(k ?? ''), v]),
      removeItem: (k) => rpcCall('localPluginStorage.removeItem', [String(k ?? '')]),
      keys: () => rpcCall('localPluginStorage.keys', []),
      clear: () => rpcCall('localPluginStorage.clear', []),
    }),

    getDatabase: (keys) => rpcCall('db.getDatabase', [keys === undefined ? 'all' : keys]),
    setDatabase: (patch) => rpcCall('db.setDatabase', [patch]),
    setDatabaseLite: (patch) => rpcCall('db.setDatabaseLite', [patch]),
    getCharacter: () => rpcCall('db.getCharacterActive', []),
    getChar: () => rpcCall('db.getCharacterActive', []),
    setCharacter: (c) => rpcCall('db.setCharacterActive', [c]),
    setChar: (c) => rpcCall('db.setCharacterActive', [c]),
    getCharacterFromIndex: (idx) => rpcCall('db.getCharacter', [Number(idx)]),
    setCharacterToIndex: (idx, c) => rpcCall('db.setCharacter', [Number(idx), c]),
    getCurrentCharacterIndex: () => rpcCall('db.getCurrentCharacterIndex', []),
    getCurrentChatIndex: () => rpcCall('db.getCurrentChatIndex', []),
    getChat: () => rpcCall('db.getChatActive', []),
    getCurrentChat: () => rpcCall('db.getChatActive', []),
    getChatFromIndex: (cIdx, chIdx) => rpcCall('db.getChat', [Number(cIdx), Number(chIdx)]),
    setChatToIndex: (cIdx, chIdx, chat) => rpcCall('db.setChat', [Number(cIdx), Number(chIdx), chat]),
    loadPlugins: () => rpcCall('db.reloadPcPlugins', []),
    readImage: async (p) => {
      const r = await rpcCall('asset.readImage', [String(p || '')]);
      return (r && r.__b64) ? decodeBase64ToBytes(r.__b64) : null;
    },
    saveAsset: async (data) => rpcCall('asset.saveAsset', [packAssetArg(data)]),
    readInlay: (id) => rpcCall('asset.readInlay', [String(id || '')]),
    createInlay: async (data, opts) => rpcCall('asset.createInlay', [packAssetArg(data), opts || {}]),

    getRootDocument: async () => document,
    getRootContainer: async () => document.body,
    getPluginRoot: async () => document.body,
    createMutationObserver: async (cb) => new MutationObserver(cb),
    showContainer: async () => {
      const boot = document.getElementById('__rs_boot_state');
      if (boot) boot.remove();
      window.parent.postMessage({ __rsGuiShown: 1, pluginName: meta.name }, '*');
      return true;
    },
    hideContainer: async () => {
      window.parent.postMessage({ __rsGuiClose: 1, pluginName: meta.name }, '*');
      return true;
    },

    registerSetting: async (name, callback, icon = '', iconType = 'none', providedId) => {
      const id = providedId || ('ui_set_' + (++uiSeq));
      const item = { id, kind: 'setting', name: String(name || '설정'), icon: String(icon || ''), iconType: iconType || 'none', callback };
      const idx = uiRegistry.findIndex((x) => x.id === id);
      if (idx >= 0) uiRegistry[idx] = item;
      else uiRegistry.push(item);
      reportUiItems();
      if (!autoOpened && (meta.entryId ? id === meta.entryId : uiRegistry.length === 1)) {
        setTimeout(() => { if (!autoOpened) invokeEntry(meta.entryId); }, 40);
      } else {
        scheduleAutoOpen();
      }
      return { id };
    },
    registerButton: async (opts, callback) => {
      const arg = opts && typeof opts === 'object' ? opts : {};
      const id = arg.id || ('ui_btn_' + (++uiSeq));
      const item = { id, kind: 'button', location: arg.location || 'action', name: String(arg.name || 'GUI'), icon: String(arg.icon || ''), iconType: arg.iconType || 'none', callback };
      const idx = uiRegistry.findIndex((x) => x.id === id);
      if (idx >= 0) uiRegistry[idx] = item;
      else uiRegistry.push(item);
      reportUiItems();
      if (!autoOpened && (meta.entryId ? id === meta.entryId : uiRegistry.length === 1)) {
        setTimeout(() => { if (!autoOpened) invokeEntry(meta.entryId); }, 40);
      } else {
        scheduleAutoOpen();
      }
      return { id };
    },
    unregisterUIPart: async (id) => {
      const idx = uiRegistry.findIndex((x) => x.id === String(id));
      if (idx >= 0) uiRegistry.splice(idx, 1);
      reportUiItems();
      return true;
    },

    nativeFetch: async (url, init = {}) => {
      const headers = {};
      if (init && init.headers) {
        new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
      }
      let bodyStr = null;
      if (init && init.body !== undefined && init.body !== null) {
        bodyStr = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
      }
      const res = await rpcCall('nativeFetch', [String(url || ''), {
        method: (init && init.method) || (bodyStr !== null ? 'POST' : 'GET'),
        headers,
        body: bodyStr,
      }]);
      const bytes = decodeBase64ToBytes(res && res.bodyBase64);
      const status = Number((res && res.status) || 200);
      return new Response(status === 204 || status === 304 ? null : bytes, {
        status,
        statusText: (res && res.statusText) || '',
        headers: (res && res.headers) || {},
      });
    },
    risuFetch: async (url, opts = {}) => {
      const r = await rpcCall('risuFetch', [String(url || ''), opts || {}]);
      if (r && typeof r === 'object') {
        r.json = async () => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data);
        r.text = async () => (typeof r.data === 'string' ? r.data : JSON.stringify(r.data ?? ''));
      }
      return r;
    },
    runLLMModel: (req) => rpcCall('runLLMModel', [req || {}]),

    addPluginChannelListener: async (ch, fn) => {
      channelListeners.set(String(ch), fn);
      if (!window.__rsIpcPollTimer) {
        let lastIpcSeq = 0;
        window.__rsIpcPollTimer = setInterval(async () => {
          if (channelListeners.size === 0) return;
          try {
            const res = await rpcCall('ipc.poll', [lastIpcSeq]);
            if (res && typeof res.latestSeq === 'number') lastIpcSeq = res.latestSeq;
            const list = Array.isArray(res && res.events) ? res.events : [];
            for (const ev of list) {
              const listener = channelListeners.get(String(ev.channel || ''));
              if (typeof listener === 'function') {
                try { listener(ev.message, { sender: String(ev.sender || ''), channel: String(ev.channel || '') }); } catch (e) { console.error(e); }
              }
            }
          } catch (_) {}
        }, 1200);
      }
      return true;
    },
    removePluginChannelListener: async (ch) => {
      channelListeners.delete(String(ch));
      return true;
    },
    postPluginChannelMessage: (target, ch, msg) => rpcCall('ipc.post', [String(target || ''), String(ch || ''), msg]),

    getRuntimeInfo: async () => ({ apiVersion: '3.0', platform: 'risustand-remote-gui', saveMethod: 'local' }),
    requestPluginPermission: async () => true,
    getColorScheme: async () => ({ type: meta.theme === 'light' ? 'light' : 'dark', bgcolor: meta.theme === 'light' ? '#ffffff' : '#0f172a', textcolor: meta.theme === 'light' ? '#1b1c1d' : '#e2e8f0' }),
    getTextTheme: async () => ({ name: 'standard', customTheme: {} }),
    changeColorScheme: async () => {},
    setColorScheme: async () => {},
    changeTextTheme: async () => {},
    setCustomTextTheme: async () => {},
    unwarpSafeArray: async (a) => (Array.isArray(a) ? a : []),
    alertError: async (msg) => { window.alert(String(msg || 'Error')); },
    log: (...a) => console.log(...a),
    onUnload: async () => {},
    addRisuChatListener: async () => {},
    removeRisuChatListener: async () => {},
    addRisuReplacer: async () => {},
    removeRisuReplacer: async () => {},
    addRisuScriptHandler: async () => {},
    removeRisuScriptHandler: async () => {},
    registerBodyIntercepter: async () => ({ id: 'gui-noop' }),
    unregisterBodyIntercepter: async () => {},
  };

  const apiProxy = new Proxy(baseApi, {
    get(target, prop) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop);
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
      return async () => undefined;
    },
  });

  window.Risuai = window.RisuAI = window.risuai = window.risuApi = window.risuAPI = apiProxy;

  try {
    const fn = new Function(pluginCode);
    const maybePromise = fn();
    if (maybePromise && typeof maybePromise.catch === 'function') {
      maybePromise.catch((err) => {
        console.error('[Plugin GUI Async Error]', err);
      });
    }
    scheduleAutoOpen();
  } catch (err) {
    const boot = document.getElementById('__rs_boot_state') || document.body;
    boot.innerHTML = '';
    const pre = document.createElement('pre');
    pre.style.cssText = 'margin:16px;padding:12px;border-radius:10px;background:#450a0a;color:#fecaca;white-space:pre-wrap;font-size:12px;';
    pre.textContent = '플러그인 GUI 로드 실패: ' + (err && err.stack ? err.stack : String(err));
    boot.appendChild(pre);
  }
})();
</script>
</body>
</html>`;
}

function createPluginAdapter({
    pluginsPath,
    persistDisabled = false,
    getBackendConfig = () => ({}),
    saveBackendConfig = () => {},
    hostRpc = null,
    getFallbackSnapshot = () => null,
    runLLM = null,
} = {}) {
    let customPlugins = [];
    const pcPlugins = new Map(); // name -> { name, displayName, version, script, header, pcRealArg, pcEnabled, updatedAt }
    const activeHosts = new Map(); // name -> { unload, api, record, context }
    const lastErrors = new Map(); // name -> string
    const pluginChannels = new Map(); // `${pluginName}\0${channel}` -> { pluginName, callback }
    const providers = new Map(); // providerName -> { pluginName, fn, options }
    const pluginDoms = new Map(); // pluginName -> mockDom
    const guiIpcOutbox = []; // [{ seq, targetPlugin, channel, message, sender, at }]
    let guiIpcSeq = 0;
    const hookState = {
        beforeRequest: [],
        afterRequest: [],
        editinput: [],
        editprocess: [],
        editoutput: [],
        editdisplay: [],
        chatOutput: [],
        bodyIntercepter: [],
    };
    const fallbackPluginStore = new Map();
    const fallbackSafeLocal = new Map();
    const fallbackLocalPlugin = new Map();
    const fallbackAssetStore = new Map();
    const fallbackInlayStore = new Map();

    // Per-turn coherent cache (never acts as a separate persistent DB)
    let turnCache = {
        active: false,
        charIndex: -1,
        chatIndex: -1,
        charObj: null,
        chatObj: null,
        stagedUserIdx: -1,
        stagedUserChatId: '',
        pluginStoreCache: new Map(), // key -> parsed JSON snapshot | null
    };

    const isRpcConnected = () => Boolean(hostRpc && typeof hostRpc.isConnected === 'function' && hostRpc.isConnected());

    function loadCustomPluginsFromDisk() {
        if (!pluginsPath || persistDisabled) return;
        try {
            if (fs.existsSync(pluginsPath)) {
                const parsed = JSON.parse(fs.readFileSync(pluginsPath, 'utf8'));
                if (Array.isArray(parsed)) {
                    customPlugins = parsed.filter((p) => p && typeof p === 'object' && p.name && typeof p.script === 'string');
                }
            }
        } catch (e) {
            console.warn('[PluginAdapter] 커스텀 플러그인 파일 로드 실패:', e.message);
        }
    }

    function saveCustomPluginsToDisk() {
        if (!pluginsPath || persistDisabled) return;
        const tmp = `${pluginsPath}.rs-tmp-${crypto.randomBytes(6).toString('hex')}`;
        try {
            fs.writeFileSync(tmp, JSON.stringify(customPlugins, null, 2), { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(tmp, pluginsPath);
        } catch (e) {
            try { fs.rmSync(tmp, { force: true }); } catch (_) {}
            console.warn('[PluginAdapter] 커스텀 플러그인 저장 실패:', e.message);
        }
    }

    loadCustomPluginsFromDisk();

    function getPluginConfigMap() {
        const cfg = getBackendConfig();
        if (!cfg || typeof cfg !== 'object') return {};
        if (!cfg.backendPlugins || typeof cfg.backendPlugins !== 'object' || Array.isArray(cfg.backendPlugins)) {
            cfg.backendPlugins = {};
        }
        return cfg.backendPlugins;
    }

    function getPluginEntry(name) {
        const custom = customPlugins.find((p) => p && p.name === name);
        if (custom) return { ...custom, source: 'custom' };
        const pc = pcPlugins.get(name);
        if (pc) return { ...pc, source: 'pc' };
        return null;
    }

    function getAllKnownEntries() {
        const out = [];
        const seen = new Set();
        for (const p of customPlugins) {
            if (!p || !p.name || seen.has(p.name)) continue;
            seen.add(p.name);
            out.push({ ...p, source: 'custom' });
        }
        for (const [name, p] of pcPlugins.entries()) {
            if (seen.has(name)) continue;
            seen.add(name);
            out.push({ ...p, source: 'pc' });
        }
        return out;
    }

    function isPluginEnabled(name) {
        const cfgMap = getPluginConfigMap();
        const entry = cfgMap[name];
        if (entry && typeof entry.enabled === 'boolean') return entry.enabled;
        const known = getPluginEntry(name);
        return Boolean(known && known.source === 'custom' && known.defaultEnabled);
    }

    function mergePluginArgs(entry) {
        const out = {};
        const header = (entry && entry.header) || parsePluginHeader(entry && entry.script, entry && entry.name);
        for (const def of header.args || []) {
            out[def.key] = def.defaultValue;
        }
        if (entry && entry.pcRealArg && typeof entry.pcRealArg === 'object') {
            for (const [k, v] of Object.entries(entry.pcRealArg)) {
                if (v !== undefined) out[k] = v;
            }
        }
        const cfgEntry = getPluginConfigMap()[entry.name];
        if (cfgEntry && cfgEntry.argOverrides && typeof cfgEntry.argOverrides === 'object') {
            for (const [k, v] of Object.entries(cfgEntry.argOverrides)) {
                if (v !== undefined) out[k] = v;
            }
        }
        return out;
    }

    // ---- Shared Direct Host Storage & DB Primitives ----
    async function storeGet(storeKind, key) {
        const k = String(key);
        if (storeKind === 'pluginStorage') {
            if (turnCache.active && turnCache.pluginStoreCache.has(k)) {
                return cloneJson(turnCache.pluginStoreCache.get(k));
            }
            let val;
            if (isRpcConnected()) {
                val = await hostRpc.invoke('pluginStorage.getItem', [k]);
            } else {
                val = fallbackPluginStore.has(k) ? JSON.parse(fallbackPluginStore.get(k)) : null;
            }
            if (turnCache.active) {
                turnCache.pluginStoreCache.set(k, val === undefined ? null : cloneJson(val));
            }
            return val === undefined ? null : val;
        }
        const op = `${storeKind}.getItem`;
        if (isRpcConnected()) {
            const v = await hostRpc.invoke(op, [k]);
            return v === undefined ? null : v;
        }
        const fb = storeKind === 'safeLocalStorage' ? fallbackSafeLocal : fallbackLocalPlugin;
        return fb.has(k) ? fb.get(k) : null;
    }

    async function storeSet(storeKind, key, value) {
        const k = String(key);
        if (storeKind === 'pluginStorage') {
            const jsonStr = JSON.stringify(value) ?? 'null';
            const normalized = JSON.parse(jsonStr);
            if (turnCache.active) {
                turnCache.pluginStoreCache.set(k, cloneJson(normalized));
            }
            if (isRpcConnected()) {
                await hostRpc.invoke('pluginStorage.setItem', [k, normalized]);
            } else {
                fallbackPluginStore.set(k, jsonStr);
            }
            return true;
        }
        const normalizedVal = storeKind === 'safeLocalStorage' ? String(value ?? '') : cloneJson(value);
        if (isRpcConnected()) {
            await hostRpc.invoke(`${storeKind}.setItem`, [k, normalizedVal]);
        } else {
            const fb = storeKind === 'safeLocalStorage' ? fallbackSafeLocal : fallbackLocalPlugin;
            fb.set(k, normalizedVal);
        }
        return true;
    }

    async function storeRemove(storeKind, key) {
        const k = String(key);
        if (storeKind === 'pluginStorage' && turnCache.active) {
            turnCache.pluginStoreCache.set(k, null);
        }
        if (isRpcConnected()) {
            await hostRpc.invoke(`${storeKind}.removeItem`, [k]);
        } else {
            const fb = storeKind === 'pluginStorage' ? fallbackPluginStore : (storeKind === 'safeLocalStorage' ? fallbackSafeLocal : fallbackLocalPlugin);
            fb.delete(k);
        }
        return true;
    }

    async function storeClear(storeKind) {
        if (storeKind === 'pluginStorage' && turnCache.active) {
            turnCache.pluginStoreCache.clear();
        }
        if (isRpcConnected()) {
            await hostRpc.invoke(`${storeKind}.clear`, []);
        } else {
            const fb = storeKind === 'pluginStorage' ? fallbackPluginStore : (storeKind === 'safeLocalStorage' ? fallbackSafeLocal : fallbackLocalPlugin);
            fb.clear();
        }
        return true;
    }

    async function storeKeys(storeKind) {
        if (isRpcConnected()) {
            const ks = await hostRpc.invoke(`${storeKind}.keys`, []);
            return Array.isArray(ks) ? ks : [];
        }
        const fb = storeKind === 'pluginStorage' ? fallbackPluginStore : (storeKind === 'safeLocalStorage' ? fallbackSafeLocal : fallbackLocalPlugin);
        return Array.from(fb.keys());
    }

    function buildSnapshotCharFallback(snap) {
        if (!snap || typeof snap !== 'object') return null;
        const ctx = snap.charContext && typeof snap.charContext === 'object' ? snap.charContext : {};
        const msgs = (Array.isArray(snap.messages) ? snap.messages : [])
            .filter((m) => m && !m.isFirstMessage && Number(m.index) >= 0)
            .map((m) => ({
                role: m.role === 'user' ? 'user' : 'char',
                data: String(m.raw || m.text || ''),
                ...(m.chatId ? { chatId: String(m.chatId) } : {}),
            }));
        const chat = {
            id: String(snap.chatUuid || snap.chatId || `chat_${snap.chatIndex ?? 0}`),
            name: String(snap.chatName || 'Chat 1'),
            note: String(ctx.note || ''),
            message: msgs,
            scriptstate: Object.fromEntries(Object.entries(snap.chatVariables || {}).map(([k, v]) => [`$${k}`, String(v ?? '')])),
            fmIndex: typeof snap.fmIndex === 'number' ? snap.fmIndex : -1,
        };
        const chats = [];
        chats[Math.max(0, Number(snap.chatIndex) || 0)] = chat;
        return {
            chaId: String(ctx.charId || snap.charName || `char_${snap.charIndex ?? 0}`),
            name: String(ctx.name || snap.charName || 'Character'),
            desc: String(ctx.desc || ''),
            personality: String(ctx.personality || ''),
            scenario: String(ctx.scenario || ''),
            systemPrompt: String(ctx.systemPrompt || ''),
            replaceGlobalNote: String(ctx.replaceGlobalNote || ''),
            chatPage: Math.max(0, Number(snap.chatIndex) || 0),
            chats,
        };
    }

    async function dbGetCurrentIndices() {
        if (turnCache.active && turnCache.charIndex >= 0) {
            return { charIndex: turnCache.charIndex, chatIndex: Math.max(0, turnCache.chatIndex) };
        }
        if (isRpcConnected()) {
            const idx = await hostRpc.invoke('db.getCurrentIndices', []);
            if (idx && typeof idx === 'object') {
                const fallbackSnap = getFallbackSnapshot();
                const cIdx = (fallbackSnap && typeof fallbackSnap.charIndex === 'number' && fallbackSnap.charIndex >= 0)
                    ? fallbackSnap.charIndex
                    : (typeof idx.viewCharIndex === 'number' && idx.viewCharIndex >= 0 ? idx.viewCharIndex : Number(idx.charIndex ?? 0));
                const chIdx = (fallbackSnap && typeof fallbackSnap.chatIndex === 'number' && fallbackSnap.chatIndex >= 0)
                    ? fallbackSnap.chatIndex
                    : (typeof idx.viewChatIndex === 'number' && idx.viewChatIndex >= 0 ? idx.viewChatIndex : Number(idx.chatIndex ?? 0));
                return { charIndex: cIdx, chatIndex: Math.max(0, chIdx) };
            }
        }
        const snap = getFallbackSnapshot();
        return {
            charIndex: snap && typeof snap.charIndex === 'number' && snap.charIndex >= 0 ? snap.charIndex : 0,
            chatIndex: snap && typeof snap.chatIndex === 'number' && snap.chatIndex >= 0 ? snap.chatIndex : 0,
        };
    }

    async function dbGetCharacterFromIndex(idx) {
        const cIdx = Number(idx);
        if (Number.isNaN(cIdx) || cIdx < 0) return null;
        if (turnCache.active && turnCache.charIndex === cIdx && turnCache.charObj) {
            const copy = cloneJson(turnCache.charObj);
            if (turnCache.chatObj && Array.isArray(copy.chats)) {
                copy.chats[turnCache.chatIndex] = cloneJson(turnCache.chatObj);
            }
            return copy;
        }
        if (isRpcConnected()) {
            return await hostRpc.invoke('db.getCharacter', [cIdx]);
        }
        const snap = getFallbackSnapshot();
        if (snap && snap.charIndex === cIdx) return buildSnapshotCharFallback(snap);
        return null;
    }

    async function dbSetCharacterToIndex(idx, charObj) {
        const cIdx = Number(idx);
        if (Number.isNaN(cIdx) || cIdx < 0 || !charObj) return false;
        const copy = cloneJson(charObj);
        if (turnCache.active && turnCache.charIndex === cIdx) {
            turnCache.charObj = copy;
            if (Array.isArray(copy.chats) && copy.chats[turnCache.chatIndex]) {
                turnCache.chatObj = cloneJson(copy.chats[turnCache.chatIndex]);
            }
        }
        if (isRpcConnected()) {
            await hostRpc.invoke('db.setCharacter', [cIdx, copy]);
        }
        return true;
    }

    async function dbGetChatFromIndex(cIdx, chIdx) {
        const ci = Number(cIdx);
        const chi = Number(chIdx);
        if (Number.isNaN(ci) || ci < 0 || Number.isNaN(chi) || chi < 0) return null;
        if (turnCache.active && turnCache.charIndex === ci && turnCache.chatIndex === chi && turnCache.chatObj) {
            return cloneJson(turnCache.chatObj);
        }
        if (isRpcConnected()) {
            return await hostRpc.invoke('db.getChat', [ci, chi]);
        }
        const snap = getFallbackSnapshot();
        if (snap && snap.charIndex === ci) {
            const fb = buildSnapshotCharFallback(snap);
            return (fb && fb.chats && fb.chats[chi]) || null;
        }
        return null;
    }

    async function dbSetChatToIndex(cIdx, chIdx, chatObj) {
        const ci = Number(cIdx);
        const chi = Number(chIdx);
        if (Number.isNaN(ci) || ci < 0 || Number.isNaN(chi) || chi < 0 || !chatObj) return false;
        const copy = cloneJson(chatObj);
        if (turnCache.active && turnCache.charIndex === ci && turnCache.chatIndex === chi) {
            turnCache.chatObj = copy;
            if (turnCache.charObj && Array.isArray(turnCache.charObj.chats)) {
                turnCache.charObj.chats[chi] = cloneJson(copy);
            }
        }
        if (isRpcConnected()) {
            await hostRpc.invoke('db.setChat', [ci, chi, copy]);
        }
        return true;
    }

    async function dbGetDatabase(keys = 'all') {
        const want = keys === undefined ? 'all' : keys;
        let out = {};
        if (isRpcConnected()) {
            out = (await hostRpc.invoke('db.getDatabase', [want])) || {};
        } else {
            const snap = getFallbackSnapshot();
            const fbChar = buildSnapshotCharFallback(snap);
            out = {
                characters: fbChar ? [fbChar] : [],
                personas: snap && snap.charContext ? [{ name: snap.charContext.personaName || 'User', personaPrompt: snap.charContext.personaPrompt || '' }] : [],
                selectedPersona: 0,
                enabledModules: [],
                modules: [],
                plugins: [],
            };
        }
        if (turnCache.active && Array.isArray(out.characters) && turnCache.charIndex >= 0 && turnCache.charObj) {
            out.characters[turnCache.charIndex] = cloneJson(turnCache.charObj);
            if (turnCache.chatObj && Array.isArray(out.characters[turnCache.charIndex].chats)) {
                out.characters[turnCache.charIndex].chats[turnCache.chatIndex] = cloneJson(turnCache.chatObj);
            }
        }
        if (want === 'all' || (Array.isArray(want) && want.includes('plugins'))) {
            const merged = Array.isArray(out.plugins) ? out.plugins.slice() : [];
            for (const entry of getAllKnownEntries()) {
                if (!merged.some((p) => p && p.name === entry.name)) {
                    merged.push({
                        name: entry.name,
                        displayName: entry.displayName,
                        version: '3.0',
                        versionOfPlugin: entry.version,
                        enabled: isPluginEnabled(entry.name),
                        allowedIPC: entry.header ? entry.header.allowedIPC : [],
                        realArg: mergePluginArgs(entry),
                    });
                }
            }
            out.plugins = merged;
        }
        return out;
    }

    async function dbSetDatabase(method, patch) {
        const safePatch = cloneJson(patch || {});
        if (turnCache.active && safePatch && Array.isArray(safePatch.characters) && safePatch.characters[turnCache.charIndex]) {
            turnCache.charObj = cloneJson(safePatch.characters[turnCache.charIndex]);
            if (Array.isArray(turnCache.charObj.chats) && turnCache.charObj.chats[turnCache.chatIndex]) {
                turnCache.chatObj = cloneJson(turnCache.charObj.chats[turnCache.chatIndex]);
            }
        }
        if (isRpcConnected()) {
            await hostRpc.invoke(method, [safePatch]);
        }
        return true;
    }

    async function assetReadImage(assetPath) {
        const key = String(assetPath || '');
        if (!key) return null;
        if (isRpcConnected()) {
            const res = await hostRpc.invoke('asset.readImage', [key]);
            return (res && res.__b64) ? new Uint8Array(Buffer.from(res.__b64, 'base64')) : null;
        }
        const hit = fallbackAssetStore.get(key);
        return hit ? new Uint8Array(hit) : null;
    }

    async function assetSaveAsset(data) {
        const buf = toNodeBuffer(data);
        if (!buf || !buf.length) return '';
        if (isRpcConnected()) {
            return await hostRpc.invoke('asset.saveAsset', [{ __b64: buf.toString('base64') }]);
        }
        const ext = (detectImageMimeFromBuf(buf).split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
        const p = `assets/${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}.${ext}`;
        fallbackAssetStore.set(p, new Uint8Array(buf));
        return p;
    }

    async function assetReadInlay(id) {
        const key = String(id || '');
        if (!key) return null;
        if (isRpcConnected()) {
            return await hostRpc.invoke('asset.readInlay', [key]);
        }
        return cloneJson(fallbackInlayStore.get(key) || null);
    }

    async function assetCreateInlay(data, options) {
        const isDataUri = typeof data === 'string' && /^data:image\//i.test(data);
        const hasPackedB64 = Boolean(data && typeof data === 'object' && typeof data.__b64 === 'string');
        if (!isDataUri && !isBinaryLike(data) && !hasPackedB64) {
            throw new Error('data must be a Uint8Array or an image data URI string');
        }
        const name = (options && options.name) ? String(options.name) : undefined;
        if (isDataUri) {
            if (isRpcConnected()) {
                return await hostRpc.invoke('asset.createInlay', [{ kind: 'dataUri', dataUri: data, name }]);
            }
            const id = crypto.randomUUID();
            const extMatch = data.match(/^data:image\/([a-z0-9.+-]+);/i);
            fallbackInlayStore.set(id, {
                data,
                ext: extMatch ? extMatch[1].toLowerCase() : 'png',
                type: 'image',
                name: name || id,
                created: Date.now(),
            });
            return id;
        }
        const buf = toNodeBuffer(data);
        if (!buf || !buf.length) return null;
        if (isRpcConnected()) {
            return await hostRpc.invoke('asset.createInlay', [{ kind: 'bytes', __b64: buf.toString('base64'), name }]);
        }
        const id = crypto.randomUUID();
        const mime = detectImageMimeFromBuf(buf);
        fallbackInlayStore.set(id, {
            data: `data:${mime};base64,${buf.toString('base64')}`,
            ext: mime.split('/')[1] || 'png',
            type: 'image',
            name: name || id,
            created: Date.now(),
        });
        return id;
    }

    async function proxyFetchForPlugin(url, opts = {}, isRisuFetch = false) {
        const parsed = checkUrlAllowed(url);
        const initOpts = opts && typeof opts === 'object' ? opts : {};
        const headers = {};
        if (initOpts.headers && typeof initOpts.headers === 'object') {
            for (const [k, v] of Object.entries(initOpts.headers)) {
                if (v !== undefined && v !== null) headers[String(k)] = String(v);
            }
        }
        let body = initOpts.body;
        if (body !== undefined && body !== null && typeof body !== 'string' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
            body = JSON.stringify(body);
            if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
                headers['Content-Type'] = 'application/json';
            }
        }
        const method = String(initOpts.method || (body !== undefined && body !== null ? 'POST' : 'GET')).toUpperCase();
        const resp = await fetch(parsed.toString(), {
            method,
            headers,
            ...(body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
        });
        if (!isRisuFetch) {
            return resp;
        }
        const respHeaders = {};
        resp.headers.forEach((v, k) => { respHeaders[k] = v; });
        const rawText = await resp.text();
        let data = rawText;
        const ct = String(respHeaders['content-type'] || '').toLowerCase();
        if (ct.includes('json') || /^\s*[\[{]/.test(rawText)) {
            try { data = JSON.parse(rawText); } catch (_) { data = rawText; }
        }
        return {
            ok: resp.ok,
            status: resp.status,
            headers: respHeaders,
            data,
            json: async () => (typeof data === 'string' ? JSON.parse(data) : data),
            text: async () => rawText,
        };
    }

    async function postIpcMessage(senderEntry, targetPluginName, channelName, message) {
        const targetEntry = getPluginEntry(targetPluginName);
        if (!targetEntry) return false;
        const senderAllowed = (senderEntry && senderEntry.header && senderEntry.header.allowedIPC) || [];
        const targetAllowed = (targetEntry && targetEntry.header && targetEntry.header.allowedIPC) || [];
        if (targetAllowed.length && !targetAllowed.includes(senderEntry.name)) return false;
        if (senderAllowed.length && !senderAllowed.includes(targetEntry.name)) return false;
        const cloned = cloneJson(message);
        const rec = pluginChannels.get(`${targetPluginName}\0${channelName}`);
        if (rec && typeof rec.callback === 'function') {
            await rec.callback(cloned, { sender: senderEntry.name, channel: String(channelName) });
        }
        guiIpcOutbox.push({
            seq: ++guiIpcSeq,
            targetPlugin: String(targetPluginName),
            channel: String(channelName),
            message: cloned,
            sender: String(senderEntry.name || ''),
            at: Date.now(),
        });
        if (guiIpcOutbox.length > 60) {
            guiIpcOutbox.splice(0, guiIpcOutbox.length - 60);
        }
        return true;
    }

    function pollGuiIpc(pluginName, afterSeq = 0) {
        const n = String(pluginName || '');
        const s = Number(afterSeq) || 0;
        const events = guiIpcOutbox.filter((ev) => ev.targetPlugin === n && ev.seq > s);
        return {
            latestSeq: guiIpcSeq,
            events,
        };
    }

    function makePluginApiFor(entry, record, sharedMockDom) {
        const pluginName = entry.name;
        const trackedUnloads = [];
        const { asyncDoc } = sharedMockDom;
        const addUnload = (fn) => {
            if (typeof fn === 'function') trackedUnloads.push(fn);
        };

        const rawApi = {
            apiVersion: '3.0',
            apiVersionCompatibleWith: ['3.0'],

            getArgument: async (key) => {
                const args = mergePluginArgs(getPluginEntry(pluginName) || entry);
                const k = String(key || '');
                return Object.prototype.hasOwnProperty.call(args, k) ? args[k] : undefined;
            },
            setArgument: async (key, val) => {
                const k = String(key || '');
                if (!k) return;
                const cfgMap = getPluginConfigMap();
                if (!cfgMap[pluginName] || typeof cfgMap[pluginName] !== 'object') {
                    cfgMap[pluginName] = { enabled: isPluginEnabled(pluginName), argOverrides: {} };
                }
                if (!cfgMap[pluginName].argOverrides || typeof cfgMap[pluginName].argOverrides !== 'object') {
                    cfgMap[pluginName].argOverrides = {};
                }
                cfgMap[pluginName].argOverrides[k] = val;
                saveBackendConfig();
            },
            getArg: async (arg) => {
                const s = String(arg || '');
                const k = s.includes('::') ? s.split('::').slice(1).join('::') : s;
                return await rawApi.getArgument(k);
            },
            setArg: async (arg, val) => {
                const s = String(arg || '');
                const k = s.includes('::') ? s.split('::').slice(1).join('::') : s;
                return await rawApi.setArgument(k, val);
            },

            pluginStorage: {
                getItem: (k) => storeGet('pluginStorage', k),
                setItem: (k, v) => storeSet('pluginStorage', k, v),
                removeItem: (k) => storeRemove('pluginStorage', k),
                clear: () => storeClear('pluginStorage'),
                keys: () => storeKeys('pluginStorage'),
                key: async (i) => {
                    const ks = await storeKeys('pluginStorage');
                    return ks[Number(i)] ?? null;
                },
                length: async () => (await storeKeys('pluginStorage')).length,
            },
            safeLocalStorage: {
                getItem: (k) => storeGet('safeLocalStorage', k),
                setItem: (k, v) => storeSet('safeLocalStorage', k, v),
                removeItem: (k) => storeRemove('safeLocalStorage', k),
                clear: () => storeClear('safeLocalStorage'),
                keys: () => storeKeys('safeLocalStorage'),
                key: async (i) => {
                    const ks = await storeKeys('safeLocalStorage');
                    return ks[Number(i)] ?? null;
                },
                length: async () => (await storeKeys('safeLocalStorage')).length,
            },
            getLocalPluginStorage: async () => ({
                __classType: 'REMOTE_REQUIRED',
                getItem: (k) => storeGet('localPluginStorage', k),
                setItem: (k, v) => storeSet('localPluginStorage', k, v),
                removeItem: (k) => storeRemove('localPluginStorage', k),
                keys: () => storeKeys('localPluginStorage'),
                clear: () => storeClear('localPluginStorage'),
            }),

            addRisuReplacer: async (mode, fn) => {
                if (typeof fn !== 'function') return;
                if (mode !== 'beforeRequest' && mode !== 'afterRequest') {
                    throw new Error(`replacer handler named ${mode} not found`);
                }
                const list = hookState[mode];
                const item = { pluginName, fn };
                list.push(item);
                if (!record.hooks.replacers.includes(mode)) record.hooks.replacers.push(mode);
                addUnload(() => {
                    const idx = list.indexOf(item);
                    if (idx >= 0) list.splice(idx, 1);
                });
            },
            removeRisuReplacer: async (mode, fn) => {
                const list = hookState[mode];
                if (!Array.isArray(list)) return;
                for (let i = list.length - 1; i >= 0; i -= 1) {
                    if (list[i].pluginName === pluginName && (!fn || list[i].fn === fn)) list.splice(i, 1);
                }
            },

            addRisuScriptHandler: async (mode, fn) => {
                if (typeof fn !== 'function') return;
                const key = `edit${mode}`;
                const list = hookState[key];
                if (!Array.isArray(list)) throw new Error(`script handler named ${mode} not found`);
                const item = { pluginName, fn };
                list.push(item);
                if (!record.hooks.scriptHandlers.includes(mode)) record.hooks.scriptHandlers.push(mode);
                addUnload(() => {
                    const idx = list.indexOf(item);
                    if (idx >= 0) list.splice(idx, 1);
                });
            },
            removeRisuScriptHandler: async (mode, fn) => {
                const list = hookState[`edit${mode}`];
                if (!Array.isArray(list)) return;
                for (let i = list.length - 1; i >= 0; i -= 1) {
                    if (list[i].pluginName === pluginName && (!fn || list[i].fn === fn)) list.splice(i, 1);
                }
            },

            addRisuChatListener: async (mode, fn) => {
                if (mode !== 'output') throw new Error(`chat listener mode ${mode} not found`);
                if (typeof fn !== 'function') return;
                const item = { pluginName, fn };
                hookState.chatOutput.push(item);
                if (!record.hooks.chatListeners.includes('output')) record.hooks.chatListeners.push('output');
                addUnload(() => {
                    const idx = hookState.chatOutput.indexOf(item);
                    if (idx >= 0) hookState.chatOutput.splice(idx, 1);
                });
            },
            removeRisuChatListener: async (mode, fn) => {
                if (mode !== 'output') return;
                for (let i = hookState.chatOutput.length - 1; i >= 0; i -= 1) {
                    if (hookState.chatOutput[i].pluginName === pluginName && (!fn || hookState.chatOutput[i].fn === fn)) {
                        hookState.chatOutput.splice(i, 1);
                    }
                }
            },

            registerBodyIntercepter: async (cb) => {
                if (typeof cb !== 'function') return { id: '' };
                const id = `bi_${pluginName}_${++record.seq}`;
                const item = { id, pluginName, fn: cb };
                hookState.bodyIntercepter.push(item);
                addUnload(() => {
                    const idx = hookState.bodyIntercepter.indexOf(item);
                    if (idx >= 0) hookState.bodyIntercepter.splice(idx, 1);
                });
                return { id };
            },
            unregisterBodyIntercepter: async (id) => {
                for (let i = hookState.bodyIntercepter.length - 1; i >= 0; i -= 1) {
                    if (hookState.bodyIntercepter[i].id === String(id)) hookState.bodyIntercepter.splice(i, 1);
                }
            },

            registerSetting: async (name, _cb, icon = '', iconType = 'none', providedId) => {
                const id = providedId || `set_${++record.seq}`;
                const ui = { id, kind: 'setting', name: String(name || '설정'), icon: String(icon || ''), iconType: iconType || 'none', location: 'setting' };
                const idx = record.uiItems.findIndex((u) => u.id === id);
                if (idx >= 0) record.uiItems[idx] = ui;
                else record.uiItems.push(ui);
                return { id };
            },
            registerButton: async (opts, _cb) => {
                const arg = opts && typeof opts === 'object' ? opts : {};
                const id = arg.id || `btn_${++record.seq}`;
                const ui = { id, kind: 'button', name: String(arg.name || 'GUI'), icon: String(arg.icon || ''), iconType: arg.iconType || 'none', location: arg.location || 'action' };
                const idx = record.uiItems.findIndex((u) => u.id === id);
                if (idx >= 0) record.uiItems[idx] = ui;
                else record.uiItems.push(ui);
                return { id };
            },
            unregisterUIPart: async (id) => {
                const idx = record.uiItems.findIndex((u) => u.id === String(id));
                if (idx >= 0) record.uiItems.splice(idx, 1);
            },

            addPluginChannelListener: async (channelName, cb) => {
                if (typeof cb !== 'function') return;
                const key = `${pluginName}\0${channelName}`;
                pluginChannels.set(key, { pluginName, callback: cb });
                addUnload(() => { pluginChannels.delete(key); });
            },
            removePluginChannelListener: async (channelName) => {
                pluginChannels.delete(`${pluginName}\0${channelName}`);
            },
            postPluginChannelMessage: (target, channel, msg) => postIpcMessage(getPluginEntry(pluginName) || entry, target, channel, msg),

            nativeFetch: (url, opts) => proxyFetchForPlugin(url, opts, false),
            risuFetch: (url, opts) => proxyFetchForPlugin(url, opts, true),

            runLLMModel: async (req) => {
                if (typeof runLLM !== 'function') {
                    return { type: 'fail', result: 'No LLM runner available in backend adapter' };
                }
                try {
                    return await runLLM(req || {}, pluginName, providers);
                } catch (err) {
                    return { type: 'fail', result: err && err.message ? err.message : String(err) };
                }
            },

            getCurrentCharacterIndex: async () => (await dbGetCurrentIndices()).charIndex,
            getCurrentChatIndex: async () => (await dbGetCurrentIndices()).chatIndex,
            getCharacter: async () => dbGetCharacterFromIndex((await dbGetCurrentIndices()).charIndex),
            getChar: async () => dbGetCharacterFromIndex((await dbGetCurrentIndices()).charIndex),
            setCharacter: async (c) => dbSetCharacterToIndex((await dbGetCurrentIndices()).charIndex, c),
            setChar: async (c) => dbSetCharacterToIndex((await dbGetCurrentIndices()).charIndex, c),
            getCharacterFromIndex: (idx) => dbGetCharacterFromIndex(idx),
            setCharacterToIndex: (idx, c) => dbSetCharacterToIndex(idx, c),
            getChat: async () => {
                const idx = await dbGetCurrentIndices();
                return dbGetChatFromIndex(idx.charIndex, idx.chatIndex);
            },
            getCurrentChat: async () => {
                const idx = await dbGetCurrentIndices();
                return dbGetChatFromIndex(idx.charIndex, idx.chatIndex);
            },
            getChatFromIndex: (cIdx, chIdx) => dbGetChatFromIndex(cIdx, chIdx),
            setChatToIndex: (cIdx, chIdx, chat) => dbSetChatToIndex(cIdx, chIdx, chat),
            getDatabase: (keys) => dbGetDatabase(keys),
            setDatabaseLite: (patch) => dbSetDatabase('db.setDatabaseLite', patch),
            setDatabase: (patch) => dbSetDatabase('db.setDatabase', patch),
            loadPlugins: async () => {
                if (isRpcConnected()) await hostRpc.invoke('db.reloadPcPlugins', []);
            },

            onUnload: async (cb) => { addUnload(cb); },
            getRootDocument: async () => asyncDoc,
            getRootContainer: async () => asyncDoc.body,
            getPluginRoot: async () => asyncDoc.body,
            createMutationObserver: async () => ({ observe: async () => {}, disconnect: async () => {}, takeRecords: async () => [] }),
            showContainer: async () => {},
            hideContainer: async () => {},
            getRuntimeInfo: async () => ({ apiVersion: '3.0', platform: 'risustand-backend', saveMethod: 'local' }),
            requestPluginPermission: async () => true,
            unwarpSafeArray: async (a) => (Array.isArray(a) ? a : []),
            getColorScheme: async () => ({ name: 'dark', type: 'dark', scheme: {} }),
            getTextTheme: async () => ({ name: 'standard', customTheme: {} }),
            changeColorScheme: async () => {},
            setColorScheme: async () => {},
            changeTextTheme: async () => {},
            setCustomTextTheme: async () => {},
            searchTranslationCache: async () => [],
            getTranslationCache: async () => null,
            getFetchLogs: async () => [],
            checkCharOrder: async () => {},
            readImage: (p) => assetReadImage(p),
            readInlay: (id) => assetReadInlay(id),
            saveAsset: (d) => assetSaveAsset(d),
            createInlay: (d, opts) => assetCreateInlay(d, opts),
            addProvider: async (name, func, options) => {
                const pKey = String(name || '').trim();
                if (!pKey || typeof func !== 'function') return;
                const rec = { pluginName, name: pKey, fn: func, options: (options && typeof options === 'object') ? cloneJson(options) : {} };
                providers.set(pKey, rec);
                if (!Array.isArray(record.providers)) record.providers = [];
                if (!record.providers.includes(pKey)) record.providers.push(pKey);
                addUnload(() => {
                    const cur = providers.get(pKey);
                    if (cur === rec) providers.delete(pKey);
                });
            },
            registerMCP: async () => {},
            unregisterMCP: async () => {},
            addTTSPreprocessor: async () => {},
            addTTSPostprocessor: async () => {},
            alertError: async (msg) => { console.warn(`[Plugin:${pluginName}] alertError:`, msg); },
            log: (...args) => console.log(`[Plugin:${pluginName}]`, ...args),
        };

        const proxy = new Proxy(rawApi, {
            get(target, prop) {
                if (Reflect.has(target, prop)) return Reflect.get(target, prop);
                if (typeof prop === 'symbol' || prop === 'then' || prop === 'catch' || prop === 'finally' || prop === 'toJSON') {
                    return undefined;
                }
                return async () => undefined;
            },
        });
        return { api: proxy, trackedUnloads };
    }

    async function unloadPlugin(name) {
        const inst = activeHosts.get(name);
        if (!inst) return;
        activeHosts.delete(name);
        pluginDoms.delete(name);
        for (const fn of [...inst.trackedUnloads].reverse()) {
            try { await fn(); } catch (_) {}
        }
        for (const id of [...inst.timers]) {
            clearTimeout(id);
            clearInterval(id);
        }
        inst.timers.clear();
    }

    async function loadPlugin(name) {
        const entry = getPluginEntry(name);
        if (!entry) return false;
        await unloadPlugin(name);
        lastErrors.delete(name);

        const record = {
            pluginName: name,
            seq: 0,
            uiItems: [],
            providers: [],
            hooks: { replacers: [], scriptHandlers: [], chatListeners: [] },
        };
        const sharedMockDom = createHeadlessMockDom();
        pluginDoms.set(name, sharedMockDom);
        const { api, trackedUnloads } = makePluginApiFor(entry, record, sharedMockDom);
        const timers = new Set();
        const { syncDoc } = sharedMockDom;
        const sandboxCrypto = createSandboxCrypto();

        const sandbox = {
            console: {
                log: (...a) => console.log(`[Plugin:${name}]`, ...a),
                info: (...a) => console.log(`[Plugin:${name}]`, ...a),
                warn: (...a) => console.warn(`[Plugin:${name}]`, ...a),
                error: (...a) => console.error(`[Plugin:${name}]`, ...a),
                debug: () => {},
            },
            setTimeout: (fn, ms, ...args) => {
                const id = setTimeout(() => {
                    timers.delete(id);
                    try { fn(...args); } catch (e) { console.error(`[Plugin:${name}] timer error:`, e.message); }
                }, ms);
                if (typeof id.unref === 'function') id.unref();
                timers.add(id);
                return id;
            },
            clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
            setInterval: (fn, ms, ...args) => {
                const id = setInterval(() => {
                    try { fn(...args); } catch (e) { console.error(`[Plugin:${name}] interval error:`, e.message); }
                }, ms);
                if (typeof id.unref === 'function') id.unref();
                timers.add(id);
                return id;
            },
            clearInterval: (id) => { timers.delete(id); clearInterval(id); },
            queueMicrotask,
            crypto: sandboxCrypto,
            SubtleCrypto: crypto.webcrypto ? crypto.webcrypto.SubtleCrypto : undefined,
            CryptoKey: crypto.webcrypto ? crypto.webcrypto.CryptoKey : undefined,
            CompressionStream,
            DecompressionStream,
            ReadableStream,
            WritableStream,
            TransformStream,
            performance,
            URL,
            URLSearchParams,
            TextEncoder,
            TextDecoder,
            AbortController,
            AbortSignal,
            Headers,
            Request,
            Response,
            Blob,
            FormData: typeof FormData !== 'undefined' ? FormData : undefined,
            structuredClone,
            Uint8Array,
            ArrayBuffer,
            atob: (b64) => Buffer.from(String(b64), 'base64').toString('binary'),
            btoa: (bin) => Buffer.from(String(bin), 'binary').toString('base64'),
            fetch: (u, o) => proxyFetchForPlugin(u, o, false),
            risuai: api,
            Risuai: api,
            RisuAI: api,
            risuApi: api,
            risuAPI: api,
            document: syncDoc,
            localStorage: api.safeLocalStorage,
            MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
            matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
            requestAnimationFrame: (fn) => sandbox.setTimeout(fn, 16),
            cancelAnimationFrame: (id) => sandbox.clearTimeout(id),
        };
        sandbox.window = sandbox;
        sandbox.self = sandbox;
        sandbox.globalThis = sandbox;

        try {
            vm.createContext(sandbox);
            const ret = vm.runInContext(entry.script, sandbox, { filename: `${name}.js`, timeout: 5000 });
            if (ret && typeof ret.then === 'function') {
                await Promise.race([
                    ret.catch((err) => {
                        lastErrors.set(name, err && err.message ? err.message : String(err));
                    }),
                    new Promise((r) => setTimeout(r, 800)),
                ]);
            } else {
                await new Promise((r) => setTimeout(r, 40));
            }
            activeHosts.set(name, { entry, record, trackedUnloads, timers, sandbox });
            return true;
        } catch (err) {
            lastErrors.set(name, err && err.message ? err.message : String(err));
            for (const fn of trackedUnloads) {
                try { await fn(); } catch (_) {}
            }
            for (const id of timers) { clearTimeout(id); clearInterval(id); }
            return false;
        }
    }

    async function reconcileEnabledPlugins() {
        for (const entry of getAllKnownEntries()) {
            const want = isPluginEnabled(entry.name);
            const active = activeHosts.has(entry.name);
            if (want && !active) {
                await loadPlugin(entry.name);
            } else if (!want && active) {
                await unloadPlugin(entry.name);
            }
        }
    }

    // Boot any persisted custom/enabled plugins on startup (non-blocking if offline)
    void reconcileEnabledPlugins().catch(() => {});

    async function syncPcPlugins() {
        if (!isRpcConnected()) return listPlugins();
        const rawList = await hostRpc.invoke('db.getPlugins', []);
        if (!Array.isArray(rawList)) return listPlugins();
        const prevScripts = new Map();
        for (const [k, v] of pcPlugins.entries()) prevScripts.set(k, v.script);

        pcPlugins.clear();
        for (const raw of rawList) {
            if (!raw || !raw.script || raw.name === 'risustand') continue;
            const header = parsePluginHeader(raw.script, raw.name);
            const pName = String(raw.name || header.name);
            pcPlugins.set(pName, {
                name: pName,
                displayName: String(raw.displayName || header.displayName || pName),
                version: String(raw.versionOfPlugin || header.version || '0.0.0'),
                script: String(raw.script),
                header,
                pcRealArg: (raw.realArg && typeof raw.realArg === 'object') ? cloneJson(raw.realArg) : {},
                pcEnabled: raw.enabled !== false,
                updatedAt: Date.now(),
            });
            if (activeHosts.has(pName) && prevScripts.get(pName) !== String(raw.script)) {
                await loadPlugin(pName);
            }
        }
        await reconcileEnabledPlugins();
        return listPlugins();
    }

    async function addCustomPlugin({ filename = '', script = '', enabled = true } = {}) {
        const src = String(script || '');
        if (!src.trim()) throw new Error('플러그인 스크립트가 비어 있습니다.');
        const header = parsePluginHeader(src, filename);
        const existingIdx = customPlugins.findIndex((p) => p && p.name === header.name);
        const item = {
            name: header.name,
            displayName: header.displayName,
            version: header.version,
            filename: String(filename || `${header.name}.js`),
            script: src,
            header,
            defaultEnabled: Boolean(enabled),
            updatedAt: Date.now(),
        };
        if (existingIdx >= 0) customPlugins[existingIdx] = item;
        else customPlugins.push(item);
        saveCustomPluginsToDisk();

        const cfgMap = getPluginConfigMap();
        cfgMap[item.name] = {
            ...(cfgMap[item.name] || {}),
            enabled: Boolean(enabled),
            argOverrides: (cfgMap[item.name] && cfgMap[item.name].argOverrides) || {},
        };
        saveBackendConfig();
        await reconcileEnabledPlugins();
        return listPlugins();
    }

    async function removePlugin(name) {
        const n = String(name || '').trim();
        const prevLen = customPlugins.length;
        customPlugins = customPlugins.filter((p) => p && p.name !== n);
        if (customPlugins.length !== prevLen) saveCustomPluginsToDisk();
        await unloadPlugin(n);
        const cfgMap = getPluginConfigMap();
        if (cfgMap[n]) {
            delete cfgMap[n];
            saveBackendConfig();
        }
        lastErrors.delete(n);
        return listPlugins();
    }

    async function togglePlugin(name, enabled) {
        const n = String(name || '').trim();
        const entry = getPluginEntry(n);
        if (!entry) throw new Error(`플러그인 '${n}'을 찾을 수 없습니다.`);
        const cfgMap = getPluginConfigMap();
        cfgMap[n] = {
            ...(cfgMap[n] || {}),
            enabled: Boolean(enabled),
            argOverrides: (cfgMap[n] && cfgMap[n].argOverrides) || {},
        };
        saveBackendConfig();
        if (enabled) {
            await loadPlugin(n);
        } else {
            await unloadPlugin(n);
        }
        return listPlugins();
    }

    async function updatePluginArgs(name, nextArgs = {}) {
        const n = String(name || '').trim();
        const entry = getPluginEntry(n);
        if (!entry) throw new Error(`플러그인 '${n}'을 찾을 수 없습니다.`);
        const cfgMap = getPluginConfigMap();
        const cur = cfgMap[n] || { enabled: isPluginEnabled(n), argOverrides: {} };
        const overrides = { ...(cur.argOverrides || {}) };
        for (const [k, v] of Object.entries(nextArgs || {})) {
            if (!k) continue;
            const def = (entry.header && entry.header.args || []).find((a) => a.key === k);
            overrides[k] = (def && def.type === 'int' && v !== '') ? (Number(v) || 0) : v;
        }
        cfgMap[n] = { ...cur, argOverrides: overrides };
        saveBackendConfig();
        return listPlugins();
    }

    function listPlugins() {
        return getAllKnownEntries().map((entry) => {
            const inst = activeHosts.get(entry.name);
            const rec = inst ? inst.record : null;
            const enabled = isPluginEnabled(entry.name);
            return {
                name: entry.name,
                displayName: entry.displayName || entry.name,
                version: entry.version || '0.0.0',
                source: entry.source,
                enabled,
                loaded: Boolean(inst),
                uiItems: rec ? rec.uiItems : [],
                hooks: rec ? rec.hooks : { replacers: [], scriptHandlers: [], chatListeners: [] },
                hasBodyIntercepter: hookState.bodyIntercepter.some((b) => b.pluginName === entry.name),
                argsSchema: (entry.header && entry.header.args) || [],
                argValues: mergePluginArgs(entry),
                lastError: lastErrors.get(entry.name) || '',
                hasScript: Boolean(entry.script),
            };
        });
    }

    function hasEnabledPlugins() {
        return activeHosts.size > 0;
    }

    // ---- Direct Turn Pipeline Orchestration ----
    async function prepareTurn(charIndex, chatIndex, fallbackSnap) {
        turnCache = {
            active: true,
            charIndex: Number(charIndex),
            chatIndex: Number(chatIndex),
            charObj: null,
            chatObj: null,
            stagedUserIdx: -1,
            stagedUserChatId: '',
            pluginStoreCache: new Map(),
        };
        if (isRpcConnected()) {
            const [charObj, chatObj] = await Promise.all([
                hostRpc.invoke('db.getCharacter', [turnCache.charIndex]),
                hostRpc.invoke('db.getChat', [turnCache.charIndex, turnCache.chatIndex]),
            ]);
            turnCache.charObj = charObj ? cloneJson(charObj) : buildSnapshotCharFallback(fallbackSnap);
            turnCache.chatObj = chatObj ? cloneJson(chatObj) : ((turnCache.charObj && turnCache.charObj.chats && turnCache.charObj.chats[turnCache.chatIndex]) || null);
        } else {
            turnCache.charObj = buildSnapshotCharFallback(fallbackSnap);
            turnCache.chatObj = (turnCache.charObj && turnCache.charObj.chats && turnCache.charObj.chats[turnCache.chatIndex]) || null;
        }
        if (turnCache.chatObj && !turnCache.chatObj.id) {
            turnCache.chatObj.id = crypto.randomUUID();
        }
        if (turnCache.charObj && turnCache.chatObj) {
            if (!Array.isArray(turnCache.charObj.chats)) turnCache.charObj.chats = [];
            turnCache.charObj.chats[turnCache.chatIndex] = turnCache.chatObj;
        }
    }

    function endTurn() {
        turnCache.active = false;
        turnCache.stagedUserIdx = -1;
        turnCache.stagedUserChatId = '';
        turnCache.pluginStoreCache.clear();
    }

    function getTurnContext() {
        return {
            active: turnCache.active,
            charIndex: turnCache.charIndex,
            chatIndex: turnCache.chatIndex,
            charObj: turnCache.charObj,
            chatObj: turnCache.chatObj,
            stagedUserIdx: turnCache.stagedUserIdx,
            stagedUserChatId: turnCache.stagedUserChatId,
        };
    }

    function setTurnObjects({ charObj, chatObj } = {}) {
        if (!turnCache.active) return;
        if (charObj) turnCache.charObj = charObj;
        if (chatObj) turnCache.chatObj = chatObj;
        if (turnCache.charObj && turnCache.chatObj && Array.isArray(turnCache.charObj.chats)) {
            turnCache.charObj.chats[turnCache.chatIndex] = turnCache.chatObj;
        }
    }

    function stageUserTurnMessage(userText) {
        if (!turnCache.active || !turnCache.chatObj || !userText) return -1;
        if (!Array.isArray(turnCache.chatObj.message)) turnCache.chatObj.message = [];
        const chatId = crypto.randomUUID();
        turnCache.chatObj.message.push({
            role: 'user',
            data: String(userText),
            chatId,
            time: Date.now(),
        });
        turnCache.stagedUserIdx = turnCache.chatObj.message.length - 1;
        turnCache.stagedUserChatId = chatId;
        if (turnCache.charObj && Array.isArray(turnCache.charObj.chats)) {
            turnCache.charObj.chats[turnCache.chatIndex] = turnCache.chatObj;
        }
        return turnCache.stagedUserIdx;
    }

    function unstageUserTurnMessage() {
        if (!turnCache.active || !turnCache.chatObj || turnCache.stagedUserIdx < 0) return;
        if (Array.isArray(turnCache.chatObj.message) && turnCache.chatObj.message.length > turnCache.stagedUserIdx) {
            turnCache.chatObj.message.splice(turnCache.stagedUserIdx, 1);
        }
        turnCache.stagedUserIdx = -1;
        turnCache.stagedUserChatId = '';
    }

    async function runEditInput(userText) {
        let out = String(userText ?? '');
        for (const h of [...hookState.editinput]) {
            try {
                const res = await h.fn(out);
                if (typeof res === 'string') out = res;
            } catch (e) {
                console.warn(`[Plugin:${h.pluginName}] editinput error:`, e.message);
            }
        }
        return out;
    }

    async function runBeforeRequest(messages, mode = 'model') {
        let msgs = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
        if (hookState.editprocess.length) {
            for (const h of [...hookState.editprocess]) {
                try {
                    for (let i = 0; i < msgs.length; i += 1) {
                        const res = await h.fn(String(msgs[i].content ?? ''));
                        if (typeof res === 'string') msgs[i].content = res;
                    }
                } catch (e) {
                    console.warn(`[Plugin:${h.pluginName}] editprocess error:`, e.message);
                }
            }
        }
        for (const h of [...hookState.beforeRequest]) {
            try {
                const inputCopy = msgs.map((m) => ({ ...m }));
                const res = await h.fn(inputCopy, mode);
                if (Array.isArray(res)) {
                    msgs = res;
                } else if (res && typeof res === 'object' && Array.isArray(res.content)) {
                    msgs = res.content;
                }
            } catch (e) {
                console.warn(`[Plugin:${h.pluginName}] beforeRequest error:`, e.message);
            }
        }
        return msgs;
    }

    async function runBodyIntercepters(bodyObj, type = 'openai') {
        let current = bodyObj;
        for (const h of [...hookState.bodyIntercepter]) {
            try {
                const res = await h.fn(cloneJson(current), type);
                if (res && typeof res === 'object' && !Array.isArray(res)) {
                    current = res;
                }
            } catch (e) {
                console.warn(`[Plugin:${h.pluginName}] bodyIntercepter error:`, e.message);
            }
        }
        return current;
    }

    async function runAfterRequest(text, mode = 'model') {
        let out = String(text ?? '');
        for (const h of [...hookState.afterRequest]) {
            try {
                const res = await h.fn(out, mode);
                if (typeof res === 'string') out = res;
            } catch (e) {
                console.warn(`[Plugin:${h.pluginName}] afterRequest error:`, e.message);
            }
        }
        for (const h of [...hookState.editoutput]) {
            try {
                const res = await h.fn(out);
                if (typeof res === 'string') out = res;
            } catch (e) {
                console.warn(`[Plugin:${h.pluginName}] editoutput error:`, e.message);
            }
        }
        return out;
    }

    function hasEditDisplayHandlers() {
        return hookState.editdisplay.length > 0;
    }

    async function runEditDisplay(text) {
        let out = String(text ?? '');
        if (!hookState.editdisplay.length) return out;
        for (const h of [...hookState.editdisplay]) {
            try {
                const res = await h.fn(out);
                if (typeof res === 'string') out = res;
            } catch (e) {
                console.warn(`[Plugin:${h.pluginName}] editdisplay error:`, e.message);
            }
        }
        return out;
    }

    async function commitTurnReply({ charIndex, chatIndex, assistantText, replaceMsgIndex = -1 }) {
        if (!turnCache.active || !turnCache.chatObj) return { committedViaRpc: false, messageIndex: -1 };
        if (!Array.isArray(turnCache.chatObj.message)) turnCache.chatObj.message = [];
        let messageIndex = -1;
        if (replaceMsgIndex >= 0 && turnCache.chatObj.message[replaceMsgIndex]) {
            turnCache.chatObj.message[replaceMsgIndex].data = String(assistantText ?? '');
            if (!turnCache.chatObj.message[replaceMsgIndex].chatId) {
                turnCache.chatObj.message[replaceMsgIndex].chatId = crypto.randomUUID();
            }
            messageIndex = replaceMsgIndex;
        } else {
            turnCache.chatObj.message.push({
                role: 'char',
                data: String(assistantText ?? ''),
                chatId: crypto.randomUUID(),
                time: Date.now(),
            });
            messageIndex = turnCache.chatObj.message.length - 1;
        }
        turnCache.stagedUserIdx = -1;
        turnCache.stagedUserChatId = '';
        if (turnCache.charObj && Array.isArray(turnCache.charObj.chats)) {
            turnCache.charObj.chats[Number(chatIndex)] = turnCache.chatObj;
        }
        if (isRpcConnected()) {
            await hostRpc.invoke('db.setChat', [Number(charIndex), Number(chatIndex), cloneJson(turnCache.chatObj)]);
            return { committedViaRpc: true, messageIndex };
        }
        return { committedViaRpc: false, messageIndex };
    }

    async function dispatchSurfaceAction({ charIndex, chatIndex, actionHtml = '', dataset = {} } = {}) {
        const cIdx = Number(charIndex);
        const chIdx = Number(chatIndex);
        const needTempTurn = !turnCache.active && !Number.isNaN(cIdx) && !Number.isNaN(chIdx) && cIdx >= 0 && chIdx >= 0;
        if (needTempTurn) {
            await prepareTurn(cIdx, chIdx, getFallbackSnapshot());
        }
        let dispatchedCount = 0;
        try {
            for (const [pName, mockDom] of pluginDoms.entries()) {
                if (!activeHosts.has(pName)) continue;
                const el = mockDom.mountSurfaceActionElement(actionHtml, dataset);
                try {
                    await mockDom.dispatchSurfaceClick(el, 24, 24);
                    dispatchedCount += 1;
                } finally {
                    el.remove();
                }
            }
            return { ok: true, dispatchedCount };
        } finally {
            if (needTempTurn) endTurn();
        }
    }

    async function dispatchChatOutput({ charIndex, chatIndex, messageIndex }) {
        const list = [...hookState.chatOutput];
        if (!list.length) return;
        const charSnap = await dbGetCharacterFromIndex(charIndex);
        const chatSnap = await dbGetChatFromIndex(charIndex, chatIndex);
        const work = Promise.all(list.map(async (h) => {
            try {
                await h.fn({
                    char: cloneJson(charSnap),
                    chat: cloneJson(chatSnap),
                    characterIndex: Number(charIndex),
                    chatIndex: Number(chatIndex),
                    messageIndex: Number(messageIndex),
                });
            } catch (e) {
                console.warn(`[Plugin:${h.pluginName}] chatOutput error:`, e.message);
            }
        }));
        await Promise.race([work, new Promise((r) => setTimeout(r, 1500))]);
    }

    async function handleGuiRpc({ pluginName, method, args = [] }) {
        const entry = getPluginEntry(pluginName);
        if (!entry) throw new Error(`Plugin '${pluginName}' not found`);
        const a = Array.isArray(args) ? args : [];

        if (method === 'getArgument' || method === 'getArg') {
            const rawKey = String(a[0] || '');
            const k = method === 'getArg' && rawKey.includes('::') ? rawKey.split('::').slice(1).join('::') : rawKey;
            const merged = mergePluginArgs(entry);
            return Object.prototype.hasOwnProperty.call(merged, k) ? merged[k] : undefined;
        }
        if (method === 'setArgument' || method === 'setArg') {
            const rawKey = String(a[0] || '');
            const k = method === 'setArg' && rawKey.includes('::') ? rawKey.split('::').slice(1).join('::') : rawKey;
            if (k) await updatePluginArgs(pluginName, { [k]: a[1] });
            return true;
        }

        const storageMatch = String(method || '').match(/^(pluginStorage|safeLocalStorage|localPluginStorage)\.(.+)$/);
        if (storageMatch) {
            const [, kind, op] = storageMatch;
            if (op === 'getItem') return await storeGet(kind, a[0]);
            if (op === 'setItem') return await storeSet(kind, a[0], a[1]);
            if (op === 'removeItem') return await storeRemove(kind, a[0]);
            if (op === 'clear') return await storeClear(kind);
            if (op === 'keys') return await storeKeys(kind);
            if (op === 'key') {
                const ks = await storeKeys(kind);
                return ks[Number(a[0])] ?? null;
            }
            if (op === 'length') return (await storeKeys(kind)).length;
        }

        if (method === 'db.getCurrentCharacterIndex') return (await dbGetCurrentIndices()).charIndex;
        if (method === 'db.getCurrentChatIndex') return (await dbGetCurrentIndices()).chatIndex;
        if (method === 'db.getCharacterActive') return dbGetCharacterFromIndex((await dbGetCurrentIndices()).charIndex);
        if (method === 'db.setCharacterActive') return dbSetCharacterToIndex((await dbGetCurrentIndices()).charIndex, a[0]);
        if (method === 'db.getCharacter') return dbGetCharacterFromIndex(a[0]);
        if (method === 'db.setCharacter') return dbSetCharacterToIndex(a[0], a[1]);
        if (method === 'db.getChatActive') {
            const idx = await dbGetCurrentIndices();
            return dbGetChatFromIndex(idx.charIndex, idx.chatIndex);
        }
        if (method === 'db.getChat') return dbGetChatFromIndex(a[0], a[1]);
        if (method === 'db.setChat') return dbSetChatToIndex(a[0], a[1], a[2]);
        if (method === 'db.getDatabase') return dbGetDatabase(a[0]);
        if (method === 'db.setDatabaseLite') return dbSetDatabase('db.setDatabaseLite', a[0]);
        if (method === 'db.setDatabase') return dbSetDatabase('db.setDatabase', a[0]);
        if (method === 'db.reloadPcPlugins') {
            if (isRpcConnected()) await hostRpc.invoke('db.reloadPcPlugins', []);
            return true;
        }
        if (method === 'asset.readImage') {
            const bytes = await assetReadImage(a[0]);
            return bytes ? { __b64: Buffer.from(bytes).toString('base64') } : null;
        }
        if (method === 'asset.saveAsset') return await assetSaveAsset(a[0]);
        if (method === 'asset.readInlay') return await assetReadInlay(a[0]);
        if (method === 'asset.createInlay') return await assetCreateInlay(a[0], a[1]);

        if (method === 'nativeFetch') {
            const resp = await proxyFetchForPlugin(a[0], a[1], false);
            const buf = Buffer.from(await resp.arrayBuffer());
            const respHeaders = {};
            resp.headers.forEach((v, k) => { respHeaders[k] = v; });
            return {
                status: resp.status,
                statusText: resp.statusText || '',
                headers: respHeaders,
                bodyBase64: buf.toString('base64'),
            };
        }
        if (method === 'risuFetch') {
            const r = await proxyFetchForPlugin(a[0], a[1], true);
            return { ok: r.ok, status: r.status, headers: r.headers, data: r.data };
        }
        if (method === 'runLLMModel') {
            if (typeof runLLM !== 'function') return { type: 'fail', result: 'No active model profile' };
            return await runLLM(a[0] || {}, pluginName, providers);
        }
        if (method === 'ipc.post') {
            return await postIpcMessage(entry, a[0], a[1], a[2]);
        }
        if (method === 'ipc.poll') {
            return pollGuiIpc(pluginName, Number(a[0]) || 0);
        }

        throw new Error(`Unsupported GUI RPC method: ${method}`);
    }

    function getGuiSrcdoc(pluginName, entryId = '', theme = 'dark') {
        const entry = getPluginEntry(pluginName);
        if (!entry) return null;
        const inst = activeHosts.get(pluginName);
        const pluginWithUi = inst
            ? { ...entry, uiItems: inst.record.uiItems }
            : { ...entry, uiItems: [] };
        return {
            plugin: { name: entry.name, displayName: entry.displayName, version: entry.version },
            srcdoc: buildPluginGuiSrcdoc({ plugin: pluginWithUi, entryId, theme }),
        };
    }

    async function dispose() {
        for (const name of [...activeHosts.keys()]) {
            await unloadPlugin(name);
        }
        pluginChannels.clear();
        providers.clear();
        pluginDoms.clear();
        guiIpcOutbox.length = 0;
        for (const k of Object.keys(hookState)) hookState[k].length = 0;
    }

    return {
        listPlugins,
        syncPcPlugins,
        addCustomPlugin,
        removePlugin,
        togglePlugin,
        updatePluginArgs,
        reconcileEnabledPlugins,
        hasEnabledPlugins,
        getRegisteredProviders: () => providers,
        getTurnContext,
        setTurnObjects,
        dispatchSurfaceAction,
        pollGuiIpc,
        prepareTurn,
        endTurn,
        stageUserTurnMessage,
        unstageUserTurnMessage,
        runEditInput,
        runBeforeRequest,
        runBodyIntercepters,
        runAfterRequest,
        hasEditDisplayHandlers,
        runEditDisplay,
        readImage: assetReadImage,
        readInlay: assetReadInlay,
        saveAsset: assetSaveAsset,
        createInlay: assetCreateInlay,
        commitTurnReply,
        dispatchChatOutput,
        handleGuiRpc,
        getGuiSrcdoc,
        dispose,
        _debug: { hookState, providers, pluginDoms, fallbackPluginStore, fallbackSafeLocal, fallbackLocalPlugin, fallbackAssetStore, fallbackInlayStore, getAllKnownEntries },
    };
}

module.exports = {
    URL_BLACKLIST,
    parsePluginHeader,
    buildPluginGuiSrcdoc,
    createPluginAdapter,
};
