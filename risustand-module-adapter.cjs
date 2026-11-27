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

LLM = async(function(id, prompt, useMultimodal, options)
    local pJson = type(prompt) == "string" and prompt or json.encode(prompt or {})
    local oJson = type(options) == "string" and options or json.encode(options or {})
    local resJson = LLMMain(id, pJson, useMultimodal == true, oJson):await()
    local ok, decoded = pcall(json.decode, resJson)
    if ok and type(decoded) == "table" then return decoded end
    return { success = false, result = tostring(resJson or "LLM decode error") }
end)

axLLM = async(function(id, prompt, useMultimodal, options)
    local pJson = type(prompt) == "string" and prompt or json.encode(prompt or {})
    local oJson = type(options) == "string" and options or json.encode(options or {})
    local resJson = axLLMMain(id, pJson, useMultimodal == true, oJson):await()
    local ok, decoded = pcall(json.decode, resJson)
    if ok and type(decoded) == "table" then return decoded end
    return { success = false, result = tostring(resJson or "axLLM decode error") }
end)

simpleLLM = async(function(id, prompt)
    local resJson = simpleLLMMain(id, tostring(prompt or "")):await()
    local ok, decoded = pcall(json.decode, resJson)
    if ok and type(decoded) == "table" then return decoded end
    return { success = false, result = tostring(resJson or "simpleLLM decode error") }
end)
`;

function extractOrderFlag(flagStr) {
    const m = String(flagStr || '').match(/<order\s+(-?\d+)>/i);
    return m ? Number(m[1]) : 0;
}

function runRegexScripts(mode, text, scripts, cbsFn) {
    let cur = String(text ?? '');
    if (!Array.isArray(scripts) || !scripts.length) return cur;

    const matching = [];
    for (let i = 0; i < scripts.length; i += 1) {
        const s = scripts[i];
        if (!s || s.type !== mode) continue;
        if (!s.in || typeof s.in !== 'string') continue;
        matching.push({ script: s, order: extractOrderFlag(s.flag), idx: i });
    }
    matching.sort((a, b) => (b.order - a.order) || (a.idx - b.idx));

    for (const item of matching) {
        const s = item.script;
        try {
            const flagText = String(s.flag || 'g');
            const strippedFlags = flagText.replace(/<[^>]+>/g, '');
            let regexFlags = strippedFlags.replace(/[^dgimsuvy]/g, '');
            if (!regexFlags && !flagText.includes('<no_g>')) regexFlags = 'g';
            if (flagText.includes('<move_top>') || flagText.includes('<move_bottom>')) {
                // tags stripped cleanly above
            }
            const re = new RegExp(s.in, regexFlags);
            if (!re.test(cur)) continue;
            re.lastIndex = 0;
            let outTemplate = String(s.out ?? '');
            if (s.ableFlag && flagText.includes('<cbs>') && typeof cbsFn === 'function') {
                outTemplate = String(cbsFn(outTemplate));
            }
            outTemplate = outTemplate.replace(/\\n/g, '\n');
            cur = cur.replace(re, (...args) => {
                const whole = args[0];
                return outTemplate
                    .replace(/\$&/g, whole)
                    .replace(/\$(\d+)/g, (_, d) => {
                        const n = Number(d);
                        return args[n] !== undefined ? String(args[n]) : '';
                    });
            });
        } catch (_) {}
    }
    return cur;
}

function collectTriggerLuaEntries(charObj, modulesList) {
    const entries = [];
    const charLowLevel = Boolean(charObj && charObj.lowLevelAccess);
    const pushFrom = (trList, sourceName, sourceId, lowLevelAccess) => {
        if (!Array.isArray(trList)) return;
        for (let i = 0; i < trList.length; i += 1) {
            const tr = trList[i];
            if (!tr || !Array.isArray(tr.effect)) continue;
            for (let j = 0; j < tr.effect.length; j += 1) {
                const ef = tr.effect[j];
                if (ef && ef.type === 'triggerlua' && ef.code) {
                    const code = String(ef.code);
                    const hash = crypto.createHash('sha1').update(code).digest('hex').slice(0, 12);
                    entries.push({
                        key: `${sourceId}:${i}:${j}:${hash}`,
                        sourceName,
                        sourceId,
                        code,
                        lowLevelAccess: Boolean(lowLevelAccess),
                    });
                }
            }
        }
    };
    if (charObj && Array.isArray(charObj.triggerscript)) {
        pushFrom(charObj.triggerscript, charObj.name || 'character', `char:${charObj.chaId || charObj.name || '0'}`, charLowLevel);
    }
    for (const m of modulesList || []) {
        const trList = m && (Array.isArray(m.trigger) ? m.trigger : (Array.isArray(m.triggerscript) ? m.triggerscript : null));
        if (trList) {
            pushFrom(trList, m.name || m.id || 'module', `mod:${m.id || m.name || '0'}`, Boolean(m.lowLevelAccess));
        }
    }
    return entries;
}

function normalizePromptMessagesFromLua(promptJson) {
    let arr;
    try {
        arr = typeof promptJson === 'string' ? JSON.parse(promptJson) : promptJson;
    } catch (_) {
        arr = [];
    }
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const m of arr) {
        if (!m || typeof m !== 'object') continue;
        const r = String(m.role || 'user').toLowerCase();
        const role = (r === 'char' || r === 'model' || r === 'assistant') ? 'assistant'
            : (r === 'system' ? 'system' : 'user');
        out.push({
            role,
            content: typeof m.content === 'string' ? m.content : String(m.data ?? m.content ?? ''),
        });
    }
    return out;
}

function createModuleAdapter({
    hostRpc = null,
    getBackendConfig = () => ({}),
    runLLM = null,
    imageProvider = null,
    evalCbs = (s) => String(s ?? ''),
    onTriggerNotice = () => {},
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
    };

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

    function buildCbsContext() {
        const cVars = {};
        if (activeCtx.chatObj && activeCtx.chatObj.scriptstate && typeof activeCtx.chatObj.scriptstate === 'object') {
            for (const [k, v] of Object.entries(activeCtx.chatObj.scriptstate)) {
                const clean = k.startsWith('$') ? k.slice(1) : k;
                if (clean) cVars[clean] = String(v ?? '');
            }
        }
        return {
            charName: String((activeCtx.charObj && activeCtx.charObj.name) || 'Character'),
            personaName: 'User',
            chatVars: cVars,
            globalVars: { ...(activeCtx.globalVars || {}) },
        };
    }

    function runCbs(text) {
        try {
            return String(evalCbs(String(text ?? ''), buildCbsContext()));
        } catch (_) {
            return String(text ?? '');
        }
    }

    function computeGlobalVars(dbGlobals = {}) {
        const out = {};
        if (dbGlobals && typeof dbGlobals === 'object') {
            for (const [k, v] of Object.entries(dbGlobals)) {
                if (v !== undefined && v !== null) out[String(k)] = String(v);
            }
        }
        const cfg = typeof getBackendConfig === 'function' ? getBackendConfig() : {};
        if (cfg && cfg.remoteToggleValues && typeof cfg.remoteToggleValues === 'object') {
            for (const [k, v] of Object.entries(cfg.remoteToggleValues)) {
                if (k && v !== undefined && v !== null) {
                    const fk = k.startsWith('toggle_') ? k : `toggle_${k}`;
                    out[fk] = String(v);
                    out[k.startsWith('toggle_') ? k.slice(7) : k] = String(v);
                }
            }
        }
        if (activeCtx.chatObj && activeCtx.chatObj.useLocallySetGlobalVariables && activeCtx.chatObj.GLGlobalVariables) {
            for (const [k, v] of Object.entries(activeCtx.chatObj.GLGlobalVariables)) {
                if (k && v !== undefined && v !== null) out[String(k)] = String(v);
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
            return '';
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

        // CBS, Hashing & UI alerts/controls
        engine.global.set('cbs', (_id, text) => runCbs(text));
        engine.global.set('hash', (_id, text) => crypto.createHash('sha256').update(String(text ?? '')).digest('hex'));
        engine.global.set('stopChat', () => {
            activeCtx.stopSending = true;
        });
        engine.global.set('reloadDisplay', () => {
            activeCtx.needsDisplayRefresh = true;
        });
        engine.global.set('reloadChat', () => {
            activeCtx.needsDisplayRefresh = true;
        });
        engine.global.set('alertNormal', (_id, msg) => {
            onTriggerNotice({ kind: 'notice', title: entry.sourceName, message: String(msg ?? '') });
        });
        engine.global.set('alertError', (_id, msg) => {
            onTriggerNotice({ kind: 'alert_error', title: entry.sourceName, message: String(msg ?? '') });
        });
        engine.global.set('alertConfirm', async () => true);
        engine.global.set('alertInput', async () => '');
        engine.global.set('alertSelect', async () => '0');

        // Low-level LLM & Image Generation APIs
        engine.global.set('LLMMain', async (_id, promptJson, _useMM, optionsJson) => {
            if (!stateHolder.allowLowLevel) {
                return JSON.stringify({ success: false, result: 'Low level access is required' });
            }
            if (typeof runLLM !== 'function') {
                return JSON.stringify({ success: false, result: 'LLM runner unavailable' });
            }
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

        engine.global.set('axLLMMain', async (_id, promptJson, _useMM, optionsJson) => {
            if (!stateHolder.allowLowLevel) {
                return JSON.stringify({ success: false, result: 'Low level access is required' });
            }
            if (typeof runLLM !== 'function') {
                return JSON.stringify({ success: false, result: 'LLM runner unavailable' });
            }
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

        engine.global.set('simpleLLMMain', async (_id, promptStr) => {
            if (!stateHolder.allowLowLevel) {
                return JSON.stringify({ success: false, result: 'Low level access is required' });
            }
            if (typeof runLLM !== 'function') {
                return JSON.stringify({ success: false, result: 'LLM runner unavailable' });
            }
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

    async function prepareTurn({ charIndex, chatIndex, charObj, chatObj, modulesOverride = null, globalVarsOverride = null, onSyncBack = null } = {}) {
        const modPayload = Array.isArray(modulesOverride)
            ? { modules: modulesOverride, globalChatVariables: globalVarsOverride || {} }
            : await loadActiveModulesForTurn(charIndex, chatIndex);

        activeCtx = {
            active: true,
            charIndex: Number(charIndex),
            chatIndex: Number(chatIndex),
            charObj: charObj || null,
            chatObj: chatObj || null,
            modules: Array.isArray(modPayload.modules) ? modPayload.modules : [],
            globalVars: {},
            stopSending: false,
            needsDisplayRefresh: false,
            syncToSharedTurn: onSyncBack,
        };
        activeCtx.globalVars = computeGlobalVars(globalVarsOverride || modPayload.globalChatVariables || {});
        return activeCtx;
    }

    function endTurn() {
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

                let ret = await runThreadCall(engine, (t) => {
                    t.lua.lua_getglobal(t.address, '__rsCallTrigger');
                }, [luaFnName, ...callArgs]);
                if (ret && typeof ret.then === 'function') ret = await ret;

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

    async function runEditPhase(phase, data, meta = {}) {
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
        if (regexMode && scripts.length) {
            if (phase === 'editRequest' && Array.isArray(current)) {
                current = current.map((m) => ({
                    ...m,
                    content: runRegexScripts(regexMode, String((m && m.content) ?? ''), scripts, runCbs),
                }));
            } else if (typeof current === 'string') {
                current = runRegexScripts(regexMode, current, scripts, runCbs);
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
                const res = await runThreadCall(engine, (t) => {
                    t.lua.lua_getglobal(t.address, '__rsRunEditHandlers');
                }, [phase, triggerId, current, meta || {}]);
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

    async function runInteraction({ charIndex, chatIndex, charObj, chatObj, modulesOverride = null, kind = 'button', code = '', key = '', formValues = {} } = {}) {
        const wasActive = activeCtx.active;
        await prepareTurn({ charIndex, chatIndex, charObj, chatObj, modulesOverride });
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

    function dispose() {
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
