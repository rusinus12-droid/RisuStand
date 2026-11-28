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
const fs = require('node:fs');
const path = require('node:path');

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
    Object.freeze({ id: 'openai', label: '🤖 OpenAI' }),
    Object.freeze({ id: 'qwen', label: '🎙️ Qwen3-TTS' }),
]);

const TTS_BUILTIN_VOICE_REFERENCES = Object.freeze({
    fish: Object.freeze([]),
    openai: Object.freeze([
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
    ]),
    qwen: Object.freeze([
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

const TTS_SPEECH_MODEL_SPECS = Object.freeze({
    fish_s2: Object.freeze({
        id: 'fish_s2',
        voiceGroup: 'fish',
        deliveryMode: 'inline_tag',
        tagSyntax: 'brackets',
        label: 'Fish Audio S2 ([대괄호] 감정·발성 태그)',
        recommendedTags: Object.freeze([
            'calm', 'soft', 'gentle', 'happy', 'cheerful', 'excited', 'sad', 'melancholic',
            'angry', 'cold', 'nervous', 'shy', 'fearful', 'surprised', 'sarcastic', 'serious',
            'confident', 'playful', 'affectionate', 'whispering', 'quiet', 'softly', 'sighing',
            'breathless', 'shouting', 'hesitant', 'tired', 'laughing', 'chuckling', 'crying', 'soft tone',
        ]),
        llmGuide: 'Target TTS model is Fish Audio S2 (supports inline [tag] bracket cues). For each segment, put 1-2 short English emotion/delivery cues in `tone` reflecting the character\'s personality and line emotion (e.g. "playful", "shy", "whispering", "soft tone", "sighing", "chuckling") WITHOUT brackets — the backend prepends [...]. NEVER put [tag] inside `text`. Keep `instruction` brief or empty.',
    }),
    fish_s1: Object.freeze({
        id: 'fish_s1',
        voiceGroup: 'fish',
        deliveryMode: 'inline_tag',
        tagSyntax: 'parens',
        label: 'Fish Audio S1 ((소괄호) 감정·발성 태그)',
        recommendedTags: Object.freeze([
            'angry', 'sad', 'disdainful', 'excited', 'surprised', 'satisfied', 'anxious', 'delighted',
            'scared', 'worried', 'indifferent', 'upset', 'impatient', 'nervous', 'guilty', 'scornful',
            'frustrated', 'depressed', 'panicked', 'furious', 'empathetic', 'embarrassed', 'reluctant',
            'disgusted', 'moved', 'proud', 'relaxed', 'grateful', 'confident', 'interested', 'curious',
            'confused', 'joyful', 'whispering', 'shouting', 'soft tone', 'sighing', 'laughing',
            'chuckling', 'sobbing', 'panting',
        ]),
        llmGuide: 'Target TTS model is Fish Audio S1 (fixed (tag) parenthesis cue vocabulary). Choose `tone` strictly from the Fish S1 vocabulary (e.g. "joyful", "relaxed", "soft tone", "whispering", "embarrassed", "scornful", "sighing", "laughing") WITHOUT parentheses — the backend prepends (...). NEVER put (tag) or [tag] inside `text`. Keep `instruction` brief or empty.',
    }),
    fish_plain: Object.freeze({
        id: 'fish_plain',
        voiceGroup: 'fish',
        deliveryMode: 'none',
        tagSyntax: 'none',
        label: 'Fish Audio (태그 삽입 비활성)',
        recommendedTags: Object.freeze(['calm', 'soft', 'happy', 'sad', 'angry', 'whispering']),
        llmGuide: 'Inline tags are disabled for this Fish setup. Do NOT embed [tag] or (tag) inside `text`. Optionally put a simple emotion keyword in `tone` for metadata only.',
    }),
    openai_tts: Object.freeze({
        id: 'openai_tts',
        voiceGroup: 'openai',
        deliveryMode: 'instruction',
        tagSyntax: 'instruction',
        label: 'OpenAI TTS (instructions 발성·연기 지시문)',
        recommendedTags: Object.freeze([
            'calm', 'warm', 'playful', 'gentle', 'whispering', 'serious', 'sarcastic', 'sad', 'angry', 'nervous', 'excited',
        ]),
        llmGuide: 'Target TTS model is OpenAI TTS (gpt-4o-mini-tts), which uses a separate `instructions` acting parameter instead of inline bracket tags. NEVER write [tag] or (tag) inside `text` (OpenAI reads bracketed words aloud!). Instead, write a concise 1-sentence English voice acting direction in `instruction` describing vocal tone, personality attitude, emotion, and pacing (e.g. "Warm, teasing female voice; speak lightly with amused energy and slightly brisk pace."), plus a 1-word mood in `tone`.',
    }),
    qwen3_tts: Object.freeze({
        id: 'qwen3_tts',
        voiceGroup: 'qwen',
        deliveryMode: 'instruction',
        tagSyntax: 'instruction',
        label: 'Qwen3-TTS (instructions 감정·말투 지시문)',
        recommendedTags: Object.freeze([
            'calm', 'warm', 'playful', 'gentle', 'whispering', 'serious', 'sarcastic', 'sad', 'angry', 'nervous', 'excited', 'shy',
        ]),
        llmGuide: 'Target TTS model is Qwen3-TTS (/v1/audio/speech with `instructions` style prompt). NEVER put [tag] or (tag) inside `text` (it would be spoken aloud!). Instead, write a concise natural-language vocal acting direction in `instruction` (Korean or English) describing the character\'s personality-driven timbre, emotion, and delivery pace (e.g. "밝고 장난기 어린 한국어 여성 목소리, 살짝 들뜬 어조로 자연스럽게 말하기"), plus a short emotion keyword in `tone`.',
    }),
});

const VALID_SPEECH_MODEL_SPEC_IDS = Object.freeze(['fish_s2', 'fish_s1', 'openai_tts', 'qwen3_tts']);

const FISH_S1_TAG_ALIAS_MAP = Object.freeze({
    happy: 'joyful',
    cheerful: 'joyful',
    playful: 'delighted',
    soft: 'soft tone',
    gentle: 'soft tone',
    affectionate: 'empathetic',
    softly: 'soft tone',
    shy: 'embarrassed',
    calm: 'relaxed',
    quiet: 'whispering',
    fearful: 'scared',
    hesitant: 'reluctant',
    sarcastic: 'scornful',
    cold: 'indifferent',
    crying: 'sobbing',
    breathless: 'panting',
    melancholic: 'depressed',
    serious: 'confident',
    tired: 'relaxed',
});

function resolveTtsSpeechModelSpec(ttsConfig = {}) {
    const raw = (ttsConfig && typeof ttsConfig === 'object') ? ttsConfig : {};
    const provRaw = String(raw.provider || 'fish_local').toLowerCase().trim();
    const provider = VALID_PROVIDERS.includes(provRaw) ? provRaw : 'fish_local';
    const provMeta = TTS_PROVIDER_DEFAULTS[provider] || TTS_PROVIDER_DEFAULTS.fish_local;
    const model = String(raw.model !== undefined ? raw.model : provMeta.model).trim();
    const tagStyleRaw = String(raw.fishTagStyle || 'brackets').toLowerCase().trim();
    const fishTagStyle = VALID_FISH_TAG_STYLES.includes(tagStyleRaw) ? tagStyleRaw : 'brackets';

    if (provMeta.kind === 'fish') {
        if (fishTagStyle === 'none') return TTS_SPEECH_MODEL_SPECS.fish_plain;
        if (fishTagStyle === 'parens' || /^s1\b|speech-1/i.test(model)) return TTS_SPEECH_MODEL_SPECS.fish_s1;
        return TTS_SPEECH_MODEL_SPECS.fish_s2;
    }
    if (provider === 'openai_compat_cloud') {
        return TTS_SPEECH_MODEL_SPECS.openai_tts;
    }
    return TTS_SPEECH_MODEL_SPECS.qwen3_tts;
}

function sanitizeModelToneTag(rawTag, modelSpec) {
    let s = String(rawTag || '').trim().replace(/^[\[(]+|[\])]+$/g, '').trim();
    if (!s) return '';
    if (s.includes(',')) {
        s = s.split(',')[0].trim();
    }
    s = s.slice(0, 40).trim();
    if (!s) return '';
    if (modelSpec && modelSpec.id === 'fish_s1') {
        const lower = s.toLowerCase();
        if (FISH_S1_TAG_ALIAS_MAP[lower]) return FISH_S1_TAG_ALIAS_MAP[lower];
        const exact = TTS_SPEECH_MODEL_SPECS.fish_s1.recommendedTags.find((t) => t.toLowerCase() === lower);
        return exact || lower;
    }
    return s;
}

function normalizeVoiceGroup(g, fallback = '') {
    const s = String(g || '').toLowerCase().trim();
    if (s === 'fish' || s === 'fish_local' || s === 'fish_cloud') return 'fish';
    if (s === 'openai' || s === 'openai_compat_cloud') return 'openai';
    if (s === 'qwen' || s === 'qwen3' || s === 'qwen3-tts' || s === 'openai_compat_local') return 'qwen';
    if (s === 'openai_qwen') return 'openai';
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

function isQwenVoiceEntry(entry) {
    if (!entry) return false;
    const id = String(entry.id || '').trim();
    const label = String(entry.label || '').trim();
    if (TTS_BUILTIN_VOICE_REFERENCES.qwen.some((v) => v.id.toLowerCase() === id.toLowerCase())) return true;
    return /qwen/i.test(id) || /qwen/i.test(label);
}

function normalizeVoiceProfiles(raw) {
    const out = { fish: [], openai: [], qwen: [] };
    if (!raw || typeof raw !== 'object') return out;
    const seenByGroup = { fish: new Set(), openai: new Set(), qwen: new Set() };
    const pushUnique = (group, item) => {
        const entry = normalizeVoiceProfileEntry(item);
        if (!entry || seenByGroup[group].has(entry.id)) return;
        seenByGroup[group].add(entry.id);
        out[group].push(entry);
    };
    for (const group of ['fish', 'openai', 'qwen']) {
        const arr = Array.isArray(raw[group]) ? raw[group] : [];
        for (const item of arr) pushUnique(group, item);
    }
    const legacyArr = Array.isArray(raw.openai_qwen) ? raw.openai_qwen : [];
    for (const item of legacyArr) {
        const entry = normalizeVoiceProfileEntry(item);
        if (!entry) continue;
        pushUnique(isQwenVoiceEntry(entry) ? 'qwen' : 'openai', entry);
    }
    return out;
}

function inferTtsVoiceGroup(voiceId, provider = 'fish_local', voiceProfiles = null) {
    const id = String(voiceId || '').trim();
    const prof = normalizeVoiceProfiles(voiceProfiles);
    if (id) {
        if (prof.fish.some((v) => v.id === id)) return 'fish';
        if (prof.openai.some((v) => v.id === id)) return 'openai';
        if (prof.qwen.some((v) => v.id === id)) return 'qwen';
        if (TTS_BUILTIN_VOICE_REFERENCES.openai.some((v) => v.id.toLowerCase() === id.toLowerCase())) {
            return 'openai';
        }
        if (TTS_BUILTIN_VOICE_REFERENCES.qwen.some((v) => v.id.toLowerCase() === id.toLowerCase())) {
            return 'qwen';
        }
    }
    const provMeta = TTS_PROVIDER_DEFAULTS[provider] || TTS_PROVIDER_DEFAULTS.fish_local;
    if (provMeta.kind === 'fish') return 'fish';
    return provider === 'openai_compat_cloud' ? 'openai' : 'qwen';
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

function buildTtsBotKey(input) {
    if (typeof input === 'string') {
        const s = input.trim();
        if (!s || s === '__global__') return '';
        const chatMatch = s.match(/^(.+?):r\d+$/i);
        return (chatMatch ? chatMatch[1] : s).trim().slice(0, 160);
    }
    if (!input || typeof input !== 'object') return '';
    const charCtx = (input.charContext && typeof input.charContext === 'object') ? input.charContext : null;
    const rawId = (charCtx && (charCtx.charId || charCtx.chaId)) || input.botKey || input.chaId || input.charId || '';
    const cleanId = String(rawId || '').trim();
    if (cleanId && cleanId !== '__global__') {
        const chatMatch = cleanId.match(/^(.+?):r\d+$/i);
        return (chatMatch ? chatMatch[1] : cleanId).trim().slice(0, 160);
    }
    const idxRaw = input.charIndex !== undefined ? input.charIndex : input.index;
    const charIdx = Number(idxRaw);
    if (idxRaw !== undefined && idxRaw !== null && idxRaw !== '' && Number.isFinite(charIdx) && charIdx >= 0) {
        return `c${Math.trunc(charIdx)}`;
    }
    const charName = String(input.charName || (charCtx && charCtx.name) || input.name || '').trim();
    if (charName) return `name:${charName}`.slice(0, 160);
    return '';
}

function buildTtsChatKey(snap) {
    if (!snap || typeof snap !== 'object') return '';
    const charPart = buildTtsBotKey(snap);
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
        characterVoicesEnabled: true,
        autoLearnBotProfiles: true,
        characters: [],
        botCharacters: {},
        chatCharacters: {},
        voiceProfiles: {
            fish: [],
            openai: [],
            qwen: [],
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

function normalizeSpeechTagsByModel(rawMap) {
    const out = {};
    if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return out;
    for (const key of VALID_SPEECH_MODEL_SPEC_IDS) {
        const src = rawMap[key];
        if (!src || typeof src !== 'object') continue;
        const entry = {
            dialogueTag: String(src.dialogueTag || src.dialogueToneTag || '').trim().slice(0, 60),
            thoughtTag: String(src.thoughtTag || src.thoughtToneTag || '').trim().slice(0, 60),
            dialogueInstruction: String(src.dialogueInstruction || '').trim().slice(0, 260),
            thoughtInstruction: String(src.thoughtInstruction || '').trim().slice(0, 260),
        };
        if (entry.dialogueTag || entry.thoughtTag || entry.dialogueInstruction || entry.thoughtInstruction) {
            out[key] = entry;
        }
    }
    return out;
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
        personality: String(raw.personality || '').trim().slice(0, 280),
        speechStyle: String(raw.speechStyle || '').trim().slice(0, 280),
        dialogueToneTag: String(raw.dialogueToneTag || raw.dialogueTag || '').trim(),
        thoughtToneTag: String(raw.thoughtToneTag !== undefined ? raw.thoughtToneTag : (raw.thoughtTag !== undefined ? raw.thoughtTag : 'whispering')).trim(),
        dialogueInstruction: String(raw.dialogueInstruction || '').trim().slice(0, 260),
        thoughtInstruction: String(raw.thoughtInstruction || '').trim().slice(0, 260),
        speechTagsByModel: normalizeSpeechTagsByModel(raw.speechTagsByModel),
        speed: clampNum(raw.speed, 1.0, 0.5, 2.0),
        thoughtSpeed: clampNum(raw.thoughtSpeed, 0.94, 0.5, 2.0),
        autoGenerated: Boolean(raw.autoGenerated),
        updatedAt: Number.isFinite(Number(raw.updatedAt)) && Number(raw.updatedAt) > 0 ? Math.trunc(Number(raw.updatedAt)) : 0,
    };
}

function normalizeBotCharactersMap(rawBotChars) {
    const out = {};
    if (!rawBotChars || typeof rawBotChars !== 'object' || Array.isArray(rawBotChars)) return out;
    for (const [rawKey, rawVal] of Object.entries(rawBotChars)) {
        const botKey = buildTtsBotKey(rawKey);
        if (!botKey) continue;
        const rawList = Array.isArray(rawVal)
            ? rawVal
            : (rawVal && Array.isArray(rawVal.characters) ? rawVal.characters : null);
        if (!rawList) continue;
        const seen = new Set();
        const characters = [];
        for (let i = 0; i < rawList.length; i += 1) {
            const norm = normalizeCharacterVoice(rawList[i], i);
            if (!norm) continue;
            const lowerName = norm.name.toLowerCase();
            if (seen.has(lowerName)) continue;
            seen.add(lowerName);
            characters.push(norm);
        }
        const botName = (rawVal && typeof rawVal === 'object' && !Array.isArray(rawVal))
            ? String(rawVal.botName || '').trim().slice(0, 120)
            : '';
        const updatedAt = (rawVal && typeof rawVal === 'object' && !Array.isArray(rawVal) && Number.isFinite(Number(rawVal.updatedAt)))
            ? Math.max(0, Math.trunc(Number(rawVal.updatedAt)))
            : 0;
        out[botKey] = { botKey, botName, updatedAt, characters };
    }
    return out;
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
    const botCharacters = normalizeBotCharactersMap(raw.botCharacters);

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
        characterVoicesEnabled: raw.characterVoicesEnabled !== undefined ? Boolean(raw.characterVoicesEnabled) : def.characterVoicesEnabled,
        autoLearnBotProfiles: raw.autoLearnBotProfiles !== undefined ? Boolean(raw.autoLearnBotProfiles) : def.autoLearnBotProfiles,
        characters,
        botCharacters,
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

function formatSavedProfileHint(c, modelSpec) {
    const aliasPart = (c.aliases && c.aliases.length) ? ` (aliases: ${c.aliases.join(', ')})` : '';
    const bits = [`- ${c.name}${aliasPart} [gender: ${c.gender}]`];
    if (c.personality) bits.push(`personality: ${c.personality}`);
    if (c.speechStyle) bits.push(`speechStyle: ${c.speechStyle}`);
    const modelTags = (c.speechTagsByModel && modelSpec && c.speechTagsByModel[modelSpec.id]) || null;
    if (modelSpec && modelSpec.deliveryMode === 'instruction') {
        const dInstr = (modelTags && modelTags.dialogueInstruction) || c.dialogueInstruction || '';
        const tInstr = (modelTags && modelTags.thoughtInstruction) || c.thoughtInstruction || '';
        if (dInstr) bits.push(`dialogueInstruction: ${dInstr}`);
        if (tInstr) bits.push(`thoughtInstruction: ${tInstr}`);
    } else {
        const dTag = (modelTags && modelTags.dialogueTag) || c.dialogueToneTag || '';
        const tTag = (modelTags && modelTags.thoughtTag) || c.thoughtToneTag || '';
        if (dTag) bits.push(`dialogueTag: ${dTag}`);
        if (tTag) bits.push(`thoughtTag: ${tTag}`);
    }
    return bits.join(' | ');
}

function buildScriptDirectorMessages(cleanText, options = {}) {
    const characters = Array.isArray(options.characters) ? options.characters : [];
    const role = String(options.role || 'char').toLowerCase();
    const charName = String(options.charName || 'Character').trim();
    const personaName = String(options.personaName || '나').trim();
    const modelSpec = options.modelSpec || resolveTtsSpeechModelSpec(options.ttsConfig || {});
    const botCtx = (options.botContext && typeof options.botContext === 'object') ? options.botContext : null;

    const castLines = characters
        .filter((c) => c && c.name)
        .map((c) => formatSavedProfileHint(c, modelSpec));

    const castHint = castLines.length
        ? `Saved Bot Character Speech Profiles:\n${castLines.join('\n')}`
        : 'Saved Bot Character Speech Profiles: (none saved yet — analyze speakers from text/context and emit characterProfiles)';

    const ctxBits = [];
    if (botCtx) {
        if (botCtx.desc) ctxBits.push(`Character Sheet Summary:\n${String(botCtx.desc).trim().slice(0, 700)}`);
        if (botCtx.loreSummary) ctxBits.push(`World/Cast Notes:\n${String(botCtx.loreSummary).trim().slice(0, 700)}`);
    }
    const botCtxBlock = ctxBits.length ? `${ctxBits.join('\n\n')}\n\n` : '';

    const recommendedHint = (modelSpec.recommendedTags && modelSpec.recommendedTags.length)
        ? `Recommended tags for ${modelSpec.id}: ${modelSpec.recommendedTags.join(', ')}`
        : '';

    const sysPrompt = [
        'You are an advanced TTS Script Director & Character Voice Profiler for a roleplay/novel reader.',
        'Analyze each speaking character\'s personality, temperament, speech habits, and situational emotion, then split the input message into ordered voice-acting segments.',
        `Active Speech Model: ${modelSpec.label}`,
        `Model Tag Specification: ${modelSpec.llmGuide}`,
        recommendedHint,
        'Output ONLY valid JSON matching:',
        '{"characterProfiles":[{"name":"string","aliases":["string"],"gender":"female"|"male"|"neutral","personality":"short personality traits","speechStyle":"voice cadence & speaking style","dialogueTag":"model-appropriate default dialogue cue","thoughtTag":"model-appropriate default inner-thought cue","dialogueInstruction":"voice acting direction for dialogue","thoughtInstruction":"voice acting direction for inner thought"}],"segments":[{"kind":"narration"|"dialogue"|"thought","speaker":"string","gender":"female"|"male"|"neutral","tone":"string","instruction":"string","text":"string"}]}',
        'Rules:',
        '1. Preserve the exact original text in chronological order without summarizing, translating, or dropping words.',
        '2. Strip surrounding quotation marks ("", “”, 「」, \'\', ‘’, 『』, **) AND strip any inline [tag] or (tag) markers from `text`.',
        '3. Classify `kind` strictly:',
        '   - "dialogue": spoken lines aloud ("...", “...”, 「...」)',
        '   - "thought": silent inner thoughts/monologue (\'...\', ‘...’, 『...』, *...*, or clear internal thoughts)',
        '   - "narration": descriptive prose and action beats',
        '4. Set `speaker` to "Narrator" for narration. For dialogue/thought, match the exact Saved Bot Character Speech Profile `name` when speaking, otherwise infer the true character name (fallback: "' + (role === 'user' ? personaName : charName) + '"). Never use "Narrator" as a character.',
        '5. Set `gender` to "female", "male", or "neutral" consistently with the character\'s profile and context.',
        '6. Tailor `tone` and `instruction` for each segment to BOTH the character\'s underlying personality AND the line\'s momentary emotion, strictly following the Active Speech Model specification above.',
        '7. In `characterProfiles`, include every distinct speaking character (excluding "Narrator") who speaks/thinks in the message, with concise `personality`, `speechStyle`, and model-appropriate default speech tags/instructions so their profile can be saved for this bot.',
        '8. Do NOT output markdown fences or any commentary outside the JSON object.',
    ].filter(Boolean).join('\n');

    const userPrompt = [
        `Message Role: ${role === 'user' ? `user (${personaName})` : `assistant (${charName})`}`,
        castHint,
        `${botCtxBlock}Input Text:\n${cleanText}`,
    ].join('\n\n');

    return [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userPrompt },
    ];
}

function normalizeModelCharacterProfileDraft(raw, modelSpec, idx = 0) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name || '').trim();
    if (!name || name.toLowerCase() === 'narrator') return null;
    const specId = (modelSpec && VALID_SPEECH_MODEL_SPEC_IDS.includes(modelSpec.id)) ? modelSpec.id : 'fish_s2';
    const dTagRaw = raw.dialogueTag !== undefined ? raw.dialogueTag : raw.dialogueToneTag;
    const tTagRaw = raw.thoughtTag !== undefined ? raw.thoughtTag : raw.thoughtToneTag;
    const dTag = modelSpec && modelSpec.deliveryMode === 'inline_tag'
        ? sanitizeModelToneTag(dTagRaw, modelSpec)
        : String(dTagRaw || '').trim().slice(0, 60);
    const tTag = modelSpec && modelSpec.deliveryMode === 'inline_tag'
        ? sanitizeModelToneTag(tTagRaw, modelSpec)
        : String(tTagRaw || '').trim().slice(0, 60);
    const dInstr = String(raw.dialogueInstruction || '').trim().slice(0, 260);
    const tInstr = String(raw.thoughtInstruction || '').trim().slice(0, 260);
    const speechTagsByModel = normalizeSpeechTagsByModel(raw.speechTagsByModel);
    if (dTag || tTag || dInstr || tInstr) {
        speechTagsByModel[specId] = {
            dialogueTag: dTag,
            thoughtTag: tTag || (modelSpec && modelSpec.deliveryMode === 'inline_tag' ? 'whispering' : ''),
            dialogueInstruction: dInstr,
            thoughtInstruction: tInstr,
        };
    }
    return normalizeCharacterVoice({
        id: raw.id || `tts-char-${Date.now()}-${idx + 1}`,
        name,
        aliases: raw.aliases,
        gender: raw.gender,
        voiceGroup: raw.voiceGroup || (raw.voiceId && modelSpec ? modelSpec.voiceGroup : ''),
        voiceId: raw.voiceId || '',
        personality: raw.personality || '',
        speechStyle: raw.speechStyle || '',
        dialogueToneTag: dTag,
        thoughtToneTag: tTag || 'whispering',
        dialogueInstruction: dInstr,
        thoughtInstruction: tInstr,
        speechTagsByModel,
        speed: raw.speed,
        thoughtSpeed: raw.thoughtSpeed,
        autoGenerated: true,
        updatedAt: Date.now(),
    }, idx);
}

function parseScriptDirectorResult(rawOutput, fallbackSpeaker = 'Character', maxChunkChars = 260, modelSpec = null) {
    const parsed = extractJsonPayload(rawOutput);
    const list = Array.isArray(parsed)
        ? parsed
        : (parsed && Array.isArray(parsed.segments) ? parsed.segments : null);
    if (!list || !list.length) {
        throw new Error('LLM 대본 분석 결과에 segments 배열이 없습니다.');
    }

    const segments = [];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const kind = normalizeKind(item.kind);
        const gender = kind === 'narration' ? 'neutral' : normalizeGender(item.gender);
        const speaker = kind === 'narration'
            ? 'Narrator'
            : (String(item.speaker || '').trim() || fallbackSpeaker);
        const rawTone = item.tone !== undefined ? item.tone : item.speechTag;
        const tone = modelSpec
            ? sanitizeModelToneTag(rawTone, modelSpec)
            : String(rawTone || '').trim().replace(/^[\[(]+|[\])]+$/g, '');
        const instruction = String(item.instruction || item.actingDirection || '').trim().slice(0, 260);
        let text = String(item.text || '').replace(/[\uE000\uE001]/g, '').trim();
        if (modelSpec && modelSpec.deliveryMode === 'instruction') {
            text = text.replace(/^(?:\[[^\]]{1,40}\]|\([^)]{1,40}\))\s*/g, '').trim();
        }
        if (!isSpeakableText(text)) continue;

        for (const chunk of splitLongTextChunks(text, maxChunkChars)) {
            if (!isSpeakableText(chunk)) continue;
            segments.push({ kind, speaker, gender, tone, instruction, text: chunk });
        }
    }

    if (!segments.length) {
        throw new Error('LLM 대본 분석에서 유효한 발화 구간을 찾지 못했습니다.');
    }

    const rawProfiles = (parsed && !Array.isArray(parsed) && Array.isArray(parsed.characterProfiles))
        ? parsed.characterProfiles
        : [];
    const characterProfiles = rawProfiles
        .map((p, idx) => normalizeModelCharacterProfileDraft(p, modelSpec, idx))
        .filter(Boolean);

    return { segments, characterProfiles };
}

function parseScriptDirectorResponse(rawOutput, fallbackSpeaker = 'Character', maxChunkChars = 260, modelSpec = null) {
    return parseScriptDirectorResult(rawOutput, fallbackSpeaker, maxChunkChars, modelSpec).segments;
}

function buildBotCastAnalysisMessages({ botContext = {}, existingCharacters = [], ttsConfig = {}, availableVoices = [] } = {}) {
    const cfg = normalizeTtsConfig(ttsConfig);
    const modelSpec = resolveTtsSpeechModelSpec(cfg);
    const botCtx = (botContext && typeof botContext === 'object') ? botContext : {};
    const botName = String(botCtx.botName || 'Character').trim() || 'Character';

    const voiceLines = (Array.isArray(availableVoices) ? availableVoices : [])
        .filter((v) => v && v.id)
        .slice(0, 60)
        .map((v) => `- ${v.id} (${v.label || v.id}, gender: ${normalizeGender(v.gender)})`);

    const existingLines = (Array.isArray(existingCharacters) ? existingCharacters : [])
        .filter((c) => c && c.name)
        .map((c) => formatSavedProfileHint(c, modelSpec) + (c.voiceId ? ` | voiceId: ${c.voiceId}` : ''));

    const recommendedHint = (modelSpec.recommendedTags && modelSpec.recommendedTags.length)
        ? `Allowed / Recommended Tags: ${modelSpec.recommendedTags.join(', ')}`
        : '';

    const sysPrompt = [
        'You are a Character Voice Casting & Speech Profile Designer for a roleplay TTS engine.',
        'Analyze the bot character sheet, world lore, and recent dialogue to extract recurring speaking characters (excluding Narrator and unnamed extras), analyze each character\'s personality and speaking style, assign a fitting Voice ID from the provided Available Voices list (if available), and generate speech tags/directions strictly matched to the Active Speech Model.',
        `Active Speech Model: ${modelSpec.label}`,
        `Model Tag Specification: ${modelSpec.llmGuide}`,
        recommendedHint,
        'Output ONLY valid JSON matching:',
        '{"characters":[{"name":"string","aliases":["string"],"gender":"female"|"male"|"neutral","personality":"concise Korean/English summary of personality","speechStyle":"concise voice timbre, pacing, and habit summary","voiceId":"matching id from Available Voices or empty string","dialogueTag":"default dialogue cue for this model","thoughtTag":"default inner-thought cue for this model","dialogueInstruction":"personality-matched voice acting direction for dialogue","thoughtInstruction":"personality-matched voice acting direction for inner thought","speed":1.0,"thoughtSpeed":0.94}]}',
        'Rules:',
        '1. Return up to 12 main speaking characters. Never include "Narrator".',
        '2. `voiceId` MUST be copied verbatim from Available Voices (prefer matching gender and distinct voices per character), or "" if no Available Voices list is provided.',
        '3. If a character already exists in Existing Saved Characters, keep their canonical `name` and refine/complete their personality, speechStyle, and speech tags for the Active Speech Model.',
        '4. Strictly follow the Active Speech Model specification for `dialogueTag`, `thoughtTag`, `dialogueInstruction`, and `thoughtInstruction`.',
        '5. Output raw JSON only, no markdown fences.',
    ].filter(Boolean).join('\n');

    const userSections = [
        `Bot Name: ${botName}`,
        voiceLines.length ? `Available Voices (${modelSpec.voiceGroup}):\n${voiceLines.join('\n')}` : `Available Voices (${modelSpec.voiceGroup}): (none registered — leave voiceId as "")`,
        existingLines.length ? `Existing Saved Characters:\n${existingLines.join('\n')}` : 'Existing Saved Characters: (none)',
    ];
    if (botCtx.desc) userSections.push(`Character Description / Sheet:\n${String(botCtx.desc).trim().slice(0, 2500)}`);
    if (botCtx.loreSummary) userSections.push(`Lorebook Summary:\n${String(botCtx.loreSummary).trim().slice(0, 3200)}`);
    if (botCtx.firstMessage) userSections.push(`First Message:\n${String(botCtx.firstMessage).trim().slice(0, 1000)}`);
    if (botCtx.note) userSections.push(`Author Note:\n${String(botCtx.note).trim().slice(0, 600)}`);
    if (botCtx.recentDialogue) userSections.push(`Recent Chat Excerpt:\n${String(botCtx.recentDialogue).trim().slice(0, 2200)}`);

    return [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userSections.join('\n\n') },
    ];
}

function parseBotCastAnalysisResponse(rawOutput, modelSpec, availableVoiceIds = []) {
    const parsed = extractJsonPayload(rawOutput);
    const list = Array.isArray(parsed)
        ? parsed
        : (parsed && Array.isArray(parsed.characters) ? parsed.characters : null);
    if (!list || !list.length) {
        throw new Error('LLM 봇 캐릭터 분석 결과에 characters 배열이 없습니다.');
    }
    const validVoiceSet = new Set(
        (Array.isArray(availableVoiceIds) ? availableVoiceIds : [])
            .map((id) => String(id || '').trim())
            .filter(Boolean)
    );
    const out = [];
    const seen = new Set();
    for (let i = 0; i < list.length && out.length < 12; i += 1) {
        const raw = list[i];
        if (!raw || typeof raw !== 'object') continue;
        const rawVoiceId = String(raw.voiceId || '').trim();
        const safeVoiceId = validVoiceSet.size
            ? (validVoiceSet.has(rawVoiceId) ? rawVoiceId : '')
            : rawVoiceId;
        const norm = normalizeModelCharacterProfileDraft({
            ...raw,
            voiceId: safeVoiceId,
            voiceGroup: safeVoiceId && modelSpec ? modelSpec.voiceGroup : '',
        }, modelSpec, i);
        if (!norm) continue;
        const lower = norm.name.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        out.push(norm);
    }
    if (!out.length) {
        throw new Error('유효한 등장인물 스피치 프로필을 추출하지 못했습니다.');
    }
    return out;
}

async function analyzeBotCharacterProfiles({ botContext = {}, existingCharacters = [], ttsConfig = {}, availableVoices = [], callLlm = null } = {}) {
    if (typeof callLlm !== 'function') {
        throw new Error('봇 캐릭터 분석용 LLM이 설정되지 않았습니다.');
    }
    const cfg = normalizeTtsConfig(ttsConfig);
    const modelSpec = resolveTtsSpeechModelSpec(cfg);
    const messages = buildBotCastAnalysisMessages({
        botContext,
        existingCharacters,
        ttsConfig: cfg,
        availableVoices,
    });
    const rawOut = await callLlm(messages);
    const availableIds = (Array.isArray(availableVoices) ? availableVoices : []).map((v) => v && v.id).filter(Boolean);
    const characters = parseBotCastAnalysisResponse(rawOut, modelSpec, availableIds);
    return { characters, modelSpec };
}

function mergeCharacterSpeechProfiles(existingList = [], incomingList = [], options = {}) {
    const modelSpecId = VALID_SPEECH_MODEL_SPEC_IDS.includes(options.modelSpecId) ? options.modelSpecId : 'fish_s2';
    const overwriteTags = Boolean(options.overwriteTags);
    const overwriteVoices = Boolean(options.overwriteVoices);
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();

    const next = (Array.isArray(existingList) ? existingList : [])
        .map((c, idx) => normalizeCharacterVoice(c, idx))
        .filter(Boolean);

    let changed = false;
    let addedCount = 0;
    let updatedCount = 0;

    const findIdx = (incoming) => {
        const targetNames = [incoming.name, ...(Array.isArray(incoming.aliases) ? incoming.aliases : [])]
            .map((n) => String(n || '').trim().toLowerCase())
            .filter(Boolean);
        return next.findIndex((c) => {
            const cNames = [c.name, ...(Array.isArray(c.aliases) ? c.aliases : [])]
                .map((n) => String(n || '').trim().toLowerCase())
                .filter(Boolean);
            return targetNames.some((t) => cNames.includes(t));
        });
    };

    for (let i = 0; i < (Array.isArray(incomingList) ? incomingList : []).length; i += 1) {
        const inc = normalizeCharacterVoice(incomingList[i], next.length + i);
        if (!inc || inc.name.toLowerCase() === 'narrator') continue;
        const incSpecEntry = (inc.speechTagsByModel && inc.speechTagsByModel[modelSpecId]) || {
            dialogueTag: inc.dialogueToneTag || '',
            thoughtTag: inc.thoughtToneTag || '',
            dialogueInstruction: inc.dialogueInstruction || '',
            thoughtInstruction: inc.thoughtInstruction || '',
        };

        const idx = findIdx(inc);
        if (idx === -1) {
            const nextMap = { ...(inc.speechTagsByModel || {}) };
            if (incSpecEntry.dialogueTag || incSpecEntry.thoughtTag || incSpecEntry.dialogueInstruction || incSpecEntry.thoughtInstruction) {
                nextMap[modelSpecId] = { ...incSpecEntry };
            }
            next.push(normalizeCharacterVoice({
                ...inc,
                speechTagsByModel: nextMap,
                autoGenerated: inc.autoGenerated !== undefined ? inc.autoGenerated : true,
                updatedAt: now,
            }, next.length));
            changed = true;
            addedCount += 1;
            continue;
        }

        const cur = next[idx];
        let itemChanged = false;
        const mergedAliases = [...(cur.aliases || [])];
        const aliasSet = new Set([cur.name.toLowerCase(), ...mergedAliases.map((a) => a.toLowerCase())]);
        for (const al of (inc.aliases || [])) {
            const cleanAl = String(al || '').trim();
            if (cleanAl && !aliasSet.has(cleanAl.toLowerCase())) {
                aliasSet.add(cleanAl.toLowerCase());
                mergedAliases.push(cleanAl);
                itemChanged = true;
            }
        }
        const nextGender = (cur.gender === 'neutral' && inc.gender !== 'neutral') || (overwriteTags && inc.gender !== 'neutral')
            ? inc.gender
            : cur.gender;
        if (nextGender !== cur.gender) itemChanged = true;

        const nextPersonality = ((overwriteTags || !cur.personality) && inc.personality) ? inc.personality : cur.personality;
        const nextSpeechStyle = ((overwriteTags || !cur.speechStyle) && inc.speechStyle) ? inc.speechStyle : cur.speechStyle;
        if (nextPersonality !== cur.personality || nextSpeechStyle !== cur.speechStyle) itemChanged = true;

        const nextVoiceId = ((overwriteVoices || !cur.voiceId) && inc.voiceId) ? inc.voiceId : cur.voiceId;
        const nextVoiceGroup = ((overwriteVoices || !cur.voiceId) && inc.voiceId && inc.voiceGroup)
            ? inc.voiceGroup
            : cur.voiceGroup;
        if (nextVoiceId !== cur.voiceId || nextVoiceGroup !== cur.voiceGroup) itemChanged = true;

        const curTagsByModel = { ...(cur.speechTagsByModel || {}) };
        const curModelEntry = curTagsByModel[modelSpecId] || {};
        const nextModelEntry = {
            dialogueTag: ((overwriteTags || !curModelEntry.dialogueTag) && incSpecEntry.dialogueTag) ? incSpecEntry.dialogueTag : (curModelEntry.dialogueTag || ''),
            thoughtTag: ((overwriteTags || !curModelEntry.thoughtTag) && incSpecEntry.thoughtTag) ? incSpecEntry.thoughtTag : (curModelEntry.thoughtTag || ''),
            dialogueInstruction: ((overwriteTags || !curModelEntry.dialogueInstruction) && incSpecEntry.dialogueInstruction) ? incSpecEntry.dialogueInstruction : (curModelEntry.dialogueInstruction || ''),
            thoughtInstruction: ((overwriteTags || !curModelEntry.thoughtInstruction) && incSpecEntry.thoughtInstruction) ? incSpecEntry.thoughtInstruction : (curModelEntry.thoughtInstruction || ''),
        };
        if (JSON.stringify(nextModelEntry) !== JSON.stringify(curModelEntry)) {
            if (nextModelEntry.dialogueTag || nextModelEntry.thoughtTag || nextModelEntry.dialogueInstruction || nextModelEntry.thoughtInstruction) {
                curTagsByModel[modelSpecId] = nextModelEntry;
                itemChanged = true;
            }
        }

        const nextDialogueTag = ((overwriteTags || !cur.dialogueToneTag) && inc.dialogueToneTag) ? inc.dialogueToneTag : cur.dialogueToneTag;
        const nextThoughtTag = ((overwriteTags || !cur.thoughtToneTag) && inc.thoughtToneTag) ? inc.thoughtToneTag : cur.thoughtToneTag;
        const nextDialogueInstr = ((overwriteTags || !cur.dialogueInstruction) && inc.dialogueInstruction) ? inc.dialogueInstruction : cur.dialogueInstruction;
        const nextThoughtInstr = ((overwriteTags || !cur.thoughtInstruction) && inc.thoughtInstruction) ? inc.thoughtInstruction : cur.thoughtInstruction;
        if (nextDialogueTag !== cur.dialogueToneTag || nextThoughtTag !== cur.thoughtToneTag ||
            nextDialogueInstr !== cur.dialogueInstruction || nextThoughtInstr !== cur.thoughtInstruction) {
            itemChanged = true;
        }

        if (itemChanged) {
            next[idx] = normalizeCharacterVoice({
                ...cur,
                aliases: mergedAliases,
                gender: nextGender,
                voiceId: nextVoiceId,
                voiceGroup: nextVoiceGroup,
                personality: nextPersonality,
                speechStyle: nextSpeechStyle,
                dialogueToneTag: nextDialogueTag,
                thoughtToneTag: nextThoughtTag,
                dialogueInstruction: nextDialogueInstr,
                thoughtInstruction: nextThoughtInstr,
                speechTagsByModel: curTagsByModel,
                updatedAt: now,
            }, idx);
            changed = true;
            updatedCount += 1;
        }
    }

    return { characters: next, changed, addedCount, updatedCount };
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

function getEffectiveTtsCharacters(ttsConfig, botOrChatKey = '') {
    const cfg = normalizeTtsConfig(ttsConfig);
    if (!cfg.characterVoicesEnabled) return [];
    const botKey = buildTtsBotKey(botOrChatKey);
    const botChars = (botKey && cfg.botCharacters && cfg.botCharacters[botKey] && Array.isArray(cfg.botCharacters[botKey].characters))
        ? cfg.botCharacters[botKey].characters
        : [];
    if (!botChars.length) return cfg.characters;
    if (!cfg.characters.length) return botChars;
    const seen = new Set(botChars.map((c) => c.name.toLowerCase()));
    const combined = [...botChars];
    for (const gc of cfg.characters) {
        if (gc && gc.name && !seen.has(gc.name.toLowerCase())) {
            seen.add(gc.name.toLowerCase());
            combined.push(gc);
        }
    }
    return combined;
}

function mergeInstructionText(baseInstr, segInstr, segTone) {
    const base = String(baseInstr || '').trim();
    const seg = String(segInstr || '').trim();
    const tone = String(segTone || '').trim();
    if (base && seg) {
        if (base.toLowerCase().includes(seg.toLowerCase())) return base.slice(0, 360);
        if (seg.toLowerCase().includes(base.toLowerCase())) return seg.slice(0, 360);
        return `${base} / ${seg}`.slice(0, 360);
    }
    if (seg) return seg.slice(0, 360);
    if (base && tone && !base.toLowerCase().includes(tone.toLowerCase())) {
        return `${base} (${tone})`.slice(0, 360);
    }
    return base.slice(0, 360);
}

function sanitizeToneTagsArray(rawTags, rawSingleTone, modelSpec) {
    const arr = Array.isArray(rawTags)
        ? rawTags
        : (typeof rawSingleTone === 'string' && rawSingleTone.includes(',')
            ? rawSingleTone.split(',')
            : (rawSingleTone !== undefined ? [rawSingleTone] : []));
    const out = [];
    const seen = new Set();
    for (const rawItem of arr) {
        const clean = modelSpec
            ? sanitizeModelToneTag(rawItem, modelSpec)
            : String(rawItem || '').trim().replace(/^[\[(]+|[\])]+$/g, '').slice(0, 40).trim();
        if (!clean) continue;
        const lower = clean.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        out.push(clean);
        if (out.length >= 3) break;
    }
    return out;
}

function resolveSegmentVoice(segment, ttsConfig, defaultCharName = 'Character', chatKey = '') {
    const cfg = normalizeTtsConfig(ttsConfig);
    const modelSpec = resolveTtsSpeechModelSpec(cfg);
    const isManual = Boolean(segment && segment.manualOverride);
    const kind = normalizeKind(segment && segment.kind);
    const speaker = kind === 'narration'
        ? (String((segment && segment.speaker) || '').trim() || 'Narrator')
        : (String((segment && segment.speaker) || defaultCharName || 'Character').trim() || 'Character');

    if (kind === 'narration') {
        const nar = cfg.narration;
        const tags = [];
        const segNarTone = sanitizeModelToneTag(segment && segment.tone, modelSpec);
        if (isManual && (Array.isArray(segment && segment.toneTags) || (segment && segment.tone !== undefined))) {
            tags.push(...sanitizeToneTagsArray(segment.toneTags, segment.tone, modelSpec));
        } else {
            const narTag = sanitizeModelToneTag(nar.toneTag, modelSpec);
            if (narTag) tags.push(narTag);
            if (segNarTone && !tags.some((t) => t.toLowerCase() === segNarTone.toLowerCase())) {
                tags.push(segNarTone);
            }
        }
        const manualNarVoice = isManual && segment && String(segment.voiceId || '').trim();
        const manualNarInstr = isManual && segment && segment.instruction !== undefined;
        const manualNarSpeed = isManual && segment && segment.speed !== undefined && Number.isFinite(Number(segment.speed));
        return {
            kind,
            speaker,
            gender: nar.gender || 'neutral',
            voiceId: manualNarVoice ? String(segment.voiceId).trim() : (nar.voiceId || cfg.defaultVoices.neutral.voiceId || ''),
            toneTags: tags.filter(Boolean),
            instruction: manualNarInstr
                ? String(segment.instruction || '').trim().slice(0, 360)
                : mergeInstructionText(nar.instruction || '', segment && segment.instruction, segNarTone),
            speed: manualNarSpeed ? clampNum(segment.speed, nar.speed, 0.5, 2.0) : nar.speed,
            temperature: nar.temperature,
            topP: nar.topP,
            matchedCharacter: '',
            modelSpecId: modelSpec.id,
        };
    }

    const effectiveChars = getEffectiveTtsCharacters(cfg, chatKey);
    const matched = findCharacterProfile(speaker, effectiveChars);
    const gender = matched ? matched.gender : normalizeGender(segment && segment.gender);
    const genderPreset = cfg.defaultVoices[gender] || cfg.defaultVoices.neutral;
    const isThought = kind === 'thought';
    const matchedModelTags = (matched && matched.speechTagsByModel && matched.speechTagsByModel[modelSpec.id]) || null;

    const manualVoice = isManual && segment && String(segment.voiceId || '').trim();
    const voiceId = manualVoice
        ? String(segment.voiceId).trim()
        : ((matched && matched.voiceId) ? matched.voiceId : (genderPreset.voiceId || ''));
    const rawPresetTag = isThought
        ? ((matchedModelTags && matchedModelTags.thoughtTag) || (matched && matched.thoughtToneTag !== undefined && matched.thoughtToneTag !== '' ? matched.thoughtToneTag : genderPreset.thoughtToneTag))
        : ((matchedModelTags && matchedModelTags.dialogueTag) || (matched && matched.dialogueToneTag !== undefined && matched.dialogueToneTag !== '' ? matched.dialogueToneTag : genderPreset.dialogueToneTag));
    const presetTag = sanitizeModelToneTag(rawPresetTag, modelSpec);
    const segTone = sanitizeModelToneTag(segment && segment.tone, modelSpec);

    const toneTags = [];
    if (isManual && (Array.isArray(segment && segment.toneTags) || (segment && segment.tone !== undefined))) {
        toneTags.push(...sanitizeToneTagsArray(segment.toneTags, segment.tone, modelSpec));
    } else {
        if (presetTag) toneTags.push(presetTag);
        if (segTone && !toneTags.some((t) => t.toLowerCase() === segTone.toLowerCase())) {
            toneTags.push(segTone);
        }
    }

    const fallbackProfileInstr = matched && (matched.speechStyle || matched.personality)
        ? [matched.personality, matched.speechStyle].filter(Boolean).join(', ')
        : '';
    const charBaseInstr = isThought
        ? ((matchedModelTags && matchedModelTags.thoughtInstruction) || (matched && matched.thoughtInstruction) || fallbackProfileInstr || genderPreset.thoughtInstruction || '')
        : ((matchedModelTags && matchedModelTags.dialogueInstruction) || (matched && matched.dialogueInstruction) || fallbackProfileInstr || genderPreset.dialogueInstruction || '');
    const instruction = (isManual && segment && segment.instruction !== undefined)
        ? String(segment.instruction || '').trim().slice(0, 360)
        : mergeInstructionText(charBaseInstr, segment && segment.instruction, segTone);

    const baseSpeed = isThought
        ? ((matched && matched.thoughtSpeed) || genderPreset.thoughtSpeed)
        : ((matched && matched.speed) || genderPreset.speed);
    const speed = (isManual && segment && segment.speed !== undefined && Number.isFinite(Number(segment.speed)))
        ? clampNum(segment.speed, baseSpeed, 0.5, 2.0)
        : baseSpeed;

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
        modelSpecId: modelSpec.id,
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

async function analyzeTtsSegments({ text = '', html = '', role = 'char', charName = 'Character', personaName = '나', chatKey = '', botKey = '', botContext = null, ttsConfig = {}, callLlm = null } = {}) {
    const cfg = normalizeTtsConfig(ttsConfig);
    const modelSpec = resolveTtsSpeechModelSpec(cfg);
    const effectiveBotKey = buildTtsBotKey(botKey || chatKey || botContext || (charName ? { charName } : ''));
    const scopeKey = effectiveBotKey || chatKey;
    const clean = cleanTextForTts(text, html);
    const modelSpecSummary = {
        id: modelSpec.id,
        label: modelSpec.label,
        deliveryMode: modelSpec.deliveryMode,
        tagSyntax: modelSpec.tagSyntax,
        voiceGroup: modelSpec.voiceGroup,
    };
    if (!clean) {
        return { segments: [], modeUsed: 'rule', warning: '', learnedProfiles: [], modelSpec: modelSpecSummary, botKey: effectiveBotKey };
    }

    const effectiveChars = getEffectiveTtsCharacters(cfg, scopeKey);
    const ruleOpts = {
        html,
        role,
        charName,
        personaName,
        characters: effectiveChars,
    };

    const attachVoice = (segs, activeCfg = cfg) => segs.map((seg) => {
        const resolved = resolveSegmentVoice(seg, activeCfg, role === 'user' ? personaName : charName, scopeKey);
        return {
            ...seg,
            speaker: resolved.speaker,
            gender: resolved.gender,
            voiceId: resolved.voiceId,
            toneTags: resolved.toneTags,
            instruction: resolved.instruction,
            speed: resolved.speed,
            matchedCharacter: resolved.matchedCharacter,
            modelSpecId: resolved.modelSpecId,
        };
    });

    if (cfg.parseMode === 'rule') {
        return {
            segments: attachVoice(parseSegmentsRuleBased(text, ruleOpts)),
            modeUsed: 'rule',
            warning: '',
            learnedProfiles: [],
            modelSpec: modelSpecSummary,
            botKey: effectiveBotKey,
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
            ttsConfig: cfg,
            modelSpec,
            botContext,
        });
        const rawOut = await callLlm(messages);
        const parsedResult = parseScriptDirectorResult(rawOut, fallbackSpeaker, 260, modelSpec);
        let cfgForResolution = cfg;
        if (cfg.characterVoicesEnabled && parsedResult.characterProfiles.length) {
            const targetKey = effectiveBotKey || '__ephemeral__';
            const merged = mergeCharacterSpeechProfiles(effectiveChars, parsedResult.characterProfiles, {
                modelSpecId: modelSpec.id,
                overwriteTags: false,
            });
            cfgForResolution = {
                ...cfg,
                botCharacters: {
                    ...cfg.botCharacters,
                    [targetKey]: { botKey: targetKey, botName: charName, updatedAt: Date.now(), characters: merged.characters },
                },
            };
        }
        return {
            segments: attachVoice(parsedResult.segments, cfgForResolution),
            modeUsed: 'llm',
            warning: '',
            learnedProfiles: parsedResult.characterProfiles,
            modelSpec: modelSpecSummary,
            botKey: effectiveBotKey,
        };
    } catch (err) {
        if (cfg.parseMode === 'llm') {
            throw err;
        }
        return {
            segments: attachVoice(parseSegmentsRuleBased(text, ruleOpts)),
            modeUsed: 'rule_fallback',
            warning: err && err.message ? err.message : 'LLM 대본 분석 실패로 규칙 파싱을 사용했습니다.',
            learnedProfiles: [],
            modelSpec: modelSpecSummary,
            botKey: effectiveBotKey,
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
            ...(Array.isArray(opts.toneTags) ? { toneTags: opts.toneTags } : {}),
            instruction: String(opts.instruction || '').trim(),
            ...(opts.speed !== undefined && Number.isFinite(Number(opts.speed)) ? { speed: Number(opts.speed) } : {}),
            ...(opts.manualOverride ? { manualOverride: true } : {}),
            ...(opts.voiceId ? { voiceId: String(opts.voiceId).trim() } : {}),
            text: sampleText,
        };
        return await synthesizeSegment(seg, cfg, {
            overrideVoiceId: opts.voiceId ? String(opts.voiceId).trim() : '',
            chatKey: opts.botKey || opts.chatKey || '',
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

    const resolvedVoiceGroup = cfg.provider === 'openai_compat_cloud' ? 'openai' : 'qwen';
    const voiceItems = voices.map((id) => ({ id, label: id, group: resolvedVoiceGroup }));
    const healthy = Boolean(mRes.ok);
    const statusMsg = healthy
        ? `서버에서 ${models.length}개 모델을 불러왔습니다.` + (voices.length ? ` · 보이스 ${voices.length}개` : '')
        : (cfg.provider === 'openai_compat_cloud'
            ? `기본 OpenAI TTS 모델 ${models.length}개 표시 (API 키를 입력하면 실시간 조회 가능)`
            : '로컬 /v1/models 조회 실패 — 기본 모델 목록을 표시합니다.');
    return { models, voices, voiceGroup: resolvedVoiceGroup, voiceItems, detectedFamily: '', healthy, resolvedEndpoint, statusMsg };
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

// ================= Persistent TTS Script Store =================

function buildTtsScriptKey({ botKey = '', role = 'char', text = '', html = '' } = {}) {
    const cleaned = cleanTextForTts(text, html);
    if (!cleaned) return '';
    const b = buildTtsBotKey(botKey);
    const r = String(role || 'char').toLowerCase().trim() || 'char';
    return crypto.createHash('sha1').update(JSON.stringify({ b, r, t: cleaned })).digest('hex').slice(0, 24);
}

function normalizeTtsScriptSegment(raw, modelSpec = null, manualOverride = false) {
    if (!raw || typeof raw !== 'object') return null;
    const text = String(raw.text || '').replace(/[\uE000\uE001]/g, '').trim();
    if (!isSpeakableText(text)) return null;
    const kind = normalizeKind(raw.kind);
    const speaker = kind === 'narration'
        ? (String(raw.speaker || '').trim() || 'Narrator')
        : (String(raw.speaker || '').trim() || 'Character');
    const gender = kind === 'narration' ? 'neutral' : normalizeGender(raw.gender);
    const toneTags = sanitizeToneTagsArray(raw.toneTags, raw.tone, modelSpec);
    const instruction = String(raw.instruction || '').trim().slice(0, 360);
    const hasSpeed = raw.speed !== undefined && raw.speed !== null && raw.speed !== '' && Number.isFinite(Number(raw.speed));
    const speed = hasSpeed ? clampNum(raw.speed, 1.0, 0.5, 2.0) : undefined;
    return {
        kind,
        speaker,
        gender,
        voiceId: String(raw.voiceId || '').trim().slice(0, 160),
        tone: toneTags[0] || String(raw.tone || '').trim().slice(0, 40),
        toneTags,
        instruction,
        ...(speed !== undefined ? { speed } : {}),
        text,
        matchedCharacter: String(raw.matchedCharacter || '').trim().slice(0, 120),
        modelSpecId: String(raw.modelSpecId || (modelSpec && modelSpec.id) || '').trim(),
        manualOverride: Boolean(manualOverride || raw.manualOverride),
    };
}

function normalizeSavedTtsScriptRecord(raw, modelSpec = null) {
    if (!raw || typeof raw !== 'object') return null;
    const scriptKey = String(raw.scriptKey || '').trim().slice(0, 64);
    if (!scriptKey) return null;
    const manuallyEdited = Boolean(raw.manuallyEdited);
    const rawSegs = Array.isArray(raw.segments) ? raw.segments : [];
    const segments = rawSegs
        .map((s) => normalizeTtsScriptSegment(s, modelSpec, manuallyEdited))
        .filter(Boolean);
    if (!segments.length) return null;
    const now = Date.now();
    const createdAt = (Number.isFinite(Number(raw.createdAt)) && Number(raw.createdAt) > 0)
        ? Math.trunc(Number(raw.createdAt))
        : now;
    const updatedAt = (Number.isFinite(Number(raw.updatedAt)) && Number(raw.updatedAt) > 0)
        ? Math.trunc(Number(raw.updatedAt))
        : now;
    return {
        scriptKey,
        botKey: buildTtsBotKey(raw.botKey || ''),
        botName: String(raw.botName || '').trim().slice(0, 120),
        chatKey: String(raw.chatKey || '').trim().slice(0, 200),
        msgIndex: (raw.msgIndex !== undefined && raw.msgIndex !== null && Number.isFinite(Number(raw.msgIndex)))
            ? Math.trunc(Number(raw.msgIndex))
            : null,
        role: String(raw.role || 'char').toLowerCase().trim() || 'char',
        charName: String(raw.charName || '').trim().slice(0, 120),
        sourceTextPreview: String(raw.sourceTextPreview || '').replace(/\s+/g, ' ').trim().slice(0, 140),
        modelSpecId: String(raw.modelSpecId || (modelSpec && modelSpec.id) || '').trim().slice(0, 40),
        modeUsed: String(raw.modeUsed || (manuallyEdited ? 'manual' : 'llm')).trim().slice(0, 32),
        manuallyEdited,
        createdAt,
        updatedAt,
        segments,
    };
}

function hydrateSavedScriptSegments(record, ttsConfig, defaultCharName = 'Character', botOrChatKey = '') {
    if (!record || !Array.isArray(record.segments)) return [];
    const cfg = normalizeTtsConfig(ttsConfig);
    const scopeKey = botOrChatKey || record.botKey || record.chatKey || '';
    const isManualRecord = Boolean(record.manuallyEdited);
    return record.segments.map((seg) => {
        const inputSeg = isManualRecord
            ? { ...seg, manualOverride: true }
            : {
                kind: seg.kind,
                speaker: seg.speaker,
                gender: seg.gender,
                tone: seg.tone !== undefined ? seg.tone : (Array.isArray(seg.toneTags) ? (seg.toneTags[0] || '') : ''),
                instruction: seg.instruction || '',
                text: seg.text,
            };
        const resolved = resolveSegmentVoice(inputSeg, cfg, defaultCharName || record.charName || 'Character', scopeKey);
        return {
            kind: resolved.kind,
            speaker: resolved.speaker,
            gender: resolved.gender,
            voiceId: resolved.voiceId,
            tone: resolved.toneTags[0] || '',
            toneTags: resolved.toneTags,
            instruction: resolved.instruction,
            speed: resolved.speed,
            text: seg.text,
            matchedCharacter: resolved.matchedCharacter,
            modelSpecId: resolved.modelSpecId,
            manualOverride: isManualRecord || Boolean(seg.manualOverride),
        };
    });
}

function createTtsScriptStore({ filePath = '', maxEntries = 500, isPersistDisabled = () => false } = {}) {
    const scripts = new Map();
    let loaded = false;
    const cap = Math.max(20, Number(maxEntries) || 500);

    function ensureLoaded() {
        if (loaded) return;
        loaded = true;
        if (!filePath || isPersistDisabled()) return;
        try {
            if (!fs.existsSync(filePath)) return;
            const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const entries = (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.scripts && typeof raw.scripts === 'object')
                ? Object.entries(raw.scripts)
                : (raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.entries(raw) : []);
            for (const [k, v] of entries) {
                const norm = normalizeSavedTtsScriptRecord({ ...(v && typeof v === 'object' ? v : {}), scriptKey: (v && v.scriptKey) || k });
                if (norm) scripts.set(norm.scriptKey, norm);
            }
        } catch (e) {
            console.warn('[TTS Scripts] 저장 대본 로드 실패:', e && e.message ? e.message : String(e));
        }
    }

    function persist() {
        if (!filePath || isPersistDisabled()) return;
        const tmp = `${filePath}.rs-tmp-${crypto.randomBytes(6).toString('hex')}`;
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            const outObj = { version: 1, scripts: Object.fromEntries(scripts.entries()) };
            fs.writeFileSync(tmp, JSON.stringify(outObj, null, 2), { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(tmp, filePath);
        } catch (e) {
            try { fs.rmSync(tmp, { force: true }); } catch (_) {}
            console.warn('[TTS Scripts] 저장 대본 파일 기록 실패:', e && e.message ? e.message : String(e));
        }
    }

    function evictIfNeeded() {
        while (scripts.size > cap) {
            let victimKey = null;
            let victimTs = Infinity;
            // Evict oldest auto-generated (non-manual) entry first
            for (const [k, v] of scripts.entries()) {
                if (v.manuallyEdited) continue;
                const ts = Number(v.updatedAt || v.createdAt || 0);
                if (ts < victimTs) {
                    victimTs = ts;
                    victimKey = k;
                }
            }
            if (!victimKey) {
                for (const [k, v] of scripts.entries()) {
                    const ts = Number(v.updatedAt || v.createdAt || 0);
                    if (ts < victimTs) {
                        victimTs = ts;
                        victimKey = k;
                    }
                }
            }
            if (!victimKey) break;
            scripts.delete(victimKey);
        }
    }

    function get(scriptKey) {
        ensureLoaded();
        const k = String(scriptKey || '').trim();
        if (!k || !scripts.has(k)) return null;
        return JSON.parse(JSON.stringify(scripts.get(k)));
    }

    function set(scriptKey, record) {
        ensureLoaded();
        const k = String(scriptKey || (record && record.scriptKey) || '').trim();
        const prev = k ? scripts.get(k) : null;
        const norm = normalizeSavedTtsScriptRecord({
            ...(record && typeof record === 'object' ? record : {}),
            scriptKey: k,
            createdAt: (prev && prev.createdAt) || (record && record.createdAt) || Date.now(),
            updatedAt: Date.now(),
        });
        if (!norm) return null;
        scripts.set(norm.scriptKey, norm);
        evictIfNeeded();
        persist();
        return JSON.parse(JSON.stringify(norm));
    }

    function del(scriptKey) {
        ensureLoaded();
        const k = String(scriptKey || '').trim();
        if (!k || !scripts.has(k)) return false;
        scripts.delete(k);
        persist();
        return true;
    }

    function list({ botKey = '' } = {}) {
        ensureLoaded();
        const filterBot = buildTtsBotKey(botKey);
        const items = [];
        for (const rec of scripts.values()) {
            if (filterBot && rec.botKey !== filterBot) continue;
            items.push({
                scriptKey: rec.scriptKey,
                botKey: rec.botKey,
                botName: rec.botName,
                chatKey: rec.chatKey,
                msgIndex: rec.msgIndex,
                role: rec.role,
                charName: rec.charName,
                sourceTextPreview: rec.sourceTextPreview,
                modelSpecId: rec.modelSpecId,
                modeUsed: rec.modeUsed,
                manuallyEdited: rec.manuallyEdited,
                segmentCount: rec.segments.length,
                createdAt: rec.createdAt,
                updatedAt: rec.updatedAt,
            });
        }
        items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return items;
    }

    function clear() {
        ensureLoaded();
        scripts.clear();
        persist();
    }

    return {
        get,
        set,
        delete: del,
        list,
        clear,
    };
}

module.exports = {
    TTS_PROVIDER_DEFAULTS,
    TTS_ENDPOINT_PRESETS,
    TTS_VOICE_GROUPS,
    TTS_BUILTIN_VOICE_REFERENCES,
    TTS_TONE_TAG_PRESETS,
    TTS_SPEECH_MODEL_SPECS,
    normalizeVoiceGroup,
    normalizeVoiceProfiles,
    inferTtsVoiceGroup,
    normalizeTtsEndpointUrl,
    resolveTtsSpeechModelSpec,
    sanitizeModelToneTag,
    buildTtsBotKey,
    buildTtsChatKey,
    buildTtsScriptKey,
    normalizeTtsScriptSegment,
    normalizeSavedTtsScriptRecord,
    hydrateSavedScriptSegments,
    createTtsScriptStore,
    getEffectiveTtsCharacters,
    mergeCharacterSpeechProfiles,
    defaultTtsConfig,
    normalizeTtsConfig,
    sanitizeTtsForClient,
    cleanTextForTts,
    parseSegmentsRuleBased,
    buildScriptDirectorMessages,
    parseScriptDirectorResult,
    parseScriptDirectorResponse,
    buildBotCastAnalysisMessages,
    parseBotCastAnalysisResponse,
    analyzeBotCharacterProfiles,
    analyzeTtsSegments,
    resolveSegmentVoice,
    formatFishTaggedText,
    detectAudioMimeFromBytes,
    listTtsModels,
    scanLocalTtsServers,
    createTtsProvider,
};
