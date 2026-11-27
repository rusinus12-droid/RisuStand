'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRelayServer } = require('../risustand-relay-server.js');
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

        // 3) Floating UI state starts collapsed & /api/plugins/floating-open auto-expands it (with sibling region preserved)
        const stAfter = await fetch(`${baseUrl}/api/state`, { headers: { 'X-RisuStand-Token': token } }).then((r) => r.json());
        assert.ok(stAfter.pluginFloatingUi && Array.isArray(stAfter.pluginFloatingUi.rootWidgets));
        const amWidget0 = stAfter.pluginFloatingUi.rootWidgets.find((w) => w.pluginName === 'maid_fab_test');
        assert.ok(amWidget0 && amWidget0.html.includes('data-am-expanded="false"'));
        assert.ok(amWidget0.html.includes('data-am-toast-region'));

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
