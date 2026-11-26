'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const { REPO } = require('./helpers.cjs');

async function bootPluginWithMockRisu({ db, characters }) {
    const storage = new Map([
        ['risustand_remote_bridge_v2', JSON.stringify({
            enabled: true,
            relayUrl: 'http://127.0.0.1:8787',
            token: 'test-token',
            includeImages: true,
            pollIntervalMs: 1800,
        })],
    ]);
    const polls = [];
    const queuedCommands = [];
    const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    let unloadCb = null;
    const timers = new Set();

    const trackTimer = (id) => { timers.add(id); return id; };
    const untrackTimer = (id) => { timers.delete(id); clearTimeout(id); clearInterval(id); };

    const risuai = {
        pluginStorage: {
            getItem: async (k) => storage.get(k) ?? null,
            setItem: async (k, v) => { storage.set(k, v); },
        },
        getRootDocument: async () => null,
        changeColorScheme: async () => {},
        changeTextTheme: async () => {},
        setColorScheme: async () => {},
        setCustomTextTheme: async () => {},
        registerButton: async () => {},
        registerSetting: async () => {},
        addRisuChatListener: async () => {},
        removeRisuChatListener: async () => {},
        onUnload: async (fn) => { unloadCb = fn; },
        getDatabase: async (keys) => {
            const out = {};
            for (const k of keys) out[k] = db[k];
            return out;
        },
        setDatabaseLite: async (patch) => { Object.assign(db, patch); },
        getCurrentCharacterIndex: async () => 0,
        getCurrentChatIndex: async () => 0,
        getCharacter: async () => characters[0],
        getCharacterFromIndex: async (i) => characters[i] || null,
        setCharacterToIndex: async (i, c) => { characters[i] = c; },
        getChatFromIndex: async (cIdx, chIdx) => (characters[cIdx] && characters[cIdx].chats[chIdx]) || null,
        setChatToIndex: async (cIdx, chIdx, chatObj) => { characters[cIdx].chats[chIdx] = chatObj; },
        readImage: async (p) => (p === 'assets/eunju_uniform_shy.png' ? pngBytes : null),
        readInlay: async () => null,
        nativeFetch: async (_url, opts) => {
            const body = JSON.parse(opts.body);
            polls.push(body);
            const cmds = queuedCommands.splice(0, queuedCommands.length);
            return {
                ok: true,
                status: 200,
                json: async () => ({ ok: true, relayVersion: '1.0.0', commands: cmds }),
            };
        },
    };

    const context = {
        risuai,
        console,
        crypto,
        btoa: (bin) => Buffer.from(bin, 'binary').toString('base64'),
        Uint8Array,
        ArrayBuffer,
        structuredClone,
        Blob,
        URL,
        setTimeout: (fn, ms) => trackTimer(setTimeout(fn, ms)),
        clearTimeout: (id) => untrackTimer(id),
        setInterval: (fn, ms) => trackTimer(setInterval(fn, ms)),
        clearInterval: (id) => untrackTimer(id),
    };
    context.globalThis = context;

    const src = fs.readFileSync(path.join(REPO, 'risustand.js'), 'utf8');
    vm.runInNewContext(src, context, { filename: 'risustand.js' });

    // Wait briefly for initial pollOnce(true) to finish
    for (let i = 0; i < 40 && polls.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
    }

    const triggerNextPoll = async (cmd) => {
        if (cmd) queuedCommands.push(cmd);
        const before = polls.length;
        // Wait for scheduled poll or command-triggered poll (or wait up to 2.5s)
        for (let i = 0; i < 120 && polls.length === before; i++) {
            await new Promise((r) => setTimeout(r, 25));
        }
    };

    const cleanup = async () => {
        if (unloadCb) await unloadCb();
        for (const id of timers) { clearTimeout(id); clearInterval(id); }
        timers.clear();
    };

    return { polls, queuedCommands, triggerNextPoll, cleanup };
}

