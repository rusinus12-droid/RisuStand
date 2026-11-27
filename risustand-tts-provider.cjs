'use strict';
/**
 * RisuStand Backend TTS Provider
 *
 * Supports:
 *  - Local native Fish Speech (`fish_local`: POST /v1/tts)
 *  - Local OpenAI-compatible TTS hubs (`openai_compat_local`: LocalAI, TTS-WebUI, vLLM-Omni, Qwen3-TTS FastAPI, Speaches, llama.cpp -> POST /v1/audio/speech)
 *  - Commercial Fish Audio Cloud (`fish_cloud`: POST https://api.fish.audio/v1/tts)
 *  - Commercial OpenAI-compatible TTS (`openai_compat_cloud`: POST /v1/audio/speech)
 *
 * Includes hybrid dialogue / inner thought / narration segmentation, character & gender
 * voice resolution, tone tag/instruction formatting, and LRU audio caching.
 */

const crypto = require('node:crypto');

const TTS_PROVIDER_DEFAULTS = Object.freeze({
    fish_local: Object.freeze({
        label: 'Fish Speech 로컬 (기본 · /v1/tts)',
        apiUrl: 'http://127.0.0.1:8080/v1/tts',
        model: 's2-pro',
        kind: 'fish',
        isLocal: true,
    }),
    openai_compat_local: Object.freeze({
        label: 'OpenAI 호환 로컬 허브 (LocalAI / TTS-WebUI / vLLM-Omni / Qwen3-TTS)',
        apiUrl: 'http://127.0.0.1:8881/v1/audio/speech',
        model: 'tts-1',
        kind: 'openai_compat',
        isLocal: true,
    }),
    fish_cloud: Object.freeze({
        label: 'Fish Audio Cloud (상용 · api.fish.audio)',
        apiUrl: 'https://api.fish.audio/v1/tts',
        model: 's2-pro',
        kind: 'fish',
        isLocal: false,
    }),
    openai_compat_cloud: Object.freeze({
        label: 'OpenAI TTS / 호환 상용 API (gpt-4o-mini-tts 등)',
        apiUrl: 'https://api.openai.com/v1/audio/speech',
        model: 'gpt-4o-mini-tts',
        kind: 'openai_compat',
        isLocal: false,
    }),
});

const VALID_PROVIDERS = Object.keys(TTS_PROVIDER_DEFAULTS);

const TTS_ENDPOINT_PRESETS = Object.freeze([
    Object.freeze({
        id: 'fish_local_8081',
        label: 'Fish Speech S2-Pro 로컬 (127.0.0.1:8081)',
        provider: 'fish_local',
        apiUrl: 'http://127.0.0.1:8081/v1/tts',
        model: 's2-pro',
        fishTagStyle: 'brackets',
    }),
    Object.freeze({
        id: 'fish_local_8080',
        label: 'Fish Speech 로컬 기본 (127.0.0.1:8080)',
        provider: 'fish_local',
        apiUrl: 'http://127.0.0.1:8080/v1/tts',
        model: 's2-pro',
        fishTagStyle: 'brackets',
    }),
    Object.freeze({
        id: 'localai_8080',
        label: 'LocalAI 로컬 허브 (127.0.0.1:8080)',
        provider: 'openai_compat_local',
        apiUrl: 'http://127.0.0.1:8080/v1/audio/speech',
        model: 'fish-speech-s2-pro',
        fishTagStyle: 'none',
    }),
    Object.freeze({
        id: 'qwen3_8881',
        label: 'Qwen3-TTS FastAPI 로컬 (127.0.0.1:8881)',
        provider: 'openai_compat_local',
        apiUrl: 'http://127.0.0.1:8881/v1/audio/speech',
        model: 'tts-1',
        fishTagStyle: 'none',
    }),
    Object.freeze({
        id: 'vllm_8000',
        label: 'vLLM-Omni / TTS-WebUI 로컬 (127.0.0.1:8000)',
        provider: 'openai_compat_local',
        apiUrl: 'http://127.0.0.1:8000/v1/audio/speech',
        model: 'fishaudio/s2-pro',
        fishTagStyle: 'none',
    }),
    Object.freeze({
        id: 'fish_cloud',
        label: 'Fish Audio Cloud (상용 · api.fish.audio)',
        provider: 'fish_cloud',
        apiUrl: 'https://api.fish.audio/v1/tts',
        model: 's2-pro',
        fishTagStyle: 'brackets',
    }),
    Object.freeze({
        id: 'openai_cloud',
        label: 'OpenAI TTS (상용 · gpt-4o-mini-tts)',
        provider: 'openai_compat_cloud',
        apiUrl: 'https://api.openai.com/v1/audio/speech',
        model: 'gpt-4o-mini-tts',
        fishTagStyle: 'none',
    }),
]);

function normalizeTtsEndpointUrl(rawUrl, provider = 'fish_local') {
    const raw = String(rawUrl || '').trim();
    if (!raw) return '';
    let u = raw;
    if (!/^https?:\/\//i.test(u)) {
        u = `http://${u}`;
    }
    try {
        const parsed = new URL(u);
        let p = parsed.pathname.replace(/\/+$/, '');
        const provMeta = TTS_PROVIDER_DEFAULTS[provider] || TTS_PROVIDER_DEFAULTS.fish_local;
        const suffix = provMeta.kind === 'fish' ? '/v1/tts' : '/v1/audio/speech';
        const v1Tail = provMeta.kind === 'fish' ? '/tts' : '/audio/speech';
        if (!p || p === '/') {
            p = suffix;
        } else if (p === '/v1') {
            p = `/v1${v1Tail}`;
        }
        parsed.pathname = p;
        return parsed.toString();
    } catch (_) {
        return raw.replace(/\/+$/, '');
    }
}
const VALID_FORMATS = ['mp3', 'wav', 'opus'];
const VALID_FISH_TAG_STYLES = ['brackets', 'parens', 'none'];
const VALID_PARSE_MODES = ['hybrid', 'llm', 'rule'];
const VALID_LLM_SOURCES = ['translator', 'active', 'aux'];
const VALID_GENDERS = ['female', 'male', 'neutral'];
const VALID_KINDS = ['dialogue', 'thought', 'narration'];

const TTS_VOICE_GROUPS = Object.freeze([
    Object.freeze({ id: 'fish', label: '🐟 Fish Audio' }),
    Object.freeze({ id: 'openai_qwen', label: '🎙️ OpenAI / Qwen' }),
]);

const TTS_BUILTIN_VOICE_REFERENCES = Object.freeze({
    fish: Object.freeze([]),
    openai_qwen: Object.freeze([
        Object.freeze({ id: 'alloy', label: 'Alloy · 중성/균형 (OpenAI)', gender: 'neutral', source: 'builtin' }),
        Object.freeze({ id: 'ash', label: 'Ash · 남성/차분 (OpenAI)', gender: 'male', source: 'builtin' }),
        Object.freeze({ id: 'ballad', label: 'Ballad · 남성/부드러움 (OpenAI)', gender: 'male', source: 'builtin' }),
        Object.freeze({ id: 'coral', label: 'Coral · 여성/따뜻함 (OpenAI)', gender: 'female', source: 'builtin' }),
        Object.freeze({ id: 'echo', label: 'Echo · 남성/중저음 (OpenAI)', gender: 'male', source: 'builtin' }),
        Object.freeze({ id: 'fable', label: 'Fable · 중성/서사적 (OpenAI)', gender: 'neutral', source: 'builtin' }),
        Object.freeze({ id: 'nova', label: 'Nova · 여성/밝고 선명 (OpenAI)', gender: 'female', source: 'builtin' }),
        Object.freeze({ id: 'onyx', label: 'Onyx · 남성/낮고 중후 (OpenAI)', gender: 'male', source: 'builtin' }),
        Object.freeze({ id: 'sage', label: 'Sage · 여성/지적·차분 (OpenAI)', gender: 'female', source: 'builtin' }),
        Object.freeze({ id: 'shimmer', label: 'Shimmer · 여성/맑고 부드러움 (OpenAI)', gender: 'female', source: 'builtin' }),
        Object.freeze({ id: 'verse', label: 'Verse · 남성/표현력 (OpenAI)', gender: 'male', source: 'builtin' }),
        Object.freeze({ id: 'Sohee', label: 'Sohee · 소희 / 한국어 여성 (Qwen3)', gender: 'female', source: 'builtin' }),
        Object.freeze({ id: 'Vivian', label: 'Vivian · 여성 (Qwen3)', gender: 'female', source: 'builtin' }),
        Object.freeze({ id: 'Serena', label: 'Serena · 여성 (Qwen3)', gender: 'female', source: 'builtin' }),
        Object.freeze({ id: 'Ono_Anna', label: 'Ono_Anna · 일본어 여성 (Qwen3)', gender: 'female', source: 'builtin' }),
        Object.freeze({ id: 'Ryan', label: 'Ryan · 남성 (Qwen3)', gender: 'male', source: 'builtin' }),
        Object.freeze({ id: 'Aiden', label: 'Aiden · 남성 (Qwen3)', gender: 'male', source: 'builtin' }),
        Object.freeze({ id: 'Dylan', label: 'Dylan · 남성 (Qwen3)', gender: 'male', source: 'builtin' }),
        Object.freeze({ id: 'Uncle_Fu', label: 'Uncle_Fu · 중년 남성 (Qwen3)', gender: 'male', source: 'builtin' }),
        Object.freeze({ id: 'Eric', label: 'Eric · 남성 (Qwen3)', gender: 'male', source: 'builtin' }),
    ]),
});

