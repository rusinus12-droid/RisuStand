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
            if (st.lastTriggerEvent && st.lastTriggerEvent.message === '컨텍스트 커터 리셋됨') break;
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
