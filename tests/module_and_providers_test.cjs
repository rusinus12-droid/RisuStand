'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRelayServer, evalPresetCbs } = require('../risustand-relay-server.js');
const { buildSingleFileZip, extractFirstImageFromZip, createImageProvider } = require('../risustand-image-provider.cjs');
const { createModuleAdapter, runRegexScripts } = require('../risustand-module-adapter.cjs');

const ONE_BY_ONE_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
);

async function listenServer(srv) {
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const addr = srv.address();
    return `http://127.0.0.1:${addr.port}`;
}

async function closeServer(srv) {
    if (!srv) return;
    await new Promise((resolve) => srv.close(() => resolve()));
}

function createFakeHostBridge({ modules = [], charObj = null, chatObj = null, imageConfig = {} } = {}) {
    const dbState = {
        char: charObj || {
            chaId: 'char-uuid-1',
            name: 'Iris',
            desc: 'Archivist assistant',
            personality: 'Calm',
            scenario: 'Library',
            systemPrompt: '',
            replaceGlobalNote: '',
            lowLevelAccess: false,
            triggerscript: [],
            customscript: [],
            globalLore: [],
            chatPage: 0,
            chats: [],
        },
        chat: chatObj || {
            id: 'chat-uuid-1',
            name: 'Chat 1',
            note: '',
            modules: modules.map((m) => m.id),
            localLore: [],
            scriptstate: {},
            message: [],
        },
        pluginStorage: {},
        safeLocal: {},
        inlays: {},
        imageConfig,
    };
    dbState.char.chats = [dbState.chat];

    let stopRequested = false;
    let loopPromise = null;

    async function handleRpcCall(op, args) {
        const a = Array.isArray(args) ? args : [];
        if (op === 'pluginStorage.getItem') return Object.prototype.hasOwnProperty.call(dbState.pluginStorage, a[0]) ? dbState.pluginStorage[a[0]] : null;
        if (op === 'pluginStorage.setItem') { dbState.pluginStorage[a[0]] = a[1]; return true; }
        if (op === 'pluginStorage.removeItem') { delete dbState.pluginStorage[a[0]]; return true; }
        if (op === 'pluginStorage.keys') return Object.keys(dbState.pluginStorage);
        if (op === 'safeLocalStorage.getItem') return Object.prototype.hasOwnProperty.call(dbState.safeLocal, a[0]) ? dbState.safeLocal[a[0]] : null;
        if (op === 'safeLocalStorage.setItem') { dbState.safeLocal[a[0]] = String(a[1] ?? ''); return true; }
        if (op === 'db.getCurrentIndices') return { charIndex: 0, chatIndex: 0, viewCharIndex: 0, viewChatIndex: 0 };
        if (op === 'db.getCharacter') return JSON.parse(JSON.stringify(dbState.char));
        if (op === 'db.setCharacter') { dbState.char = JSON.parse(JSON.stringify(a[1])); return true; }
        if (op === 'db.getChat') return JSON.parse(JSON.stringify(dbState.chat));
        if (op === 'db.setChat') {
            dbState.chat = JSON.parse(JSON.stringify(a[2]));
            dbState.char.chats[0] = dbState.chat;
            return true;
        }
        if (op === 'db.getDatabase') return { characters: [dbState.char], modules, enabledModules: modules.map((m) => m.id), globalChatVariables: {} };
        if (op === 'db.getPlugins') return [];
        if (op === 'db.getActiveModules') return { modules, globalChatVariables: {} };
        if (op === 'db.getImageGenConfig') return dbState.imageConfig || {};
        if (op === 'asset.createInlay') {
            const p = a[0] || {};
            const id = `inlay-${Object.keys(dbState.inlays).length + 1}`;
            dbState.inlays[id] = { data: p.dataUri || `data:image/png;base64,${p.__b64 || ''}`, type: 'image', ext: 'png', name: p.name || id };
            return id;
        }
        if (op === 'asset.readInlay') return dbState.inlays[a[0]] || null;
        return null;
    }

    function startRpcLoop(baseUrl, token) {
        stopRequested = false;
        loopPromise = (async () => {
            while (!stopRequested) {
                try {
                    const wResp = await fetch(`${baseUrl}/api/pc/rpc-wait`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
                        body: JSON.stringify({ timeoutMs: 3000 }),
                    });
                    if (!wResp.ok) break;
                    const data = await wResp.json();
                    if (Array.isArray(data.calls) && data.calls.length) {
                        const results = [];
                        for (const c of data.calls) {
                            try {
                                const value = await handleRpcCall(c.op, c.args);
                                results.push({ id: c.id, ok: true, value });
                            } catch (e) {
                                results.push({ id: c.id, ok: false, error: e.message });
                            }
                        }
                        await fetch(`${baseUrl}/api/pc/rpc-result`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
                            body: JSON.stringify({ results }),
                        });
                    }
                } catch (_) {
                    if (stopRequested) break;
                    await new Promise((r) => setTimeout(r, 40));
                }
            }
        })();
    }

    async function pushSnapshot(baseUrl, token) {
        const msgs = (dbState.chat.message || []).map((m, idx) => ({
            index: idx,
            role: m.role,
            chatId: m.chatId || '',
            text: m.data || '',
            html: m.data || '',
            raw: m.data || '',
            images: [],
            swipeCount: 1,
            swipeIndex: 0,
        }));
        await fetch(`${baseUrl}/api/pc/poll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({
                bridgeVersion: '2.0.0',
                pluginVersion: '1.1.0',
                generating: false,
                supportsBatchCommands: true,
                catalog: {
                    pcActiveCharIndex: 0,
                    pcActiveChatIndex: 0,
                    selectedPersona: 0,
                    params: { temperature: 80, maxContext: 8000, maxResponse: 1000 },
                    characters: [{ index: 0, name: dbState.char.name, activeChatIndex: 0, chats: [{ index: 0, name: 'Chat 1' }] }],
                    modules: [],
                    personas: [{ index: 0, name: 'User' }],
                },
                snapshot: {
                    charName: dbState.char.name,
                    charIndex: 0,
                    chatIndex: 0,
                    chatUuid: dbState.chat.id,
                    chatName: 'Chat 1',
                    isPcActive: true,
                    totalMessages: msgs.length,
                    chatModules: dbState.chat.modules || [],
                    chatVariables: {},
                    assetMap: {},
                    messages: msgs,
                    charContext: { charId: dbState.char.chaId, name: dbState.char.name, personaName: 'User' },
                },
            }),
        });
    }

    async function stop() {
        stopRequested = true;
        if (loopPromise) await loopPromise.catch(() => {});
    }

    return { dbState, startRpcLoop, pushSnapshot, stop };
}

test('Phase 1: Dual Model Pipeline (model vs otherAx) & plugin addProvider registry', async () => {
    const mainHits = [];
    const auxHits = [];
    const mockUpstream = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/main') {
            mainHits.push(body);
            res.end(JSON.stringify({ choices: [{ message: { content: 'MAIN_REPLY' } }] }));
        } else {
            auxHits.push(body);
            res.end(JSON.stringify({ choices: [{ message: { content: 'AUX_REPLY' } }] }));
        }
    });
    const upUrl = await listenServer(mockUpstream);

    const tmpPlugins = path.join(os.tmpdir(), `rs-p1-${Date.now()}.json`);
    const token = 'test-p1-tok';
    const relay = createRelayServer({
        token,
        configOverride: {
            activeProfileId: 'prof-main',
            auxProfileId: 'prof-aux',
            directPresetId: 'off',
            remoteDirectOnly: true,
            profiles: [
                { id: 'prof-main', name: 'MainModel', providerType: 'openai_compat', baseUrl: `${upUrl}/main`, apiKey: 'k1', model: 'gpt-main' },
                { id: 'prof-aux', name: 'AuxModel', providerType: 'openai_compat', baseUrl: `${upUrl}/aux`, apiKey: 'k2', model: 'gpt-aux' },
            ],
        },
    });
    const baseUrl = await listenServer(relay);

    try {
        // Upload plugin that calls addProvider and exposes a trigger test via GUI RPC or direct test
        const pluginScript = `//@name dual-tester\n//@api 3.0\nRisuai.addProvider('MyCustomProv', async (req) => ({ success: true, content: 'CUSTOM_PROV_OK' }), { model: 'custom-1' });\nRisuai.registerSetting('Test', async () => {});`;
        const upRes = await fetch(`${baseUrl}/api/plugins/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ filename: 'dual.js', script: pluginScript, enabled: true }),
        });
        assert.equal(upRes.status, 200);

        const rMain = await fetch(`${baseUrl}/api/plugins/gui-rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({
                pluginName: 'dual-tester',
                method: 'runLLMModel',
                args: [{ mode: 'model', messages: [{ role: 'user', content: 'hi main' }] }],
            }),
        }).then((r) => r.json());
        assert.equal(rMain.value.result, 'MAIN_REPLY');

        const rAux = await fetch(`${baseUrl}/api/plugins/gui-rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({
                pluginName: 'dual-tester',
                method: 'runLLMModel',
                args: [{ mode: 'otherAx', messages: [{ role: 'user', content: 'hi aux' }] }],
            }),
        }).then((r) => r.json());
        assert.equal(rAux.value.result, 'AUX_REPLY');

        const rCustom = await fetch(`${baseUrl}/api/plugins/gui-rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({
                pluginName: 'dual-tester',
                method: 'runLLMModel',
                args: [{ mode: 'otherAx', allowPlugins: true, provider: 'MyCustomProv', messages: [{ role: 'user', content: 'hi custom' }] }],
            }),
        }).then((r) => r.json());
        assert.equal(rCustom.value.result, 'CUSTOM_PROV_OK');

        assert.equal(mainHits.length, 1);
        assert.equal(auxHits.length, 1);
    } finally {
        await closeServer(relay);
        await closeServer(mockUpstream);
        try { fs.rmSync(tmpPlugins, { force: true }); } catch (_) {}
    }
});

test('Phase 2 & 4: Backend Image Provider (NovelAI ZIP + ComfyUI) + Lightboard Inter-Module & Interaction', async () => {
    // 1. Test ZIP roundtrip + multi-character NovelAI v4.5 payload + ComfyUI flow
    const naiPayloads = [];
    const mockImgApi = http.createServer(async (req, res) => {
        if (req.url === '/nai/generate-image' && req.method === 'POST') {
            const chunks = [];
            for await (const c of req) chunks.push(c);
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            naiPayloads.push(body);
            const zipBuf = buildSingleFileZip('image_0.png', ONE_BY_ONE_PNG, { compress: true });
            res.writeHead(200, { 'Content-Type': 'application/zip' });
            res.end(zipBuf);
            return;
        }
        if (req.url === '/comfy/prompt' && req.method === 'POST') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ prompt_id: 'cid-42' }));
            return;
        }
        if (req.url === '/comfy/history/cid-42') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 'cid-42': { outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } }));
            return;
        }
        if (req.url.startsWith('/comfy/view')) {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.end(ONE_BY_ONE_PNG);
            return;
        }
        res.writeHead(404);
        res.end();
    });
    const imgUrl = await listenServer(mockImgApi);

    const extracted = extractFirstImageFromZip(buildSingleFileZip('sample.png', ONE_BY_ONE_PNG, { compress: true }));
    assert.equal(extracted.mime, 'image/png');
    assert.ok(extracted.dataUri.startsWith('data:image/png;base64,'));

    // Mock upstream LLM (Aux model receives Lightboard prompt extraction)
    const llmCalls = [];
    const mockLLM = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        llmCalls.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/aux') {
            res.end(JSON.stringify({ choices: [{ message: { content: '1girl, reading a book | 1boy, smiling' } }] }));
        } else {
            res.end(JSON.stringify({ choices: [{ message: { content: 'The librarian turned the golden page.' } }] }));
        }
    });
    const llmUrl = await listenServer(mockLLM);

    // Two cooperating Lightboard-style modules: Backend + Illustration module discovered via getLoreBooks('manifest.lb')
    const modules = [
        {
            id: 'mod-lb-backend',
            name: 'Lightboard Backend Sim',
            lowLevelAccess: true,
            lorebook: [
                { comment: 'lb-core', content: 'return { version = "5.0" }' },
            ],
            trigger: [{
                effect: [{
                    type: 'triggerlua',
                    code: `
                    onOutput = async(function(tid)
                        local manifests = getLoreBooks(tid, 'manifest.lb')
                        assert(#manifests == 1, 'manifest missing')
                        local mf = json.decode(manifests[1].content)
                        assert(_ENV.null ~= nil and json.encode({ x = _ENV.null }) == '{"x":null}')
                        for _, stepName in ipairs(mf.steps) do
                            local entries = getLoreBooks(tid, stepName)
                            local fn = assert(load(entries[1].content))
                            local stepMod = fn()
                            stepMod.run(tid):await()
                        end
                    end)
                    onFormSubmit = async(function(tid, key, metaJson)
                        if key == 'lb-interaction__xnai' then
                            local meta = json.decode(metaJson)
                            setChatVar(tid, 'lb_last_dir', (meta.data and meta.data.direction) or '')
                            local lastIdx = getChatLength(tid) - 1
                            local prev = getChat(tid, lastIdx)
                            setChat(tid, lastIdx, (prev and prev.data or '') .. ' [FORM_OK]')
                        end
                    end)
                    `,
                }],
            }],
            regex: [
                { type: 'editdisplay', in: '\\[TAG\\]', out: '<b>DISPLAYED</b>', flag: 'g', ableFlag: false },
            ],
        },
        {
            id: 'mod-lb-illus',
            name: 'Lightboard XNAI Sim',
            lowLevelAccess: true,
            lorebook: [
                { comment: 'manifest.lb', content: JSON.stringify({ steps: ['lb-xnai.lb.onOutput'] }) },
                {
                    comment: 'lb-xnai.lb.onOutput',
                    content: `
                    return {
                        run = async(function(tid)
                            local r = axLLM(tid, { { role = 'user', content = 'Generate tags' } }):await()
                            assert(r.success, 'axLLM failed')
                            local tok = generateImage(tid, r.result, 'lowres', { orientation = 'landscape' }):await()
                            local idx = getChatLength(tid) - 1
                            local cur = getChat(tid, idx)
                            setChat(tid, idx, cur.data .. '\\n' .. tok)
                        end)
                    }
                    `,
                },
            ],
            trigger: [],
            regex: [],
        },
    ];

    const bridge = createFakeHostBridge({
        modules,
        imageConfig: {
            sdProvider: 'novelai',
            NAIImgUrl: `${imgUrl}/nai/generate-image`,
            NAIApiKey: 'nai-secret-key',
            NAIImgModel: 'nai-diffusion-4-5-full',
            NAIImgConfig: { width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral' },
        },
    });

    const token = 'test-p2-tok';
    const relay = createRelayServer({
        token,
        configOverride: {
            activeProfileId: 'p-main',
            auxProfileId: 'p-aux',
            directPresetId: 'off',
            remoteDirectOnly: true,
            profiles: [
                { id: 'p-main', name: 'Main', providerType: 'openai_compat', baseUrl: `${llmUrl}/main`, apiKey: 'k1', model: 'm1' },
                { id: 'p-aux', name: 'Aux', providerType: 'openai_compat', baseUrl: `${llmUrl}/aux`, apiKey: 'k2', model: 'm2' },
            ],
        },
    });
    const baseUrl = await listenServer(relay);
    bridge.startRpcLoop(baseUrl, token);

    try {
        await bridge.pushSnapshot(baseUrl, token);
        await new Promise((r) => setTimeout(r, 80));

        const sendRes = await fetch(`${baseUrl}/api/chat/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, text: 'Describe the library.' }),
        });
        assert.equal(sendRes.status, 200);

        // Wait until assistant reply with {{inlay::...}} lands in Host DB
        let committedMsg = '';
        for (let i = 0; i < 60; i += 1) {
            const m = bridge.dbState.chat.message.find((x) => x.role === 'char');
            if (m && m.data.includes('{{inlay::')) {
                committedMsg = m.data;
                break;
            }
            await new Promise((r) => setTimeout(r, 50));
        }
        assert.match(committedMsg, /The librarian turned the golden page\./);
        assert.match(committedMsg, /\{\{inlay::inlay-1\}\}/);
        assert.equal(naiPayloads.length, 1);
        assert.equal(naiPayloads[0].parameters.width, 1216);
        assert.equal(naiPayloads[0].parameters.height, 832);
        assert.equal(naiPayloads[0].parameters.v4_prompt.caption.base_caption, '1girl, reading a book');
        assert.equal(naiPayloads[0].parameters.v4_prompt.caption.char_captions.length, 1);
        assert.equal(naiPayloads[0].parameters.v4_prompt.caption.char_captions[0].char_caption, '1boy, smiling');
        assert.ok(llmCalls.some((c) => c.url === '/aux'));

        // Also test ComfyUI provider directly via createImageProvider
        const comfyProv = createImageProvider({
            getBackendConfig: () => ({
                imageGen: {
                    source: 'custom',
                    provider: 'comfyui',
                    apiUrl: `${imgUrl}/comfy`,
                    comfyWorkflowJson: '{"6":{"inputs":{"text":"{{risu_prompt}}","seed":1}},"7":{"inputs":{"text":"{{risu_neg}}"}}}',
                },
            }),
            createInlay: async () => 'comfy-inlay-99',
        });
        const comfyRes = await comfyProv.generateInlay({ positive: 'cat', negative: 'bad' });
        assert.equal(comfyRes.inlayToken, '{{inlay::comfy-inlay-99}}');

        // Test <form risu-form> backend interaction endpoint
        const formRes = await fetch(`${baseUrl}/api/modules/interaction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({
                charIndex: 0,
                chatIndex: 0,
                kind: 'form',
                key: 'lb-interaction__xnai',
                formValues: { direction: 'Zoom in on face' },
            }),
        }).then((r) => r.json());
        assert.equal(formRes.ok, true);
        assert.equal(formRes.handled, true);
        assert.match(bridge.dbState.chat.message[bridge.dbState.chat.message.length - 1].data, /\[FORM_OK\]/);
        assert.equal(bridge.dbState.chat.scriptstate.$lb_last_dir, 'Zoom in on face');

        // Verify regex engine directly as well
        assert.equal(runRegexScripts('editdisplay', 'hello [TAG]', modules[0].regex), 'hello <b>DISPLAYED</b>');
    } finally {
        await bridge.stop();
        await closeServer(relay);
        await closeServer(mockLLM);
        await closeServer(mockImgApi);
    }
});

