'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const relay = require('../risustand-relay-server.js');
const { REPO } = require('./helpers.cjs');

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

test('helper unit checks: parseOptionalNumber, applyPromptOverride, normalizeTurnMessages, safeTokenEqual', () => {
    assert.equal(relay.parseOptionalNumber(0), 0);
    assert.equal(relay.parseOptionalNumber('0'), 0);
    assert.equal(relay.parseOptionalNumber(''), undefined);
    assert.equal(relay.parseOptionalNumber(null), undefined);
    assert.equal(relay.parseOptionalNumber('abc'), undefined);

    const msgs = [
        { role: 'system', content: 'Base' },
        { role: 'user', content: 'Hi' },
    ];
    assert.equal(relay.applyPromptOverride(msgs, { overrideMode: 'append', systemOverride: 'Extra' })[0].content, 'Base\n\nExtra');
    assert.deepEqual(relay.applyPromptOverride(msgs, { overrideMode: 'replace', systemOverride: 'Only' }), [
        { role: 'system', content: 'Only' },
        { role: 'user', content: 'Hi' },
    ]);

    const normAnthropic = relay.normalizeTurnMessages([
        { role: 'system', content: 'Sys' },
        { role: 'assistant', content: 'First' },
        { role: 'assistant', content: 'Second' },
        { role: 'user', content: 'U1' },
        { role: 'user', content: 'U2' },
    ], { assistantRole: 'assistant', ensureUserFirst: true });
    assert.deepEqual(normAnthropic.sysParts, ['Sys']);
    assert.deepEqual(normAnthropic.turns, [
        { role: 'user', text: '[Start]' },
        { role: 'assistant', text: 'First\n\nSecond' },
        { role: 'user', text: 'U1\n\nU2' },
    ]);

    const normGemini = relay.normalizeTurnMessages([
        { role: 'assistant', content: 'A1' },
        { role: 'assistant', content: 'A2' },
    ], { assistantRole: 'model', ensureUserFirst: false });
    assert.deepEqual(normGemini.turns, [{ role: 'model', text: 'A1\n\nA2' }]);

    assert.equal(relay.safeTokenEqual('abc123', 'abc123'), true);
    assert.equal(relay.safeTokenEqual('abc123', 'abc124'), false);
    assert.equal(relay.safeTokenEqual('', ''), false);

    assert.equal(relay.isLoopbackAddress('127.0.0.1'), true);
    assert.equal(relay.isLoopbackAddress('::1'), true);
    assert.equal(relay.isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(relay.isLoopbackAddress('100.64.0.5'), false);

    assert.equal(relay.isTrustedOrigin('http://localhost:8787', 'localhost:8787'), true);
    assert.equal(relay.isTrustedOrigin('http://100.64.0.5:8787', '100.64.0.5:8787'), true);
    assert.equal(relay.isTrustedOrigin('https://evil.example', '100.64.0.5:8787'), false);

    const san = relay.sanitizeConfigForClient();
    assert.equal(Array.isArray(san.profiles), true);
    assert.equal(san.translator.apiKey, undefined);
});

test('relay server auth: headers accepted, ?token= query param rejected, rate limit triggers 429', async () => {
    const server = relay.createRelayServer({ token: 'secret-test-token' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
        const noAuth = await requestHttp(port, { path: '/api/state' });
        assert.equal(noAuth.status, 401);

        const queryTok = await requestHttp(port, { path: '/api/state?token=secret-test-token' });
        assert.equal(queryTok.status, 401);

        const headerTok = await requestHttp(port, {
            path: '/api/state',
            headers: { 'X-RisuStand-Token': 'secret-test-token' },
        });
        assert.equal(headerTok.status, 200);

        const bearerTok = await requestHttp(port, {
            path: '/api/state',
            headers: { Authorization: 'Bearer secret-test-token' },
        });
        assert.equal(bearerTok.status, 200);

        // Trigger rate limit (15 failures in window -> 429)
        let lastRes = null;
        for (let i = 0; i < 16; i++) {
            lastRes = await requestHttp(port, {
                path: '/api/state',
                headers: { 'X-RisuStand-Token': 'wrong-token' },
            });
        }
        assert.equal(lastRes.status, 429);
        assert.equal(lastRes.headers['retry-after'], '60');
    } finally {
        await new Promise((r) => server.close(r));
    }
});

test('relay proxy & CORS: untrusted Origin blocked on loopback, never emits Access-Control-Allow-Origin: *', async () => {
    const server = relay.createRelayServer({ token: 'secret-test-token' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
        // Loopback without Origin (like RisuAI / local client) is permitted for /v1/models
        const localModels = await requestHttp(port, { path: '/v1/models' });
        assert.equal(localModels.status, 200);
        assert.equal(localModels.headers['access-control-allow-origin'], undefined);

        // Untrusted browser Origin on loopback is blocked with 403
        const evilOrigin = await requestHttp(port, {
            path: '/v1/models',
            headers: { Origin: 'https://evil.example' },
        });
        assert.equal(evilOrigin.status, 403);
        assert.equal(evilOrigin.headers['access-control-allow-origin'], undefined);

        // Trusted localhost Origin receives exact Origin echo (never *)
        const okOrigin = await requestHttp(port, {
            path: '/v1/models',
            headers: { Origin: 'http://localhost:5173' },
        });
        assert.equal(okOrigin.status, 200);
        assert.equal(okOrigin.headers['access-control-allow-origin'], 'http://localhost:5173');
        assert.notEqual(okOrigin.headers['access-control-allow-origin'], '*');

        // Web UI HTML escapes single quotes in esc(), compiles cleanly, and has no wildcard CORS
        const html = await requestHttp(port, { path: '/' });
        assert.equal(html.status, 200);
        assert.match(html.body, /&#39;/);
        const scriptMatch = html.body.match(/<script>([\s\S]*?)<\/script>/);
        assert.ok(scriptMatch, 'rendered HTML must contain inline script');
        new vm.Script(scriptMatch[1], { filename: 'webapp-inline.js' });
        assert.ok(!fs.readFileSync(path.join(REPO, 'risustand-relay-server.js'), 'utf8').includes("'Access-Control-Allow-Origin': '*'"));
    } finally {
        await new Promise((r) => server.close(r));
    }
});

test('relay /v1/chat/completions forwards non-stream and stream requests without premature Client disconnected', async () => {
    const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const reqBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            if (reqBody.stream) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
                res.write(`data: ${JSON.stringify({ id: 's1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hello stream' }, finish_reason: null }] })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                id: 'c1',
                model: reqBody.model || 'mock-model',
                choices: [{ index: 0, message: { role: 'assistant', content: 'hello non-stream' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
            }));
        });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = upstream.address().port;

    const server = relay.createRelayServer({
        token: 'proxy-test-token',
        configOverride: {
            activeProfileId: 'mock-openai',
            presetToggles: [],
            profiles: [{
                id: 'mock-openai',
                name: 'Mock OpenAI',
                providerType: 'openai_compat',
                baseUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
                apiKey: 'mock-key',
                model: 'deepseek-test',
                temperature: '',
                maxTokens: '',
                overrideMode: 'off',
                systemOverride: '',
            }],
            translator: { enabled: false, useActiveProfile: true },
        },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    try {
        const nonStream = await requestHttp(port, {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer proxy-test-token',
            },
            body: JSON.stringify({ model: 'risustand-router', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
        });
        assert.equal(nonStream.status, 200);
        const nonStreamJson = JSON.parse(nonStream.body);
        assert.equal(nonStreamJson.choices[0].message.content, 'hello non-stream');

        const streamed = await requestHttp(port, {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer proxy-test-token',
            },
            body: JSON.stringify({ model: 'risustand-router', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
        });
        assert.equal(streamed.status, 200);
        assert.match(streamed.body, /hello stream/);
        assert.match(streamed.body, /\[DONE\]/);
    } finally {
        await new Promise((r) => server.close(r));
        await new Promise((r) => upstream.close(r));
    }
});

test('bundled Leave preset & AI provider model loader APIs (including 22 Ollama Cloud models)', async () => {
    const upstream = http.createServer((req, res) => {
        if (req.url === '/v1/models') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ data: [{ id: 'live-model-1' }, { id: 'live-model-2' }] }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = upstream.address().port;

    const server = relay.createRelayServer({ token: 'preset-loader-token' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
        // 1) Auth required on Leave & model loader routes
        assert.equal((await requestHttp(port, { path: '/api/presets/leave' })).status, 401);
        assert.equal((await requestHttp(port, { path: '/api/presets/leave/download' })).status, 401);
        assert.equal((await requestHttp(port, { path: '/api/presets/leave/guide' })).status, 401);
        assert.equal((await requestHttp(port, { method: 'POST', path: '/api/router/models', body: '{}' })).status, 401);

        const authHdr = { 'X-RisuStand-Token': 'preset-loader-token' };

        // 2) Bundled Leave r1.1 preset metadata, download .risup binary, and guide HTML
        const meta = await requestHttp(port, { path: '/api/presets/leave', headers: authHdr });
        assert.equal(meta.status, 200);
        const metaJson = JSON.parse(meta.body);
        assert.equal(metaJson.id, 'preset-leave-r1.1');
        assert.equal(metaJson.filename, 'Leave_RisuAI_Preset.risup');
        assert.ok(metaJson.toggleSyntax.includes('ooc_mode='));
        assert.ok(metaJson.toggleSyntax.includes('bianca_inject=비앙카 투입 (기본: 꺼짐)=select='));
        assert.ok(metaJson.toggleSyntax.includes('DeepSeek 계열'));
        assert.equal(metaJson.hasGuide, true);

        const dl = await new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port, path: '/api/presets/leave/download', headers: authHdr }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
            }).on('error', reject);
        });
        assert.equal(dl.status, 200);
        assert.equal(dl.headers['content-type'], 'application/octet-stream');
        assert.match(dl.headers['content-disposition'] || '', /Leave_RisuAI_Preset\.risup/);
        assert.notEqual(dl.buf[0], 0x7b, 'Downloaded preset must be binary .risup, not raw JSON');
        const decodedPreset = relay.decodeRisupPreset(dl.buf);
        assert.equal(decodedPreset.name, 'Leave — Wandering Librarian Engine r1.1');
        assert.equal(decodedPreset.promptTemplate.length, 21);
        assert.ok(decodedPreset.promptTemplate[8].text.includes('BIANCA WRITING DISCIPLINE — PROSE CRAFT, EDITORIAL CHECKS & MATURE REGISTER ONLY'));
        assert.ok(decodedPreset.promptTemplate[8].text.includes('BIANCA WORKSPACE PERSONA — this module governs prose voice'));
        assert.ok(decodedPreset.promptTemplate[20].text.includes('STEP 3 — CHARACTER-CARD STATUS LINE'));

        const guide = await requestHttp(port, { path: '/api/presets/leave/guide', headers: authHdr });
        assert.equal(guide.status, 200);
        assert.match(guide.body, /Leave/i);

        // 3) Ollama Cloud model loader includes all 22 requested models even without live key
        const expectedOllamaModels = [
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
        ];
        const ollamaRes = await requestHttp(port, {
            method: 'POST',
            path: '/api/router/models',
            headers: { ...authHdr, 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'ollama_cloud', baseUrl: 'https://ollama.com/v1/chat/completions' }),
        });
        assert.equal(ollamaRes.status, 200);
        const ollamaIds = JSON.parse(ollamaRes.body).models.map((m) => m.id);
        for (const id of expectedOllamaModels) {
            assert.ok(ollamaIds.includes(id), `Expected Ollama Cloud model: ${id}`);
        }

        // 4) Live OpenAI-compatible /v1/models lookup against local upstream mock
        const liveRes = await requestHttp(port, {
            method: 'POST',
            path: '/api/router/models',
            headers: { ...authHdr, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider: 'custom',
                providerType: 'openai_compat',
                baseUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
            }),
        });
        assert.equal(liveRes.status, 200);
        assert.deepEqual(JSON.parse(liveRes.body).models.map((m) => m.id), ['live-model-1', 'live-model-2']);

        // 5) Rendered HTML includes provider selector, model loader, Leave buttons, and compiles cleanly
        const html = await requestHttp(port, { path: '/' });
        assert.equal(html.status, 200);
        for (const marker of ['edProvider', 'edLoadModelsBtn', 'edModelPick', 'trProvider', 'installBundledLeaveToggle', 'downloadLeavePreset', 'RISUP 받기']) {
            assert.ok(html.body.includes(marker), `Expected UI marker: ${marker}`);
        }
        const scriptMatch = html.body.match(/<script>([\s\S]*?)<\/script>/);
        assert.ok(scriptMatch);
        new vm.Script(scriptMatch[1], { filename: 'webapp-presets-inline.js' });
    } finally {
        await new Promise((r) => server.close(r));
        await new Promise((r) => upstream.close(r));
    }
});

test('risustand-admin: token rotation/revocation and port file management', () => {
    const admin = require('../risustand-admin.cjs');
    const { tmpDir } = require('./helpers.cjs');
    const dir = tmpDir('rs-admin-');
    try {
        // Default state
        assert.equal(admin.readTokenFile(dir), '');
        assert.equal(admin.readPortFile(dir), 8787);
        assert.equal(relay.loadSavedPort(dir), 8787);

        // Random token rotation
        const r1 = admin.rotateToken(dir);
        assert.equal(r1.previous, '');
        assert.match(r1.token, /^[a-f0-9]{32}$/);
        assert.equal(admin.readTokenFile(dir), r1.token);

        const r2 = admin.rotateToken(dir);
        assert.equal(r2.previous, r1.token);
        assert.notEqual(r2.token, r1.token);
        assert.equal(admin.readTokenFile(dir), r2.token);

        // Custom token validation
        assert.throws(() => admin.rotateToken(dir, { customToken: 'short' }), /8자 이상/);
        assert.throws(() => admin.rotateToken(dir, { customToken: 'has space 1234' }), /공백/);
        const r3 = admin.rotateToken(dir, { customToken: 'my-secure-token-99' });
        assert.equal(r3.token, 'my-secure-token-99');
        assert.equal(admin.readTokenFile(dir), 'my-secure-token-99');

        // Revocation
        const rev = admin.revokeToken(dir);
        assert.equal(rev.existed, true);
        assert.equal(admin.readTokenFile(dir), '');
        assert.equal(admin.revokeToken(dir).existed, false);

        // Port management
        assert.throws(() => admin.writePortFile(dir, 80), /1024~65535/);
        assert.throws(() => admin.writePortFile(dir, 70000), /1024~65535/);
        assert.throws(() => admin.writePortFile(dir, 'abc'), /올바른 포트 번호/);

        assert.equal(admin.writePortFile(dir, '9090'), 9090);
        assert.equal(admin.readPortFile(dir), 9090);
        assert.equal(relay.loadSavedPort(dir), 9090);

        assert.equal(admin.resetPortFile(dir), 8787);
        assert.equal(admin.readPortFile(dir), 8787);
        assert.equal(relay.loadSavedPort(dir), 8787);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('pc poll needFullSync signal & risustand.js trash filtering / post-ACK signature commit', async () => {
    const server = relay.createRelayServer({ token: 'sync-check-token' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
        const hdrs = { 'X-RisuStand-Token': 'sync-check-token', 'Content-Type': 'application/json' };

        // Empty relay asks PC bridge for full sync (both batch and legacy mode)
        const emptyPoll = await requestHttp(port, {
            method: 'POST',
            path: '/api/pc/poll',
            headers: hdrs,
            body: JSON.stringify({ supportsBatchCommands: true, catalog: null, snapshot: null }),
        });
        assert.equal(emptyPoll.status, 200);
        assert.equal(JSON.parse(emptyPoll.body).needFullSync, true);

        // Catalog present, snapshot missing -> still needs full sync
        const catOnlyPoll = await requestHttp(port, {
            method: 'POST',
            path: '/api/pc/poll',
            headers: hdrs,
            body: JSON.stringify({
                supportsBatchCommands: false,
                catalog: { characters: [{ index: 0, name: 'Bot', chats: [] }] },
                snapshot: null,
            }),
        });
        assert.equal(catOnlyPoll.status, 200);
        assert.equal(JSON.parse(catOnlyPoll.body).needFullSync, true);

        // Once both catalog (non-empty characters) and snapshot are populated -> needFullSync is false
        const populatedPoll = await requestHttp(port, {
            method: 'POST',
            path: '/api/pc/poll',
            headers: hdrs,
            body: JSON.stringify({
                supportsBatchCommands: true,
                catalog: { characters: [{ index: 0, name: 'Bot', chats: [{ index: 0, id: 'c1', name: 'Chat 1', msgCount: 0 }] }] },
                snapshot: { charIndex: 0, chatIndex: 0, charName: 'Bot', chatName: 'Chat 1', messages: [] },
            }),
        });
        assert.equal(populatedPoll.status, 200);
        assert.equal(JSON.parse(populatedPoll.body).needFullSync, false);

        // Verify inline webapp compiles after client JS edits & includes aligned bot menu FAB styles
        const html = await requestHttp(port, { path: '/' });
        assert.equal(html.status, 200);
        assert.ok(html.body.includes('lastBotsSyncAt'));
        assert.ok(html.body.includes('align-items:center; justify-content:center;'));
        assert.ok(html.body.includes('bmf-ic'));
        assert.ok(html.body.includes('--bot-fab-w'));
        assert.ok(html.body.includes('.trig-alert-card'));
        assert.ok(html.body.includes('.trig-ok-btn'));
        assert.ok(html.body.includes('dismiss_pc_alert'));
        assert.ok(html.body.includes("tev.kind === 'notice' || tev.kind === 'alert_error'"));
        assert.ok(html.body.includes('lastToggleChatKey'));
        assert.ok(html.body.includes("scope: curUseLocal ? 'local' : 'global'"));
        assert.ok(html.body.includes('openToggleGroups.clear()'));
        assert.ok(html.body.includes('/^(SELECT|INPUT|TEXTAREA)$/i.test(activeEl.tagName)'));
        assert.ok(!html.body.includes('}, 6000);'), 'Floating bot menu should not auto-hide on a 6s timer');
        assert.ok(html.body.includes('bookDesiredSpreadIdx'));
        assert.ok(html.body.includes('fromLayout = false'));
        assert.ok(html.body.includes('bookAnchorMode'));
        assert.ok(html.body.includes('armPendingReplyFollow'));
        assert.ok(html.body.includes('pendingReplyTarget'));
        assert.ok(html.body.includes('pendingScrollToLastUser'));
        assert.ok(html.body.includes('function scopeBotCss'));
        assert.ok(html.body.includes('scopeBotCss(sanitizeBotCss('));
        assert.ok(html.body.includes('class="rs-bg-host rs-bot-html"'));
        assert.ok(html.body.includes('#refreshAllBtn'));
        assert.ok(html.body.includes('.book-img-preview'));
        assert.ok(html.body.includes('openBookImgPreview'));
        assert.ok(html.body.includes('closeBookImgPreview'));
        assert.ok(html.body.includes('bookImgPreview'));
        assert.ok(html.body.includes('findExpandableBotAsset'));
        assert.ok(html.body.includes('extractCssBgImageUrl'));
        assert.ok(html.body.includes('data-rs-bg-img'));
        assert.ok(html.body.includes('scrollImgPreview'));
        assert.ok(html.body.includes('chatImgLightbox'));
        assert.ok(html.body.includes('openChatImgLightbox'));
        assert.ok(html.body.includes('bookColOffsets'));
        assert.ok(html.body.includes('getBookSpreadScrollLeft'));
        assert.ok(html.body.includes('setBookViewportScrollLeft'));
        assert.ok(html.body.includes('bookEndPad'));
        assert.ok(html.body.includes('botWidgetHtml'));
        assert.ok(html.body.includes('extractFixedFromContainer'));
        assert.ok(html.body.includes('#botBgHost.rs-bg-host'));
        assert.ok(html.body.includes('contain:layout paint !important'));
        assert.ok(html.body.includes('body:not(.tab-chat-active)'));
        assert.ok(html.body.includes('tab-chat-active'));
        assert.ok(html.body.includes('stripUnsafeRootDecls'));
        const sigMatch = html.body.match(/const sig = JSON\.stringify\(\[snap\.charIndex,[\s\S]*?\]\);/);
        assert.ok(sigMatch && !sigMatch[0].includes('st.generating') && !sigMatch[0].includes('st.directGenerating'), 'lastChatRenderSig should not include generating flags');
        const sendMatch = html.body.match(/async function sendMessage\(\) \{[\s\S]*?document\.getElementById\('sendBtn'\)/);
        assert.ok(sendMatch && !sendMatch[0].includes('bookSpreadIdx = -1'), 'sendMessage should preserve current bookSpreadIdx');
        const scriptMatch = html.body.match(/<script>([\s\S]*?)<\/script>/);
        assert.ok(scriptMatch);
        new vm.Script(scriptMatch[1], { filename: 'webapp-bots-sync-inline.js' });

        // Verify extractCssBgImageUrl behavior in VM
        const bgFnMatch = scriptMatch[1].match(/function extractCssBgImageUrl[\s\S]*?function ensureBotAssetRatio/);
        assert.ok(bgFnMatch);
        const bgCtx = {};
        vm.runInNewContext(bgFnMatch[0].replace(/function ensureBotAssetRatio$/, ''), bgCtx);
        assert.equal(bgCtx.extractCssBgImageUrl('url("/api/asset/abc")'), '/api/asset/abc');
        assert.equal(bgCtx.extractCssBgImageUrl("url('https://example.com/a.png')"), 'https://example.com/a.png');
        assert.equal(bgCtx.extractCssBgImageUrl('linear-gradient(135deg, #fff, #000)'), '');
        assert.equal(bgCtx.extractCssBgImageUrl('none'), '');

        // Verify sanitizeBotCss, scopeBotCss, and stripBotFixedMenuNodes behavior directly
        const fnMatch = scriptMatch[1].match(/function sanitizeBotCss[\s\S]*?function sanitizeBotNode/);
        assert.ok(fnMatch);
        const scopeCtx = {};
        vm.runInNewContext(fnMatch[0].replace(/function sanitizeBotNode$/, ''), scopeCtx);
        const scopedBtn = scopeCtx.scopeBotCss('.btn { width: 44px; border-radius: 50%; }');
        assert.match(scopedBtn, /^\s*\.rs-bot-html \.btn\s*\{/);
        const scopedKf = scopeCtx.scopeBotCss('@keyframes spin { from { opacity: 0; } to { opacity: 1; } }');
        assert.ok(scopedKf.includes('@keyframes spin') && !scopedKf.includes('.rs-bot-html from'));
        const scopedMedia = scopeCtx.scopeBotCss('@media (max-width: 768px) { .btn { width: 40px; } }');
        assert.ok(scopedMedia.includes('@media (max-width: 768px)') && scopedMedia.includes('.rs-bot-html .btn'));
        const scopedRoot = scopeCtx.scopeBotCss(':root { --x: 1; position: fixed; }');
        assert.ok(scopedRoot.includes('.rs-bot-html{') || scopedRoot.includes('.rs-bot-html {'));
        assert.ok(scopedRoot.includes('--x: 1') && !/position\s*:/i.test(scopedRoot));
        const scopedBodyOverlay = scopeCtx.scopeBotCss('html, body { position: fixed !important; inset: 0; height: 100vh; z-index: 99999; overflow: hidden; display: block; background: linear-gradient(135deg, #faf8f5, #efe7d8); color: #333; }');
        assert.ok(scopedBodyOverlay.includes('#botBgHost'), 'bare html/body rules should target #botBgHost');
        assert.ok(scopedBodyOverlay.includes('linear-gradient(135deg, #faf8f5, #efe7d8)'));
        assert.ok(scopedBodyOverlay.includes('color: #333'));
        assert.ok(!/(?:position|inset|height|z-index|overflow|display)\s*:/i.test(scopedBodyOverlay), 'viewport-hijacking props must be stripped from html/body');
        const scopedDescendant = scopeCtx.scopeBotCss('body .card { position: relative; color: red; }');
        assert.ok(scopedDescendant.includes('.rs-bot-html .card') && scopedDescendant.includes('position: relative'));
        const scopedIs = scopeCtx.scopeBotCss(':is(.a, .b) { color: red; }');
        assert.ok(scopedIs.includes('.rs-bot-html :is(.a, .b)'));

        // .x-risu- prefix alias expansion (class & attribute selectors)
        const scopedRisuCls = scopeCtx.scopeBotCss('.x-risu-cg-card .x-risu-cg-item { display: flex; }');
        assert.ok(scopedRisuCls.includes('.rs-bot-html .x-risu-cg-card .x-risu-cg-item'));
        assert.ok(scopedRisuCls.includes('.rs-bot-html .cg-card .cg-item'));
        const scopedRisuAttr = scopeCtx.scopeBotCss('[class^="x-risu-cg-"] { color: #111; }');
        assert.ok(scopedRisuAttr.includes('.rs-bot-html [class^="x-risu-cg-"]'));
        assert.ok(scopedRisuAttr.includes('.rs-bot-html [class^="cg-"]'));

        // Unquoted Google Fonts @import with semicolons inside url(...) must not break downstream rules
        const gfontCss = '@import url(https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700&display=swap); .cg-card { display: flex; }';
        const scopedGfont = scopeCtx.scopeBotCss(gfontCss);
        assert.ok(scopedGfont.includes('@import url(https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700&display=swap);'));
        assert.ok(scopedGfont.includes('.rs-bot-html .cg-card{ display: flex; }') || scopedGfont.includes('.rs-bot-html .cg-card { display: flex; }') || scopedGfont.includes('.rs-bot-html .cg-card{'));

        // sanitizeBotCss allows quoted https @import and cleanly strips unsafe http @import
        const sanAllowed = scopeCtx.sanitizeBotCss('@import "https://fonts.googleapis.com/css2?family=Inter:wght@400;700"; .ok { color: green; }');
        assert.ok(sanAllowed.includes('@import "https://fonts.googleapis.com/css2?family=Inter:wght@400;700";'));
        const sanBlocked = scopeCtx.sanitizeBotCss('@import url(http://evil.example/x.css); .ok { color: green; }');
        assert.ok(!sanBlocked.includes('evil.example') && sanBlocked.includes('.ok { color: green; }'));

        // Custom properties on html/body propagate to .rs-bot-html as well as #botBgHost
        const scopedBodyVars = scopeCtx.scopeBotCss('body { --cg-accent: #ff0; background: #fff; position: fixed; }');
        assert.ok(scopedBodyVars.includes('#botBgHost{') && scopedBodyVars.includes('background: #fff') && !/position\s*:/i.test(scopedBodyVars));
        assert.ok(scopedBodyVars.includes('.rs-bot-html{--cg-accent: #ff0}'));

        // stripBotFixedMenuNodes preserves <style>, status card checkboxes, and .cg-bg-overlay while stripping real fixed menus
        const fixedMatch = scriptMatch[1].match(/const BOT_FIXED_CLASS_SEL[\s\S]*?function syncBotBackground/);
        assert.ok(fixedMatch);
        const fixedCtx = {};
        vm.runInNewContext(fixedMatch[0].replace(/function syncBotBackground$/, ''), fixedCtx);
        const makeEl = (tag, { cls = '', style = '', type = '', text = '' } = {}) => ({
            nodeType: 1,
            tagName: tag.toUpperCase(),
            className: cls,
            type,
            textContent: text,
            children: [],
            parentElement: null,
            getAttribute(k) { return k === 'style' ? style : (k === 'class' ? cls : null); },
            appendChild(c) { c.parentElement = this; this.children.push(c); return c; },
            remove() {
                if (this.parentElement) {
                    this.parentElement.children = this.parentElement.children.filter((x) => x !== this);
                    this.parentElement = null;
                }
            },
            querySelectorAll(sel) {
                const out = [];
                const parts = sel.split(',').map((s) => s.trim());
                const matchesOne = (node, s) => {
                    if (s === 'style') return node.tagName === 'STYLE';
                    if (s === '.floating') return node.className.split(/\s+/).includes('floating');
                    const attrMatch = s.match(/^\[class\*="([^"]+)"/i);
                    if (attrMatch) return node.className.toLowerCase().includes(attrMatch[1].toLowerCase());
                    const tagStyleMatch = s.match(/^([a-z]+)\[style\]$/i);
                    if (tagStyleMatch) return node.tagName === tagStyleMatch[1].toUpperCase() && Boolean(node.getAttribute('style'));
                    return false;
                };
                const walk = (node) => {
                    for (const c of node.children) {
                        if (parts.some((p) => matchesOne(c, p))) out.push(c);
                        walk(c);
                    }
                };
                walk(this);
                return out;
            },
            querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
        });
        const cardContainer = makeEl('div');
        const cardStyle = cardContainer.appendChild(makeEl('style', { text: '.cg-modal{position:fixed;} .cg-card{display:flex;}' }));
        const cardChk = cardContainer.appendChild(makeEl('input', { type: 'checkbox' }));
        const cardOverlay = cardContainer.appendChild(makeEl('div', { cls: 'cg-bg-overlay' }));
        assert.equal(fixedCtx.containerHasBotFixedMenu(cardContainer), false);
        fixedCtx.stripBotFixedMenuNodes(cardContainer);
        assert.deepEqual(cardContainer.children, [cardStyle, cardChk, cardOverlay]);

        const menuContainer = makeEl('div');
        const menuStyle = menuContainer.appendChild(makeEl('style', { text: '.buttons-container{position:fixed;}' }));
        menuContainer.appendChild(makeEl('input', { type: 'checkbox' }));
        menuContainer.appendChild(makeEl('div', { cls: 'buttons-container' }));
        menuContainer.appendChild(makeEl('div', { cls: 'side-panel' }));
        menuContainer.appendChild(makeEl('div', { cls: 'menu-overlay' }));
        assert.equal(fixedCtx.containerHasBotFixedMenu(menuContainer), true);
        fixedCtx.stripBotFixedMenuNodes(menuContainer);
        assert.deepEqual(menuContainer.children, [menuStyle]);
    } finally {
        await new Promise((r) => server.close(r));
    }

    const pluginSrc = fs.readFileSync(path.join(REPO, 'risustand.js'), 'utf8');
    assert.ok(pluginSrc.includes('function isTrashedEntry('));
    assert.ok(pluginSrc.includes('Boolean(item.trashTime)'));
    assert.ok(pluginSrc.includes('findFirstActiveCharIndex'));
    assert.ok(pluginSrc.includes('if (isTrashedEntry(c)) continue;'));
    assert.ok(pluginSrc.includes('if (isTrashedEntry(ch)) continue;'));
    assert.ok(pluginSrc.includes('x.chats.map((ch) => [ch.index, ch.id, ch.name, ch.msgCount])'));
    assert.ok(pluginSrc.includes('if (catRes && catRes.catalog) lastCatalogSig = catRes.sig;'));
    assert.ok(pluginSrc.includes('if (snapRes && snapRes.snapshot) lastSnapSig = snapRes.sig;'));
    assert.ok(pluginSrc.includes('data && data.needFullSync'));
    assert.ok(pluginSrc.includes('findSafePcAlertModal'));
    assert.ok(pluginSrc.includes('pollPcNativeAlert'));
    assert.ok(pluginSrc.includes("if (heading !== '' && heading !== 'Error') return null;"));
    assert.ok(pluginSrc.includes("if (type === 'dismiss_pc_alert')"));
    assert.ok(pluginSrc.includes("runBotTrigger(cIdx, chIdx, 'onOutput'"));
    assert.ok(pluginSrc.includes('globalToggleValues'));
    assert.ok(pluginSrc.includes('setDatabaseLite({ globalChatVariables: nextGlobal })'));
    assert.ok(pluginSrc.includes('CATALOG_POLL_INTERVAL_MS'));
    assert.ok(pluginSrc.includes('cachedSnapDb'));
});

test('OOM optimizations: /api/asset binary cache, cookie auth, and /api/state revision delta polling', async () => {
    const server = relay.createRelayServer({ token: 'oom-opt-token' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
        const hdrs = { 'X-RisuStand-Token': 'oom-opt-token', 'Content-Type': 'application/json' };
        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04]);
        const dataUri = 'data:image/png;base64,' + pngBytes.toString('base64');

        // 1) PC poll with base64 in assetMap and deduplicated [[RSASSET:a0]] token in messages[0].images
        const poll1 = await requestHttp(port, {
            method: 'POST',
            path: '/api/pc/poll',
            headers: hdrs,
            body: JSON.stringify({
                supportsBatchCommands: true,
                catalog: { characters: [{ index: 0, name: 'Bot', chats: [{ index: 0, id: 'c0', name: 'Chat 1', msgCount: 1 }] }] },
                snapshot: {
                    charIndex: 0,
                    chatIndex: 0,
                    charName: 'Bot',
                    chatName: 'Chat 1',
                    assetMap: { a0: dataUri },
                    messages: [{ index: 0, role: 'char', text: 'hi', html: '<img src="[[RSASSET:a0]]">', images: ['[[RSASSET:a0]]'] }],
                },
            }),
        });
        assert.equal(poll1.status, 200);

        // 2) Full /api/state returns externalized /api/asset/<32hex> URLs and sets rs_asset_sid HttpOnly cookie
        const st1Res = await requestHttp(port, { path: '/api/state', headers: { 'X-RisuStand-Token': 'oom-opt-token' } });
        assert.equal(st1Res.status, 200);
        const setCookie = [].concat(st1Res.headers['set-cookie'] || []).join('; ');
        assert.match(setCookie, /rs_asset_sid=[a-f0-9]{32}/);
        assert.match(setCookie, /HttpOnly/);
        const st1 = JSON.parse(st1Res.body);
        assert.ok(typeof st1.catalogVersion === 'number' && st1.catalogVersion > 0);
        assert.ok(typeof st1.snapshotVersion === 'number' && st1.snapshotVersion > 0);
        const assetUrl = st1.snapshot.assetMap.a0;
        assert.match(assetUrl, /^\/api\/asset\/[a-f0-9]{32}$/);
        assert.equal(st1.snapshot.messages[0].images[0], assetUrl);

        // 3) /api/asset/<id> requires token header or rs_asset_sid cookie
        const unauthAsset = await requestHttp(port, { path: assetUrl });
        assert.equal(unauthAsset.status, 401);

        const cookiePair = setCookie.match(/rs_asset_sid=[a-f0-9]{32}/)[0];
        const assetBin = await new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port, path: assetUrl, headers: { Cookie: cookiePair } }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
            }).on('error', reject);
        });
        assert.equal(assetBin.status, 200);
        assert.equal(assetBin.headers['content-type'], 'image/png');
        assert.match(assetBin.headers['cache-control'] || '', /immutable/);
        assert.deepEqual(assetBin.buf, pngBytes);

        // 4) Unchanged revision poll omits catalog and snapshot
        const stDelta = await requestHttp(port, {
            path: `/api/state?cv=${st1.catalogVersion}&sv=${st1.snapshotVersion}`,
            headers: { 'X-RisuStand-Token': 'oom-opt-token' },
        });
        assert.equal(stDelta.status, 200);
        const deltaJson = JSON.parse(stDelta.body);
        assert.equal('catalog' in deltaJson, false);
        assert.equal('snapshot' in deltaJson, false);

        // 5) Snapshot-only update increments snapshotVersion without catalog
        await requestHttp(port, {
            method: 'POST',
            path: '/api/pc/poll',
            headers: hdrs,
            body: JSON.stringify({
                catalog: null,
                snapshot: { charIndex: 0, chatIndex: 0, charName: 'Bot', chatName: 'Chat 1', assetMap: {}, messages: [] },
            }),
        });
        const stSnapOnly = await requestHttp(port, {
            path: `/api/state?cv=${st1.catalogVersion}&sv=${st1.snapshotVersion}`,
            headers: { 'X-RisuStand-Token': 'oom-opt-token' },
        });
        const snapOnlyJson = JSON.parse(stSnapOnly.body);
        assert.equal('catalog' in snapOnlyJson, false);
        assert.equal('snapshot' in snapOnlyJson, true);
        assert.equal(snapOnlyJson.snapshotVersion, st1.snapshotVersion + 1);

        // 6) Client webapp includes in-flight poll guard, revision params, /api/asset support, and compiles
        const htmlRes = await requestHttp(port, { path: '/' });
        assert.equal(htmlRes.status, 200);
        for (const marker of ['isStatePolling', 'knownCatalogVer', 'knownSnapshotVer', String.raw`\/api\/asset\/`]) {
            assert.ok(htmlRes.body.includes(marker), `Expected client OOM marker: ${marker}`);
        }
        const scriptMatch = htmlRes.body.match(/<script>([\s\S]*?)<\/script>/);
        assert.ok(scriptMatch);
        new vm.Script(scriptMatch[1], { filename: 'webapp-oom-inline.js' });
    } finally {
        await new Promise((r) => server.close(r));
    }
});

test('On-demand PC asset proxy resolves pcpath: and pcinlay: via hostRpc and caches into assetStore', async () => {
    const server = relay.createRelayServer({ token: 'pc-asset-token' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const hdrs = { 'X-RisuStand-Token': 'pc-asset-token', 'Content-Type': 'application/json' };
    const bigPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22, 0x33, 0x44]);
    const inlayPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x55, 0x66, 0x77, 0x88]);
    let stopRpc = false;
    let rpcLoopPromise = null;
    const rpcAbort = new AbortController();

    try {
        await requestHttp(port, {
            method: 'POST',
            path: '/api/pc/poll',
            headers: hdrs,
            body: JSON.stringify({
                catalog: { characters: [{ index: 0, name: 'Bot', chats: [{ index: 0, id: 'c0', name: 'Chat 1', msgCount: 1 }] }] },
                snapshot: {
                    charIndex: 0,
                    chatIndex: 0,
                    charName: 'Bot',
                    chatName: 'Chat 1',
                    assetMap: {
                        a0: 'pcpath:assets/big_portrait.png',
                        a1: 'pcinlay:inlay-9',
                    },
                    messages: [{
                        index: 0,
                        role: 'char',
                        text: 'hi',
                        html: '<img src="[[RSASSET:a0]]"><img src="[[RSASSET:a1]]">',
                        images: ['[[RSASSET:a0]]', '[[RSASSET:a1]]'],
                    }],
                },
            }),
        });

        const stRes = await requestHttp(port, { path: '/api/state', headers: { 'X-RisuStand-Token': 'pc-asset-token' } });
        assert.equal(stRes.status, 200);
        const setCookie = [].concat(stRes.headers['set-cookie'] || []).join('; ');
        const cookiePair = setCookie.match(/rs_asset_sid=[a-f0-9]{32}/)[0];
        const stJson = JSON.parse(stRes.body);
        const a0Url = stJson.snapshot.assetMap.a0;
        const a1Url = stJson.snapshot.assetMap.a1;
        assert.match(a0Url, /^\/api\/asset\/[a-f0-9]{32}$/);
        assert.match(a1Url, /^\/api\/asset\/[a-f0-9]{32}$/);

        // Disconnected PC RPC -> 503 with Cache-Control: no-store
        const disRes = await fetch(`${baseUrl}${a0Url}`, { headers: { Cookie: cookiePair } });
        assert.equal(disRes.status, 503);
        assert.equal(disRes.headers.get('cache-control'), 'no-store');

        // Start mock PC Host RPC loop
        let readImageCalls = 0;
        let readInlayCalls = 0;
        rpcLoopPromise = (async () => {
            while (!stopRpc) {
                try {
                    const wResp = await fetch(`${baseUrl}/api/pc/rpc-wait`, {
                        method: 'POST',
                        headers: hdrs,
                        body: JSON.stringify({ timeoutMs: 2000 }),
                        signal: rpcAbort.signal,
                    });
                    if (!wResp.ok) break;
                    const data = await wResp.json();
                    if (Array.isArray(data.calls) && data.calls.length) {
                        const results = data.calls.map((c) => {
                            if (c.op === 'asset.readImage' && c.args[0] === 'assets/big_portrait.png') {
                                readImageCalls += 1;
                                return { id: c.id, ok: true, value: { __b64: bigPng.toString('base64'), mime: 'image/png' } };
                            }
                            if (c.op === 'asset.readInlay' && c.args[0] === 'inlay-9') {
                                readInlayCalls += 1;
                                return { id: c.id, ok: true, value: { data: 'data:image/png;base64,' + inlayPng.toString('base64') } };
                            }
                            return { id: c.id, ok: false, error: 'unexpected op' };
                        });
                        await fetch(`${baseUrl}/api/pc/rpc-result`, {
                            method: 'POST',
                            headers: hdrs,
                            body: JSON.stringify({ results }),
                            signal: rpcAbort.signal,
                        });
                    }
                } catch (_) {
                    if (stopRpc) break;
                }
            }
        })();
        // Wait briefly for rpc-wait to mark rpcClientActive = true
        await new Promise((r) => setTimeout(r, 40));

        const resA0 = await fetch(`${baseUrl}${a0Url}`, { headers: { Cookie: cookiePair } });
        assert.equal(resA0.status, 200);
        assert.equal(resA0.headers.get('content-type'), 'image/png');
        assert.deepEqual(Buffer.from(await resA0.arrayBuffer()), bigPng);
        assert.equal(readImageCalls, 1);

        // Second request served from assetStore cache without another RPC
        const resA0Cached = await fetch(`${baseUrl}${a0Url}`, { headers: { Cookie: cookiePair } });
        assert.equal(resA0Cached.status, 200);
        assert.deepEqual(Buffer.from(await resA0Cached.arrayBuffer()), bigPng);
        assert.equal(readImageCalls, 1);

        const resA1 = await fetch(`${baseUrl}${a1Url}`, { headers: { Cookie: cookiePair } });
        assert.equal(resA1.status, 200);
        assert.equal(resA1.headers.get('content-type'), 'image/png');
        assert.deepEqual(Buffer.from(await resA1.arrayBuffer()), inlayPng);
        assert.equal(readInlayCalls, 1);
    } finally {
        stopRpc = true;
        rpcAbort.abort();
        if (rpcLoopPromise) await rpcLoopPromise.catch(() => {});
        await new Promise((r) => server.close(r));
    }
});

test('request logs API records proxy non-stream, stream & error calls, redacts secrets, and serves UI', async () => {
    const upstream = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/v1/chat/completions') {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                const lastText = Array.isArray(body.messages) && body.messages.length
                    ? String(body.messages[body.messages.length - 1].content || '')
                    : '';
                if (lastText.includes('FORCE_ERR')) {
                    res.writeHead(429, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Rate limited upstream' } }));
                    return;
                }
                if (body.stream) {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream; charset=utf-8',
                        'Cache-Control': 'no-cache',
                    });
                    res.write('data: ' + JSON.stringify({
                        id: 'c1',
                        model: 'mock-gpt-stream',
                        choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello ' }, finish_reason: null }],
                    }) + '\n\n');
                    res.write('data: ' + JSON.stringify({
                        id: 'c1',
                        model: 'mock-gpt-stream',
                        choices: [{ index: 0, delta: { content: 'streamed world!' }, finish_reason: 'stop' }],
                        usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
                    }) + '\n\n');
                    res.write('data: [DONE]\n\n');
                    res.end();
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    id: 'c0',
                    model: 'mock-gpt',
                    choices: [{ index: 0, message: { role: 'assistant', content: 'Non-stream hello' }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
                }));
            });
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const { port: upstreamPort } = upstream.address();

    const secretApiKey = 'sk-top-secret-key-9999';
    const tok = 'log-test-token-42';
    const server = relay.createRelayServer({
        token: tok,
        configOverride: {
            activeProfileId: 'p1',
            presetToggles: [],
            profiles: [{
                id: 'p1',
                name: 'TestMock',
                provider: 'custom',
                providerType: 'openai_compat',
                baseUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
                apiKey: secretApiKey,
                model: 'mock-gpt',
                temperature: '',
                maxTokens: '',
                overrideMode: 'off',
                systemOverride: '',
            }],
            translator: {
                useActiveProfile: true,
                autoTranslateOutput: false,
                autoTranslateInput: false,
            },
        },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
        const authHdr = { 'X-RisuStand-Token': tok, 'Content-Type': 'application/json' };

        // 1) Auth guard
        const unauthLogs = await requestHttp(port, { path: '/api/logs' });
        assert.equal(unauthLogs.status, 401);

        // Start clean
        const clr0 = await requestHttp(port, { method: 'DELETE', path: '/api/logs', headers: authHdr });
        assert.equal(clr0.status, 200);

        // 2) Non-stream proxy call
        const nonStreamRes = await requestHttp(port, {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'risustand-router',
                stream: false,
                messages: [
                    { role: 'system', content: 'You are a test system.' },
                    { role: 'user', content: 'Say hi cleanly' },
                ],
            }),
        });
        assert.equal(nonStreamRes.status, 200);
        assert.equal(JSON.parse(nonStreamRes.body).choices[0].message.content, 'Non-stream hello');

        const list1 = JSON.parse((await requestHttp(port, { path: '/api/logs', headers: authHdr })).body);
        assert.equal(list1.logs.length, 1);
        assert.equal(list1.logs[0].ok, true);
        assert.equal(list1.logs[0].status, 200);
        assert.equal(list1.logs[0].source, 'proxy');
        assert.equal(list1.logs[0].stream, false);
        assert.equal(list1.logs[0].usage.total_tokens, 17);

        const detail1Res = await requestHttp(port, {
            path: `/api/logs/${encodeURIComponent(list1.logs[0].id)}`,
            headers: authHdr,
        });
        assert.equal(detail1Res.status, 200);
        assert.ok(!detail1Res.body.includes(secretApiKey), 'API key must not leak in request log detail');
        const detail1 = JSON.parse(detail1Res.body).log;
        assert.equal(detail1.headers.Authorization, 'Bearer [REDACTED]');
        assert.equal(detail1.responseText, 'Non-stream hello');
        assert.equal(detail1.messages.length, 2);
        assert.equal(detail1.messages[1].content, 'Say hi cleanly');

        // 3) Stream passthrough proxy call
        const streamRes = await requestHttp(port, {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'risustand-router',
                stream: true,
                messages: [{ role: 'user', content: 'Stream something' }],
            }),
        });
        assert.equal(streamRes.status, 200);
        assert.ok(streamRes.body.includes('streamed world!'));

        const list2 = JSON.parse((await requestHttp(port, { path: '/api/logs', headers: authHdr })).body);
        assert.equal(list2.logs.length, 2);
        assert.equal(list2.logs[0].stream, true);
        assert.equal(list2.logs[0].ok, true);
        assert.equal(list2.logs[0].status, 200);
        const detail2Res = await requestHttp(port, {
            path: `/api/logs/${encodeURIComponent(list2.logs[0].id)}`,
            headers: authHdr,
        });
        assert.ok(!detail2Res.body.includes(secretApiKey));
        const detail2 = JSON.parse(detail2Res.body).log;
        assert.equal(detail2.responseText, 'Hello streamed world!');
        assert.equal(detail2.usage.total_tokens, 12);

        // 4) Error upstream call
        const errRes = await requestHttp(port, {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'risustand-router',
                stream: false,
                messages: [{ role: 'user', content: 'FORCE_ERR' }],
            }),
        });
        assert.equal(errRes.status, 502);

        const list3 = JSON.parse((await requestHttp(port, { path: '/api/logs', headers: authHdr })).body);
        assert.equal(list3.logs.length, 3);
        assert.equal(list3.logs[0].ok, false);
        assert.equal(list3.logs[0].status, 429);
        assert.ok(list3.logs[0].error.includes('Rate limited upstream'));

        // 5) Clear logs
        const clr1 = await requestHttp(port, { method: 'DELETE', path: '/api/logs', headers: authHdr });
        assert.equal(clr1.status, 200);
        const list4 = JSON.parse((await requestHttp(port, { path: '/api/logs', headers: authHdr })).body);
        assert.equal(list4.logs.length, 0);

        // 6) Web UI includes Request Log viewer markers & compiles
        const htmlRes = await requestHttp(port, { path: '/' });
        assert.equal(htmlRes.status, 200);
        for (const marker of ['reqLogQuickBtn', 'reqLogModal', 'reqLogCard', 'reqLogList', 'loadRequestLogs', 'openRequestLogDetail', '.req-log-body > * { flex-shrink:0; }', 'reqLogMsgSearch', 'data-copy-msg-idx', 'data-log-expand-all']) {
            assert.ok(htmlRes.body.includes(marker), `Expected Request Log UI marker: ${marker}`);
        }
        const scriptMatch = htmlRes.body.match(/<script>([\s\S]*?)<\/script>/);
        assert.ok(scriptMatch);
        new vm.Script(scriptMatch[1], { filename: 'webapp-reqlogs-inline.js' });
    } finally {
        await new Promise((r) => server.close(r));
        await new Promise((r) => upstream.close(r));
    }
});

test('CBS evaluator & Leave r1.1 direct prompt builder honor global and local toggles', () => {
    const cbsCtx = {
        charName: 'Alice',
        personaName: 'Bob',
        globalVars: {
            toggle_ooc_mode: '0',
            toggle_bianca_inject: '1',
            toggle_flag_a: '0',
            toggle_flag_b: '1',
        },
        chatVars: { nsfw_mode: '1' },
    };
    const nested = relay.evalPresetCbs(
        '{{#if {{equal::{{getglobalvar::toggle_ooc_mode}}::0}}}}' +
        'Hello {{user}} & {{char}}! ' +
        '{{#if_pure {{any::{{getglobalvar::toggle_flag_a}}::{{getglobalvar::toggle_flag_b}}}}}}ANY_OK{{:else}}ANY_NO{{/if}} ' +
        '{{#if {{equal::{{getvar::nsfw_mode}}::1}}}}NSFW_ON{{/if}}' +
        '{{:else}}OOC_ONLY{{/if}}',
        cbsCtx
    );
    assert.equal(nested, 'Hello Bob & Alice! ANY_OK NSFW_ON');

    const leave = relay.loadBundledLeavePreset();
    assert.ok(leave && leave.promptTemplate.length === 21);

    const baseSnap = {
        charName: 'Cheongwon High School',
        charContext: {
            name: 'Cheongwon High School',
            desc: 'Campus simulation.',
            personaName: 'Puding',
            personaPrompt: 'Student.',
            moduleLore: 'Safe lore.\n{{#if {{equal::{{getvar::nsfw_mode}}::1}}}}NSFW_LORE_TAG{{/if}}',
            note: 'Author focus note.',
        },
        chatVariables: { nsfw_mode: '1' },
        useLocallySetGlobalVariables: false,
        globalToggleValues: {},
        localToggleValues: {},
    };
    const history = [
        { index: 0, role: 'user', raw: 'Morning.' },
        { index: 1, role: 'char', raw: 'Class starts soon.' },
    ];

    // 1) Default toggles: Bianca omitted, OOC omitted, 09. Commitment Lock sits AFTER latest user input, NSFW lore resolved
    const defaultMsgs = relay.buildDirectPromptMessages({
        preset: leave,
        snap: baseSnap,
        historyMessages: history,
        userText: 'Enter the classroom.',
        remoteToggleValues: {},
    });
    const combinedDefault = defaultMsgs.map((m) => m.content).join('\n');
    assert.ok(!combinedDefault.includes('BIANCA WORKSPACE PERSONA'), 'Bianca should be off by default');
    assert.ok(!combinedDefault.includes('[LEAVE OOC COMMITMENT LOCK'), 'OOC lock should be off by default');
    assert.ok(combinedDefault.includes('NSFW_LORE_TAG'), 'chat variable nsfw_mode=1 should resolve inside lorebook');
    assert.ok(combinedDefault.includes('STEP 3 — CHARACTER-CARD STATUS LINE'), 'Commitment lock should be present');
    assert.ok(!/\{\{#if|\{\{getglobalvar|\{\{\/if\}\}/.test(combinedDefault), 'No unresolved preset CBS macros should remain');
    const lastUserIdx = defaultMsgs.map((m) => m.role).lastIndexOf('user');
    assert.equal(defaultMsgs[lastUserIdx].content, 'Enter the classroom.');
    assert.ok(lastUserIdx < defaultMsgs.length - 1, 'Commitment lock must appear after latest user turn');
    assert.ok(defaultMsgs[defaultMsgs.length - 1].content.includes('STEP 3 — CHARACTER-CARD STATUS LINE'));

    // 2) Remote toggles: enable Bianca writing discipline ('1') + English output HUD
    const biancaMsgs = relay.buildDirectPromptMessages({
        preset: leave,
        snap: baseSnap,
        historyMessages: history,
        userText: 'Enter the classroom.',
        remoteToggleValues: { toggle_bianca_inject: '1', toggle_output_lang: '1' },
    });
    const combinedBianca = biancaMsgs.map((m) => m.content).join('\n');
    assert.ok(combinedBianca.includes('BIANCA WRITING DISCIPLINE — PROSE CRAFT, EDITORIAL CHECKS & MATURE REGISTER ONLY'));
    assert.ok(!combinedBianca.includes('BIANCA WORKSPACE PERSONA — this module governs prose voice'));
    assert.ok(combinedBianca.includes('Leave HUD · [Time] · [Location]'));

    // 2b) Remote toggles: enable full Bianca persona ('2') + DeepSeek model adapter ('4')
    const biancaFullMsgs = relay.buildDirectPromptMessages({
        preset: leave,
        snap: baseSnap,
        historyMessages: history,
        userText: 'Enter the classroom.',
        remoteToggleValues: { toggle_bianca_inject: '2', toggle_model_adapter: '4' },
    });
    const combinedBiancaFull = biancaFullMsgs.map((m) => m.content).join('\n');
    assert.ok(combinedBiancaFull.includes('BIANCA WORKSPACE PERSONA — this module governs prose voice'));
    assert.ok(!/\{\{#if|\{\{getglobalvar|\{\{\/if\}\}/.test(combinedBiancaFull), 'No unresolved preset CBS macros should remain with DeepSeek adapter');

    // 3) OOC mode on globally -> OOC lock active; then overridden locally to OFF -> narrative restored
    const oocMsgs = relay.buildDirectPromptMessages({
        preset: leave,
        snap: baseSnap,
        historyMessages: history,
        userText: 'Summarize the scene.',
        remoteToggleValues: { toggle_ooc_mode: '1' },
    });
    const combinedOoc = oocMsgs.map((m) => m.content).join('\n');
    assert.ok(combinedOoc.includes('[LEAVE OOC COMMITMENT LOCK — DIRECT REPLY]'));
    assert.ok(!combinedOoc.includes('STEP 3 — CHARACTER-CARD STATUS LINE'));

    const localOverrideMsgs = relay.buildDirectPromptMessages({
        preset: leave,
        snap: {
            ...baseSnap,
            useLocallySetGlobalVariables: true,
            localToggleValues: { toggle_ooc_mode: '0', toggle_bianca_inject: '1' },
        },
        historyMessages: history,
        userText: 'Back to IC.',
        remoteToggleValues: { toggle_ooc_mode: '1', toggle_bianca_inject: '0' },
    });
    const combinedLocal = localOverrideMsgs.map((m) => m.content).join('\n');
    assert.ok(combinedLocal.includes('STEP 3 — CHARACTER-CARD STATUS LINE'), 'Local toggle should override remote global OOC toggle');
    assert.ok(combinedLocal.includes('BIANCA WRITING DISCIPLINE — PROSE CRAFT, EDITORIAL CHECKS & MATURE REGISTER ONLY'), 'Local bianca toggle should override global');

    // 4) Preset null -> legacy minimal single-system prompt
    const legacyMsgs = relay.buildDirectPromptMessages({
        preset: null,
        snap: baseSnap,
        historyMessages: history,
        userText: 'Hi',
    });
    assert.equal(legacyMsgs[0].role, 'system');
    assert.ok(legacyMsgs[0].content.includes('You are roleplaying as Cheongwon High School'));
});

test('direct remote chat applies Leave preset + remote toggles & supports custom .risup upload API', async () => {
    const capturedPayloads = [];
    const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            capturedPayloads.push(body);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                id: 'direct-1',
                model: body.model || 'mock-model',
                choices: [{ index: 0, message: { role: 'assistant', content: 'Leave remote reply' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
            }));
        });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = upstream.address().port;

    const tok = 'direct-preset-test-tok';
    const server = relay.createRelayServer({
        token: tok,
        configOverride: {
            activeProfileId: 'mock-direct',
            directPresetId: 'bundled:leave',
            remoteToggleValues: {},
            presetToggles: [{ id: 'preset-leave-r1.1', name: 'Old Leave', enabled: true, syntax: 'ooc_mode=old' }],
            profiles: [{
                id: 'mock-direct',
                name: 'MockDirect',
                providerType: 'openai_compat',
                baseUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
                apiKey: 'mock-key',
                model: 'deepseek-test',
                temperature: '',
                maxTokens: '',
                overrideMode: 'off',
                systemOverride: '',
            }],
            translator: { useActiveProfile: true, autoTranslateOutput: false, autoTranslateInput: false },
        },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    try {
        const hdrs = { 'X-RisuStand-Token': tok, 'Content-Type': 'application/json' };

        // 0) Stale bundled Leave preset toggle entry is auto-refreshed on GET /api/router/config
        const cfgRes = await requestHttp(port, { path: '/api/router/config', headers: hdrs });
        assert.equal(cfgRes.status, 200);
        const cfgJson = JSON.parse(cfgRes.body);
        const leaveToggleEntry = (cfgJson.presetToggles || []).find((pt) => pt.id === 'preset-leave-r1.1');
        assert.ok(leaveToggleEntry);
        assert.ok(leaveToggleEntry.syntax.includes('bianca_inject=비앙카 투입 (기본: 꺼짐)=select='));
        assert.ok(leaveToggleEntry.syntax.includes('DeepSeek 계열'));

        // 1) Toggle bianca_inject globally via /api/command -> persisted in relay remoteToggleValues
        const togRes = await requestHttp(port, {
            method: 'POST',
            path: '/api/command',
            headers: hdrs,
            body: JSON.stringify({
                type: 'set_custom_toggle',
                payload: { charIndex: 1, chatIndex: 0, key: 'bianca_inject', value: '1', scope: 'global' },
            }),
        });
        assert.equal(togRes.status, 200);

        // 2) Sync a non-PC-active character without DOM switch (direct_router fallback)
        await requestHttp(port, {
            method: 'POST',
            path: '/api/pc/poll',
            headers: hdrs,
            body: JSON.stringify({
                bridgeVersion: '2.0.0',
                generating: false,
                supportsBatchCommands: true,
                catalog: { characters: [{ index: 1, name: 'Bot', chats: [{ index: 0, id: 'c0', name: 'Chat 1', msgCount: 1 }] }] },
                snapshot: {
                    charIndex: 1,
                    chatIndex: 0,
                    charName: 'Bot',
                    chatName: 'Chat 1',
                    isPcActive: false,
                    canPcSwitch: false,
                    useLocallySetGlobalVariables: false,
                    globalToggleValues: {},
                    localToggleValues: {},
                    chatVariables: { nsfw_mode: '0' },
                    charContext: {
                        name: 'Bot',
                        desc: 'Bot desc',
                        personaName: 'Tester',
                        personaPrompt: 'User persona',
                        moduleLore: 'Safe entry.',
                    },
                    messages: [{ index: 0, role: 'char', raw: 'Greeting' }],
                },
            }),
        });

        // 3) Send message -> direct_router -> upstream receives Leave preset + Bianca persona!
        const sendRes = await requestHttp(port, {
            method: 'POST',
            path: '/api/chat/send',
            headers: hdrs,
            body: JSON.stringify({ charIndex: 1, chatIndex: 0, text: 'Hello Leave!' }),
        });
        assert.equal(sendRes.status, 200);
        assert.equal(JSON.parse(sendRes.body).mode, 'direct_router');

        for (let i = 0; i < 40 && capturedPayloads.length === 0; i += 1) {
            await new Promise((r) => setTimeout(r, 25));
        }
        assert.equal(capturedPayloads.length, 1);
        const sentMsgs = capturedPayloads[0].messages;
        assert.ok(sentMsgs.length >= 8, `Expected multi-message Leave template, got ${sentMsgs.length}`);
        const sentAll = sentMsgs.map((m) => m.content).join('\n');
        assert.ok(sentAll.includes('BIANCA WRITING DISCIPLINE — PROSE CRAFT, EDITORIAL CHECKS & MATURE REGISTER ONLY'), 'Remote global toggle must apply to direct remote chat');
        assert.ok(sentMsgs[sentMsgs.length - 1].content.includes('STEP 3 — CHARACTER-CARD STATUS LINE'));

        // 4) Custom .risup upload, selection, and deletion APIs
        const risupB64 = fs.readFileSync(path.join(REPO, 'prompt', 'Leave_RisuAI_Preset.risup')).toString('base64');
        const upRes = await requestHttp(port, {
            method: 'POST',
            path: '/api/presets/custom',
            headers: hdrs,
            body: JSON.stringify({ filename: 'MyCustomLeave.risup', dataBase64: risupB64, registerToggle: true }),
        });
        assert.equal(upRes.status, 200);
        const upJson = JSON.parse(upRes.body);
        assert.ok(upJson.preset && upJson.preset.id.startsWith('custom:'));
        assert.equal(upJson.config.directPresetId, upJson.preset.id);
        assert.ok(upJson.config.presetToggles.some((pt) => pt.id === `pt-${upJson.preset.customId}`));

        const delRes = await requestHttp(port, {
            method: 'DELETE',
            path: `/api/presets/custom/${encodeURIComponent(upJson.preset.customId)}`,
            headers: hdrs,
        });
        assert.equal(delRes.status, 200);
        const delJson = JSON.parse(delRes.body);
        assert.equal(delJson.config.directPresetId, 'bundled:leave');
        assert.equal(delJson.config.presetToggles.some((pt) => pt.id === `pt-${upJson.preset.customId}`), false);

        // 5) Web UI renders preset selector + upload controls and compiles cleanly
        const html = await requestHttp(port, { path: '/' });
        assert.equal(html.status, 200);
        for (const marker of ['directPresetCard', 'directPresetSel', 'directPresetUploadBtn', 'directPresetDelBtn', 'backendPluginsCard', 'pluginGuiModal', '백엔드 플러그인 어댑터']) {
            assert.ok(html.body.includes(marker), `Expected UI marker: ${marker}`);
        }
        const scriptMatch = html.body.match(/<script>([\s\S]*?)<\/script>/);
        assert.ok(scriptMatch);
        new vm.Script(scriptMatch[1], { filename: 'webapp-direct-preset-inline.js' });
    } finally {
        await new Promise((r) => server.close(r));
        await new Promise((r) => upstream.close(r));
    }
});

test('remote preset auto-registers own toggles and activates/shows presetToggles only while parent remote preset is active', async () => {
    const tok = 'tok-preset-lifecycle';
    const server = relay.createRelayServer({
        token: tok,
        configOverride: {
            activeProfileId: 'off',
            directPresetId: 'bundled:leave',
            remoteToggleValues: {},
            presetToggles: [],
            profiles: [],
        },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    try {
        const hdrs = { 'X-RisuStand-Token': tok, 'Content-Type': 'application/json' };

        // 1) Initial config with bundled:leave & empty presetToggles -> Leave toggle entry auto-registered & enabled
        const cfg0 = JSON.parse((await requestHttp(port, { path: '/api/router/config', headers: hdrs })).body);
        const leave0 = (cfg0.presetToggles || []).find((pt) => pt.id === 'preset-leave-r1.1');
        assert.ok(leave0, 'Bundled Leave toggles must auto-register without manual install');
        assert.equal(leave0.parentPresetId, 'bundled:leave');
        assert.equal(leave0.enabled, true);

        // 2) Upload Custom Preset A with its own customPromptTemplateToggle -> auto-registered & enabled, Leave auto-disabled
        const upA = JSON.parse((await requestHttp(port, {
            method: 'POST',
            path: '/api/presets/custom',
            headers: hdrs,
            body: JSON.stringify({
                filename: 'AlphaPreset.json',
                jsonObject: {
                    name: 'Alpha Own-Toggle Preset',
                    customPromptTemplateToggle: 'alpha_mode=알파 모드=select=끄기,켜기',
                    promptTemplate: [{ type: 'plain', role: 'system', text: 'Alpha {{#if {{? {{getglobalvar::toggle_alpha_mode}}=1}}}}ON{{/if}}' }],
                },
            }),
        })).body);
        assert.equal(upA.ok, true);
        const idA = upA.preset.id;
        const ptIdA = `pt-${upA.preset.customId}`;
        const alphaOnUpload = upA.config.presetToggles.find((pt) => pt.id === ptIdA);
        const leaveAfterA = upA.config.presetToggles.find((pt) => pt.id === 'preset-leave-r1.1');
        assert.ok(alphaOnUpload && alphaOnUpload.enabled === true && alphaOnUpload.parentPresetId === idA);
        assert.ok(leaveAfterA && leaveAfterA.enabled === false, 'Inactive Leave preset toggles must be disabled when replaced');

        // 3) Upload Custom Preset B without own toggles -> both Leave and Alpha auto-disabled
        const upB = JSON.parse((await requestHttp(port, {
            method: 'POST',
            path: '/api/presets/custom',
            headers: hdrs,
            body: JSON.stringify({
                filename: 'BetaNoToggle.json',
                jsonObject: {
                    name: 'Beta Module-Driven Preset',
                    customPromptTemplateToggle: '',
                    promptTemplate: [{ type: 'plain', role: 'system', text: 'Beta base' }],
                },
            }),
        })).body);
        assert.equal(upB.ok, true);
        const idB = upB.preset.id;
        assert.equal(upB.config.directPresetId, idB);
        assert.equal(upB.config.presetToggles.find((pt) => pt.id === ptIdA).enabled, false);
        assert.equal(upB.config.presetToggles.find((pt) => pt.id === 'preset-leave-r1.1').enabled, false);

        // 4) Switch direct preset back to Alpha -> Alpha re-enabled, Leave remains disabled
        const swA = JSON.parse((await requestHttp(port, {
            method: 'POST',
            path: '/api/presets/direct',
            headers: hdrs,
            body: JSON.stringify({ directPresetId: idA }),
        })).body);
        assert.equal(swA.directPresetId, idA);
        assert.equal(swA.presetToggles.find((pt) => pt.id === ptIdA).enabled, true);
        assert.equal(swA.presetToggles.find((pt) => pt.id === 'preset-leave-r1.1').enabled, false);

        // 5) Switch direct preset to off -> all parent-bound preset toggles disabled
        const swOff = JSON.parse((await requestHttp(port, {
            method: 'POST',
            path: '/api/presets/direct',
            headers: hdrs,
            body: JSON.stringify({ directPresetId: 'off' }),
        })).body);
        assert.equal(swOff.directPresetId, 'off');
        assert.equal(swOff.presetToggles.find((pt) => pt.id === ptIdA).enabled, false);
        assert.equal(swOff.presetToggles.find((pt) => pt.id === 'preset-leave-r1.1').enabled, false);

        // 6) Switch back to bundled:leave -> Leave re-enabled, Alpha stays disabled
        const swLeave = JSON.parse((await requestHttp(port, {
            method: 'POST',
            path: '/api/presets/direct',
            headers: hdrs,
            body: JSON.stringify({ directPresetId: 'bundled:leave' }),
        })).body);
        assert.equal(swLeave.directPresetId, 'bundled:leave');
        assert.equal(swLeave.presetToggles.find((pt) => pt.id === 'preset-leave-r1.1').enabled, true);
        assert.equal(swLeave.presetToggles.find((pt) => pt.id === ptIdA).enabled, false);

        // 7) Verify Web UI client bindings (#leavePresetBar, #ptParentPreset, renderCustomToggles(true) on preset switch, valid JS)
        const html = await requestHttp(port, { path: '/' });
        assert.equal(html.status, 200);
        assert.ok(html.body.includes('id="leavePresetBar"'));
        assert.ok(html.body.includes('id="ptParentPreset"'));
        assert.ok(html.body.includes("if (parentId && parentId !== curDirectId) return false;"));
        const scriptMatch = html.body.match(/<script>([\s\S]*?)<\/script>/);
        assert.ok(scriptMatch);
        new vm.Script(scriptMatch[1], { filename: 'webapp-parent-toggle-lifecycle.js' });
    } finally {
        await new Promise((r) => server.close(r));
    }
});

test('Cheongwon High School regression: large lorebooks (>6k), character sheet scanDepth, @@depth postEverything, {{#when}}, and replaceGlobalNote', async () => {
    const capturedPayloads = [];
    const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            capturedPayloads.push(body);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                id: 'cw-1',
                model: body.model || 'mock-model',
                choices: [{ index: 0, message: { role: 'assistant', content: 'Reply' }, finish_reason: 'stop' }],
            }));
        });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = upstream.address().port;

    const tok = 'cw-lore-regression-tok';
    const server = relay.createRelayServer({
        token: tok,
        configOverride: {
            activeProfileId: 'mock-cw',
            directPresetId: 'bundled:leave',
            remoteToggleValues: {},
            presetToggles: [],
            profiles: [{
                id: 'mock-cw',
                name: 'MockCW',
                providerType: 'openai_compat',
                baseUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
                apiKey: 'mock-key',
                model: 'deepseek-test',
                temperature: '',
                maxTokens: '',
                overrideMode: 'off',
                systemOverride: '',
            }],
            translator: { useActiveProfile: true, autoTranslateOutput: false, autoTranslateInput: false },
        },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    try {
        const leave = relay.loadBundledLeavePreset();
        const loreEntries = [
            { key: '', comment: 'LBDATA', alwaysActive: true, insertorder: 200, content: 'X'.repeat(2800) },
            { key: '', comment: '기본 정보', alwaysActive: true, insertorder: 190, content: 'Y'.repeat(2800) },
            { key: '', comment: 'Asset Prompt', alwaysActive: true, insertorder: 150, content: '@@depth 00\n<img src={name}_{outfit}_{keyword}>' },
            { key: '', comment: 'Bot Status Bar', alwaysActive: true, insertorder: 50, content: '@@depth 0\nAlways emit status line: [☀️][7°C][YYYY.MM.DD][AM/PM HH:MM][Location][Action]{{#when::nsfw_mode::is::1}}\nNSFW_ACTIVE{{/when}}{{#when::hud_bar::tis::0}}\nHUD_DEFAULT_ON{{/when}}' },
            {
                key: '',
                comment: '♥️ 호감도 (Love Guages)',
                alwaysActive: true,
                insertorder: 60,
                content: '@@depth 0\n{{#func getAffectionBehavior}}' +
                    '{{#if {{calc:: ({{arg::1}} < 0) && ({{arg::1}} >= -100) }}}}(Stage -1: 경계/불신){{/if}}' +
                    '{{#if {{calc:: ({{arg::1}} >= 0) && ({{arg::1}} < 100) }}}}(Stage 0: 중립){{/if}}' +
                    '{{#if {{calc:: {{arg::1}} >= 100 }}}}(Stage 1: 호의){{/if}}' +
                    '{{/func}}' +
                    '강다인: {{getvar::dain_c}}/500 | {{call::getAffectionBehavior::{{getvar::dain_c}}}}\n' +
                    '서민지: {{getvar::minji_c}}/500 | {{call::getAffectionBehavior::{{getvar::minji_c}}}}',
            },
            { key: '다인,강다인', comment: '강다인', alwaysActive: false, insertorder: 120, content: 'Character Sheet: 강다인 (음악실 자주 방문).' },
            { key: '음악실', comment: '음악실', alwaysActive: false, insertorder: 110, content: 'Location Detail: 신관 음악실.' },
        ];

        const messages = [
            { index: 0, role: 'user', raw: '방과 후 다인과 음악실로 향했다.' },
            { index: 1, role: 'char', raw: '음악실 문이 열렸다.' },
            { index: 2, role: 'user', raw: '그녀의 손을 잡았다.' },
            { index: 3, role: 'char', raw: '그녀가 고개를 끄덕였다.' },
        ];

        const manyChatVars = { nsfw_mode: '1', dain_c: '-30' };
        for (let vi = 0; vi < 45; vi += 1) manyChatVars[`pad_var_${vi}`] = String(vi);
        manyChatVars.minji_c = '0';

        const snap = {
            charIndex: 0,
            chatIndex: 0,
            charName: 'Cheongwon High School',
            chatName: 'Chat 1',
            isPcActive: false,
            chatVariables: manyChatVars,
            customToggleBlocks: [{ source: 'CWModule', syntax: 'hud_bar=상태창=select=켜짐,꺼짐' }],
            useLocallySetGlobalVariables: false,
            globalToggleValues: {},
            localToggleValues: {},
            charContext: {
                name: 'Cheongwon High School',
                desc: 'High school simulation.',
                personaName: '푸딩',
                personaPrompt: 'Student.',
                loreEntries,
                loreDepth: 10,
                loreTokenBudget: 16000,
                loreRecursive: true,
                replaceGlobalNote: 'CARD_STATUS_LOCK_REMINDER {{original}}',
                depthPrompt: { depth: 1, prompt: 'DEPTH1_SCENE_REMINDER' },
                memory: 'MEMORY_SUMMARY_DAIN',
            },
            messages,
        };

        // Direct unit check on buildDirectPromptMessages with short new userText lacking "다인"
        const built = relay.buildDirectPromptMessages({
            preset: leave,
            snap,
            historyMessages: messages,
            userText: '그녀의 입속에...',
            remoteToggleValues: {},
        });
        const fullText = built.map((m) => m.content).join('\n');
        assert.ok(!/@@depth\b/i.test(fullText), 'Raw @@depth decorator must be stripped before LLM payload');
        assert.ok(fullText.includes('Always emit status line: [☀️][7°C]'), 'Status bar prompt must not be truncated');
        assert.ok(fullText.includes('NSFW_ACTIVE'), '{{#when::nsfw_mode::is::1}} must evaluate inside lorebook');
        assert.ok(fullText.includes('HUD_DEFAULT_ON'), 'Untouched module toggle defaults to 0 for #when::hud_bar::tis::0');
        assert.ok(!/\{\{#func|\{\{call::|\{\{arg::|\{\{calc::/.test(fullText), 'All #func/call/arg/calc macros must resolve');
        assert.ok(fullText.includes('강다인: -30/500 | (Stage -1: 경계/불신)'));
        assert.ok(fullText.includes('서민지: 0/500 | (Stage 0: 중립)'));
        assert.ok(!fullText.includes('(Stage 1: 호의)'), 'Non-matching affection stages must not be emitted');
        assert.ok(fullText.includes('Character Sheet: 강다인'), 'Character lorebook must activate from prior turns');
        assert.ok(fullText.includes('Location Detail: 신관 음악실'), 'Location lorebook must activate');
        assert.ok(fullText.includes('CARD_STATUS_LOCK_REMINDER'), 'replaceGlobalNote must populate globalNote slot');
        assert.ok(!fullText.includes('MEMORY_SUMMARY_DAIN'), 'Leave default toggle_memory_backend=0 suppresses memory via innerFormat');

        const builtWithMem = relay.buildDirectPromptMessages({
            preset: leave,
            snap,
            historyMessages: messages,
            userText: '그녀의 입속에...',
            remoteToggleValues: { toggle_memory_backend: '1' },
        });
        assert.ok(builtWithMem.some((m) => m.content.includes('[LONG-TERM MEMORY & CONTINUITY]') && m.content.includes('MEMORY_SUMMARY_DAIN')), 'memory slot must populate when toggle_memory_backend=1');

        const userTurnIdx = built.findIndex((m) => m.role === 'user' && m.content === '그녀의 입속에...');
        const depth1Idx = built.findIndex((m) => m.content.includes('DEPTH1_SCENE_REMINDER'));
        const assetPostIdx = built.findIndex((m) => m.content.includes('<img src={name}_{outfit}_{keyword}>'));
        const statusPostIdx = built.findIndex((m) => m.content.includes('Always emit status line: [☀️][7°C]'));
        const commitIdx = built.findIndex((m) => m.content.includes('STEP 3 — CHARACTER-CARD STATUS LINE'));
        assert.ok(depth1Idx >= 0 && depth1Idx < userTurnIdx, 'depthPrompt(1) should sit before latest user turn');
        assert.ok(assetPostIdx > userTurnIdx && assetPostIdx < commitIdx, '@@depth 00 Asset Prompt must land in postEverything after user turn and before Leave 09 anchor');
        assert.ok(statusPostIdx > userTurnIdx && statusPostIdx < commitIdx, '@@depth 0 status bar must land in postEverything after user turn and before Leave 09 anchor');

        // Integration check: /api/state strips heavy loreEntries, while /api/chat/send forwards full lore + status bar to upstream
        const hdrs = { 'X-RisuStand-Token': tok, 'Content-Type': 'application/json' };
        await requestHttp(port, {
            method: 'POST',
            path: '/api/pc/poll',
            headers: hdrs,
            body: JSON.stringify({
                bridgeVersion: '2.0.0',
                generating: false,
                supportsBatchCommands: true,
                catalog: { characters: [{ index: 0, name: 'Cheongwon High School', chats: [{ index: 0, id: 'c0', name: 'Chat 1', msgCount: 4 }] }] },
                snapshot: snap,
            }),
        });

        const stRes = await requestHttp(port, { path: '/api/state', headers: hdrs });
        assert.equal(stRes.status, 200);
        const stJson = JSON.parse(stRes.body);
        assert.equal('loreEntries' in stJson.snapshot.charContext, false, '/api/state should omit heavy loreEntries for mobile');

        const sendRes = await requestHttp(port, {
            method: 'POST',
            path: '/api/chat/send',
            headers: hdrs,
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, text: '그녀의 입속에...' }),
        });
        assert.equal(sendRes.status, 200);
        for (let i = 0; i < 40 && capturedPayloads.length === 0; i += 1) {
            await new Promise((r) => setTimeout(r, 25));
        }
        assert.equal(capturedPayloads.length, 1);
        const sentText = capturedPayloads[0].messages.map((m) => m.content).join('\n');
        assert.ok(sentText.includes('Always emit status line: [☀️][7°C]'));
        assert.ok(sentText.includes('Character Sheet: 강다인'));
        assert.ok(!/@@depth\b/i.test(sentText));
    } finally {
        await new Promise((r) => server.close(r));
        await new Promise((r) => upstream.close(r));
    }
});

test('lorebook inspector GET /api/lorebook, per-entry exclude & pin, Author Note editing, and Web UI script compilation', async () => {
    const capturedPayloads = [];
    const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            capturedPayloads.push(body);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                id: 'lb-sel-1',
                model: body.model || 'mock-model',
                choices: [{ index: 0, message: { role: 'assistant', content: 'Response ok' }, finish_reason: 'stop' }],
            }));
        });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = upstream.address().port;

    const tok = 'lore-sel-token';
    const server = relay.createRelayServer({
        token: tok,
        configOverride: {
            activeProfileId: 'mock-lb',
            directPresetId: 'bundled:leave',
            remoteToggleValues: {},
            disabledLoreEntries: {},
            pinnedLoreEntries: {},
            presetToggles: [],
            profiles: [{
                id: 'mock-lb',
                name: 'MockLB',
                providerType: 'openai_compat',
                baseUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
                apiKey: 'mock-key',
                model: 'deepseek-test',
                temperature: '',
                maxTokens: '',
                overrideMode: 'off',
                systemOverride: '',
            }],
            translator: { useActiveProfile: true, autoTranslateOutput: false, autoTranslateInput: false },
        },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    try {
        const hdrs = { 'X-RisuStand-Token': tok, 'Content-Type': 'application/json' };
        await requestHttp(port, {
            method: 'POST',
            path: '/api/pc/poll',
            headers: hdrs,
            body: JSON.stringify({
                bridgeVersion: '2.0.0',
                generating: false,
                supportsBatchCommands: true,
                catalog: { characters: [{ index: 0, name: 'TestChar', chats: [{ index: 0, id: 'c0', name: 'Chat 1', msgCount: 1 }] }] },
                snapshot: {
                    charIndex: 0,
                    chatIndex: 0,
                    charName: 'TestChar',
                    chatName: 'Chat 1',
                    isPcActive: false,
                    chatVariables: {},
                    useLocallySetGlobalVariables: false,
                    globalToggleValues: {},
                    localToggleValues: {},
                    charContext: {
                        charId: 'char-uid-test',
                        name: 'TestChar',
                        desc: 'Detailed character description for TestChar.',
                        personality: 'Calm and witty.',
                        scenario: 'Rainy library.',
                        note: 'Initial author note.',
                        loreEntries: [
                            { uid: 'char:keep1', source: 'char', sourceName: 'TestChar', comment: 'Keep Always', key: '', alwaysActive: true, insertorder: 100, content: 'ALWAYS_KEPT_ENTRY' },
                            { uid: 'char:drop1', source: 'char', sourceName: 'TestChar', comment: 'Drop Me', key: '', alwaysActive: true, insertorder: 90, content: 'EXCLUDED_ENTRY_TEXT' },
                            { uid: 'char:pin1', source: 'char', sourceName: 'TestChar', comment: 'Secret Keyword', key: 'raretrigger', alwaysActive: false, insertorder: 80, content: 'PINNED_KEYWORD_ENTRY' },
                        ],
                    },
                    messages: [{ index: 0, role: 'char', raw: 'Welcome.' }],
                },
            }),
        });

        // 1) GET /api/lorebook returns all entries, all checked (disabledUids empty) by default
        const lbRes = await requestHttp(port, { path: '/api/lorebook', headers: hdrs });
        assert.equal(lbRes.status, 200);
        const lbJson = JSON.parse(lbRes.body);
        assert.equal(lbJson.charKey, 'char-uid-test');
        assert.deepEqual(lbJson.disabledUids, []);
        assert.equal(lbJson.entries.length, 3);

        // 2) Exclude char:drop1 and pin char:pin1
        const selRes1 = await requestHttp(port, {
            method: 'POST',
            path: '/api/lorebook/selection',
            headers: hdrs,
            body: JSON.stringify({ charKey: 'char-uid-test', uid: 'char:drop1', enabled: false, pinned: false }),
        });
        assert.equal(selRes1.status, 200);
        const selRes2 = await requestHttp(port, {
            method: 'POST',
            path: '/api/lorebook/selection',
            headers: hdrs,
            body: JSON.stringify({ charKey: 'char-uid-test', uid: 'char:pin1', enabled: true, pinned: true }),
        });
        assert.equal(selRes2.status, 200);
        const selJson2 = JSON.parse(selRes2.body);
        assert.deepEqual(selJson2.disabledUids, ['char:drop1']);
        assert.deepEqual(selJson2.pinnedUids, ['char:pin1']);

        // 3) Edit Author's Note via /api/command -> immediately updates in-memory snapshot for direct request
        const anRes = await requestHttp(port, {
            method: 'POST',
            path: '/api/command',
            headers: hdrs,
            body: JSON.stringify({ type: 'set_author_note', payload: { charIndex: 0, chatIndex: 0, note: 'EDITED_AUTHORS_NOTE_LIVE' } }),
        });
        assert.equal(anRes.status, 200);

        // 4) Direct chat send applies description, edited Author's Note, keeps ALWAYS_KEPT_ENTRY + PINNED_KEYWORD_ENTRY, excludes EXCLUDED_ENTRY_TEXT
        const sendRes = await requestHttp(port, {
            method: 'POST',
            path: '/api/chat/send',
            headers: hdrs,
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, text: 'Ordinary message without keyword.' }),
        });
        assert.equal(sendRes.status, 200);
        for (let i = 0; i < 40 && capturedPayloads.length === 0; i += 1) {
            await new Promise((r) => setTimeout(r, 25));
        }
        assert.equal(capturedPayloads.length, 1);
        const sent = capturedPayloads[0].messages.map((m) => m.content).join('\n');
        assert.ok(sent.includes('Detailed character description for TestChar.'));
        assert.ok(sent.includes('EDITED_AUTHORS_NOTE_LIVE'));
        assert.ok(!sent.includes('Initial author note.'));
        assert.ok(sent.includes('ALWAYS_KEPT_ENTRY'));
        assert.ok(sent.includes('PINNED_KEYWORD_ENTRY'), 'Pinned keyword entry must be included even without keyword match');
        assert.ok(!sent.includes('EXCLUDED_ENTRY_TEXT'), 'Unchecked lorebook entry must be omitted from LLM request');

        // 5) Web UI contains Author Note editor, Lorebook card, dedicated message edit modal & compiles cleanly
        const html = await requestHttp(port, { path: '/' });
        assert.equal(html.status, 200);
        for (const marker of ['authorNoteCard', 'authorNoteInput', 'saveAuthorNoteBtn', 'charDescPreviewDetails', 'lorebookCard', 'loreList', 'loreSearch', 'loreEnableAllBtn', 'msgEditModal', 'msg-edit-card', 'msgEditTextarea', 'openMsgEditModal', 'saveMsgEditModal']) {
            assert.ok(html.body.includes(marker), `Expected Web UI marker: ${marker}`);
        }
        assert.ok(!html.body.includes("prompt('메시지 수정:'"), 'Legacy small prompt() message editor should be removed');
        const scriptMatch = html.body.match(/<script>([\s\S]*?)<\/script>/);
        assert.ok(scriptMatch);
        new vm.Script(scriptMatch[1], { filename: 'webapp-lorebook-ui-inline.js' });

        // 6) edit_message command immediately updates in-memory snapshot message text
        const edRes = await requestHttp(port, {
            method: 'POST',
            path: '/api/command',
            headers: hdrs,
            body: JSON.stringify({ type: 'edit_message', payload: { charIndex: 0, chatIndex: 0, msgIndex: 0, text: 'EDITED_GREETING_TEXT' } }),
        });
        assert.equal(edRes.status, 200);
        const stAfterEdit = JSON.parse((await requestHttp(port, { path: '/api/state', headers: hdrs })).body);
        assert.equal(stAfterEdit.snapshot.messages[0].raw, 'EDITED_GREETING_TEXT');
    } finally {
        await new Promise((r) => server.close(r));
        await new Promise((r) => upstream.close(r));
    }
});

test('Cache Guard monitors proxy narrative lanes, excludes Hayaku/Flashback/translate/errors, detects prefix breaks & serves analysis UI', async () => {
    // 1) Multi-provider usage mapping checks
    const antU = relay.mapUsageToOpenAI({ input_tokens: 120, cache_read_input_tokens: 800, cache_creation_input_tokens: 80, output_tokens: 40 });
    assert.equal(antU.prompt_tokens, 1000);
    assert.equal(antU.cached_tokens, 800);
    assert.equal(antU.cache_creation_tokens, 80);

    const oaiU = relay.mapUsageToOpenAI({ prompt_tokens: 2000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 1800 } });
    assert.equal(oaiU.prompt_tokens, 2000);
    assert.equal(oaiU.cached_tokens, 1800);

    const gemU = relay.mapUsageToOpenAI({ promptTokenCount: 1500, candidatesTokenCount: 50, cachedContentTokenCount: 1200 });
    assert.equal(gemU.prompt_tokens, 1500);
    assert.equal(gemU.cached_tokens, 1200);

    const dsU = relay.mapUsageToOpenAI({ prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 });
    assert.equal(dsU.cached_tokens, 900);

    // 2) End-to-end proxy + translate + Hayaku/Flashback exclusion + Bot A/B lane separation
    const upstream = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const joined = (body.messages || []).map((m) => String(m.content || '')).join('\n');
        if (joined.includes('FORCE_PROXY_ERR')) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Rate limited' } }));
            return;
        }
        if (body.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
            res.write('data: {"id":"c1","model":"gpt-4o","choices":[{"delta":{"content":"Streamed narrative reply."}}]}\n\n');
            res.write('data: {"id":"c1","model":"gpt-4o","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2000,"completion_tokens":30,"total_tokens":2030,"prompt_tokens_details":{"cached_tokens":1800}}}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            id: 'chatcmpl-cg',
            model: 'gpt-4o',
            choices: [{ message: { role: 'assistant', content: 'Ok reply' } }],
            usage: { prompt_tokens: 1500, completion_tokens: 20, total_tokens: 1520, prompt_tokens_details: { cached_tokens: 0 } },
        }));
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upPort = upstream.address().port;

    const tok = 'cache-guard-token-77';
    const server = relay.createRelayServer({
        token: tok,
        configOverride: {
            activeProfileId: 'cg-p1',
            presetToggles: [],
            profiles: [{
                id: 'cg-p1',
                name: 'CGMock',
                provider: 'custom',
                providerType: 'openai_compat',
                baseUrl: `http://127.0.0.1:${upPort}/v1/chat/completions`,
                apiKey: 'sk-cg-secret-1111',
                model: 'gpt-4o',
                temperature: '',
                maxTokens: '',
                overrideMode: 'off',
                systemOverride: '',
            }],
            translator: {
                useActiveProfile: true,
                targetLang: 'Korean',
                autoTranslateOutput: false,
                autoTranslateInput: false,
            },
        },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    const botASysHead = 'Character Alice is an archivist in an ancient clockwork observatory in New Avalon who catalogs celestial maps and forbidden mechanical scriptures every night. '.repeat(2);
    const botASysBase = botASysHead + 'She always speaks calmly and wears brass spectacles.';
    const botASysMutated = botASysHead + 'She suddenly speaks frantically because an unexpected lorebook block altered the system prompt!';
    const botBSys = 'Character Bob is a deep-sea submarine engineer exploring Europa trenches with sonar drones and pressure suits.';

    try {
        const authHdr = { 'X-RisuStand-Token': tok, 'Content-Type': 'application/json' };
        const proxyHdr = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };

        await requestHttp(port, { method: 'DELETE', path: '/api/logs', headers: authHdr });

        const postProxy = (messages, stream = false) => requestHttp(port, {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: proxyHdr,
            body: JSON.stringify({ model: 'risustand-router', stream, messages }),
        });

        // Turn A1 (baseline for Bot A)
        assert.equal((await postProxy([
            { role: 'system', content: botASysBase },
            { role: 'user', content: 'Alice, open the star ledger on desk 4.' },
        ])).status, 200);

        // Interleaved Hayaku summary request via proxy (MUST be excluded)
        assert.equal((await postProxy([
            { role: 'system', content: '[Hayaku] Summarize the following conversation concisely into bullet notes.' },
            { role: 'user', content: 'Alice opened the ledger and checked the brass astrolabe.' },
        ])).status, 200);

        // Interleaved Flashback Memory retrieval via proxy (MUST be excluded)
        assert.equal((await postProxy([
            { role: 'system', content: 'FLASHBACK Memory retrieval helper. Extract relevant memories for the upcoming turn.' },
            { role: 'user', content: 'Query: clockwork observatory' },
        ])).status, 200);

        // Bot B Turn 1 (MUST form Group #2 without affecting Bot A)
        assert.equal((await postProxy([
            { role: 'system', content: botBSys },
            { role: 'user', content: 'Bob, check the hull seal at 4000 meters.' },
        ])).status, 200);

        // Error request via proxy (MUST be excluded)
        assert.equal((await postProxy([
            { role: 'system', content: botASysBase },
            { role: 'user', content: 'FORCE_PROXY_ERR' },
        ])).status, 502);

        // Translator call via /api/translate (MUST be excluded)
        assert.equal((await requestHttp(port, {
            method: 'POST',
            path: '/api/translate',
            headers: authHdr,
            body: JSON.stringify({ text: 'The stars align tonight.', direction: 'to_target' }),
        })).status, 200);

        // Turn A2 (stream passthrough, prefix matches A1 100%, KV hit 90%)
        assert.equal((await postProxy([
            { role: 'system', content: botASysBase },
            { role: 'user', content: 'Alice, open the star ledger on desk 4.' },
            { role: 'assistant', content: 'She opens the leather-bound ledger carefully.' },
            { role: 'user', content: 'Read the constellation entry for October.' },
        ], true)).status, 200);

        // Turn A3 (Bot A anchor matches, system prompt mutated mid-chat -> cacheBroken: true!)
        assert.equal((await postProxy([
            { role: 'system', content: botASysMutated },
            { role: 'user', content: 'Alice, open the star ledger on desk 4.' },
            { role: 'assistant', content: 'She opens the leather-bound ledger carefully.' },
            { role: 'user', content: 'Read the constellation entry for October.' },
            { role: 'assistant', content: 'The October chart shows a faint comet.' },
            { role: 'user', content: 'Trace its orbital trajectory.' },
        ])).status, 200);

        const logsRes = JSON.parse((await requestHttp(port, { path: '/api/logs', headers: authHdr })).body);
        assert.equal(logsRes.logs.length, 8);
        assert.equal(logsRes.summary.narrativeCount, 4);
        assert.equal(logsRes.summary.excludedCount, 4);
        assert.equal(logsRes.summary.laneCount, 2);
        assert.equal(logsRes.summary.brokenCount, 1);
        assert.equal(logsRes.summary.intactCount, 1);
        assert.equal(logsRes.summary.baselineCount, 2);

        // Newest-first indices: 0=A3, 1=A2, 2=Translate, 3=Err, 4=B1, 5=Flashback, 6=Hayaku, 7=A1
        const [logA3, logA2, logTrans, logErr, logB1, logFlash, logHayaku, logA1] = logsRes.logs;

        assert.equal(logA1.cacheGuard.eligible, true);
        assert.equal(logA1.cacheGuard.verdict, 'baseline');
        assert.equal(logA1.cacheGuard.turnIndex, 1);

        assert.equal(logHayaku.cacheGuard.eligible, false);
        assert.equal(logHayaku.cacheGuard.excludedReason, 'hayaku');

        assert.equal(logFlash.cacheGuard.eligible, false);
        assert.equal(logFlash.cacheGuard.excludedReason, 'flashback');

        assert.equal(logErr.cacheGuard.eligible, false);
        assert.equal(logErr.cacheGuard.excludedReason, 'http_error');

        assert.equal(logTrans.cacheGuard.eligible, false);
        assert.equal(logTrans.cacheGuard.excludedReason, 'translate');

        assert.equal(logB1.cacheGuard.eligible, true);
        assert.equal(logB1.cacheGuard.verdict, 'baseline');
        assert.notEqual(logB1.cacheGuard.laneId, logA1.cacheGuard.laneId);

        assert.equal(logA2.cacheGuard.eligible, true);
        assert.equal(logA2.cacheGuard.laneId, logA1.cacheGuard.laneId);
        assert.equal(logA2.cacheGuard.prevLogId, logA1.id);
        assert.equal(logA2.cacheGuard.turnIndex, 2);
        assert.equal(logA2.cacheGuard.prefixMatchPct, 100);
        assert.equal(logA2.cacheGuard.cacheBroken, false);
        assert.equal(logA2.cacheGuard.verdict, 'ok');
        assert.equal(logA2.cacheGuard.serverHitPct, 90);

        assert.equal(logA3.cacheGuard.eligible, true);
        assert.equal(logA3.cacheGuard.laneId, logA1.cacheGuard.laneId);
        assert.equal(logA3.cacheGuard.prevLogId, logA2.id);
        assert.equal(logA3.cacheGuard.turnIndex, 3);
        assert.equal(logA3.cacheGuard.cacheBroken, true);
        assert.equal(logA3.cacheGuard.verdict, 'broken');
        assert.ok(logA3.cacheGuard.prefixMatchPct < 98);

        // Detail endpoint returns segmentMap & firstDiff without leaking internal raw buffers
        const detailA3Res = JSON.parse((await requestHttp(port, {
            path: `/api/logs/${encodeURIComponent(logA3.id)}`,
            headers: authHdr,
        })).body);
        assert.ok(detailA3Res.log.cacheGuard.firstDiff);
        assert.ok(detailA3Res.log.cacheGuard.firstDiff.currSnippet.includes('unexpected lorebook block') || detailA3Res.log.cacheGuard.firstDiff.currSnippet.includes('frantically'));
        assert.ok(Array.isArray(detailA3Res.log.cacheGuard.segmentMap));
        assert.equal(detailA3Res.log._cgRawBody, undefined);

        // Web UI compiles & contains Cache Guard markers
        const html = await requestHttp(port, { path: '/' });
        assert.equal(html.status, 200);
        for (const marker of ['reqLogCgSummary', 'reqLogGroupToggle', 'data-log-filter="narrative"', 'data-log-filter="broken"', 'renderReqLogCacheTabHtml', 'buildCacheGuardSummaryHtml']) {
            assert.ok(html.body.includes(marker), `Expected Cache Guard UI marker: ${marker}`);
        }
        const scriptMatch = html.body.match(/<script>([\s\S]*?)<\/script>/);
        assert.ok(scriptMatch);
        new vm.Script(scriptMatch[1], { filename: 'webapp-cacheguard-inline.js' });

        await requestHttp(port, { method: 'DELETE', path: '/api/logs', headers: authHdr });
    } finally {
        await new Promise((r) => server.close(r));
        await new Promise((r) => upstream.close(r));
    }
});

test('Zen minibar visibility on all tabs, horizontal touch-scroll CSS, bot menu theme dedup & /api/plugins/reload-pc resilience', async () => {
    const tok = 'ui-fix-token-99';
    const server = relay.createRelayServer({
        token: tok,
        configOverride: { activeProfileId: '', presetToggles: [], profiles: [] },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
        const authHdr = { 'X-RisuStand-Token': tok, 'Content-Type': 'application/json' };

        // 1) POST /api/plugins/reload-pc succeeds even when PC bridge RPC is offline
        const relRes = await requestHttp(port, {
            method: 'POST',
            path: '/api/plugins/reload-pc',
            headers: authHdr,
            body: '{}',
        });
        assert.equal(relRes.status, 200);
        const relBody = JSON.parse(relRes.body);
        assert.equal(relBody.ok, true);
        assert.ok(Array.isArray(relBody.plugins));

        // 2) Web UI HTML/CSS/JS invariants
        const htmlRes = await requestHttp(port, { path: '/' });
        assert.equal(htmlRes.status, 200);
        const html = htmlRes.body;

        assert.ok(!html.includes('body:not(.tab-chat-active) #rsMiniBar'), 'Zen minibar must remain visible across non-chat tabs');
        assert.ok(html.includes('body:not(.rs-zen-mode) #rsMiniBar { display:none !important; }'));
        assert.ok(html.includes('#rsMiniBar.expanded { padding:5px 10px; font-size:12px; font-weight:600; touch-action:pan-x; }'));
        assert.ok(html.includes('BOT_FIXED_CLASS_SEL'));
        assert.ok(html.includes('function isBotFixedMenuElement('));
        assert.ok(html.includes('__rsGuiReloadPlugin'));
        assert.ok(html.includes('#tab-chat { gap:18px; z-index:auto; isolation:auto; }'));
        assert.ok(!html.includes('.book-frame {\n    flex:1; display:flex; flex-direction:column;\n    background:var(--book-bg); border:1px solid var(--border); border-radius:12px;\n    box-shadow: var(--shadow); overflow:hidden; position:relative;\n    perspective:1800px;'));
        assert.ok(html.includes('@keyframes rsFlipNext { 0% { opacity:0.95; transform:perspective(1800px) rotateY(0deg); }'));
        assert.ok(html.includes('html body #bookBotOverlay {\n    position:fixed !important; inset:0 !important; z-index:42 !important;'));
        assert.ok(html.includes('#botMenuFab {\n    position:fixed; right:12px; top:62px; z-index:44;'));
        assert.ok(html.includes('!/(?:side-panel|drawer|modal)/i.test(fallbackBar.className'));
        assert.ok(html.includes("el.querySelector('button, a, input, select, textarea, label, [risu-trigger], [risu-btn]')"));

        const setThemeMatch = html.match(/function setTheme\(key\)\s*\{[\s\S]*?\n  \}/);
        assert.ok(setThemeMatch && setThemeMatch[0].includes("lastChatRenderSig = ''"), 'setTheme must reset lastChatRenderSig before re-rendering');

        const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
        assert.ok(scriptMatch);
        new vm.Script(scriptMatch[1], { filename: 'webapp-ui-fixes-inline.js' });
    } finally {
        await new Promise((r) => server.close(r));
    }
});

test('U+A turn recognition matches Hayaku & Flashback pairing rules across plugin and relay UI', () => {
    assert.deepEqual(relay.computeUATurnStats([]), { completedTurns: 0, pendingTurn: 0, turnByIndex: [] });

    // Leading greeting / prologue before first user turn is Turn 0
    const greetingOnly = relay.computeUATurnStats([
        { role: 'char', isFirstMessage: true, data: 'Greeting' },
        { role: 'char', data: 'Prologue narration' },
    ]);
    assert.equal(greetingOnly.completedTurns, 0);
    assert.equal(greetingOnly.pendingTurn, 0);
    assert.deepEqual(greetingOnly.turnByIndex, [0, 0]);

    // Standard U+A pairs + consecutive assistant continuations + consecutive user inputs
    const mixed = relay.computeUATurnStats([
        { role: 'char', isFirstMessage: true, data: 'Greeting' },
        { role: 'user', data: 'U1' },
        { role: 'char', data: 'A1 part 1' },
        { role: 'assistant', data: 'A1 part 2' },
        { role: 'user', data: 'U2a (unanswered)' },
        { role: 'user', data: 'U2b (combined before reply)' },
        { role: 'char', data: 'A2' },
        { role: 'char', disabled: true, data: 'disabled note' },
        { role: 'user', isComment: true, data: 'comment note' },
        { role: 'user', data: 'U3 pending' },
    ]);
    assert.equal(mixed.completedTurns, 2);
    assert.equal(mixed.pendingTurn, 3);
    assert.deepEqual(mixed.turnByIndex, [0, 1, 1, 1, 2, 2, 2, 0, 0, 3]);

    const pluginSrc = fs.readFileSync(path.join(REPO, 'risustand.js'), 'utf8');
    assert.ok(pluginSrc.includes('function computeUATurnStats('));
    assert.ok(pluginSrc.includes('turnCount: computeUATurnStats('));
    assert.ok(pluginSrc.includes('totalTurns: uaStats.completedTurns'));
    assert.ok(pluginSrc.includes('✦ 프롤로그'));
});

test('Cache Guard recognizes remote-prompt requests (direct Leave preset & proxy Leave) as main narrative', async () => {
    let callCount = 0;
    const upstream = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        callCount += 1;
        const cached = callCount === 2 ? 2200 : 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            id: `chatcmpl-remote-${callCount}`,
            model: body.model || 'gpt-4o',
            choices: [{ message: { role: 'assistant', content: `Remote narrative reply #${callCount}` } }],
            usage: { prompt_tokens: 2600, completion_tokens: 45, total_tokens: 2645, prompt_tokens_details: { cached_tokens: cached } },
        }));
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upPort = upstream.address().port;

    const tok = 'remote-cg-token-88';
    const server = relay.createRelayServer({
        token: tok,
        configOverride: {
            activeProfileId: 'rm-p1',
            directPresetId: 'bundled:leave',
            presetToggles: [],
            profiles: [{
                id: 'rm-p1',
                name: 'RemoteMock',
                provider: 'custom',
                providerType: 'openai_compat',
                baseUrl: `http://127.0.0.1:${upPort}/v1/chat/completions`,
                apiKey: 'sk-remote-mock',
                model: 'gpt-4o',
                temperature: '',
                maxTokens: '',
                overrideMode: 'off',
                systemOverride: '',
            }],
        },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
        const hdrs = { 'X-RisuStand-Token': tok, 'Content-Type': 'application/json' };
        const proxyHdr = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };

        await requestHttp(port, { method: 'DELETE', path: '/api/logs', headers: hdrs });

        // Seed PC snapshot containing [HAYAKU] & [FLASHBACK] memory blocks in lore/history
        await requestHttp(port, {
            method: 'POST',
            path: '/api/pc/poll',
            headers: hdrs,
            body: JSON.stringify({
                supportsBatchCommands: true,
                catalog: { characters: [{ index: 0, name: 'Elena', chats: [{ index: 0, id: 'c-elena', name: 'Room 1', msgCount: 2, turnCount: 1 }] }] },
                snapshot: {
                    charIndex: 0,
                    chatIndex: 0,
                    charName: 'Elena',
                    chatName: 'Room 1',
                    isPcActive: false,
                    charContext: {
                        charId: 'elena-1',
                        name: 'Elena',
                        desc: 'Elena is a quiet librarian.',
                        note: 'Keep atmospheric tone.',
                        memory: '[HAYAKU] Turn 1 summary: Elena greeted the traveler.\n[FLASHBACK] Past memory of the rain.',
                        loreEntries: [],
                    },
                    messages: [
                        { index: 0, role: 'user', raw: 'Good evening, Elena.' },
                        { index: 1, role: 'char', raw: 'Welcome back to the archive.' },
                    ],
                },
            }),
        });

        const waitForLogs = async (expectedCount) => {
            for (let i = 0; i < 60; i += 1) {
                const res = JSON.parse((await requestHttp(port, { path: '/api/logs', headers: hdrs })).body);
                if (res.logs.length >= expectedCount) return res;
                await new Promise((r) => setTimeout(r, 25));
            }
            return JSON.parse((await requestHttp(port, { path: '/api/logs', headers: hdrs })).body);
        };

        // Turn 1 via direct remote chat (Leave preset)
        assert.equal((await requestHttp(port, {
            method: 'POST',
            path: '/api/chat/send',
            headers: hdrs,
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, text: 'Let us inspect the upper shelf.' }),
        })).status, 200);
        await waitForLogs(1);

        // Sync snapshot after Turn 1 (matching PC bridge append_messages sync)
        await requestHttp(port, {
            method: 'POST',
            path: '/api/pc/poll',
            headers: hdrs,
            body: JSON.stringify({
                supportsBatchCommands: true,
                catalog: { characters: [{ index: 0, name: 'Elena', chats: [{ index: 0, id: 'c-elena', name: 'Room 1', msgCount: 4, turnCount: 2 }] }] },
                snapshot: {
                    charIndex: 0,
                    chatIndex: 0,
                    charName: 'Elena',
                    chatName: 'Room 1',
                    isPcActive: false,
                    charContext: {
                        charId: 'elena-1',
                        name: 'Elena',
                        desc: 'Elena is a quiet librarian.',
                        note: 'Keep atmospheric tone.',
                        memory: '[HAYAKU] Turn 1 summary: Elena greeted the traveler.\n[FLASHBACK] Past memory of the rain.',
                        loreEntries: [],
                    },
                    messages: [
                        { index: 0, role: 'user', raw: 'Good evening, Elena.' },
                        { index: 1, role: 'char', raw: 'Welcome back to the archive.' },
                        { index: 2, role: 'user', raw: 'Let us inspect the upper shelf.' },
                        { index: 3, role: 'char', raw: 'Remote narrative reply #1' },
                    ],
                },
            }),
        });

        // Turn 2 via direct remote chat (intact prefix + normal post-history tail shift + KV hit reported)
        assert.equal((await requestHttp(port, {
            method: 'POST',
            path: '/api/chat/send',
            headers: hdrs,
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, text: 'Pull out the brass lantern.' }),
        })).status, 200);
        await waitForLogs(2);

        // Mutate Author's Note so Turn 3 mutates system/authornote prefix -> MUST stay in same lane & report cacheBroken
        assert.equal((await requestHttp(port, {
            method: 'POST',
            path: '/api/command',
            headers: hdrs,
            body: JSON.stringify({ type: 'set_author_note', payload: { charIndex: 0, chatIndex: 0, note: 'MUTATED_AUTHOR_NOTE_BREAKS_CACHE' } }),
        })).status, 200);
        assert.equal((await requestHttp(port, {
            method: 'POST',
            path: '/api/chat/send',
            headers: hdrs,
            body: JSON.stringify({ charIndex: 0, chatIndex: 0, text: 'Open the locked folio.' }),
        })).status, 200);
        await waitForLogs(3);

        // Turn 4 via proxy carrying Leave Engine prompt mentioning HAYAKU/Flashback -> MUST also be recognized as main narrative
        assert.equal((await requestHttp(port, {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: proxyHdr,
            body: JSON.stringify({
                model: 'risustand-router',
                stream: false,
                messages: [
                    { role: 'system', content: '[LEAVE ENGINE — OUTPUT CONTRACT & BASE QUALITY FLOOR]\nCross-check LIBRA, HAYAKU, Flashback blocks if present.' },
                    { role: 'user', content: 'Hello from proxy Leave.' },
                ],
            }),
        })).status, 200);

        const logsRes = await waitForLogs(4);
        assert.equal(logsRes.logs.length, 4);
        assert.equal(logsRes.summary.narrativeCount, 4);
        assert.equal(logsRes.summary.excludedCount, 0);

        // Newest-first: [proxyLeave, directT3, directT2, directT1]
        const [logProxy, logT3, logT2, logT1] = logsRes.logs;

        assert.equal(logT1.source, 'direct_chat');
        assert.equal(logT1.remotePrompt, true);
        assert.equal(logT1.cacheGuard.eligible, true);
        assert.equal(logT1.cacheGuard.isRemotePrompt, true);
        assert.equal(logT1.cacheGuard.verdict, 'baseline');
        assert.equal(logT1.cacheGuard.turnIndex, 1);

        assert.equal(logT2.cacheGuard.eligible, true);
        assert.equal(logT2.cacheGuard.isRemotePrompt, true);
        assert.equal(logT2.cacheGuard.laneId, logT1.cacheGuard.laneId);
        assert.equal(logT2.cacheGuard.turnIndex, 2);
        assert.equal(logT2.cacheGuard.cacheBroken, false);
        assert.ok(logT2.cacheGuard.serverHitPct > 80);

        assert.equal(logT3.cacheGuard.eligible, true);
        assert.equal(logT3.cacheGuard.isRemotePrompt, true);
        assert.equal(logT3.cacheGuard.laneId, logT1.cacheGuard.laneId);
        assert.equal(logT3.cacheGuard.turnIndex, 3);
        assert.equal(logT3.cacheGuard.cacheBroken, true);
        assert.equal(logT3.cacheGuard.verdict, 'broken');

        assert.equal(logProxy.source, 'proxy');
        assert.equal(logProxy.cacheGuard.eligible, true);
        assert.equal(logProxy.cacheGuard.isRemotePrompt, true);

        const htmlRes = await requestHttp(port, { path: '/' });
        assert.equal(htmlRes.status, 200);
        assert.ok(htmlRes.body.includes('🍃 원격 서사'));
        assert.ok(htmlRes.body.includes('function computeUATurnStats('));
        const scriptMatch = htmlRes.body.match(/<script>([\s\S]*?)<\/script>/);
        assert.ok(scriptMatch);
        new vm.Script(scriptMatch[1], { filename: 'webapp-ua-remote-cg-inline.js' });

        await requestHttp(port, { method: 'DELETE', path: '/api/logs', headers: hdrs });
    } finally {
        await new Promise((r) => server.close(r));
        await new Promise((r) => upstream.close(r));
    }
});

