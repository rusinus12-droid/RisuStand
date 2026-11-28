'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const { REPO } = require('./helpers.cjs');
const CURRENT_VERSION = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim();

async function bootPluginWithMockRisu({ db, characters, initialStorage, requestPluginPermission, onSendChat, onReadImage, onGetDatabase, onSetDatabaseLite, onReadInlay, rootDoc, getCurrentCharacterIndex, getCurrentChatIndex }) {
    const storage = new Map(initialStorage || [
        ['risustand_perms_prompted_v3', `${CURRENT_VERSION}:${Date.now()}`],
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

    const context = {
        risuai: undefined,
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
    const risuai = {
        pluginStorage: {
            getItem: async (k) => storage.get(k) ?? null,
            setItem: async (k, v) => { storage.set(k, v); },
        },
        getRootDocument: async () => (rootDoc !== undefined ? rootDoc : null),
        changeColorScheme: async () => {},
        changeTextTheme: async () => {},
        setColorScheme: async () => {},
        setCustomTextTheme: async () => {},
        registerButton: async () => {},
        registerSetting: async () => {},
        addRisuChatListener: async () => {},
        removeRisuChatListener: async () => {},
        createMutationObserver: async () => ({ observe: async () => {}, disconnect: async () => {} }),
        onUnload: async (fn) => { unloadCb = fn; },
        getDatabase: async (keys) => {
            if (typeof onGetDatabase === 'function') await onGetDatabase(keys);
            const out = {};
            for (const k of keys) out[k] = db[k];
            return out;
        },
        setDatabaseLite: async (patch) => {
            if (typeof onSetDatabaseLite === 'function') await onSetDatabaseLite(patch);
            Object.assign(db, patch);
        },
        getCurrentCharacterIndex: typeof getCurrentCharacterIndex === 'function' ? getCurrentCharacterIndex : async () => 0,
        getCurrentChatIndex: typeof getCurrentChatIndex === 'function' ? getCurrentChatIndex : async () => 0,
        getCharacter: async () => characters[0],
        getCharacterFromIndex: async (i) => characters[i] || null,
        setCharacterToIndex: async (i, c) => { characters[i] = c; },
        getChatFromIndex: async (cIdx, chIdx) => (characters[cIdx] && characters[cIdx].chats[chIdx]) || null,
        setChatToIndex: async (cIdx, chIdx, chatObj) => { characters[cIdx].chats[chIdx] = chatObj; },
        readImage: async (p) => (typeof onReadImage === 'function' ? onReadImage(p, pngBytes) : (p && p.startsWith('assets/') ? pngBytes : null)),
        readInlay: async (id) => (typeof onReadInlay === 'function' ? onReadInlay(id) : null),
        sendChat: typeof onSendChat === 'function' ? onSendChat : async () => {},
        requestPluginPermission: typeof requestPluginPermission === 'function' ? requestPluginPermission : undefined,
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
    context.risuai = risuai;
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

    return { polls, queuedCommands, storage, triggerNextPoll, cleanup };
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
                out: '{{settempvar::asset_find::{{trim::$1}}.png}}{{settempvar::asset_found::0}}{{#each {{module_assetlist::CWHA}} asset_name}}{{#if {{equal::{{slot::asset_name}}::{{gettempvar::asset_find}}}}}}{{settempvar::asset_found::1}}{{/if}}{{/each}}{{#if {{equal::{{gettempvar::asset_found}}::1}}}}<style>.image-container{color:#fff}</style><div class="image-container" style="background-image: url(\'{{raw::{{gettempvar::asset_find}}}}\');"></div>{{/if}}',
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
        assert.equal(fm1.images[0], '[[RSASSET:a0]]');
        assert.match(fm1.html, /<div class="image-container"/);
        assert.match(fm1.html, /\[\[RSASSET:a0\]\]/);
        assert.match(fm1.html, /<button risu-trigger="setFirst1">시작 1<\/button>/);
        assert.match(snap1.assetMap.a0 || '', /^data:image\/png;base64,/);

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

test('module-bot per-chat & global module toggling, [name,path,ext] asset lookup, and backgroundEmbedding', async () => {
    const db = {
        enabledModules: [],
        modules: [{
            id: 'opm-mod',
            name: 'Onepunman Module',
            namespace: '',
            backgroundEmbedding: '<style>.container { display:grid; }</style>',
            assets: [['BUSHIDRILL_default', 'assets/bushidrill.png', 'jpg']],
            regex: [{
                comment: '에셋출력',
                type: 'editdisplay',
                in: '<img="(.*?)">',
                out: '<div class="container"><img class="roundedImage" src="{{raw::$1}}"></div>',
                ableFlag: false,
            }],
            lorebook: [{
                comment: 'Always Rule',
                key: 'hero',
                alwaysActive: true,
                content: 'Hero Association S-Class ranks.',
            }],
        }],
        personas: [{ name: 'User', personaPrompt: '' }],
        selectedPersona: 0,
        customscript: [],
        globalChatVariables: {},
        characters: [],
    };
    const characters = [{
        name: 'Onepunman',
        firstMessage: '',
        alternateGreetings: [],
        backgroundHTML: '<style>kr-fms-terminal { display:block; }</style>',
        customscript: [],
        chats: [{
            name: 'Chat 1',
            fmIndex: -1,
            modules: [],
            scriptstate: {},
            message: [
                { role: 'char', data: '<kr-fms-terminal>히어로 등장</kr-fms-terminal>\n<img="BUSHIDRILL_default">' },
            ],
        }],
    }];

    const harness = await bootPluginWithMockRisu({ db, characters });
    try {
        const snap0 = harness.polls[0].snapshot;
        assert.equal(snap0.messages[0].images.length, 0);
        assert.match(snap0.backgroundHtml, /kr-fms-terminal/);

        // Enable module for this chat room specifically (scope: 'chat')
        harness.queuedCommands.push({
            type: 'toggle_module',
            payload: { scope: 'chat', charIndex: 0, chatIndex: 0, moduleId: 'opm-mod', enabled: true },
        });
        await harness.triggerNextPoll();
        await harness.triggerNextPoll();

        assert.deepEqual([...characters[0].chats[0].modules], ['opm-mod']);
        const snap1 = harness.polls.find((p, i) => i > 0 && p.snapshot)?.snapshot;
        assert.ok(snap1, 'snapshot regenerated after chat module toggle');
        assert.deepEqual(snap1.chatModules, ['opm-mod']);
        assert.match(snap1.backgroundHtml, /\.container \{ display:grid; \}/);
        assert.match(snap1.charContext.moduleLore, /Hero Association S-Class/);
        assert.equal(snap1.messages[0].images.length, 1);
        assert.match(snap1.messages[0].html, /<kr-fms-terminal>히어로 등장<\/kr-fms-terminal>/);
        assert.match(snap1.messages[0].html, /class="roundedImage" src="\[\[RSASSET:a\d+\]\]"/);
    } finally {
        await harness.cleanup();
    }
});

test('run_trigger Lua VM executes direct triggers and multi-step alertSelect / alertInput replay', async () => {
    const luaCode = [
        'function setFirst3(tid)',
        '  setChatVar(tid, "first", "3")',
        '  reloadDisplay(tid)',
        'end',
        'setRoleToStudent = async(function(tid)',
        '  local opts = { "인문계", "자연계" }',
        '  local sel = alertSelect(tid, opts):await()',
        '  local track = (sel == "1") and "natural" or "humanities"',
        '  local custom = alertInput(tid, "날짜 입력"):await()',
        '  setState(tid, "user_role", "student")',
        '  setChatVar(tid, "user_role", "student")',
        '  setChatVar(tid, "student_track", track)',
        '  setChatVar(tid, "start_date", custom)',
        '  alertNormal(tid, "설정 완료: " .. track .. " / " .. custom)',
        '  reloadDisplay(tid)',
        'end)',
    ].join('\n');

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
        name: 'LuaBot',
        firstMessage: [
            '{{#when::{{equal::{{getvar::first}}::1}}}}FIRST ONE{{/when}}',
            '{{#when::{{equal::{{getvar::first}}::3}}}}FIRST THREE ({{getvar::student_track}}:{{getvar::start_date}}){{/when}}',
        ].join('\n'),
        alternateGreetings: [],
        triggerscript: [{
            comment: '',
            type: 'manual',
            effect: [{ type: 'triggerlua', code: luaCode }],
        }],
        customscript: [],
        chats: [{ name: 'Chat 1', fmIndex: -1, scriptstate: { $first: '1' }, message: [] }],
    }];

    const harness = await bootPluginWithMockRisu({ db, characters });
    try {
        // 1) Simple synchronous Lua trigger
        harness.queuedCommands.push({
            type: 'run_trigger',
            payload: { charIndex: 0, chatIndex: 0, trigger: 'setFirst3', promptAnswers: [] },
        });
        await harness.triggerNextPoll();
        await harness.triggerNextPoll();
        assert.equal(characters[0].chats[0].scriptstate.$first, '3');

        // 2) Step 1 of async multi-prompt trigger: pauses with prompt_select
        harness.queuedCommands.push({
            type: 'run_trigger',
            payload: { charIndex: 0, chatIndex: 0, trigger: 'setRoleToStudent', promptAnswers: [] },
        });
        await harness.triggerNextPoll();
        await harness.triggerNextPoll();
        const pollSelect = harness.polls.find((p) => p.triggerEvent && p.triggerEvent.kind === 'prompt_select');
        assert.ok(pollSelect, 'alertSelect must pause and emit prompt_select triggerEvent');
        assert.deepEqual(pollSelect.triggerEvent.options, ['인문계', '자연계']);

        // 3) Step 2: replay with promptAnswers: ['1'], pauses at alertInput -> prompt_input
        harness.queuedCommands.push({
            type: 'run_trigger',
            payload: { charIndex: 0, chatIndex: 0, trigger: 'setRoleToStudent', promptAnswers: ['1'] },
        });
        await harness.triggerNextPoll();
        await harness.triggerNextPoll();
        const pollInput = harness.polls.find((p) => p.triggerEvent && p.triggerEvent.kind === 'prompt_input');
        assert.ok(pollInput, 'alertInput must pause and emit prompt_input triggerEvent');
        assert.equal(pollInput.triggerEvent.message, '날짜 입력');

        // 4) Step 3: replay with all promptAnswers -> completes and persists scriptstate
        harness.queuedCommands.push({
            type: 'run_trigger',
            payload: { charIndex: 0, chatIndex: 0, trigger: 'setRoleToStudent', promptAnswers: ['1', '2025.03.03'] },
        });
        await harness.triggerNextPoll();
        await harness.triggerNextPoll();
        assert.equal(characters[0].chats[0].scriptstate.$student_track, 'natural');
        assert.equal(characters[0].chats[0].scriptstate.$start_date, '2025.03.03');
        const pollNotice = harness.polls.find((p) => p.triggerEvent && p.triggerEvent.kind === 'notice');
        assert.ok(pollNotice, 'alertNormal emits notice triggerEvent');
        assert.match(pollNotice.triggerEvent.message, /natural \/ 2025\.03\.03/);
        const lastSnap = [...harness.polls].reverse().find((p) => p.snapshot)?.snapshot;
        assert.ok(lastSnap);
        assert.match(lastSnap.messages[0].text, /FIRST THREE \(natural:2025\.03\.03\)/);
    } finally {
        await harness.cleanup();
    }
});

test('upfront permission onboarding prompts mainDom, db, dbWrite, sendChat, inlay once on first install only', async () => {
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
        name: 'Bot',
        firstMessage: 'hi',
        alternateGreetings: [],
        customscript: [],
        chats: [{ name: 'Chat 1', fmIndex: -1, scriptstate: {}, message: [] }],
    }];

    const requestedFirst = [];
    const callOrder = [];
    const h1 = await bootPluginWithMockRisu({
        db,
        characters,
        initialStorage: [],
        onGetDatabase: async (keys) => { callOrder.push(`getDatabase:${(keys || []).join(',')}`); },
        onSetDatabaseLite: async (patch) => { callOrder.push(`setDatabaseLite:${Object.keys(patch || {}).join(',')}`); },
        onReadInlay: async (id) => { callOrder.push(`readInlay:${id}`); return null; },
        requestPluginPermission: async (perm) => {
            requestedFirst.push(perm);
            callOrder.push(`perm:${perm}`);
            return true;
        },
    });
    try {
        await new Promise((r) => setTimeout(r, 80));
        assert.deepEqual(requestedFirst, ['mainDom', 'db', 'dbWrite', 'sendChat', 'inlay']);
        const setLiteIdx = callOrder.indexOf('setDatabaseLite:');
        const getDbIdx = callOrder.indexOf('getDatabase:enabledModules');
        const inlayIdx = callOrder.indexOf('readInlay:__risustand_perm_probe__');
        const firstPermIdx = callOrder.indexOf('perm:mainDom');
        assert.ok(setLiteIdx >= 0 && getDbIdx >= 0 && inlayIdx >= 0 && firstPermIdx > setLiteIdx && firstPermIdx > getDbIdx && firstPermIdx > inlayIdx, `Expected periodic probes before requestPluginPermission, got: ${JSON.stringify(callOrder)}`);
        const savedStamp = String(h1.storage.get('risustand_perms_prompted_v3') || '');
        const escVer = CURRENT_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        assert.match(savedStamp, new RegExp(`^${escVer}:[0-9a-f]+:\\d+$`), `Expected version:sig:ts stamp, got: ${savedStamp}`);

        // Same version + same build sig + within TTL -> must skip re-prompting
        const requestedSecond = [];
        const h2 = await bootPluginWithMockRisu({
            db,
            characters,
            initialStorage: [['risustand_perms_prompted_v3', savedStamp]],
            requestPluginPermission: async (perm) => { requestedSecond.push(perm); return true; },
        });
        try {
            await new Promise((r) => setTimeout(r, 80));
            assert.deepEqual(requestedSecond, []);
        } finally {
            await h2.cleanup();
        }
    } finally {
        await h1.cleanup();
    }

    // Legacy 2-part stamp (version:ts) or stale build sig -> must re-prompt all permissions including dbWrite upfront
    const requestedStale = [];
    const staleCallOrder = [];
    const h3 = await bootPluginWithMockRisu({
        db,
        characters,
        initialStorage: [['risustand_perms_prompted_v3', `${CURRENT_VERSION}:deadbeef:${Date.now()}`]],
        onSetDatabaseLite: async (patch) => { staleCallOrder.push(`setDatabaseLite:${Object.keys(patch || {}).join(',')}`); },
        requestPluginPermission: async (perm) => {
            requestedStale.push(perm);
            staleCallOrder.push(`perm:${perm}`);
            return true;
        },
    });
    try {
        await new Promise((r) => setTimeout(r, 80));
        assert.deepEqual(requestedStale, ['mainDom', 'db', 'dbWrite', 'sendChat', 'inlay']);
        assert.ok(staleCallOrder.includes('setDatabaseLite:'), 'Expected upfront dbWrite probe on script change/reinstall');
    } finally {
        await h3.cleanup();
    }

    // Expired (>3 days) stamp must re-prompt upfront
    const requestedExpired = [];
    const oldTs = Date.now() - Math.floor(3.1 * 24 * 60 * 60 * 1000);
    const h4 = await bootPluginWithMockRisu({
        db,
        characters,
        initialStorage: [['risustand_perms_prompted_v3', `${CURRENT_VERSION}:0:${oldTs}`]],
        requestPluginPermission: async (perm) => { requestedExpired.push(perm); return true; },
    });
    try {
        await new Promise((r) => setTimeout(r, 80));
        assert.deepEqual(requestedExpired, ['mainDom', 'db', 'dbWrite', 'sendChat', 'inlay']);
    } finally {
        await h4.cleanup();
    }
});

test('#each collapses whitespace-only loops over 500 assets and collector holds >30 unique assets', async () => {
    const modAssets = [];
    for (let i = 0; i < 500; i++) {
        modAssets.push([`hero_${i}.png`, `assets/hero_${i}.png`]);
    }
    const manyTags = Array.from({ length: 34 }, (_, i) => `<img src=extra_${i}>`).join('\n');
    for (let i = 0; i < 34; i++) {
        modAssets.push([`extra_${i}.png`, `assets/extra_${i}.png`]);
    }

    const db = {
        enabledModules: ['big-mod'],
        modules: [{ id: 'big-mod', name: 'BIG', namespace: 'BIG', assets: modAssets, regex: [] }],
        personas: [{ name: 'User', personaPrompt: '' }],
        selectedPersona: 0,
        customscript: [],
        globalChatVariables: {},
        characters: [],
    };
    const characters = [{
        name: 'BigBot',
        firstMessage: '시작\n<img src=hero_499>',
        alternateGreetings: [],
        customscript: [{
            comment: 'ASSET',
            type: 'editdisplay',
            in: '<img src=([^>\\s]+)>',
            out: '{{settempvar::f::{{trim::$1}}.png}}{{settempvar::ok::0}}\n{{#each {{module_assetlist::BIG}} a}}\n  {{#if {{equal::{{slot::a}}::{{gettempvar::f}}}}}}\n    {{settempvar::ok::1}}\n  {{/if}}\n{{/each}}\n{{#if {{equal::{{gettempvar::ok}}::1}}}}<div class="image-container" style="background-image:url(\'{{raw::{{gettempvar::f}}}}\')"></div>{{/if}}',
            ableFlag: false,
        }],
        chats: [{
            name: 'Chat 1',
            fmIndex: -1,
            scriptstate: {},
            message: [{ role: 'char', data: '본문\n' + manyTags }],
        }],
    }];

    const harness = await bootPluginWithMockRisu({
        db,
        characters,
        onReadImage: (p, basePng) => {
            if (!p || !p.startsWith('assets/')) return null;
            const copy = new Uint8Array(basePng.length + 2);
            copy.set(basePng, 0);
            const tail = p.split('_')[1] || '0';
            copy[basePng.length] = parseInt(tail, 10) & 0xff;
            copy[basePng.length + 1] = (parseInt(tail, 10) >> 8) & 0xff;
            return copy;
        },
    });
    try {
        const snap = harness.polls[0].snapshot;
        assert.ok(snap);
        const fm = snap.messages[0];
        assert.match(fm.html, /\[\[RSASSET:/);
        const newlineRuns = (fm.html.match(/\n{3,}/g) || []).length;
        assert.equal(newlineRuns, 0, '#each over 500 assets must not emit whitespace explosion');
        assert.ok(fm.html.length < 1500, 'first message HTML stays compact instead of 500 blank lines');
        const m0 = snap.messages[1];
        assert.equal(m0.images.length, 34, 'collector must hold >28 unique assets across messages');
        assert.equal(Object.keys(snap.assetMap).length, 35);
    } finally {
        await harness.cleanup();
    }
});

test('reroll_message, replace_message_with_swipe, swipe_message rollback, and delete_message cleanup', async () => {
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
        chaId: 'reroll-char',
        name: 'RerollBot',
        firstMessage: '첫 인사',
        alternateGreetings: [],
        customscript: [],
        chats: [{
            id: 'chat-a',
            name: 'Chat 1',
            fmIndex: -1,
            scriptstate: {},
            message: [
                { role: 'user', data: '안녕' },
                { role: 'char', data: '첫 번째 응답' },
            ],
        }],
    }];

    let sendChatCount = 0;
    const harness = await bootPluginWithMockRisu({
        db,
        characters,
        onSendChat: async (txt) => {
            assert.equal(txt, '');
            sendChatCount += 1;
            characters[0].chats[0].message.push({ role: 'char', data: `리롤 응답 v${sendChatCount}` });
        },
    });

    try {
        // 1) Reroll latest char message (idx 1)
        harness.queuedCommands.push({
            type: 'reroll_message',
            payload: { charIndex: 0, chatIndex: 0, msgIndex: 1 },
        });
        await harness.triggerNextPoll();
        await harness.triggerNextPoll();

        assert.equal(sendChatCount, 1);
        assert.equal(characters[0].chats[0].message[1].data, '리롤 응답 v1');
        let lastSnap = [...harness.polls].reverse().find((p) => p.snapshot)?.snapshot;
        let m1 = lastSnap.messages.find((m) => m.index === 1);
        assert.equal(m1.swipeCount, 2);
        assert.equal(m1.swipeIndex, 1);

        // 2) Swipe back (delta -1 -> rollback to '첫 번째 응답')
        harness.queuedCommands.push({
            type: 'swipe_message',
            payload: { charIndex: 0, chatIndex: 0, msgIndex: 1, delta: -1 },
        });
        await harness.triggerNextPoll();
        await harness.triggerNextPoll();
        assert.equal(characters[0].chats[0].message[1].data, '첫 번째 응답');
        lastSnap = [...harness.polls].reverse().find((p) => p.snapshot)?.snapshot;
        m1 = lastSnap.messages.find((m) => m.index === 1);
        assert.equal(m1.swipeIndex, 0);

        // 3) Replace via direct router swipe (adds v3)
        harness.queuedCommands.push({
            type: 'replace_message_with_swipe',
            payload: { charIndex: 0, chatIndex: 0, msgIndex: 1, newData: '직접 라우팅 응답' },
        });
        await harness.triggerNextPoll();
        await harness.triggerNextPoll();
        assert.equal(characters[0].chats[0].message[1].data, '직접 라우팅 응답');
        lastSnap = [...harness.polls].reverse().find((p) => p.snapshot)?.snapshot;
        m1 = lastSnap.messages.find((m) => m.index === 1);
        assert.equal(m1.swipeCount, 3);
        assert.equal(m1.swipeIndex, 2);

        // 4) Delete message cleans up swipe history for that index
        harness.queuedCommands.push({
            type: 'delete_message',
            payload: { charIndex: 0, chatIndex: 0, msgIndex: 1 },
        });
        await harness.triggerNextPoll();
        await harness.triggerNextPoll();
        assert.equal(characters[0].chats[0].message.length, 1);
        const swStored = JSON.parse(harness.storage.get('risustand_swipe_history_v1'));
        assert.equal(swStored['reroll-char:chat-a:1'], undefined);
    } finally {
        await harness.cleanup();
    }
});

test('Lua trigger require("json") and isolated module script execution', async () => {
    const db = {
        modules: [
            {
                id: 'mod-broken',
                name: 'BrokenRequireMod',
                namespace: 'broken',
                trigger: [
                    {
                        type: 'manual',
                        effect: [{
                            type: 'triggerlua',
                            code: [
                                'local json = require("json")',
                                'local unknown = require("some_external_lib")',
                                'local encoded = json.encode({ ok = true })',
                                'local decoded = json.decode(encoded)',
                                'if not decoded.ok then error("json decode failed") end',
                                'error("unrelated module init failure")',
                            ].join('\n'),
                        }],
                    },
                ],
            },
            {
                id: 'mod-json',
                name: 'JsonHelperMod',
                namespace: 'jsonhelper',
                trigger: [
                    {
                        type: 'manual',
                        effect: [{
                            type: 'triggerlua',
                            code: [
                                'local json = require("json")',
                                'function checkJsonTrigger(id)',
                                '  local tbl = json.decode(\'{"val":42}\')',
                                '  setChatVar(id, "json_out", json.encode({ doubled = tbl.val * 2 }))',
                                'end',
                            ].join('\n'),
                        }],
                    },
                ],
            },
        ],
        enabledModules: ['mod-broken', 'mod-json'],
        personas: [{ name: 'Tester', personaPrompt: '' }],
        selectedPersona: 0,
    };
    const characters = [{
        chaId: 'char-lua-iso',
        name: 'LuaIsoBot',
        firstMessage: 'hi',
        alternateGreetings: [],
        customscript: [],
        triggerscript: [
            {
                type: 'manual',
                effect: [{
                    type: 'triggerlua',
                    code: [
                        'local json = require("json")',
                        'function charAction(id)',
                        '  local d = json.decode(\'{"step":3}\')',
                        '  setChatVar(id, "char_res", "step-" .. tostring(d.step))',
                        'end',
                    ].join('\n'),
                }],
            },
        ],
        chats: [{
            id: 'chat-iso',
            name: 'Chat 1',
            fmIndex: -1,
            scriptstate: {},
            message: [],
        }],
    }];

    const harness = await bootPluginWithMockRisu({ db, characters });
    try {
        // 1) Character trigger succeeds even though mod-broken throws a top-level Lua error
        harness.queuedCommands.push({
            type: 'run_trigger',
            payload: { charIndex: 0, chatIndex: 0, trigger: 'charAction', promptAnswers: [] },
        });
        await harness.triggerNextPoll();
        await harness.triggerNextPoll();
        assert.equal(characters[0].chats[0].scriptstate.$char_res, 'step-3');

        // 2) Module trigger using require("json") works too, still unblocked by mod-broken
        harness.queuedCommands.push({
            type: 'run_trigger',
            payload: { charIndex: 0, chatIndex: 0, trigger: 'checkJsonTrigger', promptAnswers: [] },
        });
        await harness.triggerNextPoll();
        await harness.triggerNextPoll();
        const parsed = JSON.parse(characters[0].chats[0].scriptstate.$json_out);
        assert.equal(parsed.doubled, 84);
    } finally {
        await harness.cleanup();
    }
});

test('Relay server includes book page jump UI and valid client script', async () => {
    const http = require('node:http');
    const relay = require(path.join(REPO, 'risustand-relay-server.js'));
    const server = relay.createRelayServer({
        token: 'test-jump-token',
        configOverride: { activeProfileId: '', remoteDirectOnly: false },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
        const body = await new Promise((resolve, reject) => {
            http.get({ hostname: '127.0.0.1', port, path: '/' }, (res) => {
                let buf = '';
                res.on('data', (c) => { buf += c; });
                res.on('end', () => resolve(buf));
            }).on('error', reject);
        });
        assert.ok(body.includes('bookPageJumpBtn'), 'Expected bookPageJumpBtn in relay HTML');
        assert.ok(body.includes('bookJumpBar'), 'Expected bookJumpBar in relay HTML');
        assert.ok(body.includes('RisuAI에 응답을 요청 중...'), 'Expected busy placeholder in relay HTML');
        const scriptMatch = body.match(/<script>([\s\S]*?)<\/script>/);
        assert.ok(scriptMatch, 'Expected inline <script> in rendered HTML');
        new vm.Script(scriptMatch[1], { filename: 'relay-client-inline.js' });

        const reqJson = (method, p, payload) => new Promise((resolve, reject) => {
            const raw = payload ? JSON.stringify(payload) : '';
            const req = http.request({
                hostname: '127.0.0.1', port, path: p, method,
                headers: {
                    'X-RisuStand-Token': 'test-jump-token',
                    ...(raw ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : {}),
                },
            }, (res) => {
                let buf = '';
                res.on('data', (c) => { buf += c; });
                res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') }));
            });
            req.on('error', reject);
            if (raw) req.write(raw);
            req.end();
        });

        // Establish active PC snapshot
        await reqJson('POST', '/api/pc/poll', {
            bridgeVersion: '2.0.0', generating: false, supportsBatchCommands: true,
            snapshot: { charIndex: 0, chatIndex: 0, isPcActive: true, messages: [{ index: 0, role: 'user', text: 'hello' }] },
        });
        // Empty retry send succeeds and sets generating: true until PC poll completes post-dispatch
        const sendRes = await reqJson('POST', '/api/chat/send', { charIndex: 0, chatIndex: 0, text: '' });
        assert.equal(sendRes.status, 200);
        assert.equal(sendRes.json.mode, 'native_risu');
        const stBefore = await reqJson('GET', '/api/state');
        assert.equal(stBefore.json.generating, true);

        // PC picks up command
        const poll1 = await reqJson('POST', '/api/pc/poll', { bridgeVersion: '2.0.0', generating: false, supportsBatchCommands: true });
        assert.equal(poll1.json.commands[0].type, 'send_chat');
        assert.equal(poll1.json.commands[0].payload.text, '');
        const stWhile = await reqJson('GET', '/api/state');
        assert.equal(stWhile.json.generating, true);

        // PC reports generating finished -> relay clears generating
        await reqJson('POST', '/api/pc/poll', { bridgeVersion: '2.0.0', generating: false, supportsBatchCommands: true });
        const stDone = await reqJson('GET', '/api/state');
        assert.equal(stDone.json.generating, false);
    } finally {
        await new Promise((r) => server.close(r));
    }
});

test('empty send_chat command triggers risuai.sendChat("") retry in plugin', async () => {
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
        chaId: 'retry-char',
        name: 'RetryBot',
        firstMessage: 'hi',
        alternateGreetings: [],
        customscript: [],
        chats: [{
            id: 'c-retry',
            name: 'Chat 1',
            fmIndex: -1,
            scriptstate: {},
            message: [{ role: 'user', data: '유나를 상담실에 불렀다.' }],
        }],
    }];
    const sent = [];
    const harness = await bootPluginWithMockRisu({
        db,
        characters,
        onSendChat: async (txt) => { sent.push(txt); },
    });
    try {
        harness.queuedCommands.push({
            type: 'send_chat',
            payload: { charIndex: 0, chatIndex: 0, text: '' },
        });
        await harness.triggerNextPoll();
        await harness.triggerNextPoll();
        assert.deepEqual(sent, ['']);
    } finally {
        await harness.cleanup();
    }
});

