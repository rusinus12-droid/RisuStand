'use strict';
/**
 * RisuStand Backend Image Generation Provider
 *
 * Implements RisuAI-compatible `generateImage` providers (`novelai`, `comfyui`,
 * `webui`, `openai`) modeled on RisuAI's `src/ts/process/stableDiff.ts` and
 * `Asset Maid`, automatically reading PC RisuAI `DBState.db` image settings via
 * Host RPC or using RisuStand's custom image provider profile.
 */

const zlib = require('node:zlib');
const crypto = require('node:crypto');

const DEFAULT_NEGATIVE_BASE = 'nsfw, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone';

function defaultImageGenConfig() {
    return {
        source: 'pc_risu', // 'pc_risu' | 'custom'
        provider: 'novelai', // 'novelai' | 'comfyui' | 'webui' | 'openai'
        apiUrl: '',
        apiKey: '',
        model: 'nai-diffusion-4-5-full',
        width: 1024,
        height: 1024,
        steps: 28,
        scale: 5,
        sampler: 'k_euler_ancestral',
        noiseSchedule: 'karras',
        negativeBase: DEFAULT_NEGATIVE_BASE,
        varietyPlus: false,
        sm: false,
        smDyn: false,
        cfgRescale: 0,
        comfyWorkflowJson: '',
        comfyPosNodeId: '',
        comfyPosInputName: 'text',
        comfyNegNodeId: '',
        comfyNegInputName: 'text',
        comfyTimeoutMs: 120000,
        openaiQuality: 'standard',
    };
}

function normalizeImageGenConfig(raw) {
    const def = defaultImageGenConfig();
    if (!raw || typeof raw !== 'object') return def;
    const clampNum = (v, fallback, min, max) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    };
    const provRaw = String(raw.provider || def.provider).toLowerCase().trim();
    const provider = provRaw === 'comfy' ? 'comfyui'
        : provRaw === 'dalle' ? 'openai'
        : (['novelai', 'comfyui', 'webui', 'openai'].includes(provRaw) ? provRaw : 'novelai');

    return {
        source: raw.source === 'custom' ? 'custom' : 'pc_risu',
        provider,
        apiUrl: String(raw.apiUrl || '').trim(),
        apiKey: String(raw.apiKey || '').trim(),
        model: String(raw.model || def.model).trim(),
        width: Math.trunc(clampNum(raw.width, def.width, 64, 4096)),
        height: Math.trunc(clampNum(raw.height, def.height, 64, 4096)),
        steps: Math.trunc(clampNum(raw.steps, def.steps, 1, 150)),
        scale: clampNum(raw.scale, def.scale, 0, 50),
        sampler: String(raw.sampler || def.sampler).trim(),
        noiseSchedule: String(raw.noiseSchedule || def.noiseSchedule).trim(),
        negativeBase: raw.negativeBase !== undefined ? String(raw.negativeBase) : def.negativeBase,
        varietyPlus: Boolean(raw.varietyPlus),
        sm: Boolean(raw.sm),
        smDyn: Boolean(raw.smDyn),
        cfgRescale: clampNum(raw.cfgRescale, def.cfgRescale, 0, 1),
        comfyWorkflowJson: String(raw.comfyWorkflowJson || ''),
        comfyPosNodeId: String(raw.comfyPosNodeId || '').trim(),
        comfyPosInputName: String(raw.comfyPosInputName || 'text').trim() || 'text',
        comfyNegNodeId: String(raw.comfyNegNodeId || '').trim(),
        comfyNegInputName: String(raw.comfyNegInputName || 'text').trim() || 'text',
        comfyTimeoutMs: Math.trunc(clampNum(raw.comfyTimeoutMs, def.comfyTimeoutMs, 5000, 600000)),
        openaiQuality: String(raw.openaiQuality || def.openaiQuality).trim() || 'standard',
    };
}

function sanitizeImageGenForClient(raw) {
    const cfg = normalizeImageGenConfig(raw);
    const k = cfg.apiKey;
    const keyPreview = !k ? '' : (k.length <= 8 ? '****' : `${k.slice(0, 4)}...${k.slice(-4)}`);
    return {
        ...cfg,
        apiKey: undefined,
        hasKey: Boolean(k),
        keyPreview,
    };
}