test('module lorebooks are separated from character/chat lorebooks and disabled by default (opt-in only)', async () => {
    const capturedPayloads = [];
    const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            capturedPayloads.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                id: 'chatcmpl-modlore',
                model: 'deepseek-test',
                choices: [{ message: { role: 'assistant', content: 'ok' } }],
            }));
        });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upPort = upstream.address().port;

    const tok = 'modlore-sep-token-55';
    const server = relay.createRelayServer({
        token: tok,
        configOverride: {
            activeProfileId: 'ml-p1',
            directPresetId: 'off',
            disabledLoreEntries: {},
            enabledModuleLoreEntries: {},
            pinnedLoreEntries: {},
            profiles: [{
                id: 'ml-p1',
                name: 'MockML',
                providerType: 'openai_compat',
                baseUrl: `http://127.0.0.1:${upPort}/v1/chat/completions`,
                apiKey: 'mock-key',
                model: 'deepseek-test',
                temperature: '',
                maxTokens: '',
                overrideMode: 'off',
                systemOverride: '',
            }],
        },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    try {
        const hdrs = { 'X-RisuStand-Token': tok, 'Content-Type': 'application/json' };
        await requestHttp(port, {
            method: 'POST',
            path: '/api/pc/poll',
            headers: hdrs,
            body: JSON.stringify({
                supportsBatchCommands: true,
                catalog: { characters: [{ index: 0, name: 'CharA', chats: [{ index: 0, id: 'c0', name: 'Chat 1', msgCount: 1 }] }] },
                snapshot: {
                    charIndex: 0,
                    chatIndex: 0,
                    charName: 'CharA',
                    chatName: 'Chat 1',
                    isPcActive: false,
                    charContext: {
                        charId: 'char-mod-sep',
                        name: 'CharA',
                        desc: 'Base description.',
                        loreEntries: [
                            { uid: 'char:c1', source: 'char', sourceName: 'CharA', comment: 'Char Always', key: '', alwaysActive: true, insertorder: 100, content: 'CHAR_LORE_ACTIVE' },
                            { uid: 'local:l1', source: 'local', sourceName: '이 채팅방', comment: 'Local Room', key: 'lantern', alwaysActive: false, insertorder: 95, content: 'LOCAL_LORE_ACTIVE' },
                            { uid: 'module:m1', source: 'module', sourceName: 'HeavyModule', comment: 'Mod Always', key: '', alwaysActive: true, insertorder: 90, content: 'MODULE_ALWAYS_SHOULD_DEFAULT_OFF' },
                            { uid: 'module:m2', source: 'module', sourceName: 'HeavyModule', comment: 'Mod Keyword', key: 'lantern', alwaysActive: false, insertorder: 85, content: 'MODULE_KEYWORD_SHOULD_DEFAULT_OFF' },
                        ],
                    },
                    messages: [{ index: 0, role: 'char', raw: 'Hello.' }],
                },
            }),
        });

        // 1) GET /api/lorebook separates charEntries & moduleEntries and reports enabledModuleUids: []
        const lbRes = JSON.parse((await requestHttp(port, { path: '/api/lorebook', headers: hdrs })).body);
        assert.equal(lbRes.charEntries.length, 2);
        assert.equal(lbRes.moduleEntries.length, 2);
        assert.deepEqual(lbRes.enabledModuleUids, []);

        // 2) Default chat send: char + local active; BOTH module lorebooks excluded despite alwaysActive & keyword match
        const sendAndWait = async (text) => {
            const before = capturedPayloads.length;
            const r = await requestHttp(port, {
                method: 'POST',
                path: '/api/chat/send',
                headers: hdrs,
                body: JSON.stringify({ charIndex: 0, chatIndex: 0, text }),
            });
            assert.equal(r.status, 200);
            for (let i = 0; i < 60 && capturedPayloads.length === before; i += 1) {
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return capturedPayloads[capturedPayloads.length - 1].messages.map((m) => m.content).join('\n');
        };

        const sentDefault = await sendAndWait('Hold up the lantern.');
        assert.ok(sentDefault.includes('CHAR_LORE_ACTIVE'));
        assert.ok(sentDefault.includes('LOCAL_LORE_ACTIVE'));
        assert.ok(!sentDefault.includes('MODULE_ALWAYS_SHOULD_DEFAULT_OFF'));
        assert.ok(!sentDefault.includes('MODULE_KEYWORD_SHOULD_DEFAULT_OFF'));

        // 3) Opt-in ONLY module:m2 -> module:m2 included, module:m1 still excluded
        const optInRes = JSON.parse((await requestHttp(port, {
            method: 'POST',
            path: '/api/lorebook/selection',
            headers: hdrs,
            body: JSON.stringify({ charKey: 'char-mod-sep', uid: 'module:m2', enabled: true }),
        })).body);
        assert.deepEqual(optInRes.enabledModuleUids, ['module:m2']);

        const sentOptIn = await sendAndWait('Hold up the lantern.');
        assert.ok(!sentOptIn.includes('MODULE_ALWAYS_SHOULD_DEFAULT_OFF'));
        assert.ok(sentOptIn.includes('MODULE_KEYWORD_SHOULD_DEFAULT_OFF'));

        // 4) Character "전체 반영" (disabledUids: []) must NOT touch enabledModuleUids
        await requestHttp(port, {
            method: 'POST',
            path: '/api/lorebook/selection',
            headers: hdrs,
            body: JSON.stringify({ charKey: 'char-mod-sep', disabledUids: [] }),
        });
        const lbAfterCharAll = JSON.parse((await requestHttp(port, { path: '/api/lorebook', headers: hdrs })).body);
        assert.deepEqual(lbAfterCharAll.enabledModuleUids, ['module:m2']);

        // 5) "전체 비활성" clears enabledModuleUids -> module:m2 excluded again
        await requestHttp(port, {
            method: 'POST',
            path: '/api/lorebook/selection',
            headers: hdrs,
            body: JSON.stringify({ charKey: 'char-mod-sep', enabledModuleUids: [] }),
        });
        const sentDisabledAll = await sendAndWait('Hold up the lantern.');
        assert.ok(!sentDisabledAll.includes('MODULE_ALWAYS_SHOULD_DEFAULT_OFF'));
        assert.ok(!sentDisabledAll.includes('MODULE_KEYWORD_SHOULD_DEFAULT_OFF'));

        // 6) Web UI separates #moduleLorebookCard, removes module filter from #loreFilters, and compiles cleanly
        const htmlRes = await requestHttp(port, { path: '/' });
        assert.equal(htmlRes.status, 200);
        assert.ok(htmlRes.body.includes('id="moduleLorebookCard"'));
        assert.ok(htmlRes.body.includes('id="modLoreList"'));
        assert.ok(htmlRes.body.includes('id="modLoreDisableAllBtn"'));
        assert.ok(!htmlRes.body.includes('data-lore-src="module"'));
        assert.ok(!htmlRes.body.includes('id="pluginGuiTabs"'));
        assert.ok(!htmlRes.body.includes('plg-gui-tabs'));
        assert.ok(htmlRes.body.includes('function renderModuleLorebookList('));
        const scriptMatch = htmlRes.body.match(/<script>([\s\S]*?)<\/script>/);
        assert.ok(scriptMatch);
        new vm.Script(scriptMatch[1], { filename: 'webapp-module-lore-sep-inline.js' });
    } finally {
        await new Promise((r) => server.close(r));
        await new Promise((r) => upstream.close(r));
    }
});

test('CBS negative-number comparisons, keywords, and Leave Preset r1.1 AIDE/encoder upgrades', () => {
    const ctx = {
        charName: 'Char',
        personaName: 'User',
        globalVars: { toggle_bianca_inject: '1', toggle_prose_tone: '4', toggle_ooc_mode: '0' },
        chatVars: { aff_sieun: '-85', aff_dain: '-50', aff_minji: '120' },
    };

    assert.equal(
        relay.evalPresetCbs('{{#when::var::aff_sieun::lt::0}}NEG{{:else}}ZERO_PLUS{{/when}}', ctx),
        'NEG'
    );
    assert.equal(
        relay.evalPresetCbs('{{#when::var::aff_dain::gte::0}}STAGE_0{{:else}}HOSTILE{{/when}}', ctx),
        'HOSTILE'
    );
    assert.equal(
        relay.evalPresetCbs('{{#when::var::aff_dain::lte::-50}}AT_OR_BELOW_NEG50{{:else}}ABOVE{{/when}}', ctx),
        'AT_OR_BELOW_NEG50'
    );
    assert.equal(
        relay.evalPresetCbs('{{lt::-85::0}}|{{lte::-50::-50}}|{{gt::-10::-50}}|{{gte::0::0}}|{{eq::-85::-85}}|{{neq::-85::0}}', ctx),
        '1|1|1|1|1|1'
    );
    assert.equal(
        relay.evalPresetCbs('{{? -85 < 0 and -50 < 0 and not (0 < 0)}}', ctx),
        '1'
    );
    assert.equal(
        relay.evalPresetCbs('{{#if {{greater_equal::{{getvar::aff_sieun}}::0}}}}Stage0{{:else}}Hostile({{getvar::aff_sieun}}){{/if}}', ctx),
        'Hostile(-85)'
    );

    // .risup encoder round-trip
    const sampleObj = {
        name: 'RoundTrip Test Preset',
        temperature: 85,
        maxResponse: 4096,
        promptTemplate: [{ type: 'plain', role: 'system', text: '한국어 UTF-8 테스트' }],
    };
    const encoded = relay.encodeRisupPreset(sampleObj);
    assert.deepEqual(relay.decodeRisupPreset(encoded), sampleObj);

    // Upgraded bundled Leave preset checks
    const leave = relay.loadBundledLeavePreset();
    assert.equal(leave.temperature, 0.8);
    assert.equal(leave.maxResponse, 8192);
    assert.ok(leave.defaultVariables.includes('toggle_pipeline_mode=1'));
    assert.ok(leave.defaultVariables.includes('toggle_sub_body_state=1'));
    assert.ok(leave.defaultVariables.includes('toggle_sub_relationship_sim=1'));
    assert.ok(leave.defaultVariables.includes('toggle_sub_world_dynamics=1'));
    assert.ok(leave.toggleSyntax.includes('sub_body_state=상태 AIDE (부상 · 피로 · 신체 상태 · 수면)'));

    const msgsWithBiancaConflict = relay.buildDirectPromptMessages({
        preset: leave,
        snap: { charName: 'TestChar', charContext: { name: 'TestChar', desc: 'World.' } },
        historyMessages: [{ index: 0, role: 'user', raw: '안녕' }],
        userText: '계속해.',
        remoteToggleValues: { toggle_bianca_inject: '1', toggle_prose_tone: '4' },
        modelName: 'deepseek-v4.1-flash:1017-cloud',
    });
    const combinedBianca = msgsWithBiancaConflict.map((m) => m.content).join('\n');
    assert.ok(combinedBianca.includes('[PROCEDURAL DRAFTING PIPELINE — LIGHTWEIGHT 4-STEP CHECK]'), 'Default pipeline_mode=1 should be active');
    assert.ok(combinedBianca.includes('FAIL (impersonation):'));
    assert.ok(combinedBianca.includes('Terminal-First Continuity Lock'));
    assert.ok(combinedBianca.includes('FAIL (echo-loop):'));
    assert.ok(combinedBianca.includes('FAIL (crutch chop):'));
    assert.ok(combinedBianca.includes('[PROSE VOICE PRIORITY]'));
    assert.ok(!combinedBianca.includes('[LEAVE PROSE TONE — LIVELY LIGHT-NOVEL'), 'BIANCA active must suppress contradictory prose_tone=4');
    assert.ok(/DeepSeek/i.test(combinedBianca), 'Auto model_adapter must inject DeepSeek adapter when modelName contains deepseek');
    assert.ok(combinedBianca.includes('STRICT ORDER: Prose -> Step 2'));
    assert.ok(combinedBianca.includes('[SUB-AIDE: Status (Physical & Sleep)]'));
    assert.ok(combinedBianca.includes('No Fabricated Readings'));
    assert.ok(combinedBianca.includes('• 상태:'));
    assert.ok(!combinedBianca.includes('• 몸·수면:'));
    assert.ok(!combinedBianca.includes('수면 0-100'));
    assert.ok(msgsWithBiancaConflict.some((m) => m._cachePoint === true), 'Leave cache template entries must tag _cachePoint');
    assert.ok(!/\{\{#if|\{\{getglobalvar|\{\{\/if\}\}/.test(combinedBianca));

    // EN & JP localized Leave AIDE checks (zero Korean leakage in AIDE blocks)
    const msgsEn = relay.buildDirectPromptMessages({
        preset: leave,
        snap: { charName: 'Alice', charContext: { name: 'Alice', desc: 'Room.' } },
        historyMessages: [{ index: 0, role: 'user', raw: 'Hi' }],
        userText: 'Go',
        remoteToggleValues: { toggle_output_lang: '1' },
    });
    const bodyEn = msgsEn.slice(0, -1).map((m) => m.content).join('\n');
    const combinedEn = msgsEn.map((m) => m.content).join('\n');
    assert.ok(!/[가-힣]/.test(bodyEn), 'English Leave AIDE blocks must not leak Korean Hangul');
    assert.ok(bodyEn.includes('FAIL (impersonation): "When the guard handed over the folder'));
    assert.ok(bodyEn.includes('FAIL (echo-loop): User: "Still don\'t feel it?"'));
    assert.ok(bodyEn.includes('FAIL (crutch chop): "She very slowly looked up.'));
    assert.ok(combinedEn.includes('• Status:'));
    assert.ok(!combinedEn.includes('• Body & Sleep:'));
    assert.ok(!combinedEn.includes('wakefulness 0-100'));
    assert.ok(!/\{\{#if|\{\{getglobalvar|\{\{\/if\}\}/.test(combinedEn));

    const msgsJp = relay.buildDirectPromptMessages({
        preset: leave,
        snap: { charName: 'Alice', charContext: { name: 'Alice', desc: 'Room.' } },
        historyMessages: [{ index: 0, role: 'user', raw: 'Hi' }],
        userText: 'Go',
        remoteToggleValues: { toggle_output_lang: '2' },
    });
    const bodyJp = msgsJp.slice(0, -1).map((m) => m.content).join('\n');
    const combinedJp = msgsJp.map((m) => m.content).join('\n');
    assert.ok(!/[가-힣]/.test(bodyJp), 'Japanese Leave AIDE blocks must not leak Korean Hangul');
    assert.ok(bodyJp.includes('FAIL (impersonation): 「警備員が書類を差し出すと'));
    assert.ok(bodyJp.includes('FAIL (echo-loop): User: 「まだ実感わかない？」'));
    assert.ok(bodyJp.includes('FAIL (crutch chop): 「彼女はとてもゆっくり顔を上げた。'));
    assert.ok(combinedJp.includes('• 状態:'));
    assert.ok(!combinedJp.includes('• 身体・睡眠:'));
    assert.ok(!combinedJp.includes('覚醒 0-100'));
    assert.ok(!/\{\{#if|\{\{getglobalvar|\{\{\/if\}\}/.test(combinedJp));

    const msgsTextTracker = relay.buildDirectPromptMessages({
        preset: leave,
        snap: { charName: 'Alice', charContext: { name: 'Alice', desc: 'Room.' } },
        historyMessages: [{ index: 0, role: 'user', raw: 'Hi' }],
        userText: 'Go',
        remoteToggleValues: { toggle_state_tracker: '2' },
    });
    const combinedTextTracker = msgsTextTracker.map((m) => m.content).join('\n');
    assert.ok(combinedTextTracker.includes('- Status:'));
    assert.ok(!combinedTextTracker.includes('- Body & Sleep:'));
    assert.ok(!combinedTextTracker.includes('wakefulness 0-100'));
});

test('selectCacheFriendlyHistory preserves prefix across 5 turns & reconcileLeaveHayakuFooterContract fixes </statusdata>', () => {
    const makeMsgs = (count) => Array.from({ length: count }, (_, idx) => ({
        index: idx,
        role: idx % 2 === 0 ? 'user' : 'char',
        raw: `msg-${idx}`,
    }));

    const startIndices = [32, 34, 36, 38, 40].map((len) => relay.selectCacheFriendlyHistory(makeMsgs(len), { mode: 'chunked' })[0].index);
    assert.deepEqual(startIndices, [10, 10, 10, 10, 10], 'Prefix start index must stay locked at 10 across 5 U+A turns');
    assert.equal(relay.selectCacheFriendlyHistory(makeMsgs(42), { mode: 'chunked' })[0].index, 20);
    assert.equal(relay.selectCacheFriendlyHistory(makeMsgs(50), { mode: 'full' }).length, 50);
    assert.equal(relay.selectCacheFriendlyHistory(makeMsgs(40), { mode: 'sliding_30' })[0].index, 10);
    assert.equal(relay.selectCacheFriendlyHistory(makeMsgs(34), { mode: 'sliding_30' })[0].index, 4);

    // Footer conflict reconciliation & duplicate status-line cleanup
    const conflicting = [
        { role: 'system', content: '[LEAVE FINAL EXECUTION CHECK]\n- STEP 3 — CHARACTER-CARD STATUS LINE\n<statusdata>\n• 현장: A\n</statusdata>' },
        { role: 'system', content: '[HAYAKU SIDE-WRITE FINAL REMINDER]\nWrap raw JSON between <!-- HAYAKU_STATE_PACKET_START --> and <!-- HAYAKU_STATE_PACKET_END --> IMMEDIATELY BEFORE </statusdata>. FINAL CONTENT MUST END WITH: </statusdata>', _cachePoint: true },
    ];
    const reconciled = relay.reconcileLeaveHayakuFooterContract(conflicting);
    assert.ok(reconciled[1].content.includes('Place the entire HAYAKU packet AFTER </statusdata> and any character-card status line'));
    assert.ok(!reconciled[1].content.includes('IMMEDIATELY BEFORE </statusdata>. FINAL CONTENT MUST END WITH: </statusdata>'));
    assert.equal(reconciled[1]._cachePoint, true);

    const nonLeave = [{ role: 'system', content: 'Plain prompt' }, conflicting[1]];
    assert.equal(relay.reconcileLeaveHayakuFooterContract(nonLeave)[1].content, conflicting[1].content);

    // Multi-plugin tail shift (Leave + Lorebook + HAYAKU head [user] + Flashback + Leave Final + HAYAKU Reminder) & TTL miss
    const baseIntroMsgs = [
        { role: 'system', content: '[LEAVE ENGINE] System contract' },
        { role: 'system', content: '[Static World Lorebook]\nCampus Guide V1' },
        { role: 'user', content: 'Intro user greeting message long enough for lane sig.' },
        { role: 'assistant', content: 'Intro assistant reply message long enough for lane sig.' },
    ];
    const multiTailLogs = [
        // Turn 4 (newest): static lore mutated -> broken!
        {
            id: 'mt-4', source: 'direct_chat', ok: true, status: 200, model: 'deepseek-v4.1-flash:1017-cloud',
            remotePrompt: true, narrativeScopeKey: '0:0', charName: 'Cheongwon',
            usage: { prompt_tokens: 49000, cached_tokens: 1000, completion_tokens: 500, cache_reported: true },
            messages: [
                { role: 'system', content: '[LEAVE ENGINE] System contract' },
                { role: 'system', content: '[Static World Lorebook]\nMUTATED_STATIC_GUIDE' },
                { role: 'user', content: 'Intro user greeting message long enough for lane sig.' },
                { role: 'assistant', content: 'Intro assistant reply message long enough for lane sig.' },
                { role: 'user', content: 'U1 first turn content here.' }, { role: 'assistant', content: 'A1 first assistant reply.' },
                { role: 'user', content: 'U2 second turn content here.' }, { role: 'assistant', content: 'A2 second assistant reply.' },
                { role: 'user', content: 'U3 third turn content here.' }, { role: 'assistant', content: 'A3 third assistant reply.' },
                { role: 'user', content: 'U4 fourth turn content here.' },
                { role: 'system', content: '[LEAVE FINAL EXECUTION CHECK]\nDone' },
            ],
        },
        // Turn 3: intact prefix + +2 turn growth, but server reported cached_tokens=0 (TTL expired)
        {
            id: 'mt-3', source: 'direct_chat', ok: true, status: 200, model: 'deepseek-v4.1-flash:1017-cloud',
            remotePrompt: true, narrativeScopeKey: '0:0', charName: 'Cheongwon',
            usage: { prompt_tokens: 47261, cached_tokens: 0, completion_tokens: 500, cache_reported: true },
            messages: [
                ...baseIntroMsgs,
                { role: 'user', content: 'U1 first turn content here.' }, { role: 'assistant', content: 'A1 first assistant reply.' },
                { role: 'user', content: 'U2 second turn content here.' }, { role: 'assistant', content: 'A2 second assistant reply.' },
                { role: 'system', content: '[World / Module Lorebook]\nDYNAMIC_SCENE_LORE_T3' },
                { role: 'user', content: '[HAYAKU 활성 장면 헤드]\nScene T3' },
                { role: 'system', content: '[ACTIVE CONTINUITY EVIDENCE]\nEvidence T3' },
                { role: 'user', content: 'U3 third turn content here.' },
                { role: 'system', content: '[♥️ 호감도]\n-160' },
                { role: 'system', content: '[LEAVE FINAL EXECUTION CHECK]\nDone' },
                { role: 'system', content: '[HAYAKU SIDE-WRITE FINAL REMINDER]\nPacket' },
            ],
        },
        // Turn 2: intact prefix + +2 turn growth + multi-plugin tail shifted -> cacheBroken MUST be false!
        {
            id: 'mt-2', source: 'direct_chat', ok: true, status: 200, model: 'deepseek-v4.1-flash:1017-cloud',
            remotePrompt: true, narrativeScopeKey: '0:0', charName: 'Cheongwon',
            usage: { prompt_tokens: 45754, cached_tokens: 29184, completion_tokens: 500, cache_reported: true },
            messages: [
                ...baseIntroMsgs,
                { role: 'user', content: 'U1 first turn content here.' }, { role: 'assistant', content: 'A1 first assistant reply.' },
                { role: 'system', content: '[World / Module Lorebook]\nDYNAMIC_SCENE_LORE_T2' },
                { role: 'user', content: '[HAYAKU 활성 장면 헤드]\nScene T2' },
                { role: 'system', content: '[ACTIVE CONTINUITY EVIDENCE]\nEvidence T2' },
                { role: 'user', content: 'U2 second turn content here.' },
                { role: 'system', content: '[♥️ 호감도]\n-150' },
                { role: 'system', content: '[LEAVE FINAL EXECUTION CHECK]\nDone' },
                { role: 'system', content: '[HAYAKU SIDE-WRITE FINAL REMINDER]\nPacket' },
            ],
        },
        // Turn 1: baseline
        {
            id: 'mt-1', source: 'direct_chat', ok: true, status: 200, model: 'deepseek-v4.1-flash:1017-cloud',
            remotePrompt: true, narrativeScopeKey: '0:0', charName: 'Cheongwon',
            usage: { prompt_tokens: 39738, cached_tokens: 0, completion_tokens: 500, cache_reported: true },
            messages: [
                ...baseIntroMsgs,
                { role: 'system', content: '[World / Module Lorebook]\nDYNAMIC_SCENE_LORE_T1' },
                { role: 'user', content: '[HAYAKU 활성 장면 헤드]\nScene T1' },
                { role: 'system', content: '[ACTIVE CONTINUITY EVIDENCE]\nEvidence T1' },
                { role: 'user', content: 'U1 first turn content here.' },
                { role: 'system', content: '[♥️ 호감도]\n-145' },
                { role: 'system', content: '[LEAVE FINAL EXECUTION CHECK]\nDone' },
                { role: 'system', content: '[HAYAKU SIDE-WRITE FINAL REMINDER]\nPacket' },
            ],
        },
    ];
    relay.recomputeRequestLogsCacheGuard(multiTailLogs);
    const [mt4, mt3, mt2, mt1] = multiTailLogs;
    assert.equal(mt1.cacheGuard.verdict, 'baseline');
    assert.equal(mt2.cacheGuard.cacheBroken, false, 'Normal multi-plugin tail shift must NOT falsely flag lorebook_removed');
    assert.equal(mt2.cacheGuard.causeCode, 'tail_post_history_shift');
    assert.equal(mt2.cacheGuard.verdict, 'ok');
    assert.equal(mt3.cacheGuard.cacheBroken, true);
    assert.equal(mt3.cacheGuard.causeCode, 'server_cache_miss', 'Zero cached_tokens on intact multi-plugin turn shift should report TTL/server_cache_miss');
    assert.equal(mt4.cacheGuard.cacheBroken, true, 'Mutating static lore prefix must still be caught');
    assert.notEqual(mt4.cacheGuard.causeCode, 'tail_post_history_shift');

    const dupFooter = [
        '본문 서사입니다.',
        '',
        '<statusdata>',
        '📖 Leave HUD · 2025.03.04 PM 01:32 · 뒷산',
        '• 현장: 시은',
        '</statusdata>',
        '',
        '[☀️][7°C][2025.03.04][PM 01:32][뒷산][접촉]',
        '',
        ' ',
        '[☀️][7°C][2025.03.04][PM 01:32][뒷산][접촉]',
        '',
        'HAYAKU_STATE_PACKET_START',
        '{"ok":true}',
        'HAYAKU_STATE_PACKET_END',
    ].join('\n');
    const deduped = relay.dedupeTrailingStatusLines(dupFooter);
    assert.equal(deduped.match(/\[☀️\]\[7°C\]\[2025\.03\.04\]\[PM 01:32\]\[뒷산\]\[접촉\]/g).length, 1);
    assert.ok(deduped.includes('<statusdata>\n📖 Leave HUD'));
    assert.ok(deduped.includes('HAYAKU_STATE_PACKET_START'));

    const auditExpandedCrutch = relay.auditDraftWithDeterministicGuards(
        '손가락이 아주 작게 움직였고 아주 얇게 배어 나오더니 아주 조금 흔들렸다.',
        { isRpMode: false }
    );
    assert.ok(auditExpandedCrutch.issues.some((i) => i.code === 'crutch_adverb_overuse'));

    const auditEn = relay.auditDraftWithDeterministicGuards(
        'She said "Still don\'t feel it?" and nodded. Jin smiled as she very slowly, faintly slightly, ever so quietly stepped back.',
        { userText: '"Still don\'t feel it?" Jin asked.', personaName: 'Jin', isRpMode: true }
    );
    const enCodes = new Set(auditEn.issues.map((i) => i.code));
    assert.ok(enCodes.has('rp_impersonation'));
    assert.ok(enCodes.has('crutch_adverb_overuse'));
    assert.ok(enCodes.has('user_quote_echo'));

    // Static vs Dynamic Lorebook Cache-Tier Separation (Leave preset puts lorebook after chat)
    const leave = relay.loadBundledLeavePreset();
    const tieredMsgs = relay.buildDirectPromptMessages({
        preset: leave,
        snap: {
            charName: 'Cheongwon',
            charContext: {
                name: 'Cheongwon',
                desc: 'School campus.',
                loreEntries: [
                    { uid: 'c-static', source: 'char', comment: '🏫 기본 정보', key: '', alwaysActive: true, insertorder: 100, content: 'STATIC_CAMPUS_WORLD_GUIDE' },
                    { uid: 'c-dyn-macro', source: 'char', comment: '♥️ 호감도', key: '', alwaysActive: true, insertorder: 90, content: 'AFFECTION_DYNAMIC={{getvar::aff_sieun}}' },
                    { uid: 'c-dyn-kw', source: 'char', comment: '주시은 시트', key: '시은', alwaysActive: false, insertorder: 80, content: 'DYNAMIC_SIEUN_SHEET' },
                ],
            },
            chatVariables: { aff_sieun: '-160' },
        },
        historyMessages: [{ index: 0, role: 'user', raw: '안녕' }],
        userText: '시은아.',
    });
    const staticIdx = tieredMsgs.findIndex((m) => m.content.includes('STATIC_CAMPUS_WORLD_GUIDE'));
    const firstChatMsgIdx = tieredMsgs.findIndex((m) => m.role === 'user' && m.content === '안녕');
    const dynMacroIdx = tieredMsgs.findIndex((m) => m.content.includes('AFFECTION_DYNAMIC=-160'));
    const dynKwIdx = tieredMsgs.findIndex((m) => m.content.includes('DYNAMIC_SIEUN_SHEET'));
    assert.ok(staticIdx >= 0 && staticIdx < firstChatMsgIdx, 'Static alwaysActive lorebook must sit BEFORE chat in cached prefix');
    assert.ok(tieredMsgs[staticIdx]._cachePoint === true || tieredMsgs.slice(0, firstChatMsgIdx).some((m) => m._cachePoint === true));
    assert.ok(dynMacroIdx > firstChatMsgIdx, 'Macro-dependent alwaysActive lorebook must stay AFTER chat');
    assert.ok(dynKwIdx > firstChatMsgIdx, 'Keyword lorebook must stay AFTER chat');

    const auditJp = relay.auditDraftWithDeterministicGuards(
        '「まだ実感わかない？」彼は封筒を受け取り、とてもゆっくり、ごくわずかに、ほんの少し後ろへ下がった。',
        { userText: '「まだ実感わかない？」とレンは聞いた。', personaName: 'レン', isRpMode: true }
    );
    const jpCodes = new Set(auditJp.issues.map((i) => i.code));
    assert.ok(jpCodes.has('rp_impersonation'));
    assert.ok(jpCodes.has('crutch_adverb_overuse'));
    assert.ok(jpCodes.has('user_quote_echo'));
});

test('Anthropic cache_control + preset sampling fallback, deterministic guards, and Two-Pass 2-stage pipeline', async () => {
    const capturedAnthropic = [];
    const anthropicUpstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            capturedAnthropic.push(parsed);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                id: 'msg_test',
                model: parsed.model,
                content: [{ type: 'text', text: 'Anthropic cached reply.' }],
                usage: { input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 50, output_tokens: 40 },
            }));
        });
    });
    await new Promise((r) => anthropicUpstream.listen(0, '127.0.0.1', r));
    const antPort = anthropicUpstream.address().port;

    const capturedOai = [];
    const oaiUpstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            capturedOai.push(parsed);
            const isDraftPass = parsed.messages.some((m) => String(m.content || '').includes('[TWO-PASS DRAFT ENGINE — PASS 1'));
            const replyText = isDraftPass
                ? '그가 서류를 받아 들고 아주 천천히 고개를 들었다. 아주 짧게 숨을 삼키더니 아주 낮게 중얼거렸다. "아직 느낌이 안 와?"'
                : '문고리가 철컥 잠기는 소리가 복도 끝에서 먼저 끊겼다.\n<statusdata>\n📖 Leave HUD · 오후 · 음악실\n• 현장: 강다인\n• 다음 씨앗: 잠긴 문\n</statusdata>';
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                id: 'oai_test',
                model: parsed.model,
                choices: [{ index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 500, completion_tokens: 80, prompt_cache_hit_tokens: isDraftPass ? 0 : 400 },
            }));
        });
    });
    await new Promise((r) => oaiUpstream.listen(0, '127.0.0.1', r));
    const oaiPort = oaiUpstream.address().port;

    try {
        // Unit checks on extractTerminalSceneTail & auditDraftWithDeterministicGuards
        const tail = relay.extractTerminalSceneTail([
            { role: 'user', raw: '문 열어.' },
            { role: 'char', raw: '<thinking>plan</thinking>\n강다인이 빗장을 손끝으로 눌렀다.\n<statusdata>\nHUD\n</statusdata>\n[☀️][7°C][2025.03.03]\n<!-- HAYAKU_STATE_PACKET_START -->{}<!-- HAYAKU_STATE_PACKET_END -->' },
        ], 2400);
        assert.equal(tail, '강다인이 빗장을 손끝으로 눌렀다.');

        const guardAudit = relay.auditDraftWithDeterministicGuards(
            '[☀️][7°C]\n<statusdata>\nHUD\n</statusdata>\n강다인이 빗장을 손끝으로 눌렀다. 강다인이 빗장을 손끝으로 눌렀다.\n진우가 조용히 웃었다. 아주 천천히, 아주 짧게, 아주 낮게 대답했다. "아직 느낌이 안 와?"',
            {
                prevAssistantText: '강다인이 빗장을 손끝으로 눌렀다. 음악실 문틈 사이로 차가운 복도 공기가 흘러들어오고 있었다.',
                userText: '"아직 느낌이 안 와?" 진우는 가만히 물었다.',
                personaName: '진우',
                isRpMode: true,
            }
        );
        const issueCodes = new Set(guardAudit.issues.map((i) => i.code));
        assert.equal(guardAudit.ok, false);
        assert.ok(issueCodes.has('prior_turn_regression'));
        assert.ok(issueCodes.has('rp_impersonation'));
        assert.ok(issueCodes.has('crutch_adverb_overuse'));
        assert.ok(issueCodes.has('user_quote_echo'));
        assert.ok(issueCodes.has('footer_order_violation'));

        // 1) Anthropic cache_control + Leave sampling fallback
        const tok1 = 'ant-cache-token';
        const srv1 = relay.createRelayServer({
            token: tok1,
            configOverride: {
                activeProfileId: 'prof-ant',
                directPresetId: 'bundled:leave',
                profiles: [{
                    id: 'prof-ant',
                    name: 'Claude Blank Sampling',
                    providerType: 'anthropic',
                    baseUrl: `http://127.0.0.1:${antPort}/v1/messages`,
                    apiKey: 'sk-ant-test',
                    model: 'claude-sonnet-4-20250514',
                    temperature: '',
                    maxTokens: '',
                }],
            },
        });
        await new Promise((r) => srv1.listen(0, '127.0.0.1', r));
        const port1 = srv1.address().port;
        try {
            const hdrs1 = { 'X-RisuStand-Token': tok1, 'Content-Type': 'application/json' };
            await requestHttp(port1, {
                method: 'POST',
                path: '/api/pc/poll',
                headers: hdrs1,
                body: JSON.stringify({
                    catalog: { characters: [{ index: 0, name: 'CharA', chats: [{ index: 0, id: 'c0', name: 'Chat 1', msgCount: 2 }] }] },
                    snapshot: {
                        charIndex: 0,
                        chatIndex: 0,
                        charName: 'CharA',
                        chatName: 'Chat 1',
                        isPcActive: false,
                        charContext: { name: 'CharA', desc: 'Campus room.' },
                        messages: [{ index: 0, role: 'user', raw: 'Hi' }, { index: 1, role: 'char', raw: 'Hello there.' }],
                    },
                }),
            });
            const sendAnt = await requestHttp(port1, {
                method: 'POST',
                path: '/api/chat/send',
                headers: hdrs1,
                body: JSON.stringify({ charIndex: 0, chatIndex: 0, text: 'Continue cleanly.' }),
            });
            assert.equal(sendAnt.status, 200);
            for (let i = 0; i < 60 && capturedAnthropic.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
            assert.equal(capturedAnthropic.length, 1);
            const antBody = capturedAnthropic[0];
            assert.equal(antBody.temperature, 0.8, 'Leave preset temperature 0.8 should apply when profile leaves it blank');
            assert.equal(antBody.max_tokens, 8192, 'Leave preset maxResponse 8192 should apply when profile leaves it blank');
            assert.ok(Array.isArray(antBody.system), 'Anthropic system should serialize as content-block array when cachePoint is active');
            assert.ok(antBody.system.some((b) => b.cache_control && b.cache_control.type === 'ephemeral'));
        } finally {
            await new Promise((r) => srv1.close(r));
        }

        // 2) Two-pass pipeline end-to-end + Web UI script & config API
        const tok2 = 'two-pass-token';
        const srv2 = relay.createRelayServer({
            token: tok2,
            configOverride: {
                activeProfileId: 'prof-oai',
                directPresetId: 'bundled:leave',
                directHistoryMode: 'chunked',
                directPipelineMode: 'two_pass',
                profiles: [{
                    id: 'prof-oai',
                    name: 'DeepSeek Main',
                    providerType: 'openai_compat',
                    baseUrl: `http://127.0.0.1:${oaiPort}/v1/chat/completions`,
                    apiKey: 'sk-oai-test',
                    model: 'deepseek-v4.1-flash:1017-cloud',
                    temperature: '0.6',
                    maxTokens: '2048',
                }],
            },
        });
        await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
        const port2 = srv2.address().port;
        try {
            const hdrs2 = { 'X-RisuStand-Token': tok2, 'Content-Type': 'application/json' };
            await requestHttp(port2, {
                method: 'POST',
                path: '/api/pc/poll',
                headers: hdrs2,
                body: JSON.stringify({
                    catalog: { characters: [{ index: 0, name: 'CharA', chats: [{ index: 0, id: 'c0', name: 'Chat 1', msgCount: 2 }] }] },
                    snapshot: {
                        charIndex: 0,
                        chatIndex: 0,
                        charName: 'CharA',
                        chatName: 'Chat 1',
                        isPcActive: false,
                        charContext: { name: 'CharA', personaName: '진우', desc: 'Campus room.' },
                        messages: [{ index: 0, role: 'user', raw: '문 열어.' }, { index: 1, role: 'char', raw: '강다인이 빗장을 손끝으로 눌렀다.\n<statusdata>\nHUD\n</statusdata>' }],
                    },
                }),
            });
            const send2 = await requestHttp(port2, {
                method: 'POST',
                path: '/api/chat/send',
                headers: hdrs2,
                body: JSON.stringify({ charIndex: 0, chatIndex: 0, text: '"아직 느낌이 안 와?" 진우는 가만히 물었다.' }),
            });
            assert.equal(send2.status, 200);
            for (let i = 0; i < 80 && capturedOai.length < 2; i += 1) await new Promise((r) => setTimeout(r, 20));
            assert.equal(capturedOai.length, 2, 'Two-pass mode must issue Pass 1 draft + Pass 2 polish');
            assert.equal(capturedOai[1].temperature, 0.6, 'Explicit profile temperature must override Leave preset');
            assert.equal(capturedOai[1].max_tokens, 2048, 'Explicit profile maxTokens must override Leave preset');
            assert.ok(!capturedOai[1].messages.some((m) => '_cachePoint' in m), '_cachePoint metadata must be stripped for OpenAI payloads');
            const pass2Text = capturedOai[1].messages.map((m) => m.content).join('\n');
            assert.ok(pass2Text.includes('[TWO-PASS EDITORIAL POLISH — PASS 2 FINISHING]'));
            assert.ok(pass2Text.includes('crutch_adverb_overuse'));
            assert.ok(pass2Text.includes('user_quote_echo'));
            assert.ok(pass2Text.includes('rp_impersonation'));

            const logsRes = JSON.parse((await requestHttp(port2, { path: '/api/logs', headers: hdrs2 })).body);
            const pass2Log = logsRes.logs.find((l) => l.source === 'direct_chat');
            const pass1Log = logsRes.logs.find((l) => l.source === 'direct_draft');
            assert.ok(pass2Log && pass2Log.cacheGuard.eligible === true);
            assert.ok(pass1Log && pass1Log.cacheGuard.eligible === false, 'Pass 1 direct_draft must be excluded from main Cache Guard lane');

            const cfgRes = JSON.parse((await requestHttp(port2, {
                method: 'POST',
                path: '/api/router/config',
                headers: hdrs2,
                body: JSON.stringify({ directHistoryMode: 'full', directPipelineMode: 'single' }),
            })).body);
            assert.equal(cfgRes.directHistoryMode, 'full');
            assert.equal(cfgRes.directPipelineMode, 'single');

            const htmlRes = await requestHttp(port2, { path: '/' });
            assert.ok(htmlRes.body.includes('id="directHistoryModeSel"'));
            assert.ok(htmlRes.body.includes('id="directPipelineModeSel"'));
            const scriptMatch = htmlRes.body.match(/<script>([\s\S]*?)<\/script>/);
            assert.ok(scriptMatch);
            new vm.Script(scriptMatch[1], { filename: 'webapp-two-pass-inline.js' });
        } finally {
            await new Promise((r) => srv2.close(r));
        }
    } finally {
        if (typeof anthropicUpstream.closeAllConnections === 'function') anthropicUpstream.closeAllConnections();
        if (typeof oaiUpstream.closeAllConnections === 'function') oaiUpstream.closeAllConnections();
        await new Promise((r) => anthropicUpstream.close(r));
        await new Promise((r) => oaiUpstream.close(r));
    }
});