const TTS_TONE_TAG_PRESETS = Object.freeze([
    // Emotion
    Object.freeze({ value: 'calm', label: 'calm · 차분함', category: 'emotion' }),
    Object.freeze({ value: 'soft', label: 'soft · 부드러움', category: 'emotion' }),
    Object.freeze({ value: 'gentle', label: 'gentle · 다정함', category: 'emotion' }),
    Object.freeze({ value: 'happy', label: 'happy · 기쁨 · 밝음', category: 'emotion' }),
    Object.freeze({ value: 'excited', label: 'excited · 들뜸 · 신남', category: 'emotion' }),
    Object.freeze({ value: 'cheerful', label: 'cheerful · 경쾌함', category: 'emotion' }),
    Object.freeze({ value: 'sad', label: 'sad · 슬픔', category: 'emotion' }),
    Object.freeze({ value: 'melancholic', label: 'melancholic · 우울 · 쓸쓸함', category: 'emotion' }),
    Object.freeze({ value: 'angry', label: 'angry · 화남 · 격앙', category: 'emotion' }),
    Object.freeze({ value: 'cold', label: 'cold · 차가움 · 냉소', category: 'emotion' }),
    Object.freeze({ value: 'nervous', label: 'nervous · 긴장 · 불안', category: 'emotion' }),
    Object.freeze({ value: 'shy', label: 'shy · 수줍음', category: 'emotion' }),
    Object.freeze({ value: 'fearful', label: 'fearful · 두려움', category: 'emotion' }),
    Object.freeze({ value: 'surprised', label: 'surprised · 놀람', category: 'emotion' }),
    Object.freeze({ value: 'sarcastic', label: 'sarcastic · 비꼼 · 빈정거림', category: 'emotion' }),
    Object.freeze({ value: 'serious', label: 'serious · 진지함', category: 'emotion' }),
    Object.freeze({ value: 'confident', label: 'confident · 자신감 · 당당함', category: 'emotion' }),
    Object.freeze({ value: 'playful', label: 'playful · 장난스러움', category: 'emotion' }),
    Object.freeze({ value: 'affectionate', label: 'affectionate · 애정 어린', category: 'emotion' }),
    // Delivery / Inner Voice
    Object.freeze({ value: 'whispering', label: 'whispering · 속삭임', category: 'delivery' }),
    Object.freeze({ value: 'quiet', label: 'quiet · 조용함 · 낮은 목소리', category: 'delivery' }),
    Object.freeze({ value: 'softly', label: 'softly · 나지막이', category: 'delivery' }),
    Object.freeze({ value: 'sighing', label: 'sighing · 한숨 섞인', category: 'delivery' }),
    Object.freeze({ value: 'breathless', label: 'breathless · 숨 가쁜', category: 'delivery' }),
    Object.freeze({ value: 'shouting', label: 'shouting · 외침 · 큰소리', category: 'delivery' }),
    Object.freeze({ value: 'hesitant', label: 'hesitant · 망설임', category: 'delivery' }),
    Object.freeze({ value: 'tired', label: 'tired · 피곤함 · 나른함', category: 'delivery' }),
]);

function normalizeVoiceGroup(g, fallback = '') {
    const s = String(g || '').toLowerCase().trim();
    if (s === 'fish' || s === 'fish_local' || s === 'fish_cloud') return 'fish';
    if (s === 'openai_qwen' || s === 'openai' || s === 'qwen' || s === 'openai_compat_local' || s === 'openai_compat_cloud') {
        return 'openai_qwen';
    }
    return fallback;
}

function normalizeVoiceProfileEntry(raw) {
    if (typeof raw === 'string') {
        const id = raw.trim().slice(0, 160);
        if (!id) return null;
        return { id, label: id.slice(0, 120), gender: 'neutral' };
    }
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || raw.voiceId || raw.referenceId || '').trim().slice(0, 160);
    if (!id) return null;
    const label = String(raw.label || raw.name || id).trim().slice(0, 120) || id;
    return {
        id,
        label,
        gender: normalizeGender(raw.gender),
    };
}

function normalizeVoiceProfiles(raw) {
    const out = { fish: [], openai_qwen: [] };
    if (!raw || typeof raw !== 'object') return out;
    for (const group of ['fish', 'openai_qwen']) {
        const arr = Array.isArray(raw[group]) ? raw[group] : [];
        const seen = new Set();
        for (const item of arr) {
            const entry = normalizeVoiceProfileEntry(item);
            if (!entry || seen.has(entry.id)) continue;
            seen.add(entry.id);
            out[group].push(entry);
        }
    }
    return out;
}

function inferTtsVoiceGroup(voiceId, provider = 'fish_local', voiceProfiles = null) {
    const id = String(voiceId || '').trim();
    const prof = normalizeVoiceProfiles(voiceProfiles);
    if (id) {
        if (prof.fish.some((v) => v.id === id)) return 'fish';
        if (prof.openai_qwen.some((v) => v.id === id)) return 'openai_qwen';
        if (TTS_BUILTIN_VOICE_REFERENCES.openai_qwen.some((v) => v.id.toLowerCase() === id.toLowerCase())) {
            return 'openai_qwen';
        }
    }
    const provMeta = TTS_PROVIDER_DEFAULTS[provider] || TTS_PROVIDER_DEFAULTS.fish_local;
    return provMeta.kind === 'fish' ? 'fish' : 'openai_qwen';
}

function clampNum(v, fallback, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function normalizeGender(g) {
    const s = String(g || '').toLowerCase().trim();
    if (s === 'female' || s === 'f' || s === 'woman' || s === 'girl' || s === '여성' || s === '여') return 'female';
    if (s === 'male' || s === 'm' || s === 'man' || s === 'boy' || s === '남성' || s === '남') return 'male';
    return 'neutral';
}

function normalizeKind(k) {
    const s = String(k || '').toLowerCase().trim();
    if (s === 'dialogue' || s === 'speech' || s === 'spoken' || s === '대사' || s === '대화') return 'dialogue';
    if (s === 'thought' || s === 'monologue' || s === 'inner' || s === 'inner_thought' || s === '속마음' || s === '독백') return 'thought';
    return 'narration';
}

function buildTtsChatKey(snap) {
    if (!snap || typeof snap !== 'object') return '';
    const charCtx = (snap.charContext && typeof snap.charContext === 'object') ? snap.charContext : null;
    const rawCharId = (charCtx && (charCtx.charId || charCtx.chaId)) || snap.chaId || '';
    const charIdx = Number(snap.charIndex);
    const charPart = String(rawCharId || (!Number.isNaN(charIdx) && charIdx >= 0 ? `c${charIdx}` : '')).trim();
    const chatIdx = Number(snap.chatIndex);
    const chatPart = (!Number.isNaN(chatIdx) && chatIdx >= 0)
        ? `r${chatIdx}`
        : String(snap.chatUuid || snap.chatId || '').trim();
    if (!charPart || !chatPart) return '';
    return `${charPart}:${chatPart}`.slice(0, 200);
}

function defaultTtsConfig() {
    return {
        enabled: true,
        provider: 'fish_local',
        apiUrl: '',
        apiKey: '',
        model: 's2-pro',
        fishTagStyle: 'brackets',
        format: 'mp3',
        parseMode: 'hybrid',
        llmSource: 'translator',
        timeoutMs: 60000,
        narration: {
            voiceId: '',
            gender: 'neutral',
            toneTag: 'calm',
            instruction: '차분하고 몰입감 있는 소설 나레이터 톤으로 읽어주세요.',
            speed: 0.96,
            temperature: 0.72,
            topP: 0.75,
        },
        defaultVoices: {
            female: {
                voiceId: '',
                dialogueToneTag: '',
                thoughtToneTag: 'whispering',
                dialogueInstruction: '자연스럽고 생동감 있는 여성 대화 톤.',
                thoughtInstruction: '속으로 조용히 생각하는 낮고 속삭이는 독백 톤.',
                speed: 1.0,
                thoughtSpeed: 0.94,
                temperature: 0.8,
                topP: 0.8,
            },
            male: {
                voiceId: '',
                dialogueToneTag: '',
                thoughtToneTag: 'whispering',
                dialogueInstruction: '자연스럽고 안정감 있는 남성 대화 톤.',
                thoughtInstruction: '속으로 조용히 생각하는 낮고 차분한 독백 톤.',
                speed: 1.0,
                thoughtSpeed: 0.94,
                temperature: 0.8,
                topP: 0.8,
            },
            neutral: {
                voiceId: '',
                dialogueToneTag: '',
                thoughtToneTag: 'whispering',
                dialogueInstruction: '자연스러운 대화 톤.',
                thoughtInstruction: '조용한 속마음 톤.',
                speed: 1.0,
                thoughtSpeed: 0.94,
                temperature: 0.8,
                topP: 0.8,
            },
        },
        characters: [],
        chatCharacters: {},
        voiceProfiles: {
            fish: [],
            openai_qwen: [],
        },
        effects: {
            thoughtFxEnabled: true,
            thoughtReverbMix: 0.32,
            thoughtFilterHz: 2800,
            thoughtGain: 0.85,
            thoughtRate: 0.95,
            narrationGain: 0.92,
            narrationRate: 0.96,
            dialogueGain: 1.0,
            masterRate: 1.0,
        },
    };
}

function normalizeVoicePreset(raw, def) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    return {
        voiceId: String(src.voiceId || '').trim(),
        dialogueToneTag: String(src.dialogueToneTag !== undefined ? src.dialogueToneTag : def.dialogueToneTag).trim(),
        thoughtToneTag: String(src.thoughtToneTag !== undefined ? src.thoughtToneTag : def.thoughtToneTag).trim(),
        dialogueInstruction: String(src.dialogueInstruction !== undefined ? src.dialogueInstruction : def.dialogueInstruction).trim(),
        thoughtInstruction: String(src.thoughtInstruction !== undefined ? src.thoughtInstruction : def.thoughtInstruction).trim(),
        speed: clampNum(src.speed, def.speed, 0.5, 2.0),
        thoughtSpeed: clampNum(src.thoughtSpeed, def.thoughtSpeed, 0.5, 2.0),
        temperature: clampNum(src.temperature, def.temperature, 0.1, 1.2),
        topP: clampNum(src.topP, def.topP, 0.1, 1.0),
    };
}

