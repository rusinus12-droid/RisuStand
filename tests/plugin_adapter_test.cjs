'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const relay = require('../risustand-relay-server.js');
const adapterMod = require('../risustand-plugin-adapter.cjs');
const { REPO } = require('./helpers.cjs');

const CURRENT_VERSION = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim();

function requestHttp(port, { method = 'GET', path: reqPath = '/', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('error', reject);
        if (body !== null) req.write(body);
        req.end();
    });
}

async function waitUntil(fn, timeoutMs = 6000, intervalMs = 40) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    while (Date.now() < deadline) {
        try {
            const val = await fn();
            if (val) return val;
        } catch (e) {
            lastErr = e;
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`waitUntil timed out after ${timeoutMs}ms${lastErr ? `: ${lastErr.message}` : ''}`);
}

function makeMapStore(initialEntries = []) {
    const map = new Map(initialEntries);
    return {
        map,
        api: {
            async getItem(k) { return map.has(String(k)) ? map.get(String(k)) : null; },
            async setItem(k, v) { map.set(String(k), String(v)); },
            async removeItem(k) { map.delete(String(k)); },
            async clear() { map.clear(); },
            async keys() { return Array.from(map.keys()); },
            async key(i) { const ks = Array.from(map.keys()); return ks[Number(i)] ?? null; },
            get length() { return map.size; },
        },
    };
}

function bootRisuStandInVm({
    relayPort,
    token,
    mockDb,
    pluginStore,
    safeLocalStore,
    localPluginStore,
    assetStore = new Map(),
    inlayStore = new Map(),
    onSendChat = null,
}) {
    const code = fs.readFileSync(path.join(REPO, 'risustand.js'), 'utf8');
    let unloadCb = null;
    let reloadCount = 0;
    const timers = new Set();

    const trackTimer = (id) => { timers.add(id); return id; };
    const untrackTimer = (id) => { timers.delete(id); clearTimeout(id); clearInterval(id); };

    pluginStore.map.set('risustand_perms_prompted_v3', `${CURRENT_VERSION}:${Date.now()}`);
    pluginStore.map.set('risustand_remote_bridge_v2', JSON.stringify({
        enabled: true,
        relayUrl: `http://127.0.0.1:${relayPort}`,
        token,
        pollIntervalMs: 80,
    }));

    const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

    const risuai = {
        pluginStorage: pluginStore ? pluginStore.api : null,
        safeLocalStorage: safeLocalStore ? safeLocalStore.api : null,
        getLocalPluginStorage: () => (localPluginStore ? localPluginStore.api : null),
        async getRootDocument() { return null; },
        async changeColorScheme() {},
        async changeTextTheme() {},
        async setColorScheme() {},
        async setCustomTextTheme() {},
        async createMutationObserver() { return { observe: async () => {}, disconnect: async () => {} }; },
        async getDatabase(keys) {
            if (!Array.isArray(keys) || !keys.length) return clone(mockDb);
            const out = {};
            for (const k of keys) {
                if (Object.prototype.hasOwnProperty.call(mockDb, k)) out[k] = clone(mockDb[k]);
            }
            return out;
        },
        async setDatabaseLite(patch) {
            if (patch && typeof patch === 'object') Object.assign(mockDb, clone(patch));
            return true;
        },
        async setDatabase(patch) {
            if (patch && typeof patch === 'object') Object.assign(mockDb, clone(patch));
            return true;
        },
        async getCharacter() { return clone(mockDb.characters[0]); },
        async getCharacterFromIndex(idx) {
            return clone(mockDb.characters[Number(idx)] || null);
        },
        async setCharacterToIndex(idx, charObj) {
            mockDb.characters[Number(idx)] = clone(charObj);
            return true;
        },
        async getChatFromIndex(charIdx, chatIdx) {
            const c = mockDb.characters[Number(charIdx)];
            if (!c || !Array.isArray(c.chats)) return null;
            return clone(c.chats[Number(chatIdx)] || null);
        },
        async setChatToIndex(charIdx, chatIdx, chatObj) {
            const c = mockDb.characters[Number(charIdx)];
            if (!c) return false;
            if (!Array.isArray(c.chats)) c.chats = [];
            c.chats[Number(chatIdx)] = clone(chatObj);
            return true;
        },
        async getCurrentCharacterIndex() { return 0; },
        async getCurrentChatIndex() { return 0; },
        async readImage(assetPath) {
            const hit = assetStore.get(String(assetPath || ''));
            return hit ? new Uint8Array(hit) : null;
        },
        async saveAsset(data) {
            const buf = Buffer.from(data);
            const p = `assets/saved_${assetStore.size + 1}.png`;
            assetStore.set(p, new Uint8Array(buf));
            return p;
        },
        async readInlay(id) {
            return inlayStore.get(String(id || '')) || null;
        },
        async createInlay(data, opts) {
            const id = `aaaaaaaa-bbbb-4ccc-8ddd-${String(inlayStore.size + 1).padStart(12, '0')}`;
            const dataUri = typeof data === 'string'
                ? data
                : `data:image/png;base64,${Buffer.from(data).toString('base64')}`;
            inlayStore.set(id, {
                data: dataUri,
                ext: 'png',
                type: 'image',
                name: (opts && opts.name) || id,
                created: Date.now(),
            });
            return id;
        },
        async loadPlugins() { reloadCount += 1; },
        async getArgument() { return ''; },
        async setArgument() {},
        async getArg() { return ''; },
        async setArg() {},
        async registerSetting() {},
        async addRisuChatListener() {},
        async removeRisuChatListener() {},
        async addRisuScriptHandler() {},
        async addRisuReplacer() {},
        async registerButton() {},
        onUnload(fn) { unloadCb = fn; },
        async sendChat(msg) {
            if (typeof onSendChat === 'function') await onSendChat(msg);
        },
        async addPluginChannelListener() {},
        async registerMCP() {},
        async nativeFetch(url, opts = {}) {
            const resp = await fetch(String(url), {
                method: opts.method || 'GET',
                headers: opts.headers || {},
                body: opts.body,
                signal: opts.signal,
            });
            return resp;
        },
    };

    const noopFn = () => {};
    const makeEl = (tag = 'div') => ({
        tagName: String(tag).toUpperCase(),
        style: {},
        classList: { add: noopFn, remove: noopFn, toggle: noopFn, contains: () => false },
        setAttribute: noopFn,
        getAttribute: () => null,
        removeAttribute: noopFn,
        appendChild: noopFn,
        remove: noopFn,
        addEventListener: noopFn,
        removeEventListener: noopFn,
        querySelector: () => null,
        querySelectorAll: () => [],
        contains: () => false,
        innerHTML: '',
        textContent: '',
        id: '',
        dataset: {},
    });
    const fakeDocument = {
        head: makeEl('head'),
        body: makeEl('body'),
        documentElement: makeEl('html'),
        createElement: (tag) => makeEl(tag),
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: noopFn,
        removeEventListener: noopFn,
    };
    const noopObserver = class {
        observe() {}
        disconnect() {}
    };
    const fakeWindow = {
        addEventListener: noopFn,
        removeEventListener: noopFn,
        innerWidth: 1280,
        innerHeight: 800,
        location: { href: 'http://localhost/' },
        document: fakeDocument,
        MutationObserver: noopObserver,
    };

    const sandbox = {
        console: { log: noopFn, warn: noopFn, info: noopFn, error: console.error },
        setTimeout: (fn, ms) => trackTimer(setTimeout(fn, ms)),
        clearTimeout: (id) => untrackTimer(id),
        setInterval: (fn, ms) => trackTimer(setInterval(fn, ms)),
        clearInterval: (id) => untrackTimer(id),
        fetch,
        URL,
        URLSearchParams,
        Headers,
        Request,
        Response,
        Uint8Array,
        ArrayBuffer,
        Blob,
        AbortController,
        TextEncoder,
        TextDecoder,
        Buffer,
        crypto,
        structuredClone,
        atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
        btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
        DOMException,
        AbortSignal,
        navigator: { userAgent: 'node-test' },
        Math,
        Date,
        JSON,
        Promise,
        Error,
        Array,
        Object,
        String,
        Number,
        Boolean,
        Map,
        Set,
        RegExp,
        window: fakeWindow,
        self: fakeWindow,
        globalThis: null,
        document: fakeDocument,
        MutationObserver: noopObserver,
        ResizeObserver: noopObserver,
        Node: { ELEMENT_NODE: 1 },
        getComputedStyle: () => ({}),
        risuai,
        Risuai: risuai,
        __risuapi: risuai,
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(code, sandbox, { filename: 'risustand.js' });

    return {
        getReloadCount: () => reloadCount,
        async shutdown() {
            if (typeof unloadCb === 'function') {
                await unloadCb();
            }
            for (const id of [...timers]) {
                untrackTimer(id);
            }
        },
    };
}

test('plugin header parser & GUI iframe srcdoc generation compile safely', () => {
    const src = [
        '//@name mem_adapter_test',
        '//@display-name Memory Adapter Test',
        '//@api 3.0',
        '//@version 1.2.3',
        '//@arg mem_adapter_test::tag string Prefix tag; blank uses default',
        '//@arg limit int Max turns',
        '//@allowed-ipc helper_plugin other_plugin',
        'console.log("</script><script>alert(1)");',
    ].join('\n');

    const header = adapterMod.parsePluginHeader(src, 'fallback.js');
    assert.equal(header.name, 'mem_adapter_test');
    assert.equal(header.displayName, 'Memory Adapter Test');
    assert.equal(header.apiVersion, '3.0');
    assert.equal(header.version, '1.2.3');
    assert.deepEqual(header.allowedIPC, ['helper_plugin', 'other_plugin']);
    assert.equal(header.args.length, 2);
    assert.equal(header.args[0].key, 'tag');
    assert.equal(header.args[0].type, 'string');
    assert.equal(header.args[0].placeholder, 'default');
    assert.equal(header.args[1].key, 'limit');
    assert.equal(header.args[1].type, 'int');
    assert.equal(header.args[1].defaultValue, 0);

    const html = adapterMod.buildPluginGuiSrcdoc({
        plugin: {
            name: header.name,
            displayName: header.displayName,
            version: header.version,
            script: src,
            uiItems: [{ entryId: 'entry-0', name: 'Open GUI', icon: '🧪', iconType: 'html' }],
        },
        entryId: 'entry-0',
        theme: 'dark',
    });

    assert.ok(html.includes('<script id="__rs_meta" type="application/json">'));
    assert.ok(html.includes('<script id="__rs_plugin_code" type="application/json">'));
    assert.ok(!html.includes('</script><script>alert(1)'), 'Raw </script> in plugin code must be escaped inside srcdoc');

    const scripts = [];
    const re = /<script(?:\s+([^>]*))?>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        if (!(m[1] || '').includes('__rs_')) scripts.push(m[2]);
    }
    assert.equal(scripts.length, 1, 'Expected one executable runtime bootstrap script in GUI srcdoc');
    new vm.Script(scripts[0], { filename: 'plugin-gui-runtime.js' });
});

