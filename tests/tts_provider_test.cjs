'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
    TTS_ENDPOINT_PRESETS,
    TTS_VOICE_GROUPS,
    TTS_BUILTIN_VOICE_REFERENCES,
    TTS_TONE_TAG_PRESETS,
    normalizeVoiceGroup,
    normalizeVoiceProfiles,
    inferTtsVoiceGroup,
    normalizeTtsEndpointUrl,
    buildTtsChatKey,
    getEffectiveTtsCharacters,
    defaultTtsConfig,
    normalizeTtsConfig,
    sanitizeTtsForClient,
    cleanTextForTts,
    parseSegmentsRuleBased,
    parseScriptDirectorResponse,
    analyzeTtsSegments,
    resolveSegmentVoice,
    formatFishTaggedText,
    listTtsModels,
    createTtsProvider,
} = require('../risustand-tts-provider.cjs');
const { createRelayServer } = require('../risustand-relay-server.js');

const FAKE_MP3 = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00'), Buffer.from('FAKE_MP3_PAYLOAD_DATA')]);
const FAKE_WAV = Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt '), Buffer.from('FAKE_WAV_DATA')]);

async function listenServer(srv) {
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const addr = srv.address();
    return `http://127.0.0.1:${addr.port}`;
}

async function closeServer(srv) {
    if (!srv) return;
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    await new Promise((resolve) => srv.close(() => resolve()));
}

test('tts config normalization and key sanitization', () => {
    const def = defaultTtsConfig();
    assert.equal(def.provider, 'fish_local');
    assert.equal(def.parseMode, 'hybrid');
    assert.equal(def.fishTagStyle, 'brackets');

    const norm = normalizeTtsConfig({
        provider: 'openai_compat_cloud',
        apiKey: 'sk-test-secret-key-1234',
        timeoutMs: 999999,
        narration: { speed: 5.0, toneTag: 'calm' },
        characters: [
            { name: '엘레나', aliases: 'Elena, 그녀', gender: '여성', voiceId: 'ref-elena-1' },
            { name: '', gender: 'male' },
        ],
    });
    assert.equal(norm.provider, 'openai_compat_cloud');
    assert.equal(norm.timeoutMs, 180000);
    assert.equal(norm.narration.speed, 2.0);
    assert.equal(norm.characters.length, 1);
    assert.equal(norm.characters[0].gender, 'female');
    assert.deepEqual(norm.characters[0].aliases, ['Elena', '그녀']);

    const sanitized = sanitizeTtsForClient(norm);
    assert.equal(sanitized.apiKey, undefined);
    assert.equal(sanitized.hasKey, true);
    assert.equal(sanitized.keyPreview, 'sk-t...1234');
});

test('cleanTextForTts strips media/details and preserves italics', () => {
    const raw = '손이 내려갔다. {{inlay::abc123}} <details><summary>상태창</summary>HP 100</details> <i>아, 정말로…</i> "읏—!"';
    const cleaned = cleanTextForTts(raw);
    assert.ok(!cleaned.includes('inlay'));
    assert.ok(!cleaned.includes('상태창'));
    assert.ok(cleaned.includes('손이 내려갔다.'));
    assert.ok(cleaned.includes('아, 정말로…'));
    assert.ok(cleaned.includes('"읏—!"'));
});

test('parseSegmentsRuleBased separates narration, dialogue, inner thought, and guards English contractions', () => {
    const text = [
        '엘레나가 창밖을 바라보며 조용히 말했다.',
        '"I don\'t think it\'s over yet."',
        "'Wait, isn't that Lukas outside?'",
        '루카스가 한숨을 쉬었다.',
        '루카스: "이미 늦었어."',
        '*설마 들킨 건가?*',
    ].join('\n');

    const segs = parseSegmentsRuleBased(text, {
        charName: '엘레나',
        characters: [
            { name: '엘레나', aliases: ['Elena'], gender: 'female', voiceId: 'v-elena' },
            { name: '루카스', aliases: ['Lukas'], gender: 'male', voiceId: 'v-lukas' },
        ],
    });

    assert.equal(segs[0].kind, 'narration');
    assert.equal(segs[1].kind, 'dialogue');
    assert.equal(segs[1].speaker, '엘레나');
    assert.equal(segs[1].gender, 'female');
    assert.equal(segs[1].text, "I don't think it's over yet.");

    assert.equal(segs[2].kind, 'thought');
    assert.equal(segs[2].text, "Wait, isn't that Lukas outside?");
    assert.equal(segs[2].tone, 'whispering');

    assert.equal(segs[3].kind, 'narration');
    assert.equal(segs[4].kind, 'dialogue');
    assert.equal(segs[4].speaker, '루카스');
    assert.equal(segs[4].gender, 'male');
    assert.equal(segs[4].text, '이미 늦었어.');

    assert.equal(segs[5].kind, 'thought');
    assert.equal(segs[5].text, '설마 들킨 건가?');
});