test('Leave preset display compat renders <statusdata> HUD card, <ooc>, and respects toggle_state_tracker & toggle_thought_display', async () => {
    const db = {
        enabledModules: [{
            id: 'mod-hud-tog',
            name: 'HudModule',
            customModuleToggle: 'hud_mode=상태창=select=켜짐,꺼짐',
            regex: [],
            lorebook: [],
        }],
        modules: [],
        personas: [{ name: 'User', personaPrompt: '' }],
        selectedPersona: 0,
        customscript: [],
        globalChatVariables: { toggle_thought_display: '0' },
        characters: [],
    };
    db.modules = db.enabledModules;
    db.enabledModules = ['mod-hud-tog'];
    const bigScriptState = {};
    for (let i = 0; i < 55; i += 1) bigScriptState[`$var_${i}`] = `val_${i}`;
    const characters = [{
        chaId: 'leave-compat-char',
        name: 'LeaveBot',
        firstMessage: '첫 장면',
        alternateGreetings: [],
        customscript: [],
        chats: [{
            id: 'c-leave',
            name: 'Chat 1',
            fmIndex: -1,
            scriptstate: bigScriptState,
            message: [
                {
                    role: 'char',
                    data: '<thinking>숨길 생각</thinking>\n<statusdata>\n📖 Leave HUD · 2025.03.03 PM 06:37 · 음악실\n• 현장: 강다인\n</statusdata>\n<statusdata>HP: 100</statusdata>\n<statusdata><details><summary>HUD</summary>상태창</details></statusdata>\n<ooc>사서 리브 응답</ooc>\n{{#when::hud_mode::tis::0}}HUD_TOG_DEFAULT{{/when}}\n본문 서사입니다.',
                },
            ],
        }],
    }];
    const harness = await bootPluginWithMockRisu({ db, characters });
    try {
        // Case 1: default state_tracker ('0') -> Leave HUD cards rendered cleanly, text-only cleanProse excludes HUD
        let snap = [...harness.polls].reverse().find((p) => p.snapshot)?.snapshot;
        let msg = snap.messages.find((m) => m.index === 0);
        assert.ok(msg.html.includes('leave-ooc-card'));
        assert.ok(msg.html.includes('사서 리브 응답'));
        assert.ok(msg.html.includes('<details class="leave-hud-card"><summary>📖 Leave HUD · 2025.03.03 PM 06:37 · 음악실</summary><div class="leave-hud-body">• 현장: 강다인</div></details>'));
        assert.ok(msg.html.includes('<details class="leave-hud-card"><summary>📖 Leave HUD</summary><div class="leave-hud-body">HP: 100</div></details>'));
        assert.ok(msg.html.includes('<details><summary>HUD</summary>상태창</details>'));
        assert.ok(!msg.html.includes('숨길 생각'));
        assert.ok(!msg.html.includes('leave-thought-box'));
        assert.ok(msg.html.includes('HUD_TOG_DEFAULT'), 'Untouched module toggle defaults to 0 in evalCBS');
        assert.ok(!msg.text.includes('현장: 강다인'), 'cleanProse should strip leave-hud-card from plain text');
        assert.ok(!msg.text.includes('HP: 100'));
        assert.ok(Object.keys(snap.chatVariables).length >= 55 && snap.chatVariables.var_54 === 'val_54', 'All >40 chatVariables must be preserved');

        // Case 2: toggle_thought_display = '1' & toggle_state_tracker = '2' -> thoughts shown, text-only <statusdata> hidden
        db.globalChatVariables.toggle_thought_display = '1';
        db.globalChatVariables.toggle_state_tracker = '2';
        await harness.triggerNextPoll({ type: 'sync_chat', payload: {} });
        await harness.triggerNextPoll();
        snap = [...harness.polls].reverse().find((p) => p.snapshot)?.snapshot;
        msg = snap.messages.find((m) => m.index === 0);
        assert.ok(msg.html.includes('<details class="leave-thought-box">'));
        assert.ok(msg.html.includes('숨길 생각'));
        assert.ok(!msg.html.includes('leave-hud-card'));
        assert.ok(!msg.html.includes('HP: 100'));
        assert.ok(msg.html.includes('<details><summary>HUD</summary>상태창</details>'));
        assert.ok(!msg.text.includes('숨길 생각'));
        assert.ok(msg.text.includes('본문 서사입니다.'));
    } finally {
        await harness.cleanup();
    }
});

