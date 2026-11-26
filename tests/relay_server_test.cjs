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

        // Verify scopeBotCss behavior directly
        const fnMatch = scriptMatch[1].match(/function splitCssSelectors[\s\S]*?function sanitizeBotNode/);
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
        for (const marker of ['directPresetCard', 'directPresetSel', 'directPresetUploadBtn', 'directPresetDelBtn', '다른 RisuAI 플러그인은 동작하지 않습니다']) {
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
            { key: '', comment: 'Bot Status Bar', alwaysActive: true, insertorder: 50, content: '@@depth 0\nAlways emit status line: [☀️][7°C][YYYY.MM.DD][AM/PM HH:MM][Location][Action]{{#when::nsfw_mode::is::1}}\nNSFW_ACTIVE{{/when}}' },
            { key: '다인,강다인', comment: '강다인', alwaysActive: false, insertorder: 120, content: 'Character Sheet: 강다인 (음악실 자주 방문).' },
            { key: '음악실', comment: '음악실', alwaysActive: false, insertorder: 110, content: 'Location Detail: 신관 음악실.' },
        ];

        const messages = [
            { index: 0, role: 'user', raw: '방과 후 다인과 음악실로 향했다.' },
            { index: 1, role: 'char', raw: '음악실 문이 열렸다.' },
            { index: 2, role: 'user', raw: '그녀의 손을 잡았다.' },
            { index: 3, role: 'char', raw: '그녀가 고개를 끄덕였다.' },
        ];

        const snap = {
            charIndex: 0,
            chatIndex: 0,
            charName: 'Cheongwon High School',
            chatName: 'Chat 1',
            isPcActive: false,
            chatVariables: { nsfw_mode: '1' },
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