function detectMimeFromBytes(buf, nameHint = '') {
    if (buf && buf.length >= 12) {
        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
        if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
        if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
        if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
    }
    const lower = String(nameHint || '').toLowerCase();
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.webp')) return 'image/webp';
    return 'image/png';
}

function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) {
        crc ^= buf[i];
        for (let b = 0; b < 8; b += 1) {
            crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Helper to create a minimal single-file ZIP (used in tests and ZIP utilities).
 */
function buildSingleFileZip(filename, dataBuf, { compress = true } = {}) {
    const raw = Buffer.isBuffer(dataBuf) ? dataBuf : Buffer.from(dataBuf || '');
    const nameBuf = Buffer.from(String(filename || 'image.png'), 'utf8');
    const c = crc32(raw);
    const body = compress ? zlib.deflateRawSync(raw) : raw;
    const method = compress ? 8 : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(c, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(c, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(0, 42);

    const cdOffset = lh.length + nameBuf.length + body.length;
    const cdSize = ch.length + nameBuf.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);

    return Buffer.concat([lh, nameBuf, body, ch, nameBuf, eocd]);
}

/**
 * Extracts the first image entry from a ZIP buffer (zero external deps, supports
 * both Central Directory and Local File Headers with Stored or Deflate methods).
 */
function extractFirstImageFromZip(zipBuffer) {
    const buf = Buffer.isBuffer(zipBuffer) ? zipBuffer : Buffer.from(zipBuffer || '');
    if (buf.length < 22) {
        throw new Error('NovelAI ZIP 응답이 너무 짧습니다.');
    }

    const decodeEntry = (method, compStart, compLen, nameHint) => {
        const compSlice = buf.subarray(compStart, compStart + compLen);
        let rawBytes;
        if (method === 0) {
            rawBytes = Buffer.from(compSlice);
        } else if (method === 8) {
            rawBytes = zlib.inflateRawSync(compSlice);
        } else {
            throw new Error(`지원하지 않는 ZIP 압축 방식입니다 (method=${method}).`);
        }
        const mime = detectMimeFromBytes(rawBytes, nameHint);
        return {
            bytes: rawBytes,
            mime,
            filename: nameHint,
            dataUri: `data:${mime};base64,${rawBytes.toString('base64')}`,
        };
    };

    // Prefer Central Directory so bit-3 data-descriptor ZIPs still know exact compressed sizes.
    let eocdOffset = -1;
    const minSearch = Math.max(0, buf.length - 65557);
    for (let i = buf.length - 22; i >= minSearch; i -= 1) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocdOffset = i;
            break;
        }
    }

    if (eocdOffset >= 0) {
        const totalEntries = buf.readUInt16LE(eocdOffset + 10);
        const cdOffset = buf.readUInt32LE(eocdOffset + 16);
        let ptr = cdOffset;
        let fallbackEntry = null;
        for (let idx = 0; idx < totalEntries && ptr + 46 <= eocdOffset; idx += 1) {
            if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
            const method = buf.readUInt16LE(ptr + 10);
            const compSize = buf.readUInt32LE(ptr + 20);
            const nameLen = buf.readUInt16LE(ptr + 28);
            const extraLen = buf.readUInt16LE(ptr + 30);
            const commentLen = buf.readUInt16LE(ptr + 32);
            const localOff = buf.readUInt32LE(ptr + 42);
            const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
            ptr += 46 + nameLen + extraLen + commentLen;

            if (name.endsWith('/') || localOff + 30 > buf.length) continue;
            if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
            const lhNameLen = buf.readUInt16LE(localOff + 26);
            const lhExtraLen = buf.readUInt16LE(localOff + 28);
            const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
            if (dataStart + compSize > buf.length) continue;

            if (/\.(png|jpe?g|webp|gif)$/i.test(name)) {
                return decodeEntry(method, dataStart, compSize, name);
            }
            if (!fallbackEntry && compSize > 0) {
                fallbackEntry = { method, dataStart, compSize, name };
            }
        }
        if (fallbackEntry) {
            return decodeEntry(fallbackEntry.method, fallbackEntry.dataStart, fallbackEntry.compSize, fallbackEntry.name);
        }
    }

    // Fallback: sequential local file headers
    let pos = 0;
    while (pos + 30 <= buf.length) {
        if (buf.readUInt32LE(pos) !== 0x04034b50) break;
        const method = buf.readUInt16LE(pos + 8);
        const compSize = buf.readUInt32LE(pos + 18);
        const nameLen = buf.readUInt16LE(pos + 26);
        const extraLen = buf.readUInt16LE(pos + 28);
        const name = buf.toString('utf8', pos + 30, pos + 30 + nameLen);
        const dataStart = pos + 30 + nameLen + extraLen;
        if (!name.endsWith('/') && compSize > 0 && dataStart + compSize <= buf.length) {
            return decodeEntry(method, dataStart, compSize, name);
        }
        pos = dataStart + Math.max(0, compSize);
        if (compSize === 0) break;
    }

    throw new Error('ZIP 응답에서 이미지 파일을 찾지 못했습니다.');
}

function mapPcDbConfigToImageGen(dbCfg, customCfg) {
    const base = normalizeImageGenConfig(customCfg);
    if (!dbCfg || typeof dbCfg !== 'object') return base;
    const rawProv = String(dbCfg.sdProvider || '').toLowerCase().trim();
    if (!rawProv) return base;

    const nai = (dbCfg.NAIImgConfig && typeof dbCfg.NAIImgConfig === 'object') ? dbCfg.NAIImgConfig : {};
    const comfy = (dbCfg.comfyConfig && typeof dbCfg.comfyConfig === 'object') ? dbCfg.comfyConfig : {};
    const sd = (dbCfg.sdConfig && typeof dbCfg.sdConfig === 'object') ? dbCfg.sdConfig : {};

    if (rawProv === 'novelai') {
        return normalizeImageGenConfig({
            ...base,
            source: 'pc_risu',
            provider: 'novelai',
            apiUrl: dbCfg.NAIImgUrl || 'https://image.novelai.net/ai/generate-image',
            apiKey: dbCfg.NAIApiKey || base.apiKey,
            model: dbCfg.NAIImgModel || 'nai-diffusion-4-5-full',
            width: nai.width || 1024,
            height: nai.height || 1024,
            steps: nai.steps || 28,
            scale: nai.scale !== undefined ? nai.scale : 5,
            sampler: nai.sampler || 'k_euler_ancestral',
            noiseSchedule: nai.noise_schedule || 'karras',
            varietyPlus: Boolean(nai.variety_plus),
            sm: Boolean(nai.sm),
            smDyn: Boolean(nai.sm_dyn),
            cfgRescale: nai.cfg_rescale !== undefined ? nai.cfg_rescale : 0,
        });
    }
    if (rawProv === 'comfy' || rawProv === 'comfyui') {
        return normalizeImageGenConfig({
            ...base,
            source: 'pc_risu',
            provider: 'comfyui',
            apiUrl: dbCfg.comfyUiUrl || 'http://127.0.0.1:8188',
            comfyWorkflowJson: comfy.workflow || base.comfyWorkflowJson,
            comfyPosNodeId: comfy.posNodeID || '',
            comfyPosInputName: comfy.posInputName || 'text',
            comfyNegNodeId: comfy.negNodeID || '',
            comfyNegInputName: comfy.negInputName || 'text',
            comfyTimeoutMs: (Number(comfy.timeout) > 0 && Number(comfy.timeout) < 1000)
                ? Number(comfy.timeout) * 1000
                : (Number(comfy.timeout) || base.comfyTimeoutMs),
        });
    }
    if (rawProv === 'webui') {
        return normalizeImageGenConfig({
            ...base,
            source: 'pc_risu',
            provider: 'webui',
            apiUrl: dbCfg.webUiUrl || 'http://127.0.0.1:7860',
            width: sd.width || base.width,
            height: sd.height || base.height,
            steps: dbCfg.sdSteps || base.steps,
            scale: dbCfg.sdCFG || base.scale,
            sampler: sd.sampler_name || base.sampler,
        });
    }
    if (rawProv === 'dalle' || rawProv === 'openai') {
        return normalizeImageGenConfig({
            ...base,
            source: 'pc_risu',
            provider: 'openai',
            apiUrl: 'https://api.openai.com/v1/images/generations',
            apiKey: dbCfg.openAIKey || base.apiKey,
            model: 'dall-e-3',
            openaiQuality: dbCfg.dallEQuality || 'standard',
        });
    }
    return base;
}

function resolveDimensions(cfg, options = {}) {
    let w = Number(options.width) || Number(cfg.width) || 1024;
    let h = Number(options.height) || Number(cfg.height) || 1024;
    const ori = String((options && options.orientation) || '').toLowerCase();
    if (ori === 'landscape') {
        if (!options.width && !options.height) {
            w = 1216;
            h = 832;
        } else if (w < h) {
            [w, h] = [h, w];
        }
    } else if (ori === 'portrait') {
        if (!options.width && !options.height) {
            w = 832;
            h = 1216;
        } else if (w > h) {
            [w, h] = [h, w];
        }
    }
    return {
        width: Math.max(64, Math.round(w / 64) * 64),
        height: Math.max(64, Math.round(h / 64) * 64),
        orientation: ori,
    };
}

function splitMultiCharPrompt(text) {
    const parts = String(text || '').split(' | ').map((s) => s.trim());
    return {
        base: parts[0] || '',
        chars: parts.slice(1).filter((s) => s.length > 0),
    };
}

async function callNovelAI({ positive, negative, dims, cfg, fetchImpl }) {
    if (!cfg.apiKey) {
        throw new Error('NovelAI API 키가 설정되지 않았습니다. PC RisuAI [기타 봇 - 이미지 생성] 또는 RisuStand [모델/번역]에서 키를 입력해 주세요.');
    }
    const endpoint = cfg.apiUrl || 'https://image.novelai.net/ai/generate-image';
    const model = cfg.model || 'nai-diffusion-4-5-full';
    const isV4 = /^nai-diffusion-4/i.test(model);
    const seed = crypto.randomInt(0, 2147483647);

    let parameters;
    if (isV4) {
        const posSplit = splitMultiCharPrompt(positive);
        const negSplit = splitMultiCharPrompt(negative);
        const charCount = posSplit.chars.length;
        const posCharCaptions = posSplit.chars.map((p) => ({
            char_caption: p,
            centers: [{ x: 0.5, y: 0.5 }],
        }));
        const negCharCaptions = Array.from({ length: charCount }, (_, i) => ({
            char_caption: negSplit.chars[i] || '',
            centers: [{ x: 0.5, y: 0.5 }],
        }));
        const characterPrompts = posSplit.chars.map((p, i) => ({
            prompt: p,
            uc: negSplit.chars[i] || '',
            center: { x: 0.5, y: 0.5 },
            enabled: true,
        }));
        const isV45 = /4-5|4\.5/i.test(model);
        parameters = {
            params_version: 3,
            width: dims.width,
            height: dims.height,
            scale: cfg.scale,
            sampler: cfg.sampler || 'k_euler_ancestral',
            steps: cfg.steps,
            n_samples: 1,
            ucPreset: 0,
            qualityToggle: false,
            autoSmea: false,
            dynamic_thresholding: false,
            controlnet_strength: 1,
            legacy: false,
            add_original_image: true,
            cfg_rescale: cfg.cfgRescale || 0,
            noise_schedule: cfg.noiseSchedule || 'karras',
            legacy_v3_extend: false,
            skip_cfg_above_sigma: cfg.varietyPlus ? (isV45 ? 58 : 19) : null,
            use_coords: false,
            seed,
            characterPrompts,
            v4_prompt: {
                caption: { base_caption: posSplit.base, char_captions: posCharCaptions },
                use_coords: false,
                use_order: true,
            },
            v4_negative_prompt: {
                caption: { base_caption: negSplit.base, char_captions: negCharCaptions },
                legacy_uc: false,
            },
            negative_prompt: negSplit.base,
        };
    } else {
        parameters = {
            width: dims.width,
            height: dims.height,
            scale: cfg.scale,
            sampler: cfg.sampler || 'k_euler_ancestral',
            steps: cfg.steps,
            n_samples: 1,
            ucPreset: 0,
            qualityToggle: false,
            sm: Boolean(cfg.sm),
            sm_dyn: Boolean(cfg.smDyn),
            dynamic_thresholding: false,
            controlnet_strength: 1,
            legacy: false,
            add_original_image: false,
            cfg_rescale: cfg.cfgRescale || 0,
            noise_schedule: cfg.noiseSchedule || 'native',
            seed,
            negative_prompt: negative,
        };
    }

    const resp = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${cfg.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            input: positive,
            model,
            action: 'generate',
            parameters,
        }),
    });
    if (!resp.ok) {
        const errTxt = await resp.text().catch(() => '');
        throw new Error(`NovelAI HTTP ${resp.status}: ${errTxt.slice(0, 300)}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    return extractFirstImageFromZip(buf);
}

async function callComfyUI({ positive, negative, cfg, fetchImpl }) {
    const base = (cfg.apiUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '');
    if (!cfg.comfyWorkflowJson || !cfg.comfyWorkflowJson.trim()) {
        throw new Error('ComfyUI 워크플로우 JSON이 비어 있습니다. PC RisuAI 또는 RisuStand [모델/번역]에서 ComfyUI API Workflow JSON을 설정해 주세요.');
    }

    let workflowStr = String(cfg.comfyWorkflowJson);
    const jsonEscStr = (s) => JSON.stringify(String(s || '')).slice(1, -1);
    const hasTemplatePlaceholders = workflowStr.includes('{{risu_prompt}}') || workflowStr.includes('{{risu_neg}}');
    if (hasTemplatePlaceholders) {
        workflowStr = workflowStr
            .replace(/\{\{risu_prompt\}\}/g, jsonEscStr(positive))
            .replace(/\{\{risu_neg\}\}/g, jsonEscStr(negative));
    }

    let workflow;
    try {
        workflow = JSON.parse(workflowStr);
    } catch (e) {
        throw new Error(`ComfyUI 워크플로우 JSON 파싱 실패: ${e.message}`);
    }

    if (cfg.comfyPosNodeId && workflow[cfg.comfyPosNodeId] && workflow[cfg.comfyPosNodeId].inputs) {
        workflow[cfg.comfyPosNodeId].inputs[cfg.comfyPosInputName || 'text'] = positive;
    }
    if (cfg.comfyNegNodeId && workflow[cfg.comfyNegNodeId] && workflow[cfg.comfyNegNodeId].inputs) {
        workflow[cfg.comfyNegNodeId].inputs[cfg.comfyNegInputName || 'text'] = negative;
    }
    for (const node of Object.values(workflow)) {
        if (node && typeof node === 'object' && node.inputs && typeof node.inputs === 'object') {
            if (typeof node.inputs.seed === 'number') {
                node.inputs.seed = crypto.randomInt(0, 2147483647);
            } else if (typeof node.inputs.noise_seed === 'number') {
                node.inputs.noise_seed = crypto.randomInt(0, 2147483647);
            }
        }
    }

    const qResp = await fetchImpl(`${base}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow }),
    });
    if (!qResp.ok) {
        const errTxt = await qResp.text().catch(() => '');
        throw new Error(`ComfyUI /prompt HTTP ${qResp.status}: ${errTxt.slice(0, 300)}`);
    }
    const qData = await qResp.json();
    const promptId = qData && qData.prompt_id;
    if (!promptId) {
        throw new Error('ComfyUI가 prompt_id를 반환하지 않았습니다.');
    }

    const deadline = Date.now() + Math.max(5000, Number(cfg.comfyTimeoutMs) || 120000);
    let imageMeta = null;
    while (Date.now() < deadline) {
        const hResp = await fetchImpl(`${base}/history/${encodeURIComponent(promptId)}`);
        let hJson = null;
        if (hResp.ok) {
            hJson = await hResp.json().catch(() => null);
        } else {
            const allResp = await fetchImpl(`${base}/history`);
            if (allResp.ok) hJson = await allResp.json().catch(() => null);
        }
        const entry = hJson && (hJson[promptId] || (hJson.outputs ? hJson : null));
        if (entry && entry.outputs && typeof entry.outputs === 'object') {
            for (const nodeOut of Object.values(entry.outputs)) {
                if (nodeOut && Array.isArray(nodeOut.images) && nodeOut.images.length) {
                    imageMeta = nodeOut.images[0];
                    break;
                }
            }
        }
        if (imageMeta) break;
        await new Promise((r) => setTimeout(r, 350));
    }

    if (!imageMeta || !imageMeta.filename) {
        throw new Error('ComfyUI 이미지 생성 대기 시간을 초과했습니다.');
    }
    const qs = new URLSearchParams({
        filename: String(imageMeta.filename),
        subfolder: String(imageMeta.subfolder || ''),
        type: String(imageMeta.type || 'output'),
    });
    const vResp = await fetchImpl(`${base}/view?${qs.toString()}`);
    if (!vResp.ok) {
        throw new Error(`ComfyUI /view HTTP ${vResp.status}`);
    }
    const bytes = Buffer.from(await vResp.arrayBuffer());
    const mime = detectMimeFromBytes(bytes, imageMeta.filename);
    return {
        bytes,
        mime,
        filename: imageMeta.filename,
        dataUri: `data:${mime};base64,${bytes.toString('base64')}`,
    };
}