test('buildSnapshot emits botWidgetHtml when chat exceeds 36 messages and firstMessage holds fixed bot menu', async () => {
    const db = {
        enabledModules: [],
        modules: [],
        personas: [{ name: 'User', personaPrompt: '' }],
        selectedPersona: 0,
        customscript: [],
        globalChatVariables: {},
        characters: [],
    };
    const menuHtml = '<style>.buttons-container{position:fixed;right:12px;top:90px;display:flex;}</style>' +
        '<div class="buttons-container"><label for="m_tog">메뉴</label></div>' +
        '<input type="checkbox" id="m_tog">' +
        '<div class="side-panel">상태창 패널</div>';
    const manyMsgs = [];
    for (let i = 0; i < 40; i++) {
        manyMsgs.push({ role: i % 2 === 0 ? 'user' : 'char', data: `turn ${i}` });
    }
    const characters = [{
        chaId: 'long-chat-menu-char',
        name: 'MenuBot',
        firstMessage: `${menuHtml}\n첫 장면 본문`,
        alternateGreetings: [],
        customscript: [],
        chats: [{
            id: 'c-long-40',
            name: 'Chat Long',
            fmIndex: -1,
            scriptstate: {},
            message: manyMsgs,
        }],
    }];
    const harness = await bootPluginWithMockRisu({ db, characters });
    try {
        const snap = [...harness.polls].reverse().find((p) => p.snapshot)?.snapshot;
        assert.ok(snap);
        assert.equal(snap.messages.length, 36);
        assert.ok(snap.messages.every((m) => !m.isFirstMessage));
        assert.ok(snap.botWidgetHtml.includes('buttons-container'));
        assert.ok(snap.botWidgetHtml.includes('side-panel'));
    } finally {
        await harness.cleanup();
    }
});