function normalizeCharacterVoice(raw, idx = 0) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name || '').trim();
    if (!name) return null;
    const rawAliases = Array.isArray(raw.aliases)
        ? raw.aliases
        : String(raw.aliases || '').split(',');
    const aliases = rawAliases.map((a) => String(a || '').trim()).filter(Boolean);
    return {
        id: String(raw.id || `tts-char-${idx + 1}`).trim(),
        name,
        aliases,
        gender: normalizeGender(raw.gender),
        voiceGroup: normalizeVoiceGroup(raw.voiceGroup, ''),
        voiceId: String(raw.voiceId || '').trim(),
        dialogueToneTag: String(raw.dialogueToneTag || '').trim(),
        thoughtToneTag: String(raw.thoughtToneTag !== undefined ? raw.thoughtToneTag : 'whispering').trim(),
        dialogueInstruction: String(raw.dialogueInstruction || '').trim(),
        thoughtInstruction: String(raw.thoughtInstruction || '').trim(),
        speed: clampNum(raw.speed, 1.0, 0.5, 2.0),
        thoughtSpeed: clampNum(raw.thoughtSpeed, 0.94, 0.5, 2.0),
    };
}

function normalizeTtsConfig(raw) {
    const def = defaultTtsConfig();
    if (!raw || typeof raw !== 'object') return def;

    const provRaw = String(raw.provider || def.provider).toLowerCase().trim();
    const provider = VALID_PROVIDERS.includes(provRaw) ? provRaw : def.provider;
    const provMeta = TTS_PROVIDER_DEFAULTS[provider];

    const formatRaw = String(raw.format || def.format).toLowerCase().trim();
    const format = VALID_FORMATS.includes(formatRaw) ? formatRaw : def.format;

    const tagStyleRaw = String(raw.fishTagStyle || def.fishTagStyle).toLowerCase().trim();
    const fishTagStyle = VALID_FISH_TAG_STYLES.includes(tagStyleRaw) ? tagStyleRaw : def.fishTagStyle;

    const parseRaw = String(raw.parseMode || def.parseMode).toLowerCase().trim();
    const parseMode = VALID_PARSE_MODES.includes(parseRaw) ? parseRaw : def.parseMode;

    const llmRaw = String(raw.llmSource || def.llmSource).toLowerCase().trim();
    const llmSource = VALID_LLM_SOURCES.includes(llmRaw) ? llmRaw : def.llmSource;

    const narSrc = (raw.narration && typeof raw.narration === 'object') ? raw.narration : {};
    const narration = {
        voiceId: String(narSrc.voiceId || '').trim(),
        gender: normalizeGender(narSrc.gender || def.narration.gender),
        toneTag: String(narSrc.toneTag !== undefined ? narSrc.toneTag : def.narration.toneTag).trim(),
        instruction: String(narSrc.instruction !== undefined ? narSrc.instruction : def.narration.instruction).trim(),
        speed: clampNum(narSrc.speed, def.narration.speed, 0.5, 2.0),
        temperature: clampNum(narSrc.temperature, def.narration.temperature, 0.1, 1.2),
        topP: clampNum(narSrc.topP, def.narration.topP, 0.1, 1.0),
    };

    const dvSrc = (raw.defaultVoices && typeof raw.defaultVoices === 'object') ? raw.defaultVoices : {};
    const defaultVoices = {
        female: normalizeVoicePreset(dvSrc.female, def.defaultVoices.female),
        male: normalizeVoicePreset(dvSrc.male, def.defaultVoices.male),
        neutral: normalizeVoicePreset(dvSrc.neutral, def.defaultVoices.neutral),
    };

    const characters = Array.isArray(raw.characters)
        ? raw.characters.map((c, i) => normalizeCharacterVoice(c, i)).filter(Boolean)
        : [];
    const seenCharNames = new Set(characters.map((c) => c.name.toLowerCase()));

    // Migrate any legacy per-chat entries into global characters so existing casts keep working everywhere
    if (raw.chatCharacters && typeof raw.chatCharacters === 'object' && !Array.isArray(raw.chatCharacters)) {
        for (const v of Object.values(raw.chatCharacters)) {
            if (!Array.isArray(v)) continue;
            for (const c of v) {
                const normChar = normalizeCharacterVoice(c, characters.length);
                if (!normChar) continue;
                const lowerName = normChar.name.toLowerCase();
                if (!seenCharNames.has(lowerName)) {
                    seenCharNames.add(lowerName);
                    characters.push(normChar);
                }
            }
        }
    }
    const chatCharacters = {};

    const voiceProfiles = normalizeVoiceProfiles(raw.voiceProfiles);

    const fxSrc = (raw.effects && typeof raw.effects === 'object') ? raw.effects : {};
    const effects = {
        thoughtFxEnabled: fxSrc.thoughtFxEnabled !== undefined ? Boolean(fxSrc.thoughtFxEnabled) : def.effects.thoughtFxEnabled,
        thoughtReverbMix: clampNum(fxSrc.thoughtReverbMix, def.effects.thoughtReverbMix, 0, 1),
        thoughtFilterHz: Math.trunc(clampNum(fxSrc.thoughtFilterHz, def.effects.thoughtFilterHz, 600, 12000)),
        thoughtGain: clampNum(fxSrc.thoughtGain, def.effects.thoughtGain, 0.1, 1.5),
        thoughtRate: clampNum(fxSrc.thoughtRate, def.effects.thoughtRate, 0.6, 1.4),
        narrationGain: clampNum(fxSrc.narrationGain, def.effects.narrationGain, 0.1, 1.5),
        narrationRate: clampNum(fxSrc.narrationRate, def.effects.narrationRate, 0.6, 1.4),
        dialogueGain: clampNum(fxSrc.dialogueGain, def.effects.dialogueGain, 0.1, 1.5),
        masterRate: clampNum(fxSrc.masterRate, def.effects.masterRate, 0.6, 1.6),
    };

    return {
        enabled: raw.enabled !== undefined ? Boolean(raw.enabled) : def.enabled,
        provider,
        apiUrl: normalizeTtsEndpointUrl(raw.apiUrl, provider),
        apiKey: String(raw.apiKey || '').trim(),
        model: String(raw.model !== undefined ? raw.model : provMeta.model).trim() || provMeta.model,
        fishTagStyle,
        format,
        parseMode,
        llmSource,
        timeoutMs: Math.trunc(clampNum(raw.timeoutMs, def.timeoutMs, 5000, 180000)),
        narration,
        defaultVoices,
        characters,
        chatCharacters,
        voiceProfiles,
        effects,
    };
}

function sanitizeTtsForClient(raw) {
    const cfg = normalizeTtsConfig(raw);
    const k = cfg.apiKey;
    const keyPreview = !k ? '' : (k.length <= 8 ? '****' : `${k.slice(0, 4)}...${k.slice(-4)}`);
    return {
        ...cfg,
        apiKey: undefined,
        hasKey: Boolean(k),
        keyPreview,
    };
}

// ================= Text Cleaning & Segmentation =================

const THOUGHT_OPEN_MARK = '\uE000';
const THOUGHT_CLOSE_MARK = '\uE001';