test('home tab UI and bot thumbnail endpoints (custom upload, default reset, auth, uncached asset rejection)', async () => {
    const tok = 'home-thumb-test-token';
    const server = relay.createRelayServer({ token: tok, configOverride: {} });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const requestBinary = (reqPath, headers = {}) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: reqPath, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                buf: Buffer.concat(chunks),
            }));
        });
        req.on('error', reject);
        req.end();
    });
    try {
        const htmlRes = await requestHttp(port, { path: '/' });
        assert.equal(htmlRes.status, 200);
        assert.ok(htmlRes.body.includes('id="tab-home"'));
        assert.ok(htmlRes.body.includes('data-tab="home"'));
        assert.ok(htmlRes.body.includes('id="thumbPickerModal"'));
        assert.ok(htmlRes.body.includes('tab-chat-active'));
        assert.ok(!htmlRes.body.includes('data-tab="bots"'));

        const unauthThumb = await requestBinary('/api/asset/bot-thumb/c1');
        assert.equal(unauthThumb.status, 401);

        // Tiny valid 1x1 transparent PNG
        const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
        const expectedPng = Buffer.from(pngB64, 'base64');
        const hdrs = { 'X-RisuStand-Token': tok, 'Content-Type': 'application/json' };

        const postCustom = await requestHttp(port, {
            method: 'POST',
            path: '/api/bot-thumb',
            headers: hdrs,
            body: JSON.stringify({
                chaId: 'c1',
                source: 'custom',
                dataUri: 'data:image/png;base64,' + pngB64,
            }),
        });
        assert.equal(postCustom.status, 200);
        const postCustomJson = JSON.parse(postCustom.body);
        assert.equal(postCustomJson.ok, true);
        assert.equal(postCustomJson.botThumbs.c1.source, 'custom');

        const getCustom = await requestBinary('/api/asset/bot-thumb/c1', { 'X-RisuStand-Token': tok });
        assert.equal(getCustom.status, 200);
        assert.equal(getCustom.headers['content-type'], 'image/png');
        assert.deepEqual(getCustom.buf, expectedPng);

        const stateRes = await requestHttp(port, { path: '/api/state', headers: { 'X-RisuStand-Token': tok } });
        assert.equal(stateRes.status, 200);
        const stateJson = JSON.parse(stateRes.body);
        assert.equal(stateJson.botThumbs.c1.source, 'custom');

        const postDefault = await requestHttp(port, {
            method: 'POST',
            path: '/api/bot-thumb',
            headers: hdrs,
            body: JSON.stringify({ chaId: 'c1', source: 'default' }),
        });
        assert.equal(postDefault.status, 200);

        const afterReset = await requestBinary('/api/asset/bot-thumb/c1', { 'X-RisuStand-Token': tok });
        assert.equal(afterReset.status, 404);

        const uncachedAsset = await requestHttp(port, {
            method: 'POST',
            path: '/api/bot-thumb',
            headers: hdrs,
            body: JSON.stringify({ chaId: 'c1', charIndex: 0, source: 'asset', assetIndex: 0 }),
        });
        assert.equal(uncachedAsset.status, 400);

        // Regression checks for /favicon.ico, mobile-web-app-capable meta, postMessage null guard, and idle count CSS
        const favRes = await requestHttp(port, { path: '/favicon.ico' });
        assert.equal(favRes.status, 204);
        assert.ok(htmlRes.body.includes('name="mobile-web-app-capable"'));
        assert.ok(htmlRes.body.includes("document.getElementById('pluginGuiFrame') === frame && frame.contentWindow"));
        assert.ok(htmlRes.body.includes('.rs-pfm-stage [data-am-count-region][x-am-count-visible="false"]'));
        assert.ok(htmlRes.body.includes('id="chatPinnedPluginCtrl"'));
        assert.ok(htmlRes.body.includes('data-pfm-opt-show'));
        assert.ok(htmlRes.body.includes('data-pfm-opt-place'));
        assert.ok(htmlRes.body.includes('data-pfm-opt-align'));
        assert.ok(htmlRes.body.includes('data-pfm-opt-nudge'));
        assert.ok(htmlRes.body.includes('renderChatFloatingControls'));
        assert.ok(htmlRes.body.includes('id="pluginSurfaceStyleHost"'));
        assert.ok(htmlRes.body.includes('function syncPluginSurfaceStyles('));
        assert.ok(htmlRes.body.includes('#pluginFloatingModal.is-action-overlay .plg-float-dialog'));
        assert.ok(htmlRes.body.includes("'data-am-viewer-action'"));
        assert.ok(htmlRes.body.includes('pluginSurfaceStyles'));
        assert.ok(htmlRes.body.includes('extractFixedMenuSelectorsFromStyles'));
        assert.ok(htmlRes.body.includes('appendMdProseSegment'));
        assert.ok(htmlRes.body.includes('pluginModalRules'));
        assert.ok(htmlRes.body.includes('shouldOpenPluginOverlay'));
        assert.ok(htmlRes.body.includes('data-pfm-modal-rule'));
        assert.ok(htmlRes.body.includes('data-pfm-suppress-modal'));
        assert.ok(!htmlRes.body.includes('id="pluginFloatingDock"'));
        assert.ok(!htmlRes.body.includes('id="pluginRootFloatingHost"'));
        assert.ok(!htmlRes.body.includes('data-pfm-open-gui'));
        const uiScript = htmlRes.body.match(/<script>([\s\S]*?)<\/script>/);
        assert.ok(uiScript);
        new vm.Script(uiScript[1], { filename: 'webapp-floating-ui-regression.js' });

        // CSS-scoped RisuAI chat container selectors and style-declared fixed bot menu detection
        const cssScopeMatch = uiScript[1].match(/function sanitizeBotCss[\s\S]*?function sanitizeBotNode/);
        assert.ok(cssScopeMatch);
        const cssScopeCtx = {};
        vm.runInNewContext(cssScopeMatch[0].replace(/function sanitizeBotNode$/, ''), cssScopeCtx);
        const scopedChat = cssScopeCtx.scopeBotCss('.chattext p { color: #123; } .risu-chat em { font-style: italic; }');
        assert.ok(scopedChat.includes('.rs-bot-html p') && scopedChat.includes('color: #123;'));
        assert.ok(scopedChat.includes('.rs-bot-html em') && scopedChat.includes('font-style: italic;'));

        const fixedFnMatch = uiScript[1].match(/const BOT_FIXED_CLASS_SEL[\s\S]*?function syncBotBackground/);
        assert.ok(fixedFnMatch);
        const fixedMenuCtx = {};
        vm.runInNewContext(fixedFnMatch[0].replace(/function syncBotBackground$/, ''), fixedMenuCtx);
        const mkNode = (tag, { cls = '', style = '', text = '' } = {}) => ({
            nodeType: 1,
            tagName: tag.toUpperCase(),
            className: cls,
            textContent: text,
            children: [],
            parentElement: null,
            getAttribute(k) { return k === 'style' ? style : (k === 'class' ? cls : null); },
            appendChild(c) { c.parentElement = this; this.children.push(c); return c; },
            remove() {
                if (this.parentElement) {
                    this.parentElement.children = this.parentElement.children.filter((x) => x !== this);
                    this.parentElement = null;
                }
            },
            querySelectorAll(sel) {
                const out = [];
                const parts = sel.split(',').map((s) => s.trim());
                const matchesOne = (node, s) => {
                    if (s === 'style') return node.tagName === 'STYLE';
                    if (s.startsWith('.')) return node.className.split(/\s+/).includes(s.slice(1));
                    const attrMatch = s.match(/^\[class\*="([^"]+)"/i);
                    if (attrMatch) return node.className.toLowerCase().includes(attrMatch[1].toLowerCase());
                    return false;
                };
                const walk = (n) => { for (const c of n.children) { if (parts.some((p) => matchesOne(c, p))) out.push(c); walk(c); } };
                walk(this);
                return out;
            },
            querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
        });
        const badgeContainer = mkNode('div');
        badgeContainer.appendChild(mkNode('style', { text: '.slogm-badge { position: fixed; top: 14px; right: 14px; }' }));
        badgeContainer.appendChild(mkNode('label', { cls: 'slogm-badge', text: '플래그 0' }));
        assert.equal(fixedMenuCtx.containerHasBotFixedMenu(badgeContainer), true, 'CSS-declared fixed label badge must be detected');

        // Cross-container detection: backgroundHTML <style> declaring .hy-float { position: fixed; } + msg .hy-ui wrapper
        const bgStyleHost = mkNode('div');
        bgStyleHost.appendChild(mkNode('style', { text: '.hy-float { position: fixed; right: 18px; top: 88px; } .hy-panel { position: fixed; right: 0; }' }));
        const hyMsgContainer = mkNode('div');
        const hyUi = hyMsgContainer.appendChild(mkNode('div', { cls: 'hy-ui' }));
        hyUi.appendChild(mkNode('button', { cls: 'hy-float', text: '유혜연' }));
        hyUi.appendChild(mkNode('div', { cls: 'hy-panel', text: '패널' }));
        assert.equal(fixedMenuCtx.containerHasBotFixedMenu(hyMsgContainer, bgStyleHost), true, 'backgroundHTML style fixed rule must detect .hy-ui/.hy-float in message');
        assert.ok(fixedMenuCtx.isSelfContainedFixedUiWrapper(hyUi, fixedMenuCtx.extractFixedMenuSelectorsFromStyles(hyMsgContainer, bgStyleHost)));
        fixedMenuCtx.stripBotFixedMenuNodes(hyMsgContainer, bgStyleHost);
        assert.equal(hyMsgContainer.children.length, 0, 'stripped self-contained .hy-ui wrapper leaves no duplicate in bubble');
    } finally {
        await new Promise((r) => server.close(r));
    }
});