test('end-to-end PC bridge + relay server + backend plugin adapter direct storage/DB RPC, turn hooks, GUI RPC & upload/delete', async () => {
    const upstreamPayloads = [];
    const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            upstreamPayloads.push(body);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                id: `up-${upstreamPayloads.length}`,
                model: body.model || 'mock-model',
                choices: [{ index: 0, message: { role: 'assistant', content: `Upstream reply #${upstreamPayloads.length}` }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
            }));
        });
    });

    const auxHttp = http.createServer((req, res) => {
        if (req.url === '/ping') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, pong: true }));
            return;
        }
        res.writeHead(404);
        res.end('not found');
    });

    await Promise.all([
        new Promise((r) => upstream.listen(0, '127.0.0.1', r)),
        new Promise((r) => auxHttp.listen(0, '127.0.0.1', r)),
    ]);
    const upstreamPort = upstream.address().port;
    const auxPort = auxHttp.address().port;

    const pcPluginScript = `
//@name mem_adapter_test
//@display-name Memory Adapter Test
//@api 3.0
//@version 1.0.0
//@arg tag string Prefix tag
//@arg limit int Turn limit

(async () => {
    const risuai = globalThis.risuai;
    const tag = String((await risuai.getArgument('tag')) || 'def');
    await risuai.pluginStorage.setItem('adapter:boot', JSON.stringify({ tag }));
    await risuai.safeLocalStorage.setItem('adapter:safe', 'yes:' + tag);
    const localStore = await risuai.getLocalPluginStorage();
    await localStore.setItem('adapter:local', 'ok:' + tag);

    await risuai.addRisuReplacer('beforeRequest', async (messages) => {
        const raw = await risuai.pluginStorage.getItem('adapter:turn_log');
        const prev = raw ? JSON.parse(raw).count : 'none';
        const chatNow = await risuai.getChatFromIndex(1, 0);
        const noteNow = (chatNow && chatNow.note) || '';
        return [...(messages || []), { role: 'system', content: '[MEM_PREV:' + prev + '|NOTE:' + noteNow + ']' }];
    });

    risuai.registerBodyIntercepter(async (body) => {
        const curTag = String((await risuai.getArgument('tag')) || 'def');
        if (body && Array.isArray(body.messages)) {
            body.messages.push({ role: 'system', content: '[BODY_INTERCEPTED:' + curTag + ']' });
        }
        return body;
    });

    await risuai.addRisuReplacer('afterRequest', async (content) => {
        const curTag = String((await risuai.getArgument('tag')) || 'def');
        return String(content || '') + ' [AFTER:' + curTag + ']';
    });

    await risuai.addRisuChatListener('output', async () => {
        const raw = await risuai.pluginStorage.getItem('adapter:turn_log');
        const prev = raw ? Number(JSON.parse(raw).count || 0) : 0;
        const nextCount = prev + 1;
        await risuai.pluginStorage.setItem('adapter:turn_log', JSON.stringify({ count: nextCount }));
        const chatObj = await risuai.getChatFromIndex(1, 0);
        if (chatObj) {
            chatObj.note = 'turns:' + nextCount;
            await risuai.setChatToIndex(1, 0, chatObj);
        }
    });

    await risuai.registerSetting('GUI 열기', () => {
        const div = document.createElement('div');
        div.id = 'gui-root';
        div.textContent = 'GUI Mounted';
        document.body.appendChild(div);
    }, '🧪', 'html');

    risuai.onUnload(async () => {
        await risuai.pluginStorage.setItem('adapter:unloaded', '1');
    });
})();
`;

    const pluginStore = makeMapStore();
    const safeLocalStore = makeMapStore();
    const localPluginStore = makeMapStore();
    const mockDb = {
        characters: [
            { name: 'Placeholder', desc: '', personality: '', scenario: '', firstMessage: '', chats: [{ message: [], note: '' }] },
            {
                name: 'BotA',
                desc: 'Test bot',
                personality: '',
                scenario: '',
                firstMessage: 'Hi',
                chats: [{
                    message: [
                        { role: 'user', data: 'hello0' },
                        { role: 'char', data: 'hi0' },
                    ],
                    note: 'initial-note',
                }],
            },
        ],
        plugins: [
            {
                name: 'mem_adapter_test',
                displayName: 'Memory Adapter Test',
                versionOfPlugin: '3.0',
                customLink: '',
                realArg: { tag: 'v3', limit: 2 },
                arguments: { tag: 'string', limit: 'int' },
                script: pcPluginScript,
            },
        ],
    };

    const tok = 'plugin-adapter-e2e-tok';
    const authHeaders = { 'X-RisuStand-Token': tok, 'Content-Type': 'application/json' };
    const server = relay.createRelayServer({
        token: tok,
        configOverride: {
            activeProfileId: 'mock-openai',
            directPresetId: '',
            backendPlugins: {},
            profiles: [{
                id: 'mock-openai',
                name: 'Mock OpenAI',
                providerType: 'openai_compat',
                baseUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
                apiKey: 'sk-test',
                model: 'mock-model',
                temperature: '',
                maxTokens: '',
                overrideMode: 'off',
                systemOverride: '',
            }],
            translator: { useActiveProfile: true, autoTranslateOutput: false, autoTranslateInput: false },
        },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const relayPort = server.address().port;

    const vmBridge = bootRisuStandInVm({
        relayPort,
        token: tok,
        mockDb,
        pluginStore,
        safeLocalStore,
        localPluginStore,
    });

    try {
        // 1) Wait until PC Bridge connects & Host RPC channel comes up, and sync PC plugins
        await waitUntil(async () => {
            const res = await requestHttp(relayPort, { path: '/api/plugins', headers: authHeaders });
            const json = JSON.parse(res.body);
            return json.ok && json.pcConnected && json.rpcConnected && json.plugins.some((p) => p.name === 'mem_adapter_test');
        });

        const syncRes = await requestHttp(relayPort, { method: 'POST', path: '/api/plugins/sync-pc', headers: authHeaders, body: '{}' });
        assert.equal(syncRes.status, 200);
        const syncedList = JSON.parse(syncRes.body).plugins;
        const memPlugin = syncedList.find((p) => p.name === 'mem_adapter_test');
        assert.ok(memPlugin, 'mem_adapter_test should be discovered from PC db.plugins');
        assert.equal(memPlugin.source, 'pc');
        assert.equal(memPlugin.enabled, false);

        // Switch remote view target to non-PC-active character 1 (BotA) for direct_router routing
        const selRes = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/command',
            headers: authHeaders,
            body: JSON.stringify({ type: 'select_target', payload: { charIndex: 1, chatIndex: 0 } }),
        });
        assert.equal(selRes.status, 200);
        await waitUntil(async () => {
            const st = JSON.parse((await requestHttp(relayPort, { path: '/api/state', headers: authHeaders })).body);
            return st.snapshot && st.snapshot.charIndex === 1 && st.snapshot.isPcActive === false;
        });

        // 2) Toggle ON -> loads plugin & writes directly to PC pluginStorage / safeLocalStorage / localPluginStorage
        const toggleOnRes = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/toggle',
            headers: authHeaders,
            body: JSON.stringify({ name: 'mem_adapter_test', enabled: true }),
        });
        assert.equal(toggleOnRes.status, 200);
        const onState = JSON.parse(toggleOnRes.body).plugins.find((p) => p.name === 'mem_adapter_test');
        assert.equal(onState.enabled, true);
        assert.equal(onState.loaded, true);
        assert.ok(onState.uiItems.length >= 1, 'registerSetting GUI item should be captured');
        assert.equal(onState.hasBodyIntercepter, true);

        await waitUntil(() => pluginStore.map.get('adapter:boot') === JSON.stringify({ tag: 'v3' }));
        assert.equal(safeLocalStore.map.get('adapter:safe'), 'yes:v3');
        assert.equal(localPluginStore.map.get('adapter:local'), 'ok:v3');

        // 3) Update @arg via /api/plugins/args
        const argsRes = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/args',
            headers: authHeaders,
            body: JSON.stringify({ name: 'mem_adapter_test', args: { tag: 'customTag', limit: '5' } }),
        });
        assert.equal(argsRes.status, 200);
        const afterArgs = JSON.parse(argsRes.body).plugins.find((p) => p.name === 'mem_adapter_test');
        assert.equal(afterArgs.argValues.tag, 'customTag');
        assert.equal(afterArgs.argValues.limit, 5);

        // 4) Direct remote chat Turn 1 -> triggers beforeRequest, bodyIntercepter, afterRequest, chatOutput
        const turn1Res = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/chat/send',
            headers: authHeaders,
            body: JSON.stringify({
                text: 'First turn prompt',
                charIndex: 1,
                chatIndex: 0,
            }),
        });
        assert.equal(turn1Res.status, 200);
        assert.equal(JSON.parse(turn1Res.body).mode, 'direct_router');

        await waitUntil(async () => {
            const st = JSON.parse((await requestHttp(relayPort, { path: '/api/state', headers: authHeaders })).body);
            return !st.directGenerating &&
                pluginStore.map.get('adapter:turn_log') === JSON.stringify({ count: 1 }) &&
                mockDb.characters[1].chats[0].message.some((m) => m.role === 'char' && m.data.includes('[AFTER:customTag]'));
        });

        assert.equal(upstreamPayloads.length, 1);
        const upMsgs1 = upstreamPayloads[0].messages.map((m) => m.content).join('\n');
        assert.ok(upMsgs1.includes('[MEM_PREV:none|NOTE:initial-note]'));
        assert.ok(upMsgs1.includes('[BODY_INTERCEPTED:customTag]'));
        assert.equal(mockDb.characters[1].chats[0].note, 'turns:1');

        // 5) Direct remote chat Turn 2 -> beforeRequest sees Turn 1 data directly from PC pluginStorage & DB
        const turn2Res = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/chat/send',
            headers: authHeaders,
            body: JSON.stringify({
                text: 'Second turn prompt',
                charIndex: 1,
                chatIndex: 0,
            }),
        });
        assert.equal(turn2Res.status, 200);
        assert.equal(JSON.parse(turn2Res.body).mode, 'direct_router');

        await waitUntil(async () => {
            const st = JSON.parse((await requestHttp(relayPort, { path: '/api/state', headers: authHeaders })).body);
            return !st.directGenerating &&
                pluginStore.map.get('adapter:turn_log') === JSON.stringify({ count: 2 });
        });
        const upMsgs2 = upstreamPayloads[1].messages.map((m) => m.content).join('\n');
        assert.ok(upMsgs2.includes('[MEM_PREV:1|NOTE:turns:1]'));

        // 6) Dedicated GUI srcdoc + postMessage RPC bridge endpoints
        const entryId = encodeURIComponent(onState.uiItems[0].id);
        const srcdocRes = await requestHttp(relayPort, {
            path: `/api/plugins/gui-srcdoc?name=mem_adapter_test&entryId=${entryId}&theme=dark`,
            headers: authHeaders,
        });
        assert.equal(srcdocRes.status, 200);
        const srcdocJson = JSON.parse(srcdocRes.body);
        assert.equal(srcdocJson.ok, true);
        assert.ok(srcdocJson.srcdoc.includes('GUI Mounted'));

        const guiRpcStore = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/gui-rpc',
            headers: authHeaders,
            body: JSON.stringify({
                pluginName: 'mem_adapter_test',
                method: 'pluginStorage.setItem',
                args: ['adapter:from_gui', 'hello-from-iframe'],
            }),
        });
        assert.equal(guiRpcStore.status, 200);
        assert.equal(pluginStore.map.get('adapter:from_gui'), 'hello-from-iframe');

        const chatSnap = JSON.parse(JSON.stringify(mockDb.characters[1].chats[0]));
        chatSnap.note = 'gui-edited-note';
        const guiRpcDb = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/gui-rpc',
            headers: authHeaders,
            body: JSON.stringify({
                pluginName: 'mem_adapter_test',
                method: 'db.setChat',
                args: [1, 0, chatSnap],
            }),
        });
        assert.equal(guiRpcDb.status, 200);
        assert.equal(mockDb.characters[1].chats[0].note, 'gui-edited-note');

        const guiRpcArg = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/gui-rpc',
            headers: authHeaders,
            body: JSON.stringify({
                pluginName: 'mem_adapter_test',
                method: 'setArgument',
                args: ['tag', 'guiTag'],
            }),
        });
        assert.equal(guiRpcArg.status, 200);

        const guiRpcFetch = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/gui-rpc',
            headers: authHeaders,
            body: JSON.stringify({
                pluginName: 'mem_adapter_test',
                method: 'nativeFetch',
                args: [`http://127.0.0.1:${auxPort}/ping`, { method: 'GET' }],
            }),
        });
        assert.equal(guiRpcFetch.status, 200);
        const fetchVal = JSON.parse(guiRpcFetch.body).value;
        assert.equal(fetchVal.status, 200);
        assert.deepEqual(JSON.parse(Buffer.from(fetchVal.bodyBase64, 'base64').toString('utf8')), { ok: true, pong: true });

        // 7) Toggle OFF -> triggers onUnload hook & stops intercepting Turn 3
        const toggleOffRes = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/toggle',
            headers: authHeaders,
            body: JSON.stringify({ name: 'mem_adapter_test', enabled: false }),
        });
        assert.equal(toggleOffRes.status, 200);
        await waitUntil(() => pluginStore.map.get('adapter:unloaded') === '1');

        const turn3Res = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/chat/send',
            headers: authHeaders,
            body: JSON.stringify({
                text: 'Third turn after unload',
                charIndex: 1,
                chatIndex: 0,
            }),
        });
        assert.equal(turn3Res.status, 200);
        await waitUntil(async () => {
            const st = JSON.parse((await requestHttp(relayPort, { path: '/api/state', headers: authHeaders })).body);
            return !st.directGenerating && upstreamPayloads.length === 3;
        });
        const upMsgs3 = upstreamPayloads[2].messages.map((m) => m.content).join('\n');
        assert.ok(!upMsgs3.includes('[BODY_INTERCEPTED:'));

        // 8) Upload custom .js plugin & delete it (never writes .risustand-plugins.json under configOverride)
        const customScript = `
//@name custom_uploaded_test
//@display-name Custom Uploaded
//@api 3.0
//@version 0.1.0
globalThis.risuai.addRisuReplacer('afterRequest', async (c) => c + ' [CUSTOM]');
`;
        const uploadRes = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/upload',
            headers: authHeaders,
            body: JSON.stringify({ filename: 'custom_uploaded_test.js', script: customScript, enabled: true }),
        });
        assert.equal(uploadRes.status, 200);
        const uploadedPlugin = JSON.parse(uploadRes.body).plugins.find((p) => p.name === 'custom_uploaded_test');
        assert.ok(uploadedPlugin);
        assert.equal(uploadedPlugin.source, 'custom');
        assert.equal(uploadedPlugin.loaded, true);
        assert.equal(fs.existsSync(path.join(REPO, '.risustand-plugins.json')), false);

        const delRes = await requestHttp(relayPort, {
            method: 'DELETE',
            path: '/api/plugins/custom_uploaded_test',
            headers: authHeaders,
        });
        assert.equal(delRes.status, 200);
        const afterDel = JSON.parse(delRes.body).plugins;
        assert.ok(!afterDel.some((p) => p.name === 'custom_uploaded_test'));
    } finally {
        await vmBridge.shutdown();
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        await new Promise((r) => server.close(r));
        await new Promise((r) => upstream.close(r));
        await new Promise((r) => auxHttp.close(r));
    }
});

test('PC-open bot (isPcActive=true) runs remote backend plugins exclusively (PC sendChat stopped) with createInlay/saveAsset/readImage/readInlay & display handler', async () => {
    const pngBytes = Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
    ]);
    let upstreamCount = 0;
    const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            upstreamCount += 1;
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                id: `illus-${upstreamCount}`,
                model: body.model || 'mock-model',
                choices: [{ index: 0, message: { role: 'assistant', content: `Reply #${upstreamCount}` }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
            }));
        });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = upstream.address().port;

    const pngB64 = Buffer.from(pngBytes).toString('base64');
    const illustPluginScript = `
//@name illust_display_test
//@display-name Illustration & Display Test
//@api 3.0
//@version 1.0.0

(async () => {
    const risuai = globalThis.risuai;
    const b64 = '${pngB64}';
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const savedPath = await risuai.saveAsset(bin);
    const readBack = await risuai.readImage(savedPath);
    await risuai.pluginStorage.setItem('illust:boot_asset', JSON.stringify({
        savedPath,
        byteLen: readBack ? readBack.byteLength : 0,
    }));

    await risuai.addRisuReplacer('afterRequest', async (text) => {
        const inlayId = await risuai.createInlay(bin, { name: 'illust.png' });
        return String(text || '') + '\\n{{inlay::' + inlayId + '}}\\n[CARD]Scene Illustrated[/CARD]';
    });

    await risuai.addRisuScriptHandler('display', async (text) => {
        return String(text || '').replace(/\\[CARD\\]([\\s\\S]*?)\\[\\/CARD\\]/g, '<div class="plg-card">$1</div>');
    });
})();
`;

    const pluginStore = makeMapStore();
    const safeLocalStore = makeMapStore();
    const localPluginStore = makeMapStore();
    const assetStore = new Map();
    const inlayStore = new Map();
    let pcSendChatCount = 0;

    const mockDb = {
        characters: [
            {
                name: 'OpenBot',
                desc: 'Active on PC',
                personality: '',
                scenario: '',
                firstMessage: 'Hello from OpenBot',
                chats: [{
                    message: [
                        { role: 'user', data: 'initial user' },
                        { role: 'char', data: 'initial reply' },
                    ],
                    note: '',
                }],
            },
        ],
        plugins: [
            {
                name: 'illust_display_test',
                displayName: 'Illustration & Display Test',
                versionOfPlugin: '3.0',
                customLink: '',
                realArg: {},
                arguments: {},
                script: illustPluginScript,
            },
        ],
    };

    const tok = 'plugin-pc-open-illust-tok';
    const authHeaders = { 'X-RisuStand-Token': tok, 'Content-Type': 'application/json' };
    const server = relay.createRelayServer({
        token: tok,
        configOverride: {
            activeProfileId: 'mock-openai',
            directPresetId: '',
            backendPlugins: {},
            remoteDirectOnly: true,
            profiles: [{
                id: 'mock-openai',
                name: 'Mock OpenAI',
                providerType: 'openai_compat',
                baseUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
                apiKey: 'sk-test',
                model: 'mock-model',
                temperature: '',
                maxTokens: '',
                overrideMode: 'off',
                systemOverride: '',
            }],
            translator: { useActiveProfile: true, autoTranslateOutput: false, autoTranslateInput: false },
        },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const relayPort = server.address().port;

    const vmBridge = bootRisuStandInVm({
        relayPort,
        token: tok,
        mockDb,
        pluginStore,
        safeLocalStore,
        localPluginStore,
        assetStore,
        inlayStore,
        onSendChat: async () => { pcSendChatCount += 1; },
    });

    try {
        // 1) Wait until PC Bridge + Host RPC connects and syncs PC plugins while charIndex 0 (isPcActive=true) is open
        await waitUntil(async () => {
            const pRes = JSON.parse((await requestHttp(relayPort, { path: '/api/plugins', headers: authHeaders })).body);
            const stRes = JSON.parse((await requestHttp(relayPort, { path: '/api/state', headers: authHeaders })).body);
            return pRes.ok && pRes.pcConnected && pRes.rpcConnected &&
                pRes.remoteDirectOnly === true &&
                pRes.plugins.some((p) => p.name === 'illust_display_test') &&
                stRes.snapshot && stRes.snapshot.charIndex === 0 && stRes.snapshot.isPcActive === true;
        });

        // 2) Toggle illust_display_test ON -> verifies saveAsset + readImage binary round-trip over PC Host RPC
        const togOnRes = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/toggle',
            headers: authHeaders,
            body: JSON.stringify({ name: 'illust_display_test', enabled: true }),
        });
        assert.equal(togOnRes.status, 200);
        await waitUntil(() => Boolean(pluginStore.map.get('illust:boot_asset')));
        const bootAsset = JSON.parse(pluginStore.map.get('illust:boot_asset'));
        assert.match(bootAsset.savedPath, /^assets\//);
        assert.equal(bootAsset.byteLen, pngBytes.byteLength);

        // 3) Send chat while charIndex 0 is OPEN on PC -> MUST route via direct_router & NEVER call PC sendChat()
        const sendRes = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/chat/send',
            headers: authHeaders,
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, text: 'Draw a sunset scene' }),
        });
        assert.equal(sendRes.status, 200);
        assert.equal(JSON.parse(sendRes.body).mode, 'direct_router');
        assert.equal(pcSendChatCount, 0, 'PC native sendChat() must stay stopped when remoteDirectOnly/backend plugins run');

        // 4) Wait until reply + createInlay + PC DB save + refreshed snapshot with editdisplay card & /api/asset image arrives
        let latestCharMsg = null;
        await waitUntil(async () => {
            const st = JSON.parse((await requestHttp(relayPort, { path: '/api/state', headers: authHeaders })).body);
            if (!st.directGenerating && st.snapshot && Array.isArray(st.snapshot.messages)) {
                const last = st.snapshot.messages[st.snapshot.messages.length - 1];
                if (last && last.role === 'char' && last.html && last.html.includes('plg-card')) {
                    latestCharMsg = last;
                    return true;
                }
            }
            return false;
        });

        assert.equal(pcSendChatCount, 0);
        assert.ok(latestCharMsg.html.includes('<div class="plg-card">Scene Illustrated</div>'), 'display handler transform must apply to m.html');
        assert.ok(latestCharMsg.raw.includes('[CARD]Scene Illustrated[/CARD]'), 'raw DB message must retain original marker');
        assert.ok(/\{\{inlay::[^}]+\}\}/.test(latestCharMsg.raw), 'raw DB message must retain {{inlay::...}} placeholder');

        const assetUrl = (latestCharMsg.images || []).find((u) => typeof u === 'string' && u.startsWith('/api/asset/'));
        assert.ok(assetUrl, 'inlay created by plugin should resolve to /api/asset/<id> in snapshot messages');
        const assetHttpRes = await requestHttp(relayPort, { path: assetUrl, headers: authHeaders });
        assert.equal(assetHttpRes.status, 200);
        assert.equal(assetHttpRes.headers['content-type'], 'image/png');

        // 5) GUI RPC binary asset & inlay endpoints work directly against PC Host RPC
        const guiSave = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/gui-rpc',
            headers: authHeaders,
            body: JSON.stringify({
                pluginName: 'illust_display_test',
                method: 'asset.saveAsset',
                args: [{ __b64: pngB64 }],
            }),
        });
        assert.equal(guiSave.status, 200);
        const guiSavedPath = JSON.parse(guiSave.body).value;
        assert.match(guiSavedPath, /^assets\//);

        const guiRead = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/gui-rpc',
            headers: authHeaders,
            body: JSON.stringify({
                pluginName: 'illust_display_test',
                method: 'asset.readImage',
                args: [guiSavedPath],
            }),
        });
        assert.equal(guiRead.status, 200);
        assert.equal(Buffer.from(JSON.parse(guiRead.body).value.__b64, 'base64').byteLength, pngBytes.byteLength);

        const guiInlayCreate = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/gui-rpc',
            headers: authHeaders,
            body: JSON.stringify({
                pluginName: 'illust_display_test',
                method: 'asset.createInlay',
                args: [{ __b64: pngB64 }, { name: 'gui-inlay.png' }],
            }),
        });
        assert.equal(guiInlayCreate.status, 200);
        const guiInlayId = JSON.parse(guiInlayCreate.body).value;
        assert.ok(guiInlayId);

        const guiInlayRead = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/gui-rpc',
            headers: authHeaders,
            body: JSON.stringify({
                pluginName: 'illust_display_test',
                method: 'asset.readInlay',
                args: [guiInlayId],
            }),
        });
        assert.equal(guiInlayRead.status, 200);
        assert.ok(JSON.parse(guiInlayRead.body).value.data.startsWith('data:image/png;base64,'));

        // 6) Toggle illust_display_test OFF -> display handler stops immediately & m.html reverts to unstyled base
        const togOffRes = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/toggle',
            headers: authHeaders,
            body: JSON.stringify({ name: 'illust_display_test', enabled: false }),
        });
        assert.equal(togOffRes.status, 200);
        const stReverted = JSON.parse((await requestHttp(relayPort, { path: '/api/state', headers: authHeaders })).body);
        const revertedLast = stReverted.snapshot.messages[stReverted.snapshot.messages.length - 1];
        assert.ok(!String(revertedLast.html || '').includes('plg-card'), 'disabling plugin should immediately remove display handler transform');

        // 7) Turning remoteDirectOnly OFF (with backend plugins OFF) restores native PC sendChat for PC-open bot
        const setOptRes = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/settings',
            headers: authHeaders,
            body: JSON.stringify({ remoteDirectOnly: false }),
        });
        assert.equal(setOptRes.status, 200);
        assert.equal(JSON.parse(setOptRes.body).remoteDirectOnly, false);

        const nativeRes = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/chat/send',
            headers: authHeaders,
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, text: 'Native turn check' }),
        });
        assert.equal(nativeRes.status, 200);
        assert.equal(JSON.parse(nativeRes.body).mode, 'native_risu');
        await waitUntil(() => pcSendChatCount === 1);
    } finally {
        await vmBridge.shutdown();
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        await new Promise((r) => server.close(r));
        await new Promise((r) => upstream.close(r));
    }
});