test('parseSegmentsRuleBased splits long text chunks along sentence boundaries', () => {
    const longNarration = Array.from({ length: 10 }, (_, i) => `문장 번호 ${i + 1}이 아주 길게 이어지고 있습니다.`).join(' ');
    const segs = parseSegmentsRuleBased(longNarration, { maxChunkChars: 90 });
    assert.ok(segs.length >= 3);
    for (const s of segs) {
        assert.ok(s.text.length <= 90, `chunk too long: ${s.text.length}`);
        assert.equal(s.kind, 'narration');
    }
});

test('analyzeTtsSegments handles llm, hybrid fallback, and voice resolution', async () => {
    const cfg = normalizeTtsConfig({
        parseMode: 'hybrid',
        narration: { voiceId: 'v-nar', toneTag: 'calm', speed: 0.95 },
        defaultVoices: {
            female: { voiceId: 'v-def-f', thoughtToneTag: 'whispering' },
            male: { voiceId: 'v-def-m', thoughtToneTag: 'whispering' },
        },
        characters: [
            { name: '세라', aliases: ['Sera'], gender: 'female', voiceId: 'v-sera', dialogueToneTag: 'happy', thoughtToneTag: 'nervous' },
        ],
    });

    const llmRes = await analyzeTtsSegments({
        text: '문을 열었다. "안녕!" \'이상하네.\'',
        ttsConfig: cfg,
        callLlm: async () => '```json\n{"segments":[{"kind":"narration","speaker":"Narrator","gender":"neutral","tone":"calm","text":"문을 열었다."},{"kind":"dialogue","speaker":"Sera","gender":"female","tone":"excited","text":"안녕!"},{"kind":"thought","speaker":"낯선 남자","gender":"male","tone":"soft","text":"이상하네."}]}\n```',
    });
    assert.equal(llmRes.modeUsed, 'llm');
    assert.equal(llmRes.segments.length, 3);
    assert.equal(llmRes.segments[0].voiceId, 'v-nar');
    assert.equal(llmRes.segments[1].speaker, '세라');
    assert.equal(llmRes.segments[1].voiceId, 'v-sera');
    assert.deepEqual(llmRes.segments[1].toneTags, ['happy', 'excited']);
    assert.equal(llmRes.segments[2].voiceId, 'v-def-m');
    assert.deepEqual(llmRes.segments[2].toneTags, ['whispering', 'soft']);

    const fallbackRes = await analyzeTtsSegments({
        text: '비가 내렸다. "집에 가자."',
        ttsConfig: cfg,
        callLlm: async () => { throw new Error('LLM offline'); },
    });
    assert.equal(fallbackRes.modeUsed, 'rule_fallback');
    assert.match(fallbackRes.warning, /LLM offline/);
    assert.equal(fallbackRes.segments.length, 2);
});

test('formatFishTaggedText formats S2 brackets, S1 parens, and avoids duplicates', () => {
    assert.equal(formatFishTaggedText('조용히 해.', ['whispering', 'sad'], 'brackets'), '[whispering][sad] 조용히 해.');
    assert.equal(formatFishTaggedText('조용히 해.', ['whispering'], 'parens'), '(whispering) 조용히 해.');
    assert.equal(formatFishTaggedText('[calm] 이미 태그 있음.', ['happy'], 'brackets'), '[calm] 이미 태그 있음.');
    assert.equal(formatFishTaggedText('태그 없음.', ['happy'], 'none'), '태그 없음.');
});