test('Phase 4: Context Cutter Lua (editRequest memo UUID cutting + /컨텍리셋 onStart stopChat)', async () => {
    const upstreamMessages = [];
    const mockLLM = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        upstreamMessages.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).messages);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'CUTTER_OK' } }] }));
    });
    const llmUrl = await listenServer(mockLLM);

    const uuid1 = '11111111-1111-4111-8111-111111111111';
    const uuid2 = '22222222-2222-4222-8222-222222222222';
    const modules = [
        {
            id: 'mod-cutter',
            name: 'Context Cutter Sim',
            lowLevelAccess: false,
            trigger: [{
                effect: [{
                    type: 'triggerlua',
                    code: `
                    onStart = function(id)
                        local last = getChat(id, -1)
                        if last and last.data == '/컨텍리셋' then
                            setState(id, 'cc_removed', {})
                            removeChat(id, -1)
                            alertNormal(id, '컨텍스트 커터 리셋됨')
                            stopChat(id)
                        end
                    end
                    listenEdit('editRequest', function(id, messages)
                        local out = {}
                        local seenFirstChat = false
                        for _, m in ipairs(messages) do
                            local isUuid = m.memo and string.match(m.memo, '^%x+%-%x+%-%x+%-%x+%-%x+$')
                            if not isUuid then
                                table.insert(out, m)
                            elseif not seenFirstChat then
                                seenFirstChat = true -- cut oldest UUID message, keep preset/system and newer chat
                            else
                                table.insert(out, m)
                            end
                        end
                        return out
                    end)
                    `,
                }],
            }],
            regex: [],
        },
    ];

    const bridge = createFakeHostBridge({
        modules,
        chatObj: {
            id: 'chat-cc',
            name: 'Chat CC',
            modules: ['mod-cutter'],
            scriptstate: { $__cc_removed: '["old"]' },
            message: [
                { role: 'user', data: 'old user message', chatId: uuid1, time: 1 },
                { role: 'char', data: 'recent char message', chatId: uuid2, time: 2 },
            ],
        },
    });

    const token = 'test-cc-tok';
    const relay = createRelayServer({
        token,
        configOverride: {
            activeProfileId: 'p1',
            directPresetId: 'off',
            remoteDirectOnly: true,
            profiles: [{ id: 'p1', name: 'P1', providerType: 'openai_compat', baseUrl: `${llmUrl}/v1`, apiKey: 'k', model: 'm' }],
        },
    });
    const baseUrl = await listenServer(relay);
    bridge.startRpcLoop(baseUrl, token);

    try {
        await bridge.pushSnapshot(baseUrl, token);
        await new Promise((r) => setTimeout(r, 80));

        // 1) Normal chat turn: editRequest cuts oldest UUID message, preserves system preset + uuid2 + new user message, and strips memo before HTTP
        await fetch(`${baseUrl}/api/chat/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, text: 'newest prompt' }),
        });

        for (let i = 0; i < 60; i += 1) {
            if (upstreamMessages.length >= 1) break;
            await new Promise((r) => setTimeout(r, 40));
        }
        assert.equal(upstreamMessages.length, 1);
        const sent = upstreamMessages[0];
        assert.ok(sent.some((m) => m.role === 'system'));
        assert.ok(!sent.some((m) => m.content === 'old user message'), 'Oldest UUID chat message must be cut');
        assert.ok(sent.some((m) => m.content === 'recent char message'));
        assert.ok(sent.some((m) => m.content === 'newest prompt'));
        assert.ok(sent.every((m) => !('memo' in m)), 'Internal memo must be stripped before LLM HTTP request');

        await new Promise((r) => setTimeout(r, 120));
        await bridge.pushSnapshot(baseUrl, token);

        // 2) /컨텍리셋 command: onStart stops turn, removes /컨텍리셋 message, emits alertNormal notice, does NOT call LLM again
        await fetch(`${baseUrl}/api/chat/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, text: '/컨텍리셋' }),
        });
        for (let i = 0; i < 60; i += 1) {
            const st = await fetch(`${baseUrl}/api/state`, { headers: { 'X-RisuStand-Token': token } }).then((r) => r.json());
            if (st.lastTriggerEvent && st.lastTriggerEvent.message === '컨텍스트 커터 리셋됨' && bridge.dbState.chat.scriptstate.$__cc_removed === '[]') break;
            await new Promise((r) => setTimeout(r, 40));
        }
        assert.equal(upstreamMessages.length, 1, '/컨텍리셋 must abort before calling LLM');
        assert.equal(bridge.dbState.chat.scriptstate.$__cc_removed, '[]');
        assert.ok(!bridge.dbState.chat.message.some((m) => m.data === '/컨텍리셋'));
    } finally {
        await bridge.stop();
        await closeServer(relay);
        await closeServer(mockLLM);
    }
});

test('Phase 3 & 5: LIB Server Mode primitives, chatId lineage, & Bubble Surface Action click bridge', async () => {
    const kvStore = {};
    const mockLibServer = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/v1/kv/set') {
            kvStore[body.key] = body.value;
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (req.url === '/v1/kv/get') {
            res.end(JSON.stringify({ ok: true, value: kvStore[body.key] || null }));
            return;
        }
        res.end(JSON.stringify({ ok: true }));
    });
    const libUrl = await listenServer(mockLibServer);

    const mockLLM = http.createServer(async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'LIB_REPLY <button data-am-illustration-action="generate" data-am-slot="slot1">✨ Generate</button>' } }] }));
    });
    const llmUrl = await listenServer(mockLLM);

    const bridge = createFakeHostBridge();
    const token = 'test-p3-tok';
    const relay = createRelayServer({
        token,
        configOverride: {
            activeProfileId: 'p1',
            directPresetId: 'off',
            remoteDirectOnly: true,
            profiles: [{ id: 'p1', name: 'P1', providerType: 'openai_compat', baseUrl: `${llmUrl}/v1`, apiKey: 'k', model: 'm' }],
        },
    });
    const baseUrl = await listenServer(relay);
    bridge.startRpcLoop(baseUrl, token);

    try {
        await bridge.pushSnapshot(baseUrl, token);

        // Plugin simulating LIB server mode crypto/streams/IPC + Asset Maid rootDoc click listener
        const comboPlugin = `
//@name lib-and-am-sim
//@api 3.0
(async () => {
  // 1. Verify cross-realm WebCrypto + Web Streams (LIB Storage SDK dependencies)
  const rnd = crypto.getRandomValues(new Uint8Array(8));
  if (rnd.length !== 8) throw new Error('getRandomValues failed');
  const enc = new TextEncoder().encode('risustand-lib-hash');
  const digest = await crypto.subtle.digest('SHA-256', enc);
  const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex.length !== 64) throw new Error('sha256 failed');
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(enc);
  writer.close();
  const ab = await new Response(cs.readable).arrayBuffer();
  if (ab.byteLength < 10) throw new Error('CompressionStream failed');

  await Risuai.nativeFetch('${libUrl}/v1/kv/set', {
    method: 'POST',
    body: JSON.stringify({ key: 'sha_test', value: hex }),
  });

  // 2. Register root document capture click handler like Asset Maid
  const rootDoc = await Risuai.getRootDocument();
  await rootDoc.addEventListener('click', async (ev) => {
    const t = ev && ev.target;
    if (!t || typeof t.getOuterHTML !== 'function') return;
    const html = await t.getOuterHTML();
    if (!html.includes('data-am-illustration-action="generate"')) return;
    const chat = await Risuai.getChat();
    if (chat && Array.isArray(chat.message) && chat.message.length) {
      chat.message[chat.message.length - 1].data += ' [AM_CLICKED]';
      await Risuai.setChatToIndex(0, 0, chat);
    }
  }, true);

  // 3. Emit backend -> GUI IPC message
  Risuai.addPluginChannelListener('gui_ping', () => {});
  await Risuai.postPluginChannelMessage('lib-and-am-sim', 'gui_ping', { ok: true, hex });
})();
`;
        const up = await fetch(`${baseUrl}/api/plugins/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ filename: 'combo.js', script: comboPlugin, enabled: true }),
        });
        assert.equal(up.status, 200);
        await new Promise((r) => setTimeout(r, 120));

        assert.equal(typeof kvStore.sha_test, 'string');
        assert.equal(kvStore.sha_test.length, 64);

        // Verify GUI IPC polling retrieves backend -> GUI message
        const ipcRes = await fetch(`${baseUrl}/api/plugins/gui-rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ pluginName: 'lib-and-am-sim', method: 'ipc.poll', args: [0] }),
        }).then((r) => r.json());
        assert.ok(Array.isArray(ipcRes.value.events) && ipcRes.value.events.some((e) => e.channel === 'gui_ping' && e.message.ok === true));

        // Send remote turn -> persisted messages must carry UUID chatId
        await fetch(`${baseUrl}/api/chat/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, text: 'hello lib' }),
        });
        for (let i = 0; i < 60; i += 1) {
            if (bridge.dbState.chat.message.length >= 2) break;
            await new Promise((r) => setTimeout(r, 40));
        }
        assert.equal(bridge.dbState.chat.message.length, 2);
        const uuidRx = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        assert.match(bridge.dbState.chat.message[0].chatId, uuidRx);
        assert.match(bridge.dbState.chat.message[1].chatId, uuidRx);

        // Dispatch surface action simulating mobile user tapping dedicated [✨ 삽화 생성] bar
        const surfRes = await fetch(`${baseUrl}/api/plugins/surface-action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({
                charIndex: 0,
                chatIndex: 0,
                msgIndex: 1,
                actionHtml: '<button data-am-illustration-action="generate" data-am-slot="slot1">✨ Generate</button>',
                dataset: { 'am-illustration-action': 'generate' },
            }),
        }).then((r) => r.json());
        assert.equal(surfRes.ok, true);
        assert.ok(surfRes.dispatchedCount >= 1);
        assert.match(bridge.dbState.chat.message[1].data, /\[AM_CLICKED\]/);

        // Verify UI HTML markers are present
        const html = await fetch(`${baseUrl}/`).then((r) => r.text());
        assert.ok(html.includes('auxProfileSel'));
        assert.ok(html.includes('imageGenCard'));
        assert.ok(html.includes('sceneCtrlQuickBtn'));
        assert.ok(html.includes('rs-plugin-bubble-bar'));
    } finally {
        await bridge.stop();
        await closeServer(relay);
        await closeServer(mockLLM);
        await closeServer(mockLibServer);
    }
});

test('StatusPanel Lua LLM/axLLM without :await(), instant /api/triggers/run, floating UI, stealth drawer, and live SSE activity', async () => {
    const alertErrors = [];
    const llmRequests = [];
    const mockLLM = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        llmRequests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url.startsWith('/aux')) {
            res.end(JSON.stringify({ choices: [{ message: { content: 'STATUS_PANEL_AUX_OK' } }] }));
            return;
        }
        res.end(JSON.stringify({ choices: [{ message: { content: 'STORY_REPLY_OK' } }] }));
    });
    const llmUrl = await listenServer(mockLLM);

    const statusModule = {
        id: 'mod-status-panel',
        name: 'Cheongwon Status Panel',
        lowLevelAccess: true,
        lorebook: [],
        regex: [],
        trigger: [{
            effect: [{
                type: 'triggerlua',
                code: `
                onOutput = async(function(tid)
                    local res = axLLM(tid, { { role = 'sys', content = 'Update panel' }, { role = 'user', content = 'Now' } })
                    if not res or not res.success then
                        alertError(tid, '[StatusPanel] Failed to get LLM response: ' .. tostring(res and res.result))
                        return
                    end
                    local res2 = LLM(tid, { { role = 'user', content = 'Confirm' } }):await()
                    if not res2 or not res2.success then
                        alertError(tid, '[StatusPanel] LLM failed')
                        return
                    end
                    setChatVar(tid, 'status_out', tostring(res.result) .. '|' .. tostring(res2.result))
                end)

                toggleMenuMode = async(function(tid)
                    local cur = getChatVar(tid, 'menu_mode')
                    local nxt = (cur == 'open') and 'closed' or 'open'
                    setChatVar(tid, 'menu_mode', nxt)
                end)
                `,
            }],
        }],
    };

    const bridge = createFakeHostBridge({ modules: [statusModule] });
    const token = 'test-5fixes-tok';
    const relay = createRelayServer({
        token,
        configOverride: {
            activeProfileId: 'p-main',
            auxProfileId: 'p-aux',
            directPresetId: 'off',
            remoteDirectOnly: true,
            profiles: [
                { id: 'p-main', name: 'Main', providerType: 'openai_compat', baseUrl: `${llmUrl}/main`, apiKey: 'k1', model: 'm1' },
                { id: 'p-aux', name: 'Aux', providerType: 'openai_compat', baseUrl: `${llmUrl}/aux`, apiKey: 'k2', model: 'm2' },
            ],
        },
    });
    const baseUrl = await listenServer(relay);
    bridge.startRpcLoop(baseUrl, token);

    const sseCtrl = new AbortController();
    const sseEvents = [];
    const ssePromise = (async () => {
        const resp = await fetch(`${baseUrl}/api/activity/stream`, {
            headers: { 'X-RisuStand-Token': token },
            signal: sseCtrl.signal,
        });
        assert.equal(resp.status, 200);
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let idx;
                while ((idx = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, idx).trim();
                    buf = buf.slice(idx + 1);
                    if (line.startsWith('data:')) {
                        sseEvents.push(JSON.parse(line.slice(5).trim()));
                    }
                }
            }
        } catch (_) {}
    })();

    try {
        await bridge.pushSnapshot(baseUrl, token);
        await new Promise((r) => setTimeout(r, 80));

        // Register two plugins to verify sequential beforeRequest/afterRequest hook status + setChatPanel + sibling HTML preservation
        const hookStatusPlugin = `
//@name panel_hook_plugin
//@display-name LIBRA Hook
//@api 3.0
(async () => {
  await Risuai.addRisuReplacer('beforeRequest', async (msgs) => {
    await Risuai.setChatPanel('<style>.mscs-bar{color:#fff}</style><div class="mscs-bar"><span class="mscs-preview">기억 회상 분석 중 (1/2)</span></div>', { id: 'p1-status' });
    await new Promise((r) => setTimeout(r, 25));
    return msgs;
  });
  await Risuai.addRisuReplacer('afterRequest', async (out) => {
    await Risuai.setChatPanel('<div class="mscs-bar"><span class="mscs-preview">응답 후 기억 검증 중 (1/2)</span></div>', { id: 'p1-status' });
    await new Promise((r) => setTimeout(r, 25));
    await Risuai.setChatPanel(null, { id: 'p1-status' });
    return out;
  });
})();
`;
        const upRes1 = await fetch(`${baseUrl}/api/plugins/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ filename: 'panel_hook_plugin.js', script: hookStatusPlugin, enabled: true }),
        });
        assert.equal(upRes1.status, 200);

        // Register a plugin with root document widget (two sibling regions + collapsed Asset Maid generation count) + hooks
        const floatingPlugin = `
//@name maid_fab_test
//@display-name Maid Fab Test
//@api 3.0
(async () => {
  const tpl = document.createElement('template');
  tpl.innerHTML = '<div data-am-count-node="root"><section class="x-risu-am-generation-count" data-am-expanded="false" data-am-floating="true"><div class="x-risu-am-generation-count__panel-anchor"><div class="x-risu-am-generation-count__panel"><span>삽화</span><span>수동</span><span>범위</span></div></div><button type="button" class="x-risu-am-generation-count__toggle" data-am-count-node="root-1" data-am-runtime-generation-count-action="toggle">1–3</button></section></div>';
  const parsedRoot = tpl.content.firstElementChild;
  const attrsOk = Array.from(parsedRoot.attributes).some((a) => a.name === 'data-am-count-node' && a.value === 'root');
  if (!attrsOk || !parsedRoot.hasAttribute('data-am-count-node')) {
    throw new Error('MockElement attributes/hasAttribute mismatch');
  }
  const repSpan = document.createElement('span');
  repSpan.textContent = '1–3';
  const toggleBtn = parsedRoot.querySelector('[data-am-count-node="root-1"]');
  const oldTxt = toggleBtn.childNodes[0];
  oldTxt.replaceWith(repSpan);

  const doc = await Risuai.getRootDocument();
  const host = await doc.createElement('div');
  await host.setAttribute('x-am-root-host', 'am-test');
  await host.setInnerHTML('<div data-am-count-region x-am-count-visible="true">' + parsedRoot.outerHTML + '</div><div data-am-toast-region></div>');
  await doc.body.appendChild(host);

  const list = await doc.querySelectorAll('[x-am-root-host="am-test"] [data-am-count-region]');
  if ((await list.length()) !== 1) throw new Error('SafeNodeList length mismatch');
  const toastList = await doc.querySelectorAll('[x-am-root-host="am-test"] [data-am-toast-region]');
  if ((await toastList.length()) !== 1) throw new Error('Sibling toast region missing after innerHTML parse');
  const region = await list.at(0);

  let downHit = null;
  await doc.addEventListener('mousedown', async (ev) => {
    const matches = await doc.querySelectorAll(':is(button[data-am-runtime-generation-count-action]):active');
    if ((await matches.length()) > 0) {
      const el = await matches.at(0);
      const r = await el.getBoundingClientRect();
      if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
        downHit = await el.getOuterHTML();
      }
    }
  });
  await doc.addEventListener('click', async () => {
    if (!downHit) return;
    downHit = null;
    const sec = await region.querySelector('.x-risu-am-generation-count');
    if (sec) {
      const cur = await sec.getAttribute('data-am-expanded');
      await sec.setAttribute('data-am-expanded', cur === 'true' ? 'false' : 'true');
    }
  });

  await Risuai.addRisuReplacer('beforeRequest', async (msgs) => {
    await new Promise((r) => setTimeout(r, 20));
    return msgs;
  });
  await Risuai.addRisuReplacer('afterRequest', async (out) => {
    await new Promise((r) => setTimeout(r, 20));
    return out;
  });
})();
`;
        const upRes = await fetch(`${baseUrl}/api/plugins/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ filename: 'maid.js', script: floatingPlugin, enabled: true }),
        });
        assert.equal(upRes.status, 200);

        // No non-hook init activity should be broadcasted on SSE before a chat request
        await new Promise((r) => setTimeout(r, 50));
        const preChatItems = sseEvents.flatMap((ev) => [...(ev.active || []), ...(ev.recent || [])]);
        assert.equal(preChatItems.length, 0, 'Plugin load/init must not emit top-bar activity');

        // 1) Chat turn exercises StatusPanel axLLM WITHOUT :await() and LLM WITH :await() + sequential hooks
        await fetch(`${baseUrl}/api/chat/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, text: 'Hello status panel' }),
        });

        for (let i = 0; i < 60; i += 1) {
            if (bridge.dbState.chat.scriptstate && bridge.dbState.chat.scriptstate.$status_out) break;
            const st = await fetch(`${baseUrl}/api/state`, { headers: { 'X-RisuStand-Token': token } }).then((r) => r.json());
            if (st.lastTriggerEvent && st.lastTriggerEvent.kind === 'alert_error') {
                alertErrors.push(st.lastTriggerEvent.message);
                break;
            }
            await new Promise((r) => setTimeout(r, 40));
        }

        assert.equal(alertErrors.length, 0, 'StatusPanel must never emit nil response alertError');
        assert.equal(bridge.dbState.chat.scriptstate.$status_out, 'STATUS_PANEL_AUX_OK|STORY_REPLY_OK');
        assert.ok(llmRequests.some((r) => r.url === '/aux' && r.body.messages.some((m) => m.role === 'system' && m.content === 'Update panel')));

        // 2) Instant backend manual trigger via /api/triggers/run
        const trigRes = await fetch(`${baseUrl}/api/triggers/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, trigger: 'toggleMenuMode', promptAnswers: [] }),
        }).then((r) => r.json());
        assert.equal(trigRes.ok, true);
        assert.equal(trigRes.mode, 'backend_instant');
        assert.equal(trigRes.handled, true);
        assert.equal(bridge.dbState.chat.scriptstate.$menu_mode, 'open');

        // 3) Floating UI state starts collapsed, stays collapsed with autoExpand:false, and expands when explicitly requested
        const stAfter = await fetch(`${baseUrl}/api/state`, { headers: { 'X-RisuStand-Token': token } }).then((r) => r.json());
        assert.ok(stAfter.pluginFloatingUi && Array.isArray(stAfter.pluginFloatingUi.rootWidgets));
        const amWidget0 = stAfter.pluginFloatingUi.rootWidgets.find((w) => w.pluginName === 'maid_fab_test');
        assert.ok(amWidget0 && amWidget0.html.includes('data-am-expanded="false"'));
        assert.ok(amWidget0.html.includes('data-am-toast-region'));

        const floatNoExpandRes = await fetch(`${baseUrl}/api/plugins/floating-open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, autoExpand: false }),
        }).then((r) => r.json());
        assert.equal(floatNoExpandRes.ok, true);
        const amWidgetCollapsed = floatNoExpandRes.pluginFloatingUi.rootWidgets.find((w) => w.pluginName === 'maid_fab_test');
        assert.ok(amWidgetCollapsed && amWidgetCollapsed.html.includes('data-am-expanded="false"'), 'floating-open with autoExpand:false must keep floating bar collapsed');

        const floatOpenRes = await fetch(`${baseUrl}/api/plugins/floating-open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ charIndex: 0, chatIndex: 0 }),
        }).then((r) => r.json());
        assert.equal(floatOpenRes.ok, true);
        const amWidget1 = floatOpenRes.pluginFloatingUi.rootWidgets.find((w) => w.pluginName === 'maid_fab_test');
        assert.ok(amWidget1 && amWidget1.html.includes('data-am-expanded="true"'), 'floating-open should auto-expand floating control bar');

        // 4) SSE activity stream ONLY reports beforeRequest / afterRequest plugin hooks in sequence + setChatPanel task text
        const allHookItems = sseEvents.flatMap((ev) => [...(ev.active || []), ...(ev.recent || [])]);
        assert.ok(allHookItems.length > 0, 'SSE stream should emit hook events during chat turn');
        assert.ok(allHookItems.every((x) => x.kind === 'plugin_hook' && (x.stage === 'beforeRequest' || x.stage === 'afterRequest')),
            'Top bar SSE activity must strictly contain beforeRequest / afterRequest plugin_hook events');
        assert.ok(allHookItems.some((x) => x.stage === 'beforeRequest' && x.step === 1 && x.total === 2 && x.phase.includes('기억 회상 분석 중 (1/2)')),
            'beforeRequest step 1 should reflect setChatPanel live task text');
        assert.ok(allHookItems.some((x) => x.stage === 'beforeRequest' && x.step === 2 && x.total === 2 && x.name === 'Maid Fab Test'),
            'beforeRequest step 2 should run sequentially');
        assert.ok(allHookItems.some((x) => x.stage === 'afterRequest' && x.step === 1 && x.total === 2 && x.phase.includes('응답 후 기억 검증 중 (1/2)')),
            'afterRequest step 1 should reflect setChatPanel live task text');
        assert.ok(allHookItems.some((x) => x.stage === 'afterRequest' && x.step === 2 && x.total === 2 && x.name === 'Maid Fab Test'),
            'afterRequest step 2 should run sequentially');

        // 5) Web UI markup & script verification (RisuStand mini-bar + popup controls without main-DOM GUI buttons + bot menu dedup)
        const html = await fetch(`${baseUrl}/`).then((r) => r.text());
        assert.ok(html.includes('id="hdrActivityBar"'));
        assert.ok(html.includes('class="h-sub-row"'));
        assert.ok(html.includes('event.stopPropagation()'));
        assert.ok(html.includes('id="rsMiniBar"'));
        assert.ok(html.includes('id="zenModeBtn"'));
        assert.ok(!html.includes('id="rsMiniBarToggleBtn"'));
        assert.ok(html.includes('id="pluginFloatingModal"'));
        assert.ok(html.includes('data-scene-open-floating'));
        assert.ok(html.includes('id="openPlgFloatingBtn"'));
        assert.ok(html.includes('stripBotFixedMenuNodes'));
        assert.ok(!html.includes('data-pfm-open-gui'), 'Floating popup must not contain main-DOM GUI entry buttons');
        assert.ok(html.includes('autoExpand: false'), 'Client floating widget init/modal must pass autoExpand: false');
        assert.ok(html.includes('.x-risu-am-generation-count:not([data-am-expanded="true"])'), 'CSS must hide collapsed floating panel');
        assert.ok(!html.includes('id="pluginFloatingDock"'));
        assert.ok(!html.includes('id="pluginRootFloatingHost"'));
        assert.ok(html.includes('scene-stealth-note'));
        assert.ok(html.includes('data-scene-thumb-reveal'));
        assert.ok(html.includes('/api/triggers/run'));
    } finally {
        sseCtrl.abort();
        await ssePromise;
        await bridge.stop();
        await closeServer(relay);
        await closeServer(mockLLM);
    }
});