test('buildSnapshot emits full loreEntries (beyond 6000 chars), localLore, replaceGlobalNote, depthPrompt, and memory', async () => {
    const bigBlockA = 'A'.repeat(3200);
    const bigBlockB = 'B'.repeat(3200);
    const db = {
        enabledModules: ['mod-hud'],
        modules: [{
            id: 'mod-hud',
            name: 'StatusHudMod',
            lorebook: [
                { key: '', comment: 'Folder Header', mode: 'folder', content: 'ignored' },
                { key: '', comment: 'Module StatusRule', alwaysActive: true, insertorder: 50, content: '@@depth 0\nEmit status bar [DATE]' },
            ],
        }],
        personas: [{ name: 'Puding', personaPrompt: 'Student' }],
        selectedPersona: 0,
        customscript: [],
        globalChatVariables: {},
        characters: [],
    };
    const characters = [{
        chaId: 'cheongwon-test',
        name: 'Cheongwon High School',
        firstMessage: 'Start',
        alternateGreetings: [],
        customscript: [],
        replaceGlobalNote: 'CARD_GLOBAL_NOTE {{original}}',
        depth_prompt: { depth: 1, prompt: 'Card depth prompt reminder.' },
        loreSettings: { scanDepth: 12, tokenBudget: 24000, recursiveScanning: true },
        globalLore: [
            { key: '', comment: 'L1 Big', alwaysActive: true, insertorder: 100, content: bigBlockA },
            { key: '', comment: 'L2 Big', alwaysActive: true, insertorder: 90, content: bigBlockB },
            { key: '다인,강다인', comment: 'Kang Dain', alwaysActive: false, insertorder: 80, content: 'Kang Dain profile sheet.' },
        ],
        chats: [{
            id: 'c-cw',
            name: 'Chat 1',
            fmIndex: -1,
            supaMemoryData: 'Past memory summary of Music Room.',
            scriptstate: {},
            localLore: [
                { key: '음악실', comment: 'Music Room Note', alwaysActive: false, insertorder: 70, content: 'Local music room detail.' },
            ],
            message: [
                { role: 'char', data: '다인이 음악실 피아노 옆에 서 있다.' },
                { role: 'user', data: '짧은 행동 입력.' },
            ],
        }],
    }];
    const harness = await bootPluginWithMockRisu({ db, characters });
    try {
        const snap = [...harness.polls].reverse().find((p) => p.snapshot)?.snapshot;
        assert.ok(snap && snap.charContext);
        assert.equal(snap.charContext.replaceGlobalNote, 'CARD_GLOBAL_NOTE {{original}}');
        assert.deepEqual(snap.charContext.depthPrompt, { depth: 1, prompt: 'Card depth prompt reminder.' });
        assert.equal(snap.charContext.memory, 'Past memory summary of Music Room.');
        assert.equal(snap.charContext.loreDepth, 12);
        assert.equal(snap.charContext.loreTokenBudget, 24000);
        // Folder skipped -> 5 valid entries remain (module + 3 global + 1 local)
        assert.equal(snap.charContext.loreEntries.length, 5);
        assert.equal(snap.charContext.charId, 'cheongwon-test');
        assert.ok(snap.charContext.loreEntries.every((e) => typeof e.uid === 'string' && e.uid.includes(':') && e.source && e.sourceName));
        assert.ok(snap.charContext.moduleLore.includes('Kang Dain profile sheet.'), 'fallback summary must not drop entries after 6000 chars');
        assert.ok(snap.charContext.moduleLore.includes('Local music room detail.'));

        // set_author_note and set_char_global_note commands persist to RisuAI DB and refresh snapshot
        await harness.triggerNextPoll({ type: 'set_author_note', payload: { charIndex: 0, chatIndex: 0, note: 'Focus on emotional pacing.' } });
        await harness.triggerNextPoll({ type: 'set_char_global_note', payload: { charIndex: 0, replaceGlobalNote: 'UPDATED_GN {{original}}' } });
        await new Promise((r) => setTimeout(r, 80));
        await harness.triggerNextPoll();
        const snapAfter = [...harness.polls].reverse().find((p) => p.snapshot)?.snapshot;
        assert.ok(snapAfter);
        assert.equal(snapAfter.charContext.note, 'Focus on emotional pacing.');
        assert.equal(snapAfter.charContext.replaceGlobalNote, 'UPDATED_GN {{original}}');
        assert.equal(characters[0].chats[0].note, 'Focus on emotional pacing.');
        assert.equal(characters[0].replaceGlobalNote, 'UPDATED_GN {{original}}');
    } finally {
        await harness.cleanup();
    }
});