test('createTtsProvider calls Fish and OpenAI-compat servers and caches responses', async () => {
    const requests = [];
    const mockSrv = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            requests.push({ url: req.url, headers: req.headers, body });
            if (req.url === '/v1/tts') {
                res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
                res.end(FAKE_MP3);
                return;
            }
            if (req.url === '/v1/audio/speech') {
                res.writeHead(200, { 'Content-Type': 'audio/wav' });
                res.end(FAKE_WAV);
                return;
            }
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not found' }));
        });
    });

    const baseUrl = await listenServer(mockSrv);
    try {
        const prov = createTtsProvider();

        // 1) Fish local
        const fishCfg = normalizeTtsConfig({
            provider: 'fish_local',
            apiUrl: `${baseUrl}/v1/tts`,
            model: 's2-pro',
            defaultVoices: { female: { voiceId: 'ref-f-1', thoughtToneTag: 'whispering' } },
        });
        const r1 = await prov.synthesizeSegment({ kind: 'thought', speaker: 'NPC', gender: 'female', text: '들키면 안 돼.' }, fishCfg);
        assert.equal(r1.cacheHit, false);
        assert.equal(r1.mime, 'audio/mpeg');
        assert.equal(requests[0].headers.model, 's2-pro');
        assert.equal(requests[0].body.reference_id, 'ref-f-1');
        assert.equal(requests[0].body.text, '[whispering] 들키면 안 돼.');

        // Cache hit on repeat
        const r2 = await prov.synthesizeSegment({ kind: 'thought', speaker: 'NPC', gender: 'female', text: '들키면 안 돼.' }, fishCfg);
        assert.equal(r2.cacheHit, true);
        assert.equal(requests.length, 1);

        // 2) OpenAI compat local
        const oaCfg = normalizeTtsConfig({
            provider: 'openai_compat_local',
            apiUrl: `${baseUrl}/v1/audio/speech`,
            model: 'qwen3-tts',
            format: 'wav',
            narration: { voiceId: 'narrator-ko', instruction: '차분한 톤', speed: 0.92 },
        });
        const r3 = await prov.synthesizeSegment({ kind: 'narration', text: '밤이 깊었다.' }, oaCfg);
        assert.equal(r3.cacheHit, false);
        assert.equal(r3.mime, 'audio/wav');
        assert.equal(requests[1].body.model, 'qwen3-tts');
        assert.equal(requests[1].body.voice, 'narrator-ko');
        assert.equal(requests[1].body.instructions, '차분한 톤');
        assert.equal(requests[1].body.speed, 0.92);

        // 3) Cloud provider missing API key fails cleanly
        await assert.rejects(
            () => prov.synthesizeSegment({ kind: 'dialogue', text: '안녕' }, normalizeTtsConfig({ provider: 'fish_cloud', apiKey: '' })),
            /API 키가 비어 있습니다/
        );
    } finally {
        await closeServer(mockSrv);
    }
});