test('Asset Maid style manual illustration footer projects via MutationObserver and targets clicked message across multi-turn chat', async () => {
    const token = 'am-footer-token';
    const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=', 'base64');
    const relay = createRelayServer({
        token,
        configOverride: {
            profiles: [{
                id: 'm-1',
                name: 'Main',
                providerType: 'openai_compat',
                baseUrl: 'http://127.0.0.1:9',
                apiKey: 'k',
                model: 'm',
            }],
            activeProfileId: 'm-1',
            remoteDirectOnly: true,
        },
    });
    await listenServer(relay);
    const port = relay.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        await fetch(`${baseUrl}/api/pc/poll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({
                bridgeVersion: '2.0.0',
                pluginVersion: '1.1.0',
                generating: false,
                supportsBatchCommands: true,
                catalog: {
                    pcActiveCharIndex: 0,
                    pcActiveChatIndex: 0,
                    selectedPersona: 0,
                    params: { temperature: 80, maxContext: 8000, maxResponse: 1000 },
                    characters: [{ index: 0, name: 'Elysia', activeChatIndex: 0, chats: [{ index: 0, name: 'Chat 1' }] }],
                    modules: [],
                    personas: [{ index: 0, name: 'User' }],
                },
                snapshot: {
                    charName: 'Elysia',
                    charIndex: 0,
                    chatIndex: 0,
                    chatUuid: 'chat-am-uuid-1',
                    chatName: 'Chat 1',
                    isPcActive: true,
                    totalMessages: 3,
                    chatModules: [],
                    chatVariables: {},
                    assetMap: {},
                    messages: [
                        { index: 0, role: 'char', chatId: 'cid-msg-0', text: 'First assistant paragraph.', html: 'First assistant paragraph.', raw: 'First assistant paragraph.', images: [], swipeCount: 1, swipeIndex: 0 },
                        { index: 1, role: 'user', chatId: 'cid-msg-1', text: 'Next scene please.', html: 'Next scene please.', raw: 'Next scene please.', images: [], swipeCount: 1, swipeIndex: 0 },
                        { index: 2, role: 'char', chatId: 'cid-msg-2', text: 'Second assistant paragraph.', html: 'Second assistant paragraph.', raw: 'Second assistant paragraph.', images: [], swipeCount: 1, swipeIndex: 0 },
                    ],
                    charContext: { charId: 'char-am-1', name: 'Elysia', personaName: 'User' },
                },
            }),
        });

        const amFooterScript = `
        //@name AssetMaidFooterTest
        //@display-name Asset Maid Footer Test
        //@api 3.0
        (async () => {
            const doc = await risuai.getRootDocument();
            const genStates = new Map();
            let activeButtonEl = null;

            async function reconcile() {
                const screen = await doc.querySelector('.default-chat-screen');
                if (!screen) return;
                const rows = await screen.querySelectorAll('.risu-chat[data-chat-id]');
                const count = await rows.length();
                for (let i = 0; i < count; i += 1) {
                    const row = await rows.at(i);
                    const cid = await row.getAttribute('data-chat-id').catch(() => '');
                    const role = await row.getAttribute('data-role').catch(() => '');
                    if (!cid || role !== 'char') continue;
                    const bodyEl = await row.querySelector('.chattext');
                    if (!bodyEl) continue;
                    let footer = await bodyEl.querySelector('.x-risu-am-illustration-footer');
                    const state = genStates.get(cid) || 'idle';
                    if (!footer) {
                        footer = await doc.createElement('div');
                        await footer.addClass('x-risu-am-illustration-footer');
                        await bodyEl.appendChild(footer);
                    }
                    const prevState = await footer.getAttribute('x-am-state').catch(() => '');
                    if (prevState !== state) {
                        await footer.setAttribute('x-am-state', state);
                        await footer.setInnerHTML(
                            '<button type="button" class="x-risu-am-illustration-footer__generate" data-am-illustration-action="generate" data-am-message-id="' + cid + '">' +
                            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 20 12 12 21.5 4 12Z"></path><path d="M12 7 16.5 12 12 17 7.5 12Z"></path></svg>' +
                            '</button>'
                        );
                    }
                }
            }

            await doc.addEventListener('mousedown', async (ev) => {
                const matches = await doc.querySelectorAll(':is(.x-risu-am-illustration-footer [data-am-illustration-action]):active');
                const len = await matches.length();
                activeButtonEl = null;
                for (let i = 0; i < len; i += 1) {
                    const el = await matches.at(i);
                    const rect = await el.getBoundingClientRect();
                    if (ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
                        activeButtonEl = el;
                        break;
                    }
                }
            }, { capture: true });

            await doc.addEventListener('click', async (ev) => {
                const btn = activeButtonEl;
                activeButtonEl = null;
                if (!btn) return;
                const rect = await btn.getBoundingClientRect();
                if (!(ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom)) return;
                const targetCid = await btn.getAttribute('data-am-message-id');
                if (!targetCid) return;
                // Async generation IIFE that completes after dispatchSurfaceAction returns
                setTimeout(async () => {
                    const savedPath = await risuai.saveAsset(new Uint8Array(${JSON.stringify(Array.from(pngBytes))}));
                    const charObj = await risuai.getCharacterFromIndex(0);
                    charObj.additionalAssets = [...(charObj.additionalAssets || []), ['test_illust', savedPath, 'png']];
                    await risuai.setCharacterToIndex(0, charObj);
                    const chatObj = await risuai.getChatFromIndex(0, 0);
                    const msg = chatObj.message.find((m) => m.chatId === targetCid);
                    if (msg) {
                        msg.data += '\\n<div class="am-illustration-projection"><span class="am-image"><img class="am-image__media" src="{{raw::test_illust}}"></span></div>';
                    }
                    await risuai.setChatToIndex(0, 0, chatObj);
                    genStates.set(targetCid, 'complete');
                    await reconcile();
                }, 40);
            }, { capture: true });

            const body = await doc.querySelector('body');
            const obs = await risuai.createMutationObserver(() => { void reconcile(); });
            await obs.observe(body, { childList: true, subtree: true });
            await reconcile();
        })();
        `;

        const upRes = await fetch(`${baseUrl}/api/plugins/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ filename: 'AssetMaidFooterTest.js', script: amFooterScript, enabled: true }),
        }).then((r) => r.json());
        assert.equal(upRes.ok, true);

        // Trigger initial snapshot projection refresh
        const st1 = await fetch(`${baseUrl}/api/state`, { headers: { 'X-RisuStand-Token': token } }).then((r) => r.json());
        const msgs1 = st1.snapshot && st1.snapshot.messages ? st1.snapshot.messages : [];
        const m0 = msgs1.find((m) => m.chatId === 'cid-msg-0');
        const m1 = msgs1.find((m) => m.chatId === 'cid-msg-1');
        const m2 = msgs1.find((m) => m.chatId === 'cid-msg-2');
        assert.ok(m0 && m0.pluginFooterHtml.includes('x-risu-am-illustration-footer__generate'));
        assert.ok(m0.pluginFooterHtml.includes('M12 2.5 20 12 12 21.5 4 12Z'));
        assert.equal(m1.pluginFooterHtml || '', '', 'User message should not get assistant illustration footer');
        assert.ok(m2 && m2.pluginFooterHtml.includes('data-am-message-id="cid-msg-2"'));

        // Click msg #2's manual illustration button (must NOT hit msg #0)
        const surfRes = await fetch(`${baseUrl}/api/plugins/surface-action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({
                charIndex: 0,
                chatIndex: 0,
                msgIndex: 2,
                chatId: 'cid-msg-2',
                actionHtml: '<button type="button" class="x-risu-am-illustration-footer__generate" data-am-illustration-action="generate" data-am-message-id="cid-msg-2"></button>',
                dataset: { 'data-am-illustration-action': 'generate', 'data-am-message-id': 'cid-msg-2' },
            }),
        }).then((r) => r.json());
        assert.equal(surfRes.ok, true);
        assert.equal(surfRes.matchedLive, true);

        let stAfter = null;
        for (let i = 0; i < 40; i += 1) {
            await new Promise((r) => setTimeout(r, 40));
            const candidate = await fetch(`${baseUrl}/api/state`, { headers: { 'X-RisuStand-Token': token } }).then((r) => r.json());
            const curM2 = candidate.snapshot.messages.find((m) => m.chatId === 'cid-msg-2');
            if (curM2 && curM2.pluginFooterHtml.includes('x-am-state="complete"')) {
                stAfter = candidate;
                break;
            }
        }
        assert.ok(stAfter, 'State should update asynchronously after manual footer click');
        const finalM0 = stAfter.snapshot.messages.find((m) => m.chatId === 'cid-msg-0');
        const finalM2 = stAfter.snapshot.messages.find((m) => m.chatId === 'cid-msg-2');
        assert.ok(!finalM0.html.includes('am-illustration-projection'), 'Message #0 must remain untouched when clicking message #2');
        assert.match(finalM2.html, /<img\b[^>]*class="am-image__media"[^>]*\bsrc="\/api\/asset\/[a-f0-9]{32}"/);
        assert.ok(!finalM2.html.includes('<img class="msg-img"'), 'src="{{raw::...}}" must resolve cleanly to URL without nested <img>');

        const html = await fetch(`${baseUrl}/`).then((r) => r.text());
        assert.ok(html.includes('rs-am-footer-host'));
        assert.ok(html.includes('x-risu-am-spin'));
    } finally {
        await closeServer(relay);
    }
});

test('Soakma-style preset without internal toggles reacts cleanly to module customModuleToggle, single-= CBS, #each, position, and module regex/Lua', async () => {
    const llmRequests = [];
    const mockLLM = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        llmRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            choices: [{
                message: {
                    content: '걸음을 옮겼다. §쿵§ 그리고, 침묵이 흘렀다.',
                },
            }],
        }));
    });
    const llmUrl = await listenServer(mockLLM);

    const soakmaModuleToggle = [
        '=소악마 그룹=group',
        'response_language=응답 언어=select=영어,한국어,일본어',
        'narrative_style=문체=select=기본,1인칭담백',
        'trpgmode=TRPG 모드=check',
        'genre1=장르1=select=없음,코미디,로맨스',
        'PastMemori=요약 에피슬롯=check',
        'wordRequest=소유욕 제거=check',
        'onomatopoeia_off=의성어 끄기=check',
        'zerocomma=쉼표 제거=check',
        'custom_narrative=커스텀 문체=text',
        'topbotpersona=페르소나 위치=select=기본,삭제',
        '=소악마 그룹=groupend',
    ].join('\n');

    const soakmaModule = {
        id: 'mod-soakma-core',
        name: 'Soakma Module',
        customModuleToggle: soakmaModuleToggle,
        lorebook: [],
        regex: [
            {
                comment: '소유욕 제거',
                type: 'editprocess',
                in: '독점욕',
                out: '{{#if {{? {{getglobalvar::toggle_wordRequest}}=0}}}}$&{{/if}}',
                ableFlag: true,
                flag: 'gu',
            },
            {
                comment: '제로쉼표',
                type: 'editdisplay',
                in: '{{#if {{? {{getglobalvar::toggle_zerocomma}}=1}}}}[、,]{{/if}}',
                out: '',
                ableFlag: true,
                flag: 'g<cbs>',
            },
            {
                comment: '의성어',
                type: 'editdisplay',
                in: '§([^§\\n\\r]+)§',
                out: '{{#if {{? {{getglobalvar::toggle_onomatopoeia_off}}=0}}}}<sfx>{{ruby::$1::sfx}}</sfx>{{/if}}',
                ableFlag: true,
                flag: 'gs',
            },
        ],
        trigger: [{
            effect: [{
                type: 'triggerlua',
                code: `
                listenEdit("editRequest", function(id, msgs)
                    local trpg = getGlobalVar(id, "toggle_trpgmode")
                    local hasTag = false
                    for _, m in ipairs(msgs) do
                        if type(m.content) == "string" and string.find(m.content, "<!--TRPG_MODE-->", 1, true) then
                            hasTag = true
                        end
                    end
                    if trpg == "1" and hasTag then
                        table.insert(msgs, { role = "system", content = "[LUA_TRPG_ACTIVE]" })
                    end
                    return msgs
                end)
                `,
            }],
        }],
    };

    const soakmaPreset = {
        name: 'Soakma-v17-NoToggle',
        customPromptTemplateToggle: '',
        templateDefaultVariables: '',
        promptTemplate: [
            {
                type: 'plain',
                type2: 'main',
                role: 'system',
                text: 'LANG={{#if {{? {{getglobalvar::toggle_response_language}}=0}}}}EN{{/if}}{{#if {{? {{getglobalvar::toggle_response_language}}=1}}}}KO{{/if}}{{#if {{? {{getglobalvar::toggle_response_language}}=2}}}}JA{{/if}} | ' +
                    'STYLE={{#if {{? {{getglobalvar::toggle_narrative_style}}=1}}}}CLEAN_PROSE{{/if}} | ' +
                    'GENRES={{trim::{{#each {{array::toggle_genre1::toggle_genre2}} gv}}{{#if_pure {{equal::{{getglobalvar::{{slot::gv}}}}::1}}}}Comedy; {{/if}}{{#if_pure {{equal::{{getglobalvar::{{slot::gv}}}}::2}}}}Romance; {{/if}}{{/each}}}} | ' +
                    'CUSTOM={{#if {{and::{{not_equal::{{getglobalvar::toggle_custom_narrative}}::null}}::{{? {{length::{{getglobalvar::toggle_custom_narrative}}}}>0}}}}}}{{getglobalvar::toggle_custom_narrative}}{{/if}} | ' +
                    'BK={{#escape}}{bkspc}{{/}}' +
                    '{{#each {{? {{lastmessageid}}}} item}}{{#if {{? {{contains::{{previous_chat_log::{{slot::item}}}}::Helena}}}}}}{{settempvar::HELENA::TRUE}}{{/if}}{{/each}}' +
                    '{{#if {{equal::{{gettempvar::HELENA}}::TRUE}}}} | SAW_HELENA{{/if}}' +
                    '{{#if {{? {{getglobalvar::toggle_trpgmode}}=1}}}}\n<!--TRPG_MODE-->{{/if}}',
            },
            {
                type: 'persona',
                role: 'user',
                innerFormat: '{{#if {{? {{getglobalvar::toggle_topbotpersona}}=0}}}}<PC>{{slot}}</PC>{{/if}}{{#if {{? {{getglobalvar::toggle_topbotpersona}}=1}}}}<Players Character is nothing>{{/if}}',
            },
            {
                type: 'description',
                role: 'user',
                innerFormat: '<NPC>{{slot}}</NPC>',
            },
            {
                type: 'plain',
                role: 'user',
                text: '{{#if {{? {{getglobalvar::toggle_PastMemori}}=1}}}}PAST:[{{position::ep1}}]{{/if}}',
            },
            { type: 'chat', rangeStart: 0, rangeEnd: -2 },
            { type: 'cache', role: 'all', text: '' },
            { type: 'postEverything', role: 'system', text: '' },
            { type: 'chat', rangeStart: -2, rangeEnd: -1 },
            { type: 'chat', rangeStart: -1, rangeEnd: 'end' },
        ],
    };

    const charObj = {
        chaId: 'char-soakma',
        name: 'Helena',
        desc: 'NPC Desc with 독점욕',
        personality: '',
        scenario: '',
        systemPrompt: '',
        replaceGlobalNote: '',
        lowLevelAccess: false,
        triggerscript: [],
        customscript: [],
        globalLore: [],
        chatPage: 0,
        chats: [],
    };
    const chatObj = {
        id: 'chat-soakma-0',
        name: 'Chat 1',
        note: '',
        useLocallySetGlobalVariables: false,
        GLGlobalVariables: {},
        scriptstate: {},
        localLore: [],
        modules: [soakmaModule.id],
        message: [
            { role: 'user', data: '안녕 Helena', chatId: 'cid-0' },
        ],
    };

    const bridge = createFakeHostBridge({
        modules: [soakmaModule],
        charObj,
        chatObj,
    });

    const token = 'tok-soakma';
    const tmpCfgPath = path.join(os.tmpdir(), `rs-soakma-cfg-${Date.now()}.json`);
    const relay = createRelayServer({
        token,
        pluginsPath: path.join(os.tmpdir(), `rs-soakma-plug-${Date.now()}.json`),
        configPath: tmpCfgPath,
        configOverride: {
            profiles: [{
                id: 'prof-soakma',
                name: 'Soakma Mock LLM',
                provider: 'custom',
                providerType: 'openai_compat',
                baseUrl: `${llmUrl}/v1/chat/completions`,
                apiKey: 'k-test',
                model: 'gpt-test',
            }],
            activeProfileId: 'prof-soakma',
            directPresetId: 'off',
            remoteDirectOnly: true,
            remoteToggleValues: {},
        },
    });
    const baseUrl = await listenServer(relay);
    const headers = { 'Content-Type': 'application/json', 'X-RisuStand-Token': token };
    bridge.startRpcLoop(baseUrl, token);

    const pushRichSnapshot = async () => {
        const msgs = (bridge.dbState.chat.message || []).map((m, idx) => ({
            index: idx,
            role: m.role,
            chatId: m.chatId || '',
            text: m.data || '',
            html: m.data || '',
            raw: m.data || '',
            images: [],
            swipeCount: 1,
            swipeIndex: 0,
        }));
        await fetch(`${baseUrl}/api/pc/poll`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                bridgeVersion: '2.0.0',
                pluginVersion: '1.1.0',
                generating: false,
                catalog: {
                    pcActiveCharIndex: 0,
                    pcActiveChatIndex: 0,
                    selectedPersona: 0,
                    params: { temperature: 80, maxContext: 8000, maxResponse: 1000 },
                    characters: [{ index: 0, name: 'Helena', activeChatIndex: 0, chats: [{ index: 0, name: 'Chat 1' }] }],
                    modules: [{ id: soakmaModule.id, name: soakmaModule.name, enabled: true, hasToggles: true }],
                    personas: [{ index: 0, name: 'Player1' }],
                },
                snapshot: {
                    charName: 'Helena',
                    charIndex: 0,
                    chatIndex: 0,
                    chatUuid: chatObj.id,
                    chatName: 'Chat 1',
                    isPcActive: false,
                    totalMessages: msgs.length,
                    chatModules: [soakmaModule.id],
                    customToggleBlocks: [{ source: soakmaModule.name, syntax: soakmaModuleToggle }],
                    useLocallySetGlobalVariables: false,
                    globalToggleValues: {},
                    localToggleValues: {},
                    chatVariables: {},
                    assetMap: {},
                    messages: msgs,
                    charContext: {
                        charId: 'char-soakma',
                        name: 'Helena',
                        desc: charObj.desc,
                        personaName: 'Player1',
                        personaPrompt: '',
                        loreEntries: [
                            { uid: 'ep-1', content: '@@position pt_ep1\nEpisode One Summary', alwaysActive: true, key: '' },
                        ],
                    },
                },
            }),
        });
    };

    try {
        await pushRichSnapshot();

        // Upload & select Soakma-style preset (without internal toggles)
        const upRes = await fetch(`${baseUrl}/api/presets/custom`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ filename: 'soakma_v17.json', jsonObject: soakmaPreset }),
        }).then((r) => r.json());
        assert.equal(upRes.ok, true);

        // Turn 1: Default state (everything = 0, wordRequest = 0 so "독점욕" is KEPT)
        await fetch(`${baseUrl}/api/chat/send`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, text: '첫 번째 행동' }),
        });
        for (let i = 0; i < 60; i += 1) {
            if (llmRequests.length >= 1 && bridge.dbState.chat.message.length >= 3) break;
            await new Promise((r) => setTimeout(r, 30));
        }
        assert.equal(llmRequests.length, 1);
        const req1Msgs = llmRequests[0].messages;
        const req1Joined = req1Msgs.map((m) => m.content).join('\n');
        assert.ok(req1Joined.includes('LANG=EN'), 'response_language=0 must pick EN only');
        assert.ok(!req1Joined.includes('LANG=KO') && !req1Joined.includes('CLEAN_PROSE'), 'Non-selected options must not activate');
        assert.ok(req1Joined.includes('BK={bkspc}'), '#escape should preserve literal {bkspc}');
        assert.ok(req1Joined.includes('SAW_HELENA'), '#each lastmessageid + previous_chat_log should detect Helena');
        assert.ok(!req1Joined.includes('PAST:[Episode One Summary]'), 'PastMemori=0 should keep pt_ep1 hidden');
        assert.ok(!req1Joined.includes('<!--TRPG_MODE-->') && !req1Joined.includes('[LUA_TRPG_ACTIVE]'));
        assert.ok(req1Joined.includes('독점욕'), 'wordRequest=0 should keep 독점욕');
        assert.equal(req1Msgs.filter((m) => m.content.includes('첫 번째 행동')).length, 1, 'Multi-chat slice must not duplicate messages');
        assert.ok(!/\{\{#if|\{\{#each|\{\{getglobalvar|\{\{position::|\{\{\/if\}\}/.test(req1Joined), 'No unexpanded CBS macros');

        // Verify backend module adapter editDisplay regexes react accurately to default vs toggled globals
        const { evalPresetCbs } = require('../risustand-relay-server.js');
        const cfgRef = { remoteToggleValues: {} };
        const modAd = createModuleAdapter({
            getBackendConfig: () => cfgRef,
            evalCbs: evalPresetCbs,
        });
        await modAd.prepareTurn({ charIndex: 0, chatIndex: 0, charObj, chatObj, modulesOverride: [soakmaModule], globalVarsOverride: {} });
        const dispDefault = await modAd.runEditPhase('editDisplay', '걸음을 옮겼다. §쿵§ 그리고, 침묵이 흘렀다.');
        assert.ok(dispDefault.includes('<sfx><ruby>쿵<rt>sfx</rt></ruby></sfx>'), 'onomatopoeia_off=0 should render ruby sfx');
        assert.ok(dispDefault.includes(','), 'zerocomma=0 must not match empty pattern or strip comma');
        modAd.endTurn();

        // Turn 2: Toggle module controls immediately via /api/command (no PC poll round-trip needed)
        const globalCmds = [
            { key: 'response_language', value: '1', scope: 'global' },
            { key: 'narrative_style', value: '1', scope: 'global' },
            { key: 'genre1', value: '2', scope: 'global' },
            { key: 'custom_narrative', value: '아리스', scope: 'global' },
            { key: 'PastMemori', value: '1', scope: 'global' },
            { key: 'topbotpersona', value: '1', scope: 'global' },
            { key: 'trpgmode', value: '1', scope: 'global' },
            { key: 'wordRequest', value: '1', scope: 'global' },
            { key: 'onomatopoeia_off', value: '1', scope: 'global' },
            { key: 'zerocomma', value: '1', scope: 'global' },
        ];
        for (const payload of globalCmds) {
            await fetch(`${baseUrl}/api/command`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ type: 'set_custom_toggle', payload: { charIndex: 0, chatIndex: 0, ...payload } }),
            });
            cfgRef.remoteToggleValues[`toggle_${payload.key}`] = payload.value;
        }

        await modAd.prepareTurn({ charIndex: 0, chatIndex: 0, charObj, chatObj, modulesOverride: [soakmaModule], globalVarsOverride: {} });
        const dispToggled = await modAd.runEditPhase('editDisplay', '걸음을 옮겼다. §쿵§ 그리고, 침묵이 흘렀다.');
        assert.ok(!dispToggled.includes('<sfx>') && !dispToggled.includes('쿵'), 'onomatopoeia_off=1 should remove sound block');
        assert.ok(!dispToggled.includes(','), 'zerocomma=1 should strip commas');
        modAd.endTurn();

        await fetch(`${baseUrl}/api/chat/send`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, text: '두 번째 행동' }),
        });
        for (let i = 0; i < 60; i += 1) {
            if (llmRequests.length >= 2 && bridge.dbState.chat.message.length >= 5) break;
            await new Promise((r) => setTimeout(r, 30));
        }
        assert.equal(llmRequests.length, 2);
        const req2Msgs = llmRequests[1].messages;
        const req2Joined = req2Msgs.map((m) => m.content).join('\n');
        assert.ok(req2Joined.includes('LANG=KO') && !req2Joined.includes('LANG=EN'));
        assert.ok(req2Joined.includes('STYLE=CLEAN_PROSE'));
        assert.ok(req2Joined.includes('GENRES=Romance;'));
        assert.ok(req2Joined.includes('CUSTOM=아리스'));
        assert.ok(req2Joined.includes('PAST:[Episode One Summary]'));
        assert.ok(req2Joined.includes('<Players Character is nothing>'), 'Empty personaPrompt must still emit topbotpersona=1 block');
        assert.equal(req2Msgs.find((m) => m.content.includes('<Players Character is nothing>')).role, 'user');
        assert.equal(req2Msgs.find((m) => m.content.includes('<NPC>')).role, 'user');
        assert.ok(req2Joined.includes('<!--TRPG_MODE-->'));
        assert.ok(req2Joined.includes('[LUA_TRPG_ACTIVE]'), 'Module Lua listenEdit(editRequest) must react to TRPG_MODE & toggle_trpgmode=1');
        assert.ok(!req2Joined.includes('독점욕'), 'wordRequest=1 regex without <cbs> flag must strip matched word');
        assert.ok(!/\{\{#if|\{\{#each|\{\{getglobalvar|\{\{position::|\{\{\/if\}\}/.test(req2Joined));

        // Turn 3: Local scope toggle overrides global scope immediately
        await fetch(`${baseUrl}/api/command`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                type: 'set_custom_toggle',
                payload: { charIndex: 0, chatIndex: 0, key: 'response_language', value: '2', scope: 'local' },
            }),
        });
        await fetch(`${baseUrl}/api/command`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                type: 'set_custom_toggle',
                payload: { charIndex: 0, chatIndex: 0, key: 'trpgmode', value: '0', scope: 'local' },
            }),
        });

        await fetch(`${baseUrl}/api/chat/send`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, text: '세 번째 행동' }),
        });
        for (let i = 0; i < 60; i += 1) {
            if (llmRequests.length >= 3 && bridge.dbState.chat.message.length >= 7) break;
            await new Promise((r) => setTimeout(r, 30));
        }
        assert.equal(llmRequests.length, 3);
        const req3Joined = llmRequests[2].messages.map((m) => m.content).join('\n');
        assert.ok(req3Joined.includes('LANG=JA') && !req3Joined.includes('LANG=KO'));
        assert.ok(!req3Joined.includes('<!--TRPG_MODE-->') && !req3Joined.includes('[LUA_TRPG_ACTIVE]'));

        const html = await fetch(`${baseUrl}/`).then((r) => r.text());
        assert.ok(html.includes("typeLower === 'groupend'"));
    } finally {
        await bridge.stop();
        await closeServer(relay);
        await closeServer(mockLLM);
        try { fs.rmSync(tmpCfgPath, { force: true }); } catch (_) {}
    }
});

test('Asset Maid image click opens dedicated GUI overlay, showContainer triggers GUI, and revision < / > switches images', async () => {
    const tmpCfgPath = path.join(os.tmpdir(), `rs-am-rev-cfg-${Date.now()}.json`);
    const tmpPluginsPath = path.join(os.tmpdir(), `rs-am-rev-plugins-${Date.now()}.json`);
    const rev1Png = Buffer.concat([ONE_BY_ONE_PNG, Buffer.from('REV1')]);
    const rev2Png = Buffer.concat([ONE_BY_ONE_PNG, Buffer.from('REV2')]);

    const charObj = {
        chaId: 'char-am-rev-1',
        name: 'Sieun',
        desc: 'Campus story',
        personality: '',
        scenario: '',
        systemPrompt: '',
        replaceGlobalNote: '',
        lowLevelAccess: false,
        triggerscript: [],
        customscript: [],
        globalLore: [],
        additionalAssets: [
            ['rev1_asset', 'assets/rev1.png', 'png'],
            ['rev2_asset', 'assets/rev2.png', 'png'],
        ],
        chatPage: 0,
        chats: [],
    };
    const chatObj = {
        id: 'chat-am-rev-1',
        name: 'Chat 1',
        note: '',
        modules: [],
        localLore: [],
        scriptstate: {},
        message: [
            { role: 'user', data: '안녕', chatId: 'cid-rev-0' },
            { role: 'char', data: '장면 본문\n<div class="x-risu-am-illustration-projection"><span class="x-risu-am-image"><img class="x-risu-am-image__media" src="{{raw::rev2_asset}}" /></span></div>', chatId: 'cid-rev-1' },
        ],
    };
    charObj.chats = [chatObj];

    const bridge = createFakeHostBridge({ charObj, chatObj });
    const relay = createRelayServer({
        token: 'test-am-rev-token',
        configPath: tmpCfgPath,
        pluginsPath: tmpPluginsPath,
        configOverride: { activeProfileId: '' },
    });
    const baseUrl = await listenServer(relay);
    const headers = { 'Content-Type': 'application/json', 'X-RisuStand-Token': 'test-am-rev-token' };

    try {
        bridge.startRpcLoop(baseUrl, 'test-am-rev-token');
        const assetMap = {
            'assets/rev1.png': `data:image/png;base64,${rev1Png.toString('base64')}`,
            'assets/rev2.png': `data:image/png;base64,${rev2Png.toString('base64')}`,
            rev1_asset: `data:image/png;base64,${rev1Png.toString('base64')}`,
            rev2_asset: `data:image/png;base64,${rev2Png.toString('base64')}`,
        };
        await fetch(`${baseUrl}/api/pc/poll`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                bridgeVersion: '2.0.0',
                pluginVersion: '1.1.0',
                generating: false,
                catalog: {
                    pcActiveCharIndex: 0,
                    pcActiveChatIndex: 0,
                    selectedPersona: 0,
                    params: { temperature: 80, maxContext: 8000, maxResponse: 1000 },
                    characters: [{ index: 0, name: 'Sieun', activeChatIndex: 0, chats: [{ index: 0, name: 'Chat 1' }] }],
                    modules: [],
                    personas: [{ index: 0, name: 'User' }],
                },
                snapshot: {
                    charIndex: 0,
                    chatIndex: 0,
                    charName: 'Sieun',
                    chatName: 'Chat 1',
                    chatUuid: 'chat-am-rev-1',
                    isPcActive: true,
                    totalMessages: 2,
                    chatModules: [],
                    chatVariables: {},
                    assetMap,
                    messages: [
                        { index: 0, role: 'user', raw: chatObj.message[0].data, html: chatObj.message[0].data, text: '안녕', images: [], chatId: 'cid-rev-0' },
                        { index: 1, role: 'char', raw: chatObj.message[1].data, html: chatObj.message[1].data, text: '장면 본문', images: [], chatId: 'cid-rev-1' },
                    ],
                    charContext: { charId: 'char-am-rev-1', name: 'Sieun', personaName: 'User' },
                },
            }),
        });

        const amInteractivePlugin = `
        //@name AssetMaidInteractiveTest
        //@display-name Asset Maid Interactive
        //@api 3.0
        (async () => {
            const doc = await risuai.getRootDocument();
            let revIdx = 2;
            let lastPromptEdit = '';

            async function renderFooter(row) {
                const bodyEl = await row.querySelector('.chattext');
                if (!bodyEl) return;
                let footer = await bodyEl.querySelector('.x-risu-am-illustration-footer');
                if (!footer) {
                    footer = await doc.createElement('div');
                    await footer.addClass('x-risu-am-illustration-footer');
                    await bodyEl.appendChild(footer);
                }
                const prevRev = await footer.getAttribute('x-am-rev').catch(() => '');
                if (prevRev === String(revIdx)) return;
                await footer.setAttribute('x-am-rev', String(revIdx));
                await footer.setInnerHTML(
                    '<button type="button" class="x-risu-am-illustration-footer__generate" title="재생성">↻</button>' +
                    '<div class="x-risu-am-illustration-revision-controls">' +
                      '<button type="button" title="이전 이미지">&lt;</button>' +
                      '<span class="x-risu-am-illustration-revision-count">' + revIdx + '/2</span>' +
                      '<button type="button" title="다음 이미지">&gt;</button>' +
                    '</div>'
                );
            }

            async function reconcileAll() {
                const screen = await doc.querySelector('.default-chat-screen');
                if (!screen) return;
                const rows = await screen.querySelectorAll('.risu-chat[data-role="char"]');
                const count = await rows.length();
                for (let i = 0; i < count; i += 1) {
                    await renderFooter(await rows.at(i));
                }
            }

            async function openInspectorOverlay() {
                let vp = await doc.querySelector('[data-am-floating-viewport]');
                if (!vp) {
                    vp = await doc.createElement('div');
                    await vp.setAttribute('data-am-floating-viewport', 'true');
                    await doc.body.appendChild(vp);
                }
                const assetName = revIdx === 1 ? 'rev1_asset' : 'rev2_asset';
                await vp.setInnerHTML(
                    '<div class="am-inspector-modal">' +
                      '<img class="am-inspector-img" src="{{raw::' + assetName + '}}" />' +
                      '<input id="amPromptEditInp" type="text" value="custom prompt" />' +
                      '<button type="button" id="amCloseInspectorBtn">닫기</button>' +
                    '</div>'
                );
            }

            await doc.addEventListener('click', async (ev) => {
                const target = ev.target;
                if (!target) return;
                const id = target.id || (await target.getAttribute('id').catch(() => ''));
                const title = await target.getAttribute('title').catch(() => '');
                const cls = await target.getClassName().catch(() => '');

                if (id === 'amCloseInspectorBtn') {
                    const vp = await doc.querySelector('[data-am-floating-viewport]');
                    if (vp) await vp.setInnerHTML('');
                    return;
                }
                if (title === '이전 이미지' || title === '다음 이미지') {
                    revIdx = title === '이전 이미지' ? Math.max(1, revIdx - 1) : Math.min(2, revIdx + 1);
                    const chat = await risuai.getChat();
                    const msg = chat.message.find((m) => m.chatId === 'cid-rev-1');
                    if (msg) {
                        const tok = revIdx === 1 ? 'rev1_asset' : 'rev2_asset';
                        msg.data = '장면 본문\\n<div class="x-risu-am-illustration-projection"><span class="x-risu-am-image"><img class="x-risu-am-image__media" src="{{raw::' + tok + '}}" /></span></div>';
                        await risuai.setChat(chat);
                    }
                    await reconcileAll();
                    return;
                }
                if (cls.includes('x-risu-am-image__media') || cls.includes('x-risu-am-image')) {
                    await openInspectorOverlay();
                }
            });

            await doc.addEventListener('input', async (ev) => {
                if (ev.target && ev.target.id === 'amPromptEditInp') {
                    lastPromptEdit = String(ev.target.value || '');
                    await risuai.setArg('last_prompt_edit', lastPromptEdit);
                }
            });

            const body = await doc.querySelector('body');
            const obs = await risuai.createMutationObserver(() => { void reconcileAll(); });
            await obs.observe(body, { childList: true, subtree: true });
            await reconcileAll();
        })();
        `;

        await fetch(`${baseUrl}/api/plugins/upload`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ filename: 'AssetMaidInteractiveTest.js', script: amInteractivePlugin, enabled: true }),
        }).then((r) => assert.equal(r.status, 200));

        // Initial state shows rev2/2 asset URL
        const st0 = await fetch(`${baseUrl}/api/state`, { headers }).then((r) => r.json());
        const m0 = st0.snapshot.messages.find((m) => m.chatId === 'cid-rev-1');
        assert.ok(m0 && m0.pluginFooterHtml.includes('2/2'));
        const rev2Match = m0.html.match(/src="(\/api\/asset\/[^"]+)"/);
        assert.ok(rev2Match && rev2Match[1], 'Initial message should resolve rev2 asset URL');
        const rev2Url = rev2Match[1];

        // 1) Click '<' (이전 이미지) button with NO data-* attributes -> must match exact button, call setChat(), switch image to rev1 and update counter to 1/2
        const revClickRes = await fetch(`${baseUrl}/api/plugins/surface-action`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                charIndex: 0,
                chatIndex: 0,
                msgIndex: 1,
                chatId: 'cid-rev-1',
                actionHtml: '<button type="button" title="이전 이미지">&lt;</button>',
                textContent: '<',
                title: '이전 이미지',
                siblingIndex: 0,
            }),
        }).then((r) => r.json());
        assert.equal(revClickRes.ok, true, `Unexpected revClickRes: ${JSON.stringify(revClickRes)}`);
        assert.equal(revClickRes.matchedLive, true);
        assert.equal(revClickRes.openedOverlay, null, 'Revision switch must not pop up an overlay modal');

        const updatedMsg = revClickRes.snapshot.messages.find((m) => m.chatId === 'cid-rev-1');
        assert.ok(updatedMsg && updatedMsg.pluginFooterHtml.includes('1/2'), 'Footer counter must switch to 1/2');
        const rev1Match = updatedMsg.html.match(/src="(\/api\/asset\/[^"]+)"/);
        assert.ok(rev1Match && rev1Match[1] && rev1Match[1] !== rev2Url, 'Image URL must switch to rev1 after clicking <');
        assert.ok(bridge.dbState.chat.message[1].data.includes('{{raw::rev1_asset}}'), 'setChat() must persist rev1 to host bridge');

        // 2) Click generated image -> plugin mounts dedicated inspector overlay inside [data-am-floating-viewport]
        const imgClickRes = await fetch(`${baseUrl}/api/plugins/surface-action`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                charIndex: 0,
                chatIndex: 0,
                msgIndex: 1,
                chatId: 'cid-rev-1',
                actionHtml: `<img class="x-risu-am-image__media" src="${rev1Match[1]}">`,
                className: 'x-risu-am-image__media',
            }),
        }).then((r) => r.json());
        assert.equal(imgClickRes.ok, true);
        assert.equal(imgClickRes.matchedLive, true);
        assert.ok(imgClickRes.openedOverlay && imgClickRes.openedOverlay.pluginName === 'AssetMaidInteractiveTest', 'Clicking image must open dedicated plugin overlay');
        assert.ok(imgClickRes.openedOverlay.html.includes('am-inspector-modal'));
        assert.ok(imgClickRes.openedOverlay.html.includes(rev1Match[1]), 'Overlay image token {{raw::rev1_asset}} must resolve to /api/asset/... URL');

        // 3) Interact with input inside dedicated overlay GUI + close it via root-click
        const inputRes = await fetch(`${baseUrl}/api/plugins/root-click`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                pluginName: 'AssetMaidInteractiveTest',
                charIndex: 0,
                chatIndex: 0,
                selector: '#amPromptEditInp',
                eventType: 'input',
                value: 'edited prompt text',
            }),
        }).then((r) => r.json());
        assert.equal(inputRes.ok, true);
        assert.equal(inputRes.matchedLive, true);

        const closeOverlayRes = await fetch(`${baseUrl}/api/plugins/root-click`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                pluginName: 'AssetMaidInteractiveTest',
                charIndex: 0,
                chatIndex: 0,
                selector: '#amCloseInspectorBtn',
                eventType: 'click',
            }),
        }).then((r) => r.json());
        assert.equal(closeOverlayRes.ok, true);
        assert.equal(closeOverlayRes.activeOverlay, null, 'Closing dedicated overlay must clear activeOverlay');

        // 4) Plugin calling risuai.showContainer() opens full plugin GUI modal
        const showContainerPlugin = `
        //@name ShowContainerTest
        //@display-name Show Container Plugin
        //@api 3.0
        (async () => {
            const doc = await risuai.getRootDocument();
            await doc.addEventListener('click', async (ev) => {
                if (ev.target && ev.target.classList && ev.target.classList.contains('open-container-img')) {
                    await risuai.showContainer();
                }
            });
        })();
        `;
        await fetch(`${baseUrl}/api/plugins/upload`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ filename: 'ShowContainerTest.js', script: showContainerPlugin, enabled: true }),
        }).then((r) => assert.equal(r.status, 200));

        const showRes = await fetch(`${baseUrl}/api/plugins/surface-action`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                charIndex: 0,
                chatIndex: 0,
                actionHtml: '<img class="open-container-img" data-am-image-action="open" />',
                dataset: { 'data-am-image-action': 'open' },
                className: 'open-container-img',
            }),
        }).then((r) => r.json());
        assert.ok(showRes.openPluginGui && showRes.openPluginGui.pluginName === 'ShowContainerTest', 'showContainer() must instruct UI to open plugin GUI modal');

        // 5) Embedded client JS compiles cleanly and keeps data-pfm-open-gui omitted
        const html = await fetch(`${baseUrl}/`).then((r) => r.text());
        assert.ok(!html.includes('data-pfm-open-gui'));
        assert.ok(html.includes('openPluginActionOverlayModal'));
        const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
        assert.ok(scriptMatch && scriptMatch[1]);
        assert.doesNotThrow(() => new Function(scriptMatch[1]));
    } finally {
        await bridge.stop();
        if (typeof relay.closeAllConnections === 'function') relay.closeAllConnections();
        await closeServer(relay);
        try { fs.rmSync(tmpCfgPath, { force: true }); } catch (_) {}
        try { fs.rmSync(tmpPluginsPath, { force: true }); } catch (_) {}
    }
});

test('rebuildDisplayedSnapshot runs Lua 5.4 listenEdit(editDisplay) for [LBDATA] modules without double-running regexes', async () => {
    const tmpCfgPath = path.join(os.tmpdir(), `rs-lua-disp-cfg-${Date.now()}.json`);
    const tmpPluginsPath = path.join(os.tmpdir(), `rs-lua-disp-plg-${Date.now()}.json`);
    const lbModule = {
        id: 'mod-lb-display',
        name: 'Lightboard Display Mock',
        trigger: [
            {
                type: 'manual',
                effect: [{
                    type: 'triggerlua',
                    code: `
listenEdit('editDisplay', function(id, text)
    if type(text) ~= 'string' then return text end
    return text:gsub('%[LBDATA START%]%s*([%s%S]-)%s*%[LBDATA END%]', '<div class="lb-panel">%1</div>')
end)
`,
                }],
            },
        ],
        regex: [],
    };
    const charObj = {
        chaId: 'char-hyeyeon-lb',
        name: 'Hyeyeon',
        customscript: [
            {
                type: 'editdisplay',
                comment: 'once_regex',
                in: '\\[COUNT_ME\\]',
                out: 'X',
                ableFlag: true,
                flag: 'g',
            },
        ],
        chats: [],
    };
    const chatObj = {
        id: 'chat-lb-1',
        name: 'Chat 1',
        modules: [lbModule.id],
        message: [
            { role: 'user', data: '안녕', chatId: 'lb-m0' },
            { role: 'char', data: '본문 [COUNT_ME]\n[LBDATA START]상태: 안정[LBDATA END]', chatId: 'lb-m1' },
        ],
    };
    charObj.chats = [chatObj];

    const bridge = createFakeHostBridge({ charObj, chatObj, modules: [lbModule] });
    const relay = createRelayServer({
        token: 'test-lua-editdisplay-tok',
        configPath: tmpCfgPath,
        pluginsPath: tmpPluginsPath,
        configOverride: { activeProfileId: '' },
    });
    const baseUrl = await listenServer(relay);
    const headers = { 'Content-Type': 'application/json', 'X-RisuStand-Token': 'test-lua-editdisplay-tok' };

    try {
        bridge.startRpcLoop(baseUrl, 'test-lua-editdisplay-tok');
        await new Promise((r) => setTimeout(r, 80));
        await fetch(`${baseUrl}/api/pc/poll`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                bridgeVersion: '2.0.0',
                pluginVersion: '1.1.0',
                generating: false,
                catalog: {
                    pcActiveCharIndex: 0,
                    pcActiveChatIndex: 0,
                    selectedPersona: 0,
                    params: { temperature: 80, maxContext: 8000, maxResponse: 1000 },
                    characters: [{ index: 0, name: 'Hyeyeon', activeChatIndex: 0, chats: [{ index: 0, name: 'Chat 1' }] }],
                    modules: [{ id: lbModule.id, name: lbModule.name, enabled: true }],
                    personas: [{ index: 0, name: 'User' }],
                },
                snapshot: {
                    charIndex: 0,
                    chatIndex: 0,
                    charName: 'Hyeyeon',
                    chatName: 'Chat 1',
                    chatUuid: 'chat-lb-1',
                    isPcActive: true,
                    totalMessages: 2,
                    chatModules: [{ id: lbModule.id, name: lbModule.name, enabled: true }],
                    chatVariables: {},
                    assetMap: {},
                    messages: [
                        { index: 0, role: 'user', raw: chatObj.message[0].data, html: '안녕', text: '안녕', images: [], chatId: 'lb-m0' },
                        { index: 1, role: 'char', raw: chatObj.message[1].data, html: '본문 X\n[LBDATA START]상태: 안정[LBDATA END]', text: '본문 X', images: [], chatId: 'lb-m1' },
                    ],
                },
            }),
        });

        let st = null;
        for (let i = 0; i < 20; i += 1) {
            const candidate = await fetch(`${baseUrl}/api/state`, { headers }).then((r) => r.json());
            const msg1 = candidate && candidate.snapshot && Array.isArray(candidate.snapshot.messages)
                ? candidate.snapshot.messages.find((m) => m.index === 1)
                : null;
            if (msg1 && msg1.html && msg1.html.includes('<div class="lb-panel">상태: 안정</div>')) {
                st = candidate;
                break;
            }
            await new Promise((r) => setTimeout(r, 40));
        }
        assert.ok(st, 'Lua listenEdit(editDisplay) must project transformed Lightboard HTML into /api/state');
        const finalMsg1 = st.snapshot.messages.find((m) => m.index === 1);
        assert.ok(finalMsg1.html.includes('<div class="lb-panel">상태: 안정</div>'));
        assert.ok(!finalMsg1.html.includes('[LBDATA START]'));
    } finally {
        await bridge.stop();
        if (typeof relay.closeAllConnections === 'function') relay.closeAllConnections();
        await closeServer(relay);
        try { fs.rmSync(tmpCfgPath, { force: true }); } catch (_) {}
        try { fs.rmSync(tmpPluginsPath, { force: true }); } catch (_) {}
    }
});

test('1-arg cbs(), {{history::role}}, log(), Lua {{asset::}} resolution, and /api/modules/interaction instant snapshot update', async () => {
    const tmpCfgPath = path.join(os.tmpdir(), `rs-hyeyeon-parity-cfg-${Date.now()}.json`);
    const tmpPluginsPath = path.join(os.tmpdir(), `rs-hyeyeon-parity-plg-${Date.now()}.json`);
    const sampleImg = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const sampleUrl = `data:image/png;base64,${sampleImg.toString('base64')}`;
    const hyLua = `
log('Hyeyeon parity boot')
onButtonClick = function(id, code)
    if code == 'hy_toggle' then
        local cur = cbs('{{getvar::hy_ui_open}}')
        setChatVar(id, 'hy_ui_open', cur == '1' and '0' or '1')
    end
end
listenEdit('editDisplay', function(id, text, meta)
    local idx = tonumber(meta and meta.index) or -1
    if idx ~= getChatLength(id) - 1 then return text end
    local h = hash(cbs('{{history::role}}'))
    local isOpen = cbs('{{getvar::hy_ui_open}}') == '1'
    local clean = tostring(text):gsub('<hy%-status[^>]*/>', '')
    return clean .. '<div class="hy-sb" data-h="' .. h:sub(1, 8) .. '">{{asset::hy_portrait}}</div>' ..
        '<div class="hy-ui"><button type="button" class="hy-float" risu-btn="hy_toggle">열기</button>' ..
        '<div class="hy-panel' .. (isOpen and ' hy-open' or '') .. '"><span>상태패널</span></div></div>'
end)
`;
    const charObj = {
        chaId: 'hyeyeon-parity',
        name: 'Hyeyeon',
        additionalAssets: [['hy_portrait', 'assets/hy_portrait.png', 'png']],
        triggerscript: [{
            comment: 'HyeyeonMock',
            type: 'output',
            lowLevelAccess: true,
            effect: [{ type: 'triggerlua', code: hyLua }],
        }],
        chats: [],
    };
    const chatObj = {
        id: 'chat-hy-1',
        name: 'Chat 1',
        scriptstate: { $hy_ui_open: '0', $complex_state: { tab: 'relation' } },
        message: [
            { role: 'user', data: '안녕', chatId: 'hy-m0' },
            { role: 'char', data: '본문 <hy-status time="13:06"/>', chatId: 'hy-m1' },
        ],
    };
    charObj.chats = [chatObj];

    const bridge = createFakeHostBridge({
        charObj,
        chatObj,
        modules: [],
        onReadImage: (p) => (p === 'assets/hy_portrait.png' ? sampleUrl : null),
    });
    const relay = createRelayServer({
        token: 'test-hyeyeon-parity-tok',
        configPath: tmpCfgPath,
        pluginsPath: tmpPluginsPath,
        configOverride: { activeProfileId: '' },
    });
    const baseUrl = await listenServer(relay);
    const headers = { 'Content-Type': 'application/json', 'X-RisuStand-Token': 'test-hyeyeon-parity-tok' };

    try {
        bridge.startRpcLoop(baseUrl, 'test-hyeyeon-parity-tok');
        await new Promise((r) => setTimeout(r, 80));
        await fetch(`${baseUrl}/api/pc/poll`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                bridgeVersion: '2.0.0',
                pluginVersion: '1.1.0',
                generating: false,
                catalog: {
                    pcActiveCharIndex: 0,
                    pcActiveChatIndex: 0,
                    selectedPersona: 0,
                    params: { temperature: 80, maxContext: 8000, maxResponse: 1000 },
                    characters: [{ index: 0, name: 'Hyeyeon', activeChatIndex: 0, chats: [{ index: 0, name: 'Chat 1' }] }],
                    modules: [],
                    personas: [{ index: 0, name: 'User' }],
                },
                snapshot: {
                    charIndex: 0,
                    chatIndex: 0,
                    charName: 'Hyeyeon',
                    chatName: 'Chat 1',
                    chatUuid: 'chat-hy-1',
                    isPcActive: true,
                    totalMessages: 2,
                    chatModules: [],
                    chatVariables: { hy_ui_open: '0' },
                    assetMap: {},
                    messages: [
                        { index: 0, role: 'user', raw: chatObj.message[0].data, html: '안녕', text: '안녕', images: [], chatId: 'hy-m0' },
                        { index: 1, role: 'char', raw: chatObj.message[1].data, html: '본문 <hy-status time="13:06"/>', text: '본문', images: [], chatId: 'hy-m1' },
                    ],
                },
            }),
        });

        let msg1 = null;
        for (let i = 0; i < 20; i += 1) {
            const st = await fetch(`${baseUrl}/api/state`, { headers }).then((r) => r.json());
            const m = st && st.snapshot && Array.isArray(st.snapshot.messages) ? st.snapshot.messages.find((x) => x.index === 1) : null;
            if (m && m.html && m.html.includes('hy-sb')) {
                msg1 = m;
                break;
            }
            await new Promise((r) => setTimeout(r, 40));
        }
        assert.ok(msg1, 'Lua editDisplay must strip <hy-status> and inject hy-sb / hy-ui');
        assert.ok(!msg1.html.includes('<hy-status'));
        assert.match(msg1.html, /<img class="msg-img" src="\/api\/asset\/[a-f0-9]{32}" \/>/, '{{asset::hy_portrait}} must resolve to /api/asset/<id>');
        assert.ok(msg1.html.includes('class="hy-panel"'));

        // Toggle hy_ui_open via /api/modules/interaction and verify instant refreshed snapshot
        const intRes = await fetch(`${baseUrl}/api/modules/interaction`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, kind: 'button', code: 'hy_toggle' }),
        }).then((r) => r.json());
        assert.equal(intRes.ok, true);
        assert.equal(intRes.handled, true);
        const updatedMsg1 = intRes.snapshot && Array.isArray(intRes.snapshot.messages)
            ? intRes.snapshot.messages.find((x) => x.index === 1)
            : null;
        assert.ok(updatedMsg1 && updatedMsg1.html.includes('hy-panel hy-open'), 'interaction response must include refreshed snapshot with hy-open');
    } finally {
        await bridge.stop();
        if (typeof relay.closeAllConnections === 'function') relay.closeAllConnections();
        await closeServer(relay);
        try { fs.rmSync(tmpCfgPath, { force: true }); } catch (_) {}
        try { fs.rmSync(tmpPluginsPath, { force: true }); } catch (_) {}
    }
});

test('Asset Maid DOM mutation preserves Lua editDisplay (.hy-sb/.hy-ui/assets/LBDATA) via db.getDisplayLuaBundle', async () => {
    const tmpCfgPath = path.join(os.tmpdir(), `rs-hy-am-coexist-cfg-${Date.now()}.json`);
    const tmpPluginsPath = path.join(os.tmpdir(), `rs-hy-am-coexist-plg-${Date.now()}.json`);
    const sampleImg = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const sampleUrl = `data:image/png;base64,${sampleImg.toString('base64')}`;
    const luaCode = `
listenEdit('editDisplay', function(id, text, meta)
    local idx = tonumber(meta and meta.index) or -1
    if idx ~= getChatLength(id) - 1 then return text end
    local clean = tostring(text):gsub('<hy%-status[^>]*/>', '')
    clean = clean:gsub('%[LBDATA START%](.-)%[LBDATA END%]', '<div class="lb-card">%1</div>')
    return clean .. '<div class="hy-sb">시각 13:06</div><div class="hy-scene">{{asset::hy_portrait}}</div>' ..
        '<div class="hy-ui"><button type="button" class="hy-float" risu-btn="hy_toggle">혜연</button></div>'
end)
`;
    const charObj = {
        chaId: 'hy-am-coexist',
        name: 'Hyeyeon',
        additionalAssets: [['hy_portrait', 'assets/hy_portrait.png', 'png']],
        triggerscript: [{ comment: 'HyCoexist', type: 'output', lowLevelAccess: true, effect: [{ type: 'triggerlua', code: luaCode }] }],
        chats: [{
            id: 'chat-coexist-1',
            name: 'Chat 1',
            scriptstate: {},
            message: [
                { role: 'user', data: '안녕', chatId: 'co-m0' },
                { role: 'char', data: '본문 <hy-status time="13:06"/>\n[LBDATA START]단서[LBDATA END]', chatId: 'co-m1' },
            ],
        }],
    };
    let bundleCalls = 0;
    let stopRpc = false;
    const relay = createRelayServer({ token: 'test-hy-am-coexist-tok', configPath: tmpCfgPath, pluginsPath: tmpPluginsPath, configOverride: { activeProfileId: '' } });
    const baseUrl = await listenServer(relay);
    const headers = { 'Content-Type': 'application/json', 'X-RisuStand-Token': 'test-hy-am-coexist-tok' };
    const rpcLoop = (async () => {
        while (!stopRpc) {
            try {
                const w = await fetch(`${baseUrl}/api/pc/rpc-wait`, { method: 'POST', headers, body: JSON.stringify({ timeoutMs: 1500 }) }).then((r) => r.json());
                if (Array.isArray(w.calls) && w.calls.length) {
                    const results = w.calls.map((c) => {
                        if (c.op === 'db.getDisplayLuaBundle') {
                            bundleCalls += 1;
                            return { id: c.id, ok: true, value: { charObj, chatObj: charObj.chats[0], modules: [], globalChatVariables: {} } };
                        }
                        if (c.op === 'db.getCharacter') return { id: c.id, ok: true, value: charObj };
                        if (c.op === 'db.getChat') return { id: c.id, ok: true, value: charObj.chats[0] };
                        if (c.op === 'db.getActiveModules') return { id: c.id, ok: true, value: { modules: [], globalChatVariables: {} } };
                        if (c.op === 'asset.readImage') {
                            const b64 = sampleUrl.split(',')[1];
                            return { id: c.id, ok: true, value: { __b64: b64, mime: 'image/png' } };
                        }
                        if (c.op === 'db.getPlugins') return { id: c.id, ok: true, value: [] };
                        return { id: c.id, ok: true, value: null };
                    });
                    await fetch(`${baseUrl}/api/pc/rpc-result`, { method: 'POST', headers, body: JSON.stringify({ results }) });
                }
            } catch (_) {
                if (stopRpc) break;
                await new Promise((r) => setTimeout(r, 30));
            }
        }
    })();

    try {
        // Upload a DOM plugin that mutates .chattext (setting _rsBodyMutated) AND appends an Asset Maid footer
        const amSimPlugin = `
        //@name AssetMaidCoexistSim
        //@api 3.0
        (async () => {
            const doc = await risuai.getRootDocument();
            const reconcile = async () => {
                const rows = await doc.querySelectorAll('.risu-chat');
                for (const row of rows) {
                    if ((await row.getAttribute('data-role')) !== 'char') continue;
                    const ct = await row.querySelector('.chattext');
                    if (!ct) continue;
                    const cur = await ct.getInnerHTML();
                    if (!cur.includes('data-am-marked="1"')) {
                        const marker = await doc.createElement('span');
                        await marker.setAttribute('data-am-marked', '1');
                        await ct.appendChild(marker);
                    }
                    const ex = await ct.querySelector('.x-risu-am-illustration-footer');
                    if (!ex) {
                        const f = await doc.createElement('div');
                        await f.setAttribute('class', 'x-risu-am-illustration-footer');
                        await f.setInnerHTML('<button type="button">삽화 제어</button>');
                        await ct.appendChild(f);
                    }
                }
            };
            const body = await doc.querySelector('body');
            const obs = await risuai.createMutationObserver(() => { void reconcile(); });
            await obs.observe(body, { childList: true, subtree: true });
            await reconcile();
        })();
        `;
        await fetch(`${baseUrl}/api/plugins/upload`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ filename: 'AssetMaidCoexistSim.js', script: amSimPlugin, enabled: true }),
        }).then((r) => assert.equal(r.status, 200));

        await fetch(`${baseUrl}/api/pc/poll`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                bridgeVersion: '2.0.0',
                pluginVersion: '1.2.0',
                catalog: { pcActiveCharIndex: 0, pcActiveChatIndex: 0, selectedPersona: 0, params: {}, characters: [{ index: 0, name: 'Hyeyeon', chats: [{ index: 0, name: 'Chat 1' }] }], modules: [], personas: [{ index: 0, name: 'User' }] },
                snapshot: {
                    charIndex: 0,
                    chatIndex: 0,
                    charName: 'Hyeyeon',
                    chatName: 'Chat 1',
                    chatUuid: 'chat-coexist-1',
                    isPcActive: false,
                    totalMessages: 2,
                    chatModules: [],
                    chatVariables: {},
                    assetMap: {},
                    messages: [
                        { index: 0, role: 'user', raw: '안녕', html: '안녕', text: '안녕', images: [], chatId: 'co-m0' },
                        { index: 1, role: 'char', raw: charObj.chats[0].message[1].data, html: '본문 <hy-status time="13:06"/>\n[LBDATA START]단서[LBDATA END]', text: '본문', images: [], chatId: 'co-m1' },
                    ],
                },
            }),
        }).then((r) => assert.equal(r.status, 200));

        let msg1 = null;
        for (let i = 0; i < 20; i += 1) {
            const st = await fetch(`${baseUrl}/api/state`, { headers }).then((r) => r.json());
            const m = st && st.snapshot && Array.isArray(st.snapshot.messages) ? st.snapshot.messages.find((x) => x.index === 1) : null;
            if (m && m.html && m.html.includes('hy-sb') && m.pluginFooterHtml && m.pluginFooterHtml.includes('삽화 제어')) {
                msg1 = m;
                break;
            }
            await new Promise((r) => setTimeout(r, 40));
        }
        assert.ok(bundleCalls >= 1, 'db.getDisplayLuaBundle single-RPC path must be used');
        assert.ok(msg1, 'Lua editDisplay HTML and Asset Maid footer must both appear on message 1');
        assert.ok(!msg1.html.includes('<hy-status'), 'raw <hy-status> must be stripped');
        assert.ok(msg1.html.includes('hy-ui') && msg1.html.includes('hy-float'), 'floating menu .hy-ui/.hy-float must survive Asset Maid bodyHtml mutation');
        assert.ok(msg1.html.includes('lb-card'), 'Lightboard transform must survive Asset Maid bodyHtml mutation');
        assert.match(msg1.html, /<img class="msg-img" src="\/api\/asset\/[a-f0-9]{32}" \/>/, 'Lua {{asset::hy_portrait}} must resolve to /api/asset/<id>');
    } finally {
        stopRpc = true;
        if (typeof relay.closeAllConnections === 'function') relay.closeAllConnections();
        await closeServer(relay);
        await rpcLoop;
        try { fs.rmSync(tmpCfgPath, { force: true }); } catch (_) {}
        try { fs.rmSync(tmpPluginsPath, { force: true }); } catch (_) {}
    }
});

test('rebuildDisplayedSnapshot never passes [[RSASSET:...]] placeholders to asset.readImage and survives missing asset read errors', async () => {
    const tmpCfgPath = path.join(os.tmpdir(), `rs-rsasset-guard-cfg-${Date.now()}.json`);
    const tmpPluginsPath = path.join(os.tmpdir(), `rs-rsasset-guard-plg-${Date.now()}.json`);
    const luaCode = `
listenEdit('editDisplay', function(id, text, meta)
    local idx = tonumber(meta and meta.index) or -1
    if idx ~= getChatLength(id) - 1 then return text end
    return tostring(text) .. '<div class="hy-sb">시각 13:06</div><img src="[[RSASSET:a0]]"><div style="background-image:url(\\'[[RSASSET:a0]]\\')"></div>{{asset::missing_file}}'
end)
`;
    const charObj = {
        chaId: 'rsasset-guard',
        name: 'Hyeyeon',
        additionalAssets: [],
        triggerscript: [{ comment: 'HyLua', type: 'output', lowLevelAccess: true, effect: [{ type: 'triggerlua', code: luaCode }] }],
        chats: [{
            id: 'chat-rsasset-1',
            name: 'Chat 1',
            scriptstate: {},
            message: [
                { role: 'user', data: '안녕', chatId: 'rg-m0' },
                { role: 'char', data: '본문 <img src="[[RSASSET:a0]]">', chatId: 'rg-m1' },
            ],
        }],
    };
    const readImageRequests = [];
    let stopRpc = false;
    const relay = createRelayServer({ token: 'test-rsasset-guard-tok', configPath: tmpCfgPath, pluginsPath: tmpPluginsPath, configOverride: { activeProfileId: '' } });
    const baseUrl = await listenServer(relay);
    const headers = { 'Content-Type': 'application/json', 'X-RisuStand-Token': 'test-rsasset-guard-tok' };
    const rpcLoop = (async () => {
        while (!stopRpc) {
            try {
                const w = await fetch(`${baseUrl}/api/pc/rpc-wait`, { method: 'POST', headers, body: JSON.stringify({ timeoutMs: 1500 }) }).then((r) => r.json());
                if (Array.isArray(w.calls) && w.calls.length) {
                    const results = w.calls.map((c) => {
                        if (c.op === 'db.getDisplayLuaBundle') {
                            return { id: c.id, ok: true, value: { charObj, chatObj: charObj.chats[0], modules: [], globalChatVariables: {} } };
                        }
                        if (c.op === 'db.getCharacter') return { id: c.id, ok: true, value: charObj };
                        if (c.op === 'db.getChat') return { id: c.id, ok: true, value: charObj.chats[0] };
                        if (c.op === 'db.getActiveModules') return { id: c.id, ok: true, value: { modules: [], globalChatVariables: {} } };
                        if (c.op === 'asset.readImage') {
                            const reqPath = c.args && c.args[0];
                            readImageRequests.push(String(reqPath || ''));
                            return { id: c.id, ok: false, error: `failed to open file at path: C:\\assets\\${reqPath} (os error 2)` };
                        }
                        if (c.op === 'db.getPlugins') return { id: c.id, ok: true, value: [] };
                        return { id: c.id, ok: true, value: null };
                    });
                    await fetch(`${baseUrl}/api/pc/rpc-result`, { method: 'POST', headers, body: JSON.stringify({ results }) });
                }
            } catch (_) {
                if (stopRpc) break;
                await new Promise((r) => setTimeout(r, 30));
            }
        }
    })();

    try {
        await fetch(`${baseUrl}/api/pc/poll`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                bridgeVersion: '2.0.0',
                pluginVersion: '1.2.0',
                catalog: { pcActiveCharIndex: 0, pcActiveChatIndex: 0, selectedPersona: 0, params: {}, characters: [{ index: 0, name: 'Hyeyeon', chats: [{ index: 0, name: 'Chat 1' }] }], modules: [], personas: [{ index: 0, name: 'User' }] },
                snapshot: {
                    charIndex: 0,
                    chatIndex: 0,
                    charName: 'Hyeyeon',
                    chatName: 'Chat 1',
                    chatUuid: 'chat-rsasset-1',
                    isPcActive: false,
                    totalMessages: 2,
                    chatModules: [],
                    chatVariables: {},
                    assetMap: { a0: '/api/asset/sample-a0' },
                    messages: [
                        { index: 0, role: 'user', raw: '안녕', html: '안녕', text: '안녕', images: [], chatId: 'rg-m0' },
                        { index: 1, role: 'char', raw: charObj.chats[0].message[1].data, html: '본문 <img src="[[RSASSET:a0]]">', text: '본문', images: [], chatId: 'rg-m1' },
                    ],
                },
            }),
        }).then((r) => assert.equal(r.status, 200));

        let msg1 = null;
        for (let i = 0; i < 25; i += 1) {
            const st = await fetch(`${baseUrl}/api/state`, { headers }).then((r) => r.json());
            const m = st && st.snapshot && Array.isArray(st.snapshot.messages) ? st.snapshot.messages.find((x) => x.index === 1) : null;
            if (m && m.html && m.html.includes('hy-sb')) {
                msg1 = m;
                break;
            }
            await new Promise((r) => setTimeout(r, 40));
        }
        assert.ok(msg1, 'rebuildDisplayedSnapshot must complete and preserve Lua .hy-sb despite [[RSASSET:a0]] and missing asset');
        assert.ok(readImageRequests.every((p) => !/^\[\[RS/i.test(p)), `asset.readImage must never be called with [[RS... placeholder, got: ${JSON.stringify(readImageRequests)}`);
        assert.ok(msg1.html.includes('src="[[RSASSET:a0]]"'), 'img [[RSASSET:a0]] placeholder must remain intact for client resolution');
        assert.ok(msg1.html.includes("url('[[RSASSET:a0]]')"), 'CSS url([[RSASSET:a0]]) placeholder must remain intact for client resolution');
        assert.ok(!msg1.html.includes('{{asset::missing_file}}'), 'unresolvable asset token must resolve cleanly to empty string');
    } finally {
        stopRpc = true;
        if (typeof relay.closeAllConnections === 'function') relay.closeAllConnections();
        await closeServer(relay);
        await rpcLoop;
        try { fs.rmSync(tmpCfgPath, { force: true }); } catch (_) {}
        try { fs.rmSync(tmpPluginsPath, { force: true }); } catch (_) {}
    }
});

test('Hyeyeon start menu Engine.save cbs(getvar) optimistic lock passes on unset hy_state and addChat/removeChat updates snapshot immediately', async () => {
    const tmpCfgPath = path.join(os.tmpdir(), `rs-hy-start-cfg-${Date.now()}.json`);
    const tmpPluginsPath = path.join(os.tmpdir(), `rs-hy-start-plg-${Date.now()}.json`);
    const luaCode = `
local json = require('json')

local function readState(id)
    local raw = getChatVar(id, 'hy_state')
    if raw == nil or raw == '' or raw == 'null' then return nil, raw end
    return json.decode(raw), raw
end

local function saveState(id, state, expected)
    if getChatVar(id, 'hy_state') ~= expected or cbs('{{getvar::hy_state}}') ~= expected then
        return nil
    end
    state.revision = (state.revision or 0) + 1
    local raw = json.encode(state)
    setChatVar(id, 'hy_state', raw)
    return raw
end

onButtonClick = async(function(id, action)
    if action == 'hy_start_1' then
        if getChatLength(id) ~= 0 then
            alertNormal(id, '이미 시작한 채팅이에요.')
            return true
        end
        local state, raw = readState(id)
        if not state then
            state = { revision = 0, events = {} }
            if not saveState(id, state, raw) then
                alertNormal(id, '다른 변경과 겹쳐 저장하지 못했습니다. 다시 눌러 주세요.')
                return true
            end
        end
        setChatVar(id, 'hy_episode', '1')
        addChat(id, 'char', '혜연은 {{user}}를 알아보았다. {{char}}는 고개를 끄덕였다.')
        return true
    elseif action == 'hy_restart' then
        if getChatLength(id) ~= 1 then
            alertNormal(id, '이미 대화를 시작해서 장면을 바꿀 수 없어요.')
            return true
        end
        removeChat(id, 0)
        setChatVar(id, 'hy_episode', '')
        return true
    end
end)

listenEdit('editDisplay', function(id, text, meta)
    local index = tonumber(meta and meta.index) or -1
    if index < 0 and text:find('@HY_START@', 1, true) then
        local html = getChatLength(id) == 0
            and '<button type="button" risu-btn="hy_start_1">EPISODE 01</button>'
            or '<button type="button" risu-btn="hy_restart">다른 장면 고르기</button>'
        return (text:gsub('@HY_START@', html))
    end
    if index < 0 then return text end
    if index == getChatLength(id) - 1 then
        return tostring(text) .. '<div class="hy-sb" data-p="' .. tostring(getPersonaName(id)) .. '">시각 13:06</div>'
    end
    return text
end)
`;
    const charObj = {
        chaId: 'hy-start-test',
        name: 'Hyeyeon',
        firstMessage: '@HY_START@',
        additionalAssets: [],
        triggerscript: [{ comment: 'HyStart', type: 'output', lowLevelAccess: true, effect: [{ type: 'triggerlua', code: luaCode }] }],
        chats: [{
            id: 'chat-hy-start-1',
            name: 'Chat 1',
            scriptstate: {},
            message: [],
        }],
    };
    const bridge = createFakeHostBridge({ charObj, chatObj: charObj.chats[0], modules: [] });
    const relay = createRelayServer({
        token: 'test-hy-start-tok',
        configPath: tmpCfgPath,
        pluginsPath: tmpPluginsPath,
        configOverride: { activeProfileId: '' },
    });
    const baseUrl = await listenServer(relay);
    const headers = { 'Content-Type': 'application/json', 'X-RisuStand-Token': 'test-hy-start-tok' };

    try {
        bridge.startRpcLoop(baseUrl, 'test-hy-start-tok');
        await new Promise((r) => setTimeout(r, 80));
        await fetch(`${baseUrl}/api/pc/poll`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                bridgeVersion: '2.0.0',
                pluginVersion: '1.2.0',
                generating: false,
                catalog: {
                    pcActiveCharIndex: 0,
                    pcActiveChatIndex: 0,
                    selectedPersona: 1,
                    params: {},
                    characters: [{ index: 0, name: 'Hyeyeon', activeChatIndex: 0, chats: [{ index: 0, name: 'Chat 1' }] }],
                    modules: [],
                    personas: [{ index: 0, name: 'User' }, { index: 1, name: '푸딩' }],
                },
                snapshot: {
                    charIndex: 0,
                    chatIndex: 0,
                    charName: 'Hyeyeon',
                    chatName: 'Chat 1',
                    chatUuid: 'chat-hy-start-1',
                    isPcActive: false,
                    totalMessages: 0,
                    chatModules: [],
                    chatVariables: {},
                    assetMap: {},
                    messages: [
                        { index: -1, isFirstMessage: true, role: 'char', raw: '@HY_START@', html: '@HY_START@', text: '', images: [], chatId: 'first-0' },
                    ],
                },
            }),
        }).then((r) => assert.equal(r.status, 200));

        // 1. Click hy_start_1 -> Engine.save optimistic lock must succeed and addChat + {{user}}/{{char}} must reflect immediately
        const startRes = await fetch(`${baseUrl}/api/modules/interaction`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, kind: 'button', code: 'hy_start_1' }),
        }).then((r) => r.json());
        assert.equal(startRes.ok, true);
        assert.equal(startRes.handled, true);
        assert.equal(startRes.triggerEvent, null, 'Engine.save must not emit conflict alert on unset hy_state');
        assert.equal(charObj.chats[0].message.length, 1);
        assert.equal(charObj.chats[0].message[0].data, '혜연은 {{user}}를 알아보았다. {{char}}는 고개를 끄덕였다.');
        assert.equal(charObj.chats[0].scriptstate.$hy_episode, '1');
        assert.ok(charObj.chats[0].scriptstate.$hy_state && charObj.chats[0].scriptstate.$hy_state.includes('"revision":1'));

        const firstAfterStart = startRes.snapshot.messages.find((m) => m.index === -1);
        const msg0AfterStart = startRes.snapshot.messages.find((m) => m.index === 0);
        assert.ok(firstAfterStart && firstAfterStart.html.includes('risu-btn="hy_restart"'), 'firstMessage must switch to hy_restart');
        assert.ok(msg0AfterStart && msg0AfterStart.html.includes('혜연은 푸딩를 알아보았다.') && msg0AfterStart.html.includes('Hyeyeon는 고개를 끄덕였다.') && msg0AfterStart.html.includes('hy-sb'), 'new episode message must expand {{user}}/{{char}} and keep .hy-sb');
        assert.ok(!msg0AfterStart.html.includes('{{user}}') && !msg0AfterStart.html.includes('{{char}}'));
        assert.ok(msg0AfterStart.html.includes('data-p="푸딩"'), 'Lua getPersonaName() must resolve active persona name 푸딩');

        // 2. Click hy_restart -> removeChat(id, 0) must clear message 0 and show start cards again
        const restartRes = await fetch(`${baseUrl}/api/modules/interaction`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, kind: 'button', code: 'hy_restart' }),
        }).then((r) => r.json());
        assert.equal(restartRes.ok, true);
        assert.equal(restartRes.handled, true);
        assert.equal(restartRes.triggerEvent, null);
        assert.equal(charObj.chats[0].message.length, 0);
        const firstAfterRestart = restartRes.snapshot.messages.find((m) => m.index === -1);
        assert.ok(firstAfterRestart && firstAfterRestart.html.includes('risu-btn="hy_start_1"'), 'firstMessage must revert to hy_start_1 after restart');
    } finally {
        await bridge.stop();
        if (typeof relay.closeAllConnections === 'function') relay.closeAllConnections();
        await closeServer(relay);
        try { fs.rmSync(tmpCfgPath, { force: true }); } catch (_) {}
        try { fs.rmSync(tmpPluginsPath, { force: true }); } catch (_) {}
    }
});

test('Relay evalPresetCbs and rebuildDisplayedSnapshot evaluate {{source::user}}, nested asset CBS, string/array/var CBS, and plugin footer CBS', async () => {
    const tmpCfgPath = path.join(os.tmpdir(), `rs-cbs-parity-cfg-${Date.now()}.json`);
    const tmpPluginsPath = path.join(os.tmpdir(), `rs-cbs-parity-plg-${Date.now()}.json`);
    const relay = createRelayServer({
        token: 'test-cbs-parity-tok',
        configPath: tmpCfgPath,
        pluginsPath: tmpPluginsPath,
        configOverride: { activeProfileId: '' },
    });
    const baseUrl = await listenServer(relay);
    const headers = { 'Content-Type': 'application/json', 'X-RisuStand-Token': 'test-cbs-parity-tok' };

    try {
        // Direct evalPresetCbs parity checks
        const cbsCtx = {
            charName: '혜연',
            personaName: '푸딩',
            userIconUrl: '/api/asset/user-avatar-1',
            charImageUrl: '/api/asset/char-avatar-1',
            charAssetNames: ['hy_pick_01', 'hy_portrait'],
            emotionNames: ['happy'],
            chatVars: { mood: 'happy', hp: '10' },
            globalVars: { toggle_hud: '1' },
            chatList: [{ role: 'user', content: '안녕' }, { role: 'assistant', content: '반가워' }],
        };
        assert.equal(
            evalPresetCbs(
                '{{source::user}}|{{source::char}}|{{asset::{{getvar::mood}}}}|{{var::hp}}|{{toggle::hud}}|{{subvar::hp::3}}{{getvar::hp}}|{{mulvar::hp::2}}{{getvar::hp}}|{{divvar::hp::7}}{{getvar::hp}}|{{capitalize::hello}}|{{reverse::abc}}|{{spread::{{range::1::4}}}}|{{object_keys::{{makedict::k1=v1::k2=v2}}}}|{{message_count}}|{{button::열기::act_open}}|{{#pure_display}}{{user}}{{/pure_display}}',
                cbsCtx
            ),
            '/api/asset/user-avatar-1|/api/asset/char-avatar-1|{{asset::happy}}|10|1|7|14|2|Hello|cba|1::2::3|["k1","k2"]|2|<button type="button" class="risu-cbs-btn" risu-trigger="act_open">열기</button>|푸딩'
        );

        // Plugin footer + display message CBS evaluation via rebuildDisplayedSnapshot
        const footerPlugin = `
        //@name CbsFooterSim
        //@api 3.0
        (async () => {
            const doc = await risuai.getRootDocument();
            const reconcile = async () => {
                const rows = await doc.querySelectorAll('.risu-chat');
                for (const row of rows) {
                    if ((await row.getAttribute('data-role')) !== 'char') continue;
                    const ct = await row.querySelector('.chattext');
                    if (!ct) continue;
                    const ex = await ct.querySelector('.x-risu-am-illustration-footer');
                    if (!ex) {
                        const f = await doc.createElement('div');
                        await f.setAttribute('class', 'x-risu-am-illustration-footer');
                        await f.setInnerHTML('<img src="{{source::user}}" alt="{{user}}">');
                        await ct.appendChild(f);
                    }
                }
            };
            const body = await doc.querySelector('body');
            const obs = await risuai.createMutationObserver(() => { void reconcile(); });
            await obs.observe(body, { childList: true, subtree: true });
            await reconcile();
        })();
        `;
        await fetch(`${baseUrl}/api/plugins/upload`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ filename: 'CbsFooterSim.js', script: footerPlugin, enabled: true }),
        }).then((r) => assert.equal(r.status, 200));

        await fetch(`${baseUrl}/api/pc/poll`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                bridgeVersion: '2.0.0',
                pluginVersion: '1.2.0',
                catalog: {
                    pcActiveCharIndex: 0,
                    pcActiveChatIndex: 0,
                    selectedPersona: 1,
                    params: {},
                    characters: [{ index: 0, name: '혜연', chats: [{ index: 0, name: 'Chat 1' }] }],
                    modules: [],
                    personas: [{ index: 0, name: 'User' }, { index: 1, name: '푸딩' }],
                },
                snapshot: {
                    charIndex: 0,
                    chatIndex: 0,
                    charName: '혜연',
                    chatName: 'Chat 1',
                    chatUuid: 'chat-cbs-parity-1',
                    isPcActive: false,
                    totalMessages: 1,
                    chatModules: [],
                    chatVariables: { mood: 'happy' },
                    globalToggleValues: { toggle_hud: '1' },
                    assetMap: { happy: '/api/asset/mood-happy' },
                    charContext: {
                        name: '혜연',
                        personaName: '푸딩',
                        personaIcon: 'assets/user_icon.png',
                        charImage: 'assets/char_icon.png',
                    },
                    messages: [
                        { index: 0, role: 'char', chatId: 'cp-m0', raw: '테스트', html: '<div><img src="{{source::user}}"><span>{{var::mood}}|{{toggle::hud}}|{{asset::{{getvar::mood}}}}</span></div>', text: '테스트', images: [] },
                    ],
                },
            }),
        }).then((r) => assert.equal(r.status, 200));

        let m0 = null;
        for (let i = 0; i < 20; i += 1) {
            const st = await fetch(`${baseUrl}/api/state`, { headers }).then((r) => r.json());
            const m = st && st.snapshot && Array.isArray(st.snapshot.messages) ? st.snapshot.messages[0] : null;
            if (m && m.pluginFooterHtml) {
                m0 = m;
                break;
            }
            await new Promise((r) => setTimeout(r, 40));
        }
        assert.ok(m0);
        assert.match(m0.html, /<img src="\/api\/asset\/[a-f0-9-]+">/, '{{source::user}} must resolve to /api/asset/... ref');
        assert.ok(m0.html.includes('happy|1|<img class="msg-img" src="/api/asset/mood-happy" />'), `nested {{asset::{{getvar::mood}}}} and {{var}}/{{toggle}} must resolve, got: ${m0.html}`);
        assert.match(m0.pluginFooterHtml || '', /<img src="\/api\/asset\/[a-f0-9-]+" alt="푸딩">/, 'plugin footer must also resolve {{source::user}} and {{user}}');
    } finally {
        if (typeof relay.closeAllConnections === 'function') relay.closeAllConnections();
        await closeServer(relay);
        try { fs.rmSync(tmpCfgPath, { force: true }); } catch (_) {}
        try { fs.rmSync(tmpPluginsPath, { force: true }); } catch (_) {}
    }
});

test('Live SSE generation telemetry streams provider, model, output tokens, tok/s and UI renders non-clipping liveGenBar & hdrActPopover', async () => {
    const tmpCfgPath = path.join(os.tmpdir(), `rs-live-gen-cfg-${Date.now()}.json`);
    const tmpPluginsPath = path.join(os.tmpdir(), `rs-live-gen-plg-${Date.now()}.json`);
    const mockLLM = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.equal(body.stream, true, 'executeDirectModelTurn must request streaming progress when streamProgress is enabled');
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.write(`data: ${JSON.stringify({ model: 'anthropic/claude-sonnet-4', choices: [{ index: 0, delta: { content: '안' } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 40));
        res.write(`data: ${JSON.stringify({ model: 'anthropic/claude-sonnet-4', choices: [{ index: 0, delta: { content: '녕하세요 혜연입니다.' } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 40));
        res.write(`data: ${JSON.stringify({ model: 'anthropic/claude-sonnet-4', choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 120, completion_tokens: 42 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    });
    const llmUrl = await listenServer(mockLLM);

    const token = 'test-live-gen-tok';
    const relay = createRelayServer({
        token,
        configPath: tmpCfgPath,
        pluginsPath: tmpPluginsPath,
        configOverride: {
            activeProfileId: 'p-or',
            directPresetId: 'off',
            remoteDirectOnly: true,
            profiles: [{
                id: 'p-or',
                name: 'OR Main',
                providerType: 'openai_compat',
                baseUrl: `${llmUrl}/openrouter.ai/api/v1/chat/completions`,
                apiKey: 'k',
                model: 'anthropic/claude-sonnet-4',
            }],
        },
    });
    const baseUrl = await listenServer(relay);
    const headers = { 'Content-Type': 'application/json', 'X-RisuStand-Token': token };

    const sseCtrl = new AbortController();
    const ssePayloads = [];
    const ssePromise = (async () => {
        const resp = await fetch(`${baseUrl}/api/activity/stream`, { headers: { 'X-RisuStand-Token': token }, signal: sseCtrl.signal });
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (line.startsWith('data:')) ssePayloads.push(JSON.parse(line.slice(5).trim()));
                }
            }
        } catch (_) {}
    })();

    try {
        await fetch(`${baseUrl}/api/pc/poll`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                bridgeVersion: '2.0.0',
                pluginVersion: '1.2.0',
                catalog: { pcActiveCharIndex: 0, pcActiveChatIndex: 0, selectedPersona: 0, params: {}, characters: [{ index: 0, name: 'Hyeyeon', chats: [{ index: 0, name: 'Chat 1' }] }], modules: [], personas: [{ index: 0, name: 'User' }] },
                snapshot: { charIndex: 0, chatIndex: 0, charName: 'Hyeyeon', chatName: 'Chat 1', chatUuid: 'c-lg-1', isPcActive: false, totalMessages: 0, chatModules: [], chatVariables: {}, assetMap: {}, messages: [] },
            }),
        }).then((r) => assert.equal(r.status, 200));

        await fetch(`${baseUrl}/api/chat/send`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, text: '안녕' }),
        }).then((r) => assert.equal(r.status, 200));

        for (let i = 0; i < 50; i += 1) {
            if (ssePayloads.some((p) => p.generation && !p.generation.active && p.generation.status === 'done')) break;
            await new Promise((r) => setTimeout(r, 30));
        }
        const genStarted = ssePayloads.find((p) => p.generation && p.generation.active && p.generation.status === 'generating');
        const genDone = [...ssePayloads].reverse().find((p) => p.generation && !p.generation.active && p.generation.status === 'done');
        assert.ok(genStarted, 'SSE /api/activity/stream must emit active generation telemetry');
        assert.ok(genDone, 'SSE /api/activity/stream must emit completed generation telemetry');
        assert.equal(genDone.generation.provider, 'OR Main');
        assert.equal(genDone.generation.model, 'anthropic/claude-sonnet-4');
        assert.equal(genDone.generation.outputTokens, 42);
        assert.equal(genDone.generation.tokenEstimated, false);
        assert.ok(genDone.generation.tokPerSec > 0, 'tokPerSec must be computed > 0');

        const stateRes = await fetch(`${baseUrl}/api/state`, { headers }).then((r) => r.json());
        assert.ok(stateRes.liveGeneration && stateRes.liveGeneration.model === 'anthropic/claude-sonnet-4', '/api/state must expose liveGeneration');

        const uiHtml = await fetch(`${baseUrl}/`).then((r) => r.text());
        assert.ok(uiHtml.includes('id="liveGenBar"'));
        assert.ok(uiHtml.includes('id="hdrActPopover"'));
        assert.ok(uiHtml.includes('hdr-act-stage'));
        assert.ok(uiHtml.includes("fmtStageShort"));
        const scriptMatch = uiHtml.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
        assert.ok(scriptMatch && scriptMatch[1]);
        assert.doesNotThrow(() => new Function(scriptMatch[1]));
    } finally {
        sseCtrl.abort();
        await ssePromise;
        if (typeof relay.closeAllConnections === 'function') relay.closeAllConnections();
        await closeServer(relay);
        await closeServer(mockLLM);
        try { fs.rmSync(tmpCfgPath, { force: true }); } catch (_) {}
        try { fs.rmSync(tmpPluginsPath, { force: true }); } catch (_) {}
    }
});

