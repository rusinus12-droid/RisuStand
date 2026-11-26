#!/usr/bin/env node
/**
 * RisuStand Remote Relay Server v1.1.0
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

// Kept in sync with VERSION by tools/release_version.cjs
const RELAY_VERSION = '1.1.0';
const ROOT_DIR = __dirname;
const TOKEN_PATH = path.join(ROOT_DIR, '.risustand-token');
const CONFIG_PATH = path.join(ROOT_DIR, '.risustand-config.json');
const PRESETS_PATH = path.join(ROOT_DIR, '.risustand-presets.json');
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
        directPresetId: 'bundled:leave',
        remoteToggleValues: {},
        disabledLoreEntries: {},
        pinnedLoreEntries: {},
        presetToggles: [],
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
                directPresetId: typeof raw.directPresetId === 'string' ? raw.directPresetId : def.directPresetId,
                remoteToggleValues,
                disabledLoreEntries: normalizeStrArrayMap(raw.disabledLoreEntries),
                pinnedLoreEntries: normalizeStrArrayMap(raw.pinnedLoreEntries),
                profiles: Array.isArray(raw.profiles) ? raw.profiles : def.profiles,
                presetToggles: Array.isArray(raw.presetToggles) ? raw.presetToggles : [],
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
const RISUP_DECODE_MAP = RISUP_MAP_BYTES.subarray(256, 512);

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
        const value = {
            id: LEAVE_PRESET_ID,
            name: String((parsed && parsed.name) || 'Leave — Wandering Librarian Engine r1.1'),
            toggleSyntax: String((parsed && parsed.customPromptTemplateToggle) || ''),
            defaultVariables: String((parsed && parsed.templateDefaultVariables) || ''),
            promptTemplate: Array.isArray(parsed && parsed.promptTemplate) ? parsed.promptTemplate : [],
            globalNote: String((parsed && parsed.globalNote) || ''),
            mainPrompt: String((parsed && parsed.mainPrompt) || ''),
            jailbreak: String((parsed && parsed.jailbreak) || ''),
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

function syncBundledLeavePresetToggles(presetToggles) {
    if (!Array.isArray(presetToggles) || !presetToggles.length) return false;
    const leave = loadBundledLeavePreset();
    if (!leave || !leave.toggleSyntax) return false;
    let changed = false;
    for (const pt of presetToggles) {
        if (!pt || pt.id !== LEAVE_PRESET_ID) continue;
        const nextName = '🍃 ' + leave.name;
        if (pt.syntax !== leave.toggleSyntax) {
            pt.syntax = leave.toggleSyntax;
            changed = true;
        }
        if (pt.name !== nextName) {
            pt.name = nextName;
            changed = true;
        }
    }
    return changed;
}

if (syncBundledLeavePresetToggles(config.presetToggles)) {
    saveConfig();
}

let customPresetsCache = null;

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
        globalNote,
        mainPrompt,
        jailbreak,
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
    const turns = [];
    for (const m of Array.isArray(messages) ? messages : []) {
        const txt = normalizeMessageText(m && m.content);
        if (m && m.role === 'system') {
            if (txt) sysParts.push(txt);
            continue;
        }
        const role = m && m.role === 'assistant' ? assistantRole : 'user';
        const last = turns[turns.length - 1];
        if (last && last.role === role) {
            if (txt) last.text = last.text ? `${last.text}\n\n${txt}` : txt;
        } else {
            turns.push({ role, text: txt });
        }
    }
    if (ensureUserFirst) {
        if (!turns.length) turns.push({ role: 'user', text: 'Continue.' });
        else if (turns[0].role !== 'user') turns.unshift({ role: 'user', text: '[Start]' });
    } else if (!turns.length) {
        turns.push({ role: 'user', text: 'Continue.' });
    }
    return { sysParts, turns };
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

function mapUsageToOpenAI(usage) {
    if (!usage || typeof usage !== 'object') {
        return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    }
    if (typeof usage.prompt_tokens === 'number' || typeof usage.completion_tokens === 'number') {
        const prompt = Number(usage.prompt_tokens || 0);
        const completion = Number(usage.completion_tokens || 0);
        return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: Number(usage.total_tokens || (prompt + completion)) };
    }
    if (typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number') {
        const prompt = Number(usage.input_tokens || 0);
        const completion = Number(usage.output_tokens || 0);
        return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
    }
    if (typeof usage.promptTokenCount === 'number' || typeof usage.candidatesTokenCount === 'number') {
        const prompt = Number(usage.promptTokenCount || 0);
        const completion = Number(usage.candidatesTokenCount || 0);
        return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: Number(usage.totalTokenCount || (prompt + completion)) };
    }
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
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

function recordRequestLog(entry) {
    const item = {
        id: `req-${++requestLogSeq}-${crypto.randomBytes(3).toString('hex')}`,
        at: new Date().toISOString(),
        source: entry.source || 'llm',
        profileName: entry.profileName || '',
        providerType: entry.providerType || 'openai_compat',
        model: entry.model || '',
        endpoint: entry.endpoint || '',
        stream: Boolean(entry.stream),
        status: Number(entry.status || 0),
        ok: Boolean(entry.ok),
        durationMs: Math.max(0, Number(entry.durationMs || 0)),
        msgCount: Math.max(0, Number(entry.msgCount || 0)),
        usage: entry.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        headers: entry.headers || {},
        messages: Array.isArray(entry.messages) ? entry.messages : [],
        requestJson: entry.requestJson || '',
        responseText: entry.responseText || '',
        responseJson: entry.responseJson || '',
        error: entry.error || '',
    };
    requestLogs.unshift(item);
    if (requestLogs.length > REQUEST_LOG_MAX) {
        requestLogs.length = REQUEST_LOG_MAX;
    }
    return item;
}

function summarizeRequestLog(entry) {
    const previewSrc = entry.error ? `오류: ${entry.error}` : (entry.responseText || '');
    const responsePreview = String(previewSrc).replace(/\s+/g, ' ').trim().slice(0, 160);
    return {
        id: entry.id,
        at: entry.at,
        source: entry.source,
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
    };
}

async function callLLMNonStream(profile, messages, extraOpts = {}) {
    if (!profile) throw new Error('활성화된 모델 프로필이 없습니다. [모델/번역] 탭에서 프로필을 선택하세요.');

    const startedAt = Date.now();
    const source = extraOpts.source || 'llm';
    const wantStreamFlag = Boolean(extraOpts.stream);
    let logEndpoint = profile.baseUrl || '';
    let logHeaders = {};
    let logBodyObj = null;
    let logStatus = 0;
    let logRespData = null;
    let logModel = profile.model || '';

    const tempVal = extraOpts.forceTemperature !== undefined
        ? extraOpts.forceTemperature
        : (parseOptionalNumber(profile.temperature) ?? parseOptionalNumber(extraOpts.temperature));
    const maxTokVal = extraOpts.forceMaxTokens !== undefined
        ? extraOpts.forceMaxTokens
        : (parseOptionalNumber(profile.maxTokens) ?? parseOptionalNumber(extraOpts.maxTokens));
    const timeoutMs = Number(extraOpts.timeoutMs) || 180000;
    const { signal, cleanup } = createTimeoutSignal(timeoutMs, extraOpts.signal);

    try {
        if (!profile.apiKey && profile.providerType !== 'openai_compat') {
            throw new Error(`프로필 "${profile.name}"의 API 키가 비어 있습니다.`);
        }

        if (profile.providerType === 'anthropic') {
            const { sysParts, turns } = normalizeTurnMessages(messages, { assistantRole: 'assistant', ensureUserFirst: true });
            const body = {
                model: profile.model,
                max_tokens: maxTokVal || 4096,
                messages: turns.map((t) => ({ role: t.role, content: t.text })),
            };
            if (sysParts.length) body.system = sysParts.join('\n\n');
            if (tempVal !== undefined) body.temperature = tempVal;

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
            const body = { contents };
            if (sysParts.length) body.systemInstruction = { parts: [{ text: sysParts.join('\n\n') }] };
            const genCfg = {};
            if (tempVal !== undefined) genCfg.temperature = tempVal;
            if (maxTokVal !== undefined) genCfg.maxOutputTokens = maxTokVal;
            if (Object.keys(genCfg).length) body.generationConfig = genCfg;

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

        const body = {
            model: profile.model,
            messages,
            stream: false,
        };
        if (tempVal !== undefined) body.temperature = tempVal;
        if (maxTokVal !== undefined) body.max_tokens = maxTokVal;

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
            requestJson: safeJsonForLog(body, REQUEST_LOG_BODY_CHAR_LIMIT),
            responseText: truncateLogText(out, REQUEST_LOG_RESP_CHAR_LIMIT),
            responseJson: safeJsonForLog(data, REQUEST_LOG_RESP_CHAR_LIMIT),
            error: '',
        });
        return { text: out, model: logModel, usage: data.usage || null };
    } catch (err) {
        recordRequestLog({
            source,
            profileName: profile.name || '',
            providerType: profile.providerType || 'openai_compat',
            model: logModel,
            endpoint: logEndpoint,
            stream: wantStreamFlag,
            status: logStatus,
            ok: false,
            durationMs: Date.now() - startedAt,
            msgCount: Array.isArray(messages) ? messages.length : 0,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            headers: sanitizeLogHeaders(logHeaders),
            messages: sanitizeLogMessages(messages),
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
                        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                        headers: sanitizeLogHeaders(headers),
                        messages: sanitizeLogMessages(messages),
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
                        if (parsed.usage) streamUsage = parsed.usage;
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
        if (/^#(?:if(?:_pure)?|when|each)(?:\s|$)/i.test(tagInner)) {
            blockDepth += 1;
        } else if (/^\/(?:if|when|each)?$/i.test(tagInner)) {
            if (blockDepth === 0) {
                return { elseStart, elseEnd, endStart: openIdx, endClose: closeIdx };
            }
            blockDepth -= 1;
        } else if (blockDepth === 0 && /^:else$/i.test(tagInner) && elseStart < 0) {
            elseStart = openIdx;
            elseEnd = closeIdx + 2;
        }
        i = closeIdx + 2;
    }
    return null;
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
            // Support either ['var', 'x', 'is', '1'] or ['A', 'is', 'B']
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
            if (op === 'is' || op === '==' || op === 'equal') res = String(lhs) === String(rhs);
            else if (op === 'isnot' || op === '!=' || op === 'notequal') res = String(lhs) !== String(rhs);
            else if (op === '>') res = Number(lhs) > Number(rhs);
            else if (op === '<') res = Number(lhs) < Number(rhs);
            else if (op === '>=') res = Number(lhs) >= Number(rhs);
            else if (op === '<=') res = Number(lhs) <= Number(rhs);
            else res = isCbsTruthy(lhs);
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

function evalPresetCbs(input, ctx = {}, depth = 0) {
    const str = String(input ?? '');
    if (!str.includes('{{') || depth > 24) return str;
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

        const parts = splitCbsTopLevelArgs(inner);
        const rawCmd = parts[0] || '';
        const cmd = (rawCmd.includes('{{') ? evalPresetCbs(rawCmd, ctx, depth + 1) : rawCmd).trim().toLowerCase();
        const args = parts.slice(1).map((a) => evalPresetCbs(a, ctx, depth + 1));

        const gVars = (ctx && ctx.globalVars) || {};
        const cVars = (ctx && ctx.chatVars) || {};

        let replaced = null;
        if (cmd === 'getglobalvar') {
            const k = (args[0] || '').trim();
            if (Object.prototype.hasOwnProperty.call(gVars, k)) replaced = String(gVars[k] ?? '');
            else if (k && !k.startsWith('toggle_') && Object.prototype.hasOwnProperty.call(gVars, `toggle_${k}`)) {
                replaced = String(gVars[`toggle_${k}`] ?? '');
            } else {
                replaced = '';
            }
        } else if (cmd === 'getvar') {
            const k = (args[0] || '').trim();
            if (Object.prototype.hasOwnProperty.call(cVars, k)) replaced = String(cVars[k] ?? '');
            else if (Object.prototype.hasOwnProperty.call(gVars, k)) replaced = String(gVars[k] ?? '');
            else replaced = '';
        } else if (cmd === 'equal') {
            replaced = String(args[0] ?? '') === String(args[1] ?? '') ? '1' : '0';
        } else if (cmd === 'notequal') {
            replaced = String(args[0] ?? '') !== String(args[1] ?? '') ? '1' : '0';
        } else if (cmd === 'any') {
            replaced = args.some(isCbsTruthy) ? '1' : '0';
        } else if (cmd === 'all') {
            replaced = (args.length > 0 && args.every(isCbsTruthy)) ? '1' : '0';
        } else if (cmd === 'and') {
            replaced = (isCbsTruthy(args[0]) && isCbsTruthy(args[1])) ? '1' : '0';
        } else if (cmd === 'or') {
            replaced = (isCbsTruthy(args[0]) || isCbsTruthy(args[1])) ? '1' : '0';
        } else if (cmd === 'not') {
            replaced = isCbsTruthy(args[0]) ? '0' : '1';
        } else if (cmd === 'greater') {
            replaced = Number(args[0]) > Number(args[1]) ? '1' : '0';
        } else if (cmd === 'less') {
            replaced = Number(args[0]) < Number(args[1]) ? '1' : '0';
        } else if (cmd === 'greater_equal') {
            replaced = Number(args[0]) >= Number(args[1]) ? '1' : '0';
        } else if (cmd === 'less_equal') {
            replaced = Number(args[0]) <= Number(args[1]) ? '1' : '0';
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
    pinnedLoreUids = [],
} = {}) {
    const disabledSet = new Set((Array.isArray(disabledLoreUids) ? disabledLoreUids : []).map(String));
    const pinnedSet = new Set((Array.isArray(pinnedLoreUids) ? pinnedLoreUids : []).map(String));
    const parsed = [];
    for (let i = 0; i < (Array.isArray(loreEntries) ? loreEntries.length : 0); i += 1) {
        const raw = loreEntries[i];
        if (!raw || raw.enabled === false || raw.mode === 'folder') continue;
        if (raw.uid && disabledSet.has(String(raw.uid))) continue;
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

            const formatted = raw.comment ? `[${raw.comment}]\n${evaluated}` : evaluated;
            activeMap.set(item.idx, {
                idx: item.idx,
                insertorder: item.insertorder,
                priority: item.priority,
                pos: dec.pos,
                depth: dec.depth,
                role: dec.role,
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
        } else {
            buckets.normal.push(item);
        }
    }
    if (postAssistant.length) buckets.postEverything.push(...postAssistant);
    return buckets;
}

function buildDirectPromptMessages({
    preset = null,
    snap = null,
    historyMessages = [],
    userText = '',
    remoteToggleValues = null,
    disabledLoreUids = [],
    pinnedLoreUids = [],
} = {}) {
    const s = snap || {};
    const rawCtx = s.charContext && typeof s.charContext === 'object'
        ? s.charContext
        : { name: s.charName || 'Character' };

    const globalVars = parsePresetDefaultToggles(
        (preset && (preset.toggleSyntax || preset.customPromptTemplateToggle)) || '',
        (preset && (preset.defaultVariables || preset.templateDefaultVariables)) || ''
    );
    normalizeToggleMapInto(globalVars, s.globalToggleValues);
    normalizeToggleMapInto(globalVars, remoteToggleValues);
    if (s.useLocallySetGlobalVariables) {
        normalizeToggleMapInto(globalVars, s.localToggleValues);
    }

    const chatVars = {};
    if (s.chatVariables && typeof s.chatVariables === 'object' && !Array.isArray(s.chatVariables)) {
        for (const [k, v] of Object.entries(s.chatVariables)) {
            if (k) chatVars[String(k)] = String(v ?? '');
        }
    }

    const baseCtx = {
        globalVars,
        chatVars,
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

    const chatList = (Array.isArray(historyMessages) ? historyMessages : []).map((m) => ({
        role: m && m.role === 'user' ? 'user' : 'assistant',
        content: String((m && (m.raw || m.text)) || ''),
    }));
    if (userText) {
        chatList.push({ role: 'user', content: String(userText) });
    }

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
        };

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

    const msgs = [];
    let sawChatBlock = false;
    let emittedPostEverything = false;

    for (const item of preset.promptTemplate) {
        if (!item || typeof item !== 'object') continue;
        const type = String(item.type || 'plain');

        if (type === 'plain') {
            if (item.type2 === 'globalNote') {
                const gn = resolveGlobalNote(item.text);
                if (gn) msgs.push({ role: mapRole(item.role), content: gn });
                continue;
            }
            let rawText = item.text !== undefined ? String(item.text) : '';
            if (!rawText && item.type2 === 'main') rawText = baseCtx.mainPrompt;
            const evaluated = cleanPresetPromptText(evalPresetCbs(rawText, baseCtx));
            if (evaluated) msgs.push({ role: mapRole(item.role), content: evaluated });
            continue;
        }
        if (type === 'jailbreak') {
            const rawText = item.text !== undefined ? String(item.text) : baseCtx.jailbreak;
            const evaluated = cleanPresetPromptText(evalPresetCbs(rawText, baseCtx));
            if (evaluated) msgs.push({ role: mapRole(item.role), content: evaluated });
            continue;
        }
        if (type === 'persona') {
            if (rawCtx.personaName || baseCtx.personaPrompt) {
                const rawPersona = (item.innerFormat && String(item.innerFormat).includes('{{slot}}'))
                    ? baseCtx.personaPrompt
                    : `[User Persona: ${baseCtx.personaName}]\n${baseCtx.personaPrompt}`;
                const body = applyInnerFormat(item, cleanPresetPromptText(rawPersona));
                if (body) msgs.push({ role: 'system', content: body });
            }
            continue;
        }
        if (type === 'description') {
            const body = applyInnerFormat(item, buildDescText());
            if (body) msgs.push({ role: 'system', content: body });
            continue;
        }
        if (type === 'lorebook') {
            if (normalLoreText) {
                const body = applyInnerFormat(item, cleanPresetPromptText(`[World / Module Lorebook]\n${normalLoreText}`));
                if (body) msgs.push({ role: 'system', content: body });
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
            if (body) msgs.push({ role: mapRole(item.role), content: body });
            continue;
        }
        if (type === 'authornote') {
            if (baseCtx.note) {
                const rawNote = (item.innerFormat && String(item.innerFormat).includes('{{slot}}'))
                    ? baseCtx.note
                    : `[Author's Note]\n${baseCtx.note}`;
                const body = applyInnerFormat(item, cleanPresetPromptText(rawNote));
                if (body) msgs.push({ role: 'system', content: body });
            }
            continue;
        }
        if (type === 'chat') {
            sawChatBlock = true;
            const sliced = sliceChatRange(chatStream, item.rangeStart, item.rangeEnd);
            for (const cm of sliced) {
                if (cm.content || cm.role === 'user') msgs.push({ role: cm.role, content: cm.content });
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

// ================= Direct Remote Chat (for non-PC-active chars) =================
async function runDirectRemoteChat(charIndex, chatIndex, userText, snapView = state.snapshot) {
    const profile = getActiveProfile();
    if (!profile) {
        throw new Error('PC에서 현재 열려있지 않은 봇과 대화하려면 [모델/번역] 탭에서 활성 모델 프로필을 먼저 설정해야 합니다.');
    }
    const snap = snapView || state.snapshot;
    const preset = resolveDirectPreset(config.directPresetId);
    const history = Array.isArray(snap && snap.messages) ? snap.messages.slice(-30) : [];
    const loreKey = getLoreCharKeyFromSnap(snap);
    const msgs = buildDirectPromptMessages({
        preset,
        snap,
        historyMessages: history,
        userText,
        remoteToggleValues: config.remoteToggleValues,
        disabledLoreUids: (config.disabledLoreEntries && config.disabledLoreEntries[loreKey]) || [],
        pinnedLoreUids: (config.pinnedLoreEntries && config.pinnedLoreEntries[loreKey]) || [],
    });

    const finalMsgs = applyPromptOverride(msgs, profile);
    state.directGenerating = true;
    try {
        console.log(`[DirectChat] char#${charIndex} chat#${chatIndex} via ${profile.name} (${profile.model}) preset=${preset ? preset.name : 'off'}`);
        const result = await callLLMNonStream(profile, finalMsgs, { source: 'direct_chat' });
        const appended = [];
        if (userText) appended.push({ role: 'user', data: userText });
        appended.push({ role: 'char', data: result.text });
        queueCommand('append_messages', {
            charIndex,
            chatIndex,
            messages: appended,
        });
        return result.text;
    } finally {
        state.directGenerating = false;
    }
}

async function runDirectRemoteReroll(charIndex, chatIndex, msgIndex, snapView = state.snapshot) {
    const profile = getActiveProfile();
    if (!profile) {
        throw new Error('PC에서 현재 열려있지 않은 봇을 리롤하려면 [모델/번역] 탭에서 활성 모델 프로필을 먼저 설정해야 합니다.');
    }
    const snap = snapView || state.snapshot;
    const preset = resolveDirectPreset(config.directPresetId);
    const prior = (Array.isArray(snap && snap.messages) ? snap.messages : [])
        .filter((m) => m.index < msgIndex)
        .slice(-30);
    const loreKey = getLoreCharKeyFromSnap(snap);
    const msgs = buildDirectPromptMessages({
        preset,
        snap,
        historyMessages: prior,
        userText: '',
        remoteToggleValues: config.remoteToggleValues,
        disabledLoreUids: (config.disabledLoreEntries && config.disabledLoreEntries[loreKey]) || [],
        pinnedLoreUids: (config.pinnedLoreEntries && config.pinnedLoreEntries[loreKey]) || [],
    });

    const finalMsgs = applyPromptOverride(msgs, profile);
    state.directGenerating = true;
    try {
        console.log(`[DirectReroll] char#${charIndex} chat#${chatIndex} msg#${msgIndex} via ${profile.name} (${profile.model}) preset=${preset ? preset.name : 'off'}`);
        const result = await callLLMNonStream(profile, finalMsgs, { source: 'direct_reroll' });
        queueCommand('replace_message_with_swipe', {
            charIndex,
            chatIndex,
            msgIndex,
            newData: result.text,
        });
        return result.text;
    } finally {
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
    padding: calc(8px + env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) 8px max(12px, env(safe-area-inset-left));
    border-bottom:1px solid var(--border); background: var(--header-bg);
    -webkit-backdrop-filter: saturate(160%) blur(14px); backdrop-filter: saturate(160%) blur(14px);
  }
  .h-left { min-width:0; display:flex; align-items:center; gap:10px; flex:1; padding: 2px 4px; margin-left:-4px; border-radius: 10px; }
  .h-left:active { background: var(--accent-soft); }
  .dot { width:8px; height:8px; border-radius:50%; background:#9ca3af; flex-shrink:0; box-shadow: 0 0 0 3px color-mix(in srgb, #9ca3af 22%, transparent); }
  .dot.on { background:#22c55e; box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.22); }
  .h-title { font-weight:700; font-size:15px; letter-spacing:-0.01em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .h-sub { font-size:11.5px; color:var(--sub); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:1px; }
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
    position:absolute; top: calc(100% + 8px); right: max(10px, env(safe-area-inset-right));
    width: min(380px, calc(100vw - 20px));
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
    z-index:6; cursor:pointer; background:transparent; user-select:none;
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
  .book-turn-tag { font-family: var(--ui-font); font-size:11px; color:var(--accent); margin-bottom:6px; font-weight:700; letter-spacing:0.04em; break-after:avoid; }
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
  html body #bookBotOverlay [risu-trigger],
  html body #bookBotOverlay [risu-btn],
  html body #bookBotOverlay label,
  html body #bookBotOverlay button,
  html body #bookBotOverlay a { pointer-events:auto; }
  #bookBotOverlay:empty { display:none; }
  #bookBotOverlay [data-rs-bot-fab="1"] {
    position:fixed !important; top:106px !important; right:12px !important; z-index:25 !important;
    display:flex !important; flex-direction:column !important; align-items:center !important; gap:10px !important;
    margin:0 !important; padding:0 !important;
    transition: transform 0.22s ease, opacity 0.2s ease;
  }
  #bookBotOverlay.bot-menu-collapsed [data-rs-bot-fab="1"] {
    opacity:0 !important; pointer-events:none !important; transform:translateX(90px) !important;
  }
  #botMenuFab {
    position:fixed; right:12px; top:62px; z-index:35;
    display:inline-flex; align-items:center; justify-content:center; gap:5px;
    box-sizing:border-box; height:34px; min-height:34px; min-width:48px; padding:0 12px; margin:0;
    border-radius:999px; border:1px solid var(--border); background:var(--elev); color:var(--text);
    font-size:12px; font-weight:700; line-height:1; letter-spacing:-0.01em; white-space:nowrap;
    cursor:pointer; box-shadow:var(--shadow-sm); opacity:0.78;
    transition: opacity 0.18s ease, background 0.18s ease, border-color 0.18s ease, border-radius 0.18s ease, padding 0.18s ease, width 0.18s ease;
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
  .bot-head { padding:13px 14px; min-height:54px; display:flex; align-items:center; justify-content:space-between; gap:10px; cursor:pointer; }
  .bot-head > div:first-child { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .bot-head > div:last-child { flex-shrink:0; }
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
  .login-mark { width:52px; height:52px; border-radius:16px; display:flex; align-items:center; justify-content:center; font-size:26px; background: var(--accent-soft); margin-bottom:16px; }
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
  @media (max-width: 380px) {
    .h-right { gap:4px; }
    .icon-pill { width:34px; height:34px; }
    .composer .pill { padding:0 8px; }
    .param-grid { grid-template-columns: 1fr 1fr; }
  }
  /* Landscape phones: reclaim vertical space */
  @media (max-height: 500px) and (orientation: landscape) {
    header { padding-top: calc(4px + env(safe-area-inset-top)); padding-bottom:4px; }
    .h-sub { display:none; }
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
    nav.tabbar::before {
      content:'📖'; display:flex; align-items:center; justify-content:center;
      width:44px; height:44px; margin:0 auto 14px; border-radius:14px; font-size:22px;
      background: var(--accent-soft);
    }
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
    #reqLogCard { grid-column: 1 / -1; }
    #tab-bots { --content-w: 760px; }
    .composer { margin-bottom: 16px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }
</style>
</head>
<body class="tab-chat-active">
<div id="toast" role="status" aria-live="polite"></div>
<div id="botBgHost" class="rs-bg-host rs-bot-html"></div>
<div id="bookBotOverlay" class="bot-menu-collapsed"></div>
<button id="botMenuFab" type="button" style="display:none;" title="봇 메뉴 펼치기 / 접기">☰ 메뉴</button>
<div id="triggerModal" style="display:none;" role="dialog" aria-modal="true"></div>
<div id="reqLogModal" style="display:none;" role="dialog" aria-modal="true" aria-label="리퀘스트 로그"></div>
<div id="msgEditModal" style="display:none;" role="dialog" aria-modal="true" aria-label="메시지 수정"></div>

<div id="login">
  <div class="login-card">
    <div class="login-mark">📖</div>
    <h2>RisuStand Remote</h2>
    <p>PC 터미널에 출력된 보안 토큰을 입력하세요.<br>한 번 로그인하면 이 기기에 저장됩니다.</p>
    <input class="f-inp" id="tokInput" type="password" placeholder="보안 토큰 입력" autocomplete="current-password" style="margin-bottom:10px;" />
    <button class="btn" id="loginBtn" style="width:100%; min-height:46px; font-size:14.5px;">접속하기</button>
    <div id="loginErr" style="color:var(--danger); font-size:12.5px; margin-top:10px; min-height:1em;"></div>
  </div>
</div>

<div id="app" style="display:none;">
  <header>
    <div class="h-left" onclick="switchTab('bots')" style="cursor:pointer;" title="봇/채팅방 목록">
      <span class="dot" id="pcDot"></span>
      <div style="min-width:0;">
        <div class="h-title" id="hdrChar">연결 중...</div>
        <div class="h-sub" id="hdrSub">-</div>
      </div>
    </div>
    <div class="h-right">
      <button class="pill icon-pill" id="reqLogQuickBtn" title="리퀘스트 로그 보기" aria-label="리퀘스트 로그">📜</button>
      <button class="pill icon-pill" id="assetCycleBtn" title="에셋 표시 / 가리기 / 감추기" aria-label="에셋 표시 모드">🖼️</button>
      <button class="pill icon-pill" id="autoTrBtn" title="응답 자동 번역" aria-label="응답 자동 번역">🌐</button>
      <button class="pill icon-pill" id="readBarToggle" title="테마·글꼴·에셋 설정" aria-label="화면 설정" aria-expanded="false" style="font-weight:800;">Aa</button>
    </div>

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
      <div class="rb-sec" style="border-top:1px solid var(--border); padding-top:10px;">
        <button class="btn sec" id="logoutBtn" style="width:100%;">🔒 로그아웃 / 토큰 변경</button>
      </div>
    </div>
  </header>

  <!-- TAB 1: CHAT / EPUB READER -->
  <section class="panel active" id="tab-chat"></section>
  <div class="composer" id="composerBar">
    <button class="pill" id="inTrBtn" title="입력 한→영 자동 번역">한→영</button>
    <textarea id="msgInput" rows="1" placeholder="메시지를 입력하세요..."></textarea>
    <button class="send-btn" id="sendBtn">전송</button>
  </div>

  <!-- TAB 2: BOTS & CHATS -->
  <section class="panel" id="tab-bots">
    <div class="panel-title">봇 · 채팅방</div>
    <div style="display:flex; gap:8px;">
      <input class="search-inp" id="botSearch" placeholder="봇 이름 검색..." />
      <button class="btn sec" id="refreshAllBtn" style="flex-shrink:0;">새로고침</button>
    </div>
    <div class="hint" style="margin-top:0;">
      PC RisuAI에 현재 열려 있는 봇만 <b>PC 활성</b>(<code>risuai.sendChat()</code> · 다른 RisuAI 플러그인 정상 작동)으로 동작합니다. PC가 홈 화면이거나 다른 봇을 열어 둔 상태에서는 <b>원격 라우팅</b>(DB 직접 반영)으로 동작하므로 <b>다른 RisuAI 플러그인은 동작하지 않습니다</b>. 대신 <b>[⚡ 모델/번역]</b>의 원격 프롬프트 프리셋과 <b>[🧩 모듈/설정]</b> 토글이 실시간 적용됩니다.
    </div>
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
      <div class="leave-preset-bar">
        <div class="leave-preset-info">
          <b>🍃 Leave · 방랑 사서의 서가 r1.1</b>
          <span>내장 AI 프리셋 토글 · RisuAI 임포트 RISUP · 가이드</span>
        </div>
        <div class="leave-preset-btns">
          <button type="button" class="pill" onclick="installBundledLeaveToggle()">🍃 Leave r1.1 토글 등록</button>
          <button type="button" class="pill" onclick="downloadLeavePreset()">⬇️ RISUP 받기</button>
          <button type="button" class="pill" onclick="openLeavePresetGuide()">📖 가이드</button>
        </div>
      </div>
      <div id="presetToggleAdder" style="display:none; margin-bottom:12px; padding:12px; border-radius:12px; background:var(--bg); border:1px solid var(--border);">
        <div style="font-size:11.5px; color:var(--sub); line-height:1.5; margin-bottom:6px;">
          RisuAI 보안 정책상 프롬프트 프리셋 토글은 플러그인이 직접 읽을 수 없습니다. PC RisuAI 프리셋 설정의 <b>커스텀 토글</b> 텍스트를 아래에 한 번만 붙여넣어 두면, 모든 체크박스·드롭다운이 로컬 토글로 즉시 연동됩니다.
        </div>
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
    <div class="card" id="lorebookCard">
      <h3>
        <span>📚 캐릭터 · 채팅 로어북</span>
        <span class="badge" id="loreCountBadge">0 / 0 반영</span>
      </h3>
      <div class="hint" style="margin-top:0; margin-bottom:8px;">
        기본적으로 모든 로어북이 <b>체크(반영 대상)</b>되어 있으며, 체크를 해제한 로어북만 요청에서 제외됩니다. 키워드 로어북은 <b>📌 고정</b>으로 키워드와 무관하게 강제 포함할 수도 있습니다.
      </div>
      <div style="display:flex; gap:6px; margin-bottom:8px;">
        <input class="search-inp" id="loreSearch" placeholder="로어북 제목 · 키워드 · 내용 검색..." />
        <button type="button" class="btn sec" id="loreRefreshBtn" style="flex-shrink:0;">🔄</button>
      </div>
      <div id="loreFilters" style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:8px;">
        <button type="button" class="pill active" data-lore-src="all">전체</button>
        <button type="button" class="pill" data-lore-src="char">캐릭터</button>
        <button type="button" class="pill" data-lore-src="local">이 방</button>
        <button type="button" class="pill" data-lore-src="module">모듈</button>
        <span style="flex:1;"></span>
        <button type="button" class="pill" id="loreEnableAllBtn">전체 반영</button>
        <button type="button" class="pill" id="loreExcludeShownBtn">표시 제외</button>
      </div>
      <div id="loreList" style="display:flex; flex-direction:column; gap:8px; max-height:420px; overflow-y:auto;"></div>
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
      <div class="hint" id="directPresetHint" style="margin-top:6px;">
        PC에서 <code>risuai.sendChat()</code>을 쓸 수 없는 상태(<code>원격 라우팅</code>)에서는 DB 직접 반영으로 동작하므로 <b>다른 RisuAI 플러그인은 동작하지 않습니다</b>. 대신 <b>원격 직접 요청(원격채팅 · 원격리롤)</b>에 이 프리셋의 프롬프트 구조와 <b>[🧩 모듈/설정]</b> 탭 토글을 실시간 CBS로 반영합니다. (다른 플러그인까지 쓰려면 PC RisuAI에서 해당 봇을 열어 <b>PC 활성</b> 상태로 사용해 주세요.)
      </div>
      <div class="btn-row">
        <button type="button" class="btn sec" id="directPresetUploadBtn">+ .risup / .json 업로드</button>
        <input type="file" id="directPresetFile" accept=".risup,.json" style="display:none;" />
        <button type="button" class="btn danger" id="directPresetDelBtn" style="display:none; margin-left:auto;">삭제</button>
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
        PC RisuAI 프록시(<code>/v1/chat/completions</code>), 원격 직접 채팅/리롤, 번역기에서 나간 최근 40건의 요청·응답 로그를 서버 메모리에 보관합니다. API 키와 인증 토큰은 자동 마스킹됩니다.
      </div>
      <div class="req-log-filters" id="reqLogFilters">
        <button type="button" class="pill active" data-log-filter="all">전체</button>
        <button type="button" class="pill" data-log-filter="proxy">프록시</button>
        <button type="button" class="pill" data-log-filter="direct">원격 채팅/리롤</button>
        <button type="button" class="pill" data-log-filter="translate">번역</button>
      </div>
      <div id="reqLogList" class="req-log-list"><div style="font-size:12.5px; color:var(--sub);">아직 기록된 요청이 없습니다.</div></div>
    </div>
  </section>

  <nav class="tabbar">
    <button class="tab-btn active" data-tab="chat" onclick="switchTab('chat')"><span class="ic">📖</span>독서/채팅</button>
    <button class="tab-btn" data-tab="bots" onclick="switchTab('bots')"><span class="ic">📚</span>봇/방</button>
    <button class="tab-btn" data-tab="modules" onclick="switchTab('modules')"><span class="ic">🧩<span class="nd"></span></span>모듈/설정</button>
    <button class="tab-btn" data-tab="router" onclick="switchTab('router')"><span class="ic">⚡</span>모델/번역</button>
  </nav>
</div>

<script>
  const AI_PROVIDERS = ${JSON.stringify(Object.values(AI_PROVIDER_PRESETS)).replace(/<\//g, '<\\/')};
  let token = localStorage.getItem('rs_token') || '';
  let currentTab = 'chat';
  let lastState = null;
  let routerCfg = null;
  let expandedBotIdx = -1;
  let lastChatRenderSig = '';
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
  };
  const openToggleGroups = new Set();

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
    localStorage.setItem('rs_theme', uiPref.theme);
    localStorage.setItem('rs_font', uiPref.font);
    localStorage.setItem('rs_fsize', String(uiPref.fsize));
    localStorage.setItem('rs_lh', String(uiPref.lh));
    localStorage.setItem('rs_asset_mode', uiPref.assetMode);
    localStorage.setItem('rs_rich_html', uiPref.richHtml ? '1' : '0');
  }
  document.getElementById('richHtmlBtn').onclick = () => {
    uiPref.richHtml = !uiPref.richHtml;
    applyUiPrefs();
    renderChat();
    toast('봇 정규식 UI: ' + (uiPref.richHtml ? '켜짐' : '꺼짐'));
  };
  window.toggleImgReveal = (el) => { if (el) el.classList.toggle('revealed'); };
  window.setAssetMode = (mode) => {
    uiPref.assetMode = mode;
    applyUiPrefs();
    if (lastState) applyState(lastState);
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
    applyUiPrefs();
    renderChat();
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

  function sanitizeBotNode(node) {
    const kids = Array.from(node.childNodes || []);
    for (const ch of kids) {
      if (ch.nodeType === 8) {
        node.removeChild(ch);
        continue;
      }
      if (ch.nodeType !== 1) continue;
      const tag = (ch.tagName || '').toLowerCase();
      if (tag === 'script' || tag === 'iframe' || tag === 'object' || tag === 'embed' || tag === 'applet' || tag === 'base' || tag === 'meta' || tag === 'link' || tag === 'form') {
        node.removeChild(ch);
        continue;
      }
      if (tag === 'style') {
        ch.textContent = scopeBotCss(sanitizeBotCss(ch.textContent || ''));
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
      sanitizeBotNode(ch);
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

  function syncBotBackground(bgHtml, assetMap) {
    const host = document.getElementById('botBgHost');
    if (!host) return;
    const raw = uiPref.richHtml ? String(bgHtml || '') : '';
    const sig = raw ? (hashStr(raw) + ':' + Object.keys(assetMap || {}).length) : '';
    if (sig === lastBgHtmlSig) return;
    lastBgHtmlSig = sig;
    host.innerHTML = raw ? renderBotRichHtml(raw, assetMap) : '';
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
      await api('/api/command', {
        method: 'POST',
        body: JSON.stringify({
          type: 'run_trigger',
          payload: {
            charIndex: ev.charIndex,
            chatIndex: ev.chatIndex,
            trigger: ev.trigger,
            promptAnswers: baseAnswers.concat([String(ans)]),
          },
        }),
      });
      toast('적용 중...');
      setTimeout(pollState, 300);
      setTimeout(pollState, 850);
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
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (updPolling) { clearInterval(updPolling); updPolling = null; }
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

  function switchTab(tab) {
    currentTab = tab;
    document.body.classList.toggle('tab-chat-active', tab === 'chat');
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.getElementById('tab-' + tab).classList.add('active');
    document.querySelector('.tab-btn[data-tab="' + tab + '"]').classList.add('active');
    document.getElementById('composerBar').style.display = tab === 'chat' ? 'flex' : 'none';
    if (tab === 'chat' && isBookMode()) setTimeout(() => layoutBookSpreads(false), 30);
    syncBotMenuVisibility();
    if (tab === 'router') { loadRouterConfig(); if (typeof loadRequestLogs === 'function') loadRequestLogs(); }
    if (tab === 'bots') {
      renderBots();
      if (Date.now() - lastBotsSyncAt > 4000) {
        lastBotsSyncAt = Date.now();
        api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'sync_all' }) }).catch(() => {});
      }
    }
    if (tab === 'modules') { renderModules(); refreshUpdateStatus(); }
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

  function applyState(st) {
    lastState = st;
    const snap = st.snapshot || {};
    document.getElementById('pcDot').className = 'dot' + (st.pcConnected ? ' on' : '');
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
    const msgDigest = hashStr(msgs.map((m) => m.index + ':' + (m.text || '') + ':' + (m.html || '') + ':' + (m.swipeCount || 1) + ':' + (m.swipeIndex || 0) + ':' + (m.images ? m.images.length : 0)).join('\\x01'));
    const sig = JSON.stringify([snap.charIndex, snap.chatIndex, snap.fmIndex, snap.firstMessageCount, snap.greetingControls || [], snap.backgroundHtml || '', hashStr(snap.botWidgetHtml || ''), Object.keys(snap.assetMap || {}).length, msgs.length, msgDigest, uiPref.theme, uiPref.assetMode, uiPref.richHtml]);
    if (sig !== lastChatRenderSig) {
      lastChatRenderSig = sig;
      try { renderChat(); }
      catch (err) { console.error('[RisuStand UI] chat render failed:', err); }
    }
    if (currentTab === 'bots') renderBots();
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
    return acts ? '<div class="msg-actions" style="flex-wrap:wrap; align-items:center;">' + acts + '</div>' : '';
  }

  function renderBookContent(msgs, snap) {
    if (!msgs || !msgs.length) return '<div style="color:var(--sub); font-size:13px; text-align:center; margin-top:30px;">대화가 비어 있습니다.</div>';
    const lastIdx = Number(snap.totalMessages || 0) - 1;
    let out = '';
    for (let mi = 0; mi < msgs.length; mi++) {
      const m = msgs[mi];
      const isUser = m.role === 'user';
      const key = snap.charIndex + ':' + snap.chatIndex + ':' + m.index;
      const trText = localTranslations.get(key);
      const showTr = shownTranslations.has(key);
      const useRich = uiPref.richHtml && m.html;
      const bodyHtml = (showTr && trText)
        ? esc(trText)
        : (useRich ? '<div class="rs-bot-html">' + renderBotRichHtml(m.html, snap.assetMap) + '</div>' : renderInlineBody(m.text, m.images));
      const isLatestChar = m.index >= 0 && !isUser && (m.index === lastIdx || (lastIdx < 0 && mi === msgs.length - 1));
      out += '<div class="' + (isUser ? 'book-user-block' : 'book-char-block') + '">';
      out += '<div class="book-turn-tag">' + esc(isUser ? '나' : displayBotName(snap.charName)) + '</div>';
      out += '<div>' + bodyHtml + '</div>';
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
    if (fabCol.offsetWidth >= 42 && fabCol.offsetWidth <= 72) {
      fab.style.setProperty('--bot-fab-w', fabCol.offsetWidth + 'px');
    } else {
      fab.style.removeProperty('--bot-fab-w');
    }
    fab.style.display = 'inline-flex';
    overlay.classList.toggle('bot-menu-collapsed', !botMenuExpanded);
    fab.classList.toggle('expanded', botMenuExpanded);
    fab.innerHTML = botMenuExpanded
      ? '<span class="bmf-ic">▸</span><span class="bmf-lb">접기</span>'
      : '<span class="bmf-ic">☰</span><span class="bmf-lb">메뉴</span>';
  }

  function scheduleBotMenuAutoHide() {
    if (botMenuAutoTimer) { clearTimeout(botMenuAutoTimer); botMenuAutoTimer = null; }
  }

  document.getElementById('botMenuFab').onclick = () => {
    botMenuExpanded = !botMenuExpanded;
    syncBotMenuVisibility();
    if (botMenuExpanded) scheduleBotMenuAutoHide();
    else if (botMenuAutoTimer) { clearTimeout(botMenuAutoTimer); botMenuAutoTimer = null; }
  };

  function hoistBotFixedWidgets(rootEl) {
    const overlay = document.getElementById('bookBotOverlay');
    if (!overlay || !rootEl) return;
    overlay.innerHTML = '';

    const extractFixedFromContainer = (container) => {
      if (!container) return;
      let hasFixed = false;
      container.querySelectorAll('style').forEach((st) => {
        if (/position\\s*:\\s*fixed/i.test(st.textContent || '')) hasFixed = true;
      });
      if (!hasFixed) {
        for (const ch of Array.from(container.children)) {
          const tag = (ch.tagName || '').toLowerCase();
          if (tag === 'div' && /(?:buttons-container|side-panel|overlay|floating)/i.test(ch.className || '')) {
            const stAttr = ch.getAttribute('style') || '';
            if (/position\\s*:\\s*fixed/i.test(stAttr) || /(?:buttons-container|floating)/i.test(ch.className || '')) {
              hasFixed = true;
              break;
            }
          }
        }
      }
      if (!hasFixed) return;
      const hostWrap = document.createElement('div');
      hostWrap.className = 'rs-bot-html';
      let moved = false;
      for (const ch of Array.from(container.children)) {
        const tag = (ch.tagName || '').toLowerCase();
        if (tag === 'style' && /position\\s*:\\s*fixed/i.test(ch.textContent || '')) {
          hostWrap.appendChild(ch.cloneNode(true));
        } else if (
          (tag === 'input' && (ch.type === 'checkbox' || ch.type === 'radio')) ||
          (tag === 'div' && /(?:buttons-container|side-panel|overlay|floating)/i.test(ch.className || ''))
        ) {
          if (tag === 'div' && /(?:buttons-container|floating)/i.test(ch.className || '')) {
            ch.setAttribute('data-rs-bot-fab', '1');
          }
          hostWrap.appendChild(ch);
          moved = true;
        }
      }
      if (moved) overlay.appendChild(hostWrap);
    };

    rootEl.querySelectorAll('.rs-bot-html').forEach(extractFixedFromContainer);

    const snap = (lastState && lastState.snapshot) || null;
    if (uiPref.richHtml && snap && !overlay.querySelector('[data-rs-bot-fab="1"]')) {
      if (snap.botWidgetHtml) {
        const tmp = document.createElement('div');
        tmp.className = 'rs-bot-html';
        tmp.innerHTML = renderBotRichHtml(snap.botWidgetHtml, snap.assetMap);
        extractFixedFromContainer(tmp);
      }
      if (!overlay.querySelector('[data-rs-bot-fab="1"]') && snap.backgroundHtml && /(?:buttons-container|side-panel|floating)/i.test(snap.backgroundHtml)) {
        const bgHost = document.getElementById('botBgHost');
        if (bgHost) {
          bgHost.querySelectorAll('input[type="checkbox"], input[type="radio"], .buttons-container, .side-panel, .overlay, .floating').forEach((n) => n.remove());
        }
        const tmpBg = document.createElement('div');
        tmpBg.className = 'rs-bot-html';
        tmpBg.innerHTML = renderBotRichHtml(snap.backgroundHtml, snap.assetMap);
        extractFixedFromContainer(tmpBg);
      }
    }

    let mayHaveFixedCover = Boolean(rootEl.querySelector('.rs-bot-html [style*="fixed" i]'));
    if (!mayHaveFixedCover) {
      rootEl.querySelectorAll('.rs-bot-html style').forEach((st) => {
        if (/position\\s*:\\s*fixed/i.test(st.textContent || '')) mayHaveFixedCover = true;
      });
    }
    if (mayHaveFixedCover && typeof window.getComputedStyle === 'function') {
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      rootEl.querySelectorAll('.rs-bot-html *').forEach((el) => {
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

  function renderChat() {
    const box = document.getElementById('tab-chat');
    const overlay = document.getElementById('bookBotOverlay');
    const snap = (lastState && lastState.snapshot) || {};
    const msgs = snap.messages || [];
    const checkedBotIds = captureCheckedBotIds();

    if (isBookMode()) {
      if (overlay) overlay.innerHTML = '';
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
      document.getElementById('bookTapPrev').onclick = () => flipBook(-1);
      document.getElementById('bookTapNext').onclick = () => flipBook(1);
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
        if (!bookImgPreviewState.pinned) closeBookImgPreview(false);
      };
      frame.addEventListener('click', (e) => {
        const ic = e.target.closest('.book-columns .rs-bot-html .image-container');
        if (!ic) {
          if (bookImgPreviewState.pinned && !e.target.closest('#bookImgPreview')) closeBookImgPreview(false);
          return;
        }
        if (document.body.classList.contains('asset-blur') && !ic.classList.contains('revealed')) return;
        e.stopPropagation();
        if (bookImgPreviewState.el === ic && bookImgPreviewState.pinned) closeBookImgPreview(false);
        else openBookImgPreview(ic, true);
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
    if (overlay) overlay.innerHTML = '';
    const prevScrollTop = box.scrollTop;
    const nearBottom = box.scrollHeight - prevScrollTop - box.clientHeight < 140;
    const autoTr = Boolean(routerCfg && routerCfg.translator && routerCfg.translator.autoTranslateOutput);

    let html = '';
    if (!msgs.length) {
      html += '<div class="empty-hint"><span class="big">💬</span>대화가 비어 있습니다.<br>아래에서 메시지를 보내 시작해 보세요.</div>';
    } else {
      const lastIdx = Number(snap.totalMessages || 0) - 1;
      for (let mi = 0; mi < msgs.length; mi++) {
        const m = msgs[mi];
        const key = snap.charIndex + ':' + snap.chatIndex + ':' + m.index;
        const isUser = m.role === 'user';
        const trText = localTranslations.get(key);
        const showTr = shownTranslations.has(key) || (autoTr && !isUser && trText);
        const useRich = uiPref.richHtml && m.html;
        const bodyHtml = useRich
          ? '<div class="rs-bot-html">' + renderBotRichHtml(m.html, snap.assetMap) + '</div>'
          : renderInlineBody(m.text, m.images);
        const isLatestChar = m.index >= 0 && !isUser && (m.index === lastIdx || (lastIdx < 0 && mi === msgs.length - 1));
        html += '<div class="msg-wrap ' + (isUser ? 'user' : 'char') + '">';
        html += '<div class="msg-role">' + esc(isUser ? '나' : displayBotName(snap.charName)) + '</div>';
        html += '<div class="msg-bubble">' + bodyHtml + '</div>';
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

  async function handleBotWidgetClick(e) {
    if (document.getElementById('bookBotOverlay').contains(e.target) && botMenuExpanded) {
      scheduleBotMenuAutoHide();
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
      await api('/api/command', {
        method: 'POST',
        body: JSON.stringify({
          type: 'run_trigger',
          payload: { charIndex: snap.charIndex, chatIndex: snap.chatIndex, trigger: trig, promptAnswers: [] },
        }),
      });
      toast('메뉴 실행 중...');
      setTimeout(pollState, 350);
      setTimeout(pollState, 900);
      setTimeout(pollState, 1600);
      return true;
    }
    const btnEl = e.target.closest('[risu-btn]');
    if (btnEl) {
      e.preventDefault();
      e.stopPropagation();
      const snap = lastState && lastState.snapshot;
      const txt = (btnEl.getAttribute('risu-btn') || btnEl.textContent || '').trim();
      if (!snap || snap.charIndex < 0 || !txt) return true;
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

  function renderBots(force = false) {
    const listEl = document.getElementById('botList');
    const q = (document.getElementById('botSearch').value || '').trim().toLowerCase();
    const chars = (lastState && lastState.catalog && lastState.catalog.characters) || [];
    const curChar = lastState && lastState.snapshot ? lastState.snapshot.charIndex : -1;
    const curChat = lastState && lastState.snapshot ? lastState.snapshot.chatIndex : -1;
    const filtered = chars.filter((c) => !q || String(c.name).toLowerCase().includes(q));
    const sig = JSON.stringify([q, curChar, curChat, expandedBotIdx, filtered.map((c) => [c.index, c.chaId || '', c.name, c.isPcActive, (c.chats || []).map((ch) => [ch.index, ch.id || '', ch.name, ch.msgCount])])]);
    if (!force && sig === lastBotsRenderSig) return;
    lastBotsRenderSig = sig;
    if (!filtered.length) {
      listEl.innerHTML = '<div class="empty-hint"><span class="big">📚</span>표시할 봇이 없습니다.<br>PC RisuStand의 원격 브릿지가 켜져 있는지 확인하세요.</div>';
      return;
    }
    let html = '';
    for (const c of filtered) {
      const open = expandedBotIdx === c.index || (expandedBotIdx === -1 && c.index === curChar);
      html += '<div class="bot-item"><div class="bot-head" data-toggle-bot="' + c.index + '">';
      html += '<div style="font-weight:700; font-size:14.5px;">' + esc(c.name) + '</div><div style="display:flex; gap:5px; align-items:center;">';
      if (c.isPcActive) html += '<span class="badge pc">PC 활성</span>';
      html += '<span class="badge">방 ' + (c.chats ? c.chats.length : 0) + '</span></div></div>';
      if (open) {
        html += '<div class="chat-list"><button class="btn sec" style="width:100%; margin-bottom:4px;" data-create-chat="' + c.index + '">＋ 새 채팅방 파기</button>';
        for (const ch of (c.chats || [])) {
          const isCur = c.index === curChar && ch.index === curChat;
          html += '<div class="chat-row' + (isCur ? ' cur' : '') + '" data-sel-char="' + c.index + '" data-sel-chat="' + ch.index + '"><span>' + esc(ch.name) + '</span><span class="badge">' + ch.msgCount + '턴</span></div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    listEl.innerHTML = html;
  }
  document.getElementById('botList').addEventListener('click', (e) => {
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
      const line = rawLine.replace(/\\r$/, '');
      const parts = line.split('=');
      const key = parts[0] || '';
      const value = parts[1] || '';
      const type = parts[2] || '';
      const option = parts.slice(3).join('=');
      if (type === 'group' || type === 'groupEnd' || type === 'divider') {
        items.push({ key, value, type, children: [] });
      } else if (type === 'caption' && value) {
        items.push({ key, value, type });
      } else if (key && value) {
        items.push({
          key,
          value,
          type: (type === 'select' || type === 'text' || type === 'textarea') ? type : 'check',
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

  window.togglePresetAdder = (forceState) => {
    const el = document.getElementById('presetToggleAdder');
    const show = forceState !== undefined ? forceState : (el.style.display === 'none');
    el.style.display = show ? 'block' : 'none';
  };

  window.savePresetToggle = async () => {
    const name = document.getElementById('ptName').value.trim() || '프롬프트 프리셋';
    const syntax = document.getElementById('ptSyntax').value.trim();
    if (!syntax) return toast('커스텀 토글 텍스트를 붙여넣어 주세요.');
    if (!routerCfg) routerCfg = await api('/api/router/config');
    if (!Array.isArray(routerCfg.presetToggles)) routerCfg.presetToggles = [];
    routerCfg.presetToggles.push({ id: 'pt-' + Date.now(), name, enabled: true, syntax });
    routerCfg = await api('/api/router/config', { method: 'POST', body: JSON.stringify(routerCfg) });
    document.getElementById('ptName').value = '';
    document.getElementById('ptSyntax').value = '';
    togglePresetAdder(false);
    renderCustomToggles(true);
    toast('프리셋 토글 등록됨');
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
      const entry = {
        id: data.id || 'preset-leave-r1.1',
        name: '🍃 ' + (data.name || 'Leave · 방랑 사서의 서가 r1.1'),
        enabled: true,
        syntax: data.toggleSyntax,
      };
      const idx = routerCfg.presetToggles.findIndex((x) => x && x.id === entry.id);
      if (idx >= 0) routerCfg.presetToggles[idx] = entry;
      else routerCfg.presetToggles.unshift(entry);
      routerCfg = await api('/api/router/config', { method: 'POST', body: JSON.stringify(routerCfg) });
      renderCustomToggles(true);
      toast('🍃 Leave r1.1 프리셋 토글이 등록되었습니다');
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

  function renderCustomToggles(force = false) {
    const snap = (lastState && lastState.snapshot) || {};
    const modBlocks = (snap.customToggleBlocks || []).map((b) => ({ source: b.source, syntax: b.syntax, isPreset: false }));
    const presetBlocks = ((routerCfg && routerCfg.presetToggles) || []).filter((p) => p.enabled !== false).map((p) => ({ id: p.id, source: p.name, syntax: p.syntax, isPreset: true }));
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
    const sig = JSON.stringify([snap.charIndex, snap.chatIndex, useLocal, vals, blocks.map((b) => (b.id || '') + ':' + b.source + ':' + b.syntax.length), Array.from(openToggleGroups)]);
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
      body.innerHTML = '<div style="color:var(--sub); font-size:12.5px;">표시할 토글이 없습니다. 프리셋 토글은 우측 상단 <b>+ 프리셋 토글</b>로 한 번만 등록해 주세요.</div>';
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
      if (b.isPreset) html += '<button class="act-btn" data-del-preset="' + esc(b.id) + '">삭제</button>';
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
  let loreCache = { charKey: '', charIndex: -1, chatIndex: -1, disabledUids: [], pinnedUids: [], entries: [] };
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

  async function saveLoreSelection(charKey, disabledUids, pinnedUids) {
    const res = await api('/api/lorebook/selection', {
      method: 'POST',
      body: JSON.stringify({ charKey, disabledUids, pinnedUids }),
    });
    if (res) {
      loreCache.disabledUids = Array.isArray(res.disabledUids) ? res.disabledUids : [];
      loreCache.pinnedUids = Array.isArray(res.pinnedUids) ? res.pinnedUids : [];
    }
    renderLorebookList();
  }

  function renderLorebookList() {
    const listEl = document.getElementById('loreList');
    const badgeEl = document.getElementById('loreCountBadge');
    if (!listEl) return;
    document.querySelectorAll('#loreFilters [data-lore-src]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-lore-src') === loreSrcFilter);
    });
    const entries = Array.isArray(loreCache.entries) ? loreCache.entries : [];
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
        (entries.length ? '검색·필터 조건에 맞는 로어북이 없습니다.' : '표시할 캐릭터 · 채팅 로어북이 없습니다.') +
        '</div>';
      return;
    }
    const srcLabel = (s) => (s === 'char' ? '캐릭터' : (s === 'local' ? '이 방' : '모듈'));
    listEl.innerHTML = visible.map((e, idx) => {
      const checked = !disSet.has(e.uid);
      const pinned = pinSet.has(e.uid);
      const title = e.comment || e.key || ('로어북 #' + (idx + 1));
      const trigText = e.alwaysActive ? '상시' : ('키워드: ' + (e.key || '(없음)'));
      return '<div style="padding:10px 12px; border-radius:12px; border:1px solid ' + (checked ? 'var(--border)' : 'color-mix(in srgb, var(--border) 60%, transparent)') + '; background:var(--bg); opacity:' + (checked ? '1' : '0.62') + ';">' +
        '<div style="display:flex; align-items:flex-start; justify-content:space-between; gap:8px;">' +
          '<div style="min-width:0; flex:1;">' +
            '<div style="font-size:13px; font-weight:700; word-break:break-word;">' + esc(title) + '</div>' +
            '<div style="display:flex; gap:4px; flex-wrap:wrap; margin-top:4px; align-items:center;">' +
              '<span class="badge">' + esc(srcLabel(e.source)) + (e.sourceName && e.source === 'module' ? ' · ' + esc(e.sourceName) : '') + '</span>' +
              '<span class="badge' + (e.alwaysActive ? ' pc' : '') + '">' + esc(trigText) + '</span>' +
              (e.decorator ? '<span class="badge">' + esc(e.decorator) + '</span>' : '') +
              '<span style="font-size:11px; color:var(--sub);">' + Number(e.charLen || 0) + '자</span>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">' +
            (!e.alwaysActive ? '<button type="button" class="pill' + (pinned ? ' active' : '') + '" style="min-height:28px; padding:0 8px; font-size:11.5px;" data-lore-pin="' + esc(e.uid) + '" title="키워드가 없어도 항상 포함">' + (pinned ? '📌 고정' : '고정') + '</button>' : '') +
            '<input type="checkbox" ' + (checked ? 'checked' : '') + ' data-lore-chk="' + esc(e.uid) + '" title="이 로어북 반영 여부" />' +
          '</div>' +
        '</div>' +
        '<details style="margin-top:6px;">' +
          '<summary style="cursor:pointer; font-size:11.5px; color:var(--sub);">내용 확인</summary>' +
          '<div style="margin-top:6px; padding:8px; border-radius:8px; background:var(--surface); font-size:12px; white-space:pre-wrap; word-break:break-word; max-height:180px; overflow-y:auto; line-height:1.5;">' + esc(e.content || '') + '</div>' +
        '</details>' +
      '</div>';
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
        pinnedUids: Array.isArray(res.pinnedUids) ? res.pinnedUids : [],
        entries: Array.isArray(res.entries) ? res.entries : [],
      };
      renderLorebookList();
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
      toast('모든 로어북 반영으로 설정됨');
      return;
    }
    if (e.target.id === 'loreExcludeShownBtn') {
      if (!loreCache.charKey) return;
      const q = (document.getElementById('loreSearch').value || '').trim().toLowerCase();
      const dis = new Set(loreCache.disabledUids || []);
      for (const item of loreCache.entries || []) {
        if (loreSrcFilter !== 'all' && item.source !== loreSrcFilter) continue;
        if (q && !String(item.comment || '').toLowerCase().includes(q) && !String(item.key || '').toLowerCase().includes(q) && !String(item.content || '').toLowerCase().includes(q)) continue;
        dis.add(item.uid);
      }
      await saveLoreSelection(loreCache.charKey, Array.from(dis), loreCache.pinnedUids);
      toast('표시 중인 로어북 제외됨');
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

  function renderModules(force = false) {
    renderCustomToggles(false);
    renderChatVariables(force);
    renderAuthorNoteAndCharContext(force);
    loadLorebookList(false);
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
    document.getElementById('profileList').innerHTML = (routerCfg.profiles || []).map((p) => {
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
          : 'PC에서 <code>risuai.sendChat()</code>을 쓸 수 없는 상태(<code>원격 라우팅</code>)에서는 DB 직접 반영으로 동작하므로 <b>다른 RisuAI 플러그인은 동작하지 않습니다</b>. 대신 <b>원격 직접 요청(원격채팅 · 원격리롤)</b>에 이 프리셋과 <b>[🧩 모듈/설정]</b> 탭 토글을 실시간 CBS로 반영합니다. (다른 플러그인까지 쓰려면 PC RisuAI에서 해당 봇을 열어 <b>PC 활성</b> 상태로 사용해 주세요.)';
      }
    }
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
    routerCfg = await api('/api/router/config', { method: 'POST', body: JSON.stringify(routerCfg) });
    document.getElementById('profileEditor').style.display = 'none';
    renderRouterUI();
    toast('프로필 삭제됨');
  };
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
  let reqLogFilter = 'all';
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

  function filterRequestLogs(list) {
    const arr = Array.isArray(list) ? list : [];
    if (reqLogFilter === 'proxy') return arr.filter((x) => x.source === 'proxy');
    if (reqLogFilter === 'direct') return arr.filter((x) => x.source === 'direct_chat' || x.source === 'direct_reroll');
    if (reqLogFilter === 'translate') return arr.filter((x) => x.source === 'translate');
    return arr;
  }

  function buildRequestLogRowsHtml(list) {
    const filtered = filterRequestLogs(list);
    if (!filtered.length) {
      return '<div style="font-size:12.5px; color:var(--sub); padding:8px 2px;">' +
        (reqLogsCache.length ? '선택한 필터에 해당하는 로그가 없습니다.' : '아직 기록된 요청이 없습니다.') +
        '</div>';
    }
    return filtered.map((item) => {
      const u = item.usage || {};
      const tokText = u.total_tokens ? ('토큰 ' + u.total_tokens + ' (' + (u.prompt_tokens || 0) + '→' + (u.completion_tokens || 0) + ')') : '';
      const statusText = item.status ? ('HTTP ' + item.status) : (item.ok ? 'OK' : 'ERR');
      return '<button type="button" class="req-log-row" data-log-id="' + esc(item.id) + '">' +
        '<div class="req-log-row-top">' +
          '<span class="req-log-badge ' + (item.ok ? 'ok' : 'err') + '">' + (item.ok ? '✓ ' : '⚠ ') + esc(statusText) + '</span>' +
          '<span class="req-log-badge src">' + esc(formatLogSource(item.source)) + (item.stream ? ' · stream' : '') + '</span>' +
          '<span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(item.model || item.profileName || 'Unknown') + '</span>' +
          '<span style="margin-left:auto; font-size:11.5px; font-weight:500; color:var(--sub);">' + esc(formatLogTime(item.at)) + '</span>' +
        '</div>' +
        '<div class="req-log-row-meta">' +
          '<span>' + esc(formatLogDuration(item.durationMs)) + '</span>' +
          '<span>메시지 ' + Number(item.msgCount || 0) + '개</span>' +
          (tokText ? '<span>' + esc(tokText) + '</span>' : '') +
          (item.profileName ? '<span>프로필: ' + esc(item.profileName) + '</span>' : '') +
        '</div>' +
        (item.responsePreview ? '<div class="req-log-row-prev">' + esc(item.responsePreview) + '</div>' : '') +
      '</button>';
    }).join('');
  }

  function renderRequestLogsList() {
    const el = document.getElementById('reqLogList');
    if (el) el.innerHTML = buildRequestLogRowsHtml(reqLogsCache);
    document.querySelectorAll('#reqLogFilters [data-log-filter]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-log-filter') === reqLogFilter);
    });
  }

  async function loadRequestLogs() {
    try {
      const res = await api('/api/logs');
      reqLogsCache = Array.isArray(res && res.logs) ? res.logs : [];
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
          '</div>' +
          '<div class="req-log-body">' +
            '<div class="req-log-list" style="max-height:none;">' + buildRequestLogRowsHtml(reqLogsCache) + '</div>' +
          '</div>' +
        '</div>';
      modal.style.display = 'flex';
      return;
    }

    const d = reqLogActiveDetail;
    const msgs = Array.isArray(d.messages) ? d.messages : [];
    const u = d.usage || {};
    const statusText = d.status ? ('HTTP ' + d.status) : (d.ok ? 'OK' : 'ERR');
    let tabBody = '';
    if (reqLogDetailTab === 'messages') {
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
          '<div class="req-log-meta-item"><b>토큰 사용량</b><span>' + esc('총 ' + (u.total_tokens || 0) + ' (입력 ' + (u.prompt_tokens || 0) + ' / 출력 ' + (u.completion_tokens || 0) + ')') + '</span></div>' +
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
    reqLogActiveDetail = null;
    renderRequestLogsList();
    if (reqLogModalOpen) renderReqLogModal();
    toast('리퀘스트 로그를 비웠습니다');
  }

  document.getElementById('reqLogQuickBtn').onclick = openRequestLogModal;
  document.getElementById('reqLogRefreshBtn').onclick = loadRequestLogs;
  document.getElementById('reqLogClearBtn').onclick = clearRequestLogs;
  document.getElementById('reqLogFilters').addEventListener('click', (e) => {
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

  if (token) tryLogin(token);
</script>
</body>
</html>`;
}

function sanitizeConfigForClient() {
    if (syncBundledLeavePresetToggles(config.presetToggles)) {
        saveConfig();
    }
    const remoteToggleValues = (config.remoteToggleValues && typeof config.remoteToggleValues === 'object' && !Array.isArray(config.remoteToggleValues))
        ? { ...config.remoteToggleValues }
        : {};
    return {
        activeProfileId: config.activeProfileId,
        directPresetId: typeof config.directPresetId === 'string' ? config.directPresetId : 'bundled:leave',
        directPresets: listDirectPresets(),
        remoteToggleValues,
        disabledLoreEntries: (config.disabledLoreEntries && typeof config.disabledLoreEntries === 'object') ? config.disabledLoreEntries : {},
        pinnedLoreEntries: (config.pinnedLoreEntries && typeof config.pinnedLoreEntries === 'object') ? config.pinnedLoreEntries : {},
        presetToggles: Array.isArray(config.presetToggles) ? config.presetToggles : [],
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
            remoteToggleValues: (configOverride.remoteToggleValues && typeof configOverride.remoteToggleValues === 'object')
                ? { ...configOverride.remoteToggleValues }
                : {},
            disabledLoreEntries: (configOverride.disabledLoreEntries && typeof configOverride.disabledLoreEntries === 'object')
                ? { ...configOverride.disabledLoreEntries }
                : {},
            pinnedLoreEntries: (configOverride.pinnedLoreEntries && typeof configOverride.pinnedLoreEntries === 'object')
                ? { ...configOverride.pinnedLoreEntries }
                : {},
        };
        configPersistDisabled = true;
        customPresetsCache = [];
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

        // 1b) Cached Binary Image Asset Endpoint (avoids multi-MB base64 repeats in /api/state)
        const assetMatch = req.method === 'GET' && pathname.match(/^\/api\/asset\/([a-f0-9]{32})$/);
        if (assetMatch) {
            const headerOk = safeTokenEqual(getRequestToken(req), resolvedToken);
            const cookieOk = safeTokenEqual(parseCookie(req, 'rs_asset_sid'), assetCookieVal);
            if (!headerOk && !cookieOk) {
                return sendJson(res, 401, { error: 'Unauthorized: Invalid token' }, req);
            }
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
                    state.snapshot = externalizeSnapshotAssets(body.snapshot);
                    state.snapshotVersion += 1;
                }
                if (body.triggerEvent) state.lastTriggerEvent = body.triggerEvent;
                const needFullSync = !state.catalog || !Array.isArray(state.catalog.characters) || state.catalog.characters.length === 0 || !state.snapshot || typeof state.snapshot.charIndex !== 'number' || state.snapshot.charIndex < 0;

                pruneCommandQueue();
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
                    return sendJson(res, 200, { ok: true, command: commands[0] || null, commands, needFullSync, relayVersion: RELAY_VERSION }, req);
                }
                const nextCmd = state.commandQueue.shift() || null;
                if (nextCmd && (nextCmd.type === 'send_chat' || nextCmd.type === 'reroll_message')) {
                    state.nativeRequestDispatched = true;
                    if (!state.nativeRequestPendingSince) state.nativeRequestPendingSince = Date.now();
                }
                return sendJson(res, 200, { ok: true, command: nextCmd, needFullSync, relayVersion: RELAY_VERSION }, req);
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
                    if (key && scope !== 'local') {
                        const fullKey = key.startsWith('toggle_') ? key : `toggle_${key}`;
                        if (!config.remoteToggleValues || typeof config.remoteToggleValues !== 'object') {
                            config.remoteToggleValues = {};
                        }
                        config.remoteToggleValues[fullKey] = String(p.value ?? '');
                        saveConfig();
                    }
                }
                if (body.type === 'set_author_note' && body.payload && typeof body.payload === 'object') {
                    const p = body.payload;
                    if (state.snapshot && Number(p.charIndex) === state.snapshot.charIndex && Number(p.chatIndex) === state.snapshot.chatIndex) {
                        if (!state.snapshot.charContext || typeof state.snapshot.charContext !== 'object') {
                            state.snapshot.charContext = { name: state.snapshot.charName || 'Character' };
                        }
                        state.snapshot.charContext.note = String(p.note ?? '');
                        state.snapshotVersion += 1;
                    }
                }
                if (body.type === 'set_char_global_note' && body.payload && typeof body.payload === 'object') {
                    const p = body.payload;
                    if (state.snapshot && Number(p.charIndex) === state.snapshot.charIndex) {
                        if (!state.snapshot.charContext || typeof state.snapshot.charContext !== 'object') {
                            state.snapshot.charContext = { name: state.snapshot.charName || 'Character' };
                        }
                        state.snapshot.charContext.replaceGlobalNote = String(p.replaceGlobalNote ?? '');
                        state.snapshotVersion += 1;
                    }
                }
                if (body.type === 'edit_message' && body.payload && typeof body.payload === 'object') {
                    const p = body.payload;
                    if (state.snapshot && Number(p.charIndex) === state.snapshot.charIndex && Number(p.chatIndex) === state.snapshot.chatIndex && Array.isArray(state.snapshot.messages)) {
                        const hit = state.snapshot.messages.find((m) => m && m.index === Number(p.msgIndex));
                        if (hit) {
                            hit.raw = String(p.text ?? '');
                            state.snapshotVersion += 1;
                        }
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

                if (state.snapshot && state.snapshot.isPcActive && charIndex === state.snapshot.charIndex) {
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
                if (!getActiveProfile()) {
                    return sendJson(res, 400, { error: 'PC에서 현재 열려있지 않은 봇과 대화하려면 [모델/번역] 탭에서 활성 모델 프로필을 먼저 설정해야 합니다.' }, req);
                }
                if (!state.snapshot || state.snapshot.charIndex !== charIndex || state.snapshot.chatIndex !== chatIndex) {
                    return sendJson(res, 409, { error: '채팅방 동기화가 완료되지 않았습니다. 잠시 후 다시 시도해 주세요.' }, req);
                }

                state.lastDirectError = null;
                const snapView = {
                    charName: state.snapshot.charName,
                    charContext: state.snapshot.charContext ? { ...state.snapshot.charContext } : null,
                    messages: Array.isArray(state.snapshot.messages) ? state.snapshot.messages.slice() : [],
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

                if (state.snapshot && state.snapshot.isPcActive && charIndex === state.snapshot.charIndex) {
                    state.nativeRequestPendingSince = Date.now();
                    state.nativeRequestDispatched = false;
                    queueCommand('reroll_message', { charIndex, chatIndex, msgIndex });
                    return sendJson(res, 200, { ok: true, mode: 'native_risu' }, req);
                }

                if (state.directGenerating) {
                    return sendJson(res, 409, { error: '이미 응답을 생성 중입니다.' }, req);
                }
                if (!getActiveProfile()) {
                    return sendJson(res, 400, { error: 'PC에서 현재 열려있지 않은 봇을 리롤하려면 [모델/번역] 탭에서 활성 모델 프로필을 먼저 설정해야 합니다.' }, req);
                }
                if (!state.snapshot || state.snapshot.charIndex !== charIndex || state.snapshot.chatIndex !== chatIndex) {
                    return sendJson(res, 409, { error: '채팅방 동기화가 완료되지 않았습니다. 잠시 후 다시 시도해 주세요.' }, req);
                }

                state.lastDirectError = null;
                const snapView = {
                    charName: state.snapshot.charName,
                    charContext: state.snapshot.charContext ? { ...state.snapshot.charContext } : null,
                    messages: Array.isArray(state.snapshot.messages) ? state.snapshot.messages.slice() : [],
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
                if (typeof body.directPresetId === 'string') {
                    config.directPresetId = body.directPresetId;
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
                    }));
                    syncBundledLeavePresetToggles(config.presetToggles);
                }
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
            return sendJson(res, 200, {
                ok: true,
                max: REQUEST_LOG_MAX,
                logs: requestLogs.map(summarizeRequestLog),
            }, req);
        }

        if (pathname === '/api/logs' && req.method === 'DELETE') {
            if (!requireAuth(req, res)) return;
            requestLogs.length = 0;
            return sendJson(res, 200, { ok: true }, req);
        }

        const logDetailMatch = pathname.match(/^\/api\/logs\/([^/]+)$/);
        if (logDetailMatch && req.method === 'GET') {
            if (!requireAuth(req, res)) return;
            let reqId = logDetailMatch[1];
            try { reqId = decodeURIComponent(reqId); } catch (_) {}
            const found = requestLogs.find((item) => item.id === reqId);
            if (!found) {
                return sendJson(res, 404, { error: '요청 로그를 찾을 수 없습니다.' }, req);
            }
            return sendJson(res, 200, { ok: true, log: found }, req);
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
                const list = loadCustomPresets().slice();
                list.push(entry);
                saveCustomPresets(list);
                config.directPresetId = `custom:${entry.id}`;
                if (body.registerToggle !== false && entry.customPromptTemplateToggle) {
                    if (!Array.isArray(config.presetToggles)) config.presetToggles = [];
                    const ptId = `pt-${entry.id}`;
                    const ptEntry = {
                        id: ptId,
                        name: `📄 ${entry.name}`,
                        enabled: true,
                        syntax: entry.customPromptTemplateToggle,
                    };
                    const idx = config.presetToggles.findIndex((x) => x && x.id === ptId);
                    if (idx >= 0) config.presetToggles[idx] = ptEntry;
                    else config.presetToggles.unshift(ptEntry);
                }
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
            const disabledUids = (config.disabledLoreEntries && Array.isArray(config.disabledLoreEntries[charKey]))
                ? config.disabledLoreEntries[charKey]
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
                pinnedUids,
                entries,
            }, req);
        }

        if (pathname === '/api/lorebook/selection' && req.method === 'POST') {
            if (!requireAuth(req, res)) return;
            try {
                const body = JSON.parse((await readBody(req)) || '{}');
                const charKey = String(body.charKey || getLoreCharKeyFromSnap(state.snapshot) || '').trim();
                if (!charKey) return sendJson(res, 400, { error: 'Missing charKey' }, req);
                if (!config.disabledLoreEntries || typeof config.disabledLoreEntries !== 'object') config.disabledLoreEntries = {};
                if (!config.pinnedLoreEntries || typeof config.pinnedLoreEntries !== 'object') config.pinnedLoreEntries = {};

                if (Array.isArray(body.disabledUids)) {
                    const next = Array.from(new Set(body.disabledUids.map((x) => String(x || '')).filter(Boolean)));
                    if (next.length) config.disabledLoreEntries[charKey] = next;
                    else delete config.disabledLoreEntries[charKey];
                }
                if (Array.isArray(body.pinnedUids)) {
                    const nextP = Array.from(new Set(body.pinnedUids.map((x) => String(x || '')).filter(Boolean)));
                    if (nextP.length) config.pinnedLoreEntries[charKey] = nextP;
                    else delete config.pinnedLoreEntries[charKey];
                }
                if (body.uid) {
                    const uid = String(body.uid);
                    const disSet = new Set(config.disabledLoreEntries[charKey] || []);
                    const pinSet = new Set(config.pinnedLoreEntries[charKey] || []);
                    if (typeof body.enabled === 'boolean') {
                        if (body.enabled) disSet.delete(uid);
                        else disSet.add(uid);
                        if (disSet.size) config.disabledLoreEntries[charKey] = Array.from(disSet);
                        else delete config.disabledLoreEntries[charKey];
                    }
                    if (typeof body.pinned === 'boolean') {
                        if (body.pinned) pinSet.add(uid);
                        else pinSet.delete(uid);
                        if (pinSet.size) config.pinnedLoreEntries[charKey] = Array.from(pinSet);
                        else delete config.pinnedLoreEntries[charKey];
                    }
                }
                saveConfig();
                return sendJson(res, 200, {
                    ok: true,
                    charKey,
                    disabledUids: config.disabledLoreEntries[charKey] || [],
                    pinnedUids: config.pinnedLoreEntries[charKey] || [],
                }, req);
            } catch (e) {
                return sendJson(res, 400, { error: e.message }, req);
            }
        }

        sendJson(res, 404, { error: 'Not found' }, req);
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
    applyPromptOverride,
    safeTokenEqual,
    isLoopbackAddress,
    isTrustedOrigin,
    corsHeaders,
    sanitizeConfigForClient,
    decodeRisupPreset,
    parsePresetDefaultToggles,
    evalPresetCbs,
    parseLoreDecorators,
    evaluateLorebookEntries,
    buildDirectPromptMessages,
    loadBundledLeavePreset,
    syncBundledLeavePresetToggles,
    createRelayServer,
};