function decodeBasicEntities(s) {
    return String(s || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'");
}

/**
 * Strips RisuAI image/inlay tokens, status blocks, styles/scripts, and HTML markup
 * while preserving `<i>` / `<em>` spans via internal thought delimiters.
 */
function cleanTextForTts(rawText = '', rawHtml = '') {
    let src = String(rawText || '').trim();
    const htmlStr = String(rawHtml || '').trim();

    if (!src && htmlStr) {
        src = htmlStr;
    }

    // If rawHtml has <i>/<em> spans and rawText doesn't use markdown asterisks/single-quotes,
    // use rawHtml only when rawText is absent; otherwise strip HTML cleanly from rawText.
    src = src
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, ' ')
        .replace(/\{\{(?:inlay|img|asset|raw|image|audio|video)::[^{}]*\}\}/gi, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)\]\((?:https?:\/\/|data:)[^)]+\)/g, '$1');

    // Preserve <i> / <em> spans as thought markers before stripping remaining tags
    src = src
        .replace(/<\s*(?:i|em)\b[^>]*>([\s\S]*?)<\s*\/\s*(?:i|em)\s*>/gi, (_, inner) => {
            const cleanInner = String(inner || '').replace(/<[^>]+>/g, ' ').trim();
            return cleanInner ? ` ${THOUGHT_OPEN_MARK}${cleanInner}${THOUGHT_CLOSE_MARK} ` : ' ';
        })
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\s*\/\s*(?:p|div|li|blockquote|h[1-6]|tr)\s*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');

    src = decodeBasicEntities(src)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s*[-*_]{3,}\s*$/gm, '\n')
        .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/[ \t\r]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return src;
}

function splitLongTextChunks(text, maxChars = 260) {
    const s = String(text || '').trim();
    if (!s) return [];
    if (s.length <= maxChars) return [s];

    const out = [];
    // Split at sentence endings or line breaks while keeping punctuation
    const parts = s.split(/(?<=[.!?…。！？\n])\s+/);
    let buf = '';
    for (const part of parts) {
        const p = part.trim();
        if (!p) continue;
        if (!buf) {
            if (p.length <= maxChars) {
                buf = p;
            } else {
                // Hard split very long run-on clause on spaces or commas
                const subParts = p.split(/(?<=[,;，；])\s+/);
                let subBuf = '';
                for (const sp of subParts) {
                    if (!subBuf) {
                        if (sp.length <= maxChars) {
                            subBuf = sp;
                        } else {
                            for (let idx = 0; idx < sp.length; idx += maxChars) {
                                out.push(sp.slice(idx, idx + maxChars).trim());
                            }
                        }
                    } else if ((subBuf.length + 1 + sp.length) <= maxChars) {
                        subBuf += ' ' + sp;
                    } else {
                        out.push(subBuf);
                        subBuf = sp;
                    }
                }
                if (subBuf) buf = subBuf;
            }
        } else if ((buf.length + 1 + p.length) <= maxChars) {
            buf += ' ' + p;
        } else {
            out.push(buf);
            if (p.length <= maxChars) {
                buf = p;
            } else {
                buf = '';
                const nested = splitLongTextChunks(p, maxChars);
                out.push(...nested);
            }
        }
    }
    if (buf) out.push(buf);
    return out.filter(Boolean);
}

function isSpeakableText(text) {
    const s = String(text || '').trim();
    if (!s) return false;
    // Must contain at least one letter, Hangul, CJK, or digit
    return /[\p{L}\p{N}]/u.test(s);
}

function findCharacterInContext(contextText, characters = []) {
    const ctx = String(contextText || '');
    if (!ctx || !Array.isArray(characters) || !characters.length) return null;
    let best = null;
    let bestPos = -1;
    const lowerCtx = ctx.toLowerCase();
    for (const ch of characters) {
        if (!ch || !ch.name) continue;
        const names = [ch.name, ...(Array.isArray(ch.aliases) ? ch.aliases : [])].filter(Boolean);
        for (const n of names) {
            const needle = String(n).trim().toLowerCase();
            if (!needle) continue;
            const pos = lowerCtx.lastIndexOf(needle);
            if (pos >= bestPos) {
                bestPos = pos;
                best = ch;
            }
        }
    }
    return best;
}

function inferSpeakerFromContext(precedingText, explicitSpeaker, options = {}) {
    const characters = Array.isArray(options.characters) ? options.characters : [];
    const role = String(options.role || 'char').toLowerCase();
    const defaultSpeaker = role === 'user'
        ? String(options.personaName || '나').trim()
        : String(options.charName || 'Character').trim();

    if (explicitSpeaker) {
        const matched = findCharacterInContext(explicitSpeaker, characters);
        if (matched) return { speaker: matched.name, gender: matched.gender };
        return { speaker: explicitSpeaker, gender: 'neutral' };
    }

    const tail = String(precedingText || '').slice(-100);
    const matched = findCharacterInContext(tail, characters);
    if (matched) return { speaker: matched.name, gender: matched.gender };

    // Also try finding defaultSpeaker inside character list to inherit configured gender
    const defMatch = findCharacterInContext(defaultSpeaker, characters);
    if (defMatch) return { speaker: defMatch.name, gender: defMatch.gender };

    return { speaker: defaultSpeaker, gender: 'neutral' };
}

function findNextSpanToken(text, startIdx) {
    const len = text.length;
    for (let i = startIdx; i < len; i += 1) {
        const ch = text[i];

        // 1) Preserved HTML <i>/<em> thought marker
        if (ch === THOUGHT_OPEN_MARK) {
            const closeIdx = text.indexOf(THOUGHT_CLOSE_MARK, i + 1);
            if (closeIdx > i + 1) {
                return { start: i, end: closeIdx + 1, inner: text.slice(i + 1, closeIdx), kind: 'thought' };
            }
        }

        // 2) Dialogue quotes: "...", “...”, 「...」
        if (ch === '"' || ch === '“' || ch === '「') {
            const closeChar = ch === '“' ? '”' : (ch === '「' ? '」' : '"');
            const closeIdx = text.indexOf(closeChar, i + 1);
            if (closeIdx > i) {
                return { start: i, end: closeIdx + 1, inner: text.slice(i + 1, closeIdx), kind: 'dialogue' };
            }
        }

        // 3) Thought quotes: ‘...’, 『...』, or '...' (guarded against English contractions)
        if (ch === '‘' || ch === '『') {
            const closeChar = ch === '‘' ? '’' : '』';
            const closeIdx = text.indexOf(closeChar, i + 1);
            if (closeIdx > i) {
                return { start: i, end: closeIdx + 1, inner: text.slice(i + 1, closeIdx), kind: 'thought' };
            }
        }

        if (ch === "'") {
            const prevChar = i > 0 ? text[i - 1] : '';
            // Guard: if preceded by ASCII alphanumeric, treat as apostrophe/contraction (e.g. don't, I'm, Elena's)
            if (/[A-Za-z0-9]/.test(prevChar)) continue;
            let searchFrom = i + 1;
            while (searchFrom < len) {
                const closeIdx = text.indexOf("'", searchFrom);
                if (closeIdx === -1) break;
                const nextChar = closeIdx + 1 < len ? text[closeIdx + 1] : '';
                if (/[A-Za-z0-9]/.test(nextChar)) {
                    // Internal contraction inside single-quoted thought (e.g. 'I don't know')
                    searchFrom = closeIdx + 1;
                    continue;
                }
                if (closeIdx > i + 1) {
                    return { start: i, end: closeIdx + 1, inner: text.slice(i + 1, closeIdx), kind: 'thought' };
                }
                break;
            }
        }

        // 4) Asterisk thought/emphasis spans: *...*
        if (ch === '*') {
            const nextChar = i + 1 < len ? text[i + 1] : '';
            if (nextChar && !/\s/.test(nextChar) && nextChar !== '*') {
                const closeIdx = text.indexOf('*', i + 1);
                if (closeIdx > i + 1 && !/\n\n/.test(text.slice(i + 1, closeIdx))) {
                    const inner = text.slice(i + 1, closeIdx);
                    if (isSpeakableText(inner)) {
                        return { start: i, end: closeIdx + 1, inner, kind: 'thought' };
                    }
                }
            }
        }
    }
    return null;
}

/**
 * Deterministic rule-based segmentation separating spoken dialogue, inner thoughts, and narration.
 */
function parseSegmentsRuleBased(rawText, options = {}) {
    const cleaned = cleanTextForTts(rawText, options.html || '');
    if (!cleaned) return [];

    const maxChunkChars = Number(options.maxChunkChars) > 40 ? Number(options.maxChunkChars) : 260;
    const rawSegments = [];
    let cursor = 0;

    while (cursor < cleaned.length) {
        const tok = findNextSpanToken(cleaned, cursor);
        if (!tok) {
            const tail = cleaned.slice(cursor).replace(/[\uE000\uE001]/g, '').trim();
            if (isSpeakableText(tail)) {
                rawSegments.push({ kind: 'narration', speaker: 'Narrator', gender: 'neutral', tone: '', text: tail });
            }
            break;
        }

        let pre = cleaned.slice(cursor, tok.start).replace(/[\uE000\uE001]/g, '');
        let explicitSpeaker = '';

        // Check for script-style speaker prefix right before quote: e.g. `엘레나: "..."` or `[엘레나] "..."`
        const prefixMatch = pre.match(/(?:^|\n)\s*(?:\[([^\[\]\n]{1,32})\]|([^\s:\n]{1,32}))\s*:\s*$/);
        if (prefixMatch) {
            explicitSpeaker = String(prefixMatch[1] || prefixMatch[2] || '').trim();
            pre = pre.slice(0, pre.length - prefixMatch[0].length);
        }

        const preTrimmed = pre.trim();
        if (isSpeakableText(preTrimmed)) {
            rawSegments.push({ kind: 'narration', speaker: 'Narrator', gender: 'neutral', tone: '', text: preTrimmed });
        }

        const innerText = String(tok.inner || '').replace(/[\uE000\uE001]/g, '').trim();
        if (isSpeakableText(innerText)) {
            const ctxWindow = preTrimmed || (rawSegments.length ? rawSegments[rawSegments.length - 1].text : '');
            const { speaker, gender } = inferSpeakerFromContext(ctxWindow, explicitSpeaker, options);
            rawSegments.push({
                kind: tok.kind,
                speaker,
                gender,
                tone: tok.kind === 'thought' ? 'whispering' : '',
                text: innerText,
            });
        }
        cursor = tok.end;
    }

    const chunked = [];
    for (const seg of rawSegments) {
        const parts = splitLongTextChunks(seg.text, maxChunkChars);
        for (const part of parts) {
            if (!isSpeakableText(part)) continue;
            chunked.push({
                kind: seg.kind,
                speaker: seg.speaker,
                gender: seg.gender,
                tone: seg.tone,
                text: part,
            });
        }
    }
    return chunked;
}