test('Scene control drawer thumbnails open enlarged lightbox with X close button', async () => {
    const tmpCfgPath = path.join(os.tmpdir(), `rs-scene-lb-cfg-${Date.now()}.json`);
    const tmpPluginsPath = path.join(os.tmpdir(), `rs-scene-lb-plug-${Date.now()}.json`);
    const relay = createRelayServer({
        token: 'tok-scene-lb',
        pluginsPath: tmpPluginsPath,
        configPath: tmpCfgPath,
    });
    const baseUrl = await listenServer(relay);
    try {
        const uiHtml = await fetch(`${baseUrl}/`).then((r) => r.text());
        assert.ok(uiHtml.includes('.chat-img-lightbox-close'), 'Lightbox must style X close button');
        assert.ok(uiHtml.includes('data-lb-close="1"'), 'Lightbox must render data-lb-close="1" button');
        assert.ok(uiHtml.includes('>✕</button>'), 'Lightbox close button must show ✕');
        assert.ok(uiHtml.includes('z-index:190'), 'Lightbox z-index must stack above #sceneCtrlModal (168)');
        assert.ok(
            uiHtml.includes("openChatImgLightbox(src, { items, index: idx >= 0 ? idx : 0 })"),
            'Scene control drawer thumbnail click must open enlarged lightbox'
        );
        const scriptMatch = uiHtml.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
        assert.ok(scriptMatch && scriptMatch[1]);
        assert.doesNotThrow(() => new Function(scriptMatch[1]));
    } finally {
        if (typeof relay.closeAllConnections === 'function') relay.closeAllConnections();
        await closeServer(relay);
        try { fs.rmSync(tmpCfgPath, { force: true }); } catch (_) {}
        try { fs.rmSync(tmpPluginsPath, { force: true }); } catch (_) {}
    }
});