test('buildSnapshot preserves firstMessage <style> blocks into backgroundHtml when chat exceeds 36 messages', async () => {
    const db = {
        enabledModules: [],
        modules: [],
        personas: [{ name: 'User', personaPrompt: '' }],
        selectedPersona: 0,
        customscript: [],
        globalChatVariables: {},
        characters: [],
    };
    const manyMsgs = [];
    for (let i = 0; i < 40; i++) {
        manyMsgs.push({ role: i % 2 === 0 ? 'user' : 'char', data: `turn ${i}` });
    }
    const characters = [{
        chaId: 'long-chat-style-char',
        name: 'StyleBot',
        firstMessage: '<style>.cg-card{display:flex}</style>\n프롤로그 본문',
        alternateGreetings: [],
        customscript: [],
        chats: [{
            id: 'c-style-40',
            name: 'Chat Long Style',
            fmIndex: -1,
            scriptstate: {},
            message: manyMsgs,
        }],
    }];
    const harness = await bootPluginWithMockRisu({ db, characters });
    try {
        const snap = [...harness.polls].reverse().find((p) => p.snapshot)?.snapshot;
        assert.ok(snap);
        assert.equal(snap.messages.length, 36);
        assert.ok(snap.backgroundHtml.includes('.cg-card{display:flex}'));
    } finally {
        await harness.cleanup();
    }
});