function buildScriptDirectorMessages(cleanText, options = {}) {
    const characters = Array.isArray(options.characters) ? options.characters : [];
    const role = String(options.role || 'char').toLowerCase();
    const charName = String(options.charName || 'Character').trim();
    const personaName = String(options.personaName || '나').trim();

    const castLines = characters
        .filter((c) => c && c.name)
        .map((c) => {
            const aliasPart = (c.aliases && c.aliases.length) ? ` (aliases: ${c.aliases.join(', ')})` : '';
            return `- ${c.name}${aliasPart} [gender: ${c.gender}]`;
        });

    const castHint = castLines.length
        ? `Registered Voice Cast:\n${castLines.join('\n')}`
        : 'Registered Voice Cast: (none registered yet)';

    const sysPrompt = [
        'You are a TTS Script Director for a roleplay/novel reader.',
        'Split the input message into ordered segments for voice acting.',
        'Output ONLY valid JSON matching: {"segments":[{"kind":"narration"|"dialogue"|"thought","speaker":"string","gender":"female"|"male"|"neutral","tone":"string","text":"string"}]}.',
        'Rules:',
        '1. Preserve the exact original text in chronological order without summarizing, translating, or dropping words.',
        '2. Strip surrounding quotation marks ("", “”, 「」, \'\', ‘’, 『』, **) from `text`, keeping only the spoken/thought/narrated words.',
        '3. Classify `kind` strictly:',
        '   - "dialogue": spoken lines aloud ("...", “...”, 「...」)',
        '   - "thought": silent inner thoughts/monologue (\'...\', ‘...’, 『...』, *...*, or clear internal thoughts)',
        '   - "narration": descriptive prose and action beats',
        '4. Set `speaker` to "Narrator" for narration. For dialogue/thought, use the exact Registered Voice Cast `name` when matching, otherwise infer the speaking character name (fallback: "' + (role === 'user' ? personaName : charName) + '").',
        '5. Set `gender` to "female", "male", or "neutral" based on context/pronouns/cast.',
        '6. Set `tone` to a short Fish Audio emotion/style cue in English (e.g. "calm", "whispering", "happy", "sad", "angry", "nervous", "soft") or "" if neutral.',
        '7. Do NOT output markdown fences or any commentary outside the JSON object.',
    ].join('\n');

    const userPrompt = [
        `Message Role: ${role === 'user' ? `user (${personaName})` : `assistant (${charName})`}`,
        castHint,
        'Input Text:',
        cleanText,
    ].join('\n\n');

    return [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userPrompt },
    ];
}

function extractJsonPayload(rawOutput) {
    let s = String(rawOutput || '').trim();
    if (!s) throw new Error('LLM 대본 분석 응답이 비어 있습니다.');

    const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch && fenceMatch[1]) {
        s = fenceMatch[1].trim();
    }

    try {
        return JSON.parse(s);
    } catch (_) {}

    const firstObj = s.indexOf('{');
    const lastObj = s.lastIndexOf('}');
    if (firstObj !== -1 && lastObj > firstObj) {
        try {
            return JSON.parse(s.slice(firstObj, lastObj + 1));
        } catch (_) {}
    }

    const firstArr = s.indexOf('[');
    const lastArr = s.lastIndexOf(']');
    if (firstArr !== -1 && lastArr > firstArr) {
        return JSON.parse(s.slice(firstArr, lastArr + 1));
    }

    throw new Error('LLM 대본 분석 JSON 파싱에 실패했습니다.');
}

function parseScriptDirectorResponse(rawOutput, fallbackSpeaker = 'Character', maxChunkChars = 260) {
    const parsed = extractJsonPayload(rawOutput);
    const list = Array.isArray(parsed)
        ? parsed
        : (parsed && Array.isArray(parsed.segments) ? parsed.segments : null);
    if (!list || !list.length) {
        throw new Error('LLM 대본 분석 결과에 segments 배열이 없습니다.');
    }

    const out = [];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const kind = normalizeKind(item.kind);
        const gender = kind === 'narration' ? 'neutral' : normalizeGender(item.gender);
        const speaker = kind === 'narration'
            ? 'Narrator'
            : (String(item.speaker || '').trim() || fallbackSpeaker);
        const tone = String(item.tone || '').trim().replace(/^[\[(]+|[\])]+$/g, '');
        const text = String(item.text || '').replace(/[\uE000\uE001]/g, '').trim();
        if (!isSpeakableText(text)) continue;

        for (const chunk of splitLongTextChunks(text, maxChunkChars)) {
            if (!isSpeakableText(chunk)) continue;
            out.push({ kind, speaker, gender, tone, text: chunk });
        }
    }

    if (!out.length) {
        throw new Error('LLM 대본 분석에서 유효한 발화 구간을 찾지 못했습니다.');
    }
    return out;
}

// ================= Voice Resolution & Tag Formatting =================

function findCharacterProfile(speaker, characters = []) {
    const sp = String(speaker || '').trim().toLowerCase();
    if (!sp || !Array.isArray(characters)) return null;
    for (const ch of characters) {
        if (!ch || !ch.name) continue;
        if (ch.name.toLowerCase() === sp) return ch;
        if (Array.isArray(ch.aliases) && ch.aliases.some((a) => String(a || '').trim().toLowerCase() === sp)) {
            return ch;
        }
    }
    return null;
}

function getEffectiveTtsCharacters(ttsConfig, _chatKey = '') {
    return normalizeTtsConfig(ttsConfig).characters;
}

function resolveSegmentVoice(segment, ttsConfig, defaultCharName = 'Character', chatKey = '') {
    const cfg = normalizeTtsConfig(ttsConfig);
    const kind = normalizeKind(segment && segment.kind);
    const speaker = kind === 'narration'
        ? 'Narrator'
        : (String((segment && segment.speaker) || defaultCharName || 'Character').trim() || 'Character');

    if (kind === 'narration') {
        const nar = cfg.narration;
        const tags = [];
        if (nar.toneTag) tags.push(nar.toneTag);
        if (segment && segment.tone && !tags.includes(String(segment.tone).trim())) {
            tags.push(String(segment.tone).trim());
        }
        return {
            kind,
            speaker,
            gender: nar.gender || 'neutral',
            voiceId: nar.voiceId || cfg.defaultVoices.neutral.voiceId || '',
            toneTags: tags.filter(Boolean),
            instruction: nar.instruction || '',
            speed: nar.speed,
            temperature: nar.temperature,
            topP: nar.topP,
            matchedCharacter: '',
        };
    }

    const effectiveChars = getEffectiveTtsCharacters(cfg, chatKey);
    const matched = findCharacterProfile(speaker, effectiveChars);
    const gender = matched ? matched.gender : normalizeGender(segment && segment.gender);
    const genderPreset = cfg.defaultVoices[gender] || cfg.defaultVoices.neutral;
    const isThought = kind === 'thought';

    const voiceId = (matched && matched.voiceId) ? matched.voiceId : (genderPreset.voiceId || '');
    const presetTag = isThought
        ? (matched && matched.thoughtToneTag !== undefined && matched.thoughtToneTag !== '' ? matched.thoughtToneTag : genderPreset.thoughtToneTag)
        : (matched && matched.dialogueToneTag !== undefined && matched.dialogueToneTag !== '' ? matched.dialogueToneTag : genderPreset.dialogueToneTag);

    const toneTags = [];
    if (presetTag) toneTags.push(presetTag);
    const segTone = String((segment && segment.tone) || '').trim();
    if (segTone && !toneTags.some((t) => t.toLowerCase() === segTone.toLowerCase())) {
        toneTags.push(segTone);
    }

    const instruction = isThought
        ? ((matched && matched.thoughtInstruction) || genderPreset.thoughtInstruction || '')
        : ((matched && matched.dialogueInstruction) || genderPreset.dialogueInstruction || '');

    const speed = isThought
        ? ((matched && matched.thoughtSpeed) || genderPreset.thoughtSpeed)
        : ((matched && matched.speed) || genderPreset.speed);

    return {
        kind,
        speaker: matched ? matched.name : speaker,
        gender,
        voiceId,
        toneTags: toneTags.filter(Boolean),
        instruction,
        speed,
        temperature: genderPreset.temperature,
        topP: genderPreset.topP,
        matchedCharacter: matched ? matched.name : '',
    };
}

