'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
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
        pluginStorage: pluginStore.api,
        safeLocalStorage: safeLocalStore.api,
        getLocalPluginStorage: () => localPluginStore.api,
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