test('Backend Plugin Adapter: chunked multi-MB sync, scriptSig cache reuse, single-flight dedup, and legacy fallback', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-chunk-sync-'));
    const cfg = { backendPlugins: {} };
    const pad = '/* pad */\n'.repeat(340000); // ~3.4 MB -> forces 3 chunks at 1.5M chars/chunk
    const makeBigScript = (tag) => `
//@name big_lib_plugin
//@display-name Big Lib Plugin
//@api 3.0
//@version 2.1.0
//@arg mode string Mode
${pad}
globalThis.BIG_PLUGIN_TAG = ${JSON.stringify(tag)};
`;
    let currentScript = makeBigScript('v1');
    let realArg = { mode: 'fast' };

    const counts = { listMeta: 0, getChunk: 0, legacyGetPlugins: 0 };
    let forceLegacy = false;
    let delayFirstMetaMs = 0;

    function scriptSig(s) {
        let h1 = 0x811c9dc5;
        const step = Math.max(1, Math.floor(s.length / 4096));
        for (let i = 0; i < s.length; i += step) {
            h1 ^= s.charCodeAt(i);
            h1 = Math.imul(h1, 0x01000193) >>> 0;
        }
        return `${s.length}:${h1.toString(16)}`;
    }

    const mockRpc = {
        isConnected: () => true,
        invoke: async (op, args = []) => {
            if (op === 'db.listPluginsMeta') {
                counts.listMeta += 1;
                if (delayFirstMetaMs > 0) {
                    const ms = delayFirstMetaMs;
                    delayFirstMetaMs = 0;
                    await new Promise((r) => setTimeout(r, ms));
                }
                if (forceLegacy) throw new Error('Unsupported host RPC op: db.listPluginsMeta');
                return [{
                    name: 'big_lib_plugin',
                    displayName: 'Big Lib Plugin',
                    version: '3.0',
                    versionOfPlugin: '2.1.0',
                    scriptLen: currentScript.length,
                    scriptSig: scriptSig(currentScript),
                    realArg: { ...realArg },
                    enabled: true,
                    allowedIPC: [],
                }];
            }
            if (op === 'db.getPluginScriptChunk') {
                counts.getChunk += 1;
                const [name, offset, maxChars] = args;
                assert.equal(name, 'big_lib_plugin');
                const chunk = currentScript.slice(offset, offset + maxChars);
                return {
                    name,
                    chunk,
                    offset,
                    totalLen: currentScript.length,
                    scriptSig: scriptSig(currentScript),
                    eof: (offset + chunk.length) >= currentScript.length,
                };
            }
            if (op === 'db.getPlugins') {
                counts.legacyGetPlugins += 1;
                return [{
                    name: 'legacy_plugin',
                    displayName: 'Legacy Plugin',
                    version: '3.0',
                    versionOfPlugin: '1.0.0',
                    script: `//@name legacy_plugin\n//@api 3.0\nglobalThis.LEGACY = true;`,
                    realArg: {},
                    enabled: true,
                    allowedIPC: [],
                }];
            }
            throw new Error(`Unexpected RPC op: ${op}`);
        },
    };

    const adapter = adapterMod.createPluginAdapter({
        pluginsPath: path.join(tmpDir, 'plugins.json'),
        persistDisabled: true,
        getBackendConfig: () => cfg,
        saveBackendConfig: () => {},
        hostRpc: mockRpc,
    });

    try {
        // 1) Concurrent calls deduplicate into a single in-flight sync & split >3.4MB script into >=3 chunks
        delayFirstMetaMs = 40;
        const [r1, r2] = await Promise.all([adapter.syncPcPlugins(), adapter.syncPcPlugins()]);
        assert.equal(counts.listMeta, 1, 'concurrent syncPcPlugins() must share single-flight promise');
        assert.equal(counts.getChunk, 3, '>3.4MB script must stream across 3 chunks of 1.5M chars');
        const p1 = r1.find((p) => p.name === 'big_lib_plugin');
        assert.ok(p1 && p1.hasScript);
        assert.equal(r2.length, r1.length);
        assert.equal(p1.argValues.mode, 'fast');

        // 2) Second sync with unchanged scriptSig skips chunk transfers completely, yet picks up realArg changes
        realArg = { mode: 'accurate' };
        const beforeChunkCount = counts.getChunk;
        const r3 = await adapter.syncPcPlugins();
        assert.equal(counts.listMeta, 2);
        assert.equal(counts.getChunk, beforeChunkCount, 'matching scriptSig must reuse cached script without re-fetching chunks');
        assert.equal(r3.find((p) => p.name === 'big_lib_plugin').argValues.mode, 'accurate');

        // 3) Legacy fallback when PC risustand.js lacks db.listPluginsMeta
        forceLegacy = true;
        const r4 = await adapter.syncPcPlugins();
        assert.equal(counts.legacyGetPlugins, 1);
        assert.ok(r4.some((p) => p.name === 'legacy_plugin'), 'must fall back to db.getPlugins on legacy PC client');
    } finally {
        await adapter.dispose();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('Plugin Adapter: self-update via setDatabase({ plugins }) + location.reload() / loadPlugins() hot-reloads without RPC error', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-self-upd-'));
    const pluginsPath = path.join(tmpDir, 'plugins.json');
    const cfg = { backendPlugins: {} };
    let reloadRpcCalls = 0;

    const makeScript = (ver) => `
//@name self_upd_plugin
//@display-name Self Updater
//@api 3.0
//@version ${ver}
(async () => {
  await risuai.registerSetting('Self Updater v${ver}', async () => {});
  await risuai.addRisuReplacer('beforeRequest', async (msgs) => {
    return [...msgs, { role: 'system', content: 'SELF_UPD_${ver}' }];
  });
})();
`;

    const mockRpc = {
        isConnected: () => true,
        invoke: async (op) => {
            if (op === 'db.reloadPcPlugins') {
                reloadRpcCalls += 1;
                return true;
            }
            if (op === 'db.getDatabase') {
                return { characters: [], plugins: [] };
            }
            if (op === 'db.setDatabase' || op === 'db.setDatabaseLite') {
                return true;
            }
            if (op === 'db.listPluginsMeta') {
                return [];
            }
            return null;
        },
    };

    const adapter = adapterMod.createPluginAdapter({
        pluginsPath,
        persistDisabled: false,
        getBackendConfig: () => cfg,
        saveBackendConfig: () => {},
        hostRpc: mockRpc,
    });

    try {
        await adapter.addCustomPlugin({ filename: 'self_upd.js', script: makeScript('1.0.0'), enabled: true });
        let list = adapter.listPlugins();
        assert.equal(list.find((p) => p.name === 'self_upd_plugin').version, '1.0.0');

        // Simulate in-plugin self-update updating DB plugins array + calling location.reload()
        const guiOut = await adapter.handleGuiRpc({ pluginName: 'self_upd_plugin', method: 'db.getDatabase', args: [['plugins']] });
        const target = guiOut.plugins.find((p) => p && p.name === 'self_upd_plugin');
        assert.ok(target && target.script.includes('1.0.0'));

        target.script = makeScript('2.0.0');
        target.versionOfPlugin = '2.0.0';
        await adapter.handleGuiRpc({ pluginName: 'self_upd_plugin', method: 'db.setDatabase', args: [{ plugins: guiOut.plugins }] });
        await adapter.handleGuiRpc({ pluginName: 'self_upd_plugin', method: 'db.reloadPcPlugins', args: ['self_upd_plugin'] });
        await new Promise((r) => setTimeout(r, 120));

        list = await adapter.reloadPlugins('self_upd_plugin');
        assert.equal(list.find((p) => p.name === 'self_upd_plugin').version, '2.0.0');
        assert.ok(reloadRpcCalls >= 1);

        const reqOut = await adapter.runBeforeRequest([{ role: 'user', content: 'hi' }], {});
        assert.ok(reqOut.some((m) => String(m.content || '').includes('SELF_UPD_2.0.0')), 'hot-reloaded hook must emit v2.0.0 content');
    } finally {
        await adapter.dispose();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('GUI RPC batching coalesces pluginStorage.getItem into getMany, caches db.getChat briefly, and compiles srcdoc script', async () => {
    const rpcCalls = [];
    let chatVersion = 1;
    const storeData = new Map([
        ['hayaku:k1', { packet: 1 }],
        ['hayaku:k2', { packet: 2 }],
        ['hayaku:k3', { packet: 3 }],
    ]);
    const mockRpc = {
        isConnected: () => true,
        invoke: async (op, args) => {
            rpcCalls.push({ op, args });
            if (op === 'pluginStorage.getMany') {
                const out = {};
                for (const k of (args[0] || [])) out[k] = storeData.has(k) ? storeData.get(k) : null;
                return out;
            }
            if (op === 'pluginStorage.getItem') {
                return storeData.has(args[0]) ? storeData.get(args[0]) : null;
            }
            if (op === 'db.getChat') {
                return { id: 'c-1', name: 'Room', version: chatVersion, message: [{ role: 'char', data: 'hello' }] };
            }
            if (op === 'db.setChat') {
                chatVersion = (args[2] && args[2].version) || (chatVersion + 1);
                return true;
            }
            return null;
        },
    };

    const adapter = adapterMod.createPluginAdapter({
        persistDisabled: true,
        getBackendConfig: () => ({ backendPlugins: {} }),
        saveBackendConfig: () => {},
        hostRpc: mockRpc,
    });
    const server = relay.createRelayServer({
        token: 'batch-test-tok',
        configOverride: { persistDisabled: true, backendPlugins: {} },
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const headers = {
        'Content-Type': 'application/json',
        'X-RisuStand-Token': 'batch-test-tok',
    };

    try {
        const hayakuScript = '//@name hayaku_mock\n//@display-name HAYAKU Mock\n//@api 3.0\nrisuai.registerSetting("Open", () => {});\n';
        await adapter.addCustomPlugin({
            filename: 'hayaku_mock.js',
            script: hayakuScript,
            enabled: true,
        });

        // 1) Batch coalesces >= 2 uncached pluginStorage.getItem calls into a single pluginStorage.getMany
        const batchResults = await adapter.handleGuiRpcBatch({
            pluginName: 'hayaku_mock',
            calls: [
                { reqId: 'r1', method: 'pluginStorage.getItem', args: ['hayaku:k1'] },
                { reqId: 'r2', method: 'pluginStorage.getItem', args: ['hayaku:k2'] },
                { reqId: 'r3', method: 'pluginStorage.getItem', args: ['hayaku:k3'] },
            ],
        });
        assert.deepEqual(batchResults.map((r) => [r.reqId, r.ok, r.value]), [
            ['r1', true, { packet: 1 }],
            ['r2', true, { packet: 2 }],
            ['r3', true, { packet: 3 }],
        ]);
        assert.equal(rpcCalls.filter((c) => c.op === 'pluginStorage.getMany').length, 1);
        assert.equal(rpcCalls.filter((c) => c.op === 'pluginStorage.getItem').length, 0);

        // 2) Short-TTL cache deduplicates back-to-back db.getChat reads, and db.setChat invalidates it
        rpcCalls.length = 0;
        const chatBatch = await adapter.handleGuiRpcBatch({
            pluginName: 'hayaku_mock',
            calls: [
                { reqId: 'c1', method: 'db.getChat', args: [0, 0] },
                { reqId: 'c2', method: 'db.getChat', args: [0, 0] },
            ],
        });
        assert.equal(chatBatch[0].value.version, 1);
        assert.equal(chatBatch[1].value.version, 1);
        assert.equal(rpcCalls.filter((c) => c.op === 'db.getChat').length, 1);

        await adapter.handleGuiRpc({
            pluginName: 'hayaku_mock',
            method: 'db.setChat',
            args: [0, 0, { id: 'c-1', name: 'Room', version: 2, message: [{ role: 'char', data: 'updated' }] }],
        });
        const afterSetVal = await adapter.handleGuiRpc({ pluginName: 'hayaku_mock', method: 'db.getChat', args: [0, 0] });
        assert.equal(afterSetVal.version, 2);

        // 3) Upload plugin onto relay server and verify /api/plugins/gui-rpc-batch + /api/plugins/gui-srcdoc
        const upRes = await requestHttp(port, {
            method: 'POST',
            path: '/api/plugins/upload',
            headers,
            body: JSON.stringify({ filename: 'hayaku_mock.js', script: hayakuScript, enabled: true }),
        });
        assert.equal(upRes.status, 200);

        const httpBatchRes = await requestHttp(port, {
            method: 'POST',
            path: '/api/plugins/gui-rpc-batch',
            headers,
            body: JSON.stringify({
                pluginName: 'hayaku_mock',
                calls: [
                    { reqId: 'w1', method: 'pluginStorage.setItem', args: ['hayaku:w1', { ok: true }] },
                    { reqId: 'g1', method: 'pluginStorage.getItem', args: ['hayaku:w1'] },
                ],
            }),
        });
        assert.equal(httpBatchRes.status, 200);
        const httpBatchBody = JSON.parse(httpBatchRes.body);
        assert.equal(httpBatchBody.ok, true);
        assert.deepEqual(httpBatchBody.results.map((r) => [r.reqId, r.ok, r.value]), [
            ['w1', true, true],
            ['g1', true, { ok: true }],
        ]);

        const srcdocRes = await requestHttp(port, {
            path: '/api/plugins/gui-srcdoc?name=hayaku_mock&theme=dark',
            headers: { 'X-RisuStand-Token': 'batch-test-tok' },
        });
        assert.equal(srcdocRes.status, 200);
        const srcdocHtml = JSON.parse(srcdocRes.body).srcdoc;
        assert.ok(srcdocHtml.includes('__rsGuiRpcBatch'));
        assert.ok(srcdocHtml.includes('__rsGuiChatChanged'));
        assert.ok(srcdocHtml.includes('setInterval(window.__rsPollIpcNow, 120)'));
        const scriptMatches = [...srcdocHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
        assert.ok(scriptMatches.length >= 1);
        for (const m of scriptMatches) {
            new vm.Script(m[1]);
        }
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await adapter.dispose();
    }
});

test('sandbox DOM globals support Element/HTMLElement/HTMLButtonElement instanceof, DOMParser, sync document listener, and error isolation across plugins', async () => {
    const store = makeMapStore();
    const adapter = adapterMod.createPluginAdapter({
        persistDisabled: true,
        getBackendConfig: () => ({ backendPlugins: {} }),
        saveBackendConfig: () => {},
        getFallbackSnapshot: () => ({
            charIndex: 0,
            chatIndex: 0,
            chatId: 'chat-dom-1',
            messages: [
                { index: 0, role: 'char', chatId: 'msg-dom-0', data: 'hello <button data-act="go">Go</button>', html: '<button data-act="go">Go</button>' },
            ],
        }),
        hostRpc: {
            isConnected: () => true,
            invoke: async (op, args) => {
                if (op === 'pluginStorage.setItem') { store.map.set(args[0], args[1]); return true; }
                if (op === 'pluginStorage.getItem') return store.map.has(args[0]) ? store.map.get(args[0]) : null;
                return null;
            },
        },
    });

    try {
        await adapter.addCustomPlugin({
            filename: 'sync_dom_plugin.js',
            enabled: true,
            script: `
//@name sync_dom_plugin
//@display-name Sync DOM Plugin
//@api 3.0
(() => {
  const parsed = new DOMParser().parseFromString('<div class="wrap"><span id="hi">ok</span></div>', 'text/html');
  const ce = new CustomEvent('ping', { detail: { ok: true } });
  document.addEventListener('click', (e) => {
    const t = e.target;
    const btn = t && typeof t.closest === 'function' ? t.closest('button') : null;
    const checks = {
      isEl: t instanceof Element,
      isHtmlEl: t instanceof HTMLElement,
      isNode: t instanceof Node,
      isBtn: t instanceof HTMLButtonElement,
      isNotImg: !(t instanceof HTMLImageElement),
      isEv: e instanceof Event,
      isMouse: e instanceof MouseEvent,
      hasBtn: Boolean(btn && btn.getAttribute('data-act') === 'go'),
      parsedOk: Boolean(parsed.getElementById('hi') && parsed.getElementById('hi').textContent === 'ok'),
      ceOk: (ce instanceof CustomEvent) && (ce instanceof Event) && ce.detail && ce.detail.ok === true,
    };
    void risuai.pluginStorage.setItem('sync_dom_checks', checks);
  });
})();
`,
        });

        await adapter.addCustomPlugin({
            filename: 'async_dom_plugin.js',
            enabled: true,
            script: `
//@name async_dom_plugin
//@display-name Async DOM Plugin
//@api 3.0
(async () => {
  const doc = await risuai.getRootDocument();
  await doc.addEventListener('click', async (ev) => {
    const t = ev.target;
    const btn = t && typeof t.closest === 'function' ? await t.closest('button') : null;
    await risuai.pluginStorage.setItem('async_dom_checks', {
      isEl: t instanceof Element,
      isHtmlEl: t instanceof HTMLElement,
      isNode: t instanceof Node,
      isBtn: t instanceof HTMLButtonElement,
      hasBtn: Boolean(btn && (await btn.getAttribute('data-act')) === 'go'),
    });
  });
})();
`,
        });

        await adapter.addCustomPlugin({
            filename: 'throwing_plugin.js',
            enabled: true,
            script: `
//@name throwing_plugin
//@display-name Throwing Plugin
//@api 3.0
(() => {
  document.addEventListener('click', () => {
    throw new Error('simulated listener boom');
  });
})();
`,
        });

        const res = await adapter.dispatchSurfaceAction({
            charIndex: 0,
            chatIndex: 0,
            msgIndex: 0,
            chatId: 'msg-dom-0',
            actionHtml: '<button data-act="go">Go</button>',
            dataset: { act: 'go' },
        });
        assert.equal(res.ok, true);
        assert.equal(res.dispatchedCount, 3);

        await waitUntil(() => store.map.has('sync_dom_checks') && store.map.has('async_dom_checks'));
        assert.deepEqual(store.map.get('sync_dom_checks'), {
            isEl: true,
            isHtmlEl: true,
            isNode: true,
            isBtn: true,
            isNotImg: true,
            isEv: true,
            isMouse: true,
            hasBtn: true,
            parsedOk: true,
            ceOk: true,
        });
        assert.deepEqual(store.map.get('async_dom_checks'), {
            isEl: true,
            isHtmlEl: true,
            isNode: true,
            isBtn: true,
            hasBtn: true,
        });
    } finally {
        await adapter.dispose();
    }
});

test('prepareFloatingPopupWidgets includes idle x-am-count-visible=false widgets and survives toggle errors', async () => {
    const adapter = adapterMod.createPluginAdapter({
        persistDisabled: true,
        getBackendConfig: () => ({ backendPlugins: {} }),
        saveBackendConfig: () => {},
        getFallbackSnapshot: () => ({ charIndex: 0, chatIndex: 0, messages: [] }),
    });

    try {
        await adapter.addCustomPlugin({
            filename: 'idle_am_plugin.js',
            enabled: true,
            script: `
//@name idle_am_plugin
//@display-name Asset Maid Idle
//@api 3.0
(async () => {
  const doc = await risuai.getRootDocument();
  const host = await doc.createElement('div');
  await host.setAttribute('x-am-root-host', 'am-idle');
  await host.setInnerHTML(
    '<div data-am-count-region x-am-count-visible="false">' +
      '<div class="x-risu-am-generation-count" data-am-expanded="false">' +
        '<button type="button" data-am-runtime-generation-count-action="toggle" data-am-count-node="root-1">0</button>' +
      '</div>' +
    '</div>'
  );
  await doc.body.appendChild(host);
  await doc.addEventListener('click', () => {
    throw new Error('simulated toggle error');
  });
})();
`,
        });

        // Default poll state omits idle x-am-count-visible="false" widgets
        const idleState = adapter.getFloatingUiState();
        assert.equal(idleState.rootWidgets.length, 0);

        // prepareFloatingPopupWidgets returns the idle widget anyway and survives click errors
        const openState = await adapter.prepareFloatingPopupWidgets({ charIndex: 0, chatIndex: 0 });
        assert.equal(openState.rootWidgets.length, 1);
        assert.equal(openState.rootWidgets[0].pluginName, 'idle_am_plugin');
        assert.ok(openState.rootWidgets[0].html.includes('x-risu-am-generation-count'));
    } finally {
        await adapter.dispose();
    }
});

test('syncAndProjectChatSurface adds x-risu- class prefixes and collects projected surface styles', async () => {
    const adapter = adapterMod.createPluginAdapter({
        persistDisabled: true,
        getBackendConfig: () => ({ backendPlugins: {} }),
        saveBackendConfig: () => {},
        getFallbackSnapshot: () => ({ charIndex: 0, chatIndex: 0, messages: [] }),
    });

    try {
        await adapter.addCustomPlugin({
            filename: 'surface_prefix_style_plugin.js',
            enabled: true,
            script: `
//@name surface_prefix_style_plugin
//@display-name Surface Prefix & Style
//@api 3.0
(async () => {
  const doc = await risuai.getRootDocument();
  const st = await doc.createElement('style');
  await st.setInnerHTML('.x-risu-am-image { position: relative; } .am-hover-ctrl { display: flex; }');
  await doc.head.appendChild(st);

  const root = await doc.getRoot ? await doc.getRoot() : doc.body;
  const obs = await risuai.createMutationObserver(async () => {
    const imgs = await doc.querySelectorAll('.x-risu-am-image');
    for (const imgEl of imgs) {
      const hasCtrl = await imgEl.querySelector('.am-hover-ctrl');
      if (!hasCtrl) {
        const ctrl = await doc.createElement('button');
        await ctrl.setAttribute('class', 'am-hover-ctrl');
        await ctrl.setAttribute('data-am-image-action', 'prev');
        await ctrl.setInnerHTML('<');
        await imgEl.appendChild(ctrl);
      }
    }
  });
  await obs.observe(doc.body, { childList: true, subtree: true });
})();
`,
        });

        const snap = {
            charIndex: 0,
            chatIndex: 0,
            charName: 'Char',
            chatName: 'Chat',
            assetMap: {},
            messages: [
                {
                    index: 0,
                    role: 'char',
                    chatId: 'm-0',
                    text: 'img',
                    html: '<div class="am-image"><img class="am-image__media" src="a.png"></div>',
                },
            ],
        };
        const proj = await adapter.syncAndProjectChatSurface(snap);
        assert.ok(Array.isArray(proj.styles) && proj.styles.some((s) => s.includes('.x-risu-am-image')));
        assert.ok(proj.bodyHtmlByChatId['m-0'], 'prefixed .x-risu-am-image target must receive injected controls');
        assert.ok(proj.bodyHtmlByChatId['m-0'].includes('class="am-image"'));
        assert.ok(proj.bodyHtmlByChatId['m-0'].includes('data-am-image-action="prev"'));
    } finally {
        await adapter.dispose();
    }
});

test('inline floating toolbar toggle does not trigger activeOverlay while explicit modal does and registers modal catalog', async () => {
    const adapter = adapterMod.createPluginAdapter({
        persistDisabled: true,
        getBackendConfig: () => ({ backendPlugins: {} }),
        saveBackendConfig: () => {},
        getFallbackSnapshot: () => ({ charIndex: 0, chatIndex: 0, messages: [] }),
    });

    try {
        await adapter.addCustomPlugin({
            filename: 'am_overlay_policy_test.js',
            enabled: true,
            script: `
//@name am_overlay_policy_test
//@display-name Asset Maid Overlay Policy Test
//@api 3.0
(async () => {
  const doc = await risuai.getRootDocument();
  const host = await doc.createElement('div');
  await host.setAttribute('x-am-root-host', 'am-host');
  await host.setInnerHTML(
    '<div data-am-count-region x-am-count-visible="true">' +
      '<div class="x-risu-am-generation-count" data-am-expanded="false">' +
        '<div class="x-risu-am-generation-count__panel-anchor">' +
          '<div class="x-risu-am-generation-count__panel">' +
            '<button type="button" data-am-action="open-gallery">삽화</button>' +
          '</div>' +
        '</div>' +
        '<button type="button" data-am-runtime-generation-count-action="toggle" data-am-count-node="cnt-1">1-3</button>' +
      '</div>' +
    '</div>'
  );
  await doc.body.appendChild(host);

  await doc.addEventListener('click', async (ev) => {
    const t = ev && ev.target;
    if (!t || typeof t.getAttribute !== 'function') return;
    const toggleAct = await t.getAttribute('data-am-runtime-generation-count-action');
    if (toggleAct === 'toggle') {
      const cnt = await doc.querySelector('.x-risu-am-generation-count');
      if (cnt) {
        const cur = await cnt.getAttribute('data-am-expanded');
        await cnt.setAttribute('data-am-expanded', cur === 'true' ? 'false' : 'true');
      }
      return;
    }
    const amAct = await t.getAttribute('data-am-action');
    if (amAct === 'open-gallery') {
      let vp = await doc.querySelector('[data-am-floating-viewport]');
      if (!vp) {
        vp = await doc.createElement('div');
        await vp.setAttribute('data-am-floating-viewport', 'true');
        await doc.body.appendChild(vp);
      }
      await vp.setInnerHTML('<div class="am-inspector-modal" role="dialog"><h3>전체 삽화 관리</h3><button type="button">닫기</button></div>');
    }
  });
})();
`,
        });

        // 1) Toggling 1-3 expands inline bar ONLY -> activeOverlay must remain null
        const toggleRes = await adapter.dispatchRootWidgetClick({
            pluginName: 'am_overlay_policy_test',
            charIndex: 0,
            chatIndex: 0,
            selector: '[data-am-runtime-generation-count-action="toggle"]',
            countNode: 'cnt-1',
        });
        assert.equal(toggleRes.ok, true);
        assert.equal(toggleRes.activeOverlay, null, 'expanding inline toolbar must NOT produce fullscreen activeOverlay');

        // 2) Opening explicit modal DOES produce activeOverlay with metadata + registers modals in floatingUiState
        const openRes = await adapter.dispatchRootWidgetClick({
            pluginName: 'am_overlay_policy_test',
            charIndex: 0,
            chatIndex: 0,
            dataset: { 'data-am-action': 'open-gallery' },
        });
        assert.equal(openRes.ok, true);
        assert.equal(openRes.overlayChanged, true);
        assert.ok(openRes.activeOverlay && openRes.activeOverlay.html.includes('am-inspector-modal'));
        assert.equal(openRes.activeOverlay.modalKey, 'am-inspector-modal');
        assert.equal(openRes.activeOverlay.modalLabel, '전체 삽화 관리');
        assert.equal(openRes.activeOverlay.autoPopup, true);

        const uiState = adapter.getFloatingUiState({ includeIdleWidgets: true });
        assert.ok(uiState.rootWidgets.length >= 1);
        const modals = uiState.rootWidgets[0].modals || [];
        assert.ok(modals.some((m) => m.key === 'floating-bar' && m.autoPopup === false));
        assert.ok(modals.some((m) => m.key === 'am-inspector-modal' && m.autoPopup === true));
    } finally {
        await adapter.dispose();
    }
});

test('runtime recall aggregates multi-hook injections, skips non-model no-ops, tracks bodyIntercepter, and recommends current-chat recall', async () => {
    const fakeDb = {
        characters: [
            {
                name: '지원',
                chats: [
                    { id: 'chat-a-uuid', name: 'Chat A', message: [{ role: 'user', data: '안녕', chatId: 'm1' }] },
                    { id: 'chat-b-uuid', name: 'Chat B', message: [{ role: 'user', data: '다른 방', chatId: 'm2' }] },
                ],
            },
        ],
    };
    const adapter = adapterMod.createPluginAdapter({
        persistDisabled: true,
        getBackendConfig: () => ({ backendPlugins: {} }),
        saveBackendConfig: () => {},
        hostRpc: {
            isConnected: () => true,
            invoke: async (method, args) => {
                if (method === 'db.getCharacter') return fakeDb.characters[args[0]];
                if (method === 'db.getChat') return fakeDb.characters[args[0]].chats[args[1]];
                return null;
            },
        },
    });

    try {
        // 1) Multi-hook plugin (2 beforeRequest hooks, second returns unchanged) + non-model call
        await adapter.addCustomPlugin({
            filename: 'hayaku_multi_hook.js',
            enabled: true,
            script: `
//@name hayaku_multi_hook
//@display-name HAYAKU Multi
//@api 3.0
risuai.addRisuReplacer('beforeRequest', async (msgs, mode) => {
  if (mode !== 'model') return msgs;
  const out = msgs.map((m) => ({ ...m }));
  out.splice(0, 0, { role: 'system', content: '[HAYAKU_HEAD]\\n장면 헤드' });
  out.splice(1, 0, { role: 'system', content: '[HAYAKU_MEM]\\n회상 기억 1' });
  out.splice(2, 0, { role: 'system', content: '[HAYAKU_CONSTRAINTS]\\n제약 조건' });
  return out;
});
risuai.addRisuReplacer('beforeRequest', async (msgs) => {
  // Second hook intentionally leaves messages unchanged
  return msgs;
});
`,
        });

        // 2) Body-intercepter-only plugin + paired beforeRequest+bodyIntercepter plugin
        await adapter.addCustomPlugin({
            filename: 'body_only_plugin.js',
            enabled: true,
            script: `
//@name body_only_plugin
//@display-name Body Only
//@api 3.0
risuai.registerBodyIntercepter(async (body, type) => {
  if (type === 'anthropic') {
    const sys = Array.isArray(body.system) ? [...body.system] : [{ type: 'text', text: String(body.system || '') }];
    sys.push({ type: 'text', text: '[BODY_ANTHROPIC_RECALL]\\n기억 주입' });
    return { ...body, system: sys };
  }
  if (type === 'gemini') {
    const contents = Array.isArray(body.contents) ? [...body.contents] : [];
    contents.unshift({ role: 'user', parts: [{ text: '[BODY_GEMINI_RECALL]\\n제미니 기억' }] });
    return { ...body, contents };
  }
  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  messages.splice(0, 0, { role: 'system', content: '[BODY_OPENAI_RECALL]\\n오픈AI 기억' });
  return { ...body, messages };
});
`,
        });

        await adapter.addCustomPlugin({
            filename: 'hybrid_plugin.js',
            enabled: true,
            script: `
//@name hybrid_plugin
//@display-name Hybrid
//@api 3.0
risuai.addRisuReplacer('beforeRequest', async (msgs, mode) => {
  if (mode !== 'model') return msgs;
  return [{ role: 'system', content: '[HYBRID_BEFORE]\\n전처리 주입' }, ...msgs];
});
risuai.registerBodyIntercepter(async (body, type) => {
  if (type !== 'openai') return body;
  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  messages.push({ role: 'system', content: '[HYBRID_BODY]\\n본문 인터셉트 주입' });
  return { ...body, messages };
});
`,
        });

        // Turn on Chat A
        await adapter.prepareTurn(0, 0);
        const baseMsgs = [
            { role: 'system', content: 'System base' },
            { role: 'user', content: [{ type: 'text', text: '오늘 어땠어?' }] },
        ];
        const afterBefore = await adapter.runBeforeRequest(baseMsgs, 'model');
        assert.ok(afterBefore.some((m) => String(m.content).includes('[HAYAKU_HEAD]')));

        // Non-'model' call (e.g. auxiliary submodel) must NOT overwrite Chat A's recall with 0 chars
        await adapter.runBeforeRequest([{ role: 'user', content: 'aux prompt' }], 'submodel');

        // Body intercepter on OpenAI in the same turn
        await adapter.runBodyIntercepters({
            model: 'gpt-test',
            messages: afterBefore.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '오늘 어땠어?' })),
        }, 'openai');
        adapter.endTurn();

        // Check multi-hook aggregation on hayaku_multi_hook
        const hayakuChatA = adapter.getPluginRuntimeRecall('hayaku_multi_hook', { chatUuid: 'chat-a-uuid' });
        assert.equal(hayakuChatA.beforeRequestRuns, 2);
        assert.equal(hayakuChatA.history.length, 1, '2 hooks in one model request aggregate to 1 entry and submodel no-op is skipped');
        assert.equal(hayakuChatA.history[0].injectedCount, 3);
        assert.ok(hayakuChatA.history[0].totalInjectedChars > 30);
        assert.equal(hayakuChatA.recommendedIndex, 0);

        // Check hybrid_plugin merged beforeRequest + bodyIntercepter in same turn
        const hybridRecall = adapter.getPluginRuntimeRecall('hybrid_plugin', { chatUuid: 'chat-a-uuid' });
        assert.equal(hybridRecall.history.length, 1);
        assert.equal(hybridRecall.history[0].kind, 'beforeRequest+bodyIntercepter');
        assert.equal(hybridRecall.history[0].injectedCount, 2);
        assert.ok(hybridRecall.history[0].injectedBlocks.some((b) => b.text.includes('[HYBRID_BEFORE]')));
        assert.ok(hybridRecall.history[0].injectedBlocks.some((b) => b.text.includes('[HYBRID_BODY]')));

        // Check body_only_plugin across OpenAI, Anthropic, Gemini
        await adapter.prepareTurn(0, 0);
        await adapter.runBodyIntercepters({
            system: [{ type: 'text', text: 'Anthropic sys' }],
            messages: [{ role: 'user', content: 'hi' }],
        }, 'anthropic');
        await adapter.runBodyIntercepters({
            systemInstruction: { parts: [{ text: 'Gemini sys' }] },
            contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        }, 'gemini');
        adapter.endTurn();

        const bodyOnlyRecall = adapter.getPluginRuntimeRecall('body_only_plugin', { chatUuid: 'chat-a-uuid' });
        assert.equal(bodyOnlyRecall.bodyIntercepterRuns, 3);
        assert.equal(bodyOnlyRecall.history.length, 2);
        assert.equal(bodyOnlyRecall.history[0].injectedCount, 2);
        assert.ok(bodyOnlyRecall.history[0].injectedBlocks.some((b) => b.text.includes('[BODY_ANTHROPIC_RECALL]')));
        assert.ok(bodyOnlyRecall.history[0].injectedBlocks.some((b) => b.text.includes('[BODY_GEMINI_RECALL]')));
        assert.equal(bodyOnlyRecall.history[1].injectedCount, 1);
        assert.ok(bodyOnlyRecall.history[1].injectedBlocks.some((b) => b.text.includes('[BODY_OPENAI_RECALL]')));

        // Simulate a newer 0-char run on Chat B: Chat A must still recommend & report non-zero for chat-a-uuid
        await adapter.prepareTurn(0, 1);
        await adapter.runBeforeRequest([{ role: 'user', content: 'empty' }], 'other');
        // Force a 0-char 'model' entry on Chat B by disabling injection via custom script? Instead invoke model with a 0-char plugin:
        adapter.endTurn();
        // Also test direct 0-char model turn on Chat B with a plugin that skips Chat B
        await adapter.addCustomPlugin({
            filename: 'chat_scoped_plugin.js',
            enabled: true,
            script: `
//@name chat_scoped_plugin
//@display-name Chat Scoped
//@api 3.0
risuai.addRisuReplacer('beforeRequest', async (msgs) => {
  const ch = await risuai.getChat();
  if (ch && ch.id === 'chat-a-uuid') {
    return [{ role: 'system', content: '[SCOPED_RECALL]\\nChat A 기억' }, ...msgs];
  }
  return msgs;
});
`,
        });
        await adapter.prepareTurn(0, 0);
        await adapter.runBeforeRequest([{ role: 'user', content: 'A' }], 'model');
        adapter.endTurn();
        await adapter.prepareTurn(0, 1);
        await adapter.runBeforeRequest([{ role: 'user', content: 'B' }], 'model');
        adapter.endTurn();

        const scopedForA = adapter.getPluginRuntimeRecall('chat_scoped_plugin', { chatUuid: 'chat-a-uuid' });
        assert.equal(scopedForA.history.length, 2);
        assert.equal(scopedForA.history[0].totalInjectedChars, 0);
        assert.equal(scopedForA.history[1].matchesCurrentChat, true);
        assert.ok(scopedForA.history[1].totalInjectedChars > 0);
        assert.equal(scopedForA.recommendedIndex, 1);

        const listForA = adapter.getPluginRuntimeRecall('', { chatUuid: 'chat-a-uuid' });
        const scopedSummary = listForA.find((p) => p.pluginName === 'chat_scoped_plugin');
        assert.ok(scopedSummary);
        assert.equal(scopedSummary.latestInjectedCount, 1);
        assert.ok(scopedSummary.latestInjectedChars > 0);
        assert.equal(scopedSummary.matchesCurrentChat, true);
    } finally {
        await adapter.dispose();
    }
});

test('pickPreferredPluginGuiEntry prioritizes main GUI / setting entries over input-compose action buttons', () => {
    // 1) registerButton(action: 인풋 작성하기) registered BEFORE registerSetting(GRADIA 설정)
    const entries1 = [
        { id: 'ui_btn_1', kind: 'button', location: 'action', name: 'GRADIA로 인풋 작성하기' },
        { id: 'ui_set_1', kind: 'setting', location: 'setting', name: 'GRADIA 설정' },
    ];
    assert.equal(adapterMod.pickPreferredPluginGuiEntry(entries1, '').id, 'ui_set_1');

    // 2) Two registerButton entries: action input compose vs hamburger main GUI
    const entries2 = [
        { id: 'ui_btn_1', kind: 'button', location: 'action', name: 'GRADIA로 인풋 작성하기' },
        { id: 'ui_btn_2', kind: 'button', location: 'hamburger', name: 'GRADIA' },
    ];
    assert.equal(adapterMod.pickPreferredPluginGuiEntry(entries2, '').id, 'ui_btn_2');

    // 3) Explicit targetId (by id or name) overrides default heuristic
    assert.equal(adapterMod.pickPreferredPluginGuiEntry(entries1, 'ui_btn_1').id, 'ui_btn_1');
    assert.equal(adapterMod.pickPreferredPluginGuiEntry(entries1, 'GRADIA로 인풋 작성하기').id, 'ui_btn_1');

    // 4) Generated srcdoc includes pickPreferredEntry & __rsGuiActiveEntry and compiles cleanly
    const html = adapterMod.buildPluginGuiSrcdoc({
        plugin: {
            name: 'GRADIA',
            displayName: 'GRADIA v1.3.0',
            script: 'Risuai.registerButton({ name: "GRADIA로 인풋 작성하기", location: "action" }, () => {}); Risuai.registerSetting("GRADIA 설정", () => {});',
            uiItems: entries1,
        },
        entryId: '',
        theme: 'dark',
    });
    assert.ok(html.includes('pickPreferredEntry'));
    assert.ok(html.includes('__rsGuiActiveEntry'));
    assert.ok(html.includes('MAX_AUTO_OPEN_WAIT_MS'));
    const scripts = [];
    const re = /<script(?:\s+([^>]*))?>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        if (!(m[1] || '').includes('__rs_')) scripts.push(m[2]);
    }
    assert.equal(scripts.length, 1);
    new vm.Script(scripts[0], { filename: 'plugin-gui-runtime-gradia.js' });
});

test('synchronous localStorage & sessionStorage work in Backend VM and GUI iframe srcdoc with webStorage RPC', async () => {
    const pluginStore = makeMapStore();
    const adapter = adapterMod.createPluginAdapter({
        persistDisabled: true,
        hostRpc: {
            isConnected: () => false,
            async invoke() { throw new Error('offline'); },
        },
    });
    try {
        await adapter.addCustomPlugin({
            filename: 'sync_web_storage_test.js',
            enabled: true,
            script: `
//@name sync_web_storage_test
//@display-name Sync Web Storage Test
//@api 3.0
//@version 1.0.0
(async () => {
  localStorage.setItem('gradia_run_log', JSON.stringify({ step: 1, label: 'ok' }));
  localStorage.gradia_prop = 'prop-val';
  sessionStorage.setItem('gradia_session', 'sess-42');
  const parsed = JSON.parse(localStorage.getItem('gradia_run_log'));
  if (parsed.step === 1 && localStorage.gradia_prop === 'prop-val' && localStorage.length === 2 && sessionStorage.getItem('gradia_session') === 'sess-42') {
    await risuai.pluginStorage.setItem('sync_ok', true);
  }
})();
`,
        });

        await waitUntil(async () => (await adapter._debug.fallbackPluginStore.get('sync_ok')) === 'true');
        assert.equal(adapter._debug.webLocalStore.get('gradia_run_log'), JSON.stringify({ step: 1, label: 'ok' }));
        assert.equal(adapter._debug.webLocalStore.get('gradia_prop'), 'prop-val');
        assert.equal(adapter._debug.webSessionStore.get('gradia_session'), 'sess-42');

        const { srcdoc } = adapter.getGuiSrcdoc('sync_web_storage_test', '', 'dark');
        assert.ok(srcdoc.includes('webLocalSnapshot'));
        assert.ok(srcdoc.includes('gradia_run_log'));
        assert.ok(srcdoc.includes('gradia_session'));
        assert.ok(srcdoc.includes('makeIframeWebStorage'));

        const scripts = [];
        const re = /<script(?:\s+([^>]*))?>([\s\S]*?)<\/script>/gi;
        let m;
        while ((m = re.exec(srcdoc)) !== null) {
            if (!(m[1] || '').includes('__rs_')) scripts.push(m[2]);
        }
        assert.equal(scripts.length, 1);
        new vm.Script(scripts[0], { filename: 'plugin-gui-webstorage.js' });

        await adapter.handleGuiRpc({
            pluginName: 'sync_web_storage_test',
            method: 'webStorage.setItem',
            args: ['local', 'from_gui', 'gui-val'],
        });
        assert.equal(adapter._debug.webLocalStore.get('from_gui'), 'gui-val');
    } finally {
        await adapter.dispose();
    }
});

test('offline storage persistence, dirty replay on PC reconnect, in-place bodyIntercepter mutation, and persistDisabled safety', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-plg-persist-'));
    const storagePath = path.join(tmpDir, 'storage.json');
    const ledgerPath = path.join(tmpDir, 'ledger.json');
    const replayed = [];
    let rpcConnected = false;

    const adapter1 = adapterMod.createPluginAdapter({
        storagePath,
        ledgerPath,
        persistDisabled: false,
        hostRpc: {
            isConnected: () => rpcConnected,
            async invoke(op, args) {
                if (!rpcConnected) throw new Error('RPC offline');
                replayed.push({ op, args });
                if (op === 'pluginStorage.getItem') return null;
                if (op === 'pluginStorage.keys') return [];
                if (op === 'db.getCharacter') return { name: 'Char', chats: [{ id: 'c1', message: [] }] };
                if (op === 'db.getChat') return { id: 'c1', message: [] };
                return true;
            },
        },
    });
    try {
        await adapter1.addCustomPlugin({
            filename: 'offline_persist_test.js',
            enabled: true,
            script: `
//@name offline_persist_test
//@display-name Offline Persist
//@api 3.0
(async () => {
  await risuai.pluginStorage.setItem('offline_key', { count: 7 });
  localStorage.setItem('ls_key', 'ls_val');
  await risuai.registerBodyIntercepter(async (body) => {
    body.messages.push({ role: 'system', content: '[INPLACE_BODY]' });
    // returns undefined intentionally to test in-place mutation preservation
  });
})();
`,
        });
        await waitUntil(() => adapter1._debug.dirtyStoreOps.has('pluginStorage\0offline_key'));

        await adapter1.prepareTurn(0, 0);
        const bodyOut = await adapter1.runBodyIntercepters({ messages: [{ role: 'user', content: 'hi' }] }, 'openai');
        assert.ok(bodyOut.messages.some((m) => m.content === '[INPLACE_BODY]'), 'In-place mutation by bodyIntercepter returning undefined must be preserved');
        adapter1.endTurn();

        const recall1 = adapter1.getPluginRuntimeRecall('offline_persist_test');
        assert.equal(recall1.bodyIntercepterRuns, 1);
        assert.ok(recall1.storageWrites >= 2);
        assert.ok(recall1.recentStorageKeys.includes('pluginStorage:offline_key'));
    } finally {
        await adapter1.dispose();
    }

    assert.equal(fs.existsSync(storagePath), true);
    assert.equal(fs.existsSync(ledgerPath), true);

    // Boot second adapter from disk and replay when RPC connects
    const adapter2 = adapterMod.createPluginAdapter({
        storagePath,
        ledgerPath,
        persistDisabled: false,
        hostRpc: {
            isConnected: () => rpcConnected,
            async invoke(op, args) {
                replayed.push({ op, args });
                return op === 'pluginStorage.getItem' ? null : true;
            },
        },
    });
    try {
        const recall2 = adapter2.getPluginRuntimeRecall('offline_persist_test');
        assert.equal(recall2.bodyIntercepterRuns, 1);
        assert.ok(recall2.storageWrites >= 2);
        assert.equal(adapter2._debug.webLocalStore.get('ls_key'), 'ls_val');
        assert.equal(JSON.parse(adapter2._debug.fallbackPluginStore.get('offline_key')).count, 7);

        rpcConnected = true;
        const flushRes = await adapter2.flushDirtyStoreOps();
        assert.ok(flushRes.flushed >= 1);
        assert.equal(flushRes.remaining, 0);
        assert.ok(replayed.some((x) => x.op === 'pluginStorage.setItem' && x.args[0] === 'offline_key' && x.args[1].count === 7));
    } finally {
        await adapter2.dispose();
    }

    // Verify persistDisabled: true never creates files on disk
    const noDiskStorage = path.join(tmpDir, 'nodisk-storage.json');
    const noDiskLedger = path.join(tmpDir, 'nodisk-ledger.json');
    const adapter3 = adapterMod.createPluginAdapter({
        storagePath: noDiskStorage,
        ledgerPath: noDiskLedger,
        persistDisabled: true,
        hostRpc: { isConnected: () => false, async invoke() { throw new Error('offline'); } },
    });
    try {
        await adapter3.addCustomPlugin({
            filename: 'nodisk.js',
            enabled: true,
            script: `//@name nodisk\n//@api 3.0\nrisuai.pluginStorage.setItem('k', 'v');`,
        });
        await waitUntil(() => adapter3._debug.fallbackPluginStore.has('k'));
    } finally {
        await adapter3.dispose();
    }
    assert.equal(fs.existsSync(noDiskStorage), false);
    assert.equal(fs.existsSync(noDiskLedger), false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('risustand.js PC Host RPC storage resilience: numeric length getter, key(i) enumeration, and prefixed fallback when safeLocalStorage/localPluginStorage unavailable', async () => {
    const psMap = new Map();
    const slMap = new Map([['sl_k1', 'sl_v1'], ['sl_k2', 'sl_v2']]);
    const numericPluginStore = {
        map: psMap,
        api: {
            async getItem(k) { return psMap.has(String(k)) ? psMap.get(String(k)) : null; },
            async setItem(k, v) { psMap.set(String(k), v); },
            async removeItem(k) { psMap.delete(String(k)); },
            async clear() { psMap.clear(); },
            async keys() { return Array.from(psMap.keys()); },
            async key(i) { return Array.from(psMap.keys())[Number(i)] ?? null; },
            get length() { return psMap.size; }, // numeric getter instead of async function
        },
    };
    const keyOnlySafeLocal = {
        map: slMap,
        api: {
            async getItem(k) { return slMap.has(String(k)) ? slMap.get(String(k)) : null; },
            async setItem(k, v) { slMap.set(String(k), String(v)); },
            async removeItem(k) { slMap.delete(String(k)); },
            async clear() { slMap.clear(); },
            // intentionally omit keys() to verify key(i) fallback
            async key(i) { return Array.from(slMap.keys())[Number(i)] ?? null; },
            get length() { return slMap.size; },
        },
    };
    const mockDb = { characters: [{ name: 'C', desc: '', chats: [{ message: [], note: '' }] }], plugins: [] };
    const tok = 'rpc-resilience-tok';
    const server = relay.createRelayServer({ token: tok, configOverride: { backendPlugins: {} } });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const relayPort = server.address().port;
    const vmBridge = bootRisuStandInVm({
        relayPort,
        token: tok,
        mockDb,
        pluginStore: numericPluginStore,
        safeLocalStore: keyOnlySafeLocal,
        localPluginStore: null, // unavailable -> falls back to prefixed pluginStorage
    });
    try {
        const authHeaders = { 'X-RisuStand-Token': tok, 'Content-Type': 'application/json' };
        await waitUntil(async () => {
            const st = JSON.parse((await requestHttp(relayPort, { path: '/api/plugins', headers: authHeaders })).body);
            return st.pcConnected && st.rpcConnected;
        });

        // 1) numeric length getter on pluginStorage + key(i) on safeLocalStorage
        const upRes = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/upload',
            headers: authHeaders,
            body: JSON.stringify({
                filename: 'rpc_res_test.js',
                enabled: true,
                script: '//@name rpc_res_test\n//@api 3.0\nrisuai.registerSetting("R", () => {});',
            }),
        });
        assert.equal(upRes.status, 200);

        await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/gui-rpc',
            headers: authHeaders,
            body: JSON.stringify({ pluginName: 'rpc_res_test', method: 'pluginStorage.setItem', args: ['k_num', 'v_num'] }),
        });
        const psLenRes = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/gui-rpc',
            headers: authHeaders,
            body: JSON.stringify({ pluginName: 'rpc_res_test', method: 'pluginStorage.length', args: [] }),
        });
        assert.ok(JSON.parse(psLenRes.body).value >= 1);

        const slKeysRes = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/gui-rpc',
            headers: authHeaders,
            body: JSON.stringify({ pluginName: 'rpc_res_test', method: 'safeLocalStorage.keys', args: [] }),
        });
        assert.deepEqual(JSON.parse(slKeysRes.body).value, ['sl_k1', 'sl_k2']);

        // 2) localPluginStorage unavailable -> fallback to prefixed pluginStorage (does not silently drop writes)
        const lpsSetRes = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/gui-rpc',
            headers: authHeaders,
            body: JSON.stringify({ pluginName: 'rpc_res_test', method: 'localPluginStorage.setItem', args: ['lps_fb_key', { ok: 123 }] }),
        });
        assert.equal(lpsSetRes.status, 200);
        const lpsGetRes = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/gui-rpc',
            headers: authHeaders,
            body: JSON.stringify({ pluginName: 'rpc_res_test', method: 'localPluginStorage.getItem', args: ['lps_fb_key'] }),
        });
        assert.deepEqual(JSON.parse(lpsGetRes.body).value, { ok: 123 });
        const lpsKeysRes = await requestHttp(relayPort, {
            method: 'POST',
            path: '/api/plugins/gui-rpc',
            headers: authHeaders,
            body: JSON.stringify({ pluginName: 'rpc_res_test', method: 'localPluginStorage.keys', args: [] }),
        });
        assert.deepEqual(JSON.parse(lpsKeysRes.body).value, ['lps_fb_key']);
        assert.ok(psMap.has('__rs_lps_fb__:lps_fb_key'));
    } finally {
        await vmBridge.shutdown();
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        await new Promise((r) => server.close(r));
    }
});

