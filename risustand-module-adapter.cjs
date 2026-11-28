'use strict';
/**
 * RisuStand Backend Module Adapter (Regex customScripts + Real Lua 5.4 WASM Engine)
 *
 * Executes RisuAI character & module `customScripts` regexes and `triggerscript`
 * Lua 5.4 scripts (`start`, `input`, `output`, `onButtonClick`, `onFormSubmit`,
 * and `listenEdit`: `editRequest`, `editInput`, `editOutput`, `editDisplay`)
 * using vendored `wasmoon@1.16.0`.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { LuaFactory, LUA_REGISTRYINDEX } = require('./vendor/wasmoon/index.cjs');

let sharedFactoryPromise = null;
let sharedJsonLua = '';

async function getSharedLuaFactory() {
    if (!sharedFactoryPromise) {
        sharedFactoryPromise = (async () => {
            const wasmUrl = pathToFileURL(path.join(__dirname, 'vendor', 'wasmoon', 'glue.wasm')).href;
            const factory = new LuaFactory(wasmUrl);
            if (!sharedJsonLua) {
                sharedJsonLua = fs.readFileSync(path.join(__dirname, 'vendor', 'wasmoon', 'json.lua'), 'utf8');
            }
            await factory.mountFile('json.lua', sharedJsonLua);
            return factory;
        })();
    }
    return sharedFactoryPromise;
}

const LUA_PREAMBLE = `
json = require("json")
if rawget(_G, "null") == nil then
    rawset(_G, "null", json.null)
end

__rsAsyncFns = {}
__rsAsyncSeq = 0
function async(fn)
    __rsAsyncSeq = __rsAsyncSeq + 1
    local refId = __rsAsyncSeq
    __rsAsyncFns[refId] = fn
    return function(...)
        return __rsRunAsyncThread(refId, ...)
    end
end

__rsEditHandlers = {
    editRequest = {},
    editDisplay = {},
    editInput = {},
    editOutput = {},
}

function listenEdit(kind, fn)
    local k = tostring(kind or "")
    if type(fn) ~= "function" then return end
    if not __rsEditHandlers[k] then __rsEditHandlers[k] = {} end
    table.insert(__rsEditHandlers[k], fn)
end

local function __rsAwaitIfPromise(val)
    if (type(val) == "table" or type(val) == "userdata") then
        local ok, awaitFn = pcall(function() return val.await end)
        if ok and type(awaitFn) == "function" then
            return val:await()
        end
    end
    return val
end

function __rsCallTrigger(fnName, ...)
    local fn = rawget(_G, fnName)
    if type(fn) ~= "function" then return nil end
    return __rsAwaitIfPromise(fn(...))
end

function __rsHasEditHandler(kind)
    local l = __rsEditHandlers[tostring(kind or "")]
    return l ~= nil and #l > 0
end

function __rsRunEditHandlers(kind, id, data, meta)
    local list = __rsEditHandlers[tostring(kind or "")]
    if not list or #list == 0 then
        return data
    end
    local cur = data
    for i = 1, #list do
        local fn = list[i]
        local res = __rsAwaitIfPromise(fn(id, cur, meta))
        if res ~= nil then
            cur = res
        end
    end
    return cur
end

function getState(id, name)
    local raw = getChatVar(id, "__" .. tostring(name or ""))
    if raw == nil or raw == "" or raw == "null" then
        return nil
    end
    local ok, decoded = pcall(json.decode, raw)
    if ok then return decoded end
    return nil
end

function setState(id, name, val)
    if val == nil then
        setChatVar(id, "__" .. tostring(name or ""), "null")
        return
    end
    setChatVar(id, "__" .. tostring(name or ""), json.encode(val))
end

function getFullChat(id)
    local raw = getFullChatMain(id)
    if not raw or raw == "" then return {} end
    local ok, decoded = pcall(json.decode, raw)
    if ok and type(decoded) == "table" then return decoded end
    return {}
end

function setFullChat(id, tbl)
    setFullChatMain(id, json.encode(tbl or {}))
end

function getRecentChats(id, count)
    local raw = getRecentChatsMain(id, tonumber(count) or 0)
    if not raw or raw == "" then return {} end
    local ok, decoded = pcall(json.decode, raw)
    if ok and type(decoded) == "table" then return decoded end
    return {}
end

function getChat(id, idx)
    local raw = getChatMain(id, idx)
    if not raw or raw == "" or raw == "null" then return nil end
    local ok, decoded = pcall(json.decode, raw)
    if ok then return decoded end
    return nil
end

function getLoreBooks(id, search)
    local raw = getLoreBooksMain(id, tostring(search or ""))
    if not raw or raw == "" then return {} end
    local ok, decoded = pcall(json.decode, raw)
    if ok and type(decoded) == "table" then return decoded end
    return {}
end

function loadLoreBooks(id, reserveTokens)
    local raw = loadLoreBooksMain(id, tonumber(reserveTokens) or 0)
    if not raw or raw == "" then return {} end
    local ok, decoded = pcall(json.decode, raw)
    if ok and type(decoded) == "table" then return decoded end
    return {}
end

function upsertLocalLoreBook(id, name, content, options)
    return upsertLocalLoreBookMain(id, tostring(name or ""), tostring(content or ""), json.encode(options or {}))
end

__rsResolvedMeta = {
    __index = {
        await = function(self)
            return self
        end
    }
}

local function __rsWrapLLMResult(resJson, fallbackMsg)
    local ok, decoded = pcall(json.decode, resJson)
    if ok and type(decoded) == "table" then
        return setmetatable(decoded, __rsResolvedMeta)
    end
    return setmetatable({ success = false, result = tostring(resJson or fallbackMsg) }, __rsResolvedMeta)
end

local __rsLLMAsync = async(function(id, pJson, useMM, oJson)
    local resJson = LLMMain(id, pJson, useMM, oJson):await()
    return __rsWrapLLMResult(resJson, "LLM decode error")
end)

local __rsAxLLMAsync = async(function(id, pJson, useMM, oJson)
    local resJson = axLLMMain(id, pJson, useMM, oJson):await()
    return __rsWrapLLMResult(resJson, "axLLM decode error")
end)

local __rsSimpleLLMAsync = async(function(id, promptStr)
    local resJson = simpleLLMMain(id, promptStr):await()
    return __rsWrapLLMResult(resJson, "simpleLLM decode error")
end)

function LLM(id, prompt, useMultimodal, options)
    local pJson = type(prompt) == "string" and prompt or json.encode(prompt or {})
    local oJson = type(options) == "string" and options or json.encode(options or {})
    if coroutine.isyieldable() then
        local resJson = LLMMain(id, pJson, useMultimodal == true, oJson):await()
        return __rsWrapLLMResult(resJson, "LLM decode error")
    end
    return __rsLLMAsync(id, pJson, useMultimodal == true, oJson)
end

function axLLM(id, prompt, useMultimodal, options)
    local pJson = type(prompt) == "string" and prompt or json.encode(prompt or {})
    local oJson = type(options) == "string" and options or json.encode(options or {})
    if coroutine.isyieldable() then
        local resJson = axLLMMain(id, pJson, useMultimodal == true, oJson):await()
        return __rsWrapLLMResult(resJson, "axLLM decode error")
    end
    return __rsAxLLMAsync(id, pJson, useMultimodal == true, oJson)
end

function simpleLLM(id, prompt)
    local promptStr = tostring(prompt or "")
    if coroutine.isyieldable() then
        local resJson = simpleLLMMain(id, promptStr):await()
        return __rsWrapLLMResult(resJson, "simpleLLM decode error")
    end
    return __rsSimpleLLMAsync(id, promptStr)
end
`;

function extractOrderFlag(flagStr) {
    const m = String(flagStr || '').match(/<order\s+(-?\d+)>/i);
    return m ? Number(m[1]) : 0;
}

function getRegexBucket(flagStr) {
    const f = String(flagStr || '');
    if (f.includes('<move_top>')) return 0;
    if (f.includes('<move_bottom>')) return 2;
    return 1;
}

function assignBothToggleKeys(out, rawKey, rawVal) {
    const k = String(rawKey || '').trim();
    if (!k) return;
    const v = String(rawVal ?? '');
    out[k] = v;
    if (k.startsWith('toggle_')) {
        out[k.slice(7)] = v;
    } else {
        out[`toggle_${k}`] = v;
    }
}

function applyToggleSyntaxDefaults(toggleSyntax = '', defaultVariablesText = '', out = {}) {
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
        assignBothToggleKeys(out, key, defVal);
    }
    for (const rawLine of String(defaultVariablesText || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('//')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        assignBothToggleKeys(out, line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
    return out;
}

function runRegexScripts(mode, text, scripts, cbsFn) {
    let cur = String(text ?? '').replace(/\r\n/g, '\n');
    if (!Array.isArray(scripts) || !scripts.length) return cur;

    const matching = [];
    for (let i = 0; i < scripts.length; i += 1) {
        const s = scripts[i];
        if (!s || s.type !== mode) continue;
        if (!s.in || typeof s.in !== 'string') continue;
        matching.push({ script: s, bucket: getRegexBucket(s.flag), order: extractOrderFlag(s.flag), idx: i });
    }
    matching.sort((a, b) => (a.bucket - b.bucket) || (b.order - a.order) || (a.idx - b.idx));

    for (const item of matching) {
        const s = item.script;
        try {
            const flagText = s.ableFlag ? String(s.flag || 'g') : 'g';
            const inHasCbs = Boolean(s.ableFlag && flagText.includes('<cbs>') && typeof cbsFn === 'function');
            const inPattern = inHasCbs ? String(cbsFn(s.in)) : s.in;
            if (!inPattern) continue;

            const metaAdded = (flagText.includes('<ignore_case>') ? 'i' : '')
                + (flagText.includes('<multiline>') ? 'm' : '')
                + (flagText.includes('<dotall>') ? 's' : '')
                + (flagText.includes('<global>') ? 'g' : '');
            const strippedFlags = flagText.replace(/<[^>]+>/g, '');
            let regexFlags = Array.from(new Set((strippedFlags.replace(/[^dgimsuvy]/g, '') + metaAdded).split(''))).join('');
            if (!regexFlags && !flagText.includes('<no_g>')) regexFlags = 'g';
            else if (!regexFlags.includes('g') && !flagText.includes('<no_g>')) regexFlags += 'g';
            const re = new RegExp(inPattern, regexFlags);
            if (!re.test(cur)) continue;
            re.lastIndex = 0;

            let rawOut = String(s.out ?? '').replace(/\\n/g, '\n');
            if (flagText.includes('<no_end_nl>') && rawOut.endsWith('\n')) {
                rawOut = rawOut.slice(0, -1);
            }
            cur = cur.replace(re, (...args) => {
                const whole = args[0];
                const hasGroups = args.length >= 4 && typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null && typeof args[args.length - 2] === 'string';
                const groups = hasGroups ? args[args.length - 1] : null;
                const inputStr = hasGroups ? args[args.length - 2] : args[args.length - 1];
                const offset = hasGroups ? args[args.length - 3] : args[args.length - 2];
                const caps = hasGroups ? args.slice(1, -3) : args.slice(1, -2);
                const substituted = rawOut.replace(/\$(?:\$|&|`|'|<([^>]+)>|(\d{1,2}))/g, (tok, groupName, numStr) => {
                    if (tok === '$$') return '$';
                    if (tok === '$&') return whole;
                    if (tok === '$`') return typeof inputStr === 'string' && typeof offset === 'number' ? inputStr.slice(0, offset) : '';
                    if (tok === "$'") return typeof inputStr === 'string' && typeof offset === 'number' ? inputStr.slice(offset + whole.length) : '';
                    if (groupName !== undefined) return groups && groups[groupName] !== undefined ? String(groups[groupName]) : '';
                    const n = parseInt(numStr, 10);
                    if (n === 0) return whole;
                    if (n >= 1 && n <= caps.length && caps[n - 1] !== undefined) return String(caps[n - 1]);
                    return '';
                });
                if (substituted.includes('{{') && typeof cbsFn === 'function') {
                    return String(cbsFn(substituted));
                }
                return substituted;
            });
        } catch (_) {}
    }
    return cur;
}

function collectTriggerLuaEntries(charObj, modulesList) {
    const entries = [];
    const charLowLevel = Boolean(charObj && charObj.lowLevelAccess);
    const pushFrom = (trList, sourceName, sourceId, lowLevelAccess, sourceKind) => {
        if (!Array.isArray(trList)) return;
        for (let i = 0; i < trList.length; i += 1) {
            const tr = trList[i];
            if (!tr || !Array.isArray(tr.effect)) continue;
            const effLow = Boolean(lowLevelAccess || tr.lowLevelAccess);
            for (let j = 0; j < tr.effect.length; j += 1) {
                const ef = tr.effect[j];
                if (ef && ef.type === 'triggerlua' && ef.code) {
                    const code = String(ef.code);
                    const hash = crypto.createHash('sha1').update(code).digest('hex').slice(0, 12);
                    entries.push({
                        key: `${sourceId}:${i}:${j}:${hash}`,
                        sourceName,
                        sourceId,
                        sourceKind,
                        code,
                        lowLevelAccess: effLow,
                    });
                }
            }
        }
    };
    if (charObj && Array.isArray(charObj.triggerscript)) {
        pushFrom(charObj.triggerscript, charObj.name || 'character', `char:${charObj.chaId || charObj.name || '0'}`, charLowLevel, 'bot');
    }
    for (const m of modulesList || []) {
        const trList = m && (Array.isArray(m.trigger) ? m.trigger : (Array.isArray(m.triggerscript) ? m.triggerscript : null));
        if (trList) {
            pushFrom(trList, m.name || m.id || 'module', `mod:${m.id || m.name || '0'}`, Boolean(m.lowLevelAccess), 'module');
        }
    }
    return entries;
}

function normalizePromptMessagesFromLua(promptJson) {
    let arr;
    try {
        arr = typeof promptJson === 'string' ? JSON.parse(promptJson) : promptJson;
    } catch (_) {
        const s = String(promptJson ?? '').trim();
        return s ? [{ role: 'user', content: s }] : [];
    }
    if (typeof arr === 'string') {
        const s = arr.trim();
        return s ? [{ role: 'user', content: s }] : [];
    }
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const m of arr) {
        if (!m || typeof m !== 'object') continue;
        const r = String(m.role || 'user').toLowerCase();
        const role = (r === 'char' || r === 'bot' || r === 'model' || r === 'assistant') ? 'assistant'
            : ((r === 'system' || r === 'sys') ? 'system' : 'user');
        out.push({
            role,
            content: typeof m.content === 'string' ? m.content : String(m.data ?? m.content ?? ''),
        });
    }
    return out;
}

function luaOptionsObjToArray(val) {
    if (Array.isArray(val)) return val.map((x) => String(x ?? ''));
    if (val && typeof val === 'object') {
        return Object.keys(val)
            .map((k) => ({ k, n: Number(k) }))
            .filter((x) => Number.isInteger(x.n) && x.n >= 1)
            .sort((a, b) => a.n - b.n)
            .map((x) => String(val[x.k] ?? ''));
    }
    return [];
}

function createModuleAdapter({
    hostRpc = null,
    getBackendConfig = () => ({}),
    getToggleContext = () => ({}),
    runLLM = null,
    imageProvider = null,
    evalCbs = (s) => String(s ?? ''),
    onTriggerNotice = () => {},
    onActivity = () => () => {},
} = {}) {
    const MAX_ENGINES = 24;
    const engineCache = new Map(); // entryKey -> { engine, lastUsed, allowLowLevelRef }

    let activeCtx = {
        active: false,
        charIndex: -1,
        chatIndex: -1,
        charObj: null,
        chatObj: null,
        modules: [],
        globalVars: {},
        stopSending: false,
        needsDisplayRefresh: false,
        syncToSharedTurn: null,
        promptState: null,
    };

    const emitActivity = () => () => {};

    async function withModActivity(kind, name, phase, fn) {
        const done = emitActivity(kind, name, phase);
        try {
            return await fn();
        } finally {
            done();
        }
    }

    const isRpcConnected = () => Boolean(hostRpc && typeof hostRpc.isConnected === 'function' && hostRpc.isConnected());

    function getAllMergedScripts() {
        const out = [];
        if (activeCtx.charObj) {
            if (Array.isArray(activeCtx.charObj.customscript)) out.push(...activeCtx.charObj.customscript);
            else if (Array.isArray(activeCtx.charObj.customScripts)) out.push(...activeCtx.charObj.customScripts);
        }
        for (const m of activeCtx.modules || []) {
            if (!m) continue;
            if (Array.isArray(m.regex)) out.push(...m.regex);
            else if (Array.isArray(m.customScripts)) out.push(...m.customScripts);
        }
        return out;
    }

    function buildCbsContext(msgIndex = undefined, lastMsgId = undefined) {
        const cVars = {};
        if (activeCtx.chatObj && activeCtx.chatObj.scriptstate && typeof activeCtx.chatObj.scriptstate === 'object') {
            for (const [k, v] of Object.entries(activeCtx.chatObj.scriptstate)) {
                const clean = k.startsWith('$') ? k.slice(1) : k;
                if (!clean) continue;
                cVars[clean] = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
            }
        }
        const rawMsgs = activeCtx.chatObj && Array.isArray(activeCtx.chatObj.message) ? activeCtx.chatObj.message : [];
        const chatList = rawMsgs.map((m) => ({
            role: m && m.role === 'user' ? 'user' : 'assistant',
            content: String((m && (m.data ?? m.content ?? m.text ?? m.raw)) ?? ''),
        }));
        const effLast = lastMsgId !== undefined ? lastMsgId : Math.max(0, chatList.length - 1);
        const effIdx = msgIndex !== undefined ? msgIndex : effLast;
        return {
            charName: String((activeCtx.charObj && activeCtx.charObj.name) || 'Character'),
            personaName: String(activeCtx.personaName || 'User'),
            chatVars: cVars,
            globalVars: { ...(activeCtx.globalVars || {}) },
            chatList,
            chatIndex: effIdx,
            lastMessageId: effLast,
        };
    }

    function runCbs(text, msgIndex = undefined, lastMsgId = undefined) {
        try {
            const ctx = buildCbsContext(msgIndex, lastMsgId);
            const prevVars = { ...ctx.chatVars };
            const result = String(evalCbs(String(text ?? ''), ctx));
            if (activeCtx.chatObj && ctx.chatVars && typeof ctx.chatVars === 'object') {
                if (!activeCtx.chatObj.scriptstate || typeof activeCtx.chatObj.scriptstate !== 'object') {
                    activeCtx.chatObj.scriptstate = {};
                }
                for (const [k, v] of Object.entries(ctx.chatVars)) {
                    const nextVal = String(v ?? '');
                    if (prevVars[k] === nextVal) continue;
                    const keyName = k.startsWith('$') ? k : `$${k}`;
                    activeCtx.chatObj.scriptstate[keyName] = nextVal;
                }
            }
            return result;
        } catch (_) {
            return String(text ?? '');
        }
    }

    function computeGlobalVars(dbGlobals = {}) {
        const out = {};
        const tCtx = typeof getToggleContext === 'function' ? (getToggleContext() || {}) : {};
        if (tCtx.presetToggleSyntax || tCtx.presetDefaultVariables) {
            applyToggleSyntaxDefaults(tCtx.presetToggleSyntax || '', tCtx.presetDefaultVariables || '', out);
        }
        for (const m of activeCtx.modules || []) {
            if (m && m.customModuleToggle) applyToggleSyntaxDefaults(m.customModuleToggle, '', out);
        }
        if (activeCtx.charObj && activeCtx.charObj.customModuleToggle) {
            applyToggleSyntaxDefaults(activeCtx.charObj.customModuleToggle, '', out);
        }
        if (dbGlobals && typeof dbGlobals === 'object') {
            for (const [k, v] of Object.entries(dbGlobals)) {
                if (v !== undefined && v !== null) assignBothToggleKeys(out, k, v);
            }
        }
        if (tCtx.globalToggleValues && typeof tCtx.globalToggleValues === 'object') {
            for (const [k, v] of Object.entries(tCtx.globalToggleValues)) {
                if (v !== undefined && v !== null) assignBothToggleKeys(out, k, v);
            }
        }
        const cfg = typeof getBackendConfig === 'function' ? getBackendConfig() : {};
        if (cfg && cfg.remoteToggleValues && typeof cfg.remoteToggleValues === 'object') {
            for (const [k, v] of Object.entries(cfg.remoteToggleValues)) {
                if (k && v !== undefined && v !== null) assignBothToggleKeys(out, k, v);
            }
        }
        const isLocal = Boolean((activeCtx.chatObj && activeCtx.chatObj.useLocallySetGlobalVariables) || tCtx.useLocal);
        if (isLocal) {
            if (tCtx.localToggleValues && typeof tCtx.localToggleValues === 'object') {
                for (const [k, v] of Object.entries(tCtx.localToggleValues)) {
                    if (k && v !== undefined && v !== null) assignBothToggleKeys(out, k, v);
                }
            }
            if (activeCtx.chatObj && activeCtx.chatObj.GLGlobalVariables) {
                for (const [k, v] of Object.entries(activeCtx.chatObj.GLGlobalVariables)) {
                    if (k && v !== undefined && v !== null) assignBothToggleKeys(out, k, v);
                }
            }
        }
        return out;
    }

    async function runThreadCall(engine, pushTargetFn, args = []) {
        const t = engine.global.newThread();
        const ref = engine.global.lua.luaL_ref(engine.global.address, LUA_REGISTRYINDEX);
        try {
            pushTargetFn(t);
            for (const a of args) t.pushValue(a);
            const res = await t.run(args.length);
            if (res && res.length > 0) {
                return t.getValue(-res.length);
            }
            return undefined;
        } finally {
            try { t.close(); } catch (_) {}
            try { engine.global.lua.luaL_unref(engine.global.address, LUA_REGISTRYINDEX, ref); } catch (_) {}
        }
    }

    async function createOrGetEngine(entry) {
        const existing = engineCache.get(entry.key);
        if (existing) {
            existing.lastUsed = Date.now();
            return existing;
        }
        if (engineCache.size >= MAX_ENGINES) {
            let oldestKey = '';
            let oldestTime = Infinity;
            for (const [k, v] of engineCache.entries()) {
                if (v.lastUsed < oldestTime) {
                    oldestTime = v.lastUsed;
                    oldestKey = k;
                }
            }
            if (oldestKey) {
                const old = engineCache.get(oldestKey);
                engineCache.delete(oldestKey);
                try { old.engine.global.close(); } catch (_) {}
            }
        }

        const factory = await getSharedLuaFactory();
        const engine = await factory.createEngine({ injectObjects: true, enableProxy: false });
        const stateHolder = {
            engine,
            lastUsed: Date.now(),
            allowLowLevel: false,
            ownerLowLevel: entry.lowLevelAccess,
        };

        engine.global.set('__rsRunAsyncThread', async (refId, ...args) => {
            return await runThreadCall(engine, (t) => {
                t.lua.lua_getglobal(t.address, '__rsAsyncFns');
                t.lua.lua_rawgeti(t.address, -1, BigInt(refId));
                t.lua.lua_remove(t.address, -2);
            }, args);
        });

        // Print / debug logging (non-fatal)
        engine.global.set('print', (...args) => {
            console.log(`[Module:${entry.sourceName}]`, ...args);
        });

        // Chat variables & state
        engine.global.set('getChatVar', (_id, key) => {
            const chat = activeCtx.chatObj;
            if (!chat || !chat.scriptstate || typeof chat.scriptstate !== 'object') return 'null';
            const k = String(key || '').startsWith('$') ? String(key) : `$${String(key || '')}`;
            return Object.prototype.hasOwnProperty.call(chat.scriptstate, k) && chat.scriptstate[k] !== undefined && chat.scriptstate[k] !== null
                ? String(chat.scriptstate[k])
                : 'null';
        });
        engine.global.set('setChatVar', (_id, key, val) => {
            const chat = activeCtx.chatObj;
            if (!chat) return;
            if (!chat.scriptstate || typeof chat.scriptstate !== 'object') chat.scriptstate = {};
            const rawK = String(key || '');
            const k = rawK.startsWith('$') ? rawK : `$${rawK}`;
            if (val === null || val === undefined) {
                delete chat.scriptstate[k];
            } else {
                chat.scriptstate[k] = String(val);
            }
        });
        engine.global.set('getGlobalVar', (_id, key) => {
            const k = String(key || '');
            const gv = activeCtx.globalVars || {};
            if (Object.prototype.hasOwnProperty.call(gv, k)) return String(gv[k]);
            if (!k.startsWith('toggle_') && Object.prototype.hasOwnProperty.call(gv, `toggle_${k}`)) {
                return String(gv[`toggle_${k}`]);
            }
            return 'null';
        });

        // Character & chat metadata
        engine.global.set('getName', () => String((activeCtx.charObj && activeCtx.charObj.name) || 'Character'));
        engine.global.set('getPersonaName', () => String((activeCtx.personaName) || 'User'));
        engine.global.set('setName', (_id, val) => {
            if (activeCtx.charObj) activeCtx.charObj.name = String(val ?? '');
        });
        engine.global.set('getDescription', () => String((activeCtx.charObj && activeCtx.charObj.desc) || ''));
        engine.global.set('setDescription', (_id, val) => {
            if (activeCtx.charObj) activeCtx.charObj.desc = String(val ?? '');
        });
        engine.global.set('getAuthorsNote', () => String((activeCtx.chatObj && activeCtx.chatObj.note) || ''));
        engine.global.set('setAuthorsNote', (_id, val) => {
            if (activeCtx.chatObj) activeCtx.chatObj.note = String(val ?? '');
        });
        engine.global.set('getCharacterFirstMessage', () => String((activeCtx.charObj && activeCtx.charObj.firstMessage) || ''));
        engine.global.set('getCharacterLastMessage', () => {
            const msgs = (activeCtx.chatObj && Array.isArray(activeCtx.chatObj.message)) ? activeCtx.chatObj.message : [];
            for (let i = msgs.length - 1; i >= 0; i -= 1) {
                if (msgs[i] && msgs[i].role === 'char') return String(msgs[i].data || '');
            }
            return String((activeCtx.charObj && activeCtx.charObj.firstMessage) || '');
        });
        engine.global.set('getUserLastMessage', () => {
            const msgs = (activeCtx.chatObj && Array.isArray(activeCtx.chatObj.message)) ? activeCtx.chatObj.message : [];
            for (let i = msgs.length - 1; i >= 0; i -= 1) {
                if (msgs[i] && msgs[i].role === 'user') return String(msgs[i].data || '');
            }
            return '';
        });

        // Chat message mutation
        engine.global.set('getChatLength', () => {
            const msgs = (activeCtx.chatObj && Array.isArray(activeCtx.chatObj.message)) ? activeCtx.chatObj.message : [];
            return msgs.length;
        });
        engine.global.set('getChatData', (_id, index) => {
            const msgs = (activeCtx.chatObj && Array.isArray(activeCtx.chatObj.message)) ? activeCtx.chatObj.message : [];
            let idx = Number(index);
            if (idx < 0) idx = msgs.length + idx;
            return (msgs[idx] && msgs[idx].data) ? String(msgs[idx].data) : '';
        });
        engine.global.set('getChatRole', (_id, index) => {
            const msgs = (activeCtx.chatObj && Array.isArray(activeCtx.chatObj.message)) ? activeCtx.chatObj.message : [];
            let idx = Number(index);
            if (idx < 0) idx = msgs.length + idx;
            return (msgs[idx] && msgs[idx].role) ? String(msgs[idx].role) : '';
        });
        engine.global.set('getRecentChatsMain', (_id, count) => {
            const msgs = (activeCtx.chatObj && Array.isArray(activeCtx.chatObj.message)) ? activeCtx.chatObj.message : [];
            const n = Math.max(0, Math.floor(Number(count) || 0));
            const slice = n > 0 ? msgs.slice(-n) : [];
            return JSON.stringify(slice.map((m) => ({
                role: m.role === 'user' ? 'user' : 'char',
                data: String(m.data || ''),
                time: m.time || Date.now(),
                chatId: m.chatId || '',
            })));
        });
        engine.global.set('getFullChatMain', () => {
            const msgs = (activeCtx.chatObj && Array.isArray(activeCtx.chatObj.message)) ? activeCtx.chatObj.message : [];
            return JSON.stringify(msgs.map((m) => ({
                role: m.role === 'user' ? 'user' : 'char',
                data: String(m.data || ''),
                time: m.time || Date.now(),
                chatId: m.chatId || '',
                ...(m.saying ? { saying: m.saying } : {}),
            })));
        });
        engine.global.set('setFullChatMain', (_id, jsonStr) => {
            if (!activeCtx.chatObj) return;
            let parsed = [];
            try {
                parsed = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
            } catch (_) {
                return;
            }
            if (!Array.isArray(parsed)) return;
            activeCtx.chatObj.message = parsed.map((m) => ({
                role: (m && m.role === 'user') ? 'user' : 'char',
                data: String((m && m.data) || ''),
                time: (m && m.time) || Date.now(),
                chatId: String((m && m.chatId) || crypto.randomUUID()),
                ...(m && m.saying ? { saying: m.saying } : {}),
            }));
        });
        engine.global.set('getChatMain', (_id, index) => {
            const msgs = (activeCtx.chatObj && Array.isArray(activeCtx.chatObj.message)) ? activeCtx.chatObj.message : [];
            let idx = Number(index);
            if (Number.isNaN(idx)) return 'null';
            if (idx < 0) idx = msgs.length + idx;
            const m = msgs[idx];
            if (!m) return 'null';
            return JSON.stringify({
                role: m.role === 'user' ? 'user' : 'char',
                data: String(m.data || ''),
                time: m.time || Date.now(),
                chatId: m.chatId || '',
                ...(m.saying ? { saying: m.saying } : {}),
            });
        });
        engine.global.set('setChat', (_id, index, data) => {
            const msgs = activeCtx.chatObj && Array.isArray(activeCtx.chatObj.message) ? activeCtx.chatObj.message : null;
            if (!msgs) return;
            let idx = Number(index);
            if (idx < 0) idx = msgs.length + idx;
            if (msgs[idx]) {
                msgs[idx].data = String(data ?? '');
            }
        });
        engine.global.set('setChatRole', (_id, index, role) => {
            const msgs = activeCtx.chatObj && Array.isArray(activeCtx.chatObj.message) ? activeCtx.chatObj.message : null;
            if (!msgs) return;
            let idx = Number(index);
            if (idx < 0) idx = msgs.length + idx;
            if (msgs[idx]) {
                msgs[idx].role = String(role) === 'user' ? 'user' : 'char';
            }
        });
        engine.global.set('addChat', (_id, role, data) => {
            if (!activeCtx.chatObj) return;
            if (!Array.isArray(activeCtx.chatObj.message)) activeCtx.chatObj.message = [];
            activeCtx.chatObj.message.push({
                role: String(role) === 'user' ? 'user' : 'char',
                data: String(data ?? ''),
                chatId: crypto.randomUUID(),
                time: Date.now(),
            });
        });
        engine.global.set('insertChat', (_id, role, data) => {
            if (!activeCtx.chatObj) return;
            if (!Array.isArray(activeCtx.chatObj.message)) activeCtx.chatObj.message = [];
            activeCtx.chatObj.message.push({
                role: String(role) === 'user' ? 'user' : 'char',
                data: String(data ?? ''),
                chatId: crypto.randomUUID(),
                time: Date.now(),
            });
        });
        engine.global.set('removeChat', (_id, index) => {
            const msgs = activeCtx.chatObj && Array.isArray(activeCtx.chatObj.message) ? activeCtx.chatObj.message : null;
            if (!msgs) return;
            let idx = Number(index);
            if (idx < 0) idx = msgs.length + idx;
            if (idx >= 0 && idx < msgs.length) {
                msgs.splice(idx, 1);
            }
        });
        engine.global.set('cutChat', (_id, startIdx, endIdx) => {
            if (!activeCtx.chatObj || !Array.isArray(activeCtx.chatObj.message)) return;
            const s = Math.max(0, Number(startIdx) || 0);
            const e = Math.max(s, Number(endIdx) || 0);
            activeCtx.chatObj.message = activeCtx.chatObj.message.slice(s, e);
        });

        // Lorebook discovery & upsert (critical for Lightboard Backend + Submodules)
        engine.global.set('getLoreBooksMain', (_id, search) => {
            const target = String(search || '');
            const pool = [
                ...((activeCtx.chatObj && Array.isArray(activeCtx.chatObj.localLore)) ? activeCtx.chatObj.localLore : []),
                ...((activeCtx.charObj && Array.isArray(activeCtx.charObj.globalLore)) ? activeCtx.charObj.globalLore : []),
            ];
            for (const m of activeCtx.modules || []) {
                if (m && Array.isArray(m.lorebook)) pool.push(...m.lorebook);
            }
            const matches = [];
            for (const b of pool) {
                if (!b || b.comment !== target) continue;
                matches.push({
                    ...b,
                    content: runCbs(b.content || ''),
                });
            }
            return JSON.stringify(matches);
        });
        engine.global.set('loadLoreBooksMain', () => {
            const pool = [
                ...((activeCtx.chatObj && Array.isArray(activeCtx.chatObj.localLore)) ? activeCtx.chatObj.localLore : []),
                ...((activeCtx.charObj && Array.isArray(activeCtx.charObj.globalLore)) ? activeCtx.charObj.globalLore : []),
            ];
            for (const m of activeCtx.modules || []) {
                if (m && Array.isArray(m.lorebook)) pool.push(...m.lorebook);
            }
            const out = pool
                .filter((b) => b && b.alwaysActive && b.mode !== 'folder')
                .map((b) => ({
                    data: runCbs(b.content || ''),
                    role: 'system',
                }));
            return JSON.stringify(out);
        });
        engine.global.set('upsertLocalLoreBookMain', (_id, name, content, optJson) => {
            if (!activeCtx.chatObj) return;
            if (!Array.isArray(activeCtx.chatObj.localLore)) activeCtx.chatObj.localLore = [];
            let opts = {};
            try { opts = optJson ? JSON.parse(optJson) : {}; } catch (_) {}
            const targetName = String(name || '');
            const idx = activeCtx.chatObj.localLore.findIndex((b) => b && b.comment === targetName);
            const entryObj = {
                key: String(opts.key || targetName),
                secondkey: String(opts.secondkey || ''),
                insertorder: Number(opts.insertorder ?? 100),
                comment: targetName,
                content: String(content ?? ''),
                mode: 'normal',
                alwaysActive: opts.alwaysActive !== undefined ? Boolean(opts.alwaysActive) : true,
                selective: Boolean(opts.selective),
            };
            if (idx >= 0) activeCtx.chatObj.localLore[idx] = { ...activeCtx.chatObj.localLore[idx], ...entryObj };
            else activeCtx.chatObj.localLore.push(entryObj);
        });

        // CBS, Hashing, Logging & UI alerts/controls
        engine.global.set('log', (...args) => {
            console.log(`[Module:${entry.sourceName}]`, ...args);
        });
        engine.global.set('cbs', (a, b) => runCbs(b !== undefined ? b : a));
        engine.global.set('hash', (a, b) => crypto.createHash('sha256').update(String((b !== undefined ? b : a) ?? '')).digest('hex'));
        engine.global.set('stopChat', () => {
            activeCtx.stopSending = true;
        });
        engine.global.set('reloadDisplay', () => {
            activeCtx.needsDisplayRefresh = true;
        });
        engine.global.set('reloadChat', () => {
            activeCtx.needsDisplayRefresh = true;
        });
        engine.global.set('alert', (a, b) => {
            onTriggerNotice({ kind: 'notice', title: entry.sourceName, message: String((b !== undefined ? b : a) ?? '') });
        });
        engine.global.set('alertNormal', (a, b) => {
            onTriggerNotice({ kind: 'notice', title: entry.sourceName, message: String((b !== undefined ? b : a) ?? '') });
        });
        engine.global.set('alertError', (a, b) => {
            onTriggerNotice({ kind: 'alert_error', title: entry.sourceName, message: String((b !== undefined ? b : a) ?? '') });
        });
        engine.global.set('alertConfirm', async (_id, msg) => {
            const ps = activeCtx.promptState;
            if (!ps || !ps.active) return true;
            if (ps.cursor < ps.answers.length) {
                return ps.answers[ps.cursor++] === '0';
            }
            ps.pause = {
                kind: 'prompt_select',
                message: String(msg ?? '계속할까요?'),
                options: ['확인', '취소'],
                trigger: ps.triggerName,
                charIndex: activeCtx.charIndex,
                chatIndex: activeCtx.chatIndex,
                answersSoFar: ps.answers.slice(),
            };
            throw new Error('__RS_LUA_PROMPT_PAUSE__');
        });
        engine.global.set('alertInput', async (_id, msg) => {
            const ps = activeCtx.promptState;
            if (!ps || !ps.active) return '';
            if (ps.cursor < ps.answers.length) {
                return String(ps.answers[ps.cursor++] ?? '');
            }
            ps.pause = {
                kind: 'prompt_input',
                message: String(msg ?? '값을 입력하세요'),
                options: [],
                trigger: ps.triggerName,
                charIndex: activeCtx.charIndex,
                chatIndex: activeCtx.chatIndex,
                answersSoFar: ps.answers.slice(),
            };
            throw new Error('__RS_LUA_PROMPT_PAUSE__');
        });
        engine.global.set('alertSelect', async (_id, options, msg) => {
            const ps = activeCtx.promptState;
            if (!ps || !ps.active) return '0';
            if (ps.cursor < ps.answers.length) {
                return String(ps.answers[ps.cursor++] ?? '0');
            }
            ps.pause = {
                kind: 'prompt_select',
                message: String(msg ?? '항목을 선택하세요'),
                options: luaOptionsObjToArray(options),
                trigger: ps.triggerName,
                charIndex: activeCtx.charIndex,
                chatIndex: activeCtx.chatIndex,
                answersSoFar: ps.answers.slice(),
            };
            throw new Error('__RS_LUA_PROMPT_PAUSE__');
        });

        // Low-level LLM & Image Generation APIs
        engine.global.set('LLMMain', async (_id, promptJson, _useMM, optionsJson) => {
            if (!stateHolder.allowLowLevel) {
                return JSON.stringify({ success: false, result: 'Low level access is required' });
            }
            if (typeof runLLM !== 'function') {
                return JSON.stringify({ success: false, result: 'LLM runner unavailable' });
            }
            return await withModActivity(entry.sourceKind === 'bot' ? 'bot_module' : 'module', entry.sourceName, '메인 LLM 호출', async () => {
                try {
                    let opts = {};
                    try { opts = optionsJson ? JSON.parse(optionsJson) : {}; } catch (_) {}
                    const messages = normalizePromptMessagesFromLua(promptJson);
                    const r = await runLLM({
                        mode: 'model',
                        messages,
                        ...(opts && typeof opts === 'object' ? opts : {}),
                    }, `module:${entry.sourceName}`);
                    if (r && r.type === 'success') {
                        return JSON.stringify({ success: true, result: String(r.result ?? r.content ?? '') });
                    }
                    return JSON.stringify({ success: false, result: String((r && r.result) || 'LLM failed') });
                } catch (e) {
                    return JSON.stringify({ success: false, result: e && e.message ? e.message : String(e) });
                }
            });
        });

        engine.global.set('axLLMMain', async (_id, promptJson, _useMM, optionsJson) => {
            if (!stateHolder.allowLowLevel) {
                return JSON.stringify({ success: false, result: 'Low level access is required' });
            }
            if (typeof runLLM !== 'function') {
                return JSON.stringify({ success: false, result: 'LLM runner unavailable' });
            }
            return await withModActivity(entry.sourceKind === 'bot' ? 'bot_module' : 'module', entry.sourceName, '보조 LLM 호출', async () => {
                try {
                    let opts = {};
                    try { opts = optionsJson ? JSON.parse(optionsJson) : {}; } catch (_) {}
                    const messages = normalizePromptMessagesFromLua(promptJson);
                    const mode = (opts && typeof opts.mode === 'string' && opts.mode) ? opts.mode : 'otherAx';
                    const r = await runLLM({
                        mode,
                        messages,
                        ...(opts && typeof opts === 'object' ? opts : {}),
                    }, `module:${entry.sourceName}:ax`);
                    if (r && r.type === 'success') {
                        return JSON.stringify({ success: true, result: String(r.result ?? r.content ?? '') });
                    }
                    return JSON.stringify({ success: false, result: String((r && r.result) || 'axLLM failed') });
                } catch (e) {
                    return JSON.stringify({ success: false, result: e && e.message ? e.message : String(e) });
                }
            });
        });

        engine.global.set('simpleLLMMain', async (_id, promptStr) => {
            if (!stateHolder.allowLowLevel) {
                return JSON.stringify({ success: false, result: 'Low level access is required' });
            }
            if (typeof runLLM !== 'function') {
                return JSON.stringify({ success: false, result: 'LLM runner unavailable' });
            }
            return await withModActivity(entry.sourceKind === 'bot' ? 'bot_module' : 'module', entry.sourceName, '간이 LLM 호출', async () => {
                try {
                    const r = await runLLM({
                        mode: 'otherAx',
                        messages: [{ role: 'user', content: String(promptStr ?? '') }],
                    }, `module:${entry.sourceName}:simple`);
                    if (r && r.type === 'success') {
                        return JSON.stringify({ success: true, result: String(r.result ?? r.content ?? '') });
                    }
                    return JSON.stringify({ success: false, result: String((r && r.result) || 'simpleLLM failed') });
                } catch (e) {
                    return JSON.stringify({ success: false, result: e && e.message ? e.message : String(e) });
                }
            });
        });

        engine.global.set('generateImage', async (_id, positive, negative, optionsArg) => {
            if (!stateHolder.allowLowLevel) {
                return 'Error: Low level access is required';
            }
            if (!imageProvider || typeof imageProvider.generateInlay !== 'function') {
                return 'Error: Image generation provider is not configured';
            }
            let opts = {};
            if (typeof optionsArg === 'string') {
                try { opts = JSON.parse(optionsArg); } catch (_) {}
            } else if (optionsArg && typeof optionsArg === 'object') {
                opts = optionsArg;
            }
            return await withModActivity(entry.sourceKind === 'bot' ? 'bot_module' : 'module', entry.sourceName, '삽화 생성', async () => {
                try {
                    const res = await imageProvider.generateInlay({
                        positive: String(positive || ''),
                        negative: String(negative || ''),
                        options: opts,
                        charObj: activeCtx.charObj,
                    });
                    return res.inlayToken;
                } catch (e) {
                    return `Error: ${e && e.message ? e.message : String(e)}`;
                }
            });
        });

        await engine.doString(LUA_PREAMBLE);
        await engine.doString(entry.code);
        engineCache.set(entry.key, stateHolder);
        return stateHolder;
    }

    async function loadActiveModulesForTurn(charIndex, chatIndex) {
        if (!isRpcConnected()) {
            return { modules: [], globalChatVariables: {} };
        }
        try {
            const res = await hostRpc.invoke('db.getActiveModules', [Number(charIndex), Number(chatIndex)]);
            return res && typeof res === 'object' ? res : { modules: [], globalChatVariables: {} };
        } catch (_) {
            return { modules: [], globalChatVariables: {} };
        }
    }

    async function prepareTurn({ charIndex, chatIndex, charObj, chatObj, modulesOverride = null, globalVarsOverride = null, onSyncBack = null, personaName = 'User' } = {}) {
        const modPayload = Array.isArray(modulesOverride)
            ? { modules: modulesOverride, globalChatVariables: globalVarsOverride || {} }
            : await loadActiveModulesForTurn(charIndex, chatIndex);

        if (charObj && modPayload && modPayload.charLowLevelAccess && charObj.lowLevelAccess === undefined) {
            charObj.lowLevelAccess = true;
        }
        activeCtx = {
            active: true,
            charIndex: Number(charIndex),
            chatIndex: Number(chatIndex),
            charObj: charObj || null,
            chatObj: chatObj || null,
            modules: Array.isArray(modPayload.modules) ? modPayload.modules : [],
            globalVars: {},
            personaName: String((charObj && charObj.personaName) || personaName || 'User'),
            stopSending: false,
            needsDisplayRefresh: false,
            syncToSharedTurn: onSyncBack,
            promptState: null,
        };
        activeCtx.globalVars = computeGlobalVars(globalVarsOverride || modPayload.globalChatVariables || {});
        return activeCtx;
    }

    function endTurn() {
        invalidateDisplayCache();
        activeCtx.active = false;
        activeCtx.syncToSharedTurn = null;
    }

    function commitCtxSync() {
        if (typeof activeCtx.syncToSharedTurn === 'function') {
            activeCtx.syncToSharedTurn({ charObj: activeCtx.charObj, chatObj: activeCtx.chatObj });
        }
    }

    async function runTriggerMode(mode, { data = '', meta = null } = {}) {
        if (!activeCtx.active) return { stopSending: false, needsDisplayRefresh: false, handled: false };
        const fnMap = {
            start: 'onStart',
            input: 'onInput',
            output: 'onOutput',
            onButtonClick: 'onButtonClick',
            onFormSubmit: 'onFormSubmit',
        };
        const luaFnName = fnMap[mode];
        if (!luaFnName) return { stopSending: false, needsDisplayRefresh: false, handled: false };

        const entries = collectTriggerLuaEntries(activeCtx.charObj, activeCtx.modules);
        let handled = false;
        const triggerId = `rs_${activeCtx.charIndex}_${activeCtx.chatIndex}`;

        for (const entry of entries) {
            let holder;
            try {
                holder = await createOrGetEngine(entry);
            } catch (err) {
                console.warn(`[Module:${entry.sourceName}] compile error:`, err.message);
                continue;
            }
            const { engine } = holder;
            const prevLL = holder.allowLowLevel;
            holder.allowLowLevel = Boolean(entry.lowLevelAccess);
            try {
                // Check global type directly on main global state before invoking
                engine.global.lua.lua_getglobal(engine.global.address, luaFnName);
                const tType = engine.global.lua.lua_type(engine.global.address, -1);
                engine.global.pop();
                if (tType !== 6 /* LUA_TFUNCTION */) continue;

                handled = true;
                let callArgs = [triggerId];
                if (mode === 'onButtonClick') {
                    callArgs = [triggerId, String(data || '')];
                } else if (mode === 'onFormSubmit') {
                    const key = meta && meta.key ? String(meta.key) : String(data || '');
                    const payload = JSON.stringify({ data: (meta && meta.formValues) || {} });
                    callArgs = [triggerId, key, payload];
                }

                let ret = await withModActivity(
                    entry.sourceKind === 'bot' ? 'bot_module' : 'module',
                    entry.sourceName,
                    luaFnName,
                    async () => {
                        let r = await runThreadCall(engine, (t) => {
                            t.lua.lua_getglobal(t.address, '__rsCallTrigger');
                        }, [luaFnName, ...callArgs]);
                        if (r && typeof r.then === 'function') r = await r;
                        return r;
                    }
                );

                commitCtxSync();
                if (mode === 'onButtonClick' && ret !== undefined && ret !== null) {
                    break;
                }
            } catch (err) {
                console.warn(`[Module:${entry.sourceName}] ${luaFnName} error:`, err.message);
            } finally {
                holder.allowLowLevel = prevLL;
            }
        }
        return {
            stopSending: activeCtx.stopSending,
            needsDisplayRefresh: activeCtx.needsDisplayRefresh,
            handled,
        };
    }

    async function runEditPhase(phase, data, meta = {}, { skipRegex = false } = {}) {
        const regexModeMap = {
            editInput: 'editinput',
            editRequest: 'editprocess',
            editOutput: 'editoutput',
            editDisplay: 'editdisplay',
        };
        const regexMode = regexModeMap[phase];
        const scripts = activeCtx.active ? getAllMergedScripts() : [];
        let current = data;

        // 1) Custom regex scripts
        if (!skipRegex && regexMode && scripts.length) {
            const hasMatchingRegex = scripts.some((s) => s && s.type === regexMode && s.in);
            const runRegex = () => {
                if (phase === 'editRequest' && Array.isArray(current)) {
                    const lastId = Math.max(0, current.length - 1);
                    current = current.map((m, mIdx) => ({
                        ...m,
                        content: runRegexScripts(regexMode, String((m && m.content) ?? ''), scripts, (t) => runCbs(t, mIdx, lastId)),
                    }));
                } else if (typeof current === 'string') {
                    current = runRegexScripts(regexMode, current, scripts, runCbs);
                }
            };
            if (hasMatchingRegex) {
                await withModActivity('module', '정규식 스크립트', phase, async () => runRegex());
            }
        }

        if (!activeCtx.active) return current;

        // 2) Lua listenEdit handlers
        const entries = collectTriggerLuaEntries(activeCtx.charObj, activeCtx.modules);
        const triggerId = `rs_${activeCtx.charIndex}_${activeCtx.chatIndex}`;

        for (const entry of entries) {
            let holder;
            try {
                holder = await createOrGetEngine(entry);
            } catch (err) {
                console.warn(`[Module:${entry.sourceName}] compile error:`, err.message);
                continue;
            }
            const { engine } = holder;
            const prevLL = holder.allowLowLevel;
            holder.allowLowLevel = false; // RisuAI sets lowLevelAccess = false for edit hooks
            try {
                let hasHandlers = false;
                try {
                    const check = await runThreadCall(engine, (t) => {
                        t.lua.lua_getglobal(t.address, '__rsHasEditHandler');
                    }, [phase]);
                    hasHandlers = Boolean(check);
                } catch (_) {
                    hasHandlers = true;
                }
                if (!hasHandlers) continue;

                const res = await withModActivity(
                    entry.sourceKind === 'bot' ? 'bot_module' : 'module',
                    entry.sourceName,
                    phase,
                    async () => await runThreadCall(engine, (t) => {
                        t.lua.lua_getglobal(t.address, '__rsRunEditHandlers');
                    }, [phase, triggerId, current, meta || {}])
                );
                if (res !== undefined && res !== null) {
                    if (phase === 'editRequest') {
                        if (Array.isArray(res)) {
                            current = res;
                        } else if (typeof res === 'object') {
                            // Handle sparse/1-based JS object table conversion if returned non-array
                            const arr = [];
                            const keys = Object.keys(res)
                                .map((k) => Number(k))
                                .filter((n) => Number.isInteger(n) && n >= 1)
                                .sort((a, b) => a - b);
                            for (const k of keys) arr.push(res[k]);
                            if (arr.length || Object.keys(res).length === 0) current = arr;
                        }
                    } else if (typeof res === 'string') {
                        current = res;
                    }
                }
                commitCtxSync();
            } catch (err) {
                console.warn(`[Module:${entry.sourceName}] listenEdit(${phase}) error:`, err.message);
            } finally {
                holder.allowLowLevel = prevLL;
            }
        }
        return current;
    }

    async function runManualTrigger({
        charIndex,
        chatIndex,
        charObj,
        chatObj,
        modulesOverride = null,
        triggerName = '',
        promptAnswers = [],
    } = {}) {
        const target = String(triggerName || '').trim();
        if (!target) return { handled: false, pause: null, chatObj, charObj };
        const wasActive = activeCtx.active;
        await prepareTurn({ charIndex, chatIndex, charObj, chatObj, modulesOverride });
        activeCtx.promptState = {
            active: true,
            cursor: 0,
            answers: Array.isArray(promptAnswers) ? promptAnswers.slice() : [],
            triggerName: target,
            pause: null,
        };
        let handled = false;
        try {
            // Layer 1: Non-Lua manual triggers (e.g. setvar/v2SetVar for greeting toggles / bot menus)
            const trigSources = [];
            if (activeCtx.charObj && Array.isArray(activeCtx.charObj.triggerscript)) {
                trigSources.push({ name: activeCtx.charObj.name || 'character', kind: 'bot_module', list: activeCtx.charObj.triggerscript });
            }
            for (const m of activeCtx.modules || []) {
                const trList = m && (Array.isArray(m.trigger) ? m.trigger : (Array.isArray(m.triggerscript) ? m.triggerscript : null));
                if (trList) trigSources.push({ name: m.name || m.id || 'module', kind: 'module', list: trList });
            }
            for (const src of trigSources) {
                for (const tr of src.list) {
                    if (!tr || tr.type !== 'manual') continue;
                    if (tr.comment !== target && tr.id !== target) continue;
                    let applied = false;
                    if (!activeCtx.chatObj) continue;
                    if (!activeCtx.chatObj.scriptstate || typeof activeCtx.chatObj.scriptstate !== 'object') {
                        activeCtx.chatObj.scriptstate = {};
                    }
                    for (const ef of tr.effect || []) {
                        if (!ef) continue;
                        if ((ef.type === 'setvar' || ef.type === 'v2SetVar') && ef.var) {
                            const key = String(ef.var).startsWith('$') ? String(ef.var).slice(1) : String(ef.var);
                            if (ef.operator === '+=') {
                                activeCtx.chatObj.scriptstate['$' + key] = String((Number(activeCtx.chatObj.scriptstate['$' + key]) || 0) + (Number(ef.value) || 0));
                            } else if (ef.operator === '-=') {
                                activeCtx.chatObj.scriptstate['$' + key] = String((Number(activeCtx.chatObj.scriptstate['$' + key]) || 0) - (Number(ef.value) || 0));
                            } else {
                                activeCtx.chatObj.scriptstate['$' + key] = String(ef.value ?? '');
                            }
                            applied = true;
                        }
                    }
                    if (applied) {
                        await withModActivity(src.kind, src.name, `메뉴: ${target}`, async () => {});
                        commitCtxSync();
                        handled = true;
                        return {
                            handled: true,
                            pause: null,
                            chatObj: activeCtx.chatObj,
                            charObj: activeCtx.charObj,
                        };
                    }
                }
            }

            // Layer 2: Lua trigger functions named `target`
            const entries = collectTriggerLuaEntries(activeCtx.charObj, activeCtx.modules);
            const triggerId = `rs_${activeCtx.charIndex}_${activeCtx.chatIndex}`;
            for (const entry of entries) {
                let holder;
                try {
                    holder = await createOrGetEngine(entry);
                } catch (err) {
                    console.warn(`[Module:${entry.sourceName}] compile error:`, err.message);
                    continue;
                }
                const { engine } = holder;
                const prevLL = holder.allowLowLevel;
                holder.allowLowLevel = Boolean(entry.lowLevelAccess);
                try {
                    engine.global.lua.lua_getglobal(engine.global.address, target);
                    const tType = engine.global.lua.lua_type(engine.global.address, -1);
                    engine.global.pop();
                    if (tType !== 6 /* LUA_TFUNCTION */) continue;

                    handled = true;
                    await withModActivity(
                        entry.sourceKind === 'bot' ? 'bot_module' : 'module',
                        entry.sourceName,
                        `트리거: ${target}`,
                        async () => {
                            let r = await runThreadCall(engine, (t) => {
                                t.lua.lua_getglobal(t.address, '__rsCallTrigger');
                            }, [target, triggerId]);
                            if (r && typeof r.then === 'function') r = await r;
                        }
                    );
                    commitCtxSync();
                    break;
                } catch (err) {
                    if (activeCtx.promptState && activeCtx.promptState.pause) {
                        return {
                            handled: true,
                            pause: activeCtx.promptState.pause,
                            chatObj: activeCtx.chatObj,
                            charObj: activeCtx.charObj,
                        };
                    }
                    console.warn(`[Module:${entry.sourceName}] manual trigger ${target} error:`, err.message);
                } finally {
                    holder.allowLowLevel = prevLL;
                }
            }
            return {
                handled,
                pause: (activeCtx.promptState && activeCtx.promptState.pause) || null,
                chatObj: activeCtx.chatObj,
                charObj: activeCtx.charObj,
            };
        } finally {
            activeCtx.promptState = null;
            if (!wasActive) endTurn();
        }
    }

    async function runInteraction({ charIndex, chatIndex, charObj, chatObj, modulesOverride = null, personaName = undefined, kind = 'button', code = '', key = '', formValues = {} } = {}) {
        const wasActive = activeCtx.active;
        await prepareTurn({ charIndex, chatIndex, charObj, chatObj, modulesOverride, ...(personaName ? { personaName } : {}) });
        try {
            const res = kind === 'form'
                ? await runTriggerMode('onFormSubmit', { meta: { key, formValues } })
                : await runTriggerMode('onButtonClick', { data: code });
            return {
                ...res,
                chatObj: activeCtx.chatObj,
                charObj: activeCtx.charObj,
            };
        } finally {
            if (!wasActive) endTurn();
        }
    }

    let displayCtxCache = null;

    function invalidateDisplayCache() {
        displayCtxCache = null;
    }

    function buildAssetPathIndex(charObj, modulesList) {
        const assetPathsByName = Object.create(null);
        const addEntry = (rawName, rawPath, ext = '') => {
            const name = String(rawName || '').trim();
            const p = String(rawPath || '').trim();
            if (!name || !p) return;
            if (!assetPathsByName[name]) assetPathsByName[name] = p;
            const lower = name.toLowerCase();
            if (!assetPathsByName[lower]) assetPathsByName[lower] = p;
            const noExt = lower.replace(/\.[a-z0-9]{2,5}$/i, '');
            if (noExt && !assetPathsByName[noExt]) assetPathsByName[noExt] = p;
            if (ext && !lower.includes('.')) {
                const withExt = `${lower}.${String(ext).toLowerCase()}`;
                if (!assetPathsByName[withExt]) assetPathsByName[withExt] = p;
            }
        };
        const pushList = (arr) => {
            if (!Array.isArray(arr)) return;
            for (const item of arr) {
                if (Array.isArray(item) && item[0] && item[1]) addEntry(item[0], item[1], item[2]);
                else if (item && typeof item === 'object' && item.name && (item.key || item.path)) {
                    addEntry(item.name, item.key || item.path, item.ext);
                }
            }
        };
        if (charObj) {
            pushList(charObj.additionalAssets);
            pushList(charObj.emotionImages);
        }
        for (const m of modulesList || []) {
            if (m && Array.isArray(m.assets)) pushList(m.assets);
        }
        return assetPathsByName;
    }

    async function runDisplayLuaForSnapshot(baseSnap, messages = null, opts = {}) {
        if (!isRpcConnected() || activeCtx.active || !baseSnap || typeof baseSnap !== 'object') return null;
        const msgList = Array.isArray(messages) ? messages : baseSnap.messages;
        if (!Array.isArray(msgList) || !msgList.length) return null;
        const cIdx = Number(baseSnap.charIndex ?? -1);
        const chIdx = Number(baseSnap.chatIndex ?? 0);
        if (!Number.isInteger(cIdx) || cIdx < 0) return null;

        const modSig = Array.isArray(baseSnap.chatModules)
            ? baseSnap.chatModules.map((m) => `${m && m.id}:${m && m.enabled ? 1 : 0}`).join(',')
            : '';
        const cacheKey = `${cIdx}:${chIdx}:${modSig}`;
        const now = Date.now();
        let cached = displayCtxCache && displayCtxCache.key === cacheKey && (now - displayCtxCache.at) < 5000
            ? displayCtxCache
            : null;

        let bundledChat = null;
        const fetchCharDisplayMeta = async () => {
            try {
                const meta = await hostRpc.invoke('db.getCharacterDisplayMeta', [cIdx], 6000);
                if (meta && typeof meta === 'object') return meta;
            } catch (_) {}
            return await hostRpc.invoke('db.getCharacter', [cIdx], 10000);
        };

        if (!cached) {
            try {
                let charObj = null;
                let mods = [];
                let globalChatVariables = {};
                let bundle = null;
                try {
                    bundle = await hostRpc.invoke('db.getDisplayLuaBundle', [cIdx, chIdx], 10000);
                } catch (_) {}
                if (bundle && typeof bundle === 'object' && bundle.charObj) {
                    charObj = bundle.charObj;
                    mods = Array.isArray(bundle.modules) ? bundle.modules : [];
                    globalChatVariables = (bundle.globalChatVariables && typeof bundle.globalChatVariables === 'object') ? bundle.globalChatVariables : {};
                    bundledChat = bundle.chatObj || null;
                } else {
                    const [modPayload, fetchedChar] = await Promise.all([
                        hostRpc.invoke('db.getActiveModules', [cIdx, chIdx], 10000),
                        fetchCharDisplayMeta(),
                    ]);
                    charObj = fetchedChar || null;
                    mods = modPayload && Array.isArray(modPayload.modules) ? modPayload.modules : [];
                    globalChatVariables = (modPayload && modPayload.globalChatVariables) || {};
                }
                const entries = collectTriggerLuaEntries(charObj, mods);
                const hasLuaEditDisplay = entries.some((e) => /listenEdit/i.test(String((e && e.code) || '')));
                cached = {
                    key: cacheKey,
                    at: now,
                    charObj,
                    modules: mods,
                    globalChatVariables,
                    assetPathsByName: buildAssetPathIndex(charObj, mods),
                    hasLuaEditDisplay,
                };
                displayCtxCache = cached;
            } catch (err) {
                console.warn('[ModuleAdapter] runDisplayLuaForSnapshot metadata error:', err && err.message ? err.message : err);
                return null;
            }
        }
        if (!cached || !cached.hasLuaEditDisplay) return null;

        const entries = collectTriggerLuaEntries(cached.charObj, cached.modules);
        if (!entries.length) return null;

        let freshChat = bundledChat;
        if (!freshChat) {
            try {
                freshChat = await hostRpc.invoke('db.getChat', [cIdx, chIdx], 8000);
            } catch (err) {
                console.warn('[ModuleAdapter] runDisplayLuaForSnapshot db.getChat error:', err && err.message ? err.message : err);
            }
        }
        if (!freshChat && cached.charObj && Array.isArray(cached.charObj.chats)) {
            freshChat = cached.charObj.chats[chIdx] || null;
        }
        const chatClone = freshChat
            ? { ...freshChat, scriptstate: { ...(freshChat.scriptstate || {}) } }
            : { message: [], scriptstate: {} };
        if (!Array.isArray(chatClone.message) || !chatClone.message.length) {
            const synthLen = Math.max(
                Number(baseSnap.totalMessages) || 0,
                msgList.reduce((acc, m) => Math.max(acc, Number(m && m.index) >= 0 ? Number(m.index) + 1 : 0), 0)
            );
            const synthMsgs = Array.from({ length: synthLen }, () => ({ role: 'char', data: '', chatId: '' }));
            for (const m of msgList) {
                const idx = Number(m && m.index);
                if (Number.isInteger(idx) && idx >= 0) {
                    synthMsgs[idx] = {
                        role: m.role === 'user' ? 'user' : 'char',
                        data: String(m.raw || m.text || m.html || ''),
                        chatId: String(m.chatId || ''),
                    };
                }
            }
            chatClone.message = synthMsgs;
        }
        if (baseSnap.chatVariables && typeof baseSnap.chatVariables === 'object') {
            for (const [k, v] of Object.entries(baseSnap.chatVariables)) {
                const key = String(k).startsWith('$') ? String(k) : `$${k}`;
                if (!Object.prototype.hasOwnProperty.call(chatClone.scriptstate, key) && v !== undefined && v !== null) {
                    chatClone.scriptstate[key] = String(v);
                }
            }
        }

        const prevCtx = activeCtx;
        try {
            await prepareTurn({
                charIndex: cIdx,
                chatIndex: chIdx,
                charObj: cached.charObj,
                chatObj: chatClone,
                modulesOverride: cached.modules,
                globalVarsOverride: cached.globalChatVariables,
                personaName: (opts && opts.personaName) || (baseSnap.charContext && baseSnap.charContext.personaName) || baseSnap.personaName || 'User',
            });
            let anyHandler = false;
            for (const entry of entries) {
                if (!/listenEdit/i.test(String(entry.code || ''))) continue;
                try {
                    const holder = await createOrGetEngine(entry);
                    const check = await runThreadCall(holder.engine, (t) => {
                        t.lua.lua_getglobal(t.address, '__rsHasEditHandler');
                    }, ['editDisplay']);
                    if (check) {
                        anyHandler = true;
                        break;
                    }
                } catch (err) {
                    console.warn('[ModuleAdapter] editDisplay init error:', entry.sourceName, err && err.message ? err.message : err);
                }
            }
            if (!anyHandler) {
                cached.hasLuaEditDisplay = false;
                return null;
            }

            const htmlByIndex = Object.create(null);
            let changedCount = 0;
            for (const m of msgList) {
                if (!m || typeof m !== 'object') continue;
                const baseHtml = String(m.html || m.raw || m.text || '');
                if (!baseHtml) continue;
                const transformed = await runEditPhase('editDisplay', baseHtml, {
                    index: Number(m.index ?? 0),
                    role: m.role || 'char',
                    chatId: m.chatId || '',
                }, { skipRegex: true });
                if (typeof transformed === 'string' && transformed !== baseHtml) {
                    htmlByIndex[m.index] = transformed;
                    changedCount += 1;
                }
            }
            return changedCount > 0 ? { htmlByIndex, assetPathsByName: cached.assetPathsByName || {} } : null;
        } finally {
            activeCtx = prevCtx;
        }
    }

    function dispose() {
        displayCtxCache = null;
        for (const holder of engineCache.values()) {
            try { holder.engine.global.close(); } catch (_) {}
        }
        engineCache.clear();
    }

    return {
        prepareTurn,
        endTurn,
        runTriggerMode,
        runEditPhase,
        runDisplayLuaForSnapshot,
        invalidateDisplayCache,
        runManualTrigger,
        runInteraction,
        dispose,
        _debug: { engineCache },
    };
}

module.exports = {
    runRegexScripts,
    collectTriggerLuaEntries,
    createModuleAdapter,
};