test('relay server TTS routes, config persistence, and web UI integration', async () => {
    const ttsCalls = [];
    const mockTts = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            ttsCalls.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
            res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
            res.end(FAKE_MP3);
        });
    });
    const mockLlm = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                id: 'chatcmpl-tts-1',
                choices: [{
                    message: {
                        role: 'assistant',
                        content: JSON.stringify({
                            segments: [
                                { kind: 'narration', speaker: 'Narrator', gender: 'neutral', tone: 'calm', text: '방 안이 고요했다.' },
                                { kind: 'dialogue', speaker: '이리스', gender: 'female', tone: 'soft', text: '어서 오세요.' },
                                { kind: 'thought', speaker: '이리스', gender: 'female', tone: 'whispering', text: '기다리고 있었어.' },
                            ],
                        }),
                    },
                }],
            }));
        });
    });

    const ttsUrl = await listenServer(mockTts);
    const llmUrl = await listenServer(mockLlm);
    const token = 'test-tts-token-1234';

    const relay = createRelayServer({
        token,
        configOverride: {
            activeProfileId: 'mock-openai',
            profiles: [{
                id: 'mock-openai',
                name: 'Mock OpenAI',
                providerType: 'openai_compat',
                baseUrl: `${llmUrl}/v1/chat/completions`,
                apiKey: 'sk-local',
                model: 'gpt-mock',
            }],
            tts: {
                provider: 'fish_local',
                apiUrl: `${ttsUrl}/v1/tts`,
                apiKey: 'secret-fish-key-9999',
                parseMode: 'hybrid',
                llmSource: 'active',
                characters: [{ name: '이리스', gender: 'female', voiceId: 'ref-iris' }],
            },
        },
    });
    const relayUrl = await listenServer(relay);

    try {
        // 1) Verify UI HTML and embedded <script> syntax
        const htmlRes = await fetch(`${relayUrl}/`);
        assert.equal(htmlRes.status, 200);
        const html = await htmlRes.text();
        assert.ok(html.includes('turn-tts-btn'));
        assert.ok(html.includes('id="ttsPlayerBar"'));
        assert.ok(html.includes('id="ttsConfigCard"'));
        assert.ok(html.includes('id="ttsEndpointPresetSel"'));
        assert.ok(html.includes('id="ttsDiscoverBtn"'));
        assert.ok(html.includes('id="ttsLoadModelsBtn"'));
        assert.ok(html.includes('id="ttsModelPick"'));
        assert.ok(html.includes('id="ttsVoiceDatalist"'));
        assert.ok(html.includes('id="ttsVoiceProfilesBox"'));
        assert.ok(html.includes('id="ttsNarVoiceGroupSel"'));
        assert.ok(html.includes('id="ttsNarVoiceRefSel"'));
        assert.ok(html.includes('id="ttsNarToneTagSel"'));
        assert.ok(html.includes('id="ttsFemVoiceGroupSel"'));
        assert.ok(html.includes('id="ttsMaleVoiceGroupSel"'));
        assert.ok(html.includes('id="ttsNeuVoiceGroupSel"'));
        assert.ok(html.includes('id="ttsTestBox"'));
        assert.ok(html.includes('id="ttsTestTextInp"'));
        assert.ok(html.includes('id="ttsTestKindSel"'));
        assert.ok(html.includes('id="ttsTestGenderSel"'));
        assert.ok(html.includes('id="ttsTestVoiceGroupSel"'));
        assert.ok(html.includes('id="ttsTestVoiceRefSel"'));
        assert.ok(html.includes('id="ttsTestVoiceInp"'));
        assert.ok(html.includes('id="ttsTestStatus"'));
        assert.ok(html.includes('id="ttsTestAudio"'));
        assert.ok(html.includes('id="ttsCastQuickBtn"'));
        assert.ok(html.includes('id="ttsCastModal"'));
        assert.ok(html.includes('ttscVoiceGroupSel'));
        assert.ok(html.includes('ttscVoiceRefSel'));
        assert.ok(html.includes('ttscDlgTagSel'));
        assert.ok(html.includes('ttscThTagSel'));
        assert.ok(/\.book-tap-zone\s*\{[^}]*pointer-events:\s*none/i.test(html), '.book-tap-zone must not intercept pointer events');
        assert.ok(html.includes('function isInteractiveBookTarget('), 'book view must guard interactive targets in edge zones');
        assert.ok(!html.includes('id="ttsCastScopeSel"'), 'per-character scope selector must not live in global settings');
        assert.ok(!html.includes('id="chatTtsCastCard"'), 'per-character summary card must not live in modules tab');
        const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
        assert.ok(scriptMatch && scriptMatch[1], 'embedded script block must exist');
        assert.doesNotThrow(() => new Function(scriptMatch[1]), 'embedded client JS must parse cleanly');

        // 2) Config GET masks API key & POST preserves key when omitted
        const cfgGet = await fetch(`${relayUrl}/api/router/config`, {
            headers: { 'X-RisuStand-Token': token },
        }).then((r) => r.json());
        assert.equal(cfgGet.tts.apiKey, undefined);
        assert.equal(cfgGet.tts.hasKey, true);
        assert.equal(cfgGet.tts.keyPreview, 'secr...9999');

        const cfgPost = await fetch(`${relayUrl}/api/router/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ tts: { ...cfgGet.tts, format: 'mp3', apiKey: '' } }),
        }).then((r) => r.json());
        assert.equal(cfgPost.tts.hasKey, true);

        // 3) /api/tts/analyze (LLM hybrid)
        const analyzeRes = await fetch(`${relayUrl}/api/tts/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({
                text: '방 안이 고요했다. "어서 오세요." \'기다리고 있었어.\'',
                role: 'char',
                charName: '이리스',
            }),
        }).then((r) => r.json());
        assert.equal(analyzeRes.ok, true);
        assert.equal(analyzeRes.modeUsed, 'llm');
        assert.equal(analyzeRes.segments.length, 3);
        assert.equal(analyzeRes.segments[1].voiceId, 'ref-iris');

        // 4) /api/tts/synthesize (MISS then HIT)
        const synth1 = await fetch(`${relayUrl}/api/tts/synthesize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ segment: analyzeRes.segments[2] }),
        });
        assert.equal(synth1.status, 200);
        assert.equal(synth1.headers.get('x-tts-cache'), 'MISS');
        assert.equal(synth1.headers.get('x-tts-voice'), 'ref-iris');
        const audio1 = Buffer.from(await synth1.arrayBuffer());
        assert.deepEqual(audio1, FAKE_MP3);

        const synth2 = await fetch(`${relayUrl}/api/tts/synthesize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ segment: analyzeRes.segments[2] }),
        });
        assert.equal(synth2.status, 200);
        assert.equal(synth2.headers.get('x-tts-cache'), 'HIT');
        assert.equal(ttsCalls.length, 1);

        // 5) /api/tts/test with ttsOverride
        const testRes = await fetch(`${relayUrl}/api/tts/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({
                text: '테스트입니다.',
                voiceId: 'override-voice-1',
                ttsOverride: { provider: 'fish_local', apiUrl: `${ttsUrl}/v1/tts` },
            }),
        });
        assert.equal(testRes.status, 200);
        assert.equal(testRes.headers.get('x-tts-voice'), 'override-voice-1');
        assert.ok(Number(testRes.headers.get('x-tts-elapsed-ms')) >= 0);
        assert.equal(ttsCalls[1].reference_id, 'override-voice-1');

        // 6) /api/tts/models & /api/tts/discover
        const modelsRes = await fetch(`${relayUrl}/api/tts/models`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ provider: 'fish_local', apiUrl: ttsUrl }),
        }).then((r) => r.json());
        assert.equal(modelsRes.ok, true);
        assert.ok(Array.isArray(modelsRes.models) && modelsRes.models.some((m) => m.id === 's2-pro'));

        const discRes = await fetch(`${relayUrl}/api/tts/discover`, {
            headers: { 'X-RisuStand-Token': token },
        }).then((r) => r.json());
        assert.equal(discRes.ok, true);
        assert.ok(Array.isArray(discRes.presets) && discRes.presets.length >= 5);
        assert.ok(Array.isArray(discRes.servers));

        // 7) Per-chat character voice cast via /api/tts/chat-cast and /api/tts/synthesize
        const castRoomA = await fetch(`${relayUrl}/api/tts/chat-cast`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({
                chatKey: 'charA:r0',
                characters: [{ name: '이리스', gender: 'female', voiceId: 'ref-iris-roomA' }],
            }),
        }).then((r) => r.json());
        assert.equal(castRoomA.tts.chatCharacters['charA:r0'][0].voiceId, 'ref-iris-roomA');

        const castRoomB = await fetch(`${relayUrl}/api/tts/chat-cast`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({
                chatKey: 'charA:r1',
                characters: [{ name: '이리스', gender: 'female', voiceId: 'ref-iris-roomB' }],
            }),
        }).then((r) => r.json());
        assert.equal(castRoomB.tts.chatCharacters['charA:r0'][0].voiceId, 'ref-iris-roomA');
        assert.equal(castRoomB.tts.chatCharacters['charA:r1'][0].voiceId, 'ref-iris-roomB');

        // /api/router/config saving global TTS settings without chatCharacters preserves both rooms
        const globalWithoutChatChars = { ...castRoomB.tts };
        delete globalWithoutChatChars.chatCharacters;
        const afterRouterSave = await fetch(`${relayUrl}/api/router/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ tts: globalWithoutChatChars }),
        }).then((r) => r.json());
        assert.equal(afterRouterSave.tts.chatCharacters['charA:r0'][0].voiceId, 'ref-iris-roomA');
        assert.equal(afterRouterSave.tts.chatCharacters['charA:r1'][0].voiceId, 'ref-iris-roomB');

        const synthRoomA = await fetch(`${relayUrl}/api/tts/synthesize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({
                chatKey: 'charA:r0',
                segment: { kind: 'dialogue', speaker: '이리스', gender: 'female', text: '방 A 대사입니다.' },
            }),
        });
        assert.equal(synthRoomA.status, 200);
        assert.equal(synthRoomA.headers.get('x-tts-voice'), 'ref-iris-roomA');

        const synthRoomB = await fetch(`${relayUrl}/api/tts/synthesize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({
                chatKey: 'charA:r1',
                segment: { kind: 'dialogue', speaker: '이리스', gender: 'female', text: '방 A 대사입니다.' },
            }),
        });
        assert.equal(synthRoomB.status, 200);
        assert.equal(synthRoomB.headers.get('x-tts-voice'), 'ref-iris-roomB');
    } finally {
        await closeServer(relay);
        await closeServer(mockTts);
        await closeServer(mockLlm);
    }
});

