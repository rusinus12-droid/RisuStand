'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

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

        // Web UI HTML escapes single quotes in esc() and has no wildcard CORS
        const html = await requestHttp(port, { path: '/' });
        assert.equal(html.status, 200);
        assert.match(html.body, /&#39;/);
        assert.ok(!fs.readFileSync(path.join(REPO, 'risustand-relay-server.js'), 'utf8').includes("'Access-Control-Allow-Origin': '*'"));
    } finally {
        await new Promise((r) => server.close(r));
    }
});