async function callWebUI({ positive, negative, dims, cfg, fetchImpl }) {
    const base = (cfg.apiUrl || 'http://127.0.0.1:7860').replace(/\/+$/, '');
    const resp = await fetchImpl(`${base}/sdapi/v1/txt2img`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            prompt: positive,
            negative_prompt: negative,
            width: dims.width,
            height: dims.height,
            steps: cfg.steps || 25,
            cfg_scale: cfg.scale || 7,
            sampler_name: cfg.sampler || 'Euler a',
            seed: -1,
        }),
    });
    if (!resp.ok) {
        const errTxt = await resp.text().catch(() => '');
        throw new Error(`SD WebUI HTTP ${resp.status}: ${errTxt.slice(0, 300)}`);
    }
    const data = await resp.json();
    const b64 = Array.isArray(data && data.images) ? data.images[0] : '';
    if (!b64) throw new Error('SD WebUI가 이미지를 반환하지 않았습니다.');
    const cleanB64 = String(b64).replace(/^data:image\/[^;]+;base64,/, '');
    const bytes = Buffer.from(cleanB64, 'base64');
    const mime = detectMimeFromBytes(bytes, 'webui.png');
    return {
        bytes,
        mime,
        dataUri: `data:${mime};base64,${bytes.toString('base64')}`,
    };
}