function formatFishTaggedText(text, toneTags = [], fishTagStyle = 'brackets') {
    const clean = String(text || '').trim();
    if (!clean) return '';
    if (fishTagStyle === 'none' || !Array.isArray(toneTags) || !toneTags.length) {
        return clean;
    }
    // Avoid duplicating tags if text already starts with a bracket/paren tag
    if (/^(?:\[[^\]]+\]|\([^)]+\))/.test(clean)) {
        return clean;
    }
    const sanitized = toneTags
        .map((t) => String(t || '').trim().replace(/^[\[(]+|[\])]+$/g, ''))
        .filter(Boolean)
        .slice(0, 3);
    if (!sanitized.length) return clean;
    const prefix = sanitized
        .map((t) => (fishTagStyle === 'parens' ? `(${t})` : `[${t}]`))
        .join('');
    return `${prefix} ${clean}`;
}

async function analyzeTtsSegments({ text = '', html = '', role = 'char', charName = 'Character', personaName = '나', chatKey = '', ttsConfig = {}, callLlm = null } = {}) {
    const cfg = normalizeTtsConfig(ttsConfig);
    const clean = cleanTextForTts(text, html);
    if (!clean) {
        return { segments: [], modeUsed: 'rule', warning: '' };
    }

    const effectiveChars = getEffectiveTtsCharacters(cfg, chatKey);
    const ruleOpts = {
        html,
        role,
        charName,
        personaName,
        characters: effectiveChars,
    };

    const attachVoice = (segs) => segs.map((seg) => {
        const resolved = resolveSegmentVoice(seg, cfg, role === 'user' ? personaName : charName, chatKey);
        return {
            ...seg,
            speaker: resolved.speaker,
            gender: resolved.gender,
            voiceId: resolved.voiceId,
            toneTags: resolved.toneTags,
            instruction: resolved.instruction,
            speed: resolved.speed,
            matchedCharacter: resolved.matchedCharacter,
        };
    });

    if (cfg.parseMode === 'rule') {
        return {
            segments: attachVoice(parseSegmentsRuleBased(text, ruleOpts)),
            modeUsed: 'rule',
            warning: '',
        };
    }

    const fallbackSpeaker = String(role).toLowerCase() === 'user' ? personaName : charName;
    const plainForLlm = clean.replace(/[\uE000\uE001]/g, '*');

    try {
        if (typeof callLlm !== 'function') {
            throw new Error('대본 분석용 LLM이 설정되지 않았습니다.');
        }
        const messages = buildScriptDirectorMessages(plainForLlm, {
            role,
            charName,
            personaName,
            characters: effectiveChars,
        });
        const rawOut = await callLlm(messages);
        const parsed = parseScriptDirectorResponse(rawOut, fallbackSpeaker);
        return {
            segments: attachVoice(parsed),
            modeUsed: 'llm',
            warning: '',
        };
    } catch (err) {
        if (cfg.parseMode === 'llm') {
            throw err;
        }
        return {
            segments: attachVoice(parseSegmentsRuleBased(text, ruleOpts)),
            modeUsed: 'rule_fallback',
            warning: err && err.message ? err.message : 'LLM 대본 분석 실패로 규칙 파싱을 사용했습니다.',
        };
    }
}

// ================= Audio Synthesis & Provider Drivers =================

function formatToMime(format) {
    if (format === 'wav') return 'audio/wav';
    if (format === 'opus') return 'audio/ogg';
    return 'audio/mpeg';
}

function detectAudioMimeFromBytes(buf, fallbackFormat = 'mp3') {
    if (buf && buf.length >= 4) {
        if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'audio/wav'; // RIFF
        if (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return 'audio/ogg'; // OggS
        if (buf[0] === 0x66 && buf[1] === 0x4C && buf[2] === 0x61 && buf[3] === 0x43) return 'audio/flac'; // fLaC
        if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'audio/mpeg'; // ID3
        if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return 'audio/mpeg'; // MP3 frame sync
    }
    return formatToMime(fallbackFormat);
}

function isLikelyJsonOrHtmlError(buf, contentType = '') {
    const ct = String(contentType || '').toLowerCase();
    if (ct.includes('application/json') || ct.includes('text/html') || ct.startsWith('text/plain')) {
        return true;
    }
    if (!buf || !buf.length) return true;
    const head = buf.subarray(0, Math.min(buf.length, 64)).toString('utf8').trimStart();
    if (head.startsWith('{') || head.startsWith('<html') || head.startsWith('<!DOCTYPE')) {
        return true;
    }
    return false;
}

function createAbortSignal(timeoutMs, externalSignal) {
    const ctrl = new AbortController();
    const ms = Number(timeoutMs);
    const timer = (Number.isFinite(ms) && ms > 0)
        ? setTimeout(() => ctrl.abort(new Error(`TTS 요청 시간 초과 (${Math.round(ms / 1000)}초)`)), ms)
        : null;
    let onAbort = null;
    if (externalSignal) {
        if (externalSignal.aborted) ctrl.abort(externalSignal.reason);
        else {
            onAbort = () => ctrl.abort(externalSignal.reason);
            externalSignal.addEventListener('abort', onAbort, { once: true });
        }
    }
    return {
        signal: ctrl.signal,
        cleanup: () => {
            if (timer) clearTimeout(timer);
            if (externalSignal && onAbort) {
                externalSignal.removeEventListener('abort', onAbort);
            }
        },
    };
}

function createTtsProvider({ fetchImpl = fetch, maxCacheEntries = 120, maxCacheBytes = 48 * 1024 * 1024 } = {}) {
    const cache = new Map(); // key -> { bytes, mime, voiceId, toneTags, instruction, provider }
    let cacheBytes = 0;

    function clearCache() {
        cache.clear();
        cacheBytes = 0;
    }

    function getFromCache(key) {
        if (!cache.has(key)) return null;
        const entry = cache.get(key);
        cache.delete(key);
        cache.set(key, entry);
        return entry;
    }

    function putInCache(key, entry) {
        if (!entry || !entry.bytes || !entry.bytes.length) return;
        if (entry.bytes.length > maxCacheBytes) return;
        if (cache.has(key)) {
            cacheBytes -= cache.get(key).bytes.length;
            cache.delete(key);
        }
        while ((cache.size >= maxCacheEntries || (cacheBytes + entry.bytes.length) > maxCacheBytes) && cache.size > 0) {
            const oldestKey = cache.keys().next().value;
            const oldest = cache.get(oldestKey);
            cacheBytes -= oldest ? oldest.bytes.length : 0;
            cache.delete(oldestKey);
        }
        cache.set(key, entry);
        cacheBytes += entry.bytes.length;
    }

    async function callUpstreamTts(cfg, resolved, text, signal) {
        const provMeta = TTS_PROVIDER_DEFAULTS[cfg.provider] || TTS_PROVIDER_DEFAULTS.fish_local;
        const endpoint = cfg.apiUrl || provMeta.apiUrl;

        if (!provMeta.isLocal && !cfg.apiKey) {
            throw new Error(`${provMeta.label} API 키가 비어 있습니다. [모델/번역] 탭의 TTS 설정에서 API 키를 입력하세요.`);
        }

        let headers = { 'Content-Type': 'application/json' };
        let payload;

        if (provMeta.kind === 'fish') {
            const taggedText = formatFishTaggedText(text, resolved.toneTags, cfg.fishTagStyle);
            if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
            if (cfg.model) headers.model = cfg.model;
            payload = {
                text: taggedText,
                format: cfg.format || 'mp3',
                temperature: resolved.temperature,
                top_p: resolved.topP,
                ...(resolved.voiceId ? { reference_id: resolved.voiceId } : {}),
            };
        } else {
            headers.Authorization = `Bearer ${cfg.apiKey || 'local'}`;
            payload = {
                model: cfg.model || provMeta.model,
                input: text,
                voice: resolved.voiceId || 'alloy',
                response_format: cfg.format || 'mp3',
                speed: resolved.speed || 1.0,
                ...(resolved.instruction ? { instructions: resolved.instruction } : {}),
            };
        }

        const resp = await fetchImpl(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal,
        });

        const contentType = (resp.headers && typeof resp.headers.get === 'function')
            ? (resp.headers.get('content-type') || '')
            : '';

        if (!resp.ok) {
            const errTxt = await resp.text().catch(() => '');
            throw new Error(`TTS 서버 HTTP ${resp.status}: ${errTxt.slice(0, 300) || resp.statusText || '요청 실패'}`);
        }

        const bytes = Buffer.from(await resp.arrayBuffer());
        if (!bytes.length || isLikelyJsonOrHtmlError(bytes, contentType)) {
            const preview = bytes.subarray(0, 300).toString('utf8');
            throw new Error(`TTS 서버가 오디오 대신 오류 응답을 반환했습니다: ${preview}`);
        }

        const mime = contentType && contentType.toLowerCase().startsWith('audio/')
            ? contentType.split(';')[0].trim()
            : detectAudioMimeFromBytes(bytes, cfg.format);

        return { bytes, mime };
    }

    async function synthesizeSegment(segment, rawTtsConfig, opts = {}) {
        const cfg = normalizeTtsConfig(rawTtsConfig);
        const seg = (segment && typeof segment === 'object') ? segment : { text: String(segment || '') };
        const text = String(seg.text || '').replace(/[\uE000\uE001]/g, '').trim();
        if (!isSpeakableText(text)) {
            throw new Error('합성할 대사 또는 지문 텍스트가 비어 있습니다.');
        }

        const resolved = resolveSegmentVoice(seg, cfg, opts.charName || 'Character', opts.chatKey || '');
        if (opts.overrideVoiceId) {
            resolved.voiceId = String(opts.overrideVoiceId).trim();
        }

        const provMeta = TTS_PROVIDER_DEFAULTS[cfg.provider] || TTS_PROVIDER_DEFAULTS.fish_local;
        const endpoint = cfg.apiUrl || provMeta.apiUrl;
        const keySig = crypto.createHash('sha1').update(JSON.stringify({
            provider: cfg.provider,
            endpoint,
            model: cfg.model,
            format: cfg.format,
            fishTagStyle: cfg.fishTagStyle,
            voiceId: resolved.voiceId,
            toneTags: resolved.toneTags,
            instruction: provMeta.kind === 'openai_compat' ? resolved.instruction : '',
            speed: provMeta.kind === 'openai_compat' ? resolved.speed : 1,
            temperature: resolved.temperature,
            topP: resolved.topP,
            text,
        })).digest('hex');

        const cached = getFromCache(keySig);
        if (cached) {
            return {
                ...cached,
                cacheHit: true,
            };
        }

        // Keep playback synthesis alive until completion or explicit user cancellation (X button)
        const effectiveTimeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : 0;
        const { signal, cleanup } = createAbortSignal(effectiveTimeoutMs, opts.signal);
        try {
            const { bytes, mime } = await callUpstreamTts(cfg, resolved, text, signal);
            const entry = {
                bytes,
                mime,
                voiceId: resolved.voiceId,
                toneTags: resolved.toneTags,
                instruction: resolved.instruction,
                provider: cfg.provider,
            };
            putInCache(keySig, entry);
            return {
                ...entry,
                cacheHit: false,
            };
        } finally {
            cleanup();
        }
    }

    async function testConnection(rawTtsConfig, opts = {}) {
        const cfg = normalizeTtsConfig(rawTtsConfig);
        const sampleText = String(opts.text || '').trim() || '안녕하세요. RisuStand 음성 테스트입니다.';
        const seg = {
            kind: normalizeKind(opts.kind || 'dialogue'),
            speaker: String(opts.speaker || 'Tester').trim(),
            gender: normalizeGender(opts.gender || 'female'),
            tone: String(opts.toneTag || '').trim(),
            text: sampleText,
        };
        return await synthesizeSegment(seg, cfg, {
            overrideVoiceId: opts.voiceId ? String(opts.voiceId).trim() : '',
            chatKey: opts.chatKey || '',
            signal: opts.signal,
            timeoutMs: cfg.timeoutMs,
        });
    }

        return {
            synthesizeSegment,
            testConnection,
            clearCache,
            getCacheStats: () => ({ entries: cache.size, bytes: cacheBytes }),
        };
}