test('normalizeTtsEndpointUrl and listTtsModels handle shorthand URLs and Fish/OpenAI servers', async () => {
    assert.ok(TTS_ENDPOINT_PRESETS.some((p) => p.id === 'fish_local_8081'));
    assert.equal(normalizeTtsEndpointUrl('', 'fish_local'), '');
    assert.equal(normalizeTtsEndpointUrl('127.0.0.1:8081', 'fish_local'), 'http://127.0.0.1:8081/v1/tts');
    assert.equal(normalizeTtsEndpointUrl('http://127.0.0.1:8081/v1', 'fish_local'), 'http://127.0.0.1:8081/v1/tts');
    assert.equal(normalizeTtsEndpointUrl('127.0.0.1:8080', 'openai_compat_local'), 'http://127.0.0.1:8080/v1/audio/speech');
    assert.equal(normalizeTtsEndpointUrl('http://127.0.0.1:8080/v1', 'openai_compat_local'), 'http://127.0.0.1:8080/v1/audio/speech');

    const mockSrv = http.createServer((req, res) => {
        if (req.url === '/v1/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
            return;
        }
        if (req.url === '/v1/tts/defaults') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ model_family: 's2', chunk_length: 200 }));
            return;
        }
        if (req.url === '/v1/references/list') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, reference_ids: ['elena-ko', 'lukas-ko'] }));
            return;
        }
        if (req.url === '/v1/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'fish-speech-s2-pro' }, { id: 'kokoro-82m' }] }));
            return;
        }
        if (req.url === '/v1/audio/voices') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ voices: ['af_heart', 'am_adam'] }));
            return;
        }
        res.writeHead(404);
        res.end();
    });

    const baseUrl = await listenServer(mockSrv);
    try {
        const fishModels = await listTtsModels({ provider: 'fish_local', apiUrl: baseUrl });
        assert.equal(fishModels.healthy, true);
        assert.equal(fishModels.detectedFamily, 's2');
        assert.equal(fishModels.resolvedEndpoint, `${baseUrl}/v1/tts`);
        assert.equal(fishModels.models[0].id, 's2-pro');
        assert.deepEqual(fishModels.voices, ['elena-ko', 'lukas-ko']);

        const oaModels = await listTtsModels({ provider: 'openai_compat_local', apiUrl: baseUrl });
        assert.equal(oaModels.healthy, true);
        assert.equal(oaModels.resolvedEndpoint, `${baseUrl}/v1/audio/speech`);
        assert.deepEqual(oaModels.models.map((m) => m.id), ['fish-speech-s2-pro', 'kokoro-82m']);
        assert.deepEqual(oaModels.voices, ['af_heart', 'am_adam']);
    } finally {
        await closeServer(mockSrv);
    }
});