async function callOpenAIImage({ positive, dims, cfg, fetchImpl }) {
    if (!cfg.apiKey) {
        throw new Error('OpenAI 이미지 생성 API 키가 비어 있습니다.');
    }
    const endpoint = cfg.apiUrl || 'https://api.openai.com/v1/images/generations';
    const size = dims.orientation === 'landscape'
        ? '1792x1024'
        : dims.orientation === 'portrait'
        ? '1024x1792'
        : '1024x1024';
    const resp = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${cfg.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: cfg.model || 'dall-e-3',
            prompt: positive,
            n: 1,
            size,
            quality: cfg.openaiQuality || 'standard',
            response_format: 'b64_json',
        }),
    });
    if (!resp.ok) {
        const errTxt = await resp.text().catch(() => '');
        throw new Error(`OpenAI Image HTTP ${resp.status}: ${errTxt.slice(0, 300)}`);
    }
    const data = await resp.json();
    const item = Array.isArray(data && data.data) ? data.data[0] : null;
    if (item && item.b64_json) {
        const bytes = Buffer.from(item.b64_json, 'base64');
        const mime = detectMimeFromBytes(bytes, 'openai.png');
        return { bytes, mime, dataUri: `data:${mime};base64,${bytes.toString('base64')}` };
    }
    if (item && item.url) {
        const imgResp = await fetchImpl(item.url);
        if (!imgResp.ok) throw new Error(`OpenAI Image URL HTTP ${imgResp.status}`);
        const bytes = Buffer.from(await imgResp.arrayBuffer());
        const mime = detectMimeFromBytes(bytes, 'openai.png');
        return { bytes, mime, dataUri: `data:${mime};base64,${bytes.toString('base64')}` };
    }
    throw new Error('OpenAI Image 응답에 이미지 데이터가 없습니다.');
}