test('select_target prioritizes ahead of sync_all, supports fast Host RPC switch & fallback, and web selectTarget script compiles', async () => {
    const tok = 'select-target-priority-tok';
    const server = relay.createRelayServer({ token: tok, configOverride: {} });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const hdrs = { 'X-RisuStand-Token': tok, 'Content-Type': 'application/json' };
    try {
        // Verify client selectTarget / clearPendingTargetSwitch script compiles cleanly
        const htmlRes = await requestHttp(port, { path: '/' });
        assert.equal(htmlRes.status, 200);
        const uiScript = htmlRes.body.match(/<script>([\s\S]*?)<\/script>/);
        assert.ok(uiScript);
        new vm.Script(uiScript[1], { filename: 'webapp-select-target.js' });
        assert.ok(uiScript[1].includes('clearPendingTargetSwitch'));
        assert.ok(uiScript[1].includes('fastSwitch') || uiScript[1].includes('res.snapshot'));
        assert.ok(htmlRes.body.includes('id="afCompact"') && htmlRes.body.includes('id="afOriginal"'));
        assert.ok(uiScript[1].includes('setAssetFit') && uiScript[1].includes('applyCompactBotAssetFit'));
        assert.ok(htmlRes.body.includes('asset-fit-compact'));

        // Drain any leftover module-level state.commandQueue entries from earlier tests
        for (let d = 0; d < 6; d += 1) {
            const drainRes = JSON.parse((await requestHttp(port, {
                method: 'POST',
                path: '/api/pc/poll',
                headers: hdrs,
                body: JSON.stringify({ supportsBatchCommands: true }),
            })).body);
            if (!Array.isArray(drainRes.commands) || drainRes.commands.length === 0) break;
        }

        // Queue sync_all first, then select_target; verify sync_all is dropped and select_target is delivered first
        const sRes = await requestHttp(port, { method: 'POST', path: '/api/command', headers: hdrs, body: JSON.stringify({ type: 'sync_all' }) });
        assert.equal(sRes.status, 200);
        const tRes = await requestHttp(port, { method: 'POST', path: '/api/command', headers: hdrs, body: JSON.stringify({ type: 'select_target', payload: { charIndex: 2, chatIndex: 3 } }) });
        assert.equal(tRes.status, 200);

        const pollRes1 = await requestHttp(port, {
            method: 'POST',
            path: '/api/pc/poll',
            headers: hdrs,
            body: JSON.stringify({
                supportsBatchCommands: true,
                snapshot: { charIndex: 0, chatIndex: 0, charName: 'Bot0', chatName: 'C0', isPcActive: true, totalMessages: 1, messages: [{ index: 0, role: 'char', raw: 'hi', html: 'hi', text: 'hi' }] },
            }),
        });
        assert.equal(pollRes1.status, 200);
        const pollBody1 = JSON.parse(pollRes1.body);
        assert.equal(pollBody1.commands.length, 1);
        assert.equal(pollBody1.commands[0].type, 'select_target');
        assert.deepEqual(pollBody1.commands[0].payload, { charIndex: 2, chatIndex: 3 });

        // Helper that pumps /api/pc/rpc-wait, replying [] to background db.listPluginsMeta
        // until the target RPC op arrives and is answered cleanly.
        const pumpRpcUntil = async (targetOp, respondFn) => {
            for (let attempt = 0; attempt < 6; attempt += 1) {
                const waitRes = JSON.parse((await requestHttp(port, {
                    method: 'POST',
                    path: '/api/pc/rpc-wait',
                    headers: hdrs,
                    body: JSON.stringify({ timeoutMs: 1500 }),
                })).body);
                const calls = Array.isArray(waitRes.calls) ? waitRes.calls : [];
                if (!calls.length) continue;
                let matchedCall = null;
                const results = [];
                for (const c of calls) {
                    if (c.op === targetOp && !matchedCall) {
                        matchedCall = c;
                        results.push(respondFn(c));
                    } else if (c.op === 'db.listPluginsMeta') {
                        results.push({ id: c.id, ok: true, value: [] });
                    } else {
                        results.push({ id: c.id, ok: true, value: null });
                    }
                }
                await requestHttp(port, {
                    method: 'POST',
                    path: '/api/pc/rpc-result',
                    headers: hdrs,
                    body: JSON.stringify({ results }),
                });
                if (matchedCall) return matchedCall;
            }
            return null;
        };

        // 1) Fast switch via bridge.selectTarget
        const pumpPromise1 = pumpRpcUntil('bridge.selectTarget', (c) => ({
            id: c.id,
            ok: true,
            value: { ok: true, charIndex: c.args[0], chatIndex: c.args[1] },
        }));
        await new Promise((r) => setTimeout(r, 40));
        const fastCmdPromise = requestHttp(port, {
            method: 'POST',
            path: '/api/command',
            headers: hdrs,
            body: JSON.stringify({ type: 'select_target', payload: { charIndex: 1, chatIndex: 2 } }),
        });
        const rpcCall1 = await pumpPromise1;
        assert.ok(rpcCall1, 'select_target must invoke bridge.selectTarget when Host RPC is active');
        assert.deepEqual(rpcCall1.args, [1, 2]);
        await requestHttp(port, {
            method: 'POST',
            path: '/api/pc/poll',
            headers: hdrs,
            body: JSON.stringify({
                snapshot: { charIndex: 1, chatIndex: 2, charName: 'Bot1', chatName: 'Room 2', isPcActive: false, totalMessages: 1, messages: [{ index: 0, role: 'char', raw: 'ok', html: 'ok', text: 'ok' }] },
            }),
        });
        const fastResBody = JSON.parse((await fastCmdPromise).body);
        assert.equal(fastResBody.ok, true);
        assert.equal(fastResBody.fastSwitch, true);
        assert.equal(fastResBody.snapshot.charIndex, 1);
        assert.equal(fastResBody.snapshot.chatIndex, 2);

        // 2) Legacy plugin returning Unsupported host RPC op falls back to queued select_target
        const pumpPromise2 = pumpRpcUntil('bridge.selectTarget', (c) => ({
            id: c.id,
            ok: false,
            error: 'Unsupported host RPC op: bridge.selectTarget',
        }));
        await new Promise((r) => setTimeout(r, 40));
        const fallbackCmdPromise = requestHttp(port, {
            method: 'POST',
            path: '/api/command',
            headers: hdrs,
            body: JSON.stringify({ type: 'select_target', payload: { charIndex: 0, chatIndex: 1 } }),
        });
        const rpcCall2 = await pumpPromise2;
        assert.ok(rpcCall2);
        const fbBody = JSON.parse((await fallbackCmdPromise).body);
        assert.equal(fbBody.ok, true);
        const pollFb = JSON.parse((await requestHttp(port, {
            method: 'POST',
            path: '/api/pc/poll',
            headers: hdrs,
            body: JSON.stringify({ supportsBatchCommands: true }),
        })).body);
        assert.equal(pollFb.commands[0].type, 'select_target');
        assert.deepEqual(pollFb.commands[0].payload, { charIndex: 0, chatIndex: 1 });
    } finally {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        await new Promise((r) => server.close(r));
    }
});