test('per-chat character voice cast overrides global characters by chatKey', async () => {
    const key1 = buildTtsChatKey({ charIndex: 0, chatIndex: 2, charContext: { charId: 'bot-uuid-1' } });
    assert.equal(key1, 'bot-uuid-1:r2');

    const cfg = normalizeTtsConfig({
        parseMode: 'rule',
        characters: [
            { name: '아리아', gender: 'female', voiceId: 'v-aria-global' },
            { name: '카일', gender: 'male', voiceId: 'v-kyle-global' },
        ],
        chatCharacters: {
            'bot-uuid-1:r0': [
                { name: '아리아', gender: 'female', voiceId: 'v-aria-room0', dialogueToneTag: 'happy' },
            ],
            'bot-uuid-1:r1': [
                { name: '아리아', gender: 'male', voiceId: 'v-aria-room1-alt' },
            ],
        },
    });

    const effRoom0 = getEffectiveTtsCharacters(cfg, 'bot-uuid-1:r0');
    assert.equal(effRoom0.length, 2);
    assert.equal(effRoom0[0].voiceId, 'v-aria-room0');
    assert.equal(effRoom0[1].voiceId, 'v-kyle-global');

    const r0 = await analyzeTtsSegments({
        text: '아리아: "안녕!"',
        chatKey: 'bot-uuid-1:r0',
        ttsConfig: cfg,
    });
    assert.equal(r0.segments[0].voiceId, 'v-aria-room0');
    assert.equal(r0.segments[0].gender, 'female');

    const r1 = await analyzeTtsSegments({
        text: '아리아: "안녕!"',
        chatKey: 'bot-uuid-1:r1',
        ttsConfig: cfg,
    });
    assert.equal(r1.segments[0].voiceId, 'v-aria-room1-alt');
    assert.equal(r1.segments[0].gender, 'male');

    const rOther = await analyzeTtsSegments({
        text: '아리아: "안녕!"',
        chatKey: 'bot-uuid-1:r99',
        ttsConfig: cfg,
    });
    assert.equal(rOther.segments[0].voiceId, 'v-aria-global');
});