test('buildSnapshot resolves >2.5MB and older-turn assets via pcpath:, and {{raw::}}/{{path::}} never emit <img>', async () => {
    const modAssets = [
        ['big_portrait.png', 'assets/big_portrait.png'],
        ['small_icon.png', 'assets/small_icon.png'],
        ['older_only.png', 'assets/older_only.png'],
    ];
    const db = {
        enabledModules: ['asset-edge-mod'],
        modules: [{ id: 'asset-edge-mod', name: 'AEM', namespace: 'AEM', assets: modAssets, regex: [] }],
        personas: [{ name: 'User', personaPrompt: '' }],
        selectedPersona: 0,
        customscript: [],
        globalChatVariables: {},
        characters: [],
    };
    const msgs = [
        { role: 'char', data: '<img src="older_only.png">' },
    ];
    for (let i = 1; i < 11; i++) {
        msgs.push({ role: i % 2 === 1 ? 'user' : 'char', data: `turn ${i}` });
    }
    msgs.push({
        role: 'char',
        data: '<div style="background-image:url(\'{{raw::big_portrait}}\')"></div>\n{{raw::small_icon}}\n{{path::big_portrait}}',
    });
    const characters = [{
        chaId: 'asset-edge-char',
        name: 'AssetEdgeBot',
        firstMessage: '',
        alternateGreetings: [],
        customscript: [],
        chats: [{
            id: 'c-edge',
            name: 'Chat Edge',
            fmIndex: -1,
            scriptstate: {},
            message: msgs,
        }],
    }];
    const bigBuf = new Uint8Array(3 * 1024 * 1024);
    bigBuf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);

    const harness = await bootPluginWithMockRisu({
        db,
        characters,
        onReadImage: (p, basePng) => {
            if (p === 'assets/big_portrait.png') return bigBuf;
            if (p === 'assets/small_icon.png' || p === 'assets/older_only.png') return basePng;
            return null;
        },
    });
    try {
        const snap = [...harness.polls].reverse().find((p) => p.snapshot)?.snapshot;
        assert.ok(snap);
        const mapVals = Object.values(snap.assetMap);
        assert.ok(mapVals.includes('pcpath:assets/big_portrait.png'), '>2.5MB asset must fall back to pcpath:');
        assert.ok(mapVals.includes('pcpath:assets/older_only.png'), 'older-turn asset must resolve via lazyView pcpath:');
        assert.ok(mapVals.some((v) => v.startsWith('data:image/png;base64,')), 'small recent asset remains inline data URI');

        const m0 = snap.messages.find((m) => m.index === 0);
        assert.equal(m0.images.length, 1, 'older message keeps image token');
        assert.equal(snap.assetMap[m0.images[0].slice(10, -2)], 'pcpath:assets/older_only.png');

        const mLast = snap.messages[snap.messages.length - 1];
        assert.ok(!mLast.html.includes('<img class="msg-img"'), '{{raw::}} and {{path::}} must never emit <img> tags');
    } finally {
        await harness.cleanup();
    }
});

test('editdisplay regexes sort by <move_top>, descending <order N>, and <move_bottom>', async () => {
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
        chaId: 'order-char',
        name: 'OrderBot',
        firstMessage: '',
        alternateGreetings: [],
        customscript: [
            { comment: 'bottom', type: 'editdisplay', in: '\\[TAG\\]', out: '[TAG]|bottom', ableFlag: true, flag: '<move_bottom><order 999>' },
            { comment: 'low', type: 'editdisplay', in: '\\[TAG\\]', out: '[TAG]|order1', ableFlag: true, flag: '<order 1>' },
            { comment: 'high', type: 'editdisplay', in: '\\[TAG\\]', out: '[TAG]|order10', ableFlag: true, flag: '<order 10>' },
            { comment: 'top', type: 'editdisplay', in: '\\[TAG\\]', out: '[TAG]|top', ableFlag: true, flag: '<move_top>' },
        ],
        chats: [{
            id: 'c-ord',
            name: 'Order Chat',
            fmIndex: -1,
            scriptstate: {},
            message: [{ role: 'char', data: '[TAG]' }],
        }],
    }];
    const harness = await bootPluginWithMockRisu({ db, characters });
    try {
        const snap = [...harness.polls].reverse().find((p) => p.snapshot)?.snapshot;
        assert.ok(snap);
        // Execution order: top -> order10 -> order1 -> bottom
        // Each step replaces [TAG] with [TAG]|<label>, so the resulting suffix order is:
        // top: [TAG]|top -> order10: [TAG]|order10|top -> order1: [TAG]|order1|order10|top -> bottom: [TAG]|bottom|order1|order10|top
        assert.equal(snap.messages[0].text, '[TAG]|bottom|order1|order10|top');
    } finally {
        await harness.cleanup();
    }
});

