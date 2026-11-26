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

        // 2) Bundled Leave r1.1 preset metadata, download JSON, and guide HTML
        const meta = await requestHttp(port, { path: '/api/presets/leave', headers: authHdr });
        assert.equal(meta.status, 200);
        const metaJson = JSON.parse(meta.body);
        assert.equal(metaJson.id, 'preset-leave-r1.1');
        assert.ok(metaJson.toggleSyntax.includes('ooc_mode='));
        assert.equal(metaJson.hasGuide, true);

        const dl = await requestHttp(port, { path: '/api/presets/leave/download', headers: authHdr });
        assert.equal(dl.status, 200);
        assert.ok(JSON.parse(dl.body).promptTemplate.length >= 20);

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
        for (const marker of ['edProvider', 'edLoadModelsBtn', 'edModelPick', 'trProvider', 'installBundledLeaveToggle']) {
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