// ================= Endpoint Discovery & Model/Voice Loader =================

function decodeMinimalMsgpack(buf) {
    let pos = 0;
    const readStr = (len) => {
        const s = buf.toString('utf8', pos, pos + len);
        pos += len;
        return s;
    };
    function readVal() {
        if (pos >= buf.length) return undefined;
        const b = buf[pos++];
        if (b <= 0x7f) return b;
        if (b >= 0xe0) return b - 256;
        if (b >= 0x80 && b <= 0x8f) {
            const obj = {};
            const n = b & 0x0f;
            for (let i = 0; i < n; i += 1) { const k = readVal(); obj[String(k)] = readVal(); }
            return obj;
        }
        if (b >= 0x90 && b <= 0x9f) {
            const arr = [];
            const n = b & 0x0f;
            for (let i = 0; i < n; i += 1) arr.push(readVal());
            return arr;
        }
        if (b >= 0xa0 && b <= 0xbf) return readStr(b & 0x1f);
        if (b === 0xc0) return null;
        if (b === 0xc2) return false;
        if (b === 0xc3) return true;
        if (b === 0xcc) return buf[pos++];
        if (b === 0xcd) { const v = buf.readUInt16BE(pos); pos += 2; return v; }
        if (b === 0xce) { const v = buf.readUInt32BE(pos); pos += 4; return v; }
        if (b === 0xd9) return readStr(buf[pos++]);
        if (b === 0xda) { const l = buf.readUInt16BE(pos); pos += 2; return readStr(l); }
        if (b === 0xdc) {
            const n = buf.readUInt16BE(pos); pos += 2;
            const arr = [];
            for (let i = 0; i < n; i += 1) arr.push(readVal());
            return arr;
        }
        if (b === 0xde) {
            const n = buf.readUInt16BE(pos); pos += 2;
            const obj = {};
            for (let i = 0; i < n; i += 1) { const k = readVal(); obj[String(k)] = readVal(); }
            return obj;
        }
        return undefined;
    }
    return readVal();
}

function parseFishReferencesPayload(buf, contentType = '') {
    try {
        const ct = String(contentType || '').toLowerCase();
        const txt = buf.toString('utf8').trimStart();
        if (ct.includes('json') || txt.startsWith('{') || txt.startsWith('[')) {
            const j = JSON.parse(txt);
            const ids = Array.isArray(j) ? j : (Array.isArray(j && j.reference_ids) ? j.reference_ids : []);
            return ids.map((x) => String(x || '').trim()).filter(Boolean);
        }
        const decoded = decodeMinimalMsgpack(buf);
        if (decoded && Array.isArray(decoded.reference_ids)) {
            return decoded.reference_ids.map((x) => String(x || '').trim()).filter(Boolean);
        }
    } catch (_) {}
    return [];
}

function deriveEndpointRoots(resolvedEndpoint) {
    const u = new URL(resolvedEndpoint);
    const origin = u.origin;
    const p = u.pathname.replace(/\/+$/, '');
    let v1Base = `${origin}/v1`;
    if (p.endsWith('/v1/audio/speech')) v1Base = `${origin}${p.slice(0, -'/audio/speech'.length)}`;
    else if (p.endsWith('/v1/tts')) v1Base = `${origin}${p.slice(0, -'/tts'.length)}`;
    else if (p.endsWith('/audio/speech')) v1Base = `${origin}${p.slice(0, -'/audio/speech'.length)}`;
    else if (p.endsWith('/tts')) v1Base = `${origin}${p.slice(0, -'/tts'.length)}`;
    else if (p && p !== '/') v1Base = `${origin}${p}`;
    return { origin, v1Base };
}