async function generateImageBytes({ positive = '', negative = '', options = {}, charObj = null, effectiveCfg, fetchImpl = fetch }) {
    const cfg = normalizeImageGenConfig(effectiveCfg);
    const charPos = charObj && charObj.sdData && charObj.sdData.positive ? String(charObj.sdData.positive) : '';
    const charNeg = charObj && charObj.sdData && charObj.sdData.negative ? String(charObj.sdData.negative) : '';
    const combinedPos = [charPos, String(positive || '')].filter(Boolean).join(', ').trim();
    const combinedNeg = [cfg.negativeBase, charNeg, String(negative || '')].filter(Boolean).join(', ').trim();
    const dims = resolveDimensions(cfg, options);

    if (cfg.provider === 'comfyui') {
        return await callComfyUI({ positive: combinedPos, negative: combinedNeg, dims, cfg, fetchImpl });
    }
    if (cfg.provider === 'webui') {
        return await callWebUI({ positive: combinedPos, negative: combinedNeg, dims, cfg, fetchImpl });
    }
    if (cfg.provider === 'openai') {
        return await callOpenAIImage({ positive: combinedPos, negative: combinedNeg, dims, cfg, fetchImpl });
    }
    return await callNovelAI({ positive: combinedPos, negative: combinedNeg, dims, cfg, fetchImpl });
}

