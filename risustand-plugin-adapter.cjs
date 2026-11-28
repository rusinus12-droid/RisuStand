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
            for (const peer of rest.split(/[\s,]+/)) {
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

function createHeadlessMockDom({ onToastText = null, onChatSurfaceMutated = null } = {}) {
    const VOID_HTML_TAGS = new Set([
        'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
        'link', 'meta', 'param', 'source', 'track', 'wbr',
    ]);
    const RAW_TEXT_TAGS = new Set(['style', 'script', 'textarea']);
    const RAW_MOCK_EL = Symbol('rawMockEl');
    const safeWrapperCache = new WeakMap();
    const unwrapEl = (v) => (v && typeof v === 'object' && v[RAW_MOCK_EL] ? v[RAW_MOCK_EL] : v);
    const mutationObservers = new Set();
    let activePressEl = null;
    let hoverEl = null;
    let focusedEl = null;
    let suppressSurfaceMutationNotify = false;
    let pendingChildMutationTargets = new Set();
    let childMutationFlushScheduled = false;
    let surfaceMutationFlushScheduled = false;

    function markChatRowBodyMutated(targetNode) {
        if (suppressSurfaceMutationNotify) return;
        let cur = unwrapEl(targetNode);
        while (cur && cur !== chatScreen && cur !== body && cur !== documentElement) {
            if (cur.classList && cur.classList.contains('x-risu-am-illustration-footer')) return;
            if (cur.classList && cur.classList.contains('risu-chat')) {
                cur._rsBodyMutated = true;
                return;
            }
            cur = cur.parentNode;
        }
    }

    function scheduleSurfaceMutationNotify(targetNode) {
        if (suppressSurfaceMutationNotify || typeof onChatSurfaceMutated !== 'function') return;
        const raw = unwrapEl(targetNode);
        if (!raw || !chatScreen || (raw !== chatScreen && !chatScreen.contains(raw))) return;
        markChatRowBodyMutated(raw);
        if (surfaceMutationFlushScheduled) return;
        surfaceMutationFlushScheduled = true;
        queueMicrotask(() => {
            surfaceMutationFlushScheduled = false;
            try { onChatSurfaceMutated(); } catch (_) {}
        });
    }

    function notifyChildListMutation(targetNode) {
        const raw = unwrapEl(targetNode);
        if (!raw) return;
        markChatRowBodyMutated(raw);
        if (mutationObservers.size > 0) {
            pendingChildMutationTargets.add(raw);
            if (!childMutationFlushScheduled) {
                childMutationFlushScheduled = true;
                queueMicrotask(() => {
                    childMutationFlushScheduled = false;
                    const changed = Array.from(pendingChildMutationTargets);
                    pendingChildMutationTargets.clear();
                    if (!changed.length || !mutationObservers.size) return;
                    for (const obs of [...mutationObservers]) {
                        const recs = [];
                        for (const [obsNode, opts] of obs.targets.entries()) {
                            for (const t of changed) {
                                if (obsNode === t || (opts && opts.subtree && typeof obsNode.contains === 'function' && obsNode.contains(t))) {
                                    recs.push({ type: 'childList', target: wrapSafeElement(t) || t });
                                    break;
                                }
                            }
                        }
                        if (recs.length && typeof obs.cb === 'function') {
                            try { obs.cb(recs, obs.api); } catch (_) {}
                        }
                    }
                });
            }
        }
        scheduleSurfaceMutationNotify(raw);
    }

    function decodeHtmlEntities(str) {
        return String(str ?? '').replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|#39|apos|nbsp);/g, (m, code) => {
            if (code === 'amp') return '&';
            if (code === 'lt') return '<';
            if (code === 'gt') return '>';
            if (code === 'quot') return '"';
            if (code === '#39' || code === 'apos') return "'";
            if (code === 'nbsp') return '\u00a0';
            if (code.startsWith('#x') || code.startsWith('#X')) {
                const cp = parseInt(code.slice(2), 16);
                return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
            }
            if (code.startsWith('#')) {
                const cp = parseInt(code.slice(1), 10);
                return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
            }
            return m;
        });
    }

    function escapeHtmlAttr(v) {
        return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    }

    function escapeHtmlText(v) {
        return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function splitSelectorTopLevel(str, delimiter = ',') {
        const out = [];
        let start = 0;
        let pDepth = 0;
        let bDepth = 0;
        let quote = '';
        const text = String(str || '');
        for (let i = 0; i < text.length; i += 1) {
            const c = text[i];
            if (quote) {
                if (c === '\\') { i += 1; continue; }
                if (c === quote) quote = '';
                continue;
            }
            if (c === '"' || c === "'") { quote = c; continue; }
            if (c === '(') pDepth += 1;
            else if (c === ')' && pDepth > 0) pDepth -= 1;
            else if (c === '[') bDepth += 1;
            else if (c === ']' && bDepth > 0) bDepth -= 1;
            else if (c === delimiter && pDepth === 0 && bDepth === 0) {
                out.push(text.slice(start, i));
                start = i + 1;
            }
        }
        out.push(text.slice(start));
        return out;
    }

    function findBalancedClose(str, openIdx, openCh = '(', closeCh = ')') {
        let depth = 0;
        let quote = '';
        for (let i = openIdx; i < str.length; i += 1) {
            const c = str[i];
            if (quote) {
                if (c === '\\') { i += 1; continue; }
                if (c === quote) quote = '';
                continue;
            }
            if (c === '"' || c === "'") { quote = c; continue; }
            if (c === openCh) depth += 1;
            else if (c === closeCh) {
                depth -= 1;
                if (depth === 0) return i;
            }
        }
        return -1;
    }

    function tokenizeSelectorChain(chainStr) {
        const steps = [];
        let s = String(chainStr || '').trim();
        let nextComb = ' ';
        let i = 0;
        while (i < s.length) {
            while (i < s.length && /\s/.test(s[i])) i += 1;
            if (i >= s.length) break;
            if (s[i] === '>') {
                nextComb = '>';
                i += 1;
                while (i < s.length && /\s/.test(s[i])) i += 1;
                if (i >= s.length) break;
            }
            const start = i;
            let pDepth = 0;
            let bDepth = 0;
            let quote = '';
            while (i < s.length) {
                const c = s[i];
                if (quote) {
                    if (c === '\\') { i += 2; continue; }
                    if (c === quote) quote = '';
                    i += 1;
                    continue;
                }
                if (c === '"' || c === "'") { quote = c; i += 1; continue; }
                if (c === '(') { pDepth += 1; i += 1; continue; }
                if (c === ')' && pDepth > 0) { pDepth -= 1; i += 1; continue; }
                if (c === '[') { bDepth += 1; i += 1; continue; }
                if (c === ']' && bDepth > 0) { bDepth -= 1; i += 1; continue; }
                if (pDepth === 0 && bDepth === 0 && (c === '>' || /\s/.test(c))) break;
                i += 1;
            }
            const part = s.slice(start, i).trim();
            if (part) {
                steps.push({ comb: nextComb, sel: part });
                nextComb = ' ';
            }
        }
        return steps;
    }

    function matchRelativeHas(anchorEl, hasSelectorList) {
        const chains = splitSelectorTopLevel(hasSelectorList, ',').map((s) => s.trim()).filter(Boolean);
        for (const rawChain of chains) {
            const trimmed = rawChain.trim();
            const directOnly = trimmed.startsWith('>');
            const steps = tokenizeSelectorChain(directOnly ? trimmed.slice(1).trim() : trimmed);
            if (!steps.length) continue;
            if (directOnly) steps[0].comb = '>';
            const candidates = collectMatchingElements(anchorEl, '');
            const walkDesc = (node) => {
                for (const c of node.children || []) {
                    candidates.push(c);
                    walkDesc(c);
                }
            };
            walkDesc(anchorEl);
            for (const cand of candidates) {
                if (!matchSimpleSelector(cand, steps[steps.length - 1].sel)) continue;
                let cur = cand;
                let ok = true;
                for (let idx = steps.length - 1; idx >= 1; idx -= 1) {
                    const step = steps[idx];
                    const prevSel = steps[idx - 1].sel;
                    if (step.comb === '>') {
                        cur = cur.parentElement;
                        if (!cur || !anchorEl.contains(cur) || !matchSimpleSelector(cur, prevSel)) { ok = false; break; }
                    } else {
                        cur = cur.parentElement;
                        while (cur && anchorEl.contains(cur) && !matchSimpleSelector(cur, prevSel)) {
                            cur = cur.parentElement;
                        }
                        if (!cur || !anchorEl.contains(cur)) { ok = false; break; }
                    }
                }
                if (!ok) continue;
                if (steps[0].comb === '>') {
                    if (cur.parentElement === anchorEl) return true;
                } else if (cur !== anchorEl && anchorEl.contains(cur)) {
                    return true;
                }
            }
        }
        return false;
    }

    function matchSimpleSelector(el, token) {
        if (!el || el.nodeType !== 1 || !token) return false;
        let rest = token.trim();
        if (!rest) return false;
        if (rest === '*') return true;

        if (rest.startsWith('*')) {
            rest = rest.slice(1);
        } else {
            const tagMatch = rest.match(/^([a-zA-Z0-9_-]+)/);
            if (tagMatch) {
                if (el.tagName !== tagMatch[1].toUpperCase()) return false;
                rest = rest.slice(tagMatch[1].length);
            }
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
                const closeIdx = findBalancedClose(rest, 0, '[', ']');
                if (closeIdx < 0) return false;
                const expr = rest.slice(1, closeIdx);
                const m = expr.match(/^([a-zA-Z0-9_:-]+)(?:\s*([*^$|~]?=)\s*(?:"([^"]*)"|'([^']*)'|([\s\S]*)))?$/);
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
                if (op === '~=' && !String(actual).split(/\s+/).includes(expected)) return false;
                if (op === '|=' && actual !== expected && !actual.startsWith(`${expected}-`)) return false;
                rest = rest.slice(closeIdx + 1);
            } else if (rest.startsWith(':')) {
                const pm = rest.match(/^::?([a-zA-Z0-9_-]+)/);
                if (!pm) return false;
                const pName = pm[1].toLowerCase();
                let consumed = pm[0].length;
                let inner = null;
                if (rest[consumed] === '(') {
                    const closeIdx = findBalancedClose(rest, consumed, '(', ')');
                    if (closeIdx < 0) return false;
                    inner = rest.slice(consumed + 1, closeIdx);
                    consumed = closeIdx + 1;
                }
                rest = rest.slice(consumed);
                if (pName === 'is' || pName === 'where') {
                    if (!inner || !matchesSelector(el, inner)) return false;
                } else if (pName === 'not') {
                    if (!inner || matchesSelector(el, inner)) return false;
                } else if (pName === 'has') {
                    if (!inner || !matchRelativeHas(el, inner)) return false;
                } else if (pName === 'active') {
                    if (!activePressEl || (el !== activePressEl && !el.contains(activePressEl))) return false;
                } else if (pName === 'hover') {
                    if (!hoverEl || (el !== hoverEl && !el.contains(hoverEl))) return false;
                } else if (pName === 'focus' || pName === 'focus-visible') {
                    if (el !== focusedEl) return false;
                } else if (pName === 'disabled') {
                    if (!el.disabled && !el.hasAttribute('disabled')) return false;
                } else if (pName === 'checked') {
                    if (!el.checked) return false;
                } else if (pName === 'empty') {
                    if ((el.childNodes || []).some((c) => c.nodeType === 1 || (c.nodeType === 3 && c.textContent))) return false;
                } else if (pName === 'first-child') {
                    const siblings = el.parentNode ? (el.parentNode.children || []) : [];
                    if (siblings[0] !== el) return false;
                } else if (pName === 'last-child') {
                    const siblings = el.parentNode ? (el.parentNode.children || []) : [];
                    if (siblings[siblings.length - 1] !== el) return false;
                } else {
                    return false;
                }
            } else {
                return false;
            }
        }
        return true;
    }

    function matchSingleChain(el, chainStr) {
        const steps = tokenizeSelectorChain(chainStr);
        if (!steps.length) return false;
        if (!matchSimpleSelector(el, steps[steps.length - 1].sel)) return false;
        let cur = el;
        for (let i = steps.length - 1; i >= 1; i -= 1) {
            const step = steps[i];
            const parentSel = steps[i - 1].sel;
            if (step.comb === '>') {
                cur = cur.parentElement;
                if (!cur || !matchSimpleSelector(cur, parentSel)) return false;
            } else {
                cur = cur.parentElement;
                while (cur && !matchSimpleSelector(cur, parentSel)) {
                    cur = cur.parentElement;
                }
                if (!cur) return false;
            }
        }
        return true;
    }

    function matchesSelector(el, selectorList) {
        if (!selectorList) return false;
        const chains = splitSelectorTopLevel(selectorList, ',').map((s) => s.trim()).filter(Boolean);
        return chains.some((ch) => matchSingleChain(el, ch));
    }

    function collectMatchingElements(rootNode, selectorList) {
        const out = [];
        if (!rootNode || !selectorList) return out;
        const walk = (node) => {
            for (const c of node.childNodes || []) {
                if (c && c.nodeType === 1) {
                    if (matchesSelector(c, selectorList)) out.push(c);
                    walk(c);
                }
            }
        };
        walk(rootNode);
        return out;
    }

    function makeSafeNodeList(arr) {
        const list = Array.isArray(arr) ? arr : [];
        const target = {
            async length() { return list.length; },
            async at(i) {
                const idx = Number(i);
                return Number.isInteger(idx) && idx >= 0 && idx < list.length ? list[idx] : undefined;
            },
            item(i) {
                const idx = Number(i);
                return Number.isInteger(idx) && idx >= 0 && idx < list.length ? list[idx] : null;
            },
            forEach(fn, thisArg) { list.forEach(fn, thisArg); },
            map(fn, thisArg) { return list.map(fn, thisArg); },
            filter(fn, thisArg) { return list.filter(fn, thisArg); },
            some(fn, thisArg) { return list.some(fn, thisArg); },
            [Symbol.iterator]() { return list[Symbol.iterator](); },
        };
        for (let i = 0; i < list.length; i += 1) target[i] = list[i];
        return target;
    }

    class AttrMap extends Map {
        get length() { return this.size; }
        *[Symbol.iterator]() {
            for (const [name, value] of this.entries()) {
                yield { name, value };
            }
        }
    }

    class MockTextNode {
        constructor(text = '') {
            this.nodeType = 3;
            this.nodeName = '#text';
            this.parentNode = null;
            this.parentElement = null;
            this._data = String(text ?? '');
        }
        get data() { return this._data; }
        set data(v) { this._data = String(v ?? ''); }
        get textContent() { return this._data; }
        set textContent(v) { this._data = String(v ?? ''); }
        remove() {
            if (this.parentNode && typeof this.parentNode.removeChild === 'function') {
                this.parentNode.removeChild(this);
            }
        }
        replaceWith(...nodes) {
            if (this.parentNode && typeof this.parentNode._replaceChildWithMany === 'function') {
                this.parentNode._replaceChildWithMany(this, nodes);
            }
        }
        cloneNode() { return new MockTextNode(this._data); }
    }

    function parseHtmlAttributesIntoElement(el, rawAttrStr) {
        if (!rawAttrStr) return;
        const rx = /([a-zA-Z0-9_:@.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
        let m;
        while ((m = rx.exec(rawAttrStr)) !== null) {
            const k = m[1];
            const rawVal = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : ''));
            el.setAttribute(k, decodeHtmlEntities(rawVal));
        }
    }

    function parseHtmlFragmentToNodes(rawHtml) {
        const root = new MockElement('#fragment');
        root.nodeType = 11;
        const stack = [root];
        const html = String(rawHtml ?? '');
        let i = 0;
        const appendNodeToCur = (node) => {
            const parent = stack[stack.length - 1];
            if (parent.tagName === 'TEMPLATE' && parent.content) parent.content.appendChild(node);
            else parent.appendChild(node);
        };
        while (i < html.length) {
            const lt = html.indexOf('<', i);
            if (lt < 0) {
                const txt = decodeHtmlEntities(html.slice(i));
                if (txt) appendNodeToCur(new MockTextNode(txt));
                break;
            }
            if (lt > i) {
                const txt = decodeHtmlEntities(html.slice(i, lt));
                if (txt) appendNodeToCur(new MockTextNode(txt));
            }
            if (html.startsWith('<!--', lt)) {
                const endComment = html.indexOf('-->', lt + 4);
                i = endComment >= 0 ? endComment + 3 : html.length;
                continue;
            }
            // Scan tag end accounting for quoted attribute values containing '>'
            let gt = -1;
            let q = '';
            for (let j = lt + 1; j < html.length; j += 1) {
                const ch = html[j];
                if (q) {
                    if (ch === q) q = '';
                } else if (ch === '"' || ch === "'") {
                    q = ch;
                } else if (ch === '>') {
                    gt = j;
                    break;
                }
            }
            if (gt < 0) {
                appendNodeToCur(new MockTextNode(decodeHtmlEntities(html.slice(lt))));
                break;
            }
            const tagBody = html.slice(lt + 1, gt);
            i = gt + 1;
            const closeMatch = tagBody.match(/^\/\s*([a-zA-Z0-9_-]+)/);
            if (closeMatch) {
                const closeTag = closeMatch[1].toUpperCase();
                for (let k = stack.length - 1; k >= 1; k -= 1) {
                    if (stack[k].tagName === closeTag) {
                        stack.length = k;
                        break;
                    }
                }
                continue;
            }
            const openMatch = tagBody.match(/^([a-zA-Z0-9_-]+)([\s\S]*)$/);
            if (!openMatch) continue;
            const tagNameLower = openMatch[1].toLowerCase();
            let restAttrs = openMatch[2] || '';
            let explicitSelfClose = false;
            if (/\/\s*$/.test(restAttrs)) {
                explicitSelfClose = true;
                restAttrs = restAttrs.replace(/\/\s*$/, '');
            }
            const el = new MockElement(tagNameLower);
            parseHtmlAttributesIntoElement(el, restAttrs);
            appendNodeToCur(el);

            if (RAW_TEXT_TAGS.has(tagNameLower) && !explicitSelfClose) {
                const endRx = new RegExp(`<\\/\\s*${tagNameLower}\\s*>`, 'i');
                const slice = html.slice(i);
                const endM = endRx.exec(slice);
                if (endM) {
                    const rawContent = slice.slice(0, endM.index);
                    if (rawContent) el.appendChild(new MockTextNode(rawContent));
                    i += endM.index + endM[0].length;
                }
                continue;
            }
            if (!explicitSelfClose && !VOID_HTML_TAGS.has(tagNameLower)) {
                stack.push(el);
            }
        }
        return [...root.childNodes];
    }

    const listeners = new Map();
    let seq = 0;
    const elementListeners = new WeakMap();

    class MockElement {
        constructor(tagName = 'div') {
            this.tagName = String(tagName || 'div').toUpperCase();
            this.nodeName = this.tagName;
            this.nodeType = this.tagName === '#DOCUMENT-FRAGMENT' || this.tagName === '#FRAGMENT' ? 11 : 1;
            this.id = '';
            this.className = '';
            this._styleMap = Object.create(null);
            this._styleRaw = '';
            this.style = new Proxy(this._styleMap, {
                set: (tgt, prop, val) => {
                    const k = String(prop);
                    if (k === 'cssText') {
                        void this.setStyleAttribute(val);
                        return true;
                    }
                    if (val === null || val === undefined || val === '') delete tgt[k];
                    else tgt[k] = String(val);
                    this._syncStyleAttr();
                    return true;
                },
                get: (tgt, prop) => {
                    if (prop === 'cssText') return this._styleRaw;
                    return typeof prop === 'string' && Object.prototype.hasOwnProperty.call(tgt, prop) ? tgt[prop] : '';
                },
            });
            this.dataset = {};
            this.attributes = new AttrMap();
            this.childNodes = [];
            this.parentNode = null;
            this.parentElement = null;
            this._outerHTMLOverride = '';
            this._rect = { top: 16, left: 16, right: 240, bottom: 64, width: 224, height: 48 };
            this.value = '';
            this.checked = false;
            this.disabled = false;
            if (this.tagName === 'TEMPLATE') {
                this.content = new MockElement('#document-fragment');
            }
            const self = this;
            this.classList = {
                add: (...cls) => {
                    const set = new Set(String(self.className || '').split(/\s+/).filter(Boolean));
                    let changed = false;
                    for (const c of cls) {
                        if (c && !set.has(String(c))) {
                            set.add(String(c));
                            changed = true;
                        }
                    }
                    const next = Array.from(set).join(' ');
                    self.className = next;
                    if (next) self.attributes.set('class', next);
                    else self.attributes.delete('class');
                    if (changed) scheduleSurfaceMutationNotify(self);
                },
                remove: (...cls) => {
                    const set = new Set(String(self.className || '').split(/\s+/).filter(Boolean));
                    let changed = false;
                    for (const c of cls) {
                        if (set.delete(String(c))) changed = true;
                    }
                    const next = Array.from(set).join(' ');
                    self.className = next;
                    if (next) self.attributes.set('class', next);
                    else self.attributes.delete('class');
                    if (changed) scheduleSurfaceMutationNotify(self);
                },
                contains: (c) => {
                    const key = String(c);
                    const list = String(self.className || '').split(/\s+/).filter(Boolean);
                    if (list.includes(key)) return true;
                    if (self._rsAllowRisuPrefixMatch && key.startsWith('x-risu-')) {
                        return list.includes(key.slice(7));
                    }
                    return false;
                },
                toggle: (c, force) => {
                    const has = self.classList.contains(c);
                    const next = force === undefined ? !has : Boolean(force);
                    if (next) self.classList.add(c);
                    else self.classList.remove(c);
                    return next;
                },
            };
        }
        get children() {
            return this.childNodes.filter((c) => c && c.nodeType === 1);
        }
        get firstElementChild() {
            const kids = this.children;
            return kids.length ? kids[0] : null;
        }
        get lastElementChild() {
            const kids = this.children;
            return kids.length ? kids[kids.length - 1] : null;
        }
        _syncStyleAttr() {
            const parts = [];
            for (const [k, v] of Object.entries(this._styleMap)) {
                const cssProp = k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
                parts.push(`${cssProp}:${v}`);
            }
            const next = parts.join('; ');
            const prevStyle = this._styleRaw;
            this._styleRaw = next;
            if (next) this.attributes.set('style', next);
            else this.attributes.delete('style');
            if (prevStyle !== next) scheduleSurfaceMutationNotify(this);
        }
        _clearChildNodes() {
            const target = (this.tagName === 'TEMPLATE' && this.content) ? this.content : this;
            const hadChildren = target.childNodes.length > 0;
            for (const ch of target.childNodes) {
                if (ch && typeof ch === 'object') {
                    ch.parentNode = null;
                    ch.parentElement = null;
                }
            }
            target.childNodes.length = 0;
            if (hadChildren) notifyChildListMutation(this);
        }
        _replaceChildWithMany(oldCh, rawNodes) {
            const rawOld = unwrapEl(oldCh);
            const idx = this.childNodes.indexOf(rawOld);
            if (idx < 0) return;
            rawOld.parentNode = null;
            rawOld.parentElement = null;
            const list = [];
            for (const rawItem of rawNodes) {
                if (rawItem === null || rawItem === undefined) continue;
                const unwrapped = unwrapEl(rawItem);
                const node = typeof unwrapped === 'string' ? new MockTextNode(unwrapped) : unwrapped;
                if (node && typeof node === 'object') {
                    if (node.nodeType === 11 && Array.isArray(node.childNodes)) {
                        for (const sub of [...node.childNodes]) {
                            sub.parentNode = this;
                            sub.parentElement = this.nodeType === 1 ? this : null;
                            list.push(sub);
                        }
                        node.childNodes.length = 0;
                    } else {
                        if (node.parentNode && node.parentNode !== this && typeof node.parentNode.removeChild === 'function') {
                            node.parentNode.removeChild(node);
                        }
                        node.parentNode = this;
                        node.parentElement = this.nodeType === 1 ? this : null;
                        list.push(node);
                    }
                }
            }
            this.childNodes.splice(idx, 1, ...list);
            notifyChildListMutation(this);
        }
        get innerHTML() {
            const list = (this.tagName === 'TEMPLATE' && this.content) ? this.content.childNodes : this.childNodes;
            const rawTag = this.tagName.toLowerCase();
            const isRaw = RAW_TEXT_TAGS.has(rawTag);
            return list.map((c) => {
                if (!c) return '';
                if (c.nodeType === 1) return c.outerHTML;
                if (c.nodeType === 3) return isRaw ? String(c.textContent || '') : escapeHtmlText(c.textContent || '');
                return '';
            }).join('');
        }
        set innerHTML(v) {
            this._outerHTMLOverride = '';
            this._clearChildNodes();
            const parsed = parseHtmlFragmentToNodes(v);
            const target = (this.tagName === 'TEMPLATE' && this.content) ? this.content : this;
            for (const n of parsed) target.appendChild(n);
            if (typeof onToastText === 'function' && (this.hasAttribute('data-am-toast-region') || this.hasAttribute('data-plugin-chat-panel'))) {
                const msgEl = this.querySelector('.x-risu-am-runtime-toast__message') || this.querySelector('.mscs-preview');
                const detEl = this.querySelector('.x-risu-am-runtime-toast__detail');
                const msg = msgEl ? String(msgEl.textContent || '').trim() : '';
                const det = detEl ? String(detEl.textContent || '').trim() : '';
                const combined = det ? `${msg} · ${det}` : msg;
                if (combined) {
                    try { onToastText(combined); } catch (_) {}
                }
            }
        }
        get outerHTML() {
            if (this._outerHTMLOverride) return this._outerHTMLOverride;
            const tag = this.tagName.toLowerCase();
            const attrPairs = [];
            if (this.id && !this.attributes.has('id')) attrPairs.push(`id="${escapeHtmlAttr(this.id)}"`);
            if (this.className && !this.attributes.has('class')) attrPairs.push(`class="${escapeHtmlAttr(this.className)}"`);
            for (const [k, v] of this.attributes.entries()) {
                const escaped = escapeHtmlAttr(v);
                attrPairs.push(v === '' ? `${k}=""` : `${k}="${escaped}"`);
            }
            const open = attrPairs.length ? `<${tag} ${attrPairs.join(' ')}>` : `<${tag}>`;
            if (VOID_HTML_TAGS.has(tag)) return open;
            const bodyHtml = this.innerHTML;
            return `${open}${bodyHtml}</${tag}>`;
        }
        get textContent() {
            const list = (this.tagName === 'TEMPLATE' && this.content) ? this.content.childNodes : this.childNodes;
            return list.map((c) => (c && typeof c.textContent === 'string' ? c.textContent : '')).join('');
        }
        set textContent(v) {
            this._outerHTMLOverride = '';
            this._clearChildNodes();
            const s = String(v ?? '');
            if (s !== '') {
                const target = (this.tagName === 'TEMPLATE' && this.content) ? this.content : this;
                target.appendChild(new MockTextNode(s));
            }
        }
        async innerText() { return this.textContent; }
        async setInnerText(v) { this.textContent = v; }
        async setInnerHTML(v) { this.innerHTML = v; }
        async getInnerHTML() { return this.innerHTML; }
        async getOuterHTML() { return this.outerHTML; }
        async setOuterHTML(v) {
            const raw = String(v ?? '');
            this._outerHTMLOverride = '';
            if (this.parentNode && typeof this.parentNode._replaceChildWithMany === 'function') {
                const nodes = parseHtmlFragmentToNodes(raw);
                this.parentNode._replaceChildWithMany(this, nodes);
            } else {
                this._outerHTMLOverride = raw;
            }
        }
        async setTextContent(v) { this.textContent = v; }
        async getTextContent() { return this.textContent; }
        async setStyle(prop, val) { this.style[String(prop || '')] = String(val ?? ''); }
        async getStyle(prop) { return this.style[String(prop || '')] || ''; }
        async getStyleAttribute() { return this.attributes.has('style') ? this.attributes.get('style') : this._styleRaw; }
        async setStyleAttribute(val) {
            const raw = String(val ?? '');
            this._styleRaw = raw;
            for (const k of Object.keys(this._styleMap)) delete this._styleMap[k];
            for (const decl of raw.split(';')) {
                const idx = decl.indexOf(':');
                if (idx <= 0) continue;
                const k = decl.slice(0, idx).trim();
                const v = decl.slice(idx + 1).trim();
                if (k) this._styleMap[k] = v;
            }
            if (raw) this.attributes.set('style', raw);
            else this.attributes.delete('style');
        }
        async setClassName(v) {
            const next = String(v ?? '');
            this.className = next;
            if (next) this.attributes.set('class', next);
            else this.attributes.delete('class');
        }
        async getClassName() { return this.className; }
        async addClass(...cls) { this.classList.add(...cls); }
        async removeClass(...cls) { this.classList.remove(...cls); }
        async hasClass(c) { return this.classList.contains(c); }
        async getChildren() { return this.children; }
        async getParent() { return this.parentElement; }
        async clientHeight() { return (await this.getBoundingClientRect()).height || 0; }
        async clientWidth() { return (await this.getBoundingClientRect()).width || 0; }
        async clientTop() { return (await this.getBoundingClientRect()).top || 0; }
        async clientLeft() { return (await this.getBoundingClientRect()).left || 0; }
        hasAttribute(k) { return this.attributes.has(String(k)); }
        matches(sel) { return matchesSelector(this, sel); }
        setAttribute(k, v) {
            const key = String(k);
            const val = String(v ?? '');
            const prev = this.attributes.has(key) ? this.attributes.get(key) : null;
            this.attributes.set(key, val);
            if (key === 'id') this.id = val;
            if (key === 'class') this.className = val;
            if (key === 'disabled') this.disabled = val !== 'false';
            if (key === 'checked') this.checked = val !== 'false';
            if (key === 'value') this.value = val;
            if (key === 'style') void this.setStyleAttribute(val);
            if (key.startsWith('data-')) this.dataset[attrNameToDatasetKey(key)] = val;
            if (prev !== val && (key.startsWith('x-') || key.startsWith('data-') || key === 'class' || key === 'src' || key === 'style' || key === 'hidden' || key === 'disabled' || key === 'aria-disabled' || key === 'aria-label')) {
                scheduleSurfaceMutationNotify(this);
            }
        }
        getAttribute(k) { return this.attributes.has(String(k)) ? this.attributes.get(String(k)) : null; }
        removeAttribute(k) {
            const key = String(k);
            const had = this.attributes.has(key);
            this.attributes.delete(key);
            if (key === 'id') this.id = '';
            if (key === 'class') this.className = '';
            if (key === 'disabled') this.disabled = false;
            if (key === 'checked') this.checked = false;
            if (key === 'style') void this.setStyleAttribute('');
            if (key.startsWith('data-')) delete this.dataset[attrNameToDatasetKey(key)];
            if (had && (key.startsWith('x-') || key.startsWith('data-') || key === 'class' || key === 'src' || key === 'style' || key === 'hidden' || key === 'disabled' || key === 'aria-disabled' || key === 'aria-label')) {
                scheduleSurfaceMutationNotify(this);
            }
        }
        appendChild(chRaw) {
            const ch = unwrapEl(chRaw);
            if (ch && typeof ch === 'object') {
                if (ch.nodeType === 11 && Array.isArray(ch.childNodes)) {
                    for (const sub of [...ch.childNodes]) this.appendChild(sub);
                    return chRaw;
                }
                if (ch.parentNode && ch.parentNode !== this && typeof ch.parentNode.removeChild === 'function') {
                    ch.parentNode.removeChild(ch);
                }
                ch.parentNode = this;
                ch.parentElement = this.nodeType === 1 ? this : null;
                this.childNodes.push(ch);
                notifyChildListMutation(this);
            }
            return chRaw;
        }
        append(...items) {
            for (const ch of items) {
                if (ch === null || ch === undefined) continue;
                const unwrapped = unwrapEl(ch);
                this.appendChild(typeof unwrapped === 'string' ? new MockTextNode(unwrapped) : unwrapped);
            }
        }
        prepend(...items) {
            let added = false;
            for (let i = items.length - 1; i >= 0; i -= 1) {
                const raw = unwrapEl(items[i]);
                if (raw === null || raw === undefined) continue;
                const ch = typeof raw === 'string' ? new MockTextNode(raw) : raw;
                if (ch && typeof ch === 'object') {
                    if (ch.parentNode && ch.parentNode !== this && typeof ch.parentNode.removeChild === 'function') {
                        ch.parentNode.removeChild(ch);
                    }
                    ch.parentNode = this;
                    ch.parentElement = this.nodeType === 1 ? this : null;
                    this.childNodes.unshift(ch);
                    added = true;
                }
            }
            if (added) notifyChildListMutation(this);
        }
        removeChild(chRaw) {
            const ch = unwrapEl(chRaw);
            const idx = this.childNodes.indexOf(ch);
            if (idx >= 0) {
                this.childNodes.splice(idx, 1);
                ch.parentNode = null;
                ch.parentElement = null;
                notifyChildListMutation(this);
            }
            return chRaw;
        }
        replaceChild(newCh, oldCh) {
            const rawOld = unwrapEl(oldCh);
            const rawNew = unwrapEl(newCh);
            const idx = this.childNodes.indexOf(rawOld);
            if (idx >= 0 && rawNew && typeof rawNew === 'object') {
                this._replaceChildWithMany(rawOld, [rawNew]);
            }
            return oldCh;
        }
        replaceWith(...nodes) {
            if (this.parentNode && typeof this.parentNode._replaceChildWithMany === 'function') {
                this.parentNode._replaceChildWithMany(this, nodes.map(unwrapEl));
            }
        }
        cloneNode(deep = false) {
            const c = new MockElement(this.tagName);
            c.id = this.id;
            c.className = this.className;
            c.disabled = this.disabled;
            c.checked = this.checked;
            c.value = this.value;
            for (const [k, v] of this.attributes.entries()) c.attributes.set(k, v);
            void c.setStyleAttribute(this._styleRaw);
            if (deep) {
                for (const ch of this.childNodes) {
                    if (ch && typeof ch.cloneNode === 'function') c.appendChild(ch.cloneNode(true));
                }
            }
            return c;
        }
        remove() {
            if (this.parentNode && typeof this.parentNode.removeChild === 'function') {
                this.parentNode.removeChild(this);
            }
        }
        contains(target) {
            const t = unwrapEl(target);
            if (t === this) return true;
            return this.childNodes.some((c) => typeof c.contains === 'function' && c.contains(t));
        }
        closest(sel) {
            let cur = this;
            while (cur && cur.nodeType === 1) {
                if (matchesSelector(cur, sel)) return cur;
                cur = cur.parentElement;
            }
            return null;
        }
        querySelector(sel) {
            return collectMatchingElements(this, sel)[0] || null;
        }
        querySelectorAll(sel) {
            return makeSafeNodeList(collectMatchingElements(this, sel));
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
                    if (rec.ev === evName) {
                        try {
                            await rec.fn(evObj);
                        } catch (err) {
                            console.error('[PluginDom] element listener error:', err && err.message ? err.message : String(err));
                        }
                        if (evObj && evObj.immediatePropagationStopped) break;
                    }
                }
            }
            return true;
        }
        focus() { focusedEl = this; }
        blur() { if (focusedEl === this) focusedEl = null; }
        async click() {
            const rect = await this.getBoundingClientRect();
            const x = (rect.left || 0) + Math.min(10, Math.floor((rect.width || 20) / 2));
            const y = (rect.top || 0) + Math.min(10, Math.floor((rect.height || 20) / 2));
            await dispatchSurfaceClick(this, x, y);
        }
        getBoundingClientRect() {
            if (this.hasAttribute('data-am-floating-viewport')) {
                return { top: 0, left: 0, right: 1024, bottom: 900, width: 1024, height: 900 };
            }
            return { ...this._rect };
        }
    }

    const head = new MockElement('head');
    const body = new MockElement('body');
    body._rect = { top: 0, left: 0, right: 1024, bottom: 900, width: 1024, height: 900 };
    const chatScreen = new MockElement('div');
    chatScreen.className = 'default-chat-screen rs-chat-surface';
    chatScreen._rect = { top: 0, left: 0, right: 1024, bottom: 900, width: 1024, height: 900 };
    body.appendChild(chatScreen);

    const documentElement = new MockElement('html');
    documentElement._rect = { top: 0, left: 0, right: 1024, bottom: 900, width: 1024, height: 900 };
    documentElement.appendChild(head);
    documentElement.appendChild(body);

    async function dispatchDocListeners(type, eventObj, syncEventObj) {
        const list = [...listeners.values()].filter((v) => v.ev === type);
        for (const rec of list) {
            const evArg = rec.sync && syncEventObj ? syncEventObj : eventObj;
            try {
                await rec.fn(evArg);
            } catch (err) {
                console.error('[PluginDom] doc listener error:', err && err.message ? err.message : String(err));
            }
            if (evArg && evArg.immediatePropagationStopped) break;
        }
    }

    async function dispatchSurfaceClick(targetEl, x = 24, y = 24) {
        const rawTarget = unwrapEl(targetEl);
        const isolateRect = Boolean(
            rawTarget
            && rawTarget.nodeType === 1
            && rawTarget !== chatScreen
            && rawTarget !== body
            && rawTarget !== documentElement
        );
        const savedRect = isolateRect && rawTarget._rect ? { ...rawTarget._rect } : null;
        if (isolateRect) {
            rawTarget._rect = { top: 14000, left: 400, right: 448, bottom: 14048, width: 48, height: 48 };
        }
        let clickX = isolateRect ? 424 : Number(x);
        let clickY = isolateRect ? 14024 : Number(y);
        if (!isolateRect && rawTarget && typeof rawTarget.getBoundingClientRect === 'function') {
            const rect = await rawTarget.getBoundingClientRect();
            if (rect && rect.width > 0 && rect.height > 0) {
                const inside = Number.isFinite(clickX) && Number.isFinite(clickY)
                    && clickX >= rect.left && clickX <= rect.right
                    && clickY >= rect.top && clickY <= rect.bottom;
                if (!inside) {
                    clickX = rect.left + Math.max(2, Math.floor(rect.width / 2));
                    clickY = rect.top + Math.max(2, Math.floor(rect.height / 2));
                }
            }
        }
        if (!Number.isFinite(clickX)) clickX = 24;
        if (!Number.isFinite(clickY)) clickY = 24;

        const wrappedTarget = wrapSafeElement(rawTarget) || rawTarget;
        const wrappedDoc = wrapSafeElement(documentElement) || documentElement;
        const makeEvPair = (type) => {
            const evState = { defaultPrevented: false, propagationStopped: false, immediatePropagationStopped: false };
            const makeView = (target, currentTarget) => ({
                type,
                bubbles: true,
                cancelable: true,
                composed: true,
                clientX: clickX,
                clientY: clickY,
                pageX: clickX,
                pageY: clickY,
                button: 0,
                buttons: type === 'mousedown' ? 1 : 0,
                target,
                currentTarget,
                get defaultPrevented() { return evState.defaultPrevented; },
                get propagationStopped() { return evState.propagationStopped; },
                get immediatePropagationStopped() { return evState.immediatePropagationStopped; },
                preventDefault() { evState.defaultPrevented = true; },
                stopPropagation() { evState.propagationStopped = true; },
                stopImmediatePropagation() { evState.propagationStopped = true; evState.immediatePropagationStopped = true; },
            });
            return {
                asyncEv: makeView(wrappedTarget, wrappedDoc),
                syncEv: makeView(rawTarget, documentElement),
            };
        };

        const dispatchBubble = async (ev) => {
            let cur = rawTarget;
            while (cur && cur.nodeType === 1 && !ev.propagationStopped) {
                if (typeof cur.dispatchEvent === 'function') {
                    await cur.dispatchEvent(ev);
                }
                cur = cur.parentElement;
            }
        };

        activePressEl = rawTarget || null;
        hoverEl = rawTarget || null;
        focusedEl = rawTarget || null;
        try {
            for (const type of ['mouseover', 'mouseenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
                const { asyncEv, syncEv } = makeEvPair(type);
                await dispatchDocListeners(type, asyncEv, syncEv);
                await dispatchBubble(asyncEv);
            }
            await new Promise((r) => setTimeout(r, 12));
            return true;
        } finally {
            activePressEl = null;
            if (isolateRect && savedRect) rawTarget._rect = savedRect;
        }
    }

    async function dispatchElementInput(targetEl, { value, checked, eventType = 'input' } = {}) {
        const rawTarget = unwrapEl(targetEl);
        if (!rawTarget || rawTarget.nodeType !== 1) return false;
        focusedEl = rawTarget;
        if (value !== undefined) {
            rawTarget.value = String(value);
            if (rawTarget.tagName === 'TEXTAREA') {
                rawTarget.textContent = String(value);
            } else if (rawTarget.tagName === 'INPUT') {
                rawTarget.attributes.set('value', String(value));
            }
        }
        if (typeof checked === 'boolean') {
            rawTarget.checked = checked;
            if (checked) rawTarget.attributes.set('checked', '');
            else rawTarget.attributes.delete('checked');
        }
        const evName = eventType === 'change' ? 'change' : 'input';
        const wrappedTarget = wrapSafeElement(rawTarget) || rawTarget;
        const wrappedDoc = wrapSafeElement(documentElement) || documentElement;
        const makeEvPair = (type) => {
            const evState = { defaultPrevented: false, propagationStopped: false, immediatePropagationStopped: false };
            const makeView = (target, currentTarget) => ({
                type,
                bubbles: true,
                cancelable: true,
                composed: true,
                target,
                currentTarget,
                get defaultPrevented() { return evState.defaultPrevented; },
                get propagationStopped() { return evState.propagationStopped; },
                get immediatePropagationStopped() { return evState.immediatePropagationStopped; },
                preventDefault() { evState.defaultPrevented = true; },
                stopPropagation() { evState.propagationStopped = true; },
                stopImmediatePropagation() { evState.propagationStopped = true; evState.immediatePropagationStopped = true; },
            });
            return {
                asyncEv: makeView(wrappedTarget, wrappedDoc),
                syncEv: makeView(rawTarget, documentElement),
            };
        };
        const dispatchBubble = async (ev) => {
            let cur = rawTarget;
            while (cur && cur.nodeType === 1 && !ev.propagationStopped) {
                if (typeof cur.dispatchEvent === 'function') {
                    await cur.dispatchEvent(ev);
                }
                cur = cur.parentElement;
            }
        };
        const pair1 = makeEvPair(evName);
        await dispatchDocListeners(evName, pair1.asyncEv, pair1.syncEv);
        await dispatchBubble(pair1.asyncEv);
        if (evName === 'change') {
            const pairIn = makeEvPair('input');
            await dispatchDocListeners('input', pairIn.asyncEv, pairIn.syncEv);
            await dispatchBubble(pairIn.asyncEv);
        }
        await new Promise((r) => setTimeout(r, 10));
        return true;
    }

    function matchElementByAttrs(roots, {
        selector = '',
        countNode = '',
        actionHtml = '',
        dataset = {},
        textContent = '',
        ariaLabel = '',
        title = '',
        className = '',
        siblingIndex = -1,
    } = {}) {
        if (countNode) {
            const escVal = String(countNode).replace(/"/g, '\\"');
            for (const r of roots) {
                if (matchesSelector(r, `[data-am-count-node="${escVal}"]`)) return r;
                const hit = collectMatchingElements(r, `[data-am-count-node="${escVal}"]`)[0];
                if (hit) return hit;
            }
        }
        if (selector) {
            for (const r of roots) {
                if (matchesSelector(r, selector)) return r;
                const hit = collectMatchingElements(r, selector)[0];
                if (hit) return hit;
            }
        }
        const parsed = parseAttributesFromHtml(actionHtml);
        const matchAttrs = new Map(parsed.attrs.entries());
        if (dataset && typeof dataset === 'object') {
            for (const [k, v] of Object.entries(dataset)) {
                const attrName = (k.startsWith('data-') || k.startsWith('x-'))
                    ? k
                    : `data-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
                if (!matchAttrs.has(attrName)) matchAttrs.set(attrName, String(v ?? ''));
            }
        }
        const idAttr = matchAttrs.get('id');
        if (idAttr) {
            const escId = idAttr.replace(/[^a-zA-Z0-9_-]/g, '');
            if (escId) {
                for (const r of roots) {
                    const hit = r.id === idAttr ? r : collectMatchingElements(r, `#${escId}`)[0];
                    if (hit) return hit;
                }
            }
        }
        const wantText = String(textContent || '').replace(/\s+/g, ' ').trim();
        const wantAria = String(ariaLabel || matchAttrs.get('aria-label') || '').trim();
        const wantTitle = String(title || matchAttrs.get('title') || '').trim();
        const wantClassTokens = String(className || matchAttrs.get('class') || '').split(/\s+/).filter(Boolean);
        const wantSrc = String(matchAttrs.get('src') || '').trim();
        const wantSibIdx = Number(siblingIndex);

        const significantKeys = [];
        for (const [k, v] of matchAttrs.entries()) {
            if (k === 'class' || k === 'style' || k === 'type' || k === 'src' || k === 'loading' || k === 'decoding' || k === 'aria-labelledby' || k === 'aria-label' || k === 'title' || k === 'x-am-busy') continue;
            significantKeys.push([k, v]);
        }

        const allNodes = [];
        for (const r of roots) {
            allNodes.push(r);
            const walk = (n) => {
                for (const c of n.children || []) {
                    allNodes.push(c);
                    walk(c);
                }
            };
            walk(r);
        }

        const scoreExtras = (el) => {
            let bonus = 0;
            if (parsed.tagName && el.tagName === parsed.tagName.toUpperCase()) bonus += 2;
            const elText = String(el.textContent || '').replace(/\s+/g, ' ').trim();
            if (wantText && elText === wantText) bonus += 4;
            const elAria = String(el.getAttribute('aria-label') || '').trim();
            if (wantAria && elAria === wantAria) bonus += 3;
            const elTitle = String(el.getAttribute('title') || '').trim();
            if (wantTitle && elTitle === wantTitle) bonus += 2;
            if (wantClassTokens.length && el.classList) {
                for (const cls of wantClassTokens) {
                    if (el.classList.contains(cls)) bonus += 1;
                }
            }
            if (wantSrc && String(el.getAttribute('src') || '').trim() === wantSrc) bonus += 2;
            if (Number.isInteger(wantSibIdx) && wantSibIdx >= 0 && el.parentElement) {
                const sameTagSibs = (el.parentElement.children || []).filter((s) => s.tagName === el.tagName);
                if (sameTagSibs[wantSibIdx] === el) bonus += 2;
            }
            return bonus;
        };

        let bestEl = null;
        let bestScore = 0;
        if (significantKeys.length) {
            for (const el of allNodes) {
                let score = 0;
                let mismatch = false;
                for (const [k, v] of significantKeys) {
                    if (!el.hasAttribute(k)) { mismatch = true; break; }
                    if (String(el.getAttribute(k) ?? '') !== String(v ?? '')) { mismatch = true; break; }
                    score += (k.startsWith('data-am-') || k.startsWith('x-am-')) ? 4 : 2;
                }
                if (!mismatch) {
                    score += scoreExtras(el);
                    if (score > bestScore) {
                        bestScore = score;
                        bestEl = el;
                    }
                }
            }
            if (bestEl) return bestEl;
        }

        // Fallback matching when element lacks unique data-* attributes (e.g. bare <img> or <button><</button>)
        for (const el of allNodes) {
            if (parsed.tagName && el.tagName !== parsed.tagName.toUpperCase()) continue;
            const bonus = scoreExtras(el);
            const hasStrongCue = Boolean(
                (wantAria && String(el.getAttribute('aria-label') || '').trim() === wantAria)
                || (wantTitle && String(el.getAttribute('title') || '').trim() === wantTitle)
                || (wantText && String(el.textContent || '').replace(/\s+/g, ' ').trim() === wantText)
                || (wantClassTokens.length && el.classList && wantClassTokens.some((c) => el.classList.contains(c)))
            );
            if (hasStrongCue && bonus > bestScore) {
                bestScore = bonus;
                bestEl = el;
            }
        }
        return bestEl;
    }

    function findRootInteractiveElement(opts = {}) {
        const roots = body.children.filter((ch) => ch !== chatScreen);
        return matchElementByAttrs(roots, opts);
    }

    function findChatSurfaceInteractiveElement(opts = {}) {
        const { msgIndex = -1, chatId = '' } = opts || {};
        const cid = String(chatId || '').trim();
        const mIdx = Number(msgIndex);
        let scopeRoots = [];
        if (cid) {
            scopeRoots = chatScreen.children.filter((ch) => ch.getAttribute('data-chat-id') === cid);
        }
        if (!scopeRoots.length && Number.isInteger(mIdx) && mIdx >= 0) {
            scopeRoots = chatScreen.children.filter((ch) => ch.getAttribute('data-chat-index') === String(mIdx));
        }
        if (scopeRoots.length) {
            const scopedHit = matchElementByAttrs(scopeRoots, opts);
            if (scopedHit) return scopedHit;
        }
        return matchElementByAttrs([chatScreen], opts);
    }

    function mountSurfaceActionElement(actionHtml, dataset = {}, { msgIndex = -1, chatId = '' } = {}) {
        const parsed = parseAttributesFromHtml(actionHtml);
        const el = new MockElement(parsed.tagName || 'button');
        for (const [k, v] of parsed.attrs.entries()) {
            el.setAttribute(k, v);
        }
        if (dataset && typeof dataset === 'object') {
            for (const [k, v] of Object.entries(dataset)) {
                const attrName = (k.startsWith('data-') || k.startsWith('x-'))
                    ? k
                    : `data-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
                el.setAttribute(attrName, String(v ?? ''));
            }
        }
        el._rect = { top: 14000, left: 400, right: 448, bottom: 14048, width: 48, height: 48 };
        if (
            el.hasAttribute('data-am-illustration-action')
            || el.hasAttribute('data-am-illustration-revision-action')
            || el.hasAttribute('data-am-revision-action')
            || el.hasAttribute('data-am-chat-history-action')
        ) {
            const row = new MockElement('div');
            row.className = 'risu-chat';
            if (chatId) row.setAttribute('data-chat-id', String(chatId));
            if (Number.isInteger(Number(msgIndex)) && Number(msgIndex) >= 0) row.setAttribute('data-chat-index', String(msgIndex));
            const textEl = new MockElement('div');
            textEl.className = 'chattext';
            const footer = new MockElement('div');
            footer.className = 'x-risu-am-illustration-footer';
            const revCtrl = new MockElement('div');
            revCtrl.className = 'x-risu-am-illustration-revision-controls';
            revCtrl.appendChild(el);
            footer.appendChild(revCtrl);
            textEl.appendChild(footer);
            row.appendChild(textEl);
            el._rsTempWrapper = row;
            chatScreen.appendChild(row);
        } else {
            chatScreen.appendChild(el);
        }
        return el;
    }

    function stripExistingAmFooter(htmlStr) {
        return String(htmlStr || '').replace(/<div\b[^>]*class\s*=\s*(?:"[^"]*\bx-risu-am-illustration-footer\b[^"]*"|'[^']*\bx-risu-am-illustration-footer\b[^']*')[^>]*>[\s\S]*?<\/div>/gi, '');
    }

    function syncChatMessages(messages = []) {
        const list = (Array.isArray(messages) ? messages : [])
            .filter((m) => m && !m.isFirstMessage && Number(m.index) >= 0 && String(m.chatId || '').trim());
        suppressSurfaceMutationNotify = true;
        try {
            const existingById = new Map();
            for (const ch of chatScreen.children) {
                if (ch.classList && ch.classList.contains('risu-chat')) {
                    const cid = ch.getAttribute('data-chat-id') || '';
                    if (cid) existingById.set(cid, ch);
                }
            }
            const nextRows = [];
            let structureChanged = false;
            for (let i = 0; i < list.length; i += 1) {
                const m = list[i];
                const cid = String(m.chatId).trim();
                const mIdx = Number(m.index);
                const role = m.role === 'user' ? 'user' : 'char';
                const bodySrc = stripExistingAmFooter(String(m.html || m.raw || m.text || ''));
                const sig = `${role}:${mIdx}:${bodySrc}`;
                let row = existingById.get(cid);
                const rowRect = { top: 100 + i * 120, left: 16, right: 960, bottom: 100 + i * 120 + 96, width: 944, height: 96 };
                if (row && row._rsSourceSig === sig && row.getAttribute('data-chat-index') === String(mIdx)) {
                    row._rect = rowRect;
                    nextRows.push(row);
                    continue;
                }
                structureChanged = true;
                if (!row) {
                    row = new MockElement('div');
                    row.className = 'risu-chat';
                    row.setAttribute('data-chat-id', cid);
                }
                row.setAttribute('data-chat-index', String(mIdx));
                row.setAttribute('data-role', role);
                row._rsSourceSig = sig;
                row._rsBodyMutated = false;
                row._rect = rowRect;
                let textEl = row.querySelector('.chattext');
                if (!textEl) {
                    row._clearChildNodes();
                    textEl = new MockElement('div');
                    textEl.className = 'chattext';
                    row.appendChild(textEl);
                }
                textEl.innerHTML = bodySrc;
                const markVirtualRisuPrefixes = (rootEl) => {
                    const walk = (node) => {
                        if (!node || node.nodeType !== 1) return;
                        node._rsAllowRisuPrefixMatch = true;
                        for (const ch of node.children || []) walk(ch);
                    };
                    for (const ch of rootEl.children || []) walk(ch);
                };
                markVirtualRisuPrefixes(textEl);
                row._rsBodyMutated = false;
                nextRows.push(row);
            }
            const curRows = chatScreen.children.filter((ch) => ch.classList && ch.classList.contains('risu-chat'));
            if (!structureChanged && curRows.length === nextRows.length && curRows.every((r, idx) => r === nextRows[idx])) {
                return false;
            }
            for (const oldRow of [...curRows]) {
                if (!nextRows.includes(oldRow)) chatScreen.removeChild(oldRow);
            }
            for (let i = 0; i < nextRows.length; i += 1) {
                const r = nextRows[i];
                if (r.parentNode !== chatScreen) {
                    chatScreen.appendChild(r);
                } else {
                    const curAtIdx = chatScreen.children[i];
                    if (curAtIdx !== r) {
                        chatScreen.removeChild(r);
                        chatScreen.appendChild(r);
                    }
                }
            }
            return true;
        } finally {
            suppressSurfaceMutationNotify = false;
        }
    }

    function extractChatSurfaceProjections() {
        const footersByChatId = Object.create(null);
        const footersByIndex = Object.create(null);
        const bodyHtmlByChatId = Object.create(null);
        const footerSel = '.x-risu-am-illustration-footer, .am-illustration-footer, [data-am-illustration-footer]';
        for (const row of chatScreen.children) {
            if (!row || !row.classList || !row.classList.contains('risu-chat')) continue;
            const cid = row.getAttribute('data-chat-id') || '';
            const mIdx = Number(row.getAttribute('data-chat-index') ?? -1);
            const textEl = row.querySelector('.chattext');
            const footer = (textEl && textEl.querySelector(footerSel)) || row.querySelector(footerSel);
            if (footer) {
                const fHtml = footer.outerHTML;
                if (cid) footersByChatId[cid] = fHtml;
                if (Number.isInteger(mIdx) && mIdx >= 0) footersByIndex[mIdx] = fHtml;
            }
            const extraRowNodes = [];
            for (const ch of row.childNodes || []) {
                if (!ch || ch === textEl || ch === footer) continue;
                if (ch.nodeType === 1) {
                    if (ch.classList && (ch.classList.contains('x-risu-am-illustration-footer') || ch.classList.contains('am-illustration-footer'))) continue;
                    if (typeof ch.getAttribute === 'function' && ch.getAttribute('data-am-illustration-footer') !== null) continue;
                    extraRowNodes.push(ch);
                }
            }
            if (textEl && cid) {
                const hasInjected = Boolean(row._rsBodyMutated || extraRowNodes.length > 0);
                if (hasInjected) {
                    const parts = [];
                    for (const ch of textEl.childNodes) {
                        if (!ch) continue;
                        if (ch.nodeType === 1 && ((ch.classList && (ch.classList.contains('x-risu-am-illustration-footer') || ch.classList.contains('am-illustration-footer'))) || (typeof ch.getAttribute === 'function' && ch.getAttribute('data-am-illustration-footer') !== null))) continue;
                        if (ch.nodeType === 1) parts.push(ch.outerHTML);
                        else if (ch.nodeType === 3) parts.push(escapeHtmlText(ch.textContent || ''));
                    }
                    for (const ex of extraRowNodes) {
                        parts.push(ex.outerHTML);
                    }
                    bodyHtmlByChatId[cid] = parts.join('');
                }
            }
        }
        return { footersByChatId, footersByIndex, bodyHtmlByChatId };
    }

    function wrapSafeElement(rawEl) {
        if (!rawEl || rawEl.nodeType !== 1) return null;
        const cached = safeWrapperCache.get(rawEl);
        if (cached) return cached;
        const wrapper = {
            [RAW_MOCK_EL]: rawEl,
            get nodeType() { return rawEl.nodeType; },
            get nodeName() { return rawEl.nodeName; },
            get tagName() { return rawEl.tagName; },
            get id() { return rawEl.id; },
            get className() { return rawEl.className; },
            get classList() { return rawEl.classList; },
            get dataset() { return rawEl.dataset; },
            get parentElement() { return wrapSafeElement(rawEl.parentElement); },
            get parentNode() { return wrapSafeElement(rawEl.parentNode); },
            get style() { return rawEl.style; },
            get textContent() { return rawEl.textContent; },
            set textContent(v) { rawEl.textContent = v; },
            get innerHTML() { return rawEl.innerHTML; },
            set innerHTML(v) { rawEl.innerHTML = v; },
            get outerHTML() { return rawEl.outerHTML; },
            get ownerDocument() { return doc; },
            get value() { return rawEl.value; },
            set value(v) { rawEl.value = String(v ?? ''); },
            get checked() { return Boolean(rawEl.checked); },
            set checked(v) { rawEl.checked = Boolean(v); },
            get disabled() { return Boolean(rawEl.disabled); },
            set disabled(v) { rawEl.disabled = Boolean(v); },
            getValue: async () => rawEl.value,
            setValue: async (v) => { rawEl.value = String(v ?? ''); },
            getChecked: async () => Boolean(rawEl.checked),
            setChecked: async (v) => { rawEl.checked = Boolean(v); },
            getAttribute: async (k) => rawEl.getAttribute(k),
            setAttribute: async (k, v) => { rawEl.setAttribute(k, v); },
            removeAttribute: async (k) => { rawEl.removeAttribute(k); },
            hasAttribute: async (k) => rawEl.hasAttribute(k),
            appendChild: async (ch) => { rawEl.appendChild(unwrapEl(ch)); return wrapSafeElement(unwrapEl(ch)) || ch; },
            removeChild: async (ch) => { rawEl.removeChild(unwrapEl(ch)); return ch; },
            replaceChild: async (n, o) => { rawEl.replaceChild(unwrapEl(n), unwrapEl(o)); return o; },
            replaceWith: async (...nodes) => { rawEl.replaceWith(...nodes.map(unwrapEl)); },
            remove: async () => { rawEl.remove(); },
            append: async (...items) => { rawEl.append(...items.map(unwrapEl)); },
            prepend: async (...items) => { rawEl.prepend(...items.map(unwrapEl)); },
            cloneNode: async (deep = false) => wrapSafeElement(rawEl.cloneNode(deep)),
            querySelector: async (sel) => wrapSafeElement(rawEl.querySelector(sel)),
            querySelectorAll: async (sel) => makeSafeNodeList(collectMatchingElements(rawEl, sel).map(wrapSafeElement).filter(Boolean)),
            getChildren: async () => rawEl.children.map(wrapSafeElement).filter(Boolean),
            getParent: async () => wrapSafeElement(rawEl.parentElement),
            closest: async (sel) => wrapSafeElement(rawEl.closest(sel)),
            matches: async (sel) => rawEl.matches(sel),
            contains: async (t) => rawEl.contains(unwrapEl(t)),
            getBoundingClientRect: async () => rawEl.getBoundingClientRect(),
            clientHeight: async () => rawEl.clientHeight(),
            clientWidth: async () => rawEl.clientWidth(),
            clientTop: async () => rawEl.clientTop(),
            clientLeft: async () => rawEl.clientLeft(),
            getOuterHTML: async () => rawEl.outerHTML,
            setOuterHTML: async (v) => rawEl.setOuterHTML(v),
            getInnerHTML: async () => rawEl.innerHTML,
            setInnerHTML: async (v) => { rawEl.innerHTML = v; },
            getTextContent: async () => rawEl.textContent,
            setTextContent: async (v) => { rawEl.textContent = v; },
            innerText: async () => rawEl.textContent,
            setInnerText: async (v) => { rawEl.textContent = v; },
            getClassName: async () => rawEl.className,
            setClassName: async (v) => rawEl.setClassName(v),
            addClass: async (...cls) => rawEl.addClass(...cls),
            removeClass: async (...cls) => rawEl.removeClass(...cls),
            hasClass: async (c) => rawEl.hasClass(c),
            getStyle: async (p) => rawEl.getStyle(p),
            setStyle: async (p, v) => rawEl.setStyle(p, v),
            getStyleAttribute: async () => rawEl.getStyleAttribute(),
            setStyleAttribute: async (v) => rawEl.setStyleAttribute(v),
            addEventListener: async (ev, fn, opts) => rawEl.addEventListener(ev, fn, opts),
            removeEventListener: async (ev, idOrFn, opts) => rawEl.removeEventListener(ev, idOrFn, opts),
            dispatchEvent: async (evObj) => rawEl.dispatchEvent(evObj),
            focus: async () => rawEl.focus(),
            blur: async () => rawEl.blur(),
            click: async () => rawEl.click(),
        };
        safeWrapperCache.set(rawEl, wrapper);
        return wrapper;
    }

    function createMutationObserver(cb) {
        const rec = {
            cb: typeof cb === 'function' ? cb : () => {},
            targets: new Map(),
            api: null,
        };
        const api = {
            observe: async (target, opts = {}) => {
                const raw = unwrapEl(target);
                if (!raw || typeof raw !== 'object') return;
                rec.targets.set(raw, {
                    childList: opts && opts.childList !== false,
                    subtree: Boolean(opts && opts.subtree),
                });
                mutationObservers.add(rec);
            },
            disconnect: async () => {
                rec.targets.clear();
                mutationObservers.delete(rec);
            },
            takeRecords: async () => [],
        };
        rec.api = api;
        return api;
    }

    const doc = {
        nodeType: 9,
        documentElement: wrapSafeElement(documentElement),
        head: wrapSafeElement(head),
        body: wrapSafeElement(body),
        createElement: async (tag) => wrapSafeElement(new MockElement(tag)),
        createTextNode: async (txt) => new MockTextNode(txt),
        getElementById: async (id) => wrapSafeElement(collectMatchingElements(documentElement, `#${String(id || '').replace(/[^a-zA-Z0-9_-]/g, '')}`)[0] || null),
        querySelector: async (sel) => wrapSafeElement(collectMatchingElements(documentElement, sel)[0] || null),
        querySelectorAll: async (sel) => makeSafeNodeList(collectMatchingElements(documentElement, sel).map(wrapSafeElement).filter(Boolean)),
        addEventListener: async (ev, fn, opts) => {
            const id = `doc-ev-${++seq}`;
            listeners.set(id, { ev: String(ev), fn, opts: opts || false, sync: false });
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
        nodeType: 9,
        documentElement,
        head,
        body,
        createElement: (tag) => new MockElement(tag),
        createTextNode: (txt) => new MockTextNode(txt),
        getElementById: (id) => collectMatchingElements(documentElement, `#${String(id || '').replace(/[^a-zA-Z0-9_-]/g, '')}`)[0] || null,
        querySelector: (sel) => collectMatchingElements(documentElement, sel)[0] || null,
        querySelectorAll: (sel) => collectMatchingElements(documentElement, sel),
        addEventListener: (ev, fn, opts) => {
            const id = `doc-ev-${++seq}`;
            listeners.set(id, { ev: String(ev), fn, opts: opts || false, sync: true });
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
        documentElement,
        head,
        body,
        MockElement,
        chatScreen,
        dispatchSurfaceClick,
        dispatchElementInput,
        findRootInteractiveElement,
        findChatSurfaceInteractiveElement,
        mountSurfaceActionElement,
        syncChatMessages,
        extractChatSurfaceProjections,
        createMutationObserver,
        getObserverCount: () => mutationObservers.size,
        getListenerCount: () => listeners.size,
    };
}

function extractMessageText(m) {
    if (typeof m === 'string') return m;
    if (!m || typeof m !== 'object') return '';
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
        return m.content.map((part) => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            if (typeof part.text === 'string') return part.text;
            if (typeof part.content === 'string') return part.content;
            return '';
        }).filter(Boolean).join('\n');
    }
    if (Array.isArray(m.parts)) {
        return m.parts.map((part) => {
            if (typeof part === 'string') return part;
            if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
            return '';
        }).filter(Boolean).join('\n');
    }
    if (typeof m.text === 'string') return m.text;
    return String(m.content ?? '');
}

function extractMessagesFromRequestBody(bodyObj, type = 'openai') {
    if (!bodyObj || typeof bodyObj !== 'object') return [];
    const kind = String(type || 'openai').toLowerCase();
    const out = [];
    if (kind === 'anthropic') {
        if (typeof bodyObj.system === 'string') {
            out.push({ role: 'system', content: bodyObj.system });
        } else if (Array.isArray(bodyObj.system)) {
            for (const blk of bodyObj.system) {
                const txt = typeof blk === 'string'
                    ? blk
                    : (blk && typeof blk === 'object' && typeof blk.text === 'string' ? blk.text : extractMessageText(blk));
                if (txt) out.push({ role: 'system', content: txt });
            }
        }
        if (Array.isArray(bodyObj.messages)) {
            for (const m of bodyObj.messages) {
                out.push({ role: String((m && m.role) || ''), content: extractMessageText(m) });
            }
        }
        return out;
    }
    if (kind === 'gemini') {
        const sysInst = bodyObj.systemInstruction ?? bodyObj.system_instruction;
        if (typeof sysInst === 'string') {
            out.push({ role: 'system', content: sysInst });
        } else if (sysInst && typeof sysInst === 'object') {
            const sysTxt = extractMessageText(sysInst);
            if (sysTxt) out.push({ role: 'system', content: sysTxt });
        }
        if (Array.isArray(bodyObj.contents)) {
            for (const c of bodyObj.contents) {
                out.push({ role: String((c && c.role) || 'user'), content: extractMessageText(c) });
            }
        }
        return out;
    }
    const list = Array.isArray(bodyObj.messages)
        ? bodyObj.messages
        : (Array.isArray(bodyObj.input) ? bodyObj.input : []);
    for (const m of list) {
        out.push({ role: String((m && m.role) || ''), content: extractMessageText(m) });
    }
    return out;
}

function diffPluginPromptInjection(beforeMsgs, afterMsgs) {
    const normalize = (arr) => (Array.isArray(arr) ? arr : []).map((m) => ({
        role: String((m && m.role) || ''),
        content: extractMessageText(m),
    }));
    const before = normalize(beforeMsgs);
    const after = normalize(afterMsgs);
    const n = before.length;
    const m = after.length;
    const keyOf = (x) => `${x.role}\0${x.content}`;
    const bKeys = before.map(keyOf);
    const aKeys = after.map(keyOf);

    const matchedPairs = [];
    if (n > 0 && m > 0) {
        if (n * m <= 160000) {
            const cols = m + 1;
            const dp = new Int32Array((n + 1) * cols);
            for (let i = n - 1; i >= 0; i -= 1) {
                const rowOff = i * cols;
                const nextOff = (i + 1) * cols;
                for (let j = m - 1; j >= 0; j -= 1) {
                    if (bKeys[i] === aKeys[j]) {
                        dp[rowOff + j] = 1 + dp[nextOff + j + 1];
                    } else {
                        const down = dp[nextOff + j];
                        const right = dp[rowOff + j + 1];
                        dp[rowOff + j] = down >= right ? down : right;
                    }
                }
            }
            let i = 0;
            let j = 0;
            while (i < n && j < m) {
                if (bKeys[i] === aKeys[j]) {
                    matchedPairs.push([i, j]);
                    i += 1;
                    j += 1;
                } else if (dp[(i + 1) * cols + j] >= dp[i * cols + j + 1]) {
                    i += 1;
                } else {
                    j += 1;
                }
            }
        } else {
            let startJ = 0;
            for (let i = 0; i < n; i += 1) {
                for (let j = startJ; j < m; j += 1) {
                    if (bKeys[i] === aKeys[j]) {
                        matchedPairs.push([i, j]);
                        startJ = j + 1;
                        break;
                    }
                }
            }
        }
    }

    const commonEdges = (a, b) => {
        const minLen = Math.min(a.length, b.length);
        let p = 0;
        while (p < minLen && a.charCodeAt(p) === b.charCodeAt(p)) p += 1;
        let s = 0;
        while (p + s < minLen && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s += 1;
        return { p, s };
    };

    const MAX_BLOCK_CHARS = 48000;
    const MAX_BLOCKS = 32;
    const injectedBlocks = [];
    const strippedBlocks = [];
    let strippedCount = 0;
    let totalRemovedChars = 0;
    const anchors = [[-1, -1], ...matchedPairs, [n, m]];

    for (let k = 0; k < anchors.length - 1; k += 1) {
        if (injectedBlocks.length >= MAX_BLOCKS) break;
        const [bi0, ai0] = anchors[k];
        const [bi1, ai1] = anchors[k + 1];
        const bGap = [];
        for (let bi = bi0 + 1; bi < bi1; bi += 1) bGap.push(bi);
        const aGap = [];
        for (let ai = ai0 + 1; ai < ai1; ai += 1) aGap.push(ai);
        if (!aGap.length) continue;

        const pairForA = new Map();
        const usedA = new Set();
        const usedB = new Set();

        for (const bi of bGap) {
            let bestAi = -1;
            let bestScore = 0;
            for (const ai of aGap) {
                if (usedA.has(ai)) continue;
                if (before[bi].role !== after[ai].role) continue;
                const { p, s } = commonEdges(before[bi].content, after[ai].content);
                const score = p + s;
                if (score > bestScore) {
                    bestScore = score;
                    bestAi = ai;
                }
            }
            if (bestAi >= 0) {
                pairForA.set(bestAi, bi);
                usedA.add(bestAi);
                usedB.add(bi);
            }
        }

        const remB = bGap.filter((bi) => !usedB.has(bi));
        const remA = aGap.filter((ai) => !usedA.has(ai));
        for (let r = 0; r < remB.length && r < remA.length; r += 1) {
            const bi = remB[r];
            const ai = remA[r];
            const { p, s } = commonEdges(before[bi].content, after[ai].content);
            if (p + s > 0 || before[bi].role === after[ai].role) {
                pairForA.set(ai, bi);
            }
        }

        for (const ai of aGap) {
            if (injectedBlocks.length >= MAX_BLOCKS) break;
            const afterMsg = after[ai];
            const matchedBi = pairForA.get(ai);
            if (matchedBi === undefined) {
                const rawText = afterMsg.content;
                if (!rawText || !rawText.trim()) continue;
                injectedBlocks.push({
                    kind: 'added',
                    role: afterMsg.role,
                    index: ai,
                    addedChars: rawText.length,
                    removedChars: 0,
                    text: rawText.slice(0, MAX_BLOCK_CHARS),
                    truncated: rawText.length > MAX_BLOCK_CHARS,
                });
            } else {
                const prevText = before[matchedBi].content;
                const nextText = afterMsg.content;
                if (prevText === nextText) continue;
                const { p, s } = commonEdges(prevText, nextText);
                const inserted = nextText.slice(p, nextText.length - s);
                const removed = prevText.slice(p, prevText.length - s);
                if (!inserted && !removed) continue;
                if (!inserted.trim()) {
                    strippedCount += 1;
                    totalRemovedChars += removed.length;
                    if (strippedBlocks.length < MAX_BLOCKS) {
                        strippedBlocks.push({
                            role: afterMsg.role,
                            index: ai,
                            removedChars: removed.length,
                        });
                    }
                    continue;
                }
                injectedBlocks.push({
                    kind: 'modified',
                    role: afterMsg.role,
                    index: ai,
                    addedChars: inserted.length,
                    removedChars: removed.length,
                    text: inserted.slice(0, MAX_BLOCK_CHARS),
                    truncated: inserted.length > MAX_BLOCK_CHARS,
                });
            }
        }
    }

    const totalInjectedChars = injectedBlocks.reduce((acc, b) => acc + (b.addedChars || 0), 0);
    return {
        beforeCount: n,
        afterCount: m,
        injectedBlocks,
        injectedCount: injectedBlocks.length,
        totalInjectedChars,
        strippedCount,
        totalRemovedChars,
        strippedBlocks,
        changed: injectedBlocks.length > 0 || strippedCount > 0,
    };
}

/**
 * Selects the preferred GUI entry when a plugin registers multiple UI items
 * (e.g. a chat-input action button alongside a main setting/dashboard GUI).
 */
function pickPreferredPluginGuiEntry(items, targetId = '') {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return null;
    const wanted = String(targetId || '').trim();
    if (wanted) {
        const exact = list.find((u) => u && (u.id === wanted || u.name === wanted));
        if (exact) return exact;
    }
    const scoreEntry = (u) => {
        if (!u || typeof u !== 'object') return -999;
        let score = 0;
        const kind = String(u.kind || '').toLowerCase();
        const loc = String(u.location || '').toLowerCase();
        const name = String(u.name || '');
        if (kind === 'setting') score += 100;
        else if (kind === 'button' && /^(?:setting|settings|hamburger|sidebar|menu|drawer|global)$/.test(loc)) score += 60;
        else score += 20;
        if (/(?:설정|setting|config|main|메인|대시보드|dashboard|관리|manager|studio|스튜디오|panel|패널|gui|옵션|option|열기|open)/i.test(name)) {
            score += 25;
        }
        if (/(?:인풋|input|작성|compose|이어가기|continue|확장|expand|전송|send|리롤|reroll|생성|generate|번역|translate)/i.test(name)) {
            score -= 50;
        }
        return score;
    };
    let best = list[0];
    let bestScore = scoreEntry(best);
    for (let i = 1; i < list.length; i += 1) {
        const sc = scoreEntry(list[i]);
        if (sc > bestScore) {
            best = list[i];
            bestScore = sc;
        }
    }
    return best;
}

/**
 * Creates a synchronous Web Storage (localStorage/sessionStorage) shim backed by a Map.
 */
function createSyncWebStorage(backingMap, hooks = {}) {
    const map = backingMap instanceof Map ? backingMap : new Map();
    const methods = {
        getItem(k) {
            const key = String(k);
            if (typeof hooks.onRead === 'function') hooks.onRead(key);
            return map.has(key) ? map.get(key) : null;
        },
        setItem(k, v) {
            const key = String(k);
            const val = String(v);
            map.set(key, val);
            if (typeof hooks.onSet === 'function') hooks.onSet(key, val);
        },
        removeItem(k) {
            const key = String(k);
            map.delete(key);
            if (typeof hooks.onRemove === 'function') hooks.onRemove(key);
        },
        clear() {
            map.clear();
            if (typeof hooks.onClear === 'function') hooks.onClear();
        },
        key(i) {
            const idx = Number(i);
            const ks = Array.from(map.keys());
            return (Number.isInteger(idx) && idx >= 0 && idx < ks.length) ? ks[idx] : null;
        },
    };
    return new Proxy(methods, {
        get(target, prop) {
            if (prop === 'length') return map.size;
            if (Reflect.has(target, prop)) return Reflect.get(target, prop);
            if (typeof prop === 'string') {
                if (typeof hooks.onRead === 'function') hooks.onRead(prop);
                return map.has(prop) ? map.get(prop) : undefined;
            }
            return undefined;
        },
        set(target, prop, value) {
            if (typeof prop === 'string' && prop !== 'length' && !Reflect.has(target, prop)) {
                target.setItem(prop, value);
                return true;
            }
            return Reflect.set(target, prop, value);
        },
        deleteProperty(target, prop) {
            if (typeof prop === 'string' && prop !== 'length' && !Reflect.has(target, prop)) {
                target.removeItem(prop);
                return true;
            }
            return false;
        },
        has(target, prop) {
            return Reflect.has(target, prop) || (typeof prop === 'string' && (prop === 'length' || map.has(prop)));
        },
        ownKeys() {
            return Array.from(map.keys());
        },
        getOwnPropertyDescriptor(target, prop) {
            if (typeof prop === 'string' && map.has(prop)) {
                return { enumerable: true, configurable: true, writable: true, value: map.get(prop) };
            }
            return Reflect.getOwnPropertyDescriptor(target, prop);
        },
    });
}

/**
 * Generates an isolated sandboxed iframe HTML (`srcdoc`) that implements RisuAI API v3
 * for rendering a plugin's real native GUI (`registerSetting` / `registerButton` / `getRootDocument`).
 */
function buildPluginGuiSrcdoc({ plugin, entryId = '', theme = 'dark', webLocalSnapshot = {}, webSessionSnapshot = {} }) {
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
        webLocalSnapshot: (webLocalSnapshot && typeof webLocalSnapshot === 'object') ? webLocalSnapshot : {},
        webSessionSnapshot: (webSessionSnapshot && typeof webSessionSnapshot === 'object') ? webSessionSnapshot : {},
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
  const chatListeners = new Set();
  const BATCHABLE_RPC_RX = /^(?:pluginStorage|safeLocalStorage|localPluginStorage|webStorage)\\.|^db\\.|^getArg(?:ument)?$|^ipc\\.poll$/;
  let rpcBatchQueue = [];
  let rpcBatchTimer = null;

  function flushRpcBatch() {
    if (rpcBatchTimer) {
      clearTimeout(rpcBatchTimer);
      rpcBatchTimer = null;
    }
    if (!rpcBatchQueue.length) return;
    const items = rpcBatchQueue.splice(0, 64);
    if (rpcBatchQueue.length && !rpcBatchTimer) {
      rpcBatchTimer = setTimeout(flushRpcBatch, 0);
    }
    if (items.length === 1) {
      const one = items[0];
      window.parent.postMessage({
        __rsGuiRpc: 1,
        reqId: one.reqId,
        pluginName: meta.name,
        method: one.method,
        args: one.args,
      }, '*');
      return;
    }
    window.parent.postMessage({
      __rsGuiRpcBatch: 1,
      pluginName: meta.name,
      calls: items,
    }, '*');
  }

  function rpcCall(method, args) {
    return new Promise((resolve, reject) => {
      const reqId = 'gui_' + (++rpcSeq) + '_' + Date.now();
      const timer = setTimeout(() => {
        pendingRpc.delete(reqId);
        reject(new Error('GUI RPC timeout: ' + method));
      }, 45000);
      pendingRpc.set(reqId, { resolve, reject, timer });
      const argList = Array.isArray(args) ? args : [];
      if (BATCHABLE_RPC_RX.test(String(method || ''))) {
        rpcBatchQueue.push({ reqId, method, args: argList });
        if (rpcBatchQueue.length >= 48) {
          flushRpcBatch();
        } else if (!rpcBatchTimer) {
          rpcBatchTimer = setTimeout(flushRpcBatch, 4);
        }
        return;
      }
      window.parent.postMessage({
        __rsGuiRpc: 1,
        reqId,
        pluginName: meta.name,
        method,
        args: argList,
      }, '*');
    });
  }

  window.addEventListener('message', (ev) => {
    const d = ev && ev.data;
    if (!d || typeof d !== 'object') return;
    if (d.__rsGuiRpcBatchRes === 1 && Array.isArray(d.results)) {
      for (const r of d.results) {
        if (!r || !r.reqId || !pendingRpc.has(r.reqId)) continue;
        const p = pendingRpc.get(r.reqId);
        pendingRpc.delete(r.reqId);
        clearTimeout(p.timer);
        if (r.ok) p.resolve(r.value);
        else p.reject(new Error(r.error || 'RPC error'));
      }
      if (!autoOpened && !meta.entryId && uiRegistry.length > 0 && pendingRpc.size === 0) {
        scheduleAutoOpen(180);
      }
      return;
    }
    if (d.__rsGuiRpcRes === 1 && d.reqId && pendingRpc.has(d.reqId)) {
      const p = pendingRpc.get(d.reqId);
      pendingRpc.delete(d.reqId);
      clearTimeout(p.timer);
      if (d.ok) p.resolve(d.value);
      else p.reject(new Error(d.error || 'RPC error'));
      if (!autoOpened && !meta.entryId && uiRegistry.length > 0 && pendingRpc.size === 0) {
        scheduleAutoOpen(180);
      }
      return;
    }
    if (d.__rsGuiInvokeEntry === 1) {
      invokeEntry(d.entryId || '');
      return;
    }
    if (d.__rsGuiChatChanged === 1) {
      for (const fn of [...chatListeners]) {
        if (typeof fn === 'function') {
          try { fn(d.payload || { source: 'risustand' }); } catch (e) { console.error(e); }
        }
      }
      return;
    }
    if (d.__rsGuiChannelDeliver === 1 && d.channel) {
      const set = channelListeners.get(String(d.channel));
      if (set && set.size) {
        for (const fn of [...set]) {
          if (typeof fn === 'function') {
            try { fn(d.message, { sender: String(d.sender || ''), channel: String(d.channel) }); } catch (e) { console.error(e); }
          }
        }
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
    if (!ep.setStyleAttribute) ep.setStyleAttribute = async function(v) { this.setAttribute('style', String(v ?? '')); };
    if (!ep.getStyleAttribute) ep.getStyleAttribute = async function() { return this.getAttribute('style') || ''; };
    if (!ep.getChildren) ep.getChildren = async function() { return Array.from(this.children); };
    if (!ep.getParent) ep.getParent = async function() { return this.parentElement; };
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
  let activeEntryId = '';
  const bootStartedAt = Date.now();
  const MAX_AUTO_OPEN_WAIT_MS = 1600;

  function pickPreferredEntry(targetId) {
    if (!uiRegistry.length) return null;
    const wanted = String(targetId || '').trim();
    if (wanted) {
      const exact = uiRegistry.find((u) => u && (u.id === wanted || u.name === wanted));
      if (exact) return exact;
    }
    const scoreEntry = (u) => {
      if (!u || typeof u !== 'object') return -999;
      let score = 0;
      const kind = String(u.kind || '').toLowerCase();
      const loc = String(u.location || '').toLowerCase();
      const name = String(u.name || '');
      if (kind === 'setting') score += 100;
      else if (kind === 'button' && /^(?:setting|settings|hamburger|sidebar|menu|drawer|global)$/.test(loc)) score += 60;
      else score += 20;
      if (/(?:설정|setting|config|main|메인|대시보드|dashboard|관리|manager|studio|스튜디오|panel|패널|gui|옵션|option|열기|open)/i.test(name)) {
        score += 25;
      }
      if (/(?:인풋|input|작성|compose|이어가기|continue|확장|expand|전송|send|리롤|reroll|생성|generate|번역|translate)/i.test(name)) {
        score -= 50;
      }
      return score;
    };
    let best = uiRegistry[0];
    let bestScore = scoreEntry(best);
    for (let i = 1; i < uiRegistry.length; i += 1) {
      const sc = scoreEntry(uiRegistry[i]);
      if (sc > bestScore) {
        best = uiRegistry[i];
        bestScore = sc;
      }
    }
    return best;
  }

  function reportUiItems() {
    window.parent.postMessage({
      __rsGuiItems: 1,
      pluginName: meta.name,
      activeEntryId,
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
    const pick = pickPreferredEntry(targetId);
    if (!pick || typeof pick.callback !== 'function') return false;
    const boot = document.getElementById('__rs_boot_state');
    if (boot) boot.remove();
    autoOpened = true;
    activeEntryId = pick.id;
    window.parent.postMessage({
      __rsGuiActiveEntry: 1,
      pluginName: meta.name,
      entryId: pick.id,
      name: pick.name,
    }, '*');
    reportUiItems();
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

  function scheduleAutoOpen(delayMs) {
    if (autoOpened) return;
    if (invokerTimer) clearTimeout(invokerTimer);
    const reqDelay = typeof delayMs === 'number' && delayMs >= 0 ? delayMs : 200;
    const elapsed = Date.now() - bootStartedAt;
    const wait = elapsed >= MAX_AUTO_OPEN_WAIT_MS
      ? 20
      : Math.min(reqDelay, Math.max(20, MAX_AUTO_OPEN_WAIT_MS - elapsed));
    invokerTimer = setTimeout(() => {
      if (autoOpened) return;
      if (uiRegistry.length) {
        if (pendingRpc.size > 0 && !meta.entryId && (Date.now() - bootStartedAt) < MAX_AUTO_OPEN_WAIT_MS) {
          scheduleAutoOpen(180);
          return;
        }
        invokeEntry(meta.entryId);
      } else {
        const boot = document.getElementById('__rs_boot_state');
        if (boot) {
          boot.textContent = '이 플러그인은 별도의 GUI 설정 화면(registerSetting/registerButton)을 등록하지 않았습니다.';
        }
      }
    }, uiRegistry.length ? wait : 450);
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
    setChat: (chat) => rpcCall('db.setChatActive', [chat]),
    setCurrentChat: (chat) => rpcCall('db.setChatActive', [chat]),
    getChatFromIndex: (cIdx, chIdx) => rpcCall('db.getChat', [Number(cIdx), Number(chIdx)]),
    setChatToIndex: (cIdx, chIdx, chat) => rpcCall('db.setChat', [Number(cIdx), Number(chIdx), chat]),
    loadPlugins: async () => {
      await rpcCall('db.reloadPcPlugins', [meta.name]);
      window.parent.postMessage({ __rsGuiReloadPlugin: 1, pluginName: meta.name }, '*');
      return true;
    },
    reloadPlugins: async () => {
      await rpcCall('db.reloadPcPlugins', [meta.name]);
      window.parent.postMessage({ __rsGuiReloadPlugin: 1, pluginName: meta.name }, '*');
      return true;
    },
    reload: async () => {
      await rpcCall('db.reloadPcPlugins', [meta.name]);
      window.parent.postMessage({ __rsGuiReloadPlugin: 1, pluginName: meta.name }, '*');
      return true;
    },
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
      if (!autoOpened && meta.entryId && (id === meta.entryId || item.name === meta.entryId)) {
        setTimeout(() => { if (!autoOpened) invokeEntry(meta.entryId); }, 30);
      } else {
        scheduleAutoOpen(200);
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
      if (!autoOpened && meta.entryId && (id === meta.entryId || item.name === meta.entryId)) {
        setTimeout(() => { if (!autoOpened) invokeEntry(meta.entryId); }, 30);
      } else {
        scheduleAutoOpen(200);
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
      if (typeof fn !== 'function') return false;
      const chKey = String(ch);
      let set = channelListeners.get(chKey);
      if (!set) {
        set = new Set();
        channelListeners.set(chKey, set);
      }
      set.add(fn);
      if (!window.__rsIpcCursorProm) {
        window.__rsLastIpcSeq = 0;
        window.__rsIpcCursorProm = rpcCall('ipc.poll', [0, true]).then((initRes) => {
          if (initRes && typeof initRes.latestSeq === 'number') {
            window.__rsLastIpcSeq = Math.max(window.__rsLastIpcSeq || 0, initRes.latestSeq);
          }
        }).catch(() => {});
      }
      await window.__rsIpcCursorProm;
      if (!window.__rsPollIpcNow) {
        let polling = false;
        window.__rsPollIpcNow = async () => {
          if (polling || channelListeners.size === 0) return;
          polling = true;
          try {
            const res = await rpcCall('ipc.poll', [window.__rsLastIpcSeq || 0]);
            if (res && typeof res.latestSeq === 'number') {
              window.__rsLastIpcSeq = Math.max(window.__rsLastIpcSeq || 0, res.latestSeq);
            }
            const list = Array.isArray(res && res.events) ? res.events : [];
            for (const ev of list) {
              const targetSet = channelListeners.get(String(ev.channel || ''));
              if (!targetSet || !targetSet.size) continue;
              const metaObj = { sender: String(ev.sender || ''), channel: String(ev.channel || '') };
              for (const listener of [...targetSet]) {
                if (typeof listener === 'function') {
                  try { listener(ev.message, metaObj); } catch (e) { console.error(e); }
                }
              }
            }
          } catch (_) {} finally {
            polling = false;
          }
        };
      }
      if (!window.__rsIpcPollTimer) {
        window.__rsIpcPollTimer = setInterval(window.__rsPollIpcNow, 120);
      }
      return true;
    },
    removePluginChannelListener: async (ch, fn) => {
      const chKey = String(ch);
      if (typeof fn === 'function') {
        const set = channelListeners.get(chKey);
        if (set) {
          set.delete(fn);
          if (!set.size) channelListeners.delete(chKey);
        }
      } else {
        channelListeners.delete(chKey);
      }
      return true;
    },
    unregisterPluginChannelListener: async (ch, fn) => {
      const chKey = String(ch);
      if (typeof fn === 'function') {
        const set = channelListeners.get(chKey);
        if (set) {
          set.delete(fn);
          if (!set.size) channelListeners.delete(chKey);
        }
      } else {
        channelListeners.delete(chKey);
      }
      return true;
    },
    postPluginChannelMessage: async (target, ch, msg) => {
      const ok = await rpcCall('ipc.post', [String(target || ''), String(ch || ''), msg]);
      if (typeof window.__rsPollIpcNow === 'function' && channelListeners.size > 0) {
        setTimeout(() => { void window.__rsPollIpcNow(); }, 15);
        setTimeout(() => { void window.__rsPollIpcNow(); }, 75);
      }
      return ok;
    },

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
    addRisuChatListener: async (fn) => { if (typeof fn === 'function') chatListeners.add(fn); },
    removeRisuChatListener: async (fn) => { chatListeners.delete(fn); },
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

  function makeIframeWebStorage(scope, initialObj) {
    const map = new Map();
    if (initialObj && typeof initialObj === 'object') {
      for (const [k, v] of Object.entries(initialObj)) {
        map.set(String(k), String(v ?? ''));
      }
    }
    const methods = {
      getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
      setItem: (k, v) => {
        const key = String(k);
        const val = String(v);
        map.set(key, val);
        rpcCall('webStorage.setItem', [scope, key, val]).catch(() => {});
      },
      removeItem: (k) => {
        const key = String(k);
        map.delete(key);
        rpcCall('webStorage.removeItem', [scope, key]).catch(() => {});
      },
      clear: () => {
        map.clear();
        rpcCall('webStorage.clear', [scope]).catch(() => {});
      },
      key: (i) => {
        const idx = Number(i);
        const ks = Array.from(map.keys());
        return (Number.isInteger(idx) && idx >= 0 && idx < ks.length) ? ks[idx] : null;
      },
    };
    return new Proxy(methods, {
      get(target, prop) {
        if (prop === 'length') return map.size;
        if (Reflect.has(target, prop)) return Reflect.get(target, prop);
        if (typeof prop === 'string') return map.has(prop) ? map.get(prop) : undefined;
        return undefined;
      },
      set(target, prop, value) {
        if (typeof prop === 'string' && prop !== 'length' && !Reflect.has(target, prop)) {
          target.setItem(prop, value);
          return true;
        }
        return Reflect.set(target, prop, value);
      },
      deleteProperty(target, prop) {
        if (typeof prop === 'string' && prop !== 'length' && !Reflect.has(target, prop)) {
          target.removeItem(prop);
          return true;
        }
        return false;
      },
      has(target, prop) {
        return Reflect.has(target, prop) || (typeof prop === 'string' && (prop === 'length' || map.has(prop)));
      },
      ownKeys() {
        return Array.from(map.keys());
      },
      getOwnPropertyDescriptor(target, prop) {
        if (typeof prop === 'string' && map.has(prop)) {
          return { enumerable: true, configurable: true, writable: true, value: map.get(prop) };
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
  }

  const syncLocalStorage = makeIframeWebStorage('local', meta.webLocalSnapshot);
  const syncSessionStorage = makeIframeWebStorage('session', meta.webSessionSnapshot);
  try { Object.defineProperty(window, 'localStorage', { configurable: true, get: () => syncLocalStorage }); } catch (_) {}
  try { Object.defineProperty(window, 'sessionStorage', { configurable: true, get: () => syncSessionStorage }); } catch (_) {}

  window.Risuai = window.RisuAI = window.risuai = window.risuApi = window.risuAPI = apiProxy;

  try {
    const fn = new Function('localStorage', 'sessionStorage', pluginCode);
    const maybePromise = fn(syncLocalStorage, syncSessionStorage);
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

function computePluginScriptSig(script) {
    const s = String(script || '');
    const len = s.length;
    let h1 = 0x811c9dc5;
    const step = Math.max(1, Math.floor(len / 4096));
    for (let i = 0; i < len; i += step) {
        h1 ^= s.charCodeAt(i);
        h1 = Math.imul(h1, 0x01000193) >>> 0;
    }
    return `${len}:${h1.toString(16)}`;
}

function createPluginAdapter({
    pluginsPath,
    storagePath = '',
    ledgerPath = '',
    persistDisabled = false,
    getBackendConfig = () => ({}),
    saveBackendConfig = () => {},
    hostRpc = null,
    getFallbackSnapshot = () => null,
    runLLM = null,
    onActivity = () => () => {},
    onSurfaceMutated = null,
    onDbMutated = null,
} = {}) {
    let customPlugins = [];
    const pcPlugins = new Map(); // name -> { name, displayName, version, script, header, pcRealArg, pcEnabled, updatedAt }
    const activeHosts = new Map(); // name -> { unload, api, record, context }
    const lastErrors = new Map(); // name -> string
    const pluginChannels = new Map(); // `${pluginName}\0${channel}` -> Set<Function>
    const providers = new Map(); // providerName -> { pluginName, fn, options }
    const pluginDoms = new Map(); // pluginName -> mockDom
    const chatPanels = new Map(); // `${pluginName}::${panelId}` -> { id, pluginName, displayName, className, html }
    const guiIpcOutbox = []; // [{ seq, targetPlugin, channel, message, sender, at }]
    let guiIpcSeq = 0;
    const pluginRuntimeLedger = new Map(); // pluginName -> runtime hook & prompt-injection recall ledger
    let runtimeRecallSeq = 0;
    let runtimeTurnRunSeq = 0;
    let activeHookFrame = null; // { stage, step, total, pluginName, explicit, handle, logs, fetchCount, llmCount }
    let activeActionTracker = null; // { dbMutated, surfaceMutated, openedContainerPlugin }

    function ensureRuntimeLedger(pluginName) {
        const key = String(pluginName || '');
        let rec = pluginRuntimeLedger.get(key);
        if (!rec) {
            rec = {
                pluginName: key,
                beforeRequestRuns: 0,
                bodyIntercepterRuns: 0,
                afterRequestRuns: 0,
                outputRuns: 0,
                storageReads: 0,
                storageWrites: 0,
                storageErrors: 0,
                lastBeforeRequestAt: 0,
                lastBodyIntercepterAt: 0,
                lastAfterRequestAt: 0,
                lastOutputAt: 0,
                lastStorageWriteAt: 0,
                lastStorageError: '',
                recentStorageKeys: [],
                lastAfterRequest: null,
                lastOutput: null,
                history: [],
            };
            pluginRuntimeLedger.set(key, rec);
        }
        return rec;
    }

    let storageSaveTimer = null;
    let ledgerSaveTimer = null;
    let storageDirtyForDisk = false;
    let ledgerDirtyForDisk = false;

    function atomicWriteJson(filePath, data) {
        if (!filePath || persistDisabled) return;
        const tmp = `${filePath}.rs-tmp-${crypto.randomBytes(6).toString('hex')}`;
        try {
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(tmp, filePath);
        } catch (e) {
            try { fs.rmSync(tmp, { force: true }); } catch (_) {}
            console.warn(`[PluginAdapter] 파일 저장 실패 (${path.basename(filePath)}):`, e.message);
        }
    }

    function scheduleSaveLedger() {
        ledgerDirtyForDisk = true;
        if (!ledgerPath || persistDisabled || ledgerSaveTimer) return;
        ledgerSaveTimer = setTimeout(() => {
            ledgerSaveTimer = null;
            saveLedgerToDiskNow();
        }, 300);
        if (typeof ledgerSaveTimer.unref === 'function') ledgerSaveTimer.unref();
    }

    function saveLedgerToDiskNow() {
        if (ledgerSaveTimer) {
            clearTimeout(ledgerSaveTimer);
            ledgerSaveTimer = null;
        }
        if (!ledgerPath || persistDisabled || !ledgerDirtyForDisk) return;
        ledgerDirtyForDisk = false;
        const payload = {};
        for (const [pName, rec] of pluginRuntimeLedger.entries()) {
            if (!pName || !rec) continue;
            payload[pName] = {
                pluginName: rec.pluginName,
                beforeRequestRuns: rec.beforeRequestRuns || 0,
                bodyIntercepterRuns: rec.bodyIntercepterRuns || 0,
                afterRequestRuns: rec.afterRequestRuns || 0,
                outputRuns: rec.outputRuns || 0,
                storageReads: rec.storageReads || 0,
                storageWrites: rec.storageWrites || 0,
                storageErrors: rec.storageErrors || 0,
                lastBeforeRequestAt: rec.lastBeforeRequestAt || 0,
                lastBodyIntercepterAt: rec.lastBodyIntercepterAt || 0,
                lastAfterRequestAt: rec.lastAfterRequestAt || 0,
                lastOutputAt: rec.lastOutputAt || 0,
                lastStorageWriteAt: rec.lastStorageWriteAt || 0,
                lastStorageError: rec.lastStorageError || '',
                recentStorageKeys: Array.isArray(rec.recentStorageKeys) ? rec.recentStorageKeys.slice(0, 24) : [],
                lastAfterRequest: rec.lastAfterRequest ? cloneJson(rec.lastAfterRequest) : null,
                lastOutput: rec.lastOutput ? cloneJson(rec.lastOutput) : null,
                history: Array.isArray(rec.history) ? rec.history.slice(-12).map((h) => cloneJson(h)) : [],
            };
        }
        atomicWriteJson(ledgerPath, { version: 1, runtimeRecallSeq, plugins: payload });
    }

    function loadLedgerFromDisk() {
        if (!ledgerPath || persistDisabled) return;
        try {
            if (!fs.existsSync(ledgerPath)) return;
            const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
            if (!parsed || typeof parsed !== 'object') return;
            let maxId = Number(parsed.runtimeRecallSeq) || 0;
            const pluginsObj = parsed.plugins && typeof parsed.plugins === 'object' ? parsed.plugins : {};
            for (const [pName, raw] of Object.entries(pluginsObj)) {
                if (!pName || !raw || typeof raw !== 'object') continue;
                const rec = ensureRuntimeLedger(pName);
                rec.beforeRequestRuns = Number(raw.beforeRequestRuns) || 0;
                rec.bodyIntercepterRuns = Number(raw.bodyIntercepterRuns) || 0;
                rec.afterRequestRuns = Number(raw.afterRequestRuns) || 0;
                rec.outputRuns = Number(raw.outputRuns) || 0;
                rec.storageReads = Number(raw.storageReads) || 0;
                rec.storageWrites = Number(raw.storageWrites) || 0;
                rec.storageErrors = Number(raw.storageErrors) || 0;
                rec.lastBeforeRequestAt = Number(raw.lastBeforeRequestAt) || 0;
                rec.lastBodyIntercepterAt = Number(raw.lastBodyIntercepterAt) || 0;
                rec.lastAfterRequestAt = Number(raw.lastAfterRequestAt) || 0;
                rec.lastOutputAt = Number(raw.lastOutputAt) || 0;
                rec.lastStorageWriteAt = Number(raw.lastStorageWriteAt) || 0;
                rec.lastStorageError = String(raw.lastStorageError || '');
                rec.recentStorageKeys = Array.isArray(raw.recentStorageKeys) ? raw.recentStorageKeys.map(String).slice(0, 24) : [];
                rec.lastAfterRequest = raw.lastAfterRequest || null;
                rec.lastOutput = raw.lastOutput || null;
                rec.history = Array.isArray(raw.history) ? raw.history.slice(-12) : [];
                for (const h of rec.history) {
                    if (h && Number(h.id) > maxId) maxId = Number(h.id);
                }
            }
            if (maxId > runtimeRecallSeq) runtimeRecallSeq = maxId;
        } catch (e) {
            console.warn('[PluginAdapter] 런타임 원장 파일 로드 실패:', e.message);
        }
    }

    function recordStorageEvent(pluginName, { op, storeKind, key = '', ok = true, error = '' } = {}) {
        const pName = String(pluginName || '').trim();
        if (!pName) return;
        const rec = ensureRuntimeLedger(pName);
        if (op === 'read') {
            rec.storageReads = (rec.storageReads || 0) + 1;
            return;
        }
        if (op === 'write') {
            if (ok) {
                rec.storageWrites = (rec.storageWrites || 0) + 1;
                rec.lastStorageWriteAt = Date.now();
            } else {
                rec.storageErrors = (rec.storageErrors || 0) + 1;
                rec.lastStorageError = String(error || 'storage write error').slice(0, 240);
            }
            if (key) {
                const tag = `${storeKind}:${String(key)}`.slice(0, 120);
                const list = Array.isArray(rec.recentStorageKeys) ? rec.recentStorageKeys : [];
                const filtered = list.filter((x) => x !== tag);
                filtered.unshift(tag);
                rec.recentStorageKeys = filtered.slice(0, 24);
            }
            scheduleSaveLedger();
        }
    }

    loadLedgerFromDisk();

    function pickPrimaryRecallIndex(reversedHistory) {
        const list = Array.isArray(reversedHistory) ? reversedHistory : [];
        if (!list.length) return -1;
        let idx = list.findIndex((h) => h && h.matchesCurrentChat && (Number(h.totalInjectedChars) || 0) > 0);
        if (idx >= 0) return idx;
        idx = list.findIndex((h) => h && h.matchesCurrentChat);
        if (idx >= 0) return idx;
        idx = list.findIndex((h) => h && (Number(h.totalInjectedChars) || 0) > 0);
        if (idx >= 0) return idx;
        return 0;
    }

    function appendHookStepLog(pluginName, text) {
        const f = activeHookFrame;
        if (!f || f.pluginName !== pluginName || !Array.isArray(f.logs)) return;
        const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
        if (!clean) return;
        if (f.logs.length && f.logs[f.logs.length - 1] === clean) return;
        if (f.logs.length < 20) f.logs.push(clean);
    }

    function extractLastUserPreview(msgs) {
        if (!Array.isArray(msgs)) return '';
        for (let i = msgs.length - 1; i >= 0; i -= 1) {
            const msg = msgs[i];
            if (!msg || String(msg.role || '').toLowerCase() !== 'user') continue;
            const clean = String(msg.content ?? '').replace(/\s+/g, ' ').trim();
            if (clean) return clean.slice(0, 140);
        }
        return '';
    }

    function getPluginDisplayName(pluginName) {
        const custom = customPlugins.find((p) => p && p.name === pluginName);
        if (custom) return custom.displayName || pluginName;
        const pc = pcPlugins.get(pluginName);
        if (pc) return pc.displayName || pluginName;
        return pluginName;
    }

    function decodeBasicEntities(s) {
        return String(s ?? '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, ' ');
    }

    function extractCleanPanelStatusText(html) {
        const raw = String(html || '');
        if (!raw.trim()) return '';
        const prevM = raw.match(/<span\b[^>]*class\s*=\s*["'][^"']*\bmscs-preview\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
        if (prevM) {
            const clean = decodeBasicEntities(prevM[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
            if (clean) return clean.slice(0, 100);
        }
        const stripped = decodeBasicEntities(
            raw
                .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
                .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
                .replace(/<button\b[\s\S]*?<\/button>/gi, ' ')
                .replace(/<[^>]+>/g, ' ')
        ).replace(/\s+/g, ' ').trim();
        return stripped.slice(0, 100);
    }

    function inferFetchHookTask(parsedUrl, stage) {
        const href = String(parsedUrl && parsedUrl.href ? parsedUrl.href : '').toLowerCase();
        if (/embed(?:ding)?s?\b|\/v1\/embeddings/.test(href)) {
            return stage === 'beforeRequest' ? '임베딩 벡터 회상 조회 중' : '임베딩 벡터 인덱싱·저장 중';
        }
        if (/rerank/.test(href)) return '기억 리랭킹 중';
        if (/memory|recall|vector|retrieval|librarian|retrace/.test(href)) {
            return stage === 'beforeRequest' ? '기억 스토리지 조회 중' : '기억 스토리지 저장 중';
        }
        if (/chat\/completions|generatecontent|\/v1\/messages|\/responses/.test(href)) {
            return stage === 'beforeRequest' ? '보조 LLM 분석 요청 중' : '보조 LLM 후처리 요청 중';
        }
        if (/novelai|generate-image|\/prompt\b/.test(href)) return '삽화 생성 API 요청 중';
        return `외부 API 통신 중 (${parsedUrl.hostname})`;
    }

    function updateHookTaskDetail(pluginName, detail, explicit = false) {
        const f = activeHookFrame;
        if (!f || f.pluginName !== pluginName) return;
        const clean = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 100);
        if (!clean) return;
        appendHookStepLog(pluginName, clean);
        if (!explicit && f.explicit) return;
        if (explicit) f.explicit = true;
        if (f.handle && typeof f.handle.update === 'function') {
            try { f.handle.update({ phase: clean }); } catch (_) {}
        }
    }

    async function runHookStepWithActivity({ stage, step, total, pluginName, initialTask }, fn) {
        let handle = () => {};
        if (typeof onActivity === 'function') {
            try {
                const ret = onActivity({
                    kind: 'plugin_hook',
                    stage: String(stage || ''),
                    step: Number(step) || 1,
                    total: Number(total) || 1,
                    pluginName,
                    name: getPluginDisplayName(pluginName),
                    phase: String(initialTask || ''),
                });
                if (typeof ret === 'function') handle = ret;
            } catch (_) {}
        }
        const prevFrame = activeHookFrame;
        activeHookFrame = {
            stage,
            step,
            total,
            pluginName,
            explicit: false,
            handle,
            logs: [],
            fetchCount: 0,
            llmCount: 0,
        };
        try {
            return await fn();
        } finally {
            activeHookFrame = prevFrame;
            try { handle(); } catch (_) {}
        }
    }
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
    const webLocalStore = new Map();
    const webSessionStore = new Map();
    const dirtyStoreOps = new Map(); // `${storeKind}\0${key}` -> { storeKind, key, op: 'set'|'remove'|'clear', value? }
    const fallbackAssetStore = new Map();
    const fallbackInlayStore = new Map();
    const fallbackCharCache = new Map();
    let lastActiveLocation = { charIndex: -1, chatIndex: -1 };
    let flushDirtyInFlight = null;
    let pendingChatOutputs = 0;

    function saveStorageToDiskNow() {
        if (storageSaveTimer) {
            clearTimeout(storageSaveTimer);
            storageSaveTimer = null;
        }
        if (!storagePath || persistDisabled || !storageDirtyForDisk) return;
        storageDirtyForDisk = false;
        atomicWriteJson(storagePath, {
            version: 1,
            webLocal: Object.fromEntries(webLocalStore.entries()),
            fallbackPluginStore: Object.fromEntries(fallbackPluginStore.entries()),
            fallbackSafeLocal: Object.fromEntries(fallbackSafeLocal.entries()),
            fallbackLocalPlugin: Object.fromEntries(fallbackLocalPlugin.entries()),
            dirtyStoreOps: Array.from(dirtyStoreOps.values()),
        });
    }

    function scheduleSaveStorage() {
        storageDirtyForDisk = true;
        if (!storagePath || persistDisabled || storageSaveTimer) return;
        storageSaveTimer = setTimeout(() => {
            storageSaveTimer = null;
            saveStorageToDiskNow();
        }, 120);
        if (typeof storageSaveTimer.unref === 'function') storageSaveTimer.unref();
    }

    function loadStorageFromDisk() {
        if (!storagePath || persistDisabled) return;
        try {
            if (!fs.existsSync(storagePath)) return;
            const parsed = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
            if (!parsed || typeof parsed !== 'object') return;
            if (parsed.webLocal && typeof parsed.webLocal === 'object') {
                for (const [k, v] of Object.entries(parsed.webLocal)) {
                    webLocalStore.set(String(k), String(v ?? ''));
                }
            }
            if (parsed.fallbackPluginStore && typeof parsed.fallbackPluginStore === 'object') {
                for (const [k, v] of Object.entries(parsed.fallbackPluginStore)) {
                    fallbackPluginStore.set(String(k), String(v ?? 'null'));
                }
            }
            if (parsed.fallbackSafeLocal && typeof parsed.fallbackSafeLocal === 'object') {
                for (const [k, v] of Object.entries(parsed.fallbackSafeLocal)) {
                    fallbackSafeLocal.set(String(k), String(v ?? ''));
                }
            }
            if (parsed.fallbackLocalPlugin && typeof parsed.fallbackLocalPlugin === 'object') {
                for (const [k, v] of Object.entries(parsed.fallbackLocalPlugin)) {
                    fallbackLocalPlugin.set(String(k), cloneJson(v));
                }
            }
            if (Array.isArray(parsed.dirtyStoreOps)) {
                for (const op of parsed.dirtyStoreOps) {
                    if (!op || !op.storeKind || !op.op) continue;
                    const keyStr = String(op.key ?? '');
                    dirtyStoreOps.set(`${op.storeKind}\0${keyStr}`, {
                        storeKind: String(op.storeKind),
                        key: keyStr,
                        op: String(op.op),
                        ...(op.op === 'set' ? { value: cloneJson(op.value) } : {}),
                    });
                }
            }
        } catch (e) {
            console.warn('[PluginAdapter] 플러그인 스토리지 파일 로드 실패:', e.message);
        }
    }

    loadStorageFromDisk();

    // Per-turn coherent cache (never acts as a separate persistent DB)
    let turnCache = {
        active: false,
        deferredEnd: false,
        charIndex: -1,
        chatIndex: -1,
        charObj: null,
        chatObj: null,
        stagedUserIdx: -1,
        stagedUserChatId: '',
        pluginStoreCache: new Map(), // key -> parsed JSON snapshot | null
    };

    const isRpcConnected = () => Boolean(hostRpc && typeof hostRpc.isConnected === 'function' && hostRpc.isConnected());

    // Short-TTL + in-flight dedup cache for GUI / host RPC reads (never masks turnCache or mutations)
    const READ_CACHE_TTL_MS = 800;
    const READ_CACHE_MAX_ENTRIES = 512;
    const rpcReadCache = new Map(); // cacheKey -> { at, val }
    const rpcReadInFlight = new Map(); // cacheKey -> Promise<any>

    function invalidateReadCache(prefix = '') {
        if (!prefix) {
            rpcReadCache.clear();
            rpcReadInFlight.clear();
            return;
        }
        for (const k of rpcReadCache.keys()) {
            if (k.startsWith(prefix)) rpcReadCache.delete(k);
        }
        for (const k of rpcReadInFlight.keys()) {
            if (k.startsWith(prefix)) rpcReadInFlight.delete(k);
        }
    }

    function deleteReadCacheKey(key) {
        rpcReadCache.delete(key);
        rpcReadInFlight.delete(key);
    }

    function putReadCache(key, val) {
        if (rpcReadCache.size >= READ_CACHE_MAX_ENTRIES) {
            const oldest = rpcReadCache.keys().next().value;
            if (oldest !== undefined) rpcReadCache.delete(oldest);
        }
        rpcReadCache.set(key, { at: Date.now(), val: val === undefined ? null : cloneJson(val) });
    }

    function getFreshReadCache(key) {
        if (!rpcReadCache.has(key)) return undefined;
        const hit = rpcReadCache.get(key);
        if (!hit || (Date.now() - hit.at) >= READ_CACHE_TTL_MS) {
            rpcReadCache.delete(key);
            return undefined;
        }
        return hit.val;
    }

    async function cachedRpcRead(key, fetcher) {
        const fresh = getFreshReadCache(key);
        if (fresh !== undefined) return cloneJson(fresh);
        if (rpcReadInFlight.has(key)) {
            const shared = await rpcReadInFlight.get(key);
            return shared === undefined ? null : cloneJson(shared);
        }
        const p = (async () => {
            const v = await fetcher();
            const normalized = v === undefined ? null : v;
            if (rpcReadInFlight.get(key) === p) {
                putReadCache(key, normalized);
            }
            return normalized;
        })().finally(() => {
            if (rpcReadInFlight.get(key) === p) rpcReadInFlight.delete(key);
        });
        rpcReadInFlight.set(key, p);
        const res = await p;
        return res === undefined ? null : cloneJson(res);
    }

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

    function readFallbackStoreValue(storeKind, k) {
        if (storeKind === 'pluginStorage') {
            return fallbackPluginStore.has(k) ? JSON.parse(fallbackPluginStore.get(k)) : null;
        }
        const fb = storeKind === 'safeLocalStorage' ? fallbackSafeLocal : fallbackLocalPlugin;
        return fb.has(k) ? cloneJson(fb.get(k)) : null;
    }

    function writeFallbackStoreValue(storeKind, k, value) {
        if (storeKind === 'pluginStorage') {
            const jsonStr = JSON.stringify(value) ?? 'null';
            const normalized = JSON.parse(jsonStr);
            fallbackPluginStore.set(k, jsonStr);
            return normalized;
        }
        const normalizedVal = storeKind === 'safeLocalStorage' ? String(value ?? '') : cloneJson(value);
        const fb = storeKind === 'safeLocalStorage' ? fallbackSafeLocal : fallbackLocalPlugin;
        fb.set(k, normalizedVal);
        return normalizedVal;
    }

    function clearDirtyOpsForStore(storeKind) {
        const prefix = `${storeKind}\0`;
        for (const dk of [...dirtyStoreOps.keys()]) {
            if (dk.startsWith(prefix)) dirtyStoreOps.delete(dk);
        }
    }

    async function flushDirtyStoreOps() {
        if (!isRpcConnected() || dirtyStoreOps.size === 0) return { flushed: 0, remaining: dirtyStoreOps.size };
        if (flushDirtyInFlight) return flushDirtyInFlight;
        flushDirtyInFlight = (async () => {
            let flushed = 0;
            for (const [dk, entry] of [...dirtyStoreOps.entries()]) {
                if (!isRpcConnected()) break;
                try {
                    if (entry.op === 'clear') {
                        await hostRpc.invoke(`${entry.storeKind}.clear`, []);
                    } else if (entry.op === 'remove') {
                        await hostRpc.invoke(`${entry.storeKind}.removeItem`, [entry.key]);
                    } else if (entry.op === 'set') {
                        await hostRpc.invoke(`${entry.storeKind}.setItem`, [entry.key, entry.value]);
                    }
                    dirtyStoreOps.delete(dk);
                    deleteReadCacheKey(`store:${entry.storeKind}:${entry.key}`);
                    deleteReadCacheKey(`storeKeys:${entry.storeKind}`);
                    flushed += 1;
                } catch (err) {
                    const errMsg = err && err.message ? err.message : String(err);
                    console.warn(`[PluginAdapter] dirty storage replay failed (${entry.storeKind}.${entry.op}:${entry.key}):`, errMsg);
                    break;
                }
            }
            if (flushed > 0) scheduleSaveStorage();
            return { flushed, remaining: dirtyStoreOps.size };
        })().finally(() => {
            flushDirtyInFlight = null;
        });
        return flushDirtyInFlight;
    }

    // ---- Shared Direct Host Storage & DB Primitives ----
    async function storeGet(storeKind, key, pluginName = '') {
        const k = String(key);
        recordStorageEvent(pluginName, { op: 'read', storeKind, key: k, ok: true });
        const dirtyClear = dirtyStoreOps.get(`${storeKind}\0*`);
        const dirty = dirtyStoreOps.get(`${storeKind}\0${k}`);
        if (dirty) {
            return dirty.op === 'remove' ? null : cloneJson(dirty.value);
        }
        if (dirtyClear && dirtyClear.op === 'clear') {
            return null;
        }
        if (storeKind === 'pluginStorage') {
            if (turnCache.active && turnCache.pluginStoreCache.has(k)) {
                return cloneJson(turnCache.pluginStoreCache.get(k));
            }
            let val;
            if (isRpcConnected()) {
                try {
                    val = await cachedRpcRead(`store:pluginStorage:${k}`, () => hostRpc.invoke('pluginStorage.getItem', [k]));
                } catch (err) {
                    console.warn(`[PluginAdapter] pluginStorage.getItem(${k}) RPC fallback:`, err && err.message ? err.message : String(err));
                    val = readFallbackStoreValue('pluginStorage', k);
                }
            } else {
                val = readFallbackStoreValue('pluginStorage', k);
            }
            if (turnCache.active) {
                turnCache.pluginStoreCache.set(k, val === undefined ? null : cloneJson(val));
            }
            return val === undefined ? null : val;
        }
        const op = `${storeKind}.getItem`;
        if (isRpcConnected()) {
            try {
                const v = await cachedRpcRead(`store:${storeKind}:${k}`, () => hostRpc.invoke(op, [k]));
                return v === undefined ? null : v;
            } catch (err) {
                console.warn(`[PluginAdapter] ${op}(${k}) RPC fallback:`, err && err.message ? err.message : String(err));
                return readFallbackStoreValue(storeKind, k);
            }
        }
        return readFallbackStoreValue(storeKind, k);
    }

    async function storeSet(storeKind, key, value, pluginName = '') {
        const k = String(key);
        deleteReadCacheKey(`store:${storeKind}:${k}`);
        deleteReadCacheKey(`storeKeys:${storeKind}`);
        const normalizedVal = writeFallbackStoreValue(storeKind, k, value);
        if (storeKind === 'pluginStorage' && turnCache.active) {
            turnCache.pluginStoreCache.set(k, cloneJson(normalizedVal));
        }
        const dk = `${storeKind}\0${k}`;
        if (isRpcConnected()) {
            try {
                if (dirtyStoreOps.size > 0) await flushDirtyStoreOps();
                await hostRpc.invoke(`${storeKind}.setItem`, [k, normalizedVal]);
                dirtyStoreOps.delete(dk);
                recordStorageEvent(pluginName, { op: 'write', storeKind, key: k, ok: true });
                scheduleSaveStorage();
            } catch (err) {
                const errMsg = err && err.message ? err.message : String(err);
                console.warn(`[PluginAdapter] ${storeKind}.setItem(${k}) deferred:`, errMsg);
                dirtyStoreOps.set(dk, { storeKind, key: k, op: 'set', value: cloneJson(normalizedVal) });
                recordStorageEvent(pluginName, { op: 'write', storeKind, key: k, ok: false, error: errMsg });
                scheduleSaveStorage();
            }
        } else {
            dirtyStoreOps.set(dk, { storeKind, key: k, op: 'set', value: cloneJson(normalizedVal) });
            recordStorageEvent(pluginName, { op: 'write', storeKind, key: k, ok: true });
            scheduleSaveStorage();
        }
        return true;
    }

    async function storeRemove(storeKind, key, pluginName = '') {
        const k = String(key);
        deleteReadCacheKey(`store:${storeKind}:${k}`);
        deleteReadCacheKey(`storeKeys:${storeKind}`);
        if (storeKind === 'pluginStorage' && turnCache.active) {
            turnCache.pluginStoreCache.set(k, null);
        }
        const fb = storeKind === 'pluginStorage' ? fallbackPluginStore : (storeKind === 'safeLocalStorage' ? fallbackSafeLocal : fallbackLocalPlugin);
        fb.delete(k);
        const dk = `${storeKind}\0${k}`;
        if (isRpcConnected()) {
            try {
                await hostRpc.invoke(`${storeKind}.removeItem`, [k]);
                dirtyStoreOps.delete(dk);
                recordStorageEvent(pluginName, { op: 'write', storeKind, key: k, ok: true });
                scheduleSaveStorage();
            } catch (err) {
                const errMsg = err && err.message ? err.message : String(err);
                console.warn(`[PluginAdapter] ${storeKind}.removeItem(${k}) deferred:`, errMsg);
                dirtyStoreOps.set(dk, { storeKind, key: k, op: 'remove' });
                recordStorageEvent(pluginName, { op: 'write', storeKind, key: k, ok: false, error: errMsg });
                scheduleSaveStorage();
            }
        } else {
            dirtyStoreOps.set(dk, { storeKind, key: k, op: 'remove' });
            recordStorageEvent(pluginName, { op: 'write', storeKind, key: k, ok: true });
            scheduleSaveStorage();
        }
        return true;
    }

    async function storeClear(storeKind, pluginName = '') {
        invalidateReadCache(`store:${storeKind}:`);
        deleteReadCacheKey(`storeKeys:${storeKind}`);
        if (storeKind === 'pluginStorage' && turnCache.active) {
            turnCache.pluginStoreCache.clear();
        }
        const fb = storeKind === 'pluginStorage' ? fallbackPluginStore : (storeKind === 'safeLocalStorage' ? fallbackSafeLocal : fallbackLocalPlugin);
        fb.clear();
        clearDirtyOpsForStore(storeKind);
        if (isRpcConnected()) {
            try {
                await hostRpc.invoke(`${storeKind}.clear`, []);
                recordStorageEvent(pluginName, { op: 'write', storeKind, key: '*', ok: true });
                scheduleSaveStorage();
            } catch (err) {
                const errMsg = err && err.message ? err.message : String(err);
                console.warn(`[PluginAdapter] ${storeKind}.clear deferred:`, errMsg);
                dirtyStoreOps.set(`${storeKind}\0*`, { storeKind, key: '*', op: 'clear' });
                recordStorageEvent(pluginName, { op: 'write', storeKind, key: '*', ok: false, error: errMsg });
                scheduleSaveStorage();
            }
        } else {
            dirtyStoreOps.set(`${storeKind}\0*`, { storeKind, key: '*', op: 'clear' });
            recordStorageEvent(pluginName, { op: 'write', storeKind, key: '*', ok: true });
            scheduleSaveStorage();
        }
        return true;
    }

    async function storeKeys(storeKind, pluginName = '') {
        recordStorageEvent(pluginName, { op: 'read', storeKind, key: '*', ok: true });
        let baseKeys = [];
        const hasPendingClear = dirtyStoreOps.has(`${storeKind}\0*`);
        if (!hasPendingClear) {
            if (isRpcConnected()) {
                try {
                    const ks = await cachedRpcRead(`storeKeys:${storeKind}`, () => hostRpc.invoke(`${storeKind}.keys`, []));
                    baseKeys = Array.isArray(ks) ? ks.map(String) : [];
                } catch (_) {
                    const fb = storeKind === 'pluginStorage' ? fallbackPluginStore : (storeKind === 'safeLocalStorage' ? fallbackSafeLocal : fallbackLocalPlugin);
                    baseKeys = Array.from(fb.keys());
                }
            } else {
                const fb = storeKind === 'pluginStorage' ? fallbackPluginStore : (storeKind === 'safeLocalStorage' ? fallbackSafeLocal : fallbackLocalPlugin);
                baseKeys = Array.from(fb.keys());
            }
        }
        const keySet = new Set(baseKeys);
        const prefix = `${storeKind}\0`;
        for (const [dk, entry] of dirtyStoreOps.entries()) {
            if (!dk.startsWith(prefix)) continue;
            if (entry.op === 'set' && entry.key) keySet.add(entry.key);
            else if (entry.op === 'remove' && entry.key) keySet.delete(entry.key);
        }
        return Array.from(keySet);
    }

    function ensureStableChatAndMessageIds(charObj, charIdx, chatObj, chatIdx) {
        if (!chatObj || typeof chatObj !== 'object') return chatObj;
        const cidOwner = String((charObj && charObj.chaId) || charIdx || 0).replace(/[^a-zA-Z0-9_-]/g, '_');
        if (!chatObj.id || !String(chatObj.id).trim()) {
            chatObj.id = `rs-chat-${cidOwner}-${Math.max(0, Number(chatIdx) || 0)}`;
        }
        if (Array.isArray(chatObj.message)) {
            const baseId = String(chatObj.id);
            for (let i = 0; i < chatObj.message.length; i += 1) {
                const m = chatObj.message[i];
                if (m && typeof m === 'object' && (!m.chatId || !String(m.chatId).trim())) {
                    m.chatId = `rs-msg-${baseId}-${i}`;
                }
            }
        }
        return chatObj;
    }

    function buildSnapshotCharFallback(snap) {
        if (!snap || typeof snap !== 'object') return null;
        const ctx = snap.charContext && typeof snap.charContext === 'object' ? snap.charContext : {};
        const cIdx = Math.max(0, Number(snap.charIndex) || 0);
        const chIdx = Math.max(0, Number(snap.chatIndex) || 0);
        const charId = String(ctx.charId || snap.charName || `char_${cIdx}`);
        const msgs = (Array.isArray(snap.messages) ? snap.messages : [])
            .filter((m) => m && !m.isFirstMessage && Number(m.index) >= 0)
            .map((m) => ({
                role: m.role === 'user' ? 'user' : 'char',
                data: String(m.raw || m.text || ''),
                ...(m.chatId ? { chatId: String(m.chatId) } : {}),
            }));
        const chat = {
            id: String(snap.chatUuid || snap.chatId || `rs-chat-${charId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${chIdx}`),
            name: String(snap.chatName || `Chat ${chIdx + 1}`),
            note: String(ctx.note || ''),
            message: msgs,
            scriptstate: Object.fromEntries(Object.entries(snap.chatVariables || {}).map(([k, v]) => [`$${k}`, String(v ?? '')])),
            fmIndex: typeof snap.fmIndex === 'number' ? snap.fmIndex : -1,
        };
        const chats = [];
        chats[chIdx] = chat;
        const charObj = {
            chaId: charId,
            name: String(ctx.name || snap.charName || 'Character'),
            lowLevelAccess: Boolean(ctx.lowLevelAccess),
            desc: String(ctx.desc || ''),
            personality: String(ctx.personality || ''),
            scenario: String(ctx.scenario || ''),
            systemPrompt: String(ctx.systemPrompt || ''),
            replaceGlobalNote: String(ctx.replaceGlobalNote || ''),
            chatPage: chIdx,
            chats,
        };
        ensureStableChatAndMessageIds(charObj, cIdx, chat, chIdx);
        return charObj;
    }

    function getOrSeedFallbackChar(cIdx) {
        const idx = Number(cIdx);
        const snap = getFallbackSnapshot();
        let cached = fallbackCharCache.get(idx) || null;
        if (!cached) {
            if (snap && Number(snap.charIndex) === idx) {
                cached = buildSnapshotCharFallback(snap);
                if (cached) fallbackCharCache.set(idx, cached);
            }
            return cached;
        }
        if (snap && Number(snap.charIndex) === idx) {
            const fresh = buildSnapshotCharFallback(snap);
            const chIdx = Math.max(0, Number(snap.chatIndex) || 0);
            const freshChat = fresh && fresh.chats && fresh.chats[chIdx];
            if (!Array.isArray(cached.chats)) cached.chats = [];
            const prevChat = cached.chats[chIdx];
            if (freshChat && (!prevChat || prevChat.id !== freshChat.id || (Array.isArray(freshChat.message) && freshChat.message.length > (Array.isArray(prevChat.message) ? prevChat.message.length : 0)))) {
                cached.chats[chIdx] = freshChat;
            }
            if (cached.chats[chIdx]) ensureStableChatAndMessageIds(cached, idx, cached.chats[chIdx], chIdx);
        }
        return cached;
    }

    async function dbGetCurrentIndices() {
        if (turnCache.active && turnCache.charIndex >= 0) {
            return { charIndex: turnCache.charIndex, chatIndex: Math.max(0, turnCache.chatIndex) };
        }
        const fallbackSnap = getFallbackSnapshot();
        if (fallbackSnap && typeof fallbackSnap.charIndex === 'number' && fallbackSnap.charIndex >= 0) {
            return { charIndex: fallbackSnap.charIndex, chatIndex: Math.max(0, Number(fallbackSnap.chatIndex) || 0) };
        }
        if (lastActiveLocation.charIndex >= 0) {
            return { charIndex: lastActiveLocation.charIndex, chatIndex: Math.max(0, lastActiveLocation.chatIndex) };
        }
        if (isRpcConnected()) {
            const idx = await hostRpc.invoke('db.getCurrentIndices', []);
            if (idx && typeof idx === 'object') {
                const cIdx = typeof idx.viewCharIndex === 'number' && idx.viewCharIndex >= 0 ? idx.viewCharIndex : Number(idx.charIndex ?? 0);
                const chIdx = typeof idx.viewChatIndex === 'number' && idx.viewChatIndex >= 0 ? idx.viewChatIndex : Number(idx.chatIndex ?? 0);
                return { charIndex: cIdx, chatIndex: Math.max(0, chIdx) };
            }
        }
        return { charIndex: 0, chatIndex: 0 };
    }

    async function dbGetCharacterFromIndex(idx) {
        const cIdx = Number(idx);
        if (Number.isNaN(cIdx) || cIdx < 0) return null;
        if (turnCache.active && turnCache.charIndex === cIdx && turnCache.charObj) {
            const copy = cloneJson(turnCache.charObj);
            if (turnCache.chatObj && Array.isArray(copy.chats)) {
                copy.chats[turnCache.chatIndex] = cloneJson(turnCache.chatObj);
            }
            if (Array.isArray(copy.chats)) {
                for (let ci = 0; ci < copy.chats.length; ci += 1) {
                    ensureStableChatAndMessageIds(copy, cIdx, copy.chats[ci], ci);
                }
            }
            return copy;
        }
        if (isRpcConnected()) {
            const ch = await cachedRpcRead(`dbChar:${cIdx}`, () => hostRpc.invoke('db.getCharacter', [cIdx]));
            if (ch && Array.isArray(ch.chats)) {
                for (let ci = 0; ci < ch.chats.length; ci += 1) {
                    ensureStableChatAndMessageIds(ch, cIdx, ch.chats[ci], ci);
                }
            }
            if (ch) fallbackCharCache.set(cIdx, cloneJson(ch));
            return ch;
        }
        const fb = getOrSeedFallbackChar(cIdx);
        return fb ? cloneJson(fb) : null;
    }

    async function dbSetCharacterToIndex(idx, charObj) {
        const cIdx = Number(idx);
        if (Number.isNaN(cIdx) || cIdx < 0 || !charObj) return false;
        invalidateReadCache('db:');
        invalidateReadCache(`dbChar:${cIdx}`);
        invalidateReadCache(`dbChat:${cIdx}:`);
        const copy = cloneJson(charObj);
        if (Array.isArray(copy.chats)) {
            for (let ci = 0; ci < copy.chats.length; ci += 1) {
                ensureStableChatAndMessageIds(copy, cIdx, copy.chats[ci], ci);
            }
        }
        if (turnCache.active && turnCache.charIndex === cIdx) {
            turnCache.charObj = cloneJson(copy);
            if (Array.isArray(copy.chats) && copy.chats[turnCache.chatIndex]) {
                turnCache.chatObj = cloneJson(copy.chats[turnCache.chatIndex]);
            }
        }
        fallbackCharCache.set(cIdx, cloneJson(copy));
        if (activeActionTracker) activeActionTracker.dbMutated = true;
        if (isRpcConnected()) {
            await hostRpc.invoke('db.setCharacter', [cIdx, copy]);
        }
        if (typeof onDbMutated === 'function') {
            try { onDbMutated({ charIndex: cIdx, charObj: copy }); } catch (_) {}
        }
        return true;
    }

    async function dbGetChatFromIndex(cIdx, chIdx) {
        const ci = Number(cIdx);
        const chi = Number(chIdx);
        if (Number.isNaN(ci) || ci < 0 || Number.isNaN(chi) || chi < 0) return null;
        if (turnCache.active && turnCache.charIndex === ci && turnCache.chatIndex === chi && turnCache.chatObj) {
            return ensureStableChatAndMessageIds(turnCache.charObj, ci, cloneJson(turnCache.chatObj), chi);
        }
        if (isRpcConnected()) {
            const chat = await cachedRpcRead(`dbChat:${ci}:${chi}`, () => hostRpc.invoke('db.getChat', [ci, chi]));
            return ensureStableChatAndMessageIds({ chaId: '' }, ci, chat, chi);
        }
        const fb = getOrSeedFallbackChar(ci);
        const chat = (fb && fb.chats && fb.chats[chi]) ? cloneJson(fb.chats[chi]) : null;
        return ensureStableChatAndMessageIds(fb, ci, chat, chi);
    }

    async function dbSetChatToIndex(cIdx, chIdx, chatObj) {
        const ci = Number(cIdx);
        const chi = Number(chIdx);
        if (Number.isNaN(ci) || ci < 0 || Number.isNaN(chi) || chi < 0 || !chatObj) return false;
        invalidateReadCache('db:');
        deleteReadCacheKey(`dbChar:${ci}`);
        deleteReadCacheKey(`dbChat:${ci}:${chi}`);
        const copy = cloneJson(chatObj);
        const cachedChar = fallbackCharCache.get(ci) || turnCache.charObj || null;
        ensureStableChatAndMessageIds(cachedChar, ci, copy, chi);
        if (turnCache.active && turnCache.charIndex === ci && turnCache.chatIndex === chi) {
            turnCache.chatObj = cloneJson(copy);
            if (turnCache.charObj && Array.isArray(turnCache.charObj.chats)) {
                turnCache.charObj.chats[chi] = cloneJson(copy);
            }
        }
        const fb = getOrSeedFallbackChar(ci) || { chaId: `char_${ci}`, name: 'Character', chats: [] };
        if (!Array.isArray(fb.chats)) fb.chats = [];
        fb.chats[chi] = cloneJson(copy);
        fallbackCharCache.set(ci, fb);
        if (activeActionTracker) activeActionTracker.dbMutated = true;
        if (isRpcConnected()) {
            await hostRpc.invoke('db.setChat', [ci, chi, copy]);
        }
        if (typeof onDbMutated === 'function') {
            try { onDbMutated({ charIndex: ci, chatIndex: chi, chatObj: copy }); } catch (_) {}
        }
        return true;
    }

    async function dbGetDatabase(keys = 'all') {
        const want = keys === undefined ? 'all' : keys;
        let out = {};
        const includesPlugins = want === 'all' || (Array.isArray(want) && want.includes('plugins'));
        if (isRpcConnected()) {
            const dbKey = `db:${Array.isArray(want) ? want.slice().sort().join(',') : String(want)}`;
            out = (await cachedRpcRead(dbKey, () => hostRpc.invoke('db.getDatabase', [want], includesPlugins ? 60000 : 15000))) || {};
        } else {
            const snap = getFallbackSnapshot();
            const fbChar = getOrSeedFallbackChar(snap && typeof snap.charIndex === 'number' ? snap.charIndex : 0) || buildSnapshotCharFallback(snap);
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
        if (includesPlugins) {
            const merged = Array.isArray(out.plugins) ? out.plugins.slice() : [];
            for (const entry of getAllKnownEntries()) {
                if (!merged.some((p) => p && p.name === entry.name)) {
                    merged.push({
                        name: entry.name,
                        displayName: entry.displayName,
                        version: '3.0',
                        versionOfPlugin: entry.version,
                        script: entry.script || '',
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
        invalidateReadCache('db');
        const safePatch = cloneJson(patch || {});
        if (turnCache.active && safePatch && Array.isArray(safePatch.characters) && safePatch.characters[turnCache.charIndex]) {
            turnCache.charObj = cloneJson(safePatch.characters[turnCache.charIndex]);
            if (Array.isArray(turnCache.charObj.chats) && turnCache.charObj.chats[turnCache.chatIndex]) {
                turnCache.chatObj = cloneJson(turnCache.charObj.chats[turnCache.chatIndex]);
            }
        }
        if (safePatch && Array.isArray(safePatch.plugins)) {
            let touchedCustom = false;
            for (const rawPlg of safePatch.plugins) {
                if (!rawPlg || typeof rawPlg !== 'object' || !rawPlg.name || typeof rawPlg.script !== 'string') continue;
                const pName = String(rawPlg.name);
                if (pName === 'risustand') continue;
                const nextScript = String(rawPlg.script);
                const nextHeader = parsePluginHeader(nextScript, pName);
                const customIdx = customPlugins.findIndex((p) => p && p.name === pName);
                if (customIdx >= 0) {
                    customPlugins[customIdx] = {
                        ...customPlugins[customIdx],
                        displayName: String(rawPlg.displayName || nextHeader.displayName || customPlugins[customIdx].displayName || pName),
                        version: String(rawPlg.versionOfPlugin || nextHeader.version || customPlugins[customIdx].version || '0.0.0'),
                        script: nextScript,
                        header: nextHeader,
                        updatedAt: Date.now(),
                    };
                    touchedCustom = true;
                }
                const prevPc = pcPlugins.get(pName);
                if (prevPc || customIdx < 0) {
                    pcPlugins.set(pName, {
                        ...(prevPc || {}),
                        name: pName,
                        displayName: String(rawPlg.displayName || nextHeader.displayName || (prevPc && prevPc.displayName) || pName),
                        version: String(rawPlg.versionOfPlugin || nextHeader.version || (prevPc && prevPc.version) || '0.0.0'),
                        script: nextScript,
                        header: nextHeader,
                        pcRealArg: (rawPlg.realArg && typeof rawPlg.realArg === 'object') ? cloneJson(rawPlg.realArg) : ((prevPc && prevPc.pcRealArg) || {}),
                        pcEnabled: rawPlg.enabled !== false,
                        updatedAt: Date.now(),
                    });
                }
            }
            if (touchedCustom) saveCustomPluginsToDisk();
        }
        if (isRpcConnected()) {
            const timeoutMs = (safePatch && Array.isArray(safePatch.plugins)) ? 60000 : 15000;
            await hostRpc.invoke(method, [safePatch], timeoutMs);
        }
        return true;
    }

    async function assetReadImage(assetPath) {
        const key = String(assetPath || '').trim();
        if (!key || /^\[\[RS/i.test(key)) return null;
        if (isRpcConnected()) {
            try {
                const res = await hostRpc.invoke('asset.readImage', [key]);
                return (res && res.__b64) ? new Uint8Array(Buffer.from(res.__b64, 'base64')) : null;
            } catch (_) {
                return null;
            }
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
        const key = String(id || '').trim();
        if (!key) return null;
        if (isRpcConnected()) {
            try {
                return await hostRpc.invoke('asset.readInlay', [key]);
            } catch (_) {
                return null;
            }
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

    async function proxyFetchForPlugin(url, opts = {}, isRisuFetch = false, pluginName = '') {
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
        if (pluginName && activeHookFrame && activeHookFrame.pluginName === pluginName) {
            activeHookFrame.fetchCount = (activeHookFrame.fetchCount || 0) + 1;
            updateHookTaskDetail(pluginName, inferFetchHookTask(parsed, activeHookFrame.stage), false);
        }
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
        if (!targetEntry || !senderEntry) return false;
        const senderAllowed = (senderEntry && senderEntry.header && senderEntry.header.allowedIPC) || [];
        const targetAllowed = (targetEntry && targetEntry.header && targetEntry.header.allowedIPC) || [];
        if (targetAllowed.length && !targetAllowed.includes('*') && !targetAllowed.includes(senderEntry.name)) return false;
        if (senderAllowed.length && !senderAllowed.includes('*') && !senderAllowed.includes(targetEntry.name)) return false;
        const cloned = cloneJson(message);
        const ch = String(channelName);
        const meta = { sender: String(senderEntry.name || ''), channel: ch };
        const set = pluginChannels.get(`${targetPluginName}\0${ch}`);
        if (set && set.size) {
            const listeners = [...set];
            queueMicrotask(() => {
                for (const cb of listeners) {
                    if (typeof cb !== 'function') continue;
                    try {
                        const p = cb(cloneJson(cloned), { ...meta });
                        if (p && typeof p.catch === 'function') {
                            p.catch((err) => {
                                console.warn(`[PluginIPC:${targetPluginName}/${ch}] listener error:`, err && err.message ? err.message : String(err));
                            });
                        }
                    } catch (err) {
                        console.warn(`[PluginIPC:${targetPluginName}/${ch}] listener error:`, err && err.message ? err.message : String(err));
                    }
                }
            });
        }
        guiIpcOutbox.push({
            seq: ++guiIpcSeq,
            targetPlugin: String(targetPluginName),
            channel: ch,
            message: cloned,
            sender: String(senderEntry.name || ''),
            at: Date.now(),
        });
        if (guiIpcOutbox.length > 240) {
            guiIpcOutbox.splice(0, guiIpcOutbox.length - 240);
        }
        return true;
    }

    function pollGuiIpc(pluginName, afterSeq = 0, initCursor = false) {
        if (initCursor) {
            return {
                latestSeq: guiIpcSeq,
                events: [],
            };
        }
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
                getItem: (k) => storeGet('pluginStorage', k, pluginName),
                setItem: (k, v) => storeSet('pluginStorage', k, v, pluginName),
                removeItem: (k) => storeRemove('pluginStorage', k, pluginName),
                clear: () => storeClear('pluginStorage', pluginName),
                keys: () => storeKeys('pluginStorage', pluginName),
                key: async (i) => {
                    const ks = await storeKeys('pluginStorage', pluginName);
                    return ks[Number(i)] ?? null;
                },
                length: async () => (await storeKeys('pluginStorage', pluginName)).length,
            },
            safeLocalStorage: {
                getItem: (k) => storeGet('safeLocalStorage', k, pluginName),
                setItem: (k, v) => storeSet('safeLocalStorage', k, v, pluginName),
                removeItem: (k) => storeRemove('safeLocalStorage', k, pluginName),
                clear: () => storeClear('safeLocalStorage', pluginName),
                keys: () => storeKeys('safeLocalStorage', pluginName),
                key: async (i) => {
                    const ks = await storeKeys('safeLocalStorage', pluginName);
                    return ks[Number(i)] ?? null;
                },
                length: async () => (await storeKeys('safeLocalStorage', pluginName)).length,
            },
            getLocalPluginStorage: async () => ({
                __classType: 'REMOTE_REQUIRED',
                getItem: (k) => storeGet('localPluginStorage', k, pluginName),
                setItem: (k, v) => storeSet('localPluginStorage', k, v, pluginName),
                removeItem: (k) => storeRemove('localPluginStorage', k, pluginName),
                keys: () => storeKeys('localPluginStorage', pluginName),
                clear: () => storeClear('localPluginStorage', pluginName),
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
                const targetId = String(id);
                const idx = record.uiItems.findIndex((u) => u.id === targetId);
                if (idx >= 0) record.uiItems.splice(idx, 1);
                chatPanels.delete(`${pluginName}::${targetId}`);
                try {
                    const sec = sharedMockDom.body.querySelector(`section[data-plugin-chat-panel="${targetId}"]`);
                    if (sec) sec.remove();
                } catch (_) {}
            },
            setChatPanel: async (content, options = {}) => {
                const opts = options && typeof options === 'object' ? options : {};
                const panelId = String(opts.id || `${pluginName}:default`);
                const key = `${pluginName}::${panelId}`;
                const cleanSelector = `section[data-plugin-chat-panel="${panelId.replace(/"/g, '\\"')}"]`;
                if (content === null || content === '') {
                    chatPanels.delete(key);
                    try {
                        const existing = sharedMockDom.body.querySelector(cleanSelector);
                        if (existing) existing.remove();
                    } catch (_) {}
                    return { id: panelId };
                }
                if (typeof content !== 'string') throw new Error('content must be a string or null');
                const cls = typeof opts.className === 'string' ? opts.className : '';
                chatPanels.set(key, {
                    id: panelId,
                    pluginName,
                    displayName: getPluginDisplayName(pluginName),
                    className: cls,
                    html: content,
                });
                try {
                    let sec = sharedMockDom.body.querySelector(cleanSelector);
                    if (!sec) {
                        sec = sharedMockDom.syncDoc.createElement('section');
                        sec.setAttribute('data-plugin-chat-panel', panelId);
                        if (cls) sec.setAttribute('class', cls);
                        sharedMockDom.body.appendChild(sec);
                    }
                    sec.innerHTML = content;
                } catch (_) {}
                const statusTxt = extractCleanPanelStatusText(content);
                if (statusTxt) updateHookTaskDetail(pluginName, statusTxt, true);
                return { id: panelId };
            },

            addPluginChannelListener: async (channelName, cb) => {
                if (typeof cb !== 'function') return false;
                const key = `${pluginName}\0${String(channelName)}`;
                let set = pluginChannels.get(key);
                if (!set) {
                    set = new Set();
                    pluginChannels.set(key, set);
                }
                set.add(cb);
                addUnload(() => {
                    const s = pluginChannels.get(key);
                    if (s) {
                        s.delete(cb);
                        if (!s.size) pluginChannels.delete(key);
                    }
                });
                return true;
            },
            removePluginChannelListener: async (channelName, cb) => {
                const key = `${pluginName}\0${String(channelName)}`;
                if (typeof cb === 'function') {
                    const s = pluginChannels.get(key);
                    if (s) {
                        s.delete(cb);
                        if (!s.size) pluginChannels.delete(key);
                    }
                } else {
                    pluginChannels.delete(key);
                }
                return true;
            },
            unregisterPluginChannelListener: async (channelName, cb) => {
                const key = `${pluginName}\0${String(channelName)}`;
                if (typeof cb === 'function') {
                    const s = pluginChannels.get(key);
                    if (s) {
                        s.delete(cb);
                        if (!s.size) pluginChannels.delete(key);
                    }
                } else {
                    pluginChannels.delete(key);
                }
                return true;
            },
            postPluginChannelMessage: (target, channel, msg) => postIpcMessage(getPluginEntry(pluginName) || entry, target, channel, msg),

            nativeFetch: (url, opts) => proxyFetchForPlugin(url, opts, false, pluginName),
            risuFetch: (url, opts) => proxyFetchForPlugin(url, opts, true, pluginName),

            runLLMModel: async (req) => {
                if (typeof runLLM !== 'function') {
                    return { type: 'fail', result: 'No LLM runner available in backend adapter' };
                }
                if (activeHookFrame && activeHookFrame.pluginName === pluginName) {
                    activeHookFrame.llmCount = (activeHookFrame.llmCount || 0) + 1;
                    const reqMode = String((req && req.mode) || 'model');
                    const taskTxt = reqMode === 'otherAx'
                        ? (activeHookFrame.stage === 'beforeRequest' ? '보조 모델(OtherAx) 분석 중' : '보조 모델(OtherAx) 후처리 중')
                        : '모델 파이프라인 호출 중';
                    updateHookTaskDetail(pluginName, taskTxt, false);
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
            setChat: async (chat) => {
                const idx = await dbGetCurrentIndices();
                return dbSetChatToIndex(idx.charIndex, idx.chatIndex, chat);
            },
            setCurrentChat: async (chat) => {
                const idx = await dbGetCurrentIndices();
                return dbSetChatToIndex(idx.charIndex, idx.chatIndex, chat);
            },
            getChatFromIndex: (cIdx, chIdx) => dbGetChatFromIndex(cIdx, chIdx),
            setChatToIndex: (cIdx, chIdx, chat) => dbSetChatToIndex(cIdx, chIdx, chat),
            getDatabase: (keys) => dbGetDatabase(keys),
            setDatabaseLite: (patch) => dbSetDatabase('db.setDatabaseLite', patch),
            setDatabase: (patch) => dbSetDatabase('db.setDatabase', patch),
            loadPlugins: async () => {
                if (isRpcConnected()) {
                    await hostRpc.invoke('db.reloadPcPlugins', [], 8000).catch(() => {});
                }
                setTimeout(() => {
                    reloadPlugins(pluginName).catch(() => {});
                }, 25);
                return true;
            },
            reloadPlugins: async () => {
                if (isRpcConnected()) {
                    await hostRpc.invoke('db.reloadPcPlugins', [], 8000).catch(() => {});
                }
                setTimeout(() => {
                    reloadPlugins(pluginName).catch(() => {});
                }, 25);
                return true;
            },
            reload: async () => {
                if (isRpcConnected()) {
                    await hostRpc.invoke('db.reloadPcPlugins', [], 8000).catch(() => {});
                }
                setTimeout(() => {
                    reloadPlugins(pluginName).catch(() => {});
                }, 25);
                return true;
            },

            onUnload: async (cb) => { addUnload(cb); },
            getRootDocument: async () => asyncDoc,
            getRootContainer: async () => asyncDoc.body,
            getPluginRoot: async () => asyncDoc.body,
            createMutationObserver: async (cb) => sharedMockDom.createMutationObserver(cb),
            showContainer: async () => {
                if (activeActionTracker && !activeActionTracker.openedContainerPlugin) {
                    activeActionTracker.openedContainerPlugin = pluginName;
                }
            },
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
        for (const k of [...chatPanels.keys()]) {
            if (k.startsWith(`${name}::`)) chatPanels.delete(k);
        }
        for (const fn of [...inst.trackedUnloads].reverse()) {
            try { await fn(); } catch (_) {}
        }
        for (const id of [...inst.timers]) {
            clearTimeout(id);
            clearInterval(id);
        }
        inst.timers.clear();
    }

    function buildSandboxDomGlobals(sharedMockDom) {
        const MockEl = sharedMockDom && sharedMockDom.MockElement ? sharedMockDom.MockElement : null;
        const SVG_TAGS = new Set(['SVG', 'PATH', 'CIRCLE', 'RECT', 'LINE', 'POLYGON', 'POLYLINE', 'ELLIPSE', 'G', 'DEFS', 'USE', 'SYMBOL', 'TEXT', 'TSPAN', 'LINEARGRADIENT', 'RADIALGRADIENT', 'STOP', 'CLIPPATH', 'MASK']);

        class EventTarget {
            addEventListener() {}
            removeEventListener() {}
            dispatchEvent() { return true; }
            static [Symbol.hasInstance](x) {
                return Boolean(x && typeof x === 'object' && (typeof x.nodeType === 'number' || typeof x.addEventListener === 'function' || Object.prototype.isPrototypeOf.call(EventTarget.prototype, x)));
            }
        }
        class Node extends EventTarget {
            static [Symbol.hasInstance](x) {
                return Boolean(x && typeof x === 'object' && (typeof x.nodeType === 'number' || Object.prototype.isPrototypeOf.call(Node.prototype, x)));
            }
        }
        Node.ELEMENT_NODE = 1;
        Node.ATTRIBUTE_NODE = 2;
        Node.TEXT_NODE = 3;
        Node.COMMENT_NODE = 8;
        Node.DOCUMENT_NODE = 9;
        Node.DOCUMENT_FRAGMENT_NODE = 11;

        class Element extends Node {
            static [Symbol.hasInstance](x) {
                return Boolean(x && typeof x === 'object' && (x.nodeType === 1 || Object.prototype.isPrototypeOf.call(Element.prototype, x)));
            }
        }
        class HTMLElement extends Element {
            static [Symbol.hasInstance](x) {
                return Boolean(x && typeof x === 'object' && (x.nodeType === 1 || Object.prototype.isPrototypeOf.call(HTMLElement.prototype, x)));
            }
        }
        class SVGElement extends Element {
            static [Symbol.hasInstance](x) {
                if (!x || typeof x !== 'object') return false;
                if (Object.prototype.isPrototypeOf.call(SVGElement.prototype, x)) return true;
                return x.nodeType === 1 && SVG_TAGS.has(String(x.tagName || '').toUpperCase());
            }
        }
        class Text extends Node {
            static [Symbol.hasInstance](x) {
                return Boolean(x && typeof x === 'object' && (x.nodeType === 3 || Object.prototype.isPrototypeOf.call(Text.prototype, x)));
            }
        }
        class Document extends Node {
            static [Symbol.hasInstance](x) {
                return Boolean(x && typeof x === 'object' && (x.nodeType === 9 || Object.prototype.isPrototypeOf.call(Document.prototype, x)));
            }
        }
        class DocumentFragment extends Node {
            static [Symbol.hasInstance](x) {
                return Boolean(x && typeof x === 'object' && (x.nodeType === 11 || Object.prototype.isPrototypeOf.call(DocumentFragment.prototype, x)));
            }
        }

        const makeHtmlTagClass = (tags) => {
            const tagSet = new Set(Array.isArray(tags) ? tags : [tags]);
            return class HtmlTagElement extends HTMLElement {
                static [Symbol.hasInstance](x) {
                    if (!x || typeof x !== 'object') return false;
                    if (Object.prototype.isPrototypeOf.call(HtmlTagElement.prototype, x)) return true;
                    return x.nodeType === 1 && tagSet.has(String(x.tagName || '').toUpperCase());
                }
            };
        };

        class Event {
            constructor(type, init = {}) {
                this.type = String(type || '');
                this.bubbles = Boolean(init && init.bubbles);
                this.cancelable = Boolean(init && init.cancelable);
                this.composed = Boolean(init && init.composed);
                this.defaultPrevented = false;
                this.target = null;
                this.currentTarget = null;
                this.timeStamp = Date.now();
            }
            preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
            stopPropagation() { this.propagationStopped = true; }
            stopImmediatePropagation() { this.propagationStopped = true; this.immediatePropagationStopped = true; }
            static [Symbol.hasInstance](x) {
                return Boolean(x && typeof x === 'object' && (Object.prototype.isPrototypeOf.call(Event.prototype, x) || (typeof x.type === 'string' && typeof x.preventDefault === 'function')));
            }
        }
        class CustomEvent extends Event {
            constructor(type, init = {}) {
                super(type, init);
                this.detail = init && Object.prototype.hasOwnProperty.call(init, 'detail') ? init.detail : null;
            }
            static [Symbol.hasInstance](x) {
                return Boolean(x && typeof x === 'object' && Object.prototype.isPrototypeOf.call(CustomEvent.prototype, x));
            }
        }
        class UIEvent extends Event {
            constructor(type, init = {}) {
                super(type, init);
                this.view = (init && init.view) || null;
                this.detail = Number((init && init.detail) || 0);
            }
            static [Symbol.hasInstance](x) {
                return Boolean(x && typeof x === 'object' && (Object.prototype.isPrototypeOf.call(UIEvent.prototype, x) || (typeof x.type === 'string' && typeof x.clientX === 'number' && typeof x.preventDefault === 'function')));
            }
        }
        class MouseEvent extends UIEvent {
            constructor(type, init = {}) {
                super(type, init);
                this.clientX = Number((init && init.clientX) || 0);
                this.clientY = Number((init && init.clientY) || 0);
                this.pageX = Number((init && init.pageX) || this.clientX);
                this.pageY = Number((init && init.pageY) || this.clientY);
                this.button = Number((init && init.button) || 0);
                this.buttons = Number((init && init.buttons) || 0);
            }
            static [Symbol.hasInstance](x) {
                return Boolean(x && typeof x === 'object' && (Object.prototype.isPrototypeOf.call(MouseEvent.prototype, x) || (typeof x.type === 'string' && typeof x.clientX === 'number' && typeof x.preventDefault === 'function')));
            }
        }
        class PointerEvent extends MouseEvent {
            constructor(type, init = {}) {
                super(type, init);
                this.pointerId = Number((init && init.pointerId) || 1);
                this.pointerType = String((init && init.pointerType) || 'mouse');
            }
            static [Symbol.hasInstance](x) {
                return Boolean(x && typeof x === 'object' && (Object.prototype.isPrototypeOf.call(PointerEvent.prototype, x) || (typeof x.type === 'string' && typeof x.clientX === 'number' && typeof x.preventDefault === 'function')));
            }
        }
        class KeyboardEvent extends UIEvent {
            constructor(type, init = {}) {
                super(type, init);
                this.key = String((init && init.key) || '');
                this.code = String((init && init.code) || '');
                this.ctrlKey = Boolean(init && init.ctrlKey);
                this.shiftKey = Boolean(init && init.shiftKey);
                this.altKey = Boolean(init && init.altKey);
                this.metaKey = Boolean(init && init.metaKey);
            }
            static [Symbol.hasInstance](x) {
                return Boolean(x && typeof x === 'object' && Object.prototype.isPrototypeOf.call(KeyboardEvent.prototype, x));
            }
        }
        class InputEvent extends UIEvent {
            constructor(type, init = {}) {
                super(type, init);
                this.data = (init && init.data !== undefined) ? init.data : null;
                this.inputType = String((init && init.inputType) || '');
            }
            static [Symbol.hasInstance](x) {
                return Boolean(x && typeof x === 'object' && (Object.prototype.isPrototypeOf.call(InputEvent.prototype, x) || ((x.type === 'input' || x.type === 'change') && typeof x.preventDefault === 'function')));
            }
        }
        class DOMParser {
            parseFromString(html) {
                if (!MockEl) return { nodeType: 9, documentElement: null, head: null, body: null, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
                const htmlEl = new MockEl('html');
                const headEl = new MockEl('head');
                const bodyEl = new MockEl('body');
                htmlEl.appendChild(headEl);
                htmlEl.appendChild(bodyEl);
                bodyEl.innerHTML = String(html ?? '');
                return {
                    nodeType: 9,
                    nodeName: '#document',
                    documentElement: htmlEl,
                    head: headEl,
                    body: bodyEl,
                    querySelector: (sel) => htmlEl.querySelector(sel),
                    querySelectorAll: (sel) => htmlEl.querySelectorAll(sel),
                    getElementById: (id) => htmlEl.querySelector(`#${String(id || '').replace(/[^a-zA-Z0-9_-]/g, '')}`),
                };
            }
        }
        const NodeFilter = {
            SHOW_ALL: 0xFFFFFFFF,
            SHOW_ELEMENT: 1,
            SHOW_TEXT: 4,
            SHOW_COMMENT: 128,
            FILTER_ACCEPT: 1,
            FILTER_REJECT: 2,
            FILTER_SKIP: 3,
        };
        const CSS = {
            escape: (s) => String(s ?? '').replace(/([^\w-])/g, '\\$1'),
            supports: () => true,
        };
        const noopObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
        return {
            EventTarget,
            Node,
            Element,
            HTMLElement,
            SVGElement,
            Text,
            Document,
            DocumentFragment,
            HTMLInputElement: makeHtmlTagClass('INPUT'),
            HTMLTextAreaElement: makeHtmlTagClass('TEXTAREA'),
            HTMLButtonElement: makeHtmlTagClass('BUTTON'),
            HTMLImageElement: makeHtmlTagClass('IMG'),
            HTMLSelectElement: makeHtmlTagClass('SELECT'),
            HTMLFormElement: makeHtmlTagClass('FORM'),
            HTMLDivElement: makeHtmlTagClass('DIV'),
            HTMLSpanElement: makeHtmlTagClass('SPAN'),
            HTMLAnchorElement: makeHtmlTagClass('A'),
            HTMLCanvasElement: makeHtmlTagClass('CANVAS'),
            HTMLIFrameElement: makeHtmlTagClass('IFRAME'),
            HTMLStyleElement: makeHtmlTagClass('STYLE'),
            HTMLScriptElement: makeHtmlTagClass('SCRIPT'),
            HTMLTemplateElement: makeHtmlTagClass('TEMPLATE'),
            Event,
            CustomEvent,
            UIEvent,
            MouseEvent,
            PointerEvent,
            KeyboardEvent,
            InputEvent,
            NodeFilter,
            DOMParser,
            CSS,
            getComputedStyle: (el) => (el && el.style ? el.style : {}),
            ResizeObserver: noopObserver,
            IntersectionObserver: noopObserver,
            navigator: {
                userAgent: 'Mozilla/5.0 RisuStand/1.0',
                language: 'ko-KR',
                languages: ['ko-KR', 'ko', 'en-US'],
                clipboard: {
                    writeText: async () => {},
                    readText: async () => '',
                },
            },
            innerWidth: 1280,
            innerHeight: 800,
            devicePixelRatio: 1,
        };
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
        const sharedMockDom = createHeadlessMockDom({
            onToastText: (txt) => updateHookTaskDetail(name, txt, true),
            onChatSurfaceMutated: () => {
                if (activeActionTracker) activeActionTracker.surfaceMutated = true;
                if (typeof onSurfaceMutated === 'function') {
                    try { onSurfaceMutated({ pluginName: name }); } catch (_) {}
                }
            },
        });
        pluginDoms.set(name, sharedMockDom);
        const { api, trackedUnloads } = makePluginApiFor(entry, record, sharedMockDom);
        const timers = new Set();
        const { syncDoc, asyncDoc } = sharedMockDom;
        const sandboxCrypto = createSandboxCrypto();
        const triggerSandboxReload = () => {
            if (isRpcConnected()) {
                void hostRpc.invoke('db.reloadPcPlugins', [], 8000).catch(() => {});
            }
            setTimeout(() => {
                reloadPlugins(name).catch(() => {});
            }, 25);
            return true;
        };
        const mockLocation = {
            href: 'https://risuai.local/',
            origin: 'https://risuai.local',
            protocol: 'https:',
            host: 'risuai.local',
            hostname: 'risuai.local',
            pathname: '/',
            search: '',
            hash: '',
            reload: triggerSandboxReload,
            assign: () => {},
            replace: () => {},
        };

        const logFromPlugin = (...a) => {
            if (activeHookFrame && activeHookFrame.pluginName === name) {
                const msg = a.map((v) => {
                    if (typeof v === 'string') return v;
                    try { return JSON.stringify(v); } catch (_) { return String(v); }
                }).join(' ');
                appendHookStepLog(name, msg);
            }
        };
        const sandbox = {
            console: {
                log: (...a) => { logFromPlugin(...a); console.log(`[Plugin:${name}]`, ...a); },
                info: (...a) => { logFromPlugin(...a); console.log(`[Plugin:${name}]`, ...a); },
                warn: (...a) => { logFromPlugin(...a); console.warn(`[Plugin:${name}]`, ...a); },
                error: (...a) => { logFromPlugin(...a); console.error(`[Plugin:${name}]`, ...a); },
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
            DOMException: typeof DOMException !== 'undefined' ? DOMException : Error,
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
            fetch: (u, o) => proxyFetchForPlugin(u, o, false, name),
            risuai: api,
            Risuai: api,
            RisuAI: api,
            risuApi: api,
            risuAPI: api,
            document: syncDoc,
            localStorage: createSyncWebStorage(webLocalStore, {
                onRead: (k) => recordStorageEvent(name, { op: 'read', storeKind: 'webLocalStorage', key: k, ok: true }),
                onSet: (k) => {
                    recordStorageEvent(name, { op: 'write', storeKind: 'webLocalStorage', key: k, ok: true });
                    scheduleSaveStorage();
                },
                onRemove: (k) => {
                    recordStorageEvent(name, { op: 'write', storeKind: 'webLocalStorage', key: k, ok: true });
                    scheduleSaveStorage();
                },
                onClear: () => {
                    recordStorageEvent(name, { op: 'write', storeKind: 'webLocalStorage', key: '*', ok: true });
                    scheduleSaveStorage();
                },
            }),
            sessionStorage: createSyncWebStorage(webSessionStore, {
                onRead: (k) => recordStorageEvent(name, { op: 'read', storeKind: 'webSessionStorage', key: k, ok: true }),
                onSet: (k) => recordStorageEvent(name, { op: 'write', storeKind: 'webSessionStorage', key: k, ok: true }),
                onRemove: (k) => recordStorageEvent(name, { op: 'write', storeKind: 'webSessionStorage', key: k, ok: true }),
                onClear: () => recordStorageEvent(name, { op: 'write', storeKind: 'webSessionStorage', key: '*', ok: true }),
            }),
            MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
            matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
            requestAnimationFrame: (fn) => sandbox.setTimeout(fn, 16),
            cancelAnimationFrame: (id) => sandbox.clearTimeout(id),
            ...buildSandboxDomGlobals(sharedMockDom),
            location: mockLocation,
        };
        syncDoc.location = mockLocation;
        syncDoc.defaultView = sandbox;
        asyncDoc.location = mockLocation;
        asyncDoc.defaultView = { location: mockLocation, reload: triggerSandboxReload };
        sandbox.window = sandbox;
        sandbox.self = sandbox;
        sandbox.top = sandbox;
        sandbox.parent = sandbox;
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

    async function reloadPlugins(targetName = '') {
        if (isRpcConnected()) {
            await syncPcPlugins().catch(() => {});
        }
        const t = String(targetName || '').trim();
        if (t) {
            const entry = getPluginEntry(t);
            if (entry) {
                if (isPluginEnabled(t)) await loadPlugin(t);
                else if (activeHosts.has(t)) await unloadPlugin(t);
            }
            return listPlugins();
        }
        for (const entry of getAllKnownEntries()) {
            if (isPluginEnabled(entry.name)) {
                await loadPlugin(entry.name);
            } else if (activeHosts.has(entry.name)) {
                await unloadPlugin(entry.name);
            }
        }
        return listPlugins();
    }

    const PLUGIN_SCRIPT_CHUNK_CHARS = 1500000;
    let syncPcInFlight = null;

    // Boot any persisted custom/enabled plugins on startup (non-blocking if offline)
    void reconcileEnabledPlugins().catch(() => {});

    async function fetchPcPluginListForSync() {
        let metaList = null;
        try {
            metaList = await hostRpc.invoke('db.listPluginsMeta', [true], 30000);
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            if (!/Unsupported host RPC op/i.test(msg)) {
                throw err;
            }
            return await hostRpc.invoke('db.getPlugins', [], 90000);
        }
        if (!Array.isArray(metaList)) return null;

        const out = [];
        for (const meta of metaList) {
            if (!meta || !meta.name || meta.name === 'risustand') continue;
            const pName = String(meta.name);
            const expectedLen = Number(meta.scriptLen);
            const expectedSig = typeof meta.scriptSig === 'string' ? meta.scriptSig : '';
            const prev = pcPlugins.get(pName);

            let script = '';
            if (prev && typeof prev.script === 'string' && prev.script.length === expectedLen && expectedSig && computePluginScriptSig(prev.script) === expectedSig) {
                script = prev.script;
            } else if (expectedLen === 0) {
                continue;
            } else {
                const parts = [];
                let offset = 0;
                const limitLen = Number.isFinite(expectedLen) && expectedLen > 0 ? expectedLen : Infinity;
                while (offset < limitLen) {
                    const part = await hostRpc.invoke('db.getPluginScriptChunk', [pName, offset, PLUGIN_SCRIPT_CHUNK_CHARS], 30000);
                    if (!part || typeof part.chunk !== 'string') break;
                    parts.push(part.chunk);
                    if (!part.chunk.length) break;
                    offset += part.chunk.length;
                    if (part.eof || (typeof part.totalLen === 'number' && offset >= part.totalLen)) break;
                }
                script = parts.join('');
            }
            if (!script) continue;
            out.push({ ...meta, script });
        }
        return out;
    }

    async function runSyncPcPlugins() {
        let rawList;
        try {
            rawList = await fetchPcPluginListForSync();
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            if (/Host RPC timeout/i.test(msg)) {
                throw new Error(`${msg} — 대용량 플러그인 전송이 지연되었거나 PC RisuAI에 DB 권한 허용 팝업이 대기 중일 수 있습니다. 릴레이 서버와 PC RisuAI의 RisuStand 플러그인을 최신 파일로 재적용한 뒤 다시 시도해 주세요.`);
            }
            throw err;
        }
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

    async function syncPcPlugins() {
        if (!isRpcConnected()) return listPlugins();
        void flushDirtyStoreOps().catch(() => {});
        if (syncPcInFlight) return syncPcInFlight;
        syncPcInFlight = runSyncPcPlugins().finally(() => {
            syncPcInFlight = null;
        });
        return syncPcInFlight;
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
        invalidateReadCache();
        turnCache = {
            active: true,
            deferredEnd: false,
            turnRunId: ++runtimeTurnRunSeq,
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
            turnCache.charObj = charObj ? cloneJson(charObj) : cloneJson(getOrSeedFallbackChar(turnCache.charIndex));
            turnCache.chatObj = chatObj ? cloneJson(chatObj) : ((turnCache.charObj && turnCache.charObj.chats && turnCache.charObj.chats[turnCache.chatIndex]) || null);
        } else {
            const seeded = getOrSeedFallbackChar(turnCache.charIndex);
            turnCache.charObj = seeded ? cloneJson(seeded) : null;
            turnCache.chatObj = (turnCache.charObj && turnCache.charObj.chats && turnCache.charObj.chats[turnCache.chatIndex]) || null;
        }
        if (turnCache.chatObj) {
            ensureStableChatAndMessageIds(turnCache.charObj, turnCache.charIndex, turnCache.chatObj, turnCache.chatIndex);
        }
        if (turnCache.charObj && turnCache.chatObj) {
            if (!Array.isArray(turnCache.charObj.chats)) turnCache.charObj.chats = [];
            turnCache.charObj.chats[turnCache.chatIndex] = turnCache.chatObj;
        }
    }

    function endTurn({ force = false } = {}) {
        if (!force && pendingChatOutputs > 0 && turnCache.active) {
            turnCache.deferredEnd = true;
            return;
        }
        turnCache.active = false;
        turnCache.deferredEnd = false;
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
        const steps = [
            ...hookState.editprocess.map((h) => ({ kind: 'editprocess', h })),
            ...hookState.beforeRequest.map((h) => ({ kind: 'beforeRequest', h })),
        ];
        const total = steps.length;
        const effectiveTurnRunId = (turnCache.active && turnCache.turnRunId)
            ? turnCache.turnRunId
            : (++runtimeTurnRunSeq);
        const modeStr = String(mode || 'model');
        const perPluginBatch = new Map();
        for (let idx = 0; idx < total; idx += 1) {
            const { kind, h } = steps[idx];
            const initialTask = kind === 'editprocess' ? '요청 텍스트 전처리 중' : '프롬프트·컨텍스트 구성 중';
            await runHookStepWithActivity({
                stage: 'beforeRequest',
                step: idx + 1,
                total,
                pluginName: h.pluginName,
                initialTask,
            }, async () => {
                const startedAt = Date.now();
                const beforeSnap = msgs.map((m) => ({
                    role: String((m && m.role) || ''),
                    content: extractMessageText(m),
                }));
                let stepErr = '';
                if (kind === 'editprocess') {
                    try {
                        for (let i = 0; i < msgs.length; i += 1) {
                            const res = await h.fn(String(msgs[i].content ?? ''));
                            if (typeof res === 'string') msgs[i].content = res;
                        }
                    } catch (e) {
                        stepErr = e && e.message ? e.message : String(e);
                        console.warn(`[Plugin:${h.pluginName}] editprocess error:`, stepErr);
                    }
                } else {
                    try {
                        const inputCopy = msgs.map((m) => ({ ...m }));
                        const res = await h.fn(inputCopy, mode);
                        if (Array.isArray(res)) {
                            msgs = res;
                        } else if (res && typeof res === 'object' && Array.isArray(res.content)) {
                            msgs = res.content;
                        } else if (res === undefined) {
                            msgs = inputCopy;
                        }
                    } catch (e) {
                        stepErr = e && e.message ? e.message : String(e);
                        console.warn(`[Plugin:${h.pluginName}] beforeRequest error:`, stepErr);
                    }
                }
                const diff = diffPluginPromptInjection(beforeSnap, msgs);
                const now = Date.now();
                const stepDurationMs = Math.max(0, now - startedAt);
                const stepFetchCount = (activeHookFrame && activeHookFrame.fetchCount) || 0;
                const stepLlmCount = (activeHookFrame && activeHookFrame.llmCount) || 0;
                const stepLogs = (activeHookFrame && Array.isArray(activeHookFrame.logs)) ? [...activeHookFrame.logs] : [];

                let entry = perPluginBatch.get(h.pluginName);
                if (!entry) {
                    entry = {
                        at: now,
                        durationMs: 0,
                        kind,
                        mode: modeStr,
                        turnRunId: effectiveTurnRunId,
                        charIndex: turnCache.active ? turnCache.charIndex : lastActiveLocation.charIndex,
                        chatIndex: turnCache.active ? turnCache.chatIndex : lastActiveLocation.chatIndex,
                        chatUuid: String((turnCache.chatObj && turnCache.chatObj.id) || ''),
                        charName: String((turnCache.charObj && turnCache.charObj.name) || ''),
                        chatName: String((turnCache.chatObj && turnCache.chatObj.name) || ''),
                        userPreview: extractLastUserPreview(beforeSnap),
                        beforeCount: diff.beforeCount,
                        afterCount: diff.afterCount,
                        injectedCount: 0,
                        totalInjectedChars: 0,
                        strippedCount: 0,
                        totalRemovedChars: 0,
                        injectedBlocks: [],
                        fetchCount: 0,
                        llmCount: 0,
                        stepLogs: [],
                        error: '',
                        _hadBeforeRequest: false,
                        _hasChanged: false,
                    };
                    perPluginBatch.set(h.pluginName, entry);
                }
                entry.at = now;
                entry.durationMs += stepDurationMs;
                entry.afterCount = diff.afterCount;
                if (kind === 'beforeRequest') {
                    entry._hadBeforeRequest = true;
                    entry.kind = 'beforeRequest';
                }
                if (diff.changed) entry._hasChanged = true;
                if (diff.injectedBlocks.length) {
                    for (const blk of diff.injectedBlocks) {
                        if (entry.injectedBlocks.length >= 32) break;
                        entry.injectedBlocks.push(blk);
                    }
                    entry.injectedCount = entry.injectedBlocks.length;
                    entry.totalInjectedChars = entry.injectedBlocks.reduce((acc, b) => acc + (Number(b.addedChars) || 0), 0);
                }
                entry.strippedCount += diff.strippedCount || 0;
                entry.totalRemovedChars += diff.totalRemovedChars || 0;
                entry.fetchCount += stepFetchCount;
                entry.llmCount += stepLlmCount;
                for (const lg of stepLogs) {
                    if (entry.stepLogs.length >= 20) break;
                    if (!entry.stepLogs.length || entry.stepLogs[entry.stepLogs.length - 1] !== lg) {
                        entry.stepLogs.push(lg);
                    }
                }
                if (stepErr) {
                    entry.error = entry.error ? `${entry.error}; ${stepErr}` : stepErr;
                }
            });
        }
        for (const [pluginName, batch] of perPluginBatch.entries()) {
            if (!batch._hadBeforeRequest && !batch._hasChanged && !batch.error) continue;
            const rec = ensureRuntimeLedger(pluginName);
            rec.beforeRequestRuns += 1;
            rec.lastBeforeRequestAt = batch.at;
            if (modeStr === 'model' || batch._hasChanged || Boolean(batch.error)) {
                const { _hadBeforeRequest, _hasChanged, ...cleanEntry } = batch;
                rec.history.push({
                    id: ++runtimeRecallSeq,
                    ...cleanEntry,
                });
                if (rec.history.length > 12) {
                    rec.history.splice(0, rec.history.length - 12);
                }
            }
            scheduleSaveLedger();
        }
        return msgs;
    }

    async function runBodyIntercepters(bodyObj, type = 'openai') {
        let current = bodyObj;
        const effectiveTurnRunId = (turnCache.active && turnCache.turnRunId) ? turnCache.turnRunId : 0;
        const activeChatUuid = String((turnCache.chatObj && turnCache.chatObj.id) || '');
        const list = [...hookState.bodyIntercepter];
        const total = list.length;
        for (let idx = 0; idx < total; idx += 1) {
            const h = list[idx];
            await runHookStepWithActivity({
                stage: 'bodyIntercepter',
                step: idx + 1,
                total,
                pluginName: h.pluginName,
                initialTask: '요청 바디 인터셉트 중',
            }, async () => {
                const beforeBodyMsgs = extractMessagesFromRequestBody(current, type);
                const startedAt = Date.now();
                const draft = cloneJson(current);
                let stepErr = '';
                try {
                    const res = await h.fn(draft, type);
                    if (res && typeof res === 'object' && !Array.isArray(res)) {
                        current = res;
                    } else if (res === undefined && draft && typeof draft === 'object' && !Array.isArray(draft)) {
                        current = draft;
                    }
                } catch (e) {
                    stepErr = e && e.message ? e.message : String(e);
                    console.warn(`[Plugin:${h.pluginName}] bodyIntercepter error:`, stepErr);
                }
                const afterBodyMsgs = extractMessagesFromRequestBody(current, type);
                const diff = diffPluginPromptInjection(beforeBodyMsgs, afterBodyMsgs);
                const rec = ensureRuntimeLedger(h.pluginName);
                const now = Date.now();
                rec.bodyIntercepterRuns += 1;
                rec.lastBodyIntercepterAt = now;
                const durationMs = Math.max(0, now - startedAt);
                const stepFetchCount = (activeHookFrame && activeHookFrame.fetchCount) || 0;
                const stepLlmCount = (activeHookFrame && activeHookFrame.llmCount) || 0;
                const stepLogs = (activeHookFrame && Array.isArray(activeHookFrame.logs)) ? [...activeHookFrame.logs] : [];
                if (diff.changed || stepErr || stepFetchCount > 0 || stepLlmCount > 0 || stepLogs.length > 0) {
                    const prev = rec.history.length ? rec.history[rec.history.length - 1] : null;
                    if (
                        prev &&
                        effectiveTurnRunId > 0 &&
                        prev.turnRunId === effectiveTurnRunId &&
                        String(prev.chatUuid || '') === activeChatUuid
                    ) {
                        prev.at = now;
                        prev.durationMs = (Number(prev.durationMs) || 0) + durationMs;
                        if (prev.kind === 'beforeRequest') prev.kind = 'beforeRequest+bodyIntercepter';
                        for (const blk of diff.injectedBlocks) {
                            if (prev.injectedBlocks.length >= 32) break;
                            prev.injectedBlocks.push(blk);
                        }
                        prev.injectedCount = prev.injectedBlocks.length;
                        prev.totalInjectedChars = prev.injectedBlocks.reduce((acc, b) => acc + (Number(b.addedChars) || 0), 0);
                        prev.strippedCount = (Number(prev.strippedCount) || 0) + (diff.strippedCount || 0);
                        prev.totalRemovedChars = (Number(prev.totalRemovedChars) || 0) + (diff.totalRemovedChars || 0);
                        if (diff.afterCount) prev.afterCount = Math.max(Number(prev.afterCount) || 0, diff.afterCount);
                        prev.fetchCount = (Number(prev.fetchCount) || 0) + stepFetchCount;
                        prev.llmCount = (Number(prev.llmCount) || 0) + stepLlmCount;
                        for (const lg of stepLogs) {
                            if (prev.stepLogs.length >= 20) break;
                            if (!prev.stepLogs.length || prev.stepLogs[prev.stepLogs.length - 1] !== lg) prev.stepLogs.push(lg);
                        }
                        if (stepErr) {
                            prev.error = prev.error ? `${prev.error}; ${stepErr}` : stepErr;
                        }
                    } else {
                        rec.history.push({
                            id: ++runtimeRecallSeq,
                            at: now,
                            durationMs,
                            kind: 'bodyIntercepter',
                            mode: String(type || 'openai'),
                            turnRunId: effectiveTurnRunId,
                            charIndex: turnCache.active ? turnCache.charIndex : lastActiveLocation.charIndex,
                            chatIndex: turnCache.active ? turnCache.chatIndex : lastActiveLocation.chatIndex,
                            chatUuid: activeChatUuid,
                            charName: String((turnCache.charObj && turnCache.charObj.name) || ''),
                            chatName: String((turnCache.chatObj && turnCache.chatObj.name) || ''),
                            userPreview: extractLastUserPreview(beforeBodyMsgs),
                            beforeCount: diff.beforeCount,
                            afterCount: diff.afterCount,
                            injectedCount: diff.injectedCount,
                            totalInjectedChars: diff.totalInjectedChars,
                            strippedCount: diff.strippedCount || 0,
                            totalRemovedChars: diff.totalRemovedChars || 0,
                            injectedBlocks: diff.injectedBlocks,
                            fetchCount: stepFetchCount,
                            llmCount: stepLlmCount,
                            stepLogs,
                            error: stepErr,
                        });
                        if (rec.history.length > 12) {
                            rec.history.splice(0, rec.history.length - 12);
                        }
                    }
                }
                scheduleSaveLedger();
            });
        }
        return current;
    }

    async function runAfterRequest(text, mode = 'model') {
        let out = String(text ?? '');
        const steps = [
            ...hookState.afterRequest.map((h) => ({ kind: 'afterRequest', h })),
            ...hookState.editoutput.map((h) => ({ kind: 'editoutput', h })),
        ];
        const total = steps.length;
        for (let idx = 0; idx < total; idx += 1) {
            const { kind, h } = steps[idx];
            const initialTask = kind === 'editoutput' ? '응답 출력 정규화 중' : '응답 후처리·기억/상태 갱신 중';
            await runHookStepWithActivity({
                stage: 'afterRequest',
                step: idx + 1,
                total,
                pluginName: h.pluginName,
                initialTask,
            }, async () => {
                const startedAt = Date.now();
                const beforeOut = out;
                let stepErr = '';
                if (kind === 'afterRequest') {
                    try {
                        const res = await h.fn(out, mode);
                        if (typeof res === 'string') out = res;
                    } catch (e) {
                        stepErr = e && e.message ? e.message : String(e);
                        console.warn(`[Plugin:${h.pluginName}] afterRequest error:`, stepErr);
                    }
                } else {
                    try {
                        const res = await h.fn(out);
                        if (typeof res === 'string') out = res;
                    } catch (e) {
                        stepErr = e && e.message ? e.message : String(e);
                        console.warn(`[Plugin:${h.pluginName}] editoutput error:`, stepErr);
                    }
                }
                if (kind === 'afterRequest' || out !== beforeOut || stepErr) {
                    const rec = ensureRuntimeLedger(h.pluginName);
                    const now = Date.now();
                    rec.afterRequestRuns += 1;
                    rec.lastAfterRequestAt = now;
                    rec.lastAfterRequest = {
                        at: now,
                        durationMs: Math.max(0, now - startedAt),
                        kind,
                        mode: String(mode || 'model'),
                        outputChanged: out !== beforeOut,
                        deltaChars: out.length - beforeOut.length,
                        fetchCount: (activeHookFrame && activeHookFrame.fetchCount) || 0,
                        llmCount: (activeHookFrame && activeHookFrame.llmCount) || 0,
                        stepLogs: (activeHookFrame && Array.isArray(activeHookFrame.logs)) ? [...activeHookFrame.logs] : [],
                        error: stepErr,
                    };
                    scheduleSaveLedger();
                }
            });
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
        if (turnCache.charObj) {
            fallbackCharCache.set(Number(charIndex), cloneJson(turnCache.charObj));
        }
        return { committedViaRpc: false, messageIndex };
    }

    function collectMockDomStyles(mockDom) {
        const styles = [];
        const seen = new Set();
        if (!mockDom) return styles;
        const pushStyleEl = (st) => {
            if (!st || st.tagName !== 'STYLE') return;
            const txt = st.textContent || st.innerHTML || '';
            if (txt && !seen.has(txt)) {
                seen.add(txt);
                styles.push(txt);
            }
        };
        const docEl = mockDom.documentElement;
        const head = mockDom.head;
        const body = mockDom.body;
        if (docEl && typeof docEl.querySelectorAll === 'function') {
            for (const st of docEl.querySelectorAll('style')) pushStyleEl(st);
        }
        for (const container of [docEl, head, body]) {
            if (!container) continue;
            if (typeof container.querySelectorAll === 'function') {
                for (const st of container.querySelectorAll('style')) pushStyleEl(st);
            }
            for (const st of container.children || []) pushStyleEl(st);
        }
        return styles;
    }

    function isNodeVisiblyHidden(el) {
        if (!el || el.nodeType !== 1) return true;
        if (el.hasAttribute('hidden')) return true;
        const stAttr = (el.attributes && el.attributes.get('style')) || '';
        if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(stAttr)) return true;
        return false;
    }

    function hasVisibleContent(el) {
        if (!el || el.nodeType !== 1) return false;
        const inner = el.innerHTML || el.textContent || '';
        return Boolean(inner.trim() || (el.children && el.children.length));
    }

    const knownModalsByPlugin = new Map();

    function isPersistentToastOrBadge(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el.hasAttribute('data-am-toast-region') || el.hasAttribute('data-am-count-region')) return true;
        if (el.classList && (el.classList.contains('x-risu-am-generation-count') || el.classList.contains('x-risu-am-runtime-toast-stack'))) {
            return true;
        }
        return false;
    }

    function isExplicitModalElement(el) {
        if (!el || el.nodeType !== 1) return false;
        if (isNodeVisiblyHidden(el) || isPersistentToastOrBadge(el)) return false;
        const tag = String(el.tagName || '').toUpperCase();
        if (tag === 'DIALOG' && el.hasAttribute('open')) return true;
        const role = String((el.attributes && el.attributes.get('role')) || '').toLowerCase();
        if (role === 'dialog' || role === 'alertdialog') return true;
        if (String((el.attributes && el.attributes.get('aria-modal')) || '').toLowerCase() === 'true') return true;
        if (el.attributes) {
            for (const aName of el.attributes.keys()) {
                if (/^(?:data-am-(?:viewer|lightbox|modal|inspector|gallery|dialog|sheet|drawer|overlay)|data-plugin-modal|data-modal)/i.test(aName)) {
                    return true;
                }
            }
        }
        const cls = String(el.className || '');
        if (!/(?:^|[-_\s])(?:toast|count|toolbar|badge|fab|generation-count)(?:$|[-_\s])/i.test(cls)
            && /(?:^|[-_\s])(?:modal|dialog|viewer|lightbox|inspector|gallery|sheet|drawer|popup)(?:$|[-_\s])/i.test(cls)) {
            return true;
        }
        return false;
    }

    function describeOverlayElement(el) {
        let key = '';
        if (el && el.id) {
            key = String(el.id).trim();
        }
        if (!key && el && el.attributes) {
            for (const aName of el.attributes.keys()) {
                if (/^(?:data-am-(?:viewer|lightbox|modal|inspector|gallery|dialog|sheet|drawer)|data-plugin-modal|data-modal)/i.test(aName)) {
                    const aVal = String(el.attributes.get(aName) || '').trim();
                    key = aVal && aVal !== 'true' && aVal !== '1' ? `${aName}:${aVal}` : aName;
                    break;
                }
            }
        }
        if (!key && el && el.className) {
            const clsTokens = String(el.className).split(/\s+/).filter(Boolean).map((c) => c.replace(/^x-risu-/, ''));
            const modalCls = clsTokens.find((c) => /(?:modal|dialog|viewer|lightbox|inspector|gallery|sheet|drawer|popup)/i.test(c));
            key = modalCls || clsTokens[0] || '';
        }
        if (!key) key = `overlay-${String((el && el.tagName) || 'div').toLowerCase()}`;

        let label = '';
        if (el && typeof el.querySelector === 'function') {
            const heading = el.querySelector('h1, h2, h3, [role="heading"], [data-am-modal-title]');
            if (heading) label = String(heading.textContent || '').replace(/\s+/g, ' ').trim();
        }
        if (!label && el && el.attributes) {
            label = String(el.attributes.get('aria-label') || el.attributes.get('title') || '').replace(/\s+/g, ' ').trim();
        }
        if (!label) {
            if (/inspector|viewer|gallery|lightbox/i.test(key)) label = '삽화 뷰어 · 관리 모달';
            else if (/range|scene|setting/i.test(key)) label = '장면 · 설정 모달';
            else if (/modal|dialog|popup|drawer|sheet/i.test(key)) label = `팝업 모달 (${key})`;
            else label = `플러그인 오버레이 (${key})`;
        }
        return { key, label: label.slice(0, 64), autoPopup: true };
    }

    function extractTriggerKeyFromElement(el) {
        if (!el || el.nodeType !== 1 || !el.attributes) return '';
        const actionAttrs = [
            'data-am-runtime-generation-count-action',
            'data-am-viewer-action',
            'data-am-image-action',
            'data-am-illustration-action',
            'data-am-gallery-action',
            'data-am-action',
            'data-am-runtime-toast-action',
        ];
        for (const aName of actionAttrs) {
            const v = el.attributes.get(aName);
            if (v !== undefined && v !== null && String(v).trim() !== '') {
                return `trigger:${aName}=${String(v).trim()}`;
            }
        }
        if (el.id) return `trigger:#${String(el.id).trim()}`;
        const txt = String(el.attributes.get('aria-label') || el.attributes.get('title') || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt || txt === '-' || txt === '+' || txt === '−') return '';
        return `trigger:label:${txt.toLowerCase().slice(0, 40)}`;
    }

    function recordPluginModalEntry(pluginName, item) {
        if (!pluginName || !item || !item.key) return;
        let map = knownModalsByPlugin.get(pluginName);
        if (!map) {
            map = new Map();
            knownModalsByPlugin.set(pluginName, map);
        }
        const prev = map.get(item.key);
        map.set(item.key, {
            key: item.key,
            label: item.label || (prev && prev.label) || item.key,
            kind: item.kind || (prev && prev.kind) || 'modal',
            autoPopup: item.autoPopup !== undefined ? item.autoPopup : (prev ? prev.autoPopup : true),
        });
    }

    function getKnownModalsList(pluginName) {
        const map = knownModalsByPlugin.get(pluginName);
        if (!map) return [];
        return Array.from(map.values());
    }

    function recordPluginModalCatalog(pluginName, mockDom) {
        if (!pluginName || !mockDom) return;
        const rootNode = mockDom.documentElement || mockDom.body;
        if (rootNode && typeof rootNode.querySelector === 'function') {
            const countRoot = rootNode.querySelector('[data-am-count-region], .x-risu-am-generation-count');
            if (countRoot) {
                recordPluginModalEntry(pluginName, {
                    key: 'floating-bar',
                    label: '플로팅 컨트롤 바 (펼침/접힘)',
                    kind: 'inline',
                    autoPopup: false,
                });
            }
            const btns = typeof rootNode.querySelectorAll === 'function' ? rootNode.querySelectorAll('button, [role="button"], [data-am-runtime-generation-count-action]') : [];
            let addedTriggers = 0;
            for (const btn of btns) {
                if (addedTriggers >= 12) break;
                if (mockDom.chatScreen && mockDom.chatScreen.contains && mockDom.chatScreen.contains(btn)) continue;
                const tKey = extractTriggerKeyFromElement(btn);
                if (!tKey) continue;
                const rawLbl = String((btn.attributes && (btn.attributes.get('title') || btn.attributes.get('aria-label'))) || btn.textContent || '').replace(/\s+/g, ' ').trim();
                const cleanLbl = rawLbl && rawLbl.length <= 28 ? rawLbl : tKey.replace(/^trigger:(?:[^=]+=|label:)?/, '');
                if (!cleanLbl || cleanLbl === '-' || cleanLbl === '+' || cleanLbl === '−') continue;
                recordPluginModalEntry(pluginName, {
                    key: tKey,
                    label: `컨트롤: ${cleanLbl}`,
                    kind: 'trigger',
                    autoPopup: null,
                });
                addedTriggers += 1;
            }
        }
    }

    function extractOverlayEntries(mockDom) {
        const out = [];
        if (!mockDom || !mockDom.body) return out;
        const collectModalDescendants = (node) => {
            if (!node || node.nodeType !== 1 || isNodeVisiblyHidden(node)) return;
            if (isExplicitModalElement(node)) {
                if (hasVisibleContent(node)) {
                    out.push({ ...describeOverlayElement(node), html: node.outerHTML });
                }
                return;
            }
            for (const sub of node.children || []) {
                collectModalDescendants(sub);
            }
        };
        const collectFromNode = (el) => {
            if (!el || el === mockDom.chatScreen || el.tagName === 'STYLE' || el.tagName === 'SCRIPT') return;
            if (isNodeVisiblyHidden(el)) return;
            if (typeof el.hasAttribute === 'function' && el.hasAttribute('data-plugin-chat-panel')) return;
            if (isPersistentToastOrBadge(el)) {
                // Persistent floating bars/toasts stay inline; only explicit modal children inside them open overlays
                for (const sub of el.children || []) {
                    collectModalDescendants(sub);
                }
                return;
            }
            if (typeof el.hasAttribute === 'function' && (el.hasAttribute('data-am-floating-viewport') || el.hasAttribute('x-am-root-host'))) {
                for (const sub of el.children || []) {
                    collectFromNode(sub);
                }
                return;
            }
            const countReg = typeof el.querySelector === 'function' ? el.querySelector('[data-am-count-region]') : null;
            const toastReg = typeof el.querySelector === 'function' ? el.querySelector('[data-am-toast-region]') : null;
            if (countReg || toastReg) {
                for (const sub of el.children || []) {
                    collectFromNode(sub);
                }
                return;
            }
            if (!hasVisibleContent(el)) return;
            out.push({ ...describeOverlayElement(el), html: el.outerHTML });
        };
        for (const ch of mockDom.body.children || []) {
            collectFromNode(ch);
        }
        if (mockDom.documentElement) {
            for (const ch of mockDom.documentElement.children || []) {
                if (ch === mockDom.head || ch === mockDom.body) continue;
                collectFromNode(ch);
            }
        }
        return out;
    }

    function extractOverlayBlocks(mockDom) {
        return extractOverlayEntries(mockDom).map((e) => e.html);
    }

    function getPluginOverlaySnapshot(pluginName) {
        const mockDom = pluginDoms.get(pluginName);
        if (!mockDom || !activeHosts.has(pluginName)) return null;
        recordPluginModalCatalog(pluginName, mockDom);
        const entries = extractOverlayEntries(mockDom);
        if (!entries.length) return null;
        for (const e of entries) {
            recordPluginModalEntry(pluginName, { key: e.key, label: e.label, kind: 'modal', autoPopup: true });
        }
        const primary = entries[entries.length - 1];
        return {
            pluginName,
            displayName: getPluginDisplayName(pluginName),
            styles: collectMockDomStyles(mockDom),
            html: entries.map((e) => e.html).join('\n'),
            modalKey: primary.key,
            modalLabel: primary.label,
            autoPopup: primary.autoPopup !== false,
        };
    }

    async function dispatchSurfaceAction({
        charIndex,
        chatIndex,
        msgIndex = -1,
        chatId = '',
        actionHtml = '',
        dataset = {},
        selector = '',
        textContent = '',
        ariaLabel = '',
        title = '',
        className = '',
        siblingIndex = -1,
    } = {}) {
        const cIdx = Number(charIndex);
        const chIdx = Number(chatIndex);
        if (!Number.isNaN(cIdx) && !Number.isNaN(chIdx) && cIdx >= 0 && chIdx >= 0) {
            lastActiveLocation = { charIndex: cIdx, chatIndex: chIdx };
        }
        const snap = getFallbackSnapshot();
        const baseChatUuid = String((snap && (snap.chatUuid || snap.chatId)) || `rs-chat-${Math.max(0, cIdx)}-${Math.max(0, chIdx)}`);
        const syncedMsgs = (snap && Array.isArray(snap.messages))
            ? snap.messages.map((m) => (m && !m.isFirstMessage && Number(m.index) >= 0 && !m.chatId
                ? { ...m, chatId: `rs-msg-${baseChatUuid}-${m.index}` }
                : m))
            : [];
        const resolvedCid = String(chatId || '').trim()
            || ((syncedMsgs.find((m) => m && Number(m.index) === Number(msgIndex)) || {}).chatId || '');

        const beforeOverlayHtmlByPlugin = new Map();
        for (const [pName, mockDom] of pluginDoms.entries()) {
            if (!activeHosts.has(pName)) continue;
            beforeOverlayHtmlByPlugin.set(pName, extractOverlayBlocks(mockDom).join('\n'));
        }

        const prevTracker = activeActionTracker;
        const tracker = { dbMutated: false, surfaceMutated: false, openedContainerPlugin: '' };
        activeActionTracker = tracker;
        let dispatchedCount = 0;
        let matchedLive = false;
        let openedOverlay = null;
        let openPluginGui = null;

        try {
            const matchOpts = { msgIndex, chatId: resolvedCid, selector, actionHtml, dataset, textContent, ariaLabel, title, className, siblingIndex };
            const pluginErrors = [];
            for (const [pName, mockDom] of pluginDoms.entries()) {
                if (!activeHosts.has(pName)) continue;
                try {
                    if (syncedMsgs.length && typeof mockDom.syncChatMessages === 'function') {
                        mockDom.syncChatMessages(syncedMsgs);
                    }
                    const liveEl = typeof mockDom.findChatSurfaceInteractiveElement === 'function'
                        ? mockDom.findChatSurfaceInteractiveElement(matchOpts)
                        : null;
                    if (liveEl) {
                        matchedLive = true;
                        await mockDom.dispatchSurfaceClick(liveEl, 24, 24);
                        dispatchedCount += 1;
                    } else {
                        const el = mockDom.mountSurfaceActionElement(actionHtml, dataset, { msgIndex, chatId: resolvedCid });
                        try {
                            await mockDom.dispatchSurfaceClick(el, 24, 24);
                            dispatchedCount += 1;
                        } finally {
                            if (el && el._rsTempWrapper) el._rsTempWrapper.remove();
                            else if (el) el.remove();
                        }
                    }
                } catch (err) {
                    const msg = err && err.message ? err.message : String(err);
                    lastErrors.set(pName, msg);
                    pluginErrors.push(`${pName}: ${msg}`);
                    console.error(`[Plugin:${pName}] surface-action error:`, msg);
                }
            }
            if (dispatchedCount === 0 && pluginErrors.length > 0) {
                throw new Error(pluginErrors[0]);
            }

            if (dispatchedCount > 0) {
                await new Promise((r) => setTimeout(r, 40));
                const checkOverlays = () => {
                    for (const [pName, mockDom] of pluginDoms.entries()) {
                        if (!activeHosts.has(pName)) continue;
                        const afterHtml = extractOverlayBlocks(mockDom).join('\n');
                        if (afterHtml && afterHtml !== (beforeOverlayHtmlByPlugin.get(pName) || '')) {
                            return {
                                pluginName: pName,
                                displayName: getPluginDisplayName(pName),
                                styles: collectMockDomStyles(mockDom),
                                html: afterHtml,
                            };
                        }
                    }
                    return null;
                };
                openedOverlay = checkOverlays();
                for (let step = 0; step < 10 && !openedOverlay && !tracker.openedContainerPlugin && !tracker.dbMutated && !tracker.surfaceMutated; step += 1) {
                    await new Promise((r) => setTimeout(r, 35));
                    openedOverlay = checkOverlays();
                }
                if (tracker.dbMutated || tracker.surfaceMutated || openedOverlay) {
                    await new Promise((r) => setTimeout(r, 25));
                    const settledOverlay = checkOverlays();
                    if (settledOverlay) openedOverlay = settledOverlay;
                }
            }

            if (tracker.openedContainerPlugin) {
                openPluginGui = {
                    pluginName: tracker.openedContainerPlugin,
                    displayName: getPluginDisplayName(tracker.openedContainerPlugin),
                };
            }
            return {
                ok: true,
                dispatchedCount,
                matchedLive,
                dbMutated: tracker.dbMutated,
                surfaceMutated: tracker.surfaceMutated,
                openedOverlay,
                openPluginGui,
                pluginFloatingUi: getFloatingUiState(),
            };
        } finally {
            activeActionTracker = prevTracker;
        }
    }

    async function syncAndProjectChatSurface(baseSnap) {
        const empty = { footersByChatId: {}, footersByIndex: {}, bodyHtmlByChatId: {}, assetPathsByName: {}, styles: [] };
        if (!baseSnap || !Array.isArray(baseSnap.messages) || activeHosts.size === 0) {
            return empty;
        }
        const cIdx = Number(baseSnap.charIndex ?? 0);
        const chIdx = Number(baseSnap.chatIndex ?? 0);
        if (cIdx >= 0 && chIdx >= 0) {
            lastActiveLocation = { charIndex: cIdx, chatIndex: chIdx };
        }
        const charIdPart = String((baseSnap.charContext && baseSnap.charContext.charId) || baseSnap.charName || cIdx).replace(/[^a-zA-Z0-9_-]/g, '_');
        const baseChatUuid = String(baseSnap.chatUuid || baseSnap.chatId || `rs-chat-${charIdPart}-${Math.max(0, chIdx)}`);
        const msgsWithIds = baseSnap.messages.map((m) => {
            if (!m || m.isFirstMessage || Number(m.index) < 0) return m;
            return m.chatId ? m : { ...m, chatId: `rs-msg-${baseChatUuid}-${m.index}` };
        });
        const expectedCharIds = msgsWithIds
            .filter((m) => m && !m.isFirstMessage && Number(m.index) >= 0 && m.role !== 'user' && m.chatId && String(m.raw || m.text || m.html || '').trim())
            .map((m) => String(m.chatId));

        let hasObservers = false;
        for (const [pName, mockDom] of pluginDoms.entries()) {
            if (!activeHosts.has(pName) || !mockDom) continue;
            if (typeof mockDom.syncChatMessages === 'function') {
                mockDom.syncChatMessages(msgsWithIds);
            }
            if (typeof mockDom.getObserverCount === 'function' && mockDom.getObserverCount() > 0) {
                hasObservers = true;
            }
        }

        const collectAll = () => {
            const footersByChatId = Object.create(null);
            const footersByIndex = Object.create(null);
            const bodyHtmlByChatId = Object.create(null);
            const styles = [];
            const seenStyles = new Set();
            for (const [pName, mockDom] of pluginDoms.entries()) {
                if (!activeHosts.has(pName) || !mockDom || typeof mockDom.extractChatSurfaceProjections !== 'function') continue;
                const proj = mockDom.extractChatSurfaceProjections();
                Object.assign(footersByChatId, proj.footersByChatId);
                Object.assign(footersByIndex, proj.footersByIndex);
                Object.assign(bodyHtmlByChatId, proj.bodyHtmlByChatId);
                for (const s of collectMockDomStyles(mockDom)) {
                    if (s && !seenStyles.has(s)) {
                        seenStyles.add(s);
                        styles.push(s);
                    }
                }
            }
            return { footersByChatId, footersByIndex, bodyHtmlByChatId, styles };
        };

        let merged = collectAll();
        if (hasObservers && expectedCharIds.length > 0) {
            const allHaveFooters = () => expectedCharIds.every((cid) => Boolean(merged.footersByChatId[cid]));
            for (let attempt = 0; attempt < 6 && !allHaveFooters(); attempt += 1) {
                await new Promise((r) => setTimeout(r, 25));
                merged = collectAll();
            }
        }

        const assetPathsByName = Object.create(null);
        const cachedChar = fallbackCharCache.get(cIdx) || (turnCache.active && turnCache.charIndex === cIdx ? turnCache.charObj : null);
        if (cachedChar && Array.isArray(cachedChar.additionalAssets)) {
            for (const entry of cachedChar.additionalAssets) {
                if (Array.isArray(entry) && entry[0] && entry[1]) {
                    assetPathsByName[String(entry[0])] = String(entry[1]);
                } else if (entry && typeof entry === 'object' && entry.name && (entry.key || entry.path)) {
                    assetPathsByName[String(entry.name)] = String(entry.key || entry.path);
                }
            }
        }

        return {
            footersByChatId: merged.footersByChatId,
            footersByIndex: merged.footersByIndex,
            bodyHtmlByChatId: merged.bodyHtmlByChatId,
            assetPathsByName,
            styles: merged.styles || [],
        };
    }

    async function dispatchRootWidgetClick({
        pluginName,
        charIndex,
        chatIndex,
        selector = '',
        countNode = '',
        actionHtml = '',
        dataset = {},
        textContent = '',
        ariaLabel = '',
        title = '',
        className = '',
        siblingIndex = -1,
        eventType = 'click',
        value,
        checked,
        x = 24,
        y = 24,
    } = {}) {
        const pName = String(pluginName || '');
        const mockDom = pluginDoms.get(pName);
        if (!mockDom || !activeHosts.has(pName)) return { ok: false, dispatchedCount: 0, activeOverlay: null };
        const cIdx = Number(charIndex);
        const chIdx = Number(chatIndex);
        const needTempTurn = !turnCache.active && !Number.isNaN(cIdx) && !Number.isNaN(chIdx) && cIdx >= 0 && chIdx >= 0;
        if (needTempTurn) {
            await prepareTurn(cIdx, chIdx, getFallbackSnapshot());
        }
        const prevTracker = activeActionTracker;
        const tracker = { dbMutated: false, surfaceMutated: false, openedContainerPlugin: '' };
        activeActionTracker = tracker;
        const beforeOverlayHtml = extractOverlayBlocks(mockDom).join('\n');
        try {
            const matchOpts = { selector, countNode, actionHtml, dataset, textContent, ariaLabel, title, className, siblingIndex };
            const liveEl = typeof mockDom.findRootInteractiveElement === 'function'
                ? mockDom.findRootInteractiveElement(matchOpts)
                : null;
            if (liveEl) {
                if ((eventType === 'input' || eventType === 'change') && typeof mockDom.dispatchElementInput === 'function') {
                    await mockDom.dispatchElementInput(liveEl, { value, checked, eventType });
                } else {
                    await mockDom.dispatchSurfaceClick(liveEl, Number(x) || 24, Number(y) || 24);
                }
                await new Promise((r) => setTimeout(r, 35));
                const overlaySnap = getPluginOverlaySnapshot(pName);
                return {
                    ok: true,
                    dispatchedCount: 1,
                    matchedLive: true,
                    dbMutated: tracker.dbMutated,
                    surfaceMutated: tracker.surfaceMutated,
                    overlayChanged: Boolean(overlaySnap && overlaySnap.html !== beforeOverlayHtml),
                    activeOverlay: overlaySnap,
                };
            }
            const el = mockDom.mountSurfaceActionElement(actionHtml, dataset);
            try {
                await mockDom.dispatchSurfaceClick(el, Number(x) || 24, Number(y) || 24);
                await new Promise((r) => setTimeout(r, 25));
                const overlaySnap = getPluginOverlaySnapshot(pName);
                return {
                    ok: true,
                    dispatchedCount: 1,
                    matchedLive: false,
                    dbMutated: tracker.dbMutated,
                    surfaceMutated: tracker.surfaceMutated,
                    overlayChanged: Boolean(overlaySnap && overlaySnap.html !== beforeOverlayHtml),
                    activeOverlay: overlaySnap,
                };
            } finally {
                el.remove();
            }
        } finally {
            activeActionTracker = prevTracker;
            if (needTempTurn) endTurn();
        }
    }

    async function prepareFloatingPopupWidgets({ charIndex = -1, chatIndex = -1, autoExpand = true } = {}) {
        if (autoExpand) {
            for (const pName of activeHosts.keys()) {
                const mockDom = pluginDoms.get(pName);
                if (!mockDom) continue;
                const rootNode = mockDom.documentElement || mockDom.body;
                const sec = rootNode && typeof rootNode.querySelector === 'function'
                    ? rootNode.querySelector('.x-risu-am-generation-count')
                    : null;
                if (!sec) continue;
                const xExp = sec.getAttribute('x-am-expanded');
                const dExp = sec.getAttribute('data-am-expanded');
                if (xExp !== 'true' && dExp !== 'true') {
                    const toggleBtn = sec.querySelector('[data-am-runtime-generation-count-action="toggle"]');
                    if (toggleBtn) {
                        try {
                            await dispatchRootWidgetClick({
                                pluginName: pName,
                                charIndex,
                                chatIndex,
                                selector: '[data-am-runtime-generation-count-action="toggle"]',
                                countNode: toggleBtn.getAttribute('data-am-count-node') || '',
                            });
                        } catch (err) {
                            console.warn(`[Plugin:${pName}] floating-open prepare error:`, err && err.message ? err.message : String(err));
                        }
                    }
                }
            }
        }
        return getFloatingUiState({ includeIdleWidgets: true });
    }

    function getFloatingUiState({ includeIdleWidgets = false } = {}) {
        const buttons = [];
        const rootWidgets = [];
        for (const entry of getAllKnownEntries()) {
            const inst = activeHosts.get(entry.name);
            if (!inst) continue;
            const uiItems = Array.isArray(inst.record && inst.record.uiItems) ? inst.record.uiItems : [];
            const btnItems = uiItems.filter((u) => u && u.kind === 'button');
            const pickItems = btnItems.length ? btnItems : (uiItems.length ? [uiItems[0]] : []);
            const seenNames = new Set();
            for (const u of pickItems) {
                const dedupKey = `${u.iconType || 'none'}:${u.name || ''}:${u.icon || ''}`;
                if (seenNames.has(dedupKey) && btnItems.length > 1) continue;
                seenNames.add(dedupKey);
                buttons.push({
                    uid: `${entry.name}::${u.id}`,
                    pluginName: entry.name,
                    displayName: entry.displayName || entry.name,
                    entryId: u.id,
                    kind: u.kind || 'button',
                    location: u.location || 'action',
                    label: u.name || entry.displayName || entry.name,
                    icon: u.icon || '',
                    iconType: u.iconType || 'none',
                });
            }

            const mockDom = pluginDoms.get(entry.name);
            if (mockDom && (mockDom.body || mockDom.documentElement)) {
                const styles = collectMockDomStyles(mockDom);
                const blocks = [];
                const topNodes = [];
                const seenNodes = new Set();
                for (const ch of (mockDom.body ? mockDom.body.children : [])) {
                    if (ch && !seenNodes.has(ch)) { seenNodes.add(ch); topNodes.push(ch); }
                }
                for (const ch of (mockDom.documentElement ? mockDom.documentElement.children : [])) {
                    if (!ch || ch === mockDom.head || ch === mockDom.body || seenNodes.has(ch)) continue;
                    seenNodes.add(ch);
                    topNodes.push(ch);
                }
                for (const ch of topNodes) {
                    if (!ch || ch === mockDom.chatScreen || ch.tagName === 'STYLE' || ch.tagName === 'SCRIPT') continue;
                    if (isNodeVisiblyHidden(ch)) continue;
                    if (typeof ch.hasAttribute === 'function' && ch.hasAttribute('data-plugin-chat-panel')) continue;
                    if (typeof ch.hasAttribute === 'function' && ch.hasAttribute('data-am-floating-viewport')) {
                        const subBlocks = [];
                        for (const sub of ch.children || []) {
                            if (!sub || sub.tagName === 'STYLE' || sub.tagName === 'SCRIPT' || isNodeVisiblyHidden(sub)) continue;
                            if (!hasVisibleContent(sub)) continue;
                            subBlocks.push(sub.outerHTML);
                        }
                        if (subBlocks.length) blocks.push(...subBlocks);
                        continue;
                    }
                    const countReg = typeof ch.querySelector === 'function' ? ch.querySelector('[data-am-count-region]') : null;
                    if (!includeIdleWidgets && countReg && countReg.getAttribute('x-am-count-visible') === 'false') {
                        const toastReg = typeof ch.querySelector === 'function' ? ch.querySelector('[data-am-toast-region]') : null;
                        if (!toastReg || !(toastReg.innerHTML || '').trim()) continue;
                    }
                    if (!hasVisibleContent(ch)) continue;
                    blocks.push(ch.outerHTML);
                }
                if (blocks.length) {
                    recordPluginModalCatalog(entry.name, mockDom);
                    rootWidgets.push({
                        pluginName: entry.name,
                        displayName: entry.displayName || entry.name,
                        styles,
                        html: blocks.join('\n'),
                        modals: getKnownModalsList(entry.name),
                    });
                }
            }
        }
        const modalsByPlugin = Object.create(null);
        for (const pName of activeHosts.keys()) {
            const list = getKnownModalsList(pName);
            if (list.length) modalsByPlugin[pName] = list;
        }
        const sig = crypto
            .createHash('sha1')
            .update(JSON.stringify({ buttons, rootWidgets, modalsByPlugin }))
            .digest('hex')
            .slice(0, 12);
        return { rev: sig, buttons, rootWidgets, modalsByPlugin };
    }

    async function dispatchChatOutput({ charIndex, chatIndex, messageIndex }) {
        const list = [...hookState.chatOutput];
        if (!list.length) return;
        const capturedRunId = turnCache.active ? turnCache.turnRunId : 0;
        pendingChatOutputs += 1;
        const work = (async () => {
            const charSnap = await dbGetCharacterFromIndex(charIndex);
            const chatSnap = await dbGetChatFromIndex(charIndex, chatIndex);
            await Promise.all(list.map(async (h) => {
                const startedAt = Date.now();
                let errMsg = '';
                try {
                    await h.fn({
                        char: cloneJson(charSnap),
                        chat: cloneJson(chatSnap),
                        characterIndex: Number(charIndex),
                        chatIndex: Number(chatIndex),
                        messageIndex: Number(messageIndex),
                    });
                } catch (e) {
                    errMsg = e && e.message ? e.message : String(e);
                    console.warn(`[Plugin:${h.pluginName}] chatOutput error:`, errMsg);
                } finally {
                    const rec = ensureRuntimeLedger(h.pluginName);
                    const now = Date.now();
                    rec.outputRuns += 1;
                    rec.lastOutputAt = now;
                    rec.lastOutput = {
                        at: now,
                        durationMs: Math.max(0, now - startedAt),
                        charIndex: Number(charIndex),
                        chatIndex: Number(chatIndex),
                        messageIndex: Number(messageIndex),
                        error: errMsg,
                    };
                }
            }));
        })().finally(() => {
            pendingChatOutputs = Math.max(0, pendingChatOutputs - 1);
            scheduleSaveLedger();
            if (pendingChatOutputs === 0 && turnCache.active && turnCache.deferredEnd && turnCache.turnRunId === capturedRunId) {
                endTurn({ force: true });
                invalidateReadCache();
            }
        });
        await Promise.race([work, new Promise((r) => setTimeout(r, 5000))]);
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

        if (String(method || '').startsWith('webStorage.')) {
            const op = String(method).slice(11);
            const scope = String(a[0] || 'local');
            const targetMap = scope === 'session' ? webSessionStore : webLocalStore;
            const storeKind = scope === 'session' ? 'webSessionStorage' : 'webLocalStorage';
            if (op === 'getAll') {
                return Object.fromEntries(targetMap.entries());
            }
            if (op === 'setItem') {
                const key = String(a[1] ?? '');
                targetMap.set(key, String(a[2] ?? ''));
                recordStorageEvent(pluginName, { op: 'write', storeKind, key, ok: true });
                if (scope !== 'session') scheduleSaveStorage();
                return true;
            }
            if (op === 'removeItem') {
                const key = String(a[1] ?? '');
                targetMap.delete(key);
                recordStorageEvent(pluginName, { op: 'write', storeKind, key, ok: true });
                if (scope !== 'session') scheduleSaveStorage();
                return true;
            }
            if (op === 'clear') {
                targetMap.clear();
                recordStorageEvent(pluginName, { op: 'write', storeKind, key: '*', ok: true });
                if (scope !== 'session') scheduleSaveStorage();
                return true;
            }
            return null;
        }

        const storageMatch = String(method || '').match(/^(pluginStorage|safeLocalStorage|localPluginStorage)\.(.+)$/);
        if (storageMatch) {
            const [, kind, op] = storageMatch;
            if (op === 'getItem') return await storeGet(kind, a[0], pluginName);
            if (op === 'setItem') return await storeSet(kind, a[0], a[1], pluginName);
            if (op === 'removeItem') return await storeRemove(kind, a[0], pluginName);
            if (op === 'clear') return await storeClear(kind, pluginName);
            if (op === 'keys') return await storeKeys(kind, pluginName);
            if (op === 'key') {
                const ks = await storeKeys(kind, pluginName);
                return ks[Number(a[0])] ?? null;
            }
            if (op === 'length') return (await storeKeys(kind, pluginName)).length;
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
        if (method === 'db.setChatActive') {
            const idx = await dbGetCurrentIndices();
            return dbSetChatToIndex(idx.charIndex, idx.chatIndex, a[0]);
        }
        if (method === 'db.getChat') return dbGetChatFromIndex(a[0], a[1]);
        if (method === 'db.setChat') return dbSetChatToIndex(a[0], a[1], a[2]);
        if (method === 'db.getDatabase') return dbGetDatabase(a[0]);
        if (method === 'db.setDatabaseLite') return dbSetDatabase('db.setDatabaseLite', a[0]);
        if (method === 'db.setDatabase') return dbSetDatabase('db.setDatabase', a[0]);
        if (method === 'db.reloadPcPlugins') {
            const target = (a && a[0]) ? String(a[0]) : pluginName;
            if (isRpcConnected()) {
                await hostRpc.invoke('db.reloadPcPlugins', [], 8000).catch(() => {});
            }
            setTimeout(() => {
                reloadPlugins(target).catch(() => {});
            }, 25);
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
            return pollGuiIpc(pluginName, Number(a[0]) || 0, Boolean(a[1]));
        }

        throw new Error(`Unsupported GUI RPC method: ${method}`);
    }

    function isMutatingGuiRpcMethod(method) {
        return /(?:^|\.)(?:set|remove|clear|save|create|reload|post|update|write)/i.test(String(method || ''));
    }

    async function handleGuiRpcBatch({ pluginName, calls = [] }) {
        if (!Array.isArray(calls) || !calls.length) return [];
        const slice = calls.slice(0, 64);
        const hasMutation = slice.some((c) => isMutatingGuiRpcMethod(c && c.method));
        const results = new Array(slice.length);

        if (!hasMutation && isRpcConnected()) {
            // Coalesce >= 2 uncached *.getItem calls per store kind into one *.getMany host RPC.
            const uncachedByKind = { pluginStorage: new Set(), localPluginStorage: new Set(), safeLocalStorage: new Set() };
            for (const c of slice) {
                const m = String((c && c.method) || '');
                const match = m.match(/^(pluginStorage|localPluginStorage|safeLocalStorage)\.getItem$/);
                if (!match) continue;
                const kind = match[1];
                const k = String((Array.isArray(c.args) ? c.args[0] : '') ?? '');
                if (kind === 'pluginStorage' && turnCache.active && turnCache.pluginStoreCache.has(k)) continue;
                if (getFreshReadCache(`store:${kind}:${k}`) !== undefined) continue;
                uncachedByKind[kind].add(k);
            }
            await Promise.all(Object.entries(uncachedByKind).map(async ([kind, keySet]) => {
                if (keySet.size < 2) return;
                const keysArr = [...keySet];
                try {
                    const map = await hostRpc.invoke(`${kind}.getMany`, [keysArr], 15000);
                    if (map && typeof map === 'object') {
                        for (const k of keysArr) {
                            const val = map[k] === undefined ? null : map[k];
                            putReadCache(`store:${kind}:${k}`, val);
                            if (turnCache.active && kind === 'pluginStorage') {
                                turnCache.pluginStoreCache.set(k, val === null ? null : cloneJson(val));
                            }
                        }
                    }
                } catch (_) {
                    // Older PC plugin without *.getMany falls back cleanly to per-key getItem calls below.
                }
            }));
        }

        const runOne = async (idx) => {
            const c = slice[idx] || {};
            try {
                const value = await handleGuiRpc({
                    pluginName: c.pluginName || pluginName,
                    method: c.method,
                    args: Array.isArray(c.args) ? c.args : [],
                });
                results[idx] = { reqId: c.reqId || '', ok: true, value };
            } catch (err) {
                results[idx] = { reqId: c.reqId || '', ok: false, error: err && err.message ? err.message : String(err) };
            }
        };

        if (hasMutation || slice.length <= 1) {
            for (let i = 0; i < slice.length; i += 1) {
                await runOne(i);
            }
        } else {
            const workerCount = Math.min(8, slice.length);
            let nextIdx = 0;
            await Promise.all(Array.from({ length: workerCount }, async () => {
                while (true) {
                    const i = nextIdx++;
                    if (i >= slice.length) break;
                    await runOne(i);
                }
            }));
        }
        return results;
    }

    function formatRuntimeLedgerEntry(rec, targetChatUuid = '') {
        if (!rec) return null;
        const history = [...rec.history].reverse().map((item) => {
            const copy = cloneJson(item);
            const blocks = Array.isArray(copy.injectedBlocks) ? copy.injectedBlocks : [];
            if (blocks.length > 0) {
                copy.injectedCount = blocks.length;
                copy.totalInjectedChars = blocks.reduce((acc, b) => acc + (Number(b && b.addedChars) || String((b && b.text) || '').length), 0);
            }
            copy.matchesCurrentChat = Boolean(targetChatUuid && copy.chatUuid && copy.chatUuid === targetChatUuid);
            return copy;
        });
        return {
            pluginName: rec.pluginName,
            displayName: getPluginDisplayName(rec.pluginName),
            beforeRequestRuns: rec.beforeRequestRuns || 0,
            bodyIntercepterRuns: rec.bodyIntercepterRuns || 0,
            afterRequestRuns: rec.afterRequestRuns || 0,
            outputRuns: rec.outputRuns || 0,
            storageReads: rec.storageReads || 0,
            storageWrites: rec.storageWrites || 0,
            storageErrors: rec.storageErrors || 0,
            lastBeforeRequestAt: rec.lastBeforeRequestAt || 0,
            lastBodyIntercepterAt: rec.lastBodyIntercepterAt || 0,
            lastAfterRequestAt: rec.lastAfterRequestAt || 0,
            lastOutputAt: rec.lastOutputAt || 0,
            lastStorageWriteAt: rec.lastStorageWriteAt || 0,
            lastStorageError: rec.lastStorageError || '',
            recentStorageKeys: Array.isArray(rec.recentStorageKeys) ? [...rec.recentStorageKeys] : [],
            pendingDirtyCount: dirtyStoreOps.size,
            lastAfterRequest: rec.lastAfterRequest ? cloneJson(rec.lastAfterRequest) : null,
            lastOutput: rec.lastOutput ? cloneJson(rec.lastOutput) : null,
            recommendedIndex: pickPrimaryRecallIndex(history),
            history,
        };
    }

    function getPluginRuntimeRecall(pluginName = '', { chatUuid = '' } = {}) {
        const target = String(pluginName || '').trim();
        const targetChatUuid = String(chatUuid || '').trim();
        if (target) {
            const rec = pluginRuntimeLedger.get(target) || {
                pluginName: target,
                beforeRequestRuns: 0,
                bodyIntercepterRuns: 0,
                afterRequestRuns: 0,
                outputRuns: 0,
                storageReads: 0,
                storageWrites: 0,
                storageErrors: 0,
                lastBeforeRequestAt: 0,
                lastBodyIntercepterAt: 0,
                lastAfterRequestAt: 0,
                lastOutputAt: 0,
                lastStorageWriteAt: 0,
                lastStorageError: '',
                recentStorageKeys: [],
                lastAfterRequest: null,
                lastOutput: null,
                history: [],
            };
            return formatRuntimeLedgerEntry(rec, targetChatUuid);
        }
        const names = new Set();
        for (const entry of getAllKnownEntries()) {
            if (entry && entry.name && isPluginEnabled(entry.name)) names.add(entry.name);
        }
        for (const k of pluginRuntimeLedger.keys()) names.add(k);
        const list = [];
        for (const name of names) {
            const rec = pluginRuntimeLedger.get(name);
            const revHist = rec && Array.isArray(rec.history)
                ? [...rec.history].reverse().map((item) => ({
                    ...item,
                    matchesCurrentChat: Boolean(targetChatUuid && item.chatUuid && item.chatUuid === targetChatUuid),
                }))
                : [];
            const pickIdx = pickPrimaryRecallIndex(revHist);
            const primary = pickIdx >= 0 ? revHist[pickIdx] : null;
            const primaryBlocks = primary && Array.isArray(primary.injectedBlocks) ? primary.injectedBlocks : [];
            const primaryCount = primaryBlocks.length > 0 ? primaryBlocks.length : (primary ? (Number(primary.injectedCount) || 0) : 0);
            const primaryChars = primaryBlocks.length > 0
                ? primaryBlocks.reduce((acc, b) => acc + (Number(b && b.addedChars) || String((b && b.text) || '').length), 0)
                : (primary ? (Number(primary.totalInjectedChars) || 0) : 0);
            list.push({
                pluginName: name,
                displayName: getPluginDisplayName(name),
                beforeRequestRuns: rec ? (rec.beforeRequestRuns || 0) : 0,
                bodyIntercepterRuns: rec ? (rec.bodyIntercepterRuns || 0) : 0,
                afterRequestRuns: rec ? (rec.afterRequestRuns || 0) : 0,
                outputRuns: rec ? (rec.outputRuns || 0) : 0,
                storageReads: rec ? (rec.storageReads || 0) : 0,
                storageWrites: rec ? (rec.storageWrites || 0) : 0,
                storageErrors: rec ? (rec.storageErrors || 0) : 0,
                lastBeforeRequestAt: rec ? (rec.lastBeforeRequestAt || 0) : 0,
                lastBodyIntercepterAt: rec ? (rec.lastBodyIntercepterAt || 0) : 0,
                lastAfterRequestAt: rec ? (rec.lastAfterRequestAt || 0) : 0,
                lastOutputAt: rec ? (rec.lastOutputAt || 0) : 0,
                lastStorageWriteAt: rec ? (rec.lastStorageWriteAt || 0) : 0,
                lastStorageError: rec ? (rec.lastStorageError || '') : '',
                recentStorageKeys: rec && Array.isArray(rec.recentStorageKeys) ? [...rec.recentStorageKeys] : [],
                latestInjectedCount: primaryCount,
                latestInjectedChars: primaryChars,
                latestChatUuid: primary ? (primary.chatUuid || '') : '',
                matchesCurrentChat: Boolean(primary && primary.matchesCurrentChat),
            });
        }
        return list;
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
            srcdoc: buildPluginGuiSrcdoc({
                plugin: pluginWithUi,
                entryId,
                theme,
                webLocalSnapshot: Object.fromEntries(webLocalStore.entries()),
                webSessionSnapshot: Object.fromEntries(webSessionStore.entries()),
            }),
        };
    }

    async function dispose() {
        saveStorageToDiskNow();
        saveLedgerToDiskNow();
        for (const name of [...activeHosts.keys()]) {
            await unloadPlugin(name);
        }
        pluginChannels.clear();
        providers.clear();
        pluginDoms.clear();
        chatPanels.clear();
        pluginRuntimeLedger.clear();
        guiIpcOutbox.length = 0;
        for (const k of Object.keys(hookState)) hookState[k].length = 0;
    }

    return {
        listPlugins,
        syncPcPlugins,
        reloadPlugins,
        addCustomPlugin,
        removePlugin,
        togglePlugin,
        updatePluginArgs,
        reconcileEnabledPlugins,
        hasEnabledPlugins,
        hasActiveSurfacePlugins: () => activeHosts.size > 0,
        getRegisteredProviders: () => providers,
        getTurnContext,
        setTurnObjects,
        dispatchSurfaceAction,
        syncAndProjectChatSurface,
        dispatchRootWidgetClick,
        prepareFloatingPopupWidgets,
        getFloatingUiState,
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
        handleGuiRpcBatch,
        flushDirtyStoreOps,
        invalidateReadCache,
        getPluginRuntimeRecall,
        getGuiSrcdoc,
        dispose,
        _debug: { hookState, providers, pluginDoms, pluginRuntimeLedger, fallbackPluginStore, fallbackSafeLocal, fallbackLocalPlugin, webLocalStore, webSessionStore, dirtyStoreOps, fallbackAssetStore, fallbackInlayStore, getAllKnownEntries },
    };
}

module.exports = {
    URL_BLACKLIST,
    parsePluginHeader,
    diffPluginPromptInjection,
    pickPreferredPluginGuiEntry,
    createSyncWebStorage,
    buildPluginGuiSrcdoc,
    createPluginAdapter,
};