test('CBS #when multi-greeting, editdisplay regex, and <img src=...> module asset rendering', async () => {
    const firstMes = [
        '◆▶▶',
        '{{#when::{{equal::{{getvar::first}}::1}}::and::{{equal::{{getvar::lang}}::0}}::and::{{equal::{{getvar::user_role}}::student}}}}',
        '<img src=eunju_uniform_shy>',
        '학생 루트 1번 인사말입니다. 안녕, {{user}}!',
        '{{/when}}',
        '{{#when::{{equal::{{getvar::first}}::2}}::and::{{equal::{{getvar::lang}}::0}}::and::{{equal::{{getvar::user_role}}::student}}}}',
        '학생 루트 2번 인사말입니다. 체육관 장면!',
        '{{/when}}',
        '{{#when::{{equal::{{getvar::first}}::1}}::and::{{equal::{{getvar::lang}}::1}}::and::{{equal::{{getvar::user_role}}::teacher}}}}',
        'Teacher English greeting.',
        '{{/when}}',
    ].join('\n');

    const db = {
        enabledModules: ['cwha-mod'],
        modules: [{
            id: 'cwha-mod',
            name: 'CWHA',
            assets: [['eunju_uniform_shy.png', 'assets/eunju_uniform_shy.png']],
            regex: [],
        }],
        personas: [{ name: '민준', personaPrompt: '' }],
        selectedPersona: 0,
        customscript: [],
        globalChatVariables: {},
        characters: [],
    };

    const characters = [{
        name: 'Cheongwon High School',
        firstMessage: firstMes,
        alternateGreetings: [],
        defaultVariables: '',
        customscript: [
            {
                comment: 'ASSET',
                type: 'editdisplay',
                in: '<img src=([^>]*_(?:uniform|casual)_[^>]+?)>',
                out: '<style>.image-container{}</style><div class="image-container"></div>',
                ableFlag: false,
            },
            {
                comment: 'START-ONLY',
                type: 'editdisplay',
                in: '▶▶',
                out: '<input type="checkbox" style="display:none;">',
                ableFlag: false,
            },
            {
                comment: 'START-SETTING',
                type: 'editdisplay',
                in: '◆',
                out: '<style>.cwhs{}</style><button risu-trigger="setFirst1">시작 1</button>',
                ableFlag: false,
            },
            {
                comment: 'PROSE-TAG',
                type: 'editdisplay',
                in: '\\[\\[STATUS:([^\\]]+)\\]\\]',
                out: '{{#if {{equal::{{getvar::lang}}::0}}}}상태=$1{{:else}}Status=$1{{/if}}',
                ableFlag: false,
            },
        ],
        chats: [{
            name: 'New Chat',
            fmIndex: -1,
            scriptstate: {},
            message: [
                { role: 'char', data: '[[STATUS:교실]] · 계산={{? 2+3}}' },
            ],
        }],
    }];

    const harness = await bootPluginWithMockRisu({ db, characters });
    try {
        assert.ok(harness.polls.length >= 1, 'initial poll must be sent');
        const snap1 = harness.polls[0].snapshot;
        assert.ok(snap1, 'initial snapshot present');

        const fm1 = snap1.messages.find((m) => m.isFirstMessage);
        assert.ok(fm1, 'first message present');
        assert.match(fm1.text, /학생 루트 1번 인사말입니다\. 안녕, 민준!/);
        assert.doesNotMatch(fm1.text, /학생 루트 2번/);
        assert.doesNotMatch(fm1.text, /Teacher English/);
        assert.doesNotMatch(fm1.text, /\{\{#when/);
        assert.doesNotMatch(fm1.text, /[◆▶]/);
        assert.equal(fm1.images.length, 1);
        assert.match(fm1.images[0], /^data:image\/png;base64,/);

        const m0 = snap1.messages.find((m) => m.index === 0);
        assert.equal(m0.text, '상태=교실 · 계산=5');

        assert.deepEqual(snap1.greetingControls, [
            { key: 'first', value: '1', options: ['1', '2'] },
            { key: 'lang', value: '0', options: ['0', '1'] },
            { key: 'user_role', value: 'student', options: ['student', 'teacher'] },
        ]);

        // Switch CBS variable 'first' -> '2' via set_chat_var command
        harness.queuedCommands.push({
            type: 'set_chat_var',
            payload: { charIndex: 0, chatIndex: 0, key: 'first', value: '2' },
        });
        await harness.triggerNextPoll(); // delivers command
        await harness.triggerNextPoll(); // command triggers pollOnce(true)

        assert.equal(characters[0].chats[0].scriptstate.$first, '2');
        const snapWithUpdate = harness.polls.find((p, idx) => idx > 0 && p.snapshot)?.snapshot;
        assert.ok(snapWithUpdate, 'updated snapshot sent after set_chat_var');
        const fm2 = snapWithUpdate.messages.find((m) => m.isFirstMessage);
        assert.match(fm2.text, /학생 루트 2번 인사말입니다/);
        assert.doesNotMatch(fm2.text, /학생 루트 1번/);
    } finally {
        await harness.cleanup();
    }
});

test('native alternateGreetings and set_first_message command switching', async () => {
    const db = {
        enabledModules: [],
        modules: [],
        personas: [{ name: 'User', personaPrompt: '' }],
        selectedPersona: 0,
        customscript: [],
        globalChatVariables: {},
        characters: [],
    };
    const characters = [{
        name: 'MultiGreetingBot',
        firstMessage: '기본 인사말 1',
        alternateGreetings: ['대체 인사말 2', '대체 인사말 3'],
        customscript: [],
        chats: [{ name: 'Chat 1', fmIndex: -1, scriptstate: {}, message: [] }],
    }];

    const harness = await bootPluginWithMockRisu({ db, characters });
    try {
        const snap1 = harness.polls[0].snapshot;
        assert.equal(snap1.firstMessageCount, 3);
        assert.equal(snap1.fmIndex, -1);
        assert.equal(snap1.messages[0].text, '기본 인사말 1');

        harness.queuedCommands.push({
            type: 'set_first_message',
            payload: { charIndex: 0, chatIndex: 0, fmIndex: 1 },
        });
        await harness.triggerNextPoll();
        await harness.triggerNextPoll();

        assert.equal(characters[0].chats[0].fmIndex, 1);
        const snap2 = harness.polls.find((p, idx) => idx > 0 && p.snapshot)?.snapshot;
        assert.ok(snap2);
        assert.equal(snap2.fmIndex, 1);
        assert.equal(snap2.messages[0].text, '대체 인사말 3');
    } finally {
        await harness.cleanup();
    }
});
