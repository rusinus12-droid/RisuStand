#!/usr/bin/env node
/**
 * RisuStand Remote Relay Server v1.2.0
 * Zero-dependency Node.js (v18+) server:
 *  1) PC RisuAI Plugin Bridge Relay (Bots, Chats, Modules, Personas, Params)
 *  2) OpenAI-Compatible Local LLM Proxy Router (/v1/chat/completions)
 *     -> Supports OpenAI-Compatible, Anthropic Claude, Google Gemini + Prompt Override
 *  3) Built-in Translator Engine (Auto/On-demand Output & Korean->English Input)
 *  4) Mobile-first Pocket Web UI (Gemini / Claude / ChatGPT / EPUB Day & Night)
 *
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Required Notice: Copyright (c) 2026 rusinus12
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { parsePluginHeader, buildPluginGuiSrcdoc, createPluginAdapter } = require('./risustand-plugin-adapter.cjs');
const { defaultImageGenConfig, normalizeImageGenConfig, sanitizeImageGenForClient, createImageProvider } = require('./risustand-image-provider.cjs');
const {
    TTS_PROVIDER_DEFAULTS,
    TTS_ENDPOINT_PRESETS,
    TTS_VOICE_GROUPS,
    TTS_BUILTIN_VOICE_REFERENCES,
    TTS_TONE_TAG_PRESETS,
    normalizeVoiceGroup,
    normalizeVoiceProfiles,
    inferTtsVoiceGroup,
    normalizeTtsEndpointUrl,
    defaultTtsConfig,
    normalizeTtsConfig,
    sanitizeTtsForClient,
    analyzeTtsSegments,
    resolveSegmentVoice,
    listTtsModels,
    scanLocalTtsServers,
    createTtsProvider,
} = require('./risustand-tts-provider.cjs');
const { createModuleAdapter } = require('./risustand-module-adapter.cjs');

// Kept in sync with VERSION by tools/release_version.cjs
const RELAY_VERSION = '1.2.0';
// Brand mark (source: docs/brand/*.svg). Full-color tile for favicon, mono glyph (currentColor) for in-app UI.
const RS_LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="RisuStand"><defs><linearGradient id="rs-tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a86b38"/><stop offset="1" stop-color="#6a3c1a"/></linearGradient><linearGradient id="rs-page" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fffaf0"/><stop offset="1" stop-color="#f3e3c6"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#rs-tile)"/><g transform="translate(0 -2.5)"><g fill="none" stroke="#f6c66e" stroke-width="3" stroke-linecap="round"><path d="M27.76 20.26 A6 6 0 0 1 36.24 20.26"/><path d="M24.22 16.72 A11 11 0 0 1 39.78 16.72" opacity="0.7"/></g><path d="M32 27C25.5 23 18.5 22.4 13 23.2V41C18.5 40.4 25.5 41.2 32 45Z" fill="url(#rs-page)"/><path d="M32 27C38.5 23 45.5 22.4 51 23.2V41C45.5 40.4 38.5 41.2 32 45Z" fill="url(#rs-page)"/><path d="M32 27V45" stroke="#c99a63" stroke-width="1.4"/><g fill="none" stroke="#fffaf0" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 43.5L32 49L53.5 43.5"/><path d="M32 49V54"/><path d="M25 54H39"/></g></g></svg>';
const RS_MARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false" fill="currentColor"><g transform="translate(0 -2.5)"><g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M27.76 20.26 A6 6 0 0 1 36.24 20.26"/><path d="M24.22 16.72 A11 11 0 0 1 39.78 16.72" opacity="0.6"/></g><path d="M30.8 26.3C24.6 22.8 18.2 22.3 13 23.2V41C18.5 40.4 24.9 41.1 30.8 44.3Z"/><path d="M33.2 26.3C39.4 22.8 45.8 22.3 51 23.2V41C45.5 40.4 39.1 41.1 33.2 44.3Z"/><g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 43.5L32 49L53.5 43.5"/><path d="M32 49V54"/><path d="M25 54H39"/></g></g></svg>';
const ROOT_DIR = __dirname;
const TOKEN_PATH = path.join(ROOT_DIR, '.risustand-token');
const CONFIG_PATH = path.join(ROOT_DIR, '.risustand-config.json');
const PRESETS_PATH = path.join(ROOT_DIR, '.risustand-presets.json');
const PLUGINS_PATH = path.join(ROOT_DIR, '.risustand-plugins.json');
const THUMBS_DIR = process.env.RISUSTAND_THUMBS_DIR || path.join(ROOT_DIR, '.risustand-thumbs');
let configPersistDisabled = false;

function loadSavedPort(rootDir = ROOT_DIR) {
    try {
        const portPath = path.join(rootDir, '.risustand-port');
        if (!fs.existsSync(portPath)) return 8787;
        const raw = fs.readFileSync(portPath, 'utf8').trim();
        if (/^\d+$/.test(raw)) {
            const n = Number(raw);
            if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
        }
    } catch (_) {}
    return 8787;
}

const PORT = Number(process.env.PORT || loadSavedPort(ROOT_DIR));
const HOST = process.env.HOST || '0.0.0.0';

function loadOrCreateToken(rootDir = ROOT_DIR) {
    const envToken = (process.env.RISU_REMOTE_TOKEN || '').trim();
    if (envToken) return envToken;
    const tokenPath = path.join(rootDir, '.risustand-token');
    try {
        if (fs.existsSync(tokenPath)) {
            const fileToken = fs.readFileSync(tokenPath, 'utf8').trim();
            if (fileToken) return fileToken;
        }
    } catch (_) {}
    const generated = crypto.randomBytes(16).toString('hex');
    try {
        fs.writeFileSync(tokenPath, `${generated}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (_) {
        try {
            const existing = fs.readFileSync(tokenPath, 'utf8').trim();
            if (existing) return existing;
        } catch (_) {}
    }
    return generated;
}

let TOKEN = (process.env.RISU_REMOTE_TOKEN || '').trim();

// ================= Persistent Config =================
function defaultConfig() {
    return {
        activeProfileId: '',
        auxProfileId: 'inherit',
        directPresetId: 'bundled:leave',
        directHistoryMode: 'chunked',
        directPipelineMode: 'single',
        remoteToggleValues: {},
        disabledLoreEntries: {},
        enabledModuleLoreEntries: {},
        pinnedLoreEntries: {},
        presetToggles: [],
        backendPlugins: {},
        remoteDirectOnly: true,
        botThumbs: {},
        imageGen: defaultImageGenConfig(),
        tts: defaultTtsConfig(),
        profiles: [
            {
                id: 'preset-openrouter',
                name: 'OpenRouter (예시)',
                providerType: 'openai_compat',
                baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
                apiKey: '',
                model: 'anthropic/claude-3.7-sonnet',
                temperature: '',
                maxTokens: '',
                overrideMode: 'off',
                systemOverride: '',
            },
            {
                id: 'preset-gemini',
                name: 'Google Gemini (예시)',
                providerType: 'gemini',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
                apiKey: '',
                model: 'gemini-2.5-pro',
                temperature: '',
                maxTokens: '',
                overrideMode: 'off',
                systemOverride: '',
            },
            {
                id: 'preset-claude',
                name: 'Anthropic Claude (예시)',
                providerType: 'anthropic',
                baseUrl: 'https://api.anthropic.com/v1/messages',
                apiKey: '',
                model: 'claude-sonnet-4-20250514',
                temperature: '',
                maxTokens: '4096',
                overrideMode: 'off',
                systemOverride: '',
            },
        ],
        translator: {
            enabled: false,
            useActiveProfile: true,
            autoTranslateOutput: false,
            autoTranslateInput: false,
            targetLang: 'Korean',
            providerType: 'gemini',
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
            apiKey: '',
            model: 'gemini-2.5-flash',
            prompt: 'Translate the following roleplay/novel text naturally into Korean. Preserve tone, nuance, and formatting. Output ONLY the translated text without explanations.',
            inputPrompt: 'Translate the following Korean user roleplay input naturally into English. Output ONLY the translated English text.',
        },
    };
}

function normalizeBotThumbs(src) {
    const out = {};
    if (!src || typeof src !== 'object' || Array.isArray(src)) return out;
    const fileRx = /^[a-f0-9]{24}\.(png|jpg|webp|gif)$/;
    for (const [k, v] of Object.entries(src)) {
        if (!k || k.length > 200 || !v || typeof v !== 'object' || Array.isArray(v)) continue;
        const updatedAt = (typeof v.updatedAt === 'number' && Number.isFinite(v.updatedAt)) ? v.updatedAt : Date.now();
        if (v.source === 'asset' && typeof v.path === 'string' && v.path && v.path.length <= 500) {
            out[k] = { source: 'asset', path: v.path, updatedAt };
        } else if (v.source === 'custom' && typeof v.file === 'string' && fileRx.test(v.file)) {
            out[k] = { source: 'custom', file: v.file, updatedAt };
        }
    }
    return out;
}

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            const def = defaultConfig();
            const remoteToggleValues = {};
            if (raw.remoteToggleValues && typeof raw.remoteToggleValues === 'object' && !Array.isArray(raw.remoteToggleValues)) {
                for (const [k, v] of Object.entries(raw.remoteToggleValues)) {
                    if (k) remoteToggleValues[String(k)] = String(v ?? '');
                }
            }
            const normalizeStrArrayMap = (src) => {
                const out = {};
                if (src && typeof src === 'object' && !Array.isArray(src)) {
                    for (const [k, v] of Object.entries(src)) {
                        if (k && Array.isArray(v)) out[String(k)] = v.map((x) => String(x || '')).filter(Boolean);
                    }
                }
                return out;
            };
            return {
                activeProfileId: typeof raw.activeProfileId === 'string' ? raw.activeProfileId : def.activeProfileId,
                auxProfileId: typeof raw.auxProfileId === 'string' && raw.auxProfileId ? raw.auxProfileId : 'inherit',
                directPresetId: typeof raw.directPresetId === 'string' ? raw.directPresetId : def.directPresetId,
                directHistoryMode: ['chunked', 'full', 'sliding_30'].includes(raw.directHistoryMode) ? raw.directHistoryMode : 'chunked',
                directPipelineMode: ['single', 'two_pass'].includes(raw.directPipelineMode) ? raw.directPipelineMode : 'single',
                remoteToggleValues,
                disabledLoreEntries: normalizeStrArrayMap(raw.disabledLoreEntries),
                enabledModuleLoreEntries: normalizeStrArrayMap(raw.enabledModuleLoreEntries),
                pinnedLoreEntries: normalizeStrArrayMap(raw.pinnedLoreEntries),
                profiles: Array.isArray(raw.profiles) ? raw.profiles : def.profiles,
                presetToggles: Array.isArray(raw.presetToggles) ? raw.presetToggles : [],
                backendPlugins: (raw.backendPlugins && typeof raw.backendPlugins === 'object' && !Array.isArray(raw.backendPlugins)) ? raw.backendPlugins : {},
                remoteDirectOnly: raw.remoteDirectOnly !== undefined ? Boolean(raw.remoteDirectOnly) : true,
                botThumbs: normalizeBotThumbs(raw.botThumbs),
                imageGen: normalizeImageGenConfig(raw.imageGen),
                tts: normalizeTtsConfig(raw.tts),
                translator: { ...def.translator, ...(raw.translator || {}) },
            };
        }
    } catch (e) {
        console.warn('[Config] 설정 로드 실패, 기본값 사용:', e.message);
    }
    return defaultConfig();
}

function saveConfig() {
    if (configPersistDisabled) return;
    const tmp = `${CONFIG_PATH}.rs-tmp-${crypto.randomBytes(6).toString('hex')}`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, CONFIG_PATH);
    } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch (_) {}
        console.warn('[Config] 설정 저장 실패:', e.message);
    }
}

let config = loadConfig();

// Byte substitution table matching RisuAI's .risup / rpack container format
const RISUP_RPACK_MAP_BASE64 = 'xA0eC70rP1X8RW71ZlNPGuC7MJSGumu/QVBvm+/etxBhFyDfMomonW2ryZAADF2v0sFW5RZkkYJldJfKI9ZS0f+0oOgvilg4WmAZlknb18g7PkNLpWNHqmopkvQVz2I0eNMdPOIFjipXDhvNTC3yQCwleUgPsnq1p2w35px7VH7+h9yaAuQzouuxLgPdmaaw59WIGIN89r7hXJ/DIUYfCE7QdhJf7v2PROqjXosoCTWeacwKx4UHrUrzd+ln1NqEgJO2TXP6JyZ/BMb78XI5UcI2qWis+O3FucvOdaQ9gdlCcByVEbzYjJj5WaET9xR9s+xxwOON8AGuWzEGJCI6uCz3hIvJZfu2n66zAy0BaXQf5KPs7lw0IZNKD2riYgKeIpz9PPxxx8atWWcFcG2KRBL6JIZfr9F6R87+UGPdUQZvGOBSqAmdVnNMuFNsw6AOGc8+DX4HMmhG6kj5mS6rpEkgXlU1OAy807FYFnkoChrh8s3EOduiumBydn2V73/IwN43lL+1FIGSJUWs5/Vmpys2WsET40s66I2DG3wnsJpC64eq3FSOeCbSVynUt/gvj4l18EF3wh7/2BUR5QSXF/Mx0JsA18q0Tyo72bJr2l2hPzBhvZE9Tubfvk2CjB0jEJhk9IUze5BDu6mI8dalHPbMbrlbC5bt1enFywimgEA=';
const RISUP_MAP_BYTES = Uint8Array.from(Buffer.from(RISUP_RPACK_MAP_BASE64, 'base64'));
const RISUP_ENCODE_MAP = RISUP_MAP_BYTES.subarray(0, 256);
const RISUP_DECODE_MAP = RISUP_MAP_BYTES.subarray(256, 512);

function msgpackEncode(val) {
    const chunks = [];
    const writeUInt8 = (v) => chunks.push(Buffer.from([v & 0xff]));
    const writeInt = (v) => {
        if (v >= 0 && v <= 0x7f) return writeUInt8(v);
        if (v < 0 && v >= -32) return writeUInt8(v & 0xff);
        if (v >= 0 && v <= 0xff) return chunks.push(Buffer.from([0xcc, v]));
        if (v >= 0 && v <= 0xffff) {
            const b = Buffer.allocUnsafe(3);
            b[0] = 0xcd; b.writeUInt16BE(v, 1);
            return chunks.push(b);
        }
        if (v >= 0 && v <= 0xffffffff) {
            const b = Buffer.allocUnsafe(5);
            b[0] = 0xce; b.writeUInt32BE(v, 1);
            return chunks.push(b);
        }
        if (v >= -128 && v <= 127) {
            const b = Buffer.allocUnsafe(2);
            b[0] = 0xd0; b.writeInt8(v, 1);
            return chunks.push(b);
        }
        if (v >= -32768 && v <= 32767) {
            const b = Buffer.allocUnsafe(3);
            b[0] = 0xd1; b.writeInt16BE(v, 1);
            return chunks.push(b);
        }
        if (v >= -2147483648 && v <= 2147483647) {
            const b = Buffer.allocUnsafe(5);
            b[0] = 0xd2; b.writeInt32BE(v, 1);
            return chunks.push(b);
        }
        const b = Buffer.allocUnsafe(9);
        b[0] = 0xcb; b.writeDoubleBE(v, 1);
        return chunks.push(b);
    };
    const writeStr = (s) => {
        const strBuf = Buffer.from(String(s), 'utf8');
        const len = strBuf.length;
        if (len <= 31) writeUInt8(0xa0 | len);
        else if (len <= 0xff) chunks.push(Buffer.from([0xd9, len]));
        else if (len <= 0xffff) {
            const b = Buffer.allocUnsafe(3);
            b[0] = 0xda; b.writeUInt16BE(len, 1);
            chunks.push(b);
        } else {
            const b = Buffer.allocUnsafe(5);
            b[0] = 0xdb; b.writeUInt32BE(len, 1);
            chunks.push(b);
        }
        chunks.push(strBuf);
    };
    const writeBin = (buf) => {
        const len = buf.length;
        if (len <= 0xff) chunks.push(Buffer.from([0xc4, len]));
        else if (len <= 0xffff) {
            const b = Buffer.allocUnsafe(3);
            b[0] = 0xc5; b.writeUInt16BE(len, 1);
            chunks.push(b);
        } else {
            const b = Buffer.allocUnsafe(5);
            b[0] = 0xc6; b.writeUInt32BE(len, 1);
            chunks.push(b);
        }
        chunks.push(buf);
    };
    function write(v) {
        if (v === null || v === undefined) return writeUInt8(0xc0);
        if (v === false) return writeUInt8(0xc2);
        if (v === true) return writeUInt8(0xc3);
        if (typeof v === 'number') {
            if (!Number.isFinite(v)) return writeUInt8(0xc0);
            if (Number.isInteger(v)) return writeInt(v);
            const b = Buffer.allocUnsafe(9);
            b[0] = 0xcb; b.writeDoubleBE(v, 1);
            return chunks.push(b);
        }
        if (typeof v === 'string') return writeStr(v);
        if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
            return writeBin(Buffer.isBuffer(v) ? v : Buffer.from(v));
        }
        if (Array.isArray(v)) {
            const len = v.length;
            if (len <= 15) writeUInt8(0x90 | len);
            else if (len <= 0xffff) {
                const b = Buffer.allocUnsafe(3);
                b[0] = 0xdc; b.writeUInt16BE(len, 1);
                chunks.push(b);
            } else {
                const b = Buffer.allocUnsafe(5);
                b[0] = 0xdd; b.writeUInt32BE(len, 1);
                chunks.push(b);
            }
            for (let i = 0; i < len; i += 1) write(v[i]);
            return;
        }
        if (typeof v === 'object') {
            const keys = Object.keys(v).filter((k) => v[k] !== undefined);
            const len = keys.length;
            if (len <= 15) writeUInt8(0x80 | len);
            else if (len <= 0xffff) {
                const b = Buffer.allocUnsafe(3);
                b[0] = 0xde; b.writeUInt16BE(len, 1);
                chunks.push(b);
            } else {
                const b = Buffer.allocUnsafe(5);
                b[0] = 0xdf; b.writeUInt32BE(len, 1);
                chunks.push(b);
            }
            for (const k of keys) {
                writeStr(k);
                write(v[k]);
            }
            return;
        }
        writeStr(String(v));
    }
    write(val);
    return Buffer.concat(chunks);
}

function encodeRisupPreset(presetObj) {
    if (!presetObj || typeof presetObj !== 'object') throw new Error('Invalid preset object for .risup encoding');
    const inner = msgpackEncode(presetObj);
    const aesKey = crypto.createHash('sha256').update('risupreset').digest();
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, Buffer.alloc(12));
    const encBuf = Buffer.concat([cipher.update(inner), cipher.final(), cipher.getAuthTag()]);
    const outer = msgpackEncode({ presetVersion: 2, type: 'preset', preset: encBuf });
    const zipped = zlib.gzipSync(outer);
    const out = Buffer.allocUnsafe(zipped.length);
    for (let i = 0; i < zipped.length; i += 1) {
        out[i] = RISUP_ENCODE_MAP[zipped[i]];
    }
    return out;
}

function msgpackDecode(u8) {
    const buf = Buffer.isBuffer(u8) ? u8 : Buffer.from(u8);
    let pos = 0;
    const readStr = (len) => {
        const s = buf.toString('utf8', pos, pos + len);
        pos += len;
        return s;
    };
    const readBin = (len) => {
        const b = buf.subarray(pos, pos + len);
        pos += len;
        return b;
    };
    const readArr = (len) => {
        const arr = new Array(len);
        for (let i = 0; i < len; i += 1) arr[i] = read();
        return arr;
    };
    const readMap = (len) => {
        const obj = {};
        for (let i = 0; i < len; i += 1) {
            const k = read();
            obj[String(k)] = read();
        }
        return obj;
    };
    function read() {
        if (pos >= buf.length) throw new Error('Unexpected end of MessagePack data');
        const b = buf[pos++];
        if (b <= 0x7f) return b;
        if (b >= 0xe0) return b - 256;
        if (b >= 0x80 && b <= 0x8f) return readMap(b & 0x0f);
        if (b >= 0x90 && b <= 0x9f) return readArr(b & 0x0f);
        if (b >= 0xa0 && b <= 0xbf) return readStr(b & 0x1f);
        switch (b) {
            case 0xc0: return null;
            case 0xc2: return false;
            case 0xc3: return true;
            case 0xc4: return readBin(buf[pos++]);
            case 0xc5: { const l = buf.readUInt16BE(pos); pos += 2; return readBin(l); }
            case 0xc6: { const l = buf.readUInt32BE(pos); pos += 4; return readBin(l); }
            case 0xca: { const v = buf.readFloatBE(pos); pos += 4; return v; }
            case 0xcb: { const v = buf.readDoubleBE(pos); pos += 8; return v; }
            case 0xcc: return buf[pos++];
            case 0xcd: { const v = buf.readUInt16BE(pos); pos += 2; return v; }
            case 0xce: { const v = buf.readUInt32BE(pos); pos += 4; return v; }
            case 0xcf: { const v = Number(buf.readBigUInt64BE(pos)); pos += 8; return v; }
            case 0xd0: { const v = buf.readInt8(pos); pos += 1; return v; }
            case 0xd1: { const v = buf.readInt16BE(pos); pos += 2; return v; }
            case 0xd2: { const v = buf.readInt32BE(pos); pos += 4; return v; }
            case 0xd3: { const v = Number(buf.readBigInt64BE(pos)); pos += 8; return v; }
            case 0xd9: return readStr(buf[pos++]);
            case 0xda: { const l = buf.readUInt16BE(pos); pos += 2; return readStr(l); }
            case 0xdb: { const l = buf.readUInt32BE(pos); pos += 4; return readStr(l); }
            case 0xdc: { const l = buf.readUInt16BE(pos); pos += 2; return readArr(l); }
            case 0xdd: { const l = buf.readUInt32BE(pos); pos += 4; return readArr(l); }
            case 0xde: { const l = buf.readUInt16BE(pos); pos += 2; return readMap(l); }
            case 0xdf: { const l = buf.readUInt32BE(pos); pos += 4; return readMap(l); }
            default: throw new Error(`Unsupported MessagePack prefix 0x${b.toString(16)}`);
        }
    }
    return read();
}

function decodeRisupPreset(buf) {
    if (!buf || !buf.length) throw new Error('Empty .risup buffer');
    const decoded = Buffer.allocUnsafe(buf.length);
    for (let i = 0; i < buf.length; i += 1) {
        decoded[i] = RISUP_DECODE_MAP[buf[i]];
    }
    let unzipped;
    try {
        unzipped = zlib.unzipSync(decoded);
    } catch (_) {
        unzipped = zlib.inflateRawSync(decoded);
    }
    const outer = msgpackDecode(unzipped);
    const enc = outer && (outer.preset || outer.pres);
    if (!enc || enc.length <= 16) throw new Error('Invalid .risup payload');
    const encBuf = Buffer.isBuffer(enc) ? enc : Buffer.from(enc);
    const aesKey = crypto.createHash('sha256').update('risupreset').digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.alloc(12));
    decipher.setAuthTag(encBuf.subarray(encBuf.length - 16));
    const decrypted = Buffer.concat([
        decipher.update(encBuf.subarray(0, encBuf.length - 16)),
        decipher.final(),
    ]);
    return msgpackDecode(decrypted);
}

function normalizePresetSampling(parsed) {
    const rawTemp = parseOptionalNumber(parsed && parsed.temperature);
    const temperature = rawTemp !== undefined
        ? (rawTemp > 2 ? Math.round((rawTemp / 100) * 1000) / 1000 : rawTemp)
        : undefined;
    const rawMaxResp = parseOptionalNumber(parsed && parsed.maxResponse);
    const maxResponse = rawMaxResp !== undefined && rawMaxResp > 0 ? Math.floor(rawMaxResp) : undefined;
    return { temperature, maxResponse };
}

const LEAVE_PRESET_ID = 'preset-leave-r1.1';
let cachedLeavePreset = null;
function loadBundledLeavePreset() {
    const risupPath = path.join(ROOT_DIR, 'prompt', 'Leave_RisuAI_Preset.risup');
    const htmlPath = path.join(ROOT_DIR, 'prompt', 'Leave_RisuAI_Preset.html');
    if (!fs.existsSync(risupPath)) return null;
    try {
        const stat = fs.statSync(risupPath);
        const hasGuide = fs.existsSync(htmlPath);
        if (cachedLeavePreset && cachedLeavePreset.mtimeMs === stat.mtimeMs && cachedLeavePreset.size === stat.size && cachedLeavePreset.hasGuide === hasGuide) {
            return cachedLeavePreset.value;
        }
        const rawRisup = fs.readFileSync(risupPath);
        const parsed = decodeRisupPreset(rawRisup);
        const sampling = normalizePresetSampling(parsed);
        const value = {
            id: LEAVE_PRESET_ID,
            name: String((parsed && parsed.name) || 'Leave — Wandering Librarian Engine r1.1'),
            toggleSyntax: String((parsed && parsed.customPromptTemplateToggle) || ''),
            defaultVariables: String((parsed && parsed.templateDefaultVariables) || ''),
            promptTemplate: Array.isArray(parsed && parsed.promptTemplate) ? parsed.promptTemplate : [],
            globalNote: String((parsed && parsed.globalNote) || ''),
            mainPrompt: String((parsed && parsed.mainPrompt) || ''),
            jailbreak: String((parsed && parsed.jailbreak) || ''),
            ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
            ...(sampling.maxResponse !== undefined ? { maxResponse: sampling.maxResponse } : {}),
            hasGuide,
            filename: 'Leave_RisuAI_Preset.risup',
            rawRisup,
            htmlPath,
        };
        cachedLeavePreset = { mtimeMs: stat.mtimeMs, size: stat.size, hasGuide, value };
        return value;
    } catch (_) {
        return null;
    }
}

function syncBundledLeavePresetToggles(presetToggles, activeDirectId = 'bundled:leave') {
    if (!Array.isArray(presetToggles)) return false;
    const leave = loadBundledLeavePreset();
    if (!leave || !String(leave.toggleSyntax || '').trim()) return false;
    let changed = false;
    const nextName = '🍃 ' + leave.name;
    const shouldEnable = activeDirectId === 'bundled:leave';
    let entry = presetToggles.find((pt) => pt && pt.id === LEAVE_PRESET_ID);
    if (!entry) {
        entry = {
            id: LEAVE_PRESET_ID,
            parentPresetId: 'bundled:leave',
            name: nextName,
            enabled: shouldEnable,
            syntax: leave.toggleSyntax,
        };
        presetToggles.unshift(entry);
        return true;
    }
    if (entry.parentPresetId !== 'bundled:leave') {
        entry.parentPresetId = 'bundled:leave';
        changed = true;
    }
    if (entry.syntax !== leave.toggleSyntax) {
        entry.syntax = leave.toggleSyntax;
        changed = true;
    }
    if (entry.name !== nextName) {
        entry.name = nextName;
        changed = true;
    }
    if (entry.enabled !== shouldEnable) {
        entry.enabled = shouldEnable;
        changed = true;
    }
    return changed;
}

function syncDirectPresetToggles(cfg = config) {
    if (!cfg || typeof cfg !== 'object') return false;
    let changed = false;
    if (!Array.isArray(cfg.presetToggles)) {
        cfg.presetToggles = [];
        changed = true;
    }
    const activeDirectId = (typeof cfg.directPresetId === 'string' && cfg.directPresetId.trim())
        ? cfg.directPresetId.trim()
        : 'bundled:leave';

    if (syncBundledLeavePresetToggles(cfg.presetToggles, activeDirectId)) {
        changed = true;
    }

    const customList = loadCustomPresets();
    const validCustomIds = new Set(customList.map((p) => p && p.id).filter(Boolean));
    const beforeLen = cfg.presetToggles.length;
    cfg.presetToggles = cfg.presetToggles.filter((pt) => {
        if (!pt || typeof pt !== 'object') return false;
        if (typeof pt.parentPresetId === 'string' && pt.parentPresetId.startsWith('custom:')) {
            return validCustomIds.has(pt.parentPresetId.slice(7));
        }
        return true;
    });
    if (cfg.presetToggles.length !== beforeLen) changed = true;

    for (const cp of customList) {
        if (!cp || !cp.id) continue;
        const parentId = `custom:${cp.id}`;
        const ptId = `pt-${cp.id}`;
        const existingIdx = cfg.presetToggles.findIndex((pt) => pt && pt.id === ptId);
        const syntaxStr = String(cp.customPromptTemplateToggle || '');
        if (syntaxStr.trim() && cp.autoRegisterToggle !== false) {
            const nextName = `📄 ${cp.name}`;
            const shouldEnable = activeDirectId === parentId;
            if (existingIdx < 0) {
                cfg.presetToggles.unshift({
                    id: ptId,
                    parentPresetId: parentId,
                    name: nextName,
                    enabled: shouldEnable,
                    syntax: syntaxStr,
                });
                changed = true;
            } else {
                const cur = cfg.presetToggles[existingIdx];
                if (cur.parentPresetId !== parentId) { cur.parentPresetId = parentId; changed = true; }
                if (cur.name !== nextName) { cur.name = nextName; changed = true; }
                if (cur.syntax !== syntaxStr) { cur.syntax = syntaxStr; changed = true; }
                if (cur.enabled !== shouldEnable) { cur.enabled = shouldEnable; changed = true; }
            }
        } else if (existingIdx >= 0 && !cfg.presetToggles[existingIdx].parentPresetId) {
            cfg.presetToggles[existingIdx].parentPresetId = parentId;
            changed = true;
        }
    }

    for (const pt of cfg.presetToggles) {
        if (!pt || typeof pt !== 'object') continue;
        if (!pt.parentPresetId) {
            if (pt.id === LEAVE_PRESET_ID) {
                pt.parentPresetId = 'bundled:leave';
                changed = true;
            } else if (typeof pt.id === 'string' && pt.id.startsWith('pt-') && validCustomIds.has(pt.id.slice(3))) {
                pt.parentPresetId = `custom:${pt.id.slice(3)}`;
                changed = true;
            }
        }
        if (pt.parentPresetId) {
            const shouldEnable = pt.parentPresetId === activeDirectId;
            if (pt.enabled !== shouldEnable) {
                pt.enabled = shouldEnable;
                changed = true;
            }
        }
    }
    return changed;
}

let customPresetsCache = null;

if (syncDirectPresetToggles(config)) {
    saveConfig();
}

function sanitizeUploadedPresetEntry(parsed, { id = '', filename = '' } = {}) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('올바른 RisuAI 프리셋 형식이 아닙니다.');
    }
    let promptTemplate = Array.isArray(parsed.promptTemplate) ? parsed.promptTemplate : [];
    const mainPrompt = String(parsed.mainPrompt || '');
    const globalNote = String(parsed.globalNote || '');
    const jailbreak = String(parsed.jailbreak || '');
    if (!promptTemplate.length && (mainPrompt || globalNote || jailbreak)) {
        promptTemplate = [];
        if (mainPrompt) promptTemplate.push({ type: 'plain', type2: 'main', role: 'system', text: mainPrompt });
        promptTemplate.push({ type: 'persona' });
        promptTemplate.push({ type: 'description' });
        promptTemplate.push({ type: 'lorebook' });
        promptTemplate.push({ type: 'authornote' });
        promptTemplate.push({ type: 'chat', rangeStart: 0, rangeEnd: 'end' });
        if (globalNote) promptTemplate.push({ type: 'plain', type2: 'globalNote', role: 'system', text: globalNote });
        if (jailbreak) promptTemplate.push({ type: 'jailbreak', role: 'system', text: jailbreak });
    }
    if (!promptTemplate.length) {
        throw new Error('프리셋에 promptTemplate 또는 mainPrompt가 없습니다.');
    }
    const baseName = String(parsed.name || filename.replace(/\.(risup|json)$/i, '') || 'Custom Preset').trim();
    const sampling = normalizePresetSampling(parsed);
    return {
        id: id || ('custom-' + crypto.randomBytes(6).toString('hex')),
        name: baseName.slice(0, 120),
        filename: String(filename || '').slice(0, 160),
        createdAt: Date.now(),
        promptTemplate: promptTemplate.map((it) => ({
            type: String((it && it.type) || 'plain'),
            ...(it && it.type2 ? { type2: String(it.type2) } : {}),
            ...(it && it.role ? { role: String(it.role) } : {}),
            ...(it && it.name ? { name: String(it.name) } : {}),
            ...(it && it.text !== undefined ? { text: String(it.text) } : {}),
            ...(it && it.rangeStart !== undefined ? { rangeStart: it.rangeStart } : {}),
            ...(it && it.rangeEnd !== undefined ? { rangeEnd: it.rangeEnd } : {}),
            ...(it && it.innerFormat ? { innerFormat: String(it.innerFormat) } : {}),
        })),
        customPromptTemplateToggle: String(parsed.customPromptTemplateToggle || ''),
        templateDefaultVariables: String(parsed.templateDefaultVariables || ''),
        autoRegisterToggle: parsed.autoRegisterToggle !== false,
        globalNote,
        mainPrompt,
        jailbreak,
        ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
        ...(sampling.maxResponse !== undefined ? { maxResponse: sampling.maxResponse } : {}),
    };
}

function parseUploadedPresetPayload({ filename = '', dataBase64 = '', jsonObject = null } = {}) {
    const cleanName = String(filename || '').trim();
    if (jsonObject && typeof jsonObject === 'object') {
        return sanitizeUploadedPresetEntry(jsonObject, { filename: cleanName });
    }
    const b64 = String(dataBase64 || '').trim();
    if (!b64) throw new Error('프리셋 파일 데이터가 비어 있습니다.');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw new Error('프리셋 파일 디코딩에 실패했습니다.');
    let parsed = null;
    if (/\.json$/i.test(cleanName)) {
        parsed = JSON.parse(buf.toString('utf8'));
    } else if (/\.risup$/i.test(cleanName)) {
        parsed = decodeRisupPreset(buf);
    } else {
        try {
            parsed = decodeRisupPreset(buf);
        } catch (_) {
            parsed = JSON.parse(buf.toString('utf8'));
        }
    }
    return sanitizeUploadedPresetEntry(parsed, { filename: cleanName });
}

function loadCustomPresets() {
    if (Array.isArray(customPresetsCache)) return customPresetsCache;
    try {
        if (fs.existsSync(PRESETS_PATH)) {
            const raw = JSON.parse(fs.readFileSync(PRESETS_PATH, 'utf8'));
            if (Array.isArray(raw)) {
                customPresetsCache = raw.filter((p) => p && typeof p === 'object' && p.id && Array.isArray(p.promptTemplate));
                return customPresetsCache;
            }
        }
    } catch (e) {
        console.warn('[Presets] 커스텀 프리셋 로드 실패:', e.message);
    }
    customPresetsCache = [];
    return customPresetsCache;
}

function saveCustomPresets(list) {
    customPresetsCache = Array.isArray(list) ? list : [];
    if (configPersistDisabled) return;
    const tmp = `${PRESETS_PATH}.rs-tmp-${crypto.randomBytes(6).toString('hex')}`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(customPresetsCache, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, PRESETS_PATH);
    } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch (_) {}
        console.warn('[Presets] 커스텀 프리셋 저장 실패:', e.message);
    }
}

function listDirectPresets() {
    const out = [
        { id: 'off', name: '사용 안 함 (기본 간이 프롬프트)', kind: 'off', templateCount: 0, hasToggles: false },
    ];
    const leave = loadBundledLeavePreset();
    if (leave) {
        out.push({
            id: 'bundled:leave',
            name: '🍃 ' + leave.name + ' (내장 .risup)',
            kind: 'bundled',
            templateCount: Array.isArray(leave.promptTemplate) ? leave.promptTemplate.length : 0,
            hasToggles: Boolean(leave.toggleSyntax),
        });
    }
    for (const p of loadCustomPresets()) {
        out.push({
            id: 'custom:' + p.id,
            customId: p.id,
            name: '📄 ' + p.name,
            filename: p.filename || '',
            kind: 'custom',
            templateCount: Array.isArray(p.promptTemplate) ? p.promptTemplate.length : 0,
            hasToggles: Boolean(p.customPromptTemplateToggle),
        });
    }
    return out;
}

function resolveDirectPreset(presetId) {
    const id = typeof presetId === 'string' ? presetId.trim() : '';
    if (!id || id === 'off') return null;
    if (id === 'bundled:leave') return loadBundledLeavePreset();
    if (id.startsWith('custom:')) {
        const cid = id.slice(7);
        return loadCustomPresets().find((p) => p && p.id === cid) || null;
    }
    return null;
}

// Ported from Librarian-System (LIB_UI_Patch) AI Provider & Ollama Cloud catalog
const OLLAMA_CLOUD_MODELS = Object.freeze([
    'deepseek-v4.1-flash:1017-cloud',
    'glm-5.3:cloud',
    'glm-5.3-flash:cloud',
    'hy4:cloud',
    'kimi-k3.1-pro:cloud',
    'inkling-2-small:cloud',
    'minimax-m3:cloud',
    'beam:cloud',
    'glm-5.2:cloud',
    'minimax-m3.1-flash:cloud',
    'kimi-k2.7-code:cloud',
    'kimi-k3:cloud',
    'nemotron-3-ultra:cloud',
    'mistral-large-4:cloud',
    'muse-spark-open:cloud',
    'mimo-v2.6-flash:cloud',
    'mimo-v2.6-pro:cloud',
    'gemma4:31b-cloud',
    'nemotron-3-super:120b',
    'deepseek-v4-pro:0813-cloud',
    'kimi-k2.6:cloud',
    'gpt-oss:120b-cloud',
]);

const AI_PROVIDER_PRESETS = Object.freeze({
    openrouter: Object.freeze({ id: 'openrouter', label: 'OpenRouter', group: 'main', providerType: 'openai_compat', endpoint: 'https://openrouter.ai/api/v1/chat/completions', modelsUrl: 'https://openrouter.ai/api/v1/models', modelsPath: '/v1/models', defaultModel: 'anthropic/claude-3.7-sonnet', allowEmptyKey: false }),
    ollama_cloud: Object.freeze({ id: 'ollama_cloud', label: 'Ollama Cloud', group: 'main', providerType: 'openai_compat', endpoint: 'https://ollama.com/v1/chat/completions', modelsUrl: 'https://ollama.com/v1/models', modelsPath: '/v1/models', defaultModel: 'deepseek-v4.1-flash:1017-cloud', allowEmptyKey: false, builtinModels: OLLAMA_CLOUD_MODELS }),
    openai: Object.freeze({ id: 'openai', label: 'OpenAI', group: 'main', providerType: 'openai_compat', endpoint: 'https://api.openai.com/v1/chat/completions', modelsUrl: 'https://api.openai.com/v1/models', modelsPath: '/v1/models', defaultModel: 'gpt-4.1', allowEmptyKey: false }),
    claude: Object.freeze({ id: 'claude', label: 'Claude / Anthropic', group: 'main', providerType: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages', modelsUrl: 'https://api.anthropic.com/v1/models', modelsPath: '/v1/models', defaultModel: 'claude-sonnet-4-20250514', allowEmptyKey: false }),
    gemini: Object.freeze({ id: 'gemini', label: 'Google Gemini API', group: 'main', providerType: 'gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models', modelsPath: '/v1beta/models', defaultModel: 'gemini-2.5-pro', allowEmptyKey: false }),
    deepseek: Object.freeze({ id: 'deepseek', label: 'DeepSeek', group: 'main', providerType: 'openai_compat', endpoint: 'https://api.deepseek.com/chat/completions', modelsUrl: 'https://api.deepseek.com/models', modelsPath: '/models', defaultModel: 'deepseek-chat', allowEmptyKey: false }),
    kimi: Object.freeze({ id: 'kimi', label: 'Kimi / Moonshot AI', group: 'main', providerType: 'openai_compat', endpoint: 'https://api.moonshot.ai/v1/chat/completions', modelsUrl: 'https://api.moonshot.ai/v1/models', modelsPath: '/models', defaultModel: 'kimi-k2.5', allowEmptyKey: false }),
    nanogpt: Object.freeze({ id: 'nanogpt', label: 'NanoGPT', group: 'main', providerType: 'openai_compat', endpoint: 'https://nano-gpt.com/api/v1/chat/completions', modelsUrl: 'https://nano-gpt.com/api/v1/models', modelsPath: '/v1/models', defaultModel: '', allowEmptyKey: false }),
    ollama: Object.freeze({ id: 'ollama', label: 'Ollama (로컬)', group: 'main', providerType: 'openai_compat', endpoint: 'http://localhost:11434/v1/chat/completions', modelsUrl: 'http://localhost:11434/v1/models', modelsPath: '/v1/models', defaultModel: '', allowEmptyKey: true }),
    lmstudio: Object.freeze({ id: 'lmstudio', label: 'LM Studio (로컬)', group: 'main', providerType: 'openai_compat', endpoint: 'http://localhost:1234/v1/chat/completions', modelsUrl: 'http://localhost:1234/v1/models', modelsPath: '/v1/models', defaultModel: '', allowEmptyKey: true }),
    together: Object.freeze({ id: 'together', label: 'Together AI', group: 'direct', providerType: 'openai_compat', endpoint: 'https://api.together.xyz/v1/chat/completions', modelsUrl: 'https://api.together.xyz/v1/models', modelsPath: '/models', defaultModel: '', allowEmptyKey: false }),
    fireworks: Object.freeze({ id: 'fireworks', label: 'Fireworks AI', group: 'direct', providerType: 'openai_compat', endpoint: 'https://api.fireworks.ai/inference/v1/chat/completions', modelsUrl: 'https://api.fireworks.ai/inference/v1/models', modelsPath: '/models', defaultModel: '', allowEmptyKey: false }),
    cerebras: Object.freeze({ id: 'cerebras', label: 'Cerebras', group: 'direct', providerType: 'openai_compat', endpoint: 'https://api.cerebras.ai/v1/chat/completions', modelsUrl: 'https://api.cerebras.ai/v1/models', modelsPath: '/models', defaultModel: '', allowEmptyKey: false }),
    siliconflow: Object.freeze({ id: 'siliconflow', label: 'SiliconFlow', group: 'direct', providerType: 'openai_compat', endpoint: 'https://api.siliconflow.com/v1/chat/completions', modelsUrl: 'https://api.siliconflow.com/v1/models?sub_type=chat', modelsPath: '/models?sub_type=chat', defaultModel: '', allowEmptyKey: false }),
    novita: Object.freeze({ id: 'novita', label: 'Novita AI', group: 'direct', providerType: 'openai_compat', endpoint: 'https://api.novita.ai/openai/v1/chat/completions', modelsUrl: 'https://api.novita.ai/openai/v1/models', modelsPath: '/models', defaultModel: '', allowEmptyKey: false }),
    'novita-coding': Object.freeze({ id: 'novita-coding', label: 'Novita Coding', group: 'direct', providerType: 'openai_compat', endpoint: 'https://api.novita.ai/openai/v1/chat/completions', modelsUrl: 'https://api.novita.ai/openai/v1/models', modelsPath: '/models', defaultModel: '', allowEmptyKey: false }),
    arliai: Object.freeze({ id: 'arliai', label: 'ArliAI', group: 'direct', providerType: 'openai_compat', endpoint: 'https://api.arliai.com/v1/chat/completions', modelsUrl: 'https://api.arliai.com/v1/models', modelsPath: '/models', defaultModel: '', allowEmptyKey: false }),
    featherless: Object.freeze({ id: 'featherless', label: 'Featherless AI', group: 'direct', providerType: 'openai_compat', endpoint: 'https://api.featherless.ai/v1/chat/completions', modelsUrl: 'https://api.featherless.ai/v1/models', modelsPath: '/models', defaultModel: '', allowEmptyKey: false }),
    'venice-ai': Object.freeze({ id: 'venice-ai', label: 'Venice AI', group: 'direct', providerType: 'openai_compat', endpoint: 'https://api.venice.ai/api/v1/chat/completions', modelsUrl: 'https://api.venice.ai/api/v1/models?type=text', modelsPath: '/models?type=text', defaultModel: '', allowEmptyKey: false }),
    'vercel-ai': Object.freeze({ id: 'vercel-ai', label: 'Vercel AI Gateway', group: 'direct', providerType: 'openai_compat', endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions', modelsUrl: 'https://ai-gateway.vercel.sh/v1/models', modelsPath: '/models', defaultModel: '', allowEmptyKey: false }),
    'cloudflare-ai-gateway': Object.freeze({ id: 'cloudflare-ai-gateway', label: 'Cloudflare AI Gateway', group: 'direct', providerType: 'openai_compat', endpoint: 'https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1/chat/completions', modelsUrl: '', modelsPath: '', defaultModel: '', allowEmptyKey: false }),
    crofai: Object.freeze({ id: 'crofai', label: 'CrofAI', group: 'direct', providerType: 'openai_compat', endpoint: 'https://ai.nahcrof.com/v1/chat/completions', modelsUrl: 'https://ai.nahcrof.com/v1/models', modelsPath: '/models', defaultModel: '', allowEmptyKey: false }),
    digitalocean: Object.freeze({ id: 'digitalocean', label: 'DigitalOcean Gradient AI', group: 'direct', providerType: 'openai_compat', endpoint: 'https://inference.do-ai.run/v1/chat/completions', modelsUrl: 'https://inference.do-ai.run/v1/models', modelsPath: '/models', defaultModel: '', allowEmptyKey: false }),
    'heroku-us': Object.freeze({ id: 'heroku-us', label: 'Heroku Managed Inference (US)', group: 'direct', providerType: 'openai_compat', endpoint: 'https://us.inference.heroku.com/v1/chat/completions', modelsUrl: '', modelsPath: '', defaultModel: '', allowEmptyKey: false }),
    'heroku-eu': Object.freeze({ id: 'heroku-eu', label: 'Heroku Managed Inference (EU)', group: 'direct', providerType: 'openai_compat', endpoint: 'https://eu.inference.heroku.com/v1/chat/completions', modelsUrl: '', modelsPath: '', defaultModel: '', allowEmptyKey: false }),
    'lightning-ai': Object.freeze({ id: 'lightning-ai', label: 'Lightning AI', group: 'direct', providerType: 'openai_compat', endpoint: 'https://lightning.ai/api/v1/chat/completions', modelsUrl: 'https://lightning.ai/api/v1/models', modelsPath: '/models', defaultModel: '', allowEmptyKey: false }),
    'llm-gateway': Object.freeze({ id: 'llm-gateway', label: 'LLM Gateway', group: 'direct', providerType: 'openai_compat', endpoint: 'https://api.llmgateway.io/v1/chat/completions', modelsUrl: 'https://api.llmgateway.io/v1/models?exclude_deprecated=true', modelsPath: '/models?exclude_deprecated=true', defaultModel: '', allowEmptyKey: false }),
    neuralwatt: Object.freeze({ id: 'neuralwatt', label: 'Neuralwatt', group: 'direct', providerType: 'openai_compat', endpoint: 'https://api.neuralwatt.com/v1/chat/completions', modelsUrl: 'https://api.neuralwatt.com/v1/models', modelsPath: '/models', defaultModel: '', allowEmptyKey: false }),
    'opencode-go': Object.freeze({ id: 'opencode-go', label: 'OpenCode Go', group: 'direct', providerType: 'openai_compat', endpoint: 'https://opencode.ai/zen/go/v1/chat/completions', modelsUrl: 'https://opencode.ai/zen/go/v1/models', modelsPath: '/models', defaultModel: '', allowEmptyKey: false }),
    synthetic: Object.freeze({ id: 'synthetic', label: 'Synthetic', group: 'direct', providerType: 'openai_compat', endpoint: 'https://api.synthetic.new/v1/chat/completions', modelsUrl: 'https://api.synthetic.new/v1/models', modelsPath: '/models', defaultModel: '', allowEmptyKey: false }),
    'z-ai': Object.freeze({ id: 'z-ai', label: 'Z.ai', group: 'direct', providerType: 'openai_compat', endpoint: 'https://api.z.ai/api/paas/v4/chat/completions', modelsUrl: '', modelsPath: '', defaultModel: '', allowEmptyKey: false }),
    'z-ai-coding': Object.freeze({ id: 'z-ai-coding', label: 'Z.ai Coding Plan', group: 'direct', providerType: 'openai_compat', endpoint: 'https://api.z.ai/api/coding/paas/v4/chat/completions', modelsUrl: '', modelsPath: '', defaultModel: '', allowEmptyKey: false }),
    'xiaomi-mimo': Object.freeze({ id: 'xiaomi-mimo', label: 'Xiaomi MiMo', group: 'direct', providerType: 'openai_compat', endpoint: 'https://api.xiaomimimo.com/v1/chat/completions', modelsUrl: '', modelsPath: '', defaultModel: '', allowEmptyKey: false }),
    'xiaomi-mimo-token-plan-cn': Object.freeze({ id: 'xiaomi-mimo-token-plan-cn', label: 'Xiaomi MiMo Token Plan (China)', group: 'direct', providerType: 'openai_compat', endpoint: 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions', modelsUrl: '', modelsPath: '', defaultModel: '', allowEmptyKey: false }),
    'xiaomi-mimo-token-plan-sgp': Object.freeze({ id: 'xiaomi-mimo-token-plan-sgp', label: 'Xiaomi MiMo Token Plan (Singapore)', group: 'direct', providerType: 'openai_compat', endpoint: 'https://token-plan-sgp.xiaomimimo.com/v1/chat/completions', modelsUrl: '', modelsPath: '', defaultModel: '', allowEmptyKey: false }),
    'xiaomi-mimo-token-plan-ams': Object.freeze({ id: 'xiaomi-mimo-token-plan-ams', label: 'Xiaomi MiMo Token Plan (Europe)', group: 'direct', providerType: 'openai_compat', endpoint: 'https://token-plan-ams.xiaomimimo.com/v1/chat/completions', modelsUrl: '', modelsPath: '', defaultModel: '', allowEmptyKey: false }),
    copilot: Object.freeze({ id: 'copilot', label: 'GitHub Copilot', group: 'direct', providerType: 'openai_compat', endpoint: 'https://api.githubcopilot.com/chat/completions', modelsUrl: '', modelsPath: '', defaultModel: '', allowEmptyKey: false }),
    custom: Object.freeze({ id: 'custom', label: '커스텀 (직접 입력)', group: 'direct', providerType: 'openai_compat', endpoint: '', modelsUrl: '', modelsPath: '/v1/models', defaultModel: '', allowEmptyKey: true }),
});

function joinProviderEndpoint(base = '', endpointPath = '') {
    const rawBase = String(base || '').trim().replace(/\/+$/, '');
    const rawPath = String(endpointPath || '').trim();
    if (!rawBase || !rawPath) return rawBase;
    const [pathPart, queryPart = ''] = rawPath.split('?');
    const normalizedPath = `/${String(pathPart || '').replace(/^\/+/, '')}`;
    const currentEndpoint = rawBase.match(/\/(chat\/completions|responses|messages|embeddings|models|api\/tags)(?:\?.*)?$/i);
    const targetMatch = normalizedPath.match(/\/(chat\/completions|responses|messages|embeddings|models|api\/tags)$/i);
    const targetEndpoint = targetMatch ? targetMatch[1] : '';
    if (currentEndpoint) {
        if (String(currentEndpoint[1]).toLowerCase() === String(targetEndpoint).toLowerCase()) return rawBase;
        return joinProviderEndpoint(rawBase.slice(0, currentEndpoint.index), rawPath);
    }
    const baseLower = rawBase.toLowerCase();
    const segments = normalizedPath.split('/').filter(Boolean);
    let overlap = '';
    for (let count = segments.length; count > 0; count -= 1) {
        const candidate = `/${segments.slice(0, count).join('/')}`;
        if (baseLower.endsWith(candidate.toLowerCase())) {
            overlap = candidate;
            break;
        }
    }
    const joined = `${rawBase}${overlap ? normalizedPath.slice(overlap.length) : normalizedPath}`;
    return queryPart ? `${joined}?${queryPart}` : joined;
}

function detectProviderPresetId(provider = '', providerType = '', baseUrl = '') {
    const rawId = String(provider || '').trim().toLowerCase();
    if (rawId && Object.prototype.hasOwnProperty.call(AI_PROVIDER_PRESETS, rawId)) return rawId;
    const u = String(baseUrl || '').trim().toLowerCase();
    if (u) {
        for (const p of Object.values(AI_PROVIDER_PRESETS)) {
            if (!p.endpoint || p.id === 'custom') continue;
            try {
                const pu = new URL(p.endpoint);
                const bu = new URL(u);
                if (pu.host === bu.host) {
                    if (p.id === 'novita-coding') continue;
                    if (p.id === 'z-ai' && u.includes('/coding/')) return 'z-ai-coding';
                    return p.id;
                }
            } catch (_) {}
        }
        if (u.includes('11434')) return 'ollama';
        if (u.includes('1234')) return 'lmstudio';
    }
    if (providerType === 'anthropic') return 'claude';
    if (providerType === 'gemini') return 'gemini';
    return 'custom';
}

function normalizeProviderModelsList(payload, providerId) {
    const source = Array.isArray(payload)
        ? payload
        : Array.isArray(payload && payload.data)
        ? payload.data
        : Array.isArray(payload && payload.models)
        ? payload.models
        : Array.isArray(payload && payload.items)
        ? payload.items
        : [];
    const seen = new Set();
    const out = [];
    for (const item of source) {
        const rec = typeof item === 'string' ? { id: item } : (item || {});
        let id = String(rec.id || rec.model || rec.slug || rec.name || '').trim();
        if (providerId === 'gemini') id = id.replace(/^models\//, '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const label = String(rec.display_name || rec.displayName || rec.label || rec.name || id).trim().replace(/^models\//, '') || id;
        out.push({ id, label });
    }
    return out;
}

async function fetchProviderModels({ provider = '', providerType = '', baseUrl = '', apiKey = '' } = {}) {
    const pid = detectProviderPresetId(provider, providerType, baseUrl);
    const preset = AI_PROVIDER_PRESETS[pid] || AI_PROVIDER_PRESETS.custom;
    const effType = providerType || preset.providerType || 'openai_compat';
    const rawUrl = String(baseUrl || '').trim();
    const builtinList = Array.isArray(preset.builtinModels) ? preset.builtinModels.map((id) => ({ id, label: id })) : [];

    let modelsUrl = '';
    if (rawUrl && preset.modelsPath) {
        modelsUrl = joinProviderEndpoint(rawUrl, preset.modelsPath);
    } else if (preset.modelsUrl) {
        modelsUrl = preset.modelsUrl;
    } else if (rawUrl && effType === 'openai_compat' && /\/chat\/completions/i.test(rawUrl)) {
        modelsUrl = joinProviderEndpoint(rawUrl, '/models');
    }

    const key = String(apiKey || '').trim().replace(/^Bearer\s+/i, '');
    let liveModels = [];
    let liveErr = null;

    if (modelsUrl && (key || preset.allowEmptyKey || pid === 'ollama')) {
        const headers = { Accept: 'application/json' };
        if (key && effType === 'gemini') headers['x-goog-api-key'] = key;
        else if (key && effType === 'anthropic') {
            headers['x-api-key'] = key;
            headers['anthropic-version'] = '2023-06-01';
        } else if (key) {
            headers.Authorization = `Bearer ${key}`;
        }
        const { signal, cleanup } = createTimeoutSignal(15000);
        try {
            const resp = await fetch(modelsUrl, { method: 'GET', headers, signal });
            if (!resp.ok) {
                const detail = await resp.text().catch(() => '');
                throw new Error(`HTTP ${resp.status}${detail ? ` - ${detail.slice(0, 160)}` : ''}`);
            }
            const json = await resp.json().catch(() => ({}));
            liveModels = normalizeProviderModelsList(json, pid);
        } catch (err) {
            liveErr = err;
        } finally {
            cleanup();
        }

        if ((!liveModels.length || liveErr) && pid === 'ollama') {
            const tagsUrl = joinProviderEndpoint(rawUrl || 'http://localhost:11434', '/api/tags');
            const tagCtrl = createTimeoutSignal(8000);
            try {
                const tagResp = await fetch(tagsUrl, { method: 'GET', headers: { Accept: 'application/json' }, signal: tagCtrl.signal });
                if (tagResp.ok) {
                    const tagJson = await tagResp.json().catch(() => ({}));
                    liveModels = normalizeProviderModelsList(tagJson, pid);
                    liveErr = null;
                }
            } catch (_) {
            } finally {
                tagCtrl.cleanup();
            }
        }
    }

    if (builtinList.length && liveModels.length) {
        const seen = new Set(builtinList.map((m) => m.id));
        const merged = [...builtinList];
        for (const m of liveModels) {
            if (!seen.has(m.id)) {
                seen.add(m.id);
                merged.push(m);
            }
        }
        return { models: merged, source: 'merged', provider: pid };
    }
    if (builtinList.length) {
        return { models: builtinList, source: 'builtin', provider: pid };
    }
    if (liveModels.length) {
        return { models: liveModels, source: 'live', provider: pid };
    }
    if (!modelsUrl) {
        throw new Error(`${preset.label}는 자동 모델 목록을 지원하지 않습니다. 모델 ID를 직접 입력해 주세요.`);
    }
    if (!key && !preset.allowEmptyKey) {
        throw new Error('모델 목록을 불러오려면 API 키를 먼저 입력(또는 저장)해 주세요.');
    }
    if (liveErr) {
        throw new Error(`모델 목록 조회 실패: ${liveErr.message}`);
    }
    throw new Error('프로바이더가 빈 모델 목록을 반환했습니다.');
}

// ================= Runtime State =================
const CMD_TTL_MS = 5 * 60 * 1000;
const CMD_MAX_LEN = 50;

const state = {
    pcConnected: false,
    pcLastSeen: 0,
    bridgeVersion: '',
    generating: false,
    nativeRequestPendingSince: 0,
    nativeRequestDispatched: false,
    directGenerating: false,
    lastDirectError: null,
    lastTriggerEvent: null,
    catalogVersion: 0,
    snapshotVersion: 0,
    baseSnapshot: null,
    catalog: {
        pcActiveCharIndex: -1,
        pcActiveChatIndex: -1,
        selectedPersona: 0,
        params: { temperature: 80, maxContext: 8000, maxResponse: 1000 },
        characters: [],
        modules: [],
        personas: [],
    },
    snapshot: {
        charName: 'PC RisuAI 연결 대기 중...',
        charIndex: -1,
        chatIndex: -1,
        chatName: '',
        isPcActive: false,
        totalMessages: 0,
        chatModules: [],
        backgroundHtml: '',
        assetMap: {},
        messages: [],
        charContext: null,
    },
    commandQueue: [],
};

const translationCache = new Map();

const ASSET_HMAC_KEY = crypto.randomBytes(32);
const ASSET_STORE_MAX_ITEMS = 160;
const ASSET_STORE_MAX_BYTES = 48 * 1024 * 1024;
const assetStore = new Map(); // id (32 hex) -> { buf: Buffer, mime: string }
let assetStoreBytes = 0;

function storeDataUriAsset(dataUri) {
    if (typeof dataUri !== 'string' || !dataUri.startsWith('data:image/')) return dataUri;
    const m = dataUri.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!m) return dataUri;
    const mime = m[1].toLowerCase();
    const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    if (!buf.length) return dataUri;
    const id = crypto.createHmac('sha256', ASSET_HMAC_KEY).update(mime + ':').update(buf).digest('hex').slice(0, 32);
    if (assetStore.has(id)) {
        const existing = assetStore.get(id);
        assetStore.delete(id);
        assetStore.set(id, existing);
        return `/api/asset/${id}`;
    }
    if (buf.length <= ASSET_STORE_MAX_BYTES) {
        while (
            assetStore.size >= ASSET_STORE_MAX_ITEMS ||
            assetStoreBytes + buf.length > ASSET_STORE_MAX_BYTES
        ) {
            const oldestKey = assetStore.keys().next().value;
            if (!oldestKey) break;
            const oldestVal = assetStore.get(oldestKey);
            assetStoreBytes = Math.max(0, assetStoreBytes - (oldestVal && oldestVal.buf ? oldestVal.buf.length : 0));
            assetStore.delete(oldestKey);
        }
        assetStore.set(id, { buf, mime });
        assetStoreBytes += buf.length;
    }
    return `/api/asset/${id}`;
}

function externalizeSnapshotAssets(snap) {
    if (!snap || typeof snap !== 'object') return snap;
    const nextMap = {};
    if (snap.assetMap && typeof snap.assetMap === 'object') {
        for (const [k, v] of Object.entries(snap.assetMap)) {
            nextMap[k] = (typeof v === 'string' && v.startsWith('data:image/')) ? storeDataUriAsset(v) : v;
        }
    }
    const nextMsgs = Array.isArray(snap.messages)
        ? snap.messages.map((msg) => {
            if (!msg || !Array.isArray(msg.images) || !msg.images.length) return msg;
            const nextImages = msg.images.map((im) => {
                const s = String(im || '');
                if (s.startsWith('[[RSASSET:') && s.endsWith(']]')) {
                    const key = s.slice(10, -2);
                    return nextMap[key] || s;
                }
                if (s.startsWith('data:image/')) return storeDataUriAsset(s);
                return s;
            });
            return { ...msg, images: nextImages };
        })
        : [];
    return {
        ...snap,
        assetMap: nextMap,
        messages: nextMsgs,
    };
}

async function replaceAsync(str, regex, asyncFn) {
    const src = String(str || '');
    const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
    const rx = new RegExp(regex.source, flags);
    let out = '';
    let lastIndex = 0;
    let match;
    while ((match = rx.exec(src)) !== null) {
        out += src.slice(lastIndex, match.index);
        out += await asyncFn(...match);
        lastIndex = match.index + match[0].length;
        if (match[0].length === 0) rx.lastIndex += 1;
    }
    out += src.slice(lastIndex);
    return out;
}

async function rebuildDisplayedSnapshot(baseSnap = state.baseSnapshot, adapter = activePluginAdapter) {
    if (!baseSnap || typeof baseSnap !== 'object') {
        state.snapshot = baseSnap;
        return baseSnap;
    }
    const hasEditDisplay = Boolean(adapter && typeof adapter.hasEditDisplayHandlers === 'function' && adapter.hasEditDisplayHandlers());
    const hasSurface = Boolean(adapter && ((typeof adapter.hasActiveSurfacePlugins === 'function' && adapter.hasActiveSurfacePlugins()) || (typeof adapter.hasEnabledPlugins === 'function' && adapter.hasEnabledPlugins())));
    if ((!hasEditDisplay && !hasSurface) || !Array.isArray(baseSnap.messages) || !baseSnap.messages.length) {
        state.snapshot = baseSnap;
        return baseSnap;
    }
    const charIdPart = String((baseSnap.charContext && baseSnap.charContext.charId) || baseSnap.charName || baseSnap.charIndex || 0).replace(/[^a-zA-Z0-9_-]/g, '_');
    const ensuredChatUuid = String(baseSnap.chatUuid || baseSnap.chatId || `rs-chat-${charIdPart}-${Math.max(0, Number(baseSnap.chatIndex) || 0)}`);
    const preparedMessages = baseSnap.messages.map((m) => {
        if (!m || typeof m !== 'object' || m.isFirstMessage || Number(m.index) < 0) return m;
        if (m.chatId && String(m.chatId).trim()) return m;
        return { ...m, chatId: `rs-msg-${ensuredChatUuid}-${m.index}` };
    });
    const surfaceProj = (hasSurface && typeof adapter.syncAndProjectChatSurface === 'function')
        ? await adapter.syncAndProjectChatSurface({ ...baseSnap, chatUuid: ensuredChatUuid, messages: preparedMessages })
        : null;

    const resolveAdapterAssetUrl = async (rawToken, nextImages) => {
        const tok = String(rawToken || '').trim();
        if (!tok) return '';
        const mappedPath = (surfaceProj && surfaceProj.assetPathsByName && surfaceProj.assetPathsByName[tok]) || '';
        const tryPaths = /^assets\//i.test(tok)
            ? [tok]
            : (mappedPath ? [mappedPath, tok] : [tok]);
        if (typeof adapter.readImage === 'function') {
            for (const p of tryPaths) {
                const bytes = await adapter.readImage(p);
                if (bytes && bytes.length) {
                    const dataUri = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
                    const url = storeDataUriAsset(dataUri);
                    if (url && !nextImages.includes(url)) nextImages.push(url);
                    return url;
                }
            }
        }
        if (baseSnap.assetMap && typeof baseSnap.assetMap[tok] === 'string') {
            return baseSnap.assetMap[tok];
        }
        return '';
    };

    const nextMessages = [];
    for (const m of preparedMessages) {
        if (!m || typeof m !== 'object') {
            nextMessages.push(m);
            continue;
        }
        const mCid = String(m.chatId || '').trim();
        const surfaceBodyHtml = (surfaceProj && surfaceProj.bodyHtmlByChatId && mCid && surfaceProj.bodyHtmlByChatId[mCid]) || '';
        const rawFooter = (surfaceProj && ((mCid && surfaceProj.footersByChatId[mCid]) || (surfaceProj.footersByIndex && surfaceProj.footersByIndex[m.index]))) || '';
        const pluginFooterHtml = rawFooter ? rawFooter.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '') : '';

        const baseHtml = surfaceBodyHtml || String(m.html || m.raw || '');
        let nextHtml = hasEditDisplay ? await adapter.runEditDisplay(baseHtml) : baseHtml;
        if (typeof nextHtml !== 'string') nextHtml = baseHtml;
        const hasTokens = /\{\{(?:inlay|inlayed|raw|img|asset|image)::/i.test(nextHtml) || /data:image\//i.test(nextHtml);
        if (nextHtml === String(m.html || '') && !hasTokens && !surfaceBodyHtml) {
            nextMessages.push(pluginFooterHtml ? { ...m, pluginFooterHtml } : m);
            continue;
        }
        nextHtml = nextHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
        const nextImages = Array.isArray(m.images) ? m.images.slice() : [];
        if (typeof adapter.readInlay === 'function') {
            nextHtml = await replaceAsync(nextHtml, /\{\{(?:inlay|inlayed)::([^}]+)\}\}/gi, async (_, rawId) => {
                const inlay = await adapter.readInlay(String(rawId || '').trim());
                if (inlay && inlay.data && String(inlay.data).startsWith('data:image/')) {
                    const url = storeDataUriAsset(inlay.data);
                    if (url && !nextImages.includes(url)) nextImages.push(url);
                    return `<img class="msg-img" src="${url}" />`;
                }
                return '';
            });
        }
        nextHtml = await replaceAsync(
            nextHtml,
            /(\bsrc\s*=\s*)(?:"\{\{(?:raw|img|asset|image)::([^}]+)\}\}"|'\{\{(?:raw|img|asset|image)::([^}]+)\}\}'|\{\{(?:raw|img|asset|image)::([^}]+)\}\})/gi,
            async (_, prefix, d1, d2, d3) => {
                const url = await resolveAdapterAssetUrl(d1 || d2 || d3, nextImages);
                return url ? `${prefix}"${url}"` : `${prefix}""`;
            }
        );
        nextHtml = await replaceAsync(nextHtml, /\{\{raw::([^}]+)\}\}/gi, async (_, rawTok) => await resolveAdapterAssetUrl(rawTok, nextImages));
        nextHtml = await replaceAsync(nextHtml, /\{\{(?:img|asset|image)::([^}]+)\}\}/gi, async (_, rawTok) => {
            const url = await resolveAdapterAssetUrl(rawTok, nextImages);
            return url ? `<img class="msg-img" src="${url}" />` : '';
        });
        nextHtml = nextHtml.replace(/<img\b([^>]*?)\bsrc\s*=\s*(?:"(data:image\/[^"]+)"|'(data:image\/[^']+)'|(data:image\/[^\s>]+))([^>]*)>/gi, (_, bAttr, d1, d2, d3, aAttr) => {
            const rawUri = d1 || d2 || d3 || '';
            const url = storeDataUriAsset(rawUri);
            if (url && !nextImages.includes(url)) nextImages.push(url);
            return `<img${bAttr} src="${url}"${aAttr}>`;
        });
        const strippedText = nextHtml
            .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, '')
            .trim();
        const nextText = strippedText || (nextImages.length ? nextImages.map((_, idx) => `[[RSIMG:${idx}]]`).join('\n') : String(m.text || ''));
        nextMessages.push({
            ...m,
            html: nextHtml,
            text: nextText,
            images: nextImages,
            pluginFooterHtml,
        });
    }
    state.snapshot = {
        ...baseSnap,
        chatUuid: ensuredChatUuid,
        messages: nextMessages,
    };
    return state.snapshot;
}

async function resolvePluginHtmlAssets(rawHtml, adapter = activePluginAdapter, baseSnap = state.baseSnapshot) {
    let nextHtml = String(rawHtml || '');
    if (!nextHtml) return '';
    nextHtml = nextHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    const assetPathsByName = {};
    try {
        if (adapter && typeof adapter.getTurnContext === 'function') {
            const tCtx = adapter.getTurnContext();
            const cAssets = tCtx && tCtx.charObj && Array.isArray(tCtx.charObj.additionalAssets) ? tCtx.charObj.additionalAssets : [];
            for (const entry of cAssets) {
                if (Array.isArray(entry) && entry[0] && entry[1]) assetPathsByName[String(entry[0])] = String(entry[1]);
                else if (entry && typeof entry === 'object' && entry.name && (entry.key || entry.path)) assetPathsByName[String(entry.name)] = String(entry.key || entry.path);
            }
        }
    } catch (_) {}

    const resolveTokenUrl = async (rawToken) => {
        const tok = String(rawToken || '').trim();
        if (!tok) return '';
        const mappedPath = assetPathsByName[tok] || '';
        const tryPaths = /^assets\//i.test(tok) ? [tok] : (mappedPath ? [mappedPath, tok] : [tok]);
        if (adapter && typeof adapter.readImage === 'function') {
            for (const p of tryPaths) {
                const bytes = await adapter.readImage(p);
                if (bytes && bytes.length) {
                    const dataUri = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
                    return storeDataUriAsset(dataUri);
                }
            }
        }
        if (baseSnap && baseSnap.assetMap && typeof baseSnap.assetMap[tok] === 'string') {
            return baseSnap.assetMap[tok];
        }
        return '';
    };

    const resolveInlayUrl = async (rawId) => {
        if (!adapter || typeof adapter.readInlay !== 'function') return '';
        const inlay = await adapter.readInlay(String(rawId || '').trim());
        if (inlay && inlay.data && String(inlay.data).startsWith('data:image/')) {
            return storeDataUriAsset(inlay.data);
        }
        return '';
    };

    if (/\{\{(?:inlay|inlayed|raw|img|asset|image)::/i.test(nextHtml)) {
        nextHtml = await replaceAsync(
            nextHtml,
            /(\bsrc\s*=\s*)(?:"\{\{(?:inlay|inlayed)::([^}]+)\}\}"|'\{\{(?:inlay|inlayed)::([^}]+)\}\}'|\{\{(?:inlay|inlayed)::([^}]+)\}\})/gi,
            async (_, prefix, d1, d2, d3) => {
                const url = await resolveInlayUrl(d1 || d2 || d3);
                return url ? `${prefix}"${url}"` : `${prefix}""`;
            }
        );
        nextHtml = await replaceAsync(nextHtml, /\{\{(?:inlay|inlayed)::([^}]+)\}\}/gi, async (_, rawId) => {
            const url = await resolveInlayUrl(rawId);
            return url ? `<img class="msg-img" src="${url}" />` : '';
        });
        nextHtml = await replaceAsync(
            nextHtml,
            /(\bsrc\s*=\s*)(?:"\{\{(?:raw|img|asset|image)::([^}]+)\}\}"|'\{\{(?:raw|img|asset|image)::([^}]+)\}\}'|\{\{(?:raw|img|asset|image)::([^}]+)\}\})/gi,
            async (_, prefix, d1, d2, d3) => {
                const url = await resolveTokenUrl(d1 || d2 || d3);
                return url ? `${prefix}"${url}"` : `${prefix}""`;
            }
        );
        nextHtml = await replaceAsync(nextHtml, /\{\{raw::([^}]+)\}\}/gi, async (_, rawTok) => await resolveTokenUrl(rawTok));
        nextHtml = await replaceAsync(nextHtml, /\{\{(?:img|asset|image)::([^}]+)\}\}/gi, async (_, rawTok) => {
            const url = await resolveTokenUrl(rawTok);
            return url ? `<img class="msg-img" src="${url}" />` : '';
        });
    }
    nextHtml = nextHtml.replace(/<img\b([^>]*?)\bsrc\s*=\s*(?:"(data:image\/[^"]+)"|'(data:image\/[^']+)'|(data:image\/[^\s>]+))([^>]*)>/gi, (_, bAttr, d1, d2, d3, aAttr) => {
        const rawUri = d1 || d2 || d3 || '';
        const url = storeDataUriAsset(rawUri);
        return `<img${bAttr} src="${url}"${aAttr}>`;
    });
    return nextHtml;
}

async function resolvePluginUiAssets(uiObj, adapter = activePluginAdapter, baseSnap = state.baseSnapshot) {
    if (!uiObj || typeof uiObj !== 'object') return uiObj;
    if (typeof uiObj.html === 'string') {
        return {
            ...uiObj,
            html: await resolvePluginHtmlAssets(uiObj.html, adapter, baseSnap),
        };
    }
    if (Array.isArray(uiObj.rootWidgets)) {
        const nextWidgets = await Promise.all(uiObj.rootWidgets.map(async (w) => (
            w && typeof w.html === 'string'
                ? { ...w, html: await resolvePluginHtmlAssets(w.html, adapter, baseSnap) }
                : w
        )));
        return { ...uiObj, rootWidgets: nextWidgets };
    }
    return uiObj;
}

function parseCookie(req, name) {
    const raw = String((req && req.headers && req.headers.cookie) || '');
    if (!raw) return '';
    for (const part of raw.split(';')) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        if (part.slice(0, eq).trim() === name) {
            return part.slice(eq + 1).trim();
        }
    }
    return '';
}

function maskKey(k) {
    if (!k) return '';
    const s = String(k);
    if (s.length <= 8) return '****';
    return s.slice(0, 4) + '...' + s.slice(-4);
}

function getActiveProfile() {
    if (!config.profiles.length) return null;
    return config.profiles.find((p) => p.id === config.activeProfileId) || null;
}

function getProfileForMode(mode = 'model') {
    const m = String(mode || 'model').trim();
    if (!m || m === 'model') return getActiveProfile();
    const auxId = typeof config.auxProfileId === 'string' ? config.auxProfileId.trim() : 'inherit';
    if (auxId && auxId !== 'inherit') {
        const aux = config.profiles.find((p) => p && p.id === auxId);
        if (aux) return aux;
    }
    return getActiveProfile();
}

function getAuxProfile() {
    return getProfileForMode('aux');
}

function pruneCommandQueue(now = Date.now()) {
    state.commandQueue = state.commandQueue.filter((c) => now - c.createdAt <= CMD_TTL_MS);
    if (state.commandQueue.length > CMD_MAX_LEN) {
        state.commandQueue.splice(0, state.commandQueue.length - CMD_MAX_LEN);
    }
}

function queueCommand(type, payload) {
    const now = Date.now();
    pruneCommandQueue(now);
    state.commandQueue.push({
        id: crypto.randomBytes(6).toString('hex'),
        type,
        payload: payload || {},
        createdAt: now,
    });
    if (state.commandQueue.length > CMD_MAX_LEN) {
        state.commandQueue.shift();
    }
}

// ================= HTTP & Security Helpers =================
function readBody(req, limitBytes = 25 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > limitBytes) {
                reject(new Error('Payload too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function isLoopbackAddress(addr) {
    const raw = String(addr || '').trim();
    return raw === '127.0.0.1' || raw === '::1' || raw === '::ffff:127.0.0.1';
}

function isTrustedOrigin(origin, hostHeader) {
    if (!origin) return true;
    const raw = String(origin).trim();
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(raw)) return true;
    if (/^(tauri:\/\/localhost|https?:\/\/tauri\.localhost)$/i.test(raw)) return true;
    if (hostHeader) {
        try {
            if (new URL(raw).host === String(hostHeader).trim()) return true;
        } catch (_) {}
    }
    return false;
}

function corsHeaders(req) {
    const origin = req && req.headers && req.headers.origin ? String(req.headers.origin).trim() : '';
    const hostHeader = req && req.headers && req.headers.host ? String(req.headers.host).trim() : '';
    if (!origin || !isTrustedOrigin(origin, hostHeader)) return {};
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-RisuStand-Token',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Vary': 'Origin',
    };
}

function sendJson(res, status, data, req = null, extraHeaders = {}) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        ...corsHeaders(req),
        ...extraHeaders,
    });
    res.end(body);
}

function getRequestToken(req) {
    const h = req.headers['x-risustand-token'];
    if (h) return String(h).trim();
    const auth = req.headers['authorization'] || '';
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    return '';
}

function safeTokenEqual(provided, expected) {
    const a = String(provided || '');
    const b = String(expected || '');
    if (!a || !b) return false;
    const da = crypto.createHash('sha256').update(a, 'utf8').digest();
    const db = crypto.createHash('sha256').update(b, 'utf8').digest();
    return crypto.timingSafeEqual(da, db);
}

const AUTH_WINDOW_MS = 60 * 1000;
const AUTH_MAX_FAILURES = 15;

function createAuthRateLimiter() {
    const failures = new Map();
    const clientKey = (req) => String((req && req.socket && req.socket.remoteAddress) || 'unknown');
    const isBlocked = (req, now = Date.now()) => {
        const entry = failures.get(clientKey(req));
        if (!entry) return false;
        if (now - entry.windowStart >= AUTH_WINDOW_MS) {
            failures.delete(clientKey(req));
            return false;
        }
        return entry.count >= AUTH_MAX_FAILURES;
    };
    const recordFailure = (req, now = Date.now()) => {
        const key = clientKey(req);
        let entry = failures.get(key);
        if (!entry || now - entry.windowStart >= AUTH_WINDOW_MS) {
            if (failures.size >= 500) {
                const oldest = failures.keys().next().value;
                if (oldest !== undefined) failures.delete(oldest);
            }
            entry = { count: 0, windowStart: now };
        }
        entry.count += 1;
        failures.set(key, entry);
        return entry.count >= AUTH_MAX_FAILURES;
    };
    const reset = (req) => failures.delete(clientKey(req));
    return { isBlocked, recordFailure, reset };
}

function makeRequireAuth(expectedToken, limiter) {
    return function requireAuthFn(req, res) {
        if (limiter.isBlocked(req)) {
            sendJson(res, 429, { error: 'Too many failed authentication attempts. Try again later.' }, req, { 'Retry-After': '60' });
            return false;
        }
        if (!safeTokenEqual(getRequestToken(req), expectedToken)) {
            const blocked = limiter.recordFailure(req);
            if (blocked) {
                sendJson(res, 429, { error: 'Too many failed authentication attempts. Try again later.' }, req, { 'Retry-After': '60' });
            } else {
                sendJson(res, 401, { error: 'Unauthorized: Invalid token' }, req);
            }
            return false;
        }
        limiter.reset(req);
        return true;
    };
}

function makeRequireProxyAuth(expectedToken, limiter) {
    return function requireProxyAuthFn(req, res) {
        if (limiter.isBlocked(req)) {
            sendJson(res, 429, { error: { message: 'Too many failed authentication attempts', type: 'rate_limit_error' } }, req, { 'Retry-After': '60' });
            return false;
        }
        const provided = getRequestToken(req);
        if (provided) {
            if (safeTokenEqual(provided, expectedToken)) {
                limiter.reset(req);
                return true;
            }
            // Allow local PC RisuAI Custom API users who left a dummy key like 'risustand', unless untrusted Origin
            if (isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
                const origin = req.headers && req.headers.origin;
                if (origin && !isTrustedOrigin(origin, req.headers.host)) {
                    sendJson(res, 403, { error: { message: 'Forbidden cross-origin request', type: 'auth_error' } }, req);
                    return false;
                }
                return true;
            }
            limiter.recordFailure(req);
            sendJson(res, 401, { error: { message: 'Unauthorized: Invalid token for remote proxy access', type: 'auth_error' } }, req);
            return false;
        }
        if (isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
            const origin = req.headers && req.headers.origin;
            if (origin && !isTrustedOrigin(origin, req.headers.host)) {
                sendJson(res, 403, { error: { message: 'Forbidden cross-origin request', type: 'auth_error' } }, req);
                return false;
            }
            return true;
        }
        limiter.recordFailure(req);
        sendJson(res, 401, { error: { message: 'Unauthorized: Bearer token required for remote proxy access', type: 'auth_error' } }, req);
        return false;
    };
}

// ================= LLM Router Core =================
function applyPromptOverride(messages, profile) {
    const list = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
    const mode = profile && profile.overrideMode ? profile.overrideMode : 'off';
    const text = profile && profile.systemOverride ? String(profile.systemOverride).trim() : '';
    if (mode === 'off' || !text) return list;

    if (mode === 'replace') {
        const nonSys = list.filter((m) => m.role !== 'system');
        return [{ role: 'system', content: text }, ...nonSys];
    }
    if (mode === 'prepend') {
        return [{ role: 'system', content: text }, ...list];
    }
    if (mode === 'append') {
        const idx = list.findIndex((m) => m.role === 'system');
        if (idx >= 0) {
            list[idx].content = String(list[idx].content || '') + '\n\n' + text;
            return list;
        }
        return [{ role: 'system', content: text }, ...list];
    }
    return list;
}

function parseOptionalNumber(v) {
    if (v === '' || v === null || v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

function normalizeMessageText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => (typeof part === 'string' ? part : part && part.text ? part.text : ''))
            .filter(Boolean)
            .join('\n');
    }
    return String(content || '');
}

function normalizeTurnMessages(messages, { assistantRole = 'assistant', ensureUserFirst = false } = {}) {
    const sysParts = [];
    const sysBlocks = [];
    const turns = [];
    const turnCachePoints = [];
    for (const m of Array.isArray(messages) ? messages : []) {
        const txt = normalizeMessageText(m && m.content);
        const cp = Boolean(m && m._cachePoint);
        if (m && m.role === 'system') {
            if (txt) {
                sysParts.push(txt);
                sysBlocks.push({ text: txt, cachePoint: cp });
            } else if (cp && sysBlocks.length) {
                sysBlocks[sysBlocks.length - 1].cachePoint = true;
            }
            continue;
        }
        const role = m && m.role === 'assistant' ? assistantRole : 'user';
        const lastIdx = turns.length - 1;
        if (lastIdx >= 0 && turns[lastIdx].role === role) {
            if (txt) turns[lastIdx].text = turns[lastIdx].text ? `${turns[lastIdx].text}\n\n${txt}` : txt;
            if (cp) turnCachePoints[lastIdx] = true;
        } else {
            turns.push({ role, text: txt });
            turnCachePoints.push(cp);
        }
    }
    if (ensureUserFirst) {
        if (!turns.length) {
            turns.push({ role: 'user', text: 'Continue.' });
            turnCachePoints.push(false);
        } else if (turns[0].role !== 'user') {
            turns.unshift({ role: 'user', text: '[Start]' });
            turnCachePoints.unshift(false);
        }
    } else if (!turns.length) {
        turns.push({ role: 'user', text: 'Continue.' });
        turnCachePoints.push(false);
    }
    return { sysParts, sysBlocks, turns, turnCachePoints };
}

function computeUATurnStats(messages) {
    const list = Array.isArray(messages) ? messages : [];
    let completed = 0;
    let hasPendingUser = false;
    let hasAssistantInPair = false;
    let activeTurnNum = 0;
    const turnByIndex = new Array(list.length).fill(0);
    for (let i = 0; i < list.length; i += 1) {
        const m = list[i];
        if (!m || typeof m !== 'object') continue;
        if (m.disabled === true || m.isComment === true || m.isFirstMessage === true) continue;
        const rawBody = m.data ?? m.raw ?? m.content ?? m.text ?? '';
        let hasBody = String(rawBody).trim().length > 0;
        if (!hasBody && m.html) {
            hasBody = String(m.html).replace(/<[^>]+>/g, ' ').trim().length > 0 || /<img\b/i.test(String(m.html));
        }
        if (!hasBody) continue;
        const roleRaw = String(m.role || '').toLowerCase();
        if (roleRaw === 'user') {
            if (!hasPendingUser) {
                activeTurnNum = completed + 1;
                hasPendingUser = true;
                hasAssistantInPair = false;
            } else if (hasAssistantInPair) {
                completed += 1;
                activeTurnNum = completed + 1;
                hasPendingUser = true;
                hasAssistantInPair = false;
            }
            turnByIndex[i] = activeTurnNum;
        } else if (roleRaw === 'char' || roleRaw === 'assistant' || roleRaw === 'bot' || roleRaw === 'model') {
            if (!hasPendingUser) {
                turnByIndex[i] = 0;
            } else {
                hasAssistantInPair = true;
                turnByIndex[i] = activeTurnNum;
            }
        }
    }
    if (hasPendingUser && hasAssistantInPair) completed += 1;
    return {
        completedTurns: completed,
        pendingTurn: (hasPendingUser && !hasAssistantInPair) ? activeTurnNum : 0,
        turnByIndex,
    };
}

function createTimeoutSignal(timeoutMs, externalSignal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`요청 시간 초과 (${Math.round(timeoutMs / 1000)}초)`)), timeoutMs);
    let onAbort = null;
    if (externalSignal) {
        if (externalSignal.aborted) {
            ctrl.abort(externalSignal.reason);
        } else {
            onAbort = () => ctrl.abort(externalSignal.reason);
            externalSignal.addEventListener('abort', onAbort, { once: true });
        }
    }
    const cleanup = () => {
        clearTimeout(timer);
        if (externalSignal && onAbort) externalSignal.removeEventListener('abort', onAbort);
    };
    return { signal: ctrl.signal, cleanup };
}

function mergeStreamUsage(prev, incoming) {
    if (!incoming || typeof incoming !== 'object') return prev || null;
    if (!prev || typeof prev !== 'object') return { ...incoming };
    const merged = { ...prev, ...incoming };
    if (prev.prompt_tokens_details || incoming.prompt_tokens_details) {
        merged.prompt_tokens_details = {
            ...(prev.prompt_tokens_details || {}),
            ...(incoming.prompt_tokens_details || {}),
        };
    }
    if (prev.input_tokens_details || incoming.input_tokens_details) {
        merged.input_tokens_details = {
            ...(prev.input_tokens_details || {}),
            ...(incoming.input_tokens_details || {}),
        };
    }
    if (prev.completion_tokens_details || incoming.completion_tokens_details) {
        merged.completion_tokens_details = {
            ...(prev.completion_tokens_details || {}),
            ...(incoming.completion_tokens_details || {}),
        };
    }
    if (prev.output_tokens_details || incoming.output_tokens_details) {
        merged.output_tokens_details = {
            ...(prev.output_tokens_details || {}),
            ...(incoming.output_tokens_details || {}),
        };
    }
    // Preserve non-zero Anthropic/OpenAI fields from earlier chunks (e.g. message_start vs message_delta)
    for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'promptTokenCount', 'candidatesTokenCount', 'cachedContentTokenCount', 'totalTokenCount', 'thoughtsTokenCount']) {
        const pv = Number(prev[k] || 0);
        const iv = Number(incoming[k] || 0);
        if (pv > 0 && iv === 0 && (k !== 'output_tokens' && k !== 'completion_tokens')) {
            merged[k] = pv;
        }
    }
    return merged;
}

function mapUsageToOpenAI(usage) {
    if (!usage || typeof usage !== 'object') {
        return {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            cached_tokens: 0,
            cache_creation_tokens: 0,
            reasoning_tokens: 0,
            cache_reported: false,
        };
    }
    if (typeof usage.prompt_tokens === 'number' || typeof usage.completion_tokens === 'number') {
        const deepSeekHit = Number(usage.prompt_cache_hit_tokens || 0);
        const deepSeekMiss = Number(usage.prompt_cache_miss_tokens || 0);
        const pDetails = (usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object') ? usage.prompt_tokens_details : null;
        const iDetails = (usage.input_tokens_details && typeof usage.input_tokens_details === 'object') ? usage.input_tokens_details : null;
        const cDetails = (usage.completion_tokens_details && typeof usage.completion_tokens_details === 'object') ? usage.completion_tokens_details : null;
        const cached = Number(
            (pDetails && pDetails.cached_tokens) ??
            (iDetails && iDetails.cached_tokens) ??
            usage.cache_read_input_tokens ??
            deepSeekHit ??
            0
        );
        const cacheWrite = Number(
            (pDetails && (pDetails.cache_write_tokens ?? pDetails.cached_creation_tokens)) ??
            usage.cache_creation_input_tokens ??
            0
        );
        const reasoning = Number((cDetails && cDetails.reasoning_tokens) ?? 0);
        const prompt = Number(usage.prompt_tokens || (deepSeekHit + deepSeekMiss) || 0);
        const completion = Number(usage.completion_tokens || 0);
        const cacheReported = Boolean(
            (pDetails && ('cached_tokens' in pDetails)) ||
            (iDetails && ('cached_tokens' in iDetails)) ||
            ('prompt_cache_hit_tokens' in usage) ||
            ('cache_read_input_tokens' in usage)
        );
        return {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: Number(usage.total_tokens || (prompt + completion)),
            cached_tokens: cached,
            cache_creation_tokens: cacheWrite,
            reasoning_tokens: reasoning,
            cache_reported: cacheReported,
        };
    }
    if (typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number') {
        const iDetails = (usage.input_tokens_details && typeof usage.input_tokens_details === 'object') ? usage.input_tokens_details : null;
        const oDetails = (usage.output_tokens_details && typeof usage.output_tokens_details === 'object') ? usage.output_tokens_details : null;
        const baseInput = Number(usage.input_tokens || 0);
        const cached = Number(usage.cache_read_input_tokens ?? (iDetails && iDetails.cached_tokens) ?? 0);
        const cacheWrite = Number(usage.cache_creation_input_tokens ?? 0);
        const isAnthropicShape = ('cache_read_input_tokens' in usage) || ('cache_creation_input_tokens' in usage);
        const prompt = isAnthropicShape ? (baseInput + cached + cacheWrite) : baseInput;
        const completion = Number(usage.output_tokens || 0);
        const reasoning = Number((oDetails && oDetails.reasoning_tokens) ?? 0);
        const cacheReported = Boolean(isAnthropicShape || (iDetails && ('cached_tokens' in iDetails)));
        return {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: prompt + completion,
            cached_tokens: cached,
            cache_creation_tokens: cacheWrite,
            reasoning_tokens: reasoning,
            cache_reported: cacheReported,
        };
    }
    if (typeof usage.promptTokenCount === 'number' || typeof usage.candidatesTokenCount === 'number') {
        const prompt = Number(usage.promptTokenCount || 0);
        const completion = Number(usage.candidatesTokenCount || 0);
        const cached = Number(usage.cachedContentTokenCount || 0);
        const reasoning = Number(usage.thoughtsTokenCount || 0);
        return {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: Number(usage.totalTokenCount || (prompt + completion)),
            cached_tokens: cached,
            cache_creation_tokens: 0,
            reasoning_tokens: reasoning,
            cache_reported: ('cachedContentTokenCount' in usage),
        };
    }
    return {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cached_tokens: 0,
        cache_creation_tokens: 0,
        reasoning_tokens: 0,
        cache_reported: false,
    };
}

const REQUEST_LOG_MAX = 40;
const REQUEST_LOG_MSG_CHAR_LIMIT = 40000;
const REQUEST_LOG_BODY_CHAR_LIMIT = 140000;
const REQUEST_LOG_RESP_CHAR_LIMIT = 80000;
const requestLogs = [];
let requestLogSeq = 0;

function truncateLogText(val, maxLen) {
    const s = String(val == null ? '' : val);
    if (!maxLen || s.length <= maxLen) return s;
    const overflow = s.length - maxLen;
    return `${s.slice(0, maxLen)}\n... [truncated ${overflow} chars]`;
}

function stripDataUriBase64(val) {
    return String(val == null ? '' : val).replace(/data:[a-z0-9.+/-]+;base64,[A-Za-z0-9+/=]{128,}/gi, '[base64 media omitted]');
}

function sanitizeLogHeaders(headers) {
    const out = {};
    if (!headers || typeof headers !== 'object') return out;
    for (const [k, v] of Object.entries(headers)) {
        const key = String(k);
        const val = String(v == null ? '' : v);
        if (/^(authorization|proxy-authorization|x-api-key|x-goog-api-key|x-risustand-token|cookie|set-cookie)$/i.test(key)) {
            out[key] = /^Bearer\s+/i.test(val) ? 'Bearer [REDACTED]' : '[REDACTED]';
        } else {
            out[key] = val;
        }
    }
    return out;
}

function flattenMessageContentForLog(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return String(part || '');
            if (typeof part.text === 'string') return part.text;
            if (part.type === 'image_url' && part.image_url) {
                const url = typeof part.image_url === 'string' ? part.image_url : (part.image_url.url || '');
                return `[image: ${stripDataUriBase64(url).slice(0, 120)}]`;
            }
            return safeJsonForLog(part, 2000);
        }).join('\n');
    }
    if (content && typeof content === 'object') return safeJsonForLog(content, REQUEST_LOG_MSG_CHAR_LIMIT);
    return String(content == null ? '' : content);
}

function sanitizeLogMessages(messages) {
    if (!Array.isArray(messages)) return [];
    const list = messages.slice(0, 200);
    return list.map((m) => ({
        role: String((m && m.role) || 'user'),
        content: truncateLogText(stripDataUriBase64(flattenMessageContentForLog(m ? m.content : '')), REQUEST_LOG_MSG_CHAR_LIMIT),
    }));
}

function safeJsonForLog(obj, maxLen) {
    if (obj === undefined || obj === null) return '';
    try {
        const json = JSON.stringify(obj, (key, val) => {
            if (key && /^(?:api[_-]?key|.*secret.*|.*password.*|authorization|x-api-key|x-goog-api-key|auth_?token|access_?token|refresh_?token|risustand_?token)$/i.test(key)) {
                return '[REDACTED]';
            }
            if (typeof val === 'string') {
                if (/^Bearer\s+\S+/i.test(val)) return 'Bearer [REDACTED]';
                return stripDataUriBase64(val);
            }
            return val;
        }, 2);
        return truncateLogText(json, maxLen);
    } catch (_) {
        return '';
    }
}

// ===== Prompt Cache Guard Engine (An-chan logic adapted for RisuStand Remote Proxy) =====
const CACHE_GUARD_PRICING_TABLE = [
    { re: /claude[-_]?opus[-_.]?4(?:[._-]?[56])/i, in: 5.0, read: 0.5, write: 6.25, out: 25.0 },
    { re: /claude[-_]?opus[-_.]?4/i, in: 15.0, read: 1.5, write: 18.75, out: 75.0 },
    { re: /claude[-_.]?(?:3[._-]?[57][._-]?)?sonnet|claude[-_]?sonnet[-_.]?4/i, in: 3.0, read: 0.3, write: 3.75, out: 15.0 },
    { re: /claude[-_.]?haiku[-_.]?4(?:[._-]?5)?/i, in: 1.0, read: 0.1, write: 1.25, out: 5.0 },
    { re: /claude[-_.]?3[._-]?5[._-]?haiku/i, in: 0.8, read: 0.08, write: 1.0, out: 4.0 },
    { re: /gpt-4\.1-mini/i, in: 0.4, read: 0.1, write: 0.4, out: 1.6 },
    { re: /gpt-4\.1-nano/i, in: 0.1, read: 0.025, write: 0.1, out: 0.4 },
    { re: /gpt-4\.1/i, in: 2.0, read: 0.5, write: 2.0, out: 8.0 },
    { re: /gpt-4o-mini/i, in: 0.15, read: 0.075, write: 0.15, out: 0.6 },
    { re: /gpt-4o/i, in: 2.5, read: 1.25, write: 2.5, out: 10.0 },
    { re: /gpt-5/i, in: 1.25, read: 0.125, write: 1.25, out: 10.0 },
    { re: /\bo[134](?:-mini|-pro)?\b/i, in: 2.0, read: 0.5, write: 2.0, out: 8.0 },
    { re: /gemini[-_.]?2\.0[-_.]?flash/i, in: 0.1, read: 0.025, write: 0.1, out: 0.4 },
    { re: /gemini[-_.]?(?:2\.5|3)[-_.]?flash/i, in: 0.3, read: 0.075, write: 0.3, out: 2.5 },
    { re: /gemini[-_.]?(?:2\.5|3)[-_.]?pro/i, in: 1.25, read: 0.31, write: 1.25, out: 10.0 },
    { re: /deepseek/i, in: 0.27, read: 0.07, write: 0.27, out: 1.1 },
];

function cgFnv1aHex(input) {
    const str = String(input || '');
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

function cgSampleHash(input) {
    const str = String(input || '');
    if (!str) return '00000000';
    if (str.length <= 2048) return cgFnv1aHex(str);
    const mid = Math.floor(str.length / 2);
    const sample = str.slice(0, 512) + '|' + str.slice(mid - 256, mid + 256) + '|' + str.slice(-512) + '|' + str.length;
    return cgFnv1aHex(sample);
}

function cgEstimateTokens(text) {
    const str = String(text || '');
    if (!str) return 0;
    let nonAscii = 0;
    for (let i = 0; i < str.length; i++) {
        if (str.charCodeAt(i) > 127) nonAscii++;
    }
    const ascii = str.length - nonAscii;
    return Math.max(1, Math.ceil(ascii / 3.8 + nonAscii / 1.4));
}

function cgGetMinCacheTokensForModel(model) {
    const m = String(model || '').toLowerCase();
    if (!m) return 1024;
    if (m.includes('deepseek')) return 64;
    if (m.includes('gemini-1.5')) return 32768;
    if (m.includes('gemini')) return 1024;
    if (m.includes('haiku')) return 2048;
    if (m.includes('claude')) return 1024;
    return 1024;
}

function cgGetPricingForModel(model) {
    const m = String(model || '');
    if (!m) return null;
    for (const rule of CACHE_GUARD_PRICING_TABLE) {
        if (rule.re.test(m)) return rule;
    }
    return null;
}

function cgEstimateTurnCost(model, usage) {
    const pricing = cgGetPricingForModel(model);
    if (!pricing || !usage) return null;
    const promptTokens = Math.max(0, Number(usage.prompt_tokens || 0));
    const completionTokens = Math.max(0, Number(usage.completion_tokens || 0));
    const cachedTokens = Math.min(promptTokens, Math.max(0, Number(usage.cached_tokens || 0)));
    const cacheWriteTokens = Math.max(0, Number(usage.cache_creation_tokens || 0));
    const uncachedInput = Math.max(0, promptTokens - cachedTokens - cacheWriteTokens);
    const inputCost = (uncachedInput / 1e6) * pricing.in + (cachedTokens / 1e6) * pricing.read + (cacheWriteTokens / 1e6) * pricing.write;
    const outputCost = (completionTokens / 1e6) * pricing.out;
    const cacheSavingsUsd = (cachedTokens / 1e6) * Math.max(0, pricing.in - pricing.read);
    const writeOverheadUsd = (cacheWriteTokens / 1e6) * Math.max(0, pricing.write - pricing.in);
    return {
        totalUsd: Math.round((inputCost + outputCost) * 1e6) / 1e6,
        cacheSavingsUsd: Math.round(cacheSavingsUsd * 1e6) / 1e6,
        writeOverheadUsd: Math.round(writeOverheadUsd * 1e6) / 1e6,
    };
}

function cgFlattenContent(content) {
    let hasCacheControl = false;
    let cacheControlType = '';
    if (typeof content === 'string') {
        return { text: content, hasCacheControl: false, cacheControlType: '' };
    }
    if (Array.isArray(content)) {
        const parts = [];
        for (const item of content) {
            if (typeof item === 'string') {
                parts.push(item);
                continue;
            }
            if (!item || typeof item !== 'object') continue;
            if (item.cache_control && typeof item.cache_control === 'object') {
                hasCacheControl = true;
                cacheControlType = String(item.cache_control.type || 'ephemeral');
            }
            if (typeof item.text === 'string') {
                parts.push(item.text);
            } else if (item.type === 'text' && item.text && typeof item.text.value === 'string') {
                parts.push(item.text.value);
            } else if (item.type === 'image_url') {
                parts.push('[image_url]');
            } else if (item.type === 'input_image' || item.inlineData) {
                parts.push('[image]');
            }
        }
        return { text: parts.join('\n'), hasCacheControl, cacheControlType };
    }
    if (content && typeof content === 'object') {
        if (content.cache_control && typeof content.cache_control === 'object') {
            hasCacheControl = true;
            cacheControlType = String(content.cache_control.type || 'ephemeral');
        }
        if (Array.isArray(content.parts)) {
            return cgFlattenContent(content.parts);
        }
        if (typeof content.text === 'string') {
            return { text: content.text, hasCacheControl, cacheControlType };
        }
    }
    return { text: content == null ? '' : String(content), hasCacheControl: false, cacheControlType: '' };
}

function cgIsNonChatMediaRequest(endpoint, rawBodyObj) {
    const ep = String(endpoint || '').toLowerCase();
    if (/\/(?:images\/(?:generations|edits|variations)|audio\/|embeddings\b|moderations\b|tts\b)/.test(ep)) {
        return true;
    }
    if (rawBodyObj && typeof rawBodyObj === 'object') {
        if (!Array.isArray(rawBodyObj.messages) && !Array.isArray(rawBodyObj.contents)) {
            if (rawBodyObj.input !== undefined || rawBodyObj.prompt !== undefined || rawBodyObj.voice !== undefined) {
                return true;
            }
        }
    }
    return false;
}

function cgClassifySegmentKind(role, sawChatTurn) {
    const r = String(role || 'user').toLowerCase();
    if (r === 'system' || r === 'developer') {
        return sawChatTurn ? 'sys_tail' : 'system';
    }
    return 'chat';
}

function cgExtractRequestSegments(rawBodyObj, fallbackMessages, providerType) {
    const rawItems = [];
    const body = (rawBodyObj && typeof rawBodyObj === 'object') ? rawBodyObj : null;

    if (body) {
        // Anthropic `system` field or Gemini `systemInstruction`
        if (body.system !== undefined && body.system !== null && body.system !== '') {
            const flat = cgFlattenContent(body.system);
            if (flat.text) {
                rawItems.push({ role: 'system', text: flat.text, hasCacheControl: flat.hasCacheControl, cacheControlType: flat.cacheControlType });
            }
        } else if (body.systemInstruction !== undefined && body.systemInstruction !== null) {
            const flat = cgFlattenContent(body.systemInstruction);
            if (flat.text) {
                rawItems.push({ role: 'system', text: flat.text, hasCacheControl: flat.hasCacheControl, cacheControlType: flat.cacheControlType });
            }
        }
        if (Array.isArray(body.messages)) {
            for (const m of body.messages) {
                if (!m || typeof m !== 'object') continue;
                const flat = cgFlattenContent(m.content);
                const msgCC = m.cache_control && typeof m.cache_control === 'object';
                rawItems.push({
                    role: String(m.role || 'user').toLowerCase(),
                    text: flat.text,
                    hasCacheControl: Boolean(flat.hasCacheControl || msgCC),
                    cacheControlType: flat.cacheControlType || (msgCC ? String(m.cache_control.type || 'ephemeral') : ''),
                });
            }
        } else if (Array.isArray(body.contents)) {
            for (const c of body.contents) {
                if (!c || typeof c !== 'object') continue;
                const flat = cgFlattenContent(c.parts || c.content || '');
                rawItems.push({
                    role: String(c.role || 'user').toLowerCase(),
                    text: flat.text,
                    hasCacheControl: flat.hasCacheControl,
                    cacheControlType: flat.cacheControlType,
                });
            }
        }
    }

    if (rawItems.length === 0 && Array.isArray(fallbackMessages)) {
        for (const m of fallbackMessages) {
            if (!m || typeof m !== 'object') continue;
            const flat = cgFlattenContent(m.content);
            rawItems.push({
                role: String(m.role || 'user').toLowerCase(),
                text: flat.text,
                hasCacheControl: flat.hasCacheControl,
                cacheControlType: flat.cacheControlType,
            });
        }
    }

    let sawChatTurn = false;
    let lastCacheBreakpointSegIdx = -1;
    const segments = rawItems.map((item, idx) => {
        const text = String(item.text || '');
        const kind = cgClassifySegmentKind(item.role, sawChatTurn);
        if (kind === 'chat') sawChatTurn = true;
        if (item.hasCacheControl) lastCacheBreakpointSegIdx = idx;
        return {
            idx,
            role: item.role,
            kind,
            text,
            len: text.length,
            tokens: cgEstimateTokens(text),
            hash: cgSampleHash(text),
            exactHash: cgFnv1aHex(text),
            preview: text.replace(/\s+/g, ' ').trim().slice(0, 100),
            hasCacheControl: Boolean(item.hasCacheControl),
            cacheControlType: item.cacheControlType || '',
        };
    });

    return { segments, lastCacheBreakpointSegIdx, providerType: providerType || 'openai_compat' };
}

function detectRemotePromptMainNarrative(segments) {
    const segs = Array.isArray(segments) ? segments : [];
    const sysCombined = segs
        .filter((s) => s && (s.kind === 'system' || s.kind === 'sys_tail'))
        .map((s) => String(s.text || ''))
        .join('\n\n');
    if (!sysCombined) return { matched: false, presetName: '' };

    if (/\[LEAVE ENGINE\b|\[LEAVE WRITING MODE\b|\[LEAVE FINAL EXECUTION CHECK\b|\[LEAVE CORE AIDE\b|\[LEAVE\s*[×x]\s*GRADIA|\[LEAVE OOC COMMITMENT LOCK/i.test(sysCombined)) {
        return { matched: true, presetName: 'Leave — Wandering Librarian Engine' };
    }

    const activeDirectId = (config && typeof config.directPresetId === 'string') ? config.directPresetId.trim() : '';
    if (activeDirectId.startsWith('custom:')) {
        const activePreset = resolveDirectPreset(activeDirectId);
        if (activePreset && Array.isArray(activePreset.promptTemplate)) {
            for (const item of activePreset.promptTemplate) {
                if (!item || typeof item !== 'object' || item.type !== 'plain' || !item.text) continue;
                const staticLine = String(item.text)
                    .replace(/\{\{[\s\S]*?\}\}/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                if (staticLine.length >= 48) {
                    const probe = staticLine.slice(0, 72);
                    if (sysCombined.replace(/\s+/g, ' ').includes(probe)) {
                        return { matched: true, presetName: String(activePreset.name || '원격 커스텀 프리셋') };
                    }
                    break;
                }
            }
        }
    }
    return { matched: false, presetName: '' };
}

function detectAuxiliaryOrSubRequest({ source, endpoint, ok, status, rawBodyObj, segments, remotePrompt = false, presetName = '' }) {
    if (source !== 'proxy' && source !== 'direct_chat' && source !== 'direct_reroll') {
        return {
            eligible: false,
            excludedReason: source === 'translate' ? 'translate' : 'non_narrative_source',
            excludedLabel: source === 'translate' ? '번역 요청' : `비서사 출처 (${source || 'llm'})`,
        };
    }
    if (!ok || (status > 0 && (status < 200 || status >= 300))) {
        return {
            eligible: false,
            excludedReason: 'http_error',
            excludedLabel: '오류 응답 (집계 제외)',
        };
    }
    if (cgIsNonChatMediaRequest(endpoint, rawBodyObj)) {
        return {
            eligible: false,
            excludedReason: 'non_chat_media',
            excludedLabel: '미디어/임베딩 요청',
        };
    }
    const segs = Array.isArray(segments) ? segments : [];
    if (segs.length === 0) {
        return {
            eligible: false,
            excludedReason: 'empty_messages',
            excludedLabel: '빈 프롬프트',
        };
    }

    const remoteMatch = detectRemotePromptMainNarrative(segs);
    if (source === 'direct_chat' || source === 'direct_reroll') {
        return {
            eligible: true,
            isRemotePrompt: Boolean(remotePrompt || remoteMatch.matched),
            mainNarrativeKind: (remotePrompt || remoteMatch.matched) ? 'remote_prompt' : 'direct_chat',
            detectedPresetName: presetName || remoteMatch.presetName || '',
            excludedReason: '',
            excludedLabel: '',
        };
    }

    if (source === 'proxy' && remoteMatch.matched) {
        return {
            eligible: true,
            isRemotePrompt: true,
            mainNarrativeKind: 'remote_prompt_proxy',
            detectedPresetName: remoteMatch.presetName || '',
            excludedReason: '',
            excludedLabel: '',
        };
    }

    const sysSegs = segs.filter((s) => s.kind === 'system');
    const chatSegs = segs.filter((s) => s.kind === 'chat');
    const sysProbe = sysSegs.map((s) => s.text.slice(0, 3500)).join('\n');
    const shortTurnProbe = chatSegs.length <= 2
        ? segs.map((s) => s.text.slice(0, 2500)).join('\n')
        : segs.map((s) => s.text.slice(0, 400)).join('\n');
    const probeText = sysProbe + '\n' + shortTurnProbe;
    const startsWithAuxDirective = /^(?:\s|[\r\n])*(?:\[?\s*hayaku\b|<hayaku\b|##\s*hayaku|FLASHBACK\s*Memory|\[?\s*flashback\b|<flashback\b|\[LBDATA|<lb-|\[StatusPanel\]|AssetMaid)/i.test(sysProbe);
    const looksMultiTurnMainChat = chatSegs.length >= 4 && !startsWithAuxDirective;

    if (!looksMultiTurnMainChat) {
        // 1) Hayaku / HypaMemory / SupaMemory / Summary requests
        if (
            /\[?\s*hayaku\b|<hayaku\b|##\s*hayaku|hayaku_|하야쿠|서사\s*요약|\[?\s*hypamemory|HypaV[23]|\[?\s*supamemory|장기\s*기억\s*요약/i.test(probeText) ||
            (/^(?:\s|[\r\n])*(?:you are (?:a|an) )?(?:helpful )?(?:ai |assistant )?(?:that |whose job is to )?summariz/im.test(sysProbe) && chatSegs.length <= 3) ||
            (/(?:summarize the following (?:conversation|chat|story|roleplay|events|messages)|write a concise summary of (?:the )?(?:story|conversation|roleplay)|다음\s*(?:대화|서사|내용)(?:을|를)\s*요약)/i.test(shortTurnProbe) && chatSegs.length <= 3)
        ) {
            return {
                eligible: false,
                excludedReason: 'hayaku',
                excludedLabel: '하야쿠 / 요약 보조 요청',
            };
        }

        // 2) Flashback Memory requests
        if (
            /FLASHBACK\s*Memory|flashback_memory|\[?\s*flashback\b|<flashback\b|##\s*flashback|플래시백|회상\s*메모리/i.test(probeText) ||
            (/(?:extract relevant memor|select relevant (?:past )?memor|retrieve relevant memor|memory retrieval|기억\s*검색|회상\s*추출)/i.test(shortTurnProbe) && chatSegs.length <= 3)
        ) {
            return {
                eligible: false,
                excludedReason: 'flashback',
                excludedLabel: '플래시백 / 기억 검색 요청',
            };
        }

        // 3) Translator prompts sent through proxy
        if (
            /(?:<translate_request|\[translation\]|translation_only|translate the following (?:text|dialogue|passage) (?:to|into)|다음\s*(?:문장|텍스트)(?:을|를)\s*(?:한국어|영어|일본어)로\s*번역)/i.test(shortTurnProbe) &&
            chatSegs.length <= 2
        ) {
            return {
                eligible: false,
                excludedReason: 'translator_prompt',
                excludedLabel: '번역 보조 요청',
            };
        }

        // 4) Other auxiliary plugins/modules (Lightboard/LBDATA, LIBRA, RETRACE, Asset Maid, Hanurai, status window updaters)
        if (
            /(?:\[LBDATA|<lb-|StatusPanel|\[StatusPanel\]|AssetMaid|asset\s*maid|hanurai|generate\s+(?:an?\s+)?(?:image\s+generation|danbooru|stable\s*diffusion|novelai)\s+prompt|삽화\s*프롬프트\s*생성|상태창\s*업데이트)/i.test(probeText)
        ) {
            return {
                eligible: false,
                excludedReason: 'plugin_aux',
                excludedLabel: '플러그인/모듈 보조 요청',
            };
        }
    }

    return {
        eligible: true,
        isRemotePrompt: false,
        mainNarrativeKind: 'proxy_narrative',
        detectedPresetName: '',
        excludedReason: '',
        excludedLabel: '',
    };
}

function buildLaneSignature(entry, segInfo, cls = null) {
    const namespace = entry.source === 'proxy' ? 'proxy' : 'direct';
    const segs = segInfo && Array.isArray(segInfo.segments) ? segInfo.segments : [];
    const sysSegs = segs.filter((s) => s.kind === 'system');
    const chatSegs = segs.filter((s) => s.kind === 'chat');
    const sysAll = sysSegs.map((s) => s.text).join('\n\n');
    const systemHash = sysAll ? cgFnv1aHex(sysAll) : 'none';
    const sysHeadHash = sysAll ? cgSampleHash(sysAll.slice(0, 512)) : '';
    const midStart = sysAll.length > 512 ? Math.max(0, Math.floor(sysAll.length / 2) - 256) : 0;
    const sysMidHash = sysAll.length > 512 ? cgSampleHash(sysAll.slice(midStart, midStart + 512)) : '';
    const sysTailHash = sysAll.length > 256 ? cgSampleHash(sysAll.slice(-512)) : '';
    const sysAnchor512 = sysAll.length >= 48 ? cgFnv1aHex(sysAll.slice(0, 512)) : '';
    const sysAnchor2048 = sysAll.length >= 256 ? cgFnv1aHex(sysAll.slice(0, 2048)) : '';
    const convSegHashes = chatSegs.filter((s) => s.len >= 24).map((s) => s.exactHash);
    const substantialConvHashes = chatSegs.filter((s) => s.len >= 80).map((s) => s.exactHash);
    const sysPreview = sysAll.replace(/\s+/g, ' ').trim().slice(0, 80);
    return {
        namespace,
        chatScopeKey: String(entry.narrativeScopeKey || ''),
        charName: String(entry.charName || ''),
        isRemotePrompt: Boolean(entry.remotePrompt || (cls && cls.isRemotePrompt)),
        presetName: String(entry.presetName || (cls && cls.detectedPresetName) || ''),
        mainNarrativeKind: String((cls && cls.mainNarrativeKind) || (namespace === 'proxy' ? 'proxy_narrative' : 'direct_chat')),
        systemHash,
        sysHeadHash,
        sysMidHash,
        sysTailHash,
        sysAnchor512,
        sysAnchor2048,
        convSegHashes,
        substantialConvHashes,
        sysPreview,
    };
}

function findMatchingMainLane(lanes, sig) {
    let bestLane = null;
    let bestScore = 0;
    for (const lane of lanes) {
        if (lane.namespace !== sig.namespace) continue;
        if (sig.chatScopeKey && lane.chatScopeKey && sig.chatScopeKey !== lane.chatScopeKey) continue;
        let score = 0;
        if (sig.chatScopeKey && lane.chatScopeKey && sig.chatScopeKey === lane.chatScopeKey) {
            score = 120;
        } else if (sig.systemHash !== 'none' && lane.systemHash === sig.systemHash) {
            // Tier 1: exact system hash match
            score = 100;
        } else {
            // Tier 2: partial system anchors (tolerates lorebook insertions / dynamic toggles)
            if (sig.sysAnchor2048 && lane.sysAnchor2048 === sig.sysAnchor2048) {
                score = Math.max(score, 90);
            } else if (sig.sysAnchor512 && lane.sysAnchor512 === sig.sysAnchor512) {
                score = Math.max(score, 80);
            } else {
                let partialHits = 0;
                if (sig.sysHeadHash && lane.sysHeadHash === sig.sysHeadHash) partialHits++;
                if (sig.sysMidHash && lane.sysMidHash === sig.sysMidHash) partialHits++;
                if (sig.sysTailHash && lane.sysTailHash === sig.sysTailHash) partialHits++;
                if (partialHits >= 2) score = Math.max(score, 75);
            }
            // Tier 3: shared conversation segment hashes
            if (sig.convSegHashes.length > 0 && lane.recentConvHashSet.size > 0) {
                let overlap = 0;
                for (const h of sig.convSegHashes) {
                    if (lane.recentConvHashSet.has(h)) overlap++;
                }
                const substantialOverlap = sig.substantialConvHashes.filter((h) => lane.recentConvHashSet.has(h)).length;
                const anchorsConflict = Boolean(sig.sysAnchor512 && lane.sysAnchor512 && sig.sysAnchor512 !== lane.sysAnchor512);
                if (overlap >= 2 || (!anchorsConflict && substantialOverlap >= 1 && overlap >= 1)) {
                    score = Math.max(score, 60 + Math.min(20, overlap));
                }
            }
        }
        if (score > bestScore || (score > 0 && score === bestScore && lane.lastTurnSeq > bestLane.lastTurnSeq)) {
            bestScore = score;
            bestLane = lane;
        }
    }
    return bestLane;
}

function cgSnippetAround(text, offset, radius = 90) {
    const s = String(text || '');
    if (!s) return '';
    const start = Math.max(0, offset - radius);
    const end = Math.min(s.length, offset + radius);
    return (start > 0 ? '...' : '') + s.slice(start, end) + (end < s.length ? '...' : '');
}

function cgFindFirstCharDiff(a, b) {
    const sa = String(a || '');
    const sb = String(b || '');
    const lim = Math.min(sa.length, sb.length);
    for (let i = 0; i < lim; i++) {
        if (sa.charCodeAt(i) !== sb.charCodeAt(i)) return i;
    }
    if (sa.length !== sb.length) return lim;
    return -1;
}

function cgLooksDynamicMemoryOrPluginDiff(prevSnippet, currSnippet) {
    const combined = `${prevSnippet || ''}\n${currSnippet || ''}`;
    return /(?:\[LBDATA|<lb-|StatusPanel|Hayaku|Flashback|currentTime|currentDate|\[?Time:|\[?Turn[:\s]|\[?Day\s+\d+|HP:|MP:|호감도|affection)/i.test(combined);
}

function cgLooksDynamicMacroDiff(prevSnippet, currSnippet) {
    const combined = `${prevSnippet || ''}\n${currSnippet || ''}`;
    return /(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}:\d{2}(?::\d{2})?|{{\s*(?:time|date|random|roll|pick|idle_duration)\b)/i.test(combined);
}

function identifyLorebookCulprit(prevSnippet, currSnippet, loreEntries) {
    if (!Array.isArray(loreEntries) || !loreEntries.length) return null;
    const prevClean = String(prevSnippet || '').trim();
    const currClean = String(currSnippet || '').trim();
    for (const entry of loreEntries) {
        if (!entry || typeof entry !== 'object') continue;
        const name = String(entry.comment || entry.key || '').trim();
        const content = String(entry.content || '').trim();
        if (!content || content.length < 16) continue;
        const needle = content.slice(0, Math.min(64, content.length));
        const inCurr = currClean.includes(needle) || (currClean.length >= 24 && content.includes(currClean.slice(0, 48)));
        const inPrev = prevClean.includes(needle) || (prevClean.length >= 24 && content.includes(prevClean.slice(0, 48)));
        if (inCurr && !inPrev) {
            return { action: 'injected', name: name || '이름 없는 로어북' };
        }
        if (inPrev && !inCurr) {
            return { action: 'removed', name: name || '이름 없는 로어북' };
        }
        if (inCurr && inPrev) {
            return { action: 'modified', name: name || '이름 없는 로어북' };
        }
    }
    return null;
}

function buildSegmentMap(segs, diffSegIdx) {
    const list = Array.isArray(segs) ? segs : [];
    const totalTokens = Math.max(1, list.reduce((acc, s) => acc + Math.max(1, Number(s.tokens || 0)), 0));
    return list.map((s) => ({
        idx: s.idx,
        role: s.role,
        kind: s.kind,
        tokens: s.tokens,
        pct: Math.round((Math.max(1, Number(s.tokens || 0)) / totalTokens) * 1000) / 10,
        status: diffSegIdx < 0 ? 'cached' : (s.idx < diffSegIdx ? 'cached' : (s.idx === diffSegIdx ? 'changed' : 'after')),
        hasCacheControl: Boolean(s.hasCacheControl),
        preview: s.preview,
    }));
}

function computePrefixDiff(prevTurn, currTurn, options = {}) {
    const prevSegs = (prevTurn && prevTurn.segments) || [];
    const currSegs = (currTurn && currTurn.segments) || [];
    const prevTotalChars = Math.max(1, prevSegs.reduce((acc, s) => acc + s.len, 0));
    let matchedChars = 0;
    let diffSegIdx = -1;
    let diffOffset = 0;

    for (let i = 0; i < prevSegs.length; i++) {
        const p = prevSegs[i];
        const c = currSegs[i];
        if (c && p.role === c.role && p.exactHash === c.exactHash) {
            matchedChars += p.len;
            continue;
        }
        diffSegIdx = i;
        if (c) {
            diffOffset = cgFindFirstCharDiff(p.text, c.text);
            if (diffOffset > 0) matchedChars += diffOffset;
        } else {
            diffOffset = 0;
        }
        break;
    }

    const prefixMatchPct = Math.max(0, Math.min(100, Math.round((matchedChars / prevTotalChars) * 1000) / 10));
    const segmentMap = buildSegmentMap(currSegs, diffSegIdx);

    if (prevTurn.model && currTurn.model && prevTurn.model !== currTurn.model) {
        return {
            prefixMatchPct,
            diffSegIdx,
            afterBreakpoint: false,
            tailShiftOnly: false,
            causeCode: 'model_changed',
            causeLabel: `모델 변경 (${prevTurn.model} → ${currTurn.model})`,
            culpritLorebook: null,
            firstDiff: {
                segIdx: diffSegIdx,
                role: diffSegIdx >= 0 ? (prevSegs[diffSegIdx]?.role || 'system') : 'system',
                offset: diffOffset,
                prevSnippet: `${prevTurn.model}`,
                currSnippet: `${currTurn.model}`,
            },
            segmentMap,
        };
    }

    if (diffSegIdx < 0) {
        return {
            prefixMatchPct: 100,
            diffSegIdx: -1,
            afterBreakpoint: false,
            tailShiftOnly: false,
            causeCode: 'intact',
            causeLabel: '프리픽스 100% 일치',
            culpritLorebook: null,
            firstDiff: null,
            segmentMap,
        };
    }

    const pSeg = prevSegs[diffSegIdx];
    const cSeg = currSegs[diffSegIdx];
    const prevSnippet = cgSnippetAround(pSeg ? pSeg.text : '', diffOffset);
    const currSnippet = cgSnippetAround(cSeg ? cSeg.text : '', diffOffset);
    const afterBreakpoint = Boolean(
        (currTurn.lastCacheBreakpointSegIdx >= 0 && diffSegIdx > currTurn.lastCacheBreakpointSegIdx) ||
        (prevTurn.lastCacheBreakpointSegIdx >= 0 && diffSegIdx > prevTurn.lastCacheBreakpointSegIdx)
    );
    const isMultiBlockTailShift = () => {
        if (diffSegIdx <= 0 || !pSeg || pSeg.kind === 'system') return false;
        if (currSegs.length <= prevSegs.length) return false;
        const prevTail = prevSegs.slice(diffSegIdx);
        if (!prevTail.length || prevTail.length > 12) return false;
        // Any assistant turn at/after diffSegIdx means an already-committed history block changed
        if (prevTail.some((s) => !s || s.role === 'assistant')) return false;
        const prevSysTails = prevTail.filter((s) => s.kind === 'sys_tail');
        if (!prevSysTails.length) return false;

        const currTail = currSegs.slice(diffSegIdx);
        // Any Author's Note / static tail note present before must remain hash-identical
        for (const pt of prevSysTails) {
            if (/^\[(?:Author's Note|LEAVE AUTHOR'S NOTE)\]/i.test(String(pt.text || ''))) {
                if (!currTail.some((ct) => ct && ct.kind === 'sys_tail' && ct.role === pt.role && ct.exactHash === pt.exactHash)) {
                    return false;
                }
            }
        }
        // Any real user turn in prevTail (excluding synthetic plugin heads like HAYAKU scene head) must shift forward intact
        const realPrevUsers = prevTail.filter((s) => s.role === 'user' && !/^\s*\[HAYAKU\b/i.test(String(s.text || '')));
        for (const pu of realPrevUsers) {
            if (!currTail.some((ct) => ct && ct.role === 'user' && ct.exactHash === pu.exactHash)) {
                return false;
            }
        }
        // Current request must still terminate with a post-history sys_tail (e.g. Leave Final / Jailbreak / Reminder)
        return currTail.some((ct) => ct && ct.kind === 'sys_tail');
    };
    const tailShiftOnly = Boolean(
        (diffSegIdx === prevSegs.length - 1 &&
            pSeg &&
            pSeg.kind === 'sys_tail' &&
            currSegs.length > prevSegs.length &&
            currSegs[currSegs.length - 1] &&
            currSegs[currSegs.length - 1].exactHash === pSeg.exactHash) ||
        isMultiBlockTailShift()
    );
    const lorebookMatch = identifyLorebookCulprit(
        pSeg ? pSeg.text.slice(Math.max(0, diffOffset - 120), diffOffset + 400) : '',
        cSeg ? cSeg.text.slice(Math.max(0, diffOffset - 120), diffOffset + 400) : '',
        options.loreEntries
    );

    let causeCode = 'prefix_changed';
    let causeLabel = '프리픽스 변경';
    if (afterBreakpoint) {
        causeCode = 'after_breakpoint';
        causeLabel = '캐시 브레이크포인트 이후 변경 (상위 캐시 유지)';
    } else if (tailShiftOnly) {
        causeCode = 'tail_post_history_shift';
        causeLabel = '후미 시스템/탈옥 블록 위치 이동 (정상 턴 증가)';
    } else if (lorebookMatch) {
        causeCode = `lorebook_${lorebookMatch.action}`;
        const actKo = lorebookMatch.action === 'injected' ? '삽입' : (lorebookMatch.action === 'removed' ? '제거' : '수정');
        causeLabel = `로어북 ${actKo}: ${lorebookMatch.name}`;
    } else if (cgLooksDynamicMemoryOrPluginDiff(prevSnippet, currSnippet)) {
        causeCode = 'dynamic_memory_or_plugin';
        causeLabel = '동적 상태창/플러그인 블록 변동';
    } else if (cgLooksDynamicMacroDiff(prevSnippet, currSnippet)) {
        causeCode = 'dynamic_macro';
        causeLabel = '동적 매크로/시간값 변동';
    } else if (pSeg && pSeg.kind === 'system') {
        causeCode = 'system_modified';
        causeLabel = '시스템 프롬프트 변경';
    } else {
        causeCode = 'history_modified';
        causeLabel = `이전 대화 세그먼트 변경 (#${diffSegIdx + 1})`;
    }

    return {
        prefixMatchPct,
        diffSegIdx,
        afterBreakpoint,
        tailShiftOnly,
        causeCode,
        causeLabel,
        culpritLorebook: lorebookMatch,
        firstDiff: {
            segIdx: diffSegIdx,
            role: pSeg ? pSeg.role : (cSeg ? cSeg.role : 'unknown'),
            kind: pSeg ? pSeg.kind : (cSeg ? cSeg.kind : 'chat'),
            offset: diffOffset,
            prevSnippet,
            currSnippet,
        },
        segmentMap,
    };
}

function buildCacheGuardSessionSummary(logs) {
    const list = Array.isArray(logs) ? logs : [];
    let totalRequests = list.length;
    let narrativeCount = 0;
    let excludedCount = 0;
    let brokenCount = 0;
    let intactCount = 0;
    let baselineCount = 0;
    let totalPromptTokens = 0;
    let totalCachedTokens = 0;
    let reportedPromptTokens = 0;
    let totalSavingsUsd = 0;
    let estimatedLossUsd = 0;
    const laneIds = new Set();
    const laneStatsMap = new Map();

    for (const item of list) {
        const cg = item && item.cacheGuard;
        if (!cg) continue;
        if (!cg.eligible) {
            excludedCount++;
            continue;
        }
        narrativeCount++;
        laneIds.add(cg.laneId);
        if (!laneStatsMap.has(cg.laneId)) {
            laneStatsMap.set(cg.laneId, {
                laneId: cg.laneId,
                laneLabel: cg.laneLabel,
                namespace: cg.namespace,
                turns: 0,
                broken: 0,
                sysPreview: cg.lanePreview || '',
            });
        }
        const ls = laneStatsMap.get(cg.laneId);
        ls.turns++;
        if (cg.verdict === 'baseline') baselineCount++;
        else if (cg.cacheBroken) {
            brokenCount++;
            ls.broken++;
        } else {
            intactCount++;
        }
        totalPromptTokens += Number(cg.promptTokens || 0);
        if (cg.serverHitPct !== null && cg.serverHitPct !== undefined) {
            reportedPromptTokens += Number(cg.promptTokens || 0);
            totalCachedTokens += Number(cg.cachedTokens || 0);
        }
        if (cg.cost && typeof cg.cost.cacheSavingsUsd === 'number') {
            totalSavingsUsd += cg.cost.cacheSavingsUsd;
        }
        if (cg.cacheBroken && cg.prevCost && typeof cg.prevCost.cacheSavingsUsd === 'number') {
            estimatedLossUsd += cg.prevCost.cacheSavingsUsd;
        }
    }

    return {
        totalRequests,
        narrativeCount,
        excludedCount,
        laneCount: laneIds.size,
        baselineCount,
        intactCount,
        brokenCount,
        avgServerHitPct: reportedPromptTokens > 0 ? Math.round((totalCachedTokens / reportedPromptTokens) * 1000) / 10 : null,
        totalPromptTokens,
        totalCachedTokens,
        totalSavingsUsd: Math.round(totalSavingsUsd * 1e6) / 1e6,
        estimatedLossUsd: Math.round(estimatedLossUsd * 1e6) / 1e6,
        lanes: Array.from(laneStatsMap.values()),
    };
}

function recomputeRequestLogsCacheGuard(logs, options = {}) {
    const list = Array.isArray(logs) ? logs : requestLogs;
    const loreEntries = options.loreEntries !== undefined
        ? options.loreEntries
        : (typeof state !== 'undefined' && state && state.baseSnapshot && state.baseSnapshot.charContext
            ? state.baseSnapshot.charContext.loreEntries
            : []);

    // Process oldest -> newest because list is newest-first
    const chronological = [...list].reverse();
    const lanes = [];
    let nextLaneSeq = 0;

    for (const item of chronological) {
        if (!item || typeof item !== 'object') continue;
        let bodyObj = item._cgRawBody || null;
        if (!bodyObj && item.requestJson) {
            try { bodyObj = JSON.parse(item.requestJson); } catch (_) { bodyObj = null; }
        }
        const segInfo = cgExtractRequestSegments(bodyObj, item.messages, item.providerType);
        const cls = detectAuxiliaryOrSubRequest({
            source: item.source,
            endpoint: item.endpoint,
            ok: item.ok,
            status: item.status,
            rawBodyObj: bodyObj,
            segments: segInfo.segments,
            remotePrompt: Boolean(item.remotePrompt),
            presetName: item.presetName || '',
        });

        if (!cls.eligible) {
            item._cgInternal = null;
            item.cacheGuard = {
                eligible: false,
                excludedReason: cls.excludedReason,
                excludedLabel: cls.excludedLabel,
            };
            continue;
        }

        const usage = item.usage || {};
        const estPromptTokens = segInfo.segments.reduce((acc, s) => acc + s.tokens, 0);
        const promptTokens = Number(usage.prompt_tokens || 0) || estPromptTokens;
        const cachedTokens = Number(usage.cached_tokens || 0);
        const cacheCreationTokens = Number(usage.cache_creation_tokens || 0);
        const cacheReported = Boolean(usage.cache_reported || cachedTokens > 0 || cacheCreationTokens > 0);
        const serverHitPct = (cacheReported && promptTokens > 0)
            ? Math.round((Math.min(promptTokens, cachedTokens) / promptTokens) * 1000) / 10
            : null;
        const minCacheTokens = cgGetMinCacheTokensForModel(item.model);
        const belowMinCacheTokens = promptTokens > 0 && promptTokens < minCacheTokens;

        const sig = buildLaneSignature(item, segInfo, cls);
        let lane = findMatchingMainLane(lanes, sig);
        if (!lane) {
            nextLaneSeq++;
            lane = {
                laneId: `${sig.namespace}-lane-${nextLaneSeq}`,
                laneNumber: nextLaneSeq,
                laneLabel: sig.charName ? `그룹 #${nextLaneSeq} · ${sig.charName}` : `그룹 #${nextLaneSeq}`,
                namespace: sig.namespace,
                chatScopeKey: sig.chatScopeKey,
                charName: sig.charName,
                isRemotePrompt: sig.isRemotePrompt,
                presetName: sig.presetName,
                systemHash: sig.systemHash,
                sysHeadHash: sig.sysHeadHash,
                sysMidHash: sig.sysMidHash,
                sysTailHash: sig.sysTailHash,
                sysAnchor512: sig.sysAnchor512,
                sysAnchor2048: sig.sysAnchor2048,
                sysPreview: sig.sysPreview,
                recentConvHashSet: new Set(sig.convSegHashes),
                lastTurnSeq: 0,
                turns: [],
            };
            lanes.push(lane);
        } else {
            // Update rolling hash set for multi-turn continuity
            for (const h of sig.convSegHashes) lane.recentConvHashSet.add(h);
            if (lane.systemHash === 'none' && sig.systemHash !== 'none') lane.systemHash = sig.systemHash;
            if (!lane.sysAnchor512 && sig.sysAnchor512) lane.sysAnchor512 = sig.sysAnchor512;
            if (!lane.sysAnchor2048 && sig.sysAnchor2048) lane.sysAnchor2048 = sig.sysAnchor2048;
            if (!lane.isRemotePrompt && sig.isRemotePrompt) lane.isRemotePrompt = true;
            if (!lane.presetName && sig.presetName) lane.presetName = sig.presetName;
            if (!lane.charName && sig.charName) {
                lane.charName = sig.charName;
                lane.laneLabel = `그룹 #${lane.laneNumber} · ${sig.charName}`;
            }
        }

        const prevTurn = lane.turns.length > 0 ? lane.turns[lane.turns.length - 1] : null;
        const turnIndex = lane.turns.length + 1;
        lane.lastTurnSeq++;

        const cost = cgEstimateTurnCost(item.model, {
            prompt_tokens: promptTokens,
            completion_tokens: Number(usage.completion_tokens || 0),
            cached_tokens: cachedTokens,
            cache_creation_tokens: cacheCreationTokens,
        });

        let cacheGuard;
        if (!prevTurn) {
            cacheGuard = {
                eligible: true,
                namespace: sig.namespace,
                isRemotePrompt: Boolean(sig.isRemotePrompt || lane.isRemotePrompt),
                mainNarrativeKind: sig.mainNarrativeKind,
                presetName: sig.presetName || lane.presetName || '',
                charName: sig.charName || lane.charName || '',
                laneId: lane.laneId,
                laneNumber: lane.laneNumber,
                laneLabel: lane.laneLabel,
                lanePreview: lane.sysPreview,
                turnIndex,
                prevLogId: null,
                verdict: 'baseline',
                verdictLabel: '기준선 (첫 턴)',
                cacheBroken: false,
                prefixMatchPct: null,
                serverHitPct,
                cachedTokens,
                cacheCreationTokens,
                promptTokens,
                minCacheTokens,
                belowMinCacheTokens,
                causeCode: 'baseline',
                causeLabel: (sig.isRemotePrompt || lane.isRemotePrompt)
                    ? '원격 프롬프트 메인 서사 그룹의 첫 턴입니다.'
                    : '그룹의 첫 서사 요청입니다.',
                afterBreakpoint: false,
                tailShiftOnly: false,
                culpritLorebook: null,
                firstDiff: null,
                segmentMap: buildSegmentMap(segInfo.segments, -1),
                cost,
                prevCost: null,
            };
        } else {
            const diff = computePrefixDiff(prevTurn, {
                model: item.model,
                segments: segInfo.segments,
                lastCacheBreakpointSegIdx: segInfo.lastCacheBreakpointSegIdx,
            }, { loreEntries });

            const structuralBreak = diff.causeCode === 'model_changed' ||
                (diff.prefixMatchPct < 98 && !diff.afterBreakpoint && !diff.tailShiftOnly);
            const serverMissOnIntact = !structuralBreak &&
                !belowMinCacheTokens &&
                cacheReported &&
                cachedTokens === 0 &&
                (prevTurn.cachedTokens > 0 || prevTurn.cacheCreationTokens > 0 || (serverHitPct === 0 && prevTurn.promptTokens >= minCacheTokens));
            const cacheBroken = Boolean(structuralBreak || serverMissOnIntact);

            let verdict = 'ok';
            let verdictLabel = '캐시 유지';
            let causeCode = diff.causeCode;
            let causeLabel = diff.causeLabel;
            if (cacheBroken) {
                verdict = 'broken';
                verdictLabel = '캐시 깨짐';
                if (serverMissOnIntact && !structuralBreak) {
                    causeCode = 'server_cache_miss';
                    causeLabel = '프리픽스 동일하나 서버 KV 캐시 미스 (TTL 만료 또는 라우팅 변경)';
                }
            } else if (serverHitPct !== null && serverHitPct > 0) {
                verdictLabel = `캐시 적중 ${serverHitPct}%`;
            }

            cacheGuard = {
                eligible: true,
                namespace: sig.namespace,
                isRemotePrompt: Boolean(sig.isRemotePrompt || lane.isRemotePrompt),
                mainNarrativeKind: sig.mainNarrativeKind,
                presetName: sig.presetName || lane.presetName || '',
                charName: sig.charName || lane.charName || '',
                laneId: lane.laneId,
                laneNumber: lane.laneNumber,
                laneLabel: lane.laneLabel,
                lanePreview: lane.sysPreview,
                turnIndex,
                prevLogId: prevTurn.logId,
                verdict,
                verdictLabel,
                cacheBroken,
                prefixMatchPct: diff.prefixMatchPct,
                serverHitPct,
                cachedTokens,
                cacheCreationTokens,
                promptTokens,
                minCacheTokens,
                belowMinCacheTokens,
                causeCode,
                causeLabel,
                afterBreakpoint: diff.afterBreakpoint,
                tailShiftOnly: diff.tailShiftOnly,
                culpritLorebook: diff.culpritLorebook,
                firstDiff: diff.firstDiff,
                segmentMap: diff.segmentMap,
                cost,
                prevCost: prevTurn.cost || null,
            };
        }

        item._cgInternal = null;
        item.cacheGuard = cacheGuard;
        lane.turns.push({
            logId: item.id,
            model: item.model,
            segments: segInfo.segments,
            lastCacheBreakpointSegIdx: segInfo.lastCacheBreakpointSegIdx,
            promptTokens,
            cachedTokens,
            cacheCreationTokens,
            cost,
        });
    }

    return buildCacheGuardSessionSummary(list);
}

function summarizeCacheGuardForList(cg) {
    if (!cg || typeof cg !== 'object') return null;
    if (!cg.eligible) {
        return {
            eligible: false,
            excludedReason: cg.excludedReason || '',
            excludedLabel: cg.excludedLabel || '',
        };
    }
    return {
        eligible: true,
        namespace: cg.namespace,
        isRemotePrompt: Boolean(cg.isRemotePrompt),
        mainNarrativeKind: cg.mainNarrativeKind || '',
        presetName: cg.presetName || '',
        charName: cg.charName || '',
        laneId: cg.laneId,
        laneNumber: cg.laneNumber,
        laneLabel: cg.laneLabel,
        turnIndex: cg.turnIndex,
        prevLogId: cg.prevLogId,
        verdict: cg.verdict,
        verdictLabel: cg.verdictLabel,
        cacheBroken: Boolean(cg.cacheBroken),
        prefixMatchPct: cg.prefixMatchPct,
        serverHitPct: cg.serverHitPct,
        cachedTokens: cg.cachedTokens,
        promptTokens: cg.promptTokens,
        belowMinCacheTokens: Boolean(cg.belowMinCacheTokens),
        causeCode: cg.causeCode,
        causeLabel: cg.causeLabel,
        cost: cg.cost,
    };
}

function serializeRequestLogDetail(entry) {
    if (!entry || typeof entry !== 'object') return entry;
    const { _cgRawBody: _omitBody, _cgRawUsage: _omitUsage, _cgInternal: _omitInternal, ...rest } = entry;
    return rest;
}

function recordRequestLog(entry) {
    const item = {
        id: `req-${++requestLogSeq}-${crypto.randomBytes(3).toString('hex')}`,
        at: new Date().toISOString(),
        source: entry.source || 'llm',
        remotePrompt: Boolean(entry.remotePrompt),
        presetId: entry.presetId || '',
        presetName: entry.presetName || '',
        narrativeScopeKey: entry.narrativeScopeKey || '',
        charName: entry.charName || '',
        profileName: entry.profileName || '',
        providerType: entry.providerType || 'openai_compat',
        model: entry.model || '',
        endpoint: entry.endpoint || '',
        stream: Boolean(entry.stream),
        status: Number(entry.status || 0),
        ok: Boolean(entry.ok),
        durationMs: Math.max(0, Number(entry.durationMs || 0)),
        msgCount: Math.max(0, Number(entry.msgCount || 0)),
        usage: entry.usage || mapUsageToOpenAI(null),
        headers: entry.headers || {},
        messages: Array.isArray(entry.messages) ? entry.messages : [],
        _cgRawBody: entry.rawBodyObj && typeof entry.rawBodyObj === 'object' ? entry.rawBodyObj : null,
        _cgRawUsage: entry.rawUsageObj && typeof entry.rawUsageObj === 'object' ? entry.rawUsageObj : null,
        requestJson: entry.requestJson || '',
        responseText: entry.responseText || '',
        responseJson: entry.responseJson || '',
        error: entry.error || '',
        cacheGuard: null,
    };
    requestLogs.unshift(item);
    if (requestLogs.length > REQUEST_LOG_MAX) {
        requestLogs.length = REQUEST_LOG_MAX;
    }
    recomputeRequestLogsCacheGuard(requestLogs);
    return item;
}

function summarizeRequestLog(entry) {
    const previewSrc = entry.error ? `오류: ${entry.error}` : (entry.responseText || '');
    const responsePreview = String(previewSrc).replace(/\s+/g, ' ').trim().slice(0, 160);
    return {
        id: entry.id,
        at: entry.at,
        source: entry.source,
        remotePrompt: Boolean(entry.remotePrompt),
        presetId: entry.presetId || '',
        presetName: entry.presetName || '',
        narrativeScopeKey: entry.narrativeScopeKey || '',
        charName: entry.charName || '',
        profileName: entry.profileName,
        providerType: entry.providerType,
        model: entry.model,
        endpoint: entry.endpoint,
        stream: entry.stream,
        status: entry.status,
        ok: entry.ok,
        durationMs: entry.durationMs,
        msgCount: entry.msgCount,
        usage: entry.usage,
        error: entry.error,
        responsePreview,
        cacheGuard: summarizeCacheGuardForList(entry.cacheGuard),
    };
}

async function callLLMNonStream(profile, messages, extraOpts = {}) {
    if (!profile) throw new Error('활성화된 모델 프로필이 없습니다. [모델/번역] 탭에서 프로필을 선택하세요.');

    const startedAt = Date.now();
    const source = extraOpts.source || 'llm';
    const wantStreamFlag = Boolean(extraOpts.stream);
    const remotePromptFlag = Boolean(extraOpts.remotePrompt);
    const presetIdVal = String(extraOpts.presetId || '');
    const presetNameVal = String(extraOpts.presetName || '');
    const narrativeScopeKeyVal = String(extraOpts.narrativeScopeKey || '');
    const charNameVal = String(extraOpts.charName || '');
    const logMetaFields = {
        remotePrompt: remotePromptFlag,
        presetId: presetIdVal,
        presetName: presetNameVal,
        narrativeScopeKey: narrativeScopeKeyVal,
        charName: charNameVal,
    };
    let logEndpoint = profile.baseUrl || '';
    let logHeaders = {};
    let logBodyObj = null;
    let logStatus = 0;
    let logRespData = null;
    let logModel = profile.model || '';

    const tempVal = extraOpts.forceTemperature !== undefined
        ? extraOpts.forceTemperature
        : (parseOptionalNumber(profile.temperature) ?? parseOptionalNumber(extraOpts.temperature) ?? parseOptionalNumber(extraOpts.presetTemperature));
    const maxTokVal = extraOpts.forceMaxTokens !== undefined
        ? extraOpts.forceMaxTokens
        : (parseOptionalNumber(profile.maxTokens) ?? parseOptionalNumber(extraOpts.maxTokens) ?? parseOptionalNumber(extraOpts.presetMaxTokens));
    const timeoutMs = Number(extraOpts.timeoutMs) || 180000;
    const { signal, cleanup } = createTimeoutSignal(timeoutMs, extraOpts.signal);

    try {
        if (!profile.apiKey && profile.providerType !== 'openai_compat') {
            throw new Error(`프로필 "${profile.name}"의 API 키가 비어 있습니다.`);
        }

        if (profile.providerType === 'anthropic') {
            const { sysParts, sysBlocks, turns, turnCachePoints } = normalizeTurnMessages(messages, { assistantRole: 'assistant', ensureUserFirst: true });
            const hasCachePoints = sysBlocks.some((b) => b.cachePoint) || turnCachePoints.some(Boolean);
            let anthropicMessages = turns.map((t) => ({ role: t.role, content: t.text }));
            let anthropicSystem = sysParts.length ? sysParts.join('\n\n') : undefined;
            if (hasCachePoints) {
                // Anthropic allows up to 4 ephemeral cache_control breakpoints per request; retain the last 4 marks
                const allMarked = [];
                sysBlocks.forEach((b, i) => { if (b.cachePoint) allMarked.push(`s:${i}`); });
                turnCachePoints.forEach((cp, i) => { if (cp) allMarked.push(`t:${i}`); });
                const activeSet = new Set(allMarked.slice(-4));
                if (sysBlocks.length) {
                    const collapsedSys = [];
                    for (let i = 0; i < sysBlocks.length; i += 1) {
                        const sb = sysBlocks[i];
                        const isBp = activeSet.has(`s:${i}`);
                        const prev = collapsedSys[collapsedSys.length - 1];
                        if (prev && !prev.cache_control && !isBp) {
                            prev.text += `\n\n${sb.text}`;
                        } else {
                            collapsedSys.push({
                                type: 'text',
                                text: sb.text,
                                ...(isBp ? { cache_control: { type: 'ephemeral' } } : {}),
                            });
                        }
                    }
                    anthropicSystem = collapsedSys;
                }
                anthropicMessages = turns.map((t, i) => (
                    activeSet.has(`t:${i}`)
                        ? { role: t.role, content: [{ type: 'text', text: t.text, cache_control: { type: 'ephemeral' } }] }
                        : { role: t.role, content: t.text }
                ));
            }
            let body = {
                model: profile.model,
                max_tokens: maxTokVal || 4096,
                messages: anthropicMessages,
            };
            if (anthropicSystem !== undefined) body.system = anthropicSystem;
            if (tempVal !== undefined) body.temperature = tempVal;
            if (typeof extraOpts.interceptBody === 'function') {
                body = (await extraOpts.interceptBody(body, 'anthropic')) || body;
            }

            logEndpoint = profile.baseUrl || 'https://api.anthropic.com/v1/messages';
            logHeaders = {
                'Content-Type': 'application/json',
                'x-api-key': profile.apiKey,
                'anthropic-version': '2023-06-01',
            };
            logBodyObj = body;

            const resp = await fetch(logEndpoint, {
                method: 'POST',
                headers: logHeaders,
                body: JSON.stringify(body),
                signal,
            });
            logStatus = resp.status;
            const data = await resp.json().catch(() => ({}));
            logRespData = data;
            if (!resp.ok) throw new Error(data.error?.message || `Anthropic HTTP ${resp.status}`);
            const out = Array.isArray(data.content) ? data.content.map((b) => b.text || '').join('') : '';
            logModel = data.model || profile.model || '';
            recordRequestLog({
                source,
                ...logMetaFields,
                profileName: profile.name || '',
                providerType: profile.providerType,
                model: logModel,
                endpoint: logEndpoint,
                stream: wantStreamFlag,
                status: resp.status,
                ok: true,
                durationMs: Date.now() - startedAt,
                msgCount: Array.isArray(messages) ? messages.length : 0,
                usage: mapUsageToOpenAI(data.usage || null),
                headers: sanitizeLogHeaders(logHeaders),
                messages: sanitizeLogMessages(messages),
                rawBodyObj: body,
                rawUsageObj: data.usage || null,
                requestJson: safeJsonForLog(body, REQUEST_LOG_BODY_CHAR_LIMIT),
                responseText: truncateLogText(out, REQUEST_LOG_RESP_CHAR_LIMIT),
                responseJson: safeJsonForLog(data, REQUEST_LOG_RESP_CHAR_LIMIT),
                error: '',
            });
            return { text: out, model: logModel, usage: data.usage || null };
        }

        if (profile.providerType === 'gemini') {
            const base = (profile.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
            const endpoint = `${base}/models/${encodeURIComponent(profile.model)}:generateContent`;
            const { sysParts, turns } = normalizeTurnMessages(messages, { assistantRole: 'model', ensureUserFirst: false });
            const contents = turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] }));
            let body = { contents };
            if (sysParts.length) body.systemInstruction = { parts: [{ text: sysParts.join('\n\n') }] };
            const genCfg = {};
            if (tempVal !== undefined) genCfg.temperature = tempVal;
            if (maxTokVal !== undefined) genCfg.maxOutputTokens = maxTokVal;
            if (Object.keys(genCfg).length) body.generationConfig = genCfg;
            if (typeof extraOpts.interceptBody === 'function') {
                body = (await extraOpts.interceptBody(body, 'gemini')) || body;
            }

            logEndpoint = endpoint;
            logHeaders = {
                'Content-Type': 'application/json',
                'x-goog-api-key': profile.apiKey,
            };
            logBodyObj = body;

            const resp = await fetch(endpoint, {
                method: 'POST',
                headers: logHeaders,
                body: JSON.stringify(body),
                signal,
            });
            logStatus = resp.status;
            const data = await resp.json().catch(() => ({}));
            logRespData = data;
            if (!resp.ok) throw new Error(data.error?.message || `Gemini HTTP ${resp.status}`);
            const parts = data.candidates?.[0]?.content?.parts || [];
            const out = parts.map((p) => p.text || '').join('');
            recordRequestLog({
                source,
                ...logMetaFields,
                profileName: profile.name || '',
                providerType: profile.providerType,
                model: profile.model || '',
                endpoint,
                stream: wantStreamFlag,
                status: resp.status,
                ok: true,
                durationMs: Date.now() - startedAt,
                msgCount: Array.isArray(messages) ? messages.length : 0,
                usage: mapUsageToOpenAI(data.usageMetadata || null),
                headers: sanitizeLogHeaders(logHeaders),
                messages: sanitizeLogMessages(messages),
                rawBodyObj: body,
                rawUsageObj: data.usageMetadata || null,
                requestJson: safeJsonForLog(body, REQUEST_LOG_BODY_CHAR_LIMIT),
                responseText: truncateLogText(out, REQUEST_LOG_RESP_CHAR_LIMIT),
                responseJson: safeJsonForLog(data, REQUEST_LOG_RESP_CHAR_LIMIT),
                error: '',
            });
            return { text: out, model: profile.model, usage: data.usageMetadata || null };
        }

        // Default: OpenAI-Compatible
        const endpoint = profile.baseUrl || 'https://api.openai.com/v1/chat/completions';
        const headers = { 'Content-Type': 'application/json' };
        if (profile.apiKey) headers['Authorization'] = `Bearer ${profile.apiKey}`;
        if (endpoint.includes('openrouter.ai')) {
            headers['HTTP-Referer'] = `http://localhost:${PORT}`;
            headers['X-Title'] = 'RisuStand Remote';
        }

        let body = {
            model: profile.model,
            messages: (Array.isArray(messages) ? messages : []).map(({ memo: _omitMemo, data: _omitData, _cachePoint: _omitCP, ...rest }) => rest),
            stream: false,
        };
        if (tempVal !== undefined) body.temperature = tempVal;
        if (maxTokVal !== undefined) body.max_tokens = maxTokVal;
        if (typeof extraOpts.interceptBody === 'function') {
            body = (await extraOpts.interceptBody(body, 'openai')) || body;
        }

        logEndpoint = endpoint;
        logHeaders = headers;
        logBodyObj = body;

        const resp = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal,
        });
        logStatus = resp.status;
        const data = await resp.json().catch(() => ({}));
        logRespData = data;
        if (!resp.ok) throw new Error(data.error?.message || `Upstream HTTP ${resp.status}`);
        const out = data.choices?.[0]?.message?.content || '';
        logModel = data.model || profile.model || '';
        recordRequestLog({
            source,
            ...logMetaFields,
            profileName: profile.name || '',
            providerType: profile.providerType || 'openai_compat',
            model: logModel,
            endpoint,
            stream: wantStreamFlag,
            status: resp.status,
            ok: true,
            durationMs: Date.now() - startedAt,
            msgCount: Array.isArray(messages) ? messages.length : 0,
            usage: mapUsageToOpenAI(data.usage || null),
            headers: sanitizeLogHeaders(headers),
            messages: sanitizeLogMessages(messages),
            rawBodyObj: body,
            rawUsageObj: data.usage || null,
            requestJson: safeJsonForLog(body, REQUEST_LOG_BODY_CHAR_LIMIT),
            responseText: truncateLogText(out, REQUEST_LOG_RESP_CHAR_LIMIT),
            responseJson: safeJsonForLog(data, REQUEST_LOG_RESP_CHAR_LIMIT),
            error: '',
        });
        return { text: out, model: logModel, usage: data.usage || null };
    } catch (err) {
        recordRequestLog({
            source,
            ...logMetaFields,
            profileName: profile.name || '',
            providerType: profile.providerType || 'openai_compat',
            model: logModel,
            endpoint: logEndpoint,
            stream: wantStreamFlag,
            status: logStatus,
            ok: false,
            durationMs: Date.now() - startedAt,
            msgCount: Array.isArray(messages) ? messages.length : 0,
            usage: mapUsageToOpenAI(null),
            headers: sanitizeLogHeaders(logHeaders),
            messages: sanitizeLogMessages(messages),
            rawBodyObj: logBodyObj,
            rawUsageObj: null,
            requestJson: logBodyObj ? safeJsonForLog(logBodyObj, REQUEST_LOG_BODY_CHAR_LIMIT) : '',
            responseText: '',
            responseJson: logRespData ? safeJsonForLog(logRespData, REQUEST_LOG_RESP_CHAR_LIMIT) : '',
            error: err && err.message ? err.message : String(err),
        });
        throw err;
    } finally {
        cleanup();
    }
}

async function handleOpenAIProxy(req, res) {
    const clientAbort = new AbortController();
    const onReqAborted = () => {
        if (!res.writableEnded) clientAbort.abort(new Error('Client disconnected'));
    };
    const onResClose = () => {
        if (!res.writableEnded) clientAbort.abort(new Error('Client disconnected'));
    };
    req.on('aborted', onReqAborted);
    res.on('close', onResClose);
    try {
        const raw = await readBody(req);
        const reqBody = JSON.parse(raw || '{}');
        const profile = getActiveProfile();
        if (!profile) {
            return sendJson(res, 400, {
                error: {
                    message: 'RisuStand 릴레이 라우터에 활성화된 모델 프로필이 없습니다. 모바일 [모델/번역] 탭에서 프로필을 선택해 주세요.',
                    type: 'configuration_error',
                },
            }, req);
        }

        const messages = applyPromptOverride(reqBody.messages || [], profile);
        const wantStream = Boolean(reqBody.stream);
        console.log(`[Router] ${profile.name} (${profile.providerType}:${profile.model}) | msgs=${messages.length} | stream=${wantStream}`);

        // Fast-path passthrough for OpenAI-compatible streaming
        if (wantStream && profile.providerType === 'openai_compat') {
            const endpoint = profile.baseUrl || 'https://api.openai.com/v1/chat/completions';
            const headers = { 'Content-Type': 'application/json' };
            if (profile.apiKey) headers['Authorization'] = `Bearer ${profile.apiKey}`;
            if (endpoint.includes('openrouter.ai')) {
                headers['HTTP-Referer'] = `http://localhost:${PORT}`;
                headers['X-Title'] = 'RisuStand Remote';
            }
            const upBody = {
                ...reqBody,
                model: profile.model,
                messages,
                stream: true,
            };
            const profTemp = parseOptionalNumber(profile.temperature);
            const profMaxTok = parseOptionalNumber(profile.maxTokens);
            if (profTemp !== undefined) upBody.temperature = profTemp;
            if (profMaxTok !== undefined) upBody.max_tokens = profMaxTok;

            const startedAt = Date.now();
            const { signal, cleanup } = createTimeoutSignal(180000, clientAbort.signal);
            let reader = null;
            let upStatus = 0;
            let logged = false;
            let streamText = '';
            let streamTruncated = false;
            let streamUsage = null;
            let streamModel = profile.model || '';
            let sseBuf = '';
            let aborted = false;
            let streamErr = '';
            try {
                const upRes = await fetch(endpoint, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(upBody),
                    signal,
                });
                upStatus = upRes.status;

                if (!upRes.ok || !upRes.body) {
                    const errText = await upRes.text().catch(() => '');
                    const errMsg = errText || `Upstream HTTP ${upRes.status}`;
                    logged = true;
                    recordRequestLog({
                        source: 'proxy',
                        profileName: profile.name || '',
                        providerType: profile.providerType || 'openai_compat',
                        model: streamModel,
                        endpoint,
                        stream: true,
                        status: upRes.status || 502,
                        ok: false,
                        durationMs: Date.now() - startedAt,
                        msgCount: Array.isArray(messages) ? messages.length : 0,
                        usage: mapUsageToOpenAI(null),
                        headers: sanitizeLogHeaders(headers),
                        messages: sanitizeLogMessages(messages),
                        rawBodyObj: upBody,
                        rawUsageObj: null,
                        requestJson: safeJsonForLog(upBody, REQUEST_LOG_BODY_CHAR_LIMIT),
                        responseText: truncateLogText(errText, REQUEST_LOG_RESP_CHAR_LIMIT),
                        responseJson: '',
                        error: errMsg,
                    });
                    return sendJson(res, upRes.status || 502, {
                        error: { message: errMsg, type: 'upstream_error' },
                    }, req);
                }

                res.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    ...corsHeaders(req),
                });

                reader = upRes.body.getReader();
                const decoder = new TextDecoder('utf-8');
                const processSseLine = (line) => {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) return;
                    const payload = trimmed.slice(5).trim();
                    if (!payload || payload === '[DONE]') return;
                    try {
                        const parsed = JSON.parse(payload);
                        if (parsed.model) streamModel = parsed.model;
                        const uObj = parsed.usage || parsed.usageMetadata || (parsed.message && parsed.message.usage) || null;
                        if (uObj) streamUsage = mergeStreamUsage(streamUsage, uObj);
                        const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
                        const delta = choice && choice.delta ? choice.delta : null;
                        const piece = delta ? (delta.content || delta.reasoning_content || '') : '';
                        if (piece) {
                            if (streamText.length < REQUEST_LOG_RESP_CHAR_LIMIT) {
                                const remain = REQUEST_LOG_RESP_CHAR_LIMIT - streamText.length;
                                streamText += piece.length > remain ? piece.slice(0, remain) : piece;
                                if (piece.length > remain) streamTruncated = true;
                            } else {
                                streamTruncated = true;
                            }
                        }
                    } catch (_) {}
                };
                while (true) {
                    if (res.writableEnded || res.destroyed || clientAbort.signal.aborted) {
                        aborted = true;
                        await reader.cancel().catch(() => {});
                        break;
                    }
                    const { done, value } = await reader.read();
                    if (done) break;
                    sseBuf += decoder.decode(value, { stream: true });
                    let nl = sseBuf.indexOf('\n');
                    while (nl !== -1) {
                        processSseLine(sseBuf.slice(0, nl));
                        sseBuf = sseBuf.slice(nl + 1);
                        nl = sseBuf.indexOf('\n');
                    }
                    if (!res.writableEnded && !res.destroyed) {
                        res.write(Buffer.from(value));
                    }
                }
                sseBuf += decoder.decode();
                if (sseBuf) processSseLine(sseBuf);
                if (!res.writableEnded && !res.destroyed) res.end();
                return;
            } catch (err) {
                streamErr = err && err.message ? err.message : String(err);
                throw err;
            } finally {
                cleanup();
                if (!logged) {
                    logged = true;
                    const respFull = streamTruncated
                        ? `${streamText}\n... [stream preview truncated]`
                        : streamText;
                    recordRequestLog({
                        source: 'proxy',
                        profileName: profile.name || '',
                        providerType: profile.providerType || 'openai_compat',
                        model: streamModel,
                        endpoint,
                        stream: true,
                        status: upStatus || 0,
                        ok: !streamErr && !aborted && upStatus >= 200 && upStatus < 300,
                        durationMs: Date.now() - startedAt,
                        msgCount: Array.isArray(messages) ? messages.length : 0,
                        usage: mapUsageToOpenAI(streamUsage),
                        headers: sanitizeLogHeaders(headers),
                        messages: sanitizeLogMessages(messages),
                        rawBodyObj: upBody,
                        rawUsageObj: streamUsage,
                        requestJson: safeJsonForLog(upBody, REQUEST_LOG_BODY_CHAR_LIMIT),
                        responseText: respFull,
                        responseJson: '',
                        error: streamErr || (aborted ? 'Client disconnected' : ''),
                    });
                }
            }
        }

        // Universal call (works for Anthropic, Gemini, and non-stream OpenAI)
        const result = await callLLMNonStream(profile, messages, {
            temperature: reqBody.temperature,
            maxTokens: reqBody.max_tokens,
            signal: clientAbort.signal,
            source: 'proxy',
            stream: wantStream,
        });

        const id = 'chatcmpl-' + crypto.randomBytes(8).toString('hex');
        const created = Math.floor(Date.now() / 1000);

        if (wantStream) {
            if (res.writableEnded || res.destroyed) return;
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                ...corsHeaders(req),
            });
            const chunk = {
                id,
                object: 'chat.completion.chunk',
                created,
                model: result.model,
                choices: [{ index: 0, delta: { role: 'assistant', content: result.text }, finish_reason: null }],
            };
            const endChunk = {
                id,
                object: 'chat.completion.chunk',
                created,
                model: result.model,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            res.write(`data: ${JSON.stringify(endChunk)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }

        return sendJson(res, 200, {
            id,
            object: 'chat.completion',
            created,
            model: result.model,
            choices: [
                {
                    index: 0,
                    message: { role: 'assistant', content: result.text },
                    finish_reason: 'stop',
                },
            ],
            usage: mapUsageToOpenAI(result.usage),
        }, req);
    } catch (e) {
        if (clientAbort.signal.aborted && (res.writableEnded || res.destroyed)) return;
        console.error('[Router Error]', e.message);
        if (!res.headersSent) {
            return sendJson(res, 502, {
                error: { message: e.message || 'Proxy router error', type: 'proxy_error' },
            }, req);
        }
        if (!res.writableEnded && !res.destroyed) res.end();
    } finally {
        req.off('aborted', onReqAborted);
        res.off('close', onResClose);
    }
}

// ================= Translator Core =================
async function translateText(text, direction = 'to_target') {
    const clean = String(text || '').trim();
    if (!clean) return '';
    const cacheKey = `${direction}:${crypto.createHash('sha1').update(clean).digest('hex')}`;
    if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

    const tr = config.translator || {};
    let profile = null;
    if (tr.useActiveProfile) {
        profile = getActiveProfile();
    } else {
        profile = {
            name: 'Translator',
            providerType: tr.providerType || 'gemini',
            baseUrl: tr.baseUrl || '',
            apiKey: tr.apiKey || '',
            model: tr.model || 'gemini-2.5-flash',
            temperature: 0.2,
            maxTokens: 2048,
        };
    }

    if (!profile) {
        throw new Error('번역에 사용할 모델이 설정되지 않았습니다. [모델/번역] 탭에서 모델 프로필 또는 번역기 키를 설정하세요.');
    }

    const sysPrompt = direction === 'to_en'
        ? (tr.inputPrompt || 'Translate the following Korean text naturally into English. Output ONLY the translation.')
        : (tr.prompt || `Translate the following text naturally into ${tr.targetLang || 'Korean'}. Output ONLY the translation.`);

    const res = await callLLMNonStream(profile, [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: clean },
    ], { forceTemperature: 0.2, timeoutMs: 60000, source: 'translate' });

    const out = String(res.text || '').trim();
    if (out) {
        if (translationCache.size > 400) translationCache.clear();
        translationCache.set(cacheKey, out);
    }
    return out;
}

// ================= RisuAI Preset CBS Evaluator & Prompt Builder =================
function parsePresetDefaultToggles(toggleSyntax = '', defaultVariablesText = '') {
    const out = {};
    const assignToggle = (rawKey, val) => {
        const k = String(rawKey || '').trim();
        if (!k) return;
        const fullKey = k.startsWith('toggle_') ? k : `toggle_${k}`;
        const v = String(val ?? '');
        out[k] = v;
        out[fullKey] = v;
    };
    for (const rawLine of String(toggleSyntax || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('//') || line.startsWith('#') || line.startsWith('=group') || line.startsWith('=divider')) {
            continue;
        }
        const parts = line.split('=');
        if (parts.length < 2) continue;
        const key = (parts[0] || '').trim();
        if (!key || key.startsWith('=')) continue;
        const kind = (parts[2] || '').trim().toLowerCase();
        if (kind === 'caption' || kind === 'group' || kind === 'groupend' || kind === 'divider') continue;
        const defVal = (kind === 'text' || kind === 'textarea') ? '' : '0';
        assignToggle(key, defVal);
    }
    for (const rawLine of String(defaultVariablesText || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('//')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        assignToggle(key, val);
    }
    return out;
}

function isCbsTruthy(val) {
    const s = String(val ?? '').trim().toLowerCase();
    return Boolean(s) && s !== '0' && s !== 'false' && s !== 'null' && s !== 'undefined' && s !== 'nan';
}

function findMatchingCbsClose(str, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < str.length - 1; i += 1) {
        if (str[i] === '{' && str[i + 1] === '{') {
            depth += 1;
            i += 1;
        } else if (str[i] === '}' && str[i + 1] === '}') {
            depth -= 1;
            if (depth === 0) return i;
            i += 1;
        }
    }
    return -1;
}

function splitCbsTopLevelArgs(inner) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < inner.length - 1; i += 1) {
        if (inner[i] === '{' && inner[i + 1] === '{') {
            depth += 1;
            i += 1;
        } else if (inner[i] === '}' && inner[i + 1] === '}') {
            if (depth > 0) depth -= 1;
            i += 1;
        } else if (depth === 0 && inner[i] === ':' && inner[i + 1] === ':') {
            parts.push(inner.slice(start, i));
            i += 1;
            start = i + 1;
        }
    }
    parts.push(inner.slice(start));
    return parts;
}

function findMatchingCbsIfEnd(str, startIdx) {
    let blockDepth = 0;
    let elseStart = -1;
    let elseEnd = -1;
    let i = startIdx;
    while (i < str.length - 1) {
        const openIdx = str.indexOf('{{', i);
        if (openIdx < 0) break;
        const closeIdx = findMatchingCbsClose(str, openIdx);
        if (closeIdx < 0) break;
        const tagInner = str.slice(openIdx + 2, closeIdx).trim();
        if (/^#(?:if(?:_pure)?|when|each|func|pure(?:_?display)?|escape)(?:[\s:]|$)/i.test(tagInner)) {
            blockDepth += 1;
        } else if (tagInner.startsWith('/') && !tagInner.startsWith('//')) {
            if (blockDepth === 0) {
                return { elseStart, elseEnd, endStart: openIdx, endClose: closeIdx };
            }
            blockDepth -= 1;
        } else if (blockDepth === 0 && /^:else\s*$/i.test(tagInner) && elseStart < 0) {
            elseStart = openIdx;
            elseEnd = closeIdx + 2;
        }
        i = closeIdx + 2;
    }
    return null;
}

function findMatchingCbsBlockEnd(str, startIdx) {
    let blockDepth = 0;
    let i = startIdx;
    while (i < str.length - 1) {
        const openIdx = str.indexOf('{{', i);
        if (openIdx < 0) break;
        const closeIdx = findMatchingCbsClose(str, openIdx);
        if (closeIdx < 0) break;
        const tagInner = str.slice(openIdx + 2, closeIdx).trim();
        if (/^#(?:if(?:_pure)?|when|each|func|pure(?:_?display)?|escape)(?:[\s:]|$)/i.test(tagInner)) {
            blockDepth += 1;
        } else if (tagInner.startsWith('/') && !tagInner.startsWith('//')) {
            if (blockDepth === 0) {
                return { endStart: openIdx, endClose: closeIdx };
            }
            blockDepth -= 1;
        }
        i = closeIdx + 2;
    }
    return null;
}

function evalSimpleCbsExpr(expr) {
    const src = String(expr || '').trim();
    if (!src) return '0';
    let pos = 0;
    const skipWs = () => { while (pos < src.length && /\s/.test(src[pos])) pos += 1; };
    const peek = () => { skipWs(); return src.slice(pos); };
    const isNum = (v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));

    function parsePrimary() {
        skipWs();
        if (src[pos] === '(') {
            pos += 1;
            const v = parseOr();
            skipWs();
            if (src[pos] === ')') pos += 1;
            return v;
        }
        if (src[pos] === '"' || src[pos] === "'") {
            const q = src[pos++];
            let out = '';
            while (pos < src.length && src[pos] !== q) {
                if (src[pos] === '\\' && pos + 1 < src.length) pos += 1;
                out += src[pos++];
            }
            if (src[pos] === q) pos += 1;
            return out;
        }
        const mNum = src.slice(pos).match(/^-?\d+(?:\.\d+)?/);
        if (mNum) {
            pos += mNum[0].length;
            return Number(mNum[0]);
        }
        const mId = src.slice(pos).match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
        if (mId) {
            pos += mId[0].length;
            if (mId[0] === 'true') return 1;
            if (mId[0] === 'false' || mId[0] === 'null' || mId[0] === 'undefined') return 0;
            return mId[0];
        }
        return 0;
    }
    function parseUnary() {
        const rest = peek();
        if (rest.startsWith('!')) { pos += 1; return isCbsTruthy(parseUnary()) ? 0 : 1; }
        if (/^not(?![a-zA-Z0-9_])/i.test(rest)) { pos += 3; return isCbsTruthy(parseUnary()) ? 0 : 1; }
        if (rest.startsWith('-') && !/^-\d/.test(rest)) { pos += 1; return -Number(parseUnary() || 0); }
        if (rest.startsWith('+') && !/^\+\d/.test(rest)) { pos += 1; return Number(parseUnary() || 0); }
        return parsePrimary();
    }
    function parseMul() {
        let left = parseUnary();
        while (true) {
            const rest = peek();
            const op = rest[0];
            if (op !== '*' && op !== '/' && op !== '%') break;
            pos += 1;
            const right = Number(parseUnary() || 0);
            const l = Number(left || 0);
            left = op === '*' ? l * right : op === '/' ? (right === 0 ? 0 : l / right) : (right === 0 ? 0 : l % right);
        }
        return left;
    }
    function parseAdd() {
        let left = parseMul();
        while (true) {
            const rest = peek();
            const op = rest[0];
            if (op !== '+' && op !== '-') break;
            pos += 1;
            const right = parseMul();
            if (op === '+' && (typeof left === 'string' || typeof right === 'string')) left = String(left) + String(right);
            else left = op === '+' ? Number(left || 0) + Number(right || 0) : Number(left || 0) - Number(right || 0);
        }
        return left;
    }
    function parseCmp() {
        let left = parseAdd();
        while (true) {
            const rest = peek();
            const m = rest.match(/^(===|!==|==|!=|>=|<=|=|>|<)/);
            if (!m) break;
            pos += m[1].length;
            const right = parseAdd();
            const op = m[1];
            const bothNum = isNum(left) && isNum(right);
            if (op === '=' || op === '==' || op === '===') left = (String(left) === String(right) || (bothNum && Number(left) === Number(right))) ? 1 : 0;
            else if (op === '!=' || op === '!==') left = (String(left) !== String(right) && !(bothNum && Number(left) === Number(right))) ? 1 : 0;
            else if (op === '>') left = Number(left) > Number(right) ? 1 : 0;
            else if (op === '<') left = Number(left) < Number(right) ? 1 : 0;
            else if (op === '>=') left = Number(left) >= Number(right) ? 1 : 0;
            else if (op === '<=') left = Number(left) <= Number(right) ? 1 : 0;
        }
        return left;
    }
    function parseAnd() {
        let left = parseCmp();
        while (true) {
            const rest = peek();
            if (rest.startsWith('&&')) pos += 2;
            else if (/^and(?![a-zA-Z0-9_])/i.test(rest)) pos += 3;
            else break;
            const right = parseCmp();
            left = isCbsTruthy(left) && isCbsTruthy(right) ? 1 : 0;
        }
        return left;
    }
    function parseOr() {
        let left = parseAnd();
        while (true) {
            const rest = peek();
            if (rest.startsWith('||')) pos += 2;
            else if (/^or(?![a-zA-Z0-9_])/i.test(rest)) pos += 2;
            else break;
            const right = parseAnd();
            left = isCbsTruthy(left) || isCbsTruthy(right) ? 1 : 0;
        }
        return left;
    }
    try {
        const res = parseOr();
        return typeof res === 'number' && !Number.isFinite(res) ? '0' : String(res);
    } catch (_) {
        return '0';
    }
}

function lookupCbsVar(name, ctx) {
    const k = String(name || '').trim();
    if (!k) return '';
    const cVars = (ctx && ctx.chatVars) || {};
    const gVars = (ctx && ctx.globalVars) || {};
    if (Object.prototype.hasOwnProperty.call(cVars, k)) return String(cVars[k] ?? '');
    if (Object.prototype.hasOwnProperty.call(gVars, k)) return String(gVars[k] ?? '');
    if (!k.startsWith('toggle_') && Object.prototype.hasOwnProperty.call(gVars, `toggle_${k}`)) {
        return String(gVars[`toggle_${k}`] ?? '');
    }
    return '';
}

function evalCbsWhenCondition(condExpr, ctx, depth) {
    const raw = String(condExpr || '').trim();
    if (!raw) return false;
    if (!raw.includes('::')) {
        const evaluated = evalPresetCbs(raw, ctx, depth + 1).trim();
        if (/^(?:0|1|true|false|null|undefined|nan)$/i.test(evaluated) || !evaluated) {
            return isCbsTruthy(evaluated);
        }
        const v = lookupCbsVar(evaluated, ctx);
        return v !== '' ? isCbsTruthy(v) : isCbsTruthy(evaluated);
    }

    const tokens = splitCbsTopLevelArgs(raw);
    while (tokens.length && /^(?:keep|legacy)$/i.test(tokens[0].trim())) {
        tokens.shift();
    }
    if (!tokens.length) return false;
    const orGroups = [[]];
    for (const tok of tokens) {
        if (tok.trim().toLowerCase() === 'or') {
            orGroups.push([]);
        } else {
            orGroups[orGroups.length - 1].push(tok);
        }
    }

    const evalAtomic = (slice) => {
        if (!slice.length) return false;
        let idx = 0;
        let negate = false;
        while (idx < slice.length && slice[idx].trim().toLowerCase() === 'not') {
            negate = !negate;
            idx += 1;
        }
        const rem = slice.slice(idx);
        let res = false;
        if (rem.length === 1) {
            const evaluated = evalPresetCbs(rem[0], ctx, depth + 1).trim();
            const v = (!rem[0].includes('{{') && lookupCbsVar(evaluated, ctx)) || evaluated;
            res = isCbsTruthy(v);
        } else if (rem.length === 2) {
            const op = rem[0].trim().toLowerCase();
            const arg = evalPresetCbs(rem[1], ctx, depth + 1).trim();
            if (op === 'var' || op === 'toggle' || op === 'vis') {
                res = isCbsTruthy(lookupCbsVar(arg, ctx) || (op === 'vis' ? arg : ''));
            } else if (op === 'visnot') {
                res = !isCbsTruthy(lookupCbsVar(arg, ctx) || arg);
            } else {
                res = isCbsTruthy(evalPresetCbs(rem.join('::'), ctx, depth + 1));
            }
        } else {
            // Support ['var', 'x', 'is', '1'], ['A', 'vis'|'visnot'|'tis'|'tisnot', 'B'], or ['A', 'is', 'B']
            const secondOp = (rem[1] || '').trim().toLowerCase();
            if (secondOp === 'vis' || secondOp === 'visnot') {
                const varKey = evalPresetCbs(rem[0], ctx, depth + 1).trim();
                const cVars = (ctx && ctx.chatVars) || {};
                const lhs = Object.prototype.hasOwnProperty.call(cVars, varKey) ? String(cVars[varKey] ?? '') : '';
                const rhs = evalPresetCbs(rem.slice(2).join('::'), ctx, depth + 1).trim();
                res = secondOp === 'vis' ? (lhs === rhs) : (lhs !== rhs);
            } else if (secondOp === 'tis' || secondOp === 'tisnot') {
                const togKey = evalPresetCbs(rem[0], ctx, depth + 1).trim();
                const gVars = (ctx && ctx.globalVars) || {};
                const lhs = Object.prototype.hasOwnProperty.call(gVars, `toggle_${togKey}`)
                    ? String(gVars[`toggle_${togKey}`] ?? '')
                    : (Object.prototype.hasOwnProperty.call(gVars, togKey) ? String(gVars[togKey] ?? '') : '');
                const rhs = evalPresetCbs(rem.slice(2).join('::'), ctx, depth + 1).trim();
                res = secondOp === 'tis' ? (lhs === rhs) : (lhs !== rhs);
            } else {
                let opIdx = 1;
                let lhs;
                const headOp = rem[0].trim().toLowerCase();
                if ((headOp === 'var' || headOp === 'toggle') && rem.length >= 4) {
                    lhs = lookupCbsVar(evalPresetCbs(rem[1], ctx, depth + 1).trim(), ctx);
                    opIdx = 2;
                } else {
                    const rawLhs = rem[0];
                    const evalLhs = evalPresetCbs(rawLhs, ctx, depth + 1);
                    lhs = (!rawLhs.includes('{{') && lookupCbsVar(evalLhs, ctx) !== '') ? lookupCbsVar(evalLhs, ctx) : evalLhs;
                }
                const op = (rem[opIdx] || '').trim().toLowerCase();
                const rhs = evalPresetCbs(rem.slice(opIdx + 1).join('::'), ctx, depth + 1);
                const lhsTrim = String(lhs ?? '').trim();
                const rhsTrim = String(rhs ?? '').trim();
                const lhsNum = Number(lhsTrim);
                const rhsNum = Number(rhsTrim);
                const bothNums = lhsTrim !== '' && rhsTrim !== '' && Number.isFinite(lhsNum) && Number.isFinite(rhsNum);
                if (op === 'is' || op === 'equal') {
                    res = String(lhs) === String(rhs);
                } else if (op === '==' || op === '===' || op === 'eq') {
                    res = String(lhs) === String(rhs) || (bothNums && lhsNum === rhsNum);
                } else if (op === 'isnot' || op === 'notequal' || op === 'not_equal') {
                    res = String(lhs) !== String(rhs);
                } else if (op === '!=' || op === '!==' || op === 'neq') {
                    res = String(lhs) !== String(rhs) && !(bothNums && lhsNum === rhsNum);
                } else if (op === '>' || op === 'gt' || op === 'greater' || op === 'greaterthan' || op === 'greater_than') {
                    res = (bothNums ? lhsNum : Number(lhs)) > (bothNums ? rhsNum : Number(rhs));
                } else if (op === '<' || op === 'lt' || op === 'less' || op === 'lessthan' || op === 'less_than') {
                    res = (bothNums ? lhsNum : Number(lhs)) < (bothNums ? rhsNum : Number(rhs));
                } else if (op === '>=' || op === 'gte' || op === 'greater_equal' || op === 'greaterequal' || op === 'greater_than_equal' || op === 'greaterthanequal') {
                    res = (bothNums ? lhsNum : Number(lhs)) >= (bothNums ? rhsNum : Number(rhs));
                } else if (op === '<=' || op === 'lte' || op === 'less_equal' || op === 'lessequal' || op === 'less_than_equal' || op === 'lessthanequal') {
                    res = (bothNums ? lhsNum : Number(lhs)) <= (bothNums ? rhsNum : Number(rhs));
                } else {
                    res = isCbsTruthy(lhs);
                }
            }
        }
        return negate ? !res : res;
    };

    for (const grp of orGroups) {
        const andParts = [[]];
        for (const tok of grp) {
            if (tok.trim().toLowerCase() === 'and') andParts.push([]);
            else andParts[andParts.length - 1].push(tok);
        }
        if (andParts.every(evalAtomic)) return true;
    }
    return false;
}

function parsePresetEachHeader(argStr) {
    const src = String(argStr || '');
    const topParts = splitCbsTopLevelArgs(src);
    if (topParts.length >= 2) {
        return {
            iterExpr: topParts.slice(0, -1).join('::').trim(),
            slotName: topParts[topParts.length - 1].trim(),
        };
    }
    let depth = 0;
    let lastWsStart = -1;
    let lastWsEnd = -1;
    let i = 0;
    while (i < src.length) {
        if (src[i] === '{' && src[i + 1] === '{') {
            depth += 1;
            i += 2;
            continue;
        }
        if (src[i] === '}' && src[i + 1] === '}') {
            depth = Math.max(0, depth - 1);
            i += 2;
            continue;
        }
        if (depth === 0 && /\s/.test(src[i])) {
            const start = i;
            while (i < src.length && /\s/.test(src[i])) i += 1;
            if (i < src.length) {
                lastWsStart = start;
                lastWsEnd = i;
            }
            continue;
        }
        i += 1;
    }
    if (lastWsStart >= 0) {
        return {
            iterExpr: src.slice(0, lastWsStart).trim(),
            slotName: src.slice(lastWsEnd).trim(),
        };
    }
    return { iterExpr: src.trim(), slotName: '' };
}

function formatCbsDateTime(fmt = '', dateObj = new Date()) {
    const d = dateObj instanceof Date ? dateObj : new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const map = {
        YYYY: String(d.getFullYear()),
        YY: String(d.getFullYear()).slice(-2),
        MM: pad(d.getMonth() + 1),
        DD: pad(d.getDate()),
        HH: pad(d.getHours()),
        mm: pad(d.getMinutes()),
        ss: pad(d.getSeconds()),
        ddd: days[d.getDay()],
    };
    const template = String(fmt || '').trim() || 'HH:mm:ss';
    return template.replace(/YYYY|YY|MM|DD|HH|mm|ss|ddd/g, (tok) => map[tok] ?? tok);
}

function evalPresetCbs(input, ctx = {}, depth = 0) {
    const str = String(input ?? '');
    if (!str.includes('{{') || depth > 200) return str;
    if (ctx && typeof ctx === 'object') {
        if (!ctx.functions) ctx.functions = new Map();
        if (!ctx.slots) ctx.slots = {};
        if (!ctx.tempVars) ctx.tempVars = {};
        if (!ctx.chatVars) ctx.chatVars = {};
        if (!ctx.globalVars) ctx.globalVars = {};
    }
    let out = '';
    let pos = 0;
    while (pos < str.length) {
        const openIdx = str.indexOf('{{', pos);
        if (openIdx < 0) {
            out += str.slice(pos);
            break;
        }
        out += str.slice(pos, openIdx);
        const closeIdx = findMatchingCbsClose(str, openIdx);
        if (closeIdx < 0) {
            out += str.slice(openIdx);
            break;
        }
        const inner = str.slice(openIdx + 2, closeIdx);
        const trimmed = inner.trim();

        if (trimmed.startsWith('//')) {
            pos = closeIdx + 2;
            continue;
        }

        const escapeMatch = trimmed.match(/^#escape(?:[\s:]|$)/i);
        if (escapeMatch) {
            const bounds = findMatchingCbsBlockEnd(str, closeIdx + 2);
            if (!bounds) {
                out += str.slice(openIdx, closeIdx + 2);
                pos = closeIdx + 2;
                continue;
            }
            out += str.slice(closeIdx + 2, bounds.endStart);
            pos = bounds.endClose + 2;
            continue;
        }

        const funcMatch = trimmed.match(/^#func(?:(?:\s+|::)([\s\S]*))?$/i);
        if (funcMatch) {
            const bounds = findMatchingCbsBlockEnd(str, closeIdx + 2);
            if (!bounds) {
                out += str.slice(openIdx, closeIdx + 2);
                pos = closeIdx + 2;
                continue;
            }
            const headerTokens = String(funcMatch[1] || '').split(/(?:\s+|::)/).map((t) => t.trim()).filter(Boolean);
            const funcName = headerTokens[0] || '';
            if (funcName && ctx && ctx.functions) {
                const rawBody = str.slice(closeIdx + 2, bounds.endStart).trim();
                ctx.functions.set(funcName, { data: rawBody, params: headerTokens.slice(1) });
            }
            pos = bounds.endClose + 2;
            continue;
        }

        const eachMatch = trimmed.match(/^#each(?:\s+|::)([\s\S]*)$/i);
        if (eachMatch) {
            const bounds = findMatchingCbsBlockEnd(str, closeIdx + 2);
            if (!bounds) {
                out += str.slice(openIdx, closeIdx + 2);
                pos = closeIdx + 2;
                continue;
            }
            const { iterExpr, slotName } = parsePresetEachHeader(eachMatch[1]);
            const rawList = evalPresetCbs(iterExpr, ctx, depth + 1).trim();
            let arr = [];
            if (rawList.startsWith('[')) {
                try {
                    const parsedArr = JSON.parse(rawList);
                    if (Array.isArray(parsedArr)) arr = parsedArr;
                } catch (_) {}
            } else if (/^-?\d+$/.test(rawList)) {
                const n = Number(rawList);
                const emptyChat = Array.isArray(ctx.chatList) && ctx.chatList.length === 0;
                if (n >= 0 && !(emptyChat && n === 0)) {
                    const limitCount = Math.min(n + 1, 5000);
                    arr = Array.from({ length: limitCount }, (_, idx) => String(idx));
                }
            } else if (rawList) {
                arr = rawList.split('::').filter(Boolean);
            }
            let bodyToRender = str.slice(closeIdx + 2, bounds.endStart);
            if (bodyToRender.startsWith('\r\n')) bodyToRender = bodyToRender.slice(2);
            else if (bodyToRender.startsWith('\n')) bodyToRender = bodyToRender.slice(1);

            const slots = ctx.slots || (ctx.slots = {});
            const hadPrev = slotName && Object.prototype.hasOwnProperty.call(slots, slotName);
            const prevVal = hadPrev ? slots[slotName] : undefined;
            const limit = Math.min(arr.length, 20000);
            for (let i = 0; i < limit; i += 1) {
                if (slotName) slots[slotName] = String(arr[i] ?? '');
                const iterOut = evalPresetCbs(bodyToRender, ctx, depth + 1);
                if (/\S/.test(iterOut)) out += iterOut;
            }
            if (slotName) {
                if (hadPrev) slots[slotName] = prevVal;
                else delete slots[slotName];
            }
            pos = bounds.endClose + 2;
            continue;
        }

        const ifMatch = trimmed.match(/^#if(?:_pure)?(?:\s+([\s\S]*))?$/i);
        if (ifMatch) {
            const bounds = findMatchingCbsIfEnd(str, closeIdx + 2);
            if (!bounds) {
                out += str.slice(openIdx, closeIdx + 2);
                pos = closeIdx + 2;
                continue;
            }
            const condRaw = ifMatch[1] || '';
            const condVal = evalPresetCbs(condRaw, ctx, depth + 1);
            const thenBody = bounds.elseStart >= 0
                ? str.slice(closeIdx + 2, bounds.elseStart)
                : str.slice(closeIdx + 2, bounds.endStart);
            const elseBody = bounds.elseStart >= 0
                ? str.slice(bounds.elseEnd, bounds.endStart)
                : '';
            const branch = isCbsTruthy(condVal) ? thenBody : elseBody;
            out += evalPresetCbs(branch, ctx, depth + 1);
            pos = bounds.endClose + 2;
            continue;
        }

        const whenMatch = trimmed.match(/^#when(?:\s+|::)([\s\S]*)$/i) || (/^#when$/i.test(trimmed) ? ['', ''] : null);
        if (whenMatch) {
            const bounds = findMatchingCbsIfEnd(str, closeIdx + 2);
            if (!bounds) {
                out += str.slice(openIdx, closeIdx + 2);
                pos = closeIdx + 2;
                continue;
            }
            const ok = evalCbsWhenCondition(whenMatch[1] || '', ctx, depth);
            const thenBody = bounds.elseStart >= 0
                ? str.slice(closeIdx + 2, bounds.elseStart)
                : str.slice(closeIdx + 2, bounds.endStart);
            const elseBody = bounds.elseStart >= 0
                ? str.slice(bounds.elseEnd, bounds.endStart)
                : '';
            out += evalPresetCbs(ok ? thenBody : elseBody, ctx, depth + 1);
            pos = bounds.endClose + 2;
            continue;
        }

        if (trimmed.startsWith('?')) {
            out += evalSimpleCbsExpr(evalPresetCbs(trimmed.slice(1), ctx, depth + 1));
            pos = closeIdx + 2;
            continue;
        }

        const parts = splitCbsTopLevelArgs(inner);
        const rawCmd = parts[0] || '';
        const evalRawCmd = rawCmd.includes('{{') ? evalPresetCbs(rawCmd, ctx, depth + 1) : rawCmd;
        let cmd = evalRawCmd.trim().toLowerCase();
        let args = parts.slice(1).map((a) => evalPresetCbs(a, ctx, depth + 1));
        if (parts.length === 1 && cmd.includes(':')) {
            const colonIdx = evalRawCmd.indexOf(':');
            cmd = evalRawCmd.slice(0, colonIdx).trim().toLowerCase();
            args = [evalPresetCbs(evalRawCmd.slice(colonIdx + 1), ctx, depth + 1)];
        }

        const gVars = (ctx && ctx.globalVars) || {};
        const cVars = (ctx && ctx.chatVars) || {};

        let replaced = null;
        if (cmd === 'getglobalvar') {
            const k = (args[0] || '').trim();
            if (Object.prototype.hasOwnProperty.call(gVars, k)) replaced = String(gVars[k] ?? '');
            else if (k && !k.startsWith('toggle_') && Object.prototype.hasOwnProperty.call(gVars, `toggle_${k}`)) {
                replaced = String(gVars[`toggle_${k}`] ?? '');
            } else {
                replaced = 'null';
            }
        } else if (cmd === 'getvar' || cmd === 'getchatvar') {
            const k = (args[0] || '').trim();
            if (Object.prototype.hasOwnProperty.call(cVars, k)) replaced = String(cVars[k] ?? '');
            else if (Object.prototype.hasOwnProperty.call(gVars, k)) replaced = String(gVars[k] ?? '');
            else replaced = '';
        } else if (cmd === 'setvar') {
            const k = (args[0] || '').trim();
            if (k && ctx && ctx.chatVars) ctx.chatVars[k] = String(args.slice(1).join('::'));
            replaced = '';
        } else if (cmd === 'setdefaultvar') {
            const k = (args[0] || '').trim();
            if (k && ctx && ctx.chatVars && (!Object.prototype.hasOwnProperty.call(ctx.chatVars, k) || ctx.chatVars[k] === '' || ctx.chatVars[k] === 'null')) {
                ctx.chatVars[k] = String(args.slice(1).join('::'));
            }
            replaced = '';
        } else if (cmd === 'addvar') {
            const k = (args[0] || '').trim();
            if (k && ctx && ctx.chatVars) {
                ctx.chatVars[k] = String((Number(ctx.chatVars[k]) || 0) + (Number(args[1]) || 0));
            }
            replaced = '';
        } else if (cmd === 'tempvar' || cmd === 'gettempvar') {
            const k = (args[0] || '').trim();
            replaced = String((ctx && ctx.tempVars && Object.prototype.hasOwnProperty.call(ctx.tempVars, k)) ? ctx.tempVars[k] : '');
        } else if (cmd === 'settempvar') {
            const k = (args[0] || '').trim();
            if (k && ctx && ctx.tempVars) ctx.tempVars[k] = String(args.slice(1).join('::'));
            replaced = '';
        } else if (cmd === 'slot') {
            const k = (args[0] || '').trim();
            const slots = (ctx && ctx.slots) || {};
            if (k && Object.prototype.hasOwnProperty.call(slots, k)) replaced = String(slots[k] ?? '');
            else if (!k) {
                const first = Object.values(slots)[0];
                replaced = first !== undefined ? String(first) : '';
            } else replaced = '';
        } else if (cmd === 'array' || cmd === 'makearray' || cmd === 'a') {
            replaced = JSON.stringify(args.map((x) => String(x ?? '')));
        } else if (cmd === 'length') {
            const valStr = String(args[0] ?? '');
            const trimmedVal = valStr.trim();
            if (trimmedVal.startsWith('[')) {
                try {
                    const parsed = JSON.parse(trimmedVal);
                    if (Array.isArray(parsed)) replaced = String(parsed.length);
                } catch (_) {}
            }
            if (replaced === null) replaced = String(valStr.length);
        } else if (cmd === 'chat_index' || cmd === 'chatindex') {
            const fallbackIdx = Array.isArray(ctx.chatList) ? Math.max(0, ctx.chatList.length - 1) : 0;
            replaced = String(ctx.chatIndex !== undefined ? ctx.chatIndex : (ctx.lastMessageId !== undefined ? ctx.lastMessageId : fallbackIdx));
        } else if (cmd === 'lastmessageid') {
            const fallbackLast = Array.isArray(ctx.chatList) ? Math.max(0, ctx.chatList.length - 1) : 0;
            replaced = String(ctx.lastMessageId !== undefined ? ctx.lastMessageId : fallbackLast);
        } else if (cmd === 'previous_chat_log' || cmd === 'previouschatlog') {
            const idx = Number((args[0] || '').trim());
            replaced = (Array.isArray(ctx.chatList) && Number.isInteger(idx) && idx >= 0 && idx < ctx.chatList.length)
                ? String((ctx.chatList[idx] && ctx.chatList[idx].content) ?? '')
                : '';
        } else if (cmd === 'position') {
            const posKey = String(args[0] || '').trim();
            const ptMap = (ctx && ctx.ptPositions && typeof ctx.ptPositions === 'object') ? ctx.ptPositions : {};
            const list = ptMap[posKey] || ptMap[`pt_${posKey}`] || ptMap[posKey.replace(/^pt_/, '')] || [];
            replaced = Array.isArray(list) ? list.filter(Boolean).join('\n\n') : '';
        } else if (cmd === 'random') {
            let choices = args;
            if (choices.length === 1) {
                const one = String(choices[0] ?? '');
                if (one.includes(':')) choices = one.split(':');
                else if (one.includes(',')) choices = one.split(',');
            }
            replaced = choices.length ? String(choices[Math.floor(Math.random() * choices.length)] ?? '') : '';
        } else if (cmd === 'roll') {
            const spec = String(args[0] || '20').trim();
            const dm = spec.match(/^(\d+)d(\d+)$/i);
            if (dm) {
                const cnt = Math.min(100, Math.max(1, Number(dm[1]) || 1));
                const sides = Math.max(1, Number(dm[2]) || 20);
                let total = 0;
                for (let ri = 0; ri < cnt; ri += 1) total += 1 + Math.floor(Math.random() * sides);
                replaced = String(total);
            } else {
                const sides = Math.max(1, Number(spec) || 20);
                replaced = String(1 + Math.floor(Math.random() * sides));
            }
        } else if (cmd === 'time') {
            replaced = formatCbsDateTime(args[0] || 'HH:mm:ss', new Date());
        } else if (cmd === 'date') {
            replaced = formatCbsDateTime(args[0] || 'YYYY-MM-DD', new Date());
        } else if (cmd === 'idle_duration' || cmd === 'idleduration') {
            if (Number.isFinite(ctx.lastUserMessageTime) && ctx.lastUserMessageTime > 0) {
                const secs = Math.max(0, Math.floor((Date.now() - ctx.lastUserMessageTime) / 1000));
                if (secs < 60) replaced = `${secs}s`;
                else if (secs < 3600) replaced = `${Math.floor(secs / 60)}m`;
                else replaced = `${Math.floor(secs / 3600)}h`;
            } else {
                replaced = '0s';
            }
        } else if (cmd === 'ruby') {
            replaced = `<ruby>${String(args[0] ?? '')}<rt>${String(args[1] ?? '')}</rt></ruby>`;
        } else if (cmd === 'u' || cmd === 'unicode') {
            const cp = parseInt(String(args[0] || '').trim(), 16);
            replaced = (Number.isFinite(cp) && cp >= 0 && cp <= 0x10FFFF) ? String.fromCodePoint(cp) : '';
        } else if (cmd === 'calc') {
            replaced = evalSimpleCbsExpr(args.join('::'));
        } else if (cmd === 'call') {
            if ((ctx.callStack || 0) <= 20) {
                const funcName = String(args[0] || '').trim();
                const fn = ctx && ctx.functions && ctx.functions.get(funcName);
                if (fn) {
                    let fnBody = fn.data;
                    for (let ai = 0; ai < args.length; ai += 1) {
                        fnBody = fnBody.split(`{{arg::${ai}}}`).join(String(args[ai] ?? ''));
                    }
                    replaced = evalPresetCbs(fnBody, { ...ctx, callArgs: args, callStack: (ctx.callStack || 0) + 1 }, depth + 1);
                } else {
                    replaced = '';
                }
            } else {
                replaced = '';
            }
        } else if (cmd === 'arg') {
            const idx = Number((args[0] || '').trim());
            replaced = (Array.isArray(ctx.callArgs) && Number.isInteger(idx) && idx >= 0 && idx < ctx.callArgs.length)
                ? String(ctx.callArgs[idx] ?? '')
                : '';
        } else if (cmd === 'return') {
            replaced = String(args[0] ?? '');
        } else if (cmd === 'equal' || cmd === 'eq' || cmd === '==') {
            const a = String(args[0] ?? '');
            const b = String(args[1] ?? '');
            const na = Number(a.trim());
            const nb = Number(b.trim());
            replaced = (a === b || (cmd !== 'equal' && a.trim() !== '' && b.trim() !== '' && Number.isFinite(na) && Number.isFinite(nb) && na === nb)) ? '1' : '0';
        } else if (cmd === 'notequal' || cmd === 'not_equal' || cmd === 'neq' || cmd === '!=') {
            const a = String(args[0] ?? '');
            const b = String(args[1] ?? '');
            const na = Number(a.trim());
            const nb = Number(b.trim());
            replaced = (a !== b && !(cmd !== 'notequal' && cmd !== 'not_equal' && a.trim() !== '' && b.trim() !== '' && Number.isFinite(na) && Number.isFinite(nb) && na === nb)) ? '1' : '0';
        } else if (cmd === 'any') {
            replaced = args.some(isCbsTruthy) ? '1' : '0';
        } else if (cmd === 'all') {
            replaced = (args.length > 0 && args.every(isCbsTruthy)) ? '1' : '0';
        } else if (cmd === 'and') {
            replaced = (args.length > 0 && args.every(isCbsTruthy)) ? '1' : '0';
        } else if (cmd === 'or') {
            replaced = args.some(isCbsTruthy) ? '1' : '0';
        } else if (cmd === 'not') {
            replaced = isCbsTruthy(args[0]) ? '0' : '1';
        } else if (cmd === 'greater' || cmd === 'gt' || cmd === 'greaterthan' || cmd === 'greater_than' || cmd === '>') {
            replaced = Number(args[0]) > Number(args[1]) ? '1' : '0';
        } else if (cmd === 'less' || cmd === 'lt' || cmd === 'lessthan' || cmd === 'less_than' || cmd === '<') {
            replaced = Number(args[0]) < Number(args[1]) ? '1' : '0';
        } else if (cmd === 'greater_equal' || cmd === 'greaterequal' || cmd === 'gte' || cmd === 'greaterthanequal' || cmd === 'greater_than_equal' || cmd === '>=') {
            replaced = Number(args[0]) >= Number(args[1]) ? '1' : '0';
        } else if (cmd === 'less_equal' || cmd === 'lessequal' || cmd === 'lte' || cmd === 'lessthanequal' || cmd === 'less_than_equal' || cmd === '<=') {
            replaced = Number(args[0]) <= Number(args[1]) ? '1' : '0';
        } else if (cmd === 'trim') {
            replaced = String(args.join('::')).trim();
        } else if (cmd === 'lower') {
            replaced = String(args.join('::')).toLowerCase();
        } else if (cmd === 'upper') {
            replaced = String(args.join('::')).toUpperCase();
        } else if (cmd === 'abs') {
            replaced = String(Math.abs(Number(args[0]) || 0));
        } else if (cmd === 'round') {
            replaced = String(Math.round(Number(args[0]) || 0));
        } else if (cmd === 'floor') {
            replaced = String(Math.floor(Number(args[0]) || 0));
        } else if (cmd === 'ceil') {
            replaced = String(Math.ceil(Number(args[0]) || 0));
        } else if (cmd === 'tonumber') {
            const n = Number(String(args[0] || '').trim());
            replaced = Number.isFinite(n) ? String(n) : '0';
        } else if (cmd === 'min') {
            const nums = args.map((x) => Number(x)).filter((n) => Number.isFinite(n));
            replaced = nums.length ? String(Math.min(...nums)) : '0';
        } else if (cmd === 'max') {
            const nums = args.map((x) => Number(x)).filter((n) => Number.isFinite(n));
            replaced = nums.length ? String(Math.max(...nums)) : '0';
        } else if (cmd === 'sum') {
            let sum = 0;
            for (const x of args) sum += Number(x) || 0;
            replaced = String(sum);
        } else if (cmd === 'contains') {
            replaced = String(args[0] ?? '').includes(String(args[1] ?? '')) ? '1' : '0';
        } else if (cmd === 'startswith') {
            replaced = String(args[0] ?? '').startsWith(String(args[1] ?? '')) ? '1' : '0';
        } else if (cmd === 'endswith') {
            replaced = String(args[0] ?? '').endsWith(String(args[1] ?? '')) ? '1' : '0';
        } else if (cmd === 'replace') {
            replaced = String(args[0] ?? '').split(String(args[1] ?? '')).join(String(args[2] ?? ''));
        } else if (cmd === 'blank' || cmd === 'comment' || cmd === 'hiddenkey' || cmd === 'hidden_key') {
            replaced = '';
        } else if (cmd === 'char') {
            replaced = String(ctx.charName || 'Character');
        } else if (cmd === 'user') {
            replaced = String(ctx.personaName || 'User');
        } else if (cmd === 'persona') {
            replaced = String(ctx.personaPrompt || '');
        } else if (cmd === 'description') {
            replaced = String(ctx.desc || '');
        } else if (cmd === 'personality') {
            replaced = String(ctx.personality || '');
        } else if (cmd === 'scenario') {
            replaced = String(ctx.scenario || '');
        } else if (cmd === 'authorsnote' || cmd === 'authornote') {
            replaced = String(ctx.note || '');
        } else if (cmd === 'globalnote') {
            replaced = String(ctx.globalNote || '');
        } else if (cmd === 'mainprompt') {
            replaced = String(ctx.mainPrompt || '');
        } else if (cmd === 'jailbreak') {
            replaced = String(ctx.jailbreak || '');
        } else if (cmd === 'newline' || cmd === 'br') {
            replaced = '\n';
        }

        out += (replaced !== null) ? replaced : str.slice(openIdx, closeIdx + 2);
        pos = closeIdx + 2;
    }
    return out;
}

function sliceChatRange(list, rangeStart, rangeEnd) {
    const len = list.length;
    if (!len) return [];
    const resolveIdx = (val, def) => {
        if (val === undefined || val === null || val === '') return def;
        if (String(val).toLowerCase() === 'end') return len;
        const n = Number(val);
        if (!Number.isFinite(n)) return def;
        return n < 0 ? Math.max(0, len + n) : Math.min(len, n);
    };
    const start = resolveIdx(rangeStart, 0);
    const end = resolveIdx(rangeEnd, len);
    if (end <= start) return [];
    return list.slice(start, end);
}

function cleanPresetPromptText(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function normalizeToggleMapInto(target, src) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) return;
    for (const [rawKey, rawVal] of Object.entries(src)) {
        const k = String(rawKey || '').trim();
        if (!k) continue;
        const v = String(rawVal ?? '');
        target[k] = v;
        if (k.startsWith('toggle_')) {
            target[k.slice(7)] = v;
        } else {
            target[`toggle_${k}`] = v;
        }
    }
}

function parseLoreDecorators(rawContent) {
    const lines = String(rawContent || '').replace(/\r\n/g, '\n').split('\n');
    const out = {
        content: '',
        pos: '',
        depth: 0,
        role: 'system',
        scanDepth: null,
        priority: null,
        forceState: 'none',
        activateOnlyAfter: null,
        activateOnlyEvery: null,
        isGreeting: null,
        additionalKeys: [],
        excludeKeys: [],
        excludeKeysAll: [],
        fullWord: null,
        recursive: null,
        noRecursiveSearch: false,
    };

    let idx = 0;
    while (idx < lines.length && !lines[idx].trim()) {
        idx += 1;
    }
    while (idx < lines.length) {
        const line = lines[idx].trim();
        if (!line.startsWith('@@')) break;
        const body = line.slice(2).trim();
        if (body) {
            const parts = body.split(/\s+/);
            const name = String(parts[0] || '').toLowerCase();
            const arg = parts.slice(1);
            switch (name) {
                case 'end':
                    out.pos = 'depth';
                    out.depth = 0;
                    break;
                case 'depth':
                case 'reverse_depth': {
                    const n = parseInt(arg[0], 10);
                    if (!Number.isNaN(n)) {
                        out.depth = n;
                        out.pos = name === 'depth' ? 'depth' : 'reverse_depth';
                    }
                    break;
                }
                case 'role': {
                    const r = String(arg[0] || '').toLowerCase();
                    if (r === 'user' || r === 'assistant' || r === 'system') out.role = r;
                    break;
                }
                case 'scan_depth': {
                    const n = parseInt(arg[0], 10);
                    if (!Number.isNaN(n) && n > 0) out.scanDepth = n;
                    break;
                }
                case 'priority': {
                    const n = parseInt(arg[0], 10);
                    if (!Number.isNaN(n)) out.priority = n;
                    break;
                }
                case 'position': {
                    const p = String(arg[0] || '');
                    if (p.startsWith('pt_') || p === 'postEverything' || p === 'after_desc' || p === 'before_desc' || p === 'personality' || p === 'scenario') {
                        out.pos = p;
                    }
                    break;
                }
                case 'activate':
                    out.forceState = 'activate';
                    break;
                case 'dont_activate':
                    out.forceState = 'deactivate';
                    break;
                case 'activate_only_after': {
                    const n = parseInt(arg[0], 10);
                    if (!Number.isNaN(n)) out.activateOnlyAfter = n;
                    break;
                }
                case 'activate_only_every': {
                    const n = parseInt(arg[0], 10);
                    if (!Number.isNaN(n) && n > 0) out.activateOnlyEvery = n;
                    break;
                }
                case 'is_greeting': {
                    const n = parseInt(arg[0], 10);
                    if (!Number.isNaN(n)) out.isGreeting = n;
                    break;
                }
                case 'additional_keys':
                    out.additionalKeys.push(...arg.join(' ').split(',').map((k) => k.trim()).filter(Boolean));
                    break;
                case 'exclude_keys':
                    out.excludeKeys.push(...arg.join(' ').split(',').map((k) => k.trim()).filter(Boolean));
                    break;
                case 'exclude_keys_all':
                    out.excludeKeysAll.push(...arg.join(' ').split(',').map((k) => k.trim()).filter(Boolean));
                    break;
                case 'match_full_word':
                    out.fullWord = true;
                    break;
                case 'match_partial_word':
                    out.fullWord = false;
                    break;
                case 'recursive':
                    out.recursive = true;
                    break;
                case 'unrecursive':
                    out.recursive = false;
                    break;
                case 'no_recursive_search':
                    out.noRecursiveSearch = true;
                    break;
                default:
                    break;
            }
        }
        idx += 1;
    }
    out.content = lines.slice(idx).join('\n').trim();
    return out;
}

function escapeRegExpStr(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesLoreKeys(corpus, keys, { useRegex = false, fullWord = false, requireAll = false } = {}) {
    const cleanKeys = (Array.isArray(keys) ? keys : []).map((k) => String(k || '').trim()).filter(Boolean);
    if (!cleanKeys.length) return false;
    const text = String(corpus || '');
    const lowerText = text.toLowerCase();

    const hitOne = (k) => {
        if (useRegex) {
            const m = k.match(/^\/([\s\S]+)\/([gimsuy]*)$/);
            try {
                const re = m ? new RegExp(m[1], m[2] || 'i') : new RegExp(k, 'i');
                return re.test(text);
            } catch (_) {
                return lowerText.includes(k.toLowerCase());
            }
        }
        if (fullWord && /^[a-zA-Z0-9_]+$/.test(k)) {
            const re = new RegExp(`(^|[^a-zA-Z0-9_])${escapeRegExpStr(k)}([^a-zA-Z0-9_]|$)`, 'i');
            return re.test(text);
        }
        return lowerText.includes(k.toLowerCase());
    };

    return requireAll ? cleanKeys.every(hitOne) : cleanKeys.some(hitOne);
}

function isModuleLoreEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    return String(entry.source || '').toLowerCase() === 'module' || String(entry.uid || '').startsWith('module:');
}

function evaluateLorebookEntries({
    loreEntries = [],
    chatList = [],
    cbsCtx = {},
    loreDepth = 10,
    loreTokenBudget = 16000,
    loreRecursive = true,
    loreFullWord = false,
    fmIndex = -1,
    totalChatMessages = 0,
    disabledLoreUids = [],
    enabledModuleLoreUids = [],
    pinnedLoreUids = [],
} = {}) {
    const disabledSet = new Set((Array.isArray(disabledLoreUids) ? disabledLoreUids : []).map(String));
    const enabledModuleSet = new Set((Array.isArray(enabledModuleLoreUids) ? enabledModuleLoreUids : []).map(String));
    const pinnedSet = new Set((Array.isArray(pinnedLoreUids) ? pinnedLoreUids : []).map(String));
    const parsed = [];
    for (let i = 0; i < (Array.isArray(loreEntries) ? loreEntries.length : 0); i += 1) {
        const raw = loreEntries[i];
        if (!raw || raw.enabled === false || raw.mode === 'folder') continue;
        if (isModuleLoreEntry(raw)) {
            if (!raw.uid || !enabledModuleSet.has(String(raw.uid))) continue;
        } else if (raw.uid && disabledSet.has(String(raw.uid))) {
            continue;
        }
        const dec = parseLoreDecorators(raw.content || '');
        if (!dec.content) continue;
        const msgCount = Number(totalChatMessages || chatList.length || 0);
        if (dec.activateOnlyAfter !== null && msgCount < dec.activateOnlyAfter) continue;
        if (dec.activateOnlyEvery !== null && (msgCount % dec.activateOnlyEvery !== 0)) continue;
        if (dec.isGreeting !== null && ((Number(fmIndex) + 1) !== dec.isGreeting)) continue;
        if (dec.forceState === 'deactivate') continue;

        const baseOrder = Number.isFinite(Number(raw.insertorder)) ? Number(raw.insertorder) : 100;
        parsed.push({
            idx: i,
            raw,
            dec,
            pinned: Boolean(raw.uid && pinnedSet.has(String(raw.uid))),
            insertorder: baseOrder,
            priority: dec.priority !== null ? dec.priority : baseOrder,
        });
    }

    const activeMap = new Map();
    const recursiveTexts = [];
    const maxPasses = loreRecursive ? 3 : 1;

    for (let pass = 0; pass < maxPasses; pass += 1) {
        let addedInPass = false;
        const recursiveChunk = pass > 0 ? recursiveTexts.join('\n') : '';

        for (const item of parsed) {
            if (activeMap.has(item.idx)) continue;
            if (pass > 0 && (item.dec.recursive === false || item.dec.noRecursiveSearch)) continue;
            const { raw, dec } = item;
            const depth = Math.max(1, Number(dec.scanDepth || loreDepth || 10));
            const baseCorpus = chatList.slice(-depth).map((m) => String((m && m.content) || '')).join('\n');
            const corpus = (pass > 0 && recursiveChunk) ? `${baseCorpus}\n${recursiveChunk}` : baseCorpus;
            const fw = dec.fullWord !== null ? dec.fullWord : Boolean(loreFullWord);
            const useRegex = Boolean(raw.useRegex);

            let hit = Boolean(raw.alwaysActive) || Boolean(item.pinned) || dec.forceState === 'activate';
            if (!hit && pass === 0 && !String(raw.key || '').trim() && !dec.additionalKeys.length) {
                hit = false;
            } else if (!hit) {
                const primaryKeys = String(raw.key || '').split(',');
                hit = matchesLoreKeys(corpus, primaryKeys, { useRegex, fullWord: fw });
                if (hit && raw.selective && String(raw.secondkey || '').trim()) {
                    hit = matchesLoreKeys(corpus, String(raw.secondkey).split(','), { useRegex, fullWord: fw });
                }
                if (hit && dec.additionalKeys.length) {
                    hit = matchesLoreKeys(corpus, dec.additionalKeys, { useRegex, fullWord: fw });
                }
            }
            if (hit && dec.excludeKeys.length) {
                if (matchesLoreKeys(corpus, dec.excludeKeys, { useRegex, fullWord: fw, requireAll: false })) hit = false;
            }
            if (hit && dec.excludeKeysAll.length) {
                if (matchesLoreKeys(corpus, dec.excludeKeysAll, { useRegex, fullWord: fw, requireAll: true })) hit = false;
            }
            if (!hit) continue;

            const evaluated = cleanPresetPromptText(evalPresetCbs(dec.content, cbsCtx));
            if (!evaluated) continue;

            const isDynamicMacroContent = /\{\{(?:getvar|getchatvar|chat_index|lastmessageid|previous_chat_log|time|date|idle_duration|random|roll|position|#when|#if)\b/i.test(String(dec.content || ''));
            const isStaticAlwaysActive = Boolean((raw.alwaysActive || item.pinned) && !isDynamicMacroContent);
            const formatted = raw.comment ? `[${raw.comment}]\n${evaluated}` : evaluated;
            activeMap.set(item.idx, {
                idx: item.idx,
                insertorder: item.insertorder,
                priority: item.priority,
                pos: dec.pos,
                depth: dec.depth,
                role: dec.role,
                isStaticAlwaysActive,
                content: formatted,
                rawEvaluated: evaluated,
            });
            addedInPass = true;
            if (dec.recursive !== false) {
                recursiveTexts.push(evaluated);
            }
        }
        if (!addedInPass) break;
    }

    const byPriority = Array.from(activeMap.values()).sort((a, b) => (b.priority - a.priority) || (a.idx - b.idx));
    const maxChars = Math.max(12000, Number(loreTokenBudget || 16000) * 3);
    const accepted = [];
    let usedChars = 0;
    for (const item of byPriority) {
        if (usedChars + item.content.length > maxChars) continue;
        accepted.push(item);
        usedChars += item.content.length;
    }

    accepted.sort((a, b) => (a.insertorder - b.insertorder) || (a.idx - b.idx));

    const buckets = {
        normal: [],
        beforeDesc: [],
        afterDesc: [],
        personality: [],
        scenario: [],
        depthEntries: [],
        postEverything: [],
        ptPositions: {},
    };
    const postAssistant = [];
    for (const item of accepted) {
        const p = item.pos;
        if (p === 'before_desc') buckets.beforeDesc.push(item);
        else if (p === 'after_desc') buckets.afterDesc.push(item);
        else if (p === 'personality') buckets.personality.push(item);
        else if (p === 'scenario') buckets.scenario.push(item);
        else if ((p === 'depth' && item.depth === 0) || p === 'postEverything' || p === 'pt_postEverything') {
            if (item.role === 'assistant') postAssistant.push(item);
            else buckets.postEverything.push(item);
        } else if ((p === 'depth' && item.depth > 0) || p === 'reverse_depth') {
            buckets.depthEntries.push(item);
        } else if (p && p.startsWith('pt_')) {
            const shortKey = p.slice(3);
            if (!Array.isArray(buckets.ptPositions[p])) buckets.ptPositions[p] = [];
            buckets.ptPositions[p].push(item.content);
            if (shortKey) {
                if (!Array.isArray(buckets.ptPositions[shortKey])) buckets.ptPositions[shortKey] = [];
                buckets.ptPositions[shortKey].push(item.content);
            }
        } else {
            buckets.normal.push(item);
        }
    }
    if (postAssistant.length) buckets.postEverything.push(...postAssistant);
    return buckets;
}

function normalizeDirectHistoryMode(mode) {
    const v = typeof mode === 'string' ? mode.trim() : '';
    return ['chunked', 'full', 'sliding_30'].includes(v) ? v : 'chunked';
}

function normalizeDirectPipelineMode(mode) {
    const v = typeof mode === 'string' ? mode.trim() : '';
    return ['single', 'two_pass'].includes(v) ? v : 'single';
}

function selectCacheFriendlyHistory(messages, { mode = 'chunked', maxMsgs = 30, chunkStep = 10, fullLimit = 100 } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const normMode = normalizeDirectHistoryMode(mode);
    if (normMode === 'sliding_30') {
        return list.length > maxMsgs ? list.slice(-maxMsgs) : list.slice();
    }
    if (normMode === 'full') {
        return list.length > fullLimit ? list.slice(-fullLimit) : list.slice();
    }
    if (list.length <= maxMsgs) return list.slice();
    const minCutPos = list.length - maxMsgs;
    const maxCutPos = list.length - Math.max(2, maxMsgs - chunkStep);
    for (let pos = minCutPos; pos <= maxCutPos && pos < list.length; pos += 1) {
        const m = list[pos];
        const refIdx = (m && typeof m.index === 'number' && Number.isFinite(m.index) && m.index >= 0) ? m.index : pos;
        if (refIdx % chunkStep === 0) {
            return list.slice(pos);
        }
    }
    return list.slice(minCutPos);
}

function normalizeChatObjMessagesForHistory(chatObj, beforeIndex = Infinity) {
    if (!chatObj || !Array.isArray(chatObj.message)) return [];
    const out = [];
    for (let idx = 0; idx < chatObj.message.length && idx < beforeIndex; idx += 1) {
        const m = chatObj.message[idx];
        if (!m || typeof m !== 'object') continue;
        if (m.disabled === true || m.isComment === true || m.isFirstMessage === true) continue;
        const data = String(m.data ?? '');
        if (!data.trim() && m.role !== 'user') continue;
        out.push({
            index: idx,
            role: String(m.role || '').toLowerCase() === 'user' ? 'user' : 'char',
            raw: data,
            text: data,
            ...(m.chatId ? { chatId: String(m.chatId) } : {}),
        });
    }
    return out;
}

function detectLeaveModelAdapterCode(modelName) {
    const m = String(modelName || '').trim().toLowerCase();
    if (!m) return '';
    if (/claude|anthropic/.test(m)) return '1';
    if (/gemini|gemma/.test(m)) return '2';
    if (/(?:^|\/|\b)(?:gpt[-_.]|o[134](?:[-_]|$)|chatgpt)/.test(m)) return '3';
    if (/deepseek/.test(m)) return '4';
    return '';
}

function reconcileLeaveHayakuFooterContract(messages) {
    const list = Array.isArray(messages) ? messages : [];
    if (!list.length) return list;
    const hasLeaveFooter = list.some((m) => {
        const t = String((m && m.content) || '');
        return /\[LEAVE FINAL EXECUTION CHECK\b|<statusdata>/i.test(t) && /STEP 3\s*—\s*CHARACTER-CARD STATUS LINE|LEAVE HUD/i.test(t);
    });
    if (!hasLeaveFooter) return list;

    let changed = false;
    const out = list.map((m) => {
        if (!m || typeof m !== 'object' || typeof m.content !== 'string') return m;
        const content = m.content;
        if (!/HAYAKU|HAYAKU_STATE_PACKET/i.test(content)) return m;
        if (!/<\/?statusdata>/i.test(content)) return m;
        let next = content
            .replace(/IMMEDIATELY BEFORE <\/statusdata>\.\s*FINAL CONTENT MUST END WITH:\s*<\/statusdata>/gi,
                'Place the entire HAYAKU packet AFTER </statusdata> and any character-card status line (at the very bottom of the response).')
            .replace(/(?:place|emit|output|put|append)\b[^.\n]*?\binside\s*<statusdata>[^.\n]*?<\/statusdata>/gi,
                'Place the entire HAYAKU packet AFTER </statusdata> and any character-card status line (at the very bottom of the response).');
        if (next === content) {
            next = content.replace(/FINAL CONTENT MUST END WITH:\s*<\/statusdata>/gi,
                'FINAL CONTENT MUST END WITH THE HAYAKU PACKET AFTER </statusdata> AND ANY STATUS LINE');
        }
        if (next === content) return m;
        changed = true;
        return { ...m, content: next };
    });
    return changed ? out : list;
}

function stripAuxBlocksFromProse(text) {
    return String(text || '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/<Thoughts>[\s\S]*?<\/Thoughts>/gi, '')
        .replace(/<statusdata>[\s\S]*?<\/statusdata>/gi, '')
        .replace(/<!--\s*HAYAKU_STATE_PACKET_START\s*-->[\s\S]*?<!--\s*HAYAKU_STATE_PACKET_END\s*-->/gi, '')
        .replace(/^\s*\[[☀️🌤️⛅🌥️🌦️🌧️⛈️🌩️❄️🌫️🌙✨][^\n]*\]\s*$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function dedupeTrailingStatusLines(text) {
    const src = String(text ?? '');
    if (!src) return src;
    const isCardStatusLine = (trimmed) => (
        /^\[(?:☀️|🌤️|⛅|🌥️|🌦️|🌧️|⛈️|🌩️|❄️|🌫️|🌙|✨)[^\n]*\]$/.test(trimmed) ||
        /^\[[^\]\n]+\|[^\]\n]+\|[^\]\n]+\]$/.test(trimmed) ||
        /^◈CG\b[^\n]*$/.test(trimmed)
    );

    const hayakuMatch = src.match(/\n*\s*(?:<!--\s*)?HAYAKU_STATE_PACKET_START(?:\s*-->)?[\s\S]*$/);
    const body = hayakuMatch ? src.slice(0, hayakuMatch.index) : src;
    const hayakuTail = hayakuMatch ? hayakuMatch[0] : '';

    const lastCloseIdx = body.toLowerCase().lastIndexOf('</statusdata>');
    const lines = body.split('\n');
    let footerStartLine = lines.length;
    if (lastCloseIdx >= 0) {
        const upToClose = body.slice(0, lastCloseIdx + '</statusdata>'.length);
        footerStartLine = upToClose.split('\n').length;
    } else {
        // Scan backwards over blank lines and trailing status lines
        let i = lines.length - 1;
        while (i >= 0) {
            const tr = lines[i].trim();
            if (!tr || isCardStatusLine(tr)) {
                footerStartLine = i;
                i -= 1;
            } else {
                break;
            }
        }
    }
    if (footerStartLine >= lines.length) return src;

    const headLines = lines.slice(0, footerStartLine);
    const tailLines = lines.slice(footerStartLine);
    const seenStatus = new Set();
    const cleanedTail = [];
    for (const line of tailLines) {
        const tr = line.trim();
        if (lastCloseIdx >= 0 && /^<\/statusdata>$/i.test(tr)) continue;
        if (isCardStatusLine(tr)) {
            if (seenStatus.has(tr)) continue;
            seenStatus.add(tr);
            cleanedTail.push(tr);
            continue;
        }
        cleanedTail.push(line);
    }
    const mergedTail = cleanedTail.join('\n').replace(/^\s+/, '').replace(/\s+$/, '');
    const mergedHead = headLines.join('\n').replace(/\s+$/, '');
    const combinedBody = mergedTail ? (mergedHead ? `${mergedHead}\n\n${mergedTail}` : mergedTail) : mergedHead;
    if (!hayakuTail) return combinedBody;
    return `${combinedBody}\n\n${hayakuTail.replace(/^\s+/, '')}`;
}

function extractTerminalSceneTail(historyMessages, maxChars = 2400) {
    const list = Array.isArray(historyMessages) ? historyMessages : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
        const m = list[i];
        if (!m || typeof m !== 'object') continue;
        const r = String(m.role || '').toLowerCase();
        if (r === 'user' || r === 'system') continue;
        const cleaned = stripAuxBlocksFromProse(m.raw ?? m.text ?? m.content ?? '');
        if (!cleaned) continue;
        return cleaned.length > maxChars ? cleaned.slice(-maxChars).trim() : cleaned;
    }
    return '';
}

function auditDraftWithDeterministicGuards(draftText, { prevAssistantText = '', userText = '', personaName = '', isRpMode = true } = {}) {
    const issues = [];
    const rawDraft = String(draftText || '');
    const visibleDraft = stripAuxBlocksFromProse(rawDraft);
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

    // 1) Prior-turn regression check (repeating sentences from immediately preceding assistant turn)
    const prevNorm = norm(stripAuxBlocksFromProse(prevAssistantText));
    if (prevNorm.length >= 30 && visibleDraft.length >= 30) {
        const draftSentences = visibleDraft
            .split(/(?<=[.!?…。！？\n])\s+/)
            .map((s) => norm(s))
            .filter((s) => s.length >= 16);
        if (draftSentences.length >= 2) {
            const matched = draftSentences.filter((s) => prevNorm.includes(s)).length;
            if (matched / draftSentences.length >= 0.35) {
                issues.push({
                    code: 'prior_turn_regression',
                    message: `Prior-turn regression (${matched}/${draftSentences.length} sentences repeat the previous assistant response). Advance forward directly from the terminal boundary instead of replaying earlier beats.`,
                });
            }
        }
    }

    // 2) RP Persona impersonation check (KO / EN / JP)
    if (isRpMode) {
        const cleanPersona = String(personaName || '').trim();
        const userNorm = norm(userText);
        const thirdPersonPatterns = [
            /(?:^|[\s.!?…"”'’])(?:그가|그녀가)\s+[가-힣]{1,12}(?:을|를|에|에서|에게|로|으로)?\s*(?:들었|받았|받아\s*들|주워\s*들|말했|웃었|고개를|일어섰|걸어|내밀|바라보|움직|대답|물었)/,
            /(?:^|[.!?…"”'’\n]\s*)(?:he|she)\s+(?:took|picked\s+up|replied|nodded|grabbed|smiled|stood\s+up|walked\s+over|handed|reached\s+out|answered)\b/i,
            /(?:^|[。！？「」『』\n\s])(?:彼|彼女)(?:は|が)[^。！？\n]{0,16}(?:受け取|拾い上げ|拾っ|拾い|言っ|言い|笑っ|笑い|頷い|立ち上が|歩き出|手を伸ば|握っ|握り)/,
        ];
        let impersonated = false;
        if (cleanPersona && cleanPersona.length >= 2 && !/^user$/i.test(cleanPersona)) {
            const escaped = cleanPersona.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const personaPatterns = [
                new RegExp(`${escaped}(?:은|는|이|가)\\s+[^.!?\\n]{2,32}(?:했다|말했다|물었다|받았다|들었다|웃었다|움직였다|대답했다)`),
                new RegExp(`\\b${escaped}\\s+(?:said|asked|replied|took|picked\\s+up|grabbed|smiled|nodded|turned|stood\\s+up|walked|reached|answered)\\b`, 'i'),
                new RegExp(`${escaped}(?:は|が)[^。！？\\n]{0,20}(?:言った|聞いた|答えた|受け取った|拾った|笑った|頷いた|立ち上がった|歩いた|掴んだ)`),
            ];
            for (const pRe of personaPatterns) {
                const mSub = visibleDraft.match(pRe);
                if (mSub && !userNorm.toLowerCase().includes(norm(mSub[0]).slice(0, 14).toLowerCase())) {
                    impersonated = true;
                    break;
                }
            }
        }
        if (!impersonated) {
            for (const tpRe of thirdPersonPatterns) {
                const m3 = visibleDraft.match(tpRe);
                if (m3 && !userNorm.toLowerCase().includes(norm(m3[0]).toLowerCase())) {
                    impersonated = true;
                    break;
                }
            }
        }
        if (impersonated) {
            issues.push({
                code: 'rp_impersonation',
                message: 'RP agency violation detected (inventing {{user}} actions/dialogue or third-person proxying via 그가/그녀가 / he/she / 彼/彼女). Delete every invented {{user}} beat and stop cleanly at the NPC/world reaction.',
            });
        }
    }

    // 3) Crutch adverb overuse check (KO / EN / JP)
    const crutchMatches = [
        ...(visibleDraft.match(/아주\s*(?:천천히|짧게|낮게|미세하게|조용하게|조용히|느리게|얇게|가볍게|살짝|잠시|작게|조금|살며시|조심스럽게|은근히)/g) || []),
        ...(visibleDraft.match(/\b(?:very|ever\s+so|almost|barely|faintly|slightly)\s+(?:slowly|quietly|softly|slightly|gently|briefly|lowly|faintly)\b/gi) || []),
        ...(visibleDraft.match(/(?:とても|ごく|ほんの|かすかに|すごく)\s*(?:ゆっくり|小さく|わずかに|静かに|低く|薄く|少し|軽く|短く)/g) || []),
    ];
    if (crutchMatches.length >= 3) {
        issues.push({
            code: 'crutch_adverb_overuse',
            message: `Repetitive crutch intensifier adverbs detected (${crutchMatches.length} matches). Keep at most 1 per scene and replace the rest with concrete physical timing or motion.`,
        });
    }

    // 4) User-quote echo in opening (Latin ""/“”/'' and CJK 「」/『』)
    const userQuoteMatch = String(userText || '').match(/(?:["“']([^"”']{6,40})["”']|[「『]([^」』]{4,40})[」』])/);
    const quotedRaw = userQuoteMatch ? (userQuoteMatch[1] || userQuoteMatch[2] || '') : '';
    if (quotedRaw) {
        const quoted = norm(quotedRaw);
        const head = norm(visibleDraft.slice(0, 240));
        if (quoted && (head.includes(`"${quoted}"`) || head.includes(`“${quoted}”`) || head.includes(`「${quoted}」`) || head.includes(`『${quoted}』`) || head.includes(quoted))) {
            issues.push({
                code: 'user_quote_echo',
                message: `Echo-loop detected: opening repeats user phrase "${quoted}". Open directly with the NPC's own voice or physical reaction.`,
            });
        }
    }

    // 5) Footer order check (status line placed before <statusdata>)
    const hudIdx = rawDraft.search(/<statusdata>/i);
    const cardStatusIdx = rawDraft.search(/^\s*\[[☀️🌤️⛅🌥️🌦️🌧️⛈️🌩️❄️🌫️🌙✨][^\n]*\]/m);
    if (hudIdx >= 0 && cardStatusIdx >= 0 && cardStatusIdx < hudIdx) {
        issues.push({
            code: 'footer_order_violation',
            message: 'Footer order violation: Character-Card Status Line appeared before <statusdata>. Always output Prose -> <statusdata> -> Card Status Line -> HAYAKU packet.',
        });
    }

    return { ok: issues.length === 0, issues };
}

function buildTwoPassDraftMessages({ builtMessages, historyMessages, terminalTail, userText, charName = '', personaName = '', isRpMode = true } = {}) {
    const baseMsgs = Array.isArray(builtMessages) ? builtMessages : [];
    const safeChar = charName || 'Character';
    const compactSys = [];
    for (const m of baseMsgs) {
        if (!m || m.role !== 'system') continue;
        const txt = String(m.content || '');
        if (!txt) continue;
        if (/\[LEAVE FINAL EXECUTION CHECK\b|<statusdata>|HAYAKU SIDE-WRITE FINAL REMINDER|HAYAKU_STATE_PACKET_START/i.test(txt)) {
            continue;
        }
        compactSys.push(txt.slice(0, 6000));
    }
    const sysPrompt = [
        `[TWO-PASS DRAFT ENGINE — PASS 1 (IN-WORLD SCENE DRAFT)]`,
        `- You are writing a clean Pass 1 scene draft for "${safeChar}"${personaName ? ` (User persona: ${personaName})` : ''}.`,
        isRpMode
            ? '- RP AGENCY LOCK: {{user}} performs ONLY what their latest input explicitly states. Never invent unstated {{user}} dialogue, actions, feelings, or third-person proxying ("그가/그녀가" / "he/she" / "彼/彼女").'
            : '- NOVEL MODE: Advance the full cast naturally while honoring author reservations.',
        '- TERMINAL-FIRST CONTINUITY: Continue seamlessly from the immediately preceding scene tail without replaying earlier turns or adding sudden contrived interruptions.',
        '- PROSE ONLY: Output ONLY the raw in-world prose draft. Omit <thinking>, <statusdata>, character-card status lines, and trailing memory packets (Pass 2 will polish and append footers).',
        compactSys.length ? compactSys.join('\n\n').slice(0, 14000) : '',
    ].filter(Boolean).join('\n\n');

    const msgs = [{ role: 'system', content: sysPrompt }];
    const recentChat = (Array.isArray(historyMessages) ? historyMessages : []).slice(-6);
    for (const cm of recentChat) {
        const body = stripAuxBlocksFromProse(cm && (cm.raw || cm.text));
        if (!body) continue;
        msgs.push({ role: cm.role === 'user' ? 'user' : 'assistant', content: body });
    }
    if (terminalTail) {
        msgs.push({
            role: 'system',
            content: `[TERMINAL SCENE TAIL — LAST 2,400 CHARS BEFORE THIS TURN]\n${terminalTail}`,
        });
    }
    if (userText) {
        msgs.push({ role: 'user', content: String(userText) });
    } else if (msgs.length === 1) {
        msgs.push({ role: 'user', content: 'Continue directly from the current scene.' });
    }
    return msgs;
}

function appendTwoPassPolishDirective(finalMsgs, { draftText = '', terminalTail = '', audit = null } = {}) {
    const list = Array.isArray(finalMsgs) ? finalMsgs.slice() : [];
    const issues = (audit && Array.isArray(audit.issues)) ? audit.issues : [];
    const auditBlock = issues.length
        ? issues.map((it, idx) => `${idx + 1}. [${it.code}] ${it.message}`).join('\n')
        : 'NONE — Candidate passed all structural checks. Elevate prose cadence, sensory specificity, and strict closing footer order.';
    const directive = [
        '[TWO-PASS EDITORIAL POLISH — PASS 2 FINISHING]',
        'Below is a Pass 1 candidate draft produced against the Terminal-First lock. Treat it as your raw material: preserve forward plot progress while fixing every listed guard issue, sharpening character voices, cutting crutch intensifier adverbs (e.g., "아주 천천히", "very slowly", "とてもゆっくり" max 1), balancing sentence rhythm, and appending all required closing blocks in exact order (Prose -> <statusdata> -> Card Status Line -> External Memory Packet).',
        terminalTail ? `\n<terminal_scene_tail_anchor>\n${terminalTail.slice(-1200)}\n</terminal_scene_tail_anchor>` : '',
        `\n<deterministic_guard_audit>\n${auditBlock}\n</deterministic_guard_audit>`,
        `\n<pass1_candidate_draft>\n${String(draftText || '').slice(0, 9000)}\n</pass1_candidate_draft>`,
    ].filter(Boolean).join('\n');
    list.push({ role: 'system', content: directive });
    return list;
}

function buildDirectPromptMessages({
    preset = null,
    snap = null,
    historyMessages = [],
    userText = '',
    stagedUserChatId = '',
    remoteToggleValues = null,
    disabledLoreUids = [],
    enabledModuleLoreUids = [],
    pinnedLoreUids = [],
    modelName = '',
} = {}) {
    const s = snap || {};
    const rawCtx = s.charContext && typeof s.charContext === 'object'
        ? s.charContext
        : { name: s.charName || 'Character' };

    const effDirectId = !preset
        ? 'off'
        : (preset.id === LEAVE_PRESET_ID
            ? 'bundled:leave'
            : (preset.id ? `custom:${preset.id}` : ((config && typeof config.directPresetId === 'string' && config.directPresetId) || 'off')));
    const manualPresetToggleSyntax = (Array.isArray(config && config.presetToggles) ? config.presetToggles : [])
        .filter((pt) => pt && pt.enabled !== false && pt.syntax && (!pt.parentPresetId || pt.parentPresetId === effDirectId))
        .map((pt) => pt.syntax)
        .join('\n');
    const modToggleSyntax = (Array.isArray(s.customToggleBlocks) ? s.customToggleBlocks : [])
        .map((b) => (b && b.syntax) || '')
        .filter(Boolean)
        .join('\n');
    const combinedToggleSyntax = [
        manualPresetToggleSyntax,
        modToggleSyntax,
        (preset && (preset.toggleSyntax || preset.customPromptTemplateToggle)) || '',
    ].filter(Boolean).join('\n');

    const globalVars = parsePresetDefaultToggles(
        combinedToggleSyntax,
        (preset && (preset.defaultVariables || preset.templateDefaultVariables)) || ''
    );
    normalizeToggleMapInto(globalVars, s.globalToggleValues);
    normalizeToggleMapInto(globalVars, remoteToggleValues);
    if (s.useLocallySetGlobalVariables) {
        normalizeToggleMapInto(globalVars, s.localToggleValues);
    }
    if (modelName && (Object.prototype.hasOwnProperty.call(globalVars, 'toggle_model_adapter') || combinedToggleSyntax.includes('model_adapter='))) {
        const curAdapter = String(globalVars.toggle_model_adapter ?? '').trim();
        if (!curAdapter || curAdapter === '0' || curAdapter === 'null') {
            const detected = detectLeaveModelAdapterCode(modelName);
            if (detected) {
                globalVars.toggle_model_adapter = detected;
            }
        }
    }

    const chatVars = {};
    if (s.chatVariables && typeof s.chatVariables === 'object' && !Array.isArray(s.chatVariables)) {
        for (const [k, v] of Object.entries(s.chatVariables)) {
            if (k) chatVars[String(k)] = String(v ?? '');
        }
    }

    const chatList = (Array.isArray(historyMessages) ? historyMessages : []).map((m) => ({
        role: m && m.role === 'user' ? 'user' : 'assistant',
        content: String((m && (m.raw || m.text)) || ''),
        ...(m && m.chatId ? { memo: String(m.chatId) } : {}),
    }));
    if (userText) {
        chatList.push({
            role: 'user',
            content: String(userText),
            ...(stagedUserChatId ? { memo: String(stagedUserChatId) } : {}),
        });
    }

    const baseCtx = {
        globalVars,
        chatVars,
        tempVars: {},
        slots: {},
        functions: new Map(),
        callArgs: null,
        callStack: 0,
        chatList,
        lastMessageId: chatList.length > 0 ? chatList.length - 1 : 0,
        chatIndex: chatList.length > 0 ? chatList.length - 1 : 0,
        ptPositions: {},
        charName: String(rawCtx.name || s.charName || 'Character'),
        personaName: String(rawCtx.personaName || 'User'),
        personaPrompt: '',
        desc: '',
        personality: '',
        scenario: '',
        note: '',
        globalNote: preset ? String(preset.globalNote || '') : '',
        mainPrompt: preset ? String(preset.mainPrompt || '') : '',
        jailbreak: preset ? String(preset.jailbreak || '') : '',
    };
    const evalField = (val) => cleanPresetPromptText(evalPresetCbs(String(val || ''), baseCtx));
    const sysPromptText = evalField(rawCtx.systemPrompt);
    baseCtx.desc = evalField(rawCtx.desc);
    baseCtx.personality = evalField(rawCtx.personality);
    baseCtx.scenario = evalField(rawCtx.scenario);
    baseCtx.personaPrompt = evalField(rawCtx.personaPrompt);
    baseCtx.note = evalField(rawCtx.note);
    const memoryText = evalField(rawCtx.memory);
    const replaceGlobalNoteRaw = String(rawCtx.replaceGlobalNote || '');
    const resolveGlobalNote = (fallbackText) => {
        const orig = String(fallbackText || baseCtx.globalNote || '');
        const chosen = replaceGlobalNoteRaw ? replaceGlobalNoteRaw.replace(/\{\{original\}\}/gi, orig) : orig;
        return evalField(chosen);
    };

    const loreBuckets = Array.isArray(rawCtx.loreEntries)
        ? evaluateLorebookEntries({
            loreEntries: rawCtx.loreEntries,
            chatList,
            cbsCtx: baseCtx,
            loreDepth: rawCtx.loreDepth,
            loreTokenBudget: rawCtx.loreTokenBudget,
            loreRecursive: rawCtx.loreRecursive,
            loreFullWord: rawCtx.loreFullWord,
            fmIndex: rawCtx.fmIndex ?? s.fmIndex ?? -1,
            totalChatMessages: rawCtx.totalChatMessages ?? s.totalMessages ?? chatList.length,
            disabledLoreUids,
            enabledModuleLoreUids,
            pinnedLoreUids,
        })
        : {
            normal: rawCtx.moduleLore
                ? [{ role: 'system', content: parseLoreDecorators(evalField(rawCtx.moduleLore)).content || evalField(rawCtx.moduleLore) }]
                : [],
            beforeDesc: [],
            afterDesc: [],
            personality: [],
            scenario: [],
            depthEntries: [],
            postEverything: [],
            ptPositions: {},
        };
    baseCtx.ptPositions = loreBuckets.ptPositions || {};

    if (rawCtx.depthPrompt && typeof rawCtx.depthPrompt === 'object' && rawCtx.depthPrompt.prompt) {
        const dpText = evalField(rawCtx.depthPrompt.prompt);
        const dpDepth = Number(rawCtx.depthPrompt.depth || 0);
        if (dpText) {
            if (dpDepth === 0) loreBuckets.postEverything.push({ role: 'system', content: dpText });
            else loreBuckets.depthEntries.push({ role: 'system', content: dpText, pos: 'depth', depth: dpDepth });
        }
    }

    const normalLoreText = loreBuckets.normal.map((x) => x.content).filter(Boolean).join('\n\n');
    const buildDescText = () => {
        const parts = [];
        for (const x of loreBuckets.beforeDesc) parts.push(x.content);
        if (sysPromptText) parts.push(sysPromptText);
        if (baseCtx.desc) parts.push(`[Character Description]\n${baseCtx.desc}`);
        for (const x of loreBuckets.afterDesc) parts.push(x.content);
        const persCombined = [baseCtx.personality, ...loreBuckets.personality.map((x) => x.content)].filter(Boolean).join('\n\n');
        if (persCombined) parts.push(`[Personality]\n${persCombined}`);
        const scenCombined = [baseCtx.scenario, ...loreBuckets.scenario.map((x) => x.content)].filter(Boolean).join('\n\n');
        if (scenCombined) parts.push(`[Scenario]\n${scenCombined}`);
        return cleanPresetPromptText(parts.join('\n\n'));
    };

    const chatStream = chatList.slice();
    if (loreBuckets.depthEntries.length) {
        for (const d of loreBuckets.depthEntries) {
            const msgObj = { role: d.role || 'system', content: d.content };
            if (!chatStream.length) {
                chatStream.push(msgObj);
                continue;
            }
            let targetIdx;
            if (d.pos === 'reverse_depth') {
                targetIdx = Math.min(chatStream.length - 1, Math.max(0, Number(d.depth || 0)));
            } else {
                targetIdx = Math.min(chatStream.length - 1, Math.max(0, chatStream.length - Number(d.depth || 1)));
            }
            chatStream.splice(targetIdx, 0, msgObj);
        }
    }

    // Fallback: legacy minimal prompt when direct preset is turned off
    if (!preset || !Array.isArray(preset.promptTemplate) || !preset.promptTemplate.length) {
        const sysParts = [];
        sysParts.push(`You are roleplaying as ${baseCtx.charName}. Stay in character and respond naturally.`);
        const descBlock = buildDescText();
        if (descBlock) sysParts.push(descBlock);
        if (normalLoreText) sysParts.push(`[World / Module Lorebook]\n${normalLoreText}`);
        if (rawCtx.personaName || baseCtx.personaPrompt) {
            sysParts.push(`[User Persona: ${baseCtx.personaName}]\n${baseCtx.personaPrompt}`);
        }
        if (memoryText) sysParts.push(`[Memory]\n${memoryText}`);
        if (baseCtx.note) sysParts.push(`[Author's Note]\n${baseCtx.note}`);
        const gn = resolveGlobalNote('');
        if (gn) sysParts.push(gn);
        const out = [{ role: 'system', content: sysParts.join('\n\n') }, ...chatStream];
        for (const pe of loreBuckets.postEverything) {
            out.push({ role: pe.role || 'system', content: pe.content });
        }
        return out;
    }

    const mapRole = (r) => {
        const v = String(r || '').toLowerCase();
        if (v === 'user') return 'user';
        if (v === 'bot' || v === 'char' || v === 'assistant' || v === 'model') return 'assistant';
        return 'system';
    };
    const applyInnerFormat = (item, content) => {
        if (!content) return '';
        if (item && item.innerFormat && String(item.innerFormat).includes('{{slot}}')) {
            return cleanPresetPromptText(evalPresetCbs(String(item.innerFormat).replace(/\{\{slot\}\}/gi, content), baseCtx));
        }
        return content;
    };

    const resolveItemRole = (item, fallback = 'system') => mapRole((item && (item.role || item.role2)) || fallback);

    const firstChatIdx = preset.promptTemplate.findIndex((it) => it && it.type === 'chat');
    const firstLoreIdx = preset.promptTemplate.findIndex((it) => it && it.type === 'lorebook');
    const hasCacheBlock = preset.promptTemplate.some((it) => it && it.type === 'cache');
    const splitStaticLoreForCache = hasCacheBlock && firstChatIdx >= 0 && firstLoreIdx > firstChatIdx;
    const staticNormalLoreItems = splitStaticLoreForCache
        ? loreBuckets.normal.filter((x) => x && x.isStaticAlwaysActive)
        : [];
    const dynamicNormalLoreItems = splitStaticLoreForCache
        ? loreBuckets.normal.filter((x) => !x || !x.isStaticAlwaysActive)
        : loreBuckets.normal;
    const staticNormalLoreText = staticNormalLoreItems.map((x) => x.content).filter(Boolean).join('\n\n');
    const dynamicNormalLoreText = dynamicNormalLoreItems.map((x) => x.content).filter(Boolean).join('\n\n');
    const loreTemplateItem = firstLoreIdx >= 0 ? preset.promptTemplate[firstLoreIdx] : null;
    let emittedStaticLore = false;

    const msgs = [];
    let sawChatBlock = false;
    let emittedPostEverything = false;

    for (const item of preset.promptTemplate) {
        if (!item || typeof item !== 'object') continue;
        const type = String(item.type || 'plain');

        if (type === 'plain') {
            if (item.type2 === 'globalNote') {
                const gn = resolveGlobalNote(item.text);
                if (gn) msgs.push({ role: resolveItemRole(item), content: gn });
                continue;
            }
            let rawText = item.text !== undefined ? String(item.text) : '';
            if (!rawText && item.type2 === 'main') rawText = baseCtx.mainPrompt;
            const evaluated = cleanPresetPromptText(evalPresetCbs(rawText, baseCtx));
            if (evaluated) msgs.push({ role: resolveItemRole(item), content: evaluated });
            continue;
        }
        if (type === 'jailbreak') {
            const rawText = item.text !== undefined ? String(item.text) : baseCtx.jailbreak;
            const evaluated = cleanPresetPromptText(evalPresetCbs(rawText, baseCtx));
            if (evaluated) msgs.push({ role: resolveItemRole(item), content: evaluated });
            continue;
        }
        if (type === 'persona') {
            if (item.innerFormat && String(item.innerFormat).includes('{{slot}}')) {
                const slotVal = cleanPresetPromptText(baseCtx.personaPrompt || (rawCtx.personaName ? `[User: ${baseCtx.personaName}]` : ''));
                const body = cleanPresetPromptText(evalPresetCbs(String(item.innerFormat).replace(/\{\{slot\}\}/gi, slotVal), baseCtx));
                if (body) msgs.push({ role: resolveItemRole(item), content: body });
            } else if (rawCtx.personaName || baseCtx.personaPrompt) {
                const rawPersona = `[User Persona: ${baseCtx.personaName}]\n${baseCtx.personaPrompt}`;
                const body = applyInnerFormat(item, cleanPresetPromptText(rawPersona));
                if (body) msgs.push({ role: resolveItemRole(item), content: body });
            }
            continue;
        }
        if (type === 'description') {
            const body = applyInnerFormat(item, buildDescText());
            if (body) msgs.push({ role: resolveItemRole(item), content: body });
            if (splitStaticLoreForCache && staticNormalLoreText && !emittedStaticLore) {
                const staticLoreBody = applyInnerFormat(loreTemplateItem, cleanPresetPromptText(`[Static World Lorebook]\n${staticNormalLoreText}`));
                if (staticLoreBody) {
                    msgs.push({ role: resolveItemRole(loreTemplateItem || item), content: staticLoreBody });
                }
                emittedStaticLore = true;
            }
            continue;
        }
        if (type === 'lorebook') {
            const loreContent = splitStaticLoreForCache
                ? (emittedStaticLore ? dynamicNormalLoreText : normalLoreText)
                : normalLoreText;
            if (loreContent) {
                const body = applyInnerFormat(item, cleanPresetPromptText(`[World / Module Lorebook]\n${loreContent}`));
                if (body) msgs.push({ role: resolveItemRole(item), content: body });
            }
            continue;
        }
        if (type === 'memory') {
            const bodyParts = [];
            if (item.text) {
                const t = evalField(item.text);
                if (t) bodyParts.push(t);
            }
            if (memoryText) bodyParts.push(memoryText);
            const body = applyInnerFormat(item, cleanPresetPromptText(bodyParts.join('\n\n')));
            if (body) msgs.push({ role: resolveItemRole(item), content: body });
            continue;
        }
        if (type === 'authornote') {
            if (baseCtx.note) {
                const rawNote = (item.innerFormat && String(item.innerFormat).includes('{{slot}}'))
                    ? baseCtx.note
                    : `[Author's Note]\n${baseCtx.note}`;
                const body = applyInnerFormat(item, cleanPresetPromptText(rawNote));
                if (body) msgs.push({ role: resolveItemRole(item), content: body });
            }
            continue;
        }
        if (type === 'chat') {
            sawChatBlock = true;
            const sliced = sliceChatRange(chatStream, item.rangeStart, item.rangeEnd);
            for (const cm of sliced) {
                if (cm.content || cm.role === 'user') {
                    msgs.push({
                        role: cm.role,
                        content: cm.content,
                        ...(cm.memo ? { memo: cm.memo } : {}),
                    });
                }
            }
            continue;
        }
        if (type === 'postEverything') {
            emittedPostEverything = true;
            if (item.text) {
                const evaluated = cleanPresetPromptText(evalPresetCbs(String(item.text), baseCtx));
                if (evaluated) msgs.push({ role: mapRole(item.role), content: evaluated });
            }
            for (const pe of loreBuckets.postEverything) {
                msgs.push({ role: pe.role || 'system', content: pe.content });
            }
            continue;
        }
        if (type === 'cache') {
            if (item.text) {
                const evaluated = cleanPresetPromptText(evalPresetCbs(String(item.text), baseCtx));
                if (evaluated) msgs.push({ role: mapRole(item.role), content: evaluated });
            }
            if (msgs.length > 0) {
                msgs[msgs.length - 1]._cachePoint = true;
            }
            continue;
        }
        if (item.text) {
            const evaluated = cleanPresetPromptText(evalPresetCbs(String(item.text), baseCtx));
            if (evaluated) msgs.push({ role: mapRole(item.role), content: evaluated });
        }
    }

    if (!sawChatBlock && chatStream.length) {
        msgs.push(...chatStream);
    }
    if (!emittedPostEverything && loreBuckets.postEverything.length) {
        for (const pe of loreBuckets.postEverything) {
            msgs.push({ role: pe.role || 'system', content: pe.content });
        }
    }
    return msgs;
}

function getLoreCharKeyFromSnap(snap) {
    const rawCtx = snap && snap.charContext && typeof snap.charContext === 'object' ? snap.charContext : null;
    if (rawCtx && rawCtx.charId) return String(rawCtx.charId);
    if (snap && typeof snap.charIndex === 'number' && snap.charIndex >= 0) return `idx:${snap.charIndex}`;
    return String((snap && snap.charName) || 'default');
}

let activePluginAdapter = null;
let activeModuleAdapter = null;
let activeHostRpc = null;

function syncSnapVarsFromChatObj(snap, chatObj) {
    if (!snap || !chatObj || !chatObj.scriptstate || typeof chatObj.scriptstate !== 'object') return snap;
    const nextVars = { ...(snap.chatVariables || {}) };
    for (const [k, v] of Object.entries(chatObj.scriptstate)) {
        const clean = k.startsWith('$') ? k.slice(1) : k;
        if (clean) nextVars[clean] = String(v ?? '');
    }
    return { ...snap, chatVariables: nextVars };
}

function resolveEffectiveWritingRpMode(preset, snap, remoteToggleValues = null) {
    const vars = parsePresetDefaultToggles(
        (preset && (preset.toggleSyntax || preset.customPromptTemplateToggle)) || '',
        (preset && (preset.defaultVariables || preset.templateDefaultVariables)) || ''
    );
    normalizeToggleMapInto(vars, snap && snap.globalToggleValues);
    normalizeToggleMapInto(vars, remoteToggleValues);
    if (snap && snap.useLocallySetGlobalVariables) {
        normalizeToggleMapInto(vars, snap.localToggleValues);
    }
    return String(vars.toggle_writing_mode ?? '0').trim() !== '1';
}

function selectSourceHistoryForTurn(tCtx, snap, beforeIndex = Infinity) {
    const chatObj = tCtx && tCtx.chatObj;
    const snapMsgs = Array.isArray(snap && snap.messages)
        ? snap.messages.filter((m) => !(Number.isFinite(beforeIndex) && typeof m.index === 'number' && m.index >= beforeIndex))
        : [];
    if (chatObj && Array.isArray(chatObj.message)) {
        const fullMsgs = normalizeChatObjMessagesForHistory(chatObj, beforeIndex);
        if (fullMsgs.length >= snapMsgs.length) return fullMsgs;
    }
    return snapMsgs;
}

async function executeDirectModelTurn({
    profile,
    preset,
    snap,
    historyMessages,
    userText = '',
    builtMessages,
    finalMsgs,
    charIndex,
    chatIndex,
    source = 'direct_chat',
    adapter = null,
}) {
    const charName = String((snap && (snap.charName || (snap.charContext && snap.charContext.name))) || '');
    const personaName = String((snap && snap.charContext && snap.charContext.personaName) || 'User');
    const narrativeScopeKey = `${charIndex}:${chatIndex}`;
    const presetTemperature = preset && preset.temperature;
    const presetMaxTokens = preset && preset.maxResponse;

    let outgoingMsgs = finalMsgs;
    if (normalizeDirectPipelineMode(config.directPipelineMode) === 'two_pass' && preset) {
        const draftProfile = getAuxProfile() || profile;
        const terminalTail = extractTerminalSceneTail(historyMessages, 2400);
        const isRpMode = resolveEffectiveWritingRpMode(preset, snap, config.remoteToggleValues);
        const draftMsgs = buildTwoPassDraftMessages({
            builtMessages,
            historyMessages,
            terminalTail,
            userText,
            charName,
            personaName,
            isRpMode,
        });
        console.log(`[DirectChat Pass1] char#${charIndex} chat#${chatIndex} via ${draftProfile.name} (${draftProfile.model}) tail=${terminalTail.length}c`);
        const draftRes = await callLLMNonStream(draftProfile, draftMsgs, {
            source: 'direct_draft',
            remotePrompt: false,
            presetId: String(preset.id || config.directPresetId || ''),
            presetName: String(preset.name || ''),
            narrativeScopeKey,
            charName,
            presetTemperature,
            presetMaxTokens: Math.min(4096, Number(presetMaxTokens) || 4096),
        });
        const audit = auditDraftWithDeterministicGuards(draftRes && draftRes.text, {
            prevAssistantText: terminalTail,
            userText,
            personaName,
            isRpMode,
        });
        if (!audit.ok) {
            console.log(`[DirectChat Guard] ${audit.issues.map((x) => x.code).join(', ')}`);
        }
        outgoingMsgs = appendTwoPassPolishDirective(finalMsgs, {
            draftText: draftRes && draftRes.text,
            terminalTail,
            audit,
        });
    }

    return callLLMNonStream(profile, outgoingMsgs, {
        source,
        remotePrompt: Boolean(preset),
        presetId: preset ? String(preset.id || config.directPresetId || '') : '',
        presetName: preset ? String(preset.name || '') : '',
        narrativeScopeKey,
        charName,
        presetTemperature,
        presetMaxTokens,
        interceptBody: adapter ? (b, t) => adapter.runBodyIntercepters(b, t) : undefined,
    });
}

// ================= Direct Remote Chat (for non-PC-active chars) =================
async function runDirectRemoteChat(charIndex, chatIndex, userText, snapView = state.snapshot) {
    const profile = getActiveProfile();
    if (!profile) {
        throw new Error('PC에서 현재 열려있지 않은 봇과 대화하려면 [모델/번역] 탭에서 활성 모델 프로필을 먼저 설정해야 합니다.');
    }
    let snap = snapView || state.snapshot;
    const preset = resolveDirectPreset(config.directPresetId);
    const loreKey = getLoreCharKeyFromSnap(snap);
    const adapter = activePluginAdapter && (activePluginAdapter.hasEnabledPlugins() || (activeHostRpc && activeHostRpc.isConnected()))
        ? activePluginAdapter
        : null;
    const modAdapter = activeModuleAdapter;

    state.directGenerating = true;
    try {
        let effectiveUserText = String(userText ?? '');
        if (adapter) {
            await adapter.prepareTurn(charIndex, chatIndex, snap);
            const tCtx0 = adapter.getTurnContext();
            if (tCtx0.chatObj && snap) {
                if (snap.useLocallySetGlobalVariables !== undefined) {
                    tCtx0.chatObj.useLocallySetGlobalVariables = Boolean(snap.useLocallySetGlobalVariables);
                }
                if (tCtx0.chatObj.useLocallySetGlobalVariables && snap.localToggleValues && typeof snap.localToggleValues === 'object') {
                    tCtx0.chatObj.GLGlobalVariables = { ...(tCtx0.chatObj.GLGlobalVariables || {}), ...snap.localToggleValues };
                }
            }
            if (modAdapter) {
                await modAdapter.prepareTurn({
                    charIndex,
                    chatIndex,
                    charObj: tCtx0.charObj,
                    chatObj: tCtx0.chatObj,
                    onSyncBack: (objs) => adapter.setTurnObjects(objs),
                });
            }
            if (effectiveUserText) {
                if (modAdapter) effectiveUserText = await modAdapter.runEditPhase('editInput', effectiveUserText);
                effectiveUserText = await adapter.runEditInput(effectiveUserText);
            }
        } else if (modAdapter) {
            await modAdapter.prepareTurn({ charIndex, chatIndex, charObj: null, chatObj: null });
            if (effectiveUserText) {
                effectiveUserText = await modAdapter.runEditPhase('editInput', effectiveUserText);
            }
        }

        const tCtxPreStage = adapter ? adapter.getTurnContext() : null;
        const sourceHistory = selectSourceHistoryForTurn(tCtxPreStage, snap);
        const history = selectCacheFriendlyHistory(sourceHistory, { mode: normalizeDirectHistoryMode(config.directHistoryMode) });

        if (adapter && effectiveUserText) {
            adapter.stageUserTurnMessage(effectiveUserText);
        }

        if (modAdapter) {
            if (effectiveUserText) {
                await modAdapter.runTriggerMode('input');
            }
            const startRes = await modAdapter.runTriggerMode('start');
            if (startRes && startRes.stopSending) {
                if (adapter) {
                    const tCtxStop = adapter.getTurnContext();
                    adapter.unstageUserTurnMessage();
                    if (activeHostRpc && activeHostRpc.isConnected() && tCtxStop.chatObj) {
                        await activeHostRpc.invoke('db.setChat', [Number(charIndex), Number(chatIndex), JSON.parse(JSON.stringify(tCtxStop.chatObj))]);
                    }
                }
                return '';
            }
            if (adapter) {
                snap = syncSnapVarsFromChatObj(snap, adapter.getTurnContext().chatObj);
            }
        }

        const tCtx1 = adapter ? adapter.getTurnContext() : { stagedUserChatId: '' };
        let msgs = buildDirectPromptMessages({
            preset,
            snap,
            historyMessages: history,
            userText: effectiveUserText,
            stagedUserChatId: tCtx1.stagedUserChatId || '',
            remoteToggleValues: config.remoteToggleValues,
            disabledLoreUids: (config.disabledLoreEntries && config.disabledLoreEntries[loreKey]) || [],
            enabledModuleLoreUids: (config.enabledModuleLoreEntries && config.enabledModuleLoreEntries[loreKey]) || [],
            pinnedLoreUids: (config.pinnedLoreEntries && config.pinnedLoreEntries[loreKey]) || [],
            modelName: profile.model || '',
        });

        if (modAdapter) {
            msgs = await modAdapter.runEditPhase('editRequest', msgs);
        }
        if (adapter) {
            msgs = await adapter.runBeforeRequest(msgs, 'model');
        }
        msgs = reconcileLeaveHayakuFooterContract(msgs);

        const finalMsgs = applyPromptOverride(msgs, profile);
        console.log(`[DirectChat] char#${charIndex} chat#${chatIndex} via ${profile.name} (${profile.model}) preset=${preset ? preset.name : 'off'} hist=${history.length}/${sourceHistory.length}(${normalizeDirectHistoryMode(config.directHistoryMode)}) pipe=${normalizeDirectPipelineMode(config.directPipelineMode)}${adapter ? ' +plugins' : ''}`);
        let result;
        try {
            result = await executeDirectModelTurn({
                profile,
                preset,
                snap,
                historyMessages: history,
                userText: effectiveUserText,
                builtMessages: msgs,
                finalMsgs,
                charIndex,
                chatIndex,
                source: 'direct_chat',
                adapter,
            });
        } catch (err) {
            if (adapter) adapter.unstageUserTurnMessage();
            throw err;
        }

        let finalReply = result.text;
        if (modAdapter) {
            finalReply = await modAdapter.runEditPhase('editOutput', finalReply);
        }
        if (adapter) {
            finalReply = await adapter.runAfterRequest(finalReply, 'model');
        }
        finalReply = dedupeTrailingStatusLines(finalReply);

        if (adapter) {
            const tCtxPre = adapter.getTurnContext();
            let messageIndex = -1;
            if (tCtxPre.chatObj) {
                if (!Array.isArray(tCtxPre.chatObj.message)) tCtxPre.chatObj.message = [];
                tCtxPre.chatObj.message.push({
                    role: 'char',
                    data: String(finalReply ?? ''),
                    chatId: crypto.randomUUID(),
                    time: Date.now(),
                });
                messageIndex = tCtxPre.chatObj.message.length - 1;
            }
            if (modAdapter) {
                await modAdapter.runTriggerMode('output');
                if (tCtxPre.chatObj && messageIndex >= 0 && tCtxPre.chatObj.message[messageIndex]) {
                    finalReply = String(tCtxPre.chatObj.message[messageIndex].data ?? finalReply);
                }
            }
            const committed = (activeHostRpc && activeHostRpc.isConnected() && tCtxPre.chatObj)
                ? (await activeHostRpc.invoke('db.setChat', [Number(charIndex), Number(chatIndex), JSON.parse(JSON.stringify(tCtxPre.chatObj))]), { committedViaRpc: true, messageIndex })
                : { committedViaRpc: false, messageIndex };
            if (!committed.committedViaRpc) {
                const appended = [];
                if (effectiveUserText) appended.push({ role: 'user', data: effectiveUserText, chatId: tCtx1.stagedUserChatId || '' });
                appended.push({ role: 'char', data: finalReply });
                queueCommand('append_messages', { charIndex, chatIndex, messages: appended });
            }
            await adapter.dispatchChatOutput({ charIndex, chatIndex, messageIndex: committed.messageIndex });
            return finalReply;
        }

        const appended = [];
        if (effectiveUserText) appended.push({ role: 'user', data: effectiveUserText });
        appended.push({ role: 'char', data: finalReply });
        queueCommand('append_messages', {
            charIndex,
            chatIndex,
            messages: appended,
        });
        return finalReply;
    } finally {
        if (modAdapter) modAdapter.endTurn();
        if (adapter) adapter.endTurn();
        state.directGenerating = false;
    }
}

async function runDirectRemoteReroll(charIndex, chatIndex, msgIndex, snapView = state.snapshot) {
    const profile = getActiveProfile();
    if (!profile) {
        throw new Error('PC에서 현재 열려있지 않은 봇을 리롤하려면 [모델/번역] 탭에서 활성 모델 프로필을 먼저 설정해야 합니다.');
    }
    let snap = snapView || state.snapshot;
    const preset = resolveDirectPreset(config.directPresetId);
    const loreKey = getLoreCharKeyFromSnap(snap);
    const adapter = activePluginAdapter && (activePluginAdapter.hasEnabledPlugins() || (activeHostRpc && activeHostRpc.isConnected()))
        ? activePluginAdapter
        : null;
    const modAdapter = activeModuleAdapter;

    state.directGenerating = true;
    try {
        if (adapter) {
            await adapter.prepareTurn(charIndex, chatIndex, snap);
            const tCtx0 = adapter.getTurnContext();
            if (tCtx0.chatObj && snap) {
                if (snap.useLocallySetGlobalVariables !== undefined) {
                    tCtx0.chatObj.useLocallySetGlobalVariables = Boolean(snap.useLocallySetGlobalVariables);
                }
                if (tCtx0.chatObj.useLocallySetGlobalVariables && snap.localToggleValues && typeof snap.localToggleValues === 'object') {
                    tCtx0.chatObj.GLGlobalVariables = { ...(tCtx0.chatObj.GLGlobalVariables || {}), ...snap.localToggleValues };
                }
            }
            if (modAdapter) {
                await modAdapter.prepareTurn({
                    charIndex,
                    chatIndex,
                    charObj: tCtx0.charObj,
                    chatObj: tCtx0.chatObj,
                    onSyncBack: (objs) => adapter.setTurnObjects(objs),
                });
                snap = syncSnapVarsFromChatObj(snap, tCtx0.chatObj);
            }
        }
        const tCtxPrior = adapter ? adapter.getTurnContext() : null;
        const sourcePrior = selectSourceHistoryForTurn(tCtxPrior, snap, msgIndex);
        const prior = selectCacheFriendlyHistory(sourcePrior, { mode: normalizeDirectHistoryMode(config.directHistoryMode) });
        let msgs = buildDirectPromptMessages({
            preset,
            snap,
            historyMessages: prior,
            userText: '',
            remoteToggleValues: config.remoteToggleValues,
            disabledLoreUids: (config.disabledLoreEntries && config.disabledLoreEntries[loreKey]) || [],
            enabledModuleLoreUids: (config.enabledModuleLoreEntries && config.enabledModuleLoreEntries[loreKey]) || [],
            pinnedLoreUids: (config.pinnedLoreEntries && config.pinnedLoreEntries[loreKey]) || [],
            modelName: profile.model || '',
        });
        if (modAdapter) {
            msgs = await modAdapter.runEditPhase('editRequest', msgs);
        }
        if (adapter) {
            msgs = await adapter.runBeforeRequest(msgs, 'model');
        }
        msgs = reconcileLeaveHayakuFooterContract(msgs);

        const finalMsgs = applyPromptOverride(msgs, profile);
        console.log(`[DirectReroll] char#${charIndex} chat#${chatIndex} msg#${msgIndex} via ${profile.name} (${profile.model}) preset=${preset ? preset.name : 'off'} hist=${prior.length}/${sourcePrior.length}${adapter ? ' +plugins' : ''}`);
        const result = await executeDirectModelTurn({
            profile,
            preset,
            snap,
            historyMessages: prior,
            userText: '',
            builtMessages: msgs,
            finalMsgs,
            charIndex,
            chatIndex,
            source: 'direct_reroll',
            adapter,
        });
        let finalReply = result.text;
        if (modAdapter) {
            finalReply = await modAdapter.runEditPhase('editOutput', finalReply);
        }
        if (adapter) {
            finalReply = await adapter.runAfterRequest(finalReply, 'model');
        }
        finalReply = dedupeTrailingStatusLines(finalReply);

        if (adapter) {
            const tCtxPre = adapter.getTurnContext();
            if (tCtxPre.chatObj && Array.isArray(tCtxPre.chatObj.message) && tCtxPre.chatObj.message[msgIndex]) {
                tCtxPre.chatObj.message[msgIndex].data = String(finalReply ?? '');
                if (!tCtxPre.chatObj.message[msgIndex].chatId) {
                    tCtxPre.chatObj.message[msgIndex].chatId = crypto.randomUUID();
                }
            }
            if (modAdapter) {
                await modAdapter.runTriggerMode('output');
                if (tCtxPre.chatObj && tCtxPre.chatObj.message[msgIndex]) {
                    finalReply = String(tCtxPre.chatObj.message[msgIndex].data ?? finalReply);
                }
            }
            const committedViaRpc = Boolean(activeHostRpc && activeHostRpc.isConnected() && tCtxPre.chatObj);
            if (committedViaRpc) {
                await activeHostRpc.invoke('db.setChat', [Number(charIndex), Number(chatIndex), JSON.parse(JSON.stringify(tCtxPre.chatObj))]);
            } else {
                queueCommand('replace_message_with_swipe', { charIndex, chatIndex, msgIndex, newData: finalReply });
            }
            await adapter.dispatchChatOutput({ charIndex, chatIndex, messageIndex: msgIndex });
            return finalReply;
        }

        queueCommand('replace_message_with_swipe', {
            charIndex,
            chatIndex,
            msgIndex,
            newData: finalReply,
        });
        return finalReply;
    } finally {
        if (modAdapter) modAdapter.endTurn();
        if (adapter) adapter.endTurn();
        state.directGenerating = false;
    }
}

// ================= Mobile Web UI =================
function renderWebApp() {
    return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="theme-color" id="themeColorMeta" content="#ffffff" />
<title>RisuStand Remote v${RELAY_VERSION}</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(RS_LOGO_SVG)}" />
<style>
  /* ===== Design tokens (light defaults) ===== */
  :root {
    --bg: #ffffff; --bg-grad: none; --surface: #f4f6f9; --surface2: #eaeef5; --elev: #ffffff;
    --text: #1b1c1d; --sub: #5f6368; --border: #e1e5ec;
    --accent: #1a73e8; --on-accent: #ffffff;
    --accent-soft: color-mix(in srgb, var(--accent) 14%, transparent);
    --user-bg: #e8f0fe; --user-text: #174ea6;
    --header-bg: color-mix(in srgb, var(--bg) 82%, transparent);
    --ok: #15803d; --danger: #dc2626;
    --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.06), 0 1px 3px rgba(15, 23, 42, 0.05);
    --shadow: 0 10px 30px -12px rgba(15, 23, 42, 0.22), 0 4px 10px -6px rgba(15, 23, 42, 0.12);
    --radius: 16px; --radius-sm: 10px;
    --book-bg: #f4efe6; --book-spine: rgba(0,0,0,0.09); --leaf-bg: linear-gradient(90deg, #ede5d6 0%, #f8f3ea 45%, #e4d9c6 100%);
    --font: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Malgun Gothic", sans-serif;
    --ui-font: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Malgun Gothic", system-ui, sans-serif;
    --fsize: 15.5px; --lh: 1.75;
    --content-w: 820px;
    color-scheme: light;
  }
  /* 1. Gemini */
  [data-theme="ai-gemini"] {
    --bg: #ffffff; --surface: #f0f4f9; --surface2: #e3e9f2; --text: #1f1f1f; --sub: #5e6368;
    --border: #e1e6ed; --accent: #0b57d0; --user-bg: #e9eef6; --user-text: #1f1f1f;
  }
  /* 2. Claude */
  [data-theme="ai-claude"] {
    --bg: #faf9f5; --surface: #f0eee6; --surface2: #e6e2d6; --elev: #ffffff; --text: #1a1918; --sub: #6b6860;
    --border: #e2dfd5; --accent: #c96442; --user-bg: #f0eee6; --user-text: #1a1918;
  }
  /* 3. ChatGPT */
  [data-theme="ai-chatgpt"] {
    --bg: #ffffff; --surface: #f7f7f8; --surface2: #ececec; --text: #0d0d0d; --sub: #6b6b6b;
    --border: #e6e6e6; --accent: #0d0d0d; --accent-soft: rgba(0, 0, 0, 0.07); --user-bg: #f2f2f2; --user-text: #0d0d0d;
  }
  /* 4 & 6. EPUB Sepia */
  [data-theme="epub-1p-day"], [data-theme="epub-2p-day"] {
    --bg: #f4efe6; --surface: #ece5d7; --surface2: #e2d8c6; --elev: #faf6ee; --text: #2a241e; --sub: #75685a;
    --border: #ddd2bf; --accent: #8c5a2b; --user-bg: #ebe2cf; --user-text: #2a241e;
    --book-bg: #f8f3e9; --book-spine: rgba(90,65,40,0.14);
    --leaf-bg: linear-gradient(90deg, #e7decb 0%, #faf6ee 50%, #dfd3bc 100%);
    --shadow: 0 14px 34px -14px rgba(74, 52, 28, 0.32), 0 4px 10px -6px rgba(74, 52, 28, 0.16);
  }
  /* 5 & 7. EPUB Night */
  [data-theme="epub-1p-night"], [data-theme="epub-2p-night"] {
    --bg: #141518; --surface: #1c1e23; --surface2: #262930; --elev: #1c1e23; --text: #e4e1da; --sub: #9a968c;
    --border: #2b2d34; --accent: #d2a86e; --on-accent: #1b1b20; --user-bg: #24262d; --user-text: #f0e9dc;
    --book-bg: #1a1b20; --book-spine: rgba(0,0,0,0.6);
    --leaf-bg: linear-gradient(90deg, #1b1e25 0%, #2a2c33 50%, #14161b 100%);
  }
  /* 8. Midnight Glass */
  [data-theme="midnight-glass"] {
    --bg: #0a0f1f;
    --bg-grad: radial-gradient(1200px 600px at 10% -10%, rgba(99, 102, 241, 0.28), transparent 60%), radial-gradient(900px 500px at 110% 10%, rgba(56, 189, 248, 0.16), transparent 55%), radial-gradient(900px 700px at 50% 120%, rgba(168, 85, 247, 0.18), transparent 60%);
    --surface: rgba(30, 41, 75, 0.55); --surface2: rgba(48, 62, 108, 0.6); --elev: rgba(24, 33, 62, 0.72);
    --text: #edf2ff; --sub: #a3b0d6; --border: rgba(140, 162, 235, 0.2);
    --accent: #8ea2ff; --on-accent: #0a0f1f; --user-bg: rgba(99, 120, 240, 0.3); --user-text: #f1f4ff;
    --header-bg: rgba(10, 15, 31, 0.55);
  }
  /* 9. Sakura Pastel */
  [data-theme="sakura-pastel"] {
    --bg: #fff8fb;
    --bg-grad: radial-gradient(900px 500px at 100% 0%, rgba(255, 200, 221, 0.45), transparent 60%), radial-gradient(800px 500px at 0% 100%, rgba(255, 228, 236, 0.6), transparent 60%);
    --surface: #fdeef4; --surface2: #f9dde8; --elev: #ffffff; --text: #3d2430; --sub: #8a5c71;
    --border: #f3d3e0; --accent: #c2477a; --user-bg: #fbe0eb; --user-text: #3d2430;
    --shadow: 0 12px 30px -14px rgba(194, 71, 122, 0.35), 0 4px 10px -6px rgba(194, 71, 122, 0.15);
  }
  /* 10. Forest Moss */
  [data-theme="forest-moss"] {
    --bg: #111a15;
    --bg-grad: radial-gradient(1000px 600px at 0% 0%, rgba(94, 184, 132, 0.12), transparent 60%);
    --surface: #1a251f; --surface2: #233229; --elev: #18231d; --text: #e2ece6; --sub: #93ab9d;
    --border: #2a3b31; --accent: #6cc493; --on-accent: #0f1a14; --user-bg: #22392c; --user-text: #e8f3ec;
  }
  /* Dark-scheme shared tokens */
  [data-theme="epub-1p-night"], [data-theme="epub-2p-night"], [data-theme="midnight-glass"], [data-theme="forest-moss"] {
    --ok: #4ade80; --danger: #f87171; color-scheme: dark;
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
    --shadow: 0 16px 40px -16px rgba(0,0,0,0.7), 0 4px 12px -6px rgba(0,0,0,0.45);
  }

  /* Font Overrides */
  [data-font="serif"] { --font: "RIDIBatang", "KoPub Batang", "AppleMyungjo", "Batang", "Noto Serif KR", Georgia, serif; }
  [data-font="sans"] { --font: "Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif; }
  [data-font="system"] { --font: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", sans-serif; }

  /* ===== Base ===== */
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body {
    margin:0; padding:0; height:100%; overflow:hidden;
    background: var(--bg-grad), var(--bg); background-attachment: fixed;
    color: var(--text); font-family: var(--ui-font); -webkit-font-smoothing: antialiased;
    transition: background-color 0.25s ease, color 0.25s ease;
  }
  button { font-family: inherit; }
  select, input, textarea { font-family: inherit; color: var(--text); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  ::selection { background: var(--accent-soft); }
  * { scrollbar-width: thin; scrollbar-color: var(--surface2) transparent; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: var(--surface2); border-radius: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }

  #app {
    display: grid; height: 100dvh; width: 100%;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr) auto auto;
    grid-template-areas: "header" "main" "composer" "nav";
  }

  /* ===== Header ===== */
  header {
    grid-area: header; position: relative; z-index: 30;
    display:flex; align-items:center; justify-content:space-between; gap:8px;
    height: calc(54px + env(safe-area-inset-top));
    min-height: calc(54px + env(safe-area-inset-top));
    max-height: calc(54px + env(safe-area-inset-top));
    padding: env(safe-area-inset-top) max(12px, env(safe-area-inset-right)) 0 max(12px, env(safe-area-inset-left));
    border-bottom:1px solid var(--border); background: var(--header-bg);
    -webkit-backdrop-filter: saturate(160%) blur(14px); backdrop-filter: saturate(160%) blur(14px);
  }
  .h-left { min-width:0; display:flex; align-items:center; gap:10px; flex:1; padding: 2px 4px; margin-left:-4px; border-radius: 10px; }
  .h-left:active { background: var(--accent-soft); }
  .dot { width:8px; height:8px; border-radius:50%; background:#9ca3af; flex-shrink:0; box-shadow: 0 0 0 3px color-mix(in srgb, #9ca3af 22%, transparent); }
  .dot.on { background:#22c55e; box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.22); }
  .h-title { font-weight:700; font-size:15px; line-height:20px; letter-spacing:-0.01em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .h-sub-row {
    display:flex; align-items:center; gap:6px;
    height:18px; min-height:18px; max-height:18px;
    min-width:0; overflow:hidden; white-space:nowrap; margin-top:1px;
  }
  .h-sub { font-size:11.5px; line-height:18px; color:var(--sub); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; flex-shrink:1; }
  .hdr-act-bar {
    display:inline-flex; align-items:center; gap:4px; flex-wrap:nowrap;
    height:18px; min-width:0; max-width:65%; flex-shrink:0; overflow:hidden;
  }
  .hdr-act-bar:empty { display:none; }
  .hdr-act-pill {
    display:inline-flex; align-items:center; gap:4px; height:16px; padding:0 7px; border-radius:999px;
    font-size:10.5px; font-weight:700; line-height:1; letter-spacing:-0.01em;
    background:color-mix(in srgb, var(--accent) 14%, var(--surface));
    color:var(--text); border:1px solid color-mix(in srgb, var(--accent) 36%, var(--border));
    max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .hdr-act-pill.recent {
    background:color-mix(in srgb, var(--ok) 12%, var(--surface));
    border-color:color-mix(in srgb, var(--ok) 32%, var(--border));
    color:var(--sub);
  }
  .hdr-act-dot {
    width:6px; height:6px; border-radius:50%; background:var(--accent); flex-shrink:0;
    animation: rsPulseDot 1.1s ease-in-out infinite;
  }
  @keyframes rsPulseDot {
    0%, 100% { opacity:1; transform:scale(1); }
    50% { opacity:0.4; transform:scale(0.75); }
  }
  .h-right { display:flex; align-items:center; gap:6px; flex-shrink:0; }

  .pill {
    display:inline-flex; align-items:center; justify-content:center; gap:4px;
    min-height:34px; min-width:34px; padding:0 11px;
    border:1px solid var(--border); background:var(--elev); color:var(--text);
    border-radius:999px; font-size:12.5px; font-weight:600; cursor:pointer; outline:none;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, transform 0.1s ease;
  }
  .pill:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
  .pill:active { transform: scale(0.96); }
  .pill.active { background:var(--accent); color:var(--on-accent); border-color:var(--accent); }
  .pill:disabled { opacity:0.4; cursor:default; transform:none; }
  .icon-pill { padding:0; width:36px; height:36px; font-size:15px; }

  /* ===== Reading / Display Settings Popover ===== */
  .read-bar {
    position:fixed; top: calc(58px + env(safe-area-inset-top)); right: max(10px, env(safe-area-inset-right)); z-index: 165;
    width: min(380px, calc(100vw - 20px)); max-height: calc(100dvh - 80px); overflow-y: auto;
    display:flex; flex-direction:column; gap:14px; padding:16px;
    background: var(--elev); border:1px solid var(--border); border-radius: 18px;
    box-shadow: var(--shadow);
    -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px);
    opacity:0; transform: translateY(-6px) scale(0.98); transform-origin: top right;
    pointer-events:none; visibility:hidden;
    transition: opacity 0.16s ease, transform 0.16s ease, visibility 0s linear 0.16s;
  }
  .read-bar.open { opacity:1; transform:none; pointer-events:auto; visibility:visible; transition: opacity 0.16s ease, transform 0.16s ease; }
  .rb-sec { display:flex; flex-direction:column; gap:8px; }
  .rb-label { font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:var(--sub); }
  .rb-grp { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .rb-val { min-width:40px; text-align:center; font-size:13px; font-weight:700; font-variant-numeric: tabular-nums; }
  .seg { display:flex; padding:3px; gap:2px; background:var(--surface); border:1px solid var(--border); border-radius:999px; width:100%; }
  .seg .pill { flex:1; border:none; background:transparent; min-height:30px; }
  .seg .pill.active { background:var(--elev); color:var(--text); box-shadow: var(--shadow-sm); }
  .theme-grid { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:6px; }
  .theme-chip {
    display:flex; align-items:center; gap:9px; padding:8px 10px; min-height:40px;
    border:1px solid var(--border); border-radius:12px; background:transparent; color:var(--text);
    font-size:12.5px; font-weight:600; cursor:pointer; text-align:left;
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  .theme-chip:hover { background: var(--surface); }
  .theme-chip.active { border-color: var(--accent); background: var(--accent-soft); }
  .theme-chip .sw {
    width:20px; height:20px; border-radius:50%; flex-shrink:0;
    border:1px solid rgba(127,127,127,0.35); box-shadow: inset 0 0 0 2px rgba(255,255,255,0.15);
  }
  .theme-chip span:last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #readBar select.f-inp { min-height:38px; }

  /* ===== Panels ===== */
  .panel {
    grid-area: main; overflow-y:auto; display:none; min-height:0;
    position:relative; z-index:2; isolation:isolate;
    padding: 16px max(14px, calc((100% - var(--content-w)) / 2)) 20px;
    -webkit-overflow-scrolling:touch; overscroll-behavior: contain;
  }
  .panel.active { display:flex; flex-direction:column; gap:14px; animation: rsFade 0.2s ease; }
  @keyframes rsFade { from { opacity:0; transform: translateY(4px); } to { opacity:1; transform:none; } }
  .panel-title { font-size:20px; font-weight:800; letter-spacing:-0.02em; margin:2px 2px 0; }

  /* ===== Chat Messages ===== */
  #tab-chat { gap:18px; }
  .msg-wrap { display:flex; flex-direction:column; max-width:88%; }
  .msg-wrap.user { align-self:flex-end; align-items:flex-end; }
  .msg-wrap.char { align-self:flex-start; align-items:flex-start; width:100%; max-width:100%; }
  .msg-role { font-size:12px; font-weight:700; color:var(--sub); margin:0 4px 5px; display:flex; align-items:center; gap:7px; }
  .msg-wrap.char .msg-role::before {
    content:''; width:18px; height:18px; border-radius:50%; flex-shrink:0;
    background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 45%, #ffffff));
  }
  [data-theme="ai-gemini"] .msg-wrap.char .msg-role::before { background: linear-gradient(135deg, #4285f4 0%, #9b72cb 60%, #d96570 100%); }
  .msg-wrap.user .msg-role { display:none; }
  .msg-bubble {
    padding:11px 16px; border-radius:20px; font-family: var(--font); font-size:var(--fsize); line-height:var(--lh);
    white-space:pre-wrap; word-break:keep-all; overflow-wrap:anywhere; width:fit-content; max-width:100%;
  }
  .msg-wrap.user .msg-bubble { background:var(--user-bg); color:var(--user-text); border-bottom-right-radius:6px; }
  .msg-wrap.char .msg-bubble { background:var(--surface); color:var(--text); border-bottom-left-radius:6px; }
  /* Official chatbot look: assistant text sits directly on the page */
  [data-theme^="ai-"] .msg-wrap.char .msg-bubble { background:transparent; padding:2px 4px 0 29px; border-radius:0; width:100%; }
  [data-theme^="ai-"] .msg-wrap.char .msg-actions { padding-left:25px; }
  /* EPUB single-page: book prose with a quiet user note */
  [data-theme="epub-1p-day"] .msg-wrap.char .msg-bubble, [data-theme="epub-1p-night"] .msg-wrap.char .msg-bubble {
    background:transparent; padding:0 2px; border-radius:0; width:100%; text-align:justify;
  }
  [data-theme="epub-1p-day"] .msg-wrap.char .msg-role::before, [data-theme="epub-1p-night"] .msg-wrap.char .msg-role::before { display:none; }
  [data-theme="epub-1p-day"] .msg-wrap.char .msg-role, [data-theme="epub-1p-night"] .msg-wrap.char .msg-role {
    width:100%; margin:0 0 10px; gap:10px; font-size:11px; letter-spacing:0.08em; color: color-mix(in srgb, var(--sub) 80%, transparent);
  }
  [data-theme="epub-1p-day"] .msg-wrap.char .msg-role::after, [data-theme="epub-1p-night"] .msg-wrap.char .msg-role::after { content:''; flex:1; height:1px; background:var(--border); }
  [data-theme="epub-1p-day"] .msg-wrap.user, [data-theme="epub-1p-night"] .msg-wrap.user { align-self:stretch; max-width:100%; align-items:stretch; }
  [data-theme="epub-1p-day"] .msg-wrap.user .msg-bubble, [data-theme="epub-1p-night"] .msg-wrap.user .msg-bubble {
    width:100%; border-radius:10px; border-left:3px solid var(--accent); font-size: calc(var(--fsize) - 0.5px);
  }
  [data-theme="epub-1p-day"] .msg-wrap.user .msg-actions, [data-theme="epub-1p-night"] .msg-wrap.user .msg-actions { align-self:flex-end; }
  /* Glass bubbles */
  [data-theme="midnight-glass"] .msg-bubble { -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); border:1px solid var(--border); }
  [data-theme="sakura-pastel"] .msg-wrap.char .msg-bubble, [data-theme="forest-moss"] .msg-wrap.char .msg-bubble { border:1px solid var(--border); }

  .msg-img-wrap { position:relative; display:block; width:fit-content; max-width:100%; margin:12px auto; border-radius:14px; overflow:hidden; cursor:pointer; box-shadow: var(--shadow-sm); }
  .msg-img { max-width:min(320px, 100%); max-height:360px; border-radius:14px; display:block; object-fit:contain; transition:filter 0.25s ease, transform 0.25s ease; }
  body.asset-blur .msg-img-wrap:not(.revealed) .msg-img { filter:blur(22px) brightness(0.72); transform:scale(1.06); }
  .img-veil {
    display:none; position:absolute; inset:0; align-items:center; justify-content:center;
    background:rgba(0,0,0,0.22); color:#fff; font-size:12.5px; font-weight:700; text-shadow:0 1px 4px rgba(0,0,0,0.7);
    pointer-events:none;
  }
  body.asset-blur .msg-img-wrap:not(.revealed) .img-veil { display:flex; }
  body.asset-hide .msg-img-wrap { display:none !important; }

  .msg-actions { display:flex; gap:4px; margin-top:6px; transition: opacity 0.15s ease; }
  .act-btn {
    display:inline-flex; align-items:center; gap:3px; min-height:28px;
    border:1px solid transparent; background:transparent; color:var(--sub);
    border-radius:8px; padding:0 8px; font-size:11.5px; font-weight:600; cursor:pointer;
  }
  .act-btn:hover { background: var(--surface); border-color: var(--border); color: var(--text); }
  @media (hover: hover) and (pointer: fine) {
    .msg-wrap .msg-actions { opacity:0; }
    .msg-wrap:hover .msg-actions, .msg-wrap:focus-within .msg-actions, .msg-wrap:last-child .msg-actions { opacity:1; }
  }
  @media (hover: none) { .msg-actions { opacity:0.75; } }
  .tr-box {
    margin-top:8px; padding:10px 13px; border-radius:12px; font-size:calc(var(--fsize) - 0.5px); line-height:var(--lh);
    background:var(--surface2); border-left:3px solid var(--accent); white-space:pre-wrap; max-width:100%;
  }
  .empty-hint { text-align:center; color:var(--sub); margin:auto; padding:40px 20px; font-size:14px; line-height:1.6; }
  .empty-hint .big { font-size:34px; display:block; margin-bottom:10px; opacity:0.8; }

  /* ===== Custom Module Toggles Accordion ===== */
  .tg-acc { border:1px solid var(--border); border-radius:12px; background:var(--bg); margin:8px 0; overflow:hidden; }
  .tg-acc-head {
    padding:11px 13px; font-size:13.5px; font-weight:700; cursor:pointer; min-height:44px;
    display:flex; align-items:center; justify-content:space-between; background:var(--surface);
  }
  .tg-acc-body { padding:10px 12px; display:none; flex-direction:column; gap:10px; border-top:1px solid var(--border); }
  .tg-acc.open .tg-acc-body { display:flex; }
  .tg-row { display:flex; align-items:center; justify-content:space-between; gap:10px; font-size:13.5px; min-height:36px; }
  .tg-cap { font-size:12px; color:var(--sub); line-height:1.5; margin:2px 0; }
  .tg-div { height:1px; background:var(--border); margin:4px 0; }

  .greeting-top-bar { display:flex; align-items:center; flex-wrap:wrap; gap:6px; flex-shrink:0; padding:0 2px; }
  body.book-mode .greeting-top-bar { padding:0 2px 8px; }

  /* ===== EPUB 2-Page Book Mode + 640ms 3D Paper Flip ===== */
  body.book-mode #tab-chat { --content-w: 1240px; padding-top:14px; padding-bottom:8px; }
  .book-shell { flex:1; display:flex; flex-direction:column; min-height:0; position:relative; }
  .book-frame {
    flex:1; display:flex; flex-direction:column;
    background:var(--book-bg); border:1px solid var(--border); border-radius:12px;
    box-shadow: var(--shadow); overflow:hidden; position:relative;
    perspective:1800px; min-height:0;
  }
  .book-frame:not(.single-page)::before {
    content:''; position:absolute; top:0; bottom:0; left:50%; width:1px;
    background:var(--border); pointer-events:none; z-index:3;
  }
  .book-frame:not(.single-page)::after {
    content:''; position:absolute; top:0; bottom:0; left:50%; width:48px;
    transform:translateX(-50%); pointer-events:none; z-index:2;
    background:linear-gradient(90deg, transparent, var(--book-spine) 50%, transparent);
  }
  .book-viewport {
    flex:1; min-height:0; overflow:hidden; margin: clamp(18px, 3vw, 34px) auto; padding:0; position:relative;
  }
  .book-tap-zone {
    position:absolute; top:0; bottom:0; width:12%; min-width:44px; max-width:100px;
    z-index:6; pointer-events:none; background:transparent; user-select:none;
  }
  .book-tap-left { left:0; }
  .book-tap-right { right:0; }
  .book-tap-zone.disabled { cursor:default; }
  .book-columns {
    height:100%; column-fill:auto;
    font-family: var(--font); font-size:var(--fsize); line-height:var(--lh);
    white-space:pre-wrap; word-break:keep-all; overflow-wrap:anywhere; text-align:justify;
  }
  .book-frame.single-page .book-columns { text-align:left; }
  .book-columns .msg-img-wrap { break-inside:avoid; max-width:100%; margin:10px auto; }
  .book-columns .msg-img { max-height:38vh; max-width:100%; width:auto; height:auto; }
  .book-turn-tag { font-family: var(--ui-font); font-size:11px; color:var(--accent); margin-bottom:6px; font-weight:700; letter-spacing:0.04em; break-after:avoid; display:inline-flex; align-items:center; gap:6px; position:relative; z-index:8; }
  .turn-tts-btn {
    display:inline-flex; align-items:center; justify-content:center;
    width:20px; height:20px; padding:0; border:none; border-radius:999px;
    background:transparent; color:var(--sub); cursor:pointer;
    position:relative; z-index:8; flex-shrink:0; pointer-events:auto;
    transition: background 0.15s ease, color 0.15s ease, transform 0.12s ease;
  }
  .turn-tts-btn:hover { background: var(--accent-soft); color: var(--accent); }
  .turn-tts-btn:active { transform: scale(0.92); }
  .turn-tts-btn.is-loading { color: var(--accent); background: var(--accent-soft); animation: rsTtsPulse 1s ease-in-out infinite; }
  .turn-tts-btn.is-playing { color: var(--on-accent); background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  @keyframes rsTtsPulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
  .book-user-block { background:var(--user-bg); color:var(--user-text); padding:10px 14px; border-radius:8px; border-left:3px solid var(--accent); margin:10px 0 16px; text-align:left; break-inside:avoid; }
  .book-char-block { margin:6px 0 18px; }
  .book-char-block .msg-actions { opacity:1; flex-wrap:wrap; align-items:center; }

  .epub-flip-leaf {
    position:absolute; top:0; bottom:0; width:50%; pointer-events:none; opacity:0;
    background:var(--leaf-bg); z-index:15; backface-visibility:hidden;
    box-shadow:0 0 26px rgba(0,0,0,0.22);
  }
  .book-frame.single-page .epub-flip-leaf { width:100%; }
  .epub-flip-leaf.flip-next { right:0; transform-origin:left center; animation: rsFlipNext 640ms cubic-bezier(0.32, 0.08, 0.24, 1) forwards; }
  .epub-flip-leaf.flip-prev { left:0; transform-origin:right center; animation: rsFlipPrev 640ms cubic-bezier(0.32, 0.08, 0.24, 1) forwards; }
  @keyframes rsFlipNext { 0% { opacity:0.95; transform:rotateY(0deg); } 50% { opacity:0.98; transform:rotateY(-90deg); } 100% { opacity:0; transform:rotateY(-180deg); } }
  @keyframes rsFlipPrev { 0% { opacity:0.95; transform:rotateY(0deg); } 50% { opacity:0.98; transform:rotateY(90deg); } 100% { opacity:0; transform:rotateY(180deg); } }

  .book-nav { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 2px 2px; flex-shrink:0; font-size:12.5px; color:var(--sub); font-variant-numeric: tabular-nums; position:relative; }
  .book-page-btn { min-height:30px; padding:0 12px; font-size:12px; font-variant-numeric: tabular-nums; background:var(--surface); }
  .book-jump-bar {
    position:absolute; left:50%; bottom:56px; transform:translateX(-50%); z-index:28;
    width:min(360px, calc(100% - 16px)); padding:12px 14px; border-radius:14px;
    background:var(--elev); border:1px solid var(--border); box-shadow:var(--shadow);
    display:flex; flex-direction:column; gap:10px;
  }
  .book-jump-head { display:flex; align-items:center; justify-content:space-between; font-size:12px; font-weight:700; color:var(--sub); font-variant-numeric: tabular-nums; }
  .book-jump-range { width:100%; accent-color:var(--accent); cursor:pointer; }
  .book-jump-row { display:flex; align-items:center; gap:6px; }
  .book-jump-row .f-inp { flex:1; min-width:0; min-height:34px; padding:6px 10px; font-size:13px; text-align:center; font-variant-numeric: tabular-nums; }
  .book-jump-row .btn, .book-jump-row .pill { min-height:34px; padding:0 11px; flex-shrink:0; font-size:12px; }
  .turn-ruler { display:flex; align-items:center; justify-content:center; gap:5px; padding:6px 8px 2px; overflow:hidden; flex-shrink:0; }
  .ruler-tick { width:3px; height:10px; border-radius:2px; background:var(--border); cursor:pointer; transition:all 0.15s; }
  .ruler-tick:hover { background: var(--sub); }
  .ruler-tick.active { height:16px; width:4px; background:var(--accent); }

  /* ===== Bot Regex HTML / Module Widgets & Trigger Modal ===== */
  .rs-bg-host { display:block; }
  html body #botBgHost.rs-bg-host {
    position:fixed !important; inset:0 !important; width:100vw !important; height:100dvh !important;
    z-index:0 !important; pointer-events:none !important; overflow:hidden !important;
    isolation:isolate !important; contain:layout paint !important; display:block !important;
  }
  html body:not(.tab-chat-active) #botBgHost.rs-bg-host { visibility:hidden !important; }
  html body .msg-body .rs-bot-html,
  html body .book-columns .rs-bot-html {
    position:static !important; inset:auto !important; z-index:auto !important;
    height:auto !important; max-height:none !important; pointer-events:auto !important;
  }
  .rs-bot-html { white-space:normal; word-break:keep-all; overflow-wrap:anywhere; width:100%; }
  .rs-bot-html .rs-prose-seg { white-space:pre-wrap; }
  .rs-bot-html img { max-width:100%; height:auto; border-radius:12px; }
  .rs-bot-html .image-container { max-width:100% !important; min-height:200px; background-size:cover; background-position:center 15%; border-radius:14px; }
  .book-columns .rs-bot-html .image-container {
    width:100% !important; max-width:100% !important;
    height:min(38vh, 360px) !important; min-height:180px !important; max-height:46vh !important;
    padding-bottom:0 !important; break-inside:avoid; margin:10px auto; cursor:pointer;
  }
  .book-img-preview {
    position:absolute; z-index:16; display:none;
    background-size:cover; background-position:center 10%; background-repeat:no-repeat;
    border-radius:14px; cursor:pointer; pointer-events:none;
    box-shadow: 0 20px 48px rgba(0, 0, 0, 0.52);
    transition: top 0.45s cubic-bezier(0.22, 1, 0.36, 1), height 0.45s cubic-bezier(0.22, 1, 0.36, 1), background-position 0.45s ease, opacity 0.2s ease;
  }
  .book-columns .rs-bot-html > div { max-width:100% !important; min-width:0 !important; box-sizing:border-box; }
  .book-columns .rs-bot-html div,
  .book-columns .rs-bot-html section,
  .book-columns .rs-bot-html article,
  .book-columns .rs-bot-html details,
  .book-columns .rs-bot-html table,
  .book-columns .rs-bot-html pre,
  .book-columns .rs-bot-html img,
  .book-columns .rs-bot-html svg { max-width:100% !important; box-sizing:border-box; }
  .book-columns .rs-bot-html table { display:block; overflow-x:auto; }
  .book-columns .rs-bot-html pre,
  .book-columns .rs-bot-html code { white-space:pre-wrap; overflow-wrap:anywhere; }
  .rs-bot-html [risu-trigger], .rs-bot-html [risu-btn] { cursor:pointer; }
  .risu-cbs-btn { padding:6px 12px; border-radius:8px; border:1px solid var(--border); background:var(--surface); color:var(--text); font-size:12.5px; font-weight:600; cursor:pointer; margin:4px 4px 4px 0; }
  .risu-cbs-btn:hover { border-color:var(--accent); }
  .leave-preset-bar {
    display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px;
    padding:10px 12px; margin-bottom:10px; border-radius:12px;
    background:color-mix(in srgb, var(--accent) 8%, var(--surface));
    border:1px solid color-mix(in srgb, var(--accent) 26%, var(--border));
  }
  .leave-preset-info { display:flex; flex-direction:column; gap:2px; min-width:0; }
  .leave-preset-info b { font-size:13px; color:var(--text); }
  .leave-preset-info span { font-size:11.5px; color:var(--sub); }
  .leave-preset-btns { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .leave-ooc-card {
    margin:10px 0; padding:13px 15px; border-radius:14px;
    background:rgba(15,23,42,0.92); border:1px solid rgba(159,212,185,0.35);
    color:#e2e8f0; line-height:1.72; break-inside:avoid;
  }
  .leave-ooc-badge {
    display:inline-flex; align-items:center; gap:6px; margin-bottom:8px; padding:2px 9px;
    border-radius:999px; background:rgba(47,104,78,0.35); border:1px solid rgba(159,212,185,0.32);
    color:#9fd4b9; font-size:11.5px; font-weight:800; letter-spacing:0.04em;
  }
  .leave-thought-box {
    margin:8px 0 12px; padding:8px 12px; border-radius:10px;
    background:var(--surface); border:1px solid var(--border); font-size:12.5px; color:var(--sub);
  }
  .leave-thought-box summary { cursor:pointer; font-weight:700; color:var(--text); }
  .leave-thought-body { margin-top:8px; white-space:pre-wrap; line-height:1.6; }
  .leave-hud-card {
    margin:12px 0 6px; padding:10px 14px; border-radius:12px;
    background:rgba(15,23,42,0.82); border:1px solid rgba(148,163,184,0.28);
    color:#e2e8f0; font-size:12.5px; line-height:1.65; break-inside:avoid;
    font-family:system-ui,-apple-system,"Malgun Gothic",sans-serif;
  }
  .leave-hud-card summary { cursor:pointer; font-weight:700; color:#93c5fd; list-style:revert; }
  .leave-hud-body { margin-top:8px; white-space:pre-line; color:#e2e8f0; }
  body.hide-leave-hud .leave-hud-card { display:none !important; }
  body.asset-hide .rs-bot-html img, body.asset-hide .rs-bot-html .image-container { display:none !important; }
  body.asset-blur .rs-bot-html img:not(.revealed), body.asset-blur .rs-bot-html .image-container:not(.revealed) { filter:blur(22px) brightness(0.72); cursor:pointer; transition:filter 0.25s ease; }
  html body #bookBotOverlay {
    position:fixed !important; inset:0 !important; z-index:25 !important;
    pointer-events:none !important; isolation:isolate !important; contain:layout paint !important;
  }
  html body:not(.tab-chat-active) #bookBotOverlay { display:none !important; }
  html body #bookBotOverlay [data-rs-bot-fab="1"],
  html body #bookBotOverlay .side-panel,
  html body #bookBotOverlay .floating,
  html body #bookBotOverlay .buttons-container,
  html body #bookBotOverlay [class*="side-panel" i],
  html body #bookBotOverlay [class*="floating" i],
  html body #bookBotOverlay [class*="buttons-container" i],
  html body #bookBotOverlay [risu-trigger],
  html body #bookBotOverlay [risu-btn],
  html body #bookBotOverlay label,
  html body #bookBotOverlay button,
  html body #bookBotOverlay a { pointer-events:auto; }
  #bookBotOverlay:empty { display:none; }
  #bookBotOverlay [data-rs-bot-fab="1"] {
    position:fixed !important; top:106px !important; right:12px !important; z-index:25 !important;
    display:flex !important; flex-direction:column !important; align-items:center !important; gap:10px !important;
    margin:0 !important; padding:0 !important; will-change: transform, opacity;
    transition: transform 0.11s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.09s ease;
  }
  #bookBotOverlay.bot-menu-collapsed [data-rs-bot-fab="1"] {
    opacity:0 !important; pointer-events:none !important; transform:translate3d(72px, 0, 0) !important;
  }
  #botMenuFab {
    position:fixed; right:12px; top:62px; z-index:35;
    display:inline-flex; align-items:center; justify-content:center; gap:5px;
    box-sizing:border-box; height:34px; min-height:34px; min-width:48px; padding:0 12px; margin:0;
    border-radius:999px; border:1px solid var(--border); background:var(--elev); color:var(--text);
    font-size:12px; font-weight:700; line-height:1; letter-spacing:-0.01em; white-space:nowrap;
    cursor:pointer; box-shadow:var(--shadow-sm); opacity:0.84;
    transition: opacity 0.1s ease, background 0.1s ease, border-color 0.1s ease;
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  }
  #botMenuFab .bmf-ic {
    display:inline-flex; align-items:center; justify-content:center;
    font-size:11px; line-height:1;
  }
  #botMenuFab .bmf-lb {
    display:inline-flex; align-items:center; justify-content:center; line-height:1;
  }
  #botMenuFab:hover, #botMenuFab.expanded { opacity:1; border-color:var(--accent); }
  #botMenuFab.expanded {
    width:var(--bot-fab-w, 48px); min-width:var(--bot-fab-w, 48px); height:34px; padding:0 4px; gap:2px;
    border-radius:12px; font-size:11px;
  }
  @media (max-width: 768px) {
    #botMenuFab { right:12px; top:60px; height:32px; min-height:32px; }
    #botMenuFab.expanded { width:var(--bot-fab-w, 44px); min-width:var(--bot-fab-w, 44px); height:32px; padding:0 3px; border-radius:12px; font-size:10.5px; }
    #bookBotOverlay [data-rs-bot-fab="1"] { top:100px !important; right:12px !important; gap:8px !important; }
  }
  .msg-swipe-grp { display:inline-flex; align-items:center; gap:2px; background:var(--surface); border:1px solid var(--border); border-radius:999px; padding:1px 4px; margin-right:2px; }
  .msg-swipe-cnt { font-size:11px; color:var(--sub); font-weight:700; padding:0 4px; font-variant-numeric:tabular-nums; }
  #triggerModal {
    position:fixed; inset:0; z-index:150; background:rgba(0,0,0,0.62);
    -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px);
    display:flex; align-items:center; justify-content:center; padding:18px;
  }
  .trig-card {
    width:100%; max-width:420px; max-height:82vh; overflow:auto;
    background:var(--elev); color:var(--text); border:1px solid var(--border);
    border-radius:18px; padding:18px; box-shadow:var(--shadow);
    display:flex; flex-direction:column; gap:12px;
  }
  .trig-msg { font-size:14px; line-height:1.55; white-space:pre-wrap; }
  .trig-opts { display:flex; flex-direction:column; gap:7px; }
  .trig-opt-btn { width:100%; justify-content:flex-start; text-align:left; padding:10px 13px; min-height:42px; }
  .trig-alert-card { max-width:360px; padding:18px 20px; border-radius:14px; gap:14px; }
  .trig-title { font-size:15px; font-weight:800; margin:0; color:var(--text); }
  .trig-title.err { color:var(--danger); }
  .trig-ok-btn { width:100%; min-height:42px; font-size:14px; font-weight:700; border-radius:10px; }

  /* ===== Request Log Viewer ===== */
  .req-log-filters { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-bottom:10px; }
  .req-log-list { display:flex; flex-direction:column; gap:7px; max-height:420px; overflow:auto; }
  .req-log-row {
    width:100%; text-align:left; font-family:inherit; color:var(--text);
    display:flex; flex-direction:column; gap:4px; padding:10px 12px;
    border-radius:12px; border:1px solid var(--border); background:var(--bg);
    cursor:pointer; transition:border-color 0.15s ease, background 0.15s ease;
  }
  .req-log-row:hover { border-color:var(--accent); background:var(--surface); }
  .req-log-row-top { display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:13px; font-weight:700; }
  .req-log-row-meta { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:11.5px; color:var(--sub); font-variant-numeric:tabular-nums; }
  .req-log-row-prev { font-size:12px; color:var(--sub); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .req-log-badge {
    display:inline-flex; align-items:center; gap:3px; padding:2px 7px; border-radius:999px;
    font-size:11px; font-weight:700; border:1px solid var(--border); background:var(--surface); color:var(--text);
    font-variant-numeric:tabular-nums;
  }
  .req-log-badge.ok { border-color:color-mix(in srgb, #10b981 40%, var(--border)); background:color-mix(in srgb, #10b981 12%, transparent); color:#10b981; }
  .req-log-badge.err { border-color:color-mix(in srgb, var(--danger) 45%, var(--border)); background:color-mix(in srgb, var(--danger) 12%, transparent); color:var(--danger); }
  .req-log-badge.src { border-color:color-mix(in srgb, var(--accent) 35%, var(--border)); color:var(--accent); background:var(--accent-soft); }
  #reqLogModal {
    position:fixed; inset:0; z-index:160; background:rgba(0,0,0,0.64);
    -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px);
    display:flex; align-items:center; justify-content:center; padding:14px;
  }
  .req-log-dialog {
    width:100%; max-width:min(1040px, 96vw); height:min(88vh, 920px); max-height:90vh; background:var(--elev); color:var(--text);
    border:1px solid var(--border); border-radius:18px; box-shadow:var(--shadow);
    display:flex; flex-direction:column; overflow:hidden;
  }
  .req-log-head {
    display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;
    padding:12px 16px; border-bottom:1px solid var(--border); background:var(--surface); flex-shrink:0;
  }
  .req-log-title { font-size:14.5px; font-weight:800; display:flex; align-items:center; gap:6px; flex-wrap:wrap; min-width:0; }
  .req-log-tabs {
    display:flex; gap:6px; flex-wrap:wrap; padding:8px 16px; border-bottom:1px solid var(--border);
    background:var(--elev); flex-shrink:0;
  }
  .req-log-body {
    flex:1; min-height:0; overflow-y:auto; overflow-x:hidden; padding:14px 16px;
    display:flex; flex-direction:column; gap:10px; -webkit-overflow-scrolling:touch;
  }
  .req-log-body > * { flex-shrink:0; }
  .req-log-toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .req-log-toolbar .f-inp { flex:1; min-width:180px; min-height:34px; padding:6px 11px; font-size:13px; }
  .req-log-msg-list { display:flex; flex-direction:column; gap:10px; }
  .req-log-msg {
    flex-shrink:0; border:1px solid var(--border); border-radius:12px; background:var(--bg);
  }
  .req-log-msg.role-system { border-color:color-mix(in srgb, var(--accent) 40%, var(--border)); }
  .req-log-msg.role-user {
    border-color:color-mix(in srgb, #38bdf8 45%, var(--border));
    background:color-mix(in srgb, #38bdf8 4%, var(--bg));
  }
  .req-log-msg.role-assistant, .req-log-msg.role-model {
    border-color:color-mix(in srgb, #34d399 40%, var(--border));
  }
  summary.req-log-msg-head {
    display:flex; align-items:center; justify-content:space-between; gap:8px;
    padding:8px 12px; background:var(--surface); border-bottom:1px solid var(--border);
    border-radius:11px 11px 0 0; font-size:12px; color:var(--sub);
    list-style:none; cursor:pointer; user-select:none;
  }
  summary.req-log-msg-head::-webkit-details-marker { display:none; }
  details.req-log-msg:not([open]) summary.req-log-msg-head { border-bottom:none; border-radius:11px; }
  .req-log-msg-chev { display:inline-block; transition:transform 0.15s ease; font-size:11px; margin-right:6px; }
  details.req-log-msg:not([open]) .req-log-msg-chev { transform:rotate(-90deg); }
  .req-log-msg-role { font-weight:800; text-transform:uppercase; letter-spacing:0.04em; color:var(--accent); }
  .req-log-msg.role-user .req-log-msg-role { color:#38bdf8; }
  .req-log-msg.role-assistant .req-log-msg-role, .req-log-msg.role-model .req-log-msg-role { color:#34d399; }
  .req-log-mini-btn {
    padding:3px 9px; border-radius:999px; border:1px solid var(--border); background:var(--bg);
    color:var(--text); font-size:11px; font-weight:700; cursor:pointer;
  }
  .req-log-mini-btn:hover { border-color:var(--accent); color:var(--accent); }
  .req-log-msg-body {
    margin:0; padding:12px 14px; font-size:13px; line-height:1.68;
    white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; font-family:inherit; user-select:text;
  }
  .req-log-pre {
    margin:0; padding:12px 14px; border-radius:12px; border:1px solid var(--border); background:var(--surface);
    font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12.5px; line-height:1.62;
    white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; max-height:none; overflow-x:auto; user-select:text;
  }
  .req-log-errbox {
    padding:10px 12px; border-radius:12px; border:1px solid color-mix(in srgb, var(--danger) 45%, var(--border));
    background:color-mix(in srgb, var(--danger) 10%, transparent); color:var(--danger);
    font-size:12.5px; line-height:1.5; white-space:pre-wrap; word-break:break-word;
  }
  .req-log-meta-grid {
    display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:8px;
    padding:10px 12px; border-radius:12px; border:1px solid var(--border); background:var(--surface); font-size:12px;
  }
  .req-log-meta-item b { display:block; font-size:11px; color:var(--sub); margin-bottom:2px; }
  .req-log-meta-item span { word-break:break-all; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .cg-summary-bar {
    display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-bottom:8px;
    padding:8px 10px; border-radius:12px; border:1px solid var(--border); background:var(--surface);
    font-size:11.5px; color:var(--sub);
  }
  .cg-stat {
    display:inline-flex; align-items:center; gap:4px; padding:3px 8px; border-radius:999px;
    border:1px solid var(--border); background:var(--bg); color:var(--text); font-weight:700;
  }
  .cg-stat.ok { border-color:color-mix(in srgb, #34d399 45%, var(--border)); color:#34d399; }
  .cg-stat.brk { border-color:color-mix(in srgb, var(--danger) 50%, var(--border)); background:color-mix(in srgb, var(--danger) 10%, transparent); color:var(--danger); }
  .req-log-badge.cg-lane { border-color:color-mix(in srgb, #60a5fa 45%, var(--border)); color:#60a5fa; background:color-mix(in srgb, #60a5fa 10%, transparent); }
  .req-log-badge.cg-ok { border-color:color-mix(in srgb, #34d399 45%, var(--border)); color:#34d399; background:color-mix(in srgb, #34d399 10%, transparent); }
  .req-log-badge.cg-brk { border-color:color-mix(in srgb, var(--danger) 55%, var(--border)); color:var(--danger); background:color-mix(in srgb, var(--danger) 14%, transparent); font-weight:800; }
  .req-log-badge.cg-excl { border-color:var(--border); color:var(--sub); background:var(--surface); opacity:0.85; }
  .cg-lane-hdr {
    font-size:11.5px; font-weight:800; color:var(--sub); padding:6px 4px 2px; margin-top:4px;
    border-bottom:1px dashed var(--border); display:flex; align-items:center; justify-content:space-between; gap:8px;
  }
  .cg-banner {
    padding:12px 14px; border-radius:12px; border:1px solid var(--border); background:var(--surface);
    display:flex; flex-direction:column; gap:6px;
  }
  .cg-banner.ok { border-color:color-mix(in srgb, #34d399 50%, var(--border)); background:color-mix(in srgb, #34d399 8%, var(--surface)); }
  .cg-banner.broken { border-color:color-mix(in srgb, var(--danger) 55%, var(--border)); background:color-mix(in srgb, var(--danger) 10%, var(--surface)); }
  .cg-banner.baseline { border-color:color-mix(in srgb, #60a5fa 45%, var(--border)); background:color-mix(in srgb, #60a5fa 8%, var(--surface)); }
  .cg-segmap-bar {
    display:flex; width:100%; height:18px; border-radius:8px; overflow:hidden;
    border:1px solid var(--border); background:var(--bg); gap:1px;
  }
  .cg-seg { min-width:3px; height:100%; position:relative; }
  .cg-seg.cached { background:#34d399; }
  .cg-seg.changed { background:var(--danger); }
  .cg-seg.after { background:color-mix(in srgb, var(--sub) 35%, var(--surface)); }
  .cg-seg-list { display:flex; flex-direction:column; gap:5px; }
  .cg-seg-item {
    display:flex; align-items:center; gap:8px; font-size:12px; padding:6px 9px;
    border-radius:9px; border:1px solid var(--border); background:var(--bg);
  }
  .cg-diff-box { display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:10px; }
  .cg-diff-col { border:1px solid var(--border); border-radius:12px; background:var(--surface); overflow:hidden; }
  .cg-diff-head { padding:7px 11px; font-size:11.5px; font-weight:800; border-bottom:1px solid var(--border); color:var(--sub); }
  .cg-diff-pre {
    margin:0; padding:10px 12px; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size:12px; line-height:1.55; white-space:pre-wrap; word-break:break-word; user-select:text;
  }
  .cg-diff-hi-del { background:color-mix(in srgb, var(--danger) 28%, transparent); color:var(--danger); font-weight:700; border-radius:3px; padding:0 2px; }
  .cg-diff-hi-add { background:color-mix(in srgb, #34d399 25%, transparent); color:#34d399; font-weight:700; border-radius:3px; padding:0 2px; }

  /* ===== Dedicated Message Edit Modal ===== */
  #msgEditModal {
    position:fixed; inset:0; z-index:165; background:rgba(0,0,0,0.66);
    -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px);
    display:flex; align-items:center; justify-content:center; padding:14px;
  }
  .msg-edit-card {
    width:min(860px, 96vw); height:min(86dvh, 780px); background:var(--elev); color:var(--text);
    border:1px solid var(--border); border-radius:18px; box-shadow:var(--shadow);
    display:flex; flex-direction:column; overflow:hidden;
  }
  .msg-edit-head {
    display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;
    padding:12px 16px; border-bottom:1px solid var(--border); background:var(--surface); flex-shrink:0;
  }
  .msg-edit-title { display:flex; align-items:center; gap:7px; flex-wrap:wrap; font-size:15px; font-weight:800; }
  .msg-edit-body {
    flex:1; min-height:0; padding:12px 16px; display:flex; flex-direction:column;
  }
  .msg-edit-textarea {
    flex:1; width:100%; min-height:0; resize:none; padding:14px 16px;
    border-radius:12px; border:1px solid var(--border); background:var(--bg); color:var(--text);
    font-family:var(--font); font-size:15px; line-height:1.68; outline:none;
    overflow-y:auto; white-space:pre-wrap; word-break:keep-all; overflow-wrap:anywhere;
    transition:border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .msg-edit-textarea:focus { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
  .msg-edit-foot {
    display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;
    padding:12px 16px; border-top:1px solid var(--border); background:var(--surface); flex-shrink:0;
  }
  @media (max-width: 640px) {
    #msgEditModal { padding:8px; }
    .msg-edit-card { width:100%; height:92dvh; border-radius:16px; }
    .msg-edit-textarea { font-size:16px; padding:12px; }
  }

  /* ===== Backend Plugin Adapter & Native GUI Iframe Modal ===== */
  .plg-list { display:flex; flex-direction:column; gap:8px; margin-top:10px; }
  .plg-item {
    border:1px solid var(--border); border-radius:12px; background:var(--bg);
    padding:10px 12px; display:flex; flex-direction:column; gap:8px;
  }
  .plg-item.on { border-color:color-mix(in srgb, var(--accent) 45%, var(--border)); }
  .plg-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
  .plg-title { font-size:13.5px; font-weight:700; display:flex; align-items:center; gap:6px; flex-wrap:wrap; min-width:0; }
  .plg-meta { font-size:11.5px; color:var(--sub); line-height:1.5; }
  .plg-err {
    font-size:11.5px; color:var(--danger); background:color-mix(in srgb, var(--danger) 10%, transparent);
    border:1px solid color-mix(in srgb, var(--danger) 30%, transparent); border-radius:8px; padding:6px 8px; word-break:break-word;
  }
  .plg-acts { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .plg-args {
    border-top:1px solid var(--border); padding-top:8px; display:flex; flex-direction:column; gap:7px;
  }
  #pluginGuiModal {
    position:fixed; inset:0; z-index:170; background:rgba(0,0,0,0.72);
    -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px);
    display:flex; align-items:center; justify-content:center; padding:12px;
  }
  .plg-gui-dialog {
    width:min(1120px, 96vw); height:min(90dvh, 880px); background:var(--elev); color:var(--text);
    border:1px solid var(--border); border-radius:18px; box-shadow:var(--shadow);
    display:flex; flex-direction:column; overflow:hidden;
  }
  .plg-gui-head {
    display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;
    padding:10px 14px; border-bottom:1px solid var(--border); background:var(--surface); flex-shrink:0;
  }
  #pluginGuiFrame {
    flex:1; width:100%; min-height:0; border:none; background:#0f172a;
  }
  @media (max-width: 640px) {
    #pluginGuiModal { padding:6px; }
    .plg-gui-dialog { width:100%; height:94dvh; border-radius:14px; }
  }

  /* ===== Dedicated Bubble Plugin Controls & Scene Drawer ===== */
  .rs-plugin-bubble-bar {
    display:flex; align-items:center; flex-wrap:wrap; gap:6px;
    margin-top:8px; padding:7px 10px;
    border-radius:12px; border:1px solid var(--border);
    background:color-mix(in srgb, var(--surface) 88%, var(--bg));
  }
  .rs-pbb-label {
    font-size:11px; font-weight:700; color:var(--sub); margin-right:2px;
  }
  .rs-pbb-btn {
    display:inline-flex; align-items:center; gap:4px;
    min-height:30px; padding:0 10px; border-radius:999px;
    border:1px solid var(--border); background:var(--elev); color:var(--text);
    font-size:12px; font-weight:600; cursor:pointer;
  }
  .rs-pbb-btn:hover { border-color:var(--accent); color:var(--accent); }
  #sceneCtrlModal {
    position:fixed; inset:0; z-index:168; background:rgba(0,0,0,0.68);
    -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px);
    display:flex; align-items:center; justify-content:center; padding:12px;
  }
  .scene-ctrl-dialog {
    width:min(760px, 96vw); max-height:min(88dvh, 780px);
    background:var(--elev); color:var(--text);
    border:1px solid var(--border); border-radius:18px; box-shadow:var(--shadow);
    display:flex; flex-direction:column; overflow:hidden;
  }
  .scene-ctrl-head {
    display:flex; align-items:center; justify-content:space-between; gap:8px;
    padding:12px 16px; border-bottom:1px solid var(--border); background:var(--surface); flex-shrink:0;
  }
  .scene-ctrl-body {
    flex:1; min-height:0; overflow-y:auto; padding:14px 16px;
    display:flex; flex-direction:column; gap:12px;
  }
  .scene-slot-card {
    border:1px solid var(--border); border-radius:12px; background:var(--bg);
    padding:10px 12px; display:flex; flex-direction:column; gap:8px;
  }
  .scene-slot-thumbs { display:flex; gap:8px; flex-wrap:wrap; }
  .scene-thumb-wrap {
    position:relative; display:inline-flex; align-items:center; justify-content:center;
    width:88px; height:88px; border-radius:10px; overflow:hidden;
    border:1px solid var(--border); background:var(--surface); cursor:pointer;
  }
  .scene-slot-thumb {
    width:88px; height:88px; object-fit:cover; display:block;
    transition:filter 0.2s ease, transform 0.2s ease;
  }
  .scene-thumb-veil {
    display:none; position:absolute; inset:0; align-items:center; justify-content:center;
    background:rgba(0,0,0,0.34); color:#fff; font-size:11px; font-weight:700; pointer-events:none;
  }
  body.asset-blur .scene-thumb-wrap:not(.revealed) .scene-slot-thumb { filter:blur(18px) brightness(0.68); transform:scale(1.08); }
  body.asset-blur .scene-thumb-wrap:not(.revealed) .scene-thumb-veil { display:flex; }
  body.asset-hide .scene-slot-thumbs, body.asset-hide .scene-thumb-wrap { display:none !important; }
  .scene-stealth-note {
    font-size:12px; color:var(--sub); padding:6px 10px; border-radius:8px;
    background:var(--surface); border:1px dashed var(--border);
  }

  /* ===== Plugin Floating Control Popup (Menu-triggered) ===== */
  #pluginFloatingModal {
    position:fixed; inset:0; z-index:169; background:rgba(0,0,0,0.64);
    -webkit-backdrop-filter:blur(5px); backdrop-filter:blur(5px);
    display:flex; align-items:center; justify-content:center; padding:12px;
  }
  .plg-float-dialog {
    width:min(700px, 96vw); max-height:min(84dvh, 720px);
    background:var(--elev); color:var(--text);
    border:1px solid var(--border); border-radius:18px; box-shadow:var(--shadow);
    display:flex; flex-direction:column; overflow:hidden;
  }
  .plg-float-head {
    display:flex; align-items:center; justify-content:space-between; gap:8px;
    padding:12px 16px; border-bottom:1px solid var(--border); background:var(--surface); flex-shrink:0;
  }
  .plg-float-body {
    flex:1; min-height:140px; overflow-y:auto; overflow-x:hidden; padding:14px 16px;
    display:flex; flex-direction:column; gap:12px;
  }
  .rs-pfm-card {
    border:1px solid var(--border); border-radius:14px; background:var(--bg);
    padding:12px; display:flex; flex-direction:column; gap:10px;
  }
  .rs-pfm-card-head {
    display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;
  }
  .rs-pfm-stage {
    position:relative; display:flex; flex-direction:column; gap:8px; min-width:0;
  }
  .rs-pfm-stage [x-am-root-host],
  .rs-pfm-stage .x-risu-am-generation-count {
    position:relative !important; inset:auto !important; right:auto !important; bottom:auto !important;
    left:auto !important; top:auto !important; width:100% !important; min-height:42px !important;
    display:flex !important; flex-wrap:wrap !important; align-items:center !important; justify-content:flex-end !important;
    gap:6px !important; padding-top:0 !important; pointer-events:auto !important;
  }
  .rs-pfm-stage .x-risu-am-generation-count__panel-anchor {
    position:relative !important; inset:auto !important; display:contents !important;
  }
  .rs-pfm-stage .x-risu-am-generation-count:is([data-am-expanded="true"]:not([x-am-expanded="false"]), [x-am-expanded="true"]) .x-risu-am-generation-count__panel {
    display:flex !important; position:relative !important; inset:auto !important; right:auto !important; bottom:auto !important;
    width:auto !important; max-width:100% !important; margin:0 !important; padding:4px !important;
    opacity:1 !important; pointer-events:auto !important; transform:none !important; overflow:visible !important;
  }
  .rs-pfm-stage .x-risu-am-generation-count:is([data-am-expanded="true"]:not([x-am-expanded="false"]), [x-am-expanded="true"]) .x-risu-am-generation-count__panel::before {
    content:""; position:absolute; inset:0; z-index:0; border-radius:inherit; background:rgba(33, 29, 32, .86); pointer-events:none;
  }
  .rs-pfm-stage .x-risu-am-generation-count__scene-menu[x-am-menu-open="true"],
  .rs-pfm-stage .x-risu-am-generation-count__scene-menu[data-am-menu-open="true"] {
    display:block !important; visibility:visible !important; position:relative !important;
    left:auto !important; right:auto !important; top:auto !important; bottom:auto !important;
    margin-top:6px !important; z-index:25 !important; max-width:100% !important;
  }
  .rs-pfm-stage .x-risu-am-generation-count__scene-menu[x-am-menu-open="false"],
  .rs-pfm-stage .x-risu-am-generation-count__scene-menu[hidden] { display:none !important; }
  .rs-pfm-stage .x-risu-am-runtime-toast-stack {
    position:relative !important; inset:auto !important; width:100% !important; max-height:240px !important;
  }
  .rs-pfm-stage button, .rs-pfm-stage [role="button"], .rs-pfm-stage [data-am-runtime-generation-count-action] {
    pointer-events:auto !important; cursor:pointer;
  }
  body.asset-hide #pluginFloatingModal:not(.is-action-overlay) img { display:none !important; }
  body.asset-blur #pluginFloatingModal:not(.is-action-overlay) img { filter:blur(14px); }
  #pluginFloatingModal.is-action-overlay img { max-width:100%; height:auto; }

  /* ===== Asset Maid Per-Message Manual Illustration Footer & Chat Projections ===== */
  @keyframes x-risu-am-spin { to { transform: rotate(360deg); } }
  .rs-am-footer-host { display:block; margin-top:8px; }
  .rs-am-footer-host .x-risu-am-illustration-footer,
  .rs-bot-html .x-risu-am-illustration-footer {
    --am-footer-control-bg:rgba(13,10,12,.42);
    --am-footer-shell-bg:rgba(33,29,32,.86);
    --am-footer-fg:#f1e5cf;
    --am-footer-hover:#fff5df;
    --am-footer-retry-icon:#c95f63;
    position:relative; display:inline-flex; align-items:center; justify-content:flex-start; gap:4px;
    width:max-content; max-width:100%; min-height:40px; padding:4px; border-radius:8px;
    background:var(--am-footer-shell-bg); color:var(--am-footer-fg);
    font:600 12px/1.2 system-ui,-apple-system,sans-serif; box-sizing:border-box;
    box-shadow:0 2px 10px rgba(0,0,0,0.22);
  }
  .rs-am-footer-host .x-risu-am-illustration-footer button,
  .rs-bot-html .x-risu-am-illustration-footer button {
    all:unset; display:inline-grid; flex:0 0 auto; width:32px; height:32px; place-items:center;
    box-sizing:border-box; border:0; border-radius:8px; background:var(--am-footer-control-bg);
    color:var(--am-footer-fg); cursor:pointer; user-select:none; transition:background .14s ease, color .14s ease;
  }
  .rs-am-footer-host .x-risu-am-illustration-footer button:hover,
  .rs-bot-html .x-risu-am-illustration-footer button:hover {
    background:rgba(241,229,207,0.16); color:var(--am-footer-hover);
  }
  .rs-am-footer-host .x-risu-am-illustration-footer__generate svg,
  .rs-bot-html .x-risu-am-illustration-footer__generate svg {
    display:block; width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.8;
    stroke-linecap:round; stroke-linejoin:round; pointer-events:none;
  }
  .rs-am-footer-host .x-risu-am-illustration-footer__generate svg.x-risu-am-illustration-footer__retry-icon,
  .rs-bot-html .x-risu-am-illustration-footer__generate svg.x-risu-am-illustration-footer__retry-icon {
    stroke:var(--am-footer-retry-icon);
  }
  .rs-am-footer-host .x-risu-am-illustration-footer.is-generating .x-risu-am-illustration-footer__generate svg,
  .rs-am-footer-host .x-risu-am-illustration-footer__generate[x-am-busy="true"] svg,
  .rs-bot-html .x-risu-am-illustration-footer.is-generating .x-risu-am-illustration-footer__generate svg,
  .rs-bot-html .x-risu-am-illustration-footer__generate[x-am-busy="true"] svg { display:none; }
  .rs-am-footer-host .x-risu-am-illustration-footer.is-generating .x-risu-am-illustration-footer__generate::before,
  .rs-am-footer-host .x-risu-am-illustration-footer__generate[x-am-busy="true"]::before,
  .rs-bot-html .x-risu-am-illustration-footer.is-generating .x-risu-am-illustration-footer__generate::before,
  .rs-bot-html .x-risu-am-illustration-footer__generate[x-am-busy="true"]::before {
    content:""; display:block; width:14px; height:14px; box-sizing:border-box;
    border:2px solid currentColor; border-right-color:transparent; border-radius:999px;
    animation:x-risu-am-spin .8s linear infinite;
  }
  .rs-am-footer-host .x-risu-am-illustration-revision-controls,
  .rs-bot-html .x-risu-am-illustration-revision-controls {
    display:inline-flex; align-items:center; gap:2px; border-radius:8px; background:var(--am-footer-control-bg); padding:0 2px;
  }
  .rs-am-footer-host .x-risu-am-illustration-revision-count,
  .rs-bot-html .x-risu-am-illustration-revision-count {
    font-size:11px; color:var(--am-footer-fg); padding:0 5px; font-variant-numeric:tabular-nums;
  }
  .rs-am-footer-host .x-risu-am-illustration-empty,
  .rs-bot-html .x-risu-am-illustration-empty {
    font-size:11px; color:#bca98c; padding:0 6px;
  }
  .rs-bot-html .am-illustration-projection,
  .rs-bot-html .x-risu-am-illustration-projection,
  .rs-bot-html .x-risu-am-illustration-slot {
    position:relative; display:block; margin:12px auto; max-width:100%; text-align:center;
  }
  .rs-bot-html .am-image,
  .rs-bot-html .x-risu-am-image,
  .rs-bot-html .am-generated-image,
  .rs-bot-html .x-risu-am-generated-image {
    display:inline-flex; justify-content:center; align-items:center; max-width:min(100%, 420px); margin:6px auto;
  }
  .rs-bot-html .am-image__media,
  .rs-bot-html .x-risu-am-image__media,
  .rs-bot-html .am-generated-image__img,
  .rs-bot-html .x-risu-am-generated-image__img {
    display:block; max-width:100%; height:auto; border-radius:10px;
  }
  .rs-bot-html .am-illustration-history-sources,
  .rs-bot-html .x-risu-am-illustration-history-sources,
  .rs-bot-html .am-illustration-history-bank,
  .rs-bot-html .am-native-asset-suppression,
  .rs-bot-html .x-risu-am-native-asset-suppression { display:none !important; }
  .rs-bot-html .am-chat-history-edge-controls,
  .rs-bot-html .x-risu-am-chat-history-edge-controls {
    display:inline-flex; align-items:center; gap:4px; margin-top:4px;
    background:rgba(33,29,32,.78); color:#f1e5cf; padding:3px 6px; border-radius:999px; font-size:11px;
  }
  .rs-bot-html .am-chat-history-edge-controls button,
  .rs-bot-html .x-risu-am-chat-history-edge-controls button {
    border:0; background:rgba(13,10,12,.5); color:#f1e5cf; border-radius:999px; width:22px; height:22px; cursor:pointer;
  }
  body.asset-hide .rs-bot-html .am-illustration-projection,
  body.asset-hide .rs-bot-html .x-risu-am-illustration-projection,
  body.asset-hide .rs-bot-html .x-risu-am-illustration-slot,
  body.asset-hide .rs-bot-html .am-generated-image { display:none !important; }
  body.asset-blur .rs-bot-html .am-illustration-projection img:not(.revealed),
  body.asset-blur .rs-bot-html .x-risu-am-illustration-projection img:not(.revealed) {
    filter:blur(22px) brightness(0.65); transition:filter 0.2s ease; cursor:pointer;
  }

  /* ===== RisuStand Floating Mini-Bar & Zen Mode ===== */
  #rsMiniBar {
    position:fixed; z-index:46; left:50%; top:calc(14px + env(safe-area-inset-top)); transform:translateX(-50%);
    box-sizing:border-box; display:inline-flex; align-items:center; gap:5px; border-radius:999px;
    background:color-mix(in srgb, var(--elev) 90%, transparent); color:var(--text);
    border:1px solid var(--border); box-shadow:0 4px 16px rgba(0,0,0,0.28);
    -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px);
    user-select:none; max-width:calc(100vw - 16px); overflow-x:auto; overflow-y:hidden;
    -webkit-overflow-scrolling:touch; overscroll-behavior-x:contain; scrollbar-width:none;
  }
  #rsMiniBar::-webkit-scrollbar { display:none; }
  #rsMiniBar.minimized { padding:4px 10px; font-size:12px; font-weight:700; opacity:0.8; cursor:grab; touch-action:none; }
  #rsMiniBar.expanded { padding:5px 10px; font-size:12px; font-weight:600; touch-action:pan-x; }
  .rs-mb-handle {
    display:inline-flex; align-items:center; gap:4px; padding:2px 6px;
    cursor:grab; white-space:nowrap; opacity:0.9; font-weight:700; font-size:11.5px;
    flex-shrink:0; touch-action:none;
  }
  .rs-mb-pill {
    border:1px solid var(--border); background:var(--surface); color:var(--text);
    border-radius:999px; padding:4px 9px; font-size:11.5px; font-weight:600;
    cursor:pointer; white-space:nowrap; display:inline-flex; align-items:center; gap:3px;
    flex-shrink:0; touch-action:pan-x;
  }
  .rs-mb-pill:hover { border-color:var(--accent); }
  .rs-mb-pill.active { background:var(--accent); color:var(--on-accent); border-color:var(--accent); }
  body:not(.rs-zen-mode) #rsMiniBar { display:none !important; }
  body.rs-zen-mode header, body.rs-zen-mode nav.tabbar { display:none !important; }
  body.rs-zen-mode #app {
    grid-template-columns:minmax(0, 1fr) !important;
    grid-template-rows:minmax(0, 1fr) auto !important;
    grid-template-areas:"main" "composer" !important;
  }

  /* ===== Composer (capsule) ===== */
  .composer {
    grid-area: composer; position:relative; z-index:30; display:flex; gap:6px; align-items:flex-end;
    margin: 6px max(10px, calc((100% - var(--content-w)) / 2 + 4px)) 10px;
    padding:6px; border:1px solid var(--border); border-radius:26px;
    background: var(--elev); box-shadow: var(--shadow-sm);
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .composer:focus-within { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); box-shadow: 0 0 0 4px var(--accent-soft); }
  body.book-mode .composer { --content-w: 1240px; }
  .composer .pill { min-height:36px; flex-shrink:0; font-size:12px; }
  .composer textarea {
    flex:1; min-height:36px; max-height:140px; resize:none; padding:8px 6px;
    border:none; background:transparent; font-size:15px; line-height:1.4; outline:none;
  }
  .composer.is-busy textarea::placeholder { color: var(--accent); opacity: 0.92; font-weight: 600; }
  .send-btn {
    height:36px; min-width:36px; padding:0 16px; border-radius:999px; border:none; background:var(--accent);
    color:var(--on-accent); font-weight:700; font-size:13.5px; cursor:pointer; flex-shrink:0;
    transition: opacity 0.15s ease, transform 0.1s ease;
  }
  .send-btn:active { transform: scale(0.95); }
  .send-btn:disabled { opacity:0.4; cursor:default; }

  /* ===== Bottom Nav ===== */
  nav.tabbar .nav-logo { display:none; }
  nav.tabbar {
    grid-area: nav; position:relative; z-index:30; display:grid; grid-template-columns:repeat(4, 1fr);
    border-top:1px solid var(--border); background: var(--header-bg);
    -webkit-backdrop-filter: saturate(160%) blur(14px); backdrop-filter: saturate(160%) blur(14px);
    padding: 4px env(safe-area-inset-right) calc(4px + env(safe-area-inset-bottom)) env(safe-area-inset-left);
  }
  .tab-btn {
    border:none; background:transparent; color:var(--sub); padding:6px 4px 5px; min-height:54px;
    font-size:11px; font-weight:600; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; cursor:pointer;
  }
  .tab-btn .ic { font-size:17px; line-height:1; padding:5px 18px; border-radius:999px; transition: background 0.18s ease; }
  .tab-btn.active { color:var(--text); }
  .tab-btn.active .ic { background: var(--accent-soft); }

  /* ===== Cards & Forms ===== */
  .card { background:var(--elev); border:1px solid var(--border); border-radius:var(--radius); padding:16px; box-shadow: var(--shadow-sm); }
  [data-theme="midnight-glass"] .card, [data-theme="midnight-glass"] .bot-item { -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); }
  .card h3 { margin:0 0 12px; font-size:15px; font-weight:700; letter-spacing:-0.01em; display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
  .search-inp, .f-inp {
    width:100%; padding:10px 12px; border-radius:var(--radius-sm); border:1px solid var(--border);
    background:var(--bg); font-size:14px; outline:none; min-height:42px;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  textarea.f-inp { line-height:1.5; resize:vertical; }
  .search-inp:focus, .f-inp:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  select.f-inp, select.pill {
    -webkit-appearance:none; appearance:none; padding-right:32px; cursor:pointer;
    background-image: linear-gradient(45deg, transparent 50%, var(--sub) 50%), linear-gradient(135deg, var(--sub) 50%, transparent 50%);
    background-position: calc(100% - 17px) 52%, calc(100% - 12px) 52%;
    background-size: 5px 5px, 5px 5px; background-repeat:no-repeat;
  }
  #tab-modules input[type="checkbox"], #tab-router input[type="checkbox"] {
    -webkit-appearance:none; appearance:none; flex-shrink:0; cursor:pointer; margin:0;
    width:44px !important; height:26px !important; border-radius:999px; position:relative;
    background: var(--surface2); border:1px solid var(--border);
    transition: background 0.18s ease, border-color 0.18s ease;
  }
  #tab-modules input[type="checkbox"]::after, #tab-router input[type="checkbox"]::after {
    content:''; position:absolute; top:2px; left:2px; width:20px; height:20px; border-radius:50%;
    background:#fff; box-shadow: 0 1px 3px rgba(0,0,0,0.3); transition: transform 0.18s ease;
  }
  #tab-modules input[type="checkbox"]:checked, #tab-router input[type="checkbox"]:checked { background:var(--accent); border-color:var(--accent); }
  #tab-modules input[type="checkbox"]:checked::after, #tab-router input[type="checkbox"]:checked::after { transform: translateX(18px); background: var(--on-accent); }
  .chk-row { display:flex; align-items:center; justify-content:space-between; gap:12px; font-size:13.5px; padding:9px 0; cursor:pointer; border-bottom:1px solid var(--border); }
  .chk-row:last-of-type { border-bottom:none; }

  .bot-item { background:var(--elev); border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; box-shadow: var(--shadow-sm); transition: border-color 0.15s ease; }
  .bot-item:hover { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
  .bot-head { padding:11px 14px; min-height:66px; display:flex; align-items:center; justify-content:space-between; gap:10px; cursor:pointer; }
  .bot-head-main { display:flex; align-items:center; gap:12px; min-width:0; flex:1; }
  .bot-head-meta { min-width:0; flex:1; }
  .bot-head-title { font-weight:700; font-size:14.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .bot-head-sub { font-size:11.5px; color:var(--sub); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .bot-head > div:last-child { flex-shrink:0; }
  .bot-thumb {
    position:relative; width:52px; height:52px; border-radius:12px; overflow:hidden; flex-shrink:0;
    display:flex; align-items:center; justify-content:center;
    border:1px solid var(--border); background:var(--surface2);
  }
  .bot-thumb.xs { width:28px; height:28px; border-radius:8px; }
  .bot-thumb.sm { width:40px; height:40px; border-radius:10px; }
  .bot-thumb.lg { width:62px; height:62px; border-radius:14px; }
  .bot-thumb-ph {
    width:100%; height:100%; display:flex; align-items:center; justify-content:center;
    font-weight:800; font-size:18px; color:#fff; text-shadow:0 1px 2px rgba(0,0,0,0.28); user-select:none;
  }
  .bot-thumb.xs .bot-thumb-ph { font-size:12px; }
  .bot-thumb.sm .bot-thumb-ph { font-size:15px; }
  .bot-thumb.lg .bot-thumb-ph { font-size:22px; }
  .bot-thumb-img {
    position:absolute; inset:0; width:100%; height:100%;
    object-fit:cover; object-position:center top; display:block;
    transition:filter 0.18s ease, transform 0.18s ease;
  }
  .hdr-avatar-wrap { flex-shrink:0; }
  #hdrHomeTitle { display:none; }
  body.tab-home-active #hdrHomeTitle { display:block; }
  body.tab-home-active #hdrAvatar,
  body.tab-home-active #hdrChar,
  body.tab-home-active .h-sub-row { display:none !important; }
  body.tab-home-active #sceneCtrlQuickBtn,
  body.tab-home-active #reqLogQuickBtn,
  body.tab-home-active #assetCycleBtn,
  body.tab-home-active #autoTrBtn,
  body.tab-home-active #zenModeBtn { display:none !important; }
  .home-status-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:8px; }
  .home-stat-pill { background:var(--bg); border:1px solid var(--border); border-radius:12px; padding:9px 11px; min-width:0; }
  .home-stat-pill .k { font-size:11px; font-weight:700; color:var(--sub); margin-bottom:3px; }
  .home-stat-pill .v { font-size:13px; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .home-resume-card {
    display:flex; align-items:center; gap:14px; cursor:pointer;
    border:1px solid color-mix(in srgb, var(--accent) 36%, var(--border));
    background:linear-gradient(135deg, var(--accent-soft), var(--elev));
  }
  .home-resume-card:hover { border-color:var(--accent); }
  .home-recent-list { display:flex; flex-direction:column; gap:7px; }
  .home-recent-row {
    display:flex; align-items:center; gap:11px; padding:9px 11px; border-radius:12px;
    border:1px solid var(--border); background:var(--bg); cursor:pointer;
    transition:border-color 0.15s ease, background 0.15s ease;
  }
  .home-recent-row:hover { border-color:var(--accent); background:var(--surface); }
  .home-shortcuts { display:flex; flex-wrap:wrap; gap:8px; }
  .home-hint-details {
    margin:0; padding:10px 12px; border-radius:12px; border:1px solid var(--border);
    background:var(--surface); font-size:12px; color:var(--sub); line-height:1.55;
  }
  .home-hint-details summary { cursor:pointer; font-weight:700; color:var(--text); }
  #thumbPickerModal {
    position:fixed; inset:0; z-index:172; background:rgba(0,0,0,0.68);
    -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px);
    display:flex; align-items:center; justify-content:center; padding:12px;
  }
  .thumb-picker-dialog {
    width:min(760px, 96vw); max-height:min(88dvh, 780px);
    background:var(--elev); color:var(--text);
    border:1px solid var(--border); border-radius:18px; box-shadow:var(--shadow);
    display:flex; flex-direction:column; overflow:hidden;
  }
  .thumb-picker-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(104px, 1fr)); gap:10px; }
  .thumb-asset-tile {
    display:flex; flex-direction:column; gap:5px; padding:6px; border-radius:12px;
    border:1px solid var(--border); background:var(--bg); cursor:pointer; text-align:left; color:var(--text);
    transition:border-color 0.15s ease;
  }
  .thumb-asset-tile:hover { border-color:var(--accent); }
  .thumb-asset-tile img {
    width:100%; aspect-ratio:1/1; object-fit:cover; object-position:center top;
    border-radius:8px; background:var(--surface); display:block;
  }
  .thumb-asset-name { font-size:11.5px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .thumb-asset-kind { font-size:10px; color:var(--sub); }
  .badge { display:inline-flex; align-items:center; font-size:11px; padding:3px 8px; border-radius:999px; background:var(--surface2); color:var(--sub); font-weight:700; white-space:nowrap; }
  .badge.pc { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
  .chat-list { border-top:1px solid var(--border); background:var(--surface); padding:8px; display:flex; flex-direction:column; gap:6px; }
  .chat-row { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; min-height:44px; border-radius:10px; background:var(--elev); border:1px solid transparent; cursor:pointer; font-size:13.5px; transition: border-color 0.15s ease; }
  .chat-row:hover { border-color: var(--border); }
  .chat-row > span:first-child { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chat-row.cur { border-color:var(--accent); background: var(--accent-soft); font-weight:700; }
  .row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:11px 0; border-bottom:1px solid var(--border); }
  .row:last-child { border-bottom:none; }
  .f-label { display:block; font-size:12px; font-weight:600; color:var(--sub); margin:12px 0 5px; }
  .btn {
    display:inline-flex; align-items:center; justify-content:center; gap:5px;
    border:1px solid transparent; border-radius:var(--radius-sm); padding:0 14px; min-height:38px;
    font-size:13px; font-weight:700; cursor:pointer; background:var(--accent); color:var(--on-accent);
    white-space:nowrap;
    transition: filter 0.15s ease, transform 0.1s ease, background 0.15s ease;
  }
  #refreshAllBtn {
    width:auto; height:auto; min-width:fit-content; border-radius:var(--radius-sm);
    padding:0 14px; white-space:nowrap;
  }
  .btn:hover { filter: brightness(1.06); }
  .btn:active { transform: scale(0.97); }
  .btn.sec { background:var(--surface); color:var(--text); border-color: var(--border); }
  .btn.sec:hover { background: var(--surface2); filter:none; }
  .btn.danger { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); border-color: color-mix(in srgb, var(--danger) 30%, transparent); }
  .btn-row { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; background:var(--bg); padding:9px 11px; border-radius:10px; border:1px solid var(--border); word-break:break-all; }
  .hint { font-size:12px; color:var(--sub); line-height:1.6; margin-top:8px; }
  .param-grid { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:10px; align-items:end; }
  .param-grid .f-label { margin-top:0; }
  .grid-2 { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:10px; }
  .upd-grid { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:8px; }
  .upd-cell { background:var(--bg); border:1px solid var(--border); border-radius:12px; padding:10px 12px; min-width:0; }
  .upd-cell .k { font-size:11px; font-weight:700; color:var(--sub); margin-bottom:3px; }
  .upd-cell .v { font-size:15px; font-weight:800; font-variant-numeric: tabular-nums; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .upd-msg { margin-top:12px; padding:10px 12px; border-radius:12px; font-size:13px; line-height:1.55; background:var(--surface); border:1px solid var(--border); display:none; }
  .upd-msg.show { display:block; }
  .upd-msg.ok { background: color-mix(in srgb, var(--ok) 12%, transparent); border-color: color-mix(in srgb, var(--ok) 30%, transparent); }
  .upd-msg.err { background: color-mix(in srgb, var(--danger) 10%, transparent); border-color: color-mix(in srgb, var(--danger) 30%, transparent); color: var(--danger); }
  .upd-notes { margin-top:10px; max-height:160px; overflow:auto; white-space:pre-wrap; font-size:12px; color:var(--sub); line-height:1.55; }
  .upd-spin { display:inline-block; width:12px; height:12px; border:2px solid currentColor; border-right-color:transparent; border-radius:50%; animation: rsSpin 0.8s linear infinite; vertical-align:-2px; margin-right:6px; }
  @keyframes rsSpin { to { transform: rotate(360deg); } }
  .tab-btn .ic { position:relative; }
  .tab-btn .ic .nd { position:absolute; top:2px; right:10px; width:8px; height:8px; border-radius:50%; background:var(--danger); box-shadow:0 0 0 2px var(--bg); display:none; }
  .tab-btn.has-update .ic .nd { display:block; }

  /* ===== Login ===== */
  #login { position:fixed; inset:0; background: var(--bg-grad), var(--bg); display:flex; align-items:center; justify-content:center; padding:20px; z-index:99; }
  .login-card { width:100%; max-width:380px; background:var(--elev); border:1px solid var(--border); border-radius:22px; padding:28px 24px 24px; box-shadow: var(--shadow); }
  .login-mark { width:56px; height:56px; border-radius:17px; display:flex; align-items:center; justify-content:center; margin-bottom:16px; color: var(--on-accent);
    background: linear-gradient(145deg, color-mix(in srgb, var(--accent) 82%, #fff) 0%, var(--accent) 45%, color-mix(in srgb, var(--accent) 70%, #000) 100%);
    box-shadow: 0 8px 18px -8px color-mix(in srgb, var(--accent) 70%, transparent), inset 0 1px 0 rgba(255,255,255,0.18); }
  .login-mark svg { width:42px; height:42px; display:block; }
  .login-card h2 { margin:0 0 6px; font-size:20px; font-weight:800; letter-spacing:-0.02em; }
  .login-card p { margin:0 0 18px; font-size:13.5px; color:var(--sub); line-height:1.6; }

  /* ===== Toast ===== */
  #toast {
    position:fixed; top: calc(14px + env(safe-area-inset-top)); left:50%; z-index:120;
    transform:translate(-50%, -12px); opacity:0; pointer-events:none;
    background: color-mix(in srgb, var(--text) 92%, transparent); color: var(--bg);
    padding:10px 16px; border-radius:999px; font-size:13px; font-weight:600; max-width: calc(100vw - 32px);
    box-shadow:0 10px 28px rgba(0,0,0,0.25); transition: opacity 0.2s ease, transform 0.2s ease;
  }
  #toast.show { opacity:1; transform:translate(-50%, 0); }

  /* ===== Responsive ===== */
  /* Prevent iOS focus-zoom on touch devices */
  @media (pointer: coarse) {
    .f-inp, .search-inp, .composer textarea, #readBar select { font-size:16px; }
  }
  /* Korean keep-all + justify leaves wide gaps on narrow columns */
  @media (max-width: 600px) {
    .book-columns, [data-theme^="epub-1p"] .msg-wrap.char .msg-bubble { text-align:left !important; }
  }
  @media (max-width: 410px) {
    .h-right { gap:3px; }
    .icon-pill { width:32px; height:32px; font-size:14px; }
    .composer .pill { padding:0 8px; }
    .param-grid { grid-template-columns: 1fr 1fr; }
  }
  /* Landscape phones: reclaim vertical space */
  @media (max-height: 500px) and (orientation: landscape) {
    header { height: calc(42px + env(safe-area-inset-top)); min-height: calc(42px + env(safe-area-inset-top)); max-height: calc(42px + env(safe-area-inset-top)); }
    .h-sub-row { display:none; }
    .tab-btn { min-height:40px; flex-direction:row; gap:6px; font-size:12px; }
    .tab-btn .ic { padding:3px 10px; }
    .composer { margin-bottom:6px; }
  }
  /* Tablet / Desktop: side navigation rail */
  @media (min-width: 900px) {
    #app {
      grid-template-columns: 92px minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr) auto;
      grid-template-areas: "nav header" "nav main" "nav composer";
    }
    nav.tabbar {
      grid-template-columns: 1fr; grid-auto-rows: min-content; align-content: start; gap:4px;
      border-top:none; border-right:1px solid var(--border);
      padding: calc(14px + env(safe-area-inset-top)) 8px 14px max(8px, env(safe-area-inset-left));
    }
    nav.tabbar .nav-logo {
      display:flex; align-items:center; justify-content:center;
      width:46px; height:46px; margin:0 auto 14px; border-radius:15px;
      color: var(--on-accent);
      background: linear-gradient(145deg, color-mix(in srgb, var(--accent) 82%, #fff) 0%, var(--accent) 45%, color-mix(in srgb, var(--accent) 70%, #000) 100%);
      box-shadow: 0 6px 14px -6px color-mix(in srgb, var(--accent) 70%, transparent), inset 0 1px 0 rgba(255,255,255,0.18);
    }
    nav.tabbar .nav-logo svg { width:34px; height:34px; display:block; }
    .tab-btn { min-height:64px; border-radius:14px; font-size:11.5px; gap:5px; }
    .tab-btn:hover { color: var(--text); }
    .tab-btn:hover .ic { background: var(--surface); }
    .tab-btn.active .ic { background: var(--accent-soft); }
    header { padding-left: 20px; padding-right: 20px; }
    .panel { padding-top: 22px; }
    #tab-modules.active, #tab-router.active {
      display:grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); align-items:start; align-content:start;
      --content-w: 1160px;
    }
    #tab-modules .panel-title, #tab-router .panel-title { grid-column: 1 / -1; }
    /* Masonry: JS (layoutSettingsMasonry) gives each card a row span matching its height,
       so short cards no longer leave holes under them. Only enabled once JS has measured. */
    #tab-modules.active.rs-masonry, #tab-router.active.rs-masonry {
      grid-auto-rows: 4px; row-gap: 0; column-gap: 16px; grid-auto-flow: row dense;
    }
    #tab-modules.rs-masonry > *, #tab-router.rs-masonry > * { align-self:start; }
    /* TTS card is ~3x taller than any other card: give it two grid columns and split its body in two. */
    #tab-router.rs-masonry #ttsConfigCard { grid-column: span 2; }
    #tab-router.rs-masonry #ttsConfigCard .tts-layout { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 18px; align-items:start; }
    #tab-router.rs-masonry #ttsConfigCard .tts-col + .tts-col > .tts-subbox:first-child { margin-top: 4px; }
    #chatVarsBody { max-height: min(64vh, 620px); overflow-y:auto; overscroll-behavior: contain; margin-right:-6px; padding-right:6px; }
    #reqLogCard { grid-column: 1 / -1; }
    #tab-home { --content-w: 760px; }
    .composer { margin-bottom: 16px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }

  /* ===== Floating TTS Mini Player & Cast List ===== */
  #ttsPlayerBar {
    position:fixed; left:50%; bottom:calc(126px + env(safe-area-inset-bottom)); transform:translateX(-50%);
    z-index:45; width:min(580px, calc(100vw - 20px));
    background:var(--elev); border:1px solid var(--border); border-radius:18px;
    box-shadow:var(--shadow); padding:8px 12px; display:none; flex-direction:column; gap:6px;
    -webkit-backdrop-filter: saturate(160%) blur(14px); backdrop-filter: saturate(160%) blur(14px);
  }
  #ttsPlayerBar.show { display:flex; animation: rsFade 0.18s ease; }
  @media (min-width: 900px) {
    #ttsPlayerBar { left:calc(50% + 46px); bottom:calc(82px + env(safe-area-inset-bottom)); }
  }
  .tts-bar-top { display:flex; align-items:center; justify-content:space-between; gap:8px; min-width:0; }
  .tts-bar-meta { display:flex; align-items:center; gap:6px; min-width:0; flex:1; }
  .tts-kind-badge {
    font-size:11px; font-weight:700; padding:2px 7px; border-radius:999px; flex-shrink:0;
    background:var(--accent-soft); color:var(--accent);
  }
  .tts-kind-badge.thought { background: color-mix(in srgb, var(--sub) 18%, transparent); color:var(--text); }
  .tts-kind-badge.narration { background: var(--surface); color:var(--sub); border:1px solid var(--border); }
  .tts-bar-speaker { font-size:12px; font-weight:700; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .tts-bar-tone { font-size:11px; color:var(--sub); white-space:nowrap; }
  .tts-bar-preview {
    font-size:12px; color:var(--sub); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    line-height:1.35;
  }
  .tts-bar-ctrls { display:flex; align-items:center; gap:4px; flex-shrink:0; }
  .tts-bar-btn {
    min-width:28px; height:28px; padding:0 8px; border-radius:999px;
    border:1px solid var(--border); background:var(--surface); color:var(--text);
    font-size:12px; font-weight:600; cursor:pointer; display:inline-flex; align-items:center; justify-content:center;
  }
  .tts-bar-btn:hover { border-color:var(--accent); color:var(--accent); }
  .tts-bar-btn.primary { background:var(--accent); color:var(--on-accent); border-color:transparent; }
  .tts-cast-list { display:flex; flex-direction:column; gap:6px; margin-top:8px; }
  .tts-cast-item {
    display:flex; align-items:center; justify-content:space-between; gap:8px;
    padding:8px 10px; border:1px solid var(--border); border-radius:10px; background:var(--bg);
  }
  .tts-subbox {
    margin-top:10px; padding:10px 12px; border:1px solid var(--border); border-radius:12px;
    background: color-mix(in srgb, var(--surface) 55%, transparent);
  }
  .tts-subbox-title { font-size:12.5px; font-weight:800; color:var(--text); margin-bottom:6px; display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
  .tts-voice-tier { display:grid; grid-template-columns:minmax(122px, 0.92fr) minmax(0, 1.48fr); gap:6px; }
  .tts-vp-tabs { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-bottom:8px; }
  .tts-vp-chips { display:flex; gap:5px; flex-wrap:wrap; margin-top:6px; }
  @media (max-width: 520px) {
    .tts-voice-tier { grid-template-columns:1fr; }
  }
</style>
</head>
<body class="tab-home-active">
<div id="toast" role="status" aria-live="polite"></div>
<div id="ttsPlayerBar" role="region" aria-label="TTS 재생기">
  <div class="tts-bar-top">
    <div class="tts-bar-meta">
      <span class="tts-kind-badge" id="ttsBarKind">💬 대화</span>
      <span class="tts-bar-speaker" id="ttsBarSpeaker">준비 중</span>
      <span class="tts-bar-tone" id="ttsBarTone"></span>
    </div>
    <div class="tts-bar-ctrls">
      <button type="button" class="tts-bar-btn" id="ttsPrevSegBtn" title="이전 구간">⏮</button>
      <button type="button" class="tts-bar-btn primary" id="ttsPauseBtn" title="일시정지/재개">⏸</button>
      <button type="button" class="tts-bar-btn" id="ttsNextSegBtn" title="다음 구간">⏭</button>
      <button type="button" class="tts-bar-btn" id="ttsRateBtn" title="재생 속도">1.0x</button>
      <button type="button" class="tts-bar-btn" id="ttsCfgJumpBtn" title="TTS 설정">⚙️</button>
      <button type="button" class="tts-bar-btn" id="ttsStopBtn" title="정지">✕</button>
    </div>
  </div>
  <div class="tts-bar-preview" id="ttsBarPreview">...</div>
</div>
<div id="botBgHost" class="rs-bg-host rs-bot-html"></div>
<div id="bookBotOverlay" class="bot-menu-collapsed"></div>
<div id="rsMiniBar" class="minimized" style="display:none;" aria-label="리스스탠드 플로팅 미니바"></div>
<button id="botMenuFab" type="button" style="display:none;" title="봇 메뉴 펼치기 / 접기"><span class="bmf-ic">☰</span><span class="bmf-lb">메뉴</span></button>
<div id="triggerModal" style="display:none;" role="dialog" aria-modal="true"></div>
<div id="reqLogModal" style="display:none;" role="dialog" aria-modal="true" aria-label="리퀘스트 로그"></div>
<div id="msgEditModal" style="display:none;" role="dialog" aria-modal="true" aria-label="메시지 수정"></div>
<div id="pluginGuiModal" style="display:none;" role="dialog" aria-modal="true" aria-label="플러그인 GUI"></div>
<div id="pluginFloatingModal" style="display:none;" role="dialog" aria-modal="true" aria-label="플러그인 플로팅 컨트롤"></div>
<div id="sceneCtrlModal" style="display:none;" role="dialog" aria-modal="true" aria-label="장면·삽화 제어함"></div>
<div id="thumbPickerModal" style="display:none;" role="dialog" aria-modal="true" aria-label="봇 썸네일 변경"></div>

<div id="login">
  <div class="login-card">
    <div class="login-mark">${RS_MARK_SVG}</div>
    <h2>RisuStand Remote</h2>
    <p>PC 터미널에 출력된 보안 토큰을 입력하세요.<br>한 번 로그인하면 이 기기에 저장됩니다.</p>
    <input class="f-inp" id="tokInput" type="password" placeholder="보안 토큰 입력" autocomplete="current-password" style="margin-bottom:10px;" />
    <button class="btn" id="loginBtn" style="width:100%; min-height:46px; font-size:14.5px;">접속하기</button>
    <div id="loginErr" style="color:var(--danger); font-size:12.5px; margin-top:10px; min-height:1em;"></div>
  </div>
</div>

<div id="app" style="display:none;">
  <header>
    <div class="h-left" onclick="switchTab('home')" style="cursor:pointer;" title="홈으로">
      <span class="dot" id="pcDot"></span>
      <div id="hdrAvatar" class="hdr-avatar-wrap" style="display:none;"></div>
      <div style="min-width:0; flex:1;">
        <div class="h-title" id="hdrHomeTitle">RisuStand</div>
        <div class="h-title" id="hdrChar">연결 중...</div>
        <div class="h-sub-row">
          <div class="h-sub" id="hdrSub">-</div>
          <div class="hdr-act-bar" id="hdrActivityBar" onclick="event.stopPropagation()"></div>
        </div>
      </div>
    </div>
    <div class="h-right">
      <button class="pill icon-pill" id="sceneCtrlQuickBtn" title="장면·삽화 제어함" aria-label="장면·삽화 제어함">🎨</button>
      <button class="pill icon-pill" id="reqLogQuickBtn" title="리퀘스트 로그 보기" aria-label="리퀘스트 로그">📜</button>
      <button class="pill icon-pill" id="assetCycleBtn" title="에셋 표시 / 가리기 / 감추기" aria-label="에셋 표시 모드">🖼️</button>
      <button class="pill icon-pill" id="autoTrBtn" title="응답 자동 번역" aria-label="응답 자동 번역">🌐</button>
      <button class="pill icon-pill" id="zenModeBtn" title="집중 모드 (상·하단바 숨김 + 플로팅 미니바)" aria-label="집중 모드">🧘</button>
      <button class="pill icon-pill" id="readBarToggle" title="테마·글꼴·에셋 설정" aria-label="화면 설정" aria-expanded="false" style="font-weight:800;">Aa</button>
    </div>
  </header>

  <div class="read-bar" id="readBar" role="dialog" aria-label="화면 설정">
      <div class="rb-sec">
        <div class="rb-label">테마</div>
        <div class="theme-grid" id="themeGrid">
          <button class="theme-chip" data-theme-key="ai-gemini"><span class="sw" style="background:linear-gradient(135deg,#ffffff 50%,#0b57d0 50%)"></span><span>Gemini</span></button>
          <button class="theme-chip" data-theme-key="ai-claude"><span class="sw" style="background:linear-gradient(135deg,#faf9f5 50%,#c96442 50%)"></span><span>Claude</span></button>
          <button class="theme-chip" data-theme-key="ai-chatgpt"><span class="sw" style="background:linear-gradient(135deg,#ffffff 50%,#0d0d0d 50%)"></span><span>ChatGPT</span></button>
          <button class="theme-chip" data-theme-key="midnight-glass"><span class="sw" style="background:linear-gradient(135deg,#0a0f1f 50%,#8ea2ff 50%)"></span><span>미드나잇 글래스</span></button>
          <button class="theme-chip" data-theme-key="epub-1p-day"><span class="sw" style="background:linear-gradient(135deg,#f4efe6 50%,#8c5a2b 50%)"></span><span>세피아 · 스크롤</span></button>
          <button class="theme-chip" data-theme-key="epub-1p-night"><span class="sw" style="background:linear-gradient(135deg,#141518 50%,#d2a86e 50%)"></span><span>다크 · 스크롤</span></button>
          <button class="theme-chip" data-theme-key="epub-2p-day"><span class="sw" style="background:linear-gradient(135deg,#f8f3e9 50%,#8c5a2b 50%)"></span><span>세피아 · 종이책</span></button>
          <button class="theme-chip" data-theme-key="epub-2p-night"><span class="sw" style="background:linear-gradient(135deg,#1a1b20 50%,#d2a86e 50%)"></span><span>다크 · 종이책</span></button>
          <button class="theme-chip" data-theme-key="sakura-pastel"><span class="sw" style="background:linear-gradient(135deg,#fff8fb 50%,#c2477a 50%)"></span><span>사쿠라 파스텔</span></button>
          <button class="theme-chip" data-theme-key="forest-moss"><span class="sw" style="background:linear-gradient(135deg,#111a15 50%,#6cc493 50%)"></span><span>포레스트 모스</span></button>
        </div>
      </div>
      <div class="rb-sec">
        <div class="rb-label">글꼴 · 크기</div>
        <div class="rb-grp" style="flex-wrap:nowrap;">
          <select class="f-inp" id="fontSel" style="flex:1; min-width:0;">
            <option value="system">시스템 기본</option>
            <option value="serif">전자책 명조</option>
            <option value="sans">눈 편한 고딕</option>
          </select>
          <button class="pill icon-pill" id="fsDec" aria-label="글자 작게" style="font-size:12px;">A-</button>
          <span class="rb-val" id="fsVal">15.5</span>
          <button class="pill icon-pill" id="fsInc" aria-label="글자 크게" style="font-size:15px;">A+</button>
        </div>
        <button class="pill" id="lhBtn" style="align-self:flex-start;">줄간격 1.75</button>
      </div>
      <div class="rb-sec">
        <div class="rb-label">에셋 (이미지)</div>
        <div class="seg">
          <button class="pill" id="amShow" onclick="setAssetMode('show')">🖼️ 표시</button>
          <button class="pill" id="amBlur" onclick="setAssetMode('blur')">🌫️ 가리기</button>
          <button class="pill" id="amHide" onclick="setAssetMode('hide')">🙈 감추기</button>
        </div>
      </div>
      <div class="rb-sec">
        <div class="rb-label">봇 정규식 UI (HTML)</div>
        <button class="pill" id="richHtmlBtn" style="align-self:flex-start;">✨ 봇 정규식 UI: 켜짐</button>
      </div>
      <div class="rb-sec">
        <div class="rb-label">플로팅 도구</div>
        <button class="pill" id="openPlgFloatingBtn" type="button" style="align-self:flex-start;">🎛️ 플러그인 플로팅 컨트롤</button>
      </div>
      <div class="rb-sec" style="border-top:1px solid var(--border); padding-top:10px;">
        <button class="btn sec" id="logoutBtn" style="width:100%;">🔒 로그아웃 / 토큰 변경</button>
      </div>
  </div>

  <!-- TAB 1: CHAT / EPUB READER -->
  <section class="panel" id="tab-chat"></section>
  <div class="composer" id="composerBar" style="display:none;">
    <button class="pill" id="inTrBtn" title="입력 한→영 자동 번역">한→영</button>
    <textarea id="msgInput" rows="1" placeholder="메시지를 입력하세요..."></textarea>
    <button class="send-btn" id="sendBtn">전송</button>
  </div>

  <!-- TAB 2: HOME (DASHBOARD & BOT LIBRARY) -->
  <section class="panel active" id="tab-home">
    <div id="homeTopArea" style="display:flex; flex-direction:column; gap:12px;"></div>
    <div class="panel-title" style="margin-top:4px;">봇 서재</div>
    <div style="display:flex; gap:8px;">
      <input class="search-inp" id="botSearch" placeholder="봇 이름 검색..." />
      <button class="btn sec" id="refreshAllBtn" style="flex-shrink:0;">새로고침</button>
    </div>
    <details class="home-hint-details">
      <summary>ℹ️ 동작 방식 안내</summary>
      <div style="margin-top:6px;">
        PC RisuAI에 현재 열려 있는 봇은 <b>PC 활성</b>(<code>risuai.sendChat()</code>)으로 동작합니다. PC가 홈 화면이거나 다른 봇을 열어 둔 상태에서는 <b>원격 라우팅</b>으로 동작하며, <b>[🧩 모듈/설정]</b>의 <b>백엔드 플러그인 어댑터</b>에서 켠 RisuAI v3 플러그인들이 RisuAI <code>pluginStorage</code>·<code>DB</code>에 직접 연결되어 동작합니다. (어댑터에 켜지 않은 다른 RisuAI 플러그인은 PC 활성 상태에서만 동작합니다.)
      </div>
    </details>
    <div id="botList" style="display:flex; flex-direction:column; gap:8px;"></div>
  </section>

  <!-- TAB 3: MODULES & PARAMS -->
  <section class="panel" id="tab-modules">
    <div class="panel-title">모듈 · 설정</div>
    <div class="card" id="customToggleCard">
      <h3>
        <span>🎛️ 모듈 · 프리셋 토글</span>
        <span style="display:flex; gap:5px; align-items:center;">
          <button class="pill" onclick="togglePresetAdder()">+ 프리셋 토글</button>
          <span id="localToggleBadge" class="badge">로컬 토글</span>
        </span>
      </h3>
      <div class="leave-preset-bar" id="leavePresetBar">
        <div class="leave-preset-info">
          <b>🍃 Leave · 방랑 사서의 서가 r1.1</b>
          <span>내장 AI 프리셋 토글 · RisuAI 임포트 RISUP · 가이드</span>
        </div>
        <div class="leave-preset-btns">
          <button type="button" class="pill" onclick="installBundledLeaveToggle()">🔄 Leave 토글 동기화</button>
          <button type="button" class="pill" onclick="downloadLeavePreset()">⬇️ RISUP 받기</button>
          <button type="button" class="pill" onclick="openLeavePresetGuide()">📖 가이드</button>
        </div>
      </div>
      <div id="presetToggleAdder" style="display:none; margin-bottom:12px; padding:12px; border-radius:12px; background:var(--bg); border:1px solid var(--border);">
        <div style="font-size:11.5px; color:var(--sub); line-height:1.5; margin-bottom:6px;">
          원격 프롬으로 등록된 프리셋의 자체 토글은 선택 시 <b>자동 등록·연동</b>됩니다. 수동으로 추가할 때는 아래에 커스텀 토글 텍스트를 붙여넣고 필요 시 부모 원격 프롬을 지정하세요.
        </div>
        <select class="f-inp" id="ptParentPreset" style="margin-bottom:6px;"></select>
        <input class="f-inp" id="ptName" placeholder="프리셋 이름 (예: Leave · 방랑 사서의 서가 r1.1)" style="margin-bottom:6px;" />
        <textarea class="f-inp" id="ptSyntax" rows="5" placeholder="RisuAI 프리셋의 커스텀 토글 텍스트를 그대로 붙여넣기..."></textarea>
        <div class="btn-row">
          <button class="btn" onclick="savePresetToggle()">저장</button>
          <button class="btn sec" onclick="togglePresetAdder(false)">취소</button>
        </div>
      </div>
      <div id="customToggleBody" style="font-size:12.5px; color:var(--sub);">활성화된 모듈에 커스텀 토글이 없습니다.</div>
      <label class="chk-row" style="margin-top:12px; border-top:1px solid var(--border); border-bottom:none; padding-bottom:0;">
        <span>이 방에만 로컬 토글 사용 <span style="color:var(--sub); font-size:12px;">(꺼두면 전역으로 계속 유지)</span></span>
        <input type="checkbox" id="localToggleChk" />
      </label>
    </div>
    <div class="card" id="chatVarsCard" style="display:none;">
      <h3>💬 채팅 변수 (봇 상태)</h3>
      <div id="chatVarsBody"></div>
    </div>
    <div class="card" id="authorNoteCard">
      <h3>
        <span>📝 작가의 노트 · 캐릭터 설명</span>
        <span class="badge" id="authorNoteBadge">0자</span>
      </h3>
      <label class="f-label" style="margin-top:4px;">이 채팅방 작가의 노트 (Author's Note)</label>
      <textarea class="f-inp" id="authorNoteInput" rows="4" placeholder="이 채팅방에 기입된 작가의 노트가 없습니다. 내용을 입력해 저장하면 PC RisuAI 및 원격 직접 요청에 즉시 반영됩니다."></textarea>
      <div class="btn-row">
        <button type="button" class="btn" id="saveAuthorNoteBtn">💾 작가의 노트 저장</button>
        <button type="button" class="btn sec" id="resetAuthorNoteBtn">↺ 되돌리기</button>
      </div>
      <details id="charGlobalNoteDetails" style="margin-top:12px; padding-top:10px; border-top:1px solid var(--border);">
        <summary style="cursor:pointer; font-size:12.5px; font-weight:700; color:var(--text);">🌐 봇 카드 글로벌 노트 (replaceGlobalNote) <span id="charGlobalNoteBadge" class="badge">없음</span></summary>
        <div style="margin-top:8px;">
          <textarea class="f-inp" id="charGlobalNoteInput" rows="3" placeholder="봇 카드에 기입된 글로벌 노트가 없습니다. ({{original}} 포함 가능)"></textarea>
          <div class="btn-row"><button type="button" class="btn sec" id="saveCharGlobalNoteBtn">💾 글로벌 노트 저장</button></div>
        </div>
      </details>
      <details id="charDescPreviewDetails" style="margin-top:10px; padding-top:10px; border-top:1px solid var(--border);">
        <summary style="cursor:pointer; font-size:12.5px; font-weight:700; color:var(--text);">📋 반영 중인 캐릭터 설명 · 프롬프트 확인 <span id="charDescBadge" class="badge">0자</span></summary>
        <div id="charDescPreviewBody" style="margin-top:8px; display:flex; flex-direction:column; gap:8px; font-size:12px;"></div>
      </details>
    </div>
    <div class="card" id="backendPluginsCard">
      <h3>
        <span>🔌 백엔드 플러그인 어댑터</span>
        <span class="badge" id="backendPluginCount">0 활성</span>
      </h3>
      <div class="hint" style="margin-top:0;">
        <b>원격 라우팅</b>(<code>sendChat()</code> 미사용)에서도 RisuAI v3 플러그인을 백엔드 어댑터에서 직접 실행하고, PC RisuAI의 <code>pluginStorage</code>·<code>DB</code>에 직접 읽고 씁니다. 원격에서 쌓인 데이터는 PC 네이티브 실행 시에도 그대로 이어집니다.
      </div>
      <label style="display:flex; align-items:flex-start; gap:8px; margin-top:8px; padding:9px 11px; border-radius:10px; border:1px solid var(--border); background:var(--surface); cursor:pointer;">
        <input type="checkbox" id="remoteDirectOnlyChk" checked style="margin-top:3px;" />
        <span style="font-size:12.5px; line-height:1.45;">
          <b>원격 전송 시 백엔드 단독 실행 (열려 있는 봇 포함 · PC 내부 플러그인 중지)</b><br/>
          <span style="color:var(--sub); font-size:11.5px;">켜 두면 PC에 봇이 열려 있어도 <code>sendChat()</code>을 호출하지 않아 PC 내부 플러그인 작동이 멈추고, 백엔드에 켠 원격 플러그인만 단독 실행됩니다.</span>
        </span>
      </label>
      <div class="btn-row" style="margin-top:8px;">
        <button type="button" class="btn sec" id="syncPcPluginsBtn">🔄 PC 플러그인 동기화</button>
        <button type="button" class="btn sec" id="uploadPluginBtn">+ .js 추가</button>
        <button type="button" class="btn sec" id="reloadPcPluginsBtn">🔁 PC 플러그인 리로드</button>
        <input type="file" id="pluginFileInp" accept=".js,.mjs,.cjs,text/javascript,application/javascript" style="display:none;" />
      </div>
      <div id="backendPluginList" class="plg-list">
        <div style="color:var(--sub); font-size:12.5px;">등록된 플러그인이 없습니다. PC 연결 시 [PC 플러그인 동기화] 또는 [.js 추가]를 눌러 주세요.</div>
      </div>
    </div>
    <div class="card" id="lorebookCard">
      <h3>
        <span>📚 캐릭터 · 채팅 로어북</span>
        <span class="badge" id="loreCountBadge">0 / 0 반영</span>
      </h3>
      <div class="hint" style="margin-top:0; margin-bottom:8px;">
        캐릭터·이 방 로어북은 기본적으로 <b>체크(반영 대상)</b>되어 있으며, 체크를 해제한 항목만 제외됩니다. 키워드 로어북은 <b>📌 고정</b>으로 강제 포함할 수 있습니다. (모듈 로어북은 아래 별도 카드로 분리됨)
      </div>
      <div style="display:flex; gap:6px; margin-bottom:8px;">
        <input class="search-inp" id="loreSearch" placeholder="캐릭터 · 채팅 로어북 제목 · 키워드 · 내용 검색..." />
        <button type="button" class="btn sec" id="loreRefreshBtn" style="flex-shrink:0;">🔄</button>
      </div>
      <div id="loreFilters" style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:8px;">
        <button type="button" class="pill active" data-lore-src="all">전체</button>
        <button type="button" class="pill" data-lore-src="char">캐릭터</button>
        <button type="button" class="pill" data-lore-src="local">이 방</button>
        <span style="flex:1;"></span>
        <button type="button" class="pill" id="loreEnableAllBtn">전체 반영</button>
        <button type="button" class="pill" id="loreExcludeShownBtn">표시 제외</button>
      </div>
      <div id="loreList" style="display:flex; flex-direction:column; gap:8px; max-height:420px; overflow-y:auto;"></div>
    </div>
    <div class="card" id="moduleLorebookCard">
      <h3>
        <span>🧩 모듈 로어북</span>
        <span class="badge" id="modLoreCountBadge">0 / 0 반영</span>
      </h3>
      <div class="hint" style="margin-top:0; margin-bottom:8px;">
        모듈 로어북은 <b>전체 비활성(미반영)</b>이 원칙이며 전체 반영되지 않습니다. 꼭 필요한 항목만 개별 체크하여 선택 반영하세요.
      </div>
      <div style="display:flex; gap:6px; margin-bottom:8px;">
        <input class="search-inp" id="modLoreSearch" placeholder="모듈 로어북 제목 · 모듈명 · 키워드 검색..." />
        <button type="button" class="btn sec" id="modLoreRefreshBtn" style="flex-shrink:0;">🔄</button>
      </div>
      <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:8px; align-items:center;">
        <span style="font-size:11.5px; color:var(--sub);">원칙: 기본 전체 비활성 · 개별 선택만 허용</span>
        <span style="flex:1;"></span>
        <button type="button" class="pill" id="modLoreDisableAllBtn">전체 비활성</button>
      </div>
      <div id="modLoreList" style="display:flex; flex-direction:column; gap:8px; max-height:360px; overflow-y:auto;"></div>
    </div>
    <div class="card">
      <h3>👤 페르소나 선택</h3>
      <select class="f-inp" id="personaSel"></select>
    </div>
    <div class="card">
      <h3>🎛️ RisuAI 기본 파라미터</h3>
      <div class="param-grid">
        <div><span class="f-label">Temperature (×100)</span><input class="f-inp" id="pTemp" type="number" /></div>
        <div><span class="f-label">Max Context</span><input class="f-inp" id="pCtx" type="number" /></div>
        <div><span class="f-label">Max Response</span><input class="f-inp" id="pResp" type="number" /></div>
      </div>
      <div class="btn-row"><button class="btn" id="saveParamsBtn">파라미터 RisuAI 반영</button></div>
    </div>
    <div class="card">
      <h3>🧩 모듈 관리 <span id="modCount" class="badge">0</span></h3>
      <input class="search-inp" id="modSearch" placeholder="모듈 검색..." style="margin-bottom:8px;" />
      <div id="modList"></div>
    </div>
    <div class="card" id="updateCard">
      <h3><span>🔄 업데이트</span><span class="badge" id="updBadge">확인 전</span></h3>
      <div class="upd-grid">
        <div class="upd-cell"><div class="k">릴레이 서버</div><div class="v" id="updRelay">-</div></div>
        <div class="upd-cell"><div class="k">PC 플러그인</div><div class="v" id="updPlugin">-</div></div>
        <div class="upd-cell"><div class="k">최신 릴리즈</div><div class="v" id="updLatest">-</div></div>
      </div>
      <div class="upd-msg" id="updMsg"></div>
      <div class="upd-notes" id="updNotes" style="display:none;"></div>
      <div class="btn-row">
        <button class="btn sec" id="updCheckBtn">업데이트 확인</button>
        <button class="btn" id="updApplyBtn" style="display:none;">서버 업데이트</button>
        <a class="btn sec" id="updNotesLink" target="_blank" rel="noopener" style="display:none; text-decoration:none;">릴리즈 페이지</a>
      </div>
      <div class="hint">서버 업데이트는 GitHub 공식 릴리즈만 받아 SHA-256·매니페스트를 검증한 뒤 백업하고 교체합니다. 새 버전이 시작되지 못하면 자동으로 되돌립니다. 플러그인(risustand.js)은 PC RisuAI의 플러그인 설정에서 업데이트됩니다.</div>
    </div>
  </section>

  <!-- TAB 4: MODEL ROUTER & TRANSLATOR -->
  <section class="panel" id="tab-router">
    <div class="panel-title">모델 · 번역</div>
    <div class="card">
      <h3>🔗 PC RisuAI 프록시 연동 주소</h3>
      <div class="mono">http://127.0.0.1:${PORT}/v1/chat/completions</div>
      <div class="hint">
        PC RisuAI의 모델(Reverse Proxy / OpenAI 호환) URL을 위 주소로, API 키에 <b>Security Token</b>(로컬 PC 외 원격 프록시 호출 시 필수), 모델 이름에 <code>risustand-router</code>를 지정하면 아래에서 고른 모델·프롬프트가 실시간 반영됩니다.<br>
        프로필의 Temperature · Max Tokens를 입력하면 모든 프로바이더(OpenAI 호환 · Anthropic · Gemini)에서 RisuAI 값보다 우선 적용되며, 비우면 RisuAI 설정을 유지합니다.
      </div>
    </div>

    <div class="card">
      <h3>⚡ AI 프리셋 · 모델 프로필 (릴레이 라우터)</h3>
      <div style="margin-bottom:10px; padding:10px 12px; border-radius:10px; border:1px solid var(--border); background:var(--surface);">
        <div class="f-label" style="margin:0 0 5px;">🧩 보조 모델 파이프라인 (<code>otherAx</code> · 모듈/플러그인 보조 LLM)</div>
        <select class="f-inp" id="auxProfileSel" style="min-height:38px;"></select>
        <div class="hint" style="margin-top:4px;">메인 채팅(<code>model</code>)은 아래 활성 프로필을, 모듈(<code>axLLM</code>)·플러그인 보조 호출(<code>otherAx</code>)은 위 보조 모델을 사용합니다.</div>
      </div>
      <div id="profileList" style="display:flex; flex-direction:column; gap:6px; margin-bottom:10px;"></div>
      <div class="btn-row">
        <button class="btn sec" onclick="openNewProfile('ollama_cloud')">+ Ollama Cloud</button>
        <button class="btn sec" onclick="openNewProfile('openrouter')">+ OpenRouter</button>
        <button class="btn sec" onclick="openNewProfile('gemini')">+ Gemini</button>
        <button class="btn sec" onclick="openNewProfile('claude')">+ Claude</button>
        <button class="btn sec" onclick="openNewProfile('deepseek')">+ DeepSeek</button>
        <button class="btn sec" onclick="openNewProfile('openai')">+ OpenAI/기타</button>
      </div>
    </div>

    <div class="card" id="profileEditor" style="display:none;">
      <h3 id="edTitle">프로필 편집</h3>
      <input type="hidden" id="edId" />
      <label class="f-label">프로바이더 제공사 (선택 시 엔드포인트 자동 입력)</label>
      <select class="f-inp" id="edProvider"></select>
      <label class="f-label">프로필 이름</label>
      <input class="f-inp" id="edName" />
      <label class="f-label">프로바이더 포맷</label>
      <select class="f-inp" id="edType">
        <option value="openai_compat">OpenAI 호환 (OpenRouter / Ollama Cloud / DeepSeek / OpenAI)</option>
        <option value="gemini">Google Gemini API</option>
        <option value="anthropic">Anthropic Claude API</option>
      </select>
      <label class="f-label">API 엔드포인트 URL</label>
      <input class="f-inp" id="edUrl" />
      <label class="f-label">API 키 (PC 로컬 파일에만 저장, 비우면 기존 유지)</label>
      <input class="f-inp" id="edKey" type="password" placeholder="새 키 입력 또는 비워두기" />
      <label class="f-label">모델 ID</label>
      <div style="display:flex; gap:6px; align-items:center;">
        <input class="f-inp" id="edModel" placeholder="예: deepseek-v4.1-flash:1017-cloud, anthropic/claude-3.7-sonnet" style="flex:1; min-width:0;" />
        <button type="button" class="btn sec" id="edLoadModelsBtn" style="flex-shrink:0;">🔄 모델 불러오기</button>
      </div>
      <select class="f-inp" id="edModelPick" style="display:none; margin-top:6px;"></select>
      <div class="hint" id="edModelStatus" style="margin-top:4px;"></div>
      <div class="grid-2">
        <div><label class="f-label">Temperature 덮어쓰기</label><input class="f-inp" id="edTemp" placeholder="비우면 유지" /></div>
        <div><label class="f-label">Max Tokens 덮어쓰기</label><input class="f-inp" id="edMaxTok" placeholder="비우면 유지" /></div>
      </div>
      <label class="f-label">원격 시스템 프롬프트 오버라이드</label>
      <select class="f-inp" id="edOvMode">
        <option value="off">사용 안 함 (RisuAI 원본 그대로)</option>
        <option value="append">기존 시스템 프롬프트 뒤에 추가</option>
        <option value="prepend">맨 앞 시스템 지침으로 추가</option>
        <option value="replace">시스템 프롬프트 전체 교체</option>
      </select>
      <textarea class="f-inp" id="edOvText" rows="3" placeholder="원격에서 덧씌울 지침/프리셋 (선택)" style="margin-top:6px;"></textarea>
      <div class="btn-row">
        <button class="btn" id="saveProfBtn">저장</button>
        <button class="btn sec" onclick="document.getElementById('profileEditor').style.display='none'">취소</button>
        <button class="btn danger" id="delProfBtn" style="margin-left:auto;">삭제</button>
      </div>
    </div>

    <div class="card" id="directPresetCard">
      <h3>📜 원격 직접 요청 프롬프트 프리셋</h3>
      <select class="f-inp" id="directPresetSel"></select>
      <div class="grid-2" style="margin-top:8px;">
        <div>
          <label class="f-label">대화 히스토리 창</label>
          <select class="f-inp" id="directHistoryModeSel">
            <option value="chunked">캐시 친화 청크 (기본 · 5턴 고정)</option>
            <option value="full">전체 히스토리 (최대 100메시지)</option>
            <option value="sliding_30">슬라이딩 30메시지 (레거시)</option>
          </select>
        </div>
        <div>
          <label class="f-label">생성 파이프라인</label>
          <select class="f-inp" id="directPipelineModeSel">
            <option value="single">단일 패스 (기본 · 빠름)</option>
            <option value="two_pass">경량 2-Pass (초안+가드+퇴고)</option>
          </select>
        </div>
      </div>
      <div class="hint" id="directPresetHint" style="margin-top:6px;">
        PC에서 <code>risuai.sendChat()</code>을 쓸 수 없는 <code>원격 라우팅</code>에서는 이 프리셋과 <b>[🧩 모듈/설정]</b> 토글·로어북이 반영되며, <b>백엔드 플러그인 어댑터</b>에 켠 RisuAI v3 플러그인도 RisuAI <code>pluginStorage</code>·<code>DB</code>에 직접 연결되어 함께 동작합니다. (어댑터에 켜지 않은 다른 RisuAI 플러그인은 <b>PC 활성</b> 상태에서 동작합니다.)
      </div>
      <div class="btn-row">
        <button type="button" class="btn sec" id="directPresetUploadBtn">+ .risup / .json 업로드</button>
        <input type="file" id="directPresetFile" accept=".risup,.json" style="display:none;" />
        <button type="button" class="btn danger" id="directPresetDelBtn" style="display:none; margin-left:auto;">삭제</button>
      </div>
    </div>

    <div class="card" id="imageGenCard">
      <h3>🎨 백엔드 삽화 프로바이더 (모듈 · <code>generateImage</code>)</h3>
      <label class="f-label" style="margin-top:4px;">설정 연동 방식</label>
      <select class="f-inp" id="imgGenSource">
        <option value="pc_risu">PC RisuAI [기타 봇 - 이미지 생성] 설정 자동 연동 (추천)</option>
        <option value="custom">RisuStand 원격 전용 커스텀 프로바이더 사용</option>
      </select>
      <div class="hint" style="margin-top:5px;">
        모듈(예: 라이트보드 🌠 삽화)이 RisuAI 내부 <code>generateImage()</code> API를 호출하면 이 백엔드 프로바이더로 실행되어 Inlay로 저장됩니다. (에셋 메이드 등 자체 API를 쓰는 플러그인은 플러그인 내부 설정과 <code>runLLMModel</code>을 그대로 사용합니다.)
      </div>
      <div id="imgGenCustomBox" style="margin-top:8px;">
        <label class="f-label">이미지 프로바이더</label>
        <select class="f-inp" id="imgGenProvider">
          <option value="novelai">NovelAI (v3 / v4 / v4.5 · ' | ' 다중 캐릭터 지원)</option>
          <option value="comfyui">ComfyUI (로컬 127.0.0.1:8188 또는 원격 서버)</option>
          <option value="webui">SD WebUI / Forge (/sdapi/v1/txt2img)</option>
          <option value="openai">OpenAI Image (DALL-E 3 / GPT-Image)</option>
        </select>
        <label class="f-label">엔드포인트 URL (비우면 프로바이더 기본 주소 사용)</label>
        <input class="f-inp" id="imgGenUrl" placeholder="NovelAI 기본 / ComfyUI: http://127.0.0.1:8188 / WebUI: http://127.0.0.1:7860" />
        <label class="f-label">API 키 (PC 로컬 저장 · 비우면 유지)</label>
        <input class="f-inp" id="imgGenKey" type="password" placeholder="NovelAI Token 또는 OpenAI API Key" />
        <label class="f-label">모델 ID</label>
        <input class="f-inp" id="imgGenModel" placeholder="nai-diffusion-4-5-full" />
        <div class="grid-2">
          <div><label class="f-label">너비 (Width)</label><input class="f-inp" id="imgGenWidth" type="number" /></div>
          <div><label class="f-label">높이 (Height)</label><input class="f-inp" id="imgGenHeight" type="number" /></div>
        </div>
        <div class="grid-2">
          <div><label class="f-label">Steps</label><input class="f-inp" id="imgGenSteps" type="number" /></div>
          <div><label class="f-label">CFG Scale</label><input class="f-inp" id="imgGenScale" type="number" step="0.5" /></div>
        </div>
        <label class="f-label">Sampler</label>
        <input class="f-inp" id="imgGenSampler" placeholder="k_euler_ancestral" />
        <label class="f-label">기본 네거티브 프롬프트</label>
        <textarea class="f-inp" id="imgGenNegBase" rows="2"></textarea>
        <div id="imgGenComfyBox" style="display:none;">
          <label class="f-label">ComfyUI API Workflow JSON (<code>{{risu_prompt}}</code> / <code>{{risu_neg}}</code> 지원)</label>
          <textarea class="f-inp" id="imgGenComfyWorkflow" rows="4" placeholder="{ ... }"></textarea>
          <div class="grid-2">
            <div><label class="f-label">Positive Node ID (선택)</label><input class="f-inp" id="imgGenComfyPosId" placeholder="예: 6" /></div>
            <div><label class="f-label">Negative Node ID (선택)</label><input class="f-inp" id="imgGenComfyNegId" placeholder="예: 7" /></div>
          </div>
        </div>
      </div>
      <div class="btn-row"><button type="button" class="btn" id="saveImgGenBtn">💾 삽화 설정 저장</button></div>
    </div>

    <div class="card" id="ttsConfigCard">
      <h3>
        <span>🔊 멀티 캐릭터 · 톤 TTS 설정</span>
        <label class="chk-row" style="margin:0; padding:0; border:none; font-size:12px; gap:6px;">
          <span>아이콘 표시</span>
          <input type="checkbox" id="ttsEnabledChk" checked />
        </label>
      </h3>
      <div class="tts-layout"><div class="tts-col">
      <label class="f-label" style="margin-top:4px;">간편 엔드포인트 프리셋 · 로컬 서버 탐색</label>
      <div style="display:flex; gap:6px; align-items:center;">
        <select class="f-inp" id="ttsEndpointPresetSel" style="flex:1; min-width:0;">
          <option value="">-- 빠른 프리셋 선택 --</option>
          <option value="fish_local_8081">Fish Speech S2-Pro 로컬 (127.0.0.1:8081)</option>
          <option value="fish_local_8080">Fish Speech 로컬 기본 (127.0.0.1:8080)</option>
          <option value="localai_8080">LocalAI 로컬 허브 (127.0.0.1:8080)</option>
          <option value="qwen3_8881">Qwen3-TTS FastAPI 로컬 (127.0.0.1:8881)</option>
          <option value="vllm_8000">vLLM-Omni / TTS-WebUI 로컬 (127.0.0.1:8000)</option>
          <option value="fish_cloud">Fish Audio Cloud (상용 · api.fish.audio)</option>
          <option value="openai_cloud">OpenAI TTS (상용 · gpt-4o-mini-tts)</option>
        </select>
        <button type="button" class="btn sec" id="ttsDiscoverBtn" style="flex-shrink:0;">🔍 로컬 자동 탐색</button>
      </div>
      <select class="f-inp" id="ttsDiscoveredPick" style="display:none; margin-top:6px;"></select>
      <div class="hint" id="ttsDiscoverStatus" style="margin-top:4px;"></div>

      <label class="f-label" style="margin-top:6px;">TTS 엔진 프로바이더</label>
      <select class="f-inp" id="ttsProviderSel">
        <option value="fish_local">Fish Speech 로컬 (기본 · /v1/tts · Pinokio / api_server)</option>
        <option value="openai_compat_local">OpenAI 호환 로컬 허브 (/v1/audio/speech · LocalAI / TTS-WebUI / vLLM-Omni / Qwen3-TTS)</option>
        <option value="fish_cloud">Fish Audio Cloud (상용 · api.fish.audio)</option>
        <option value="openai_compat_cloud">OpenAI TTS / 호환 상용 API (gpt-4o-mini-tts)</option>
      </select>
      <div class="hint" id="ttsProviderHint" style="margin-top:5px;">
        Windows에서는 <b>Pinokio</b>(Fish Speech 원클릭 설치)나 <b>LocalAI / TTS-WebUI</b>를 켜고 아래 로컬 주소에 연결하면 Ollama처럼 모델을 서빙할 수 있습니다.
      </div>
      <label class="f-label">엔드포인트 URL (<code>127.0.0.1:8081</code>처럼 주소:포트만 입력해도 경로 자동 완성)</label>
      <input class="f-inp" id="ttsApiUrl" placeholder="http://127.0.0.1:8081/v1/tts" />
      <label class="f-label">API 키 (로컬 서버는 비워도 됨 · 비우면 기존 키 유지)</label>
      <input class="f-inp" id="ttsApiKey" type="password" placeholder="Fish Audio / OpenAI API Key" />
      <label class="f-label">모델 ID</label>
      <div style="display:flex; gap:6px; align-items:center;">
        <input class="f-inp" id="ttsModel" placeholder="s2-pro" style="flex:1; min-width:0;" />
        <button type="button" class="btn sec" id="ttsLoadModelsBtn" style="flex-shrink:0;">🔄 모델 불러오기</button>
      </div>
      <select class="f-inp" id="ttsModelPick" style="display:none; margin-top:6px;"></select>
      <div class="hint" id="ttsModelStatus" style="margin-top:4px;"></div>
      <label class="f-label">오디오 포맷</label>
      <select class="f-inp" id="ttsFormat">
        <option value="mp3">MP3 (기본 · 가벼움)</option>
        <option value="wav">WAV (무손실)</option>
        <option value="opus">Opus</option>
      </select>
      <datalist id="ttsVoiceDatalist"></datalist>
      <div class="grid-2">
        <div>
          <label class="f-label">화자·속마음·지문 분리 방식</label>
          <select class="f-inp" id="ttsParseMode">
            <option value="hybrid">하이브리드 (LLM 대본분석 + 규칙 폴백)</option>
            <option value="llm">LLM 대본 분석 전용 (다중 화자·성별 정확도)</option>
            <option value="rule">규칙 기반 즉시 파싱 (0초 · 무비용)</option>
          </select>
        </div>
        <div>
          <label class="f-label">대본 분석용 LLM</label>
          <select class="f-inp" id="ttsLlmSource">
            <option value="translator">번역기 모델 공용 (추천 · 저비용)</option>
            <option value="active">메인 활성 프로필 사용</option>
            <option value="aux">보조(Aux) 프로필 사용</option>
          </select>
        </div>
      </div>
      <div id="ttsFishTagRow">
        <label class="f-label">Fish 감정/톤 태그 문법</label>
        <select class="f-inp" id="ttsFishTagStyle">
          <option value="brackets">대괄호 [whispering] (Fish S2 권장)</option>
          <option value="parens">소괄호 (whispering) (Fish S1 구버전)</option>
          <option value="none">태그 삽입 안 함</option>
        </select>
      </div>

      <div class="tts-subbox" id="ttsVoiceProfilesBox">
        <div class="tts-subbox-title">
          <span>📚 보이스 레퍼런스 프로필 관리 (Fish / OpenAI·Qwen)</span>
          <button type="button" class="pill" id="ttsVpFetchBtn">🔄 이 영역 서버에서 불러오기</button>
        </div>
        <div class="tts-vp-tabs">
          <button type="button" class="pill active" data-vp-tab="fish">🐟 Fish 레퍼런스</button>
          <button type="button" class="pill" data-vp-tab="openai_qwen">🎙️ OpenAI / Qwen 레퍼런스</button>
        </div>
        <div id="ttsVpList" class="tts-cast-list" style="margin-top:0;"></div>
        <div id="ttsVpLiveBox" style="display:none; margin-top:6px;">
          <div class="hint" id="ttsVpLiveTitle" style="margin-top:0;">서버에서 불러온 보이스 (클릭해 프로필에 저장)</div>
          <div class="tts-vp-chips" id="ttsVpLiveChips"></div>
        </div>
        <div class="grid-2" style="margin-top:8px;">
          <div><label class="f-label" style="margin-top:0;">프로필 이름 (라벨)</label><input class="f-inp" id="ttsVpLabelInp" placeholder="예: 시은 / 차분한 여성" /></div>
          <div>
            <label class="f-label" style="margin-top:0;">기본 성별</label>
            <select class="f-inp" id="ttsVpGenderSel">
              <option value="female">👩 여성 (♀)</option>
              <option value="male">👨 남성 (♂)</option>
              <option value="neutral">중성/기타</option>
            </select>
          </div>
        </div>
        <label class="f-label" style="margin-top:6px;">Voice / Reference ID</label>
        <div style="display:flex; gap:6px; align-items:center;">
          <input class="f-inp" id="ttsVpIdInp" list="ttsVoiceDatalist" placeholder="Fish reference_id 또는 OpenAI/Qwen voice" style="flex:1; min-width:0;" />
          <button type="button" class="btn sec" id="ttsVpAddBtn" style="flex-shrink:0;">+ 프로필 저장</button>
        </div>
        <div class="hint" id="ttsVpStatus" style="margin-top:5px;">Fish 영역과 OpenAI/Qwen 영역을 나눠 레퍼런스 ID를 미리 저장하면 2단계 드롭다운에서 바로 선택할 수 있습니다.</div>
      </div>

      <div class="tts-subbox">
        <div class="tts-subbox-title"><span>📖 나레이션 (일반 지문) 보이스 · 톤</span></div>
        <label class="f-label" style="margin-top:2px;">Voice / Reference ID (1단계: 엔진 영역 → 2단계: 보이스 ID)</label>
        <div class="tts-voice-tier">
          <select class="f-inp" id="ttsNarVoiceGroupSel" aria-label="나레이션 보이스 영역"></select>
          <select class="f-inp" id="ttsNarVoiceRefSel" aria-label="나레이션 보이스 레퍼런스"></select>
        </div>
        <input class="f-inp" id="ttsNarVoiceId" list="ttsVoiceDatalist" placeholder="비우면 서버 기본 음성 (직접 입력 가능)" style="margin-top:6px;" />
        <div class="grid-2">
          <div>
            <label class="f-label" style="margin-top:4px;">기본 톤 태그</label>
            <select class="f-inp" id="ttsNarToneTagSel" aria-label="나레이션 기본 톤 태그"></select>
            <input class="f-inp" id="ttsNarToneTag" placeholder="직접 톤 태그 입력 (예: calm)" style="margin-top:4px; display:none;" />
          </div>
          <div><label class="f-label" style="margin-top:4px;">속도 (0.5~2.0)</label><input class="f-inp" id="ttsNarSpeed" type="number" step="0.02" min="0.5" max="2.0" /></div>
        </div>
        <label class="f-label" style="margin-top:4px;">톤 지시어 (OpenAI/Qwen3용)</label>
        <input class="f-inp" id="ttsNarInstr" placeholder="차분한 나레이터 톤" />
      </div>

      </div><div class="tts-col">
      <div class="tts-subbox">
        <div class="tts-subbox-title"><span>👥 기본 성별 보이스 풀 (미등록 캐릭터 자동 배정)</span></div>
        <label class="f-label" style="margin-top:2px;">👩 여성 기본 Voice ID (영역 → 레퍼런스)</label>
        <div class="tts-voice-tier">
          <select class="f-inp" id="ttsFemVoiceGroupSel" aria-label="여성 보이스 영역"></select>
          <select class="f-inp" id="ttsFemVoiceRefSel" aria-label="여성 보이스 레퍼런스"></select>
        </div>
        <input class="f-inp" id="ttsFemVoiceId" list="ttsVoiceDatalist" placeholder="Reference ID / Voice (직접 입력 가능)" style="margin-top:6px;" />

        <label class="f-label" style="margin-top:8px;">👨 남성 기본 Voice ID (영역 → 레퍼런스)</label>
        <div class="tts-voice-tier">
          <select class="f-inp" id="ttsMaleVoiceGroupSel" aria-label="남성 보이스 영역"></select>
          <select class="f-inp" id="ttsMaleVoiceRefSel" aria-label="남성 보이스 레퍼런스"></select>
        </div>
        <input class="f-inp" id="ttsMaleVoiceId" list="ttsVoiceDatalist" placeholder="Reference ID / Voice (직접 입력 가능)" style="margin-top:6px;" />

        <label class="f-label" style="margin-top:8px;">중성/기타 기본 Voice ID (영역 → 레퍼런스)</label>
        <div class="tts-voice-tier">
          <select class="f-inp" id="ttsNeuVoiceGroupSel" aria-label="중성 보이스 영역"></select>
          <select class="f-inp" id="ttsNeuVoiceRefSel" aria-label="중성 보이스 레퍼런스"></select>
        </div>
        <input class="f-inp" id="ttsNeuVoiceId" list="ttsVoiceDatalist" placeholder="Reference ID / Voice (직접 입력 가능)" style="margin-top:6px;" />

        <div class="grid-2">
          <div>
            <label class="f-label" style="margin-top:6px;">여성 속마음 톤 태그</label>
            <select class="f-inp" id="ttsFemThoughtTagSel" aria-label="여성 속마음 톤 태그"></select>
            <input class="f-inp" id="ttsFemThoughtTag" placeholder="whispering" style="margin-top:4px; display:none;" />
          </div>
          <div>
            <label class="f-label" style="margin-top:6px;">남성 속마음 톤 태그</label>
            <select class="f-inp" id="ttsMaleThoughtTagSel" aria-label="남성 속마음 톤 태그"></select>
            <input class="f-inp" id="ttsMaleThoughtTag" placeholder="whispering" style="margin-top:4px; display:none;" />
          </div>
        </div>
        <label class="f-label" style="margin-top:6px;">기본 속마음 속도</label>
        <input class="f-inp" id="ttsDefThoughtSpeed" type="number" step="0.02" min="0.5" max="2.0" />
      </div>

      <div class="tts-subbox" id="ttsGlobalCastBox">
        <div class="tts-subbox-title">
          <span>🎭 등장인물별 캐릭터 보이스 설정 (전역 적용)</span>
        </div>
        <div class="hint" style="margin:2px 0 8px;">등장인물 이름(별칭 포함)마다 서로 다른 성별 · Voice ID · 대화/속마음 톤을 등록해 두면 모든 채팅방에서 해당 화자 대사에 자동 적용됩니다.</div>
        <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
          <button type="button" class="pill active" id="ttscAddBtn">+ 캐릭터 추가</button>
          <button type="button" class="pill" id="ttscFetchFishBtn">🐟 Fish 보이스 불러오기</button>
          <button type="button" class="pill" id="ttscFetchOaBtn">🎙️ OpenAI/Qwen 불러오기</button>
        </div>
        <div class="tts-cast-list" id="ttsGlobalCastList" style="margin-top:8px;"></div>
        <div id="ttsGlobalCastEditor"></div>
      </div>

      <div class="tts-subbox">
        <div class="tts-subbox-title"><span>🎧 속마음 · 나레이션 Web Audio 음향 구분</span></div>
        <label class="chk-row" style="margin-top:2px;">
          <span>속마음 전용 음향 효과 (내면 잔향 + 저역통과 필터)</span>
          <input type="checkbox" id="ttsFxEnabledChk" checked />
        </label>
        <div class="grid-2">
          <div><label class="f-label" style="margin-top:4px;">속마음 잔향 강도 (0~1)</label><input class="f-inp" id="ttsFxReverbInp" type="number" step="0.05" min="0" max="1" /></div>
          <div><label class="f-label" style="margin-top:4px;">속마음 필터 Hz (600~12000)</label><input class="f-inp" id="ttsFxFilterInp" type="number" step="100" min="600" max="12000" /></div>
        </div>
        <div class="grid-2">
          <div><label class="f-label" style="margin-top:4px;">속마음 재생 배속</label><input class="f-inp" id="ttsFxThRateInp" type="number" step="0.02" min="0.6" max="1.4" /></div>
          <div><label class="f-label" style="margin-top:4px;">나레이션 재생 배속</label><input class="f-inp" id="ttsFxNarRateInp" type="number" step="0.02" min="0.6" max="1.4" /></div>
        </div>
      </div>

      <div class="tts-subbox" id="ttsTestBox">
        <div class="tts-subbox-title">
          <span>🧪 TTS 연결 · 음성 테스트</span>
          <div style="display:flex; gap:4px; flex-wrap:wrap;">
            <button type="button" class="pill" data-tts-sample="dialogue">💬 대화</button>
            <button type="button" class="pill" data-tts-sample="thought">💭 속마음</button>
            <button type="button" class="pill" data-tts-sample="narration">📖 나레이션</button>
          </div>
        </div>
        <label class="f-label" style="margin-top:2px;">예시 텍스트 (직접 수정 가능)</label>
        <textarea class="f-inp" id="ttsTestTextInp" rows="2">안녕하세요. 지금 들리는 목소리와 톤이 자연스러운가요?</textarea>
        <div class="grid-2">
          <div>
            <label class="f-label" style="margin-top:4px;">발화 유형</label>
            <select class="f-inp" id="ttsTestKindSel">
              <option value="dialogue">💬 대화 (Dialogue)</option>
              <option value="thought">💭 속마음 (Inner Thought)</option>
              <option value="narration">📖 나레이션 (Narration)</option>
            </select>
          </div>
          <div>
            <label class="f-label" style="margin-top:4px;">테스트 성별</label>
            <select class="f-inp" id="ttsTestGenderSel">
              <option value="female">👩 여성 (♀)</option>
              <option value="male">👨 남성 (♂)</option>
              <option value="neutral">중성/기타</option>
            </select>
          </div>
        </div>
        <label class="f-label" style="margin-top:4px;">테스트 Voice / Reference ID (선택 · 1단계 영역 → 2단계 ID)</label>
        <div class="tts-voice-tier">
          <select class="f-inp" id="ttsTestVoiceGroupSel" aria-label="테스트 보이스 영역"></select>
          <select class="f-inp" id="ttsTestVoiceRefSel" aria-label="테스트 보이스 레퍼런스"></select>
        </div>
        <input class="f-inp" id="ttsTestVoiceInp" list="ttsVoiceDatalist" placeholder="비우면 위 기본 성별/나레이션 보이스 사용 (직접 입력 가능)" style="margin-top:6px;" />
        <div class="btn-row" style="margin-top:8px;">
          <button type="button" class="btn sec" id="testTtsBtn">🔊 연결 테스트 실행</button>
        </div>
        <div class="hint" id="ttsTestStatus" style="margin-top:6px;">예시 텍스트를 입력하고 버튼을 누르면 현재 설정(저장 전 포함)으로 바로 음성을 생성해 재생합니다.</div>
        <audio id="ttsTestAudio" controls style="display:none; width:100%; margin-top:6px; height:36px;"></audio>
      </div>

      </div></div>
      <div class="btn-row">
        <button type="button" class="btn" id="saveTtsBtn">💾 TTS 설정 저장</button>
      </div>
    </div>

    <div class="card">
      <h3>🌐 자체 번역기 설정</h3>
      <label class="chk-row"><span>활성 모델 프로필을 번역에도 공용 사용</span><input type="checkbox" id="trUseActive" /></label>
      <label class="chk-row"><span>AI 응답 자동 한국어 번역 표시</span><input type="checkbox" id="trAutoOut" /></label>
      <label class="chk-row"><span>내 입력 자동 한→영 번역 후 전송</span><input type="checkbox" id="trAutoIn" /></label>
      <div id="trCustomBox">
        <label class="f-label">전용 번역 제공사 (선택 시 엔드포인트 자동 입력)</label>
        <select class="f-inp" id="trProvider"></select>
        <label class="f-label">전용 번역 프로바이더 포맷</label>
        <select class="f-inp" id="trType">
          <option value="gemini">Google Gemini (추천: gemini-2.5-flash)</option>
          <option value="openai_compat">OpenAI 호환 (OpenRouter / Ollama Cloud 등)</option>
          <option value="anthropic">Anthropic Claude</option>
        </select>
        <label class="f-label">전용 번역 엔드포인트</label>
        <input class="f-inp" id="trUrl" />
        <label class="f-label">전용 번역 API 키 (비우면 기존 유지)</label>
        <input class="f-inp" id="trKey" type="password" placeholder="API 키" />
        <label class="f-label">전용 번역 모델 ID</label>
        <div style="display:flex; gap:6px; align-items:center;">
          <input class="f-inp" id="trModel" style="flex:1; min-width:0;" />
          <button type="button" class="btn sec" id="trLoadModelsBtn" style="flex-shrink:0;">🔄 모델 불러오기</button>
        </div>
        <select class="f-inp" id="trModelPick" style="display:none; margin-top:6px;"></select>
        <div class="hint" id="trModelStatus" style="margin-top:4px;"></div>
      </div>
      <label class="f-label">응답 번역 프롬프트</label>
      <textarea class="f-inp" id="trPrompt" rows="2"></textarea>
      <div class="btn-row"><button class="btn" id="saveTrBtn">번역 설정 저장</button></div>
    </div>

    <div class="card" id="reqLogCard">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
        <h3 style="margin:0;">📜 리퀘스트 로그</h3>
        <div style="display:flex; gap:6px; align-items:center;">
          <button type="button" class="pill" id="reqLogRefreshBtn">🔄 새로고침</button>
          <button type="button" class="pill" id="reqLogClearBtn" style="color:var(--danger);">🗑️ 비우기</button>
        </div>
      </div>
      <div class="hint" style="margin-bottom:8px;">
        PC RisuAI 프록시(<code>/v1/chat/completions</code>), 원격 프롬프트 채팅/리롤, 번역기에서 나간 최근 40건의 요청·응답 로그를 서버 메모리에 보관합니다. 원격 프롬프트(Leave 등)로 요청된 응답도 메인 서사로 자동 인식해 프롬프트 캐싱 깨짐 여부를 실시간 감시하며, 하야쿠·플래시백·보조 호출은 자동 제외됩니다.
      </div>
      <div id="reqLogCgSummary" class="cg-summary-bar" style="display:none;"></div>
      <div class="req-log-filters" id="reqLogFilters">
        <button type="button" class="pill active" data-log-filter="all">전체</button>
        <button type="button" class="pill" data-log-filter="proxy">프록시</button>
        <button type="button" class="pill" data-log-filter="direct">원격 채팅/리롤</button>
        <button type="button" class="pill" data-log-filter="translate">번역</button>
        <button type="button" class="pill" data-log-filter="narrative">🛡️ 서사 감시</button>
        <button type="button" class="pill" data-log-filter="broken">⚠️ 캐시 깨짐</button>
        <button type="button" class="pill" id="reqLogGroupToggle">📂 그룹별 보기</button>
      </div>
      <div id="reqLogList" class="req-log-list"><div style="font-size:12.5px; color:var(--sub);">아직 기록된 요청이 없습니다.</div></div>
    </div>
  </section>

  <nav class="tabbar">
    <div class="nav-logo" title="RisuStand">${RS_MARK_SVG}</div>
    <button class="tab-btn active" data-tab="home" onclick="switchTab('home')"><span class="ic">🏠</span>홈</button>
    <button class="tab-btn" data-tab="chat" onclick="switchTab('chat')"><span class="ic">📖</span>독서/채팅</button>
    <button class="tab-btn" data-tab="modules" onclick="switchTab('modules')"><span class="ic">🧩<span class="nd"></span></span>모듈/설정</button>
    <button class="tab-btn" data-tab="router" onclick="switchTab('router')"><span class="ic">⚡</span>모델/번역</button>
  </nav>
</div>

<script>
  const AI_PROVIDERS = ${JSON.stringify(Object.values(AI_PROVIDER_PRESETS)).replace(/<\//g, '<\\/')};
  let token = localStorage.getItem('rs_token') || '';
  let currentTab = 'home';
  let lastState = null;
  let routerCfg = null;
  let expandedBotIdx = -1;
  let lastChatRenderSig = '';
  let lastHomeRenderSig = '';
  let lastHdrAvatarSig = '';
  let lastBotsRenderSig = '';
  let lastBotsSyncAt = 0;
  let lastModulesRenderSig = '';
  let lastChatVarsRenderSig = '';
  let lastBgHtmlSig = '';
  let lastHandledTriggerEventId = '';
  let botMenuExpanded = false;
  let botMenuAutoTimer = null;
  let lastDirectErrAt = 0;
  let localRequestPending = false;
  let localRequestTimer = null;
  let pollTimer = null;
  let isStatePolling = false;
  let knownCatalogVer = -1;
  let knownSnapshotVer = -1;
  let bookSpreadIdx = -1; // -1 means auto-jump to latest spread
  let bookDesiredSpreadIdx = -1;
  let bookAnchorMode = 'last-user'; // 'last-user' | 'manual'
  let pendingReplyTarget = null;
  let pendingScrollToLastUser = false;
  let bookSpreadStride = 1;
  let bookColStep = 1;
  let bookColOffsets = [];
  let bookScrollGuardLock = false;
  let bookTotalSpreads = 1;
  let bookTotalPages = 1;
  let bookSinglePage = false;
  let bookFlipMidTimer = null;
  let bookFlipEndTimer = null;
  let bookWheelLock = false;
  let bookResizeTimer = null;
  const localTranslations = new Map();
  const shownTranslations = new Set();

  // RisuStand Reading Preferences
  let uiPref = {
    theme: localStorage.getItem('rs_theme') || 'ai-gemini',
    font: localStorage.getItem('rs_font') || 'serif',
    fsize: Number(localStorage.getItem('rs_fsize')) || 15.5,
    lh: Number(localStorage.getItem('rs_lh')) || 1.75,
    assetMode: localStorage.getItem('rs_asset_mode') || (localStorage.getItem('rs_stealth') === '1' ? 'hide' : 'show'),
    richHtml: localStorage.getItem('rs_rich_html') !== '0',
    zenMode: localStorage.getItem('rs_zen_mode') === '1',
  };
  const openToggleGroups = new Set();
  let latestPluginFloatingUi = { rev: '', buttons: [], rootWidgets: [] };
  let lastFloatingModalSig = '';
  // ===== RisuStand Floating Mini-Bar state (initialized before initial applyUiPrefs()) =====
  let rsMiniBarMinimized = localStorage.getItem('rs_minibar_min') !== '0';
  let rsMiniBarAutoTimer = null;
  let rsMiniBarDrag = null;
  let lastRsMiniBarSig = '';

  function isBookMode() {
    return uiPref.theme === 'epub-2p-day' || uiPref.theme === 'epub-2p-night';
  }

  function applyUiPrefs() {
    document.documentElement.setAttribute('data-theme', uiPref.theme);
    document.documentElement.setAttribute('data-font', uiPref.font);
    document.documentElement.style.setProperty('--fsize', uiPref.fsize + 'px');
    document.documentElement.style.setProperty('--lh', String(uiPref.lh));
    document.body.classList.toggle('asset-blur', uiPref.assetMode === 'blur');
    document.body.classList.toggle('asset-hide', uiPref.assetMode === 'hide');
    document.body.classList.toggle('rs-zen-mode', Boolean(uiPref.zenMode));
    document.querySelectorAll('.theme-chip').forEach((c) => c.classList.toggle('active', c.getAttribute('data-theme-key') === uiPref.theme));
    document.body.classList.toggle('book-mode', isBookMode());
    const bgCol = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bgCol) document.getElementById('themeColorMeta').setAttribute('content', bgCol);
    document.getElementById('fontSel').value = uiPref.font;
    document.getElementById('fsVal').textContent = uiPref.fsize.toFixed(1);
    document.getElementById('lhBtn').textContent = '줄간격 ' + uiPref.lh.toFixed(2);
    const amIcons = { show: '🖼️', blur: '🌫️', hide: '🙈' };
    const acb = document.getElementById('assetCycleBtn');
    acb.textContent = amIcons[uiPref.assetMode] || '🖼️';
    acb.className = 'pill icon-pill' + (uiPref.assetMode !== 'show' ? ' active' : '');
    document.getElementById('amShow').className = 'pill' + (uiPref.assetMode === 'show' ? ' active' : '');
    document.getElementById('amBlur').className = 'pill' + (uiPref.assetMode === 'blur' ? ' active' : '');
    document.getElementById('amHide').className = 'pill' + (uiPref.assetMode === 'hide' ? ' active' : '');
    const rhb = document.getElementById('richHtmlBtn');
    if (rhb) {
      rhb.textContent = '✨ 봇 정규식 UI: ' + (uiPref.richHtml ? '켜짐' : '꺼짐');
      rhb.className = 'pill' + (uiPref.richHtml ? ' active' : '');
    }
    const zmb = document.getElementById('zenModeBtn');
    if (zmb) {
      zmb.className = 'pill icon-pill' + (uiPref.zenMode ? ' active' : '');
      zmb.setAttribute('aria-pressed', uiPref.zenMode ? 'true' : 'false');
    }
    localStorage.setItem('rs_theme', uiPref.theme);
    localStorage.setItem('rs_font', uiPref.font);
    localStorage.setItem('rs_fsize', String(uiPref.fsize));
    localStorage.setItem('rs_lh', String(uiPref.lh));
    localStorage.setItem('rs_asset_mode', uiPref.assetMode);
    localStorage.setItem('rs_rich_html', uiPref.richHtml ? '1' : '0');
    localStorage.setItem('rs_zen_mode', uiPref.zenMode ? '1' : '0');
    if (typeof renderRsMiniBar === 'function') renderRsMiniBar();
  }
  function setZenMode(nextZen) {
    uiPref.zenMode = Boolean(nextZen);
    if (typeof setReadBar === 'function') setReadBar(false);
    if (uiPref.zenMode) {
      rsMiniBarMinimized = false;
      try { localStorage.setItem('rs_minibar_min', '0'); } catch (_) {}
      applyUiPrefs();
      if (typeof scheduleRsMiniBarAutoMin === 'function') scheduleRsMiniBarAutoMin();
      toast('집중 모드 켜짐 (플로팅 미니바로 제어·해제)');
    } else {
      if (typeof clearRsMiniBarTimer === 'function') clearRsMiniBarTimer();
      applyUiPrefs();
      toast('집중 모드 꺼짐');
    }
    if (isBookMode() && typeof layoutBookSpreads === 'function') {
      requestAnimationFrame(() => layoutBookSpreads(false));
    }
  }
  const zenModeBtn = document.getElementById('zenModeBtn');
  if (zenModeBtn) {
    zenModeBtn.onclick = () => setZenMode(!uiPref.zenMode);
  }
  document.getElementById('richHtmlBtn').onclick = () => {
    uiPref.richHtml = !uiPref.richHtml;
    lastChatRenderSig = '';
    lastBotOverlaySig = '';
    applyUiPrefs();
    if (lastState) applyState(lastState);
    else renderChat();
    toast('봇 정규식 UI: ' + (uiPref.richHtml ? '켜짐' : '꺼짐'));
  };
  window.toggleImgReveal = (el) => { if (el) el.classList.toggle('revealed'); };
  window.setAssetMode = (mode) => {
    uiPref.assetMode = mode;
    applyUiPrefs();
    if (lastState) applyState(lastState);
    if (typeof isPluginFloatingModalOpen === 'function' && isPluginFloatingModalOpen()) renderPluginFloatingModal(true);
    const scm = document.getElementById('sceneCtrlModal');
    if (scm && scm.style.display === 'flex' && typeof openSceneCtrlModal === 'function') {
      openSceneCtrlModal();
    }
    const labels = { show: '에셋 표시', blur: '에셋 가리기 (터치 시 확인)', hide: '에셋 완전 감추기 (스텔스)' };
    toast(labels[mode] || mode);
  };
  document.getElementById('assetCycleBtn').onclick = () => {
    const order = ['show', 'blur', 'hide'];
    const next = order[(order.indexOf(uiPref.assetMode) + 1) % order.length];
    window.setAssetMode(next);
  };

  function setReadBar(open) {
    const bar = document.getElementById('readBar');
    bar.classList.toggle('open', open);
    const btn = document.getElementById('readBarToggle');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.classList.toggle('active', open);
  }
  document.getElementById('readBarToggle').onclick = (e) => {
    e.stopPropagation();
    setReadBar(!document.getElementById('readBar').classList.contains('open'));
  };
  document.addEventListener('click', (e) => {
    const bar = document.getElementById('readBar');
    if (bar.classList.contains('open') && !bar.contains(e.target)) setReadBar(false);
    const jBar = document.getElementById('bookJumpBar');
    const jBtn = document.getElementById('bookPageJumpBtn');
    if (jBar && jBar.style.display !== 'none' && !jBar.contains(e.target) && (!jBtn || !jBtn.contains(e.target))) {
      jBar.style.display = 'none';
    }
    const tgBody = document.getElementById('customToggleBody');
    if (openToggleGroups.size > 0 && tgBody && !tgBody.contains(e.target)) {
      openToggleGroups.clear();
      tgBody.querySelectorAll('.tg-acc.open').forEach((acc) => {
        acc.classList.remove('open');
        const arrow = acc.querySelector('.tg-acc-head span:last-child');
        if (arrow) arrow.textContent = '▸';
      });
      lastToggleRenderSig = '';
    }
    if (botMenuExpanded) {
      const fab = document.getElementById('botMenuFab');
      const ov = document.getElementById('bookBotOverlay');
      const insideFab = fab && fab.contains(e.target);
      const insideOv = ov && ov.contains(e.target);
      const hasOpenPanel = ov && ov.querySelector('input[type="checkbox"]:checked');
      if (!insideFab && !insideOv && !hasOpenPanel) {
        botMenuExpanded = false;
        syncBotMenuVisibility();
      }
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      setReadBar(false);
      closeBookImgPreview(true);
      if (typeof closeReqLogModal === 'function') closeReqLogModal();
      if (typeof closeThumbPickerModal === 'function') closeThumbPickerModal();
      const jBar = document.getElementById('bookJumpBar');
      if (jBar) jBar.style.display = 'none';
    }
  });
  document.querySelectorAll('.theme-chip').forEach((chip) => {
    chip.onclick = () => setTheme(chip.getAttribute('data-theme-key'));
  });
  function setTheme(key) {
    uiPref.theme = key;
    if (uiPref.theme.startsWith('epub')) uiPref.font = 'serif';
    else if (uiPref.theme.startsWith('ai-')) uiPref.font = 'system';
    bookAnchorMode = 'last-user';
    bookSpreadIdx = -1;
    bookDesiredSpreadIdx = -1;
    pendingReplyTarget = null;
    lastChatRenderSig = '';
    applyUiPrefs();
    if (lastState) applyState(lastState);
    else renderChat();
  }
  document.getElementById('fontSel').onchange = (e) => { uiPref.font = e.target.value; applyUiPrefs(); if (isBookMode()) requestAnimationFrame(() => layoutBookSpreads(false)); };
  document.getElementById('fsDec').onclick = () => { uiPref.fsize = Math.max(12, uiPref.fsize - 0.5); applyUiPrefs(); if (isBookMode()) requestAnimationFrame(() => layoutBookSpreads(false)); };
  document.getElementById('fsInc').onclick = () => { uiPref.fsize = Math.min(24, uiPref.fsize + 0.5); applyUiPrefs(); if (isBookMode()) requestAnimationFrame(() => layoutBookSpreads(false)); };
  document.getElementById('lhBtn').onclick = () => {
    const steps = [1.55, 1.75, 1.95, 2.1];
    const idx = steps.findIndex((v) => Math.abs(v - uiPref.lh) < 0.05);
    uiPref.lh = steps[(idx + 1) % steps.length];
    applyUiPrefs();
    if (isBookMode()) requestAnimationFrame(() => layoutBookSpreads(false));
  };

  window.addEventListener('resize', () => {
    if (!isBookMode()) return;
    if (bookResizeTimer) clearTimeout(bookResizeTimer);
    bookResizeTimer = setTimeout(() => layoutBookSpreads(false), 100);
  });
  document.addEventListener('keydown', (e) => {
    if (currentTab !== 'chat' || !isBookMode()) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'ArrowRight') flipBook(1);
    else if (e.key === 'ArrowLeft') flipBook(-1);
  });
  applyUiPrefs();

  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(window._tt);
    window._tt = setTimeout(() => { el.classList.remove('show'); }, 2400);
  }

  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  function safeImgSrc(u) {
    const raw = String(u || '').trim();
    if (/^(?:data:image\\/[a-z0-9.+-]+;base64,|https?:\\/\\/|\\/api\\/asset\\/[a-f0-9]{16,64}$)/i.test(raw)) return raw;
    return '';
  }

  function stripImgTokens(t) {
    return String(t || '').replace(/\\[\\[RSIMG:\\d+\\]\\]/g, '').replace(/\\n{3,}/g, '\\n\\n').trim();
  }

  function resolveAssetTokens(str, assetMap) {
    const map = assetMap || {};
    return String(str || '').replace(/\\[\\[RSASSET:([a-zA-Z0-9_-]+)\\]\\]/g, (_, id) => {
      return map[id] ? safeImgSrc(map[id]) : '';
    });
  }

  function sanitizeBotCss(css) {
    return String(css || '')
      .replace(/expression\\s*\\(/gi, 'blocked(')
      .replace(/javascript\\s*:/gi, 'blocked:')
      .replace(/vbscript\\s*:/gi, 'blocked:')
      .replace(/-moz-binding\\s*:/gi, 'blocked:')
      .replace(/@import\\s+(?!url\\(\\s*["']?https:\\/\\/)/gi, '/* @import */ ');
  }

  function splitCssSelectors(selText) {
    const out = [];
    let start = 0;
    let pDepth = 0;
    let bDepth = 0;
    let quote = '';
    for (let i = 0; i < selText.length; i++) {
      const c = selText[i];
      if (quote) {
        if (c === '\\\\') { i++; continue; }
        if (c === quote) quote = '';
        continue;
      }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '(') pDepth++;
      else if (c === ')' && pDepth > 0) pDepth--;
      else if (c === '[') bDepth++;
      else if (c === ']' && bDepth > 0) bDepth--;
      else if (c === ',' && pDepth === 0 && bDepth === 0) {
        out.push(selText.slice(start, i));
        start = i + 1;
      }
    }
    out.push(selText.slice(start));
    return out;
  }

  const UNSAFE_ROOT_CSS_PROPS = new Set([
    'position', 'inset', 'top', 'right', 'bottom', 'left', 'z-index',
    'display', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
    'overflow', 'overflow-x', 'overflow-y', 'visibility', 'pointer-events',
    'contain', 'isolation', 'transform'
  ]);

  function stripUnsafeRootDecls(declBody) {
    const parts = [];
    let start = 0;
    let pDepth = 0;
    let quote = '';
    const text = String(declBody || '');
    for (let i = 0; i <= text.length; i++) {
      const c = i < text.length ? text[i] : ';';
      if (i < text.length) {
        if (quote) {
          if (c === '\\\\') { i++; continue; }
          if (c === quote) quote = '';
          continue;
        }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === '(') { pDepth++; continue; }
        if (c === ')' && pDepth > 0) { pDepth--; continue; }
        if (c !== ';' || pDepth > 0) continue;
      }
      const decl = text.slice(start, i).trim();
      start = i + 1;
      if (!decl) continue;
      const colon = decl.indexOf(':');
      if (colon <= 0) { parts.push(decl); continue; }
      const prop = decl.slice(0, colon).trim().toLowerCase();
      if (prop.startsWith('--') || !UNSAFE_ROOT_CSS_PROPS.has(prop)) {
        parts.push(decl);
      }
    }
    return parts.join('; ');
  }

  function scopeBotCss(css, scopeSel = '.rs-bot-html') {
    const clean = String(css || '').replace(/\\/\\*[\\s\\S]*?\\*\\//g, '');
    let out = '';
    let start = 0;
    let quote = '';
    for (let i = 0; i < clean.length; i++) {
      const c = clean[i];
      if (quote) {
        if (c === '\\\\') { i++; continue; }
        if (c === quote) quote = '';
        continue;
      }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === ';') {
        const stmt = clean.slice(start, i + 1).trim();
        if (stmt) out += stmt + '\\n';
        start = i + 1;
        continue;
      }
      if (c === '{') {
        const header = clean.slice(start, i).trim();
        let depth = 1;
        let q2 = '';
        let j = i + 1;
        for (; j < clean.length && depth > 0; j++) {
          const ch = clean[j];
          if (q2) {
            if (ch === '\\\\') { j++; continue; }
            if (ch === q2) q2 = '';
            continue;
          }
          if (ch === '"' || ch === "'") { q2 = ch; continue; }
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
        const body = clean.slice(i + 1, Math.max(i + 1, j - 1));
        i = j - 1;
        start = j;
        if (!header) continue;
        if (/^@(?:keyframes|-webkit-keyframes|font-face|property|counter-style|page)\\b/i.test(header)) {
          out += header + '{' + body + '}\\n';
        } else if (/^@(?:media|supports|layer|container|document)\\b/i.test(header)) {
          out += header + '{\\n' + scopeBotCss(body, scopeSel) + '}\\n';
        } else if (header.startsWith('@')) {
          out += header + '{' + body + '}\\n';
        } else {
          const bareRootSels = [];
          const bareDocSels = [];
          const normalSels = [];
          for (const rawSel of splitCssSelectors(header)) {
            const s = rawSel.trim();
            if (!s) continue;
            if (s.indexOf(scopeSel) === 0 || s.indexOf('#botBgHost') === 0 || s.indexOf('#bookBotOverlay') === 0) {
              normalSels.push(s);
            } else if (/^:root(?=[.#:\\[]|$)/i.test(s)) {
              bareRootSels.push(s.replace(/^:root/i, scopeSel));
            } else if (/^(?:html(?:\\s*>?\\s*body)?|body)(?=[.#:\\[]|$)/i.test(s)) {
              bareDocSels.push(s.replace(/^(?:html(?:\\s*>?\\s*body)?|body)/i, '#botBgHost'));
            } else if (/^(?:html|body|:root)(?=[\\s.:#[>+~]|$)/i.test(s)) {
              normalSels.push(s.replace(/^(?:html|body|:root)/i, scopeSel));
            } else {
              normalSels.push(scopeSel + ' ' + s);
            }
          }
          if (bareRootSels.length) {
            const safeBody = stripUnsafeRootDecls(body);
            if (safeBody) out += bareRootSels.join(', ') + '{' + safeBody + '}\\n';
          }
          if (bareDocSels.length) {
            const safeBody = stripUnsafeRootDecls(body);
            if (safeBody) out += bareDocSels.join(', ') + '{' + safeBody + '}\\n';
          }
          if (normalSels.length) {
            out += normalSels.join(', ') + '{' + body + '}\\n';
          }
        }
      }
    }
    return out;
  }

  function sanitizeBotNode(node, scopeSel = '.rs-bot-html', allowForms = false) {
    const kids = Array.from(node.childNodes || []);
    for (const ch of kids) {
      if (ch.nodeType === 8) {
        node.removeChild(ch);
        continue;
      }
      if (ch.nodeType !== 1) continue;
      const tag = (ch.tagName || '').toLowerCase();
      if (tag === 'script' || tag === 'iframe' || tag === 'object' || tag === 'embed' || tag === 'applet' || tag === 'base' || tag === 'meta' || tag === 'link' || (tag === 'form' && !allowForms && !ch.hasAttribute('risu-form'))) {
        node.removeChild(ch);
        continue;
      }
      if (tag === 'form') {
        ch.removeAttribute('action');
        ch.removeAttribute('method');
        ch.removeAttribute('target');
        ch.removeAttribute('enctype');
      }
      if (tag === 'style') {
        ch.textContent = scopeBotCss(sanitizeBotCss(ch.textContent || ''), scopeSel);
        continue;
      }
      const attrs = Array.from(ch.attributes || []);
      for (const a of attrs) {
        const name = a.name.toLowerCase();
        const val = String(a.value || '').trim();
        if (name.startsWith('on')) {
          ch.removeAttribute(a.name);
          continue;
        }
        if ((name === 'src' || name === 'href' || name === 'xlink:href' || name === 'poster' || name === 'background' || name === 'formaction') && /^(?:javascript|vbscript):/i.test(val)) {
          ch.removeAttribute(a.name);
          continue;
        }
        if (name === 'src' && tag === 'img' && val && !safeImgSrc(val)) {
          ch.removeAttribute('src');
          continue;
        }
        if (name === 'style') {
          ch.setAttribute('style', sanitizeBotCss(val));
        }
      }
      if (tag === 'img') {
        if (!ch.getAttribute('loading')) ch.setAttribute('loading', 'lazy');
        if (!ch.getAttribute('decoding')) ch.setAttribute('decoding', 'async');
      }
      sanitizeBotNode(ch, scopeSel, allowForms);
    }
  }

  function sanitizePluginWidgetHtml(rawHtml, scopeSel, assetMap) {
    const withAssets = resolveAssetTokens(rawHtml || '', assetMap);
    if (!withAssets) return '';
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString('<div id="__rs_root">' + withAssets + '</div>', 'text/html');
      const root = doc.getElementById('__rs_root');
      if (!root) return esc(withAssets);
      sanitizeBotNode(root, scopeSel, true);
      return root.innerHTML;
    } catch (_) {
      return esc(withAssets);
    }
  }

  function renderBotRichHtml(rawHtml, assetMap) {
    const withAssets = resolveAssetTokens(rawHtml || '', assetMap);
    if (!withAssets) return '';
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString('<div id="__rs_root">' + withAssets + '</div>', 'text/html');
      const root = doc.getElementById('__rs_root');
      if (!root) return esc(withAssets);
      sanitizeBotNode(root);
      for (const ch of Array.from(root.childNodes)) {
        if (ch.nodeType === 3) {
          const collapsed = (ch.textContent || '')
            .replace(/(?:[ \\t]*\\r?\\n){3,}/g, '\\n\\n')
            .replace(/^(?:[ \\t]*\\r?\\n){2,}/, '\\n')
            .replace(/(?:\\r?\\n[ \\t]*){2,}$/, '\\n');
          if (/\\S/.test(collapsed)) {
            const sp = doc.createElement('span');
            sp.className = 'rs-prose-seg';
            sp.textContent = collapsed;
            root.replaceChild(sp, ch);
          } else {
            root.removeChild(ch);
          }
        }
      }
      return root.innerHTML;
    } catch (_) {
      return esc(withAssets);
    }
  }

  const BOT_FIXED_CLASS_SEL = '[class*="buttons-container" i], [class*="side-panel" i], [class*="overlay" i], [class*="floating" i]';

  function isBotFixedMenuElement(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (!['div', 'nav', 'aside', 'section'].includes(tag)) return false;
    const cls = typeof el.className === 'string' ? el.className : '';
    if (/(?:buttons-container|side-panel|overlay|floating)/i.test(cls)) return true;
    const stAttr = el.getAttribute('style') || '';
    return /position\\s*:\\s*fixed/i.test(stAttr);
  }

  function stripBotFixedMenuNodes(container) {
    if (!container) return;
    container.querySelectorAll('input[type="checkbox"], input[type="radio"], ' + BOT_FIXED_CLASS_SEL).forEach((n) => n.remove());
    container.querySelectorAll('div[style], nav[style], aside[style], section[style]').forEach((n) => {
      if (/position\\s*:\\s*fixed/i.test(n.getAttribute('style') || '')) n.remove();
    });
    container.querySelectorAll('style').forEach((st) => {
      if (/position\\s*:\\s*fixed/i.test(st.textContent || '')) st.remove();
    });
  }

  function containerHasBotFixedMenu(container) {
    if (!container) return false;
    let hasFixed = false;
    container.querySelectorAll('style').forEach((st) => {
      if (/position\\s*:\\s*fixed/i.test(st.textContent || '')) hasFixed = true;
    });
    if (!hasFixed && container.querySelector(BOT_FIXED_CLASS_SEL)) {
      hasFixed = true;
    }
    if (!hasFixed) {
      for (const ch of Array.from(container.children || [])) {
        if (isBotFixedMenuElement(ch)) {
          hasFixed = true;
          break;
        }
      }
    }
    return hasFixed;
  }

  function syncBotBackground(bgHtml, assetMap) {
    const host = document.getElementById('botBgHost');
    if (!host) return;
    const raw = uiPref.richHtml ? String(bgHtml || '') : '';
    const sig = raw ? (hashStr(raw) + ':' + Object.keys(assetMap || {}).length) : '';
    if (sig !== lastBgHtmlSig) {
      lastBgHtmlSig = sig;
      host.innerHTML = raw ? renderBotRichHtml(raw, assetMap) : '';
    }
    stripBotFixedMenuNodes(host);
  }

  let activeModalKeyHandler = null;
  function closeTriggerModal() {
    if (activeModalKeyHandler) {
      document.removeEventListener('keydown', activeModalKeyHandler);
      activeModalKeyHandler = null;
    }
    const m = document.getElementById('triggerModal');
    if (m) {
      m.style.display = 'none';
      m.innerHTML = '';
    }
  }

  function showTriggerModal(ev) {
    const modal = document.getElementById('triggerModal');
    if (!modal || !ev) return;

    if (ev.kind === 'notice' || ev.kind === 'alert_error') {
      const queue = Array.isArray(ev.notices) && ev.notices.length
        ? ev.notices
        : [{ title: ev.title || '', message: ev.message || '', isError: ev.kind === 'alert_error' }];
      let idx = 0;

      const advance = () => {
        idx += 1;
        if (idx < queue.length) {
          renderNotice();
          return;
        }
        closeTriggerModal();
        if (ev.source === 'pc_alert') {
          api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'dismiss_pc_alert' }) }).catch(() => {});
        }
      };

      const renderNotice = () => {
        const item = queue[idx] || {};
        const title = item.title || (item.isError ? 'Error' : '');
        modal.innerHTML =
          '<div class="trig-card trig-alert-card">' +
            (title ? '<h2 class="trig-title' + (item.isError ? ' err' : '') + '">' + esc(title) + '</h2>' : '') +
            '<div class="trig-msg">' + esc(item.message || '') + '</div>' +
            '<button class="btn sec trig-ok-btn" id="trigAlertOkBtn">OK</button>' +
          '</div>';
        modal.style.display = 'flex';
        const okBtn = document.getElementById('trigAlertOkBtn');
        if (okBtn) {
          okBtn.onclick = advance;
          setTimeout(() => { try { okBtn.focus(); } catch (_) {} }, 20);
        }
        modal.onclick = (e) => { if (e.target === modal) advance(); };
      };

      if (activeModalKeyHandler) document.removeEventListener('keydown', activeModalKeyHandler);
      activeModalKeyHandler = (e) => {
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault();
          advance();
        }
      };
      document.addEventListener('keydown', activeModalKeyHandler);
      renderNotice();
      return;
    }

    const baseAnswers = Array.isArray(ev.answersSoFar) ? ev.answersSoFar.slice() : [];
    const sendAnswer = async (ans) => {
      closeTriggerModal();
      try {
        const res = await api('/api/triggers/run', {
          method: 'POST',
          body: JSON.stringify({
            charIndex: ev.charIndex,
            chatIndex: ev.chatIndex,
            trigger: ev.trigger,
            promptAnswers: baseAnswers.concat([String(ans)]),
          }),
        });
        toast('적용 중...');
        if (res && res.pause) { showTriggerModal(res.pause); return; }
        if (res && res.triggerEvent && res.triggerEvent.id && res.triggerEvent.id !== lastHandledTriggerEventId) {
          lastHandledTriggerEventId = res.triggerEvent.id;
          if (res.triggerEvent.kind === 'notice' || res.triggerEvent.kind === 'alert_error') showTriggerModal(res.triggerEvent);
        }
        if (res && res.snapshot && lastState) {
          if (typeof res.snapshotVersion === 'number') knownSnapshotVer = res.snapshotVersion;
          applyState({ ...lastState, snapshot: res.snapshot, snapshotVersion: res.snapshotVersion ?? lastState.snapshotVersion });
        } else {
          setTimeout(pollState, 220);
        }
      } catch (err) {
        toast('적용 오류: ' + (err && err.message ? err.message : '실패'));
      }
    };

    if (ev.kind === 'prompt_select') {
      const opts = Array.isArray(ev.options) ? ev.options : [];
      modal.innerHTML =
        '<div class="trig-card">' +
          '<div class="trig-msg">' + esc(ev.message || '선택하세요') + '</div>' +
          '<div class="trig-opts">' +
            opts.map((opt, idx) => '<button class="btn sec trig-opt-btn" data-trig-opt="' + idx + '">' + esc(opt) + '</button>').join('') +
          '</div>' +
          '<div class="btn-row" style="margin-top:4px;"><button class="btn danger" id="trigCancelBtn" style="margin-left:auto;">취소</button></div>' +
        '</div>';
      modal.style.display = 'flex';
      modal.querySelectorAll('[data-trig-opt]').forEach((b) => {
        b.onclick = () => sendAnswer(b.getAttribute('data-trig-opt'));
      });
      document.getElementById('trigCancelBtn').onclick = closeTriggerModal;
      modal.onclick = (e) => { if (e.target === modal) closeTriggerModal(); };
      return;
    }

    if (ev.kind === 'prompt_input') {
      modal.innerHTML =
        '<div class="trig-card">' +
          '<div class="trig-msg">' + esc(ev.message || '값을 입력하세요') + '</div>' +
          '<input class="f-inp" id="trigPromptInp" placeholder="입력..." />' +
          '<div class="btn-row">' +
            '<button class="btn" id="trigOkBtn">확인</button>' +
            '<button class="btn sec" id="trigCancelBtn">취소</button>' +
          '</div>' +
        '</div>';
      modal.style.display = 'flex';
      const inp = document.getElementById('trigPromptInp');
      setTimeout(() => { try { inp.focus(); } catch (_) {} }, 30);
      document.getElementById('trigOkBtn').onclick = () => sendAnswer(inp.value);
      inp.onkeydown = (e) => { if (e.key === 'Enter') sendAnswer(inp.value); };
      document.getElementById('trigCancelBtn').onclick = closeTriggerModal;
      modal.onclick = (e) => { if (e.target === modal) closeTriggerModal(); };
    }
  }

  function renderInlineBody(text, images) {
    const imgs = Array.isArray(images) ? images : [];
    const resolveImg = (item) => {
      const s = String(item || '');
      if (s.startsWith('[[RSASSET:')) {
        return resolveAssetTokens(s, lastState && lastState.snapshot && lastState.snapshot.assetMap);
      }
      return safeImgSrc(s);
    };
    const used = new Set();
    let html = esc(text || '').replace(/\\[\\[RSIMG:(\\d+)\\]\\]/g, (_, nStr) => {
      const idx = Number(nStr);
      const src = imgs[idx] ? resolveImg(imgs[idx]) : '';
      if (src) {
        used.add(idx);
        return '<span class="msg-img-wrap" data-img-reveal="1"><img class="msg-img" loading="lazy" decoding="async" src="' + esc(src) + '" /><span class="img-veil">🌫️ 터치해 보기</span></span>';
      }
      return '';
    });
    for (let i = 0; i < imgs.length; i++) {
      const src = !used.has(i) && imgs[i] ? resolveImg(imgs[i]) : '';
      if (src) {
        html += '<span class="msg-img-wrap" data-img-reveal="1"><img class="msg-img" loading="lazy" decoding="async" src="' + esc(src) + '" /><span class="img-veil">🌫️ 터치해 보기</span></span>';
      }
    }
    return html;
  }


  function displayBotName(rawName) {
    if (uiPref.assetMode !== 'hide') return rawName || 'Character';
    if (uiPref.theme === 'ai-claude') return 'Claude';
    if (uiPref.theme === 'ai-chatgpt') return 'ChatGPT';
    if (uiPref.theme === 'ai-gemini') return 'Gemini';
    return '문서 뷰어';
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token, ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function logoutToLogin(reason) {
    if (typeof stopTtsPlayback === 'function') stopTtsPlayback();
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (updPolling) { clearInterval(updPolling); updPolling = null; }
    if (typeof disconnectActivityStream === 'function') disconnectActivityStream();
    isStatePolling = false;
    knownCatalogVer = -1;
    knownSnapshotVer = -1;
    token = '';
    localStorage.removeItem('rs_token');
    setReadBar(false);
    document.getElementById('app').style.display = 'none';
    document.getElementById('login').style.display = 'flex';
    document.getElementById('tokInput').value = '';
    document.getElementById('loginErr').textContent = reason || '';
  }

  document.getElementById('logoutBtn').onclick = () => logoutToLogin('로그아웃되었습니다.');

  function loadRecentOpens() {
    try { return JSON.parse(localStorage.getItem('rs_recent_opens') || '{}') || {}; } catch (_) { return {}; }
  }
  function saveRecentOpens(map) {
    try {
      const entries = Object.entries(map || {}).sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0)).slice(0, 100);
      localStorage.setItem('rs_recent_opens', JSON.stringify(Object.fromEntries(entries)));
    } catch (_) {}
  }
  function recordRecentOpen(charIndex, chatIndex) {
    const chars = (lastState && lastState.catalog && lastState.catalog.characters) || [];
    const c = chars.find((x) => x && x.index === charIndex) || chars[charIndex];
    if (!c) return;
    const ch = (c.chats || []).find((x) => x && x.index === chatIndex);
    const key = String(c.chaId || c.index) + '|' + String((ch && ch.id) || chatIndex);
    const map = loadRecentOpens();
    map[key] = Date.now();
    saveRecentOpens(map);
  }
  function getEffectiveChatDate(c, ch, recentMap) {
    const pcDate = Number((ch && ch.lastDate) || 0);
    const key = String((c && (c.chaId || c.index)) ?? '') + '|' + String((ch && (ch.id || ch.index)) ?? '');
    const localDate = Number((recentMap && recentMap[key]) || 0);
    return Math.max(Number.isFinite(pcDate) ? pcDate : 0, Number.isFinite(localDate) ? localDate : 0);
  }
  function getEffectiveCharDate(c, recentMap) {
    let best = Number((c && c.lastDate) || 0);
    if (!Number.isFinite(best)) best = 0;
    for (const ch of (c && c.chats) || []) {
      const d = getEffectiveChatDate(c, ch, recentMap);
      if (d > best) best = d;
    }
    return best;
  }
  function formatRelTime(ts) {
    const n = Number(ts || 0);
    if (!n || !Number.isFinite(n)) return '';
    const diff = Date.now() - n;
    if (diff < 60000) return '방금 전';
    if (diff < 3600000) return Math.floor(diff / 60000) + '분 전';
    if (diff < 86400000) return Math.floor(diff / 3600000) + '시간 전';
    const d = new Date(n);
    const now = new Date();
    const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (d.getFullYear() === yest.getFullYear() && d.getMonth() === yest.getMonth() && d.getDate() === yest.getDate()) return '어제';
    const days = Math.floor(diff / 86400000);
    if (days < 7) return days + '일 전';
    return (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
  }
  function botThumbHtml(charObj, sizeClass = '') {
    const rawName = String((charObj && charObj.name) || '?');
    const initial = esc((rawName.trim().slice(0, 1) || '?').toUpperCase());
    let hue = 0;
    for (let i = 0; i < rawName.length; i++) hue = (hue * 31 + rawName.charCodeAt(i)) % 360;
    const chaId = charObj ? String(charObj.chaId || (charObj.index !== undefined ? charObj.index : '')) : '';
    const thumbs = (lastState && lastState.botThumbs) || {};
    const ov = chaId ? thumbs[chaId] : null;
    const ver = (ov && ov.v) ? String(ov.v) : ((charObj && charObj.image) ? String(charObj.image) : '0');
    const src = chaId
      ? ('/api/asset/bot-thumb/' + encodeURIComponent(chaId) + '?v=' + encodeURIComponent(ver))
      : '';
    const cls = 'bot-thumb' + (sizeClass ? (' ' + sizeClass) : '');
    return '<div class="' + cls + '">' +
      '<div class="bot-thumb-ph" style="background:hsl(' + hue + ',46%,38%);">' + initial + '</div>' +
      (src ? '<img class="bot-thumb-img" loading="lazy" decoding="async" src="' + esc(src) + '" alt="" />' : '') +
    '</div>';
  }
  document.addEventListener('error', (e) => {
    const t = e && e.target;
    if (t && t.tagName === 'IMG' && t.classList && t.classList.contains('bot-thumb-img')) {
      t.style.display = 'none';
    }
  }, true);

  // ===== Settings-tab masonry (desktop >= 900px) =====
  const SETTINGS_MASONRY_ROW = 4;
  const SETTINGS_MASONRY_GAP = 16;
  const settingsMasonryMq = window.matchMedia ? window.matchMedia('(min-width: 900px)') : null;
  function layoutSettingsMasonry(panel) {
    if (!panel) return;
    const on = !!(settingsMasonryMq && settingsMasonryMq.matches) && typeof ResizeObserver !== 'undefined';
    if (!on) {
      if (panel.classList.contains('rs-masonry')) {
        panel.classList.remove('rs-masonry');
        Array.from(panel.children).forEach((el) => { el.style.gridRowEnd = ''; });
      }
      return;
    }
    if (!panel.classList.contains('active')) return;
    Array.from(panel.children).forEach((el) => {
      const h = el.offsetHeight;
      if (!h) return;
      const span = Math.max(1, Math.ceil((h + SETTINGS_MASONRY_GAP) / SETTINGS_MASONRY_ROW));
      const next = 'span ' + span;
      if (el.style.gridRowEnd !== next) el.style.gridRowEnd = next;
    });
    panel.classList.add('rs-masonry');
  }
  function initSettingsMasonry() {
    if (typeof ResizeObserver === 'undefined') return;
    ['tab-modules', 'tab-router'].forEach((id) => {
      const panel = document.getElementById(id);
      if (!panel) return;
      let raf = 0;
      const schedule = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; layoutSettingsMasonry(panel); });
      };
      const ro = new ResizeObserver(schedule);
      const watch = () => Array.from(panel.children).forEach((el) => ro.observe(el));
      watch();
      new MutationObserver(() => { watch(); schedule(); }).observe(panel, { childList: true });
      if (settingsMasonryMq) {
        const onMq = () => schedule();
        if (settingsMasonryMq.addEventListener) settingsMasonryMq.addEventListener('change', onMq);
        else if (settingsMasonryMq.addListener) settingsMasonryMq.addListener(onMq);
      }
      schedule();
    });
  }
  initSettingsMasonry();

  function switchTab(tab, opts = {}) {
    if (tab === 'bots') tab = 'home';
    const prevTab = currentTab;
    currentTab = tab;
    document.body.classList.toggle('tab-chat-active', tab === 'chat');
    document.body.classList.toggle('tab-home-active', tab === 'home');
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    const panelEl = document.getElementById('tab-' + tab);
    if (panelEl) panelEl.classList.add('active');
    const btnEl = document.querySelector('.tab-btn[data-tab="' + tab + '"]');
    if (btnEl) btnEl.classList.add('active');
    document.getElementById('composerBar').style.display = tab === 'chat' ? 'flex' : 'none';
    if (!opts.fromPopstate && typeof history !== 'undefined' && history.pushState) {
      try {
        if (prevTab === 'home' && tab === 'chat') history.pushState(null, '', '#chat');
        else history.replaceState(null, '', '#' + tab);
      } catch (_) {}
    }
    if (tab === 'chat') {
      if (lastState) syncChatRender(lastState);
      if (isBookMode()) setTimeout(() => layoutBookSpreads(false), 30);
    }
    syncBotMenuVisibility();
    if (typeof renderRsMiniBar === 'function') renderRsMiniBar(false);
    if (tab === 'router') { loadRouterConfig(); if (typeof loadRequestLogs === 'function') loadRequestLogs(); }
    if (tab === 'home') {
      if (typeof renderHome === 'function') renderHome();
      renderBots();
      if (Date.now() - lastBotsSyncAt > 4000) {
        lastBotsSyncAt = Date.now();
        api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'sync_all' }) }).catch(() => {});
      }
    }
    if (tab === 'modules') { renderModules(); refreshUpdateStatus(); }
  }
  window.addEventListener('popstate', () => {
    if (currentTab === 'chat' && location.hash !== '#chat') {
      switchTab('home', { fromPopstate: true });
    }
  });

  let activityAbortCtrl = null;
  let activityRetryTimer = null;
  let lastActivitySig = '';
  let lastActivitySeq = -1;
  function renderHdrActivity(actData) {
    const bar = document.getElementById('hdrActivityBar');
    if (!bar) return;
    if (actData && typeof actData.seq === 'number') {
      if (actData.seq < lastActivitySeq) return;
      lastActivitySeq = actData.seq;
    }
    const active = Array.isArray(actData && actData.active) ? actData.active : [];
    const recent = Array.isArray(actData && actData.recent) ? actData.recent : [];
    const sig = JSON.stringify([
      active.map((x) => [x.kind, x.stage, x.step, x.total, x.name, x.phase]),
      recent.map((x) => [x.kind, x.stage, x.step, x.total, x.name, x.phase]),
    ]);
    if (sig === lastActivitySig) return;
    lastActivitySig = sig;
    if (!active.length && !recent.length) {
      bar.innerHTML = '';
      bar.removeAttribute('title');
      return;
    }
    const fmtActive = (item) => {
      const stageTag = item.stage
        ? ('[' + item.stage + (item.total > 0 ? ' ' + item.step + '/' + item.total : '') + '] ')
        : '';
      return stageTag + item.name + (item.phase ? ' · ' + item.phase : '');
    };
    const fmtRecent = (item) => {
      const stageTag = item.stage ? (item.stage + ' 완료 · ') : '';
      return stageTag + item.name;
    };
    if (active.length) {
      const first = active[0];
      const txt = fmtActive(first) + (active.length > 1 ? ' +' + (active.length - 1) : '');
      bar.title = active.map(fmtActive).join('\\n');
      bar.innerHTML = '<span class="hdr-act-pill"><span class="hdr-act-dot"></span><span>' + esc(txt) + '</span></span>';
    } else {
      const latest = recent[recent.length - 1];
      const txt = fmtRecent(latest);
      bar.title = recent.map(fmtRecent).join('\\n');
      bar.innerHTML = '<span class="hdr-act-pill recent"><span>✓</span><span>' + esc(txt) + '</span></span>';
    }
  }
  function disconnectActivityStream() {
    if (activityRetryTimer) { clearTimeout(activityRetryTimer); activityRetryTimer = null; }
    if (activityAbortCtrl) { try { activityAbortCtrl.abort(); } catch (_) {} activityAbortCtrl = null; }
    lastActivitySig = '';
    lastActivitySeq = -1;
    const bar = document.getElementById('hdrActivityBar');
    if (bar) { bar.innerHTML = ''; bar.removeAttribute('title'); }
  }
  async function connectActivityStream() {
    disconnectActivityStream();
    if (!token) return;
    const ctrl = new AbortController();
    activityAbortCtrl = ctrl;
    try {
      const resp = await fetch('/api/activity/stream', {
        headers: { 'X-RisuStand-Token': token },
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) throw new Error('SSE HTTP ' + resp.status);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (activityAbortCtrl === ctrl) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nlIdx;
        while ((nlIdx = buf.indexOf('\\n')) >= 0) {
          const line = buf.slice(0, nlIdx).trim();
          buf = buf.slice(nlIdx + 1);
          if (line.startsWith('data:')) {
            try { renderHdrActivity(JSON.parse(line.slice(5).trim())); } catch (_) {}
          }
        }
      }
    } catch (_) {}
    if (activityAbortCtrl === ctrl && token) {
      activityRetryTimer = setTimeout(() => {
        if (activityAbortCtrl === ctrl) connectActivityStream();
      }, 2500);
    }
  }

  async function tryLogin(t) {
    token = t.trim();
    knownCatalogVer = -1;
    knownSnapshotVer = -1;
    try {
      const st = await api('/api/state');
      if (typeof st.catalogVersion === 'number') knownCatalogVer = st.catalogVersion;
      if (typeof st.snapshotVersion === 'number') knownSnapshotVer = st.snapshotVersion;
      localStorage.setItem('rs_token', token);
      document.getElementById('login').style.display = 'none';
      document.getElementById('app').style.display = 'grid';
      await loadRouterConfig();
      applyState(st);
      switchTab('home', { fromPopstate: true });
      try { if (typeof history !== 'undefined' && history.replaceState) history.replaceState(null, '', '#home'); } catch (_) {}
      connectActivityStream();
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(pollState, 2000);
    } catch (e) {
      document.getElementById('loginErr').textContent = e && e.status === 429
        ? '로그인 시도가 너무 많습니다. 1분 후 다시 시도하세요.'
        : '토큰이 올바르지 않습니다.';
    }
  }

  document.getElementById('loginBtn').onclick = () => tryLogin(document.getElementById('tokInput').value);
  document.getElementById('tokInput').onkeydown = (e) => { if (e.key === 'Enter') document.getElementById('loginBtn').click(); };

  async function pollState() {
    if (isStatePolling) return;
    isStatePolling = true;
    try {
      const st = await api('/api/state?cv=' + knownCatalogVer + '&sv=' + knownSnapshotVer);
      if (typeof st.catalogVersion === 'number') knownCatalogVer = st.catalogVersion;
      if (typeof st.snapshotVersion === 'number') knownSnapshotVer = st.snapshotVersion;
      if (!('catalog' in st) && lastState && lastState.catalog) st.catalog = lastState.catalog;
      if (!('snapshot' in st) && lastState && lastState.snapshot) st.snapshot = lastState.snapshot;
      applyState(st);
    } catch (e) {
      if (e && e.status === 401) {
        logoutToLogin('세션 토큰이 만료되었거나 변경되었습니다. 다시 입력해 주세요.');
      }
    } finally {
      isStatePolling = false;
    }
  }

  function syncComposerBusy(isBusy) {
    const busy = Boolean(isBusy);
    const btn = document.getElementById('sendBtn');
    const inp = document.getElementById('msgInput');
    const bar = document.getElementById('composerBar');
    if (btn) btn.disabled = busy;
    if (inp) inp.placeholder = busy ? 'RisuAI에 응답을 요청 중...' : '메시지를 입력하세요...';
    if (bar) bar.classList.toggle('is-busy', busy);
  }

  function markLocalRequestPending(active) {
    if (localRequestTimer) { clearTimeout(localRequestTimer); localRequestTimer = null; }
    localRequestPending = Boolean(active);
    if (localRequestPending) {
      localRequestTimer = setTimeout(() => {
        localRequestTimer = null;
        localRequestPending = false;
        syncComposerBusy(Boolean(lastState && (lastState.generating || lastState.directGenerating)));
      }, 8000);
    }
    syncComposerBusy(Boolean(localRequestPending || (lastState && (lastState.generating || lastState.directGenerating))));
  }

  function getLatestCharMsgInfo(msgs) {
    const list = Array.isArray(msgs) ? msgs : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m && m.role !== 'user' && Number(m.index) >= 0) {
        return {
          index: Number(m.index),
          digest: hashStr((m.text || '') + ':' + (m.html || '')),
        };
      }
    }
    return { index: -1, digest: '' };
  }

  function armPendingReplyFollow(snap) {
    if (!snap || snap.charIndex < 0) return;
    if (bookSpreadIdx >= 0) {
      bookAnchorMode = 'manual';
      bookDesiredSpreadIdx = bookSpreadIdx;
    }
    const latest = getLatestCharMsgInfo(snap.messages || []);
    pendingReplyTarget = {
      chatKey: snap.charIndex + ':' + snap.chatIndex,
      prevLastCharIndex: latest.index,
      prevLastCharDigest: latest.digest,
      at: Date.now(),
    };
  }

  function syncLeaveHudVisibility(snapObj) {
    const s = snapObj || (lastState && lastState.snapshot) || {};
    const remoteGlobals = (routerCfg && routerCfg.remoteToggleValues && typeof routerCfg.remoteToggleValues === 'object') ? routerCfg.remoteToggleValues : {};
    const useLocal = Boolean(s.useLocallySetGlobalVariables);
    const localVals = s.localToggleValues || {};
    const pcGlobals = s.globalToggleValues || {};
    const effective = useLocal
      ? (localVals.toggle_state_tracker ?? localVals.state_tracker ?? remoteGlobals.toggle_state_tracker ?? remoteGlobals.state_tracker ?? pcGlobals.toggle_state_tracker ?? pcGlobals.state_tracker ?? '0')
      : (remoteGlobals.toggle_state_tracker ?? remoteGlobals.state_tracker ?? pcGlobals.toggle_state_tracker ?? pcGlobals.state_tracker ?? '0');
    document.body.classList.toggle('hide-leave-hud', String(effective) === '2');
  }

  function syncChatRender(st) {
    const snap = (st && st.snapshot) || {};
    const msgs = snap.messages || [];
    const msgDigest = hashStr(msgs.map((m) => m.index + ':' + (m.text || '') + ':' + (m.html || '') + ':' + (m.pluginFooterHtml || '') + ':' + (m.swipeCount || 1) + ':' + (m.swipeIndex || 0) + ':' + (m.images ? m.images.length : 0)).join('\\x01'));
    const sig = JSON.stringify([snap.charIndex, snap.chatIndex, snap.fmIndex, snap.firstMessageCount, snap.greetingControls || [], snap.backgroundHtml || '', hashStr(snap.botWidgetHtml || ''), Object.keys(snap.assetMap || {}).length, msgs.length, msgDigest, uiPref.theme, uiPref.assetMode, uiPref.richHtml]);
    if (sig !== lastChatRenderSig) {
      lastChatRenderSig = sig;
      try { renderChat(); }
      catch (err) { console.error('[RisuStand UI] chat render failed:', err); }
    }
  }

  function applyState(st) {
    lastState = st;
    if (st.runtimeActivity) renderHdrActivity(st.runtimeActivity);
    if (st.pluginFloatingUi) {
      latestPluginFloatingUi = st.pluginFloatingUi;
      if (typeof renderRsMiniBar === 'function') renderRsMiniBar(false);
      if (typeof isPluginFloatingModalOpen === 'function' && isPluginFloatingModalOpen()) {
        renderPluginFloatingModal(false);
      }
    }
    const snap = st.snapshot || {};
    syncLeaveHudVisibility(snap);
    document.getElementById('pcDot').className = 'dot' + (st.pcConnected ? ' on' : '');
    const hdrAvEl = document.getElementById('hdrAvatar');
    if (hdrAvEl) {
      const chars = (st.catalog && Array.isArray(st.catalog.characters)) ? st.catalog.characters : [];
      const curCharObj = (typeof snap.charIndex === 'number' && snap.charIndex >= 0)
        ? (chars.find((c) => c && c.index === snap.charIndex) || chars[snap.charIndex] || null)
        : null;
      if (curCharObj && uiPref.assetMode !== 'hide') {
        const chaId = String(curCharObj.chaId || curCharObj.index);
        const ov = st.botThumbs && st.botThumbs[chaId];
        const avSig = chaId + ':' + (ov ? ov.v : (curCharObj.image || '0')) + ':' + uiPref.assetMode + ':' + displayBotName(curCharObj.name);
        if (avSig !== lastHdrAvatarSig) {
          lastHdrAvatarSig = avSig;
          hdrAvEl.innerHTML = botThumbHtml(curCharObj, 'xs');
        }
        hdrAvEl.style.display = 'block';
      } else {
        lastHdrAvatarSig = '';
        hdrAvEl.innerHTML = '';
        hdrAvEl.style.display = 'none';
      }
    }
    document.getElementById('hdrChar').textContent = displayBotName(snap.charName || 'PC 연결 대기');
    const modeTag = snap.isPcActive ? 'PC 활성' : '원격 라우팅';
    const isBusy = Boolean(st.generating || st.directGenerating);
    if (isBusy) {
      localRequestPending = false;
      if (localRequestTimer) { clearTimeout(localRequestTimer); localRequestTimer = null; }
    }
    const genTag = isBusy ? ' · ✨ 생성 중...' : '';
    document.getElementById('hdrSub').textContent = (uiPref.assetMode === 'hide' ? '대화' : (snap.chatName || '채팅방')) + ' · ' + modeTag + genTag;
    document.querySelector('.tab-btn[data-tab="modules"]').classList.toggle('has-update', Boolean(st.updateAvailable));
    if (st.pluginVersion) document.getElementById('updPlugin').textContent = 'v' + st.pluginVersion;
    if (st.lastDirectError && st.lastDirectError.at && st.lastDirectError.at > lastDirectErrAt) {
      lastDirectErrAt = st.lastDirectError.at;
      localRequestPending = false;
      pendingReplyTarget = null;
      if (localRequestTimer) { clearTimeout(localRequestTimer); localRequestTimer = null; }
      toast('응답 오류: ' + (st.lastDirectError.message || '실패'));
    }
    if (st.lastTriggerEvent && st.lastTriggerEvent.id && st.lastTriggerEvent.id !== lastHandledTriggerEventId) {
      lastHandledTriggerEventId = st.lastTriggerEvent.id;
      const tev = st.lastTriggerEvent;
      if (tev.kind === 'error') {
        localRequestPending = false;
        pendingReplyTarget = null;
        if (localRequestTimer) { clearTimeout(localRequestTimer); localRequestTimer = null; }
      }
      if (tev.kind === 'prompt_select' || tev.kind === 'prompt_input' || tev.kind === 'notice' || tev.kind === 'alert_error') showTriggerModal(tev);
      else if (tev.kind === 'error') toast('⚠️ ' + (tev.message || '트리거 오류'));
    }
    syncComposerBusy(Boolean(isBusy || localRequestPending));

    try { syncBotBackground(snap.backgroundHtml || '', snap.assetMap || {}); }
    catch (err) { console.error('[RisuStand UI] background render failed:', err); }

    const msgs = snap.messages || [];
    if (pendingReplyTarget) {
      const chatKey = snap.charIndex + ':' + snap.chatIndex;
      if (Date.now() - pendingReplyTarget.at > 300000 || chatKey !== pendingReplyTarget.chatKey) {
        pendingReplyTarget = null;
      } else {
        const latestChar = getLatestCharMsgInfo(msgs);
        if (
          latestChar.index > pendingReplyTarget.prevLastCharIndex ||
          (latestChar.index >= 0 && latestChar.index === pendingReplyTarget.prevLastCharIndex && latestChar.digest !== pendingReplyTarget.prevLastCharDigest)
        ) {
          pendingReplyTarget = null;
          bookAnchorMode = 'last-user';
          bookSpreadIdx = -1;
          bookDesiredSpreadIdx = -1;
          pendingScrollToLastUser = true;
        }
      }
    }
    if (currentTab === 'chat') {
      syncChatRender(st);
    }
    if (currentTab === 'home') {
      if (typeof renderHome === 'function') renderHome();
      renderBots();
    }
    if (currentTab === 'modules') renderModules();
  }

  function renderFirstMessageSwipeHtml(snap) {
    const total = Number(snap.firstMessageCount || 0);
    const fmIdx = typeof snap.fmIndex === 'number' ? snap.fmIndex : -1;
    if (total > 1) {
      const pos = fmIdx < 0 ? 1 : Math.min(total, fmIdx + 2);
      return '<span class="msg-swipe-grp">' +
        '<button class="act-btn" data-fm-step="-1" title="이전 인사말">◀</button>' +
        '<span class="msg-swipe-cnt">' + pos + ' / ' + total + '</span>' +
        '<button class="act-btn" data-fm-step="1" title="다음 인사말">▶</button>' +
      '</span>';
    }
    const ctrls = Array.isArray(snap.greetingControls) ? snap.greetingControls : [];
    const firstCtrl = ctrls.find((c) => c.key === 'first' && Array.isArray(c.options) && c.options.length > 1)
      || ctrls.find((c) => Array.isArray(c.options) && c.options.length > 1);
    if (firstCtrl) {
      const opts = firstCtrl.options;
      const curIdx = Math.max(0, opts.findIndex((o) => String(o) === String(firstCtrl.value)));
      return '<span class="msg-swipe-grp">' +
        '<button class="act-btn" data-greet-var-key="' + esc(firstCtrl.key) + '" data-greet-var-step="-1" title="이전 퍼스트">◀</button>' +
        '<span class="msg-swipe-cnt">' + (curIdx + 1) + ' / ' + opts.length + '</span>' +
        '<button class="act-btn" data-greet-var-key="' + esc(firstCtrl.key) + '" data-greet-var-step="1" title="다음 퍼스트">▶</button>' +
      '</span>';
    }
    return '';
  }

  function extractPluginBubbleControls(htmlStr) {
    const raw = String(htmlStr || '');
    if (!raw || !/data-am-|risu-form/i.test(raw)) return [];
    const controls = [];
    try {
      const doc = new DOMParser().parseFromString('<div>' + raw + '</div>', 'text/html');
      doc.querySelectorAll('[data-am-chat-history-action], [data-am-chat-regenerate-action], [data-am-manual-generate-action]').forEach((el) => {
        const ds = {};
        for (const a of Array.from(el.attributes || [])) {
          if (a.name.startsWith('data-')) ds[a.name] = a.value;
        }
        let label = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!label) {
          if (ds['data-am-chat-regenerate-action']) label = '↻ 삽화 재생성';
          else if (ds['data-am-chat-history-action'] === 'previous') label = '◀ 이전 삽화';
          else if (ds['data-am-chat-history-action'] === 'next') label = '다음 삽화 ▶';
          else if (ds['data-am-manual-generate-action']) label = '🎨 수동 생성';
          else label = '🎨 실행';
        }
        controls.push({
          label: label.slice(0, 28),
          outerHTML: el.outerHTML,
          dataset: ds,
        });
      });
    } catch (_) {}
    return controls;
  }

  function renderPluginFooterHostHtml(m, assetMap) {
    if (!m || !m.pluginFooterHtml) return '';
    return '<div class="rs-am-footer-host">' + sanitizePluginWidgetHtml(m.pluginFooterHtml, '.rs-am-footer-host', assetMap || {}) + '</div>';
  }

  function renderPluginBubbleBarHtml(m) {
    if (!m || !m.html) return '';
    const ctrls = extractPluginBubbleControls(m.html);
    if (!ctrls.length) return '';
    const btns = ctrls.map((c) => {
      const payload = esc(JSON.stringify({ msgIndex: m.index, chatId: m.chatId || '', actionHtml: c.outerHTML, dataset: c.dataset }));
      return '<button type="button" class="rs-pbb-btn" data-am-proxy="' + payload + '">' + esc(c.label) + '</button>';
    }).join('');
    return '<div class="rs-plugin-bubble-bar"><span class="rs-pbb-label">🎨 플러그인</span>' + btns + '</div>';
  }

  function renderTurnTtsBtnHtml(m, key) {
    if (!m) return '';
    const ttsCfg = (routerCfg && routerCfg.tts && typeof routerCfg.tts === 'object') ? routerCfg.tts : null;
    if (ttsCfg && ttsCfg.enabled === false) return '';
    const hasTxt = Boolean((m.text && stripImgTokens(m.text).trim()) || m.html);
    if (!hasTxt) return '';
    const isThis = typeof ttsPlayerState !== 'undefined' && ttsPlayerState.activeKey === key;
    const cls = isThis
      ? (ttsPlayerState.loading ? ' is-loading' : (ttsPlayerState.playing ? ' is-playing' : ''))
      : '';
    const svg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>';
    return '<button type="button" class="turn-tts-btn' + cls + '" data-tts-msg="' + m.index + '" data-tts-key="' + esc(key) + '" title="이 메시지 음성 재생 (TTS)" aria-label="이 메시지 음성 재생">' + svg + '</button>';
  }

  function renderMsgActionBarHtml(m, snap, key, showTr, isLatestChar, isBook) {
    let acts = '';
    if (m.isFirstMessage) {
      acts += renderFirstMessageSwipeHtml(snap);
    }
    if (m.index >= 0) {
      const swCount = Number(m.swipeCount || 1);
      const swIdx = Number(m.swipeIndex || 0);
      if (m.role !== 'user' && swCount > 1) {
        acts += '<span class="msg-swipe-grp">' +
          '<button class="act-btn" data-swipe-msg="' + m.index + '" data-swipe-delta="-1" title="이전 응답(롤백)">◀</button>' +
          '<span class="msg-swipe-cnt">' + (swIdx + 1) + ' / ' + swCount + '</span>' +
          '<button class="act-btn" data-swipe-msg="' + m.index + '" data-swipe-delta="1" title="다음 응답">▶</button>' +
        '</span>';
      }
      if (isLatestChar) {
        acts += '<button class="act-btn" data-reroll-msg="' + m.index + '" title="다시 생성 (리롤)">🔄 리롤</button>';
      }
    }
    if (m.text) {
      acts += '<button class="act-btn" data-tr-key="' + esc(key) + '" data-tr-idx="' + m.index + '">🌐 ' + (showTr ? (isBook ? '원문' : '번역 숨김') : '번역') + '</button>';
    }
    if (m.index >= 0) {
      acts += '<button class="act-btn" data-edit-msg="' + m.index + '">✏️ 수정</button>';
      acts += '<button class="act-btn" data-del-msg="' + m.index + '">🗑️ 삭제</button>';
    }
    return renderPluginBubbleBarHtml(m) + (acts ? '<div class="msg-actions" style="flex-wrap:wrap; align-items:center;">' + acts + '</div>' : '');
  }

  function computeUATurnStats(messages) {
    const list = Array.isArray(messages) ? messages : [];
    let completed = 0;
    let hasPendingUser = false;
    let hasAssistantInPair = false;
    let activeTurnNum = 0;
    const turnByIndex = new Array(list.length).fill(0);
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m || typeof m !== 'object') continue;
      if (m.disabled === true || m.isComment === true || m.isFirstMessage === true) continue;
      const rawBody = m.data !== undefined ? m.data : (m.raw !== undefined ? m.raw : (m.content !== undefined ? m.content : (m.text || '')));
      let hasBody = String(rawBody).trim().length > 0;
      if (!hasBody && m.html) {
        hasBody = String(m.html).replace(/<[^>]+>/g, ' ').trim().length > 0 || /<img/i.test(String(m.html));
      }
      if (!hasBody) continue;
      const roleRaw = String(m.role || '').toLowerCase();
      if (roleRaw === 'user') {
        if (!hasPendingUser) {
          activeTurnNum = completed + 1;
          hasPendingUser = true;
          hasAssistantInPair = false;
        } else if (hasAssistantInPair) {
          completed += 1;
          activeTurnNum = completed + 1;
          hasPendingUser = true;
          hasAssistantInPair = false;
        }
        turnByIndex[i] = activeTurnNum;
      } else if (roleRaw === 'char' || roleRaw === 'assistant' || roleRaw === 'bot' || roleRaw === 'model') {
        if (!hasPendingUser) {
          turnByIndex[i] = 0;
        } else {
          hasAssistantInPair = true;
          turnByIndex[i] = activeTurnNum;
        }
      }
    }
    if (hasPendingUser && hasAssistantInPair) completed += 1;
    return {
      completedTurns: completed,
      pendingTurn: (hasPendingUser && !hasAssistantInPair) ? activeTurnNum : 0,
      turnByIndex: turnByIndex,
    };
  }

  function renderBookContent(msgs, snap) {
    if (!msgs || !msgs.length) return '<div style="color:var(--sub); font-size:13px; text-align:center; margin-top:30px;">대화가 비어 있습니다.</div>';
    const lastIdx = Number(snap.totalMessages || 0) - 1;
    const fallbackTurns = computeUATurnStats(msgs);
    let out = '';
    for (let mi = 0; mi < msgs.length; mi++) {
      const m = msgs[mi];
      const isUser = m.role === 'user';
      const turnNum = (typeof m.turnIndex === 'number') ? m.turnIndex : (fallbackTurns.turnByIndex[mi] || 0);
      const key = snap.charIndex + ':' + snap.chatIndex + ':' + m.index;
      const trText = localTranslations.get(key);
      const showTr = shownTranslations.has(key);
      const useRich = uiPref.richHtml && m.html;
      const bodyHtml = (showTr && trText)
        ? esc(trText)
        : (useRich ? '<div class="rs-bot-html">' + renderBotRichHtml(m.html, snap.assetMap) + '</div>' : renderInlineBody(m.text, m.images));
      const isLatestChar = m.index >= 0 && !isUser && (m.index === lastIdx || (lastIdx < 0 && mi === msgs.length - 1));
      const turnTagLabel = isUser
        ? ('나' + (turnNum > 0 ? ' · Turn ' + turnNum : ''))
        : (displayBotName(snap.charName) + (turnNum > 0 ? ' · Turn ' + turnNum : ' · 프롤로그'));
      out += '<div class="' + (isUser ? 'book-user-block' : 'book-char-block') + '" data-msg-idx="' + m.index + '" data-turn-num="' + turnNum + '" data-chat-id="' + esc(m.chatId || '') + '">';
      out += '<div class="book-turn-tag"><span>' + esc(turnTagLabel) + '</span>' + renderTurnTtsBtnHtml(m, key) + '</div>';
      out += '<div>' + bodyHtml + '</div>';
      out += renderPluginFooterHostHtml(m, snap.assetMap);
      out += renderMsgActionBarHtml(m, snap, key, showTr, isLatestChar, true);
      out += '</div>';
    }
    return out;
  }

  function updateBookNavUI() {
    const prevBtn = document.getElementById('bookPrevBtn');
    const nextBtn = document.getElementById('bookNextBtn');
    const tapPrev = document.getElementById('bookTapPrev');
    const tapNext = document.getElementById('bookTapNext');
    const labelEl = document.getElementById('bookPageLabel');
    const rulerEl = document.getElementById('bookTurnRuler');
    if (prevBtn) prevBtn.disabled = bookSpreadIdx <= 0;
    if (nextBtn) nextBtn.disabled = bookSpreadIdx >= bookTotalSpreads - 1;
    if (tapPrev) tapPrev.classList.toggle('disabled', bookSpreadIdx <= 0);
    if (tapNext) tapNext.classList.toggle('disabled', bookSpreadIdx >= bookTotalSpreads - 1);
    if (labelEl) {
      if (bookSinglePage) {
        labelEl.textContent = (bookSpreadIdx + 1) + ' / ' + bookTotalSpreads + '쪽';
      } else {
        const leftP = bookSpreadIdx * 2 + 1;
        const rightP = Math.min(bookTotalPages, leftP + 1);
        labelEl.textContent = (leftP === rightP ? leftP : (leftP + '-' + rightP)) + '쪽 (' + (bookSpreadIdx + 1) + ' / ' + bookTotalSpreads + ' 펼침)';
      }
    }
    if (rulerEl) {
      let ruler = '';
      const maxTicks = 48;
      if (bookTotalSpreads <= maxTicks) {
        for (let i = 0; i < bookTotalSpreads; i++) {
          ruler += '<div class="ruler-tick' + (i === bookSpreadIdx ? ' active' : '') + '" data-book-spread="' + i + '"></div>';
        }
      } else {
        const activeTick = Math.round((bookSpreadIdx / Math.max(1, bookTotalSpreads - 1)) * (maxTicks - 1));
        for (let t = 0; t < maxTicks; t++) {
          const sp = Math.round((t / (maxTicks - 1)) * (bookTotalSpreads - 1));
          ruler += '<div class="ruler-tick' + (t === activeTick ? ' active' : '') + '" data-book-spread="' + sp + '"></div>';
        }
      }
      rulerEl.innerHTML = ruler;
    }
    const jBar = document.getElementById('bookJumpBar');
    if (jBar && jBar.style.display !== 'none') {
      const jRange = document.getElementById('bookJumpRange');
      const jInp = document.getElementById('bookJumpInp');
      const jPrev = document.getElementById('bookJumpPreview');
      const curPage = bookSinglePage ? (bookSpreadIdx + 1) : (bookSpreadIdx * 2 + 1);
      if (jRange) {
        jRange.min = '1';
        jRange.max = String(Math.max(1, bookTotalSpreads));
        jRange.value = String(Math.min(Math.max(1, bookTotalSpreads), bookSpreadIdx + 1));
      }
      if (jInp) {
        jInp.max = String(Math.max(1, bookTotalPages));
        if (document.activeElement !== jInp) jInp.value = String(curPage);
      }
      if (jPrev) {
        jPrev.textContent = (bookSpreadIdx + 1) + ' / ' + bookTotalSpreads + ' 펼침 (총 ' + bookTotalPages + '쪽)';
      }
    }
  }

  const bookImgPreviewState = { el: null, pinned: false, closeTimer: null };

  function closeBookImgPreview(immediate = false) {
    if (bookImgPreviewState.closeTimer) {
      clearTimeout(bookImgPreviewState.closeTimer);
      bookImgPreviewState.closeTimer = null;
    }
    const preview = document.getElementById('bookImgPreview');
    const frame = document.getElementById('bookFrame');
    const srcEl = bookImgPreviewState.el;
    bookImgPreviewState.el = null;
    bookImgPreviewState.pinned = false;
    if (!preview) return;
    preview.style.pointerEvents = 'none';
    if (immediate || !frame || !srcEl || !srcEl.isConnected) {
      preview.style.display = 'none';
      return;
    }
    const fr = frame.getBoundingClientRect();
    const r = srcEl.getBoundingClientRect();
    preview.style.left = (r.left - fr.left) + 'px';
    preview.style.width = r.width + 'px';
    preview.style.top = (r.top - fr.top) + 'px';
    preview.style.height = r.height + 'px';
    preview.style.backgroundPosition = 'center 10%';
    bookImgPreviewState.closeTimer = setTimeout(() => {
      bookImgPreviewState.closeTimer = null;
      preview.style.display = 'none';
    }, 360);
  }

  function openBookImgPreview(el, pinned = false) {
    if (!el) return;
    if (document.body.classList.contains('asset-blur') && !el.classList.contains('revealed')) return;
    const frame = document.getElementById('bookFrame');
    const preview = document.getElementById('bookImgPreview');
    if (!frame || !preview) return;
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none') return;
    if (bookImgPreviewState.closeTimer) {
      clearTimeout(bookImgPreviewState.closeTimer);
      bookImgPreviewState.closeTimer = null;
    }
    if (bookImgPreviewState.el === el && preview.style.display === 'block') {
      if (pinned) bookImgPreviewState.pinned = true;
      return;
    }
    const fr = frame.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!fr.height || !r.width || !r.height) return;
    const left = r.left - fr.left;
    const width = r.width;
    const startTop = r.top - fr.top;
    const startH = r.height;
    const targetH = Math.min(fr.height - 24, Math.max(startH * 1.85, width * 1.65));
    const endTop = (startTop + targetH > fr.height - 12) ? Math.max(12, fr.height - 12 - targetH) : startTop;

    bookImgPreviewState.el = el;
    bookImgPreviewState.pinned = Boolean(pinned);

    const savedTrans = preview.style.transition;
    preview.style.transition = 'none';
    preview.style.backgroundImage = bg;
    preview.style.left = left + 'px';
    preview.style.width = width + 'px';
    preview.style.top = startTop + 'px';
    preview.style.height = startH + 'px';
    preview.style.backgroundPosition = 'center 10%';
    preview.style.display = 'block';
    void preview.offsetWidth;
    preview.style.transition = savedTrans || '';
    preview.style.top = endTop + 'px';
    preview.style.height = targetH + 'px';
    preview.style.backgroundPosition = 'center 5%';
    preview.style.pointerEvents = 'auto';
  }

  function getBookSpreadScrollLeft(spreadIdx) {
    const idx = Math.max(0, Number(spreadIdx) || 0);
    const firstCol = idx * (bookSinglePage ? 1 : 2);
    if (typeof bookColOffsets[firstCol] === 'number' && Number.isFinite(bookColOffsets[firstCol])) {
      return Math.max(0, bookColOffsets[firstCol]);
    }
    return Math.max(0, Math.round(firstCol * (bookColStep || bookSpreadStride)));
  }

  function setBookViewportScrollLeft(vp, leftPx) {
    if (!vp) return;
    bookScrollGuardLock = true;
    vp.scrollLeft = Math.max(0, Math.round(leftPx));
    requestAnimationFrame(() => { bookScrollGuardLock = false; });
  }

  function goToBookSpread(nextIdx, animate = false, fromLayout = false) {
    closeBookImgPreview(true);
    const vp = document.getElementById('bookViewport');
    const flipLeaf = document.getElementById('flipLeaf');
    if (!vp) return;
    const prev = bookSpreadIdx < 0 ? 0 : bookSpreadIdx;
    if (!fromLayout) {
      bookAnchorMode = 'manual';
      bookDesiredSpreadIdx = Math.max(0, nextIdx);
    }
    const clamped = Math.max(0, Math.min(bookTotalSpreads - 1, nextIdx));
    bookSpreadIdx = clamped;

    if (bookFlipMidTimer) { clearTimeout(bookFlipMidTimer); bookFlipMidTimer = null; }
    if (bookFlipEndTimer) { clearTimeout(bookFlipEndTimer); bookFlipEndTimer = null; }

    if (animate && flipLeaf && clamped !== prev) {
      const dirClass = clamped > prev ? 'flip-next' : 'flip-prev';
      flipLeaf.classList.remove('flip-next', 'flip-prev');
      void flipLeaf.offsetWidth;
      flipLeaf.classList.add(dirClass);
      bookFlipMidTimer = setTimeout(() => {
        bookFlipMidTimer = null;
        setBookViewportScrollLeft(vp, getBookSpreadScrollLeft(bookSpreadIdx));
        updateBookNavUI();
      }, 300);
      bookFlipEndTimer = setTimeout(() => {
        bookFlipEndTimer = null;
        flipLeaf.classList.remove('flip-next', 'flip-prev');
      }, 650);
    } else {
      if (flipLeaf) flipLeaf.classList.remove('flip-next', 'flip-prev');
      setBookViewportScrollLeft(vp, getBookSpreadScrollLeft(bookSpreadIdx));
      updateBookNavUI();
    }
  }

  function layoutBookSpreads(jumpAuto = false) {
    const frame = document.getElementById('bookFrame');
    const vp = document.getElementById('bookViewport');
    const cols = document.getElementById('bookColumns');
    if (!frame || !vp || !cols) return;
    const frameW = frame.clientWidth;
    if (!frameW || frameW < 100) return;

    const oldPad = document.getElementById('bookEndPad');
    if (oldPad) oldPad.remove();

    bookSinglePage = frameW < 700;
    frame.classList.toggle('single-page', bookSinglePage);
    const colsPerSpread = bookSinglePage ? 1 : 2;
    const colGap = bookSinglePage ? 32 : 84;
    const sideMargin = bookSinglePage ? 36 : 84;
    const colW = Math.floor(Math.max(180, (frameW - sideMargin - colGap * (colsPerSpread - 1)) / colsPerSpread) / 4) * 4;
    const evenW = colW * colsPerSpread + colGap * (colsPerSpread - 1);

    vp.style.width = evenW + 'px';
    cols.style.width = evenW + 'px';
    cols.style.height = '100%';
    cols.style.columnWidth = colW + 'px';
    cols.style.columnCount = String(colsPerSpread);
    cols.style.columnGap = colGap + 'px';
    cols.style.columnFill = 'auto';

    const theoColStep = colW + colGap;
    const vpRect = vp.getBoundingClientRect();
    const measured = [];
    let maxMeasuredCol = 0;
    cols.querySelectorAll('.book-char-block, .book-user-block').forEach((el) => {
      const rects = el.getClientRects ? el.getClientRects() : [el.getBoundingClientRect()];
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (!r || r.width < colW * 0.45 || r.height < 2) continue;
        const absLeft = (r.left - vpRect.left) + vp.scrollLeft;
        if (absLeft < -8) continue;
        const cIdx = Math.round(absLeft / theoColStep);
        if (cIdx < 0) continue;
        if (Math.abs(absLeft - cIdx * theoColStep) > theoColStep * 0.35) continue;
        const floored = Math.max(0, Math.floor(absLeft));
        if (measured[cIdx] === undefined || floored < measured[cIdx]) measured[cIdx] = floored;
        if (cIdx > maxMeasuredCol) maxMeasuredCol = cIdx;
      }
    });
    bookColOffsets = measured;
    let actualColStep = theoColStep;
    if (maxMeasuredCol > 0 && typeof measured[maxMeasuredCol] === 'number' && measured[maxMeasuredCol] > 0) {
      const est = measured[maxMeasuredCol] / maxMeasuredCol;
      if (Math.abs(est - theoColStep) <= theoColStep * 0.04) actualColStep = est;
    }
    bookColStep = actualColStep;
    bookSpreadStride = actualColStep * colsPerSpread;
    const estPagesFromWidth = Math.max(1, Math.round((cols.scrollWidth + colGap) / actualColStep));
    bookTotalPages = Math.max(1, maxMeasuredCol + 1, estPagesFromWidth);
    bookTotalSpreads = Math.max(1, Math.ceil(bookTotalPages / colsPerSpread));

    if (!bookSinglePage && (bookTotalPages % 2 === 1)) {
      const pad = document.createElement('div');
      pad.id = 'bookEndPad';
      pad.style.cssText = 'break-before:column; -webkit-column-break-before:always; height:1px; width:100%; pointer-events:none;';
      cols.appendChild(pad);
    }

    if (bookAnchorMode === 'last-user') {
      const msgs = (lastState && lastState.snapshot && lastState.snapshot.messages) || [];
      let targetSpread = 0;
      if (msgs.length > 1) {
        const userBlocks = cols.querySelectorAll('.book-user-block');
        const targetEl = userBlocks.length ? userBlocks[userBlocks.length - 1] : cols.querySelector('.book-char-block:last-of-type');
        if (targetEl) {
          const tRect = (targetEl.getClientRects && targetEl.getClientRects()[0]) || targetEl.getBoundingClientRect();
          const absLeft = (tRect.left - vpRect.left) + vp.scrollLeft;
          const targetCol = Math.max(0, Math.round(absLeft / actualColStep));
          targetSpread = Math.floor(targetCol / colsPerSpread);
        } else {
          targetSpread = bookTotalSpreads - 1;
        }
      }
      bookDesiredSpreadIdx = targetSpread;
      goToBookSpread(targetSpread, false, true);
      return;
    }
    const target = bookDesiredSpreadIdx >= 0 ? bookDesiredSpreadIdx : (bookSpreadIdx < 0 ? 0 : bookSpreadIdx);
    goToBookSpread(target, false, true);
  }

  function flipBook(delta) {
    const base = bookSpreadIdx < 0 ? 0 : bookSpreadIdx;
    const next = Math.max(0, Math.min(bookTotalSpreads - 1, base + delta));
    if (next === base) return;
    goToBookSpread(next, true);
  }

  function captureCheckedBotIds() {
    const ids = [];
    document.querySelectorAll('#tab-chat .rs-bot-html input[type="checkbox"]:checked, #bookBotOverlay .rs-bot-html input[type="checkbox"]:checked').forEach((el) => {
      if (el.id) ids.push(el.id);
    });
    return ids;
  }

  function restoreCheckedBotIds(ids) {
    if (!ids || !ids.length) return;
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el && el.type === 'checkbox') el.checked = true;
    }
  }

  let lastBotOverlaySig = '';
  let cachedBotFabWidth = 0;

  function syncBotMenuVisibility() {
    const overlay = document.getElementById('bookBotOverlay');
    const fab = document.getElementById('botMenuFab');
    if (!overlay || !fab) return;
    const fabCol = overlay.querySelector('[data-rs-bot-fab="1"]');
    if (!fabCol || currentTab !== 'chat') {
      fab.style.display = 'none';
      if (botMenuAutoTimer) { clearTimeout(botMenuAutoTimer); botMenuAutoTimer = null; }
      return;
    }
    if (!cachedBotFabWidth) {
      const w = fabCol.offsetWidth;
      if (w >= 42 && w <= 72) cachedBotFabWidth = w;
    }
    if (cachedBotFabWidth) fab.style.setProperty('--bot-fab-w', cachedBotFabWidth + 'px');
    else fab.style.removeProperty('--bot-fab-w');

    fab.style.display = 'inline-flex';
    overlay.classList.toggle('bot-menu-collapsed', !botMenuExpanded);
    fab.classList.toggle('expanded', botMenuExpanded);
    const icEl = fab.querySelector('.bmf-ic');
    const lbEl = fab.querySelector('.bmf-lb');
    if (icEl && lbEl) {
      icEl.textContent = botMenuExpanded ? '▸' : '☰';
      lbEl.textContent = botMenuExpanded ? '접기' : '메뉴';
    }
  }

  function scheduleBotMenuAutoHide() {
    if (botMenuAutoTimer) { clearTimeout(botMenuAutoTimer); botMenuAutoTimer = null; }
  }

  document.getElementById('botMenuFab').onclick = (e) => {
    if (e) e.stopPropagation();
    botMenuExpanded = !botMenuExpanded;
    syncBotMenuVisibility();
    if (botMenuExpanded) scheduleBotMenuAutoHide();
    else if (botMenuAutoTimer) { clearTimeout(botMenuAutoTimer); botMenuAutoTimer = null; }
  };

  function hoistBotFixedWidgets(rootEl) {
    const overlay = document.getElementById('bookBotOverlay');
    if (!overlay || !rootEl) return;

    const snap = (lastState && lastState.snapshot) || null;
    const matchedContainers = Array.from(rootEl.querySelectorAll('.rs-bot-html')).filter(containerHasBotFixedMenu);
    const hasInlineFixed = matchedContainers.length > 0;
    const nextOverlaySig = JSON.stringify([
      snap ? snap.charIndex : -1,
      snap ? snap.chatIndex : -1,
      Boolean(uiPref.richHtml),
      snap && snap.botWidgetHtml ? hashStr(snap.botWidgetHtml) : '',
      snap && snap.backgroundHtml ? hashStr(snap.backgroundHtml) : '',
      hasInlineFixed ? lastChatRenderSig : '',
    ]);

    if (nextOverlaySig !== lastBotOverlaySig || (hasInlineFixed && !overlay.children.length)) {
      lastBotOverlaySig = nextOverlaySig;
      cachedBotFabWidth = 0;
      overlay.innerHTML = '';

      const extractFixedFromContainer = (container) => {
        if (!container || !containerHasBotFixedMenu(container)) return;
        const hostWrap = document.createElement('div');
        hostWrap.className = 'rs-bot-html';
        let moved = false;
        let hasFabAttr = false;
        const collectFromParent = (parent) => {
          for (const ch of Array.from(parent.children || [])) {
            const tag = (ch.tagName || '').toLowerCase();
            const cls = typeof ch.className === 'string' ? ch.className : '';
            if (tag === 'style' && /position\\s*:\\s*fixed/i.test(ch.textContent || '')) {
              hostWrap.appendChild(ch.cloneNode(true));
            } else if (tag === 'input' && (ch.type === 'checkbox' || ch.type === 'radio')) {
              hostWrap.appendChild(ch);
              moved = true;
            } else if (isBotFixedMenuElement(ch)) {
              if (/(?:buttons-container|floating)/i.test(cls)) {
                ch.setAttribute('data-rs-bot-fab', '1');
                hasFabAttr = true;
              }
              hostWrap.appendChild(ch);
              moved = true;
            } else if (ch.querySelector && ch.querySelector(BOT_FIXED_CLASS_SEL)) {
              collectFromParent(ch);
            }
          }
        };
        collectFromParent(container);
        if (moved && !hasFabAttr) {
          const fallbackBar = hostWrap.querySelector('div, nav, aside, section');
          if (fallbackBar) fallbackBar.setAttribute('data-rs-bot-fab', '1');
        }
        if (moved) overlay.appendChild(hostWrap);
      };

      if (matchedContainers.length > 0) {
        const winner = matchedContainers[matchedContainers.length - 1];
        extractFixedFromContainer(winner);
      }

      if (uiPref.richHtml && snap && !overlay.querySelector('[data-rs-bot-fab="1"]')) {
        if (snap.botWidgetHtml) {
          const tmp = document.createElement('div');
          tmp.className = 'rs-bot-html';
          tmp.innerHTML = renderBotRichHtml(snap.botWidgetHtml, snap.assetMap);
          extractFixedFromContainer(tmp);
        }
        if (!overlay.querySelector('[data-rs-bot-fab="1"]') && snap.backgroundHtml && /(?:buttons-container|side-panel|overlay|floating)/i.test(snap.backgroundHtml)) {
          const tmpBg = document.createElement('div');
          tmpBg.className = 'rs-bot-html';
          tmpBg.innerHTML = renderBotRichHtml(snap.backgroundHtml, snap.assetMap);
          extractFixedFromContainer(tmpBg);
        }
      }
    }

    // Never allow duplicate un-collapsed bot menu copies to remain inside chat bubbles or background host
    for (const c of matchedContainers) {
      stripBotFixedMenuNodes(c);
    }
    stripBotFixedMenuNodes(document.getElementById('botBgHost'));

    const fixedStyleEls = rootEl.querySelectorAll('.rs-bot-html [style*="fixed" i]');
    if (fixedStyleEls.length && typeof window.getComputedStyle === 'function') {
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      fixedStyleEls.forEach((el) => {
        const cs = window.getComputedStyle(el);
        if (cs && cs.position === 'fixed') {
          const rect = el.getBoundingClientRect();
          if (vw > 0 && vh > 0 && rect.width >= vw * 0.65 && rect.height >= vh * 0.65) {
            el.style.setProperty('position', 'absolute', 'important');
            el.style.setProperty('pointer-events', 'none', 'important');
            el.style.setProperty('z-index', '-1', 'important');
          }
        }
      });
    }

    syncBotMenuVisibility();
  }

  function isInteractiveBookTarget(target, rootEl) {
    if (!target || target.nodeType !== 1) return false;
    const sel = 'button, a, summary, input, select, textarea, label, audio, video, [role="button"], [role="link"], [onclick], [tabindex]:not([tabindex="-1"]), .msg-actions, .rs-am-footer-host, .rs-plugin-bubble-bar, .x-risu-am-illustration-footer, .x-risu-am-illustration-revision-controls, .x-risu-am-chat-history-edge-controls, .x-risu-am-image, .am-image, .x-risu-am-generated-image, .am-generated-image, .x-risu-am-illustration-projection, .am-illustration-projection, .x-risu-am-illustration-slot, .turn-tts-btn, .msg-img-wrap, .image-container, #bookImgPreview, [risu-btn], [risu-trigger], [x-risu-btn], [data-am-proxy], [data-am-illustration-action], [data-am-illustration-revision-action], [data-am-revision-action], [data-am-chat-history-action], [data-am-image-action], [data-am-viewer-action], [data-tts-msg], [data-reroll-msg], [data-tr-key], [data-edit-msg], [data-del-msg], [data-swipe-msg], [data-img-reveal], [data-fm-swipe], [data-chat-var-key]';
    if (target.closest(sel)) return true;
    let cur = target;
    let hops = 0;
    while (cur && cur !== rootEl && hops < 12) {
      if (cur.nodeType === 1 && typeof window.getComputedStyle === 'function') {
        try {
          if (window.getComputedStyle(cur).cursor === 'pointer') return true;
        } catch (_) {}
      }
      cur = cur.parentElement;
      hops += 1;
    }
    return false;
  }

  function renderChat() {
    const box = document.getElementById('tab-chat');
    const snap = (lastState && lastState.snapshot) || {};
    const msgs = snap.messages || [];
    const checkedBotIds = captureCheckedBotIds();

    if (typeof snap.charIndex !== 'number' || snap.charIndex < 0) {
      box.innerHTML = '<div class="empty-hint"><span class="big">🏠</span>열려 있는 채팅방이 없습니다.<br>홈에서 봇과 채팅방을 골라 주세요.<div style="margin-top:14px;"><button type="button" class="btn" onclick="switchTab(&#39;home&#39;)">🏠 홈으로 가기</button></div></div>';
      return;
    }

    if (isBookMode()) {
      const singleInit = window.innerWidth < 700;
      box.innerHTML =
        '<div class="book-shell">' +
          '<div class="book-frame' + (singleInit ? ' single-page' : '') + '" id="bookFrame">' +
            '<div class="book-tap-zone book-tap-left" id="bookTapPrev" aria-label="이전 페이지"></div>' +
            '<div class="book-tap-zone book-tap-right" id="bookTapNext" aria-label="다음 페이지"></div>' +
            '<div class="book-viewport" id="bookViewport">' +
              '<div class="book-columns" id="bookColumns">' + renderBookContent(msgs, snap) + '</div>' +
            '</div>' +
            '<div class="book-img-preview" id="bookImgPreview"></div>' +
            '<div class="epub-flip-leaf" id="flipLeaf"></div>' +
          '</div>' +
          '<div class="book-jump-bar" id="bookJumpBar" style="display:none;">' +
            '<div class="book-jump-head">' +
              '<span>쪽수 이동</span>' +
              '<span id="bookJumpPreview">1 / 1 펼침</span>' +
            '</div>' +
            '<input type="range" class="book-jump-range" id="bookJumpRange" min="1" max="1" value="1" />' +
            '<div class="book-jump-row">' +
              '<button type="button" class="pill" id="bookJumpFirstBtn">처음</button>' +
              '<input type="number" class="f-inp" id="bookJumpInp" min="1" max="1" placeholder="쪽수" />' +
              '<button type="button" class="btn" id="bookJumpGoBtn">이동</button>' +
              '<button type="button" class="pill" id="bookJumpLastBtn">끝</button>' +
            '</div>' +
          '</div>' +
          '<div class="book-nav">' +
            '<button class="pill" id="bookPrevBtn">◀ 이전</button>' +
            '<button type="button" class="pill book-page-btn" id="bookPageJumpBtn" title="쪽수 이동">' +
              '<span id="bookPageLabel">1 / 1쪽</span>' +
              '<span style="font-size:10px; opacity:0.75;">▾</span>' +
            '</button>' +
            '<button class="pill" id="bookNextBtn">다음 ▶</button>' +
          '</div>' +
          '<div class="turn-ruler" id="bookTurnRuler"></div>' +
        '</div>';

      hoistBotFixedWidgets(document.getElementById('bookColumns'));
      restoreCheckedBotIds(checkedBotIds);

      document.getElementById('bookPrevBtn').onclick = () => flipBook(-1);
      document.getElementById('bookNextBtn').onclick = () => flipBook(1);
      document.getElementById('bookTurnRuler').onclick = (e) => {
        const tick = e.target.closest('[data-book-spread]');
        if (tick) goToBookSpread(Number(tick.getAttribute('data-book-spread')), true);
      };

      const jumpBar = document.getElementById('bookJumpBar');
      const jumpBtn = document.getElementById('bookPageJumpBtn');
      const jumpRange = document.getElementById('bookJumpRange');
      const jumpInp = document.getElementById('bookJumpInp');
      const jumpGoBtn = document.getElementById('bookJumpGoBtn');
      const jumpFirstBtn = document.getElementById('bookJumpFirstBtn');
      const jumpLastBtn = document.getElementById('bookJumpLastBtn');
      const setBookJumpOpen = (open) => {
        if (!jumpBar) return;
        jumpBar.style.display = open ? 'flex' : 'none';
        if (open) {
          updateBookNavUI();
          if (jumpInp) {
            const curPage = bookSinglePage ? (bookSpreadIdx + 1) : (bookSpreadIdx * 2 + 1);
            jumpInp.value = String(curPage);
            setTimeout(() => { try { jumpInp.focus(); jumpInp.select(); } catch (_) {} }, 20);
          }
        }
      };
      const submitBookPageJump = () => {
        const raw = Number(jumpInp && jumpInp.value);
        if (!Number.isFinite(raw)) return;
        const p = Math.max(1, Math.min(Math.max(1, bookTotalPages), Math.trunc(raw)));
        const sp = bookSinglePage ? (p - 1) : Math.floor((p - 1) / 2);
        goToBookSpread(sp, false);
        setBookJumpOpen(false);
      };
      if (jumpBar) jumpBar.onclick = (e) => e.stopPropagation();
      if (jumpBtn) jumpBtn.onclick = (e) => {
        e.stopPropagation();
        setBookJumpOpen(jumpBar && jumpBar.style.display === 'none');
      };
      if (jumpRange) jumpRange.oninput = () => {
        const sp = Math.max(0, Math.min(bookTotalSpreads - 1, Number(jumpRange.value) - 1));
        goToBookSpread(sp, false);
      };
      if (jumpGoBtn) jumpGoBtn.onclick = submitBookPageJump;
      if (jumpInp) jumpInp.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitBookPageJump(); }
      };
      if (jumpFirstBtn) jumpFirstBtn.onclick = () => { goToBookSpread(0, false); setBookJumpOpen(false); };
      if (jumpLastBtn) jumpLastBtn.onclick = () => { goToBookSpread(bookTotalSpreads - 1, false); setBookJumpOpen(false); };

      const frame = document.getElementById('bookFrame');
      const vp = document.getElementById('bookViewport');
      const preview = document.getElementById('bookImgPreview');
      closeBookImgPreview(true);
      if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
        frame.addEventListener('mouseover', (e) => {
          const ic = e.target.closest('.book-columns .rs-bot-html .image-container');
          if (ic) openBookImgPreview(ic, false);
        });
        frame.addEventListener('mousemove', (e) => {
          const rect = frame.getBoundingClientRect();
          const zoneW = Math.max(44, Math.min(100, rect.width * 0.12));
          const relX = e.clientX - rect.left;
          const inPrev = relX <= zoneW && bookSpreadIdx > 0;
          const inNext = relX >= rect.width - zoneW && bookSpreadIdx < bookTotalSpreads - 1;
          frame.style.cursor = ((inPrev || inNext) && !isInteractiveBookTarget(e.target, frame)) ? 'pointer' : '';
        });
      }
      if (preview) {
        preview.onmouseleave = (e) => {
          if (e.relatedTarget && bookImgPreviewState.el && (e.relatedTarget === bookImgPreviewState.el || bookImgPreviewState.el.contains(e.relatedTarget))) return;
          if (!bookImgPreviewState.pinned) closeBookImgPreview(false);
        };
        preview.onclick = (e) => {
          e.stopPropagation();
          closeBookImgPreview(false);
        };
      }
      frame.onmouseleave = () => {
        frame.style.cursor = '';
        if (!bookImgPreviewState.pinned) closeBookImgPreview(false);
      };
      frame.addEventListener('click', (e) => {
        const ic = e.target.closest('.book-columns .rs-bot-html .image-container');
        if (ic) {
          if (document.body.classList.contains('asset-blur') && !ic.classList.contains('revealed')) return;
          e.stopPropagation();
          if (bookImgPreviewState.el === ic && bookImgPreviewState.pinned) closeBookImgPreview(false);
          else openBookImgPreview(ic, true);
          return;
        }
        if (bookImgPreviewState.pinned && !e.target.closest('#bookImgPreview')) {
          closeBookImgPreview(false);
          return;
        }
        if (e.defaultPrevented || (e.button && e.button !== 0)) return;
        const selTxt = window.getSelection ? String(window.getSelection()).trim() : '';
        if (selTxt) return;
        if (isInteractiveBookTarget(e.target, frame)) return;
        const rect = frame.getBoundingClientRect();
        const zoneW = Math.max(44, Math.min(100, rect.width * 0.12));
        const relX = e.clientX - rect.left;
        if (relX <= zoneW) flipBook(-1);
        else if (relX >= rect.width - zoneW) flipBook(1);
      });
      let sx = 0, sy = 0;
      frame.ontouchstart = (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; };
      frame.ontouchend = (e) => {
        const dx = e.changedTouches[0].clientX - sx;
        const dy = e.changedTouches[0].clientY - sy;
        if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.3) {
          if (dx < 0) flipBook(1);
          else flipBook(-1);
        }
      };
      vp.onwheel = (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          e.preventDefault();
          if (bookWheelLock) return;
          bookWheelLock = true;
          flipBook(e.deltaY > 0 ? 1 : -1);
          setTimeout(() => { bookWheelLock = false; }, 260);
        }
      };
      let bookScrollSnapTimer = null;
      vp.onscroll = () => {
        if (bookScrollGuardLock || bookSpreadIdx < 0) return;
        const expected = getBookSpreadScrollLeft(bookSpreadIdx);
        if (Math.abs(vp.scrollLeft - expected) <= 1) return;
        if (bookScrollSnapTimer) clearTimeout(bookScrollSnapTimer);
        bookScrollSnapTimer = setTimeout(() => {
          bookScrollSnapTimer = null;
          if (bookScrollGuardLock || bookSpreadIdx < 0) return;
          const exp2 = getBookSpreadScrollLeft(bookSpreadIdx);
          if (Math.abs(vp.scrollLeft - exp2) > 1) setBookViewportScrollLeft(vp, exp2);
        }, 40);
      };
      frame.querySelectorAll('img').forEach((img) => {
        if (!img.complete) {
          img.addEventListener('load', () => layoutBookSpreads(false), { once: true });
          img.addEventListener('error', () => layoutBookSpreads(false), { once: true });
        }
      });

      requestAnimationFrame(() => layoutBookSpreads(true));
      setTimeout(() => layoutBookSpreads(false), 80);
      setTimeout(() => layoutBookSpreads(false), 260);
      return;
    }

    // Standard Scroll Mode (Gemini / Claude / ChatGPT / EPUB 1p / Glass / Sakura / Moss)
    const prevScrollTop = box.scrollTop;
    const nearBottom = box.scrollHeight - prevScrollTop - box.clientHeight < 140;
    const autoTr = Boolean(routerCfg && routerCfg.translator && routerCfg.translator.autoTranslateOutput);

    let html = '';
    if (!msgs.length) {
      html += '<div class="empty-hint"><span class="big">💬</span>대화가 비어 있습니다.<br>아래에서 메시지를 보내 시작해 보세요.</div>';
    } else {
      const lastIdx = Number(snap.totalMessages || 0) - 1;
      const fallbackTurns = computeUATurnStats(msgs);
      for (let mi = 0; mi < msgs.length; mi++) {
        const m = msgs[mi];
        const key = snap.charIndex + ':' + snap.chatIndex + ':' + m.index;
        const isUser = m.role === 'user';
        const turnNum = (typeof m.turnIndex === 'number') ? m.turnIndex : (fallbackTurns.turnByIndex[mi] || 0);
        const trText = localTranslations.get(key);
        const showTr = shownTranslations.has(key) || (autoTr && !isUser && trText);
        const useRich = uiPref.richHtml && m.html;
        const bodyHtml = useRich
          ? '<div class="rs-bot-html">' + renderBotRichHtml(m.html, snap.assetMap) + '</div>'
          : renderInlineBody(m.text, m.images);
        const isLatestChar = m.index >= 0 && !isUser && (m.index === lastIdx || (lastIdx < 0 && mi === msgs.length - 1));
        const roleLabel = isUser
          ? ('나' + (turnNum > 0 ? ' · T' + turnNum : ''))
          : (displayBotName(snap.charName) + (turnNum > 0 ? ' · T' + turnNum : ' · 프롤로그'));
        html += '<div class="msg-wrap ' + (isUser ? 'user' : 'char') + '" data-msg-idx="' + m.index + '" data-turn-num="' + turnNum + '" data-chat-id="' + esc(m.chatId || '') + '">';
        html += '<div class="msg-role"><span>' + esc(roleLabel) + '</span>' + renderTurnTtsBtnHtml(m, key) + '</div>';
        html += '<div class="msg-bubble">' + bodyHtml + renderPluginFooterHostHtml(m, snap.assetMap) + '</div>';
        if (showTr && trText) html += '<div class="tr-box">' + esc(trText) + '</div>';
        html += renderMsgActionBarHtml(m, snap, key, showTr, isLatestChar, false);
        html += '</div>';
        if (autoTr && !isUser && m.text && !localTranslations.has(key)) autoFetchTranslation(key, m.text);
      }
    }
    box.innerHTML = html;
    hoistBotFixedWidgets(box);
    restoreCheckedBotIds(checkedBotIds);
    if (pendingScrollToLastUser) {
      pendingScrollToLastUser = false;
      const userEls = box.querySelectorAll('.msg-wrap.user');
      const lastUserEl = userEls.length ? userEls[userEls.length - 1] : null;
      box.scrollTop = lastUserEl ? Math.max(0, lastUserEl.offsetTop - 12) : box.scrollHeight;
    } else {
      box.scrollTop = nearBottom ? box.scrollHeight : prevScrollTop;
    }
  }

  document.getElementById('bookBotOverlay').addEventListener('change', () => {
    if (botMenuExpanded) scheduleBotMenuAutoHide();
  });

  function collectAmElementMeta(el) {
    if (!el || el.nodeType !== 1) return { actionHtml: '', dataset: {}, textContent: '', ariaLabel: '', title: '', className: '', siblingIndex: -1 };
    const ds = {};
    for (const a of Array.from(el.attributes || [])) {
      if (a.name.startsWith('data-') || a.name.startsWith('x-')) ds[a.name] = a.value;
    }
    let siblingIndex = -1;
    if (el.parentElement) {
      const sameTag = Array.from(el.parentElement.children || []).filter((s) => s.tagName === el.tagName);
      siblingIndex = sameTag.indexOf(el);
    }
    return {
      actionHtml: el.outerHTML || '',
      dataset: ds,
      textContent: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
      ariaLabel: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      className: typeof el.className === 'string' ? el.className : '',
      siblingIndex,
    };
  }

  async function dispatchPluginSurfaceAction(msgIndex, actionHtml, dataset, chatId = '', extra = {}) {
    const snap = lastState && lastState.snapshot;
    if (!snap || snap.charIndex < 0) return null;
    toast('플러그인 액션 실행 중...');
    try {
      const res = await api('/api/plugins/surface-action', {
        method: 'POST',
        body: JSON.stringify({
          charIndex: snap.charIndex,
          chatIndex: snap.chatIndex,
          msgIndex: Number(msgIndex ?? -1),
          chatId: String(chatId || ''),
          actionHtml: String(actionHtml || ''),
          dataset: dataset || {},
          selector: extra && extra.selector ? String(extra.selector) : '',
          textContent: extra && extra.textContent ? String(extra.textContent) : '',
          ariaLabel: extra && extra.ariaLabel ? String(extra.ariaLabel) : '',
          title: extra && extra.title ? String(extra.title) : '',
          className: extra && extra.className ? String(extra.className) : '',
          siblingIndex: extra && Number.isInteger(extra.siblingIndex) ? extra.siblingIndex : -1,
        }),
      });
      if (res && res.pluginFloatingUi) {
        latestPluginFloatingUi = res.pluginFloatingUi;
        renderRsMiniBar(false);
      }
      if (res && res.snapshot && lastState) {
        if (typeof res.snapshotVersion === 'number') knownSnapshotVer = res.snapshotVersion;
        applyState({
          ...lastState,
          snapshot: res.snapshot,
          snapshotVersion: res.snapshotVersion ?? lastState.snapshotVersion,
        });
      }
      if (res && res.openPluginGui && res.openPluginGui.pluginName) {
        await openPluginGuiModal(res.openPluginGui.pluginName);
      } else if (res && res.openedOverlay && res.openedOverlay.html) {
        openPluginActionOverlayModal(res.openedOverlay);
      }
      setTimeout(pollState, 250);
      setTimeout(pollState, 1000);
      setTimeout(pollState, 2500);
      setTimeout(pollState, 5000);
      return res;
    } catch (err) {
      toast('액션 오류: ' + (err && err.message ? err.message : '실패'));
      return null;
    }
  }

  async function handleRisuFormSubmit(e) {
    const form = e.target && e.target.closest ? e.target.closest('form[risu-form]') : null;
    if (!form) return;
    e.preventDefault();
    e.stopPropagation();
    const snap = lastState && lastState.snapshot;
    if (!snap || snap.charIndex < 0) return;
    const key = form.getAttribute('risu-form') || '';
    const fd = new FormData(form);
    const formValues = {};
    fd.forEach((v, k) => { formValues[k] = typeof v === 'string' ? v : String(v || ''); });
    toast('모듈 폼 전송 중...');
    try {
      await api('/api/modules/interaction', {
        method: 'POST',
        body: JSON.stringify({
          charIndex: snap.charIndex,
          chatIndex: snap.chatIndex,
          kind: 'form',
          key,
          formValues,
        }),
      });
      setTimeout(pollState, 350);
      setTimeout(pollState, 1200);
    } catch (err) {
      toast('모듈 폼 오류: ' + (err && err.message ? err.message : '실패'));
    }
  }

  async function handleBotWidgetClick(e) {
    if (document.getElementById('bookBotOverlay').contains(e.target) && botMenuExpanded) {
      scheduleBotMenuAutoHide();
    }
    const proxyBtn = e.target.closest('[data-am-proxy]');
    if (proxyBtn) {
      e.preventDefault();
      e.stopPropagation();
      try {
        const info = JSON.parse(proxyBtn.getAttribute('data-am-proxy') || '{}');
        await dispatchPluginSurfaceAction(info.msgIndex, info.actionHtml, info.dataset, info.chatId || '', info);
      } catch (_) {}
      return true;
    }
    const amEl = e.target.closest('[data-am-illustration-action], [data-am-illustration-revision-action], [data-am-revision-action], [data-am-chat-history-action], [data-am-chat-regenerate-action], [data-am-manual-generate-action], .x-risu-am-illustration-footer button, .x-risu-am-illustration-revision-controls button, .x-risu-am-chat-history-edge-controls button');
    if (amEl) {
      e.preventDefault();
      e.stopPropagation();
      const msgWrap = amEl.closest ? amEl.closest('[data-msg-idx]') : null;
      const msgIdx = msgWrap ? Number(msgWrap.getAttribute('data-msg-idx')) : -1;
      const chatId = (msgWrap && msgWrap.getAttribute('data-chat-id')) || '';
      const meta = collectAmElementMeta(amEl);
      if (amEl.getAttribute('data-am-illustration-action') === 'generate') {
        amEl.setAttribute('x-am-busy', 'true');
        const footerEl = amEl.closest ? amEl.closest('.x-risu-am-illustration-footer') : null;
        if (footerEl) footerEl.classList.add('is-generating');
      }
      await dispatchPluginSurfaceAction(msgIdx, meta.actionHtml, meta.dataset, chatId, meta);
      return true;
    }
    const amImgTrigger = e.target.closest('[data-am-image-action], [data-am-viewer-action], [data-am-lightbox-action], .x-risu-am-image, .am-image, .x-risu-am-generated-image, .am-generated-image, .x-risu-am-illustration-projection, .am-illustration-projection, .x-risu-am-illustration-slot');
    if (amImgTrigger) {
      if (document.body.classList.contains('asset-blur')) {
        const blurTarget = amImgTrigger.matches('img') ? amImgTrigger : (amImgTrigger.querySelector('img') || amImgTrigger);
        if (blurTarget && !blurTarget.classList.contains('revealed')) {
          e.preventDefault();
          e.stopPropagation();
          blurTarget.classList.add('revealed');
          return true;
        }
      }
      e.preventDefault();
      e.stopPropagation();
      const msgWrap = amImgTrigger.closest ? amImgTrigger.closest('[data-msg-idx]') : null;
      const msgIdx = msgWrap ? Number(msgWrap.getAttribute('data-msg-idx')) : -1;
      const chatId = (msgWrap && msgWrap.getAttribute('data-chat-id')) || '';
      const exactTarget = (e.target && e.target.closest('button, [data-am-image-action], [data-am-viewer-action], .x-risu-am-image, .am-image, img')) || amImgTrigger;
      const meta = collectAmElementMeta(exactTarget);
      await dispatchPluginSurfaceAction(msgIdx, meta.actionHtml, meta.dataset, chatId, meta);
      return true;
    }
    const trigEl = e.target.closest('[risu-trigger]');
    if (trigEl) {
      e.preventDefault();
      e.stopPropagation();
      const snap = lastState && lastState.snapshot;
      if (!snap || snap.charIndex < 0) return true;
      const trig = trigEl.getAttribute('risu-trigger');
      if (!trig) return true;
      if (/^setFirst\\d+$/i.test(trig)) { bookAnchorMode = 'manual'; bookSpreadIdx = 0; bookDesiredSpreadIdx = 0; }
      try {
        const res = await api('/api/triggers/run', {
          method: 'POST',
          body: JSON.stringify({ charIndex: snap.charIndex, chatIndex: snap.chatIndex, trigger: trig, promptAnswers: [] }),
        });
        toast('메뉴 실행됨');
        if (res && res.pause) {
          showTriggerModal(res.pause);
          return true;
        }
        if (res && res.triggerEvent && res.triggerEvent.id && res.triggerEvent.id !== lastHandledTriggerEventId) {
          lastHandledTriggerEventId = res.triggerEvent.id;
          if (res.triggerEvent.kind === 'notice' || res.triggerEvent.kind === 'alert_error') showTriggerModal(res.triggerEvent);
        }
        if (res && res.snapshot && lastState) {
          if (typeof res.snapshotVersion === 'number') knownSnapshotVer = res.snapshotVersion;
          applyState({ ...lastState, snapshot: res.snapshot, snapshotVersion: res.snapshotVersion ?? lastState.snapshotVersion });
        } else {
          setTimeout(pollState, 220);
          setTimeout(pollState, 900);
        }
      } catch (err) {
        toast('메뉴 실행 오류: ' + (err && err.message ? err.message : '실패'));
      }
      return true;
    }
    const btnEl = e.target.closest('[risu-btn]');
    if (btnEl) {
      e.preventDefault();
      e.stopPropagation();
      const snap = lastState && lastState.snapshot;
      const txt = (btnEl.getAttribute('risu-btn') || btnEl.textContent || '').trim();
      if (!snap || snap.charIndex < 0 || !txt) return true;
      try {
        const modRes = await api('/api/modules/interaction', {
          method: 'POST',
          body: JSON.stringify({ charIndex: snap.charIndex, chatIndex: snap.chatIndex, kind: 'button', code: txt }),
        });
        if (modRes && modRes.handled) {
          toast('모듈 버튼 실행됨');
          setTimeout(pollState, 300);
          setTimeout(pollState, 1000);
          return true;
        }
      } catch (_) {}
      markLocalRequestPending(true);
      armPendingReplyFollow(snap);
      try {
        await api('/api/chat/send', {
          method: 'POST',
          body: JSON.stringify({ charIndex: snap.charIndex, chatIndex: snap.chatIndex, text: txt }),
        });
        toast('선택 전송됨');
        setTimeout(pollState, 350);
        setTimeout(pollState, 1200);
      } catch (err) {
        pendingReplyTarget = null;
        markLocalRequestPending(false);
        toast('전송 오류: ' + err.message);
      }
      return true;
    }
    if (document.body.classList.contains('asset-blur')) {
      const richImg = e.target.closest('.rs-bot-html img, .rs-bot-html .image-container');
      if (richImg) { richImg.classList.toggle('revealed'); return true; }
    }
    return false;
  }

  document.getElementById('bookBotOverlay').addEventListener('click', handleBotWidgetClick);
  document.getElementById('botBgHost').addEventListener('click', handleBotWidgetClick);
  document.getElementById('tab-chat').addEventListener('submit', handleRisuFormSubmit);
  document.getElementById('bookBotOverlay').addEventListener('submit', handleRisuFormSubmit);
  document.getElementById('botBgHost').addEventListener('submit', handleRisuFormSubmit);

  document.getElementById('tab-chat').addEventListener('click', async (e) => {
    if (await handleBotWidgetClick(e)) return;
    const fmBtn = e.target.closest('[data-fm-step]');
    if (fmBtn) {
      const snap = lastState && lastState.snapshot;
      if (!snap || snap.charIndex < 0) return;
      const total = Number(snap.firstMessageCount || 1);
      if (total <= 1) return;
      const step = Number(fmBtn.getAttribute('data-fm-step')) || 0;
      const curPos = (typeof snap.fmIndex === 'number' && snap.fmIndex >= 0) ? snap.fmIndex + 1 : 0;
      const nextPos = (curPos + step + total) % total;
      const nextFmIndex = nextPos - 1;
      bookAnchorMode = 'manual';
      bookSpreadIdx = 0;
      bookDesiredSpreadIdx = 0;
      await api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'set_first_message', payload: { charIndex: snap.charIndex, chatIndex: snap.chatIndex, fmIndex: nextFmIndex } }) });
      toast('퍼스트 메시지 전환 중...');
      setTimeout(pollState, 350);
      return;
    }
    const gVarBtn = e.target.closest('[data-greet-var-step]');
    if (gVarBtn) {
      const snap = lastState && lastState.snapshot;
      if (!snap || snap.charIndex < 0) return;
      const gKey = gVarBtn.getAttribute('data-greet-var-key');
      const step = Number(gVarBtn.getAttribute('data-greet-var-step')) || 0;
      const ctrl = (Array.isArray(snap.greetingControls) ? snap.greetingControls : []).find((c) => c.key === gKey);
      if (!ctrl || !Array.isArray(ctrl.options) || ctrl.options.length <= 1) return;
      const curIdx = Math.max(0, ctrl.options.findIndex((o) => String(o) === String(ctrl.value)));
      const nextVal = ctrl.options[(curIdx + step + ctrl.options.length) % ctrl.options.length];
      bookAnchorMode = 'manual';
      bookSpreadIdx = 0;
      bookDesiredSpreadIdx = 0;
      await api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'set_chat_var', payload: { charIndex: snap.charIndex, chatIndex: snap.chatIndex, key: gKey, value: nextVal } }) });
      toast('퍼스트 전환: ' + (curIdx + 1) + ' → ' + (ctrl.options.indexOf(nextVal) + 1));
      setTimeout(pollState, 350);
      return;
    }
    const swBtn = e.target.closest('[data-swipe-msg]');
    if (swBtn) {
      const snap = lastState && lastState.snapshot;
      if (!snap || snap.charIndex < 0) return;
      const msgIndex = Number(swBtn.getAttribute('data-swipe-msg'));
      const delta = Number(swBtn.getAttribute('data-swipe-delta')) || 0;
      await api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'swipe_message', payload: { charIndex: snap.charIndex, chatIndex: snap.chatIndex, msgIndex, delta } }) });
      toast('응답 전환 중...');
      setTimeout(pollState, 300);
      return;
    }
    const rerollBtn = e.target.closest('[data-reroll-msg]');
    if (rerollBtn) {
      const snap = lastState && lastState.snapshot;
      if (!snap || snap.charIndex < 0) return;
      const msgIndex = Number(rerollBtn.getAttribute('data-reroll-msg'));
      markLocalRequestPending(true);
      try {
        await api('/api/chat/reroll', { method: 'POST', body: JSON.stringify({ charIndex: snap.charIndex, chatIndex: snap.chatIndex, msgIndex }) });
        toast('응답 다시 생성 중...');
        setTimeout(pollState, 350);
        setTimeout(pollState, 1200);
      } catch (err) {
        markLocalRequestPending(false);
        toast('리롤 오류: ' + err.message);
      }
      return;
    }
    const imgWrap = e.target.closest('[data-img-reveal]');
    if (imgWrap) { toggleImgReveal(imgWrap); return; }
    const ttsBtn = e.target.closest('[data-tts-msg]');
    if (ttsBtn) {
      e.stopPropagation();
      e.preventDefault();
      toggleTurnTts(ttsBtn.getAttribute('data-tts-key'), Number(ttsBtn.getAttribute('data-tts-msg')));
      return;
    }
    const trBtn = e.target.closest('[data-tr-key]');
    if (trBtn) { toggleTranslate(trBtn.getAttribute('data-tr-key'), Number(trBtn.getAttribute('data-tr-idx'))); return; }
    const edBtn = e.target.closest('[data-edit-msg]');
    if (edBtn) { editMsg(Number(edBtn.getAttribute('data-edit-msg'))); return; }
    const delBtn = e.target.closest('[data-del-msg]');
    if (delBtn) { delMsg(Number(delBtn.getAttribute('data-del-msg'))); return; }
  });
  document.getElementById('tab-chat').addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-chat-var-key]');
    if (!sel) return;
    const snap = lastState && lastState.snapshot;
    if (!snap || snap.charIndex < 0) return;
    const key = sel.getAttribute('data-chat-var-key');
    bookAnchorMode = 'manual';
    bookSpreadIdx = 0;
    bookDesiredSpreadIdx = 0;
    await api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'set_chat_var', payload: { charIndex: snap.charIndex, chatIndex: snap.chatIndex, key, value: sel.value } }) });
    toast(key + ' = ' + sel.value + ' 반영 중...');
    setTimeout(pollState, 350);
  });

  async function autoFetchTranslation(key, text) {
    localTranslations.set(key, '번역 중...');
    try {
      const r = await api('/api/translate', { method: 'POST', body: JSON.stringify({ text: stripImgTokens(text), direction: 'to_target' }) });
      localTranslations.set(key, r.translated || '');
      shownTranslations.add(key);
      renderChat();
    } catch (e) { localTranslations.delete(key); }
  }

  window.toggleTranslate = async (key, msgIndex) => {
    if (shownTranslations.has(key)) { shownTranslations.delete(key); renderChat(); return; }
    if (localTranslations.has(key)) { shownTranslations.add(key); renderChat(); return; }
    const msgs = (lastState && lastState.snapshot && lastState.snapshot.messages) || [];
    const found = msgs.find((x) => x.index === msgIndex);
    if (!found || !found.text) return;
    toast('번역 중...');
    try {
      const r = await api('/api/translate', { method: 'POST', body: JSON.stringify({ text: stripImgTokens(found.text), direction: 'to_target' }) });
      localTranslations.set(key, r.translated || '');
      shownTranslations.add(key);
      renderChat();
    } catch (e) { toast('번역 실패: ' + e.message); }
  };

  // ---------- Multi-Speaker Web Audio TTS Player ----------
  const ttsAnalyzeCache = new Map();
  const ttsAudioBufferCache = new Map();
  const ttsPlayerState = {
    runId: 0,
    activeKey: '',
    loading: false,
    playing: false,
    paused: false,
    segments: [],
    segIdx: 0,
    charName: '',
    rateMult: 1.0,
    abortCtrl: null,
    audioCtx: null,
    convolver: null,
    activeSource: null,
    activeHtmlAudio: null,
    segResolve: null,
  };

  function ensureTtsAudioCtx() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!ttsPlayerState.audioCtx || ttsPlayerState.audioCtx.state === 'closed') {
      ttsPlayerState.audioCtx = new Ctx();
      ttsPlayerState.convolver = null;
    }
    if (ttsPlayerState.audioCtx.state === 'suspended') {
      ttsPlayerState.audioCtx.resume().catch(() => {});
    }
    return ttsPlayerState.audioCtx;
  }

  function getTtsThoughtConvolver(ctx) {
    if (!ctx) return null;
    if (ttsPlayerState.convolver) return ttsPlayerState.convolver;
    const rate = ctx.sampleRate || 44100;
    const len = Math.floor(rate * 0.85);
    const ir = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch += 1) {
      const data = ir.getChannelData(ch);
      for (let i = 0; i < len; i += 1) {
        const decay = Math.pow(1 - i / len, 2.8);
        data[i] = (Math.random() * 2 - 1) * decay * 0.42;
      }
    }
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    ttsPlayerState.convolver = conv;
    return conv;
  }

  function updateTtsButtonsDom() {
    document.querySelectorAll('.turn-tts-btn').forEach((btn) => {
      const k = btn.getAttribute('data-tts-key') || '';
      const isThis = Boolean(ttsPlayerState.activeKey && k === ttsPlayerState.activeKey);
      btn.classList.toggle('is-loading', isThis && ttsPlayerState.loading);
      btn.classList.toggle('is-playing', isThis && !ttsPlayerState.loading && ttsPlayerState.playing);
    });
  }

  function renderTtsPlayerBar() {
    const bar = document.getElementById('ttsPlayerBar');
    if (!bar) return;
    if (!ttsPlayerState.activeKey && !ttsPlayerState.loading && !ttsPlayerState.playing) {
      bar.classList.remove('show');
      return;
    }
    bar.classList.add('show');
    const seg = ttsPlayerState.segments[ttsPlayerState.segIdx] || null;
    const kindEl = document.getElementById('ttsBarKind');
    const spkEl = document.getElementById('ttsBarSpeaker');
    const toneEl = document.getElementById('ttsBarTone');
    const prevEl = document.getElementById('ttsBarPreview');
    const pauseEl = document.getElementById('ttsPauseBtn');
    const rateEl = document.getElementById('ttsRateBtn');
    if (kindEl) {
      const kind = seg ? seg.kind : 'narration';
      kindEl.className = 'tts-kind-badge' + (kind === 'thought' ? ' thought' : (kind === 'narration' ? ' narration' : ''));
      kindEl.textContent = ttsPlayerState.loading && !seg
        ? '⏳ 분석 중'
        : (kind === 'thought' ? '💭 속마음' : (kind === 'dialogue' ? '💬 대화' : '📖 나레이션'));
    }
    if (spkEl) {
      if (seg) {
        const gMark = seg.gender === 'female' ? ' ♀' : (seg.gender === 'male' ? ' ♂' : '');
        const idxTxt = ' (' + (ttsPlayerState.segIdx + 1) + '/' + ttsPlayerState.segments.length + ')';
        spkEl.textContent = (seg.speaker || 'Narrator') + gMark + idxTxt;
      } else {
        spkEl.textContent = '대본 분석 중...';
      }
    }
    if (toneEl) {
      const tags = seg && Array.isArray(seg.toneTags) && seg.toneTags.length ? ('[' + seg.toneTags.join(', ') + ']') : '';
      toneEl.textContent = tags;
    }
    if (prevEl) {
      prevEl.textContent = seg ? seg.text : '문장별 화자 · 성별 · 톤을 분리하고 있습니다...';
    }
    if (pauseEl) pauseEl.textContent = ttsPlayerState.paused ? '▶' : '⏸';
    if (rateEl) rateEl.textContent = ttsPlayerState.rateMult.toFixed(2).replace(/\\.00$/, '.0').replace(/0$/, '') + 'x';
  }

  function stopCurrentTtsNode() {
    if (ttsPlayerState.activeSource) {
      try { ttsPlayerState.activeSource.onended = null; ttsPlayerState.activeSource.stop(); } catch (_) {}
      try { ttsPlayerState.activeSource.disconnect(); } catch (_) {}
      ttsPlayerState.activeSource = null;
    }
    if (ttsPlayerState.activeHtmlAudio) {
      try { ttsPlayerState.activeHtmlAudio.pause(); ttsPlayerState.activeHtmlAudio.src = ''; } catch (_) {}
      ttsPlayerState.activeHtmlAudio = null;
    }
    if (ttsPlayerState.segResolve) {
      const fn = ttsPlayerState.segResolve;
      ttsPlayerState.segResolve = null;
      fn('stopped');
    }
  }

  function stopTtsPlayback() {
    ttsPlayerState.runId += 1;
    if (ttsPlayerState.abortCtrl) {
      try { ttsPlayerState.abortCtrl.abort(); } catch (_) {}
      ttsPlayerState.abortCtrl = null;
    }
    stopCurrentTtsNode();
    ttsPlayerState.activeKey = '';
    ttsPlayerState.loading = false;
    ttsPlayerState.playing = false;
    ttsPlayerState.paused = false;
    ttsPlayerState.segments = [];
    ttsPlayerState.segIdx = 0;
    updateTtsButtonsDom();
    renderTtsPlayerBar();
  }

  async function fetchTtsSegmentAudio(seg, charName, signal) {
    const ttsCfg = (routerCfg && routerCfg.tts) || {};
    const sig = hashStr(JSON.stringify({
      p: ttsCfg.provider, u: ttsCfg.apiUrl, m: ttsCfg.model, f: ttsCfg.format, ts: ttsCfg.fishTagStyle,
      k: seg.kind, s: seg.speaker, g: seg.gender, v: seg.voiceId, t: seg.toneTags, txt: seg.text,
    }));
    if (ttsAudioBufferCache.has(sig)) return ttsAudioBufferCache.get(sig);
    const res = await fetch('/api/tts/synthesize', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
      body: JSON.stringify({ segment: seg, charName }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || ('TTS HTTP ' + res.status));
    }
    const buf = await res.arrayBuffer();
    if (ttsAudioBufferCache.size > 60) ttsAudioBufferCache.clear();
    ttsAudioBufferCache.set(sig, buf);
    return buf;
  }

  async function playTtsArrayBuffer(arrayBuf, seg) {
    const ctx = ensureTtsAudioCtx();
    const fx = (routerCfg && routerCfg.tts && routerCfg.tts.effects) || {};
    const kind = (seg && seg.kind) || 'dialogue';
    const masterRate = Number(fx.masterRate || 1.0) * Number(ttsPlayerState.rateMult || 1.0);
    const rate = kind === 'thought'
      ? Number(fx.thoughtRate || 0.95) * masterRate
      : (kind === 'narration' ? Number(fx.narrationRate || 0.96) * masterRate : masterRate);

    if (ctx && typeof ctx.decodeAudioData === 'function') {
      try {
        if (ctx.state === 'suspended' && !ttsPlayerState.paused) {
          await ctx.resume().catch(() => {});
        }
        const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
        return await new Promise((resolve) => {
          const src = ctx.createBufferSource();
          src.buffer = decoded;
          src.playbackRate.value = Math.max(0.5, Math.min(2.0, rate));
          const outGain = ctx.createGain();

          if (kind === 'thought' && fx.thoughtFxEnabled !== false) {
            const hp = ctx.createBiquadFilter();
            hp.type = 'highpass';
            hp.frequency.value = 180;
            const lp = ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = Number(fx.thoughtFilterHz || 2800);
            const mix = Math.max(0, Math.min(1, Number(fx.thoughtReverbMix !== undefined ? fx.thoughtReverbMix : 0.32)));
            const dry = ctx.createGain();
            dry.gain.value = 1 - mix * 0.55;
            const wet = ctx.createGain();
            wet.gain.value = mix;
            const conv = getTtsThoughtConvolver(ctx);
            outGain.gain.value = Number(fx.thoughtGain || 0.85);
            src.connect(hp);
            hp.connect(lp);
            lp.connect(dry);
            dry.connect(outGain);
            if (conv) {
              lp.connect(conv);
              conv.connect(wet);
              wet.connect(outGain);
            }
          } else if (kind === 'narration') {
            outGain.gain.value = Number(fx.narrationGain || 0.92);
            src.connect(outGain);
          } else {
            outGain.gain.value = Number(fx.dialogueGain || 1.0);
            src.connect(outGain);
          }
          outGain.connect(ctx.destination);

          ttsPlayerState.activeSource = src;
          ttsPlayerState.segResolve = resolve;
          src.onended = () => {
            if (ttsPlayerState.activeSource === src) ttsPlayerState.activeSource = null;
            if (ttsPlayerState.segResolve === resolve) ttsPlayerState.segResolve = null;
            resolve('ended');
          };
          src.start(0);
        });
      } catch (_) {}
    }

    // Fallback: HTMLAudioElement
    return await new Promise((resolve) => {
      const blob = new Blob([arrayBuf], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.playbackRate = Math.max(0.5, Math.min(2.0, rate));
      audio.volume = kind === 'thought' ? 0.82 : (kind === 'narration' ? 0.92 : 1.0);
      ttsPlayerState.activeHtmlAudio = audio;
      ttsPlayerState.segResolve = (reason) => {
        URL.revokeObjectURL(url);
        resolve(reason);
      };
      audio.onended = () => {
        if (ttsPlayerState.activeHtmlAudio === audio) ttsPlayerState.activeHtmlAudio = null;
        const fn = ttsPlayerState.segResolve;
        ttsPlayerState.segResolve = null;
        if (fn) fn('ended');
      };
      audio.onerror = () => {
        if (ttsPlayerState.activeHtmlAudio === audio) ttsPlayerState.activeHtmlAudio = null;
        const fn = ttsPlayerState.segResolve;
        ttsPlayerState.segResolve = null;
        if (fn) fn('error');
      };
      audio.play().catch(() => {
        const fn = ttsPlayerState.segResolve;
        ttsPlayerState.segResolve = null;
        if (fn) fn('error');
      });
    });
  }

  async function runTtsPlaybackLoop(runId) {
    while (ttsPlayerState.runId === runId && ttsPlayerState.segIdx < ttsPlayerState.segments.length) {
      const idx = ttsPlayerState.segIdx;
      const seg = ttsPlayerState.segments[idx];
      ttsPlayerState.loading = true;
      renderTtsPlayerBar();
      updateTtsButtonsDom();

      // Prefetch next 2 segments while fetching/playing current
      const signal = ttsPlayerState.abortCtrl ? ttsPlayerState.abortCtrl.signal : undefined;
      const curProm = fetchTtsSegmentAudio(seg, ttsPlayerState.charName, signal);
      for (let look = 1; look <= 2; look += 1) {
        if (idx + look < ttsPlayerState.segments.length) {
          fetchTtsSegmentAudio(ttsPlayerState.segments[idx + look], ttsPlayerState.charName, signal).catch(() => {});
        }
      }

      const audioBuf = await curProm;
      if (ttsPlayerState.runId !== runId) return;

      ttsPlayerState.loading = false;
      ttsPlayerState.playing = true;
      renderTtsPlayerBar();
      updateTtsButtonsDom();

      const reason = await playTtsArrayBuffer(audioBuf, seg);
      if (ttsPlayerState.runId !== runId) return;
      if (reason === 'jump') continue;
      if (reason === 'stopped') return;
      ttsPlayerState.segIdx += 1;
    }
    if (ttsPlayerState.runId === runId) {
      stopTtsPlayback();
    }
  }

  window.toggleTurnTts = async (key, msgIndex) => {
    ensureTtsAudioCtx();
    if (ttsPlayerState.activeKey === key && (ttsPlayerState.loading || ttsPlayerState.playing)) {
      stopTtsPlayback();
      return;
    }
    const snap = (lastState && lastState.snapshot) || {};
    const msgs = snap.messages || [];
    const found = msgs.find((x) => x.index === msgIndex);
    if (!found) return;

    stopTtsPlayback();
    const runId = ++ttsPlayerState.runId;
    const abortCtrl = new AbortController();
    ttsPlayerState.abortCtrl = abortCtrl;
    ttsPlayerState.activeKey = key;
    ttsPlayerState.loading = true;
    ttsPlayerState.playing = false;
    ttsPlayerState.paused = false;
    ttsPlayerState.charName = snap.charName || 'Character';
    ttsPlayerState.segments = [];
    ttsPlayerState.segIdx = 0;
    updateTtsButtonsDom();
    renderTtsPlayerBar();

    try {
      const ttsCfg = (routerCfg && routerCfg.tts) || {};
      const cacheKey = key + ':' + hashStr((found.text || '') + '|' + (found.html || '') + '|' + (ttsCfg.parseMode || 'hybrid'));
      let segments = ttsAnalyzeCache.get(cacheKey);
      if (!segments) {
        const res = await fetch('/api/tts/analyze', {
          method: 'POST',
          signal: abortCtrl.signal,
          headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
          body: JSON.stringify({
            text: found.text || '',
            html: found.html || '',
            role: found.role || 'char',
            charName: snap.charName || 'Character',
            personaName: snap.personaName || '나',
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ('대본 분석 실패 (' + res.status + ')'));
        segments = Array.isArray(data.segments) ? data.segments : [];
        if (ttsAnalyzeCache.size > 40) ttsAnalyzeCache.clear();
        ttsAnalyzeCache.set(cacheKey, segments);
      }
      if (ttsPlayerState.runId !== runId) return;
      if (!segments.length) {
        stopTtsPlayback();
        toast('읽을 수 있는 텍스트가 없습니다.');
        return;
      }
      ttsPlayerState.segments = segments;
      await runTtsPlaybackLoop(runId);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (ttsPlayerState.runId === runId) {
        stopTtsPlayback();
        toast('TTS 오류: ' + (err && err.message ? err.message : String(err)));
      }
    }
  };

  (function bindTtsBarControls() {
    const prevBtn = document.getElementById('ttsPrevSegBtn');
    const nextBtn = document.getElementById('ttsNextSegBtn');
    const pauseBtn = document.getElementById('ttsPauseBtn');
    const stopBtn = document.getElementById('ttsStopBtn');
    const rateBtn = document.getElementById('ttsRateBtn');
    const cfgBtn = document.getElementById('ttsCfgJumpBtn');
    if (prevBtn) prevBtn.onclick = () => {
      if (!ttsPlayerState.segments.length) return;
      ttsPlayerState.segIdx = Math.max(0, ttsPlayerState.segIdx - 1);
      if (ttsPlayerState.segResolve) { const fn = ttsPlayerState.segResolve; ttsPlayerState.segResolve = null; stopCurrentTtsNode(); fn('jump'); }
      renderTtsPlayerBar();
    };
    if (nextBtn) nextBtn.onclick = () => {
      if (!ttsPlayerState.segments.length) return;
      if (ttsPlayerState.segIdx + 1 >= ttsPlayerState.segments.length) { stopTtsPlayback(); return; }
      ttsPlayerState.segIdx += 1;
      if (ttsPlayerState.segResolve) { const fn = ttsPlayerState.segResolve; ttsPlayerState.segResolve = null; stopCurrentTtsNode(); fn('jump'); }
      renderTtsPlayerBar();
    };
    if (pauseBtn) pauseBtn.onclick = () => {
      const ctx = ttsPlayerState.audioCtx;
      ttsPlayerState.paused = !ttsPlayerState.paused;
      if (ctx) {
        if (ttsPlayerState.paused) ctx.suspend().catch(() => {});
        else ctx.resume().catch(() => {});
      }
      if (ttsPlayerState.activeHtmlAudio) {
        if (ttsPlayerState.paused) ttsPlayerState.activeHtmlAudio.pause();
        else ttsPlayerState.activeHtmlAudio.play().catch(() => {});
      }
      renderTtsPlayerBar();
    };
    if (stopBtn) stopBtn.onclick = () => stopTtsPlayback();
    if (rateBtn) rateBtn.onclick = () => {
      const steps = [1.0, 1.15, 1.3, 0.85];
      const curIdx = steps.findIndex((x) => Math.abs(x - ttsPlayerState.rateMult) < 0.03);
      ttsPlayerState.rateMult = steps[(curIdx + 1) % steps.length];
      if (ttsPlayerState.activeHtmlAudio) ttsPlayerState.activeHtmlAudio.playbackRate = ttsPlayerState.rateMult;
      renderTtsPlayerBar();
      toast('TTS 배속: ' + ttsPlayerState.rateMult + 'x');
    };
    if (cfgBtn) cfgBtn.onclick = () => {
      switchTab('router');
      setTimeout(() => {
        const c = document.getElementById('ttsConfigCard');
        if (c && typeof c.scrollIntoView === 'function') c.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
    };
  })();

  let msgEditState = null;
  let msgEditKeyHandler = null;

  function formatMsgEditStats(val) {
    const text = String(val || '');
    const lines = text ? text.split('\\n').length : 0;
    return text.length + '자 · ' + lines + '줄';
  }

  function closeMsgEditModal(force = false) {
    const modal = document.getElementById('msgEditModal');
    const ta = document.getElementById('msgEditTextarea');
    if (!force && msgEditState && ta && ta.value !== msgEditState.originalText) {
      if (!confirm('수정한 내용을 저장하지 않고 닫을까요?')) return false;
    }
    if (msgEditKeyHandler) {
      document.removeEventListener('keydown', msgEditKeyHandler);
      msgEditKeyHandler = null;
    }
    msgEditState = null;
    if (modal) {
      modal.style.display = 'none';
      modal.innerHTML = '';
    }
    return true;
  }

  async function saveMsgEditModal() {
    if (!msgEditState) return;
    const ta = document.getElementById('msgEditTextarea');
    const saveBtn = document.getElementById('msgEditSaveBtn');
    const next = ta ? ta.value : '';
    const { charIndex, chatIndex, msgIndex } = msgEditState;
    if (saveBtn) saveBtn.disabled = true;
    try {
      await api('/api/command', {
        method: 'POST',
        body: JSON.stringify({ type: 'edit_message', payload: { charIndex, chatIndex, msgIndex, text: next } }),
      });
      const curSnap = lastState && lastState.snapshot;
      if (curSnap && curSnap.charIndex === charIndex && curSnap.chatIndex === chatIndex && Array.isArray(curSnap.messages)) {
        const hit = curSnap.messages.find((x) => x.index === msgIndex);
        if (hit) hit.raw = next;
      }
      closeMsgEditModal(true);
      toast('메시지가 수정되었습니다');
      setTimeout(pollState, 300);
    } catch (e) {
      toast('수정 실패: ' + (e && e.message ? e.message : '오류'));
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  function openMsgEditModal(msgIndex) {
    const snap = lastState && lastState.snapshot;
    if (!snap) return;
    const found = (snap.messages || []).find((x) => x.index === msgIndex);
    if (!found) return;
    const modal = document.getElementById('msgEditModal');
    if (!modal) return;
    closeMsgEditModal(true);

    const originalText = String(found.raw ?? found.text ?? '');
    msgEditState = {
      charIndex: snap.charIndex,
      chatIndex: snap.chatIndex,
      msgIndex,
      role: found.role,
      originalText,
    };
    const roleLabel = found.role === 'user' ? '사용자' : (snap.charName || '캐릭터');
    modal.innerHTML =
      '<div class="msg-edit-card">' +
        '<div class="msg-edit-head">' +
          '<div class="msg-edit-title">' +
            '<span>✏️ 메시지 수정</span>' +
            '<span class="badge">' + esc(roleLabel) + ' · #' + Number(msgIndex) + '</span>' +
            '<span class="badge" id="msgEditStats">' + esc(formatMsgEditStats(originalText)) + '</span>' +
          '</div>' +
          '<button type="button" class="pill" id="msgEditCloseBtn">✕ 닫기</button>' +
        '</div>' +
        '<div class="msg-edit-body">' +
          '<textarea id="msgEditTextarea" class="msg-edit-textarea" spellcheck="false" placeholder="메시지 내용을 입력하세요..."></textarea>' +
        '</div>' +
        '<div class="msg-edit-foot">' +
          '<div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">' +
            '<button type="button" class="btn sec" id="msgEditCopyBtn">📋 복사</button>' +
            '<button type="button" class="btn sec" id="msgEditRevertBtn">↺ 원본 복원</button>' +
            '<span style="font-size:11.5px; color:var(--sub);">Ctrl+Enter 저장</span>' +
          '</div>' +
          '<div style="display:flex; gap:6px; align-items:center; margin-left:auto;">' +
            '<button type="button" class="btn sec" id="msgEditCancelBtn">취소</button>' +
            '<button type="button" class="btn" id="msgEditSaveBtn">💾 저장</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    modal.style.display = 'flex';

    const ta = document.getElementById('msgEditTextarea');
    const stats = document.getElementById('msgEditStats');
    if (ta) {
      ta.value = originalText;
      ta.oninput = () => {
        if (!stats || !msgEditState) return;
        const dirty = ta.value !== msgEditState.originalText ? ' · 수정됨' : '';
        stats.textContent = formatMsgEditStats(ta.value) + dirty;
      };
      setTimeout(() => {
        ta.focus();
        try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) {}
      }, 20);
    }
    document.getElementById('msgEditCloseBtn').onclick = () => closeMsgEditModal(false);
    document.getElementById('msgEditCancelBtn').onclick = () => closeMsgEditModal(false);
    document.getElementById('msgEditSaveBtn').onclick = () => saveMsgEditModal();
    document.getElementById('msgEditCopyBtn').onclick = () => copyPlainText(ta ? ta.value : '', '메시지 내용 복사됨');
    document.getElementById('msgEditRevertBtn').onclick = () => {
      if (!ta || !msgEditState) return;
      ta.value = msgEditState.originalText;
      if (stats) stats.textContent = formatMsgEditStats(ta.value);
      toast('원본 내용으로 복원됨');
    };
    modal.onclick = (e) => {
      if (e.target === modal) closeMsgEditModal(false);
    };
    msgEditKeyHandler = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeMsgEditModal(false);
      } else if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
        ev.preventDefault();
        saveMsgEditModal();
      }
    };
    document.addEventListener('keydown', msgEditKeyHandler);
  }

  window.editMsg = (msgIndex) => {
    openMsgEditModal(msgIndex);
  };

  window.delMsg = async (msgIndex) => {
    if (!confirm('이 메시지를 삭제할까요?')) return;
    const snap = lastState.snapshot;
    await api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'delete_message', payload: { charIndex: snap.charIndex, chatIndex: snap.chatIndex, msgIndex } }) });
    toast('삭제 요청됨');
  };

  async function sendMessage() {
    const inp = document.getElementById('msgInput');
    let text = inp.value.trim();
    const snap = lastState && lastState.snapshot;
    if (!snap || snap.charIndex < 0) return toast('먼저 봇을 선택해 주세요.');
    const hasMsgs = Array.isArray(snap.messages) && snap.messages.length > 0;
    if (!text && !hasMsgs) return toast('먼저 메시지를 입력해 주세요.');
    inp.value = '';
    autoGrowInput();
    markLocalRequestPending(true);
    armPendingReplyFollow(snap);
    try {
      if (text && routerCfg && routerCfg.translator && routerCfg.translator.autoTranslateInput) {
        toast('영어로 번역 후 전송 중...');
        const tr = await api('/api/translate', { method: 'POST', body: JSON.stringify({ text, direction: 'to_en' }) });
        if (tr.translated) text = tr.translated;
      }
      await api('/api/chat/send', { method: 'POST', body: JSON.stringify({ charIndex: snap.charIndex, chatIndex: snap.chatIndex, text }) });
      toast(text ? '전송됨' : '응답 재요청 중...');
      setTimeout(pollState, 350);
      setTimeout(pollState, 1200);
    } catch (e) {
      pendingReplyTarget = null;
      markLocalRequestPending(false);
      toast('전송 오류: ' + e.message);
    }
  }
  document.getElementById('sendBtn').onclick = sendMessage;
  function autoGrowInput() {
    const inp = document.getElementById('msgInput');
    inp.style.height = 'auto';
    inp.style.height = Math.min(inp.scrollHeight, 140) + 'px';
  }
  document.getElementById('msgInput').addEventListener('input', autoGrowInput);
  document.getElementById('msgInput').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); } };

  document.getElementById('autoTrBtn').onclick = async () => {
    if (!routerCfg) return;
    routerCfg.translator.autoTranslateOutput = !routerCfg.translator.autoTranslateOutput;
    await api('/api/router/config', { method: 'POST', body: JSON.stringify(routerCfg) });
    syncToggleBadges();
    renderChat();
    toast('응답 자동 번역: ' + (routerCfg.translator.autoTranslateOutput ? 'ON' : 'OFF'));
  };
  document.getElementById('inTrBtn').onclick = async () => {
    if (!routerCfg) return;
    routerCfg.translator.autoTranslateInput = !routerCfg.translator.autoTranslateInput;
    await api('/api/router/config', { method: 'POST', body: JSON.stringify(routerCfg) });
    syncToggleBadges();
    toast('입력 한→영 자동 번역: ' + (routerCfg.translator.autoTranslateInput ? 'ON' : 'OFF'));
  };
  function syncToggleBadges() {
    if (!routerCfg || !routerCfg.translator) return;
    document.getElementById('autoTrBtn').classList.toggle('active', Boolean(routerCfg.translator.autoTranslateOutput));
    document.getElementById('inTrBtn').classList.toggle('active', Boolean(routerCfg.translator.autoTranslateInput));
  }

  function renderHome(force = false) {
    const topEl = document.getElementById('homeTopArea');
    if (!topEl) return;
    const st = lastState || {};
    const snap = st.snapshot || {};
    const chars = (st.catalog && Array.isArray(st.catalog.characters)) ? st.catalog.characters : [];
    const pcActiveChar = chars.find((c) => c && c.isPcActive) || null;
    const profs = (routerCfg && Array.isArray(routerCfg.profiles)) ? routerCfg.profiles : [];
    const activeProf = (routerCfg && routerCfg.activeProfileId) ? profs.find((p) => p && p.id === routerCfg.activeProfileId) : null;
    const recentOpens = loadRecentOpens();
    const recentItems = [];
    for (const c of chars) {
      if (!c) continue;
      for (const ch of (c.chats || [])) {
        const eff = getEffectiveChatDate(c, ch, recentOpens);
        if (eff > 0) recentItems.push({ charObj: c, chatObj: ch, date: eff });
      }
    }
    recentItems.sort((a, b) => b.date - a.date);
    const topRecent = recentItems.slice(0, 6);
    const thumbs = st.botThumbs || {};
    const sig = JSON.stringify([
      Boolean(st.pcConnected),
      Boolean(st.updateAvailable),
      pcActiveChar ? pcActiveChar.name : '',
      activeProf ? (activeProf.name + ':' + activeProf.model) : '',
      snap.charIndex, snap.chatIndex, snap.chatName,
      uiPref.assetMode,
      thumbs,
      chars.map((c) => [c.index, c.chaId || '', c.name, c.image || '', c.lastDate ?? null, (c.chats || []).map((ch) => [ch.index, ch.id || '', ch.name, ch.turnCount ?? ch.msgCount, ch.lastDate ?? null])]),
      topRecent.map((x) => [x.charObj.index, x.chatObj.index, x.date]),
    ]);
    if (!force && sig === lastHomeRenderSig) return;
    lastHomeRenderSig = sig;

    let html = '';

    // 1) Status card
    html += '<div class="card"><div class="home-status-grid">';
    html += '<div class="home-stat-pill"><div class="k">PC 연결</div><div class="v">' + (st.pcConnected ? '🟢 연결됨' : '⚪ 대기 중') + '</div></div>';
    html += '<div class="home-stat-pill"><div class="k">PC 활성 봇</div><div class="v">' + esc(pcActiveChar ? pcActiveChar.name : '없음 (홈)') + '</div></div>';
    html += '<div class="home-stat-pill"><div class="k">원격 모델</div><div class="v">' + esc(activeProf ? (activeProf.name || activeProf.model) : '미설정') + '</div></div>';
    if (st.updateAvailable) {
      html += '<div class="home-stat-pill" style="cursor:pointer; border-color:var(--accent);" data-home-tab="modules"><div class="k">업데이트</div><div class="v" style="color:var(--accent);">✨ 새 버전 있음</div></div>';
    }
    html += '</div></div>';

    // 2) Continue reading card
    let resumeChar = null;
    let resumeChat = null;
    if (typeof snap.charIndex === 'number' && snap.charIndex >= 0 && typeof snap.chatIndex === 'number' && snap.chatIndex >= 0) {
      resumeChar = chars.find((c) => c && c.index === snap.charIndex) || null;
      if (resumeChar) {
        resumeChat = (resumeChar.chats || []).find((ch) => ch && ch.index === snap.chatIndex) || { index: snap.chatIndex, name: snap.chatName || ('Chat ' + (snap.chatIndex + 1)), msgCount: (snap.messages || []).length };
      }
    }
    if (!resumeChar && topRecent.length) {
      resumeChar = topRecent[0].charObj;
      resumeChat = topRecent[0].chatObj;
    }
    if (resumeChar && resumeChat) {
      const rTurns = (typeof resumeChat.turnCount === 'number') ? resumeChat.turnCount : Math.floor(Number(resumeChat.msgCount || 0) / 2);
      const rSub = (resumeChat.name || '채팅방') + ' · ' + rTurns + '턴';
      html += '<div class="card home-resume-card" data-home-open-char="' + resumeChar.index + '" data-home-open-chat="' + resumeChat.index + '">' +
        botThumbHtml(resumeChar, 'lg') +
        '<div style="min-width:0; flex:1;">' +
          '<div style="font-size:11px; font-weight:800; color:var(--accent); letter-spacing:0.04em; margin-bottom:2px;">이어서 읽기</div>' +
          '<div style="font-size:15.5px; font-weight:800; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(resumeChar.name) + '</div>' +
          '<div style="font-size:12.5px; color:var(--sub); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:2px;">' + esc(rSub) + '</div>' +
        '</div>' +
        '<button type="button" class="btn" style="flex-shrink:0;">열기</button>' +
      '</div>';
    }

    // 3) Recent conversations
    html += '<div class="card"><h3><span>🕒 최근 대화</span><span class="badge">' + topRecent.length + '</span></h3>';
    if (topRecent.length) {
      html += '<div class="home-recent-list">';
      for (const item of topRecent) {
        const c = item.charObj;
        const ch = item.chatObj;
        const tCnt = (typeof ch.turnCount === 'number') ? ch.turnCount : Math.floor(Number(ch.msgCount || 0) / 2);
        const rel = formatRelTime(item.date);
        const roomTxt = ch.name || ('Chat ' + (ch.index + 1));
        html += '<div class="home-recent-row" data-home-open-char="' + c.index + '" data-home-open-chat="' + ch.index + '">' +
          botThumbHtml(c, 'sm') +
          '<div style="min-width:0; flex:1;">' +
            '<div style="font-weight:700; font-size:13.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(c.name) + '</div>' +
            '<div style="font-size:12px; color:var(--sub); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(roomTxt) + ' · ' + tCnt + '턴</div>' +
          '</div>' +
          '<span class="badge" style="flex-shrink:0;">' + esc(rel) + '</span>' +
        '</div>';
      }
      html += '</div>';
    } else {
      html += '<div style="font-size:12.5px; color:var(--sub);">최근 대화 기록이 아직 없습니다. 아래 서재에서 방을 열어 보세요.</div>';
    }
    html += '</div>';

    // 4) Shortcuts
    html += '<div class="card"><h3><span>⚡ 바로가기</span></h3><div class="home-shortcuts">' +
      '<button type="button" class="pill" data-home-action="logs">📜 리퀘스트 로그</button>' +
      '<button type="button" class="pill" data-home-action="scene">🎨 장면 제어</button>' +
      '<button type="button" class="pill" data-home-action="display">Aa 화면 설정</button>' +
    '</div></div>';

    // 5) Old plugin hint
    if (chars.length > 0 && chars.every((c) => typeof c.lastDate !== 'number')) {
      html += '<div class="hint" style="margin:0; padding:10px 12px; border-radius:12px; border:1px dashed var(--border); background:var(--surface);">💡 PC의 <code>risustand.js</code>를 최신으로 다시 설치하면 썸네일·최근 대화가 표시됩니다.</div>';
    }

    topEl.innerHTML = html;
  }
  const homeTopAreaEl = document.getElementById('homeTopArea');
  if (homeTopAreaEl) {
    homeTopAreaEl.addEventListener('click', (e) => {
      const openRow = e.target.closest('[data-home-open-char][data-home-open-chat]');
      if (openRow) {
        selectTarget(Number(openRow.getAttribute('data-home-open-char')), Number(openRow.getAttribute('data-home-open-chat')));
        return;
      }
      const tabTarget = e.target.closest('[data-home-tab]');
      if (tabTarget) {
        switchTab(tabTarget.getAttribute('data-home-tab'));
        return;
      }
      const actEl = e.target.closest('[data-home-action]');
      if (actEl) {
        const act = actEl.getAttribute('data-home-action');
        if (act === 'logs' && typeof openRequestLogModal === 'function') openRequestLogModal();
        else if (act === 'scene' && typeof openSceneCtrlModal === 'function') openSceneCtrlModal();
        else if (act === 'display') { e.stopPropagation(); setReadBar(true); }
      }
    });
  }

  let thumbPickerState = { charIndex: -1, chaId: '', charName: '' };
  function closeThumbPickerModal() {
    const m = document.getElementById('thumbPickerModal');
    if (m) { m.style.display = 'none'; m.innerHTML = ''; }
  }
  function downscaleImageFileToDataUri(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('파일을 읽을 수 없습니다.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('올바른 이미지 파일이 아닙니다.'));
        img.onload = () => {
          try {
            const maxDim = 512;
            const w0 = img.naturalWidth || img.width || 1;
            const h0 = img.naturalHeight || img.height || 1;
            const scale = Math.min(1, maxDim / Math.max(w0, h0));
            const w = Math.max(1, Math.round(w0 * scale));
            const h = Math.max(1, Math.round(h0 * scale));
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (!ctx) { resolve(String(reader.result || '')); return; }
            ctx.drawImage(img, 0, 0, w, h);
            let out = '';
            try { out = canvas.toDataURL('image/webp', 0.88); } catch (_) {}
            if (!out || !out.startsWith('data:image/webp')) {
              out = canvas.toDataURL('image/jpeg', 0.88);
            }
            resolve(out);
          } catch (err) {
            reject(err);
          }
        };
        img.src = String(reader.result || '');
      };
      reader.readAsDataURL(file);
    });
  }
  async function saveBotThumbChoice(payload) {
    try {
      const res = await api('/api/bot-thumb', { method: 'POST', body: JSON.stringify(payload) });
      if (lastState) lastState.botThumbs = res.botThumbs || {};
      lastHdrAvatarSig = '';
      lastBotsRenderSig = '';
      lastHomeRenderSig = '';
      if (lastState) applyState(lastState);
      renderBots(true);
      renderHome(true);
      closeThumbPickerModal();
      toast('봇 썸네일이 변경되었습니다.');
    } catch (e) {
      toast('썸네일 변경 실패: ' + (e && e.message ? e.message : String(e)));
    }
  }
  async function openThumbPickerModal(charIndex) {
    const chars = (lastState && lastState.catalog && lastState.catalog.characters) || [];
    const c = chars.find((x) => x && x.index === charIndex) || chars[charIndex];
    if (!c) { toast('캐릭터 정보를 찾을 수 없습니다.'); return; }
    const chaId = String(c.chaId || c.index);
    thumbPickerState = { charIndex: c.index, chaId, charName: String(c.name || '') };
    const modal = document.getElementById('thumbPickerModal');
    if (!modal) return;
    modal.innerHTML =
      '<div class="thumb-picker-dialog">' +
        '<div class="scene-ctrl-head">' +
          '<div style="font-size:15px; font-weight:800; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">🖼️ ' + esc(c.name) + ' · 썸네일 변경</div>' +
          '<button type="button" class="pill" data-thumb-close="1">✕ 닫기</button>' +
        '</div>' +
        '<div class="scene-ctrl-body">' +
          '<div style="display:flex; gap:8px; flex-wrap:wrap;">' +
            '<button type="button" class="btn" id="thumbUploadBtn">📁 내 이미지 업로드</button>' +
            '<button type="button" class="btn sec" id="thumbResetBtn">↺ 기본 아이콘</button>' +
            '<input type="file" id="thumbUploadInp" accept="image/*" style="display:none;" />' +
          '</div>' +
          '<div id="thumbPickerBody" style="font-size:13px; color:var(--sub); padding:10px 0;">에셋 목록을 불러오는 중...</div>' +
        '</div>' +
      '</div>';
    modal.style.display = 'flex';

    try {
      const data = await api('/api/bot-thumb/assets?charIndex=' + encodeURIComponent(c.index));
      if (modal.style.display !== 'flex' || thumbPickerState.charIndex !== c.index) return;
      thumbPickerState.chaId = String(data.chaId || chaId);
      const bodyEl = document.getElementById('thumbPickerBody');
      const assets = Array.isArray(data.assets) ? data.assets : [];
      if (!bodyEl) return;
      if (!assets.length) {
        bodyEl.innerHTML = '<div style="padding:12px 0;">이 봇에 등록된 이미지 에셋이 없습니다. 위 버튼으로 직접 이미지를 업로드할 수 있습니다.</div>';
        return;
      }
      const kindLbl = { main: '기본', emotion: '감정', additional: '에셋' };
      bodyEl.innerHTML = '<div class="thumb-picker-grid">' +
        assets.map((a, idx) =>
          '<button type="button" class="thumb-asset-tile" data-thumb-asset-idx="' + idx + '">' +
            '<img loading="lazy" decoding="async" src="' + esc(a.url) + '" alt="" />' +
            '<div class="thumb-asset-name">' + esc(a.name || ('에셋 ' + (idx + 1))) + '</div>' +
            '<div class="thumb-asset-kind">' + esc(kindLbl[a.kind] || a.kind || '에셋') + '</div>' +
          '</button>'
        ).join('') +
      '</div>';
    } catch (e) {
      const bodyEl = document.getElementById('thumbPickerBody');
      if (bodyEl) {
        bodyEl.innerHTML = '<div style="color:var(--danger); padding:8px 0;">에셋을 불러오지 못했습니다: ' + esc(e && e.message ? e.message : String(e)) + '<br><span style="color:var(--sub); font-size:12px;">내 이미지 업로드나 기본 아이콘 복원은 PC 연결 없이도 사용할 수 있습니다.</span></div>';
      }
    }
  }
  const thumbModalEl = document.getElementById('thumbPickerModal');
  if (thumbModalEl) {
    thumbModalEl.addEventListener('click', async (e) => {
      if (e.target === thumbModalEl || e.target.closest('[data-thumb-close]')) {
        closeThumbPickerModal();
        return;
      }
      if (e.target.closest('#thumbUploadBtn')) {
        const inp = document.getElementById('thumbUploadInp');
        if (inp) inp.click();
        return;
      }
      if (e.target.closest('#thumbResetBtn')) {
        await saveBotThumbChoice({ chaId: thumbPickerState.chaId, charIndex: thumbPickerState.charIndex, source: 'default' });
        return;
      }
      const tile = e.target.closest('[data-thumb-asset-idx]');
      if (tile) {
        await saveBotThumbChoice({
          chaId: thumbPickerState.chaId,
          charIndex: thumbPickerState.charIndex,
          source: 'asset',
          assetIndex: Number(tile.getAttribute('data-thumb-asset-idx')),
        });
      }
    });
    thumbModalEl.addEventListener('change', async (e) => {
      const inp = e.target;
      if (!inp || inp.id !== 'thumbUploadInp' || !inp.files || !inp.files[0]) return;
      try {
        toast('이미지 처리 중...');
        const dataUri = await downscaleImageFileToDataUri(inp.files[0]);
        await saveBotThumbChoice({ chaId: thumbPickerState.chaId, charIndex: thumbPickerState.charIndex, source: 'custom', dataUri });
      } catch (err) {
        toast('이미지 업로드 실패: ' + (err && err.message ? err.message : String(err)));
      }
    });
  }

  function renderBots(force = false) {
    const listEl = document.getElementById('botList');
    const q = (document.getElementById('botSearch').value || '').trim().toLowerCase();
    const chars = (lastState && lastState.catalog && lastState.catalog.characters) || [];
    const curChar = lastState && lastState.snapshot ? lastState.snapshot.charIndex : -1;
    const curChat = lastState && lastState.snapshot ? lastState.snapshot.chatIndex : -1;
    const recentOpens = loadRecentOpens();
    const filtered = chars
      .filter((c) => !q || String(c.name).toLowerCase().includes(q))
      .slice()
      .sort((a, b) => (getEffectiveCharDate(b, recentOpens) - getEffectiveCharDate(a, recentOpens)) || (chars.indexOf(a) - chars.indexOf(b)));
    const thumbs = (lastState && lastState.botThumbs) || {};
    const sig = JSON.stringify([q, curChar, curChat, expandedBotIdx, uiPref.assetMode, thumbs, filtered.map((c) => [c.index, c.chaId || '', c.name, c.image || '', c.lastDate ?? null, c.isPcActive, (c.chats || []).map((ch) => [ch.index, ch.id || '', ch.name, ch.msgCount, ch.turnCount ?? null, ch.lastDate ?? null])])]);
    if (!force && sig === lastBotsRenderSig) return;
    lastBotsRenderSig = sig;
    if (!filtered.length) {
      listEl.innerHTML = '<div class="empty-hint"><span class="big">📚</span>표시할 봇이 없습니다.<br>PC RisuStand의 원격 브릿지가 켜져 있는지 확인하세요.</div>';
      return;
    }
    let html = '';
    for (const c of filtered) {
      const open = expandedBotIdx === c.index || (expandedBotIdx === -1 && c.index === curChar);
      const effBotDate = getEffectiveCharDate(c, recentOpens);
      const relTxt = effBotDate > 0 ? formatRelTime(effBotDate) : '';
      html += '<div class="bot-item"><div class="bot-head" data-toggle-bot="' + c.index + '">';
      html += '<div class="bot-head-main">' + botThumbHtml(c) + '<div class="bot-head-meta"><div class="bot-head-title">' + esc(c.name) + '</div>' +
        (relTxt ? '<div class="bot-head-sub">최근 · ' + esc(relTxt) + '</div>' : '') + '</div></div>';
      html += '<div style="display:flex; gap:5px; align-items:center;">';
      if (c.isPcActive) html += '<span class="badge pc">PC 활성</span>';
      html += '<span class="badge">방 ' + (c.chats ? c.chats.length : 0) + '</span></div></div>';
      if (open) {
        html += '<div class="chat-list"><div style="display:flex; gap:6px; margin-bottom:4px;">' +
          '<button class="btn sec" style="flex:1;" data-create-chat="' + c.index + '">＋ 새 채팅방 파기</button>' +
          '<button class="btn sec" style="flex-shrink:0;" data-thumb-edit="' + c.index + '">🖼️ 썸네일 변경</button>' +
          '</div>';
        for (const ch of (c.chats || [])) {
          const isCur = c.index === curChar && ch.index === curChat;
          const turnCnt = (typeof ch.turnCount === 'number') ? ch.turnCount : Math.floor(Number(ch.msgCount || 0) / 2);
          html += '<div class="chat-row' + (isCur ? ' cur' : '') + '" data-sel-char="' + c.index + '" data-sel-chat="' + ch.index + '"><span>' + esc(ch.name) + '</span><span class="badge" title="U+A 완료 턴 (메시지 ' + Number(ch.msgCount || 0) + '개)">' + turnCnt + '턴</span></div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    listEl.innerHTML = html;
  }
  document.getElementById('botList').addEventListener('click', (e) => {
    const thumbBtn = e.target.closest('[data-thumb-edit]');
    if (thumbBtn) { openThumbPickerModal(Number(thumbBtn.getAttribute('data-thumb-edit'))); return; }
    const createBtn = e.target.closest('[data-create-chat]');
    if (createBtn) { createChat(Number(createBtn.getAttribute('data-create-chat'))); return; }
    const chatRow = e.target.closest('[data-sel-char]');
    if (chatRow) { selectTarget(Number(chatRow.getAttribute('data-sel-char')), Number(chatRow.getAttribute('data-sel-chat'))); return; }
    const botHead = e.target.closest('[data-toggle-bot]');
    if (botHead) { toggleBot(Number(botHead.getAttribute('data-toggle-bot'))); }
  });
  document.getElementById('botSearch').oninput = () => renderBots(true);
  document.getElementById('refreshAllBtn').onclick = async () => {
    await api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'sync_all' }) });
    toast('PC 전체 목록 동기화 중...');
    setTimeout(pollState, 900);
    setTimeout(pollState, 2300);
  };
  window.toggleBot = (idx) => { expandedBotIdx = expandedBotIdx === idx ? -2 : idx; renderBots(true); };
  window.selectTarget = async (charIndex, chatIndex) => {
    recordRecentOpen(charIndex, chatIndex);
    bookAnchorMode = 'last-user';
    bookSpreadIdx = -1;
    bookDesiredSpreadIdx = -1;
    pendingReplyTarget = null;
    await api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'select_target', payload: { charIndex, chatIndex } }) });
    toast('채팅방 전환 중...');
    switchTab('chat');
    setTimeout(pollState, 700);
  };
  window.createChat = async (charIndex) => {
    const name = prompt('새 채팅방 이름 (비우면 자동 생성):', '');
    if (name === null) return;
    recordRecentOpen(charIndex, 0);
    bookAnchorMode = 'last-user';
    bookSpreadIdx = -1;
    bookDesiredSpreadIdx = -1;
    pendingReplyTarget = null;
    await api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'create_chat', payload: { charIndex, name } }) });
    toast('새 방 생성 중...');
    switchTab('chat');
    setTimeout(pollState, 800);
  };


  function parseToggleSyntax(template) {
    if (!template) return [];
    const items = [];
    const lines = String(template).split('\\n');
    for (const rawLine of lines) {
      const line = rawLine.replace(/\\r$/, '').trim();
      if (!line || line.startsWith('//') || line.startsWith('#')) continue;
      const parts = line.split('=');
      const key = (parts[0] || '').trim();
      const value = parts[1] || '';
      const rawType = (parts[2] || '').trim();
      const typeLower = rawType.toLowerCase();
      const option = parts.slice(3).join('=');
      if (typeLower === 'group' || typeLower === 'groupend' || typeLower === 'divider') {
        const normType = typeLower === 'groupend' ? 'groupEnd' : typeLower;
        items.push({ key, value, type: normType, children: [] });
      } else if (typeLower === 'caption' && value) {
        items.push({ key, value, type: 'caption' });
      } else if (key && !key.startsWith('=') && value) {
        items.push({
          key,
          value,
          type: (typeLower === 'select' || typeLower === 'text' || typeLower === 'textarea') ? typeLower : 'check',
          options: option ? option.split(',') : [],
        });
      }
    }
    const grouped = [];
    let curGroup = null;
    for (const item of items) {
      if (item.type === 'group') {
        curGroup = { ...item, children: [] };
        grouped.push(curGroup);
      } else if (item.type === 'groupEnd') {
        curGroup = null;
      } else if (curGroup) {
        curGroup.children.push(item);
      } else {
        grouped.push(item);
      }
    }
    return grouped;
  }

  function renderToggleItemsHtml(items, vals, blockIdx) {
    let html = '';
    items.forEach((t, idx) => {
      const fullKey = 'toggle_' + t.key;
      const curVal = vals[fullKey] !== undefined ? String(vals[fullKey]) : '';
      if (t.type === 'group') {
        const gid = 'g-' + blockIdx + '-' + idx + '-' + t.value;
        const isOpen = openToggleGroups.has(gid);
        html += '<div class="tg-acc' + (isOpen ? ' open' : '') + '">';
        html += '<div class="tg-acc-head" data-acc-gid="' + esc(gid) + '"><span>' + esc(t.value) + '</span><span>' + (isOpen ? '▾' : '▸') + '</span></div>';
        html += '<div class="tg-acc-body">' + renderToggleItemsHtml(t.children || [], vals, blockIdx + '_' + idx) + '</div>';
        html += '</div>';
      } else if (t.type === 'divider') {
        html += '<div class="tg-div"></div>';
      } else if (t.type === 'caption') {
        html += '<div class="tg-cap">' + esc(t.value) + '</div>';
      } else if (t.type === 'select') {
        html += '<div class="tg-row"><span>' + esc(t.value) + '</span>';
        html += '<select class="f-inp" style="width:48%;" data-toggle-key="' + esc(t.key) + '">';
        html += '<option value=""' + (curVal === '' ? ' selected' : '') + '>(기본)</option>';
        (t.options || []).forEach((opt, oi) => {
          html += '<option value="' + oi + '"' + (curVal === String(oi) ? ' selected' : '') + '>' + esc(opt) + '</option>';
        });
        html += '</select></div>';
      } else if (t.type === 'text') {
        html += '<div class="tg-row"><span>' + esc(t.value) + '</span>';
        html += '<input class="f-inp" style="width:48%;" value="' + esc(curVal) + '" data-toggle-key="' + esc(t.key) + '" /></div>';
      } else if (t.type === 'textarea') {
        html += '<div style="display:flex; flex-direction:column; gap:4px;"><span style="font-size:12.5px;">' + esc(t.value) + '</span>';
        html += '<textarea class="f-inp" rows="2" data-toggle-key="' + esc(t.key) + '">' + esc(curVal) + '</textarea></div>';
      } else {
        const checked = curVal === '1';
        html += '<label class="tg-row" style="cursor:pointer;"><span>' + esc(t.value) + '</span>';
        html += '<input type="checkbox" style="width:19px; height:19px;" ' + (checked ? 'checked' : '') + ' data-toggle-key="' + esc(t.key) + '" /></label>';
      }
    });
    return html;
  }

  let lastToggleRenderSig = '';
  let lastToggleChatKey = '';
  let optimisticUntil = 0;
  let optimisticUseLocal = null;
  const optimisticVars = {};

  function populatePtParentSelect(defaultVal) {
    const sel = document.getElementById('ptParentPreset');
    if (!sel) return;
    const list = (routerCfg && Array.isArray(routerCfg.directPresets)) ? routerCfg.directPresets.filter((p) => p && p.id && p.id !== 'off') : [];
    const activeDp = (routerCfg && typeof routerCfg.directPresetId === 'string') ? routerCfg.directPresetId : 'bundled:leave';
    const targetVal = defaultVal !== undefined ? defaultVal : (activeDp !== 'off' ? activeDp : '');
    let opts = '<option value="">원격 프롬 연결 안 함 (PC 네이티브 · 항상 노출)</option>';
    list.forEach((p) => {
      opts += '<option value="' + esc(p.id) + '">' + esc('부모 원격 프롬: ' + p.name) + '</option>';
    });
    sel.innerHTML = opts;
    sel.value = (targetVal && list.some((p) => p.id === targetVal)) ? targetVal : '';
  }

  window.togglePresetAdder = (forceState) => {
    const el = document.getElementById('presetToggleAdder');
    const show = forceState !== undefined ? forceState : (el.style.display === 'none');
    el.style.display = show ? 'block' : 'none';
    if (show) populatePtParentSelect();
  };

  window.savePresetToggle = async () => {
    const name = document.getElementById('ptName').value.trim() || '프롬프트 프리셋';
    const syntax = document.getElementById('ptSyntax').value.trim();
    if (!syntax) return toast('커스텀 토글 텍스트를 붙여넣어 주세요.');
    if (!routerCfg) routerCfg = await api('/api/router/config');
    if (!Array.isArray(routerCfg.presetToggles)) routerCfg.presetToggles = [];
    const parentEl = document.getElementById('ptParentPreset');
    const parentPresetId = parentEl ? String(parentEl.value || '').trim() : '';
    const activeDp = (routerCfg && typeof routerCfg.directPresetId === 'string') ? routerCfg.directPresetId : 'bundled:leave';
    routerCfg.presetToggles.push({
      id: 'pt-' + Date.now(),
      name,
      enabled: !parentPresetId || parentPresetId === activeDp,
      syntax,
      ...(parentPresetId ? { parentPresetId } : {}),
    });
    routerCfg = await api('/api/router/config', { method: 'POST', body: JSON.stringify(routerCfg) });
    document.getElementById('ptName').value = '';
    document.getElementById('ptSyntax').value = '';
    togglePresetAdder(false);
    renderCustomToggles(true);
    toast(parentPresetId ? '프리셋 토글 등록됨 (선택한 원격 프롬 활성 시에만 노출)' : '프리셋 토글 등록됨');
  };

  window.deletePresetToggle = async (id) => {
    if (!confirm('등록된 프리셋 토글을 삭제할까요?')) return;
    if (!routerCfg) routerCfg = await api('/api/router/config');
    routerCfg.presetToggles = (routerCfg.presetToggles || []).filter((x) => x.id !== id);
    routerCfg = await api('/api/router/config', { method: 'POST', body: JSON.stringify(routerCfg) });
    renderCustomToggles(true);
    toast('프리셋 토글 삭제됨');
  };

  window.installBundledLeaveToggle = async () => {
    try {
      const data = await api('/api/presets/leave');
      if (!data || !data.toggleSyntax) return toast('내장 Leave 프리셋을 찾을 수 없습니다.');
      if (!routerCfg) routerCfg = await api('/api/router/config');
      if (!Array.isArray(routerCfg.presetToggles)) routerCfg.presetToggles = [];
      const activeDp = (routerCfg && typeof routerCfg.directPresetId === 'string') ? routerCfg.directPresetId : 'bundled:leave';
      const entry = {
        id: data.id || 'preset-leave-r1.1',
        parentPresetId: 'bundled:leave',
        name: '🍃 ' + (data.name || 'Leave · 방랑 사서의 서가 r1.1'),
        enabled: activeDp === 'bundled:leave',
        syntax: data.toggleSyntax,
      };
      const idx = routerCfg.presetToggles.findIndex((x) => x && x.id === entry.id);
      if (idx >= 0) routerCfg.presetToggles[idx] = entry;
      else routerCfg.presetToggles.unshift(entry);
      routerCfg = await api('/api/router/config', { method: 'POST', body: JSON.stringify(routerCfg) });
      renderCustomToggles(true);
      toast('🍃 Leave r1.1 프리셋 토글이 동기화되었습니다');
    } catch (e) {
      toast('Leave 토글 등록 오류: ' + (e && e.message ? e.message : '실패'));
    }
  };

  window.downloadLeavePreset = async () => {
    try {
      const res = await fetch('/api/presets/leave/download', { headers: { 'X-RisuStand-Token': token } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'Leave_RisuAI_Preset.risup';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('Leave_RisuAI_Preset.risup 다운로드 시작');
    } catch (e) {
      toast('다운로드 오류: ' + (e && e.message ? e.message : '실패'));
    }
  };

  window.openLeavePresetGuide = async () => {
    try {
      const res = await fetch('/api/presets/leave/guide', { headers: { 'X-RisuStand-Token': token } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const html = await res.text();
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 15000);
    } catch (e) {
      toast('가이드 열기 오류: ' + (e && e.message ? e.message : '실패'));
    }
  };

  function extractToggleKeys(items) {
    const keys = [];
    for (const it of items || []) {
      if (!it) continue;
      if (it.type === 'group' && Array.isArray(it.children)) {
        keys.push(...extractToggleKeys(it.children));
      } else if (it.key && it.type !== 'divider' && it.type !== 'caption' && it.type !== 'groupEnd') {
        keys.push(String(it.key).trim());
      }
    }
    return keys;
  }

  function renderCustomToggles(force = false) {
    const snap = (lastState && lastState.snapshot) || {};
    const modBlocks = (snap.customToggleBlocks || []).map((b) => ({ source: b.source, syntax: b.syntax, isPreset: false }));
    const modKeySet = new Set();
    for (const mb of modBlocks) {
      for (const k of extractToggleKeys(parseToggleSyntax(mb.syntax))) modKeySet.add(k);
    }
    const curDirectId = (routerCfg && routerCfg.directPresetId) || 'bundled:leave';
    const leaveBarEl = document.getElementById('leavePresetBar');
    if (leaveBarEl) leaveBarEl.style.display = curDirectId === 'bundled:leave' ? '' : 'none';
    const knownCustomToggleIds = new Set(
      ((routerCfg && routerCfg.directPresets) || [])
        .filter((dp) => dp && dp.customId)
        .map((dp) => 'pt-' + dp.customId)
    );
    const presetBlocks = ((routerCfg && routerCfg.presetToggles) || [])
      .filter((p) => {
        if (!p || p.enabled === false) return false;
        const parentId = p.parentPresetId || (p.id === 'preset-leave-r1.1' ? 'bundled:leave' : (knownCustomToggleIds.has(p.id) ? ('custom:' + p.id.slice(3)) : ''));
        if (parentId && parentId !== curDirectId) return false;
        if (parentId && modKeySet.size > 0) {
          const pKeys = extractToggleKeys(parseToggleSyntax(p.syntax));
          if (pKeys.length > 0) {
            const overlap = pKeys.filter((k) => modKeySet.has(k)).length;
            if (overlap * 2 >= pKeys.length) return false;
          }
        }
        return true;
      })
      .map((p) => ({
        id: p.id,
        source: p.name,
        syntax: p.syntax,
        isPreset: true,
        isAutoManaged: Boolean(p.id === 'preset-leave-r1.1' || knownCustomToggleIds.has(p.id)),
        parentPresetId: p.parentPresetId || '',
      }));
    const blocks = [...presetBlocks, ...modBlocks];

    const chatKey = (snap.charIndex ?? -1) + ':' + (snap.chatIndex ?? -1);
    if (chatKey !== lastToggleChatKey) {
      lastToggleChatKey = chatKey;
      for (const k of Object.keys(optimisticVars)) delete optimisticVars[k];
      optimisticUseLocal = null;
      optimisticUntil = 0;
    }

    const now = Date.now();
    const useLocal = (now < optimisticUntil && optimisticUseLocal !== null) ? optimisticUseLocal : Boolean(snap.useLocallySetGlobalVariables);
    const remoteGlobals = (routerCfg && routerCfg.remoteToggleValues && typeof routerCfg.remoteToggleValues === 'object') ? routerCfg.remoteToggleValues : {};
    const baseVals = useLocal
      ? { ...(snap.globalToggleValues || {}), ...remoteGlobals, ...(snap.localToggleValues || {}) }
      : { ...(snap.globalToggleValues || {}), ...remoteGlobals };
    const vals = { ...baseVals, ...(now < optimisticUntil ? optimisticVars : {}) };
    syncLeaveHudVisibility({ ...snap, useLocallySetGlobalVariables: useLocal, localToggleValues: { ...(snap.localToggleValues || {}), ...(now < optimisticUntil ? optimisticVars : {}) } });
    const sig = JSON.stringify([snap.charIndex, snap.chatIndex, curDirectId, useLocal, vals, blocks.map((b) => (b.id || '') + ':' + b.source + ':' + b.syntax.length), Array.from(openToggleGroups)]);
    if (!force && sig === lastToggleRenderSig) return;

    const body = document.getElementById('customToggleBody');
    const activeEl = document.activeElement;
    if (!force && activeEl && body && body.contains(activeEl) && /^(SELECT|INPUT|TEXTAREA)$/i.test(activeEl.tagName)) return;
    lastToggleRenderSig = sig;

    const badge = document.getElementById('localToggleBadge');
    badge.textContent = useLocal ? '이 방 로컬' : '전역 유지';
    badge.className = 'badge' + (useLocal ? ' pc' : '');
    const chk = document.getElementById('localToggleChk');
    chk.checked = useLocal;
    chk.onchange = async () => {
      optimisticUseLocal = chk.checked;
      optimisticUntil = Date.now() + 4500;
      lastToggleRenderSig = '';
      badge.textContent = chk.checked ? '이 방 로컬' : '전역 유지';
      badge.className = 'badge' + (chk.checked ? ' pc' : '');
      await api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'set_local_toggle_mode', payload: { charIndex: snap.charIndex, chatIndex: snap.chatIndex, enabled: chk.checked } }) });
      toast(chk.checked ? '이 방 로컬 토글 켜짐' : '전역 토글 모드로 전환됨');
      setTimeout(pollState, 350);
      setTimeout(pollState, 1100);
    };

    if (!blocks.length) {
      body.innerHTML = '<div style="color:var(--sub); font-size:12.5px;">표시할 토글이 없습니다. 자체 토글이 내장된 원격 프롬은 선택 시 자동 등록되며, 별도 토글은 우측 상단 <b>+ 프리셋 토글</b>로 추가할 수 있습니다.</div>';
      return;
    }
    let html = '';
    blocks.forEach((b) => {
      const parsed = parseToggleSyntax(b.syntax);
      if (!parsed.length) return;
      const blockKey = b.isPreset ? ('p:' + (b.id || b.source)) : ('m:' + b.source);
      html += '<div style="margin-bottom:10px;">';
      html += '<div style="display:flex; align-items:center; justify-content:space-between; font-size:12px; font-weight:700; color:var(--accent); margin-bottom:4px;">';
      html += '<span>' + (b.isPreset ? '📘 ' : '🌿 ') + esc(b.source) + '</span>';
      if (b.isPreset) {
        html += b.isAutoManaged
          ? '<span class="badge">원격 프롬 자동 연동</span>'
          : '<button class="act-btn" data-del-preset="' + esc(b.id) + '">삭제</button>';
      }
      html += '</div>';
      html += renderToggleItemsHtml(parsed, vals, blockKey);
      html += '</div>';
    });
    body.innerHTML = html || '<div style="color:var(--sub); font-size:12.5px;">표시할 토글 항목이 없습니다.</div>';
  }

  document.getElementById('customToggleBody').addEventListener('click', (e) => {
    const delBtn = e.target.closest('[data-del-preset]');
    if (delBtn) { deletePresetToggle(delBtn.getAttribute('data-del-preset')); return; }
    const accHead = e.target.closest('[data-acc-gid]');
    if (accHead) { toggleAccGroup(accHead.getAttribute('data-acc-gid'), accHead); }
  });
  document.getElementById('customToggleBody').addEventListener('change', (e) => {
    const el = e.target.closest('[data-toggle-key]');
    if (!el) return;
    const key = el.getAttribute('data-toggle-key');
    const val = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
    setCustomToggle(key, val);
  });

  window.toggleAccGroup = (gid, headEl) => {
    const opening = !openToggleGroups.has(gid);
    if (opening) openToggleGroups.add(gid);
    else openToggleGroups.delete(gid);
    lastToggleRenderSig = '';
    const acc = headEl && headEl.closest ? headEl.closest('.tg-acc') : null;
    if (acc) {
      acc.classList.toggle('open', opening);
      const arrow = headEl.querySelector('span:last-child');
      if (arrow) arrow.textContent = opening ? '▾' : '▸';
      return;
    }
    renderCustomToggles(true);
  };

  window.setCustomToggle = async (key, value) => {
    const snap = lastState && lastState.snapshot;
    if (!snap || snap.charIndex < 0) return;
    const fullKey = String(key).startsWith('toggle_') ? String(key) : ('toggle_' + String(key));
    const curUseLocal = (Date.now() < optimisticUntil && optimisticUseLocal !== null) ? optimisticUseLocal : Boolean(snap.useLocallySetGlobalVariables);
    optimisticVars[fullKey] = String(value);
    optimisticUntil = Date.now() + 4500;
    lastToggleRenderSig = '';
    if (!curUseLocal && routerCfg) {
      if (!routerCfg.remoteToggleValues || typeof routerCfg.remoteToggleValues !== 'object') routerCfg.remoteToggleValues = {};
      routerCfg.remoteToggleValues[fullKey] = String(value);
    }
    await api('/api/command', {
      method: 'POST',
      body: JSON.stringify({
        type: 'set_custom_toggle',
        payload: { charIndex: snap.charIndex, chatIndex: snap.chatIndex, key, value, scope: curUseLocal ? 'local' : 'global' },
      }),
    });
    toast(curUseLocal ? '토글 반영됨 (이 방 로컬)' : '토글 반영됨 (전역 유지)');
    setTimeout(pollState, 350);
    setTimeout(pollState, 1100);
  };

  function renderChatVariables(force = false) {
    const snap = (lastState && lastState.snapshot) || {};
    const vars = (snap.chatVariables && typeof snap.chatVariables === 'object') ? snap.chatVariables : {};
    const keys = Object.keys(vars);
    const card = document.getElementById('chatVarsCard');
    const body = document.getElementById('chatVarsBody');
    if (!keys.length) {
      card.style.display = 'none';
      lastChatVarsRenderSig = '';
      return;
    }
    card.style.display = '';
    const activeEl = document.activeElement;
    if (activeEl && body.contains(activeEl)) return;
    const ctrls = new Map((Array.isArray(snap.greetingControls) ? snap.greetingControls : []).map((c) => [c.key, c.options || []]));
    const sig = JSON.stringify([snap.charIndex, snap.chatIndex, vars, snap.greetingControls || []]);
    if (!force && sig === lastChatVarsRenderSig) return;
    lastChatVarsRenderSig = sig;
    body.innerHTML = keys.map((k) => {
      const val = String(vars[k] ?? '');
      const opts = ctrls.get(k);
      if (opts && opts.length > 1) {
        const optHtml = opts.map((o) => '<option value="' + esc(o) + '"' + (String(o) === val ? ' selected' : '') + '>' + esc(o) + '</option>').join('');
        return '<div class="tg-row"><span>' + esc(k) + '</span><select class="f-inp" style="width:48%;" data-chat-var-key="' + esc(k) + '">' + optHtml + '</select></div>';
      }
      return '<div class="tg-row"><span>' + esc(k) + '</span><input class="f-inp" style="width:48%;" value="' + esc(val) + '" data-chat-var-key="' + esc(k) + '" /></div>';
    }).join('');
  }
  document.getElementById('chatVarsBody').addEventListener('change', async (e) => {
    const el = e.target.closest('[data-chat-var-key]');
    if (!el) return;
    const snap = lastState && lastState.snapshot;
    if (!snap || snap.charIndex < 0) return;
    const key = el.getAttribute('data-chat-var-key');
    await api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'set_chat_var', payload: { charIndex: snap.charIndex, chatIndex: snap.chatIndex, key, value: el.value } }) });
    toast('변수 ' + key + ' 반영됨');
    setTimeout(pollState, 350);
  });

  let lastAuthorNoteChatKey = '';
  let authorNoteDirty = false;
  let charGlobalNoteDirty = false;
  let loreCache = { charKey: '', charIndex: -1, chatIndex: -1, disabledUids: [], enabledModuleUids: [], pinnedUids: [], entries: [] };
  let loreSrcFilter = 'all';
  let lastLoreFetchKey = '';
  let loreFetchInFlight = false;

  function renderAuthorNoteAndCharContext(force = false) {
    const snap = (lastState && lastState.snapshot) || {};
    const ctx = (snap.charContext && typeof snap.charContext === 'object') ? snap.charContext : {};
    const chatKey = (snap.charIndex ?? -1) + ':' + (snap.chatIndex ?? -1);
    if (chatKey !== lastAuthorNoteChatKey) {
      lastAuthorNoteChatKey = chatKey;
      authorNoteDirty = false;
      charGlobalNoteDirty = false;
    }
    const serverNote = String(ctx.note || '');
    const serverGlobalNote = String(ctx.replaceGlobalNote || '');
    const noteEl = document.getElementById('authorNoteInput');
    const noteBadge = document.getElementById('authorNoteBadge');
    if (noteEl && (force || (!authorNoteDirty && document.activeElement !== noteEl))) {
      noteEl.value = serverNote;
    }
    if (noteBadge) {
      const len = (noteEl ? noteEl.value : serverNote).length;
      noteBadge.textContent = len ? (len + '자') : '비어 있음';
    }
    const gnEl = document.getElementById('charGlobalNoteInput');
    const gnBadge = document.getElementById('charGlobalNoteBadge');
    if (gnEl && (force || (!charGlobalNoteDirty && document.activeElement !== gnEl))) {
      gnEl.value = serverGlobalNote;
    }
    if (gnBadge) {
      const len = (gnEl ? gnEl.value : serverGlobalNote).length;
      gnBadge.textContent = len ? (len + '자') : '없음';
    }
    const descBody = document.getElementById('charDescPreviewBody');
    const descBadge = document.getElementById('charDescBadge');
    if (descBody) {
      const fields = [
        { label: 'System Prompt', text: String(ctx.systemPrompt || '') },
        { label: '캐릭터 설명 (Description)', text: String(ctx.desc || '') },
        { label: '성격 (Personality)', text: String(ctx.personality || '') },
        { label: '시나리오 (Scenario)', text: String(ctx.scenario || '') },
        { label: 'Depth Prompt (depth ' + Number((ctx.depthPrompt && ctx.depthPrompt.depth) || 0) + ')', text: String((ctx.depthPrompt && ctx.depthPrompt.prompt) || '') },
        { label: '장기 기억 (Memory)', text: String(ctx.memory || '') },
      ].filter((f) => f.text.trim());
      const totalChars = fields.reduce((acc, f) => acc + f.text.length, 0);
      if (descBadge) descBadge.textContent = totalChars + '자';
      descBody.innerHTML = fields.length
        ? fields.map((f) =>
            '<div style="padding:8px 10px; border-radius:10px; border:1px solid var(--border); background:var(--bg);">' +
              '<div style="display:flex; justify-content:space-between; font-weight:700; margin-bottom:4px;"><span>' + esc(f.label) + '</span><span style="color:var(--sub);">' + f.text.length + '자</span></div>' +
              '<div style="white-space:pre-wrap; word-break:break-word; max-height:140px; overflow-y:auto; color:var(--sub); line-height:1.5;">' + esc(f.text) + '</div>' +
            '</div>'
          ).join('')
        : '<div style="color:var(--sub);">현재 봇에 기입된 캐릭터 설명 항목이 없습니다.</div>';
    }
  }

  function isClientModuleLoreEntry(e) {
    return Boolean(e && (e.isModule || e.source === 'module' || String(e.uid || '').startsWith('module:')));
  }

  async function saveLoreSelection(charKey, disabledUids, pinnedUids, enabledModuleUids) {
    const payload = { charKey, disabledUids, pinnedUids };
    if (Array.isArray(enabledModuleUids)) payload.enabledModuleUids = enabledModuleUids;
    const res = await api('/api/lorebook/selection', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (res) {
      loreCache.disabledUids = Array.isArray(res.disabledUids) ? res.disabledUids : [];
      if (Array.isArray(res.enabledModuleUids)) loreCache.enabledModuleUids = res.enabledModuleUids;
      loreCache.pinnedUids = Array.isArray(res.pinnedUids) ? res.pinnedUids : [];
    }
    renderLorebookList();
    renderModuleLorebookList();
  }

  function renderLoreEntryCardHtml(e, idx, opts) {
    const checked = Boolean(opts && opts.checked);
    const pinned = Boolean(opts && opts.pinned);
    const showPin = Boolean(opts && opts.showPin);
    const chkAttr = (opts && opts.chkAttr) || 'data-lore-chk';
    const pinAttr = (opts && opts.pinAttr) || 'data-lore-pin';
    const srcLabel = e.source === 'char' ? '캐릭터' : (e.source === 'local' ? '이 방' : '모듈');
    const title = e.comment || e.key || ('로어북 #' + (idx + 1));
    const trigText = e.alwaysActive ? '상시' : ('키워드: ' + (e.key || '(없음)'));
    return '<div style="padding:10px 12px; border-radius:12px; border:1px solid ' + (checked ? 'var(--border)' : 'color-mix(in srgb, var(--border) 60%, transparent)') + '; background:var(--bg); opacity:' + (checked ? '1' : '0.62') + ';">' +
      '<div style="display:flex; align-items:flex-start; justify-content:space-between; gap:8px;">' +
        '<div style="min-width:0; flex:1;">' +
          '<div style="font-size:13px; font-weight:700; word-break:break-word;">' + esc(title) + '</div>' +
          '<div style="display:flex; gap:4px; flex-wrap:wrap; margin-top:4px; align-items:center;">' +
            '<span class="badge">' + esc(srcLabel) + (e.sourceName && isClientModuleLoreEntry(e) ? ' · ' + esc(e.sourceName) : '') + '</span>' +
            '<span class="badge' + (e.alwaysActive ? ' pc' : '') + '">' + esc(trigText) + '</span>' +
            (e.decorator ? '<span class="badge">' + esc(e.decorator) + '</span>' : '') +
            '<span style="font-size:11px; color:var(--sub);">' + Number(e.charLen || 0) + '자</span>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">' +
          (showPin ? '<button type="button" class="pill' + (pinned ? ' active' : '') + '" style="min-height:28px; padding:0 8px; font-size:11.5px;" ' + pinAttr + '="' + esc(e.uid) + '" title="키워드가 없어도 항상 포함">' + (pinned ? '📌 고정' : '고정') + '</button>' : '') +
          '<input type="checkbox" ' + (checked ? 'checked' : '') + ' ' + chkAttr + '="' + esc(e.uid) + '" title="이 로어북 반영 여부" />' +
        '</div>' +
      '</div>' +
      '<details style="margin-top:6px;">' +
        '<summary style="cursor:pointer; font-size:11.5px; color:var(--sub);">내용 확인</summary>' +
        '<div style="margin-top:6px; padding:8px; border-radius:8px; background:var(--surface); font-size:12px; white-space:pre-wrap; word-break:break-word; max-height:180px; overflow-y:auto; line-height:1.5;">' + esc(e.content || '') + '</div>' +
      '</details>' +
    '</div>';
  }

  function renderLorebookList() {
    const listEl = document.getElementById('loreList');
    const badgeEl = document.getElementById('loreCountBadge');
    if (!listEl) return;
    if (loreSrcFilter === 'module') loreSrcFilter = 'all';
    document.querySelectorAll('#loreFilters [data-lore-src]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-lore-src') === loreSrcFilter);
    });
    const entries = (Array.isArray(loreCache.entries) ? loreCache.entries : []).filter((e) => !isClientModuleLoreEntry(e));
    const disSet = new Set(Array.isArray(loreCache.disabledUids) ? loreCache.disabledUids : []);
    const pinSet = new Set(Array.isArray(loreCache.pinnedUids) ? loreCache.pinnedUids : []);
    const activeCount = entries.filter((e) => !disSet.has(e.uid)).length;
    if (badgeEl) badgeEl.textContent = activeCount + ' / ' + entries.length + ' 반영';

    const q = (document.getElementById('loreSearch') ? document.getElementById('loreSearch').value : '').trim().toLowerCase();
    const visible = entries.filter((e) => {
      if (loreSrcFilter !== 'all' && e.source !== loreSrcFilter) return false;
      if (!q) return true;
      return String(e.comment || '').toLowerCase().includes(q) ||
        String(e.key || '').toLowerCase().includes(q) ||
        String(e.content || '').toLowerCase().includes(q) ||
        String(e.sourceName || '').toLowerCase().includes(q);
    });
    if (!visible.length) {
      listEl.innerHTML = '<div style="font-size:12.5px; color:var(--sub); padding:6px 2px;">' +
        (entries.length ? '검색·필터 조건에 맞는 캐릭터 · 채팅 로어북이 없습니다.' : '표시할 캐릭터 · 채팅 로어북이 없습니다.') +
        '</div>';
      return;
    }
    listEl.innerHTML = visible.map((e, idx) => renderLoreEntryCardHtml(e, idx, {
      checked: !disSet.has(e.uid),
      pinned: pinSet.has(e.uid),
      showPin: !e.alwaysActive,
      chkAttr: 'data-lore-chk',
      pinAttr: 'data-lore-pin',
    })).join('');
  }

  function renderModuleLorebookList() {
    const listEl = document.getElementById('modLoreList');
    const badgeEl = document.getElementById('modLoreCountBadge');
    if (!listEl) return;
    const entries = (Array.isArray(loreCache.entries) ? loreCache.entries : []).filter((e) => isClientModuleLoreEntry(e));
    const enabledSet = new Set(Array.isArray(loreCache.enabledModuleUids) ? loreCache.enabledModuleUids : []);
    const pinSet = new Set(Array.isArray(loreCache.pinnedUids) ? loreCache.pinnedUids : []);
    const activeCount = entries.filter((e) => enabledSet.has(e.uid)).length;
    if (badgeEl) badgeEl.textContent = activeCount + ' / ' + entries.length + ' 반영';

    const q = (document.getElementById('modLoreSearch') ? document.getElementById('modLoreSearch').value : '').trim().toLowerCase();
    const visible = entries.filter((e) => {
      if (!q) return true;
      return String(e.comment || '').toLowerCase().includes(q) ||
        String(e.key || '').toLowerCase().includes(q) ||
        String(e.content || '').toLowerCase().includes(q) ||
        String(e.sourceName || '').toLowerCase().includes(q);
    });
    if (!visible.length) {
      listEl.innerHTML = '<div style="font-size:12.5px; color:var(--sub); padding:6px 2px;">' +
        (entries.length ? '검색 조건에 맞는 모듈 로어북이 없습니다.' : '표시할 모듈 로어북이 없습니다.') +
        '</div>';
      return;
    }
    listEl.innerHTML = visible.map((e, idx) => {
      const checked = enabledSet.has(e.uid);
      return renderLoreEntryCardHtml(e, idx, {
        checked,
        pinned: checked && pinSet.has(e.uid),
        showPin: checked && !e.alwaysActive,
        chkAttr: 'data-mod-lore-chk',
        pinAttr: 'data-mod-lore-pin',
      });
    }).join('');
  }

  async function loadLorebookList(force = false) {
    const snap = (lastState && lastState.snapshot) || {};
    const key = (snap.charIndex ?? -1) + ':' + (snap.chatIndex ?? -1) + ':' + ((lastState && lastState.snapshotVersion) || 0);
    if (!force && key === lastLoreFetchKey) return;
    if (loreFetchInFlight) return;
    loreFetchInFlight = true;
    try {
      const res = await api('/api/lorebook');
      lastLoreFetchKey = key;
      loreCache = {
        charKey: res.charKey || '',
        charIndex: res.charIndex,
        chatIndex: res.chatIndex,
        disabledUids: Array.isArray(res.disabledUids) ? res.disabledUids : [],
        enabledModuleUids: Array.isArray(res.enabledModuleUids) ? res.enabledModuleUids : [],
        pinnedUids: Array.isArray(res.pinnedUids) ? res.pinnedUids : [],
        entries: Array.isArray(res.entries) ? res.entries : [],
      };
      renderLorebookList();
      renderModuleLorebookList();
    } catch (_) {
    } finally {
      loreFetchInFlight = false;
    }
  }

  const authorNoteEl = document.getElementById('authorNoteInput');
  if (authorNoteEl) {
    authorNoteEl.oninput = () => {
      authorNoteDirty = true;
      const b = document.getElementById('authorNoteBadge');
      if (b) b.textContent = authorNoteEl.value.length ? (authorNoteEl.value.length + '자 (수정 중)') : '비어 있음 (수정 중)';
    };
  }
  const charGlobalNoteEl = document.getElementById('charGlobalNoteInput');
  if (charGlobalNoteEl) {
    charGlobalNoteEl.oninput = () => {
      charGlobalNoteDirty = true;
      const b = document.getElementById('charGlobalNoteBadge');
      if (b) b.textContent = charGlobalNoteEl.value.length ? (charGlobalNoteEl.value.length + '자') : '없음';
    };
  }
  const saveAuthorNoteBtn = document.getElementById('saveAuthorNoteBtn');
  if (saveAuthorNoteBtn) {
    saveAuthorNoteBtn.onclick = async () => {
      const snap = lastState && lastState.snapshot;
      if (!snap || snap.charIndex < 0) return toast('동기화된 봇이 없습니다.');
      const note = authorNoteEl ? authorNoteEl.value : '';
      await api('/api/command', {
        method: 'POST',
        body: JSON.stringify({ type: 'set_author_note', payload: { charIndex: snap.charIndex, chatIndex: snap.chatIndex, note } }),
      });
      authorNoteDirty = false;
      if (snap.charContext) snap.charContext.note = note;
      renderAuthorNoteAndCharContext(true);
      toast('작가의 노트 저장됨');
      setTimeout(pollState, 350);
    };
  }
  const resetAuthorNoteBtn = document.getElementById('resetAuthorNoteBtn');
  if (resetAuthorNoteBtn) {
    resetAuthorNoteBtn.onclick = () => {
      authorNoteDirty = false;
      renderAuthorNoteAndCharContext(true);
      toast('서버에 저장된 작가의 노트로 되돌렸습니다');
    };
  }
  const saveCharGlobalNoteBtn = document.getElementById('saveCharGlobalNoteBtn');
  if (saveCharGlobalNoteBtn) {
    saveCharGlobalNoteBtn.onclick = async () => {
      const snap = lastState && lastState.snapshot;
      if (!snap || snap.charIndex < 0) return toast('동기화된 봇이 없습니다.');
      const replaceGlobalNote = charGlobalNoteEl ? charGlobalNoteEl.value : '';
      await api('/api/command', {
        method: 'POST',
        body: JSON.stringify({ type: 'set_char_global_note', payload: { charIndex: snap.charIndex, replaceGlobalNote } }),
      });
      charGlobalNoteDirty = false;
      if (snap.charContext) snap.charContext.replaceGlobalNote = replaceGlobalNote;
      renderAuthorNoteAndCharContext(true);
      toast('봇 카드 글로벌 노트 저장됨');
      setTimeout(pollState, 350);
    };
  }
  document.getElementById('loreSearch').oninput = () => renderLorebookList();
  document.getElementById('loreRefreshBtn').onclick = () => loadLorebookList(true);
  document.getElementById('loreFilters').addEventListener('click', async (e) => {
    const srcBtn = e.target.closest('[data-lore-src]');
    if (srcBtn) {
      loreSrcFilter = srcBtn.getAttribute('data-lore-src') || 'all';
      renderLorebookList();
      return;
    }
    if (e.target.id === 'loreEnableAllBtn') {
      if (!loreCache.charKey) return;
      await saveLoreSelection(loreCache.charKey, [], loreCache.pinnedUids);
      toast('캐릭터 · 채팅 로어북 전체 반영됨 (모듈 로어북은 별도 관리)');
      return;
    }
    if (e.target.id === 'loreExcludeShownBtn') {
      if (!loreCache.charKey) return;
      const q = (document.getElementById('loreSearch').value || '').trim().toLowerCase();
      const dis = new Set(loreCache.disabledUids || []);
      for (const item of loreCache.entries || []) {
        if (isClientModuleLoreEntry(item)) continue;
        if (loreSrcFilter !== 'all' && item.source !== loreSrcFilter) continue;
        if (q && !String(item.comment || '').toLowerCase().includes(q) && !String(item.key || '').toLowerCase().includes(q) && !String(item.content || '').toLowerCase().includes(q)) continue;
        dis.add(item.uid);
      }
      await saveLoreSelection(loreCache.charKey, Array.from(dis), loreCache.pinnedUids);
      toast('표시 중인 캐릭터 · 채팅 로어북 제외됨');
    }
  });
  document.getElementById('loreList').addEventListener('change', async (e) => {
    const chk = e.target.closest('[data-lore-chk]');
    if (!chk || !loreCache.charKey) return;
    const uid = chk.getAttribute('data-lore-chk');
    const dis = new Set(loreCache.disabledUids || []);
    if (chk.checked) dis.delete(uid);
    else dis.add(uid);
    await saveLoreSelection(loreCache.charKey, Array.from(dis), loreCache.pinnedUids);
    toast(chk.checked ? '로어북 반영됨' : '로어북 제외됨');
  });
  document.getElementById('loreList').addEventListener('click', async (e) => {
    const pinBtn = e.target.closest('[data-lore-pin]');
    if (!pinBtn || !loreCache.charKey) return;
    const uid = pinBtn.getAttribute('data-lore-pin');
    const pins = new Set(loreCache.pinnedUids || []);
    const nextPinned = !pins.has(uid);
    if (nextPinned) pins.add(uid);
    else pins.delete(uid);
    await saveLoreSelection(loreCache.charKey, loreCache.disabledUids, Array.from(pins));
    toast(nextPinned ? '로어북 항상 고정됨' : '고정 해제됨');
  });
  const modLoreSearchEl = document.getElementById('modLoreSearch');
  if (modLoreSearchEl) modLoreSearchEl.oninput = () => renderModuleLorebookList();
  const modLoreRefreshBtn = document.getElementById('modLoreRefreshBtn');
  if (modLoreRefreshBtn) modLoreRefreshBtn.onclick = () => loadLorebookList(true);
  const modLoreDisableAllBtn = document.getElementById('modLoreDisableAllBtn');
  if (modLoreDisableAllBtn) {
    modLoreDisableAllBtn.onclick = async () => {
      if (!loreCache.charKey) return;
      const modUidSet = new Set((loreCache.entries || []).filter((it) => isClientModuleLoreEntry(it)).map((it) => it.uid));
      const nextPins = (loreCache.pinnedUids || []).filter((u) => !modUidSet.has(u) && !String(u).startsWith('module:'));
      await saveLoreSelection(loreCache.charKey, loreCache.disabledUids, nextPins, []);
      toast('모듈 로어북 전체 비활성화됨');
    };
  }
  const modLoreListEl = document.getElementById('modLoreList');
  if (modLoreListEl) {
    modLoreListEl.addEventListener('change', async (e) => {
      const chk = e.target.closest('[data-mod-lore-chk]');
      if (!chk || !loreCache.charKey) return;
      const uid = chk.getAttribute('data-mod-lore-chk');
      const en = new Set(loreCache.enabledModuleUids || []);
      const pins = new Set(loreCache.pinnedUids || []);
      if (chk.checked) {
        en.add(uid);
      } else {
        en.delete(uid);
        pins.delete(uid);
      }
      await saveLoreSelection(loreCache.charKey, loreCache.disabledUids, Array.from(pins), Array.from(en));
      toast(chk.checked ? '모듈 로어북 개별 반영됨' : '모듈 로어북 비활성화됨');
    });
    modLoreListEl.addEventListener('click', async (e) => {
      const pinBtn = e.target.closest('[data-mod-lore-pin]');
      if (!pinBtn || !loreCache.charKey) return;
      const uid = pinBtn.getAttribute('data-mod-lore-pin');
      const en = new Set(loreCache.enabledModuleUids || []);
      if (!en.has(uid)) return;
      const pins = new Set(loreCache.pinnedUids || []);
      const nextPinned = !pins.has(uid);
      if (nextPinned) pins.add(uid);
      else pins.delete(uid);
      await saveLoreSelection(loreCache.charKey, loreCache.disabledUids, Array.from(pins), Array.from(en));
      toast(nextPinned ? '모듈 로어북 항상 고정됨' : '고정 해제됨');
    });
  }

  function renderModules(force = false) {
    renderCustomToggles(false);
    renderChatVariables(force);
    renderAuthorNoteAndCharContext(force);
    loadLorebookList(false);
    loadBackendPlugins(false);
    const cat = (lastState && lastState.catalog) || {};
    const snap = (lastState && lastState.snapshot) || {};
    const chatModSet = new Set(Array.isArray(snap.chatModules) ? snap.chatModules.map(String) : []);
    const pSel = document.getElementById('personaSel');
    const personas = cat.personas || [];
    const q = (document.getElementById('modSearch').value || '').trim().toLowerCase();
    const mods = (cat.modules || []).filter((m) => !q || String(m.name).toLowerCase().includes(q) || String(m.namespace || '').toLowerCase().includes(q));
    if (cat.params && document.activeElement.tagName !== 'INPUT') {
      document.getElementById('pTemp').value = cat.params.temperature;
      document.getElementById('pCtx').value = cat.params.maxContext;
      document.getElementById('pResp').value = cat.params.maxResponse;
    }
    const modSig = JSON.stringify([q, cat.selectedPersona, snap.charIndex, snap.chatIndex, Array.from(chatModSet).sort(), personas.map((p) => [p.index, p.name]), mods.map((m) => [m.id, m.name, m.enabled, m.description, m.namespace, m.assetCount])]);
    if (!force && modSig === lastModulesRenderSig) return;
    lastModulesRenderSig = modSig;
    if (document.activeElement !== pSel) {
      pSel.innerHTML = personas.map((p) => '<option value="' + p.index + '"' + (p.index === cat.selectedPersona ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('');
    }
    pSel.onchange = async () => {
      await api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'select_persona', payload: { personaIndex: Number(pSel.value) } }) });
      toast('페르소나 변경됨');
    };
    const activeTotal = (cat.modules || []).filter((m) => m.enabled || chatModSet.has(String(m.id))).length;
    document.getElementById('modCount').textContent = activeTotal + ' / ' + (cat.modules || []).length;
    document.getElementById('modList').innerHTML = mods.map((m) => {
      const inChat = chatModSet.has(String(m.id));
      const metaBadges =
        (m.namespace ? '<span class="badge">' + esc(m.namespace) + '</span>' : '') +
        (m.assetCount > 0 ? '<span class="badge">🖼️ ' + m.assetCount + '</span>' : '');
      return '<div class="row">' +
        '<div style="min-width:0;">' +
          '<div style="font-size:13.5px; font-weight:600; display:flex; align-items:center; gap:5px; flex-wrap:wrap;"><span>' + esc(m.name) + '</span>' + metaBadges + '</div>' +
          (m.description ? '<div style="font-size:11.5px; color:var(--sub);">' + esc(m.description) + '</div>' : '') +
        '</div>' +
        '<div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">' +
          '<button class="pill' + (inChat ? ' active' : '') + '" style="min-height:28px; padding:0 9px; font-size:11.5px;" data-chat-mod-id="' + esc(m.id) + '" data-chat-mod-on="' + (inChat ? '1' : '0') + '" title="이 채팅방 전용 활성화">이 방</button>' +
          '<input type="checkbox" style="width:20px; height:20px; flex-shrink:0;" ' + (m.enabled ? 'checked' : '') + ' data-mod-id="' + esc(m.id) + '" title="전역 모듈 활성화" />' +
        '</div>' +
      '</div>';
    }).join('') || '<div style="color:var(--sub); font-size:12.5px;">모듈 없음</div>';
  }
  document.getElementById('modList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-chat-mod-id]');
    if (!btn) return;
    const snap = lastState && lastState.snapshot;
    if (!snap || snap.charIndex < 0) return;
    const moduleId = btn.getAttribute('data-chat-mod-id');
    const enabled = btn.getAttribute('data-chat-mod-on') !== '1';
    await api('/api/command', {
      method: 'POST',
      body: JSON.stringify({ type: 'toggle_module', payload: { scope: 'chat', charIndex: snap.charIndex, chatIndex: snap.chatIndex, moduleId, enabled } }),
    });
    toast('이 방 모듈 ' + (enabled ? '켜짐' : '꺼짐'));
    setTimeout(pollState, 350);
  });
  document.getElementById('modList').addEventListener('change', (e) => {
    const chk = e.target.closest('[data-mod-id]');
    if (chk) toggleMod(chk.getAttribute('data-mod-id'), chk.checked);
  });
  document.getElementById('modSearch').oninput = () => renderModules(true);
  window.toggleMod = async (moduleId, enabled) => {
    await api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'toggle_module', payload: { scope: 'global', moduleId, enabled } }) });
    toast('전역 모듈 ' + (enabled ? '켜짐' : '꺼짐'));
    setTimeout(pollState, 350);
  };
  document.getElementById('saveParamsBtn').onclick = async () => {
    await api('/api/command', {
      method: 'POST',
      body: JSON.stringify({
        type: 'update_params',
        payload: {
          temperature: Number(document.getElementById('pTemp').value),
          maxContext: Number(document.getElementById('pCtx').value),
          maxResponse: Number(document.getElementById('pResp').value),
        },
      }),
    });
    toast('파라미터 RisuAI에 반영됨');
  };

  async function loadRouterConfig() {
    routerCfg = await api('/api/router/config');
    syncToggleBadges();
    renderRouterUI();
  }
  function getProviderMeta(pid) {
    return AI_PROVIDERS.find((x) => x.id === pid) || AI_PROVIDERS.find((x) => x.id === 'custom') || AI_PROVIDERS[0];
  }
  function inferClientProviderId(explicitId, pType, url) {
    if (explicitId && AI_PROVIDERS.some((x) => x.id === explicitId)) return explicitId;
    const u = String(url || '').toLowerCase();
    if (u) {
      for (const p of AI_PROVIDERS) {
        if (!p.endpoint || p.id === 'custom') continue;
        try {
          const pu = new URL(p.endpoint);
          const bu = new URL(u);
          if (pu.host === bu.host) {
            if (p.id === 'novita-coding') continue;
            if (p.id === 'z-ai' && u.includes('/coding/')) return 'z-ai-coding';
            return p.id;
          }
        } catch (_) {}
      }
      if (u.includes('11434')) return 'ollama';
      if (u.includes('1234')) return 'lmstudio';
    }
    if (pType === 'anthropic') return 'claude';
    if (pType === 'gemini') return 'gemini';
    return 'custom';
  }
  function populateProviderSelect(selId) {
    const sel = document.getElementById(selId);
    if (!sel || sel.options.length) return;
    const main = AI_PROVIDERS.filter((p) => p.group === 'main');
    const direct = AI_PROVIDERS.filter((p) => p.group !== 'main');
    sel.innerHTML =
      '<optgroup label="주요 제공사">' +
        main.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.label) + '</option>').join('') +
      '</optgroup>' +
      '<optgroup label="Direct 프로바이더 (LIB 호환)">' +
        direct.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.label) + '</option>').join('') +
      '</optgroup>';
  }
  function setModelPickList(pickId, statusId, models, statusMsg) {
    const pick = document.getElementById(pickId);
    const st = document.getElementById(statusId);
    if (pick) {
      if (Array.isArray(models) && models.length) {
        pick.innerHTML = '<option value="">-- 불러온 모델 선택 (' + models.length + '개) --</option>' +
          models.map((m) => {
            const id = typeof m === 'string' ? m : m.id;
            const lbl = typeof m === 'string' ? m : (m.label && m.label !== m.id ? m.label + ' (' + m.id + ')' : m.id);
            return '<option value="' + esc(id) + '">' + esc(lbl) + '</option>';
          }).join('');
        pick.style.display = 'block';
      } else {
        pick.innerHTML = '';
        pick.style.display = 'none';
      }
    }
    if (st) st.textContent = statusMsg || '';
  }
  populateProviderSelect('edProvider');
  populateProviderSelect('trProvider');

  function renderRouterUI() {
    if (!routerCfg) return;
    const profs = routerCfg.profiles || [];
    const auxSel = document.getElementById('auxProfileSel');
    if (auxSel) {
      const curAux = typeof routerCfg.auxProfileId === 'string' && routerCfg.auxProfileId ? routerCfg.auxProfileId : 'inherit';
      auxSel.innerHTML = '<option value="inherit">메인 모델과 동일 (기본 · inherit)</option>' +
        profs.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.name + ' (' + (p.model || p.providerType) + ')') + '</option>').join('');
      auxSel.value = (curAux !== 'inherit' && profs.some((p) => p && p.id === curAux)) ? curAux : 'inherit';
    }
    const imgCfg = (routerCfg.imageGen && typeof routerCfg.imageGen === 'object') ? routerCfg.imageGen : {};
    if (document.getElementById('imgGenSource')) {
      const srcVal = imgCfg.source === 'custom' ? 'custom' : 'pc_risu';
      const provVal = imgCfg.provider || 'novelai';
      document.getElementById('imgGenSource').value = srcVal;
      document.getElementById('imgGenProvider').value = provVal;
      document.getElementById('imgGenUrl').value = imgCfg.apiUrl || '';
      document.getElementById('imgGenKey').value = '';
      document.getElementById('imgGenKey').placeholder = imgCfg.hasKey ? ('저장됨: ' + imgCfg.keyPreview + ' (비우면 유지)') : 'NovelAI Token 또는 OpenAI API Key';
      document.getElementById('imgGenModel').value = imgCfg.model || 'nai-diffusion-4-5-full';
      document.getElementById('imgGenWidth').value = imgCfg.width || 1024;
      document.getElementById('imgGenHeight').value = imgCfg.height || 1024;
      document.getElementById('imgGenSteps').value = imgCfg.steps || 28;
      document.getElementById('imgGenScale').value = imgCfg.scale !== undefined ? imgCfg.scale : 5;
      document.getElementById('imgGenSampler').value = imgCfg.sampler || 'k_euler_ancestral';
      document.getElementById('imgGenNegBase').value = imgCfg.negativeBase || '';
      document.getElementById('imgGenComfyWorkflow').value = imgCfg.comfyWorkflowJson || '';
      document.getElementById('imgGenComfyPosId').value = imgCfg.comfyPosNodeId || '';
      document.getElementById('imgGenComfyNegId').value = imgCfg.comfyNegNodeId || '';
      document.getElementById('imgGenCustomBox').style.display = srcVal === 'custom' ? 'block' : 'none';
      document.getElementById('imgGenComfyBox').style.display = provVal === 'comfyui' ? 'block' : 'none';
    }
    if (typeof hydrateTtsConfigUI === 'function') hydrateTtsConfigUI();
    document.getElementById('profileList').innerHTML = profs.map((p) => {
      const active = p.id === routerCfg.activeProfileId;
      const pMeta = getProviderMeta(inferClientProviderId(p.provider, p.providerType, p.baseUrl));
      return '<div class="row" style="padding:8px 10px; border:1px solid ' + (active ? 'var(--accent)' : 'var(--border)') + '; border-radius:10px; background:var(--bg);">' +
        '<div style="min-width:0;"><div style="font-size:13.5px; font-weight:700;">' + (active ? '🟢 ' : '') + esc(p.name) + '</div>' +
        '<div style="font-size:11.5px; color:var(--sub);">' + esc(pMeta.label) + ' · ' + esc(p.model) + ' · 키: ' + (p.hasKey ? esc(p.keyPreview) : '미설정') + '</div></div>' +
        '<div style="display:flex; gap:5px; flex-shrink:0;">' +
        '<button class="btn ' + (active ? '' : 'sec') + '" data-act-prof="' + esc(p.id) + '">' + (active ? '활성' : '선택') + '</button>' +
        '<button class="btn sec" data-edit-prof="' + esc(p.id) + '">편집</button></div></div>';
    }).join('');
    const tr = routerCfg.translator || {};
    const trPid = inferClientProviderId(tr.provider, tr.providerType, tr.baseUrl);
    document.getElementById('trUseActive').checked = Boolean(tr.useActiveProfile);
    document.getElementById('trAutoOut').checked = Boolean(tr.autoTranslateOutput);
    document.getElementById('trAutoIn').checked = Boolean(tr.autoTranslateInput);
    document.getElementById('trProvider').value = trPid;
    document.getElementById('trType').value = tr.providerType || 'gemini';
    document.getElementById('trUrl').value = tr.baseUrl || '';
    document.getElementById('trKey').value = '';
    document.getElementById('trKey').placeholder = tr.hasKey ? ('저장됨: ' + tr.keyPreview) : 'API 키 입력';
    document.getElementById('trModel').value = tr.model || 'gemini-2.5-flash';
    document.getElementById('trPrompt').value = tr.prompt || '';
    document.getElementById('trCustomBox').style.display = tr.useActiveProfile ? 'none' : 'block';
    const trMeta = getProviderMeta(trPid);
    if (trMeta && Array.isArray(trMeta.builtinModels) && trMeta.builtinModels.length) {
      setModelPickList('trModelPick', 'trModelStatus', trMeta.builtinModels, trMeta.label + ' 내장 모델 ' + trMeta.builtinModels.length + '개');
    } else {
      setModelPickList('trModelPick', 'trModelStatus', [], '');
    }
    const dpSel = document.getElementById('directPresetSel');
    const dpDel = document.getElementById('directPresetDelBtn');
    const dpHint = document.getElementById('directPresetHint');
    if (dpSel) {
      const list = Array.isArray(routerCfg.directPresets) ? routerCfg.directPresets : [
        { id: 'off', name: '사용 안 함 (기본 간이 프롬프트)', templateCount: 0 }
      ];
      const activeDp = typeof routerCfg.directPresetId === 'string' ? routerCfg.directPresetId : 'bundled:leave';
      dpSel.innerHTML = list.map((p) => {
        const suffix = p.templateCount ? (' · ' + p.templateCount + '블록') : '';
        return '<option value="' + esc(p.id) + '">' + esc(p.name + suffix) + '</option>';
      }).join('');
      dpSel.value = list.some((p) => p.id === activeDp) ? activeDp : (list[1] ? list[1].id : 'off');
      if (dpDel) dpDel.style.display = dpSel.value.startsWith('custom:') ? '' : 'none';
      if (dpHint) {
        dpHint.innerHTML = dpSel.value === 'off'
          ? '<code>원격 라우팅</code>에서는 <b>다른 RisuAI 플러그인은 동작하지 않습니다</b>. 현재 원격 직접 요청(원격채팅·원격리롤)에 최소 시스템 프롬프트만 전송합니다. RisuAI 프리셋을 입히려면 목록에서 프리셋을 선택하거나 업로드하세요.'
          : '자체 토글이 내장된 프리셋(Leave 등)을 원격 프롬으로 선택하면 <b>[🧩 모듈/설정]</b>의 프리셋 토글이 자동으로 등록·활성화되며, 다른 원격 프롬으로 바꾸면 이전 프롬 토글은 자동으로 숨김·비활성화됩니다. <b>원격 직접 요청(원격채팅 · 원격리롤)</b>에 이 프리셋과 토글이 실시간 CBS로 반영됩니다.';
      }
    }
    const adderEl = document.getElementById('presetToggleAdder');
    if (adderEl && adderEl.style.display !== 'none') populatePtParentSelect();
    const histModeEl = document.getElementById('directHistoryModeSel');
    if (histModeEl) {
      histModeEl.value = routerCfg.directHistoryMode || 'chunked';
    }
    const pipeModeEl = document.getElementById('directPipelineModeSel');
    if (pipeModeEl) {
      pipeModeEl.value = routerCfg.directPipelineMode || 'single';
    }
  }
  const directHistoryModeSelEl = document.getElementById('directHistoryModeSel');
  if (directHistoryModeSelEl) {
    directHistoryModeSelEl.onchange = async () => {
      try {
        routerCfg = await api('/api/router/config', {
          method: 'POST',
          body: JSON.stringify({ directHistoryMode: directHistoryModeSelEl.value }),
        });
        renderRouterUI();
        toast('원격 히스토리 창 모드 변경됨');
      } catch (e) {
        toast('설정 저장 실패: ' + (e && e.message ? e.message : '오류'));
      }
    };
  }
  const directPipelineModeSelEl = document.getElementById('directPipelineModeSel');
  if (directPipelineModeSelEl) {
    directPipelineModeSelEl.onchange = async () => {
      try {
        routerCfg = await api('/api/router/config', {
          method: 'POST',
          body: JSON.stringify({ directPipelineMode: directPipelineModeSelEl.value }),
        });
        renderRouterUI();
        toast('원격 생성 파이프라인 모드 변경됨');
      } catch (e) {
        toast('설정 저장 실패: ' + (e && e.message ? e.message : '오류'));
      }
    };
  }
  const directPresetSelEl = document.getElementById('directPresetSel');
  if (directPresetSelEl) {
    directPresetSelEl.onchange = async () => {
      try {
        routerCfg = await api('/api/presets/direct', {
          method: 'POST',
          body: JSON.stringify({ directPresetId: directPresetSelEl.value }),
        });
        renderRouterUI();
        renderCustomToggles(true);
        toast('원격 직접 요청 프리셋 변경됨');
      } catch (e) {
        toast('프리셋 변경 실패: ' + (e && e.message ? e.message : '오류'));
      }
    };
  }
  const directPresetUploadBtnEl = document.getElementById('directPresetUploadBtn');
  const directPresetFileEl = document.getElementById('directPresetFile');
  if (directPresetUploadBtnEl && directPresetFileEl) {
    directPresetUploadBtnEl.onclick = () => directPresetFileEl.click();
    directPresetFileEl.onchange = async () => {
      const f = directPresetFileEl.files && directPresetFileEl.files[0];
      if (!f) return;
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < buf.length; i += chunk) {
          bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
        }
        const res = await api('/api/presets/custom', {
          method: 'POST',
          body: JSON.stringify({ filename: f.name, dataBase64: btoa(bin), registerToggle: true }),
        });
        if (res && res.config) routerCfg = res.config;
        renderRouterUI();
        renderCustomToggles(true);
        toast('프리셋 업로드 및 적용 완료: ' + ((res && res.preset && res.preset.name) || f.name));
      } catch (e) {
        toast('프리셋 업로드 실패: ' + (e && e.message ? e.message : '오류'));
      } finally {
        directPresetFileEl.value = '';
      }
    };
  }
  const directPresetDelBtnEl = document.getElementById('directPresetDelBtn');
  if (directPresetDelBtnEl) {
    directPresetDelBtnEl.onclick = async () => {
      const curId = directPresetSelEl ? directPresetSelEl.value : '';
      if (!curId.startsWith('custom:')) return;
      if (!confirm('선택한 커스텀 프리셋을 삭제할까요?')) return;
      try {
        const res = await api('/api/presets/custom/' + encodeURIComponent(curId.slice(7)), { method: 'DELETE' });
        if (res && res.config) routerCfg = res.config;
        renderRouterUI();
        renderCustomToggles(true);
        toast('커스텀 프리셋 삭제됨');
      } catch (e) {
        toast('삭제 실패: ' + (e && e.message ? e.message : '오류'));
      }
    };
  }
  document.getElementById('profileList').addEventListener('click', (e) => {
    const actBtn = e.target.closest('[data-act-prof]');
    if (actBtn) { activateProfile(actBtn.getAttribute('data-act-prof')); return; }
    const edBtn = e.target.closest('[data-edit-prof]');
    if (edBtn) { editProfile(edBtn.getAttribute('data-edit-prof')); }
  });
  document.getElementById('trUseActive').onchange = (e) => { document.getElementById('trCustomBox').style.display = e.target.checked ? 'none' : 'block'; };
  window.activateProfile = async (id) => {
    routerCfg.activeProfileId = id;
    routerCfg = await api('/api/router/config', { method: 'POST', body: JSON.stringify(routerCfg) });
    renderRouterUI();
    toast('활성 모델 전환됨');
  };
  function applyEditorProvider(pid, { updateName = true, fillDefaultModel = false } = {}) {
    const meta = getProviderMeta(pid);
    if (!meta) return;
    document.getElementById('edProvider').value = meta.id;
    document.getElementById('edType').value = meta.providerType || 'openai_compat';
    if (meta.id !== 'custom') document.getElementById('edUrl').value = meta.endpoint || '';
    const nameEl = document.getElementById('edName');
    const curName = nameEl.value.trim();
    const isDefaultLabel = !curName || AI_PROVIDERS.some((x) => x.label === curName);
    if (updateName && isDefaultLabel) nameEl.value = meta.label;
    const modelEl = document.getElementById('edModel');
    if (fillDefaultModel || !modelEl.value.trim()) {
      if (meta.defaultModel) modelEl.value = meta.defaultModel;
    }
    if (Array.isArray(meta.builtinModels) && meta.builtinModels.length) {
      setModelPickList('edModelPick', 'edModelStatus', meta.builtinModels, meta.label + ' 기본 제공 모델 ' + meta.builtinModels.length + '개 (API 조회 병합 가능)');
    } else {
      setModelPickList('edModelPick', 'edModelStatus', [], meta.modelsUrl ? '🔄 모델 불러오기 버튼으로 사용 가능한 모델을 조회할 수 있습니다.' : '이 제공사는 모델 ID를 직접 입력하세요.');
    }
  }
  document.getElementById('edProvider').onchange = (e) => {
    applyEditorProvider(e.target.value, { updateName: true, fillDefaultModel: true });
  };
  document.getElementById('edModelPick').onchange = (e) => {
    const val = e.target.value;
    if (!val) return;
    document.getElementById('edModel').value = val;
    toast('모델 선택됨: ' + val);
  };
  document.getElementById('edLoadModelsBtn').onclick = async () => {
    const btn = document.getElementById('edLoadModelsBtn');
    const st = document.getElementById('edModelStatus');
    btn.disabled = true;
    if (st) st.textContent = '모델 목록을 불러오는 중...';
    try {
      const r = await api('/api/router/models', {
        method: 'POST',
        body: JSON.stringify({
          provider: document.getElementById('edProvider').value,
          providerType: document.getElementById('edType').value,
          baseUrl: document.getElementById('edUrl').value.trim(),
          apiKey: document.getElementById('edKey').value.trim(),
          profileId: document.getElementById('edId').value,
          target: 'profile',
        }),
      });
      const models = r.models || [];
      setModelPickList('edModelPick', 'edModelStatus', models, models.length + '개 모델을 불러왔습니다. 아래에서 선택하면 자동 입력됩니다.');
      toast(models.length + '개 모델 불러옴');
    } catch (e) {
      if (st) st.textContent = '⚠️ ' + (e && e.message ? e.message : '불러오기 실패');
      toast('모델 불러오기 실패: ' + (e && e.message ? e.message : '오류'));
    } finally {
      btn.disabled = false;
    }
  };
  document.getElementById('trProvider').onchange = (e) => {
    const meta = getProviderMeta(e.target.value);
    if (!meta) return;
    document.getElementById('trType').value = meta.providerType || 'openai_compat';
    if (meta.id !== 'custom') document.getElementById('trUrl').value = meta.endpoint || '';
    if (meta.defaultModel && !document.getElementById('trModel').value.trim()) document.getElementById('trModel').value = meta.defaultModel;
    if (Array.isArray(meta.builtinModels) && meta.builtinModels.length) {
      setModelPickList('trModelPick', 'trModelStatus', meta.builtinModels, meta.label + ' 기본 제공 모델 ' + meta.builtinModels.length + '개');
    } else {
      setModelPickList('trModelPick', 'trModelStatus', [], '');
    }
  };
  document.getElementById('trModelPick').onchange = (e) => {
    const val = e.target.value;
    if (!val) return;
    document.getElementById('trModel').value = val;
    toast('번역 모델 선택됨: ' + val);
  };
  document.getElementById('trLoadModelsBtn').onclick = async () => {
    const btn = document.getElementById('trLoadModelsBtn');
    const st = document.getElementById('trModelStatus');
    btn.disabled = true;
    if (st) st.textContent = '모델 목록을 불러오는 중...';
    try {
      const r = await api('/api/router/models', {
        method: 'POST',
        body: JSON.stringify({
          provider: document.getElementById('trProvider').value,
          providerType: document.getElementById('trType').value,
          baseUrl: document.getElementById('trUrl').value.trim(),
          apiKey: document.getElementById('trKey').value.trim(),
          target: 'translator',
        }),
      });
      const models = r.models || [];
      setModelPickList('trModelPick', 'trModelStatus', models, models.length + '개 모델을 불러왔습니다.');
      toast(models.length + '개 모델 불러옴');
    } catch (e) {
      if (st) st.textContent = '⚠️ ' + (e && e.message ? e.message : '불러오기 실패');
      toast('모델 불러오기 실패: ' + (e && e.message ? e.message : '오류'));
    } finally {
      btn.disabled = false;
    }
  };
  window.openNewProfile = (preset) => {
    const pid = inferClientProviderId(preset, '', '');
    const meta = getProviderMeta(pid);
    document.getElementById('edTitle').textContent = '새 모델 프로필 추가';
    document.getElementById('edId').value = 'prof-' + Date.now();
    document.getElementById('edName').value = meta.label;
    document.getElementById('edKey').value = '';
    document.getElementById('edModel').value = meta.defaultModel || '';
    document.getElementById('edTemp').value = '';
    document.getElementById('edMaxTok').value = '';
    document.getElementById('edOvMode').value = 'off';
    document.getElementById('edOvText').value = '';
    document.getElementById('delProfBtn').style.display = 'none';
    applyEditorProvider(meta.id, { updateName: false, fillDefaultModel: true });
    document.getElementById('profileEditor').style.display = 'block';
  };
  window.editProfile = (id) => {
    const p = (routerCfg.profiles || []).find((x) => x.id === id);
    if (!p) return;
    const pid = inferClientProviderId(p.provider, p.providerType, p.baseUrl);
    const meta = getProviderMeta(pid);
    document.getElementById('edTitle').textContent = '프로필 편집';
    document.getElementById('edId').value = p.id;
    document.getElementById('edName').value = p.name;
    document.getElementById('edProvider').value = pid;
    document.getElementById('edType').value = p.providerType;
    document.getElementById('edUrl').value = p.baseUrl;
    document.getElementById('edKey').value = '';
    document.getElementById('edKey').placeholder = p.hasKey ? ('저장됨: ' + p.keyPreview + ' (비우면 유지)') : 'API 키 입력';
    document.getElementById('edModel').value = p.model;
    document.getElementById('edTemp').value = p.temperature !== undefined && p.temperature !== null ? p.temperature : '';
    document.getElementById('edMaxTok').value = p.maxTokens !== undefined && p.maxTokens !== null ? p.maxTokens : '';
    document.getElementById('edOvMode').value = p.overrideMode || 'off';
    document.getElementById('edOvText').value = p.systemOverride || '';
    document.getElementById('delProfBtn').style.display = 'inline-block';
    if (Array.isArray(meta.builtinModels) && meta.builtinModels.length) {
      setModelPickList('edModelPick', 'edModelStatus', meta.builtinModels, meta.label + ' 기본 제공 모델 ' + meta.builtinModels.length + '개 (API 조회 병합 가능)');
    } else {
      setModelPickList('edModelPick', 'edModelStatus', [], meta.modelsUrl ? '🔄 모델 불러오기 버튼으로 사용 가능한 모델을 조회할 수 있습니다.' : '');
    }
    document.getElementById('profileEditor').style.display = 'block';
  };
  document.getElementById('saveProfBtn').onclick = async () => {
    const id = document.getElementById('edId').value;
    const item = {
      id,
      name: document.getElementById('edName').value.trim() || 'Model',
      provider: document.getElementById('edProvider').value,
      providerType: document.getElementById('edType').value,
      baseUrl: document.getElementById('edUrl').value.trim(),
      apiKey: document.getElementById('edKey').value.trim(),
      model: document.getElementById('edModel').value.trim(),
      temperature: document.getElementById('edTemp').value.trim(),
      maxTokens: document.getElementById('edMaxTok').value.trim(),
      overrideMode: document.getElementById('edOvMode').value,
      systemOverride: document.getElementById('edOvText').value,
    };
    const idx = routerCfg.profiles.findIndex((x) => x.id === id);
    if (idx >= 0) routerCfg.profiles[idx] = item;
    else routerCfg.profiles.push(item);
    if (!routerCfg.activeProfileId) routerCfg.activeProfileId = id;
    routerCfg = await api('/api/router/config', { method: 'POST', body: JSON.stringify(routerCfg) });
    document.getElementById('profileEditor').style.display = 'none';
    renderRouterUI();
    toast('프로필 저장됨');
  };
  document.getElementById('delProfBtn').onclick = async () => {
    const id = document.getElementById('edId').value;
    routerCfg.profiles = routerCfg.profiles.filter((x) => x.id !== id);
    if (routerCfg.activeProfileId === id) routerCfg.activeProfileId = '';
    if (routerCfg.auxProfileId === id) routerCfg.auxProfileId = 'inherit';
    routerCfg = await api('/api/router/config', { method: 'POST', body: JSON.stringify(routerCfg) });
    document.getElementById('profileEditor').style.display = 'none';
    renderRouterUI();
    toast('프로필 삭제됨');
  };
  const auxProfileSelEl = document.getElementById('auxProfileSel');
  if (auxProfileSelEl) {
    auxProfileSelEl.onchange = async () => {
      routerCfg.auxProfileId = auxProfileSelEl.value || 'inherit';
      routerCfg = await api('/api/router/config', { method: 'POST', body: JSON.stringify({ auxProfileId: routerCfg.auxProfileId }) });
      renderRouterUI();
      toast('보조 모델(otherAx) 변경됨');
    };
  }
  const imgGenSourceEl = document.getElementById('imgGenSource');
  const imgGenProvEl = document.getElementById('imgGenProvider');
  if (imgGenSourceEl) {
    imgGenSourceEl.onchange = () => {
      document.getElementById('imgGenCustomBox').style.display = imgGenSourceEl.value === 'custom' ? 'block' : 'none';
    };
  }
  if (imgGenProvEl) {
    imgGenProvEl.onchange = () => {
      document.getElementById('imgGenComfyBox').style.display = imgGenProvEl.value === 'comfyui' ? 'block' : 'none';
    };
  }
  const saveImgGenBtnEl = document.getElementById('saveImgGenBtn');
  if (saveImgGenBtnEl) {
    saveImgGenBtnEl.onclick = async () => {
      const payload = {
        source: document.getElementById('imgGenSource').value,
        provider: document.getElementById('imgGenProvider').value,
        apiUrl: document.getElementById('imgGenUrl').value.trim(),
        apiKey: document.getElementById('imgGenKey').value.trim(),
        model: document.getElementById('imgGenModel').value.trim(),
        width: Number(document.getElementById('imgGenWidth').value) || 1024,
        height: Number(document.getElementById('imgGenHeight').value) || 1024,
        steps: Number(document.getElementById('imgGenSteps').value) || 28,
        scale: Number(document.getElementById('imgGenScale').value) || 5,
        sampler: document.getElementById('imgGenSampler').value.trim(),
        negativeBase: document.getElementById('imgGenNegBase').value,
        comfyWorkflowJson: document.getElementById('imgGenComfyWorkflow').value,
        comfyPosNodeId: document.getElementById('imgGenComfyPosId').value.trim(),
        comfyNegNodeId: document.getElementById('imgGenComfyNegId').value.trim(),
      };
      routerCfg = await api('/api/router/config', { method: 'POST', body: JSON.stringify({ imageGen: payload }) });
      renderRouterUI();
      toast('삽화 프로바이더 설정 저장됨');
    };
  }

  // ---------- TTS Config & Cast Management UI ----------
  const TTS_VOICE_GROUPS_CLIENT = ${JSON.stringify(TTS_VOICE_GROUPS)};
  const TTS_BUILTIN_VOICE_REFS_CLIENT = ${JSON.stringify(TTS_BUILTIN_VOICE_REFERENCES)};
  const TTS_TONE_TAG_PRESETS_CLIENT = ${JSON.stringify(TTS_TONE_TAG_PRESETS)};
  let ttsLiveVoices = { fish: [], openai_qwen: [] };
  let activeVpTab = 'fish';

  function getSavedVoiceProfiles() {
    const vp = (routerCfg && routerCfg.tts && routerCfg.tts.voiceProfiles) || {};
    return {
      fish: Array.isArray(vp.fish) ? vp.fish : [],
      openai_qwen: Array.isArray(vp.openai_qwen) ? vp.openai_qwen : [],
    };
  }

  function getActiveTtsGroup() {
    const provEl = document.getElementById('ttsProviderSel');
    const prov = (provEl && provEl.value) || (routerCfg && routerCfg.tts && routerCfg.tts.provider) || 'fish_local';
    return (prov === 'fish_local' || prov === 'fish_cloud') ? 'fish' : 'openai_qwen';
  }

  function inferClientVoiceGroup(voiceId, preferredGroup) {
    if (preferredGroup === 'fish' || preferredGroup === 'openai_qwen') return preferredGroup;
    const id = String(voiceId || '').trim();
    const saved = getSavedVoiceProfiles();
    if (id) {
      if (saved.fish.some((v) => v.id === id)) return 'fish';
      if (saved.openai_qwen.some((v) => v.id === id)) return 'openai_qwen';
      if ((ttsLiveVoices.fish || []).some((v) => v.id === id)) return 'fish';
      if ((ttsLiveVoices.openai_qwen || []).some((v) => v.id === id)) return 'openai_qwen';
      const bi = (TTS_BUILTIN_VOICE_REFS_CLIENT.openai_qwen || []);
      if (bi.some((v) => v.id.toLowerCase() === id.toLowerCase())) return 'openai_qwen';
    }
    return getActiveTtsGroup();
  }

  function getTtsVoiceOptionsForGroup(group) {
    const grp = group === 'openai_qwen' ? 'openai_qwen' : 'fish';
    const out = [];
    const seen = new Set();
    const pushItem = (id, label, badge) => {
      const cleanId = String(id || '').trim();
      if (!cleanId || seen.has(cleanId)) return;
      seen.add(cleanId);
      const rawLabel = String(label || cleanId).trim();
      const base = rawLabel === cleanId ? cleanId : (rawLabel + ' (' + cleanId + ')');
      out.push({ id: cleanId, label: (badge ? badge + ' ' : '') + base });
    };
    const saved = getSavedVoiceProfiles()[grp] || [];
    for (const v of saved) pushItem(v.id, v.label, '★');
    const live = ttsLiveVoices[grp] || [];
    for (const v of live) pushItem(v.id, v.label || v.id, '🌐');
    const builtin = TTS_BUILTIN_VOICE_REFS_CLIENT[grp] || [];
    for (const v of builtin) pushItem(v.id, v.label || v.id, '');
    return out;
  }

  function buildVoiceGroupOptionsHtml(selectedGroup) {
    const grp = selectedGroup === 'openai_qwen' ? 'openai_qwen' : 'fish';
    return TTS_VOICE_GROUPS_CLIENT.map((g) =>
      '<option value="' + esc(g.id) + '"' + (g.id === grp ? ' selected' : '') + '>' + esc(g.label) + '</option>'
    ).join('');
  }

  function buildVoiceRefOptionsHtml(group, currentVoiceId, emptyLabel) {
    const cur = String(currentVoiceId || '').trim();
    const items = getTtsVoiceOptionsForGroup(group);
    let matched = false;
    const opts = ['<option value="">' + esc(emptyLabel || '-- 기본 / 선택 안 함 --') + '</option>'];
    for (const item of items) {
      const isSel = Boolean(cur && item.id === cur);
      if (isSel) matched = true;
      opts.push('<option value="' + esc(item.id) + '"' + (isSel ? ' selected' : '') + '>' + esc(item.label) + '</option>');
    }
    const isCustom = Boolean(cur && !matched);
    opts.push('<option value="__custom__"' + (isCustom ? ' selected' : '') + '>✏️ 직접 입력...</option>');
    return opts.join('');
  }

  function buildToneTagOptionsHtml(currentTag, emptyLabel) {
    const cur = String(currentTag || '').trim();
    const emotions = TTS_TONE_TAG_PRESETS_CLIENT.filter((t) => t.category === 'emotion');
    const delivery = TTS_TONE_TAG_PRESETS_CLIENT.filter((t) => t.category !== 'emotion');
    let matched = !cur;
    const renderOpt = (t) => {
      const isSel = Boolean(cur && t.value.toLowerCase() === cur.toLowerCase());
      if (isSel) matched = true;
      return '<option value="' + esc(t.value) + '"' + (isSel ? ' selected' : '') + '>' + esc(t.label) + '</option>';
    };
    return '<option value="">' + esc(emptyLabel || '-- 톤 태그 없음 (기본) --') + '</option>' +
      '<optgroup label="감정 (Emotions)">' + emotions.map(renderOpt).join('') + '</optgroup>' +
      '<optgroup label="발성 · 속마음 (Delivery)">' + delivery.map(renderOpt).join('') + '</optgroup>' +
      '<option value="__custom__"' + (!matched && cur ? ' selected' : '') + '>✏️ 직접 입력...</option>';
  }

  function syncVoiceDatalistOptions() {
    const dl = document.getElementById('ttsVoiceDatalist');
    if (!dl) return;
    const all = [...getTtsVoiceOptionsForGroup('fish'), ...getTtsVoiceOptionsForGroup('openai_qwen')];
    const seen = new Set();
    const opts = [];
    for (const item of all) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      opts.push('<option value="' + esc(item.id) + '" label="' + esc(item.label) + '"></option>');
    }
    dl.innerHTML = opts.join('');
  }

  function syncToneTagControl(selEl, inpEl, val, emptyLabel) {
    if (!selEl || !inpEl) return;
    const v = String(val !== undefined ? val : inpEl.value || '').trim();
    inpEl.value = v;
    selEl.innerHTML = buildToneTagOptionsHtml(v, emptyLabel);
    const isCustom = selEl.value === '__custom__';
    inpEl.style.display = isCustom ? 'block' : 'none';
  }

  function bindToneTagPair(selId, inpId, emptyLabel) {
    const selEl = document.getElementById(selId);
    const inpEl = document.getElementById(inpId);
    if (!selEl || !inpEl) return;
    selEl.onchange = () => {
      if (selEl.value === '__custom__') {
        inpEl.style.display = 'block';
        inpEl.focus();
      } else {
        inpEl.value = selEl.value;
        inpEl.style.display = 'none';
      }
    };
    inpEl.oninput = () => {
      const cur = inpEl.value.trim();
      const preset = TTS_TONE_TAG_PRESETS_CLIENT.find((t) => t.value.toLowerCase() === cur.toLowerCase());
      if (!cur) selEl.value = '';
      else if (preset) selEl.value = preset.value;
      else selEl.value = '__custom__';
    };
    syncToneTagControl(selEl, inpEl, inpEl.value, emptyLabel);
  }

  function syncVoicePickerControl(groupSelEl, refSelEl, inpEl, emptyLabel, preferredGroup) {
    if (!groupSelEl || !refSelEl || !inpEl) return;
    const grp = inferClientVoiceGroup(inpEl.value, preferredGroup);
    groupSelEl.innerHTML = buildVoiceGroupOptionsHtml(grp);
    refSelEl.innerHTML = buildVoiceRefOptionsHtml(grp, inpEl.value, emptyLabel);
  }

  function bindVoicePickerPair(groupSelId, refSelId, inpId, emptyLabel) {
    const groupSelEl = document.getElementById(groupSelId);
    const refSelEl = document.getElementById(refSelId);
    const inpEl = document.getElementById(inpId);
    if (!groupSelEl || !refSelEl || !inpEl) return;
    groupSelEl.onchange = () => {
      refSelEl.innerHTML = buildVoiceRefOptionsHtml(groupSelEl.value, inpEl.value, emptyLabel);
    };
    refSelEl.onchange = () => {
      if (refSelEl.value === '__custom__') {
        inpEl.focus();
      } else {
        inpEl.value = refSelEl.value;
      }
    };
    inpEl.oninput = () => {
      refSelEl.innerHTML = buildVoiceRefOptionsHtml(groupSelEl.value, inpEl.value, emptyLabel);
    };
    syncVoicePickerControl(groupSelEl, refSelEl, inpEl, emptyLabel);
  }

  function refreshAllTtsPickers() {
    syncVoiceDatalistOptions();
    const pairs = [
      ['ttsNarVoiceGroupSel', 'ttsNarVoiceRefSel', 'ttsNarVoiceId', '-- 서버 기본 음성 --'],
      ['ttsFemVoiceGroupSel', 'ttsFemVoiceRefSel', 'ttsFemVoiceId', '-- 미지정 (서버 기본) --'],
      ['ttsMaleVoiceGroupSel', 'ttsMaleVoiceRefSel', 'ttsMaleVoiceId', '-- 미지정 (서버 기본) --'],
      ['ttsNeuVoiceGroupSel', 'ttsNeuVoiceRefSel', 'ttsNeuVoiceId', '-- 미지정 (서버 기본) --'],
      ['ttsTestVoiceGroupSel', 'ttsTestVoiceRefSel', 'ttsTestVoiceInp', '-- 기본 성별/나레이션 사용 --'],
      ['ttscVoiceGroupSel', 'ttscVoiceRefSel', 'ttscVoiceIdInp', '-- 기본 성별 풀 사용 --'],
    ];
    for (const [gId, rId, iId, lbl] of pairs) {
      const gEl = document.getElementById(gId);
      const rEl = document.getElementById(rId);
      const iEl = document.getElementById(iId);
      if (gEl && rEl && iEl) {
        const curGrp = gEl.value || inferClientVoiceGroup(iEl.value);
        syncVoicePickerControl(gEl, rEl, iEl, lbl, iEl.value ? inferClientVoiceGroup(iEl.value, curGrp) : curGrp);
      }
    }
  }

  function renderVoiceProfilesManager() {
    const box = document.getElementById('ttsVoiceProfilesBox');
    if (!box) return;
    const saved = getSavedVoiceProfiles();
    const list = saved[activeVpTab] || [];
    box.querySelectorAll('[data-vp-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-vp-tab') === activeVpTab);
    });
    const listEl = document.getElementById('ttsVpList');
    if (listEl) {
      if (!list.length) {
        listEl.innerHTML = '<div class="hint" style="margin:2px 0 4px;">' +
          (activeVpTab === 'fish'
            ? '등록된 Fish 레퍼런스 프로필이 없습니다. 직접 ID를 저장하거나 [이 영역 서버에서 불러오기]를 누르세요.'
            : '등록된 사용자 OpenAI/Qwen 프로필이 없습니다. (기본 내장 보이스 20종은 드롭다운에 자동 포함됩니다)') +
          '</div>';
      } else {
        listEl.innerHTML = list.map((item) => {
          const gLabel = item.gender === 'female' ? '♀' : (item.gender === 'male' ? '♂' : '·');
          return '<div class="tts-cast-item">' +
            '<div style="min-width:0;">' +
              '<div style="font-size:13px; font-weight:700;">' + esc(gLabel + ' ' + item.label) + '</div>' +
              '<div style="font-size:11px; color:var(--sub); word-break:break-all;">ID: ' + esc(item.id) + '</div>' +
            '</div>' +
            '<button type="button" class="pill" data-vp-del="' + esc(item.id) + '" style="color:var(--danger); flex-shrink:0;">삭제</button>' +
          '</div>';
        }).join('');
      }
    }
    const liveBox = document.getElementById('ttsVpLiveBox');
    const liveChips = document.getElementById('ttsVpLiveChips');
    if (liveBox && liveChips) {
      const liveItems = ttsLiveVoices[activeVpTab] || [];
      const savedSet = new Set(list.map((x) => x.id));
      const unsaved = liveItems.filter((x) => x && x.id && !savedSet.has(x.id));
      if (unsaved.length) {
        liveBox.style.display = 'block';
        liveChips.innerHTML = unsaved.map((v) =>
          '<button type="button" class="pill" data-vp-quick-id="' + esc(v.id) + '" data-vp-quick-label="' + esc(v.label || v.id) + '">+ ' + esc(v.label || v.id) + '</button>'
        ).join('');
      } else {
        liveBox.style.display = 'none';
        liveChips.innerHTML = '';
      }
    }
  }

  function storeLiveVoicesFromResponse(r, fallbackGroup) {
    if (!r || !Array.isArray(r.voices)) return;
    const grp = r.voiceGroup === 'fish' || r.voiceGroup === 'openai_qwen'
      ? r.voiceGroup
      : (fallbackGroup === 'openai_qwen' ? 'openai_qwen' : 'fish');
    const items = Array.isArray(r.voiceItems) && r.voiceItems.length
      ? r.voiceItems.map((x) => ({ id: x.id, label: x.label || x.id }))
      : r.voices.map((v) => ({ id: String(v), label: String(v) }));
    ttsLiveVoices[grp] = items;
    if (r.voiceProfiles && routerCfg && routerCfg.tts) {
      routerCfg.tts.voiceProfiles = r.voiceProfiles;
    }
    refreshAllTtsPickers();
    renderVoiceProfilesManager();
  }

  const TTS_CLIENT_DEFAULTS = {
    fish_local: { url: 'http://127.0.0.1:8080/v1/tts', model: 's2-pro', isFish: true, hint: 'Windows에서는 <b>Pinokio</b>(Fish Speech 원클릭)나 <code>fish-speech/tools/api_server.py</code>를 띄워 연결하세요.' },
    openai_compat_local: { url: 'http://127.0.0.1:8881/v1/audio/speech', model: 'tts-1', isFish: false, hint: '<b>LocalAI · TTS-WebUI · vLLM-Omni · Qwen3-TTS FastAPI · Speaches</b> 등 <code>/v1/audio/speech</code> 호환 로컬 허브에 연결됩니다.' },
    fish_cloud: { url: 'https://api.fish.audio/v1/tts', model: 's2-pro', isFish: true, hint: 'Fish Audio 상용 클라우드 API입니다. 로컬 Fish와 동일한 Voice ID 및 감정 태그를 사용합니다.' },
    openai_compat_cloud: { url: 'https://api.openai.com/v1/audio/speech', model: 'gpt-4o-mini-tts', isFish: false, hint: 'OpenAI TTS(<code>gpt-4o-mini-tts</code>) 등 상용 <code>/v1/audio/speech</code> API입니다.' },
  };
  let ttsGlobalCastDraft = [];
  let ttsGlobalCastEditIdx = null;

  function renderGlobalTtsCastBox() {
    const listEl = document.getElementById('ttsGlobalCastList');
    const editorEl = document.getElementById('ttsGlobalCastEditor');
    if (listEl) {
      listEl.innerHTML = ttsGlobalCastDraft.length
        ? ttsGlobalCastDraft.map((c, idx) => {
            const gLabel = c.gender === 'female' ? '♀ 여성' : (c.gender === 'male' ? '♂ 남성' : '중성');
            const vTxt = c.voiceId ? ('Voice: ' + c.voiceId) : '기본 성별 풀';
            const aliasTxt = (c.aliases && c.aliases.length) ? (' (' + c.aliases.join(', ') + ')') : '';
            const toneTxt = [c.dialogueToneTag ? ('대화:' + c.dialogueToneTag) : '', c.thoughtToneTag ? ('속마음:' + c.thoughtToneTag) : ''].filter(Boolean).join(' · ');
            return '<div class="tts-cast-item">' +
              '<div style="min-width:0;">' +
                '<div style="font-size:13.5px; font-weight:700;">' + esc(c.name) + '<span style="font-weight:500; color:var(--sub); font-size:11.5px;">' + esc(aliasTxt) + '</span></div>' +
                '<div style="font-size:11.5px; color:var(--sub);">' + esc(gLabel + ' · ' + vTxt + (toneTxt ? ' · ' + toneTxt : '')) + '</div>' +
              '</div>' +
              '<div style="display:flex; gap:5px; flex-shrink:0;">' +
                '<button type="button" class="pill" data-ttsc-preview="' + idx + '" title="미리듣기">▶</button>' +
                '<button type="button" class="pill" data-ttsc-edit="' + idx + '">편집</button>' +
                '<button type="button" class="pill" data-ttsc-del="' + idx + '" style="color:var(--danger);">삭제</button>' +
              '</div>' +
            '</div>';
          }).join('')
        : '<div class="hint" style="margin:2px 0;">등록된 등장인물 보이스가 없습니다. <b>+ 캐릭터 추가</b>로 화자별 목소리를 등록하거나, 미등록 화자는 위 기본 성별 풀을 사용합니다.</div>';
    }
    if (editorEl) {
      if (ttsGlobalCastEditIdx === null) {
        editorEl.innerHTML = '';
        return;
      }
      const c = (ttsGlobalCastEditIdx >= 0 && ttsGlobalCastDraft[ttsGlobalCastEditIdx]) ? ttsGlobalCastDraft[ttsGlobalCastEditIdx] : {
        id: 'tts-char-' + Date.now(), name: '', aliases: [], gender: 'female', voiceGroup: '', voiceId: '',
        dialogueToneTag: '', thoughtToneTag: 'whispering', speed: 1.0, thoughtSpeed: 0.94,
      };
      const curVoiceGroup = inferClientVoiceGroup(c.voiceId || '', c.voiceGroup || '');
      const dlgPresetMatch = !c.dialogueToneTag || TTS_TONE_TAG_PRESETS_CLIENT.some((t) => t.value.toLowerCase() === String(c.dialogueToneTag).toLowerCase());
      const thVal = c.thoughtToneTag !== undefined ? c.thoughtToneTag : 'whispering';
      const thPresetMatch = !thVal || TTS_TONE_TAG_PRESETS_CLIENT.some((t) => t.value.toLowerCase() === String(thVal).toLowerCase());
      editorEl.innerHTML =
        '<div class="tts-subbox" id="ttsGlobalEditorCard" style="margin-top:8px;">' +
          '<div class="tts-subbox-title"><span>' + (ttsGlobalCastEditIdx >= 0 ? '✏️ 등장인물 보이스 편집' : '➕ 새 등장인물 보이스 추가') + '</span></div>' +
          '<div class="grid-2">' +
            '<div><label class="f-label" style="margin-top:2px;">등장인물 이름</label><input class="f-inp" id="ttscNameInp" value="' + esc(c.name || '') + '" placeholder="예: 주시은" /></div>' +
            '<div><label class="f-label" style="margin-top:2px;">성별</label>' +
              '<select class="f-inp" id="ttscGenderSel">' +
                '<option value="female"' + (c.gender === 'female' ? ' selected' : '') + '>여성 (♀)</option>' +
                '<option value="male"' + (c.gender === 'male' ? ' selected' : '') + '>남성 (♂)</option>' +
                '<option value="neutral"' + (c.gender === 'neutral' ? ' selected' : '') + '>중성/기타</option>' +
              '</select>' +
            '</div>' +
          '</div>' +
          '<label class="f-label" style="margin-top:4px;">별칭 (쉼표 구분)</label>' +
          '<input class="f-inp" id="ttscAliasesInp" value="' + esc(Array.isArray(c.aliases) ? c.aliases.join(', ') : '') + '" placeholder="예: 시은, Sieun, 그녀" />' +
          '<label class="f-label" style="margin-top:6px;">전용 Voice / Reference ID (1단계: 영역 → 2단계: 보이스 ID)</label>' +
          '<div class="tts-voice-tier">' +
            '<select class="f-inp" id="ttscVoiceGroupSel" aria-label="캐릭터 보이스 영역">' + buildVoiceGroupOptionsHtml(curVoiceGroup) + '</select>' +
            '<select class="f-inp" id="ttscVoiceRefSel" aria-label="캐릭터 보이스 레퍼런스">' + buildVoiceRefOptionsHtml(curVoiceGroup, c.voiceId || '', '-- 기본 성별 풀 사용 --') + '</select>' +
          '</div>' +
          '<div style="display:flex; gap:6px; align-items:center; margin-top:6px;">' +
            '<input class="f-inp" id="ttscVoiceIdInp" list="ttsVoiceDatalist" value="' + esc(c.voiceId || '') + '" placeholder="Fish reference_id 또는 OpenAI/Qwen voice (직접 입력 가능)" style="flex:1; min-width:0;" />' +
            '<button type="button" class="pill" id="ttscSaveVoiceProfileBtn" title="현재 영역 프로필로 저장" style="flex-shrink:0;">+ 프로필 저장</button>' +
          '</div>' +
          '<div class="grid-2">' +
            '<div>' +
              '<label class="f-label" style="margin-top:6px;">대화 톤 태그</label>' +
              '<select class="f-inp" id="ttscDlgTagSel" aria-label="대화 톤 태그">' + buildToneTagOptionsHtml(c.dialogueToneTag || '', '-- 톤 태그 없음 (기본) --') + '</select>' +
              '<input class="f-inp" id="ttscDlgTagInp" value="' + esc(c.dialogueToneTag || '') + '" placeholder="직접 입력 (예: soft)" style="margin-top:4px; display:' + (dlgPresetMatch ? 'none' : 'block') + ';" />' +
            '</div>' +
            '<div>' +
              '<label class="f-label" style="margin-top:6px;">속마음 톤 태그</label>' +
              '<select class="f-inp" id="ttscThTagSel" aria-label="속마음 톤 태그">' + buildToneTagOptionsHtml(thVal, '-- 톤 태그 없음 (기본) --') + '</select>' +
              '<input class="f-inp" id="ttscThTagInp" value="' + esc(thVal) + '" placeholder="직접 입력 (예: whispering)" style="margin-top:4px; display:' + (thPresetMatch ? 'none' : 'block') + ';" />' +
            '</div>' +
          '</div>' +
          '<div class="grid-2">' +
            '<div><label class="f-label" style="margin-top:4px;">대화 속도</label><input class="f-inp" id="ttscSpeedInp" type="number" step="0.02" min="0.5" max="2.0" value="' + esc(String(c.speed || 1.0)) + '" /></div>' +
            '<div><label class="f-label" style="margin-top:4px;">속마음 속도</label><input class="f-inp" id="ttscThSpeedInp" type="number" step="0.02" min="0.5" max="2.0" value="' + esc(String(c.thoughtSpeed || 0.94)) + '" /></div>' +
          '</div>' +
          '<div class="btn-row">' +
            '<button type="button" class="btn" id="ttscApplyEditBtn">적용 및 저장</button>' +
            '<button type="button" class="btn sec" id="ttscEditorPreviewBtn">▶ 미리듣기</button>' +
            '<button type="button" class="btn sec" id="ttscCancelEditBtn">취소</button>' +
          '</div>' +
        '</div>';
    }
  }

  function collectTtsFormPayload() {
    const prov = document.getElementById('ttsProviderSel').value;
    const cur = (routerCfg && routerCfg.tts) || {};
    const nar = cur.narration || {};
    const dv = cur.defaultVoices || {};
    const fx = cur.effects || {};
    return {
      enabled: document.getElementById('ttsEnabledChk').checked,
      provider: prov,
      apiUrl: document.getElementById('ttsApiUrl').value.trim(),
      apiKey: document.getElementById('ttsApiKey').value.trim(),
      model: document.getElementById('ttsModel').value.trim(),
      format: document.getElementById('ttsFormat').value,
      parseMode: document.getElementById('ttsParseMode').value,
      llmSource: document.getElementById('ttsLlmSource').value,
      fishTagStyle: document.getElementById('ttsFishTagStyle').value,
      narration: {
        ...nar,
        voiceId: document.getElementById('ttsNarVoiceId').value.trim(),
        toneTag: document.getElementById('ttsNarToneTag').value.trim(),
        speed: Number(document.getElementById('ttsNarSpeed').value) || 0.96,
        instruction: document.getElementById('ttsNarInstr').value.trim(),
      },
      defaultVoices: {
        female: { ...(dv.female || {}), voiceId: document.getElementById('ttsFemVoiceId').value.trim(), thoughtToneTag: document.getElementById('ttsFemThoughtTag').value.trim(), thoughtSpeed: Number(document.getElementById('ttsDefThoughtSpeed').value) || 0.94 },
        male: { ...(dv.male || {}), voiceId: document.getElementById('ttsMaleVoiceId').value.trim(), thoughtToneTag: document.getElementById('ttsMaleThoughtTag').value.trim(), thoughtSpeed: Number(document.getElementById('ttsDefThoughtSpeed').value) || 0.94 },
        neutral: { ...(dv.neutral || {}), voiceId: document.getElementById('ttsNeuVoiceId').value.trim(), thoughtSpeed: Number(document.getElementById('ttsDefThoughtSpeed').value) || 0.94 },
      },
      characters: ttsGlobalCastDraft.slice(),
      effects: {
        ...fx,
        thoughtFxEnabled: document.getElementById('ttsFxEnabledChk').checked,
        thoughtReverbMix: Number(document.getElementById('ttsFxReverbInp').value),
        thoughtFilterHz: Number(document.getElementById('ttsFxFilterInp').value) || 2800,
        thoughtRate: Number(document.getElementById('ttsFxThRateInp').value) || 0.95,
        narrationRate: Number(document.getElementById('ttsFxNarRateInp').value) || 0.96,
      },
    };
  }

  function syncTtsProviderUI(prov, overwriteUrlModel) {
    const meta = TTS_CLIENT_DEFAULTS[prov] || TTS_CLIENT_DEFAULTS.fish_local;
    const hintEl = document.getElementById('ttsProviderHint');
    const urlEl = document.getElementById('ttsApiUrl');
    const modelEl = document.getElementById('ttsModel');
    const tagRow = document.getElementById('ttsFishTagRow');
    if (hintEl) hintEl.innerHTML = meta.hint;
    if (urlEl) {
      urlEl.placeholder = meta.url;
      if (overwriteUrlModel) urlEl.value = '';
    }
    if (modelEl && overwriteUrlModel) modelEl.value = meta.model;
    if (tagRow) tagRow.style.display = meta.isFish ? 'block' : 'none';
  }

  function hydrateTtsConfigUI() {
    if (!document.getElementById('ttsConfigCard')) return;
    const t = (routerCfg && routerCfg.tts && typeof routerCfg.tts === 'object') ? routerCfg.tts : {};
    const prov = t.provider || 'fish_local';
    document.getElementById('ttsEnabledChk').checked = t.enabled !== false;
    document.getElementById('ttsProviderSel').value = prov;
    document.getElementById('ttsApiUrl').value = t.apiUrl || '';
    document.getElementById('ttsApiKey').value = '';
    document.getElementById('ttsApiKey').placeholder = t.hasKey ? ('저장됨: ' + t.keyPreview + ' (비우면 유지)') : 'Fish Audio / OpenAI API Key (로컬은 비워도 됨)';
    document.getElementById('ttsModel').value = t.model || (TTS_CLIENT_DEFAULTS[prov] ? TTS_CLIENT_DEFAULTS[prov].model : 's2-pro');
    document.getElementById('ttsFormat').value = t.format || 'mp3';
    document.getElementById('ttsParseMode').value = t.parseMode || 'hybrid';
    document.getElementById('ttsLlmSource').value = t.llmSource || 'translator';
    document.getElementById('ttsFishTagStyle').value = t.fishTagStyle || 'brackets';
    const presetSel = document.getElementById('ttsEndpointPresetSel');
    if (presetSel) presetSel.value = '';
    const discPick = document.getElementById('ttsDiscoveredPick');
    if (discPick) { discPick.innerHTML = ''; discPick.style.display = 'none'; }
    const discSt = document.getElementById('ttsDiscoverStatus');
    if (discSt) discSt.textContent = '';
    setModelPickList('ttsModelPick', 'ttsModelStatus', [], '');
    syncTtsProviderUI(prov, false);

    const nar = t.narration || {};
    document.getElementById('ttsNarVoiceId').value = nar.voiceId || '';
    document.getElementById('ttsNarToneTag').value = nar.toneTag !== undefined ? nar.toneTag : 'calm';
    document.getElementById('ttsNarSpeed').value = nar.speed || 0.96;
    document.getElementById('ttsNarInstr').value = nar.instruction || '';

    const dv = t.defaultVoices || {};
    const fem = dv.female || {};
    const male = dv.male || {};
    const neu = dv.neutral || {};
    document.getElementById('ttsFemVoiceId').value = fem.voiceId || '';
    document.getElementById('ttsMaleVoiceId').value = male.voiceId || '';
    document.getElementById('ttsNeuVoiceId').value = neu.voiceId || '';
    document.getElementById('ttsFemThoughtTag').value = fem.thoughtToneTag !== undefined ? fem.thoughtToneTag : 'whispering';
    document.getElementById('ttsMaleThoughtTag').value = male.thoughtToneTag !== undefined ? male.thoughtToneTag : 'whispering';
    document.getElementById('ttsDefThoughtSpeed').value = fem.thoughtSpeed || 0.94;

    syncToneTagControl(document.getElementById('ttsNarToneTagSel'), document.getElementById('ttsNarToneTag'), document.getElementById('ttsNarToneTag').value, '-- 톤 태그 없음 (기본) --');
    syncToneTagControl(document.getElementById('ttsFemThoughtTagSel'), document.getElementById('ttsFemThoughtTag'), document.getElementById('ttsFemThoughtTag').value, '-- 톤 태그 없음 (기본) --');
    syncToneTagControl(document.getElementById('ttsMaleThoughtTagSel'), document.getElementById('ttsMaleThoughtTag'), document.getElementById('ttsMaleThoughtTag').value, '-- 톤 태그 없음 (기본) --');
    ttsGlobalCastDraft = Array.isArray(t.characters) ? JSON.parse(JSON.stringify(t.characters)) : [];
    ttsGlobalCastEditIdx = null;
    renderGlobalTtsCastBox();
    refreshAllTtsPickers();
    renderVoiceProfilesManager();

    const fx = t.effects || {};
    document.getElementById('ttsFxEnabledChk').checked = fx.thoughtFxEnabled !== false;
    document.getElementById('ttsFxReverbInp').value = fx.thoughtReverbMix !== undefined ? fx.thoughtReverbMix : 0.32;
    document.getElementById('ttsFxFilterInp').value = fx.thoughtFilterHz || 2800;
    document.getElementById('ttsFxThRateInp').value = fx.thoughtRate || 0.95;
    document.getElementById('ttsFxNarRateInp').value = fx.narrationRate || 0.96;
  }

  (function bindTtsConfigUI() {
    const provSel = document.getElementById('ttsProviderSel');
    if (provSel) provSel.onchange = () => {
      syncTtsProviderUI(provSel.value, true);
      setModelPickList('ttsModelPick', 'ttsModelStatus', [], '');
    };

    const TTS_PRESET_MAP = {
      fish_local_8081: { provider: 'fish_local', apiUrl: 'http://127.0.0.1:8081/v1/tts', model: 's2-pro', fishTagStyle: 'brackets' },
      fish_local_8080: { provider: 'fish_local', apiUrl: 'http://127.0.0.1:8080/v1/tts', model: 's2-pro', fishTagStyle: 'brackets' },
      localai_8080: { provider: 'openai_compat_local', apiUrl: 'http://127.0.0.1:8080/v1/audio/speech', model: 'fish-speech-s2-pro', fishTagStyle: 'none' },
      qwen3_8881: { provider: 'openai_compat_local', apiUrl: 'http://127.0.0.1:8881/v1/audio/speech', model: 'tts-1', fishTagStyle: 'none' },
      vllm_8000: { provider: 'openai_compat_local', apiUrl: 'http://127.0.0.1:8000/v1/audio/speech', model: 'fishaudio/s2-pro', fishTagStyle: 'none' },
      fish_cloud: { provider: 'fish_cloud', apiUrl: 'https://api.fish.audio/v1/tts', model: 's2-pro', fishTagStyle: 'brackets' },
      openai_cloud: { provider: 'openai_compat_cloud', apiUrl: 'https://api.openai.com/v1/audio/speech', model: 'gpt-4o-mini-tts', fishTagStyle: 'none' },
    };

    function applyTtsPresetValues(preset) {
      if (!preset) return;
      document.getElementById('ttsProviderSel').value = preset.provider;
      syncTtsProviderUI(preset.provider, false);
      document.getElementById('ttsApiUrl').value = preset.apiUrl || '';
      document.getElementById('ttsModel').value = preset.model || '';
      if (preset.fishTagStyle) document.getElementById('ttsFishTagStyle').value = preset.fishTagStyle;
      if (Array.isArray(preset.models) && preset.models.length) {
        setModelPickList('ttsModelPick', 'ttsModelStatus', preset.models, '서버에서 모델 ' + preset.models.length + '개를 불러왔습니다.');
      } else {
        setModelPickList('ttsModelPick', 'ttsModelStatus', [], '프리셋이 적용되었습니다. [🔄 모델 불러오기]로 확인하거나 바로 저장하세요.');
      }
    }

    const presetSel = document.getElementById('ttsEndpointPresetSel');
    if (presetSel) presetSel.onchange = () => {
      const p = TTS_PRESET_MAP[presetSel.value];
      if (!p) return;
      applyTtsPresetValues(p);
      toast('TTS 엔드포인트 프리셋 적용됨');
    };

    let ttsDiscoveredList = [];
    const discoverBtn = document.getElementById('ttsDiscoverBtn');
    const discoveredPick = document.getElementById('ttsDiscoveredPick');
    const discoverSt = document.getElementById('ttsDiscoverStatus');
    if (discoverBtn) discoverBtn.onclick = async () => {
      discoverBtn.disabled = true;
      if (discoverSt) discoverSt.textContent = '로컬 포트(8081 · 8080 · 8881 · 8000) 탐색 중...';
      try {
        const r = await api('/api/tts/discover');
        ttsDiscoveredList = Array.isArray(r.servers) ? r.servers : [];
        if (!ttsDiscoveredList.length) {
          if (discoveredPick) { discoveredPick.innerHTML = ''; discoveredPick.style.display = 'none'; }
          if (discoverSt) discoverSt.textContent = '실행 중인 로컬 TTS 서버를 찾지 못했습니다. 위 프리셋이나 주소를 직접 입력하세요.';
          return;
        }
        if (discoveredPick) {
          discoveredPick.innerHTML = '<option value="">-- 탐색된 로컬 서버 선택 (' + ttsDiscoveredList.length + '개) --</option>' +
            ttsDiscoveredList.map((s, idx) => '<option value="' + idx + '">' + esc(s.label) + '</option>').join('');
          discoveredPick.style.display = 'block';
          discoveredPick.value = '0';
        }
        applyTtsPresetValues(ttsDiscoveredList[0]);
        if (discoverSt) discoverSt.textContent = ttsDiscoveredList.length + '개 로컬 TTS 서버를 찾아 첫 번째 서버를 자동 입력했습니다.';
        toast('로컬 TTS 서버 ' + ttsDiscoveredList.length + '개 발견');
      } catch (e) {
        if (discoverSt) discoverSt.textContent = '탐색 오류: ' + e.message;
      } finally {
        discoverBtn.disabled = false;
      }
    };
    if (discoveredPick) discoveredPick.onchange = () => {
      const idx = Number(discoveredPick.value);
      if (!Number.isNaN(idx) && ttsDiscoveredList[idx]) {
        applyTtsPresetValues(ttsDiscoveredList[idx]);
        toast('선택한 로컬 서버로 적용됨');
      }
    };

    const loadModelsBtn = document.getElementById('ttsLoadModelsBtn');
    const ttsModelPick = document.getElementById('ttsModelPick');
    if (loadModelsBtn) loadModelsBtn.onclick = async () => {
      loadModelsBtn.disabled = true;
      setModelPickList('ttsModelPick', 'ttsModelStatus', [], '모델 목록 조회 중...');
      try {
        const r = await api('/api/tts/models', {
          method: 'POST',
          body: JSON.stringify({
            provider: document.getElementById('ttsProviderSel').value,
            apiUrl: document.getElementById('ttsApiUrl').value.trim(),
            apiKey: document.getElementById('ttsApiKey').value.trim(),
            model: document.getElementById('ttsModel').value.trim(),
          }),
        });
        if (r.resolvedEndpoint && document.getElementById('ttsApiUrl').value.trim()) {
          document.getElementById('ttsApiUrl').value = r.resolvedEndpoint;
        }
        const models = Array.isArray(r.models) ? r.models : [];
        setModelPickList('ttsModelPick', 'ttsModelStatus', models, r.statusMsg || (models.length + '개 모델 조회됨'));
        if (models.length && !document.getElementById('ttsModel').value.trim()) {
          document.getElementById('ttsModel').value = models[0].id;
        }
        storeLiveVoicesFromResponse(r, getActiveTtsGroup());
      } catch (e) {
        setModelPickList('ttsModelPick', 'ttsModelStatus', [], '모델 조회 실패: ' + e.message);
      } finally {
        loadModelsBtn.disabled = false;
      }
    };
    if (ttsModelPick) ttsModelPick.onchange = () => {
      if (ttsModelPick.value) {
        document.getElementById('ttsModel').value = ttsModelPick.value;
      }
    };

    const TTS_TEST_SAMPLES = {
      dialogue: { kind: 'dialogue', text: '안녕하세요. 창밖으로 비가 내리는 밤이네요. 지금 들리는 목소리가 자연스러운가요?' },
      thought: { kind: 'thought', text: '설마 벌써 눈치챈 건 아니겠지… 조용히 숨을 고르고 침착하게 행동해야 해.' },
      narration: { kind: 'narration', text: '가로등 불빛 아래 젖은 돌길이 은은하게 반짝였다. 잠시 멈춰 선 채, 깊은 밤의 공기를 들이마셨다.' },
    };
    let ttsTestBlobUrl = '';

    const testBox = document.getElementById('ttsTestBox');
    if (testBox) testBox.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tts-sample]');
      if (!btn) return;
      const sample = TTS_TEST_SAMPLES[btn.getAttribute('data-tts-sample')];
      if (!sample) return;
      const txtEl = document.getElementById('ttsTestTextInp');
      const kindEl = document.getElementById('ttsTestKindSel');
      if (txtEl) txtEl.value = sample.text;
      if (kindEl) kindEl.value = sample.kind;
    });

    async function runTtsSampleTest(opts) {
      ensureTtsAudioCtx();
      const statusEl = document.getElementById('ttsTestStatus');
      const audioEl = document.getElementById('ttsTestAudio');
      const tBtn = document.getElementById('testTtsBtn');
      if (tBtn) tBtn.disabled = true;
      if (statusEl) statusEl.textContent = '⏳ 음성 생성 중... (로컬 첫 요청은 몇 초 걸릴 수 있습니다)';
      toast('음성 생성 테스트 중...');
      try {
        const res = await fetch('/api/tts/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
          body: JSON.stringify({ ...opts, ttsOverride: collectTtsFormPayload() }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || ('HTTP ' + res.status));
        }
        const buf = await res.arrayBuffer();
        const mime = res.headers.get('content-type') || 'audio/mpeg';
        const provName = res.headers.get('x-tts-provider') || '';
        const voiceName = res.headers.get('x-tts-voice') || '';
        const elapsedMs = Number(res.headers.get('x-tts-elapsed-ms') || 0);
        const secTxt = elapsedMs > 0 ? (elapsedMs / 1000).toFixed(2) + '초' : '완료';
        const kbTxt = (buf.byteLength / 1024).toFixed(1) + ' KB';
        if (statusEl) {
          statusEl.textContent = '✅ 연결 성공 · ' + secTxt + ' · ' + kbTxt + ' · ' + mime +
            (provName ? ' · ' + provName : '') + (voiceName ? ' · Voice: ' + voiceName : '');
        }
        if (audioEl) {
          if (ttsTestBlobUrl) { try { URL.revokeObjectURL(ttsTestBlobUrl); } catch (_) {} }
          ttsTestBlobUrl = URL.createObjectURL(new Blob([buf], { type: mime }));
          audioEl.src = ttsTestBlobUrl;
          audioEl.style.display = 'block';
        }
        await playTtsArrayBuffer(buf, { kind: opts.kind || 'dialogue' });
        toast('테스트 음성 재생 완료');
      } catch (err) {
        if (statusEl) statusEl.textContent = '❌ 연결 실패: ' + (err && err.message ? err.message : String(err));
        throw err;
      } finally {
        if (tBtn) tBtn.disabled = false;
      }
    }

    const testBtn = document.getElementById('testTtsBtn');
    if (testBtn) testBtn.onclick = async () => {
      try {
        const txtEl = document.getElementById('ttsTestTextInp');
        const kindEl = document.getElementById('ttsTestKindSel');
        const genderEl = document.getElementById('ttsTestGenderSel');
        const voiceEl = document.getElementById('ttsTestVoiceInp');
        const sampleText = (txtEl && txtEl.value.trim()) || '안녕하세요. 지금 들리는 목소리와 톤이 자연스러운가요?';
        await runTtsSampleTest({
          text: sampleText,
          kind: (kindEl && kindEl.value) || 'dialogue',
          gender: (genderEl && genderEl.value) || 'female',
          voiceId: (voiceEl && voiceEl.value.trim()) || '',
        });
      } catch (e) { toast('연결 테스트 실패: ' + e.message); }
    };

    const saveBtn = document.getElementById('saveTtsBtn');
    if (saveBtn) saveBtn.onclick = async () => {
      const payload = collectTtsFormPayload();
      routerCfg = await api('/api/router/config', { method: 'POST', body: JSON.stringify({ tts: payload }) });
      ttsAnalyzeCache.clear();
      ttsAudioBufferCache.clear();
      renderRouterUI();
      if (currentTab === 'chat') renderChat();
      toast('TTS 설정 저장됨');
    };

    bindVoicePickerPair('ttsNarVoiceGroupSel', 'ttsNarVoiceRefSel', 'ttsNarVoiceId', '-- 서버 기본 음성 --');
    bindVoicePickerPair('ttsFemVoiceGroupSel', 'ttsFemVoiceRefSel', 'ttsFemVoiceId', '-- 미지정 (서버 기본) --');
    bindVoicePickerPair('ttsMaleVoiceGroupSel', 'ttsMaleVoiceRefSel', 'ttsMaleVoiceId', '-- 미지정 (서버 기본) --');
    bindVoicePickerPair('ttsNeuVoiceGroupSel', 'ttsNeuVoiceRefSel', 'ttsNeuVoiceId', '-- 미지정 (서버 기본) --');
    bindVoicePickerPair('ttsTestVoiceGroupSel', 'ttsTestVoiceRefSel', 'ttsTestVoiceInp', '-- 기본 성별/나레이션 사용 --');
    bindToneTagPair('ttsNarToneTagSel', 'ttsNarToneTag', '-- 톤 태그 없음 (기본) --');
    bindToneTagPair('ttsFemThoughtTagSel', 'ttsFemThoughtTag', '-- 톤 태그 없음 (기본) --');
    bindToneTagPair('ttsMaleThoughtTagSel', 'ttsMaleThoughtTag', '-- 톤 태그 없음 (기본) --');

    const vpBox = document.getElementById('ttsVoiceProfilesBox');
    if (vpBox) {
      vpBox.addEventListener('click', async (e) => {
        const tabBtn = e.target.closest('[data-vp-tab]');
        if (tabBtn) {
          activeVpTab = tabBtn.getAttribute('data-vp-tab') === 'openai_qwen' ? 'openai_qwen' : 'fish';
          renderVoiceProfilesManager();
          return;
        }
        const delBtn = e.target.closest('[data-vp-del]');
        if (delBtn) {
          const delId = delBtn.getAttribute('data-vp-del');
          try {
            routerCfg = await api('/api/tts/voice-profiles', {
              method: 'POST',
              body: JSON.stringify({ action: 'delete', group: activeVpTab, id: delId }),
            });
            refreshAllTtsPickers();
            renderVoiceProfilesManager();
            toast('보이스 프로필 삭제됨');
          } catch (err) { toast('프로필 삭제 실패: ' + err.message); }
          return;
        }
        const quickBtn = e.target.closest('[data-vp-quick-id]');
        if (quickBtn) {
          const qId = quickBtn.getAttribute('data-vp-quick-id');
          const qLbl = quickBtn.getAttribute('data-vp-quick-label') || qId;
          const gVal = (document.getElementById('ttsVpGenderSel') && document.getElementById('ttsVpGenderSel').value) || 'neutral';
          try {
            routerCfg = await api('/api/tts/voice-profiles', {
              method: 'POST',
              body: JSON.stringify({ action: 'upsert', group: activeVpTab, item: { id: qId, label: qLbl, gender: gVal } }),
            });
            refreshAllTtsPickers();
            renderVoiceProfilesManager();
            toast('프로필에 추가됨: ' + qLbl);
          } catch (err) { toast('프로필 추가 실패: ' + err.message); }
        }
      });

      const vpAddBtn = document.getElementById('ttsVpAddBtn');
      if (vpAddBtn) vpAddBtn.onclick = async () => {
        const idInp = document.getElementById('ttsVpIdInp');
        const lblInp = document.getElementById('ttsVpLabelInp');
        const genSel = document.getElementById('ttsVpGenderSel');
        const idVal = (idInp && idInp.value.trim()) || '';
        const lblVal = (lblInp && lblInp.value.trim()) || idVal;
        const gVal = (genSel && genSel.value) || 'female';
        if (!idVal) { toast('Voice / Reference ID를 입력하세요.'); return; }
        try {
          routerCfg = await api('/api/tts/voice-profiles', {
            method: 'POST',
            body: JSON.stringify({ action: 'upsert', group: activeVpTab, item: { id: idVal, label: lblVal, gender: gVal } }),
          });
          if (idInp) idInp.value = '';
          if (lblInp) lblInp.value = '';
          refreshAllTtsPickers();
          renderVoiceProfilesManager();
          toast('보이스 레퍼런스 프로필 저장됨');
        } catch (err) { toast('프로필 저장 실패: ' + err.message); }
      };

      const vpFetchBtn = document.getElementById('ttsVpFetchBtn');
      if (vpFetchBtn) vpFetchBtn.onclick = async () => {
        const stEl = document.getElementById('ttsVpStatus');
        vpFetchBtn.disabled = true;
        if (stEl) stEl.textContent = (activeVpTab === 'fish' ? 'Fish' : 'OpenAI/Qwen') + ' 서버에서 보이스 목록 조회 중...';
        try {
          const payload = { group: activeVpTab };
          if (getActiveTtsGroup() === activeVpTab) {
            const urlVal = document.getElementById('ttsApiUrl').value.trim();
            const keyVal = document.getElementById('ttsApiKey').value.trim();
            const modVal = document.getElementById('ttsModel').value.trim();
            if (urlVal) payload.apiUrl = urlVal;
            if (keyVal) payload.apiKey = keyVal;
            if (modVal) payload.model = modVal;
          }
          const r = await api('/api/tts/models', { method: 'POST', body: JSON.stringify(payload) });
          storeLiveVoicesFromResponse(r, activeVpTab);
          const cnt = Array.isArray(r.voices) ? r.voices.length : 0;
          if (stEl) stEl.textContent = r.statusMsg || ('보이스 ' + cnt + '개 불러옴');
          toast((activeVpTab === 'fish' ? 'Fish' : 'OpenAI/Qwen') + ' 보이스 ' + cnt + '개 불러옴');
        } catch (err) {
          if (stEl) stEl.textContent = '조회 실패: ' + err.message;
          toast('보이스 조회 실패: ' + err.message);
        } finally {
          vpFetchBtn.disabled = false;
        }
      };
    }
    async function previewTtsVoiceItem(opts) {
      ensureTtsAudioCtx();
      toast('음성 미리듣기 생성 중...');
      const res = await fetch('/api/tts/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
        body: JSON.stringify({ ...opts, ttsOverride: collectTtsFormPayload() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || ('HTTP ' + res.status));
      }
      const buf = await res.arrayBuffer();
      await playTtsArrayBuffer(buf, { kind: opts.kind || 'dialogue' });
    }

    async function saveGlobalTtsCast(nextList) {
      routerCfg = await api('/api/tts/chat-cast', {
        method: 'POST',
        body: JSON.stringify({ characters: Array.isArray(nextList) ? nextList : [] }),
      });
      ttsAnalyzeCache.clear();
      ttsAudioBufferCache.clear();
      const savedChars = (routerCfg && routerCfg.tts && Array.isArray(routerCfg.tts.characters)) ? routerCfg.tts.characters : [];
      ttsGlobalCastDraft = JSON.parse(JSON.stringify(savedChars));
      renderGlobalTtsCastBox();
    }

    const castBox = document.getElementById('ttsGlobalCastBox');
    if (castBox) {
      castBox.addEventListener('change', (e) => {
        if (e.target && e.target.id === 'ttscVoiceGroupSel') {
          const refSel = document.getElementById('ttscVoiceRefSel');
          const idInp = document.getElementById('ttscVoiceIdInp');
          if (refSel && idInp) refSel.innerHTML = buildVoiceRefOptionsHtml(e.target.value, idInp.value, '-- 기본 성별 풀 사용 --');
        } else if (e.target && e.target.id === 'ttscVoiceRefSel') {
          const idInp = document.getElementById('ttscVoiceIdInp');
          if (!idInp) return;
          if (e.target.value === '__custom__') idInp.focus();
          else idInp.value = e.target.value;
        } else if (e.target && (e.target.id === 'ttscDlgTagSel' || e.target.id === 'ttscThTagSel')) {
          const inpId = e.target.id === 'ttscDlgTagSel' ? 'ttscDlgTagInp' : 'ttscThTagInp';
          const inpEl = document.getElementById(inpId);
          if (!inpEl) return;
          if (e.target.value === '__custom__') {
            inpEl.style.display = 'block';
            inpEl.focus();
          } else {
            inpEl.value = e.target.value;
            inpEl.style.display = 'none';
          }
        }
      });
      castBox.addEventListener('input', (e) => {
        if (e.target && e.target.id === 'ttscVoiceIdInp') {
          const gSel = document.getElementById('ttscVoiceGroupSel');
          const rSel = document.getElementById('ttscVoiceRefSel');
          if (gSel && rSel) rSel.innerHTML = buildVoiceRefOptionsHtml(gSel.value, e.target.value, '-- 기본 성별 풀 사용 --');
        }
      });
      castBox.addEventListener('click', async (e) => {
        if (e.target.closest('#ttscAddBtn')) {
          ttsGlobalCastEditIdx = -1;
          renderGlobalTtsCastBox();
          return;
        }
        if (e.target.closest('#ttscCancelEditBtn')) {
          ttsGlobalCastEditIdx = null;
          renderGlobalTtsCastBox();
          return;
        }
        if (e.target.closest('#ttscFetchFishBtn') || e.target.closest('#ttscFetchOaBtn')) {
          const reqGroup = e.target.closest('#ttscFetchOaBtn') ? 'openai_qwen' : 'fish';
          try {
            const r = await api('/api/tts/models', { method: 'POST', body: JSON.stringify({ group: reqGroup }) });
            storeLiveVoicesFromResponse(r, reqGroup);
            const gSel = document.getElementById('ttscVoiceGroupSel');
            const rSel = document.getElementById('ttscVoiceRefSel');
            const idInp = document.getElementById('ttscVoiceIdInp');
            if (gSel && rSel && idInp) {
              gSel.innerHTML = buildVoiceGroupOptionsHtml(reqGroup);
              rSel.innerHTML = buildVoiceRefOptionsHtml(reqGroup, idInp.value, '-- 기본 성별 풀 사용 --');
            }
            const cnt = Array.isArray(r.voices) ? r.voices.length : 0;
            toast((reqGroup === 'fish' ? 'Fish' : 'OpenAI/Qwen') + ' 보이스 ' + cnt + '개를 불러왔습니다.');
          } catch (err) { toast('보이스 조회 실패: ' + err.message); }
          return;
        }
        if (e.target.closest('#ttscSaveVoiceProfileBtn')) {
          const gSel = document.getElementById('ttscVoiceGroupSel');
          const idInp = document.getElementById('ttscVoiceIdInp');
          const nameInp = document.getElementById('ttscNameInp');
          const genSel = document.getElementById('ttscGenderSel');
          const grp = (gSel && gSel.value) || 'fish';
          const voiceIdVal = (idInp && idInp.value.trim()) || '';
          if (!voiceIdVal) { toast('저장할 Voice / Reference ID를 먼저 입력하거나 선택하세요.'); return; }
          const labelVal = (nameInp && nameInp.value.trim()) || voiceIdVal;
          const genderVal = (genSel && genSel.value) || 'female';
          try {
            routerCfg = await api('/api/tts/voice-profiles', {
              method: 'POST',
              body: JSON.stringify({ action: 'upsert', group: grp, item: { id: voiceIdVal, label: labelVal, gender: genderVal } }),
            });
            refreshAllTtsPickers();
            renderVoiceProfilesManager();
            const rSel = document.getElementById('ttscVoiceRefSel');
            if (rSel) rSel.innerHTML = buildVoiceRefOptionsHtml(grp, voiceIdVal, '-- 기본 성별 풀 사용 --');
            toast((grp === 'fish' ? 'Fish' : 'OpenAI/Qwen') + ' 프로필에 저장됨');
          } catch (err) { toast('프로필 저장 실패: ' + err.message); }
          return;
        }
        if (e.target.closest('#ttscApplyEditBtn')) {
          const name = (document.getElementById('ttscNameInp') && document.getElementById('ttscNameInp').value.trim()) || '';
          if (!name) { toast('등장인물 이름을 입력하세요.'); return; }
          const item = {
            id: (ttsGlobalCastEditIdx >= 0 && ttsGlobalCastDraft[ttsGlobalCastEditIdx]) ? ttsGlobalCastDraft[ttsGlobalCastEditIdx].id : ('tts-char-' + Date.now()),
            name,
            gender: (document.getElementById('ttscGenderSel') && document.getElementById('ttscGenderSel').value) || 'female',
            aliases: ((document.getElementById('ttscAliasesInp') && document.getElementById('ttscAliasesInp').value) || '').split(',').map((s) => s.trim()).filter(Boolean),
            voiceGroup: (document.getElementById('ttscVoiceGroupSel') && document.getElementById('ttscVoiceGroupSel').value) || '',
            voiceId: (document.getElementById('ttscVoiceIdInp') && document.getElementById('ttscVoiceIdInp').value.trim()) || '',
            dialogueToneTag: (document.getElementById('ttscDlgTagInp') && document.getElementById('ttscDlgTagInp').value.trim()) || '',
            thoughtToneTag: (document.getElementById('ttscThTagInp') && document.getElementById('ttscThTagInp').value.trim()) || '',
            speed: Number(document.getElementById('ttscSpeedInp') && document.getElementById('ttscSpeedInp').value) || 1.0,
            thoughtSpeed: Number(document.getElementById('ttscThSpeedInp') && document.getElementById('ttscThSpeedInp').value) || 0.94,
          };
          const nextDraft = ttsGlobalCastDraft.slice();
          if (ttsGlobalCastEditIdx >= 0) nextDraft[ttsGlobalCastEditIdx] = item;
          else nextDraft.push(item);
          try {
            ttsGlobalCastEditIdx = null;
            await saveGlobalTtsCast(nextDraft);
            toast('등장인물 보이스 저장됨 (전역 적용)');
          } catch (err) { toast('저장 실패: ' + err.message); }
          return;
        }
        if (e.target.closest('#ttscEditorPreviewBtn')) {
          try {
            await previewTtsVoiceItem({
              text: '안녕하세요. 이 목소리로 대사를 들려드릴게요.',
              kind: 'dialogue',
              speaker: (document.getElementById('ttscNameInp') && document.getElementById('ttscNameInp').value.trim()) || 'Tester',
              gender: (document.getElementById('ttscGenderSel') && document.getElementById('ttscGenderSel').value) || 'female',
              voiceId: (document.getElementById('ttscVoiceIdInp') && document.getElementById('ttscVoiceIdInp').value.trim()) || '',
              toneTag: (document.getElementById('ttscDlgTagInp') && document.getElementById('ttscDlgTagInp').value.trim()) || '',
            });
          } catch (err) { toast('미리듣기 실패: ' + err.message); }
          return;
        }
        const prevBtn = e.target.closest('[data-ttsc-preview]');
        if (prevBtn) {
          const idx = Number(prevBtn.getAttribute('data-ttsc-preview'));
          const c = ttsGlobalCastDraft[idx];
          if (!c) return;
          try {
            await previewTtsVoiceItem({
              text: '안녕하세요. 이 목소리로 대사를 들려드릴게요.',
              kind: 'dialogue',
              speaker: c.name,
              gender: c.gender,
              voiceId: c.voiceId,
              toneTag: c.dialogueToneTag,
            });
          } catch (err) { toast('미리듣기 실패: ' + err.message); }
          return;
        }
        const editBtn = e.target.closest('[data-ttsc-edit]');
        if (editBtn) {
          ttsGlobalCastEditIdx = Number(editBtn.getAttribute('data-ttsc-edit'));
          renderGlobalTtsCastBox();
          return;
        }
        const delBtn = e.target.closest('[data-ttsc-del]');
        if (delBtn) {
          const idx = Number(delBtn.getAttribute('data-ttsc-del'));
          if (idx >= 0 && idx < ttsGlobalCastDraft.length) {
            const nextDraft = ttsGlobalCastDraft.slice();
            nextDraft.splice(idx, 1);
            if (ttsGlobalCastEditIdx === idx) ttsGlobalCastEditIdx = null;
            else if (ttsGlobalCastEditIdx !== null && ttsGlobalCastEditIdx > idx) ttsGlobalCastEditIdx -= 1;
            try {
              await saveGlobalTtsCast(nextDraft);
              toast('등장인물 보이스 삭제됨');
            } catch (err) { toast('삭제 실패: ' + err.message); }
          }
        }
      });
    }

    refreshAllTtsPickers();
    renderVoiceProfilesManager();
    renderGlobalTtsCastBox();
  })();
  document.getElementById('saveTrBtn').onclick = async () => {
    routerCfg.translator = {
      ...routerCfg.translator,
      useActiveProfile: document.getElementById('trUseActive').checked,
      autoTranslateOutput: document.getElementById('trAutoOut').checked,
      autoTranslateInput: document.getElementById('trAutoIn').checked,
      provider: document.getElementById('trProvider').value,
      providerType: document.getElementById('trType').value,
      baseUrl: document.getElementById('trUrl').value.trim(),
      apiKey: document.getElementById('trKey').value.trim(),
      model: document.getElementById('trModel').value.trim(),
      prompt: document.getElementById('trPrompt').value,
    };
    routerCfg = await api('/api/router/config', { method: 'POST', body: JSON.stringify(routerCfg) });
    syncToggleBadges();
    renderRouterUI();
    toast('번역 설정 저장됨');
  };

  // ---------- Remote update ----------
  let updPolling = null;
  function cmpVer(a, b) {
    const pa = String(a || '0').split('.').map(Number), pb = String(b || '0').split('.').map(Number);
    for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
    return 0;
  }
  function renderUpdate(u) {
    if (!u) return;
    const busy = ['checking', 'downloading', 'verifying', 'installing', 'restarting'].includes(u.phase);
    const latest = u.latest;
    document.getElementById('updRelay').textContent = 'v' + u.relayVersion;
    document.getElementById('updPlugin').textContent = u.pluginVersion ? 'v' + u.pluginVersion : '연결 대기';
    document.getElementById('updLatest').textContent = latest && latest.version ? 'v' + latest.version : '-';
    const badge = document.getElementById('updBadge');
    const msg = document.getElementById('updMsg');
    const applyBtn = document.getElementById('updApplyBtn');
    const checkBtn = document.getElementById('updCheckBtn');
    const link = document.getElementById('updNotesLink');
    const notes = document.getElementById('updNotes');
    let text = '', cls = '';
    if (!u.available) { badge.textContent = '사용 불가'; badge.className = 'badge'; text = '이 서버에는 업데이터(risustand-updater.cjs)가 없습니다. 릴리즈 ZIP을 한 번 직접 설치해 주세요.'; }
    else if (busy) { badge.textContent = '진행 중'; badge.className = 'badge'; text = '<span class="upd-spin"></span>' + esc(u.message || u.phase) + (u.target ? ' (v' + esc(u.target) + ')' : ''); }
    else if (u.phase === 'error') { badge.textContent = '실패'; badge.className = 'badge'; cls = 'err'; text = esc(u.message) + '<br><small>' + esc(u.error || '') + '</small>'; }
    else if (latest && latest.updateAvailable) { badge.textContent = '새 버전'; badge.className = 'badge pc'; cls = 'ok'; text = 'v' + esc(latest.version) + ' 업데이트를 설치할 수 있습니다.' + (latest.hasAsset ? '' : '<br><small>이 릴리즈에는 검증 가능한 업데이트 ZIP이 없어 자동 설치할 수 없습니다.</small>'); }
    else if (latest) { badge.textContent = '최신'; badge.className = 'badge pc'; text = '최신 버전을 사용 중입니다.'; }
    else { badge.textContent = '확인 전'; badge.className = 'badge'; }
    if (!busy && u.pluginVersion && cmpVer(u.pluginVersion, u.relayVersion) < 0) {
      text += (text ? '<br>' : '') + '⚠️ PC 플러그인이 서버보다 오래되었습니다. PC RisuAI → 설정 → 플러그인에서 업데이트해 주세요.';
    }
    if (!busy && u.lastRollback && u.lastRollback.failedVersion && !(latest && cmpVer(latest.version, u.lastRollback.failedVersion) > 0)) {
      text += (text ? '<br>' : '') + '⚠️ v' + esc(u.lastRollback.failedVersion) + ' 설치 후 서버가 시작되지 않아 v' + esc(u.lastRollback.restoredVersion) + '(으)로 자동 복구했습니다. PC 콘솔 로그를 확인해 주세요.';
      if (cls !== 'err') cls = 'err';
    }
    if (u.stagedLaunchers && u.stagedLaunchers.length) {
      text += (text ? '<br>' : '') + '런처 변경됨: ' + u.stagedLaunchers.map((x) => esc(x) + '.new').join(', ') + ' 파일을 확인 후 덮어써 주세요.';
    }
    msg.innerHTML = text;
    msg.className = 'upd-msg' + (text ? ' show' : '') + (cls ? ' ' + cls : '');
    applyBtn.style.display = latest && latest.updateAvailable && latest.hasAsset && u.available ? '' : 'none';
    applyBtn.disabled = busy;
    checkBtn.disabled = busy || !u.available;
    if (latest && latest.htmlUrl) { link.href = latest.htmlUrl; link.style.display = ''; } else link.style.display = 'none';
    if (latest && latest.updateAvailable && latest.notes) { notes.textContent = latest.notes; notes.style.display = ''; } else notes.style.display = 'none';
  }
  async function refreshUpdateStatus() {
    try { const u = await api('/api/update/status'); renderUpdate(u); return u; } catch (_) { return null; }
  }
  document.getElementById('updCheckBtn').onclick = async () => {
    const btn = document.getElementById('updCheckBtn');
    btn.disabled = true;
    try { renderUpdate(await api('/api/update/check', { method: 'POST', body: '{}' })); }
    catch (e) { toast('확인 실패: ' + e.message); btn.disabled = false; }
  };
  document.getElementById('updApplyBtn').onclick = async () => {
    if (!confirm('릴레이 서버를 최신 버전으로 업데이트할까요?\\n잠시 연결이 끊겼다가 자동으로 다시 연결됩니다.')) return;
    try { renderUpdate(await api('/api/update/apply', { method: 'POST', body: '{}' })); }
    catch (e) { toast('업데이트 시작 실패: ' + e.message); return; }
    watchUpdate();
  };
  function watchUpdate() {
    clearInterval(updPolling);
    const startedVersion = (lastState && lastState.relayVersion) || null;
    let target = null, sawRestart = false;
    const deadline = Date.now() + 180000;
    updPolling = setInterval(async () => {
      if (Date.now() > deadline) { clearInterval(updPolling); toast('업데이트 상태를 확인하지 못했습니다. PC 콘솔을 확인해 주세요.'); return; }
      let u = null;
      try { u = await api('/api/update/status'); } catch (_) { sawRestart = true; }
      if (u) {
        if (u.target) target = u.target;
        if (u.phase === 'restarting') sawRestart = true;
        if (sawRestart && u.phase === 'idle') {
          clearInterval(updPolling);
          if (target && u.relayVersion === target) { toast('v' + target + ' 업데이트 완료 — 화면을 새로 불러옵니다'); setTimeout(() => location.reload(), 900); }
          else { renderUpdate(u); toast('새 버전이 시작되지 못해 v' + u.relayVersion + '(으)로 되돌렸습니다.'); }
          return;
        }
        if (u.phase === 'error') { clearInterval(updPolling); renderUpdate(u); return; }
        renderUpdate(u);
      } else {
        const msg = document.getElementById('updMsg');
        msg.className = 'upd-msg show';
        msg.innerHTML = '<span class="upd-spin"></span>서버 재시작 대기 중...';
      }
    }, 1500);
  }

  // ---------- Request Log Viewer ----------
  let reqLogsCache = [];
  let reqLogSummaryCache = null;
  let reqLogFilter = 'all';
  let reqLogGroupByLane = false;
  let reqLogModalOpen = false;
  let reqLogActiveDetail = null;
  let reqLogDetailLoading = false;
  let reqLogDetailTab = 'messages';
  let reqLogMsgQuery = '';

  function formatLogSource(src) {
    if (src === 'proxy') return '프록시';
    if (src === 'direct_chat') return '원격채팅';
    if (src === 'direct_reroll') return '원격리롤';
    if (src === 'translate') return '번역';
    return src || 'LLM';
  }

  function formatLogTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatLogDuration(ms) {
    const n = Number(ms || 0);
    if (n >= 1000) return (n / 1000).toFixed(2) + 's';
    return Math.round(n) + 'ms';
  }

  function formatUsd(val) {
    if (val === null || val === undefined || Number.isNaN(Number(val))) return '-';
    return '$' + Number(val).toFixed(4);
  }

  function buildCacheGuardSummaryHtml(summary) {
    if (!summary || !summary.totalRequests) return '';
    const avgHit = summary.avgServerHitPct !== null && summary.avgServerHitPct !== undefined ? (summary.avgServerHitPct + '%') : '미보고';
    return (
      '<span class="cg-stat">🛡️ 서사 ' + Number(summary.narrativeCount || 0) + '건</span>' +
      '<span class="cg-stat">📂 그룹 ' + Number(summary.laneCount || 0) + '개</span>' +
      '<span class="cg-stat ' + (summary.brokenCount > 0 ? 'brk' : 'ok') + '">⚠️ 깨짐 ' + Number(summary.brokenCount || 0) + '건</span>' +
      '<span class="cg-stat">🚫 보조/제외 ' + Number(summary.excludedCount || 0) + '건</span>' +
      '<span class="cg-stat">⚡ 평균 KV 적중 ' + esc(avgHit) + '</span>' +
      (summary.totalSavingsUsd > 0 ? '<span class="cg-stat ok">💰 절감 ' + esc(formatUsd(summary.totalSavingsUsd)) + '</span>' : '')
    );
  }

  function renderCacheGuardBadgeHtml(item) {
    const cg = item && item.cacheGuard;
    if (!cg) return '';
    if (!cg.eligible) {
      return '<span class="req-log-badge cg-excl" title="하야쿠/플래시백 등 비서사 요청은 캐시 비교에서 제외됩니다">' + esc('제외 · ' + (cg.excludedLabel || cg.excludedReason || '보조')) + '</span>';
    }
    const remoteBadge = cg.isRemotePrompt
      ? '<span class="req-log-badge src" title="원격 프롬프트 메인 서사로 인식되어 캐싱 감시 중">🍃 원격 서사</span>'
      : '';
    const laneBadge = '<span class="req-log-badge cg-lane">' + esc((cg.laneLabel || '그룹') + ' · T' + (cg.turnIndex || 1)) + '</span>';
    let statusBadge = '';
    if (cg.verdict === 'baseline') {
      statusBadge = '<span class="req-log-badge cg-lane">기준선</span>';
    } else if (cg.cacheBroken) {
      const pctText = cg.prefixMatchPct !== null && cg.prefixMatchPct !== undefined ? (' ' + cg.prefixMatchPct + '%') : '';
      statusBadge = '<span class="req-log-badge cg-brk">⚠️ 캐시 깨짐' + esc(pctText) + '</span>';
    } else {
      const hitText = cg.serverHitPct !== null && cg.serverHitPct !== undefined ? ('KV ' + cg.serverHitPct + '%') : '🛡️ 캐시 유지';
      statusBadge = '<span class="req-log-badge cg-ok">' + esc(hitText) + '</span>';
    }
    const minBadge = cg.belowMinCacheTokens ? '<span class="req-log-badge cg-excl" title="모델 최소 캐시 토큰 기준 미만">소용량</span>' : '';
    return remoteBadge + laneBadge + statusBadge + minBadge;
  }

  function filterRequestLogs(list) {
    const arr = Array.isArray(list) ? list : [];
    if (reqLogFilter === 'proxy') return arr.filter((x) => x.source === 'proxy');
    if (reqLogFilter === 'direct') return arr.filter((x) => x.source === 'direct_chat' || x.source === 'direct_reroll');
    if (reqLogFilter === 'translate') return arr.filter((x) => x.source === 'translate');
    if (reqLogFilter === 'narrative') return arr.filter((x) => x.cacheGuard && x.cacheGuard.eligible);
    if (reqLogFilter === 'broken') return arr.filter((x) => x.cacheGuard && x.cacheGuard.eligible && x.cacheGuard.cacheBroken);
    return arr;
  }

  function renderLogRowHtml(item) {
    const u = item.usage || {};
    const tokText = u.total_tokens ? ('토큰 ' + u.total_tokens + ' (' + (u.prompt_tokens || 0) + '→' + (u.completion_tokens || 0) + (u.cached_tokens ? ' · 캐시 ' + u.cached_tokens : '') + ')') : '';
    const statusText = item.status ? ('HTTP ' + item.status) : (item.ok ? 'OK' : 'ERR');
    return '<button type="button" class="req-log-row" data-log-id="' + esc(item.id) + '">' +
      '<div class="req-log-row-top">' +
        '<span class="req-log-badge ' + (item.ok ? 'ok' : 'err') + '">' + (item.ok ? '✓ ' : '⚠ ') + esc(statusText) + '</span>' +
        '<span class="req-log-badge src">' + esc(formatLogSource(item.source)) + (item.stream ? ' · stream' : '') + '</span>' +
        renderCacheGuardBadgeHtml(item) +
        '<span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(item.model || item.profileName || 'Unknown') + '</span>' +
        '<span style="margin-left:auto; font-size:11.5px; font-weight:500; color:var(--sub);">' + esc(formatLogTime(item.at)) + '</span>' +
      '</div>' +
      '<div class="req-log-row-meta">' +
        '<span>' + esc(formatLogDuration(item.durationMs)) + '</span>' +
        '<span>메시지 ' + Number(item.msgCount || 0) + '개</span>' +
        (tokText ? '<span>' + esc(tokText) + '</span>' : '') +
        (item.cacheGuard && item.cacheGuard.eligible && item.cacheGuard.causeLabel ? '<span>' + esc(item.cacheGuard.causeLabel) + '</span>' : '') +
        (item.profileName ? '<span>프로필: ' + esc(item.profileName) + '</span>' : '') +
      '</div>' +
      (item.responsePreview ? '<div class="req-log-row-prev">' + esc(item.responsePreview) + '</div>' : '') +
    '</button>';
  }

  function buildRequestLogRowsHtml(list) {
    const filtered = filterRequestLogs(list);
    if (!filtered.length) {
      return '<div style="font-size:12.5px; color:var(--sub); padding:8px 2px;">' +
        (reqLogsCache.length ? '선택한 필터에 해당하는 로그가 없습니다.' : '아직 기록된 요청이 없습니다.') +
        '</div>';
    }
    if (!reqLogGroupByLane) {
      return filtered.map(renderLogRowHtml).join('');
    }
    const groups = new Map();
    for (const item of filtered) {
      const cg = item.cacheGuard;
      const key = (cg && cg.eligible && cg.laneId) ? cg.laneId : '__excluded__';
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          label: key === '__excluded__'
            ? '🚫 집계 제외 (하야쿠 / 플래시백 / 번역 / 오류)'
            : ('📂 ' + (cg.laneLabel || key) + ' (' + (cg.isRemotePrompt ? '원격 프롬 서사' : (cg.namespace === 'proxy' ? '프록시' : '원격 직접')) + ')'),
          items: [],
          broken: 0,
        });
      }
      const g = groups.get(key);
      g.items.push(item);
      if (cg && cg.eligible && cg.cacheBroken) g.broken++;
    }
    let out = '';
    for (const g of groups.values()) {
      out += '<div class="cg-lane-hdr"><span>' + esc(g.label) + '</span><span>' + g.items.length + '건' + (g.broken > 0 ? ' · 깨짐 ' + g.broken + '건' : '') + '</span></div>';
      out += g.items.map(renderLogRowHtml).join('');
    }
    return out;
  }

  function renderRequestLogsList() {
    const sumEl = document.getElementById('reqLogCgSummary');
    if (sumEl) {
      const sumHtml = buildCacheGuardSummaryHtml(reqLogSummaryCache);
      sumEl.innerHTML = sumHtml;
      sumEl.style.display = sumHtml ? 'flex' : 'none';
    }
    const el = document.getElementById('reqLogList');
    if (el) el.innerHTML = buildRequestLogRowsHtml(reqLogsCache);
    document.querySelectorAll('#reqLogFilters [data-log-filter]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-log-filter') === reqLogFilter);
    });
    const grpBtn = document.getElementById('reqLogGroupToggle');
    if (grpBtn) grpBtn.classList.toggle('active', reqLogGroupByLane);
  }

  async function loadRequestLogs() {
    try {
      const res = await api('/api/logs');
      reqLogsCache = Array.isArray(res && res.logs) ? res.logs : [];
      reqLogSummaryCache = (res && res.summary) ? res.summary : null;
      renderRequestLogsList();
      if (reqLogModalOpen && !reqLogActiveDetail && !reqLogDetailLoading) renderReqLogModal();
    } catch (e) {
      if (reqLogModalOpen && !reqLogActiveDetail) {
        const modal = document.getElementById('reqLogModal');
        if (modal) {
          const body = modal.querySelector('.req-log-body');
          if (body) body.innerHTML = '<div class="req-log-errbox">로그를 불러오지 못했습니다: ' + esc(e && e.message ? e.message : '오류') + '</div>';
        }
      }
    }
  }

  function getReqLogCopyPayload() {
    const d = reqLogActiveDetail;
    if (!d) return '';
    if (reqLogDetailTab === 'cache') return JSON.stringify(d.cacheGuard || {}, null, 2);
    if (reqLogDetailTab === 'request') return d.requestJson || '';
    if (reqLogDetailTab === 'response') {
      if (d.responseText && d.responseJson) return d.responseText + '\\n\\n--- RAW JSON ---\\n' + d.responseJson;
      return d.responseText || d.responseJson || d.error || '';
    }
    if (reqLogDetailTab === 'meta') {
      return JSON.stringify({
        id: d.id,
        at: d.at,
        source: d.source,
        profileName: d.profileName,
        providerType: d.providerType,
        model: d.model,
        endpoint: d.endpoint,
        stream: d.stream,
        status: d.status,
        ok: d.ok,
        durationMs: d.durationMs,
        usage: d.usage,
        headers: d.headers,
        error: d.error,
      }, null, 2);
    }
    return (d.messages || []).map((m, i) => '[' + (i + 1) + ' ' + String(m.role || 'user').toUpperCase() + ']\\n' + (m.content || '')).join('\\n\\n---\\n\\n');
  }

  async function copyPlainText(txt, okMsg = '복사됨') {
    if (!txt) { toast('복사할 내용이 없습니다'); return; }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(txt);
        toast(okMsg);
        return;
      }
    } catch (_) {}
    const ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(okMsg); } catch (_) { toast('복사 실패'); }
    document.body.removeChild(ta);
  }

  async function copyReqLogActiveText() {
    await copyPlainText(getReqLogCopyPayload(), '복사됨');
  }

  function renderReqLogMessagesHtml(msgs, query) {
    const arr = Array.isArray(msgs) ? msgs : [];
    if (!arr.length) return '<div style="font-size:13px; color:var(--sub);">저장된 메시지가 없습니다.</div>';
    const q = String(query || '').trim().toLowerCase();
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const m = arr[i] || {};
      const role = String(m.role || 'user');
      const content = String(m.content || '');
      if (q && !role.toLowerCase().includes(q) && !content.toLowerCase().includes(q)) continue;
      const roleCls = role === 'system' ? 'system' : (role === 'user' ? 'user' : (role === 'model' ? 'model' : 'assistant'));
      out.push(
        '<details class="req-log-msg role-' + roleCls + '" open>' +
          '<summary class="req-log-msg-head">' +
            '<span style="display:flex; align-items:center; gap:6px; min-width:0;">' +
              '<span class="req-log-msg-chev">▾</span>' +
              '<span class="req-log-msg-role">#' + (i + 1) + ' ' + esc(role) + '</span>' +
            '</span>' +
            '<span style="display:flex; align-items:center; gap:8px; flex-shrink:0;">' +
              '<span>' + content.length + '자</span>' +
              '<button type="button" class="req-log-mini-btn" data-copy-msg-idx="' + i + '">📋 복사</button>' +
            '</span>' +
          '</summary>' +
          '<pre class="req-log-msg-body">' + esc(content || '(빈 메시지)') + '</pre>' +
        '</details>'
      );
    }
    if (!out.length) return '<div style="font-size:13px; color:var(--sub);">검색어와 일치하는 메시지가 없습니다.</div>';
    return out.join('');
  }

  function renderHighlightDiffPair(prevText, currText) {
    const a = String(prevText || '');
    const b = String(currText || '');
    const minLen = Math.min(a.length, b.length);
    let prefixLen = 0;
    while (prefixLen < minLen && a.charCodeAt(prefixLen) === b.charCodeAt(prefixLen)) prefixLen++;
    let suffixLen = 0;
    while (
      suffixLen < (minLen - prefixLen) &&
      a.charCodeAt(a.length - 1 - suffixLen) === b.charCodeAt(b.length - 1 - suffixLen)
    ) {
      suffixLen++;
    }
    const aMid = a.slice(prefixLen, a.length - suffixLen);
    const bMid = b.slice(prefixLen, b.length - suffixLen);
    return {
      prevHtml: esc(a.slice(0, prefixLen)) + (aMid ? '<span class="cg-diff-hi-del">' + esc(aMid) + '</span>' : '') + esc(suffixLen > 0 ? a.slice(a.length - suffixLen) : ''),
      currHtml: esc(b.slice(0, prefixLen)) + (bMid ? '<span class="cg-diff-hi-add">' + esc(bMid) + '</span>' : '') + esc(suffixLen > 0 ? b.slice(b.length - suffixLen) : ''),
    };
  }

  function renderReqLogCacheTabHtml(d) {
    const cg = d && d.cacheGuard;
    if (!cg) {
      return '<div class="cg-banner">캐시 분석 정보가 아직 생성되지 않았습니다.</div>';
    }
    if (!cg.eligible) {
      return (
        '<div class="cg-banner">' +
          '<div style="font-weight:800; font-size:14px;">🚫 캐시 감시 집계 제외 요청</div>' +
          '<div style="font-size:12.5px; color:var(--sub);">분류: <b>' + esc(cg.excludedLabel || cg.excludedReason || '보조 요청') + '</b></div>' +
          '<div style="font-size:12px; color:var(--sub);">하야쿠·플래시백·번역·플러그인 호출 및 오류 응답은 실제 서사 턴과 프롬프트 구조가 다르므로 캐싱 비교 그룹에 섞이지 않도록 자동 제외됩니다.</div>' +
        '</div>'
      );
    }
    const cls = cg.verdict === 'broken' ? 'broken' : (cg.verdict === 'baseline' ? 'baseline' : 'ok');
    const titleIcon = cg.verdict === 'broken' ? '⚠️ ' : (cg.verdict === 'baseline' ? '📌 ' : '🛡️ ');
    const hitStr = (cg.serverHitPct !== null && cg.serverHitPct !== undefined) ? (cg.serverHitPct + '%') : '서버 미보고';
    const matchStr = (cg.prefixMatchPct !== null && cg.prefixMatchPct !== undefined) ? (cg.prefixMatchPct + '%') : '기준선';
    let html =
      '<div class="cg-banner ' + cls + '">' +
        '<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;">' +
          '<div style="font-weight:800; font-size:14.5px;">' + titleIcon + esc(cg.verdictLabel || '분석 완료') + '</div>' +
          (cg.prevLogId ? '<button type="button" class="pill" data-log-id="' + esc(cg.prevLogId) + '">← 비교 기준 이전 턴 보기</button>' : '') +
        '</div>' +
        '<div style="font-size:12.5px;">' + esc(cg.causeLabel || '') + '</div>' +
        (cg.belowMinCacheTokens ? '<div style="font-size:11.5px; color:var(--sub);">참고: 현재 입력 토큰(' + Number(cg.promptTokens || 0) + ')이 모델 최소 캐시 기준(' + Number(cg.minCacheTokens || 1024) + ')보다 작습니다.</div>' : '') +
      '</div>' +
      '<div class="req-log-meta-grid">' +
        '<div class="req-log-meta-item"><b>그룹 / 턴 / 분류</b><span>' + esc((cg.laneLabel || '-') + ' · T' + (cg.turnIndex || 1) + ' (' + (cg.isRemotePrompt ? ('원격 프롬 서사 · ' + (cg.presetName || '메인 서사')) : (cg.namespace === 'proxy' ? '프록시' : '원격 직접')) + ')') + '</span></div>' +
        '<div class="req-log-meta-item"><b>프리픽스 일치율</b><span>' + esc(matchStr) + '</span></div>' +
        '<div class="req-log-meta-item"><b>서버 KV 적중률</b><span>' + esc(hitStr) + '</span></div>' +
        '<div class="req-log-meta-item"><b>캐시 읽기 / 쓰기 / 입력</b><span>' + esc(Number(cg.cachedTokens || 0) + ' / ' + Number(cg.cacheCreationTokens || 0) + ' / ' + Number(cg.promptTokens || 0)) + '</span></div>' +
        '<div class="req-log-meta-item"><b>예상 턴 비용 / 절감</b><span>' + esc(cg.cost ? (formatUsd(cg.cost.totalUsd) + ' / 절감 ' + formatUsd(cg.cost.cacheSavingsUsd)) : '모델 요율 미등록') + '</span></div>' +
        '<div class="req-log-meta-item"><b>로어북 / 브레이크포인트</b><span>' + esc((cg.culpritLorebook ? cg.culpritLorebook.name + ' (' + cg.culpritLorebook.action + ')' : '-') + (cg.afterBreakpoint ? ' · BP 이후' : '')) + '</span></div>' +
      '</div>';

    const segs = Array.isArray(cg.segmentMap) ? cg.segmentMap : [];
    if (segs.length) {
      html += '<div><div class="f-label" style="margin-top:0;">세그먼트별 캐시 맵 (' + segs.length + '개 블록)</div><div class="cg-segmap-bar">';
      for (const s of segs) {
        const w = Math.max(1, Number(s.pct || 0));
        const stCls = s.status === 'changed' ? 'changed' : (s.status === 'after' ? 'after' : 'cached');
        html += '<div class="cg-seg ' + stCls + '" style="width:' + w + '%;" title="' + esc('#' + (s.idx + 1) + ' ' + s.role + ' (' + s.tokens + ' tok · ' + s.pct + '%)') + '"></div>';
      }
      html += '</div><div class="cg-seg-list" style="margin-top:8px;">';
      for (const s of segs.slice(0, 12)) {
        const dotColor = s.status === 'changed' ? 'var(--danger)' : (s.status === 'after' ? 'var(--sub)' : '#34d399');
        html += '<div class="cg-seg-item">' +
          '<span style="width:9px; height:9px; border-radius:50%; flex-shrink:0; background:' + dotColor + ';"></span>' +
          '<b style="min-width:68px;">#' + (s.idx + 1) + ' ' + esc(s.role) + (s.hasCacheControl ? ' 📌' : '') + '</b>' +
          '<span style="color:var(--sub); min-width:85px;">~' + Number(s.tokens || 0) + ' tok (' + s.pct + '%)</span>' +
          '<span style="color:var(--sub); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(s.preview || '') + '</span>' +
        '</div>';
      }
      if (segs.length > 12) {
        html += '<div style="font-size:11.5px; color:var(--sub); padding-left:4px;">외 ' + (segs.length - 12) + '개 세그먼트...</div>';
      }
      html += '</div></div>';
    }

    if (cg.firstDiff) {
      const pair = renderHighlightDiffPair(cg.firstDiff.prevSnippet, cg.firstDiff.currSnippet);
      html += '<div><div class="f-label" style="margin-top:0;">최초 불일치 위치 (세그먼트 #' + (Number(cg.firstDiff.segIdx || 0) + 1) + ' · ' + esc(cg.firstDiff.role || '') + ' · offset ' + Number(cg.firstDiff.offset || 0) + ')</div>' +
        '<div class="cg-diff-box">' +
          '<div class="cg-diff-col"><div class="cg-diff-head">이전 턴 (비교 기준)</div><pre class="cg-diff-pre">' + pair.prevHtml + '</pre></div>' +
          '<div class="cg-diff-col"><div class="cg-diff-head">현재 턴 (변경 발생)</div><pre class="cg-diff-pre">' + pair.currHtml + '</pre></div>' +
        '</div>' +
      '</div>';
    }
    return html;
  }

  function renderReqLogModal() {
    const modal = document.getElementById('reqLogModal');
    if (!modal) return;
    if (!reqLogModalOpen) {
      modal.style.display = 'none';
      modal.innerHTML = '';
      return;
    }

    if (reqLogDetailLoading) {
      modal.innerHTML =
        '<div class="req-log-dialog">' +
          '<div class="req-log-head">' +
            '<div class="req-log-title">📜 리퀘스트 로그 불러오는 중...</div>' +
            '<button type="button" class="pill" data-log-close="1">✕ 닫기</button>' +
          '</div>' +
          '<div class="req-log-body"><div style="color:var(--sub); font-size:13px;">로그 상세 정보를 가져오는 중입니다...</div></div>' +
        '</div>';
      modal.style.display = 'flex';
      return;
    }

    if (!reqLogActiveDetail) {
      const sumHtml = buildCacheGuardSummaryHtml(reqLogSummaryCache);
      modal.innerHTML =
        '<div class="req-log-dialog">' +
          '<div class="req-log-head">' +
            '<div class="req-log-title">📜 리퀘스트 로그 <span class="badge">' + reqLogsCache.length + '건</span></div>' +
            '<div style="display:flex; gap:6px; align-items:center;">' +
              '<button type="button" class="pill" data-log-refresh="1">🔄 새로고침</button>' +
              '<button type="button" class="pill" data-log-clear="1" style="color:var(--danger);">🗑️ 비우기</button>' +
              '<button type="button" class="pill" data-log-close="1">✕ 닫기</button>' +
            '</div>' +
          '</div>' +
          '<div class="req-log-tabs">' +
            '<button type="button" class="pill' + (reqLogFilter === 'all' ? ' active' : '') + '" data-modal-filter="all">전체</button>' +
            '<button type="button" class="pill' + (reqLogFilter === 'proxy' ? ' active' : '') + '" data-modal-filter="proxy">프록시</button>' +
            '<button type="button" class="pill' + (reqLogFilter === 'direct' ? ' active' : '') + '" data-modal-filter="direct">원격 채팅/리롤</button>' +
            '<button type="button" class="pill' + (reqLogFilter === 'translate' ? ' active' : '') + '" data-modal-filter="translate">번역</button>' +
            '<button type="button" class="pill' + (reqLogFilter === 'narrative' ? ' active' : '') + '" data-modal-filter="narrative">🛡️ 서사 감시</button>' +
            '<button type="button" class="pill' + (reqLogFilter === 'broken' ? ' active' : '') + '" data-modal-filter="broken">⚠️ 캐시 깨짐</button>' +
            '<button type="button" class="pill' + (reqLogGroupByLane ? ' active' : '') + '" data-modal-group-toggle="1">📂 그룹별 보기</button>' +
          '</div>' +
          '<div class="req-log-body">' +
            (sumHtml ? '<div class="cg-summary-bar" style="margin-bottom:4px;">' + sumHtml + '</div>' : '') +
            '<div class="req-log-list" style="max-height:none;">' + buildRequestLogRowsHtml(reqLogsCache) + '</div>' +
          '</div>' +
        '</div>';
      modal.style.display = 'flex';
      return;
    }

    const d = reqLogActiveDetail;
    const msgs = Array.isArray(d.messages) ? d.messages : [];
    const u = d.usage || {};
    const cg = d.cacheGuard || null;
    const statusText = d.status ? ('HTTP ' + d.status) : (d.ok ? 'OK' : 'ERR');
    let tabBody = '';
    if (reqLogDetailTab === 'cache') {
      tabBody = renderReqLogCacheTabHtml(d);
    } else if (reqLogDetailTab === 'messages') {
      tabBody =
        '<div class="req-log-toolbar">' +
          '<input class="f-inp" id="reqLogMsgSearch" placeholder="메시지 역할/내용 검색..." value="' + esc(reqLogMsgQuery) + '" />' +
          '<button type="button" class="pill" data-log-expand-all="1">모두 펼치기</button>' +
          '<button type="button" class="pill" data-log-collapse-all="1">모두 접기</button>' +
        '</div>' +
        '<div id="reqLogMsgList" class="req-log-msg-list">' + renderReqLogMessagesHtml(msgs, reqLogMsgQuery) + '</div>';
    } else if (reqLogDetailTab === 'request') {
      tabBody = '<pre class="req-log-pre">' + esc(d.requestJson || '(요청 본문 없음)') + '</pre>';
    } else if (reqLogDetailTab === 'response') {
      tabBody =
        (d.error ? '<div class="req-log-errbox">' + esc(d.error) + '</div>' : '') +
        '<div><div class="f-label" style="margin-top:0;">응답 텍스트</div><pre class="req-log-pre">' + esc(d.responseText || '(응답 본문 없음)') + '</pre></div>' +
        (d.responseJson ? '<details><summary style="cursor:pointer; font-size:12.5px; font-weight:700; color:var(--sub);">원본 응답 JSON 보기</summary><pre class="req-log-pre" style="margin-top:6px;">' + esc(d.responseJson) + '</pre></details>' : '');
    } else {
      tabBody =
        '<div class="req-log-meta-grid">' +
          '<div class="req-log-meta-item"><b>시각</b><span>' + esc(d.at || '-') + '</span></div>' +
          '<div class="req-log-meta-item"><b>출처 / 방식</b><span>' + esc(formatLogSource(d.source) + (d.stream ? ' (stream)' : ' (non-stream)')) + '</span></div>' +
          '<div class="req-log-meta-item"><b>프로필 / 포맷</b><span>' + esc((d.profileName || '-') + ' / ' + (d.providerType || '-')) + '</span></div>' +
          '<div class="req-log-meta-item"><b>모델</b><span>' + esc(d.model || '-') + '</span></div>' +
          '<div class="req-log-meta-item"><b>소요 시간</b><span>' + esc(formatLogDuration(d.durationMs)) + '</span></div>' +
          '<div class="req-log-meta-item"><b>토큰 사용량</b><span>' + esc('총 ' + (u.total_tokens || 0) + ' (입력 ' + (u.prompt_tokens || 0) + ' / 출력 ' + (u.completion_tokens || 0) + (u.cached_tokens ? ' / 캐시 ' + u.cached_tokens : '') + ')') + '</span></div>' +
          '<div class="req-log-meta-item" style="grid-column:1 / -1;"><b>엔드포인트</b><span>' + esc(d.endpoint || '-') + '</span></div>' +
        '</div>' +
        '<div><div class="f-label">요청 헤더 (인증 정보 마스킹됨)</div><pre class="req-log-pre">' + esc(JSON.stringify(d.headers || {}, null, 2)) + '</pre></div>';
    }

    modal.innerHTML =
      '<div class="req-log-dialog">' +
        '<div class="req-log-head">' +
          '<div class="req-log-title">' +
            '<button type="button" class="pill" data-log-back="1">← 목록</button>' +
            '<span class="req-log-badge ' + (d.ok ? 'ok' : 'err') + '">' + esc(statusText) + '</span>' +
            '<span class="req-log-badge src">' + esc(formatLogSource(d.source)) + '</span>' +
            renderCacheGuardBadgeHtml(d) +
            '<span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(d.model || d.profileName || 'Request') + '</span>' +
            '<span style="font-size:11.5px; font-weight:500; color:var(--sub);">' + esc(formatLogDuration(d.durationMs)) + '</span>' +
          '</div>' +
          '<div style="display:flex; gap:6px; align-items:center;">' +
            '<button type="button" class="pill" data-log-copy="1">📋 복사</button>' +
            '<button type="button" class="pill" data-log-close="1">✕ 닫기</button>' +
          '</div>' +
        '</div>' +
        '<div class="req-log-tabs">' +
          '<button type="button" class="pill' + (reqLogDetailTab === 'messages' ? ' active' : '') + '" data-log-tab="messages">메시지 (' + msgs.length + ')</button>' +
          '<button type="button" class="pill' + (reqLogDetailTab === 'cache' ? ' active' : '') + '" data-log-tab="cache">🛡️ 캐시 분석' + (cg && cg.eligible && cg.cacheBroken ? ' ⚠️' : '') + '</button>' +
          '<button type="button" class="pill' + (reqLogDetailTab === 'request' ? ' active' : '') + '" data-log-tab="request">요청 JSON</button>' +
          '<button type="button" class="pill' + (reqLogDetailTab === 'response' ? ' active' : '') + '" data-log-tab="response">응답</button>' +
          '<button type="button" class="pill' + (reqLogDetailTab === 'meta' ? ' active' : '') + '" data-log-tab="meta">헤더 · 정보</button>' +
        '</div>' +
        '<div class="req-log-body">' + tabBody + '</div>' +
      '</div>';
    modal.style.display = 'flex';
    const sInp = document.getElementById('reqLogMsgSearch');
    if (sInp) {
      sInp.oninput = () => {
        reqLogMsgQuery = sInp.value;
        const listEl = document.getElementById('reqLogMsgList');
        if (listEl) listEl.innerHTML = renderReqLogMessagesHtml(msgs, reqLogMsgQuery);
      };
    }
  }

  function closeReqLogModal() {
    reqLogModalOpen = false;
    reqLogActiveDetail = null;
    reqLogDetailLoading = false;
    renderReqLogModal();
  }

  async function openRequestLogModal() {
    reqLogModalOpen = true;
    reqLogActiveDetail = null;
    reqLogDetailLoading = false;
    renderReqLogModal();
    await loadRequestLogs();
  }

  async function openRequestLogDetail(id) {
    if (!id) return;
    reqLogModalOpen = true;
    reqLogDetailLoading = true;
    reqLogActiveDetail = null;
    reqLogDetailTab = 'messages';
    reqLogMsgQuery = '';
    renderReqLogModal();
    try {
      const res = await api('/api/logs/' + encodeURIComponent(id));
      reqLogDetailLoading = false;
      reqLogActiveDetail = res && res.log ? res.log : null;
      renderReqLogModal();
    } catch (e) {
      reqLogDetailLoading = false;
      toast('로그 상세 조회 실패: ' + (e && e.message ? e.message : '오류'));
      renderReqLogModal();
    }
  }

  async function clearRequestLogs() {
    await api('/api/logs', { method: 'DELETE' });
    reqLogsCache = [];
    reqLogSummaryCache = null;
    reqLogActiveDetail = null;
    renderRequestLogsList();
    if (reqLogModalOpen) renderReqLogModal();
    toast('리퀘스트 로그를 비웠습니다');
  }

  document.getElementById('reqLogQuickBtn').onclick = openRequestLogModal;
  document.getElementById('reqLogRefreshBtn').onclick = loadRequestLogs;
  document.getElementById('reqLogClearBtn').onclick = clearRequestLogs;
  document.getElementById('reqLogFilters').addEventListener('click', (e) => {
    if (e.target.closest('#reqLogGroupToggle')) {
      reqLogGroupByLane = !reqLogGroupByLane;
      renderRequestLogsList();
      if (reqLogModalOpen && !reqLogActiveDetail) renderReqLogModal();
      return;
    }
    const btn = e.target.closest('[data-log-filter]');
    if (!btn) return;
    reqLogFilter = btn.getAttribute('data-log-filter') || 'all';
    renderRequestLogsList();
  });
  document.getElementById('reqLogList').addEventListener('click', (e) => {
    const row = e.target.closest('[data-log-id]');
    if (row) openRequestLogDetail(row.getAttribute('data-log-id'));
  });
  document.getElementById('reqLogModal').addEventListener('click', (e) => {
    const modal = document.getElementById('reqLogModal');
    const copyMsgBtn = e.target.closest('[data-copy-msg-idx]');
    if (copyMsgBtn) {
      e.preventDefault();
      e.stopPropagation();
      const idx = Number(copyMsgBtn.getAttribute('data-copy-msg-idx'));
      const msgs = (reqLogActiveDetail && reqLogActiveDetail.messages) || [];
      if (Number.isInteger(idx) && msgs[idx]) {
        copyPlainText(String(msgs[idx].content || ''), '#' + (idx + 1) + ' 메시지 복사됨');
      }
      return;
    }
    if (e.target.closest('[data-log-expand-all]')) {
      modal.querySelectorAll('details.req-log-msg').forEach((el) => { el.open = true; });
      return;
    }
    if (e.target.closest('[data-log-collapse-all]')) {
      modal.querySelectorAll('details.req-log-msg').forEach((el) => { el.open = false; });
      return;
    }
    if (e.target === modal || e.target.closest('[data-log-close]')) {
      closeReqLogModal();
      return;
    }
    if (e.target.closest('[data-log-back]')) {
      reqLogActiveDetail = null;
      renderReqLogModal();
      loadRequestLogs();
      return;
    }
    if (e.target.closest('[data-log-refresh]')) {
      loadRequestLogs();
      return;
    }
    if (e.target.closest('[data-log-clear]')) {
      clearRequestLogs();
      return;
    }
    if (e.target.closest('[data-log-copy]')) {
      copyReqLogActiveText();
      return;
    }
    const tabBtn = e.target.closest('[data-log-tab]');
    if (tabBtn) {
      reqLogDetailTab = tabBtn.getAttribute('data-log-tab') || 'messages';
      renderReqLogModal();
      return;
    }
    if (e.target.closest('[data-modal-group-toggle]')) {
      reqLogGroupByLane = !reqLogGroupByLane;
      renderRequestLogsList();
      renderReqLogModal();
      return;
    }
    const mfBtn = e.target.closest('[data-modal-filter]');
    if (mfBtn) {
      reqLogFilter = mfBtn.getAttribute('data-modal-filter') || 'all';
      renderRequestLogsList();
      renderReqLogModal();
      return;
    }
    const row = e.target.closest('[data-log-id]');
    if (row) openRequestLogDetail(row.getAttribute('data-log-id'));
  });

  // ===== Backend Plugin Adapter UI & Native Sandboxed Iframe GUI Modal =====
  let backendPluginsCache = [];
  let backendPluginsLoadedAt = 0;
  let backendPluginsLoading = false;
  const openPluginArgsSet = new Set();
  const pluginGuiState = {
    open: false,
    pluginName: '',
    displayName: '',
    entryId: '',
    uiItems: [],
  };

  function renderBackendPluginsList() {
    const listEl = document.getElementById('backendPluginList');
    const cntEl = document.getElementById('backendPluginCount');
    if (!listEl) return;
    const list = Array.isArray(backendPluginsCache) ? backendPluginsCache : [];
    const activeCnt = list.filter((p) => p && p.enabled).length;
    if (cntEl) cntEl.textContent = activeCnt + ' / ' + list.length + ' 활성';
    if (!list.length) {
      listEl.innerHTML = '<div style="color:var(--sub); font-size:12.5px;">등록된 플러그인이 없습니다. PC 연결 시 [PC 플러그인 동기화] 또는 [.js 추가]를 눌러 주세요.</div>';
      return;
    }
    listEl.innerHTML = list.map((p) => {
      const hookTags = [];
      if (p.hooks && Array.isArray(p.hooks.replacers)) p.hooks.replacers.forEach((r) => hookTags.push(r));
      if (p.hooks && Array.isArray(p.hooks.chatListeners)) p.hooks.chatListeners.forEach((c) => hookTags.push('chat:' + c));
      if (p.hooks && Array.isArray(p.hooks.scriptHandlers)) p.hooks.scriptHandlers.forEach((s) => hookTags.push('script:' + s));
      if (p.hasBodyIntercepter) hookTags.push('body');
      const argsOpen = openPluginArgsSet.has(p.name);
      const argsSchema = Array.isArray(p.argsSchema) ? p.argsSchema : [];
      const argVals = (p.argValues && typeof p.argValues === 'object') ? p.argValues : {};
      let argsHtml = '';
      if (argsOpen && argsSchema.length) {
        argsHtml = '<div class="plg-args">' +
          argsSchema.map((a) => {
            const val = argVals[a.key] !== undefined ? String(argVals[a.key]) : '';
            return '<div>' +
              '<div class="f-label" style="margin:2px 0 3px;">' + esc(a.key) + ' <span style="opacity:0.7;">(' + esc(a.type) + (a.description ? ' · ' + esc(a.description) : '') + ')</span></div>' +
              '<input class="f-inp" type="' + (a.type === 'int' ? 'number' : 'text') + '" data-plg-arg-name="' + esc(p.name) + '" data-plg-arg-key="' + esc(a.key) + '" value="' + esc(val) + '" placeholder="' + esc(a.placeholder || '') + '" style="min-height:34px; padding:6px 10px; font-size:13px;" />' +
            '</div>';
          }).join('') +
          '<div class="btn-row" style="margin-top:4px;"><button type="button" class="btn" data-plg-args-save="' + esc(p.name) + '">💾 인자 저장</button></div>' +
        '</div>';
      }
      return '<div class="plg-item' + (p.enabled ? ' on' : '') + '">' +
        '<div class="plg-head">' +
          '<div class="plg-title">' +
            '<span>' + esc(p.displayName || p.name) + '</span>' +
            '<span class="badge">' + esc(p.source === 'custom' ? '업로드' : 'PC 연동') + '</span>' +
            (p.version ? '<span class="badge">v' + esc(p.version) + '</span>' : '') +
            (p.loaded ? '<span class="badge pc">실행 중</span>' : '') +
          '</div>' +
          '<input type="checkbox" data-plg-toggle="' + esc(p.name) + '" ' + (p.enabled ? 'checked' : '') + ' title="백엔드 어댑터 활성화" />' +
        '</div>' +
        '<div class="plg-meta">' +
          'ID: <code>' + esc(p.name) + '</code>' +
          (hookTags.length ? ' · 훅: ' + esc(hookTags.join(', ')) : '') +
          (p.uiItems && p.uiItems.length ? ' · GUI 메뉴 ' + p.uiItems.length + '개' : '') +
        '</div>' +
        (p.lastError ? '<div class="plg-err">⚠️ ' + esc(p.lastError) + '</div>' : '') +
        '<div class="plg-acts">' +
          '<button type="button" class="pill" data-plg-gui="' + esc(p.name) + '">🖥️ GUI 보기</button>' +
          (argsSchema.length ? '<button type="button" class="pill" data-plg-args-btn="' + esc(p.name) + '">⚙️ 설정 (' + argsSchema.length + ')</button>' : '') +
          (p.source === 'custom' ? '<button type="button" class="pill" data-plg-del="' + esc(p.name) + '" style="color:var(--danger);">🗑️ 삭제</button>' : '') +
        '</div>' +
        argsHtml +
      '</div>';
    }).join('');
  }

  async function loadBackendPlugins(force = false) {
    if (backendPluginsLoading) return;
    if (!force && backendPluginsLoadedAt && (Date.now() - backendPluginsLoadedAt < 5000)) return;
    backendPluginsLoading = true;
    try {
      const res = await api('/api/plugins');
      backendPluginsCache = Array.isArray(res && res.plugins) ? res.plugins : [];
      backendPluginsLoadedAt = Date.now();
      const chk = document.getElementById('remoteDirectOnlyChk');
      if (chk && res) chk.checked = res.remoteDirectOnly !== false;
      renderBackendPluginsList();
    } catch (_) {
    } finally {
      backendPluginsLoading = false;
    }
  }

  function closePluginGuiModal() {
    pluginGuiState.open = false;
    pluginGuiState.pluginName = '';
    pluginGuiState.uiItems = [];
    const modal = document.getElementById('pluginGuiModal');
    if (modal) {
      modal.style.display = 'none';
      modal.innerHTML = '';
    }
  }

  async function openPluginGuiModal(pluginName, entryId = '') {
    const modal = document.getElementById('pluginGuiModal');
    if (!modal || !pluginName) return;
    const plg = backendPluginsCache.find((p) => p && p.name === pluginName);
    pluginGuiState.open = true;
    pluginGuiState.pluginName = pluginName;
    pluginGuiState.displayName = (plg && plg.displayName) || pluginName;
    pluginGuiState.entryId = entryId || '';
    pluginGuiState.uiItems = (plg && Array.isArray(plg.uiItems)) ? plg.uiItems : [];

    modal.innerHTML =
      '<div class="plg-gui-dialog">' +
        '<div class="plg-gui-head">' +
          '<div style="font-size:14.5px; font-weight:800; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">🖥️ ' + esc(pluginGuiState.displayName) + '</div>' +
          '<div style="display:flex; gap:6px; align-items:center;">' +
            '<button type="button" class="pill" data-plg-gui-reload="1">↻ 새로고침</button>' +
            '<button type="button" class="pill" data-plg-gui-close="1">✕ 닫기</button>' +
          '</div>' +
        '</div>' +
        '<iframe id="pluginGuiFrame" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"></iframe>' +
      '</div>';
    modal.style.display = 'flex';

    try {
      const isNight = /night|midnight|dark|claude/i.test(uiPref.theme || '');
      const res = await api('/api/plugins/gui-srcdoc?name=' + encodeURIComponent(pluginName) + '&entryId=' + encodeURIComponent(entryId || '') + '&theme=' + (isNight ? 'dark' : 'light'));
      const frame = document.getElementById('pluginGuiFrame');
      if (frame && res && res.srcdoc) {
        frame.srcdoc = res.srcdoc;
      }
    } catch (e) {
      toast('플러그인 GUI 열기 실패: ' + (e && e.message ? e.message : '오류'));
    }
  }

  window.addEventListener('message', async (ev) => {
    const frame = document.getElementById('pluginGuiFrame');
    if (!frame || !frame.contentWindow || ev.source !== frame.contentWindow) return;
    const d = ev.data;
    if (!d || typeof d !== 'object') return;
    if (d.__rsGuiClose === 1) {
      closePluginGuiModal();
      return;
    }
    if (d.__rsGuiReloadPlugin === 1) {
      toast('플러그인 리로드 완료');
      if (typeof loadBackendPlugins === 'function') loadBackendPlugins(true);
      if (typeof pollState === 'function') pollState();
      if (pluginGuiState.open && pluginGuiState.pluginName) {
        setTimeout(() => {
          if (pluginGuiState.open) openPluginGuiModal(pluginGuiState.pluginName, pluginGuiState.entryId);
        }, 120);
      }
      return;
    }
    if (d.__rsGuiRpc === 1 && d.reqId) {
      try {
        const res = await api('/api/plugins/gui-rpc', {
          method: 'POST',
          body: JSON.stringify({ pluginName: d.pluginName || pluginGuiState.pluginName, method: d.method, args: d.args || [] }),
        });
        frame.contentWindow.postMessage({ __rsGuiRpcRes: 1, reqId: d.reqId, ok: true, value: res ? res.value : undefined }, '*');
      } catch (err) {
        frame.contentWindow.postMessage({ __rsGuiRpcRes: 1, reqId: d.reqId, ok: false, error: (err && err.message) ? err.message : 'RPC error' }, '*');
      }
    }
  });

  const pluginGuiModalEl = document.getElementById('pluginGuiModal');
  if (pluginGuiModalEl) {
    pluginGuiModalEl.addEventListener('click', (e) => {
      if (e.target === pluginGuiModalEl || e.target.closest('[data-plg-gui-close]')) {
        closePluginGuiModal();
        return;
      }
      if (e.target.closest('[data-plg-gui-reload]')) {
        openPluginGuiModal(pluginGuiState.pluginName, pluginGuiState.entryId);
        return;
      }
    });
  }

  const remoteDirectOnlyChk = document.getElementById('remoteDirectOnlyChk');
  if (remoteDirectOnlyChk) {
    remoteDirectOnlyChk.onchange = async () => {
      const want = Boolean(remoteDirectOnlyChk.checked);
      try {
        const res = await api('/api/plugins/settings', {
          method: 'POST',
          body: JSON.stringify({ remoteDirectOnly: want }),
        });
        remoteDirectOnlyChk.checked = res.remoteDirectOnly !== false;
        toast(remoteDirectOnlyChk.checked ? '백엔드 단독 실행 켜짐 (PC 내부 플러그인 중지)' : 'PC 활성 봇 네이티브 실행 허용됨');
      } catch (e) {
        remoteDirectOnlyChk.checked = !want;
        toast('설정 저장 실패: ' + (e && e.message ? e.message : '오류'));
      }
    };
  }
  const syncPcPluginsBtn = document.getElementById('syncPcPluginsBtn');
  if (syncPcPluginsBtn) {
    syncPcPluginsBtn.onclick = async () => {
      try {
        const res = await api('/api/plugins/sync-pc', { method: 'POST', body: '{}' });
        backendPluginsCache = Array.isArray(res && res.plugins) ? res.plugins : [];
        backendPluginsLoadedAt = Date.now();
        renderBackendPluginsList();
        if (typeof pollState === 'function') pollState();
        toast('PC 플러그인 동기화 완료 (' + backendPluginsCache.length + '개)');
      } catch (e) {
        toast('동기화 오류: ' + (e && e.message ? e.message : '실패'));
      }
    };
  }
  const reloadPcPluginsBtn = document.getElementById('reloadPcPluginsBtn');
  if (reloadPcPluginsBtn) {
    reloadPcPluginsBtn.onclick = async () => {
      try {
        const res = await api('/api/plugins/reload-pc', { method: 'POST', body: '{}' });
        if (res && Array.isArray(res.plugins)) {
          backendPluginsCache = res.plugins;
          backendPluginsLoadedAt = Date.now();
          renderBackendPluginsList();
        }
        if (typeof pollState === 'function') pollState();
        toast('플러그인 리로드 완료');
      } catch (e) {
        toast('리로드 오류: ' + (e && e.message ? e.message : '실패'));
      }
    };
  }
  const uploadPluginBtn = document.getElementById('uploadPluginBtn');
  const pluginFileInp = document.getElementById('pluginFileInp');
  if (uploadPluginBtn && pluginFileInp) {
    uploadPluginBtn.onclick = () => pluginFileInp.click();
    pluginFileInp.onchange = async () => {
      const f = pluginFileInp.files && pluginFileInp.files[0];
      pluginFileInp.value = '';
      if (!f) return;
      try {
        const script = await f.text();
        const res = await api('/api/plugins/upload', {
          method: 'POST',
          body: JSON.stringify({ filename: f.name, script, enabled: true }),
        });
        backendPluginsCache = Array.isArray(res && res.plugins) ? res.plugins : [];
        backendPluginsLoadedAt = Date.now();
        renderBackendPluginsList();
        if (typeof pollState === 'function') pollState();
        toast('플러그인 추가 및 활성화됨: ' + f.name);
      } catch (e) {
        toast('업로드 실패: ' + (e && e.message ? e.message : '오류'));
      }
    };
  }
  const backendPluginListEl = document.getElementById('backendPluginList');
  if (backendPluginListEl) {
    backendPluginListEl.addEventListener('change', async (e) => {
      const chk = e.target.closest('[data-plg-toggle]');
      if (!chk) return;
      const name = chk.getAttribute('data-plg-toggle');
      const enabled = Boolean(chk.checked);
      try {
        const res = await api('/api/plugins/toggle', {
          method: 'POST',
          body: JSON.stringify({ name, enabled }),
        });
        backendPluginsCache = Array.isArray(res && res.plugins) ? res.plugins : [];
        backendPluginsLoadedAt = Date.now();
        renderBackendPluginsList();
        if (typeof pollState === 'function') pollState();
        toast(name + (enabled ? ' 켜짐' : ' 꺼짐'));
      } catch (err) {
        chk.checked = !enabled;
        toast('전환 실패: ' + (err && err.message ? err.message : '오류'));
      }
    });
    backendPluginListEl.addEventListener('click', async (e) => {
      const guiBtn = e.target.closest('[data-plg-gui]');
      if (guiBtn) {
        openPluginGuiModal(guiBtn.getAttribute('data-plg-gui'));
        return;
      }
      const argsBtn = e.target.closest('[data-plg-args-btn]');
      if (argsBtn) {
        const n = argsBtn.getAttribute('data-plg-args-btn');
        if (openPluginArgsSet.has(n)) openPluginArgsSet.delete(n);
        else openPluginArgsSet.add(n);
        renderBackendPluginsList();
        return;
      }
      const saveArgsBtn = e.target.closest('[data-plg-args-save]');
      if (saveArgsBtn) {
        const n = saveArgsBtn.getAttribute('data-plg-args-save');
        const nextArgs = {};
        backendPluginListEl.querySelectorAll('[data-plg-arg-name]').forEach((inp) => {
          if (inp.getAttribute('data-plg-arg-name') === n) {
            nextArgs[inp.getAttribute('data-plg-arg-key')] = inp.value;
          }
        });
        const res = await api('/api/plugins/args', {
          method: 'POST',
          body: JSON.stringify({ name: n, args: nextArgs }),
        });
        backendPluginsCache = Array.isArray(res && res.plugins) ? res.plugins : [];
        renderBackendPluginsList();
        toast('플러그인 인자 저장됨');
        return;
      }
      const delBtn = e.target.closest('[data-plg-del]');
      if (delBtn) {
        const n = delBtn.getAttribute('data-plg-del');
        if (!confirm('백엔드에서 "' + n + '" 플러그인을 삭제할까요?')) return;
        const res = await api('/api/plugins/' + encodeURIComponent(n), { method: 'DELETE' });
        backendPluginsCache = Array.isArray(res && res.plugins) ? res.plugins : [];
        renderBackendPluginsList();
        toast('플러그인 삭제됨');
      }
    });
  }

  // ===== RisuStand Floating Mini-Bar (matches risustand.js PC top mini-bar) =====

  function clearRsMiniBarTimer() {
    if (rsMiniBarAutoTimer) { clearTimeout(rsMiniBarAutoTimer); rsMiniBarAutoTimer = null; }
  }
  function scheduleRsMiniBarAutoMin() {
    clearRsMiniBarTimer();
    if (!uiPref.zenMode || rsMiniBarMinimized) return;
    rsMiniBarAutoTimer = setTimeout(() => {
      if (!rsMiniBarDrag && !rsMiniBarMinimized) {
        rsMiniBarMinimized = true;
        try { localStorage.setItem('rs_minibar_min', '1'); } catch (_) {}
        renderRsMiniBar(true);
      }
    }, 5000);
  }
  function applyRsMiniBarPos(el) {
    if (!el) return;
    try {
      const saved = JSON.parse(localStorage.getItem('rs_minibar_pos') || 'null');
      if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
        const vw = window.innerWidth || 390;
        const vh = window.innerHeight || 844;
        const barW = Math.min(vw - 16, Math.max(48, el.offsetWidth || 48));
        const barH = Math.min(vh - 16, Math.max(32, el.offsetHeight || 36));
        el.style.left = Math.max(8, Math.min(vw - barW - 8, saved.x)) + 'px';
        el.style.top = Math.max(8, Math.min(vh - barH - 8, saved.y)) + 'px';
        el.style.transform = 'none';
        return;
      }
    } catch (_) {}
    el.style.left = '50%';
    el.style.top = 'calc(14px + env(safe-area-inset-top))';
    el.style.transform = 'translateX(-50%)';
  }
  function renderRsMiniBar(force = false) {
    const el = document.getElementById('rsMiniBar');
    if (!el) return;
    if (!uiPref.zenMode) {
      clearRsMiniBarTimer();
      el.style.display = 'none';
      lastRsMiniBarSig = 'off';
      return;
    }
    const themeBrands = {
      'ai-gemini': '✦ Gemini',
      'ai-claude': '✻ Claude',
      'ai-chatgpt': '◉ ChatGPT',
      'midnight-glass': '✧ Glass',
      'epub-1p-day': '📖 1쪽',
      'epub-1p-night': '🌙 1쪽',
      'epub-2p-day': '📖 2쪽',
      'epub-2p-night': '🌙 2쪽',
      'sakura-pastel': '🌸 사쿠라',
      'forest-moss': '🌿 모스',
    };
    const brand = themeBrands[uiPref.theme] || '✦ RisuStand';
    const shortIc = brand.split(' ')[0] || '✦';
    const rwCount = (latestPluginFloatingUi && Array.isArray(latestPluginFloatingUi.rootWidgets)) ? latestPluginFloatingUi.rootWidgets.length : 0;
    const sig = JSON.stringify([rsMiniBarMinimized, uiPref.theme, uiPref.assetMode, uiPref.zenMode, rwCount]);
    el.style.display = 'inline-flex';
    if (!force && sig === lastRsMiniBarSig) {
      applyRsMiniBarPos(el);
      return;
    }
    lastRsMiniBarSig = sig;
    if (rsMiniBarMinimized) {
      el.className = 'minimized';
      const stealthDot = uiPref.assetMode !== 'show' ? ' 🙈' : '';
      el.innerHTML = '<span style="pointer-events:none;">' + esc(shortIc + stealthDot) + '</span>';
      el.title = '리스스탠드 미니바 펼치기 (드래그 이동 가능)';
    } else {
      el.className = 'expanded';
      el.removeAttribute('title');
      const eyeLabel = uiPref.assetMode === 'hide' ? '🙈 스텔스' : (uiPref.assetMode === 'blur' ? '🌫️ 블러' : '👁️ 표시');
      const zenLabel = uiPref.zenMode ? '🧘 집중 ON' : '🧘 집중';
      const fltLabel = rwCount > 0 ? ('🎛️ 플로팅 (' + rwCount + ')') : '🎛️ 플로팅';
      el.innerHTML =
        '<span class="rs-mb-handle" data-rsmb-drag="1">⠿ ' + esc(brand) + '</span>' +
        '<button type="button" class="rs-mb-pill" data-rsmb-act="bottom" title="맨 아래로 이동">⬇</button>' +
        '<button type="button" class="rs-mb-pill' + (uiPref.assetMode !== 'show' ? ' active' : '') + '" data-rsmb-act="eye">' + eyeLabel + '</button>' +
        '<button type="button" class="rs-mb-pill' + (uiPref.zenMode ? ' active' : '') + '" data-rsmb-act="zen">' + zenLabel + '</button>' +
        '<button type="button" class="rs-mb-pill" data-rsmb-act="floating">' + fltLabel + '</button>' +
        '<button type="button" class="rs-mb-pill" data-rsmb-act="theme">🎨 테마</button>' +
        '<button type="button" class="rs-mb-pill" data-rsmb-act="min" title="미니바 접기">—</button>';
    }
    applyRsMiniBarPos(el);
  }
  (function bindRsMiniBarEvents() {
    const el = document.getElementById('rsMiniBar');
    if (!el) return;
    let suppressTapUntil = 0;
    el.addEventListener('scroll', () => {
      if (!rsMiniBarMinimized && !rsMiniBarDrag) scheduleRsMiniBarAutoMin();
    }, { passive: true });
    el.addEventListener('touchmove', () => {
      if (!rsMiniBarMinimized && !rsMiniBarDrag) scheduleRsMiniBarAutoMin();
    }, { passive: true });
    el.addEventListener('pointerdown', (e) => {
      if (!rsMiniBarMinimized && !e.target.closest('[data-rsmb-drag]')) return;
      const r = el.getBoundingClientRect();
      rsMiniBarDrag = { pid: e.pointerId, startX: e.clientX, startY: e.clientY, origLeft: r.left, origTop: r.top, moved: false };
    });
    window.addEventListener('pointermove', (e) => {
      if (!rsMiniBarDrag || e.pointerId !== rsMiniBarDrag.pid) return;
      const dx = e.clientX - rsMiniBarDrag.startX;
      const dy = e.clientY - rsMiniBarDrag.startY;
      if (!rsMiniBarDrag.moved && Math.hypot(dx, dy) < 6) return;
      rsMiniBarDrag.moved = true;
      clearRsMiniBarTimer();
      const vw = window.innerWidth || 390;
      const vh = window.innerHeight || 844;
      el.style.left = Math.max(8, Math.min(vw - el.offsetWidth - 8, rsMiniBarDrag.origLeft + dx)) + 'px';
      el.style.top = Math.max(8, Math.min(vh - el.offsetHeight - 8, rsMiniBarDrag.origTop + dy)) + 'px';
      el.style.transform = 'none';
    });
    const endDrag = (e) => {
      if (!rsMiniBarDrag || e.pointerId !== rsMiniBarDrag.pid) return;
      if (rsMiniBarDrag.moved) {
        suppressTapUntil = Date.now() + 180;
        const r = el.getBoundingClientRect();
        try { localStorage.setItem('rs_minibar_pos', JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) })); } catch (_) {}
        if (!rsMiniBarMinimized) scheduleRsMiniBarAutoMin();
      }
      rsMiniBarDrag = null;
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    el.addEventListener('click', (e) => {
      if (Date.now() < suppressTapUntil) { e.preventDefault(); e.stopPropagation(); return; }
      if (rsMiniBarMinimized) {
        e.stopPropagation();
        rsMiniBarMinimized = false;
        try { localStorage.setItem('rs_minibar_min', '0'); } catch (_) {}
        renderRsMiniBar(true);
        scheduleRsMiniBarAutoMin();
        return;
      }
      const btn = e.target.closest('[data-rsmb-act]');
      if (!btn) return;
      e.stopPropagation();
      const act = btn.getAttribute('data-rsmb-act');
      if (act === 'min') {
        clearRsMiniBarTimer();
        rsMiniBarMinimized = true;
        try { localStorage.setItem('rs_minibar_min', '1'); } catch (_) {}
        renderRsMiniBar(true);
        return;
      }
      scheduleRsMiniBarAutoMin();
      if (act === 'bottom') {
        const activePanel = document.getElementById('tab-' + currentTab) || document.getElementById('tab-chat');
        if (currentTab === 'chat' && isBookMode() && typeof goToBookSpread === 'function') {
          goToBookSpread(Math.max(0, bookTotalSpreads - 1), false);
        } else if (activePanel) {
          activePanel.scrollTo({ top: activePanel.scrollHeight, behavior: 'smooth' });
        }
      } else if (act === 'eye') {
        const order = ['show', 'blur', 'hide'];
        const next = order[(order.indexOf(uiPref.assetMode) + 1) % order.length];
        window.setAssetMode(next);
      } else if (act === 'zen') {
        setZenMode(!uiPref.zenMode);
      } else if (act === 'floating') {
        openPluginFloatingModal();
      } else if (act === 'theme') {
        const rb = document.getElementById('readBar');
        setReadBar(!(rb && rb.classList.contains('open')));
      }
    });
  })();

  let activeActionOverlayPlugin = '';

  function isPluginFloatingModalOpen() {
    const modal = document.getElementById('pluginFloatingModal');
    return Boolean(modal && modal.style.display === 'flex');
  }

  function closePluginFloatingModal() {
    activeActionOverlayPlugin = '';
    const modal = document.getElementById('pluginFloatingModal');
    if (modal) {
      modal.classList.remove('is-action-overlay');
      modal.style.display = 'none';
      modal.innerHTML = '';
      lastFloatingModalSig = '';
    }
  }

  function openPluginActionOverlayModal(overlay) {
    const modal = document.getElementById('pluginFloatingModal');
    if (!modal || !overlay || !overlay.html) return;
    activeActionOverlayPlugin = String(overlay.pluginName || '');
    const snap = (lastState && lastState.snapshot) || {};
    const safeAttrName = activeActionOverlayPlugin.replace(/[^a-zA-Z0-9_-]/g, '');
    const scopeSel = '.rs-pfm-stage[data-rs-rw-plugin="' + safeAttrName + '"]';
    const styleHtml = (Array.isArray(overlay.styles) ? overlay.styles : [])
      .map((s) => '<style>' + scopeBotCss(sanitizeBotCss(s), scopeSel) + '</style>')
      .join('');
    const bodyHtml = sanitizePluginWidgetHtml(overlay.html || '', scopeSel, snap.assetMap || {});
    modal.classList.add('is-action-overlay');
    modal.innerHTML =
      '<div class="plg-float-dialog">' +
        '<div class="plg-float-head">' +
          '<div style="font-size:15px; font-weight:800;">🖼️ ' + esc(overlay.displayName || activeActionOverlayPlugin || '플러그인 GUI') + '</div>' +
          '<button type="button" class="pill" data-pfm-close="1">✕ 닫기</button>' +
        '</div>' +
        '<div class="plg-float-body">' +
          '<div class="rs-pfm-stage" data-rs-rw-plugin="' + esc(safeAttrName) + '" data-rs-plugin-raw="' + esc(activeActionOverlayPlugin) + '">' +
            styleHtml + bodyHtml +
          '</div>' +
        '</div>' +
      '</div>';
    modal.style.display = 'flex';
  }

  function renderPluginFloatingModal(force = false) {
    const modal = document.getElementById('pluginFloatingModal');
    if (!modal) return;
    if (!force && !isPluginFloatingModalOpen()) return;
    if (!force && activeActionOverlayPlugin) return;
    activeActionOverlayPlugin = '';
    modal.classList.remove('is-action-overlay');
    const isHide = uiPref.assetMode === 'hide';
    const snap = (lastState && lastState.snapshot) || {};
    const uiData = latestPluginFloatingUi || { rev: '', buttons: [], rootWidgets: [] };
    const widgets = Array.isArray(uiData.rootWidgets) ? uiData.rootWidgets : [];
    const sig = JSON.stringify([uiData.rev || '', widgets.length, uiPref.assetMode]);
    if (!force && sig === lastFloatingModalSig) return;
    lastFloatingModalSig = sig;

    const cardsHtml = widgets.map((w) => {
      const safeAttrName = w.pluginName.replace(/[^a-zA-Z0-9_-]/g, '');
      const scopeSel = '.rs-pfm-stage[data-rs-rw-plugin="' + safeAttrName + '"]';
      const styleHtml = (w.styles || []).map((s) => '<style>' + scopeBotCss(sanitizeBotCss(s), scopeSel) + '</style>').join('');
      const bodyHtml = sanitizePluginWidgetHtml(w.html || '', scopeSel, snap.assetMap || {});
      return '<div class="rs-pfm-card">' +
        '<div class="rs-pfm-card-head">' +
          '<b style="font-size:13.5px;">🧩 ' + esc(w.displayName || w.pluginName) + '</b>' +
        '</div>' +
        '<div class="rs-pfm-stage" data-rs-rw-plugin="' + esc(safeAttrName) + '" data-rs-plugin-raw="' + esc(w.pluginName) + '">' +
          styleHtml + bodyHtml +
        '</div>' +
      '</div>';
    }).join('');

    const emptyHtml = !widgets.length
      ? '<div style="font-size:13px; color:var(--sub); padding:10px 2px; line-height:1.6;">' +
          '현재 플로팅 컨트롤 위젯을 마운트한 활성 플러그인이 없습니다.<br>' +
          '<b>[모듈/설정 → 백엔드 플러그인 어댑터]</b>에서 해당 플러그인이 활성화되어 있는지 확인해 주세요.' +
        '</div>'
      : '';

    const titleTxt = isHide ? '🎛️ 확장 플로팅 도구' : '🎛️ 플러그인 플로팅 컨트롤';
    modal.innerHTML =
      '<div class="plg-float-dialog">' +
        '<div class="plg-float-head">' +
          '<div style="font-size:15px; font-weight:800;">' + titleTxt + '</div>' +
          '<button type="button" class="pill" data-pfm-close="1">✕ 닫기</button>' +
        '</div>' +
        '<div class="plg-float-body">' +
          cardsHtml +
          emptyHtml +
        '</div>' +
      '</div>';
    modal.style.display = 'flex';
  }

  async function openPluginFloatingModal() {
    const snap = (lastState && lastState.snapshot) || {};
    try {
      const res = await api('/api/plugins/floating-open', {
        method: 'POST',
        body: JSON.stringify({
          charIndex: Number.isFinite(Number(snap.charIndex)) ? Number(snap.charIndex) : -1,
          chatIndex: Number.isFinite(Number(snap.chatIndex)) ? Number(snap.chatIndex) : -1,
        }),
      });
      if (res && res.pluginFloatingUi) {
        latestPluginFloatingUi = res.pluginFloatingUi;
        renderRsMiniBar(false);
      }
    } catch (_) {}
    lastFloatingModalSig = '';
    renderPluginFloatingModal(true);
  }

  (function bindPluginFloatingModalEvents() {
    const readBarBtn = document.getElementById('openPlgFloatingBtn');
    if (readBarBtn) {
      readBarBtn.onclick = () => {
        setReadBar(false);
        openPluginFloatingModal();
      };
    }
    const modal = document.getElementById('pluginFloatingModal');
    if (!modal) return;
    const sendPluginRootInteraction = async (target, stage, eventType = 'click') => {
      const pName = stage.getAttribute('data-rs-plugin-raw') || stage.getAttribute('data-rs-rw-plugin');
      if (!pName || !target || target === stage) return;
      const snap = (lastState && lastState.snapshot) || {};
      const cIdx = Number.isFinite(Number(snap.charIndex)) ? Number(snap.charIndex) : -1;
      const chIdx = Number.isFinite(Number(snap.chatIndex)) ? Number(snap.chatIndex) : -1;
      const meta = collectAmElementMeta(target);
      const countNode = target.getAttribute('data-am-count-node') || '';
      const actionAttr = target.getAttribute('data-am-runtime-generation-count-action');
      const toastAttr = target.getAttribute('data-am-runtime-toast-action');
      let selector = '';
      if (target.id) selector = '#' + target.id.replace(/[^a-zA-Z0-9_-]/g, '');
      else if (actionAttr) selector = '[data-am-runtime-generation-count-action="' + actionAttr + '"]';
      else if (toastAttr) selector = '[data-am-runtime-toast-action="' + toastAttr + '"]';

      const payload = {
        pluginName: pName,
        charIndex: cIdx,
        chatIndex: chIdx,
        countNode,
        selector,
        actionHtml: meta.actionHtml,
        dataset: meta.dataset,
        textContent: meta.textContent,
        ariaLabel: meta.ariaLabel,
        title: meta.title,
        className: meta.className,
        siblingIndex: meta.siblingIndex,
        eventType,
        x: 24,
        y: 24,
      };
      if (eventType !== 'click') {
        payload.value = target.value !== undefined ? target.value : '';
        if (target.type === 'checkbox' || target.type === 'radio') payload.checked = Boolean(target.checked);
      }

      const res = await api('/api/plugins/root-click', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (res && res.pluginFloatingUi) {
        latestPluginFloatingUi = res.pluginFloatingUi;
        renderRsMiniBar(false);
      }
      if (res && res.snapshot && lastState) {
        if (typeof res.snapshotVersion === 'number') knownSnapshotVer = res.snapshotVersion;
        applyState({ ...lastState, snapshot: res.snapshot, snapshotVersion: res.snapshotVersion ?? lastState.snapshotVersion });
      }
      if (activeActionOverlayPlugin) {
        if (res && res.activeOverlay && res.activeOverlay.html) {
          if (eventType === 'click') openPluginActionOverlayModal(res.activeOverlay);
        } else if (res && res.activeOverlay === null && eventType === 'click') {
          closePluginFloatingModal();
        }
      } else if (eventType === 'click') {
        renderPluginFloatingModal(true);
      }
    };

    modal.addEventListener('submit', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    let pfmInputTimer = null;
    modal.addEventListener('input', (e) => {
      const target = e.target && e.target.closest ? e.target.closest('input, textarea, select') : null;
      const stage = target && target.closest ? target.closest('[data-rs-rw-plugin]') : null;
      if (!target || !stage) return;
      if (pfmInputTimer) clearTimeout(pfmInputTimer);
      pfmInputTimer = setTimeout(() => {
        void sendPluginRootInteraction(target, stage, 'input').catch(() => {});
      }, 120);
    });
    modal.addEventListener('change', (e) => {
      const target = e.target && e.target.closest ? e.target.closest('input, textarea, select') : null;
      const stage = target && target.closest ? target.closest('[data-rs-rw-plugin]') : null;
      if (!target || !stage) return;
      void sendPluginRootInteraction(target, stage, 'change').catch(() => {});
    });
    modal.addEventListener('click', async (e) => {
      if (e.target === modal || e.target.closest('[data-pfm-close]')) {
        closePluginFloatingModal();
        return;
      }
      const stage = e.target.closest('[data-rs-rw-plugin]');
      if (!stage) return;
      if (e.target.closest('input, textarea, select, option') && !e.target.closest('button, [role="button"], [type="submit"], [type="button"], [type="checkbox"], [type="radio"]')) {
        return;
      }
      const target = e.target.closest('button, [data-am-runtime-generation-count-action], [data-am-runtime-toast-action], a, [role="button"], [data-am-slot], [data-am-count-node]') || e.target;
      if (!target || target === stage) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        await sendPluginRootInteraction(target, stage, 'click');
      } catch (err) {
        toast('컨트롤 실행 오류: ' + (err && err.message ? err.message : '실패'));
      }
    });
  })();

  function closeSceneCtrlModal() {
    const modal = document.getElementById('sceneCtrlModal');
    if (modal) {
      modal.style.display = 'none';
      modal.innerHTML = '';
    }
  }

  async function openSceneCtrlModal() {
    const modal = document.getElementById('sceneCtrlModal');
    if (!modal) return;
    if (!backendPluginsCache.length) {
      await loadBackendPlugins(true).catch(() => {});
    }
    const isHide = uiPref.assetMode === 'hide';
    const isBlur = uiPref.assetMode === 'blur';
    const snap = (lastState && lastState.snapshot) || {};
    const msgs = Array.isArray(snap.messages) ? snap.messages : [];
    const cards = [];
    for (const m of msgs) {
      if (!m || m.role === 'user') continue;
      const ctrls = extractPluginBubbleControls(m.html || '');
      const imgs = Array.isArray(m.images) ? m.images : [];
      const hasLb = Boolean(m.html && /risu-form|lb-interaction/i.test(m.html));
      if (!ctrls.length && !imgs.length && !hasLb) continue;
      let thumbsHtml = '';
      if (isHide && imgs.length) {
        thumbsHtml = '<div class="scene-stealth-note">🙈 스텔스 모드 적용 중 · 이미지 ' + imgs.length + '장 숨김</div>';
      } else if (!isHide && imgs.length) {
        const itemsHtml = imgs.map((im) => {
          const src = String(im).startsWith('[[RSASSET:') ? resolveAssetTokens(im, snap.assetMap) : safeImgSrc(im);
          if (!src) return '';
          return '<span class="scene-thumb-wrap" data-scene-thumb-reveal="1"><img class="scene-slot-thumb" src="' + esc(src) + '" /><span class="scene-thumb-veil">' + (isBlur ? '🌫️ 보기' : '') + '</span></span>';
        }).join('');
        if (itemsHtml) thumbsHtml = '<div class="scene-slot-thumbs">' + itemsHtml + '</div>';
      }
      const amBtnsHtml = ctrls.map((c) => {
        const payload = esc(JSON.stringify({ msgIndex: m.index, chatId: m.chatId || '', actionHtml: c.outerHTML, dataset: c.dataset }));
        return '<button type="button" class="rs-pbb-btn" data-scene-am="' + payload + '">' + esc(c.label) + '</button>';
      }).join('');
      const lbBtnHtml = hasLb
        ? '<button type="button" class="rs-pbb-btn" data-scene-lb-reroll="' + m.index + '">🔦 라이트보드 재생성</button>'
        : '';
      cards.push(
        '<div class="scene-slot-card">' +
          '<div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">' +
            '<b style="font-size:13px;">#' + (m.index >= 0 ? m.index + 1 : '인사말') + ' · ' + esc(displayBotName(snap.charName)) + '</b>' +
            '<span class="badge">' + (isHide ? '항목 ' : '삽화 ') + imgs.length + ' · 컨트롤 ' + (ctrls.length + (hasLb ? 1 : 0)) + '</span>' +
          '</div>' +
          thumbsHtml +
          '<div class="plg-acts">' + amBtnsHtml + lbBtnHtml + '</div>' +
        '</div>'
      );
    }
    const activeGuiPlugins = (backendPluginsCache || []).filter((p) => p && p.enabled);
    const rwCount = (latestPluginFloatingUi && Array.isArray(latestPluginFloatingUi.rootWidgets)) ? latestPluginFloatingUi.rootWidgets.length : 0;
    const floatingPopupBtn = '<button type="button" class="pill active" data-scene-open-floating="1">🎛️ 플러그인 플로팅 컨트롤 열기' + (rwCount > 0 ? ' (' + rwCount + ')' : '') + '</button>';
    const guiLinksHtml =
      '<div class="plg-acts" style="margin-bottom:4px;">' +
        floatingPopupBtn +
        activeGuiPlugins.map((p) => '<button type="button" class="pill" data-scene-open-gui="' + esc(p.name) + '">🖥️ ' + esc(p.displayName || p.name) + ' GUI</button>').join('') +
      '</div>';
    const modalTitle = isHide ? '⚙️ 문서 · 확장 도구 제어함' : '🖼️ 장면 · 삽화 · 플러그인 제어함';
    modal.innerHTML =
      '<div class="scene-ctrl-dialog">' +
        '<div class="scene-ctrl-head">' +
          '<div style="font-size:15px; font-weight:800;">' + modalTitle + '</div>' +
          '<button type="button" class="pill" data-scene-close="1">✕ 닫기</button>' +
        '</div>' +
        '<div class="scene-ctrl-body">' +
          guiLinksHtml +
          (cards.length ? cards.join('') : '<div style="font-size:13px; color:var(--sub); padding:16px 4px;">이 채팅방에 삽화나 플러그인/모듈 제어 슬롯이 아직 없습니다.</div>') +
        '</div>' +
      '</div>';
    modal.style.display = 'flex';
  }

  const sceneQuickBtnEl = document.getElementById('sceneCtrlQuickBtn');
  if (sceneQuickBtnEl) sceneQuickBtnEl.onclick = openSceneCtrlModal;
  const sceneModalEl = document.getElementById('sceneCtrlModal');
  if (sceneModalEl) {
    sceneModalEl.addEventListener('click', async (e) => {
      if (e.target === sceneModalEl || e.target.closest('[data-scene-close]')) {
        closeSceneCtrlModal();
        return;
      }
      const revealWrap = e.target.closest('[data-scene-thumb-reveal]');
      if (revealWrap && document.body.classList.contains('asset-blur')) {
        revealWrap.classList.toggle('revealed');
        return;
      }
      if (e.target.closest('[data-scene-open-floating]')) {
        closeSceneCtrlModal();
        openPluginFloatingModal();
        return;
      }
      const guiBtn = e.target.closest('[data-scene-open-gui]');
      if (guiBtn) {
        closeSceneCtrlModal();
        openPluginGuiModal(guiBtn.getAttribute('data-scene-open-gui'));
        return;
      }
      const amBtn = e.target.closest('[data-scene-am]');
      if (amBtn) {
        try {
          const info = JSON.parse(amBtn.getAttribute('data-scene-am') || '{}');
          await dispatchPluginSurfaceAction(info.msgIndex, info.actionHtml, info.dataset);
        } catch (_) {}
        return;
      }
      const lbBtn = e.target.closest('[data-scene-lb-reroll]');
      if (lbBtn) {
        const snap = lastState && lastState.snapshot;
        if (!snap || snap.charIndex < 0) return;
        toast('라이트보드 인터랙션 요청 중...');
        await api('/api/modules/interaction', {
          method: 'POST',
          body: JSON.stringify({ charIndex: snap.charIndex, chatIndex: snap.chatIndex, kind: 'form', key: 'lb-interaction__xnai', formValues: {} }),
        }).catch(() => {});
        setTimeout(pollState, 350);
      }
    });
  }

  if (token) tryLogin(token);
</script>
</body>
</html>`;
}

function sanitizeConfigForClient() {
    if (syncDirectPresetToggles(config)) {
        saveConfig();
    }
    const remoteToggleValues = (config.remoteToggleValues && typeof config.remoteToggleValues === 'object' && !Array.isArray(config.remoteToggleValues))
        ? { ...config.remoteToggleValues }
        : {};
    return {
        activeProfileId: config.activeProfileId,
        auxProfileId: typeof config.auxProfileId === 'string' && config.auxProfileId ? config.auxProfileId : 'inherit',
        directPresetId: typeof config.directPresetId === 'string' ? config.directPresetId : 'bundled:leave',
        directHistoryMode: normalizeDirectHistoryMode(config.directHistoryMode),
        directPipelineMode: normalizeDirectPipelineMode(config.directPipelineMode),
        directPresets: listDirectPresets(),
        remoteToggleValues,
        disabledLoreEntries: (config.disabledLoreEntries && typeof config.disabledLoreEntries === 'object') ? config.disabledLoreEntries : {},
        enabledModuleLoreEntries: (config.enabledModuleLoreEntries && typeof config.enabledModuleLoreEntries === 'object') ? config.enabledModuleLoreEntries : {},
        pinnedLoreEntries: (config.pinnedLoreEntries && typeof config.pinnedLoreEntries === 'object') ? config.pinnedLoreEntries : {},
        presetToggles: Array.isArray(config.presetToggles) ? config.presetToggles : [],
        backendPlugins: (config.backendPlugins && typeof config.backendPlugins === 'object') ? config.backendPlugins : {},
        remoteDirectOnly: config.remoteDirectOnly !== false,
        imageGen: sanitizeImageGenForClient(config.imageGen),
        tts: sanitizeTtsForClient(config.tts),
        profiles: config.profiles.map((p) => ({
            id: p.id,
            name: p.name,
            provider: p.provider || detectProviderPresetId('', p.providerType, p.baseUrl),
            providerType: p.providerType,
            baseUrl: p.baseUrl,
            hasKey: Boolean(p.apiKey),
            keyPreview: maskKey(p.apiKey),
            model: p.model,
            temperature: p.temperature !== undefined && p.temperature !== null ? String(p.temperature) : '',
            maxTokens: p.maxTokens !== undefined && p.maxTokens !== null ? String(p.maxTokens) : '',
            overrideMode: p.overrideMode || 'off',
            systemOverride: p.systemOverride || '',
        })),
        translator: {
            ...config.translator,
            apiKey: undefined,
            hasKey: Boolean(config.translator.apiKey),
            keyPreview: maskKey(config.translator.apiKey),
        },
    };
}

// ================= Remote Updater =================
let updater = null;
try {
    updater = require('./risustand-updater.cjs');
} catch (e) {
    console.warn('[Update] risustand-updater.cjs를 찾지 못해 원격 업데이트가 꺼져 있습니다.');
}
const updateLog = (m) => console.log(`[Update] ${m}`);
const updateState = {
    phase: 'idle', // idle | checking | downloading | verifying | installing | restarting | error
    message: '',
    error: null,
    target: null,
    info: null,
    checkedAt: null,
    stagedLaunchers: [],
};
const UPDATE_PHASE_LABEL = {
    checking: '새 버전 확인 중...',
    downloading: '공식 릴리즈 다운로드 중...',
    verifying: '무결성 검증 중 (SHA-256 · 매니페스트 · 문법)...',
    installing: '백업 후 파일 교체 중...',
    restarting: '새 버전으로 재시작 중...',
};

function updateBusy() {
    return ['checking', 'downloading', 'verifying', 'installing', 'restarting'].includes(updateState.phase);
}

function publicUpdateState() {
    return {
        available: Boolean(updater),
        relayVersion: RELAY_VERSION,
        pluginVersion: state.pluginVersion || null,
        phase: updateState.phase,
        message: updateState.message,
        error: updateState.error,
        target: updateState.target,
        checkedAt: updateState.checkedAt,
        stagedLaunchers: updateState.stagedLaunchers,
        lastRollback: (() => {
            const j = updater ? updater.readJournal(ROOT_DIR) : null;
            return j && j.state === 'rolled_back' ? { failedVersion: j.to, restoredVersion: j.from, at: j.rolledBackAt || null } : null;
        })(),
        latest: updateState.info
            ? {
                version: updateState.info.latestVersion || null,
                updateAvailable: Boolean(updateState.info.available),
                htmlUrl: updateState.info.htmlUrl || null,
                publishedAt: updateState.info.publishedAt || null,
                notes: updateState.info.notes || '',
                hasAsset: Boolean(updateState.info.asset && updateState.info.asset.sha256),
            }
            : null,
    };
}

async function checkForUpdate() {
    if (!updater) throw new Error('업데이터가 설치되어 있지 않습니다.');
    const info = await updater.checkLatest({ currentVersion: RELAY_VERSION });
    updateState.info = info;
    updateState.checkedAt = new Date().toISOString();
    return info;
}

async function runRemoteUpdate() {
    updateState.error = null;
    updateState.stagedLaunchers = [];
    try {
        const r = await updater.updateToLatest({
            root: ROOT_DIR,
            currentVersion: RELAY_VERSION,
            log: updateLog,
            onPhase: (phase, d) => {
                updateState.phase = phase;
                updateState.message = UPDATE_PHASE_LABEL[phase] || phase;
                if (d && d.version) updateState.target = d.version;
                updateLog(updateState.message);
            },
        });
        updateState.info = r.info;
        updateState.checkedAt = new Date().toISOString();
        if (!r.updated) {
            updateState.phase = 'idle';
            updateState.message = '이미 최신 버전입니다.';
            return;
        }
        updateState.stagedLaunchers = r.stagedLaunchers || [];
        for (const rel of updateState.stagedLaunchers) updateLog(`런처 변경: ${rel}.new 를 확인 후 ${rel} 에 덮어써 주세요.`);
        updateState.phase = 'restarting';
        updateState.message = UPDATE_PHASE_LABEL.restarting;
        // Give the phone a moment to read the "restarting" state.
        setTimeout(() => restartRelay({ guardUpdate: true }), 1200);
    } catch (e) {
        updateState.phase = 'error';
        updateState.error = e && e.message ? e.message : String(e);
        updateState.message = '업데이트 실패 — 기존 버전이 그대로 유지됩니다.';
        updateLog(`실패: ${updateState.error}${e && e.code ? ` (${e.code})` : ''}`);
    }
}

/**
 * Hands the port to a fresh process running the files now on disk and stays alive as its
 * supervisor (same console window, same token). If the freshly installed version exits
 * within 20s, the backup is restored and the previous version is started instead.
 */
let activeServer = null;

function restartRelay({ guardUpdate }) {
    const childEnv = { ...process.env, RISU_REMOTE_TOKEN: TOKEN, PORT: String(PORT), HOST };
    let child = null;
    const launch = (allowRollback) => {
        const startedAt = Date.now();
        child = spawn(process.execPath, [path.join(ROOT_DIR, 'risustand-relay-server.js'), ...process.argv.slice(2)], { stdio: 'inherit', env: childEnv });
        child.on('exit', (code) => {
            const quickFail = Date.now() - startedAt < 20000 && code !== 0;
            const journal = updater ? updater.readJournal(ROOT_DIR) : null;
            if (allowRollback && quickFail && journal && journal.state === 'installed') {
                console.error('[Update] 새 버전이 정상적으로 시작되지 않아 이전 버전으로 되돌립니다.');
                try {
                    updater.rollback(ROOT_DIR, { log: updateLog });
                } catch (e) {
                    console.error('[Update] 롤백 실패:', e.message);
                    process.exit(1);
                }
                launch(false);
                return;
            }
            process.exit(code == null ? 1 : code);
        });
    };
    // Ctrl+C reaches both processes in the console; the child decides, we follow its exit.
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => child && child.kill('SIGTERM'));
    if (activeServer) {
        activeServer.close(() => setTimeout(() => launch(guardUpdate), 350));
        if (typeof activeServer.closeAllConnections === 'function') activeServer.closeAllConnections();
    } else {
        launch(guardUpdate);
    }
}

// ================= HTTP Server =================
function createRelayServer({ token, limiter = createAuthRateLimiter(), configOverride = null } = {}) {
    const resolvedToken = token !== undefined ? String(token) : (TOKEN || (TOKEN = loadOrCreateToken(ROOT_DIR)));
    const requireAuth = makeRequireAuth(resolvedToken, limiter);
    const requireProxyAuth = makeRequireProxyAuth(resolvedToken, limiter);
    const assetCookieVal = crypto.createHmac('sha256', ASSET_HMAC_KEY).update(String(resolvedToken)).digest('hex').slice(0, 32);
    const prevConfig = configOverride ? config : null;
    const prevPersistDisabled = configPersistDisabled;
    const prevCustomPresetsCache = customPresetsCache;
    if (configOverride) {
        config = {
            ...defaultConfig(),
            ...configOverride,
            auxProfileId: typeof configOverride.auxProfileId === 'string' && configOverride.auxProfileId ? configOverride.auxProfileId : 'inherit',
            directHistoryMode: normalizeDirectHistoryMode(configOverride.directHistoryMode),
            directPipelineMode: normalizeDirectPipelineMode(configOverride.directPipelineMode),
            remoteToggleValues: (configOverride.remoteToggleValues && typeof configOverride.remoteToggleValues === 'object')
                ? { ...configOverride.remoteToggleValues }
                : {},
            disabledLoreEntries: (configOverride.disabledLoreEntries && typeof configOverride.disabledLoreEntries === 'object')
                ? { ...configOverride.disabledLoreEntries }
                : {},
            enabledModuleLoreEntries: (configOverride.enabledModuleLoreEntries && typeof configOverride.enabledModuleLoreEntries === 'object')
                ? { ...configOverride.enabledModuleLoreEntries }
                : {},
            pinnedLoreEntries: (configOverride.pinnedLoreEntries && typeof configOverride.pinnedLoreEntries === 'object')
                ? { ...configOverride.pinnedLoreEntries }
                : {},
            backendPlugins: (configOverride.backendPlugins && typeof configOverride.backendPlugins === 'object')
                ? cloneJsonSafe(configOverride.backendPlugins)
                : {},
            imageGen: normalizeImageGenConfig(configOverride.imageGen),
            tts: normalizeTtsConfig(configOverride.tts),
            remoteDirectOnly: configOverride.remoteDirectOnly !== undefined ? Boolean(configOverride.remoteDirectOnly) : true,
            botThumbs: normalizeBotThumbs(configOverride.botThumbs),
        };
        configPersistDisabled = true;
        customPresetsCache = [];
        syncDirectPresetToggles(config);
    }

    function cloneJsonSafe(v) {
        try { return JSON.parse(JSON.stringify(v)); } catch (_) { return {}; }
    }

    // ---- Direct PC Host RPC Coordinator (zero separate durable store) ----
    const rpcState = {
        seq: 0,
        rpcClientActive: false,
        pcSyncedOnce: false,
        queue: [],
        waiters: [],
        pending: new Map(), // id -> { resolve, reject, timer }
    };

    function flushRpcWaiters() {
        while (rpcState.waiters.length && rpcState.queue.length) {
            const w = rpcState.waiters.shift();
            if (!w || w.done) continue;
            w.done = true;
            clearTimeout(w.timer);
            const batch = rpcState.queue.splice(0, 25);
            try { w.respond(batch); } catch (_) {}
        }
    }

    const hostRpc = {
        isConnected: () => Boolean(
            rpcState.rpcClientActive &&
            state.pcConnected &&
            (Date.now() - state.pcLastSeen < 15000)
        ),
        invoke: (op, args = [], timeoutMs = 15000) => new Promise((resolve, reject) => {
            if (!hostRpc.isConnected()) {
                return reject(new Error('PC RisuAI 브릿지 RPC가 연결되어 있지 않습니다.'));
            }
            const id = `rpc_${++rpcState.seq}_${Date.now()}`;
            const timer = setTimeout(() => {
                if (!rpcState.pending.has(id)) return;
                rpcState.pending.delete(id);
                const qIdx = rpcState.queue.findIndex((x) => x.id === id);
                if (qIdx >= 0) rpcState.queue.splice(qIdx, 1);
                reject(new Error(`Host RPC timeout: ${op}`));
            }, timeoutMs);
            rpcState.pending.set(id, { resolve, reject, timer });
            rpcState.queue.push({ id, op, args: Array.isArray(args) ? args : [] });
            flushRpcWaiters();
        }),
    };

    const prevPluginAdapter = activePluginAdapter;
    const prevModuleAdapter = activeModuleAdapter;
    const prevHostRpc = activeHostRpc;
    activeHostRpc = hostRpc;

    let llmHookDepth = 0;
    const activityState = {
        seq: 0,
        nextId: 0,
        activeMap: new Map(), // id -> { id, kind, name, phase, startedAt }
        recentList: [], // [{ id, kind, name, phase, endedAt }]
        subscribers: new Set(), // Set<{ res, kaTimer }>
        cleanupTimer: null,
    };
    const snapshotWaiters = new Set();

    function notifySnapshotWaiters() {
        for (const w of snapshotWaiters) {
            try { w(); } catch (_) {}
        }
    }

    let surfaceRefreshTimer = null;
    let surfaceRefreshRunning = false;
    let surfaceRefreshQueued = false;

    const refreshDisplaySnapshot = async () => {
        if (!state.baseSnapshot) return;
        await rebuildDisplayedSnapshot(state.baseSnapshot, pluginAdapter);
        state.snapshotVersion += 1;
        notifySnapshotWaiters();
    };

    function scheduleSurfaceSnapshotRefresh(delayMs = 60) {
        if (surfaceRefreshTimer) return;
        surfaceRefreshTimer = setTimeout(async () => {
            surfaceRefreshTimer = null;
            if (surfaceRefreshRunning) {
                surfaceRefreshQueued = true;
                return;
            }
            surfaceRefreshRunning = true;
            try {
                await refreshDisplaySnapshot();
            } catch (_) {
            } finally {
                surfaceRefreshRunning = false;
                if (surfaceRefreshQueued) {
                    surfaceRefreshQueued = false;
                    scheduleSurfaceSnapshotRefresh(40);
                }
            }
        }, Math.max(10, Number(delayMs) || 60));
        if (typeof surfaceRefreshTimer.unref === 'function') surfaceRefreshTimer.unref();
    }

    function waitForSnapshotBump(prevVer, timeoutMs = 260) {
        if (state.snapshotVersion > prevVer) return Promise.resolve(true);
        return new Promise((resolve) => {
            let done = false;
            const cleanup = () => {
                if (done) return;
                done = true;
                clearTimeout(t);
                snapshotWaiters.delete(onBump);
            };
            const onBump = () => {
                if (state.snapshotVersion > prevVer) {
                    cleanup();
                    resolve(true);
                }
            };
            const t = setTimeout(() => {
                cleanup();
                resolve(state.snapshotVersion > prevVer);
            }, timeoutMs);
            if (typeof t.unref === 'function') t.unref();
            snapshotWaiters.add(onBump);
        });
    }

    function getActivitySnapshot() {
        const now = Date.now();
        activityState.recentList = activityState.recentList.filter((x) => now - x.endedAt < 1400);
        return {
            seq: activityState.seq,
            active: Array.from(activityState.activeMap.values()),
            recent: activityState.recentList.slice(-4),
        };
    }

    function broadcastActivity() {
        const snapAct = getActivitySnapshot();
        const line = `data: ${JSON.stringify(snapAct)}\n\n`;
        for (const sub of [...activityState.subscribers]) {
            try {
                sub.res.write(line);
            } catch (_) {
                clearInterval(sub.kaTimer);
                activityState.subscribers.delete(sub);
            }
        }
        if (activityState.recentList.length > 0 && !activityState.cleanupTimer) {
            activityState.cleanupTimer = setTimeout(() => {
                activityState.cleanupTimer = null;
                if (getActivitySnapshot().recent.length === 0 && activityState.activeMap.size === 0) {
                    broadcastActivity();
                } else if (activityState.recentList.length > 0) {
                    broadcastActivity();
                }
            }, 1450);
            if (typeof activityState.cleanupTimer.unref === 'function') activityState.cleanupTimer.unref();
        }
    }

    function recordActivity({ kind = 'plugin_hook', stage = '', step = 0, total = 0, name = '플러그인', phase = '' } = {}) {
        const id = ++activityState.nextId;
        const entry = {
            id,
            kind: String(kind || 'plugin_hook'),
            stage: String(stage || ''),
            step: Number(step) || 0,
            total: Number(total) || 0,
            name: String(name || '플러그인'),
            phase: String(phase || ''),
            startedAt: Date.now(),
        };
        activityState.activeMap.set(id, entry);
        activityState.seq += 1;
        broadcastActivity();
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            const removed = activityState.activeMap.get(id);
            activityState.activeMap.delete(id);
            if (removed) {
                activityState.recentList.push({
                    id: removed.id,
                    kind: removed.kind,
                    stage: removed.stage,
                    step: removed.step,
                    total: removed.total,
                    name: removed.name,
                    phase: removed.phase,
                    endedAt: Date.now(),
                });
                if (activityState.recentList.length > 10) activityState.recentList.shift();
            }
            activityState.seq += 1;
            broadcastActivity();
        };
        finish.update = (patch = {}) => {
            if (finished) return;
            const cur = activityState.activeMap.get(id);
            if (!cur) return;
            if (typeof patch.phase === 'string') cur.phase = patch.phase;
            if (typeof patch.name === 'string' && patch.name) cur.name = patch.name;
            activityState.seq += 1;
            broadcastActivity();
        };
        return finish;
    }

    async function runUnifiedBackendLLM(req, callerLabel = 'plugin', customProviders = null) {
        const mode = String((req && req.mode) || 'model');
        let msgs = Array.isArray(req && req.messages) ? req.messages.map((m) => ({ ...m })) : [];

        if (req && req.allowPlugins && customProviders && customProviders.size > 0) {
            const explicitProv = String(req.provider || req.staticModel || '').trim();
            const chosen = (explicitProv && customProviders.get(explicitProv))
                || (!getProfileForMode(mode) ? Array.from(customProviders.values())[0] : null);
            if (chosen && typeof chosen.fn === 'function') {
                const provRes = await chosen.fn({ ...req, messages: msgs, mode });
                if (provRes && (provRes.success || provRes.type === 'success')) {
                    const txt = String(provRes.content ?? provRes.result ?? '');
                    return { type: 'success', result: txt, content: txt, model: chosen.name, finishReason: 'stop' };
                }
                if (provRes && provRes.type === 'fail') {
                    return provRes;
                }
            }
        }

        const profile = getProfileForMode(mode);
        if (!profile) {
            return { type: 'fail', result: '활성화된 모델 프로필이 없습니다.' };
        }

        const runAllowPluginHooks = Boolean(req && req.allowPlugins && llmHookDepth === 0 && pluginAdapter && pluginAdapter.hasEnabledPlugins());
        if (runAllowPluginHooks) {
            llmHookDepth += 1;
            try {
                msgs = await pluginAdapter.runBeforeRequest(msgs, mode);
                const finalMsgs = applyPromptOverride(msgs, profile);
                const res = await callLLMNonStream(profile, finalMsgs, {
                    source: `${callerLabel}:${mode}`,
                    interceptBody: (b, t) => pluginAdapter.runBodyIntercepters(b, t),
                });
                const finalOut = await pluginAdapter.runAfterRequest(res.text, mode);
                return {
                    type: 'success',
                    result: finalOut,
                    content: finalOut,
                    model: res.model,
                    usage: res.usage,
                    finishReason: 'stop',
                };
            } finally {
                llmHookDepth -= 1;
            }
        }

        const finalMsgs = applyPromptOverride(msgs, profile);
        const res = await callLLMNonStream(profile, finalMsgs, { source: `${callerLabel}:${mode}` });
        return {
            type: 'success',
            result: res.text,
            content: res.text,
            model: res.model,
            usage: res.usage,
            finishReason: 'stop',
        };
    }

    const pluginAdapter = createPluginAdapter({
        pluginsPath: PLUGINS_PATH,
        persistDisabled: configPersistDisabled,
        getBackendConfig: () => config,
        saveBackendConfig: () => saveConfig(),
        hostRpc,
        getFallbackSnapshot: () => state.baseSnapshot || state.snapshot,
        runLLM: (req, pluginName, customProviders) => runUnifiedBackendLLM(req, `plugin:${pluginName}`, customProviders),
        onActivity: (info) => recordActivity(info),
        onSurfaceMutated: () => scheduleSurfaceSnapshotRefresh(60),
        onDbMutated: ({ charIndex, chatIndex, charObj, chatObj } = {}) => {
            if (state.baseSnapshot && Number(charIndex) === Number(state.baseSnapshot.charIndex)) {
                const curChatIdx = Number(state.baseSnapshot.chatIndex);
                const targetChat = (chatObj && Number(chatIndex) === curChatIdx)
                    ? chatObj
                    : (charObj && Array.isArray(charObj.chats) ? charObj.chats[curChatIdx] : null);
                if (targetChat && Array.isArray(targetChat.message) && Array.isArray(state.baseSnapshot.messages)) {
                    for (let i = 0; i < state.baseSnapshot.messages.length; i += 1) {
                        const m = state.baseSnapshot.messages[i];
                        if (!m || m.isFirstMessage || Number(m.index) < 0) continue;
                        const src = targetChat.message[Number(m.index)];
                        if (!src) continue;
                        const nextRaw = String(src.data ?? src.content ?? '');
                        if (nextRaw !== String(m.raw || '')) {
                            m.raw = nextRaw;
                            m.html = nextRaw;
                            m.text = nextRaw;
                        }
                    }
                }
            }
            scheduleSurfaceSnapshotRefresh(40);
        },
    });
    activePluginAdapter = pluginAdapter;

    const imageProvider = createImageProvider({
        getBackendConfig: () => config,
        hostRpc,
        createInlay: (data, opts) => pluginAdapter.createInlay(data, opts),
    });

    const ttsProvider = createTtsProvider();

    function resolveTtsLlmProfile() {
        const ttsCfg = normalizeTtsConfig(config.tts);
        if (ttsCfg.llmSource === 'active') {
            return getActiveProfile();
        }
        if (ttsCfg.llmSource === 'aux') {
            return getAuxProfile();
        }
        const tr = config.translator || {};
        if (tr.useActiveProfile) {
            return getActiveProfile();
        }
        const trProf = {
            name: 'TTS Script Director (Translator)',
            providerType: tr.providerType || 'gemini',
            baseUrl: tr.baseUrl || '',
            apiKey: tr.apiKey || '',
            model: tr.model || 'gemini-2.5-flash',
            temperature: 0.15,
            maxTokens: 2048,
        };
        if (!trProf.apiKey && trProf.providerType !== 'openai_compat') {
            return getActiveProfile();
        }
        return trProf;
    }

    const moduleAdapter = createModuleAdapter({
        hostRpc,
        getBackendConfig: () => config,
        getToggleContext: () => {
            const curDirectId = (typeof config.directPresetId === 'string' && config.directPresetId) ? config.directPresetId : 'bundled:leave';
            const p = resolveDirectPreset(curDirectId);
            const snapNow = state.snapshot || {};
            const manualSyntax = (Array.isArray(config.presetToggles) ? config.presetToggles : [])
                .filter((pt) => pt && pt.enabled !== false && pt.syntax && (!pt.parentPresetId || pt.parentPresetId === curDirectId))
                .map((pt) => pt.syntax)
                .join('\n');
            return {
                presetToggleSyntax: [manualSyntax, (p && (p.toggleSyntax || p.customPromptTemplateToggle)) || ''].filter(Boolean).join('\n'),
                presetDefaultVariables: (p && (p.defaultVariables || p.templateDefaultVariables)) || '',
                globalToggleValues: snapNow.globalToggleValues || {},
                localToggleValues: snapNow.localToggleValues || {},
                useLocal: Boolean(snapNow.useLocallySetGlobalVariables),
            };
        },
        runLLM: (req, srcLabel) => runUnifiedBackendLLM(req, srcLabel || 'module', pluginAdapter.getRegisteredProviders()),
        imageProvider,
        evalCbs: evalPresetCbs,
        onTriggerNotice: (ev) => {
            state.lastTriggerEvent = { id: crypto.randomUUID(), at: Date.now(), ...ev };
        },
    });
    activeModuleAdapter = moduleAdapter;

    const THUMB_CACHE_MAX_ITEMS = 96;
    const THUMB_CACHE_MAX_BYTES = 64 * 1024 * 1024;
    const thumbCache = new Map(); // path -> { buf: Buffer, mime: string }
    let thumbCacheBytes = 0;
    const thumbInFlight = new Map(); // path -> Promise<{ buf, mime } | null>
    const charAssetListCache = new Map(); // charIndex -> { at, chaId, list }
    const charMainImageCache = new Map(); // chaId -> path string ('' means none)
    const charMainImageInFlight = new Map(); // chaId -> Promise<string>
    const customThumbMemStore = new Map(); // file -> { buf: Buffer, mime: string }

    function publicBotThumbs() {
        const out = {};
        const src = (config.botThumbs && typeof config.botThumbs === 'object') ? config.botThumbs : {};
        for (const [k, v] of Object.entries(src)) {
            if (!v || typeof v !== 'object') continue;
            if (v.source === 'asset' || v.source === 'custom') {
                out[k] = { source: v.source, v: Number(v.updatedAt || 0) };
            }
        }
        return out;
    }

    function extractCharacterImageAssets(ch, charIndex) {
        if (!ch || typeof ch !== 'object') return null;
        const assets = [];
        const seenPaths = new Set();
        const mediaRx = /(?:^|\.)(?:mp3|wav|ogg|mp4|webm|m4a|flac)$/i;
        const pushAsset = (rawName, rawPath, kind, rawExt = '') => {
            if (assets.length >= 300) return;
            const p = String(rawPath || '').trim();
            if (!p || seenPaths.has(p)) return;
            const nm = String(rawName || '').trim();
            const ex = String(rawExt || '').trim();
            if (kind === 'additional' && (mediaRx.test(ex) || mediaRx.test(nm) || mediaRx.test(p))) return;
            seenPaths.add(p);
            assets.push({ name: nm || p, path: p, kind });
        };
        if (typeof ch.image === 'string' && ch.image.trim()) {
            pushAsset('기본 아이콘', ch.image, 'main');
        }
        if (Array.isArray(ch.emotionImages)) {
            for (const e of ch.emotionImages) {
                if (Array.isArray(e)) pushAsset(e[0], e[1], 'emotion', e[2]);
            }
        }
        if (Array.isArray(ch.additionalAssets)) {
            for (const item of ch.additionalAssets) {
                if (Array.isArray(item)) pushAsset(item[0], item[1], 'additional', item[2]);
            }
        }
        return {
            chaId: String(ch.chaId || charIndex),
            name: String(ch.name || ''),
            image: typeof ch.image === 'string' ? ch.image : '',
            assets,
        };
    }

    async function readPcImageCached(assetPath) {
        const key = String(assetPath || '').trim();
        if (!key) return null;
        if (thumbCache.has(key)) {
            const hit = thumbCache.get(key);
            thumbCache.delete(key);
            thumbCache.set(key, hit);
            return hit;
        }
        if (thumbInFlight.has(key)) return thumbInFlight.get(key);
        const p = (async () => {
            try {
                if (!hostRpc.isConnected()) return null;
                const r = await hostRpc.invoke('asset.readImage', [key], 10000);
                if (!r || typeof r !== 'object' || typeof r.__b64 !== 'string') return null;
                const mime = String(r.mime || '').toLowerCase();
                if (!mime.startsWith('image/')) return null;
                const buf = Buffer.from(r.__b64, 'base64');
                if (!buf.length || buf.length > THUMB_CACHE_MAX_BYTES) return null;
                while (thumbCache.size >= THUMB_CACHE_MAX_ITEMS || thumbCacheBytes + buf.length > THUMB_CACHE_MAX_BYTES) {
                    const oldestKey = thumbCache.keys().next().value;
                    if (!oldestKey) break;
                    const oldestVal = thumbCache.get(oldestKey);
                    thumbCacheBytes = Math.max(0, thumbCacheBytes - (oldestVal && oldestVal.buf ? oldestVal.buf.length : 0));
                    thumbCache.delete(oldestKey);
                }
                const entry = { buf, mime };
                thumbCache.set(key, entry);
                thumbCacheBytes += buf.length;
                return entry;
            } catch (_) {
                return null;
            } finally {
                thumbInFlight.delete(key);
            }
        })();
        thumbInFlight.set(key, p);
        return p;
    }

    async function resolveCharMainImagePath(ch) {
        const chaId = ch && ch.chaId !== undefined ? String(ch.chaId) : '';
        if (!chaId) return '';
        if (charMainImageCache.has(chaId)) return charMainImageCache.get(chaId);
        if (charMainImageInFlight.has(chaId)) return charMainImageInFlight.get(chaId);
        const p = (async () => {
            try {
                if (!hostRpc.isConnected()) return '';
                let imgPath = '';
                try {
                    const resData = await hostRpc.invoke('db.getCharacterImageAssets', [ch.index], 15000);
                    imgPath = (resData && typeof resData.image === 'string') ? resData.image : '';
                } catch (err) {
                    if (err && /Unsupported host RPC op/i.test(String(err.message || ''))) {
                        const fullChar = await hostRpc.invoke('db.getCharacter', [ch.index], 20000);
                        imgPath = (fullChar && typeof fullChar.image === 'string') ? fullChar.image : '';
                    } else {
                        return '';
                    }
                }
                charMainImageCache.set(chaId, imgPath);
                return imgPath;
            } catch (_) {
                return '';
            } finally {
                charMainImageInFlight.delete(chaId);
            }
        })();
        charMainImageInFlight.set(chaId, p);
        return p;
    }

    function requireAssetAuth(req, res) {
        const headerOk = safeTokenEqual(getRequestToken(req), resolvedToken);
        const cookieOk = safeTokenEqual(parseCookie(req, 'rs_asset_sid'), assetCookieVal);
        if (!headerOk && !cookieOk) {
            sendJson(res, 401, { error: 'Unauthorized: Invalid token' }, req);
            return false;
        }
        return true;
    }

    function deleteCustomThumbFile(file) {
        if (!file || !/^[a-f0-9]{24}\.(png|jpg|webp|gif)$/.test(file)) return;
        if (configPersistDisabled) {
            customThumbMemStore.delete(file);
            return;
        }
        try { fs.rmSync(path.join(THUMBS_DIR, file), { force: true }); } catch (_) {}
    }

    const server = http.createServer(async (req, res) => {
        const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = urlObj.pathname;

        if (req.method === 'OPTIONS') {
            res.writeHead(204, corsHeaders(req));
            res.end();
            return;
        }

        // 1) Web UI
        if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderWebApp());
            return;
        }

        // 1b) Bot Thumbnail & Character Asset Endpoints (before 32-hex /api/asset/:id)
        if (req.method === 'GET' && pathname.startsWith('/api/asset/bot-thumb/')) {
            if (!requireAssetAuth(req, res)) return;
            let chaId = '';
            try { chaId = decodeURIComponent(pathname.slice('/api/asset/bot-thumb/'.length)); } catch (_) {
                return sendJson(res, 400, { error: 'Invalid character id' }, req);
            }
            if (!chaId || chaId.length > 200) {
                return sendJson(res, 404, { error: 'Thumbnail not found' }, req);
            }
            const override = (config.botThumbs && typeof config.botThumbs === 'object') ? config.botThumbs[chaId] : null;
            let img = null;
            if (override && override.source === 'custom' && /^[a-f0-9]{24}\.(png|jpg|webp|gif)$/.test(String(override.file || ''))) {
                if (configPersistDisabled) {
                    img = customThumbMemStore.get(override.file) || null;
                } else {
                    try {
                        const buf = fs.readFileSync(path.join(THUMBS_DIR, override.file));
                        const ext = override.file.split('.').pop();
                        const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
                        if (buf.length) img = { buf, mime };
                    } catch (_) { img = null; }
                }
            } else if (override && override.source === 'asset' && override.path) {
                img = await readPcImageCached(override.path);
            } else {
                const chars = (state.catalog && Array.isArray(state.catalog.characters)) ? state.catalog.characters : [];
                const ch = chars.find((c) => c && String(c.chaId) === chaId);
                let imgPath = (ch && typeof ch.image === 'string') ? ch.image : '';
                if (!imgPath && ch && ch.image === undefined && hostRpc.isConnected()) {
                    imgPath = await resolveCharMainImagePath(ch);
                }
                if (imgPath) {
                    img = await readPcImageCached(imgPath);
                }
            }
            if (!img || !img.buf || !img.buf.length) {
                return sendJson(res, 404, { error: 'Thumbnail not found' }, req);
            }
            res.writeHead(200, {
                'Content-Type': img.mime,
                'Content-Length': String(img.buf.length),
                'Cache-Control': 'private, max-age=604800',
                'X-Content-Type-Options': 'nosniff',
            });
            res.end(img.buf);
            return;
        }

        const charAssetMatch = req.method === 'GET' && pathname.match(/^\/api\/asset\/char-asset\/(\d+)\/(\d+)$/);
        if (charAssetMatch) {
            if (!requireAssetAuth(req, res)) return;
            const cIdx = Number(charAssetMatch[1]);
            const aIdx = Number(charAssetMatch[2]);
            const cached = charAssetListCache.get(cIdx);
            if (!cached || (Date.now() - cached.at > 10 * 60 * 1000)) {
                return sendJson(res, 404, { error: 'Asset list expired or not loaded' }, req);
            }
            const item = cached.list[aIdx];
            if (!item || !item.path) {
                return sendJson(res, 404, { error: 'Asset not found' }, req);
            }
            const img = await readPcImageCached(item.path);
            if (!img || !img.buf || !img.buf.length) {
                return sendJson(res, 404, { error: 'Asset read failed' }, req);
            }
            res.writeHead(200, {
                'Content-Type': img.mime,
                'Content-Length': String(img.buf.length),
                'Cache-Control': 'private, max-age=3600',
                'X-Content-Type-Options': 'nosniff',
            });
            res.end(img.buf);
            return;
        }

        // 1c) Cached Binary Image Asset Endpoint (avoids multi-MB base64 repeats in /api/state)
        const assetMatch = req.method === 'GET' && pathname.match(/^\/api\/asset\/([a-f0-9]{32})$/);
        if (assetMatch) {
            if (!requireAssetAuth(req, res)) return;
            const entry = assetStore.get(assetMatch[1]);
            if (!entry) {
                return sendJson(res, 404, { error: 'Asset not found' }, req);
            }
            res.writeHead(200, {
                'Content-Type': entry.mime,
                'Content-Length': String(entry.buf.length),
                'Cache-Control': 'private, max-age=86400, immutable',
                'X-Content-Type-Options': 'nosniff',
            });
            res.end(entry.buf);
            return;
        }

        // 2) OpenAI-Compatible Local Proxy Router (for PC RisuAI Reverse Proxy)
        if (pathname === '/v1/models' && req.method === 'GET') {
            if (!requireProxyAuth(req, res)) return;
            const active = getActiveProfile();
            return sendJson(res, 200, {
                object: 'list',
                data: [
                    { id: 'risustand-router', object: 'model', owned_by: 'risustand' },
                    ...(active ? [{ id: active.model, object: 'model', owned_by: active.providerType }] : []),
                ],
            }, req);
        }

        if (pathname === '/v1/chat/completions' && req.method === 'POST') {
            if (!requireProxyAuth(req, res)) return;
            return handleOpenAIProxy(req, res);
        }

        // 3) PC Bridge Polling
        if (pathname === '/api/pc/poll' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                state.pcConnected = true;
                state.pcLastSeen = Date.now();
                state.bridgeVersion = body.bridgeVersion || '1.0.0';
                state.pluginVersion = typeof body.pluginVersion === 'string' ? body.pluginVersion.slice(0, 32) : null;
                state.generating = Boolean(body.generating);
                if (state.nativeRequestDispatched && !state.generating) {
                    state.nativeRequestPendingSince = 0;
                    state.nativeRequestDispatched = false;
                }
                if (body.catalog) {
                    state.catalog = body.catalog;
                    state.catalogVersion += 1;
                }
                if (body.snapshot) {
                    state.baseSnapshot = externalizeSnapshotAssets(body.snapshot);
                    await rebuildDisplayedSnapshot(state.baseSnapshot, pluginAdapter);
                    state.snapshotVersion += 1;
                    notifySnapshotWaiters();
                }
                if (body.triggerEvent) state.lastTriggerEvent = body.triggerEvent;
                const needFullSync = !state.catalog || !Array.isArray(state.catalog.characters) || state.catalog.characters.length === 0 || !state.snapshot || typeof state.snapshot.charIndex !== 'number' || state.snapshot.charIndex < 0;

                pruneCommandQueue();
                const inlineRpcCalls = (!rpcState.waiters.length && rpcState.queue.length)
                    ? rpcState.queue.splice(0, 25)
                    : [];
                if (body.supportsBatchCommands === true) {
                    const commands = [];
                    while (state.commandQueue.length && commands.length < 10) {
                        const cmd = state.commandQueue.shift();
                        commands.push(cmd);
                        if (cmd.type === 'send_chat' || cmd.type === 'reroll_message') {
                            state.nativeRequestDispatched = true;
                            if (!state.nativeRequestPendingSince) state.nativeRequestPendingSince = Date.now();
                            break;
                        }
                    }
                    return sendJson(res, 200, { ok: true, command: commands[0] || null, commands, rpcCalls: inlineRpcCalls, supportsHostRpc: true, needFullSync, relayVersion: RELAY_VERSION }, req);
                }
                const nextCmd = state.commandQueue.shift() || null;
                if (nextCmd && (nextCmd.type === 'send_chat' || nextCmd.type === 'reroll_message')) {
                    state.nativeRequestDispatched = true;
                    if (!state.nativeRequestPendingSince) state.nativeRequestPendingSince = Date.now();
                }
                return sendJson(res, 200, { ok: true, command: nextCmd, rpcCalls: inlineRpcCalls, supportsHostRpc: true, needFullSync, relayVersion: RELAY_VERSION }, req);
            } catch (e) {
                return sendJson(res, 400, { error: e.message }, req);
            }
        }

        // 3b) Fast PC Host RPC Wait / Result Channels (for direct pluginStorage & DB access)
        if (pathname === '/api/pc/rpc-wait' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                state.pcConnected = true;
                state.pcLastSeen = Date.now();
                rpcState.rpcClientActive = true;
                if (!rpcState.pcSyncedOnce) {
                    rpcState.pcSyncedOnce = true;
                    setTimeout(() => {
                        void pluginAdapter.syncPcPlugins()
                            .then(() => scheduleSurfaceSnapshotRefresh(80))
                            .catch(() => {});
                    }, 20);
                }
                if (rpcState.queue.length) {
                    return sendJson(res, 200, { ok: true, calls: rpcState.queue.splice(0, 25) }, req);
                }
                const timeoutMs = Math.max(500, Math.min(15000, Number(body.timeoutMs) || 12000));
                const waiter = {
                    done: false,
                    timer: null,
                    respond: (calls) => sendJson(res, 200, { ok: true, calls: calls || [] }, req),
                };
                waiter.timer = setTimeout(() => {
                    if (waiter.done) return;
                    waiter.done = true;
                    const idx = rpcState.waiters.indexOf(waiter);
                    if (idx >= 0) rpcState.waiters.splice(idx, 1);
                    try { waiter.respond([]); } catch (_) {}
                }, timeoutMs);
                req.on('close', () => {
                    if (waiter.done) return;
                    waiter.done = true;
                    clearTimeout(waiter.timer);
                    const idx = rpcState.waiters.indexOf(waiter);
                    if (idx >= 0) rpcState.waiters.splice(idx, 1);
                });
                rpcState.waiters.push(waiter);
                return;
            } catch (e) {
                return sendJson(res, 400, { error: e.message }, req);
            }
        }

        if (pathname === '/api/pc/rpc-result' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req, 256 * 1024 * 1024)) || '{}');
                rpcState.rpcClientActive = true;
                state.pcConnected = true;
                state.pcLastSeen = Date.now();
                const results = Array.isArray(body.results) ? body.results : [];
                for (const item of results) {
                    if (!item || !item.id || !rpcState.pending.has(item.id)) continue;
                    const p = rpcState.pending.get(item.id);
                    rpcState.pending.delete(item.id);
                    clearTimeout(p.timer);
                    if (item.ok) p.resolve(item.value);
                    else p.reject(new Error(item.error || 'PC Host RPC error'));
                }
                return sendJson(res, 200, { ok: true }, req);
            } catch (e) {
                return sendJson(res, 400, { error: e.message }, req);
            }
        }

        // Remote update (token-protected; downloads only from the official GitHub repository)
        if (pathname === '/api/update/status' && req.method === 'GET') {
            if (!requireAuth(req, res)) return;
            return sendJson(res, 200, publicUpdateState(), req);
        }
        if (pathname === '/api/update/check' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            if (!updater) return sendJson(res, 501, { error: '업데이터가 설치되어 있지 않습니다.' }, req);
            if (updateBusy()) return sendJson(res, 200, publicUpdateState(), req);
            try {
                await checkForUpdate();
                if (updateState.phase === 'error') updateState.phase = 'idle';
                return sendJson(res, 200, publicUpdateState(), req);
            } catch (e) {
                return sendJson(res, 502, { error: e.message }, req);
            }
        }
        if (pathname === '/api/update/apply' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            if (!updater) return sendJson(res, 501, { error: '업데이터가 설치되어 있지 않습니다.' }, req);
            if (updateBusy()) return sendJson(res, 409, { error: '업데이트가 이미 진행 중입니다.' }, req);
            updateState.phase = 'checking';
            updateState.message = UPDATE_PHASE_LABEL.checking;
            runRemoteUpdate();
            return sendJson(res, 202, publicUpdateState(), req);
        }

        // 3c) Live Runtime Activity SSE Stream (real-time module & plugin indicator)
        if (pathname === '/api/activity/stream' && req.method === 'GET') {
            if (!requireAuth(req, res)) return;
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                ...corsHeaders(req),
            });
            try { res.write(`data: ${JSON.stringify(getActivitySnapshot())}\n\n`); } catch (_) {}
            const kaTimer = setInterval(() => {
                try { res.write(': keepalive\n\n'); } catch (_) {}
            }, 20000);
            if (typeof kaTimer.unref === 'function') kaTimer.unref();
            const sub = { res, kaTimer };
            activityState.subscribers.add(sub);
            req.on('close', () => {
                clearInterval(kaTimer);
                activityState.subscribers.delete(sub);
            });
            return;
        }

        // 4) Client State
        if (pathname === '/api/state' && req.method === 'GET') {
            if (!requireAuth(req, res)) return;
            const connected = Date.now() - state.pcLastSeen < 12000;
            state.pcConnected = connected;
            const nativePending = Boolean(
                state.nativeRequestPendingSince &&
                connected &&
                (Date.now() - state.nativeRequestPendingSince < 180000)
            );
            const parseRev = (raw) => {
                if (raw === null || raw === '') return null;
                const n = Number(raw);
                return Number.isInteger(n) && n >= 0 ? n : null;
            };
            const reqCv = parseRev(urlObj.searchParams.get('cv'));
            const reqSv = parseRev(urlObj.searchParams.get('sv'));
            const payload = {
                pcConnected: connected,
                bridgeVersion: state.bridgeVersion,
                relayVersion: RELAY_VERSION,
                pluginVersion: state.pluginVersion || null,
                updateAvailable: Boolean(updateState.info && updateState.info.available),
                generating: Boolean(state.generating || nativePending),
                directGenerating: state.directGenerating,
                lastDirectError: state.lastDirectError,
                lastTriggerEvent: state.lastTriggerEvent,
                catalogVersion: state.catalogVersion,
                snapshotVersion: state.snapshotVersion,
                runtimeActivity: getActivitySnapshot(),
                pluginFloatingUi: pluginAdapter.getFloatingUiState(),
                botThumbs: publicBotThumbs(),
            };
            if (reqCv === null || reqCv !== state.catalogVersion) payload.catalog = state.catalog;
            if (reqSv === null || reqSv !== state.snapshotVersion) {
                if (state.snapshot && state.snapshot.charContext && Object.prototype.hasOwnProperty.call(state.snapshot.charContext, 'loreEntries')) {
                    const { loreEntries: _omitLoreEntries, ...lightCtx } = state.snapshot.charContext;
                    payload.snapshot = { ...state.snapshot, charContext: lightCtx };
                } else {
                    payload.snapshot = state.snapshot;
                }
            }
            return sendJson(res, 200, payload, req, {
                'Set-Cookie': `rs_asset_sid=${assetCookieVal}; Path=/api/asset; HttpOnly; SameSite=Strict`,
            });
        }

        if (pathname === '/api/bot-thumb/assets' && req.method === 'GET') {
            if (!requireAuth(req, res)) return;
            const rawIdx = urlObj.searchParams.get('charIndex');
            const charIndex = (rawIdx !== null && rawIdx !== '') ? Number(rawIdx) : -1;
            if (!Number.isInteger(charIndex) || charIndex < 0) {
                return sendJson(res, 400, { error: 'Invalid charIndex' }, req);
            }
            if (!hostRpc.isConnected()) {
                return sendJson(res, 503, { error: 'PC RisuAI 브릿지가 연결되어 있지 않습니다.' }, req);
            }
            try {
                let resData = null;
                try {
                    resData = await hostRpc.invoke('db.getCharacterImageAssets', [charIndex], 15000);
                } catch (err) {
                    if (err && /Unsupported host RPC op/i.test(String(err.message || ''))) {
                        const ch = await hostRpc.invoke('db.getCharacter', [charIndex], 20000);
                        resData = extractCharacterImageAssets(ch, charIndex);
                    } else {
                        throw err;
                    }
                }
                if (!resData || !Array.isArray(resData.assets)) {
                    return sendJson(res, 404, { error: '캐릭터 정보를 찾을 수 없습니다.' }, req);
                }
                const chaId = String(resData.chaId || charIndex);
                charAssetListCache.set(charIndex, { at: Date.now(), chaId, list: resData.assets });
                return sendJson(res, 200, {
                    chaId,
                    assets: resData.assets.map((a, i) => ({
                        name: a.name,
                        kind: a.kind,
                        url: `/api/asset/char-asset/${charIndex}/${i}`,
                    })),
                }, req);
            } catch (e) {
                return sendJson(res, 502, { error: e && e.message ? e.message : String(e) }, req);
            }
        }

        if (pathname === '/api/bot-thumb' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req, 10 * 1024 * 1024)) || '{}');
                const chaId = typeof body.chaId === 'string' ? body.chaId.trim() : '';
                if (!chaId || chaId.length > 200) {
                    return sendJson(res, 400, { error: '유효한 캐릭터 ID(chaId)가 필요합니다.' }, req);
                }
                const source = String(body.source || '');
                if (!config.botThumbs || typeof config.botThumbs !== 'object') config.botThumbs = {};
                const prev = config.botThumbs[chaId];
                if (source === 'asset') {
                    const cIdx = Number(body.charIndex);
                    const aIdx = Number(body.assetIndex);
                    const cached = Number.isInteger(cIdx) ? charAssetListCache.get(cIdx) : null;
                    if (!cached || (Date.now() - cached.at > 10 * 60 * 1000) || cached.chaId !== chaId || !Number.isInteger(aIdx) || aIdx < 0 || aIdx >= cached.list.length) {
                        return sendJson(res, 400, { error: '에셋 목록이 만료되었거나 올바르지 않습니다. 다시 열어 주세요.' }, req);
                    }
                    const chosen = cached.list[aIdx];
                    if (prev && prev.source === 'custom' && prev.file) deleteCustomThumbFile(prev.file);
                    config.botThumbs[chaId] = {
                        source: 'asset',
                        path: String(chosen.path || '').slice(0, 500),
                        updatedAt: Date.now(),
                    };
                } else if (source === 'custom') {
                    const m = String(body.dataUri || '').match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i);
                    if (!m) {
                        return sendJson(res, 400, { error: '지원하지 않는 이미지 형식입니다. (PNG/JPEG/WebP/GIF)' }, req);
                    }
                    const rawExt = m[1].toLowerCase();
                    const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
                    const mime = `image/${rawExt}`;
                    const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
                    if (!buf.length || buf.length > 6 * 1024 * 1024) {
                        return sendJson(res, 400, { error: '이미지 크기는 6MB 이하여야 합니다.' }, req);
                    }
                    const hash = crypto.createHash('sha256').update(chaId).digest('hex').slice(0, 24);
                    const file = `${hash}.${ext}`;
                    if (prev && prev.source === 'custom' && prev.file && prev.file !== file) {
                        deleteCustomThumbFile(prev.file);
                    }
                    if (configPersistDisabled) {
                        customThumbMemStore.set(file, { buf, mime });
                    } else {
                        fs.mkdirSync(THUMBS_DIR, { recursive: true });
                        fs.writeFileSync(path.join(THUMBS_DIR, file), buf);
                    }
                    config.botThumbs[chaId] = {
                        source: 'custom',
                        file,
                        updatedAt: Date.now(),
                    };
                } else if (source === 'default') {
                    if (prev && prev.source === 'custom' && prev.file) deleteCustomThumbFile(prev.file);
                    delete config.botThumbs[chaId];
                } else {
                    return sendJson(res, 400, { error: 'Invalid source' }, req);
                }
                saveConfig();
                return sendJson(res, 200, { ok: true, botThumbs: publicBotThumbs() }, req);
            } catch (e) {
                return sendJson(res, 400, { error: e && e.message ? e.message : String(e) }, req);
            }
        }

        // 5) Generic Bridge Command
        if (pathname === '/api/command' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                if (!body.type) return sendJson(res, 400, { error: 'Missing command type' }, req);
                if (body.type === 'set_custom_toggle' && body.payload && typeof body.payload === 'object') {
                    const p = body.payload;
                    const key = String(p.key || '').trim();
                    const scope = p.scope || 'global';
                    if (key) {
                        const fullKey = key.startsWith('toggle_') ? key : `toggle_${key}`;
                        const strVal = (p.value === null || p.value === undefined) ? '' : String(p.value);
                        if (scope !== 'local') {
                            if (!config.remoteToggleValues || typeof config.remoteToggleValues !== 'object') {
                                config.remoteToggleValues = {};
                            }
                            if (strVal === '') delete config.remoteToggleValues[fullKey];
                            else config.remoteToggleValues[fullKey] = strVal;
                            saveConfig();
                            for (const targetSnap of [state.snapshot, state.baseSnapshot]) {
                                if (!targetSnap) continue;
                                if (!targetSnap.globalToggleValues || typeof targetSnap.globalToggleValues !== 'object') {
                                    targetSnap.globalToggleValues = {};
                                }
                                if (strVal === '') delete targetSnap.globalToggleValues[fullKey];
                                else targetSnap.globalToggleValues[fullKey] = strVal;
                            }
                        } else {
                            for (const targetSnap of [state.snapshot, state.baseSnapshot]) {
                                if (targetSnap && Number(p.charIndex) === targetSnap.charIndex && Number(p.chatIndex) === targetSnap.chatIndex) {
                                    targetSnap.useLocallySetGlobalVariables = true;
                                    if (!targetSnap.localToggleValues || typeof targetSnap.localToggleValues !== 'object') {
                                        targetSnap.localToggleValues = {};
                                    }
                                    if (strVal === '') delete targetSnap.localToggleValues[fullKey];
                                    else targetSnap.localToggleValues[fullKey] = strVal;
                                }
                            }
                        }
                        if (state.snapshot) state.snapshotVersion += 1;
                    }
                }
                if (body.type === 'set_local_toggle_mode' && body.payload && typeof body.payload === 'object') {
                    const p = body.payload;
                    const nextEnabled = Boolean(p.enabled);
                    for (const targetSnap of [state.snapshot, state.baseSnapshot]) {
                        if (targetSnap && Number(p.charIndex) === targetSnap.charIndex && Number(p.chatIndex) === targetSnap.chatIndex) {
                            targetSnap.useLocallySetGlobalVariables = nextEnabled;
                        }
                    }
                    if (state.snapshot && Number(p.charIndex) === state.snapshot.charIndex && Number(p.chatIndex) === state.snapshot.chatIndex) {
                        state.snapshotVersion += 1;
                    }
                }
                if (body.type === 'set_author_note' && body.payload && typeof body.payload === 'object') {
                    const p = body.payload;
                    for (const targetSnap of [state.snapshot, state.baseSnapshot]) {
                        if (targetSnap && Number(p.charIndex) === targetSnap.charIndex && Number(p.chatIndex) === targetSnap.chatIndex) {
                            if (!targetSnap.charContext || typeof targetSnap.charContext !== 'object') {
                                targetSnap.charContext = { name: targetSnap.charName || 'Character' };
                            }
                            targetSnap.charContext.note = String(p.note ?? '');
                        }
                    }
                    if (state.snapshot && Number(p.charIndex) === state.snapshot.charIndex && Number(p.chatIndex) === state.snapshot.chatIndex) {
                        state.snapshotVersion += 1;
                    }
                }
                if (body.type === 'set_char_global_note' && body.payload && typeof body.payload === 'object') {
                    const p = body.payload;
                    for (const targetSnap of [state.snapshot, state.baseSnapshot]) {
                        if (targetSnap && Number(p.charIndex) === targetSnap.charIndex) {
                            if (!targetSnap.charContext || typeof targetSnap.charContext !== 'object') {
                                targetSnap.charContext = { name: targetSnap.charName || 'Character' };
                            }
                            targetSnap.charContext.replaceGlobalNote = String(p.replaceGlobalNote ?? '');
                        }
                    }
                    if (state.snapshot && Number(p.charIndex) === state.snapshot.charIndex) {
                        state.snapshotVersion += 1;
                    }
                }
                if (body.type === 'edit_message' && body.payload && typeof body.payload === 'object') {
                    const p = body.payload;
                    for (const targetSnap of [state.snapshot, state.baseSnapshot]) {
                        if (targetSnap && Number(p.charIndex) === targetSnap.charIndex && Number(p.chatIndex) === targetSnap.chatIndex && Array.isArray(targetSnap.messages)) {
                            const hit = targetSnap.messages.find((m) => m && m.index === Number(p.msgIndex));
                            if (hit) hit.raw = String(p.text ?? '');
                        }
                    }
                    if (state.snapshot && Number(p.charIndex) === state.snapshot.charIndex && Number(p.chatIndex) === state.snapshot.chatIndex) {
                        state.snapshotVersion += 1;
                    }
                }
                queueCommand(body.type, body.payload || {});
                return sendJson(res, 200, { ok: true }, req);
            } catch (e) {
                return sendJson(res, 400, { error: e.message }, req);
            }
        }

        // 6) Smart Chat Send (Native RisuAI for PC-active bot, Direct Router for other bots)
        if (pathname === '/api/chat/send' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const text = String(body.text ?? '').trim();
                const charIndex = Number(body.charIndex);
                const chatIndex = Number(body.chatIndex);

                const hasRelayProfile = Boolean(getActiveProfile());
                const hasBackendPlugins = Boolean(pluginAdapter && pluginAdapter.hasEnabledPlugins());
                const forceDirectRouter = (config.remoteDirectOnly !== false && hasRelayProfile) || hasBackendPlugins;

                if (!forceDirectRouter && state.snapshot && state.snapshot.isPcActive && charIndex === state.snapshot.charIndex) {
                    state.nativeRequestPendingSince = Date.now();
                    state.nativeRequestDispatched = false;
                    queueCommand('send_chat', { charIndex, chatIndex, text });
                    return sendJson(res, 200, { ok: true, mode: 'native_risu' }, req);
                }

                if (!text && (!state.snapshot || !Array.isArray(state.snapshot.messages) || !state.snapshot.messages.length)) {
                    return sendJson(res, 400, { error: '보낼 메시지를 입력해 주세요.' }, req);
                }
                if (state.directGenerating) {
                    return sendJson(res, 409, { error: '이미 응답을 생성 중입니다.' }, req);
                }
                if (!hasRelayProfile) {
                    return sendJson(res, 400, { error: '원격 직접 라우팅(백엔드 플러그인 모드)을 사용하려면 [모델/번역] 탭에서 활성 모델 프로필을 먼저 설정해야 합니다.' }, req);
                }
                if (!state.snapshot || state.snapshot.charIndex !== charIndex || state.snapshot.chatIndex !== chatIndex) {
                    return sendJson(res, 409, { error: '채팅방 동기화가 완료되지 않았습니다. 잠시 후 다시 시도해 주세요.' }, req);
                }

                state.lastDirectError = null;
                const snapView = {
                    charIndex: state.snapshot.charIndex,
                    charName: state.snapshot.charName,
                    fmIndex: state.snapshot.fmIndex,
                    totalMessages: state.snapshot.totalMessages,
                    charContext: state.snapshot.charContext ? { ...state.snapshot.charContext } : null,
                    messages: Array.isArray(state.snapshot.messages) ? state.snapshot.messages.slice() : [],
                    customToggleBlocks: Array.isArray(state.snapshot.customToggleBlocks) ? state.snapshot.customToggleBlocks.slice() : [],
                    useLocallySetGlobalVariables: Boolean(state.snapshot.useLocallySetGlobalVariables),
                    globalToggleValues: state.snapshot.globalToggleValues ? { ...state.snapshot.globalToggleValues } : {},
                    localToggleValues: state.snapshot.localToggleValues ? { ...state.snapshot.localToggleValues } : {},
                    chatVariables: state.snapshot.chatVariables ? { ...state.snapshot.chatVariables } : {},
                };

                // Non-PC-active character: execute via Relay Router & persist back to RisuAI DB
                runDirectRemoteChat(charIndex, chatIndex, text, snapView).catch((err) => {
                    console.error('[DirectChat Error]', err.message);
                    state.lastDirectError = { message: err && err.message ? err.message : String(err), at: Date.now() };
                });
                return sendJson(res, 200, { ok: true, mode: 'direct_router' }, req);
            } catch (e) {
                return sendJson(res, 500, { error: e.message }, req);
            }
        }

        // 6b) Smart Chat Reroll (Native RisuAI for PC-active bot, Direct Router for other bots)
        if (pathname === '/api/chat/reroll' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const charIndex = Number(body.charIndex);
                const chatIndex = Number(body.chatIndex);
                const msgIndex = Number(body.msgIndex);
                if (Number.isNaN(charIndex) || Number.isNaN(chatIndex) || Number.isNaN(msgIndex) || msgIndex < 0) {
                    return sendJson(res, 400, { error: 'Invalid reroll parameters' }, req);
                }

                const hasRelayProfile = Boolean(getActiveProfile());
                const hasBackendPlugins = Boolean(pluginAdapter && pluginAdapter.hasEnabledPlugins());
                const forceDirectRouter = (config.remoteDirectOnly !== false && hasRelayProfile) || hasBackendPlugins;

                if (!forceDirectRouter && state.snapshot && state.snapshot.isPcActive && charIndex === state.snapshot.charIndex) {
                    state.nativeRequestPendingSince = Date.now();
                    state.nativeRequestDispatched = false;
                    queueCommand('reroll_message', { charIndex, chatIndex, msgIndex });
                    return sendJson(res, 200, { ok: true, mode: 'native_risu' }, req);
                }

                if (state.directGenerating) {
                    return sendJson(res, 409, { error: '이미 응답을 생성 중입니다.' }, req);
                }
                if (!hasRelayProfile) {
                    return sendJson(res, 400, { error: '원격 직접 라우팅(백엔드 플러그인 모드)을 사용하려면 [모델/번역] 탭에서 활성 모델 프로필을 먼저 설정해야 합니다.' }, req);
                }
                if (!state.snapshot || state.snapshot.charIndex !== charIndex || state.snapshot.chatIndex !== chatIndex) {
                    return sendJson(res, 409, { error: '채팅방 동기화가 완료되지 않았습니다. 잠시 후 다시 시도해 주세요.' }, req);
                }

                state.lastDirectError = null;
                const snapView = {
                    charIndex: state.snapshot.charIndex,
                    charName: state.snapshot.charName,
                    fmIndex: state.snapshot.fmIndex,
                    totalMessages: state.snapshot.totalMessages,
                    charContext: state.snapshot.charContext ? { ...state.snapshot.charContext } : null,
                    messages: Array.isArray(state.snapshot.messages) ? state.snapshot.messages.slice() : [],
                    customToggleBlocks: Array.isArray(state.snapshot.customToggleBlocks) ? state.snapshot.customToggleBlocks.slice() : [],
                    useLocallySetGlobalVariables: Boolean(state.snapshot.useLocallySetGlobalVariables),
                    globalToggleValues: state.snapshot.globalToggleValues ? { ...state.snapshot.globalToggleValues } : {},
                    localToggleValues: state.snapshot.localToggleValues ? { ...state.snapshot.localToggleValues } : {},
                    chatVariables: state.snapshot.chatVariables ? { ...state.snapshot.chatVariables } : {},
                };

                runDirectRemoteReroll(charIndex, chatIndex, msgIndex, snapView).catch((err) => {
                    console.error('[DirectReroll Error]', err.message);
                    state.lastDirectError = { message: err && err.message ? err.message : String(err), at: Date.now() };
                });
                return sendJson(res, 200, { ok: true, mode: 'direct_router' }, req);
            } catch (e) {
                return sendJson(res, 500, { error: e.message }, req);
            }
        }

        // 7) Built-in Translator
        if (pathname === '/api/translate' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const translated = await translateText(body.text || '', body.direction || 'to_target');
                return sendJson(res, 200, { ok: true, translated }, req);
            } catch (e) {
                return sendJson(res, 500, { error: e.message }, req);
            }
        }

        // 7b) Multi-Speaker TTS Script Analysis, Synthesis & Connection Test
        if (pathname === '/api/tts/analyze' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const effectiveTtsCfg = normalizeTtsConfig({
                    ...config.tts,
                    ...(body.parseMode ? { parseMode: body.parseMode } : {}),
                });
                const result = await analyzeTtsSegments({
                    text: body.text || '',
                    html: body.html || '',
                    role: body.role || 'char',
                    charName: body.charName || ((state.snapshot && state.snapshot.charName) || 'Character'),
                    personaName: body.personaName || ((state.snapshot && state.snapshot.personaName) || '나'),
                    ttsConfig: effectiveTtsCfg,
                    callLlm: async (messages) => {
                        const profile = resolveTtsLlmProfile();
                        if (!profile) throw new Error('대본 분석용 모델 프로필이 설정되지 않았습니다.');
                        const llmRes = await callLLMNonStream(profile, messages, {
                            forceTemperature: 0.15,
                            timeoutMs: 45000,
                            source: 'tts_analyze',
                        });
                        return llmRes && llmRes.text ? llmRes.text : '';
                    },
                });
                return sendJson(res, 200, { ok: true, ...result }, req);
            } catch (e) {
                return sendJson(res, 500, { error: e.message }, req);
            }
        }

        if (pathname === '/api/tts/synthesize' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const result = await ttsProvider.synthesizeSegment(body.segment, config.tts, {
                    charName: body.charName || ((state.snapshot && state.snapshot.charName) || 'Character'),
                    overrideVoiceId: body.overrideVoiceId || '',
                });
                res.writeHead(200, {
                    'Content-Type': result.mime || 'audio/mpeg',
                    'Content-Length': String(result.bytes.length),
                    'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff',
                    'X-TTS-Cache': result.cacheHit ? 'HIT' : 'MISS',
                    'X-TTS-Voice': String(result.voiceId || ''),
                    'X-TTS-Provider': String(result.provider || ''),
                    ...corsHeaders(req),
                });
                res.end(result.bytes);
                return;
            } catch (e) {
                return sendJson(res, 502, { error: e.message }, req);
            }
        }

        if (pathname === '/api/tts/test' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const ov = (body.ttsOverride && typeof body.ttsOverride === 'object') ? body.ttsOverride : {};
                const mergedCfg = normalizeTtsConfig({
                    ...config.tts,
                    ...ov,
                    apiKey: ov.apiKey ? String(ov.apiKey) : (config.tts ? config.tts.apiKey : ''),
                });
                const t0 = Date.now();
                const result = await ttsProvider.testConnection(mergedCfg, {
                    text: body.text || '안녕하세요. RisuStand 음성 테스트입니다.',
                    kind: body.kind || 'dialogue',
                    speaker: body.speaker || 'Tester',
                    gender: body.gender || 'female',
                    voiceId: body.voiceId || '',
                    toneTag: body.toneTag || '',
                });
                const elapsedMs = Date.now() - t0;
                res.writeHead(200, {
                    'Content-Type': result.mime || 'audio/mpeg',
                    'Content-Length': String(result.bytes.length),
                    'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff',
                    'X-TTS-Provider': String(result.provider || ''),
                    'X-TTS-Voice': String(result.voiceId || ''),
                    'X-TTS-Elapsed-Ms': String(elapsedMs),
                    ...corsHeaders(req),
                });
                res.end(result.bytes);
                return;
            } catch (e) {
                return sendJson(res, 502, { error: e.message }, req);
            }
        }

        if (pathname === '/api/tts/models' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const curCfg = normalizeTtsConfig(config.tts);
                const reqGroup = normalizeVoiceGroup(body.group, '');
                let targetProvider = typeof body.provider === 'string' && body.provider ? body.provider : '';
                let targetApiUrl = body.apiUrl;
                let targetModel = typeof body.model === 'string' && body.model ? body.model : '';
                if (!targetProvider && reqGroup) {
                    const curIsFish = (TTS_PROVIDER_DEFAULTS[curCfg.provider] || {}).kind === 'fish';
                    if (reqGroup === 'fish') {
                        targetProvider = curIsFish ? curCfg.provider : 'fish_local';
                        if (targetApiUrl === undefined && !curIsFish) targetApiUrl = 'http://127.0.0.1:8081/v1/tts';
                        if (!targetModel && !curIsFish) targetModel = 's2-pro';
                    } else {
                        targetProvider = !curIsFish ? curCfg.provider : 'openai_compat_local';
                        if (targetApiUrl === undefined && curIsFish) targetApiUrl = TTS_PROVIDER_DEFAULTS.openai_compat_local.apiUrl;
                        if (!targetModel && curIsFish) targetModel = TTS_PROVIDER_DEFAULTS.openai_compat_local.model;
                    }
                }
                const mergedCfg = normalizeTtsConfig({
                    ...config.tts,
                    ...(targetProvider ? { provider: targetProvider } : {}),
                    ...(targetApiUrl !== undefined ? { apiUrl: targetApiUrl } : {}),
                    ...(targetModel ? { model: targetModel } : {}),
                    apiKey: body.apiKey ? String(body.apiKey) : (config.tts ? config.tts.apiKey : ''),
                });
                const result = await listTtsModels(mergedCfg);
                return sendJson(res, 200, { ok: true, ...result, voiceProfiles: curCfg.voiceProfiles }, req);
            } catch (e) {
                return sendJson(res, 500, { error: e.message }, req);
            }
        }

        if (pathname === '/api/tts/voice-profiles' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const curTts = normalizeTtsConfig(config.tts);
                const nextProfiles = {
                    fish: [...(curTts.voiceProfiles.fish || [])],
                    openai_qwen: [...(curTts.voiceProfiles.openai_qwen || [])],
                };
                if (body.voiceProfiles && typeof body.voiceProfiles === 'object') {
                    const normAll = normalizeVoiceProfiles(body.voiceProfiles);
                    nextProfiles.fish = normAll.fish;
                    nextProfiles.openai_qwen = normAll.openai_qwen;
                } else {
                    const grp = normalizeVoiceGroup(body.group, '');
                    if (!grp) return sendJson(res, 400, { error: '유효한 보이스 영역(fish | openai_qwen)을 지정하세요.' }, req);
                    const action = String(body.action || '').toLowerCase().trim();
                    if (action === 'delete') {
                        const delId = String(body.id || '').trim();
                        nextProfiles[grp] = nextProfiles[grp].filter((item) => item.id !== delId);
                    } else if (action === 'upsert') {
                        const item = (body.item && typeof body.item === 'object') ? body.item : body;
                        const normGroup = normalizeVoiceProfiles({ [grp]: [...nextProfiles[grp], item] })[grp];
                        const id = String((item && (item.id || item.voiceId)) || '').trim();
                        if (!id) return sendJson(res, 400, { error: 'Voice / Reference ID가 비어 있습니다.' }, req);
                        const updatedEntry = normGroup.find((x) => x.id === id);
                        if (updatedEntry) {
                            const idx = nextProfiles[grp].findIndex((x) => x.id === id);
                            if (idx >= 0) {
                                const customLabel = String((item && (item.label || item.name)) || id).trim();
                                nextProfiles[grp][idx] = {
                                    ...updatedEntry,
                                    label: customLabel || updatedEntry.label,
                                };
                            } else {
                                nextProfiles[grp].push(updatedEntry);
                            }
                        }
                    } else if (Array.isArray(body.profiles)) {
                        nextProfiles[grp] = normalizeVoiceProfiles({ [grp]: body.profiles })[grp];
                    } else {
                        return sendJson(res, 400, { error: '지원하지 않는 voice-profiles 요청 형식입니다.' }, req);
                    }
                }
                curTts.voiceProfiles = normalizeVoiceProfiles(nextProfiles);
                config.tts = normalizeTtsConfig(curTts);
                ttsProvider.clearCache();
                saveConfig();
                return sendJson(res, 200, sanitizeConfigForClient(), req);
            } catch (e) {
                return sendJson(res, 400, { error: e.message }, req);
            }
        }

        if (pathname === '/api/tts/discover' && req.method === 'GET') {
            if (!requireAuth(req, res)) return;
            try {
                const servers = await scanLocalTtsServers();
                return sendJson(res, 200, { ok: true, servers, presets: TTS_ENDPOINT_PRESETS }, req);
            } catch (e) {
                return sendJson(res, 500, { error: e.message }, req);
            }
        }

        if ((pathname === '/api/tts/chat-cast' || pathname === '/api/tts/characters') && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const chars = Array.isArray(body.characters) ? body.characters : [];
                const curTts = normalizeTtsConfig(config.tts);
                curTts.characters = chars;
                curTts.chatCharacters = {};
                config.tts = normalizeTtsConfig(curTts);
                ttsProvider.clearCache();
                saveConfig();
                return sendJson(res, 200, sanitizeConfigForClient(), req);
            } catch (e) {
                return sendJson(res, 400, { error: e.message }, req);
            }
        }

        // 8) Router & Translator Config API
        if (pathname === '/api/router/config' && req.method === 'GET') {
            if (!requireAuth(req, res)) return;
            return sendJson(res, 200, sanitizeConfigForClient(), req);
        }

        if (pathname === '/api/router/config' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const oldMap = new Map(config.profiles.map((p) => [p.id, p]));
                if (Array.isArray(body.profiles)) {
                    config.profiles = body.profiles.map((p) => {
                        const prev = oldMap.get(p.id);
                        return {
                            id: String(p.id || ('prof-' + Date.now())),
                            name: String(p.name || 'Model'),
                            provider: String(p.provider || detectProviderPresetId('', p.providerType, p.baseUrl)),
                            providerType: p.providerType || 'openai_compat',
                            baseUrl: String(p.baseUrl || ''),
                            apiKey: p.apiKey ? String(p.apiKey) : (prev ? prev.apiKey : ''),
                            model: String(p.model || ''),
                            temperature: p.temperature !== undefined && p.temperature !== null ? String(p.temperature) : '',
                            maxTokens: p.maxTokens !== undefined && p.maxTokens !== null ? String(p.maxTokens) : '',
                            overrideMode: p.overrideMode || 'off',
                            systemOverride: String(p.systemOverride || ''),
                        };
                    });
                }
                if (typeof body.activeProfileId === 'string') {
                    config.activeProfileId = body.activeProfileId;
                }
                if (typeof body.auxProfileId === 'string') {
                    config.auxProfileId = body.auxProfileId || 'inherit';
                }
                if (config.auxProfileId && config.auxProfileId !== 'inherit' && !config.profiles.some((p) => p && p.id === config.auxProfileId)) {
                    config.auxProfileId = 'inherit';
                }
                if (body.imageGen && typeof body.imageGen === 'object') {
                    config.imageGen = normalizeImageGenConfig({
                        ...config.imageGen,
                        ...body.imageGen,
                        apiKey: body.imageGen.apiKey ? String(body.imageGen.apiKey) : (config.imageGen ? config.imageGen.apiKey : ''),
                    });
                }
                if (body.tts && typeof body.tts === 'object') {
                    const existingCharacters = (config.tts && Array.isArray(config.tts.characters))
                        ? config.tts.characters
                        : [];
                    const existingVoiceProfiles = (config.tts && config.tts.voiceProfiles && typeof config.tts.voiceProfiles === 'object')
                        ? config.tts.voiceProfiles
                        : { fish: [], openai_qwen: [] };
                    config.tts = normalizeTtsConfig({
                        ...config.tts,
                        ...body.tts,
                        characters: Array.isArray(body.tts.characters) ? body.tts.characters : existingCharacters,
                        chatCharacters: {},
                        voiceProfiles: body.tts.voiceProfiles !== undefined ? body.tts.voiceProfiles : existingVoiceProfiles,
                        apiKey: body.tts.apiKey ? String(body.tts.apiKey) : (config.tts ? config.tts.apiKey : ''),
                    });
                    ttsProvider.clearCache();
                }
                if (typeof body.directPresetId === 'string') {
                    config.directPresetId = body.directPresetId;
                }
                if (typeof body.directHistoryMode === 'string') {
                    config.directHistoryMode = normalizeDirectHistoryMode(body.directHistoryMode);
                }
                if (typeof body.directPipelineMode === 'string') {
                    config.directPipelineMode = normalizeDirectPipelineMode(body.directPipelineMode);
                }
                if (body.remoteToggleValues && typeof body.remoteToggleValues === 'object' && !Array.isArray(body.remoteToggleValues)) {
                    const nextRT = {};
                    for (const [k, v] of Object.entries(body.remoteToggleValues)) {
                        if (k) nextRT[String(k)] = String(v ?? '');
                    }
                    config.remoteToggleValues = nextRT;
                }
                if (Array.isArray(body.presetToggles)) {
                    config.presetToggles = body.presetToggles.map((pt) => ({
                        id: String(pt.id || ('pt-' + Date.now())),
                        name: String(pt.name || '프롬프트 프리셋'),
                        enabled: pt.enabled !== false,
                        syntax: String(pt.syntax || ''),
                        ...(typeof pt.parentPresetId === 'string' && pt.parentPresetId.trim()
                            ? { parentPresetId: pt.parentPresetId.trim() }
                            : {}),
                    }));
                }
                syncDirectPresetToggles(config);
                if (body.translator && typeof body.translator === 'object') {
                    config.translator = {
                        ...config.translator,
                        ...body.translator,
                        apiKey: body.translator.apiKey ? String(body.translator.apiKey) : config.translator.apiKey,
                    };
                }
                saveConfig();
                return sendJson(res, 200, sanitizeConfigForClient(), req);
            } catch (e) {
                return sendJson(res, 400, { error: e.message }, req);
            }
        }

        // 8b) AI Provider Presets & Model Loader API
        if (pathname === '/api/router/providers' && req.method === 'GET') {
            if (!requireAuth(req, res)) return;
            return sendJson(res, 200, { ok: true, providers: Object.values(AI_PROVIDER_PRESETS) }, req);
        }

        if (pathname === '/api/router/models' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                let apiKey = String(body.apiKey || '').trim();
                if (!apiKey) {
                    if (body.target === 'translator') {
                        apiKey = String((config.translator && config.translator.apiKey) || '');
                    } else if (body.profileId) {
                        const existing = (config.profiles || []).find((p) => p && p.id === body.profileId);
                        if (existing && existing.apiKey) apiKey = String(existing.apiKey);
                    }
                }
                const resModels = await fetchProviderModels({
                    provider: String(body.provider || ''),
                    providerType: String(body.providerType || ''),
                    baseUrl: String(body.baseUrl || ''),
                    apiKey,
                });
                return sendJson(res, 200, { ok: true, ...resModels }, req);
            } catch (e) {
                return sendJson(res, 400, { error: e && e.message ? e.message : String(e) }, req);
            }
        }

        // 8b-2) LLM Request Log Viewer API
        if (pathname === '/api/logs' && req.method === 'GET') {
            if (!requireAuth(req, res)) return;
            const summary = recomputeRequestLogsCacheGuard(requestLogs);
            return sendJson(res, 200, {
                ok: true,
                max: REQUEST_LOG_MAX,
                summary,
                logs: requestLogs.map(summarizeRequestLog),
            }, req);
        }

        if (pathname === '/api/logs' && req.method === 'DELETE') {
            if (!requireAuth(req, res)) return;
            requestLogs.length = 0;
            return sendJson(res, 200, { ok: true, summary: buildCacheGuardSessionSummary(requestLogs) }, req);
        }

        const logDetailMatch = pathname.match(/^\/api\/logs\/([^/]+)$/);
        if (logDetailMatch && req.method === 'GET') {
            if (!requireAuth(req, res)) return;
            let reqId = logDetailMatch[1];
            try { reqId = decodeURIComponent(reqId); } catch (_) {}
            recomputeRequestLogsCacheGuard(requestLogs);
            const found = requestLogs.find((item) => item.id === reqId);
            if (!found) {
                return sendJson(res, 404, { error: '요청 로그를 찾을 수 없습니다.' }, req);
            }
            return sendJson(res, 200, { ok: true, log: serializeRequestLogDetail(found) }, req);
        }

        // 8c) Bundled Leave Preset API
        if (pathname === '/api/presets/leave' && req.method === 'GET') {
            if (!requireAuth(req, res)) return;
            const p = loadBundledLeavePreset();
            if (!p) return sendJson(res, 404, { error: '내장 Leave 프리셋 파일이 없습니다.' }, req);
            return sendJson(res, 200, {
                ok: true,
                id: p.id,
                name: p.name,
                filename: p.filename,
                toggleSyntax: p.toggleSyntax,
                defaultVariables: p.defaultVariables,
                hasGuide: p.hasGuide,
            }, req);
        }

        if (pathname === '/api/presets/leave/download' && req.method === 'GET') {
            if (!requireAuth(req, res)) return;
            const p = loadBundledLeavePreset();
            if (!p) return sendJson(res, 404, { error: '내장 Leave 프리셋 파일이 없습니다.' }, req);
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Disposition': 'attachment; filename="Leave_RisuAI_Preset.risup"',
                ...corsHeaders(req),
            });
            res.end(p.rawRisup);
            return;
        }

        if (pathname === '/api/presets/leave/guide' && req.method === 'GET') {
            if (!requireAuth(req, res)) return;
            const p = loadBundledLeavePreset();
            if (!p || !p.hasGuide) return sendJson(res, 404, { error: '내장 Leave 가이드 HTML이 없습니다.' }, req);
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                ...corsHeaders(req),
            });
            res.end(fs.readFileSync(p.htmlPath));
            return;
        }

        // 8c-2) Direct Remote Prompt Preset Selection & Custom Upload API
        if (pathname === '/api/presets/direct' && req.method === 'GET') {
            if (!requireAuth(req, res)) return;
            return sendJson(res, 200, {
                ok: true,
                directPresetId: typeof config.directPresetId === 'string' ? config.directPresetId : 'bundled:leave',
                presets: listDirectPresets(),
            }, req);
        }

        if (pathname === '/api/presets/direct' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const nextId = String(body.directPresetId || 'off').trim();
                const available = listDirectPresets();
                if (!available.some((p) => p.id === nextId)) {
                    return sendJson(res, 404, { error: '선택한 프리셋을 찾을 수 없습니다.' }, req);
                }
                config.directPresetId = nextId;
                syncDirectPresetToggles(config);
                saveConfig();
                return sendJson(res, 200, sanitizeConfigForClient(), req);
            } catch (e) {
                return sendJson(res, 400, { error: e.message }, req);
            }
        }

        if (pathname === '/api/presets/custom' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const entry = parseUploadedPresetPayload({
                    filename: body.filename,
                    dataBase64: body.dataBase64,
                    jsonObject: body.jsonObject,
                });
                entry.autoRegisterToggle = body.registerToggle !== false;
                const list = loadCustomPresets().slice();
                list.push(entry);
                saveCustomPresets(list);
                config.directPresetId = `custom:${entry.id}`;
                syncDirectPresetToggles(config);
                saveConfig();
                const summary = listDirectPresets().find((p) => p.id === config.directPresetId) || null;
                return sendJson(res, 200, { ok: true, preset: summary, config: sanitizeConfigForClient() }, req);
            } catch (e) {
                return sendJson(res, 400, { error: e && e.message ? e.message : String(e) }, req);
            }
        }

        const customPresetMatch = pathname.match(/^\/api\/presets\/custom\/([^/]+)$/);
        if (customPresetMatch && req.method === 'DELETE') {
            if (!requireAuth(req, res)) return;
            let rawId = customPresetMatch[1];
            try { rawId = decodeURIComponent(rawId); } catch (_) {}
            const cid = rawId.startsWith('custom:') ? rawId.slice(7) : rawId;
            const list = loadCustomPresets();
            const nextList = list.filter((p) => p && p.id !== cid);
            if (nextList.length === list.length) {
                return sendJson(res, 404, { error: '커스텀 프리셋을 찾을 수 없습니다.' }, req);
            }
            saveCustomPresets(nextList);
            if (Array.isArray(config.presetToggles)) {
                config.presetToggles = config.presetToggles.filter((pt) => !pt || pt.id !== `pt-${cid}`);
            }
            if (config.directPresetId === `custom:${cid}`) {
                config.directPresetId = loadBundledLeavePreset() ? 'bundled:leave' : 'off';
            }
            syncDirectPresetToggles(config);
            saveConfig();
            return sendJson(res, 200, { ok: true, config: sanitizeConfigForClient() }, req);
        }

        // 8c-3) Lorebook Inspector & Per-Bot Selection API
        if (pathname === '/api/lorebook' && req.method === 'GET') {
            if (!requireAuth(req, res)) return;
            const snap = state.snapshot || {};
            const rawCtx = snap.charContext && typeof snap.charContext === 'object' ? snap.charContext : {};
            const charKey = getLoreCharKeyFromSnap(snap);
            const rawEntries = Array.isArray(rawCtx.loreEntries) ? rawCtx.loreEntries : [];
            const entries = rawEntries.map((e, idx) => {
                const dec = parseLoreDecorators(e && e.content ? e.content : '');
                const decTags = [];
                if (dec.pos === 'depth') decTags.push(`@@depth ${dec.depth}`);
                else if (dec.pos === 'reverse_depth') decTags.push(`@@reverse_depth ${dec.depth}`);
                else if (dec.pos) decTags.push(`@@position ${dec.pos}`);
                if (dec.role && dec.role !== 'system') decTags.push(`@@role ${dec.role}`);
                return {
                    uid: String((e && e.uid) || `idx:${idx}`),
                    source: String((e && e.source) || 'char'),
                    isModule: isModuleLoreEntry(e),
                    sourceName: String((e && e.sourceName) || ''),
                    comment: String((e && e.comment) || ''),
                    key: String((e && e.key) || ''),
                    secondkey: String((e && e.secondkey) || ''),
                    alwaysActive: Boolean(e && e.alwaysActive),
                    insertorder: Number((e && e.insertorder) ?? 100),
                    decorator: decTags.join(' '),
                    charLen: dec.content.length,
                    content: dec.content || String((e && e.content) || ''),
                };
            });
            const charEntries = entries.filter((e) => !e.isModule);
            const moduleEntries = entries.filter((e) => e.isModule);
            const disabledUids = (config.disabledLoreEntries && Array.isArray(config.disabledLoreEntries[charKey]))
                ? config.disabledLoreEntries[charKey]
                : [];
            const enabledModuleUids = (config.enabledModuleLoreEntries && Array.isArray(config.enabledModuleLoreEntries[charKey]))
                ? config.enabledModuleLoreEntries[charKey]
                : [];
            const pinnedUids = (config.pinnedLoreEntries && Array.isArray(config.pinnedLoreEntries[charKey]))
                ? config.pinnedLoreEntries[charKey]
                : [];
            return sendJson(res, 200, {
                ok: true,
                charKey,
                charName: snap.charName || '',
                charIndex: typeof snap.charIndex === 'number' ? snap.charIndex : -1,
                chatIndex: typeof snap.chatIndex === 'number' ? snap.chatIndex : -1,
                disabledUids,
                enabledModuleUids,
                pinnedUids,
                entries,
                charEntries,
                moduleEntries,
            }, req);
        }

        if (pathname === '/api/lorebook/selection' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const charKey = String(body.charKey || getLoreCharKeyFromSnap(state.snapshot) || '').trim();
                if (!charKey) return sendJson(res, 400, { error: 'Missing charKey' }, req);
                if (!config.disabledLoreEntries || typeof config.disabledLoreEntries !== 'object') config.disabledLoreEntries = {};
                if (!config.enabledModuleLoreEntries || typeof config.enabledModuleLoreEntries !== 'object') config.enabledModuleLoreEntries = {};
                if (!config.pinnedLoreEntries || typeof config.pinnedLoreEntries !== 'object') config.pinnedLoreEntries = {};

                if (Array.isArray(body.disabledUids)) {
                    const next = Array.from(new Set(body.disabledUids.map((x) => String(x || '')).filter(Boolean)));
                    if (next.length) config.disabledLoreEntries[charKey] = next;
                    else delete config.disabledLoreEntries[charKey];
                }
                if (Array.isArray(body.enabledModuleUids)) {
                    const nextM = Array.from(new Set(body.enabledModuleUids.map((x) => String(x || '')).filter(Boolean)));
                    if (nextM.length) config.enabledModuleLoreEntries[charKey] = nextM;
                    else delete config.enabledModuleLoreEntries[charKey];
                    const enabledSet = new Set(nextM);
                    const curPins = Array.isArray(config.pinnedLoreEntries[charKey]) ? config.pinnedLoreEntries[charKey] : [];
                    const prunedPins = curPins.filter((u) => !String(u).startsWith('module:') || enabledSet.has(String(u)));
                    if (prunedPins.length) config.pinnedLoreEntries[charKey] = prunedPins;
                    else delete config.pinnedLoreEntries[charKey];
                }
                if (Array.isArray(body.pinnedUids)) {
                    const nextP = Array.from(new Set(body.pinnedUids.map((x) => String(x || '')).filter(Boolean)));
                    if (nextP.length) config.pinnedLoreEntries[charKey] = nextP;
                    else delete config.pinnedLoreEntries[charKey];
                }
                if (body.uid) {
                    const uid = String(body.uid);
                    const rawCtx = state.snapshot && state.snapshot.charContext && typeof state.snapshot.charContext === 'object' ? state.snapshot.charContext : {};
                    const rawList = Array.isArray(rawCtx.loreEntries) ? rawCtx.loreEntries : [];
                    const matchedRaw = rawList.find((item) => item && String(item.uid || '') === uid);
                    const targetIsModule = Boolean(body.isModule || uid.startsWith('module:') || (matchedRaw && isModuleLoreEntry(matchedRaw)));
                    const disSet = new Set(config.disabledLoreEntries[charKey] || []);
                    const modEnSet = new Set(config.enabledModuleLoreEntries[charKey] || []);
                    const pinSet = new Set(config.pinnedLoreEntries[charKey] || []);
                    if (typeof body.enabled === 'boolean') {
                        if (targetIsModule) {
                            if (body.enabled) modEnSet.add(uid);
                            else {
                                modEnSet.delete(uid);
                                pinSet.delete(uid);
                            }
                            disSet.delete(uid);
                            if (modEnSet.size) config.enabledModuleLoreEntries[charKey] = Array.from(modEnSet);
                            else delete config.enabledModuleLoreEntries[charKey];
                            if (disSet.size) config.disabledLoreEntries[charKey] = Array.from(disSet);
                            else delete config.disabledLoreEntries[charKey];
                            if (pinSet.size) config.pinnedLoreEntries[charKey] = Array.from(pinSet);
                            else delete config.pinnedLoreEntries[charKey];
                        } else {
                            if (body.enabled) disSet.delete(uid);
                            else disSet.add(uid);
                            if (disSet.size) config.disabledLoreEntries[charKey] = Array.from(disSet);
                            else delete config.disabledLoreEntries[charKey];
                        }
                    }
                    if (typeof body.pinned === 'boolean') {
                        if (body.pinned) {
                            if (!targetIsModule || modEnSet.has(uid)) pinSet.add(uid);
                        } else {
                            pinSet.delete(uid);
                        }
                        if (pinSet.size) config.pinnedLoreEntries[charKey] = Array.from(pinSet);
                        else delete config.pinnedLoreEntries[charKey];
                    }
                }
                saveConfig();
                return sendJson(res, 200, {
                    ok: true,
                    charKey,
                    disabledUids: config.disabledLoreEntries[charKey] || [],
                    enabledModuleUids: config.enabledModuleLoreEntries[charKey] || [],
                    pinnedUids: config.pinnedLoreEntries[charKey] || [],
                }, req);
            } catch (e) {
                return sendJson(res, 400, { error: e.message }, req);
            }
        }

        // 8d) Backend Plugin Adapter & Native GUI Iframe APIs
        if (pathname === '/api/plugins' && req.method === 'GET') {
            if (!requireAuth(req, res)) return;
            return sendJson(res, 200, {
                ok: true,
                pcConnected: Boolean(state.pcConnected && (Date.now() - state.pcLastSeen < 12000)),
                rpcConnected: hostRpc.isConnected(),
                remoteDirectOnly: config.remoteDirectOnly !== false,
                plugins: pluginAdapter.listPlugins(),
            }, req);
        }

        if (pathname === '/api/plugins/settings' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                if (typeof body.remoteDirectOnly === 'boolean') {
                    config.remoteDirectOnly = body.remoteDirectOnly;
                    saveConfig();
                }
                return sendJson(res, 200, {
                    ok: true,
                    remoteDirectOnly: config.remoteDirectOnly !== false,
                    plugins: pluginAdapter.listPlugins(),
                }, req);
            } catch (e) {
                return sendJson(res, 400, { error: e.message }, req);
            }
        }

        if (pathname === '/api/plugins/sync-pc' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const plugins = await pluginAdapter.syncPcPlugins();
                await refreshDisplaySnapshot();
                return sendJson(res, 200, { ok: true, plugins }, req);
            } catch (e) {
                return sendJson(res, 502, { error: e.message }, req);
            }
        }

        if (pathname === '/api/plugins/reload-pc' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                if (hostRpc.isConnected()) {
                    await hostRpc.invoke('db.reloadPcPlugins', [], 8000).catch(() => {});
                    await new Promise((r) => setTimeout(r, 150));
                }
                const plugins = typeof pluginAdapter.reloadPlugins === 'function'
                    ? await pluginAdapter.reloadPlugins(body.name || '')
                    : pluginAdapter.listPlugins();
                await refreshDisplaySnapshot();
                return sendJson(res, 200, { ok: true, plugins }, req);
            } catch (e) {
                return sendJson(res, 502, { error: e.message }, req);
            }
        }

        if (pathname === '/api/plugins/upload' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req, 64 * 1024 * 1024)) || '{}');
                const plugins = await pluginAdapter.addCustomPlugin({
                    filename: body.filename,
                    script: body.script,
                    enabled: body.enabled !== false,
                });
                await refreshDisplaySnapshot();
                return sendJson(res, 200, { ok: true, plugins }, req);
            } catch (e) {
                return sendJson(res, 400, { error: e.message }, req);
            }
        }

        if (pathname === '/api/plugins/toggle' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const plugins = await pluginAdapter.togglePlugin(body.name, Boolean(body.enabled));
                await refreshDisplaySnapshot();
                return sendJson(res, 200, { ok: true, plugins }, req);
            } catch (e) {
                return sendJson(res, 400, { error: e.message }, req);
            }
        }

        if (pathname === '/api/plugins/args' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const plugins = await pluginAdapter.updatePluginArgs(body.name, body.args || {});
                await refreshDisplaySnapshot();
                return sendJson(res, 200, { ok: true, plugins }, req);
            } catch (e) {
                return sendJson(res, 400, { error: e.message }, req);
            }
        }

        if (pathname === '/api/plugins/gui-srcdoc' && req.method === 'GET') {
            if (!requireAuth(req, res)) return;
            const pName = urlObj.searchParams.get('name') || '';
            const entryId = urlObj.searchParams.get('entryId') || '';
            const theme = urlObj.searchParams.get('theme') || 'dark';
            const out = pluginAdapter.getGuiSrcdoc(pName, entryId, theme);
            if (!out) return sendJson(res, 404, { error: '플러그인을 찾을 수 없습니다.' }, req);
            return sendJson(res, 200, { ok: true, ...out }, req);
        }

        if (pathname === '/api/plugins/gui-rpc' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const value = await pluginAdapter.handleGuiRpc({
                    pluginName: body.pluginName,
                    method: body.method,
                    args: body.args || [],
                });
                return sendJson(res, 200, { ok: true, value }, req);
            } catch (e) {
                return sendJson(res, 400, { error: e && e.message ? e.message : String(e) }, req);
            }
        }

        if (pathname === '/api/plugins/surface-action' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const snapNow = state.snapshot || {};
                const charIndex = Number.isFinite(Number(body.charIndex)) ? Number(body.charIndex) : snapNow.charIndex;
                const chatIndex = Number.isFinite(Number(body.chatIndex)) ? Number(body.chatIndex) : snapNow.chatIndex;
                const prevVer = state.snapshotVersion;
                const out = await pluginAdapter.dispatchSurfaceAction({
                    charIndex,
                    chatIndex,
                    msgIndex: Number(body.msgIndex ?? -1),
                    chatId: String(body.chatId || ''),
                    actionHtml: String(body.actionHtml || ''),
                    dataset: (body.dataset && typeof body.dataset === 'object') ? body.dataset : {},
                    selector: String(body.selector || ''),
                    textContent: String(body.textContent || ''),
                    ariaLabel: String(body.ariaLabel || ''),
                    title: String(body.title || ''),
                    className: String(body.className || ''),
                    siblingIndex: Number.isInteger(Number(body.siblingIndex)) ? Number(body.siblingIndex) : -1,
                });
                if (out.dbMutated && hostRpc.isConnected()) {
                    await waitForSnapshotBump(prevVer, 280);
                }
                await refreshDisplaySnapshot();
                const resolvedOverlay = out.openedOverlay
                    ? await resolvePluginUiAssets(out.openedOverlay, pluginAdapter, state.baseSnapshot)
                    : null;
                const resolvedFloatingUi = await resolvePluginUiAssets(
                    out.pluginFloatingUi || pluginAdapter.getFloatingUiState(),
                    pluginAdapter,
                    state.baseSnapshot
                );
                return sendJson(res, 200, {
                    ok: true,
                    ...out,
                    openedOverlay: resolvedOverlay,
                    pluginFloatingUi: resolvedFloatingUi,
                    snapshot: state.snapshot,
                    snapshotVersion: state.snapshotVersion,
                }, req);
            } catch (e) {
                return sendJson(res, 400, { error: e && e.message ? e.message : String(e) }, req);
            }
        }

        if (pathname === '/api/plugins/floating-open' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const snapNow = state.snapshot || {};
                const charIndex = Number.isFinite(Number(body.charIndex)) ? Number(body.charIndex) : snapNow.charIndex;
                const chatIndex = Number.isFinite(Number(body.chatIndex)) ? Number(body.chatIndex) : snapNow.chatIndex;
                const rawUi = await pluginAdapter.prepareFloatingPopupWidgets({ charIndex, chatIndex });
                const ui = await resolvePluginUiAssets(rawUi, pluginAdapter, state.baseSnapshot);
                return sendJson(res, 200, { ok: true, pluginFloatingUi: ui }, req);
            } catch (e) {
                return sendJson(res, 400, { error: e && e.message ? e.message : String(e) }, req);
            }
        }

        if (pathname === '/api/plugins/root-click' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const snapNow = state.snapshot || {};
                const charIndex = Number.isFinite(Number(body.charIndex)) ? Number(body.charIndex) : snapNow.charIndex;
                const chatIndex = Number.isFinite(Number(body.chatIndex)) ? Number(body.chatIndex) : snapNow.chatIndex;
                const prevVer = state.snapshotVersion;
                const out = await pluginAdapter.dispatchRootWidgetClick({
                    pluginName: String(body.pluginName || ''),
                    charIndex,
                    chatIndex,
                    selector: String(body.selector || ''),
                    countNode: String(body.countNode || ''),
                    actionHtml: String(body.actionHtml || ''),
                    dataset: (body.dataset && typeof body.dataset === 'object') ? body.dataset : {},
                    textContent: String(body.textContent || ''),
                    ariaLabel: String(body.ariaLabel || ''),
                    title: String(body.title || ''),
                    className: String(body.className || ''),
                    siblingIndex: Number.isInteger(Number(body.siblingIndex)) ? Number(body.siblingIndex) : -1,
                    eventType: String(body.eventType || 'click'),
                    value: body.value,
                    checked: body.checked,
                    x: Number(body.x ?? 24),
                    y: Number(body.y ?? 24),
                });
                if (out.dbMutated && hostRpc.isConnected()) {
                    await waitForSnapshotBump(prevVer, 260);
                }
                if (out.dbMutated || out.surfaceMutated || pluginAdapter.hasEditDisplayHandlers()) {
                    await refreshDisplaySnapshot();
                }
                const resolvedActiveOverlay = out.activeOverlay
                    ? await resolvePluginUiAssets(out.activeOverlay, pluginAdapter, state.baseSnapshot)
                    : null;
                const resolvedFloatingUi = await resolvePluginUiAssets(
                    pluginAdapter.getFloatingUiState(),
                    pluginAdapter,
                    state.baseSnapshot
                );
                return sendJson(res, 200, {
                    ok: true,
                    ...out,
                    activeOverlay: resolvedActiveOverlay,
                    pluginFloatingUi: resolvedFloatingUi,
                    snapshot: state.snapshot,
                    snapshotVersion: state.snapshotVersion,
                }, req);
            } catch (e) {
                return sendJson(res, 400, { error: e && e.message ? e.message : String(e) }, req);
            }
        }

        if (pathname === '/api/triggers/run' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const snapNow = state.snapshot || {};
                const charIndex = Number.isFinite(Number(body.charIndex)) ? Number(body.charIndex) : snapNow.charIndex;
                const chatIndex = Number.isFinite(Number(body.chatIndex)) ? Number(body.chatIndex) : snapNow.chatIndex;
                const trigger = String(body.trigger || '').trim();
                const promptAnswers = Array.isArray(body.promptAnswers) ? body.promptAnswers : [];
                if (!trigger) return sendJson(res, 400, { error: 'Missing trigger' }, req);

                if (hostRpc.isConnected() && charIndex >= 0 && chatIndex >= 0) {
                    const prevSnapVer = state.snapshotVersion;
                    await pluginAdapter.prepareTurn(charIndex, chatIndex, state.snapshot);
                    try {
                        const tCtx = pluginAdapter.getTurnContext();
                        const trigRes = await moduleAdapter.runManualTrigger({
                            charIndex,
                            chatIndex,
                            charObj: tCtx.charObj,
                            chatObj: tCtx.chatObj,
                            triggerName: trigger,
                            promptAnswers,
                        });
                        if (trigRes && trigRes.handled) {
                            if (trigRes.pause) {
                                return sendJson(res, 200, {
                                    ok: true,
                                    mode: 'backend_instant',
                                    handled: true,
                                    pause: trigRes.pause,
                                    triggerEvent: state.lastTriggerEvent,
                                }, req);
                            }
                            if (trigRes.chatObj) {
                                await hostRpc.invoke('db.setChat', [Number(charIndex), Number(chatIndex), cloneJsonSafe(trigRes.chatObj)]);
                                if (state.snapshot && state.snapshot.charIndex === Number(charIndex) && state.snapshot.chatIndex === Number(chatIndex)) {
                                    state.snapshot = syncSnapVarsFromChatObj(state.snapshot, trigRes.chatObj);
                                }
                                if (state.baseSnapshot && state.baseSnapshot.charIndex === Number(charIndex) && state.baseSnapshot.chatIndex === Number(chatIndex)) {
                                    state.baseSnapshot = syncSnapVarsFromChatObj(state.baseSnapshot, trigRes.chatObj);
                                }
                            }
                            await waitForSnapshotBump(prevSnapVer, 260);
                            let lightSnap = null;
                            if (state.snapshot) {
                                if (state.snapshot.charContext && Object.prototype.hasOwnProperty.call(state.snapshot.charContext, 'loreEntries')) {
                                    const { loreEntries: _omitLoreEntries, ...lightCtx } = state.snapshot.charContext;
                                    lightSnap = { ...state.snapshot, charContext: lightCtx };
                                } else {
                                    lightSnap = state.snapshot;
                                }
                            }
                            return sendJson(res, 200, {
                                ok: true,
                                mode: 'backend_instant',
                                handled: true,
                                pause: null,
                                triggerEvent: state.lastTriggerEvent,
                                snapshotVersion: state.snapshotVersion,
                                snapshot: lightSnap,
                            }, req);
                        }
                    } finally {
                        moduleAdapter.endTurn();
                        pluginAdapter.endTurn();
                    }
                }
                queueCommand('run_trigger', { charIndex, chatIndex, trigger, promptAnswers });
                return sendJson(res, 200, { ok: true, mode: 'queued', handled: false }, req);
            } catch (e) {
                return sendJson(res, 400, { error: e && e.message ? e.message : String(e) }, req);
            }
        }

        if (pathname === '/api/modules/interaction' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const snapNow = state.snapshot || {};
                const charIndex = Number.isFinite(Number(body.charIndex)) ? Number(body.charIndex) : snapNow.charIndex;
                const chatIndex = Number.isFinite(Number(body.chatIndex)) ? Number(body.chatIndex) : snapNow.chatIndex;
                await pluginAdapter.prepareTurn(charIndex, chatIndex, state.snapshot);
                try {
                    const tCtx = pluginAdapter.getTurnContext();
                    const resInt = await moduleAdapter.runInteraction({
                        charIndex,
                        chatIndex,
                        charObj: tCtx.charObj,
                        chatObj: tCtx.chatObj,
                        kind: body.kind === 'form' ? 'form' : 'button',
                        code: String(body.code || ''),
                        key: String(body.key || ''),
                        formValues: (body.formValues && typeof body.formValues === 'object') ? body.formValues : {},
                    });
                    if (resInt && resInt.chatObj && hostRpc.isConnected()) {
                        await hostRpc.invoke('db.setChat', [Number(charIndex), Number(chatIndex), cloneJsonSafe(resInt.chatObj)]);
                    }
                    await refreshDisplaySnapshot();
                    return sendJson(res, 200, { ok: true, handled: Boolean(resInt && resInt.handled) }, req);
                } finally {
                    moduleAdapter.endTurn();
                    pluginAdapter.endTurn();
                }
            } catch (e) {
                return sendJson(res, 400, { error: e && e.message ? e.message : String(e) }, req);
            }
        }

        const pluginDelMatch = pathname.match(/^\/api\/plugins\/([^/]+)$/);
        if (pluginDelMatch && req.method === 'DELETE') {
            if (!requireAuth(req, res)) return;
            let pName = pluginDelMatch[1];
            try { pName = decodeURIComponent(pName); } catch (_) {}
            const plugins = await pluginAdapter.removePlugin(pName);
            await refreshDisplaySnapshot();
            return sendJson(res, 200, { ok: true, plugins }, req);
        }

        sendJson(res, 404, { error: 'Not found' }, req);
    });
    function closeRpcState() {
        for (const w of rpcState.waiters.splice(0)) {
            if (!w.done) {
                w.done = true;
                clearTimeout(w.timer);
                try { w.respond([]); } catch (_) {}
            }
        }
        for (const [id, p] of rpcState.pending.entries()) {
            clearTimeout(p.timer);
            p.reject(new Error('Relay server closed'));
        }
        rpcState.pending.clear();
        if (activityState.cleanupTimer) {
            clearTimeout(activityState.cleanupTimer);
            activityState.cleanupTimer = null;
        }
        for (const sub of [...activityState.subscribers]) {
            clearInterval(sub.kaTimer);
            try { sub.res.end(); } catch (_) {}
        }
        activityState.subscribers.clear();
        notifySnapshotWaiters();
    }
    const origServerClose = server.close.bind(server);
    server.close = function (...args) {
        closeRpcState();
        return origServerClose(...args);
    };
    server.once('close', () => {
        closeRpcState();
        moduleAdapter.dispose();
        void pluginAdapter.dispose();
        if (activePluginAdapter === pluginAdapter) activePluginAdapter = prevPluginAdapter;
        if (activeModuleAdapter === moduleAdapter) activeModuleAdapter = prevModuleAdapter;
        if (activeHostRpc === hostRpc) activeHostRpc = prevHostRpc;
    });
    if (prevConfig !== null) {
        server.once('close', () => {
            config = prevConfig;
            configPersistDisabled = prevPersistDisabled;
            customPresetsCache = prevCustomPresetsCache;
        });
    }
    return server;
}

function startServer() {
    TOKEN = loadOrCreateToken(ROOT_DIR);
    let recoveredFromInterruptedUpdate = false;
    if (updater) {
        try {
            recoveredFromInterruptedUpdate = updater.recoverIfNeeded(ROOT_DIR, { log: updateLog }).rolledBack;
        } catch (e) {
            console.error('[Update] 미완료 업데이트 복구 실패:', e.message);
        }
    }

    if (recoveredFromInterruptedUpdate) {
        // This process may have loaded half-written files; run the restored version instead.
        console.log('[Update] 중단된 업데이트를 되돌렸습니다. 복구된 버전으로 다시 시작합니다.');
        const child = spawn(process.execPath, [__filename, ...process.argv.slice(2)], {
            stdio: 'inherit',
            env: { ...process.env, RISU_REMOTE_TOKEN: TOKEN, PORT: String(PORT), HOST },
        });
        process.on('SIGINT', () => {});
        process.on('SIGTERM', () => child.kill('SIGTERM'));
        child.on('exit', (code) => process.exit(code == null ? 1 : code));
        return;
    }

    activeServer = createRelayServer({ token: TOKEN });
    activeServer.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE') {
            console.error('');
            console.error(`[Server Error] 포트 ${PORT} 번이 이미 사용 중입니다.`);
            console.error('이미 켜져 있는 중계 서버를 끄려면 stop-risustand-remote.bat 을 먼저 실행하거나 기존 창을 닫은 뒤 다시 시도하세요.');
            process.exit(1);
        }
        console.error(`[Server Error] ${err && err.message ? err.message : String(err)}`);
        process.exit(1);
    });
    activeServer.listen(PORT, HOST, () => {
        if (updater) {
            try {
                if (updater.commitInstalled(ROOT_DIR, RELAY_VERSION)) updateLog(`v${RELAY_VERSION} 업데이트가 확정되었습니다.`);
            } catch (_) {}
            checkForUpdate()
                .then((info) => {
                    if (info.available) updateLog(`새 버전 v${info.latestVersion} 이(가) 있습니다. 모바일 '모듈/설정' 탭 또는 update-risustand 로 업데이트하세요.`);
                })
                .catch(() => {});
        }
        console.log('');
        console.log('======================================================');
        console.log(`  📡 RisuStand Remote Relay Server v${RELAY_VERSION} 실행 중`);
        console.log('======================================================');
        console.log(`  로컬 접속 주소 : http://127.0.0.1:${PORT}`);
        console.log(`  프록시 라우터  : http://127.0.0.1:${PORT}/v1/chat/completions`);
        console.log(`  보안 토큰      : ${TOKEN}`);
        console.log('======================================================');
        console.log('  * PC RisuAI 브릿지 주소: http://127.0.0.1:' + PORT);
        console.log('  * 아이폰/아이패드 접속 : http://<PC-Tailscale-IP>:' + PORT);
        console.log('  * 설정 파일 저장 위치  : ' + CONFIG_PATH);
        console.log('======================================================');
        console.log('');
    });
}

if (require.main === module) {
    startServer();
}

module.exports = {
    RELAY_VERSION,
    loadSavedPort,
    parseOptionalNumber,
    normalizeTurnMessages,
    computeUATurnStats,
    applyPromptOverride,
    safeTokenEqual,
    isLoopbackAddress,
    isTrustedOrigin,
    corsHeaders,
    sanitizeConfigForClient,
    decodeRisupPreset,
    encodeRisupPreset,
    parsePresetDefaultToggles,
    evalPresetCbs,
    parseLoreDecorators,
    isModuleLoreEntry,
    evaluateLorebookEntries,
    normalizeDirectHistoryMode,
    normalizeDirectPipelineMode,
    selectCacheFriendlyHistory,
    detectLeaveModelAdapterCode,
    reconcileLeaveHayakuFooterContract,
    dedupeTrailingStatusLines,
    extractTerminalSceneTail,
    auditDraftWithDeterministicGuards,
    buildDirectPromptMessages,
    loadBundledLeavePreset,
    syncBundledLeavePresetToggles,
    mergeStreamUsage,
    mapUsageToOpenAI,
    detectRemotePromptMainNarrative,
    detectAuxiliaryOrSubRequest,
    buildLaneSignature,
    findMatchingMainLane,
    computePrefixDiff,
    recomputeRequestLogsCacheGuard,
    buildCacheGuardSessionSummary,
    createRelayServer,
};