test('2-page book pagination guards atomic polaroid assets, relaxes tall text blocks, and fixes risustand.js spreadIdx', async () => {
    const server = relay.createRelayServer({ token: 'book-pagination-token' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
        const htmlRes = await requestHttp(port, { path: '/' });
        assert.equal(htmlRes.status, 200);
        const html = htmlRes.body;

        for (const marker of [
            '--book-col-h',
            'prepareBookPaginationBlocks',
            'data-rs-book-atomic',
            'data-rs-book-breakable',
            'data-rs-book-flow',
            'orphans:2; widows:2;',
            'padding:12px 0',
            'ResizeObserver',
        ]) {
            assert.ok(html.includes(marker), `Expected ${marker} in relay web UI`);
        }

        const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
        assert.ok(scriptMatch);
        new vm.Script(scriptMatch[1], { filename: 'webapp-book-pagination-inline.js' });

        const bgFnMatch = scriptMatch[1].match(/function extractCssBgImageUrl[\s\S]*?function ensureBotAssetRatio/);
        const prepFnMatch = scriptMatch[1].match(/function prepareBookPaginationBlocks[\s\S]*?function layoutBookSpreads/);
        assert.ok(bgFnMatch && prepFnMatch, 'Expected extractCssBgImageUrl and prepareBookPaginationBlocks functions');

        const makeEl = (tag, opts = {}) => {
            const attrs = new Map();
            const classes = (opts.className || '').split(/\s+/).filter(Boolean);
            const el = {
                tagName: tag.toUpperCase(),
                children: [],
                parentElement: null,
                style: { ...(opts.style || {}) },
                offsetHeight: opts.offsetHeight || 0,
                scrollHeight: opts.scrollHeight || opts.offsetHeight || 0,
                _text: opts.text || '',
                _cs: opts.cs || {},
                classList: {
                    contains: (c) => classes.includes(c),
                },
                getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
                setAttribute: (k, v) => attrs.set(k, String(v)),
                removeAttribute: (k) => attrs.delete(k),
                hasAttribute: (k) => attrs.has(k),
                append(...kids) {
                    for (const k of kids) {
                        k.parentElement = el;
                        el.children.push(k);
                    }
                    return el;
                },
                get textContent() {
                    return el._text + el.children.map((c) => c.textContent).join('');
                },
            };
            if (opts.attrs) {
                for (const [k, v] of Object.entries(opts.attrs)) attrs.set(k, String(v));
            }
            const matchSimple = (node, simple) => {
                let s = simple.trim();
                if (!s) return false;
                const tagM = s.match(/^[a-zA-Z0-9_-]+/);
                if (tagM) {
                    if (node.tagName.toLowerCase() !== tagM[0].toLowerCase()) return false;
                    s = s.slice(tagM[0].length);
                }
                while (s.length) {
                    if (s[0] === '.') {
                        const cm = s.slice(1).match(/^[a-zA-Z0-9_-]+/);
                        if (!cm || !node.classList.contains(cm[0])) return false;
                        s = s.slice(1 + cm[0].length);
                    } else if (s[0] === '[') {
                        const end = s.indexOf(']');
                        if (end < 0) return false;
                        const inner = s.slice(1, end);
                        const eqIdx = inner.indexOf('=');
                        if (eqIdx >= 0) {
                            const attrName = inner.slice(0, eqIdx).trim();
                            const attrVal = inner.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
                            if (node.getAttribute(attrName) !== attrVal) return false;
                        } else if (!node.hasAttribute(inner.trim())) {
                            return false;
                        }
                        s = s.slice(end + 1);
                    } else {
                        return false;
                    }
                }
                return true;
            };
            const matchSingle = (node, sel) => {
                const parts = sel.trim().split(/\s+/).filter(Boolean);
                if (!parts.length) return false;
                if (!matchSimple(node, parts[parts.length - 1])) return false;
                let cur = node.parentElement;
                for (let i = parts.length - 2; i >= 0; i -= 1) {
                    while (cur && !matchSimple(cur, parts[i])) cur = cur.parentElement;
                    if (!cur) return false;
                    cur = cur.parentElement;
                }
                return true;
            };
            el.matches = (selList) => selList.split(',').some((s) => matchSingle(el, s));
            el.closest = (selList) => {
                let cur = el;
                while (cur) {
                    if (cur.matches(selList)) return cur;
                    cur = cur.parentElement;
                }
                return null;
            };
            el.querySelectorAll = (selList) => {
                const out = [];
                const walk = (node) => {
                    for (const ch of node.children) {
                        if (ch.matches(selList)) out.push(ch);
                        walk(ch);
                    }
                };
                walk(el);
                return out;
            };
            el.querySelector = (selList) => el.querySelectorAll(selList)[0] || null;
            return el;
        };

        const cols = makeEl('div', { className: 'book-columns' });
        const botBlock = makeEl('div', { className: 'book-char-block' });
        const botHtml = makeEl('div', { className: 'rs-bot-html' });

        // 1) CLAUGEM-style polaroid card with <img>, tape, and footer
        const polaroidWrap = makeEl('div', { className: 'polaroid-wrap', offsetHeight: 280 });
        const polaroidCard = makeEl('div', { className: 'polaroid-card', offsetHeight: 260 });
        const tape = makeEl('div', { className: 'polaroid-tape' });
        const img = makeEl('img', { attrs: { src: '/api/asset/a.webp' }, offsetHeight: 190 });
        const footer = makeEl('div', { className: 'polaroid-footer', text: 'CLAUGEM' });
        polaroidCard.append(tape, img, footer);
        polaroidWrap.append(polaroidCard);

        // Prose & divider inside the same .rs-bot-html
        const hr = makeEl('hr');
        const proseSeg = makeEl('span', { className: 'rs-prose-seg', text: '욕조 가장자리에서 하연이 일어섰다. '.repeat(8) });

        // 2) CSS background-image polaroid card
        const bgWrap = makeEl('div', { className: 'bg-polaroid-wrap', offsetHeight: 240 });
        const bgCard = makeEl('div', { className: 'bg-polaroid-photo', cs: { backgroundImage: 'url("/api/asset/b.webp")' }, offsetHeight: 200 });
        const bgFooter = makeEl('div', { className: 'polaroid-footer', text: 'CLAUGEM' });
        bgWrap.append(bgCard, bgFooter);

        // 3) Tall overflow:hidden prose wrapper
        const tallProseWrap = makeEl('div', {
            className: 'prose-shell',
            text: '긴 본문 텍스트 '.repeat(30),
            offsetHeight: 540,
            scrollHeight: 680,
            cs: { overflow: 'hidden', overflowY: 'hidden', display: 'block' },
        });

        // 4) Oversized polaroid taller than column
        const giantWrap = makeEl('div', { className: 'giant-polaroid', offsetHeight: 620, scrollHeight: 620 });
        const giantImg = makeEl('img', { attrs: { src: '/api/asset/giant.webp' }, offsetHeight: 580 });
        giantWrap.append(giantImg);

        botHtml.append(polaroidWrap, hr, proseSeg, bgWrap, tallProseWrap, giantWrap);
        botBlock.append(botHtml);

        // 5) Tall .book-user-block
        const tallUserBlock = makeEl('div', {
            className: 'book-user-block',
            text: '유저 입력 '.repeat(40),
            offsetHeight: 520,
            scrollHeight: 520,
        });

        cols.append(botBlock, tallUserBlock);

        const ctx = {
            getComputedStyle: (el) => ({ display: 'block', overflow: 'visible', overflowY: 'visible', contain: 'none', flexDirection: 'row', ...(el._cs || {}) }),
        };
        vm.runInNewContext(
            bgFnMatch[0].replace(/function ensureBotAssetRatio$/, '') + '\n' +
            prepFnMatch[0].replace(/function layoutBookSpreads$/, ''),
            ctx
        );

        const colH = 540;
        ctx.prepareBookPaginationBlocks(cols, colH);

        assert.equal(polaroidWrap.getAttribute('data-rs-book-atomic'), '1', 'Polaroid wrapper around <img> + tape + CLAUGEM footer should be atomic');
        assert.equal(botHtml.getAttribute('data-rs-book-atomic'), null, '.rs-bot-html boundary must not be marked atomic');
        assert.equal(proseSeg.getAttribute('data-rs-book-atomic'), null, 'Prose segment must not be marked atomic');
        assert.equal(bgWrap.getAttribute('data-rs-book-atomic'), '1', 'CSS background-image polaroid wrapper should be atomic');
        assert.equal(tallUserBlock.getAttribute('data-rs-book-breakable'), '1', 'Tall .book-user-block must become breakable');
        assert.equal(tallProseWrap.getAttribute('data-rs-book-flow'), '1', 'Tall overflow:hidden prose wrapper must become breakable flow');
        assert.equal(giantWrap.getAttribute('data-rs-book-scaled'), '1', 'Oversized atomic polaroid must be scaled down to fit colH');
        assert.ok(Number(giantWrap.style.zoom) > 0 && Number(giantWrap.style.zoom) < 1, 'Oversized atomic polaroid zoom must be < 1');
    } finally {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        await new Promise((r) => server.close(r));
    }

    const pluginSrc = fs.readFileSync(path.join(REPO, 'risustand.js'), 'utf8');
    assert.ok(pluginSrc.includes('prepareEpubPaginationBlocks'), 'risustand.js must include prepareEpubPaginationBlocks');
    assert.ok(pluginSrc.includes('--epub-col-h'), 'risustand.js must set --epub-col-h');
    assert.ok(!/\bspreadIdx\b/.test(pluginSrc), 'risustand.js must not reference undefined spreadIdx');
});

test('Leave lorebook expands {{user}}/{{char}} in comments & variables and prevents alwaysActive/statusdata cascade bloat', () => {
    const leave = relay.loadBundledLeavePreset();
    const loreEntries = [
        {
            key: '',
            comment: '{{user}}',
            alwaysActive: true,
            insertorder: 200,
            content: 'Member {{user}} travels with {{char}}.',
        },
        {
            key: '',
            comment: 'Quick Ref',
            alwaysActive: true,
            insertorder: 190,
            content: 'Cast: 정현석, 이지원, 천하연.',
        },
        {
            key: '',
            comment: '🖼️ ASSET',
            alwaysActive: true,
            insertorder: 180,
            content: '{{#when::toggle_asset_nsfw::is::1}}NSFW_ASSET_TAG{{/when}}',
        },
        {
            key: '',
            comment: '✈️ TRIP',
            alwaysActive: true,
            insertorder: 170,
            content: 'Plan: {{getvar::trip_plan}}',
        },
        {
            key: '정현석,현석',
            comment: '정현석',
            alwaysActive: false,
            insertorder: 120,
            content: 'Character Sheet: Jeong Hyeonseok (off-scene member).',
        },
        {
            key: '이지원,지원',
            comment: '이지원',
            alwaysActive: false,
            insertorder: 110,
            content: 'Character Sheet: Lee Jiwon.',
        },
        {
            key: '천하연,하연',
            comment: '천하연',
            alwaysActive: false,
            insertorder: 100,
            content: 'Character Sheet: Cheon Hayeon (lives in 천호동).',
        },
        {
            key: '천호동',
            comment: '천호동 장소',
            alwaysActive: false,
            insertorder: 90,
            content: 'Location Detail: 천호동 자매 아파트.',
        },
    ];

    const messages = [
        {
            index: 0,
            role: 'user',
            raw: '지원과 하연과 함께 방에 있었다.',
        },
        {
            index: 1,
            role: 'char',
            raw: '하연이 웃으며 지원의 어깨를 쳤다.\n\n<statusdata>\n📖 Leave HUD · 09:00 · 방\n• 현장: 지원, 하연\n• 장면 밖: 정현석 — 1층 추정\n</statusdata>',
        },
    ];

    const snap = {
        charIndex: 0,
        chatIndex: 0,
        charName: '클로젬 여행동아리',
        chatName: 'Chat 1',
        isPcActive: false,
        chatVariables: { trip_plan: "Follow {{user}}'s lead with {{char}}" },
        useLocallySetGlobalVariables: false,
        globalToggleValues: { toggle_asset_nsfw: '1' },
        localToggleValues: {},
        charContext: {
            name: '클로젬 여행동아리',
            desc: 'Ensemble simulation.',
            personaName: '푸딩',
            personaPrompt: 'Member.',
            loreEntries,
            loreDepth: 10,
            loreTokenBudget: 16000,
            loreRecursive: true,
        },
        messages,
    };

    const built = relay.buildDirectPromptMessages({
        preset: leave,
        snap,
        historyMessages: messages,
        userText: '계속 진행하자.',
        remoteToggleValues: {},
    });

    const staticMsg = built.find((m) => m.role === 'system' && m.content.startsWith('[Static World Lorebook]'));
    const dynamicMsg = built.find((m) => m.role === 'system' && m.content.startsWith('[World / Module Lorebook]'));
    assert.ok(staticMsg, 'Static World Lorebook message must be emitted');
    assert.ok(dynamicMsg, 'World / Module Lorebook message must be emitted');

    // 1) {{user}} & {{char}} expanded in comment header and getvar-returned text
    assert.ok(staticMsg.content.includes('[푸딩]\nMember 푸딩 travels with 클로젬 여행동아리.'), 'alwaysActive comment {{user}} and content must expand');
    assert.ok(dynamicMsg.content.includes("Plan: Follow 푸딩's lead with 클로젬 여행동아리"), 'Variable-returned {{user}} and {{char}} must expand');
    assert.ok(!staticMsg.content.includes('{{user}}') && !dynamicMsg.content.includes('{{user}}'), 'No unexpanded {{user}} may remain in lorebooks');
    assert.ok(!staticMsg.content.includes('{{char}}') && !dynamicMsg.content.includes('{{char}}'), 'No unexpanded {{char}} may remain in lorebooks');

    // 2) Static toggle-gated alwaysActive entry stays cached in [Static World Lorebook]
    assert.ok(staticMsg.content.includes('NSFW_ASSET_TAG'), 'Static global-toggle #when entry must stay in [Static World Lorebook]');
    assert.ok(!dynamicMsg.content.includes('NSFW_ASSET_TAG'), 'Static global-toggle #when entry must not leak into [World / Module Lorebook]');

    // 3) Off-scene 정현석 mentioned only in [Quick Ref] and <statusdata> must NOT activate
    assert.ok(!dynamicMsg.content.includes('Character Sheet: Jeong Hyeonseok'), 'alwaysActive [Quick Ref] and <statusdata> off-scene lines must not trigger off-scene character sheet');

    // 4) On-scene 지원, 하연 and recursive keyword 천호동 DO activate
    assert.ok(dynamicMsg.content.includes('Character Sheet: Lee Jiwon.'), 'On-scene keyword entry 이지원 must activate');
    assert.ok(dynamicMsg.content.includes('Character Sheet: Cheon Hayeon'), 'On-scene keyword entry 천하연 must activate');
    assert.ok(dynamicMsg.content.includes('Location Detail: 천호동 자매 아파트.'), 'Keyword-to-keyword recursive lorebook chain must still activate');
});