test('diffPluginPromptInjection & /api/plugins/runtime-recall attribute recalled memories per plugin and serve GUI recall viewer', async () => {
    const { diffPluginPromptInjection } = require('../risustand-plugin-adapter.cjs');

    // 1. Unit tests for diffPluginPromptInjection
    const baseMsgs = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: '오늘 일정이 뭐지?' },
    ];
    const unchanged = diffPluginPromptInjection(baseMsgs, [...baseMsgs]);
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.injectedCount, 0);
    assert.equal(unchanged.totalInjectedChars, 0);

    const addedMsgs = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'system', content: '[HAYAKU PACKET]\nTurn 72: 5층 복도 라운지' },
        { role: 'user', content: '오늘 일정이 뭐지?' },
    ];
    const addedDiff = diffPluginPromptInjection(baseMsgs, addedMsgs);
    assert.equal(addedDiff.changed, true);
    assert.equal(addedDiff.injectedCount, 1);
    assert.equal(addedDiff.injectedBlocks[0].kind, 'added');
    assert.equal(addedDiff.injectedBlocks[0].role, 'system');
    assert.ok(addedDiff.injectedBlocks[0].text.includes('[HAYAKU PACKET]'));

    const modMsgs = [
        ...addedMsgs.slice(0, 2),
        { role: 'user', content: '[FLASHBACK RECALL]\n지난주 동아리 회식 약속\n\n오늘 일정이 뭐지?' },
    ];
    const modDiff = diffPluginPromptInjection(addedMsgs, modMsgs);
    assert.equal(modDiff.changed, true);
    assert.equal(modDiff.injectedCount, 1);
    assert.equal(modDiff.injectedBlocks[0].kind, 'modified');
    assert.equal(modDiff.injectedBlocks[0].role, 'user');
    assert.ok(modDiff.injectedBlocks[0].text.includes('[FLASHBACK RECALL]'));
    assert.ok(!modDiff.injectedBlocks[0].text.includes('오늘 일정이 뭐지?'));

    // Stripped historical turns (pure removals / whitespace cleanups) must NOT pollute injectedBlocks
    const histBefore = [
        { role: 'system', content: 'System Core' },
        ...Array.from({ length: 12 }, (_, idx) => ({ role: 'assistant', content: `Turn ${idx} text <hayaku_packet>old ${idx}</hayaku_packet>` })),
        { role: 'user', content: '지금 뭐 해?' },
    ];
    const histAfter = [
        { role: 'system', content: 'System Core' },
        { role: 'system', content: '[HAYAKU MEMORY]\n실제 주입된 회상 기억 블록' },
        ...Array.from({ length: 12 }, (_, idx) => ({ role: 'assistant', content: `Turn ${idx} text ` })),
        { role: 'user', content: '[CHAR STATUS]\n상태 블록\n지금 뭐 해?' },
    ];
    const strippedNoiseDiff = diffPluginPromptInjection(histBefore, histAfter);
    assert.equal(strippedNoiseDiff.injectedCount, 2);
    assert.equal(strippedNoiseDiff.strippedCount, 12);
    assert.ok(strippedNoiseDiff.totalRemovedChars > 0);
    assert.ok(strippedNoiseDiff.injectedBlocks.every((b) => b.addedChars > 0 && b.text.trim().length > 0));
    assert.ok(strippedNoiseDiff.injectedBlocks[0].text.includes('[HAYAKU MEMORY]'));
    assert.ok(strippedNoiseDiff.injectedBlocks[1].text.includes('[CHAR STATUS]'));

    // 2. End-to-end relay integration with 2 plugins + mock LLM
    const mockLLM = http.createServer(async (req, res) => {
        let raw = '';
        for await (const c of req) raw += c;
        const body = JSON.parse(raw || '{}');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            id: 'chatcmpl-recall-1',
            choices: [{ index: 0, message: { role: 'assistant', content: '라벨이 붙은 기억을 반영해 응답합니다.' }, finish_reason: 'stop' }],
            usage: { completion_tokens: 18 },
            echoMsgCount: Array.isArray(body.messages) ? body.messages.length : 0,
        }));
    });
    const llmUrl = await listenServer(mockLLM);

    const chatUuid = 'chat-recall-uuid-1';
    const charObj = {
        chaId: 'char-recall-1',
        name: '혜연',
        desc: '선배 캐릭터',
        personality: '',
        scenario: '',
        systemPrompt: '',
        replaceGlobalNote: '',
        lowLevelAccess: false,
        triggerscript: [],
        customscript: [],
        globalLore: [],
        chatPage: 0,
        chats: [],
    };
    const chatObj = {
        id: chatUuid,
        name: 'Chat 1',
        note: '',
        localLore: [],
        modules: [],
        message: [],
    };
    const bridge = createFakeHostBridge({ charObj, chatObj });
    const tmpCfgPath = path.join(os.tmpdir(), `rs-recall-cfg-${Date.now()}.json`);
    const tmpPluginsPath = path.join(os.tmpdir(), `rs-recall-plug-${Date.now()}.json`);
    const token = 'tok-runtime-recall';
    const relay = createRelayServer({
        token,
        pluginsPath: tmpPluginsPath,
        configPath: tmpCfgPath,
        configOverride: {
            profiles: [{
                id: 'prof-recall',
                name: 'Mock Recall LLM',
                provider: 'custom',
                providerType: 'openai_compat',
                baseUrl: `${llmUrl}/v1/chat/completions`,
                apiKey: 'k-test',
                model: 'mock-recall-model',
            }],
            activeProfileId: 'prof-recall',
            directPresetId: 'off',
            remoteDirectOnly: true,
        },
    });
    const baseUrl = await listenServer(relay);
    const headers = { 'Content-Type': 'application/json', 'X-RisuStand-Token': token };
    bridge.startRpcLoop(baseUrl, token);

    const hayakuMockScript = [
        '//@name hayaku_mock',
        '//@display-name HAYAKU Mock',
        '//@api 3.0',
        'risuai.addRisuReplacer("beforeRequest", async (msgs) => {',
        '  const out = msgs.map((m) => ({ ...m }));',
        '  out.splice(Math.max(0, out.length - 1), 0, { role: "system", content: "[HAYAKU_MEMORY_PACKET]\\nTurn 71: 우산 정류장 재회" });',
        '  return out;',
        '});',
        'risuai.addRisuReplacer("afterRequest", async (txt) => txt);',
        'risuai.addRisuChatListener("output", async () => {});',
    ].join('\n');

    const flashbackMockScript = [
        '//@name flashback_mock',
        '//@display-name FLASHBACK Mock',
        '//@api 3.0',
        'risuai.addRisuReplacer("beforeRequest", async (msgs) => {',
        '  const out = msgs.map((m) => ({ ...m }));',
        '  const last = out[out.length - 1];',
        '  if (last && last.role === "user") {',
        '    last.content = "[FLASHBACK_RECALLED]\\n2년 전 스터디 모임 일지\\n\\n" + last.content;',
        '  }',
        '  return out;',
        '});',
        'risuai.addRisuReplacer("afterRequest", async (txt) => txt);',
        'risuai.addRisuChatListener("output", async () => {});',
    ].join('\n');

    try {
        await fetch(`${baseUrl}/api/plugins/upload`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ filename: 'hayaku_mock.js', script: hayakuMockScript, enabled: true }),
        }).then((r) => assert.equal(r.status, 200));

        await fetch(`${baseUrl}/api/plugins/upload`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ filename: 'flashback_mock.js', script: flashbackMockScript, enabled: true }),
        }).then((r) => assert.equal(r.status, 200));

        await fetch(`${baseUrl}/api/pc/poll`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                bridgeVersion: '2.0.0',
                pluginVersion: '1.2.0',
                catalog: {
                    pcActiveCharIndex: 0,
                    pcActiveChatIndex: 0,
                    selectedPersona: 0,
                    params: {},
                    characters: [{ index: 0, name: '혜연', chats: [{ index: 0, name: 'Chat 1' }] }],
                    modules: [],
                    personas: [{ index: 0, name: '푸딩' }],
                },
                snapshot: {
                    charIndex: 0,
                    chatIndex: 0,
                    charName: '혜연',
                    chatName: 'Chat 1',
                    chatUuid,
                    isPcActive: false,
                    totalMessages: 0,
                    chatModules: [],
                    chatVariables: {},
                    assetMap: {},
                    messages: [],
                },
            }),
        }).then((r) => assert.equal(r.status, 200));

        await fetch(`${baseUrl}/api/chat/send`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, text: '우산 정류장에서 뭐 해?' }),
        }).then((r) => assert.equal(r.status, 200));

        for (let i = 0; i < 60; i += 1) {
            if (bridge.dbState.chat.message.length >= 2) break;
            await new Promise((r) => setTimeout(r, 30));
        }
        assert.ok(bridge.dbState.chat.message.length >= 2, 'Assistant reply must be committed');
        await new Promise((r) => setTimeout(r, 100));

        const hayakuRes = await fetch(
            `${baseUrl}/api/plugins/runtime-recall?name=hayaku_mock&chatUuid=${encodeURIComponent(chatUuid)}`,
            { headers }
        ).then((r) => r.json());
        assert.equal(hayakuRes.ok, true);
        assert.ok(hayakuRes.recall.beforeRequestRuns >= 1);
        assert.ok(hayakuRes.recall.afterRequestRuns >= 1);
        assert.ok(hayakuRes.recall.outputRuns >= 1);
        assert.equal(hayakuRes.recall.history.length, 1);
        assert.equal(hayakuRes.recall.history[0].matchesCurrentChat, true);
        assert.ok(hayakuRes.recall.history[0].userPreview.includes('우산 정류장에서 뭐 해?'));
        assert.equal(hayakuRes.recall.history[0].injectedBlocks.length, 1);
        assert.equal(hayakuRes.recall.history[0].injectedBlocks[0].kind, 'added');
        assert.ok(hayakuRes.recall.history[0].injectedBlocks[0].text.includes('[HAYAKU_MEMORY_PACKET]'));
        assert.ok(!hayakuRes.recall.history[0].injectedBlocks[0].text.includes('[FLASHBACK_RECALLED]'));

        const fbRes = await fetch(
            `${baseUrl}/api/plugins/runtime-recall?name=flashback_mock&chatUuid=${encodeURIComponent(chatUuid)}`,
            { headers }
        ).then((r) => r.json());
        assert.equal(fbRes.ok, true);
        assert.ok(fbRes.recall.beforeRequestRuns >= 1);
        assert.equal(fbRes.recall.history[0].injectedBlocks.length, 1);
        assert.equal(fbRes.recall.history[0].injectedBlocks[0].kind, 'modified');
        assert.ok(fbRes.recall.history[0].injectedBlocks[0].text.includes('[FLASHBACK_RECALLED]'));
        assert.ok(!fbRes.recall.history[0].injectedBlocks[0].text.includes('[HAYAKU_MEMORY_PACKET]'));
        assert.ok(!fbRes.recall.history[0].injectedBlocks[0].text.includes('우산 정류장에서 뭐 해?'));

        const allRes = await fetch(`${baseUrl}/api/plugins/runtime-recall?chatUuid=${encodeURIComponent(chatUuid)}`, { headers }).then((r) => r.json());
        assert.equal(allRes.ok, true);
        assert.ok(Array.isArray(allRes.plugins) && allRes.plugins.length >= 2);
        assert.ok(allRes.plugins.some((p) => p.pluginName === 'hayaku_mock' && p.latestInjectedCount === 1 && p.matchesCurrentChat));

        const uiHtml = await fetch(`${baseUrl}/`).then((r) => r.text());
        assert.ok(uiHtml.includes('id="pluginGuiRecallPane"'));
        assert.ok(uiHtml.includes('data-plg-gui-recall-toggle="1"'));
        assert.ok(uiHtml.includes('/api/plugins/runtime-recall'));
        assert.ok(/\.plg-gui-recall-pane\s*>\s*\*\s*\{[^}]*flex-shrink:\s*0/i.test(uiHtml), 'recall pane children must not flex-shrink collapse');
        assert.ok(/\.plg-recall-block\s*\{[^}]*flex-shrink:\s*0/i.test(uiHtml), 'recall block cards must not flex-shrink collapse');
        assert.ok(uiHtml.includes('data-plg-recall-toggle-block'));
        assert.ok(uiHtml.includes('pickPreferredRecallIdx'));
        assert.ok(uiHtml.includes('getRecallItemChars'));
        const scriptMatch = uiHtml.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
        assert.ok(scriptMatch && scriptMatch[1]);
        assert.doesNotThrow(() => new Function(scriptMatch[1]));
    } finally {
        await bridge.stop();
        if (typeof relay.closeAllConnections === 'function') relay.closeAllConnections();
        await closeServer(relay);
        await closeServer(mockLLM);
        try { fs.rmSync(tmpCfgPath, { force: true }); } catch (_) {}
        try { fs.rmSync(tmpPluginsPath, { force: true }); } catch (_) {}
    }
});