test('dispatchChatOutput defers endTurn while async chatOutput writes pluginStorage and moduleAdapter.syncTurnObjects preserves setChat mutations', async () => {
    const modAdapterMod = require('../risustand-module-adapter.cjs');
    const modAdapter = modAdapterMod.createModuleAdapter();
    const initialChar = { name: 'Char', chats: [{ id: 'c1', message: [], note: 'initial' }] };
    await modAdapter.prepareTurn({
        charIndex: 0,
        chatIndex: 0,
        charObj: JSON.parse(JSON.stringify(initialChar)),
        chatObj: JSON.parse(JSON.stringify(initialChar.chats[0])),
        modulesOverride: [],
        globalVarsOverride: {},
    });
    const updatedChat = { id: 'c1', message: [{ role: 'char', data: 'hi' }], note: 'updated-by-plugin' };
    modAdapter.syncTurnObjects({ chatObj: updatedChat });
    const outTrig = await modAdapter.runTriggerMode('output');
    assert.equal(outTrig.handled, false);
    assert.equal(updatedChat.note, 'updated-by-plugin');
    modAdapter.endTurn();
    modAdapter.dispose();

    let slowFinished = false;
    const adapter = adapterMod.createPluginAdapter({
        persistDisabled: true,
        hostRpc: {
            isConnected: () => false,
            async invoke() { throw new Error('offline'); },
        },
        getFallbackSnapshot: () => ({ charIndex: 0, chatIndex: 0, charName: 'Char', messages: [] }),
    });
    try {
        await adapter.addCustomPlugin({
            filename: 'slow_chat_output.js',
            enabled: true,
            script: `
//@name slow_chat_output
//@api 3.0
risuai.addRisuChatListener('output', async () => {
  await new Promise((r) => setTimeout(r, 80));
  await risuai.pluginStorage.setItem('after_slow_output', 'persisted');
});
`,
        });
        await adapter.prepareTurn(0, 0);
        const dispProm = adapter.dispatchChatOutput({ charIndex: 0, chatIndex: 0, messageIndex: 0 }).then(() => {
            slowFinished = true;
        });
        adapter.endTurn(); // deferred while pendingChatOutputs > 0
        assert.equal(adapter.getTurnContext().active, true, 'endTurn must defer while chatOutput is in flight');
        await dispProm;
        await waitUntil(() => slowFinished && !adapter.getTurnContext().active);
        assert.equal(JSON.parse(adapter._debug.fallbackPluginStore.get('after_slow_output')), 'persisted');
    } finally {
        await adapter.dispose();
    }
});