function createImageProvider({ getBackendConfig, hostRpc, createInlay, fetchImpl = fetch }) {
    async function resolveEffectiveConfig() {
        const raw = typeof getBackendConfig === 'function' ? (getBackendConfig().imageGen || {}) : {};
        const customCfg = normalizeImageGenConfig(raw);
        if (customCfg.source === 'pc_risu' && hostRpc && typeof hostRpc.isConnected === 'function' && hostRpc.isConnected()) {
            try {
                const dbCfg = await hostRpc.invoke('db.getImageGenConfig', []);
                if (dbCfg && dbCfg.sdProvider) {
                    return mapPcDbConfigToImageGen(dbCfg, customCfg);
                }
            } catch (_) {}
        }
        return customCfg;
    }

    async function generateInlay({ positive = '', negative = '', options = {}, charObj = null } = {}) {
        const effectiveCfg = await resolveEffectiveConfig();
        const img = await generateImageBytes({ positive, negative, options, charObj, effectiveCfg, fetchImpl });
        if (typeof createInlay !== 'function') {
            throw new Error('Inlay 저장소가 준비되지 않았습니다.');
        }
        const inlayId = await createInlay(img.dataUri, { name: img.filename || 'risustand-gen.png' });
        if (!inlayId) {
            throw new Error('RisuAI Inlay 저장에 실패했습니다.');
        }
        return {
            inlayId: String(inlayId),
            inlayToken: `{{inlay::${inlayId}}}`,
            mime: img.mime,
            dataUri: img.dataUri,
        };
    }

    return {
        resolveEffectiveConfig,
        generateInlay,
    };
}

module.exports = {
    DEFAULT_NEGATIVE_BASE,
    defaultImageGenConfig,
    normalizeImageGenConfig,
    sanitizeImageGenForClient,
    buildSingleFileZip,
    extractFirstImageFromZip,
    mapPcDbConfigToImageGen,
    generateImageBytes,
    createImageProvider,
};