test('Leave preset templateDefaultVariables are exposed in /api/router/config and synced on modules tab', async () => {
    const tmpCfgPath = path.join(os.tmpdir(), `rs-leave-def-cfg-${Date.now()}.json`);
    const tmpPluginsPath = path.join(os.tmpdir(), `rs-leave-def-plug-${Date.now()}.json`);
    const token = 'tok-leave-defs';
    const relay = createRelayServer({
        token,
        pluginsPath: tmpPluginsPath,
        configPath: tmpCfgPath,
        configOverride: {
            directPresetId: 'bundled:leave',
            remoteToggleValues: {},
        },
    });
    const baseUrl = await listenServer(relay);
    try {
        const cfg = await fetch(`${baseUrl}/api/router/config`, {
            headers: { 'X-RisuStand-Token': token },
        }).then((r) => r.json());
        assert.ok(cfg && cfg.presetDefaultToggleValues && typeof cfg.presetDefaultToggleValues === 'object');
        assert.equal(cfg.presetDefaultToggleValues.toggle_aide_core_continuity, '1');
        assert.equal(cfg.presetDefaultToggleValues.toggle_aide_prose_polish, '1');
        assert.equal(cfg.presetDefaultToggleValues.toggle_pipeline_mode, '1');
        assert.equal(cfg.presetDefaultToggleValues.toggle_next_turn_seed, '1');
        assert.equal(cfg.presetDefaultToggleValues.toggle_sub_knowledge_boundary, '1');
        assert.equal(cfg.presetDefaultToggleValues.toggle_ooc_mode, '0');

        const uiHtml = await fetch(`${baseUrl}/`).then((r) => r.text());
        assert.ok(uiHtml.includes('presetDefaultToggleValues'));
        assert.ok(uiHtml.includes('function mergeNonEmptyToggles'));
        assert.ok(uiHtml.includes("if (typeof renderCustomToggles === 'function') renderCustomToggles(true);"));
        assert.ok(uiHtml.includes("if (tab === 'modules') {") && uiHtml.includes('loadRouterConfig()'));
        const scriptMatch = uiHtml.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
        assert.ok(scriptMatch && scriptMatch[1]);
        assert.doesNotThrow(() => new Function(scriptMatch[1]));
    } finally {
        if (typeof relay.closeAllConnections === 'function') relay.closeAllConnections();
        await closeServer(relay);
        try { fs.rmSync(tmpCfgPath, { force: true }); } catch (_) {}
        try { fs.rmSync(tmpPluginsPath, { force: true }); } catch (_) {}
    }
});