test('PC Host RPC db.getChat skips getCharacterFromIndex when chat.id/charIdByIndex exists and getMany ops return all keys', async () => {
    const storage = new Map([
        ['risustand_perms_prompted_v3', `${CURRENT_VERSION}:${Date.now()}`],
        ['risustand_remote_bridge_v2', JSON.stringify({
            enabled: true,
            relayUrl: 'http://127.0.0.1:8788',
            token: 'rpc-fast-token',
            includeImages: false,
            pollIntervalMs: 1800,
        })],
        ['hayaku:a', { step: 1 }],
        ['hayaku:b', { step: 2 }],
    ]);
    const localPluginData = new Map([['lk1', 'lv1'], ['lk2', 'lv2']]);
    const safeLocalData = new Map([['sk1', 'sv1'], ['sk2', 'sv2']]);
    const characters = [{
        chaId: 'fast-char-0',
        name: 'FastBot',
        firstMessage: 'hi',
        alternateGreetings: [],
        chats: [{
            id: 'fast-chat-0',
            name: 'Main',
            fmIndex: -1,
            scriptstate: {},
            message: [{ role: 'char', data: 'ready' }],
        }],
    }];
    let getCharCalls = 0;
    let pollCount = 0;
    let postedRpcResults = null;
    const timers = new Set();
    let unloadCb = null;
    const trackTimer = (id) => { timers.add(id); return id; };
    const untrackTimer = (id) => { timers.delete(id); clearTimeout(id); clearInterval(id); };

    const risuai = {
        pluginStorage: {
            getItem: async (k) => (storage.has(k) ? storage.get(k) : null),
            setItem: async (k, v) => { storage.set(k, v); },
        },
        safeLocalStorage: {
            getItem: async (k) => (safeLocalData.has(k) ? safeLocalData.get(k) : null),
            setItem: async (k, v) => { safeLocalData.set(k, v); },
        },
        getLocalPluginStorage: async () => ({
            getItem: async (k) => (localPluginData.has(k) ? localPluginData.get(k) : null),
            setItem: async (k, v) => { localPluginData.set(k, v); },
        }),
        getRootDocument: async () => null,
        changeColorScheme: async () => {},
        changeTextTheme: async () => {},
        setColorScheme: async () => {},
        setCustomTextTheme: async () => {},
        registerButton: async () => {},
        registerSetting: async () => {},
        addRisuChatListener: async () => {},
        removeRisuChatListener: async () => {},
        createMutationObserver: async () => ({ observe: async () => {}, disconnect: async () => {} }),
        onUnload: async (fn) => { unloadCb = fn; },
        getDatabase: async () => ({ enabledModules: [], modules: [], personas: [], selectedPersona: 0, customscript: [], globalChatVariables: {}, characters }),
        setDatabaseLite: async () => {},
        getCurrentCharacterIndex: async () => 0,
        getCurrentChatIndex: async () => 0,
        getCharacter: async () => characters[0],
        getCharacterFromIndex: async (i) => {
            getCharCalls += 1;
            return characters[i] || null;
        },
        setCharacterToIndex: async (i, c) => { characters[i] = c; },
        getChatFromIndex: async (cIdx, chIdx) => (characters[cIdx] && characters[cIdx].chats[chIdx]) || null,
        setChatToIndex: async (cIdx, chIdx, chatObj) => { characters[cIdx].chats[chIdx] = chatObj; },
        readImage: async () => null,
        readInlay: async () => null,
        sendChat: async () => {},
        nativeFetch: async (url, opts) => {
            if (String(url).endsWith('/api/pc/poll')) {
                pollCount += 1;
                if (pollCount === 1) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            ok: true,
                            relayVersion: '1.0.0',
                            supportsHostRpc: false,
                            commands: [],
                            rpcCalls: [
                                { id: 'c1', op: 'db.getChat', args: [0, 0] },
                                { id: 'c2', op: 'pluginStorage.getMany', args: [['hayaku:a', 'hayaku:b', 'hayaku:a']] },
                                { id: 'c3', op: 'localPluginStorage.getMany', args: [['lk1', 'lk2']] },
                                { id: 'c4', op: 'safeLocalStorage.getMany', args: [['sk1', 'sk2']] },
                            ],
                        }),
                    };
                }
                return { ok: true, status: 200, json: async () => ({ ok: true, relayVersion: '1.0.0', commands: [] }) };
            }
            if (String(url).endsWith('/api/pc/rpc-result')) {
                postedRpcResults = JSON.parse(opts.body).results;
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return { ok: true, status: 200, json: async () => ({ ok: true, calls: [] }) };
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

    const getCharCallsBeforeRpc = () => getCharCalls;
    try {
        const src = fs.readFileSync(path.join(REPO, 'risustand.js'), 'utf8');
        vm.runInNewContext(src, context, { filename: 'risustand.js' });
        for (let i = 0; i < 60 && !postedRpcResults; i++) {
            await new Promise((r) => setTimeout(r, 20));
        }
        assert.ok(Array.isArray(postedRpcResults), 'PC bridge should post RPC batch results');
        const byId = Object.fromEntries(postedRpcResults.map((r) => [r.id, r]));
        assert.equal(byId.c1.ok, true);
        assert.equal(byId.c1.value.id, 'fast-chat-0');
        assert.deepEqual(byId.c2.value, { 'hayaku:a': { step: 1 }, 'hayaku:b': { step: 2 } });
        assert.deepEqual(byId.c3.value, { lk1: 'lv1', lk2: 'lv2' });
        assert.deepEqual(byId.c4.value, { sk1: 'sv1', sk2: 'sv2' });
        // buildSnapshot warms charIdByIndex once via getCharacterFromIndex; db.getChat must NOT trigger extra calls
        assert.equal(getCharCallsBeforeRpc(), 1, 'db.getChat must not invoke getCharacterFromIndex again');
    } finally {
        if (unloadCb) await unloadCb();
        for (const id of timers) { clearTimeout(id); clearInterval(id); }
        timers.clear();
    }
});

test('buildSnapshot omits dead pcpath: entries for missing recent assets while preserving >2.5MB pcpath: fallback', async () => {
    const bigBuf = new Uint8Array(3 * 1024 * 1024);
    bigBuf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const db = {
        enabledModules: ['m1'],
        modules: [{
            id: 'm1',
            name: 'M1',
            assets: [
                ['missing_img.png', 'assets/missing_img.png'],
                ['huge_img.png', 'assets/huge_img.png'],
            ],
            regex: [],
        }],
        personas: [{ name: 'User', personaPrompt: '' }],
        selectedPersona: 0,
        customscript: [],
        globalChatVariables: {},
        characters: [],
    };
    const characters = [{
        chaId: 'missing-asset-char',
        name: 'MissingAssetBot',
        firstMessage: '',
        alternateGreetings: [],
        customscript: [],
        chats: [{
            id: 'c-miss',
            name: 'Chat Miss',
            fmIndex: -1,
            scriptstate: {},
            message: [{ role: 'char', data: '<img src="missing_img.png">\n<img src="huge_img.png">' }],
        }],
    }];
    const harness = await bootPluginWithMockRisu({
        db,
        characters,
        onReadImage: (p) => (p === 'assets/huge_img.png' ? bigBuf : null),
    });
    try {
        const snap = [...harness.polls].reverse().find((p) => p.snapshot)?.snapshot;
        assert.ok(snap);
        const vals = Object.values(snap.assetMap);
        assert.ok(!vals.includes('pcpath:assets/missing_img.png'), 'missing recent asset must not emit dead pcpath:');
        assert.ok(vals.includes('pcpath:assets/huge_img.png'), 'oversized (>2.5MB) existing asset still uses pcpath:');
    } finally {
        await harness.cleanup();
    }
});