test('live Backend VM GUI projection exposes in-memory plugin state across turns, strips scripts, handles events, and serves HTTP endpoints', async () => {
    const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                id: 'live-gui-up',
                model: 'mock',
                choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            }));
        });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = upstream.address().port;

    const tok = 'live-gui-tok';
    const authHeaders = { 'X-RisuStand-Token': tok, 'Content-Type': 'application/json' };
    const server = relay.createRelayServer({
        token: tok,
        configOverride: {
            activeProfileId: 'mock-openai',
            directPresetId: '',
            backendPlugins: {},
            profiles: [{
                id: 'mock-openai',
                name: 'Mock',
                providerType: 'openai_compat',
                baseUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
                apiKey: 'sk-test',
                model: 'mock-model',
            }],
        },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const pluginScript = `
//@name live_memory_gui_test
//@display-name Live Memory GUI Test
//@api 3.0
//@version 1.0.0
(async () => {
  // Stored ONLY in VM RAM (never written to pluginStorage)
  let runCount = 0;
  let lastDraft = '';
  let activeTab = 'overview';
  let searchFilter = '';
  let modalEl = null;

  await risuai.addRisuReplacer('beforeRequest', async (msgs) => {
    runCount += 1;
    const lastUser = [...(msgs || [])].reverse().find((m) => m && m.role === 'user');
    lastDraft = 'SHADOW_ACT #' + runCount + ': ' + (lastUser ? lastUser.content : '');
    return msgs;
  });

  await risuai.registerButton({ name: '인풋 작성', location: 'action' }, async () => {
    // action button should NOT win over registerSetting when entryId is empty
  });

  function renderModal() {
    if (!modalEl) return;
    const escaped = String(lastDraft).replace(/</g, '&lt;');
    const bodyHtml = activeTab === 'results'
      ? '<div id="tab-results"><details id="det"><summary id="det-sum">기억 조회 상세</summary><div id="det-body">' + escaped + ' | filter=' + searchFilter + '</div></details></div>'
      : '<div id="tab-overview">Overview Count: ' + runCount + '</div>';
    modalEl.innerHTML =
      '<div class="live-shell">' +
        '<button type="button" data-tab="overview">개요</button>' +
        '<button type="button" data-tab="results" onclick="evilInline()">실행 결과</button>' +
        '<input id="live-filter" type="text" value="' + searchFilter + '" />' +
        '<button type="button" id="live-close-btn">닫기</button>' +
        bodyHtml +
        '<script>window.__xss = 1;</script>' +
      '</div>';
    const inp = modalEl.querySelector('#live-filter');
    if (inp) {
      inp.addEventListener('input', (e) => {
        searchFilter = String(e.target.value || '');
        const out = modalEl.querySelector('#det-body');
        if (out) out.textContent = lastDraft + ' | filter=' + searchFilter;
      });
    }
    const closeBtn = modalEl.querySelector('#live-close-btn');
    if (closeBtn) {
      closeBtn.onclick = async () => {
        if (modalEl) { modalEl.remove(); modalEl = null; }
        await risuai.hideContainer();
      };
    }
  }

  await risuai.registerSetting('메인 설정', async () => {
    const st = document.createElement('style');
    st.textContent = '.live-shell { color: #e2e8f0; }';
    document.head.appendChild(st);
    modalEl = document.createElement('div');
    modalEl.id = 'live-gui-root';
    modalEl.addEventListener('click', (e) => {
      const tabBtn = e.target && e.target.closest ? e.target.closest('[data-tab]') : null;
      if (tabBtn) {
        activeTab = tabBtn.getAttribute('data-tab') || 'overview';
        renderModal();
      }
    });
    renderModal();
    document.body.appendChild(modalEl);
    await risuai.showContainer();
  }, '⚡', 'html');
})();
`;

    const pluginStore = makeMapStore();
    const safeLocalStore = makeMapStore();
    const localPluginStore = makeMapStore();
    const mockDb = {
        characters: [{
            name: 'Char',
            desc: '',
            personality: '',
            scenario: '',
            firstMessage: 'Hi',
            chats: [{ id: 'chat-live-1', name: 'Chat 1', message: [{ role: 'user', data: 'prev', chatId: 'm0' }], note: '' }],
        }],
        plugins: [],
    };
    const vmBridge = bootRisuStandInVm({
        relayPort: port,
        token: tok,
        mockDb,
        pluginStore,
        safeLocalStore,
        localPluginStore,
    });

    try {
        // 1) Auth enforcement & wait for PC bridge snapshot sync
        const unauth = await requestHttp(port, { path: '/api/plugins/live-gui-srcdoc?name=live_memory_gui_test' });
        assert.equal(unauth.status, 401);

        await waitUntil(async () => {
            const st = JSON.parse((await requestHttp(port, { path: '/api/state', headers: authHeaders })).body);
            return st.snapshot && st.snapshot.charIndex === 0;
        });

        // 2) Upload & enable plugin
        const upRes = await requestHttp(port, {
            method: 'POST',
            path: '/api/plugins/upload',
            headers: authHeaders,
            body: JSON.stringify({ filename: 'live_memory_gui_test.js', script: pluginScript, enabled: true }),
        });
        assert.equal(upRes.status, 200);

        // 3) Compile check viewer srcdoc
        const viewerRes = await requestHttp(port, {
            path: '/api/plugins/live-gui-srcdoc?name=live_memory_gui_test&theme=dark',
            headers: authHeaders,
        });
        assert.equal(viewerRes.status, 200);
        const viewerJson = JSON.parse(viewerRes.body);
        assert.ok(viewerJson.srcdoc.includes('__rsLiveGuiRender'));
        assert.ok(viewerJson.srcdoc.includes('__rsLiveGuiEvent'));
        const vScripts = [];
        const re = /<script(?:\s+([^>]*))?>([\s\S]*?)<\/script>/gi;
        let m;
        while ((m = re.exec(viewerJson.srcdoc)) !== null) {
            if (!(m[1] || '').includes('__rs_live_')) vScripts.push(m[2]);
        }
        assert.equal(vScripts.length, 1);
        new vm.Script(vScripts[0], { filename: 'live-gui-viewer-runtime.js' });

        // Run a real LLM turn via /api/chat/send so plugin's beforeRequest increments runCount in VM RAM
        const send1 = await requestHttp(port, {
            method: 'POST',
            path: '/api/chat/send',
            headers: authHeaders,
            body: JSON.stringify({ text: 'Turn1User', charIndex: 0, chatIndex: 0 }),
        });
        assert.equal(send1.status, 200);
        await waitUntil(async () => {
            const st = JSON.parse((await requestHttp(port, { path: '/api/state', headers: authHeaders })).body);
            return !st.directGenerating && mockDb.characters[0].chats[0].message.length >= 3;
        });

        // 4) Open live GUI via HTTP -> picks registerSetting ('메인 설정'), renders Overview Count: 1, strips script/onclick
        const open1Res = await requestHttp(port, {
            method: 'POST',
            path: '/api/plugins/live-gui-open',
            headers: authHeaders,
            body: JSON.stringify({ pluginName: 'live_memory_gui_test' }),
        });
        assert.equal(open1Res.status, 200);
        const open1 = JSON.parse(open1Res.body);
        assert.equal(open1.ok, true);
        assert.equal(open1.entryName, '메인 설정');
        assert.ok(open1.html.includes('Overview Count: 1'));
        assert.ok(open1.styles.some((s) => s.includes('.live-shell')));
        assert.ok(!open1.html.includes('__xss'), '<script> must be stripped from serialized DOM');
        assert.ok(!open1.html.includes('evilInline'), 'on* attributes must be stripped');

        // 5) Click '실행 결과' tab (tests e.target.closest('[data-tab]') on sync listener)
        const tabMatch = open1.html.match(/<button[^>]*data-rs-vm-nid="(\d+)"[^>]*data-tab="results"/);
        assert.ok(tabMatch, 'Tab button must carry data-rs-vm-nid');
        const evTabRes = await requestHttp(port, {
            method: 'POST',
            path: '/api/plugins/live-gui-event',
            headers: authHeaders,
            body: JSON.stringify({ pluginName: 'live_memory_gui_test', eventType: 'click', nodeId: Number(tabMatch[1]) }),
        });
        const evTab = JSON.parse(evTabRes.body);
        assert.ok(evTab.html.includes('SHADOW_ACT #1: Turn1User'));

        // 6) Type into <input id="live-filter"> (tests input listener & live value sync)
        const inpMatch = evTab.html.match(/<input[^>]*data-rs-vm-nid="(\d+)"[^>]*id="live-filter"/);
        assert.ok(inpMatch);
        const evInpRes = await requestHttp(port, {
            method: 'POST',
            path: '/api/plugins/live-gui-event',
            headers: authHeaders,
            body: JSON.stringify({ pluginName: 'live_memory_gui_test', eventType: 'input', nodeId: Number(inpMatch[1]), value: 'abc' }),
        });
        const evInp = JSON.parse(evInpRes.body);
        assert.ok(evInp.html.includes('filter=abc'));

        // 7) Click <summary> inside <details> -> toggles open=""
        const sumMatch = evInp.html.match(/<summary[^>]*data-rs-vm-nid="(\d+)"/);
        assert.ok(sumMatch);
        const evDetRes = await requestHttp(port, {
            method: 'POST',
            path: '/api/plugins/live-gui-event',
            headers: authHeaders,
            body: JSON.stringify({ pluginName: 'live_memory_gui_test', eventType: 'click', nodeId: Number(sumMatch[1]) }),
        });
        const evDet = JSON.parse(evDetRes.body);
        assert.ok(/<details[^>]*\bopen=/.test(evDet.html), 'Clicking <summary> must toggle details[open]');

        // 8) Close live GUI (preserving VM RAM state), run Turn 2, re-open -> shows Turn 2 RAM draft
        const closeRes = await requestHttp(port, {
            method: 'POST',
            path: '/api/plugins/live-gui-close',
            headers: authHeaders,
            body: JSON.stringify({ pluginName: 'live_memory_gui_test' }),
        });
        assert.equal(closeRes.status, 200);

        const send2 = await requestHttp(port, {
            method: 'POST',
            path: '/api/chat/send',
            headers: authHeaders,
            body: JSON.stringify({ text: 'Turn2User', charIndex: 0, chatIndex: 0 }),
        });
        assert.equal(send2.status, 200);
        await waitUntil(async () => {
            const st = JSON.parse((await requestHttp(port, { path: '/api/state', headers: authHeaders })).body);
            return !st.directGenerating && mockDb.characters[0].chats[0].message.length >= 5;
        });

        const open2 = JSON.parse((await requestHttp(port, {
            method: 'POST',
            path: '/api/plugins/live-gui-open',
            headers: authHeaders,
            body: JSON.stringify({ pluginName: 'live_memory_gui_test' }),
        })).body);
        assert.ok(open2.html.includes('SHADOW_ACT #2: Turn2User'), 'Re-opening live GUI after Turn 2 must show updated RAM state');

        // 9) Clicking inline close button triggers hideContainer -> closed: true
        const closeBtnMatch = open2.html.match(/<button[^>]*data-rs-vm-nid="(\d+)"[^>]*id="live-close-btn"/);
        assert.ok(closeBtnMatch);
        const evClose = JSON.parse((await requestHttp(port, {
            method: 'POST',
            path: '/api/plugins/live-gui-event',
            headers: authHeaders,
            body: JSON.stringify({ pluginName: 'live_memory_gui_test', eventType: 'click', nodeId: Number(closeBtnMatch[1]) }),
        })).body);
        assert.equal(evClose.closed, true);
    } finally {
        await vmBridge.shutdown();
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        await new Promise((r) => server.close(r));
        await new Promise((r) => upstream.close(r));
    }
});