function dedupeModels(list) {
    const out = [];
    const seen = new Set();
    for (const item of list) {
        const id = typeof item === 'string' ? item.trim() : String((item && item.id) || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const label = (item && typeof item === 'object' && item.label) ? String(item.label).trim() : id;
        out.push({ id, label });
    }
    return out;
}

async function fetchJsonWithTimeout(fetchImpl, url, opts = {}, timeoutMs = 4000) {
    const { signal, cleanup } = createAbortSignal(timeoutMs, opts.signal);
    try {
        const resp = await fetchImpl(url, { ...opts, signal });
        if (!resp.ok) return { ok: false, status: resp.status, data: null, contentType: '' };
        const ct = (resp.headers && typeof resp.headers.get === 'function') ? (resp.headers.get('content-type') || '') : '';
        const buf = Buffer.from(await resp.arrayBuffer());
        return { ok: true, status: resp.status, buf, contentType: ct };
    } catch (e) {
        return { ok: false, status: 0, error: e.message, data: null, contentType: '' };
    } finally {
        cleanup();
    }
}

function mapFishFamilyToModel(family) {
    const f = String(family || '').toLowerCase().trim();
    if (!f) return null;
    if (f === 's2' || f === 's2-pro' || f === 'dual_ar') return { id: 's2-pro', label: 's2-pro (로드됨 · S2-Pro)' };
    if (f === 'drama3' || f === 'drama-3' || f === 'fish_omni' || f === 'omni') return { id: 'drama-3', label: 'drama-3 (로드됨 · Drama 3)' };
    if (f === 's1') return { id: 's1', label: 's1 (로드됨 · S1)' };
    return { id: f, label: `${f} (로드됨)` };
}

async function listTtsModels(rawTtsConfig, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
    const cfg = normalizeTtsConfig(rawTtsConfig);
    const provMeta = TTS_PROVIDER_DEFAULTS[cfg.provider] || TTS_PROVIDER_DEFAULTS.fish_local;
    const resolvedEndpoint = normalizeTtsEndpointUrl(cfg.apiUrl, cfg.provider) || provMeta.apiUrl;
    const { origin, v1Base } = deriveEndpointRoots(resolvedEndpoint);
    const authHeaders = cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};

    if (cfg.provider === 'fish_local') {
        const [healthR, defR, refsR] = await Promise.all([
            fetchJsonWithTimeout(fetchImpl, `${origin}/v1/health`, { headers: authHeaders }, timeoutMs),
            fetchJsonWithTimeout(fetchImpl, `${origin}/v1/tts/defaults`, { headers: authHeaders }, timeoutMs),
            fetchJsonWithTimeout(fetchImpl, `${origin}/v1/references/list`, { headers: { ...authHeaders, Accept: 'application/json' } }, timeoutMs),
        ]);

        const healthy = Boolean(healthR.ok);
        let detectedFamily = '';
        const models = [];
        if (defR.ok && defR.buf) {
            try {
                const defJson = JSON.parse(defR.buf.toString('utf8'));
                detectedFamily = String(defJson.model_family || '').trim();
                const mapped = mapFishFamilyToModel(detectedFamily);
                if (mapped) models.push(mapped);
            } catch (_) {}
        }
        models.push(
            { id: 's2-pro', label: 's2-pro' },
            { id: 'drama-3', label: 'drama-3' },
            { id: 's1', label: 's1' }
        );
        const voices = refsR.ok && refsR.buf ? parseFishReferencesPayload(refsR.buf, refsR.contentType) : [];
        const voiceItems = voices.map((id) => ({ id, label: id, group: 'fish' }));
        const deduped = dedupeModels(models);
        const statusMsg = healthy
            ? `Fish 로컬 서버 연결됨 (${detectedFamily ? '로드됨: ' + detectedFamily : '응답 정상'}) · 보이스 ${voices.length}개`
            : '로컬 Fish 서버에 연결하지 못했습니다. 기본 모델 목록만 표시합니다.';
        return { models: deduped, voices, voiceGroup: 'fish', voiceItems, detectedFamily, healthy, resolvedEndpoint, statusMsg };
    }

    if (cfg.provider === 'fish_cloud') {
        const models = dedupeModels([
            { id: 's2-pro', label: 's2-pro (최신 S2-Pro)' },
            { id: 's2.1-pro', label: 's2.1-pro' },
            { id: 's2.1-pro-free', label: 's2.1-pro-free' },
            { id: 'drama-3', label: 'drama-3' },
            { id: 's1', label: 's1' },
        ]);
        let voices = [];
        let voiceItems = [];
        if (cfg.apiKey) {
            const vr = await fetchJsonWithTimeout(fetchImpl, 'https://api.fish.audio/model?self=true&page_size=20', {
                headers: { Authorization: `Bearer ${cfg.apiKey}` },
            }, timeoutMs);
            if (vr.ok && vr.buf) {
                try {
                    const vj = JSON.parse(vr.buf.toString('utf8'));
                    const items = Array.isArray(vj && vj.items) ? vj.items : (Array.isArray(vj) ? vj : []);
                    for (const x of items) {
                        const id = String((x && (x._id || x.id)) || '').trim();
                        if (!id) continue;
                        const title = String((x && (x.title || x.name)) || '').trim();
                        voices.push(id);
                        voiceItems.push({ id, label: title ? `${title} (${id})` : id, group: 'fish' });
                    }
                } catch (_) {}
            }
        }
        return {
            models,
            voices,
            voiceGroup: 'fish',
            voiceItems,
            detectedFamily: '',
            healthy: true,
            resolvedEndpoint,
            statusMsg: `Fish Audio Cloud 모델 ${models.length}개` + (voices.length ? ` · 내 보이스 ${voices.length}개` : ''),
        };
    }

    // openai_compat_local | openai_compat_cloud
    const modelsHeaders = { Authorization: `Bearer ${cfg.apiKey || 'local'}` };
    const [mRes, vRes] = await Promise.all([
        fetchJsonWithTimeout(fetchImpl, `${v1Base}/models`, { headers: modelsHeaders }, timeoutMs),
        cfg.provider === 'openai_compat_local'
            ? fetchJsonWithTimeout(fetchImpl, `${v1Base}/audio/voices`, { headers: modelsHeaders }, Math.min(timeoutMs, 3000))
            : Promise.resolve({ ok: false }),
    ]);

    let rawIds = [];
    if (mRes.ok && mRes.buf) {
        try {
            const mj = JSON.parse(mRes.buf.toString('utf8'));
            const arr = Array.isArray(mj && mj.data) ? mj.data : (Array.isArray(mj && mj.models) ? mj.models : (Array.isArray(mj) ? mj : []));
            rawIds = arr.map((x) => (typeof x === 'string' ? x : String((x && (x.id || x.name)) || ''))).filter(Boolean);
        } catch (_) {}
    }

    let models;
    let voices = [];
    if (cfg.provider === 'openai_compat_cloud') {
        const ttsFiltered = rawIds.filter((id) => /tts|speech|audio|kokoro|fish|s2-pro|drama/i.test(id));
        const baseList = [
            { id: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts (톤 지시 지원)' },
            { id: 'tts-1', label: 'tts-1' },
            { id: 'tts-1-hd', label: 'tts-1-hd' },
            ...ttsFiltered.map((id) => ({ id, label: id })),
        ];
        models = dedupeModels(baseList);
        voices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
    } else {
        models = dedupeModels(rawIds.length ? rawIds : ['tts-1', 'fish-speech-s2-pro', 'kokoro', 'qwen3-tts']);
        if (vRes.ok && vRes.buf) {
            try {
                const vj = JSON.parse(vRes.buf.toString('utf8'));
                const varr = Array.isArray(vj && vj.voices) ? vj.voices : (Array.isArray(vj) ? vj : []);
                voices = varr.map((x) => (typeof x === 'string' ? x : String((x && (x.id || x.name)) || ''))).filter(Boolean);
            } catch (_) {}
        }
    }

    const voiceItems = voices.map((id) => ({ id, label: id, group: 'openai_qwen' }));
    const healthy = Boolean(mRes.ok);
    const statusMsg = healthy
        ? `서버에서 ${models.length}개 모델을 불러왔습니다.` + (voices.length ? ` · 보이스 ${voices.length}개` : '')
        : (cfg.provider === 'openai_compat_cloud'
            ? `기본 OpenAI TTS 모델 ${models.length}개 표시 (API 키를 입력하면 실시간 조회 가능)`
            : '로컬 /v1/models 조회 실패 — 기본 모델 목록을 표시합니다.');
    return { models, voices, voiceGroup: 'openai_qwen', voiceItems, detectedFamily: '', healthy, resolvedEndpoint, statusMsg };
}

async function scanLocalTtsServers({ fetchImpl = fetch, timeoutMs = 1500 } = {}) {
    const candidates = [
        { origin: 'http://127.0.0.1:8081', tag: '127.0.0.1:8081' },
        { origin: 'http://127.0.0.1:8080', tag: '127.0.0.1:8080' },
        { origin: 'http://127.0.0.1:8881', tag: '127.0.0.1:8881' },
        { origin: 'http://127.0.0.1:8000', tag: '127.0.0.1:8000' },
    ];

    const probes = candidates.map(async (c) => {
        // Check Fish /v1/tts/defaults first
        const fishDef = await fetchJsonWithTimeout(fetchImpl, `${c.origin}/v1/tts/defaults`, {}, timeoutMs);
        if (fishDef.ok && fishDef.buf) {
            try {
                const j = JSON.parse(fishDef.buf.toString('utf8'));
                if (j && typeof j === 'object' && ('model_family' in j || 'chunk_length' in j)) {
                    const mapped = mapFishFamilyToModel(j.model_family) || { id: 's2-pro', label: 's2-pro' };
                    return {
                        id: `fish_${c.tag}`,
                        label: `Fish Speech (${mapped.id}) · ${c.tag}`,
                        provider: 'fish_local',
                        apiUrl: `${c.origin}/v1/tts`,
                        model: mapped.id,
                        models: dedupeModels([mapped, 's2-pro', 'drama-3', 's1']),
                        fishTagStyle: 'brackets',
                    };
                }
            } catch (_) {}
        }

        // Check OpenAI-compatible /v1/models (LocalAI, Qwen3-TTS, vLLM-Omni, Speaches, TTS-WebUI)
        const oaModels = await fetchJsonWithTimeout(fetchImpl, `${c.origin}/v1/models`, {}, timeoutMs);
        if (oaModels.ok && oaModels.buf) {
            try {
                const mj = JSON.parse(oaModels.buf.toString('utf8'));
                const arr = Array.isArray(mj && mj.data) ? mj.data : (Array.isArray(mj && mj.models) ? mj.models : []);
                const ids = arr.map((x) => (typeof x === 'string' ? x : String((x && (x.id || x.name)) || ''))).filter(Boolean);
                const firstModel = ids[0] || 'tts-1';
                return {
                    id: `openai_${c.tag}`,
                    label: `OpenAI 호환 로컬 허브 (${ids.length ? firstModel : '대기중'}) · ${c.tag}`,
                    provider: 'openai_compat_local',
                    apiUrl: `${c.origin}/v1/audio/speech`,
                    model: firstModel,
                    models: dedupeModels(ids.length ? ids : ['tts-1']),
                    fishTagStyle: 'none',
                };
            } catch (_) {}
        }
        return null;
    });

    const settled = await Promise.all(probes);
    return settled.filter(Boolean);
}

module.exports = {
    TTS_PROVIDER_DEFAULTS,
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
    buildScriptDirectorMessages,
    parseScriptDirectorResponse,
    analyzeTtsSegments,
    resolveSegmentVoice,
    formatFishTaggedText,
    detectAudioMimeFromBytes,
    listTtsModels,
    scanLocalTtsServers,
    createTtsProvider,
};