test('buildSnapshot supports assetlist/string-array CBS, bare CSS url() assets, and 12MB cliff pcpath: fallback', async () => {
    const makeDistinctPng = (idx) => {
        const b = new Uint8Array(1.65 * 1024 * 1024);
        b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
        for (let j = 8; j < 64; j++) b[j] = (j + idx * 17) & 0xff;
        return b;
    };

    const additionalAssets = [];
    for (let i = 1; i <= 6; i++) {
        additionalAssets.push([`portrait_${i}.png`, `assets/portrait_${i}.png`, 'png']);
    }
    const db = {
        enabledModules: [],
        modules: [],
        personas: [{ name: 'User', personaPrompt: '' }],
        selectedPersona: 0,
        customscript: [
            {
                type: 'editdisplay',
                comment: 'cbs_asset_and_css_url',
                in: '\\[SHOW_PORTRAIT:([^\\]]+)\\]',
                out: '{{#if {{includes::{{assetlist}}::{{trim::$1}}}}}}<div class="cg-photo" data-em="{{upper::{{array_element::{{emotionlist}}::0}}}}" data-ok="{{startswith::{{lowercase::{{trim::$1}}}}::portrait_}}/{{endswith::{{trim::$1}}::.png}}/{{join::{{split::a,b::,}}::-}}/{{index_of::{{assetlist}}::portrait_1.png}}" style="background-image: url(\'{{trim::$1}}\')"></div>{{/if}}',
                ableFlag: false,
            },
        ],
        globalChatVariables: {},
        characters: [],
    };
    const characters = [{
        chaId: 'cliff-asset-char',
        name: 'ClaugemBot',
        firstMessage: '',
        alternateGreetings: [],
        additionalAssets,
        emotionImages: [['happy', 'assets/happy.png']],
        customscript: [],
        chats: [{
            id: 'c-cliff',
            name: 'Chat Cliff',
            fmIndex: -1,
            scriptstate: {},
            message: [{
                role: 'char',
                data: additionalAssets.map((a) => `[SHOW_PORTRAIT:${a[0]}]`).join('\n'),
            }],
        }],
    }];
    const harness = await bootPluginWithMockRisu({
        db,
        characters,
        onReadImage: (p) => {
            const m = String(p || '').match(/assets\/portrait_(\d+)\.png$/);
            return m ? makeDistinctPng(Number(m[1])) : null;
        },
    });
    try {
        const snap = [...harness.polls].reverse().find((p) => p.snapshot)?.snapshot;
        assert.ok(snap);
        const msg = snap.messages[0];
        assert.ok(msg.html.includes('data-em="HAPPY"'));
        assert.ok(msg.html.includes('data-ok="1/1/a-b/0"'));
        const bgMatches = [...msg.html.matchAll(/background-image:\s*url\('([^']+)'\)/g)].map((m) => m[1]);
        assert.equal(bgMatches.length, 6, 'all 6 polaroid portraits must resolve even past 12MB inline cap');
        const resolvedValues = bgMatches.map((tok) => snap.assetMap[tok.replace('[[RSASSET:', '').replace(']]', '')]);
        assert.ok(resolvedValues.some((v) => String(v).startsWith('data:image/png')), 'early portraits inline as data URI');
        assert.ok(resolvedValues.includes('pcpath:assets/portrait_6.png'), 'portrait past 12MB cap falls back to pcpath: instead of dropping');
    } finally {
        await harness.cleanup();
    }
});

test('buildSnapshot supports RisuAI named capture groups, <no_end_nl>, CRLF normalization, {{#escape}}, and extended CBS', async () => {
    const db = {
        enabledModules: [],
        modules: [],
        personas: [{ name: 'Tester', personaPrompt: 'Calm observer' }],
        selectedPersona: 0,
        customscript: [],
        globalChatVariables: { toggle_hud: 'on' },
        characters: [],
    };
    const characters = [{
        chaId: 'regex-cbs-parity-char',
        name: 'HyeyeonBot',
        firstMessage: '첫 인사',
        alternateGreetings: [],
        customScripts: [
            {
                type: 'editdisplay',
                comment: 'named_group_and_no_end_nl',
                in: '\\[FLAG:(?<kind>[a-z]+):(?<val>\\d+)\\]',
                out: '<span class="hy-flag" data-k="$<kind>">$<val></span>\n',
                ableFlag: true,
                flag: 'g<no_end_nl>',
            },
        ],
        chats: [{
            id: 'c-parity',
            name: 'Chat Parity',
            fmIndex: -1,
            scriptstate: { $json_map: '{"hp":90,"mp":"full"}' },
            message: [
                { role: 'user', data: '이전 질문' },
                {
                    role: 'char',
                    data: '줄1\r\n[FLAG:luck:6]\r\n{{#escape}}{{raw_literal_cbs}}{{/escape}}\r\n{{#when::is_last_msg}}LAST:{{/when}}{{#when::toggle::hud::is::on}}{{role}}|{{dictelement::{{getvar::json_map}}::hp}}|{{round::3.6}}|{{substr::abcdef::1::4}}|{{previous_chat_log::0}}{{/when}}',
                },
            ],
        }],
    }];
    const harness = await bootPluginWithMockRisu({ db, characters });
    try {
        const snap = [...harness.polls].reverse().find((p) => p.snapshot)?.snapshot;
        assert.ok(snap);
        const msg = snap.messages.find((m) => m.index === 1);
        assert.ok(msg);
        assert.ok(msg.html.includes('<span class="hy-flag" data-k="luck">6</span>'), 'named capture group $<kind>/$<val> resolves');
        assert.ok(!msg.html.includes('<span class="hy-flag" data-k="luck">6</span>\n\n'), '<no_end_nl> strips trailing newline');
        assert.ok(msg.html.includes('{{raw_literal_cbs}}'), '{{#escape}} preserves literal CBS');
        assert.ok(msg.html.includes('LAST:char|90|4|bcd|이전 질문'), 'is_last_msg, toggle::is, role, dictelement, round, substr, previous_chat_log work');
    } finally {
        await harness.cleanup();
    }
});

test('select_target switches chat immediately via pollOnce without blocking on setCharacterToIndex', async () => {
    const db = {
        enabledModules: [],
        modules: [],
        personas: [{ name: 'User', personaPrompt: '' }],
        selectedPersona: 0,
        customscript: [],
        globalChatVariables: {},
        characters: [],
    };
    const characters = [
        {
            chaId: 'char-a',
            name: 'Alpha',
            chatPage: 0,
            chats: [
                { id: 'a-c0', name: 'Room A0', message: [{ role: 'char', data: '방 A0 인사말' }] },
                { id: 'a-c1', name: 'Room A1', message: [{ role: 'char', data: '방 A1 인사말' }] },
            ],
        },
        {
            chaId: 'char-b',
            name: 'Beta',
            chatPage: 0,
            chats: [
                { id: 'b-c0', name: 'Room B0', message: [{ role: 'char', data: '방 B0 인사말' }] },
            ],
        },
    ];
    const harness = await bootPluginWithMockRisu({ db, characters });
    const origPoll0 = harness.polls[0];
    assert.equal(origPoll0.snapshot.charIndex, 0);
    assert.equal(origPoll0.snapshot.chatIndex, 0);
    try {
        await harness.triggerNextPoll({ type: 'select_target', payload: { charIndex: 0, chatIndex: 1 } });
        let switchedA1 = null;
        for (let i = 0; i < 40; i += 1) {
            switchedA1 = [...harness.polls].reverse().find((p) => p.snapshot && p.snapshot.charIndex === 0 && p.snapshot.chatIndex === 1);
            if (switchedA1) break;
            await new Promise((r) => setTimeout(r, 25));
        }
        assert.ok(switchedA1, 'select_target should switch to (0, 1)');
        assert.equal(switchedA1.snapshot.chatName, 'Room A1');

        await harness.triggerNextPoll({ type: 'select_target', payload: { charIndex: 1, chatIndex: 0 } });
        let switchedB0 = null;
        for (let i = 0; i < 40; i += 1) {
            switchedB0 = [...harness.polls].reverse().find((p) => p.snapshot && p.snapshot.charIndex === 1 && p.snapshot.chatIndex === 0);
            if (switchedB0) break;
            await new Promise((r) => setTimeout(r, 25));
        }
        assert.ok(switchedB0, 'select_target should switch to (1, 0)');
        assert.equal(switchedB0.snapshot.charName, 'Beta');
        assert.equal(switchedB0.snapshot.chatName, 'Room B0');
    } finally {
        await harness.cleanup();
    }
});

test('risustand.js evalCBS supports {{source::user/char}}, comparison aliases, tonumber, and metadata macros', async () => {
    const db = {
        enabledModules: [],
        modules: [],
        personas: [{ name: '푸딩', personaPrompt: '', icon: 'assets/pudding_avatar.png' }],
        selectedPersona: 0,
        customscript: [],
        globalChatVariables: {},
        characters: [],
    };
    const characters = [{
        chaId: 'char-cbs-parity2',
        name: '혜연',
        image: 'assets/hy_main.png',
        chatPage: 0,
        chats: [{
            id: 'c-cbs2',
            name: 'Chat CBS 2',
            note: '메모테스트',
            scriptstate: {},
            message: [
                { role: 'user', data: '안녕' },
                {
                    role: 'char',
                    data: 'U:{{source::user}}|C:{{source::char}}|CMP:{{gt::5::3}}:{{lte::2::2}}:{{eq::01::1}}:{{neq::a::b}}|N:{{tonumber::42}}|NOTE:{{authorsnote}}|LAST:{{lastusermessage}}',
                },
            ],
        }],
    }];
    const harness = await bootPluginWithMockRisu({ db, characters });
    try {
        const snap = [...harness.polls].reverse().find((p) => p.snapshot)?.snapshot;
        assert.ok(snap);
        assert.equal(snap.charContext.personaIcon, 'assets/pudding_avatar.png');
        assert.equal(snap.charContext.charImage, 'assets/hy_main.png');
        const msg = snap.messages.find((m) => m.index === 1);
        assert.ok(msg);
        assert.ok(msg.html.includes('CMP:1:1:1:1|N:42|NOTE:메모테스트|LAST:안녕'), `got: ${msg.html}`);
        assert.ok(!msg.html.includes('{{source::'), 'source macros must be evaluated');
        assert.ok(msg.html.includes('U:[[RSASSET:') && msg.html.includes('C:[[RSASSET:'), 'asset source paths must resolve into RSASSET tokens');
    } finally {
        await harness.cleanup();
    }
});