test('Translator supports saved profile selection, per-profile model override, standalone custom model, and cache isolation', async () => {
    const trCalls = [];
    const mockLLM = http.createServer(async (req, res) => {
        let raw = '';
        for await (const c of req) raw += c;
        const body = JSON.parse(raw || '{}');
        const auth = String(req.headers.authorization || '');
        trCalls.push({ model: body.model, auth });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            id: `cmpl-tr-${trCalls.length}`,
            choices: [{ index: 0, message: { role: 'assistant', content: `TRANSLATED[${body.model}|${auth}]` }, finish_reason: 'stop' }],
            usage: { completion_tokens: 8 },
        }));
    });
    const llmUrl = await listenServer(mockLLM);

    const tmpCfgPath = path.join(os.tmpdir(), `rs-tr-model-cfg-${Date.now()}.json`);
    const tmpPluginsPath = path.join(os.tmpdir(), `rs-tr-model-plug-${Date.now()}.json`);
    const token = 'tok-tr-models';
    const relay = createRelayServer({
        token,
        pluginsPath: tmpPluginsPath,
        configPath: tmpCfgPath,
        configOverride: {
            activeProfileId: 'prof-main',
            profiles: [
                {
                    id: 'prof-main',
                    name: 'Main Profile',
                    provider: 'custom',
                    providerType: 'openai_compat',
                    baseUrl: `${llmUrl}/v1/chat/completions`,
                    apiKey: 'key-main',
                    model: 'main-model',
                },
                {
                    id: 'prof-tr',
                    name: 'Saved Translator Profile',
                    provider: 'custom',
                    providerType: 'openai_compat',
                    baseUrl: `${llmUrl}/v1/chat/completions`,
                    apiKey: 'key-tr',
                    model: 'saved-tr-model',
                },
            ],
            translator: {
                useActiveProfile: true,
                profileId: 'active',
                profileModelOverride: '',
            },
        },
    });
    const baseUrl = await listenServer(relay);
    const headers = { 'Content-Type': 'application/json', 'X-RisuStand-Token': token };

    try {
        // 1) Secondary saved profile selection
        await fetch(`${baseUrl}/api/router/config`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                translator: { useActiveProfile: false, profileId: 'prof-tr', profileModelOverride: '' },
            }),
        }).then((r) => assert.equal(r.status, 200));
        const r1 = await fetch(`${baseUrl}/api/translate`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ text: 'Hello world', direction: 'to_target' }),
        }).then((r) => r.json());
        assert.equal(r1.ok, true);
        assert.equal(r1.translated, 'TRANSLATED[saved-tr-model|Bearer key-tr]');

        // 2) Active profile with separate model override + same input text must bypass old model cache
        await fetch(`${baseUrl}/api/router/config`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                translator: { useActiveProfile: true, profileId: 'active', profileModelOverride: 'fast-override-model' },
            }),
        }).then((r) => assert.equal(r.status, 200));
        const r2 = await fetch(`${baseUrl}/api/translate`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ text: 'Hello world', direction: 'to_target' }),
        }).then((r) => r.json());
        assert.equal(r2.ok, true);
        assert.equal(r2.translated, 'TRANSLATED[fast-override-model|Bearer key-main]');

        // 3) Standalone custom translator configuration
        await fetch(`${baseUrl}/api/router/config`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                translator: {
                    useActiveProfile: false,
                    profileId: 'custom',
                    profileModelOverride: '',
                    providerType: 'openai_compat',
                    baseUrl: `${llmUrl}/v1/chat/completions`,
                    apiKey: 'key-custom',
                    model: 'custom-tr-model',
                },
            }),
        }).then((r) => assert.equal(r.status, 200));
        const r3 = await fetch(`${baseUrl}/api/translate`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ text: 'Hello world', direction: 'to_target' }),
        }).then((r) => r.json());
        assert.equal(r3.ok, true);
        assert.equal(r3.translated, 'TRANSLATED[custom-tr-model|Bearer key-custom]');

        // 4) UI markup & embedded JS compilation
        const uiHtml = await fetch(`${baseUrl}/`).then((r) => r.text());
        assert.ok(uiHtml.includes('id="trProfileSel"'));
        assert.ok(uiHtml.includes('id="trProfileModelOverride"'));
        assert.ok(uiHtml.includes('id="trProfLoadModelsBtn"'));
        assert.ok(uiHtml.includes('id="trCustomBox"'));
        assert.ok(!uiHtml.includes('trUseActive'));
        const scriptMatch = uiHtml.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
        assert.ok(scriptMatch && scriptMatch[1]);
        assert.doesNotThrow(() => new Function(scriptMatch[1]));
    } finally {
        if (typeof relay.closeAllConnections === 'function') relay.closeAllConnections();
        await closeServer(relay);
        await closeServer(mockLLM);
        try { fs.rmSync(tmpCfgPath, { force: true }); } catch (_) {}
        try { fs.rmSync(tmpPluginsPath, { force: true }); } catch (_) {}
    }
});