test('Backend VM enforces same-realm prototypes/Errors, DOM parity (style.setProperty, dataset, numeric querySelectorAll, innerText), and settles un-awaited async Live GUI loaders', async () => {
    const adapter = adapterMod.createPluginAdapter({
        persistDisabled: true,
        hostRpc: {
            isConnected: () => true,
            async invoke(op, args) {
                if (op === 'pluginStorage.getItem' && args[0] === 'k') {
                    await new Promise((r) => setTimeout(r, 120));
                    return { loaded: true, label: 'from-storage' };
                }
                if (op === 'pluginStorage.keys') return ['k'];
                if (op === 'localPluginStorage.getItem' && args[0] === 'lk') return { localOk: 42 };
                if (op === 'localPluginStorage.keys') return ['lk'];
                if (op === 'db.getCurrentIndices') return { charIndex: 0, chatIndex: 0 };
                if (op === 'db.getCharacter') return { name: 'Hero', chats: [{ id: 'ch-1', message: [{ role: 'user', data: 'hi' }] }] };
                if (op === 'db.getChat') return { id: 'ch-1', message: [{ role: 'user', data: 'hi' }] };
                if (op === 'db.getDatabase') {
                    await new Promise((r) => setTimeout(r, 120));
                    return { characters: [{ name: 'Hero', chats: [{ id: 'ch-1', message: [] }] }], plugins: [] };
                }
                return null;
            },
        },
    });

    try {
        await adapter.addCustomPlugin({
            filename: 'vm_realm_and_dom_parity.js',
            enabled: true,
            script: `
//@name vm_realm_and_dom_parity
//@display-name VM Realm & DOM Parity
//@api 3.0
(async () => {
  await risuai.addRisuChatListener((_ev) => {});

  const db = await risuai.getDatabase('all');
  const ch = await risuai.getCharacter();
  const chat = await risuai.getChat();
  const stVal = await risuai.pluginStorage.getItem('k');
  const stKeys = await risuai.pluginStorage.keys();
  const lps = await risuai.getLocalPluginStorage();
  const lpsVal = await lps.getItem('lk');
  const lpsKeys = await lps.keys();
  const lpsKey0 = await lps.key(0);
  const lpsLen = await lps.length();
  const scheme = await risuai.getColorScheme();
  const rInfo = await risuai.getRuntimeInfo();
  const cloned = structuredClone({ nested: { a: [1, 2] }, when: new Date(1000) });

  let rejectedErr = null;
  try {
    await risuai.addRisuReplacer('invalid_mode', () => {});
  } catch (e) {
    rejectedErr = e;
  }

  const realmChecks = {
    apiObj: (risuai instanceof Object),
    dbObj: (db instanceof Object && Object.getPrototypeOf(db) === Object.prototype),
    dbCharsArr: (db.characters instanceof Array && Object.getPrototypeOf(db.characters) === Array.prototype),
    charObj: (ch instanceof Object && Object.getPrototypeOf(ch) === Object.prototype),
    chatObj: (chat instanceof Object && Object.getPrototypeOf(chat) === Object.prototype),
    stObj: (stVal instanceof Object && Object.getPrototypeOf(stVal) === Object.prototype),
    stKeysArr: (stKeys instanceof Array && Object.getPrototypeOf(stKeys) === Array.prototype),
    lpsObj: (lps instanceof Object),
    lpsValObj: (lpsVal instanceof Object && Object.getPrototypeOf(lpsVal) === Object.prototype),
    lpsKeysArr: (lpsKeys instanceof Array && lpsKey0 === 'lk' && lpsLen === 1),
    schemeObj: (scheme instanceof Object && Object.getPrototypeOf(scheme) === Object.prototype && typeof scheme.bgcolor === 'string'),
    infoObj: (rInfo instanceof Object && Object.getPrototypeOf(rInfo) === Object.prototype),
    clonedObj: (cloned instanceof Object && Object.getPrototypeOf(cloned) === Object.prototype && cloned.nested instanceof Object && cloned.nested.a instanceof Array && cloned.when instanceof Date),
    errIsError: (rejectedErr instanceof Error),
  };

  risuai.registerSetting('Parity Settings', () => {
    document.documentElement.style.setProperty('--test-bg', '#123456');
    const root = document.createElement('div');
    root.id = 'parity-root';
    root.innerHTML = '<div class="item">1</div><div class="item">2</div>';
    document.body.appendChild(root);

    async function loadAsync() {
      const [loadedDb, loadedStore] = await Promise.all([
        risuai.getDatabase('all'),
        risuai.pluginStorage.getItem('k'),
      ]);
      const btn = document.createElement('button');
      btn.style.setProperty('--btn-color', '#22c55e');
      btn.dataset.tab = 'results';
      const label = document.createElement('span');
      label.innerText = 'loaded';
      btn.appendChild(label);
      root.appendChild(btn);
      const countEl = document.createElement('div');
      countEl.id = 'meta-out';
      countEl.textContent = JSON.stringify({
        itemCount: root.querySelectorAll('.item').length,
        hasResultsTab: Boolean(root.querySelector('[data-tab="results"]')),
        dbOk: (loadedDb instanceof Object && Object.getPrototypeOf(loadedDb) === Object.prototype),
        storeLabel: loadedStore && loadedStore.label,
        btnColorProp: btn.style.getPropertyValue('--btn-color'),
        realmChecks,
      });
      root.appendChild(countEl);
      console.warn('live-gui-diag-ok');
    }

    // Fire un-awaited async loader (must be awaited by settleLiveGuiDom!)
    void loadAsync();
    void risuai.showContainer();
  });
})();
`,
        });

        await waitUntil(() => adapter.listPlugins().some((p) => p.name === 'vm_realm_and_dom_parity' && p.uiItems.length >= 1));
        const res = await adapter.openLiveBackendGui('vm_realm_and_dom_parity');
        assert.equal(res.ok, true);
        assert.ok(res.rootAttrs && String(res.rootAttrs.htmlStyle || '').includes('--test-bg:#123456'), 'rootAttrs.htmlStyle must preserve --test-bg CSS variable');
        assert.ok(res.html.includes('data-tab="results"'), 'dataset.tab must serialize as data-tab="results"');
        assert.ok(res.html.includes('--btn-color:#22c55e'), 'style.setProperty CSS variable must serialize cleanly');
        assert.ok(res.html.includes('>loaded</span>'), 'innerText setter must update element text');
        assert.ok(res.diagnostics.some((d) => d.includes('live-gui-diag-ok')), 'Live GUI warnings must be captured in diagnostics');

        const metaMatch = res.html.match(/id="meta-out"[^>]*>([\s\S]*?)<\/div>/);
        assert.ok(metaMatch, 'Un-awaited async loader must complete before openLiveBackendGui returns');
        const parsedMeta = JSON.parse(metaMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
        assert.equal(parsedMeta.itemCount, 2, 'Sync querySelectorAll().length must be numeric');
        assert.equal(parsedMeta.hasResultsTab, true);
        assert.equal(parsedMeta.dbOk, true);
        assert.equal(parsedMeta.storeLabel, 'from-storage');
        assert.equal(parsedMeta.btnColorProp, '#22c55e');
        for (const [k, v] of Object.entries(parsedMeta.realmChecks)) {
            assert.equal(v, true, `Cross-realm check failed for ${k}`);
        }
    } finally {
        await adapter.dispose();
    }
});

test('Backend VM headless DOM exposes select/option/form/table collections, classList/textNode/document collections, and logs Error details', async () => {
    const adapter = adapterMod.createPluginAdapter({
        persistDisabled: true,
        hostRpc: { isConnected: () => false, async invoke() { throw new Error('offline'); } },
    });

    try {
        await adapter.addCustomPlugin({
            filename: 'dom_collections_parity.js',
            enabled: true,
            script: `
//@name dom_collections_parity
//@display-name DOM Collections Parity
//@api 3.0
risuai.registerSetting('DOM Collections', () => {
  const form = document.createElement('form');
  const sel = document.createElement('select');
  sel.name = 'modelSelect';
  const opt1 = new Option('Alpha', 'a', false, false);
  const opt2 = new Option('Beta', 'b', false, true);
  sel.add(opt1);
  sel.add(opt2);

  const inp = document.createElement('input');
  inp.type = 'file';
  form.appendChild(sel);
  form.appendChild(inp);

  const tbl = document.createElement('table');
  const tbody = document.createElement('tbody');
  const tr = document.createElement('tr');
  const td1 = document.createElement('td');
  const td2 = document.createElement('td');
  tr.append(td1, td2);
  tbody.appendChild(tr);
  tbl.appendChild(tbody);

  const box = document.createElement('div');
  box.className = 'alpha beta';
  const classReplaceOk = box.classList.replace('beta', 'gamma');
  const classSpread = [...box.classList];
  const tn = document.createTextNode('old-txt');
  tn.nodeValue = 'new-txt';
  box.appendChild(tn);

  document.body.appendChild(form);
  document.body.appendChild(tbl);
  document.body.appendChild(box);

  // Switch via selectedIndex and verify option/select state
  sel.selectedIndex = 0;

  const summary = {
    selOptsLen: sel.options.length,
    selLenProp: sel.length,
    selValueAfterIdx: sel.value,
    selSelectedOptsLen: sel.selectedOptions.length,
    selSelectedIndex: sel.selectedIndex,
    opt1Selected: opt1.selected,
    opt2Selected: opt2.selected,
    opt1Text: opt1.text,
    opt1FormMatches: opt1.form === form,
    formElemsLen: form.elements.length,
    inpFilesLen: inp.files.length,
    inpLabelsLen: inp.labels.length,
    tblRowsLen: tbl.rows.length,
    tblBodiesLen: tbl.tBodies.length,
    trCellsLen: tr.cells.length,
    classLen: box.classList.length,
    classItem0: box.classList.item(0),
    classReplaceOk,
    classSpread,
    tnChildLen: tn.childNodes.length,
    tnValue: tn.nodeValue,
    tnConnected: tn.isConnected,
    docSheetsLen: document.styleSheets.length,
    docChildrenLen: document.childNodes.length,
    docFormsLen: document.forms.length,
    winSelRangeCount: window.getSelection().rangeCount,
  };

  const out = document.createElement('pre');
  out.id = 'collections-out';
  out.textContent = JSON.stringify(summary);
  document.body.appendChild(out);

  console.warn('err-tag', new Error('boom-detail'));
  void risuai.showContainer();
});
`,
        });

        await waitUntil(() => adapter.listPlugins().some((p) => p.name === 'dom_collections_parity' && p.uiItems.length >= 1));
        const res = await adapter.openLiveBackendGui('dom_collections_parity');
        assert.equal(res.ok, true);
        assert.ok(res.diagnostics.some((d) => d.includes('err-tag') && d.includes('boom-detail')), 'formatLogArgs must include Error message/stack instead of {}');

        const m = res.html.match(/id="collections-out"[^>]*>([\s\S]*?)<\/pre>/);
        assert.ok(m, 'Expected collections-out <pre> in serialized DOM');
        const summary = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
        assert.equal(summary.selOptsLen, 2);
        assert.equal(summary.selLenProp, 2);
        assert.equal(summary.selValueAfterIdx, 'a');
        assert.equal(summary.selSelectedOptsLen, 1);
        assert.equal(summary.selSelectedIndex, 0);
        assert.equal(summary.opt1Selected, true);
        assert.equal(summary.opt2Selected, false);
        assert.equal(summary.opt1Text, 'Alpha');
        assert.equal(summary.opt1FormMatches, true);
        assert.equal(summary.formElemsLen, 2);
        assert.equal(summary.inpFilesLen, 0);
        assert.equal(summary.inpLabelsLen, 0);
        assert.equal(summary.tblRowsLen, 1);
        assert.equal(summary.tblBodiesLen, 1);
        assert.equal(summary.trCellsLen, 2);
        assert.equal(summary.classLen, 2);
        assert.equal(summary.classItem0, 'alpha');
        assert.equal(summary.classReplaceOk, true);
        assert.deepEqual(summary.classSpread, ['alpha', 'gamma']);
        assert.equal(summary.tnChildLen, 0);
        assert.equal(summary.tnValue, 'new-txt');
        assert.equal(summary.tnConnected, true);
        assert.equal(summary.docSheetsLen, 0);
        assert.equal(summary.docChildrenLen, 1);
        assert.equal(summary.docFormsLen, 1);
        assert.equal(summary.winSelRangeCount, 0);
    } finally {
        await adapter.dispose();
    }
});

test('Live GUI supports nested e.currentTarget sidebar nav, capture/stopPropagation, dedup re-append, class/disabled sync, entities, selectors, radio/label, and fast delta settle', async () => {
    let releaseBackgroundOp = null;
    const backgroundStarted = new Promise((res) => {
        releaseBackgroundOp = res;
    });
    let holdBg = null;
    const bgPromise = new Promise((res) => {
        holdBg = res;
    });

    const adapter = adapterMod.createPluginAdapter({
        persistDisabled: true,
        hostRpc: {
            isConnected: () => true,
            async invoke(op, args) {
                if (op === 'pluginStorage.getItem' && args[0] === 'bg_poll') {
                    releaseBackgroundOp();
                    await bgPromise;
                    return { ok: true };
                }
                return null;
            },
        },
    });

    try {
        await adapter.addCustomPlugin({
            filename: 'live_gui_parity_fast_test.js',
            enabled: true,
            script: `
//@name live_gui_parity_fast_test
//@display-name Live GUI Parity Fast Test
//@api 3.0
(async () => {
  // Start an unrelated background RPC op that stays in flight
  void risuai.pluginStorage.getItem('bg_poll');

  risuai.registerSetting('Overview', () => {
    const style = document.createElement('style');
    style.textContent = '.pill{color:#fff} body.gradia-dark{background:#000}';
    document.head.appendChild(style);
    document.body.className = 'gradia-dark';

    const root = document.createElement('div');
    root.id = 'gradia-root';
    root.innerHTML =
      '<nav class="sidebar">' +
        '<button type="button" class="nav-btn active" data-page="overview"><span id="nav-ov-lbl">개요</span></button>' +
        '<button type="button" class="nav-btn" data-page="results"><span id="nav-res-lbl">실행 결과</span></button>' +
        '<button type="button" id="noop-btn">No-op</button>' +
      '</nav>' +
      '<div id="pipeline-flow" data-mode="Pro"></div>' +
      '<div id="gradia:overview.count">0 / 7</div>' +
      '<button type="button" id="save-btn" disabled>저장</button>' +
      '<form id="mode-form">' +
        '<label id="lbl-mode-lite"><input type="radio" name="workMode" id="rad-lite" value="lite" checked> Lite</label>' +
        '<label id="lbl-mode-pro"><input type="radio" name="workMode" id="rad-pro" value="pro"> Pro</label>' +
      '</form>' +
      '<div id="page-out">page=overview</div>' +
      '<div id="dom-checks"></div>';
    document.body.appendChild(root);

    const flow = document.getElementById('pipeline-flow');
    const makePill = (label) => {
      const s = document.createElement('span');
      s.className = 'pill';
      s.textContent = label;
      return s;
    };
    const pills = [makePill('SHADOW ACT'), makePill('인물 AIDE'), makePill('세계관 AIDE'), makePill('플롯 AIDE'), makePill('메인 응답')];
    const renderFlow = () => {
      // Deliberately re-append existing child nodes without clearing first (must move, NOT duplicate!)
      for (const p of pills) flow.appendChild(p);
      // Also parse &rarr; and &middot; entities
      const arrowCheck = document.createElement('div');
      arrowCheck.id = 'entity-box';
      arrowCheck.innerHTML = '<span>A &rarr; B &middot; C</span>';
      if (!document.getElementById('entity-box')) flow.appendChild(arrowCheck);
    };
    renderFlow();
    renderFlow();

    // Test property-attribute sync: mutate className & disabled after HTML parsing
    const saveBtn = document.getElementById('save-btn');
    saveBtn.disabled = false;
    saveBtn.className = 'btn-ready';

    const countEl = document.getElementById('gradia:overview.count');
    if (countEl) countEl.textContent = '6 / 7';

    // Verify selectors
    const selChecks = {
      pillCount: flow.querySelectorAll(':scope > .pill').length,
      adjCount: flow.querySelectorAll('.pill + .pill').length,
      enabledSave: Boolean(root.querySelector('#save-btn:enabled')),
      caseAttr: Boolean(root.querySelector('[data-mode="PRO" i]')),
      exactId: Boolean(countEl),
    };
    document.getElementById('dom-checks').textContent = JSON.stringify(selChecks);

    // Event order + stopPropagation + e.currentTarget test
    const eventLog = [];
    document.addEventListener('click', (e) => {
      eventLog.push('doc-capture:' + (e.currentTarget === document));
    }, true);
    document.addEventListener('click', () => {
      eventLog.push('doc-bubble-should-not-run');
    });

    const navBtns = root.querySelectorAll('.nav-btn');
    navBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const page = e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.page : 'MISSING';
        eventLog.push('btn:' + page);
        document.getElementById('page-out').textContent = 'page=' + page + '|log=' + eventLog.join(',');
      });
    });

    document.getElementById('mode-form').addEventListener('change', (e) => {
      const checked = Array.from(document.querySelectorAll('input[name="workMode"]'))
        .filter((inp) => inp.checked)
        .map((inp) => inp.value);
      document.getElementById('page-out').textContent = 'mode=' + e.target.value + '|checked=' + checked.join(',');
    });

    void risuai.showContainer();
  });
})();
`,
        });

        await waitUntil(() => adapter.listPlugins().some((p) => p.name === 'live_gui_parity_fast_test' && p.uiItems.length >= 1));
        await backgroundStarted;

        // Compile-check viewer srcdoc & inspect optimizations
        const viewer = adapter.getLiveGuiViewerSrcdoc('live_gui_parity_fast_test', 'dark');
        assert.ok(viewer && viewer.srcdoc.includes('stylesUnchanged'));
        assert.ok(viewer.srcdoc.includes('fireClick'));
        const vScripts = [];
        const re = /<script(?:\s+([^>]*))?>([\s\S]*?)<\/script>/gi;
        let sm;
        while ((sm = re.exec(viewer.srcdoc)) !== null) {
            if (!(sm[1] || '').includes('__rs_live_')) vScripts.push(sm[2]);
        }
        assert.equal(vScripts.length, 1);
        new vm.Script(vScripts[0], { filename: 'live-gui-viewer-fast.js' });

        // Open Live GUI while background RPC is STILL pending (must NOT hang 3500ms)
        const tOpen0 = Date.now();
        const openRes = await adapter.openLiveBackendGui('live_gui_parity_fast_test');
        const openElapsed = Date.now() - tOpen0;
        assert.equal(openRes.ok, true);
        assert.ok(openElapsed < 800, `openLiveBackendGui took ${openElapsed}ms; background op should not block baselinePendingOps`);
        assert.ok(openRes.html.includes('6 / 7'), 'getElementById with ":" and "." must update node');
        assert.ok(openRes.html.includes('A → B · C'), '&rarr; and &middot; entities must decode cleanly');
        assert.ok(openRes.html.includes('class="btn-ready"'), 'className setter must sync serialized class attribute');
        assert.ok(!/<button[^>]*id="save-btn"[^>]*disabled=/.test(openRes.html), 'disabled=false must remove disabled="" attribute');

        const checksMatch = openRes.html.match(/id="dom-checks"[^>]*>([\s\S]*?)<\/div>/);
        assert.ok(checksMatch);
        const selChecks = JSON.parse(checksMatch[1].replace(/&quot;/g, '"'));
        assert.equal(selChecks.pillCount, 5, 'Re-appending existing children must move, not duplicate');
        assert.equal(selChecks.adjCount, 4, '.pill + .pill combinator must match 4 adjacent pills');
        assert.equal(selChecks.enabledSave, true, ':enabled must match save-btn after disabled=false');
        assert.equal(selChecks.caseAttr, true, '[data-mode="PRO" i] must match case-insensitively');
        assert.equal(selChecks.exactId, true);

        // Also verify async wrapSafeElement child/sibling traversal + replaceChildren on mockDom
        const mockDom = adapter._debug.pluginDoms.get('live_gui_parity_fast_test');
        const asyncFlow = await mockDom.asyncDoc.getElementById('pipeline-flow');
        assert.ok(asyncFlow && asyncFlow.firstChild && asyncFlow.children.length >= 5);
        const asyncTmp = await mockDom.asyncDoc.createElement('div');
        await asyncTmp.append('one', 'two');
        while (asyncTmp.firstChild) {
            await asyncTmp.removeChild(asyncTmp.firstChild);
        }
        assert.equal(asyncTmp.childNodes.length, 0);
        await asyncTmp.replaceChildren('three');
        assert.equal(asyncTmp.textContent, 'three');

        // 1) Click nested <span id="nav-res-lbl"> inside <button data-page="results">
        const spanMatch = openRes.html.match(/<span[^>]*data-rs-vm-nid="(\d+)"[^>]*id="nav-res-lbl"/);
        assert.ok(spanMatch, 'Nested nav span must have nodeId');
        const tClick0 = Date.now();
        const navRes = await adapter.dispatchLiveBackendGuiEvent({
            pluginName: 'live_gui_parity_fast_test',
            eventType: 'click',
            nodeId: Number(spanMatch[1]),
        });
        const clickElapsed = Date.now() - tClick0;
        assert.equal(navRes.ok, true);
        assert.equal(navRes.unchanged, false);
        assert.equal(navRes.stylesUnchanged, true, 'Unchanged CSS must set stylesUnchanged: true and omit styles');
        assert.equal(navRes.styles, undefined);
        assert.ok(clickElapsed < 350, `Sync click took ${clickElapsed}ms, expected < 350ms even with background RPC in flight`);
        assert.ok(navRes.html.includes('page=results|log=doc-capture:true,btn:results'), 'e.currentTarget must resolve to button & stopPropagation must block doc bubble');
        assert.ok(!navRes.html.includes('doc-bubble-should-not-run'));

        // 2) No-op button click -> unchanged: true
        const noopMatch = navRes.html.match(/<button[^>]*data-rs-vm-nid="(\d+)"[^>]*id="noop-btn"/);
        assert.ok(noopMatch);
        const noopRes = await adapter.dispatchLiveBackendGuiEvent({
            pluginName: 'live_gui_parity_fast_test',
            eventType: 'click',
            nodeId: Number(noopMatch[1]),
        });
        assert.equal(noopRes.ok, true);
        assert.equal(noopRes.unchanged, true);

        // 3) Radio change via fireClick:true switches group cleanly (only 'pro' checked)
        const proRadioMatch = navRes.html.match(/<input[^>]*data-rs-vm-nid="(\d+)"[^>]*id="rad-pro"/);
        assert.ok(proRadioMatch);
        const radRes = await adapter.dispatchLiveBackendGuiEvent({
            pluginName: 'live_gui_parity_fast_test',
            eventType: 'change',
            nodeId: Number(proRadioMatch[1]),
            value: 'pro',
            checked: true,
            fireClick: true,
        });
        assert.ok(radRes.html.includes('mode=pro|checked=pro'));

        // 4) Clicking <label id="lbl-mode-lite"> forwards click back to <input id="rad-lite">
        const lblLiteMatch = radRes.html.match(/<label[^>]*data-rs-vm-nid="(\d+)"[^>]*id="lbl-mode-lite"/);
        assert.ok(lblLiteMatch);
        const lblRes = await adapter.dispatchLiveBackendGuiEvent({
            pluginName: 'live_gui_parity_fast_test',
            eventType: 'click',
            nodeId: Number(lblLiteMatch[1]),
        });
        assert.ok(lblRes.html.includes('mode=lite|checked=lite'));
    } finally {
        if (holdBg) holdBg();
        await adapter.dispose();
    }
});

test('Live GUI avoids O(N^2) chatScreen.contains slowdown across 200 messages, supports TextNode contains, and caps slow async sync-DOM listeners', async () => {
    let releaseSlowRpc = null;
    const slowRpcDone = new Promise((res) => { releaseSlowRpc = res; });
    const adapter = adapterMod.createPluginAdapter({
        persistDisabled: true,
        onSurfaceMutated: () => {},
        hostRpc: {
            isConnected: () => true,
            async invoke(op, args) {
                if (op === 'pluginStorage.getItem' && args[0] === 'slow_tab_load') {
                    await Promise.race([
                        slowRpcDone,
                        new Promise((r) => setTimeout(r, 5000)),
                    ]);
                    return { loaded: true };
                }
                return null;
            },
        },
    });

    try {
        await adapter.addCustomPlugin({
            filename: 'live_gui_scale_perf_test.js',
            enabled: true,
            script: `
//@name live_gui_scale_perf_test
//@display-name Live GUI Scale Perf
//@api 3.0
risuai.registerSetting('Scale Perf', () => {
  const root = document.createElement('div');
  root.id = 'perf-root';
  root.innerHTML =
    '<button type="button" id="render-600">Render 600</button>' +
    '<button type="button" id="slow-tab-btn">Slow Tab</button>' +
    '<div id="perf-out">init</div>' +
    '<div id="detached-probe"></div>';
  document.body.appendChild(root);

  document.getElementById('render-600').addEventListener('click', () => {
    let html = '';
    for (let i = 0; i < 600; i++) {
      html += '<div class="row card item-row" id="row-' + i + '" data-idx="' + i + '"><span class="lbl">R' + i + '</span><button type="button" class="act" data-idx="' + i + '">Go</button></div>';
    }
    const outEl = document.getElementById('perf-out');
    outEl.innerHTML = html;
    // Heavy selector workload after render: 120x getElementById, 80x querySelector, 40x querySelectorAll + classList.contains
    for (let i = 0; i < 120; i++) {
      document.getElementById('row-' + (i % 600));
    }
    for (let i = 0; i < 80; i++) {
      document.querySelector('#perf-root .item-row[data-idx="' + i + '"]');
    }
    for (let i = 0; i < 40; i++) {
      const rows = document.querySelectorAll('.card.item-row');
      for (let j = 0; j < rows.length; j++) {
        rows[j].classList.contains('active');
      }
    }
  });

  document.getElementById('slow-tab-btn').addEventListener('click', async () => {
    // Immediately switch visible tab state, then run slow RPC
    document.getElementById('perf-out').textContent = 'tab=switched-fast';
    await risuai.pluginStorage.getItem('slow_tab_load');
  });

  void risuai.showContainer();
});
`,
        });

        await waitUntil(() => adapter.listPlugins().some((p) => p.name === 'live_gui_scale_perf_test' && p.uiItems.length >= 1));

        // Populate 200 rich chat messages into chatScreen
        const msgs = [];
        for (let i = 0; i < 200; i += 1) {
            msgs.push({
                index: i,
                role: i % 2 === 0 ? 'user' : 'char',
                chatId: `cid-${i}`,
                html: `<div class="p"><p>Msg ${i} <span>a</span><span>b</span><span>c</span><b>d</b></p><div><span>e</span><span>f</span></div></div>`,
            });
        }
        await adapter.syncAndProjectChatSurface({ charIndex: 0, chatIndex: 0, messages: msgs });

        const openRes = await adapter.openLiveBackendGui('live_gui_scale_perf_test');
        assert.equal(openRes.ok, true);

        const mockDom = adapter._debug.pluginDoms.get('live_gui_scale_perf_test');
        // Non-observer plugin must NOT get 200 chat messages synced into its chatScreen
        assert.equal(mockDom.chatScreen.childNodes.length, 0, 'syncAndProjectChatSurface must skip non-observer plugins');
        // Now explicitly populate chatScreen with 200 messages anyway to verify O(1)/early-exit DOM perf under load
        mockDom.syncChatMessages(msgs);

        // Verify lazy .style sync after setAttribute('style', ...) before .style access
        const lazyStyleEl = mockDom.syncDoc.createElement('div');
        lazyStyleEl.setAttribute('style', 'color: red; --x: 1');
        assert.equal(lazyStyleEl.style.color, 'red');
        assert.equal(lazyStyleEl.style.getPropertyValue('--x'), '1');
        lazyStyleEl.style.display = 'none';
        assert.ok(String(lazyStyleEl.getAttribute('style') || '').includes('display:none'));

        // Verify O(depth) contains() behavior with TextNode, deep descendant, sibling, and detached node
        const perfRoot = mockDom.syncDoc.getElementById('perf-root');
        const perfOut = mockDom.syncDoc.getElementById('perf-out');
        const slowBtn = mockDom.syncDoc.getElementById('slow-tab-btn');
        const detached = mockDom.syncDoc.createElement('div');
        assert.equal(perfRoot.contains(perfOut), true);
        assert.equal(perfRoot.contains(perfOut.firstChild), true, 'contains(TextNode) must return true');
        assert.equal(perfOut.contains(slowBtn), false, 'sibling must return false');
        assert.equal(perfRoot.contains(detached), false, 'detached node must return false');

        // 1) Rendering 600 rows (1,800 elements) + 240 selector queries while 200 chat messages exist must finish < 150ms
        const btn600Match = openRes.html.match(/<button[^>]*data-rs-vm-nid="(\d+)"[^>]*id="render-600"/);
        assert.ok(btn600Match);
        const tRender0 = Date.now();
        const res600 = await adapter.dispatchLiveBackendGuiEvent({
            pluginName: 'live_gui_scale_perf_test',
            eventType: 'click',
            nodeId: Number(btn600Match[1]),
        });
        const renderElapsed = Date.now() - tRender0;
        assert.equal(res600.ok, true);
        assert.ok(res600.html.includes('R599'), '600 rows must serialize completely');
        assert.ok(renderElapsed < 150, `600-row + 240-query render with 200 chat messages took ${renderElapsed}ms; expected < 150ms`);

        // 2) Slow 5s async sync-DOM listener must NOT block dispatchSurfaceClick; returns switched tab in < 1500ms
        const slowBtnMatch = res600.html.match(/<button[^>]*data-rs-vm-nid="(\d+)"[^>]*id="slow-tab-btn"/);
        assert.ok(slowBtnMatch);
        const tSlow0 = Date.now();
        const slowRes = await adapter.dispatchLiveBackendGuiEvent({
            pluginName: 'live_gui_scale_perf_test',
            eventType: 'click',
            nodeId: Number(slowBtnMatch[1]),
        });
        const slowElapsed = Date.now() - tSlow0;
        assert.equal(slowRes.ok, true);
        assert.ok(slowRes.html.includes('tab=switched-fast'), 'Switched tab state must appear even while slow RPC is still pending');
        assert.ok(slowElapsed < 1500, `Slow async sync-DOM listener blocked for ${slowElapsed}ms; expected < 1500ms`);
    } finally {
        if (releaseSlowRpc) releaseSlowRpc();
        await adapter.dispose();
    }
});

test('Plugin adapter DOM global index accelerates 1600+ GRADIA-style queries (<120ms) and preserves detach/order/x-risu semantics', async () => {
    const adapter = adapterMod.createPluginAdapter({
        persistDisabled: true,
        onSurfaceMutated: () => {},
        hostRpc: { isConnected: () => true, invoke: async () => null },
    });
    try {
        await adapter.addCustomPlugin({
            filename: 'live_index_test.js',
            enabled: true,
            script: `//@name live_gui_index_test
//@display-name Live Index Test
//@api 3.0
risuai.registerSetting('Index Test', () => {});
const modal = document.createElement('div');
modal.id = 'index-modal';
const rows = [];
for (let i = 0; i < 650; i += 1) {
    const cls = i % 10 === 0 ? 'row pill' : 'row';
    const tabAttr = i % 25 === 0 ? ' data-tab="t' + (i / 25) + '"' : '';
    rows.push('<div class="' + cls + '" data-field="f' + i + '"' + tabAttr + '><span>V' + i + '</span></div>');
}
modal.innerHTML = rows.join('');
document.body.appendChild(modal);
`,
        });

        const mockDom = adapter._debug.pluginDoms.get('live_gui_index_test');
        assert.ok(mockDom, 'mockDom must exist');
        const { syncDoc, chatScreen } = mockDom;
        const modal = syncDoc.getElementById('index-modal');
        assert.ok(modal, 'index-modal must exist');

        // 1) 1,100 querySelector + 500 querySelectorAll + 100 getElementById inside 2,000+ node DOM
        const t0 = Date.now();
        for (let i = 0; i < 1100; i += 1) {
            const k = i % 650;
            const el = modal.querySelector(`[data-field="f${k}"]`);
            assert.ok(el, `missing f${k}`);
        }
        let multiCount = 0;
        for (let i = 0; i < 500; i += 1) {
            const list = modal.querySelectorAll('.pill, [data-tab="t3"]');
            multiCount = list.length;
        }
        assert.equal(multiCount, 66, '.pill (65) + [data-tab=t3] at i=75 (1) count mismatch');
        for (let i = 0; i < 100; i += 1) {
            assert.equal(syncDoc.getElementById('index-modal'), modal);
        }
        const elapsed = Date.now() - t0;
        assert.ok(elapsed < 120, `1,700 indexed queries took ${elapsed}ms; expected < 120ms`);

        // 2) Document order preservation under insertBefore / prepend / replaceWith
        const orderBox = syncDoc.createElement('div');
        orderBox.id = 'order-box';
        const second = syncDoc.createElement('span');
        second.className = 'ord';
        second.setAttribute('data-k', '2');
        const first = syncDoc.createElement('span');
        first.className = 'ord';
        first.setAttribute('data-k', '1');
        const zero = syncDoc.createElement('span');
        zero.className = 'ord';
        zero.setAttribute('data-k', '0');
        syncDoc.body.appendChild(orderBox);
        orderBox.appendChild(second);
        orderBox.insertBefore(first, second);
        orderBox.prepend(zero);
        const ordered = syncDoc.querySelectorAll('#order-box .ord');
        assert.deepEqual(ordered.map((n) => n.getAttribute('data-k')), ['0', '1', '2']);
        assert.equal(syncDoc.querySelector('.ord'), zero);

        // 3) Detach cleanup + cloneNode(true) isolation + re-attach
        const cloned = orderBox.cloneNode(true);
        assert.equal(cloned.isConnected, false);
        assert.equal(syncDoc.getElementById('order-box'), orderBox, 'detached clone must not enter global idIndex');
        const removed = orderBox.removeChild(zero);
        assert.equal(removed.isConnected, false);
        assert.deepEqual(syncDoc.querySelectorAll('#order-box .ord').map((n) => n.getAttribute('data-k')), ['1', '2']);
        orderBox.innerHTML = '';
        assert.equal(syncDoc.querySelector('#order-box .ord'), null, 'cleared descendants must be removed from classIndex');
        assert.equal(first.isConnected, false);

        // 4) Detached fragment & subtree queries still work via fallback walk
        const frag = syncDoc.createDocumentFragment();
        const fragChild = syncDoc.createElement('button');
        fragChild.setAttribute('data-frag', 'yes');
        frag.appendChild(fragChild);
        assert.equal(frag.querySelector('[data-frag="yes"]'), fragChild);

        // 5) Case-insensitive [attr="VAL" i] query uses attrNameIndex cleanly
        const ciEl = syncDoc.createElement('div');
        ciEl.setAttribute('data-mode', 'MiXeD');
        syncDoc.body.appendChild(ciEl);
        assert.equal(syncDoc.querySelector('[data-mode="mixed" i]'), ciEl);

        // 6) Asset Maid x-risu- prefix compatibility inside chatScreen
        const rowEl = syncDoc.createElement('div');
        rowEl.className = 'am-chip';
        rowEl._rsAllowRisuPrefixMatch = true;
        chatScreen.appendChild(rowEl);
        assert.equal(syncDoc.querySelector('.x-risu-am-chip'), rowEl);
        assert.equal(chatScreen.querySelector('.x-risu-am-chip'), rowEl);
    } finally {
        await adapter.dispose();
    }
});