test('voice profile catalogs, 2-tier group inference, tone tag presets, and /api/tts/voice-profiles routes', async () => {
    assert.deepEqual(TTS_VOICE_GROUPS.map((g) => g.id), ['fish', 'openai_qwen']);
    assert.ok(TTS_BUILTIN_VOICE_REFERENCES.openai_qwen.some((v) => v.id === 'nova'));
    assert.ok(TTS_BUILTIN_VOICE_REFERENCES.openai_qwen.some((v) => v.id === 'Sohee'));
    assert.ok(TTS_TONE_TAG_PRESETS.some((t) => t.value === 'whispering' && t.category === 'delivery'));
    assert.ok(TTS_TONE_TAG_PRESETS.some((t) => t.value === 'calm' && t.category === 'emotion'));

    assert.equal(normalizeVoiceGroup('fish_local'), 'fish');
    assert.equal(normalizeVoiceGroup('openai_compat_local'), 'openai_qwen');

    const profiles = normalizeVoiceProfiles({
        fish: [
            { id: 'ref-sieun-1', label: '시은', gender: '여성' },
            { id: 'ref-sieun-1', label: '중복제거', gender: 'female' },
        ],
        openai_qwen: ['Sohee', { id: 'custom-qwen-1', label: '카일', gender: 'male' }],
    });
    assert.equal(profiles.fish.length, 1);
    assert.equal(profiles.fish[0].gender, 'female');
    assert.equal(profiles.openai_qwen.length, 2);

    assert.equal(inferTtsVoiceGroup('ref-sieun-1', 'openai_compat_cloud', profiles), 'fish');
    assert.equal(inferTtsVoiceGroup('Sohee', 'fish_local', profiles), 'openai_qwen');
    assert.equal(inferTtsVoiceGroup('unknown-id', 'fish_local', profiles), 'fish');

    const cfgWithGroup = normalizeTtsConfig({
        voiceProfiles: profiles,
        characters: [{ name: '시은', gender: 'female', voiceGroup: 'fish', voiceId: 'ref-sieun-1' }],
    });
    assert.equal(cfgWithGroup.characters[0].voiceGroup, 'fish');
    assert.equal(cfgWithGroup.voiceProfiles.fish[0].id, 'ref-sieun-1');

    // HTTP route tests for /api/tts/voice-profiles and /api/tts/models with group separation
    const mockTtsSrv = http.createServer((req, res) => {
        if (req.url === '/v1/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
            return;
        }
        if (req.url === '/v1/tts/defaults') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ model_family: 's2' }));
            return;
        }
        if (req.url === '/v1/references/list') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ reference_ids: ['fish-ref-a', 'fish-ref-b'] }));
            return;
        }
        if (req.url === '/v1/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'qwen3-tts' }] }));
            return;
        }
        if (req.url === '/v1/audio/voices') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ voices: ['Sohee', 'Ryan'] }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    const mockUrl = await listenServer(mockTtsSrv);
    const token = 'test-vp-token-999';
    const relay = createRelayServer({
        token,
        configOverride: {
            tts: {
                provider: 'fish_local',
                apiUrl: `${mockUrl}/v1/tts`,
            },
        },
    });
    const relayUrl = await listenServer(relay);

    try {
        const upFish = await fetch(`${relayUrl}/api/tts/voice-profiles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ action: 'upsert', group: 'fish', item: { id: 'fish-ref-a', label: '시은 Fish', gender: 'female' } }),
        }).then((r) => r.json());
        assert.equal(upFish.tts.voiceProfiles.fish.length, 1);
        assert.equal(upFish.tts.voiceProfiles.fish[0].label, '시은 Fish');

        const upOa = await fetch(`${relayUrl}/api/tts/voice-profiles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ action: 'upsert', group: 'openai_qwen', item: { id: 'Sohee', label: '소희 Qwen', gender: 'female' } }),
        }).then((r) => r.json());
        assert.equal(upOa.tts.voiceProfiles.fish.length, 1);
        assert.equal(upOa.tts.voiceProfiles.openai_qwen.length, 1);

        // Saving global TTS config without voiceProfiles preserves existing voiceProfiles
        const partialTts = { ...upOa.tts };
        delete partialTts.voiceProfiles;
        const afterRouterSave = await fetch(`${relayUrl}/api/router/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ tts: partialTts }),
        }).then((r) => r.json());
        assert.equal(afterRouterSave.tts.voiceProfiles.fish[0].id, 'fish-ref-a');
        assert.equal(afterRouterSave.tts.voiceProfiles.openai_qwen[0].id, 'Sohee');

        // Query /api/tts/models with group='fish' vs group='openai_qwen'
        const fishModelsRes = await fetch(`${relayUrl}/api/tts/models`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ group: 'fish', apiUrl: mockUrl }),
        }).then((r) => r.json());
        assert.equal(fishModelsRes.voiceGroup, 'fish');
        assert.deepEqual(fishModelsRes.voices, ['fish-ref-a', 'fish-ref-b']);
        assert.equal(fishModelsRes.voiceProfiles.fish[0].id, 'fish-ref-a');

        const oaModelsRes = await fetch(`${relayUrl}/api/tts/models`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ group: 'openai_qwen', apiUrl: mockUrl }),
        }).then((r) => r.json());
        assert.equal(oaModelsRes.voiceGroup, 'openai_qwen');
        assert.deepEqual(oaModelsRes.voices, ['Sohee', 'Ryan']);

        // Delete profile from fish group
        const delFish = await fetch(`${relayUrl}/api/tts/voice-profiles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token },
            body: JSON.stringify({ action: 'delete', group: 'fish', id: 'fish-ref-a' }),
        }).then((r) => r.json());
        assert.equal(delFish.tts.voiceProfiles.fish.length, 0);
        assert.equal(delFish.tts.voiceProfiles.openai_qwen.length, 1);
    } finally {
        await closeServer(relay);
        await closeServer(mockTtsSrv);
    }
});
