'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const { REPO } = require('./helpers.cjs');
const CURRENT_VERSION = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim();

async function bootPluginWithMockRisu({ db, characters, initialStorage, requestPluginPermission, onSendChat, onReadImage, onGetDatabase, onSetDatabaseLite, onReadInlay }) {
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
            if (typeof onGetDatabase === 'function') await onGetDatabase(keys);
            const out = {};
            for (const k of keys) out[k] = db[k];
            return out;
        },
        setDatabaseLite: async (patch) => {
            if (typeof onSetDatabaseLite === 'function') await onSetDatabaseLite(patch);
            Object.assign(db, patch);
        },
        getCurrentCharacterIndex: async () => 0,
        getCurrentChatIndex: async () => 0,
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
        assert.ok(savedStamp.startsWith(`${CURRENT_VERSION}:`), `Expected versioned timestamp, got: ${savedStamp}`);
    } finally {
        await h1.cleanup();
    }

    const requestedSecond = [];
    const h2 = await bootPluginWithMockRisu({
        db,
        characters,
        initialStorage: [['risustand_perms_prompted_v3', `${CURRENT_VERSION}:${Date.now()}`]],
        requestPluginPermission: async (perm) => { requestedSecond.push(perm); return true; },
    });
    try {
        await new Promise((r) => setTimeout(r, 80));
        assert.deepEqual(requestedSecond, []);
    } finally {
        await h2.cleanup();
    }

    // Legacy v2 or expired (>3 days) stamp must re-prompt upfront
    const requestedExpired = [];
    const oldTs = Date.now() - Math.floor(3.1 * 24 * 60 * 60 * 1000);
    const h3 = await bootPluginWithMockRisu({
        db,
        characters,
        initialStorage: [['risustand_perms_prompted_v3', `${CURRENT_VERSION}:${oldTs}`]],
        requestPluginPermission: async (perm) => { requestedExpired.push(perm); return true; },
    });
    try {
        await new Promise((r) => setTimeout(r, 80));
        assert.deepEqual(requestedExpired, ['mainDom', 'db', 'dbWrite', 'sendChat', 'inlay']);
    } finally {
        await h3.cleanup();
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
    const server = relay.createRelayServer({ token: 'test-jump-token' });
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

test('Leave preset display compat renders <ooc>, hides text-only <statusdata>, and respects toggle_thought_display', async () => {
    const db = {
        enabledModules: [],
        modules: [],
        personas: [{ name: 'User', personaPrompt: '' }],
        selectedPersona: 0,
        customscript: [],
        globalChatVariables: { toggle_thought_display: '0' },
        characters: [],
    };
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
            scriptstate: {},
            message: [
                {
                    role: 'char',
                    data: '<thinking>숨길 생각</thinking>\n<statusdata>HP: 100</statusdata>\n<statusdata><details><summary>HUD</summary>상태창</details></statusdata>\n<ooc>사서 리브 응답</ooc>\n본문 서사입니다.',
                },
            ],
        }],
    }];
    const harness = await bootPluginWithMockRisu({ db, characters });
    try {
        // Case 1: toggle_thought_display = '0' -> thinking hidden, text-only statusdata hidden, HUD & OOC visible
        let snap = [...harness.polls].reverse().find((p) => p.snapshot)?.snapshot;
        let msg = snap.messages.find((m) => m.index === 0);
        assert.ok(msg.html.includes('leave-ooc-card'));
        assert.ok(msg.html.includes('사서 리브 응답'));
        assert.ok(!msg.html.includes('HP: 100'));
        assert.ok(msg.html.includes('<details><summary>HUD</summary>상태창</details>'));
        assert.ok(!msg.html.includes('숨길 생각'));
        assert.ok(!msg.html.includes('leave-thought-box'));

        // Case 2: toggle_thought_display = '1' -> <thinking> rendered inside leave-thought-box, cleanProse text still hides it
        db.globalChatVariables.toggle_thought_display = '1';
        await harness.triggerNextPoll({ type: 'sync_chat', payload: {} });
        await harness.triggerNextPoll();
        snap = [...harness.polls].reverse().find((p) => p.snapshot)?.snapshot;
        msg = snap.messages.find((m) => m.index === 0);
        assert.ok(msg.html.includes('<details class="leave-thought-box">'));
        assert.ok(msg.html.includes('숨길 생각'));
        assert.ok(!msg.text.includes('숨길 생각'));
        assert.ok(msg.text.includes('본문 서사입니다.'));
    } finally {
        await harness.cleanup();
    }
});
