#!/usr/bin/env node
/**
 * RisuStand Remote Relay Server v1.0.0
 * Zero-dependency Node.js (v18+) server:
 *  1) PC RisuAI Plugin Bridge Relay (Bots, Chats, Modules, Personas, Params)
 *  2) OpenAI-Compatible Local LLM Proxy Router (/v1/chat/completions)
 *     -> Supports OpenAI-Compatible, Anthropic Claude, Google Gemini + Prompt Override
 *  3) Built-in Translator Engine (Auto/On-demand Output & Korean->English Input)
 *  4) Mobile-first Pocket Web UI (Gemini / Claude / ChatGPT / EPUB Day & Night)
 *
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Required Notice: Copyright (c) 2026 RisuStand Contributors
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = (process.env.RISU_REMOTE_TOKEN || '').trim() || crypto.randomBytes(12).toString('hex');
const CONFIG_PATH = path.join(__dirname, '.risustand-config.json');

// ================= Persistent Config =================
function defaultConfig() {
    return {
        activeProfileId: '',
        presetToggles: [],
        profiles: [
            {
                id: 'preset-openrouter',
                name: 'OpenRouter (예시)',
                providerType: 'openai_compat',
                baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
                apiKey: '',
                model: 'anthropic/claude-3.7-sonnet',
                temperature: '',
                maxTokens: '',
                overrideMode: 'off',
                systemOverride: '',
            },
            {
                id: 'preset-gemini',
                name: 'Google Gemini (예시)',
                providerType: 'gemini',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
                apiKey: '',
                model: 'gemini-2.5-pro',
                temperature: '',
                maxTokens: '',
                overrideMode: 'off',
                systemOverride: '',
            },
            {
                id: 'preset-claude',
                name: 'Anthropic Claude (예시)',
                providerType: 'anthropic',
                baseUrl: 'https://api.anthropic.com/v1/messages',
                apiKey: '',
                model: 'claude-sonnet-4-20250514',
                temperature: '',
                maxTokens: '4096',
                overrideMode: 'off',
                systemOverride: '',
            },
        ],
        translator: {
            enabled: false,
            useActiveProfile: true,
            autoTranslateOutput: false,
            autoTranslateInput: false,
            targetLang: 'Korean',
            providerType: 'gemini',
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
            apiKey: '',
            model: 'gemini-2.5-flash',
            prompt: 'Translate the following roleplay/novel text naturally into Korean. Preserve tone, nuance, and formatting. Output ONLY the translated text without explanations.',
            inputPrompt: 'Translate the following Korean user roleplay input naturally into English. Output ONLY the translated English text.',
        },
    };
}

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            const def = defaultConfig();
            return {
                activeProfileId: typeof raw.activeProfileId === 'string' ? raw.activeProfileId : def.activeProfileId,
                profiles: Array.isArray(raw.profiles) ? raw.profiles : def.profiles,
                presetToggles: Array.isArray(raw.presetToggles) ? raw.presetToggles : [],
                translator: { ...def.translator, ...(raw.translator || {}) },
            };
        }
    } catch (e) {
        console.warn('[Config] 설정 로드 실패, 기본값 사용:', e.message);
    }
    return defaultConfig();
}

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    } catch (e) {
        console.warn('[Config] 설정 저장 실패:', e.message);
    }
}

let config = loadConfig();

// ================= Runtime State =================
const state = {
    pcConnected: false,
    pcLastSeen: 0,
    bridgeVersion: '',
    generating: false,
    directGenerating: false,
    catalog: {
        pcActiveCharIndex: -1,
        pcActiveChatIndex: -1,
        selectedPersona: 0,
        params: { temperature: 80, maxContext: 8000, maxResponse: 1000 },
        characters: [],
        modules: [],
        personas: [],
    },
    snapshot: {
        charName: 'PC RisuAI 연결 대기 중...',
        charIndex: -1,
        chatIndex: -1,
        chatName: '',
        isPcActive: false,
        totalMessages: 0,
        messages: [],
        charContext: null,
    },
    commandQueue: [],
};

const translationCache = new Map();

function maskKey(k) {
    if (!k) return '';
    const s = String(k);
    if (s.length <= 8) return '****';
    return s.slice(0, 4) + '...' + s.slice(-4);
}

function getActiveProfile() {
    if (!config.profiles.length) return null;
    return config.profiles.find((p) => p.id === config.activeProfileId) || null;
}

function queueCommand(type, payload) {
    state.commandQueue.push({
        id: crypto.randomBytes(6).toString('hex'),
        type,
        payload: payload || {},
        createdAt: Date.now(),
    });
}

// ================= HTTP Helpers =================
function readBody(req, limitBytes = 25 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > limitBytes) {
                reject(new Error('Payload too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function sendJson(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-RisuStand-Token',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    });
    res.end(body);
}

function getRequestToken(req, urlObj) {
    const h = req.headers['x-risustand-token'];
    if (h) return String(h).trim();
    const auth = req.headers['authorization'] || '';
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    const q = urlObj.searchParams.get('token');
    if (q) return q.trim();
    return '';
}

function requireAuth(req, res, urlObj) {
    if (getRequestToken(req, urlObj) !== TOKEN) {
        sendJson(res, 401, { error: 'Unauthorized: Invalid token' });
        return false;
    }
    return true;
}

// ================= LLM Router Core =================
function applyPromptOverride(messages, profile) {
    const list = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
    const mode = profile && profile.overrideMode ? profile.overrideMode : 'off';
    const text = profile && profile.systemOverride ? String(profile.systemOverride).trim() : '';
    if (mode === 'off' || !text) return list;

    if (mode === 'replace') {
        const nonSys = list.filter((m) => m.role !== 'system');
        return [{ role: 'system', content: text }, ...nonSys];
    }
    if (mode === 'prepend') {
        return [{ role: 'system', content: text }, ...list];
    }
    if (mode === 'append') {
        const idx = list.findIndex((m) => m.role === 'system');
        if (idx >= 0) {
            list[idx].content = String(list[idx].content || '') + '\n\n' + text;
            return list;
        }
        return [{ role: 'system', content: text }, ...list];
    }
    return list;
}

function normalizeMessageText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => (typeof part === 'string' ? part : part && part.text ? part.text : ''))
            .filter(Boolean)
            .join('\n');
    }
    return String(content || '');
}

async function callLLMNonStream(profile, messages, extraOpts = {}) {
    if (!profile) throw new Error('활성화된 모델 프로필이 없습니다. [모델/번역] 탭에서 프로필을 선택하세요.');
    if (!profile.apiKey && profile.providerType !== 'openai_compat') {
        throw new Error(`프로필 "${profile.name}"의 API 키가 비어 있습니다.`);
    }

    const tempVal = extraOpts.temperature !== undefined
        ? extraOpts.temperature
        : profile.temperature !== '' && profile.temperature !== undefined
        ? Number(profile.temperature)
        : undefined;
    const maxTokVal = extraOpts.maxTokens !== undefined
        ? extraOpts.maxTokens
        : profile.maxTokens !== '' && profile.maxTokens !== undefined
        ? Number(profile.maxTokens)
        : undefined;

    if (profile.providerType === 'anthropic') {
        const sysParts = [];
        const chatMsgs = [];
        for (const m of messages) {
            const txt = normalizeMessageText(m.content);
            if (m.role === 'system') sysParts.push(txt);
            else chatMsgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: txt });
        }
        if (!chatMsgs.length) chatMsgs.push({ role: 'user', content: 'Continue.' });
        const body = {
            model: profile.model,
            max_tokens: maxTokVal || 4096,
            messages: chatMsgs,
        };
        if (sysParts.length) body.system = sysParts.join('\n\n');
        if (tempVal !== undefined && !Number.isNaN(tempVal)) body.temperature = tempVal;

        const resp = await fetch(profile.baseUrl || 'https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': profile.apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error?.message || `Anthropic HTTP ${resp.status}`);
        const out = Array.isArray(data.content) ? data.content.map((b) => b.text || '').join('') : '';
        return { text: out, model: data.model || profile.model, usage: data.usage || null };
    }

    if (profile.providerType === 'gemini') {
        const base = (profile.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
        const endpoint = `${base}/models/${encodeURIComponent(profile.model)}:generateContent?key=${encodeURIComponent(profile.apiKey)}`;
        const sysParts = [];
        const contents = [];
        for (const m of messages) {
            const txt = normalizeMessageText(m.content);
            if (m.role === 'system') sysParts.push(txt);
            else contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: txt }] });
        }
        if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'Continue.' }] });
        const body = { contents };
        if (sysParts.length) body.systemInstruction = { parts: [{ text: sysParts.join('\n\n') }] };
        const genCfg = {};
        if (tempVal !== undefined && !Number.isNaN(tempVal)) genCfg.temperature = tempVal;
        if (maxTokVal !== undefined && !Number.isNaN(maxTokVal)) genCfg.maxOutputTokens = maxTokVal;
        if (Object.keys(genCfg).length) body.generationConfig = genCfg;

        const resp = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error?.message || `Gemini HTTP ${resp.status}`);
        const parts = data.candidates?.[0]?.content?.parts || [];
        const out = parts.map((p) => p.text || '').join('');
        return { text: out, model: profile.model, usage: data.usageMetadata || null };
    }

    // Default: OpenAI-Compatible
    const endpoint = profile.baseUrl || 'https://api.openai.com/v1/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (profile.apiKey) headers['Authorization'] = `Bearer ${profile.apiKey}`;
    if (endpoint.includes('openrouter.ai')) {
        headers['HTTP-Referer'] = 'http://localhost:8787';
        headers['X-Title'] = 'RisuStand Remote';
    }

    const body = {
        model: profile.model,
        messages,
        stream: false,
    };
    if (tempVal !== undefined && !Number.isNaN(tempVal)) body.temperature = tempVal;
    if (maxTokVal !== undefined && !Number.isNaN(maxTokVal)) body.max_tokens = maxTokVal;

    const resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error?.message || `Upstream HTTP ${resp.status}`);
    const out = data.choices?.[0]?.message?.content || '';
    return { text: out, model: data.model || profile.model, usage: data.usage || null };
}

async function handleOpenAIProxy(req, res) {
    try {
        const raw = await readBody(req);
        const reqBody = JSON.parse(raw || '{}');
        const profile = getActiveProfile();
        if (!profile) {
            return sendJson(res, 400, {
                error: {
                    message: 'RisuStand 릴레이 라우터에 활성화된 모델 프로필이 없습니다. 모바일 [모델/번역] 탭에서 프로필을 선택해 주세요.',
                    type: 'configuration_error',
                },
            });
        }

        const messages = applyPromptOverride(reqBody.messages || [], profile);
        const wantStream = Boolean(reqBody.stream);
        console.log(`[Router] ${profile.name} (${profile.providerType}:${profile.model}) | msgs=${messages.length} | stream=${wantStream}`);

        // Fast-path passthrough for OpenAI-compatible streaming
        if (wantStream && profile.providerType === 'openai_compat') {
            const endpoint = profile.baseUrl || 'https://api.openai.com/v1/chat/completions';
            const headers = { 'Content-Type': 'application/json' };
            if (profile.apiKey) headers['Authorization'] = `Bearer ${profile.apiKey}`;
            if (endpoint.includes('openrouter.ai')) {
                headers['HTTP-Referer'] = 'http://localhost:8787';
                headers['X-Title'] = 'RisuStand Remote';
            }
            const upBody = {
                ...reqBody,
                model: profile.model,
                messages,
                stream: true,
            };
            if (profile.temperature !== '' && profile.temperature !== undefined) upBody.temperature = Number(profile.temperature);
            if (profile.maxTokens !== '' && profile.maxTokens !== undefined) upBody.max_tokens = Number(profile.maxTokens);

            const upRes = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(upBody),
            });

            if (!upRes.ok || !upRes.body) {
                const errText = await upRes.text().catch(() => '');
                return sendJson(res, upRes.status || 502, {
                    error: { message: errText || `Upstream HTTP ${upRes.status}`, type: 'upstream_error' },
                });
            }

            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
            });

            const reader = upRes.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(Buffer.from(value));
            }
            res.end();
            return;
        }

        // Universal call (works for Anthropic, Gemini, and non-stream OpenAI)
        const result = await callLLMNonStream(profile, messages, {
            temperature: reqBody.temperature,
            maxTokens: reqBody.max_tokens,
        });

        const id = 'chatcmpl-' + crypto.randomBytes(8).toString('hex');
        const created = Math.floor(Date.now() / 1000);

        if (wantStream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
            });
            const chunk = {
                id,
                object: 'chat.completion.chunk',
                created,
                model: result.model,
                choices: [{ index: 0, delta: { role: 'assistant', content: result.text }, finish_reason: null }],
            };
            const endChunk = {
                id,
                object: 'chat.completion.chunk',
                created,
                model: result.model,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            res.write(`data: ${JSON.stringify(endChunk)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }

        return sendJson(res, 200, {
            id,
            object: 'chat.completion',
            created,
            model: result.model,
            choices: [
                {
                    index: 0,
                    message: { role: 'assistant', content: result.text },
                    finish_reason: 'stop',
                },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
    } catch (e) {
        console.error('[Router Error]', e.message);
        return sendJson(res, 502, {
            error: { message: e.message || 'Proxy router error', type: 'proxy_error' },
        });
    }
}

// ================= Translator Core =================
async function translateText(text, direction = 'to_target') {
    const clean = String(text || '').trim();
    if (!clean) return '';
    const cacheKey = `${direction}:${crypto.createHash('sha1').update(clean).digest('hex')}`;
    if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

    const tr = config.translator || {};
    let profile = null;
    if (tr.useActiveProfile) {
        profile = getActiveProfile();
    } else {
        profile = {
            name: 'Translator',
            providerType: tr.providerType || 'gemini',
            baseUrl: tr.baseUrl || '',
            apiKey: tr.apiKey || '',
            model: tr.model || 'gemini-2.5-flash',
            temperature: 0.2,
            maxTokens: 2048,
        };
    }

    if (!profile) {
        throw new Error('번역에 사용할 모델이 설정되지 않았습니다. [모델/번역] 탭에서 모델 프로필 또는 번역기 키를 설정하세요.');
    }

    const sysPrompt = direction === 'to_en'
        ? (tr.inputPrompt || 'Translate the following Korean text naturally into English. Output ONLY the translation.')
        : (tr.prompt || `Translate the following text naturally into ${tr.targetLang || 'Korean'}. Output ONLY the translation.`);

    const res = await callLLMNonStream(profile, [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: clean },
    ], { temperature: 0.2 });

    const out = String(res.text || '').trim();
    if (out) {
        if (translationCache.size > 400) translationCache.clear();
        translationCache.set(cacheKey, out);
    }
    return out;
}

// ================= Direct Remote Chat (for non-PC-active chars) =================
async function runDirectRemoteChat(charIndex, chatIndex, userText) {
    const profile = getActiveProfile();
    if (!profile) {
        throw new Error('PC에서 현재 열려있지 않은 봇과 대화하려면 [모델/번역] 탭에서 활성 모델 프로필을 먼저 설정해야 합니다.');
    }
    const snap = state.snapshot;
    const ctx = snap && snap.charContext ? snap.charContext : { name: snap.charName || 'Character' };

    const sysParts = [];
    sysParts.push(`You are roleplaying as ${ctx.name}. Stay in character and respond naturally.`);
    if (ctx.systemPrompt) sysParts.push(ctx.systemPrompt);
    if (ctx.desc) sysParts.push(`[Character Description]\n${ctx.desc}`);
    if (ctx.personality) sysParts.push(`[Personality]\n${ctx.personality}`);
    if (ctx.scenario) sysParts.push(`[Scenario]\n${ctx.scenario}`);
    if (ctx.personaName || ctx.personaPrompt) {
        sysParts.push(`[User Persona: ${ctx.personaName || 'User'}]\n${ctx.personaPrompt || ''}`);
    }
    if (ctx.note) sysParts.push(`[Author's Note]\n${ctx.note}`);

    const msgs = [{ role: 'system', content: sysParts.join('\n\n') }];
    const history = Array.isArray(snap.messages) ? snap.messages.slice(-20) : [];
    for (const m of history) {
        msgs.push({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.raw || m.text || '',
        });
    }
    msgs.push({ role: 'user', content: userText });

    const finalMsgs = applyPromptOverride(msgs, profile);
    state.directGenerating = true;
    try {
        console.log(`[DirectChat] char#${charIndex} chat#${chatIndex} via ${profile.name} (${profile.model})`);
        const result = await callLLMNonStream(profile, finalMsgs);
        queueCommand('append_messages', {
            charIndex,
            chatIndex,
            messages: [
                { role: 'user', data: userText },
                { role: 'char', data: result.text },
            ],
        });
        return result.text;
    } finally {
        state.directGenerating = false;
    }
}

// ================= Mobile Web UI =================
function renderWebApp() {
    return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="theme-color" id="themeColorMeta" content="#ffffff" />
<title>RisuStand Remote v1.0.0</title>
<style>
  /* ===== Design tokens (light defaults) ===== */
  :root {
    --bg: #ffffff; --bg-grad: none; --surface: #f4f6f9; --surface2: #eaeef5; --elev: #ffffff;
    --text: #1b1c1d; --sub: #5f6368; --border: #e1e5ec;
    --accent: #1a73e8; --on-accent: #ffffff;
    --accent-soft: color-mix(in srgb, var(--accent) 14%, transparent);
    --user-bg: #e8f0fe; --user-text: #174ea6;
    --header-bg: color-mix(in srgb, var(--bg) 82%, transparent);
    --ok: #15803d; --danger: #dc2626;
    --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.06), 0 1px 3px rgba(15, 23, 42, 0.05);
    --shadow: 0 10px 30px -12px rgba(15, 23, 42, 0.22), 0 4px 10px -6px rgba(15, 23, 42, 0.12);
    --radius: 16px; --radius-sm: 10px;
    --book-bg: #f4efe6; --book-spine: rgba(0,0,0,0.09); --leaf-bg: linear-gradient(90deg, #ede5d6 0%, #f8f3ea 45%, #e4d9c6 100%);
    --font: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Malgun Gothic", sans-serif;
    --ui-font: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Malgun Gothic", system-ui, sans-serif;
    --fsize: 15.5px; --lh: 1.75;
    --content-w: 820px;
    color-scheme: light;
  }
  /* 1. Gemini */
  [data-theme="ai-gemini"] {
    --bg: #ffffff; --surface: #f0f4f9; --surface2: #e3e9f2; --text: #1f1f1f; --sub: #5e6368;
    --border: #e1e6ed; --accent: #0b57d0; --user-bg: #e9eef6; --user-text: #1f1f1f;
  }
  /* 2. Claude */
  [data-theme="ai-claude"] {
    --bg: #faf9f5; --surface: #f0eee6; --surface2: #e6e2d6; --elev: #ffffff; --text: #1a1918; --sub: #6b6860;
    --border: #e2dfd5; --accent: #c96442; --user-bg: #f0eee6; --user-text: #1a1918;
  }
  /* 3. ChatGPT */
  [data-theme="ai-chatgpt"] {
    --bg: #ffffff; --surface: #f7f7f8; --surface2: #ececec; --text: #0d0d0d; --sub: #6b6b6b;
    --border: #e6e6e6; --accent: #0d0d0d; --accent-soft: rgba(0, 0, 0, 0.07); --user-bg: #f2f2f2; --user-text: #0d0d0d;
  }
  /* 4 & 6. EPUB Sepia */
  [data-theme="epub-1p-day"], [data-theme="epub-2p-day"] {
    --bg: #f4efe6; --surface: #ece5d7; --surface2: #e2d8c6; --elev: #faf6ee; --text: #2a241e; --sub: #75685a;
    --border: #ddd2bf; --accent: #8c5a2b; --user-bg: #ebe2cf; --user-text: #2a241e;
    --book-bg: #f8f3e9; --book-spine: rgba(90,65,40,0.14);
    --leaf-bg: linear-gradient(90deg, #e7decb 0%, #faf6ee 50%, #dfd3bc 100%);
    --shadow: 0 14px 34px -14px rgba(74, 52, 28, 0.32), 0 4px 10px -6px rgba(74, 52, 28, 0.16);
  }
  /* 5 & 7. EPUB Night */
  [data-theme="epub-1p-night"], [data-theme="epub-2p-night"] {
    --bg: #141518; --surface: #1c1e23; --surface2: #262930; --elev: #1c1e23; --text: #e4e1da; --sub: #9a968c;
    --border: #2b2d34; --accent: #d2a86e; --on-accent: #1b1b20; --user-bg: #24262d; --user-text: #f0e9dc;
    --book-bg: #1a1b20; --book-spine: rgba(0,0,0,0.6);
    --leaf-bg: linear-gradient(90deg, #1b1e25 0%, #2a2c33 50%, #14161b 100%);
  }
  /* 8. Midnight Glass */
  [data-theme="midnight-glass"] {
    --bg: #0a0f1f;
    --bg-grad: radial-gradient(1200px 600px at 10% -10%, rgba(99, 102, 241, 0.28), transparent 60%), radial-gradient(900px 500px at 110% 10%, rgba(56, 189, 248, 0.16), transparent 55%), radial-gradient(900px 700px at 50% 120%, rgba(168, 85, 247, 0.18), transparent 60%);
    --surface: rgba(30, 41, 75, 0.55); --surface2: rgba(48, 62, 108, 0.6); --elev: rgba(24, 33, 62, 0.72);
    --text: #edf2ff; --sub: #a3b0d6; --border: rgba(140, 162, 235, 0.2);
    --accent: #8ea2ff; --on-accent: #0a0f1f; --user-bg: rgba(99, 120, 240, 0.3); --user-text: #f1f4ff;
    --header-bg: rgba(10, 15, 31, 0.55);
  }
  /* 9. Sakura Pastel */
  [data-theme="sakura-pastel"] {
    --bg: #fff8fb;
    --bg-grad: radial-gradient(900px 500px at 100% 0%, rgba(255, 200, 221, 0.45), transparent 60%), radial-gradient(800px 500px at 0% 100%, rgba(255, 228, 236, 0.6), transparent 60%);
    --surface: #fdeef4; --surface2: #f9dde8; --elev: #ffffff; --text: #3d2430; --sub: #8a5c71;
    --border: #f3d3e0; --accent: #c2477a; --user-bg: #fbe0eb; --user-text: #3d2430;
    --shadow: 0 12px 30px -14px rgba(194, 71, 122, 0.35), 0 4px 10px -6px rgba(194, 71, 122, 0.15);
  }
  /* 10. Forest Moss */
  [data-theme="forest-moss"] {
    --bg: #111a15;
    --bg-grad: radial-gradient(1000px 600px at 0% 0%, rgba(94, 184, 132, 0.12), transparent 60%);
    --surface: #1a251f; --surface2: #233229; --elev: #18231d; --text: #e2ece6; --sub: #93ab9d;
    --border: #2a3b31; --accent: #6cc493; --on-accent: #0f1a14; --user-bg: #22392c; --user-text: #e8f3ec;
  }
  /* Dark-scheme shared tokens */
  [data-theme="epub-1p-night"], [data-theme="epub-2p-night"], [data-theme="midnight-glass"], [data-theme="forest-moss"] {
    --ok: #4ade80; --danger: #f87171; color-scheme: dark;
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
    --shadow: 0 16px 40px -16px rgba(0,0,0,0.7), 0 4px 12px -6px rgba(0,0,0,0.45);
  }

  /* Font Overrides */
  [data-font="serif"] { --font: "RIDIBatang", "KoPub Batang", "AppleMyungjo", "Batang", "Noto Serif KR", Georgia, serif; }
  [data-font="sans"] { --font: "Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif; }
  [data-font="system"] { --font: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", sans-serif; }

  /* ===== Base ===== */
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body {
    margin:0; padding:0; height:100%; overflow:hidden;
    background: var(--bg-grad), var(--bg); background-attachment: fixed;
    color: var(--text); font-family: var(--ui-font); -webkit-font-smoothing: antialiased;
    transition: background-color 0.25s ease, color 0.25s ease;
  }
  button { font-family: inherit; }
  select, input, textarea { font-family: inherit; color: var(--text); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  ::selection { background: var(--accent-soft); }
  * { scrollbar-width: thin; scrollbar-color: var(--surface2) transparent; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: var(--surface2); border-radius: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }

  #app {
    display: grid; height: 100dvh; width: 100%;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr) auto auto;
    grid-template-areas: "header" "main" "composer" "nav";
  }

  /* ===== Header ===== */
  header {
    grid-area: header; position: relative; z-index: 30;
    display:flex; align-items:center; justify-content:space-between; gap:8px;
    padding: calc(8px + env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) 8px max(12px, env(safe-area-inset-left));
    border-bottom:1px solid var(--border); background: var(--header-bg);
    -webkit-backdrop-filter: saturate(160%) blur(14px); backdrop-filter: saturate(160%) blur(14px);
  }
  .h-left { min-width:0; display:flex; align-items:center; gap:10px; flex:1; padding: 2px 4px; margin-left:-4px; border-radius: 10px; }
  .h-left:active { background: var(--accent-soft); }
  .dot { width:8px; height:8px; border-radius:50%; background:#9ca3af; flex-shrink:0; box-shadow: 0 0 0 3px color-mix(in srgb, #9ca3af 22%, transparent); }
  .dot.on { background:#22c55e; box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.22); }
  .h-title { font-weight:700; font-size:15px; letter-spacing:-0.01em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .h-sub { font-size:11.5px; color:var(--sub); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:1px; }
  .h-right { display:flex; align-items:center; gap:6px; flex-shrink:0; }

  .pill {
    display:inline-flex; align-items:center; justify-content:center; gap:4px;
    min-height:34px; min-width:34px; padding:0 11px;
    border:1px solid var(--border); background:var(--elev); color:var(--text);
    border-radius:999px; font-size:12.5px; font-weight:600; cursor:pointer; outline:none;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, transform 0.1s ease;
  }
  .pill:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
  .pill:active { transform: scale(0.96); }
  .pill.active { background:var(--accent); color:var(--on-accent); border-color:var(--accent); }
  .pill:disabled { opacity:0.4; cursor:default; transform:none; }
  .icon-pill { padding:0; width:36px; height:36px; font-size:15px; }

  /* ===== Reading / Display Settings Popover ===== */
  .read-bar {
    position:absolute; top: calc(100% + 8px); right: max(10px, env(safe-area-inset-right));
    width: min(380px, calc(100vw - 20px));
    display:flex; flex-direction:column; gap:14px; padding:16px;
    background: var(--elev); border:1px solid var(--border); border-radius: 18px;
    box-shadow: var(--shadow);
    -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px);
    opacity:0; transform: translateY(-6px) scale(0.98); transform-origin: top right;
    pointer-events:none; visibility:hidden;
    transition: opacity 0.16s ease, transform 0.16s ease, visibility 0s linear 0.16s;
  }
  .read-bar.open { opacity:1; transform:none; pointer-events:auto; visibility:visible; transition: opacity 0.16s ease, transform 0.16s ease; }
  .rb-sec { display:flex; flex-direction:column; gap:8px; }
  .rb-label { font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:var(--sub); }
  .rb-grp { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .rb-val { min-width:40px; text-align:center; font-size:13px; font-weight:700; font-variant-numeric: tabular-nums; }
  .seg { display:flex; padding:3px; gap:2px; background:var(--surface); border:1px solid var(--border); border-radius:999px; width:100%; }
  .seg .pill { flex:1; border:none; background:transparent; min-height:30px; }
  .seg .pill.active { background:var(--elev); color:var(--text); box-shadow: var(--shadow-sm); }
  .theme-grid { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:6px; }
  .theme-chip {
    display:flex; align-items:center; gap:9px; padding:8px 10px; min-height:40px;
    border:1px solid var(--border); border-radius:12px; background:transparent; color:var(--text);
    font-size:12.5px; font-weight:600; cursor:pointer; text-align:left;
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  .theme-chip:hover { background: var(--surface); }
  .theme-chip.active { border-color: var(--accent); background: var(--accent-soft); }
  .theme-chip .sw {
    width:20px; height:20px; border-radius:50%; flex-shrink:0;
    border:1px solid rgba(127,127,127,0.35); box-shadow: inset 0 0 0 2px rgba(255,255,255,0.15);
  }
  .theme-chip span:last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #readBar select.f-inp { min-height:38px; }

  /* ===== Panels ===== */
  .panel {
    grid-area: main; overflow-y:auto; display:none; min-height:0;
    padding: 16px max(14px, calc((100% - var(--content-w)) / 2)) 20px;
    -webkit-overflow-scrolling:touch; overscroll-behavior: contain;
  }
  .panel.active { display:flex; flex-direction:column; gap:14px; animation: rsFade 0.2s ease; }
  @keyframes rsFade { from { opacity:0; transform: translateY(4px); } to { opacity:1; transform:none; } }
  .panel-title { font-size:20px; font-weight:800; letter-spacing:-0.02em; margin:2px 2px 0; }

  /* ===== Chat Messages ===== */
  #tab-chat { gap:18px; }
  .msg-wrap { display:flex; flex-direction:column; max-width:88%; }
  .msg-wrap.user { align-self:flex-end; align-items:flex-end; }
  .msg-wrap.char { align-self:flex-start; align-items:flex-start; width:100%; max-width:100%; }
  .msg-role { font-size:12px; font-weight:700; color:var(--sub); margin:0 4px 5px; display:flex; align-items:center; gap:7px; }
  .msg-wrap.char .msg-role::before {
    content:''; width:18px; height:18px; border-radius:50%; flex-shrink:0;
    background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 45%, #ffffff));
  }
  [data-theme="ai-gemini"] .msg-wrap.char .msg-role::before { background: linear-gradient(135deg, #4285f4 0%, #9b72cb 60%, #d96570 100%); }
  .msg-wrap.user .msg-role { display:none; }
  .msg-bubble {
    padding:11px 16px; border-radius:20px; font-family: var(--font); font-size:var(--fsize); line-height:var(--lh);
    white-space:pre-wrap; word-break:keep-all; overflow-wrap:anywhere; width:fit-content; max-width:100%;
  }
  .msg-wrap.user .msg-bubble { background:var(--user-bg); color:var(--user-text); border-bottom-right-radius:6px; }
  .msg-wrap.char .msg-bubble { background:var(--surface); color:var(--text); border-bottom-left-radius:6px; }
  /* Official chatbot look: assistant text sits directly on the page */
  [data-theme^="ai-"] .msg-wrap.char .msg-bubble { background:transparent; padding:2px 4px 0 29px; border-radius:0; width:100%; }
  [data-theme^="ai-"] .msg-wrap.char .msg-actions { padding-left:25px; }
  /* EPUB single-page: book prose with a quiet user note */
  [data-theme="epub-1p-day"] .msg-wrap.char .msg-bubble, [data-theme="epub-1p-night"] .msg-wrap.char .msg-bubble {
    background:transparent; padding:0 2px; border-radius:0; width:100%; text-align:justify;
  }
  [data-theme="epub-1p-day"] .msg-wrap.char .msg-role::before, [data-theme="epub-1p-night"] .msg-wrap.char .msg-role::before { display:none; }
  [data-theme="epub-1p-day"] .msg-wrap.char .msg-role, [data-theme="epub-1p-night"] .msg-wrap.char .msg-role {
    width:100%; margin:0 0 10px; gap:10px; font-size:11px; letter-spacing:0.08em; color: color-mix(in srgb, var(--sub) 80%, transparent);
  }
  [data-theme="epub-1p-day"] .msg-wrap.char .msg-role::after, [data-theme="epub-1p-night"] .msg-wrap.char .msg-role::after { content:''; flex:1; height:1px; background:var(--border); }
  [data-theme="epub-1p-day"] .msg-wrap.user, [data-theme="epub-1p-night"] .msg-wrap.user { align-self:stretch; max-width:100%; align-items:stretch; }
  [data-theme="epub-1p-day"] .msg-wrap.user .msg-bubble, [data-theme="epub-1p-night"] .msg-wrap.user .msg-bubble {
    width:100%; border-radius:10px; border-left:3px solid var(--accent); font-size: calc(var(--fsize) - 0.5px);
  }
  [data-theme="epub-1p-day"] .msg-wrap.user .msg-actions, [data-theme="epub-1p-night"] .msg-wrap.user .msg-actions { align-self:flex-end; }
  /* Glass bubbles */
  [data-theme="midnight-glass"] .msg-bubble { -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); border:1px solid var(--border); }
  [data-theme="sakura-pastel"] .msg-wrap.char .msg-bubble, [data-theme="forest-moss"] .msg-wrap.char .msg-bubble { border:1px solid var(--border); }

  .msg-img-wrap { position:relative; display:block; width:fit-content; max-width:100%; margin:12px auto; border-radius:14px; overflow:hidden; cursor:pointer; box-shadow: var(--shadow-sm); }
  .msg-img { max-width:min(320px, 100%); max-height:360px; border-radius:14px; display:block; object-fit:contain; transition:filter 0.25s ease, transform 0.25s ease; }
  body.asset-blur .msg-img-wrap:not(.revealed) .msg-img { filter:blur(22px) brightness(0.72); transform:scale(1.06); }
  .img-veil {
    display:none; position:absolute; inset:0; align-items:center; justify-content:center;
    background:rgba(0,0,0,0.22); color:#fff; font-size:12.5px; font-weight:700; text-shadow:0 1px 4px rgba(0,0,0,0.7);
    pointer-events:none;
  }
  body.asset-blur .msg-img-wrap:not(.revealed) .img-veil { display:flex; }
  body.asset-hide .msg-img-wrap { display:none !important; }

  .msg-actions { display:flex; gap:4px; margin-top:6px; transition: opacity 0.15s ease; }
  .act-btn {
    display:inline-flex; align-items:center; gap:3px; min-height:28px;
    border:1px solid transparent; background:transparent; color:var(--sub);
    border-radius:8px; padding:0 8px; font-size:11.5px; font-weight:600; cursor:pointer;
  }
  .act-btn:hover { background: var(--surface); border-color: var(--border); color: var(--text); }
  @media (hover: hover) and (pointer: fine) {
    .msg-wrap .msg-actions { opacity:0; }
    .msg-wrap:hover .msg-actions, .msg-wrap:focus-within .msg-actions, .msg-wrap:last-child .msg-actions { opacity:1; }
  }
  @media (hover: none) { .msg-actions { opacity:0.75; } }
  .tr-box {
    margin-top:8px; padding:10px 13px; border-radius:12px; font-size:calc(var(--fsize) - 0.5px); line-height:var(--lh);
    background:var(--surface2); border-left:3px solid var(--accent); white-space:pre-wrap; max-width:100%;
  }
  .empty-hint { text-align:center; color:var(--sub); margin:auto; padding:40px 20px; font-size:14px; line-height:1.6; }
  .empty-hint .big { font-size:34px; display:block; margin-bottom:10px; opacity:0.8; }

  /* ===== Custom Module Toggles Accordion ===== */
  .tg-acc { border:1px solid var(--border); border-radius:12px; background:var(--bg); margin:8px 0; overflow:hidden; }
  .tg-acc-head {
    padding:11px 13px; font-size:13.5px; font-weight:700; cursor:pointer; min-height:44px;
    display:flex; align-items:center; justify-content:space-between; background:var(--surface);
  }
  .tg-acc-body { padding:10px 12px; display:none; flex-direction:column; gap:10px; border-top:1px solid var(--border); }
  .tg-acc.open .tg-acc-body { display:flex; }
  .tg-row { display:flex; align-items:center; justify-content:space-between; gap:10px; font-size:13.5px; min-height:36px; }
  .tg-cap { font-size:12px; color:var(--sub); line-height:1.5; margin:2px 0; }
  .tg-div { height:1px; background:var(--border); margin:4px 0; }

  /* ===== EPUB 2-Page Book Mode + 640ms 3D Paper Flip ===== */
  body.book-mode #tab-chat { --content-w: 1240px; padding-top:14px; padding-bottom:8px; }
  .book-shell { flex:1; display:flex; flex-direction:column; min-height:0; position:relative; }
  .book-frame {
    flex:1; display:grid; grid-template-columns:1fr 1fr; gap:0;
    background:var(--book-bg); border:1px solid var(--border); border-radius:12px;
    box-shadow: var(--shadow); overflow:hidden; position:relative;
    perspective:1800px; min-height:0;
  }
  .book-frame.single-page { grid-template-columns:1fr; }
  .book-page {
    padding: clamp(20px, 4vw, 40px) clamp(18px, 4vw, 44px); overflow-y:auto;
    font-family: var(--font); font-size:var(--fsize); line-height:var(--lh);
    white-space:pre-wrap; word-break:keep-all; overflow-wrap:anywhere; position:relative; text-align:justify;
  }
  .book-frame:not(.single-page) .book-page.left { border-right:1px solid var(--border); box-shadow:inset -22px 0 26px -22px var(--book-spine); }
  .book-frame:not(.single-page) .book-page.right { box-shadow:inset 22px 0 26px -22px var(--book-spine); }
  .book-turn-tag { font-family: var(--ui-font); font-size:11px; color:var(--accent); margin-bottom:6px; font-weight:700; letter-spacing:0.04em; }
  .book-user-block { background:var(--user-bg); color:var(--user-text); padding:10px 14px; border-radius:8px; border-left:3px solid var(--accent); margin:10px 0 16px; text-align:left; }
  .book-char-block { margin:6px 0 18px; }

  .epub-flip-leaf {
    position:absolute; top:0; bottom:0; width:50%; pointer-events:none; opacity:0;
    background:var(--leaf-bg); z-index:15; backface-visibility:hidden;
    box-shadow:0 0 26px rgba(0,0,0,0.22);
  }
  .book-frame.single-page .epub-flip-leaf { width:100%; }
  .epub-flip-leaf.flip-next { right:0; transform-origin:left center; animation: rsFlipNext 640ms cubic-bezier(0.32, 0.08, 0.24, 1) forwards; }
  .epub-flip-leaf.flip-prev { left:0; transform-origin:right center; animation: rsFlipPrev 640ms cubic-bezier(0.32, 0.08, 0.24, 1) forwards; }
  @keyframes rsFlipNext { 0% { opacity:0.95; transform:rotateY(0deg); } 50% { opacity:0.98; transform:rotateY(-90deg); } 100% { opacity:0; transform:rotateY(-180deg); } }
  @keyframes rsFlipPrev { 0% { opacity:0.95; transform:rotateY(0deg); } 50% { opacity:0.98; transform:rotateY(90deg); } 100% { opacity:0; transform:rotateY(180deg); } }

  .book-nav { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 2px 2px; flex-shrink:0; font-size:12.5px; color:var(--sub); font-variant-numeric: tabular-nums; }
  .turn-ruler { display:flex; align-items:center; justify-content:center; gap:5px; padding:6px 8px 2px; overflow:hidden; flex-shrink:0; }
  .ruler-tick { width:3px; height:10px; border-radius:2px; background:var(--border); cursor:pointer; transition:all 0.15s; }
  .ruler-tick:hover { background: var(--sub); }
  .ruler-tick.active { height:16px; width:4px; background:var(--accent); }

  /* ===== Composer (capsule) ===== */
  .composer {
    grid-area: composer; display:flex; gap:6px; align-items:flex-end;
    margin: 6px max(10px, calc((100% - var(--content-w)) / 2 + 4px)) 10px;
    padding:6px; border:1px solid var(--border); border-radius:26px;
    background: var(--elev); box-shadow: var(--shadow-sm);
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .composer:focus-within { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); box-shadow: 0 0 0 4px var(--accent-soft); }
  body.book-mode .composer { --content-w: 1240px; }
  .composer .pill { min-height:36px; flex-shrink:0; font-size:12px; }
  .composer textarea {
    flex:1; min-height:36px; max-height:140px; resize:none; padding:8px 6px;
    border:none; background:transparent; font-size:15px; line-height:1.4; outline:none;
  }
  .send-btn {
    height:36px; min-width:36px; padding:0 16px; border-radius:999px; border:none; background:var(--accent);
    color:var(--on-accent); font-weight:700; font-size:13.5px; cursor:pointer; flex-shrink:0;
    transition: opacity 0.15s ease, transform 0.1s ease;
  }
  .send-btn:active { transform: scale(0.95); }
  .send-btn:disabled { opacity:0.4; cursor:default; }

  /* ===== Bottom Nav ===== */
  nav.tabbar {
    grid-area: nav; display:grid; grid-template-columns:repeat(4, 1fr);
    border-top:1px solid var(--border); background: var(--header-bg);
    -webkit-backdrop-filter: saturate(160%) blur(14px); backdrop-filter: saturate(160%) blur(14px);
    padding: 4px env(safe-area-inset-right) calc(4px + env(safe-area-inset-bottom)) env(safe-area-inset-left);
  }
  .tab-btn {
    border:none; background:transparent; color:var(--sub); padding:6px 4px 5px; min-height:54px;
    font-size:11px; font-weight:600; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; cursor:pointer;
  }
  .tab-btn .ic { font-size:17px; line-height:1; padding:5px 18px; border-radius:999px; transition: background 0.18s ease; }
  .tab-btn.active { color:var(--text); }
  .tab-btn.active .ic { background: var(--accent-soft); }

  /* ===== Cards & Forms ===== */
  .card { background:var(--elev); border:1px solid var(--border); border-radius:var(--radius); padding:16px; box-shadow: var(--shadow-sm); }
  [data-theme="midnight-glass"] .card, [data-theme="midnight-glass"] .bot-item { -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); }
  .card h3 { margin:0 0 12px; font-size:15px; font-weight:700; letter-spacing:-0.01em; display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
  .search-inp, .f-inp {
    width:100%; padding:10px 12px; border-radius:var(--radius-sm); border:1px solid var(--border);
    background:var(--bg); font-size:14px; outline:none; min-height:42px;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  textarea.f-inp { line-height:1.5; resize:vertical; }
  .search-inp:focus, .f-inp:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  select.f-inp, select.pill {
    -webkit-appearance:none; appearance:none; padding-right:32px; cursor:pointer;
    background-image: linear-gradient(45deg, transparent 50%, var(--sub) 50%), linear-gradient(135deg, var(--sub) 50%, transparent 50%);
    background-position: calc(100% - 17px) 52%, calc(100% - 12px) 52%;
    background-size: 5px 5px, 5px 5px; background-repeat:no-repeat;
  }
  input[type="checkbox"] {
    -webkit-appearance:none; appearance:none; flex-shrink:0; cursor:pointer; margin:0;
    width:44px !important; height:26px !important; border-radius:999px; position:relative;
    background: var(--surface2); border:1px solid var(--border);
    transition: background 0.18s ease, border-color 0.18s ease;
  }
  input[type="checkbox"]::after {
    content:''; position:absolute; top:2px; left:2px; width:20px; height:20px; border-radius:50%;
    background:#fff; box-shadow: 0 1px 3px rgba(0,0,0,0.3); transition: transform 0.18s ease;
  }
  input[type="checkbox"]:checked { background:var(--accent); border-color:var(--accent); }
  input[type="checkbox"]:checked::after { transform: translateX(18px); background: var(--on-accent); }
  .chk-row { display:flex; align-items:center; justify-content:space-between; gap:12px; font-size:13.5px; padding:9px 0; cursor:pointer; border-bottom:1px solid var(--border); }
  .chk-row:last-of-type { border-bottom:none; }

  .bot-item { background:var(--elev); border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; box-shadow: var(--shadow-sm); transition: border-color 0.15s ease; }
  .bot-item:hover { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
  .bot-head { padding:13px 14px; min-height:54px; display:flex; align-items:center; justify-content:space-between; gap:10px; cursor:pointer; }
  .bot-head > div:first-child { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .bot-head > div:last-child { flex-shrink:0; }
  .badge { display:inline-flex; align-items:center; font-size:11px; padding:3px 8px; border-radius:999px; background:var(--surface2); color:var(--sub); font-weight:700; white-space:nowrap; }
  .badge.pc { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
  .chat-list { border-top:1px solid var(--border); background:var(--surface); padding:8px; display:flex; flex-direction:column; gap:6px; }
  .chat-row { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; min-height:44px; border-radius:10px; background:var(--elev); border:1px solid transparent; cursor:pointer; font-size:13.5px; transition: border-color 0.15s ease; }
  .chat-row:hover { border-color: var(--border); }
  .chat-row > span:first-child { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chat-row.cur { border-color:var(--accent); background: var(--accent-soft); font-weight:700; }
  .row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:11px 0; border-bottom:1px solid var(--border); }
  .row:last-child { border-bottom:none; }
  .f-label { display:block; font-size:12px; font-weight:600; color:var(--sub); margin:12px 0 5px; }
  .btn {
    display:inline-flex; align-items:center; justify-content:center; gap:5px;
    border:1px solid transparent; border-radius:var(--radius-sm); padding:0 14px; min-height:38px;
    font-size:13px; font-weight:700; cursor:pointer; background:var(--accent); color:var(--on-accent);
    transition: filter 0.15s ease, transform 0.1s ease, background 0.15s ease;
  }
  .btn:hover { filter: brightness(1.06); }
  .btn:active { transform: scale(0.97); }
  .btn.sec { background:var(--surface); color:var(--text); border-color: var(--border); }
  .btn.sec:hover { background: var(--surface2); filter:none; }
  .btn.danger { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); border-color: color-mix(in srgb, var(--danger) 30%, transparent); }
  .btn-row { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; background:var(--bg); padding:9px 11px; border-radius:10px; border:1px solid var(--border); word-break:break-all; }
  .hint { font-size:12px; color:var(--sub); line-height:1.6; margin-top:8px; }
  .param-grid { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:10px; align-items:end; }
  .param-grid .f-label { margin-top:0; }
  .grid-2 { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:10px; }

  /* ===== Login ===== */
  #login { position:fixed; inset:0; background: var(--bg-grad), var(--bg); display:flex; align-items:center; justify-content:center; padding:20px; z-index:99; }
  .login-card { width:100%; max-width:380px; background:var(--elev); border:1px solid var(--border); border-radius:22px; padding:28px 24px 24px; box-shadow: var(--shadow); }
  .login-mark { width:52px; height:52px; border-radius:16px; display:flex; align-items:center; justify-content:center; font-size:26px; background: var(--accent-soft); margin-bottom:16px; }
  .login-card h2 { margin:0 0 6px; font-size:20px; font-weight:800; letter-spacing:-0.02em; }
  .login-card p { margin:0 0 18px; font-size:13.5px; color:var(--sub); line-height:1.6; }

  /* ===== Toast ===== */
  #toast {
    position:fixed; top: calc(14px + env(safe-area-inset-top)); left:50%; z-index:120;
    transform:translate(-50%, -12px); opacity:0; pointer-events:none;
    background: color-mix(in srgb, var(--text) 92%, transparent); color: var(--bg);
    padding:10px 16px; border-radius:999px; font-size:13px; font-weight:600; max-width: calc(100vw - 32px);
    box-shadow:0 10px 28px rgba(0,0,0,0.25); transition: opacity 0.2s ease, transform 0.2s ease;
  }
  #toast.show { opacity:1; transform:translate(-50%, 0); }

  /* ===== Responsive ===== */
  /* Prevent iOS focus-zoom on touch devices */
  @media (pointer: coarse) {
    .f-inp, .search-inp, .composer textarea, #readBar select { font-size:16px; }
  }
  /* Korean keep-all + justify leaves wide gaps on narrow columns */
  @media (max-width: 600px) {
    .book-page, [data-theme^="epub-1p"] .msg-wrap.char .msg-bubble { text-align:left !important; }
  }
  @media (max-width: 380px) {
    .h-right { gap:4px; }
    .icon-pill { width:34px; height:34px; }
    .composer .pill { padding:0 8px; }
    .param-grid { grid-template-columns: 1fr 1fr; }
  }
  /* Landscape phones: reclaim vertical space */
  @media (max-height: 500px) and (orientation: landscape) {
    header { padding-top: calc(4px + env(safe-area-inset-top)); padding-bottom:4px; }
    .h-sub { display:none; }
    .tab-btn { min-height:40px; flex-direction:row; gap:6px; font-size:12px; }
    .tab-btn .ic { padding:3px 10px; }
    .composer { margin-bottom:6px; }
  }
  /* Tablet / Desktop: side navigation rail */
  @media (min-width: 900px) {
    #app {
      grid-template-columns: 92px minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr) auto;
      grid-template-areas: "nav header" "nav main" "nav composer";
    }
    nav.tabbar {
      grid-template-columns: 1fr; grid-auto-rows: min-content; align-content: start; gap:4px;
      border-top:none; border-right:1px solid var(--border);
      padding: calc(14px + env(safe-area-inset-top)) 8px 14px max(8px, env(safe-area-inset-left));
    }
    nav.tabbar::before {
      content:'📖'; display:flex; align-items:center; justify-content:center;
      width:44px; height:44px; margin:0 auto 14px; border-radius:14px; font-size:22px;
      background: var(--accent-soft);
    }
    .tab-btn { min-height:64px; border-radius:14px; font-size:11.5px; gap:5px; }
    .tab-btn:hover { color: var(--text); }
    .tab-btn:hover .ic { background: var(--surface); }
    .tab-btn.active .ic { background: var(--accent-soft); }
    header { padding-left: 20px; padding-right: 20px; }
    .panel { padding-top: 22px; }
    #tab-modules.active, #tab-router.active {
      display:grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); align-items:start; align-content:start;
      --content-w: 1160px;
    }
    #tab-modules .panel-title, #tab-router .panel-title { grid-column: 1 / -1; }
    #tab-bots { --content-w: 760px; }
    .composer { margin-bottom: 16px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }
</style>
</head>
<body>
<div id="toast" role="status" aria-live="polite"></div>

<div id="login">
  <div class="login-card">
    <div class="login-mark">📖</div>
    <h2>RisuStand Remote</h2>
    <p>PC 터미널에 출력된 보안 토큰을 입력하세요.<br>한 번 로그인하면 이 기기에 저장됩니다.</p>
    <input class="f-inp" id="tokInput" type="password" placeholder="보안 토큰 입력" autocomplete="current-password" style="margin-bottom:10px;" />
    <button class="btn" id="loginBtn" style="width:100%; min-height:46px; font-size:14.5px;">접속하기</button>
    <div id="loginErr" style="color:var(--danger); font-size:12.5px; margin-top:10px; min-height:1em;"></div>
  </div>
</div>

<div id="app" style="display:none;">
  <header>
    <div class="h-left" onclick="switchTab('bots')" style="cursor:pointer;" title="봇/채팅방 목록">
      <span class="dot" id="pcDot"></span>
      <div style="min-width:0;">
        <div class="h-title" id="hdrChar">연결 중...</div>
        <div class="h-sub" id="hdrSub">-</div>
      </div>
    </div>
    <div class="h-right">
      <button class="pill icon-pill" id="assetCycleBtn" title="에셋 표시 / 가리기 / 감추기" aria-label="에셋 표시 모드">🖼️</button>
      <button class="pill icon-pill" id="autoTrBtn" title="응답 자동 번역" aria-label="응답 자동 번역">🌐</button>
      <button class="pill icon-pill" id="readBarToggle" title="테마·글꼴·에셋 설정" aria-label="화면 설정" aria-expanded="false" style="font-weight:800;">Aa</button>
    </div>

    <div class="read-bar" id="readBar" role="dialog" aria-label="화면 설정">
      <div class="rb-sec">
        <div class="rb-label">테마</div>
        <div class="theme-grid" id="themeGrid">
          <button class="theme-chip" data-theme-key="ai-gemini"><span class="sw" style="background:linear-gradient(135deg,#ffffff 50%,#0b57d0 50%)"></span><span>Gemini</span></button>
          <button class="theme-chip" data-theme-key="ai-claude"><span class="sw" style="background:linear-gradient(135deg,#faf9f5 50%,#c96442 50%)"></span><span>Claude</span></button>
          <button class="theme-chip" data-theme-key="ai-chatgpt"><span class="sw" style="background:linear-gradient(135deg,#ffffff 50%,#0d0d0d 50%)"></span><span>ChatGPT</span></button>
          <button class="theme-chip" data-theme-key="midnight-glass"><span class="sw" style="background:linear-gradient(135deg,#0a0f1f 50%,#8ea2ff 50%)"></span><span>미드나잇 글래스</span></button>
          <button class="theme-chip" data-theme-key="epub-1p-day"><span class="sw" style="background:linear-gradient(135deg,#f4efe6 50%,#8c5a2b 50%)"></span><span>세피아 · 스크롤</span></button>
          <button class="theme-chip" data-theme-key="epub-1p-night"><span class="sw" style="background:linear-gradient(135deg,#141518 50%,#d2a86e 50%)"></span><span>다크 · 스크롤</span></button>
          <button class="theme-chip" data-theme-key="epub-2p-day"><span class="sw" style="background:linear-gradient(135deg,#f8f3e9 50%,#8c5a2b 50%)"></span><span>세피아 · 종이책</span></button>
          <button class="theme-chip" data-theme-key="epub-2p-night"><span class="sw" style="background:linear-gradient(135deg,#1a1b20 50%,#d2a86e 50%)"></span><span>다크 · 종이책</span></button>
          <button class="theme-chip" data-theme-key="sakura-pastel"><span class="sw" style="background:linear-gradient(135deg,#fff8fb 50%,#c2477a 50%)"></span><span>사쿠라 파스텔</span></button>
          <button class="theme-chip" data-theme-key="forest-moss"><span class="sw" style="background:linear-gradient(135deg,#111a15 50%,#6cc493 50%)"></span><span>포레스트 모스</span></button>
        </div>
      </div>
      <div class="rb-sec">
        <div class="rb-label">글꼴 · 크기</div>
        <div class="rb-grp" style="flex-wrap:nowrap;">
          <select class="f-inp" id="fontSel" style="flex:1; min-width:0;">
            <option value="system">시스템 기본</option>
            <option value="serif">전자책 명조</option>
            <option value="sans">눈 편한 고딕</option>
          </select>
          <button class="pill icon-pill" id="fsDec" aria-label="글자 작게" style="font-size:12px;">A-</button>
          <span class="rb-val" id="fsVal">15.5</span>
          <button class="pill icon-pill" id="fsInc" aria-label="글자 크게" style="font-size:15px;">A+</button>
        </div>
        <button class="pill" id="lhBtn" style="align-self:flex-start;">줄간격 1.75</button>
      </div>
      <div class="rb-sec">
        <div class="rb-label">에셋 (이미지)</div>
        <div class="seg">
          <button class="pill" id="amShow" onclick="setAssetMode('show')">🖼️ 표시</button>
          <button class="pill" id="amBlur" onclick="setAssetMode('blur')">🌫️ 가리기</button>
          <button class="pill" id="amHide" onclick="setAssetMode('hide')">🙈 감추기</button>
        </div>
      </div>
    </div>
  </header>

  <!-- TAB 1: CHAT / EPUB READER -->
  <section class="panel active" id="tab-chat"></section>
  <div class="composer" id="composerBar">
    <button class="pill" id="inTrBtn" title="입력 한→영 자동 번역">한→영</button>
    <textarea id="msgInput" rows="1" placeholder="메시지를 입력하세요..."></textarea>
    <button class="send-btn" id="sendBtn">전송</button>
  </div>

  <!-- TAB 2: BOTS & CHATS -->
  <section class="panel" id="tab-bots">
    <div class="panel-title">봇 · 채팅방</div>
    <div style="display:flex; gap:8px;">
      <input class="search-inp" id="botSearch" placeholder="봇 이름 검색..." />
      <button class="btn sec" id="refreshAllBtn" style="flex-shrink:0;">새로고침</button>
    </div>
    <div id="botList" style="display:flex; flex-direction:column; gap:8px;"></div>
  </section>

  <!-- TAB 3: MODULES & PARAMS -->
  <section class="panel" id="tab-modules">
    <div class="panel-title">모듈 · 설정</div>
    <div class="card" id="customToggleCard">
      <h3>
        <span>🎛️ 모듈 · 프리셋 토글</span>
        <span style="display:flex; gap:5px; align-items:center;">
          <button class="pill" onclick="togglePresetAdder()">+ 프리셋 토글</button>
          <span id="localToggleBadge" class="badge">로컬 토글</span>
        </span>
      </h3>
      <div id="presetToggleAdder" style="display:none; margin-bottom:12px; padding:12px; border-radius:12px; background:var(--bg); border:1px solid var(--border);">
        <div style="font-size:11.5px; color:var(--sub); line-height:1.5; margin-bottom:6px;">
          RisuAI 보안 정책상 프롬프트 프리셋 토글은 플러그인이 직접 읽을 수 없습니다. PC RisuAI 프리셋 설정의 <b>커스텀 토글</b> 텍스트를 아래에 한 번만 붙여넣어 두면, 모든 체크박스·드롭다운이 로컬 토글로 즉시 연동됩니다.
        </div>
        <input class="f-inp" id="ptName" placeholder="프리셋 이름 (예: Leave · 방랑 사서의 서가 r1.1)" style="margin-bottom:6px;" />
        <textarea class="f-inp" id="ptSyntax" rows="5" placeholder="RisuAI 프리셋의 커스텀 토글 텍스트를 그대로 붙여넣기..."></textarea>
        <div class="btn-row">
          <button class="btn" onclick="savePresetToggle()">저장</button>
          <button class="btn sec" onclick="togglePresetAdder(false)">취소</button>
        </div>
      </div>
      <div id="customToggleBody" style="font-size:12.5px; color:var(--sub);">활성화된 모듈에 커스텀 토글이 없습니다.</div>
      <label class="chk-row" style="margin-top:12px; border-top:1px solid var(--border); border-bottom:none; padding-bottom:0;">
        <span>로컬 토글 사용 <span style="color:var(--sub); font-size:12px;">(원격 토글 제어에 필요)</span></span>
        <input type="checkbox" id="localToggleChk" />
      </label>
    </div>
    <div class="card">
      <h3>👤 페르소나 선택</h3>
      <select class="f-inp" id="personaSel"></select>
    </div>
    <div class="card">
      <h3>🎛️ RisuAI 기본 파라미터</h3>
      <div class="param-grid">
        <div><span class="f-label">Temperature (×100)</span><input class="f-inp" id="pTemp" type="number" /></div>
        <div><span class="f-label">Max Context</span><input class="f-inp" id="pCtx" type="number" /></div>
        <div><span class="f-label">Max Response</span><input class="f-inp" id="pResp" type="number" /></div>
      </div>
      <div class="btn-row"><button class="btn" id="saveParamsBtn">파라미터 RisuAI 반영</button></div>
    </div>
    <div class="card">
      <h3>🧩 모듈 관리 <span id="modCount" class="badge">0</span></h3>
      <input class="search-inp" id="modSearch" placeholder="모듈 검색..." style="margin-bottom:8px;" />
      <div id="modList"></div>
    </div>
  </section>

  <!-- TAB 4: MODEL ROUTER & TRANSLATOR -->
  <section class="panel" id="tab-router">
    <div class="panel-title">모델 · 번역</div>
    <div class="card">
      <h3>🔗 PC RisuAI 프록시 연동 주소</h3>
      <div class="mono">http://127.0.0.1:8787/v1/chat/completions</div>
      <div class="hint">
        PC RisuAI의 모델(Reverse Proxy / OpenAI 호환) URL을 위 주소로 한 번만 지정하면, 아래에서 고른 모델·프롬프트가 실시간 반영됩니다.
      </div>
    </div>

    <div class="card">
      <h3>⚡ 모델 프로필 (릴레이 라우터)</h3>
      <div id="profileList" style="display:flex; flex-direction:column; gap:6px; margin-bottom:10px;"></div>
      <div class="btn-row">
        <button class="btn sec" onclick="openNewProfile('openrouter')">+ OpenRouter</button>
        <button class="btn sec" onclick="openNewProfile('gemini')">+ Gemini</button>
        <button class="btn sec" onclick="openNewProfile('claude')">+ Claude</button>
        <button class="btn sec" onclick="openNewProfile('openai')">+ OpenAI/커스텀</button>
      </div>
    </div>

    <div class="card" id="profileEditor" style="display:none;">
      <h3 id="edTitle">프로필 편집</h3>
      <input type="hidden" id="edId" />
      <label class="f-label">프로필 이름</label>
      <input class="f-inp" id="edName" />
      <label class="f-label">프로바이더 포맷</label>
      <select class="f-inp" id="edType">
        <option value="openai_compat">OpenAI 호환 (OpenRouter / OpenAI / DeepSeek / Ollama)</option>
        <option value="gemini">Google Gemini API</option>
        <option value="anthropic">Anthropic Claude API</option>
      </select>
      <label class="f-label">API 엔드포인트 URL</label>
      <input class="f-inp" id="edUrl" />
      <label class="f-label">API 키 (PC 로컬 파일에만 저장, 비우면 기존 유지)</label>
      <input class="f-inp" id="edKey" type="password" placeholder="새 키 입력 또는 비워두기" />
      <label class="f-label">모델 ID</label>
      <input class="f-inp" id="edModel" placeholder="예: anthropic/claude-3.7-sonnet, gemini-2.5-pro" />
      <div class="grid-2">
        <div><label class="f-label">Temperature 덮어쓰기</label><input class="f-inp" id="edTemp" placeholder="비우면 유지" /></div>
        <div><label class="f-label">Max Tokens 덮어쓰기</label><input class="f-inp" id="edMaxTok" placeholder="비우면 유지" /></div>
      </div>
      <label class="f-label">원격 시스템 프롬프트 오버라이드</label>
      <select class="f-inp" id="edOvMode">
        <option value="off">사용 안 함 (RisuAI 원본 그대로)</option>
        <option value="append">기존 시스템 프롬프트 뒤에 추가</option>
        <option value="prepend">맨 앞 시스템 지침으로 추가</option>
        <option value="replace">시스템 프롬프트 전체 교체</option>
      </select>
      <textarea class="f-inp" id="edOvText" rows="3" placeholder="원격에서 덧씌울 지침/프리셋 (선택)" style="margin-top:6px;"></textarea>
      <div class="btn-row">
        <button class="btn" id="saveProfBtn">저장</button>
        <button class="btn sec" onclick="document.getElementById('profileEditor').style.display='none'">취소</button>
        <button class="btn danger" id="delProfBtn" style="margin-left:auto;">삭제</button>
      </div>
    </div>

    <div class="card">
      <h3>🌐 자체 번역기 설정</h3>
      <label class="chk-row"><span>활성 모델 프로필을 번역에도 공용 사용</span><input type="checkbox" id="trUseActive" /></label>
      <label class="chk-row"><span>AI 응답 자동 한국어 번역 표시</span><input type="checkbox" id="trAutoOut" /></label>
      <label class="chk-row"><span>내 입력 자동 한→영 번역 후 전송</span><input type="checkbox" id="trAutoIn" /></label>
      <div id="trCustomBox">
        <label class="f-label">전용 번역 프로바이더</label>
        <select class="f-inp" id="trType">
          <option value="gemini">Google Gemini (추천: gemini-2.5-flash)</option>
          <option value="openai_compat">OpenAI 호환 (OpenRouter 등)</option>
          <option value="anthropic">Anthropic Claude</option>
        </select>
        <label class="f-label">전용 번역 엔드포인트</label>
        <input class="f-inp" id="trUrl" />
        <label class="f-label">전용 번역 API 키 (비우면 기존 유지)</label>
        <input class="f-inp" id="trKey" type="password" placeholder="API 키" />
        <label class="f-label">전용 번역 모델 ID</label>
        <input class="f-inp" id="trModel" />
      </div>
      <label class="f-label">응답 번역 프롬프트</label>
      <textarea class="f-inp" id="trPrompt" rows="2"></textarea>
      <div class="btn-row"><button class="btn" id="saveTrBtn">번역 설정 저장</button></div>
    </div>
  </section>

  <nav class="tabbar">
    <button class="tab-btn active" data-tab="chat" onclick="switchTab('chat')"><span class="ic">📖</span>독서/채팅</button>
    <button class="tab-btn" data-tab="bots" onclick="switchTab('bots')"><span class="ic">📚</span>봇/방</button>
    <button class="tab-btn" data-tab="modules" onclick="switchTab('modules')"><span class="ic">🧩</span>모듈/설정</button>
    <button class="tab-btn" data-tab="router" onclick="switchTab('router')"><span class="ic">⚡</span>모델/번역</button>
  </nav>
</div>

<script>
  let token = localStorage.getItem('rs_token') || '';
  let currentTab = 'chat';
  let lastState = null;
  let routerCfg = null;
  let expandedBotIdx = -1;
  let lastChatRenderSig = '';
  let bookSpreadIdx = -1; // -1 means auto-jump to latest spread
  const localTranslations = new Map();
  const shownTranslations = new Set();

  // RisuStand Reading Preferences
  let uiPref = {
    theme: localStorage.getItem('rs_theme') || 'ai-gemini',
    font: localStorage.getItem('rs_font') || 'serif',
    fsize: Number(localStorage.getItem('rs_fsize')) || 15.5,
    lh: Number(localStorage.getItem('rs_lh')) || 1.75,
    assetMode: localStorage.getItem('rs_asset_mode') || (localStorage.getItem('rs_stealth') === '1' ? 'hide' : 'show'),
  };
  const openToggleGroups = new Set();

  function isBookMode() {
    return uiPref.theme === 'epub-2p-day' || uiPref.theme === 'epub-2p-night';
  }

  function applyUiPrefs() {
    document.documentElement.setAttribute('data-theme', uiPref.theme);
    document.documentElement.setAttribute('data-font', uiPref.font);
    document.documentElement.style.setProperty('--fsize', uiPref.fsize + 'px');
    document.documentElement.style.setProperty('--lh', String(uiPref.lh));
    document.body.classList.toggle('asset-blur', uiPref.assetMode === 'blur');
    document.body.classList.toggle('asset-hide', uiPref.assetMode === 'hide');
    document.querySelectorAll('.theme-chip').forEach((c) => c.classList.toggle('active', c.getAttribute('data-theme-key') === uiPref.theme));
    document.body.classList.toggle('book-mode', isBookMode());
    const bgCol = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bgCol) document.getElementById('themeColorMeta').setAttribute('content', bgCol);
    document.getElementById('fontSel').value = uiPref.font;
    document.getElementById('fsVal').textContent = uiPref.fsize.toFixed(1);
    document.getElementById('lhBtn').textContent = '줄간격 ' + uiPref.lh.toFixed(2);
    const amIcons = { show: '🖼️', blur: '🌫️', hide: '🙈' };
    const acb = document.getElementById('assetCycleBtn');
    acb.textContent = amIcons[uiPref.assetMode] || '🖼️';
    acb.className = 'pill icon-pill' + (uiPref.assetMode !== 'show' ? ' active' : '');
    document.getElementById('amShow').className = 'pill' + (uiPref.assetMode === 'show' ? ' active' : '');
    document.getElementById('amBlur').className = 'pill' + (uiPref.assetMode === 'blur' ? ' active' : '');
    document.getElementById('amHide').className = 'pill' + (uiPref.assetMode === 'hide' ? ' active' : '');
    localStorage.setItem('rs_theme', uiPref.theme);
    localStorage.setItem('rs_font', uiPref.font);
    localStorage.setItem('rs_fsize', String(uiPref.fsize));
    localStorage.setItem('rs_lh', String(uiPref.lh));
    localStorage.setItem('rs_asset_mode', uiPref.assetMode);
  }
  window.toggleImgReveal = (el) => { if (el) el.classList.toggle('revealed'); };
  window.setAssetMode = (mode) => {
    uiPref.assetMode = mode;
    applyUiPrefs();
    if (lastState) applyState(lastState);
    const labels = { show: '에셋 표시', blur: '에셋 가리기 (터치 시 확인)', hide: '에셋 완전 감추기 (스텔스)' };
    toast(labels[mode] || mode);
  };
  document.getElementById('assetCycleBtn').onclick = () => {
    const order = ['show', 'blur', 'hide'];
    const next = order[(order.indexOf(uiPref.assetMode) + 1) % order.length];
    window.setAssetMode(next);
  };

  function setReadBar(open) {
    const bar = document.getElementById('readBar');
    bar.classList.toggle('open', open);
    const btn = document.getElementById('readBarToggle');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.classList.toggle('active', open);
  }
  document.getElementById('readBarToggle').onclick = (e) => {
    e.stopPropagation();
    setReadBar(!document.getElementById('readBar').classList.contains('open'));
  };
  document.addEventListener('click', (e) => {
    const bar = document.getElementById('readBar');
    if (bar.classList.contains('open') && !bar.contains(e.target)) setReadBar(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setReadBar(false); });
  document.querySelectorAll('.theme-chip').forEach((chip) => {
    chip.onclick = () => setTheme(chip.getAttribute('data-theme-key'));
  });
  function setTheme(key) {
    uiPref.theme = key;
    if (uiPref.theme.startsWith('epub')) uiPref.font = 'serif';
    else if (uiPref.theme.startsWith('ai-')) uiPref.font = 'system';
    bookSpreadIdx = -1;
    applyUiPrefs();
    renderChat();
  }
  document.getElementById('fontSel').onchange = (e) => { uiPref.font = e.target.value; applyUiPrefs(); };
  document.getElementById('fsDec').onclick = () => { uiPref.fsize = Math.max(12, uiPref.fsize - 0.5); applyUiPrefs(); };
  document.getElementById('fsInc').onclick = () => { uiPref.fsize = Math.min(24, uiPref.fsize + 0.5); applyUiPrefs(); };
  document.getElementById('lhBtn').onclick = () => {
    const steps = [1.55, 1.75, 1.95, 2.1];
    const idx = steps.findIndex((v) => Math.abs(v - uiPref.lh) < 0.05);
    uiPref.lh = steps[(idx + 1) % steps.length];
    applyUiPrefs();
  };

  window.addEventListener('resize', () => { if (isBookMode()) renderChat(); });
  applyUiPrefs();

  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(window._tt);
    window._tt = setTimeout(() => { el.classList.remove('show'); }, 2400);
  }

  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function stripImgTokens(t) {
    return String(t || '').replace(/\\[\\[RSIMG:\\d+\\]\\]/g, '').replace(/\\n{3,}/g, '\\n\\n').trim();
  }

  function renderInlineBody(text, images) {
    const imgs = Array.isArray(images) ? images : [];
    const used = new Set();
    let html = esc(text || '').replace(/\\[\\[RSIMG:(\\d+)\\]\\]/g, (_, nStr) => {
      const idx = Number(nStr);
      if (imgs[idx]) {
        used.add(idx);
        return '<span class="msg-img-wrap" onclick="toggleImgReveal(this)"><img class="msg-img" src="' + imgs[idx] + '" /><span class="img-veil">🌫️ 터치해 보기</span></span>';
      }
      return '';
    });
    for (let i = 0; i < imgs.length; i++) {
      if (!used.has(i) && imgs[i]) {
        html += '<span class="msg-img-wrap" onclick="toggleImgReveal(this)"><img class="msg-img" src="' + imgs[i] + '" /><span class="img-veil">🌫️ 터치해 보기</span></span>';
      }
    }
    return html;
  }


  function displayBotName(rawName) {
    if (uiPref.assetMode !== 'hide') return rawName || 'Character';
    if (uiPref.theme === 'ai-claude') return 'Claude';
    if (uiPref.theme === 'ai-chatgpt') return 'ChatGPT';
    if (uiPref.theme === 'ai-gemini') return 'Gemini';
    return '문서 뷰어';
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'X-RisuStand-Token': token, ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.getElementById('tab-' + tab).classList.add('active');
    document.querySelector('.tab-btn[data-tab="' + tab + '"]').classList.add('active');
    document.getElementById('composerBar').style.display = tab === 'chat' ? 'flex' : 'none';
    if (tab === 'router') loadRouterConfig();
    if (tab === 'bots') renderBots();
    if (tab === 'modules') renderModules();
  }

  async function tryLogin(t) {
    token = t.trim();
    try {
      const st = await api('/api/state');
      localStorage.setItem('rs_token', token);
      document.getElementById('login').style.display = 'none';
      document.getElementById('app').style.display = 'grid';
      await loadRouterConfig();
      applyState(st);
      setInterval(pollState, 2000);
    } catch (e) {
      document.getElementById('loginErr').textContent = '토큰이 올바르지 않습니다.';
    }
  }

  document.getElementById('loginBtn').onclick = () => tryLogin(document.getElementById('tokInput').value);
  document.getElementById('tokInput').onkeydown = (e) => { if (e.key === 'Enter') document.getElementById('loginBtn').click(); };

  async function pollState() {
    try { applyState(await api('/api/state')); } catch (_) {}
  }

  function applyState(st) {
    lastState = st;
    const snap = st.snapshot || {};
    document.getElementById('pcDot').className = 'dot' + (st.pcConnected ? ' on' : '');
    document.getElementById('hdrChar').textContent = displayBotName(snap.charName || 'PC 연결 대기');
    const modeTag = snap.isPcActive ? 'PC 활성' : '원격 라우팅';
    const genTag = (st.generating || st.directGenerating) ? ' · ✨ 생성 중...' : '';
    document.getElementById('hdrSub').textContent = (uiPref.assetMode === 'hide' ? '대화' : (snap.chatName || '채팅방')) + ' · ' + modeTag + genTag;
    document.getElementById('sendBtn').disabled = Boolean(st.generating || st.directGenerating);

    const msgs = snap.messages || [];
    const sig = JSON.stringify([snap.charIndex, snap.chatIndex, msgs.length, msgs.length ? msgs[msgs.length-1].text.length : 0, st.generating, st.directGenerating, uiPref.theme, uiPref.assetMode]);
    if (sig !== lastChatRenderSig) {
      lastChatRenderSig = sig;
      renderChat();
    }
    if (currentTab === 'bots') renderBots();
    if (currentTab === 'modules') renderModules();
  }

  function buildBookPages(msgs) {
    // Group messages into comfortable book pages (~900 chars per page)
    const pages = [];
    let cur = [];
    let curLen = 0;
    for (const m of msgs) {
      const len = (m.text || '').length + 120;
      if (cur.length && curLen + len > 950) {
        pages.push(cur);
        cur = [];
        curLen = 0;
      }
      cur.push(m);
      curLen += len;
    }
    if (cur.length) pages.push(cur);
    if (!pages.length) pages.push([]);
    return pages;
  }

  function renderBookPageContent(pageMsgs, snap) {
    if (!pageMsgs || !pageMsgs.length) return '<div style="color:var(--sub); font-size:13px; text-align:center; margin-top:30px;">빈 페이지</div>';
    let out = '';
    for (const m of pageMsgs) {
      const isUser = m.role === 'user';
      const key = snap.charIndex + ':' + snap.chatIndex + ':' + m.index;
      const trText = localTranslations.get(key);
      const showTr = shownTranslations.has(key);
      out += '<div class="' + (isUser ? 'book-user-block' : 'book-char-block') + '">';
      out += '<div class="book-turn-tag">' + esc(isUser ? '나' : displayBotName(snap.charName)) + '</div>';
      out += '<div>' + (showTr && trText ? esc(trText) : renderInlineBody(m.text, m.images)) + '</div>';
      if (m.text) {
        out += '<div class="msg-actions"><button class="act-btn" onclick="toggleTranslate(\\'' + key + '\\', ' + m.index + ')">🌐 ' + (showTr ? '원문' : '번역') + '</button></div>';
      }
      out += '</div>';
    }
    return out;
  }

  let flipDirPending = '';
  function flipBook(delta) {
    flipDirPending = delta > 0 ? 'flip-next' : 'flip-prev';
    bookSpreadIdx += delta;
    renderChat(true);
  }

  function renderChat(animateFlip = false) {
    const box = document.getElementById('tab-chat');
    const snap = (lastState && lastState.snapshot) || {};
    const msgs = snap.messages || [];

    if (isBookMode()) {
      const pages = buildBookPages(msgs);
      const single = window.innerWidth < 700;
      const perSpread = single ? 1 : 2;
      const totalSpreads = Math.max(1, Math.ceil(pages.length / perSpread));
      if (bookSpreadIdx < 0 || bookSpreadIdx >= totalSpreads) bookSpreadIdx = totalSpreads - 1;

      const leftIdx = bookSpreadIdx * perSpread;
      const rightIdx = leftIdx + 1;
      const leftHtml = renderBookPageContent(pages[leftIdx], snap);
      const rightHtml = !single ? renderBookPageContent(pages[rightIdx], snap) : '';

      const pageLabel = single
        ? ((leftIdx + 1) + ' / ' + pages.length + '쪽')
        : ((leftIdx + 1) + '-' + Math.min(rightIdx + 1, pages.length) + '쪽 (' + (bookSpreadIdx + 1) + ' / ' + totalSpreads + ' 펼침)');

      let ruler = '';
      for (let i = 0; i < totalSpreads; i++) {
        ruler += '<div class="ruler-tick' + (i === bookSpreadIdx ? ' active' : '') + '" onclick="bookSpreadIdx=' + i + '; renderChat(false);"></div>';
      }

      box.innerHTML =
        '<div class="book-shell">' +
          '<div class="book-frame' + (single ? ' single-page' : '') + '" id="bookFrame">' +
            '<div class="book-page left">' + leftHtml + '</div>' +
            (single ? '' : '<div class="book-page right">' + rightHtml + '</div>') +
            '<div class="epub-flip-leaf' + (animateFlip && flipDirPending ? ' ' + flipDirPending : '') + '" id="flipLeaf"></div>' +
          '</div>' +
          '<div class="book-nav">' +
            '<button class="pill" ' + (bookSpreadIdx <= 0 ? 'disabled' : '') + ' onclick="flipBook(-1)">◀ 이전</button>' +
            '<span>' + pageLabel + '</span>' +
            '<button class="pill" ' + (bookSpreadIdx >= totalSpreads - 1 ? 'disabled' : '') + ' onclick="flipBook(1)">다음 ▶</button>' +
          '</div>' +
          '<div class="turn-ruler">' + ruler + '</div>' +
        '</div>';

      // Touch swipe support for mobile/tablet book flipping
      const frame = document.getElementById('bookFrame');
      let sx = 0, sy = 0;
      frame.ontouchstart = (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; };
      frame.ontouchend = (e) => {
        const dx = e.changedTouches[0].clientX - sx;
        const dy = e.changedTouches[0].clientY - sy;
        if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.3) {
          if (dx < 0 && bookSpreadIdx < totalSpreads - 1) flipBook(1);
          else if (dx > 0 && bookSpreadIdx > 0) flipBook(-1);
        }
      };
      flipDirPending = '';
      return;
    }

    // Standard Scroll Mode (Gemini / Claude / ChatGPT / EPUB 1p / Glass / Sakura / Moss)
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    const autoTr = Boolean(routerCfg && routerCfg.translator && routerCfg.translator.autoTranslateOutput);

    let html = '';
    if (!msgs.length) {
      html = '<div class="empty-hint"><span class="big">💬</span>대화가 비어 있습니다.<br>아래에서 메시지를 보내 시작해 보세요.</div>';
    } else {
      for (const m of msgs) {
        const key = snap.charIndex + ':' + snap.chatIndex + ':' + m.index;
        const isUser = m.role === 'user';
        const trText = localTranslations.get(key);
        const showTr = shownTranslations.has(key) || (autoTr && !isUser && trText);
        html += '<div class="msg-wrap ' + (isUser ? 'user' : 'char') + '">';
        html += '<div class="msg-role">' + esc(isUser ? '나' : displayBotName(snap.charName)) + '</div>';
        html += '<div class="msg-bubble">' + renderInlineBody(m.text, m.images) + '</div>';
        if (showTr && trText) html += '<div class="tr-box">' + esc(trText) + '</div>';
        html += '<div class="msg-actions">';
        if (m.text) html += '<button class="act-btn" onclick="toggleTranslate(\\'' + key + '\\', ' + m.index + ')">🌐 ' + (showTr ? '번역 숨김' : '번역') + '</button>';
        if (m.index >= 0) {
          html += '<button class="act-btn" onclick="editMsg(' + m.index + ')">✏️ 수정</button>';
          html += '<button class="act-btn" onclick="delMsg(' + m.index + ')">🗑️ 삭제</button>';
        }
        html += '</div></div>';
        if (autoTr && !isUser && m.text && !localTranslations.has(key)) autoFetchTranslation(key, m.text);
      }
    }
    box.innerHTML = html;
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  async function autoFetchTranslation(key, text) {
    localTranslations.set(key, '번역 중...');
    try {
      const r = await api('/api/translate', { method: 'POST', body: JSON.stringify({ text: stripImgTokens(text), direction: 'to_target' }) });
      localTranslations.set(key, r.translated || '');
      shownTranslations.add(key);
      renderChat();
    } catch (e) { localTranslations.delete(key); }
  }

  window.toggleTranslate = async (key, msgIndex) => {
    if (shownTranslations.has(key)) { shownTranslations.delete(key); renderChat(); return; }
    if (localTranslations.has(key)) { shownTranslations.add(key); renderChat(); return; }
    const msgs = (lastState && lastState.snapshot && lastState.snapshot.messages) || [];
    const found = msgs.find((x) => x.index === msgIndex);
    if (!found || !found.text) return;
    toast('번역 중...');
    try {
      const r = await api('/api/translate', { method: 'POST', body: JSON.stringify({ text: stripImgTokens(found.text), direction: 'to_target' }) });
      localTranslations.set(key, r.translated || '');
      shownTranslations.add(key);
      renderChat();
    } catch (e) { toast('번역 실패: ' + e.message); }
  };

  window.editMsg = async (msgIndex) => {
    const snap = lastState.snapshot;
    const found = (snap.messages || []).find((x) => x.index === msgIndex);
    if (!found) return;
    const next = prompt('메시지 수정:', found.raw || found.text);
    if (next === null) return;
    await api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'edit_message', payload: { charIndex: snap.charIndex, chatIndex: snap.chatIndex, msgIndex, text: next } }) });
    toast('수정 요청됨');
  };

  window.delMsg = async (msgIndex) => {
    if (!confirm('이 메시지를 삭제할까요?')) return;
    const snap = lastState.snapshot;
    await api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'delete_message', payload: { charIndex: snap.charIndex, chatIndex: snap.chatIndex, msgIndex } }) });
    toast('삭제 요청됨');
  };

  async function sendMessage() {
    const inp = document.getElementById('msgInput');
    let text = inp.value.trim();
    if (!text) return;
    const snap = lastState && lastState.snapshot;
    if (!snap || snap.charIndex < 0) return toast('먼저 봇을 선택해 주세요.');
    inp.value = '';
    autoGrowInput();
    document.getElementById('sendBtn').disabled = true;
    try {
      if (routerCfg && routerCfg.translator && routerCfg.translator.autoTranslateInput) {
        toast('영어로 번역 후 전송 중...');
        const tr = await api('/api/translate', { method: 'POST', body: JSON.stringify({ text, direction: 'to_en' }) });
        if (tr.translated) text = tr.translated;
      }
      await api('/api/chat/send', { method: 'POST', body: JSON.stringify({ charIndex: snap.charIndex, chatIndex: snap.chatIndex, text }) });
      bookSpreadIdx = -1;
      toast('전송됨');
      setTimeout(pollState, 600);
    } catch (e) {
      toast('전송 오류: ' + e.message);
      document.getElementById('sendBtn').disabled = false;
    }
  }
  document.getElementById('sendBtn').onclick = sendMessage;
  function autoGrowInput() {
    const inp = document.getElementById('msgInput');
    inp.style.height = 'auto';
    inp.style.height = Math.min(inp.scrollHeight, 140) + 'px';
  }
  document.getElementById('msgInput').addEventListener('input', autoGrowInput);
  document.getElementById('msgInput').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } };

  document.getElementById('autoTrBtn').onclick = async () => {
    if (!routerCfg) return;
    routerCfg.translator.autoTranslateOutput = !routerCfg.translator.autoTranslateOutput;
    await api('/api/router/config', { method: 'POST', body: JSON.stringify(routerCfg) });
    syncToggleBadges();
    renderChat();
    toast('응답 자동 번역: ' + (routerCfg.translator.autoTranslateOutput ? 'ON' : 'OFF'));
  };
  document.getElementById('inTrBtn').onclick = async () => {
    if (!routerCfg) return;
    routerCfg.translator.autoTranslateInput = !routerCfg.translator.autoTranslateInput;
    await api('/api/router/config', { method: 'POST', body: JSON.stringify(routerCfg) });
    syncToggleBadges();
    toast('입력 한→영 자동 번역: ' + (routerCfg.translator.autoTranslateInput ? 'ON' : 'OFF'));
  };
  function syncToggleBadges() {
    if (!routerCfg || !routerCfg.translator) return;
    document.getElementById('autoTrBtn').className = 'pill' + (routerCfg.translator.autoTranslateOutput ? ' active' : '');
    document.getElementById('inTrBtn').className = 'pill' + (routerCfg.translator.autoTranslateInput ? ' active' : '');
  }

  function renderBots() {
    const listEl = document.getElementById('botList');
    const q = (document.getElementById('botSearch').value || '').trim().toLowerCase();
    const chars = (lastState && lastState.catalog && lastState.catalog.characters) || [];
    const curChar = lastState && lastState.snapshot ? lastState.snapshot.charIndex : -1;
    const curChat = lastState && lastState.snapshot ? lastState.snapshot.chatIndex : -1;
    const filtered = chars.filter((c) => !q || String(c.name).toLowerCase().includes(q));
    if (!filtered.length) {
      listEl.innerHTML = '<div class="empty-hint"><span class="big">📚</span>표시할 봇이 없습니다.<br>PC RisuStand의 원격 브릿지가 켜져 있는지 확인하세요.</div>';
      return;
    }
    let html = '';
    for (const c of filtered) {
      const open = expandedBotIdx === c.index || (expandedBotIdx === -1 && c.index === curChar);
      html += '<div class="bot-item"><div class="bot-head" onclick="toggleBot(' + c.index + ')">';
      html += '<div style="font-weight:700; font-size:14.5px;">' + esc(c.name) + '</div><div style="display:flex; gap:5px; align-items:center;">';
      if (c.isPcActive) html += '<span class="badge pc">PC 활성</span>';
      html += '<span class="badge">방 ' + (c.chats ? c.chats.length : 0) + '</span></div></div>';
      if (open) {
        html += '<div class="chat-list"><button class="btn sec" style="width:100%; margin-bottom:4px;" onclick="createChat(' + c.index + ')">＋ 새 채팅방 파기</button>';
        for (const ch of (c.chats || [])) {
          const isCur = c.index === curChar && ch.index === curChat;
          html += '<div class="chat-row' + (isCur ? ' cur' : '') + '" onclick="selectTarget(' + c.index + ',' + ch.index + ')"><span>' + esc(ch.name) + '</span><span class="badge">' + ch.msgCount + '턴</span></div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    listEl.innerHTML = html;
  }
  document.getElementById('botSearch').oninput = renderBots;
  document.getElementById('refreshAllBtn').onclick = async () => {
    await api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'sync_all' }) });
    toast('PC 전체 목록 동기화 중...');
    setTimeout(pollState, 900);
  };
  window.toggleBot = (idx) => { expandedBotIdx = expandedBotIdx === idx ? -2 : idx; renderBots(); };
  window.selectTarget = async (charIndex, chatIndex) => {
    bookSpreadIdx = -1;
    await api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'select_target', payload: { charIndex, chatIndex } }) });
    toast('채팅방 전환 중...');
    switchTab('chat');
    setTimeout(pollState, 700);
  };
  window.createChat = async (charIndex) => {
    const name = prompt('새 채팅방 이름 (비우면 자동 생성):', '');
    if (name === null) return;
    bookSpreadIdx = -1;
    await api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'create_chat', payload: { charIndex, name } }) });
    toast('새 방 생성 중...');
    switchTab('chat');
    setTimeout(pollState, 800);
  };


  function parseToggleSyntax(template) {
    if (!template) return [];
    const items = [];
    const lines = String(template).split('\\n');
    for (const rawLine of lines) {
      const line = rawLine.replace(/\\r$/, '');
      const parts = line.split('=');
      const key = parts[0] || '';
      const value = parts[1] || '';
      const type = parts[2] || '';
      const option = parts.slice(3).join('=');
      if (type === 'group' || type === 'groupEnd' || type === 'divider') {
        items.push({ key, value, type, children: [] });
      } else if (type === 'caption' && value) {
        items.push({ key, value, type });
      } else if (key && value) {
        items.push({
          key,
          value,
          type: (type === 'select' || type === 'text' || type === 'textarea') ? type : 'check',
          options: option ? option.split(',') : [],
        });
      }
    }
    const grouped = [];
    let curGroup = null;
    for (const item of items) {
      if (item.type === 'group') {
        curGroup = { ...item, children: [] };
        grouped.push(curGroup);
      } else if (item.type === 'groupEnd') {
        curGroup = null;
      } else if (curGroup) {
        curGroup.children.push(item);
      } else {
        grouped.push(item);
      }
    }
    return grouped;
  }

  function renderToggleItemsHtml(items, vals, blockIdx) {
    let html = '';
    items.forEach((t, idx) => {
      const fullKey = 'toggle_' + t.key;
      const curVal = vals[fullKey] !== undefined ? String(vals[fullKey]) : '';
      if (t.type === 'group') {
        const gid = 'g-' + blockIdx + '-' + idx + '-' + t.value;
        const isOpen = openToggleGroups.has(gid);
        html += '<div class="tg-acc' + (isOpen ? ' open' : '') + '">';
        html += '<div class="tg-acc-head" onclick="toggleAccGroup(\\'' + esc(gid) + '\\')"><span>' + esc(t.value) + '</span><span>' + (isOpen ? '▾' : '▸') + '</span></div>';
        html += '<div class="tg-acc-body">' + renderToggleItemsHtml(t.children || [], vals, blockIdx + '_' + idx) + '</div>';
        html += '</div>';
      } else if (t.type === 'divider') {
        html += '<div class="tg-div"></div>';
      } else if (t.type === 'caption') {
        html += '<div class="tg-cap">' + esc(t.value) + '</div>';
      } else if (t.type === 'select') {
        html += '<div class="tg-row"><span>' + esc(t.value) + '</span>';
        html += '<select class="f-inp" style="width:48%;" onchange="setCustomToggle(\\'' + esc(t.key) + '\\', this.value)">';
        html += '<option value=""' + (curVal === '' ? ' selected' : '') + '>(기본)</option>';
        (t.options || []).forEach((opt, oi) => {
          html += '<option value="' + oi + '"' + (curVal === String(oi) ? ' selected' : '') + '>' + esc(opt) + '</option>';
        });
        html += '</select></div>';
      } else if (t.type === 'text') {
        html += '<div class="tg-row"><span>' + esc(t.value) + '</span>';
        html += '<input class="f-inp" style="width:48%;" value="' + esc(curVal) + '" onchange="setCustomToggle(\\'' + esc(t.key) + '\\', this.value)" /></div>';
      } else if (t.type === 'textarea') {
        html += '<div style="display:flex; flex-direction:column; gap:4px;"><span style="font-size:12.5px;">' + esc(t.value) + '</span>';
        html += '<textarea class="f-inp" rows="2" onchange="setCustomToggle(\\'' + esc(t.key) + '\\', this.value)">' + esc(curVal) + '</textarea></div>';
      } else {
        const checked = curVal === '1';
        html += '<label class="tg-row" style="cursor:pointer;"><span>' + esc(t.value) + '</span>';
        html += '<input type="checkbox" style="width:19px; height:19px;" ' + (checked ? 'checked' : '') + ' onchange="setCustomToggle(\\'' + esc(t.key) + '\\', this.checked ? \\'1\\' : \\'0\\')" /></label>';
      }
    });
    return html;
  }

  let lastToggleRenderSig = '';
  let optimisticUntil = 0;
  let optimisticUseLocal = null;
  const optimisticVars = {};

  window.togglePresetAdder = (forceState) => {
    const el = document.getElementById('presetToggleAdder');
    const show = forceState !== undefined ? forceState : (el.style.display === 'none');
    el.style.display = show ? 'block' : 'none';
  };

  window.savePresetToggle = async () => {
    const name = document.getElementById('ptName').value.trim() || '프롬프트 프리셋';
    const syntax = document.getElementById('ptSyntax').value.trim();
    if (!syntax) return toast('커스텀 토글 텍스트를 붙여넣어 주세요.');
    if (!routerCfg) routerCfg = await api('/api/router/config');
    if (!Array.isArray(routerCfg.presetToggles)) routerCfg.presetToggles = [];
    routerCfg.presetToggles.push({ id: 'pt-' + Date.now(), name, enabled: true, syntax });
    routerCfg = await api('/api/router/config', { method: 'POST', body: JSON.stringify(routerCfg) });
    document.getElementById('ptName').value = '';
    document.getElementById('ptSyntax').value = '';
    togglePresetAdder(false);
    renderCustomToggles(true);
    toast('프리셋 토글 등록됨');
  };

  window.deletePresetToggle = async (id) => {
    if (!confirm('등록된 프리셋 토글을 삭제할까요?')) return;
    if (!routerCfg) routerCfg = await api('/api/router/config');
    routerCfg.presetToggles = (routerCfg.presetToggles || []).filter((x) => x.id !== id);
    routerCfg = await api('/api/router/config', { method: 'POST', body: JSON.stringify(routerCfg) });
    renderCustomToggles(true);
    toast('프리셋 토글 삭제됨');
  };

  function renderCustomToggles(force = false) {
    const snap = (lastState && lastState.snapshot) || {};
    const modBlocks = (snap.customToggleBlocks || []).map((b) => ({ source: b.source, syntax: b.syntax, isPreset: false }));
    const presetBlocks = ((routerCfg && routerCfg.presetToggles) || []).filter((p) => p.enabled !== false).map((p) => ({ id: p.id, source: p.name, syntax: p.syntax, isPreset: true }));
    const blocks = [...presetBlocks, ...modBlocks];

    const now = Date.now();
    const vals = { ...(snap.localToggleValues || {}), ...(now < optimisticUntil ? optimisticVars : {}) };
    const useLocal = (now < optimisticUntil && optimisticUseLocal !== null) ? optimisticUseLocal : Boolean(snap.useLocallySetGlobalVariables);
    const sig = JSON.stringify([snap.charIndex, snap.chatIndex, useLocal, vals, blocks.map((b) => b.source + ':' + b.syntax.length), Array.from(openToggleGroups)]);
    if (!force && sig === lastToggleRenderSig) return;
    lastToggleRenderSig = sig;

    const badge = document.getElementById('localToggleBadge');
    badge.textContent = useLocal ? '로컬 토글 ON' : '전역 모드';
    badge.className = 'badge' + (useLocal ? ' pc' : '');
    const chk = document.getElementById('localToggleChk');
    chk.checked = useLocal;
    chk.onchange = async () => {
      optimisticUseLocal = chk.checked;
      optimisticUntil = Date.now() + 3500;
      badge.textContent = chk.checked ? '로컬 토글 ON' : '전역 모드';
      badge.className = 'badge' + (chk.checked ? ' pc' : '');
      await api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'set_local_toggle_mode', payload: { charIndex: snap.charIndex, chatIndex: snap.chatIndex, enabled: chk.checked } }) });
      toast('로컬 토글 ' + (chk.checked ? '켜짐' : '꺼짐'));
    };

    const body = document.getElementById('customToggleBody');
    if (!blocks.length) {
      body.innerHTML = '<div style="color:var(--sub); font-size:12.5px;">표시할 토글이 없습니다. 프리셋 토글은 우측 상단 <b>+ 프리셋 토글</b>로 한 번만 등록해 주세요.</div>';
      return;
    }
    let html = '';
    blocks.forEach((b, bi) => {
      const parsed = parseToggleSyntax(b.syntax);
      if (!parsed.length) return;
      html += '<div style="margin-bottom:10px;">';
      html += '<div style="display:flex; align-items:center; justify-content:space-between; font-size:12px; font-weight:700; color:var(--accent); margin-bottom:4px;">';
      html += '<span>' + (b.isPreset ? '📘 ' : '🌿 ') + esc(b.source) + '</span>';
      if (b.isPreset) html += '<button class="act-btn" onclick="deletePresetToggle(\\'' + esc(b.id) + '\\')">삭제</button>';
      html += '</div>';
      html += renderToggleItemsHtml(parsed, vals, (b.isPreset ? 'p' : 'm') + bi);
      html += '</div>';
    });
    body.innerHTML = html || '<div style="color:var(--sub); font-size:12.5px;">표시할 토글 항목이 없습니다.</div>';
  }

  window.toggleAccGroup = (gid) => {
    if (openToggleGroups.has(gid)) openToggleGroups.delete(gid);
    else openToggleGroups.add(gid);
    renderCustomToggles(true);
  };

  window.setCustomToggle = async (key, value) => {
    const snap = lastState && lastState.snapshot;
    if (!snap || snap.charIndex < 0) return;
    const fullKey = String(key).startsWith('toggle_') ? String(key) : ('toggle_' + String(key));
    optimisticUseLocal = true;
    optimisticVars[fullKey] = String(value);
    optimisticUntil = Date.now() + 3500;
    renderCustomToggles(true);
    await api('/api/command', {
      method: 'POST',
      body: JSON.stringify({
        type: 'set_custom_toggle',
        payload: { charIndex: snap.charIndex, chatIndex: snap.chatIndex, key, value },
      }),
    });
    toast('토글 반영됨 (로컬 토글)');
  };

  function renderModules() {
    renderCustomToggles(false);
    const cat = (lastState && lastState.catalog) || {};
    const pSel = document.getElementById('personaSel');
    const personas = cat.personas || [];
    pSel.innerHTML = personas.map((p) => '<option value="' + p.index + '"' + (p.index === cat.selectedPersona ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('');
    pSel.onchange = async () => {
      await api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'select_persona', payload: { personaIndex: Number(pSel.value) } }) });
      toast('페르소나 변경됨');
    };
    if (cat.params && document.activeElement.tagName !== 'INPUT') {
      document.getElementById('pTemp').value = cat.params.temperature;
      document.getElementById('pCtx').value = cat.params.maxContext;
      document.getElementById('pResp').value = cat.params.maxResponse;
    }
    const q = (document.getElementById('modSearch').value || '').trim().toLowerCase();
    const mods = (cat.modules || []).filter((m) => !q || String(m.name).toLowerCase().includes(q));
    document.getElementById('modCount').textContent = (cat.modules || []).filter((m) => m.enabled).length + ' / ' + (cat.modules || []).length;
    document.getElementById('modList').innerHTML = mods.map((m) =>
      '<div class="row"><div style="min-width:0;"><div style="font-size:13.5px; font-weight:600;">' + esc(m.name) + '</div>' +
      (m.description ? '<div style="font-size:11.5px; color:var(--sub);">' + esc(m.description) + '</div>' : '') + '</div>' +
      '<input type="checkbox" style="width:20px; height:20px; flex-shrink:0;" ' + (m.enabled ? 'checked' : '') + ' onchange="toggleMod(\\'' + esc(m.id) + '\\', this.checked)" /></div>'
    ).join('') || '<div style="color:var(--sub); font-size:12.5px;">모듈 없음</div>';
  }
  document.getElementById('modSearch').oninput = renderModules;
  window.toggleMod = async (moduleId, enabled) => {
    await api('/api/command', { method: 'POST', body: JSON.stringify({ type: 'toggle_module', payload: { moduleId, enabled } }) });
    toast('모듈 ' + (enabled ? '켜짐' : '꺼짐'));
  };
  document.getElementById('saveParamsBtn').onclick = async () => {
    await api('/api/command', {
      method: 'POST',
      body: JSON.stringify({
        type: 'update_params',
        payload: {
          temperature: Number(document.getElementById('pTemp').value),
          maxContext: Number(document.getElementById('pCtx').value),
          maxResponse: Number(document.getElementById('pResp').value),
        },
      }),
    });
    toast('파라미터 RisuAI에 반영됨');
  };

  async function loadRouterConfig() {
    routerCfg = await api('/api/router/config');
    syncToggleBadges();
    renderRouterUI();
  }
  function renderRouterUI() {
    if (!routerCfg) return;
    document.getElementById('profileList').innerHTML = (routerCfg.profiles || []).map((p) => {
      const active = p.id === routerCfg.activeProfileId;
      return '<div class="row" style="padding:8px 10px; border:1px solid ' + (active ? 'var(--accent)' : 'var(--border)') + '; border-radius:10px; background:var(--bg);">' +
        '<div style="min-width:0;"><div style="font-size:13.5px; font-weight:700;">' + (active ? '🟢 ' : '') + esc(p.name) + '</div>' +
        '<div style="font-size:11.5px; color:var(--sub);">' + esc(p.providerType) + ' · ' + esc(p.model) + ' · 키: ' + (p.hasKey ? esc(p.keyPreview) : '미설정') + '</div></div>' +
        '<div style="display:flex; gap:5px; flex-shrink:0;">' +
        '<button class="btn ' + (active ? '' : 'sec') + '" onclick="activateProfile(\\'' + esc(p.id) + '\\')">' + (active ? '활성' : '선택') + '</button>' +
        '<button class="btn sec" onclick="editProfile(\\'' + esc(p.id) + '\\')">편집</button></div></div>';
    }).join('');
    const tr = routerCfg.translator || {};
    document.getElementById('trUseActive').checked = Boolean(tr.useActiveProfile);
    document.getElementById('trAutoOut').checked = Boolean(tr.autoTranslateOutput);
    document.getElementById('trAutoIn').checked = Boolean(tr.autoTranslateInput);
    document.getElementById('trType').value = tr.providerType || 'gemini';
    document.getElementById('trUrl').value = tr.baseUrl || '';
    document.getElementById('trKey').value = '';
    document.getElementById('trKey').placeholder = tr.hasKey ? ('저장됨: ' + tr.keyPreview) : 'API 키 입력';
    document.getElementById('trModel').value = tr.model || 'gemini-2.5-flash';
    document.getElementById('trPrompt').value = tr.prompt || '';
    document.getElementById('trCustomBox').style.display = tr.useActiveProfile ? 'none' : 'block';
  }
  document.getElementById('trUseActive').onchange = (e) => { document.getElementById('trCustomBox').style.display = e.target.checked ? 'none' : 'block'; };
  window.activateProfile = async (id) => {
    routerCfg.activeProfileId = id;
    routerCfg = await api('/api/router/config', { method: 'POST', body: JSON.stringify(routerCfg) });
    renderRouterUI();
    toast('활성 모델 전환됨');
  };
  window.openNewProfile = (preset) => {
    const presets = {
      openrouter: { name: 'OpenRouter', providerType: 'openai_compat', baseUrl: 'https://openrouter.ai/api/v1/chat/completions', model: 'anthropic/claude-3.7-sonnet' },
      gemini: { name: 'Google Gemini', providerType: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-pro' },
      claude: { name: 'Anthropic Claude', providerType: 'anthropic', baseUrl: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-20250514' },
      openai: { name: 'OpenAI / 커스텀', providerType: 'openai_compat', baseUrl: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4.1' },
    };
    const p = presets[preset] || presets.openai;
    document.getElementById('edTitle').textContent = '새 모델 프로필 추가';
    document.getElementById('edId').value = 'prof-' + Date.now();
    document.getElementById('edName').value = p.name;
    document.getElementById('edType').value = p.providerType;
    document.getElementById('edUrl').value = p.baseUrl;
    document.getElementById('edKey').value = '';
    document.getElementById('edModel').value = p.model;
    document.getElementById('edTemp').value = '';
    document.getElementById('edMaxTok').value = '';
    document.getElementById('edOvMode').value = 'off';
    document.getElementById('edOvText').value = '';
    document.getElementById('delProfBtn').style.display = 'none';
    document.getElementById('profileEditor').style.display = 'block';
  };
  window.editProfile = (id) => {
    const p = (routerCfg.profiles || []).find((x) => x.id === id);
    if (!p) return;
    document.getElementById('edTitle').textContent = '프로필 편집';
    document.getElementById('edId').value = p.id;
    document.getElementById('edName').value = p.name;
    document.getElementById('edType').value = p.providerType;
    document.getElementById('edUrl').value = p.baseUrl;
    document.getElementById('edKey').value = '';
    document.getElementById('edKey').placeholder = p.hasKey ? ('저장됨: ' + p.keyPreview + ' (비우면 유지)') : 'API 키 입력';
    document.getElementById('edModel').value = p.model;
    document.getElementById('edTemp').value = p.temperature || '';
    document.getElementById('edMaxTok').value = p.maxTokens || '';
    document.getElementById('edOvMode').value = p.overrideMode || 'off';
    document.getElementById('edOvText').value = p.systemOverride || '';
    document.getElementById('delProfBtn').style.display = 'inline-block';
    document.getElementById('profileEditor').style.display = 'block';
  };
  document.getElementById('saveProfBtn').onclick = async () => {
    const id = document.getElementById('edId').value;
    const item = {
      id,
      name: document.getElementById('edName').value.trim() || 'Model',
      providerType: document.getElementById('edType').value,
      baseUrl: document.getElementById('edUrl').value.trim(),
      apiKey: document.getElementById('edKey').value.trim(),
      model: document.getElementById('edModel').value.trim(),
      temperature: document.getElementById('edTemp').value.trim(),
      maxTokens: document.getElementById('edMaxTok').value.trim(),
      overrideMode: document.getElementById('edOvMode').value,
      systemOverride: document.getElementById('edOvText').value,
    };
    const idx = routerCfg.profiles.findIndex((x) => x.id === id);
    if (idx >= 0) routerCfg.profiles[idx] = item;
    else routerCfg.profiles.push(item);
    if (!routerCfg.activeProfileId) routerCfg.activeProfileId = id;
    routerCfg = await api('/api/router/config', { method: 'POST', body: JSON.stringify(routerCfg) });
    document.getElementById('profileEditor').style.display = 'none';
    renderRouterUI();
    toast('프로필 저장됨');
  };
  document.getElementById('delProfBtn').onclick = async () => {
    const id = document.getElementById('edId').value;
    routerCfg.profiles = routerCfg.profiles.filter((x) => x.id !== id);
    if (routerCfg.activeProfileId === id) routerCfg.activeProfileId = '';
    routerCfg = await api('/api/router/config', { method: 'POST', body: JSON.stringify(routerCfg) });
    document.getElementById('profileEditor').style.display = 'none';
    renderRouterUI();
    toast('프로필 삭제됨');
  };
  document.getElementById('saveTrBtn').onclick = async () => {
    routerCfg.translator = {
      ...routerCfg.translator,
      useActiveProfile: document.getElementById('trUseActive').checked,
      autoTranslateOutput: document.getElementById('trAutoOut').checked,
      autoTranslateInput: document.getElementById('trAutoIn').checked,
      providerType: document.getElementById('trType').value,
      baseUrl: document.getElementById('trUrl').value.trim(),
      apiKey: document.getElementById('trKey').value.trim(),
      model: document.getElementById('trModel').value.trim(),
      prompt: document.getElementById('trPrompt').value,
    };
    routerCfg = await api('/api/router/config', { method: 'POST', body: JSON.stringify(routerCfg) });
    syncToggleBadges();
    renderRouterUI();
    toast('번역 설정 저장됨');
  };

  if (token) tryLogin(token);
</script>
</body>
</html>`;
}

function sanitizeConfigForClient() {
    return {
        activeProfileId: config.activeProfileId,
        presetToggles: Array.isArray(config.presetToggles) ? config.presetToggles : [],
        profiles: config.profiles.map((p) => ({
            id: p.id,
            name: p.name,
            providerType: p.providerType,
            baseUrl: p.baseUrl,
            hasKey: Boolean(p.apiKey),
            keyPreview: maskKey(p.apiKey),
            model: p.model,
            temperature: p.temperature || '',
            maxTokens: p.maxTokens || '',
            overrideMode: p.overrideMode || 'off',
            systemOverride: p.systemOverride || '',
        })),
        translator: {
            ...config.translator,
            apiKey: undefined,
            hasKey: Boolean(config.translator.apiKey),
            keyPreview: maskKey(config.translator.apiKey),
        },
    };
}

// ================= HTTP Server =================
const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-RisuStand-Token',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        });
        res.end();
        return;
    }

    // 1) Web UI
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderWebApp());
        return;
    }

    // 2) OpenAI-Compatible Local Proxy Router (for PC RisuAI Reverse Proxy)
    if (pathname === '/v1/models' && req.method === 'GET') {
        const active = getActiveProfile();
        return sendJson(res, 200, {
            object: 'list',
            data: [
                { id: 'risustand-router', object: 'model', owned_by: 'risustand' },
                ...(active ? [{ id: active.model, object: 'model', owned_by: active.providerType }] : []),
            ],
        });
    }

    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        return handleOpenAIProxy(req, res);
    }

    // 3) PC Bridge Polling
    if (pathname === '/api/pc/poll' && req.method === 'POST') {
        if (!requireAuth(req, res, urlObj)) return;
        try {
            const body = JSON.parse((await readBody(req)) || '{}');
            state.pcConnected = true;
            state.pcLastSeen = Date.now();
            state.bridgeVersion = body.bridgeVersion || '1.0.0';
            state.generating = Boolean(body.generating);
            if (body.catalog) state.catalog = body.catalog;
            if (body.snapshot) state.snapshot = body.snapshot;

            const nextCmd = state.commandQueue.shift() || null;
            return sendJson(res, 200, { ok: true, command: nextCmd });
        } catch (e) {
            return sendJson(res, 400, { error: e.message });
        }
    }

    // 4) Client State
    if (pathname === '/api/state' && req.method === 'GET') {
        if (!requireAuth(req, res, urlObj)) return;
        const connected = Date.now() - state.pcLastSeen < 12000;
        state.pcConnected = connected;
        return sendJson(res, 200, {
            pcConnected: connected,
            bridgeVersion: state.bridgeVersion,
            generating: state.generating,
            directGenerating: state.directGenerating,
            catalog: state.catalog,
            snapshot: state.snapshot,
        });
    }

    // 5) Generic Bridge Command
    if (pathname === '/api/command' && req.method === 'POST') {
        if (!requireAuth(req, res, urlObj)) return;
        try {
            const body = JSON.parse((await readBody(req)) || '{}');
            if (!body.type) return sendJson(res, 400, { error: 'Missing command type' });
            queueCommand(body.type, body.payload || {});
            return sendJson(res, 200, { ok: true });
        } catch (e) {
            return sendJson(res, 400, { error: e.message });
        }
    }

    // 6) Smart Chat Send (Native RisuAI for PC-active bot, Direct Router for other bots)
    if (pathname === '/api/chat/send' && req.method === 'POST') {
        if (!requireAuth(req, res, urlObj)) return;
        try {
            const body = JSON.parse((await readBody(req)) || '{}');
            const text = String(body.text || '').trim();
            if (!text) return sendJson(res, 400, { error: 'Empty message' });
            const charIndex = Number(body.charIndex);
            const chatIndex = Number(body.chatIndex);

            if (state.snapshot && state.snapshot.isPcActive && charIndex === state.snapshot.charIndex) {
                queueCommand('send_chat', { charIndex, chatIndex, text });
                return sendJson(res, 200, { ok: true, mode: 'native_risu' });
            }

            // Non-PC-active character: execute via Relay Router & persist back to RisuAI DB
            runDirectRemoteChat(charIndex, chatIndex, text).catch((err) => {
                console.error('[DirectChat Error]', err.message);
            });
            return sendJson(res, 200, { ok: true, mode: 'direct_router' });
        } catch (e) {
            return sendJson(res, 500, { error: e.message });
        }
    }

    // 7) Built-in Translator
    if (pathname === '/api/translate' && req.method === 'POST') {
        if (!requireAuth(req, res, urlObj)) return;
        try {
            const body = JSON.parse((await readBody(req)) || '{}');
            const translated = await translateText(body.text || '', body.direction || 'to_target');
            return sendJson(res, 200, { ok: true, translated });
        } catch (e) {
            return sendJson(res, 500, { error: e.message });
        }
    }

    // 8) Router & Translator Config API
    if (pathname === '/api/router/config' && req.method === 'GET') {
        if (!requireAuth(req, res, urlObj)) return;
        return sendJson(res, 200, sanitizeConfigForClient());
    }

    if (pathname === '/api/router/config' && req.method === 'POST') {
        if (!requireAuth(req, res, urlObj)) return;
        try {
            const body = JSON.parse((await readBody(req)) || '{}');
            const oldMap = new Map(config.profiles.map((p) => [p.id, p]));
            if (Array.isArray(body.profiles)) {
                config.profiles = body.profiles.map((p) => {
                    const prev = oldMap.get(p.id);
                    return {
                        id: String(p.id || ('prof-' + Date.now())),
                        name: String(p.name || 'Model'),
                        providerType: p.providerType || 'openai_compat',
                        baseUrl: String(p.baseUrl || ''),
                        apiKey: p.apiKey ? String(p.apiKey) : (prev ? prev.apiKey : ''),
                        model: String(p.model || ''),
                        temperature: p.temperature !== undefined ? String(p.temperature) : '',
                        maxTokens: p.maxTokens !== undefined ? String(p.maxTokens) : '',
                        overrideMode: p.overrideMode || 'off',
                        systemOverride: String(p.systemOverride || ''),
                    };
                });
            }
            if (typeof body.activeProfileId === 'string') {
                config.activeProfileId = body.activeProfileId;
            }
            if (Array.isArray(body.presetToggles)) {
                config.presetToggles = body.presetToggles.map((pt) => ({
                    id: String(pt.id || ('pt-' + Date.now())),
                    name: String(pt.name || '프롬프트 프리셋'),
                    enabled: pt.enabled !== false,
                    syntax: String(pt.syntax || ''),
                }));
            }
            if (body.translator && typeof body.translator === 'object') {
                config.translator = {
                    ...config.translator,
                    ...body.translator,
                    apiKey: body.translator.apiKey ? String(body.translator.apiKey) : config.translator.apiKey,
                };
            }
            saveConfig();
            return sendJson(res, 200, sanitizeConfigForClient());
        } catch (e) {
            return sendJson(res, 400, { error: e.message });
        }
    }

    sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
    console.log('');
    console.log('======================================================');
    console.log('  📡 RisuStand Remote Relay Server v1.0.0 실행 중');
    console.log('======================================================');
    console.log(`  로컬 접속 주소 : http://127.0.0.1:${PORT}`);
    console.log(`  프록시 라우터  : http://127.0.0.1:${PORT}/v1/chat/completions`);
    console.log(`  보안 토큰      : ${TOKEN}`);
    console.log('======================================================');
    console.log('  * PC RisuAI 브릿지 주소: http://127.0.0.1:' + PORT);
    console.log('  * 아이폰/아이패드 접속 : http://<PC-Tailscale-IP>:' + PORT);
    console.log('  * 설정 파일 저장 위치  : ' + CONFIG_PATH);
    console.log('======================================================');
    console.log('');
});
