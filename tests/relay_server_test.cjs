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
        const scopedRoot = scopeCtx.scopeBotCss(':root { --x: 1; }');
        assert.ok(scopedRoot.includes('.rs-bot-html{') || scopedRoot.includes('.rs-bot-html {'));
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
        for (const marker of ['reqLogQuickBtn', 'reqLogModal', 'reqLogCard', 'reqLogList', 'loadRequestLogs', 'openRequestLogDetail']) {
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