test('buildDirectPromptMessages strips history <Thoughts>/<thinking> while preserving HUD, and Leave preset/Two-Pass protect living voice & natural physical transitions', () => {
    const relay = require('../risustand-relay-server.js');
    const leave = relay.loadBundledLeavePreset();
    assert.ok(leave && Array.isArray(leave.promptTemplate) && leave.promptTemplate.length === 21);

    const built = relay.buildDirectPromptMessages({
        preset: leave,
        snap: {
            charName: '클로젬 여행동아리',
            useLocallySetGlobalVariables: false,
            globalToggleValues: {},
            localToggleValues: {},
            charContext: {
                name: '클로젬 여행동아리',
                personaName: '푸딩',
                loreEntries: [],
            },
        },
        historyMessages: [
            { role: 'user', raw: '"일단 같이 씻으러 가자."' },
            {
                role: 'char',
                raw: '<Thoughts>\n하연은 차가운 실무 계산기...\n</Thoughts>\n<thinking>internal note</thinking>\n\n"어머~ 이제 와서 같이 씻자고?"\n\n<statusdata>\n📖 Leave HUD · 07:46\n</statusdata>',
            },
        ],
        userText: '욕실로 들어가자 하연과 소연도 들어왔다.',
        remoteToggleValues: {
            toggle_aide_core_continuity: '1',
            toggle_aide_prose_polish: '1',
            toggle_sub_dialogue: '1',
        },
    });

    assert.ok(Array.isArray(built));
    const allSys = built.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    assert.ok(allSys.includes('Living Character Voice (Anti-Robotic Dialogue)'));
    assert.ok(allSys.includes('Restraint applies ONLY to redundant narrator commentary'));
    assert.ok(allSys.includes('show them naturally undressing rather than stepping in clothed'));

    const histAsst = built.find((m) => m.role === 'assistant');
    assert.ok(histAsst, 'Assistant turn must be preserved in history');
    assert.ok(!histAsst.content.includes('<Thoughts>') && !histAsst.content.includes('차가운 실무 계산기'));
    assert.ok(!histAsst.content.includes('<thinking>') && !histAsst.content.includes('internal note'));
    assert.ok(histAsst.content.includes('어머~ 이제 와서 같이 씻자고?'));
    assert.ok(histAsst.content.includes('<statusdata>'));

    const relaySrc = fs.readFileSync(path.join(__dirname, '..', 'risustand-relay-server.js'), 'utf8');
    assert.ok(relaySrc.includes('CHARACTER VOICE FIDELITY'));
    assert.ok(relaySrc.includes('NATURAL PHYSICAL TRANSITIONS'));
    assert.ok(relaySrc.includes("Protect each speaker\\'s living voice"));
});

test('Librarian-Suite cross-plugin IPC: LIBRA/HAYAKU/Flashback <-> GRADIA, multi-listener, 2-arg removal, allowed-ipc, and GUI cursor sync', async () => {
    const { createPluginAdapter, parsePluginHeader } = require('../risustand-plugin-adapter.cjs');

    const libraHeader = parsePluginHeader('//@name libra\n//@api 3.0\n//@allowed-ipc serial_gradation_agents_for_rp, hayaku_locator_continuity');
    assert.deepEqual(libraHeader.allowedIPC, ['serial_gradation_agents_for_rp', 'hayaku_locator_continuity']);

    const tmpPluginsPath = path.join(os.tmpdir(), `rs-ipc-suite-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const backendCfg = { pluginConfigs: {} };
    const adapter = createPluginAdapter({
        pluginsPath: tmpPluginsPath,
        persistDisabled: true,
        getBackendConfig: () => backendCfg,
    });

    try {
        // Install LIBRA, HAYAKU, FLASHBACK, GRADIA, and an unauthorized rogue plugin
        await adapter.addCustomPlugin({ filename: 'LIBRA.js', script: `//@name libra\n//@api 3.0\n//@allowed-ipc serial_gradation_agents_for_rp\n(async()=>{
          const api=window.Risuai||window.risuai;
          const ok=await api.addPluginChannelListener('libra_gradia_unified_read_request_v1', async (msg, meta) => {
            if (meta.sender !== 'serial_gradation_agents_for_rp') return;
            await api.postPluginChannelMessage(meta.sender, 'libra_gradia_unified_read_response_v1', {
              schema: msg.schema, kind: 'response', requestId: msg.requestId, ok: true, result: { source: 'libra', items: ['리브라 정본 기억'] }
            });
          });
          if (ok === false) throw new Error('expected truthy addPluginChannelListener');
          let l1 = 0, l2 = 0;
          const fn1 = async (m, meta) => {
            l1 += 1;
            await api.postPluginChannelMessage(meta.sender, 'multi_res_v1', { who: 'fn1', count: l1, tag: m && m.tag });
          };
          const fn2 = async (m, meta) => {
            l2 += 1;
            await api.postPluginChannelMessage(meta.sender, 'multi_res_v1', { who: 'fn2', count: l2, tag: m && m.tag });
          };
          await api.addPluginChannelListener('memory_suite_source_rules_v1', fn1);
          await api.addPluginChannelListener('memory_suite_source_rules_v1', fn2);
          await api.addPluginChannelListener('multi_ctrl_v1', async (m) => {
            if (m && m.removeFn1) await api.removePluginChannelListener('memory_suite_source_rules_v1', fn1);
          });
          await api.addPluginChannelListener('gui_sync_req_v1', async (msg, meta) => {
            await api.postPluginChannelMessage(meta.sender, 'gui_sync_res_v1', { echo: msg.ping, from: 'libra' });
          });
        })();` });

        await adapter.addCustomPlugin({ filename: 'HAYAKU.js', script: `//@name hayaku_locator_continuity\n//@api 3.0\n//@allowed-ipc serial_gradation_agents_for_rp\n(async()=>{
          const api=window.Risuai||window.risuai;
          await api.addPluginChannelListener('gradia_memory_read_request_v1', async (msg, meta) => {
            if (meta.sender !== 'serial_gradation_agents_for_rp') return;
            await api.postPluginChannelMessage(meta.sender, 'gradia_memory_read_response_v1', {
              schema: msg.schema, kind: 'response', id: msg.id, action: msg.action, result: { owner: 'hayaku', items: ['하야쿠 연속성 패킷'] }
            });
          });
        })();` });

        await adapter.addCustomPlugin({ filename: 'Flashback.js', script: `//@name flashback_memory\n//@api 3.0\n//@allowed-ipc serial_gradation_agents_for_rp\n(async()=>{
          const api=window.Risuai||window.risuai;
          await api.addPluginChannelListener('gradia_memory_read_request_v1', async (msg, meta) => {
            if (meta.sender !== 'serial_gradation_agents_for_rp') return;
            await api.postPluginChannelMessage(meta.sender, 'gradia_memory_read_response_v1', {
              schema: msg.schema, kind: 'response', id: msg.id, action: msg.action, result: { owner: 'flashback', items: ['플래시백 회상 조각'] }
            });
          });
        })();` });

        await adapter.addCustomPlugin({ filename: 'GRADIA.js', script: `//@name serial_gradation_agents_for_rp\n//@api 3.0\n//@allowed-ipc libra\n//@allowed-ipc hayaku_locator_continuity\n//@allowed-ipc flashback_memory\n(async()=>{
          const api=window.Risuai||window.risuai;
          const pending=new Map();
          const rpc=(target, reqCh, resCh, reqObj)=>new Promise(async (resolve, reject)=>{
            const k=reqObj.requestId||reqObj.id;
            const timer=setTimeout(()=>reject(new Error('IPC timeout '+target)), 2000);
            pending.set(k, (payload)=>{ clearTimeout(timer); resolve(payload); });
            await api.postPluginChannelMessage(target, reqCh, reqObj);
          });
          await api.addPluginChannelListener('libra_gradia_unified_read_response_v1', (msg)=>{ const fn=pending.get(msg.requestId); if(fn){ pending.delete(msg.requestId); fn(msg.result); } });
          await api.addPluginChannelListener('gradia_memory_read_response_v1', (msg)=>{ const fn=pending.get(msg.id); if(fn){ pending.delete(msg.id); fn(msg.result); } });
          api.addRisuReplacer('beforeRequest', async (msgs)=>{
            const [libraRes, hayakuRes, fbRes] = await Promise.all([
              rpc('libra', 'libra_gradia_unified_read_request_v1', 'libra_gradia_unified_read_response_v1', { schema:'u', requestId:'r-libra' }),
              rpc('hayaku_locator_continuity', 'gradia_memory_read_request_v1', 'gradia_memory_read_response_v1', { schema:'g', id:'r-hayaku', action:'capture' }),
              rpc('flashback_memory', 'gradia_memory_read_request_v1', 'gradia_memory_read_response_v1', { schema:'g', id:'r-fb', action:'capture' }),
            ]);
            const merged = [...libraRes.items, ...hayakuRes.items, ...fbRes.items].join(' | ');
            return [{ role: 'system', content: '[GRADIA_IPC_COMBINED] ' + merged }, ...msgs];
          });
        })();` });

        await adapter.addCustomPlugin({ filename: 'Rogue.js', script: `//@name rogue_plugin\n//@api 3.0\n// unauthorized\n` });

        await new Promise((r) => setTimeout(r, 30));

        // 1) Rogue plugin without mutual allowed-ipc is blocked
        const roguePostResult = await adapter.handleGuiRpc({
            pluginName: 'rogue_plugin',
            method: 'ipc.post',
            args: ['libra', 'libra_gradia_unified_read_request_v1', { requestId: 'bad' }],
        });
        assert.equal(roguePostResult, false);

        // 2) GRADIA collects memories from LIBRA, HAYAKU, and FLASHBACK concurrently via IPC
        const outMsgs = await adapter.runBeforeRequest([{ role: 'user', content: '테스트' }], 'model');
        assert.ok(outMsgs[0].content.includes('[GRADIA_IPC_COMBINED]'));
        assert.ok(outMsgs[0].content.includes('리브라 정본 기억'));
        assert.ok(outMsgs[0].content.includes('하야쿠 연속성 패킷'));
        assert.ok(outMsgs[0].content.includes('플래시백 회상 조각'));

        // 3) Multi-listener & 2-arg removePluginChannelListener preserves sibling listeners
        const initCursor = await adapter.handleGuiRpc({ pluginName: 'serial_gradation_agents_for_rp', method: 'ipc.poll', args: [0, true] });
        assert.deepEqual(initCursor.events, []);
        await adapter.handleGuiRpc({ pluginName: 'serial_gradation_agents_for_rp', method: 'ipc.post', args: ['libra', 'memory_suite_source_rules_v1', { tag: 'first' }] });
        await new Promise((r) => setTimeout(r, 25));
        const poll1 = await adapter.handleGuiRpc({ pluginName: 'serial_gradation_agents_for_rp', method: 'ipc.poll', args: [initCursor.latestSeq] });
        const multi1 = poll1.events.filter((e) => e.channel === 'multi_res_v1').map((e) => e.message.who).sort();
        assert.deepEqual(multi1, ['fn1', 'fn2']);

        // Remove only fn1 via 2-arg removePluginChannelListener
        await adapter.handleGuiRpc({ pluginName: 'serial_gradation_agents_for_rp', method: 'ipc.post', args: ['libra', 'multi_ctrl_v1', { removeFn1: true }] });
        await new Promise((r) => setTimeout(r, 25));
        await adapter.handleGuiRpc({ pluginName: 'serial_gradation_agents_for_rp', method: 'ipc.post', args: ['libra', 'memory_suite_source_rules_v1', { tag: 'second' }] });
        await new Promise((r) => setTimeout(r, 25));
        const poll2 = await adapter.handleGuiRpc({ pluginName: 'serial_gradation_agents_for_rp', method: 'ipc.poll', args: [poll1.latestSeq] });
        const multi2 = poll2.events.filter((e) => e.channel === 'multi_res_v1');
        assert.equal(multi2.length, 1);
        assert.equal(multi2[0].message.who, 'fn2');
        assert.equal(multi2[0].message.count, 2);

        // 4) GUI iframe cursor init ignores past events, then sees fresh reply from backend LIBRA
        const cursorInit = await adapter.handleGuiRpc({ pluginName: 'serial_gradation_agents_for_rp', method: 'ipc.poll', args: [0, true] });
        assert.deepEqual(cursorInit.events, []);
        assert.ok(cursorInit.latestSeq > 0);

        const guiPosted = await adapter.handleGuiRpc({ pluginName: 'serial_gradation_agents_for_rp', method: 'ipc.post', args: ['libra', 'gui_sync_req_v1', { ping: 'hello-gui' }] });
        assert.equal(guiPosted, true);
        await new Promise((r) => setTimeout(r, 25));

        const guiPolled = await adapter.handleGuiRpc({ pluginName: 'serial_gradation_agents_for_rp', method: 'ipc.poll', args: [cursorInit.latestSeq] });
        assert.equal(guiPolled.events.length, 1);
        assert.equal(guiPolled.events[0].channel, 'gui_sync_res_v1');
        assert.equal(guiPolled.events[0].message.echo, 'hello-gui');
        assert.equal(guiPolled.events[0].sender, 'libra');
    } finally {
        await adapter.dispose();
        delete globalThis.__l1;
        delete globalThis.__l2;
        delete globalThis.__libraRemoveFn1;
        delete globalThis.__roguePostResult;
        try { fs.rmSync(tmpPluginsPath, { force: true }); } catch (_) {}
    }
});
