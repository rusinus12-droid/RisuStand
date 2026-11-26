#!/usr/bin/env node
/**
 * RisuStand Updater — zero-dependency (Node 18+), modeled on Librarian-System's updater.
 *
 * Verification order (all must pass before anything on disk changes):
 *   1. GitHub stable release (not draft/prerelease) with the exact asset RisuStand-<ver>.zip
 *   2. GitHub asset `sha256:` digest == downloaded bytes
 *   3. ZIP structure: single RisuStand-<ver>/ root, no traversal, CRC32 per entry, size limits
 *   4. update-manifest.json: schema, repository, version, tag, asset name, update policy
 *   5. SHA256SUMS.txt covers every payload file and every hash matches
 *   6. JavaScript payloads pass `node --check`
 * Install: lock -> journal -> backup -> atomic per-file replace -> "installed".
 * The relay server marks the journal "committed" once the new version is listening;
 * an interrupted or failed install is rolled back from the backup.
 *
 * User data (.risustand-token, .risustand-config.json) is never read or written.
 * Running launchers (.bat/.sh) are never overwritten in place: changed ones are
 * staged next to the original as "<name>.new".
 *
 * CLI:  node risustand-updater.cjs --check
 *       node risustand-updater.cjs --apply            (stop the relay server first)
 *       node risustand-updater.cjs --release-zip <RisuStand-x.y.z.zip> [--expected-sha256 <hex>]
 *       node risustand-updater.cjs --recover
 *
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Required Notice: Copyright (c) 2026 rusinus12
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const REPOSITORY = Object.freeze({
    owner: 'rusinus12-droid',
    repo: 'RisuStand',
    slug: 'rusinus12-droid/RisuStand',
    web: 'https://github.com/rusinus12-droid/RisuStand',
});
const MANIFEST_SCHEMA = 'risustand.update-manifest.v1';
const UPDATER_CONTRACT = 1;
const MAX_ZIP_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 200;

// Replaced in place on update.
const PROGRAM_FILES = Object.freeze([
    'risustand-relay-server.js',
    'risustand-admin.cjs',
    'risustand-updater.cjs',
    'risustand.js',
    'README.md',
    'LICENSE',
    'VERSION',
    'release-policy.json',
    'prompt/Leave_RisuAI_Preset.risup',
    'prompt/Leave_RisuAI_Preset.html',
]);
// May be running while we update: staged as "<name>.new" when changed.
const LAUNCHER_FILES = Object.freeze([
    'start-risustand-remote.bat',
    'start-risustand-remote.sh',
    'stop-risustand-remote.bat',
    'stop-risustand-remote.sh',
    'rotate-risustand-token.bat',
    'rotate-risustand-token.sh',
    'change-risustand-port.bat',
    'change-risustand-port.sh',
    'update-risustand.bat',
    'update-risustand.sh',
]);
const PAYLOAD_FILES = Object.freeze([...PROGRAM_FILES, ...LAUNCHER_FILES]);
const META_FILES = Object.freeze(['update-manifest.json', 'SHA256SUMS.txt']);
const EXECUTABLE_FILES = new Set(['start-risustand-remote.sh', 'stop-risustand-remote.sh', 'rotate-risustand-token.sh', 'change-risustand-port.sh', 'update-risustand.sh']);

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function apiBase() {
    // Test hook only (local fake GitHub). Production always talks to api.github.com.
    return (process.env.RISUSTAND_UPDATE_API_BASE || 'https://api.github.com').replace(/\/+$/, '');
}

function expectedAssetName(version) {
    return `RisuStand-${version}.zip`;
}

function parseAssetVersion(name) {
    const m = String(name || '').match(/^RisuStand-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.zip$/);
    return m ? m[1] : null;
}

function compareVersions(a, b) {
    const parts = (v) => String(v || '').trim().replace(/^v/i, '').split('.').map((x) => Number((String(x).match(/^\d+/) || ['0'])[0]));
    const A = parts(a);
    const B = parts(b);
    for (let i = 0; i < 3; i++) {
        const d = (A[i] || 0) - (B[i] || 0);
        if (d) return d > 0 ? 1 : -1;
    }
    return 0;
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function normalizeDigest(value) {
    const m = String(value || '').trim().match(/^sha256:([a-f0-9]{64})$/i);
    return m ? m[1].toLowerCase() : null;
}

// ---------------------------------------------------------------- CRC32 / ZIP
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

class UpdateError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}

function assertSafeEntryName(name) {
    if (!name || name.length > 300) throw new UpdateError('zip_entry_name_invalid', `잘못된 ZIP 항목 이름: ${name}`);
    if (name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
        throw new UpdateError('zip_entry_path_unsafe', `안전하지 않은 ZIP 경로: ${name}`);
    }
    const segs = name.split('/');
    if (segs.some((s) => s === '..' || s === '.')) throw new UpdateError('zip_entry_path_unsafe', `안전하지 않은 ZIP 경로: ${name}`);
}

// Minimal ZIP32 reader (stored + deflate), with CRC and size checks.
function readZip(buf, { maxEntries = MAX_ENTRIES, maxEntryBytes = MAX_ENTRY_BYTES } = {}) {
    if (!Buffer.isBuffer(buf) || buf.length < 22) throw new UpdateError('zip_invalid', 'ZIP 파일이 아닙니다.');
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new UpdateError('zip_invalid', 'ZIP 끝 레코드를 찾지 못했습니다.');
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (count > maxEntries) throw new UpdateError('zip_too_many_entries', 'ZIP 항목이 너무 많습니다.');
    if (cdOffset + cdSize > eocd) throw new UpdateError('zip_invalid', 'ZIP 중앙 디렉터리가 손상되었습니다.');
    const entries = [];
    const seen = new Set();
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) throw new UpdateError('zip_invalid', 'ZIP 중앙 디렉터리 항목이 손상되었습니다.');
        const flags = buf.readUInt16LE(p + 8);
        const method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16);
        const csize = buf.readUInt32LE(p + 20);
        const usize = buf.readUInt32LE(p + 24);
        const nlen = buf.readUInt16LE(p + 28);
        const xlen = buf.readUInt16LE(p + 30);
        const clen = buf.readUInt16LE(p + 32);
        const extAttr = buf.readUInt32LE(p + 38);
        const local = buf.readUInt32LE(p + 42);
        const name = buf.slice(p + 46, p + 46 + nlen).toString(flags & 0x800 ? 'utf8' : 'latin1');
        p += 46 + nlen + xlen + clen;
        if (flags & 0x1) throw new UpdateError('zip_encrypted', '암호화된 ZIP은 지원하지 않습니다.');
        assertSafeEntryName(name);
        if (seen.has(name)) throw new UpdateError('zip_duplicate_entry', `중복된 ZIP 항목: ${name}`);
        seen.add(name);
        if (name.endsWith('/')) continue;
        if (usize > maxEntryBytes || csize > maxEntryBytes) throw new UpdateError('zip_entry_too_large', `ZIP 항목이 너무 큽니다: ${name}`);
        if (buf.readUInt32LE(local) !== 0x04034b50) throw new UpdateError('zip_invalid', 'ZIP 로컬 헤더가 손상되었습니다.');
        const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.slice(dataStart, dataStart + csize);
        if (raw.length !== csize) throw new UpdateError('zip_invalid', `ZIP 데이터가 잘렸습니다: ${name}`);
        let data;
        if (method === 0) data = Buffer.from(raw);
        else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: maxEntryBytes });
        else throw new UpdateError('zip_method_unsupported', `지원하지 않는 압축 방식: ${name}`);
        if (data.length !== usize || crc32(data) !== crc) throw new UpdateError('zip_crc_mismatch', `ZIP CRC 검증 실패: ${name}`);
        entries.push({ name, data, mode: (extAttr >>> 16) & 0o777 });
    }
    return entries;
}

// ---------------------------------------------------------------- GitHub
async function fetchWithTimeout(url, { fetchImpl = globalThis.fetch, timeoutMs = 15000, headers = {} } = {}) {
    if (typeof fetchImpl !== 'function') throw new UpdateError('fetch_unavailable', 'Node.js 18 이상이 필요합니다.');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await fetchImpl(url, { headers: { 'User-Agent': 'RisuStand-Updater', ...headers }, signal: ctrl.signal, redirect: 'follow' });
    } catch (e) {
        throw new UpdateError('network_error', `GitHub에 연결하지 못했습니다: ${e && e.message ? e.message : e}`);
    } finally {
        clearTimeout(timer);
    }
}

async function checkLatest({ currentVersion, fetchImpl } = {}) {
    const url = `${apiBase()}/repos/${REPOSITORY.slug}/releases/latest`;
    const res = await fetchWithTimeout(url, { fetchImpl, headers: { Accept: 'application/vnd.github+json' } });
    if (res.status === 404) return { ok: true, available: false, currentVersion, reason: 'no_release' };
    if (!res.ok) throw new UpdateError('release_lookup_failed', `릴리즈 정보를 가져오지 못했습니다 (HTTP ${res.status}).`);
    const rel = await res.json();
    if (rel.draft || rel.prerelease) return { ok: true, available: false, currentVersion, reason: 'no_stable_release' };
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    if (!SEMVER.test(latest)) throw new UpdateError('release_tag_invalid', `릴리즈 태그 형식이 올바르지 않습니다: ${rel.tag_name}`);
    const name = expectedAssetName(latest);
    const raw = (Array.isArray(rel.assets) ? rel.assets : []).find((a) => a && a.name === name) || null;
    const asset = raw
        ? { name, url: String(raw.browser_download_url || ''), size: Number(raw.size || 0), sha256: normalizeDigest(raw.digest) }
        : null;
    return {
        ok: true,
        available: compareVersions(latest, currentVersion) > 0,
        currentVersion,
        latestVersion: latest,
        tag: String(rel.tag_name),
        htmlUrl: String(rel.html_url || `${REPOSITORY.web}/releases`),
        publishedAt: rel.published_at || null,
        notes: String(rel.body || '').slice(0, 4000),
        asset,
    };
}

async function downloadAsset(asset, { fetchImpl } = {}) {
    if (!asset || !asset.url) throw new UpdateError('release_asset_missing', '릴리즈에 공식 업데이트 ZIP이 없습니다.');
    if (!/^https:\/\//i.test(String(asset.url))) throw new UpdateError('release_asset_url_invalid', 'HTTPS 공식 릴리즈 URL만 허용됩니다.');
    if (!asset.sha256) throw new UpdateError('release_asset_digest_missing', '릴리즈 ZIP의 SHA-256 정보가 없어 업데이트를 거부합니다.');
    if (asset.size > MAX_ZIP_BYTES) throw new UpdateError('release_asset_too_large', '업데이트 파일이 너무 큽니다.');
    const res = await fetchWithTimeout(asset.url, { fetchImpl, timeoutMs: 120000, headers: { Accept: 'application/octet-stream' } });
    if (!res.ok) throw new UpdateError('download_failed', `업데이트 파일 다운로드 실패 (HTTP ${res.status}).`);
    let buf;
    if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const chunks = [];
        let total = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength || value.length || 0;
            if (total > MAX_ZIP_BYTES) {
                await reader.cancel().catch(() => {});
                throw new UpdateError('release_asset_too_large', '업데이트 파일이 너무 큽니다.');
            }
            chunks.push(Buffer.from(value));
        }
        buf = Buffer.concat(chunks, total);
    } else {
        buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_ZIP_BYTES) throw new UpdateError('release_asset_too_large', '업데이트 파일이 너무 큽니다.');
    }
    if (sha256(buf) !== asset.sha256) throw new UpdateError('release_sha256_mismatch', '다운로드한 파일의 SHA-256이 GitHub 릴리즈와 다릅니다.');
    return buf;
}

// ---------------------------------------------------------------- Verification
function parseSums(text) {
    const map = new Map();
    for (const line of String(text).split(/\r?\n/)) {
        if (!line.trim()) continue;
        const m = line.match(/^([a-f0-9]{64}) [ *](.+)$/);
        if (!m) throw new UpdateError('checksums_invalid', 'SHA256SUMS.txt 형식이 올바르지 않습니다.');
        if (map.has(m[2])) throw new UpdateError('checksums_invalid', 'SHA256SUMS.txt에 중복 항목이 있습니다.');
        map.set(m[2], m[1]);
    }
    return map;
}

function syntaxCheck(rel, data, workDir) {
    if (!/\.(c?js)$/.test(rel)) return;
    fs.mkdirSync(workDir, { recursive: true });
    const tmp = path.join(workDir, `check-${crypto.randomBytes(6).toString('hex')}-${path.basename(rel)}`);
    fs.writeFileSync(tmp, data);
    try {
        const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8', timeout: 30000 });
        if (r.status !== 0) throw new UpdateError('payload_syntax_error', `업데이트 파일 문법 검사 실패: ${rel}\n${(r.stderr || '').slice(0, 500)}`);
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}

/**
 * Verifies an official release ZIP. Returns { version, manifest, files: Map<rel, Buffer> }.
 * `expectedVersion` pins the version (from the GitHub tag or the ZIP file name).
 */
function verifyReleaseArchive(buf, { expectedVersion, workDir = path.join(require('os').tmpdir(), 'risustand-update-check') } = {}) {
    if (!SEMVER.test(String(expectedVersion || ''))) throw new UpdateError('release_version_invalid', '릴리즈 버전을 알 수 없습니다.');
    const prefix = `RisuStand-${expectedVersion}/`;
    const entries = readZip(buf);
    const files = new Map();
    const modes = new Map();
    for (const e of entries) {
        if (!e.name.startsWith(prefix)) throw new UpdateError('release_layout_invalid', `ZIP 최상위 폴더가 ${prefix} 가 아닙니다: ${e.name}`);
        const rel = e.name.slice(prefix.length);
        if (!rel) throw new UpdateError('release_layout_invalid', `예상하지 못한 하위 경로: ${e.name}`);
        if (!PAYLOAD_FILES.includes(rel) && !META_FILES.includes(rel)) throw new UpdateError('release_unexpected_file', `예상하지 못한 파일: ${rel}`);
        files.set(rel, e.data);
        modes.set(rel, e.mode);
    }
    for (const req of [...META_FILES, ...PROGRAM_FILES]) {
        if (!files.has(req)) throw new UpdateError('release_file_missing', `필수 파일이 없습니다: ${req}`);
    }

    let manifest;
    try {
        manifest = JSON.parse(files.get('update-manifest.json').toString('utf8'));
    } catch (_) {
        throw new UpdateError('manifest_invalid', 'update-manifest.json을 읽지 못했습니다.');
    }
    const want = {
        schema: MANIFEST_SCHEMA,
        repository: REPOSITORY.slug,
        version: expectedVersion,
        tag: `v${expectedVersion}`,
        assetName: expectedAssetName(expectedVersion),
    };
    for (const [k, v] of Object.entries(want)) {
        if (manifest[k] !== v) throw new UpdateError('manifest_mismatch', `update-manifest.json ${k} 불일치 (${manifest[k]} ≠ ${v})`);
    }
    if (!['program_only', 'manual_required'].includes(manifest.updatePolicy)) throw new UpdateError('manifest_policy_invalid', '알 수 없는 업데이트 정책입니다.');
    if (!SEMVER.test(String(manifest.minimumSourceVersion || ''))) throw new UpdateError('manifest_invalid', 'minimumSourceVersion이 올바르지 않습니다.');
    if (Number(manifest.updaterContract || 0) > UPDATER_CONTRACT) {
        throw new UpdateError('updater_contract_newer', '이 업데이트는 더 새로운 업데이터가 필요합니다. 릴리즈 페이지에서 직접 받아 주세요.');
    }

    const sums = parseSums(files.get('SHA256SUMS.txt').toString('utf8'));
    for (const [rel, data] of files) {
        if (rel === 'SHA256SUMS.txt') continue;
        const expected = sums.get(rel);
        if (!expected) throw new UpdateError('checksum_missing', `SHA256SUMS.txt에 ${rel} 항목이 없습니다.`);
        if (sha256(data) !== expected) throw new UpdateError('checksum_mismatch', `파일 해시 불일치: ${rel}`);
    }
    for (const rel of sums.keys()) {
        if (!files.has(rel)) throw new UpdateError('checksum_extra', `SHA256SUMS.txt의 ${rel} 파일이 ZIP에 없습니다.`);
    }

    if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
        throw new UpdateError('manifest_files_mismatch', 'update-manifest.json의 files 항목이 올바르지 않습니다.');
    }
    const payloadRels = [...files.keys()].filter((rel) => !META_FILES.includes(rel));
    const manifestKeys = Object.keys(manifest.files);
    if (manifestKeys.length !== payloadRels.length) {
        throw new UpdateError('manifest_files_mismatch', 'update-manifest.json의 파일 목록이 ZIP 내용과 다릅니다.');
    }
    for (const rel of payloadRels) {
        if (!Object.prototype.hasOwnProperty.call(manifest.files, rel) || manifest.files[rel] !== sums.get(rel)) {
            throw new UpdateError('manifest_files_mismatch', `update-manifest.json 해시 불일치: ${rel}`);
        }
    }

    const version = files.get('VERSION').toString('utf8').trim();
    if (version !== expectedVersion) throw new UpdateError('payload_version_mismatch', `VERSION 파일(${version})이 릴리즈(${expectedVersion})와 다릅니다.`);
    for (const [rel, data] of files) syntaxCheck(rel, data, workDir);

    return { version, manifest, files, modes, sha256: sha256(buf) };
}

// ---------------------------------------------------------------- Install / rollback
function updateDir(root) { return path.join(root, '.update'); }
function journalPath(root) { return path.join(updateDir(root), 'journal.json'); }

function readInstalledVersion(root, fallback = '0.0.0') {
    try {
        const v = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
        return SEMVER.test(v) ? v : fallback;
    } catch (_) {
        return fallback;
    }
}

function readJournal(root) {
    try {
        return JSON.parse(fs.readFileSync(journalPath(root), 'utf8'));
    } catch (_) {
        return null;
    }
}

function writeFileAtomic(file, data, mode) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.rs-tmp-${crypto.randomBytes(6).toString('hex')}`;
    fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
    renameWithRetry(tmp, file);
}

function renameWithRetry(from, to) {
    // Windows: antivirus/indexers can briefly hold files (EPERM/EBUSY).
    for (let i = 0; ; i++) {
        try {
            fs.renameSync(from, to);
            return;
        } catch (e) {
            if (i >= 12 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1));
        }
    }
}

function writeJournal(root, journal) {
    fs.mkdirSync(updateDir(root), { recursive: true });
    writeFileAtomic(journalPath(root), JSON.stringify({ ...journal, updatedAt: new Date().toISOString() }, null, 2));
}

function withLock(root, fn) {
    fs.mkdirSync(updateDir(root), { recursive: true });
    const lock = path.join(updateDir(root), 'lock');
    try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > 10 * 60 * 1000) fs.rmSync(lock, { force: true });
    } catch (_) {}
    let fd;
    try {
        fd = fs.openSync(lock, 'wx');
    } catch (_) {
        throw new UpdateError('update_locked', '다른 업데이트가 진행 중입니다.');
    }
    try {
        fs.writeSync(fd, String(process.pid));
        return fn();
    } finally {
        fs.closeSync(fd);
        fs.rmSync(lock, { force: true });
    }
}

function assertPolicy(verified, currentVersion) {
    const m = verified.manifest;
    if (m.updatePolicy !== 'program_only') {
        throw new UpdateError('manual_update_required', `v${verified.version}은 자동 업데이트를 지원하지 않습니다. 릴리즈 페이지에서 직접 설치해 주세요.`);
    }
    if (compareVersions(currentVersion, m.minimumSourceVersion) < 0) {
        throw new UpdateError('source_version_too_old', `현재 v${currentVersion}은 너무 오래되어 자동 업데이트할 수 없습니다 (최소 v${m.minimumSourceVersion}).`);
    }
    if (compareVersions(verified.version, currentVersion) <= 0) {
        throw new UpdateError('not_newer', `이미 v${currentVersion}입니다.`);
    }
}

/** Applies a verified release into `root`. Returns { from, to, stagedLaunchers, backupDir }. */
function installRelease(root, verified, { currentVersion = readInstalledVersion(root), log = () => {} } = {}) {
    root = path.resolve(root);
    assertPolicy(verified, currentVersion);
    return withLock(root, () => {
        const pending = readJournal(root);
        if (pending && (pending.state === 'installing' || pending.state === 'installed')) {
            throw new UpdateError('update_pending', '이전 업데이트가 아직 확정되지 않았습니다. 서버를 다시 시작하거나 --recover를 실행해 주세요.');
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = path.join(updateDir(root), 'backups', `v${currentVersion}-${stamp}`);
        fs.mkdirSync(backupDir, { recursive: true });

        const program = PROGRAM_FILES.filter((rel) => verified.files.has(rel));
        const files = program.map((rel) => ({ rel, hadOriginal: fs.existsSync(path.join(root, rel)) }));
        const journal = { schema: 'risustand.update-journal.v1', state: 'installing', from: currentVersion, to: verified.version, backupDir, files, startedAt: new Date().toISOString() };
        writeJournal(root, journal);

        try {
            for (const f of files) {
                if (f.hadOriginal) {
                    const backupFile = path.join(backupDir, f.rel);
                    fs.mkdirSync(path.dirname(backupFile), { recursive: true });
                    fs.copyFileSync(path.join(root, f.rel), backupFile);
                }
            }
            log(`백업 완료: ${backupDir}`);

            for (const f of files) {
                writeFileAtomic(path.join(root, f.rel), verified.files.get(f.rel));
            }

            const stagedLaunchers = [];
            for (const rel of LAUNCHER_FILES) {
                if (!verified.files.has(rel)) continue;
                const data = verified.files.get(rel);
                const target = path.join(root, rel);
                const mode = EXECUTABLE_FILES.has(rel) ? 0o755 : undefined;
                if (!fs.existsSync(target)) {
                    writeFileAtomic(target, data, mode);
                } else if (!fs.readFileSync(target).equals(data)) {
                    writeFileAtomic(`${target}.new`, data, mode);
                    stagedLaunchers.push(rel);
                }
            }

            writeJournal(root, { ...journal, state: 'installed', stagedLaunchers });
            log(`v${currentVersion} → v${verified.version} 파일 교체 완료`);
            return { from: currentVersion, to: verified.version, stagedLaunchers, backupDir };
        } catch (err) {
            try { rollbackUnlocked(root, { log }); } catch (_) {}
            throw err;
        }
    });
}

function rollbackUnlocked(root, { log = () => {} } = {}) {
    root = path.resolve(root);
    const j = readJournal(root);
    if (!j || !['installing', 'installed'].includes(j.state)) return { rolledBack: false };
    for (const f of j.files || []) {
        const target = path.join(root, f.rel);
        const backup = path.join(j.backupDir, f.rel);
        if (f.hadOriginal && fs.existsSync(backup)) writeFileAtomic(target, fs.readFileSync(backup));
        else if (!f.hadOriginal) fs.rmSync(target, { force: true });
    }
    writeJournal(root, { ...j, state: 'rolled_back', rolledBackAt: new Date().toISOString() });
    log(`업데이트를 되돌렸습니다: v${j.to} → v${j.from}`);
    return { rolledBack: true, from: j.to, to: j.from };
}

/** Restores the backup of the journal's install. Safe to call repeatedly. */
function rollback(root, opts = {}) {
    return withLock(path.resolve(root), () => rollbackUnlocked(root, opts));
}

/** Called at relay start: an install that never finished is rolled back. */
function recoverIfNeeded(root, { log = () => {} } = {}) {
    const j = readJournal(root);
    if (j && j.state === 'installing') return rollback(root, { log });
    return { rolledBack: false };
}

/** Called by the relay once the new version is listening. Keeps the 2 newest backups. */
function commitInstalled(root, runningVersion) {
    const j = readJournal(root);
    if (!j || j.state !== 'installed' || j.to !== runningVersion) return false;
    writeJournal(root, { ...j, state: 'committed', committedAt: new Date().toISOString() });
    try {
        const dir = path.join(updateDir(root), 'backups');
        const all = fs.readdirSync(dir).map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t);
        for (const old of all.slice(2)) fs.rmSync(path.join(dir, old.n), { recursive: true, force: true });
    } catch (_) {}
    return true;
}

/** check -> download -> verify -> install. `onPhase(phase, detail)` reports progress. */
async function updateToLatest({ root, currentVersion = readInstalledVersion(root), fetchImpl, log = () => {}, onPhase = () => {} } = {}) {
    onPhase('checking');
    const info = await checkLatest({ currentVersion, fetchImpl });
    if (!info.available) return { updated: false, info };
    onPhase('downloading', { version: info.latestVersion });
    const buf = await downloadAsset(info.asset, { fetchImpl });
    onPhase('verifying', { version: info.latestVersion });
    const verified = verifyReleaseArchive(buf, { expectedVersion: info.latestVersion, workDir: path.join(updateDir(root), 'check') });
    onPhase('installing', { version: info.latestVersion });
    const result = installRelease(root, verified, { currentVersion, log });
    return { updated: true, info, ...result };
}

// ---------------------------------------------------------------- CLI
async function main(argv) {
    const root = __dirname;
    const log = (m) => console.log(`[RisuStand Updater] ${m}`);
    const has = (f) => argv.includes(f);
    const valueOf = (f) => {
        const i = argv.indexOf(f);
        return i >= 0 ? argv[i + 1] : null;
    };
    const current = readInstalledVersion(root);
    log(`설치된 버전: v${current}`);

    if (has('--recover')) {
        const r = rollback(root, { log });
        if (!r.rolledBack) log('되돌릴 미완료 업데이트가 없습니다.');
        return 0;
    }
    const zipArg = valueOf('--release-zip');
    if (zipArg) {
        const version = parseAssetVersion(path.basename(zipArg));
        if (!version) throw new UpdateError('release_zip_name_invalid', 'ZIP 이름은 RisuStand-x.y.z.zip 이어야 합니다.');
        const buf = fs.readFileSync(zipArg);
        const expected = (valueOf('--expected-sha256') || '').toLowerCase();
        if (expected && sha256(buf) !== expected) throw new UpdateError('release_sha256_mismatch', 'ZIP의 SHA-256이 지정한 값과 다릅니다.');
        const verified = verifyReleaseArchive(buf, { expectedVersion: version, workDir: path.join(updateDir(root), 'check') });
        const r = installRelease(root, verified, { currentVersion: current, log });
        commitInstalled(root, r.to);
        reportStaged(r, log);
        log('완료. 릴레이 서버를 다시 실행해 주세요.');
        return 0;
    }
    if (has('--apply')) {
        const r = await updateToLatest({ root, currentVersion: current, log, onPhase: (p, d) => log(`${p}${d && d.version ? ` v${d.version}` : ''}...`) });
        if (!r.updated) {
            log('이미 최신 버전입니다.');
            return 0;
        }
        commitInstalled(root, r.to);
        reportStaged(r, log);
        log(`v${r.to} 설치 완료. 릴레이 서버를 다시 실행해 주세요. 플러그인(risustand.js)은 RisuAI에서 업데이트됩니다.`);
        return 0;
    }
    const info = await checkLatest({ currentVersion: current });
    if (info.available) log(`새 버전 v${info.latestVersion} 이(가) 있습니다: ${info.htmlUrl}\n  설치: node risustand-updater.cjs --apply`);
    else log('최신 버전입니다.');
    return 0;
}

function reportStaged(r, log) {
    for (const rel of r.stagedLaunchers || []) log(`런처가 변경되었습니다: ${rel}.new 를 확인 후 ${rel} 에 덮어써 주세요.`);
}

if (require.main === module) {
    main(process.argv.slice(2)).then(
        (code) => process.exit(code),
        (err) => {
            console.error(`[RisuStand Updater] 실패: ${err && err.message ? err.message : err}${err && err.code ? ` (${err.code})` : ''}`);
            process.exit(1);
        }
    );
}

module.exports = {
    REPOSITORY, MANIFEST_SCHEMA, UPDATER_CONTRACT,
    PROGRAM_FILES, LAUNCHER_FILES, PAYLOAD_FILES, META_FILES, EXECUTABLE_FILES,
    UpdateError, expectedAssetName, parseAssetVersion, compareVersions, normalizeDigest, sha256, crc32,
    readZip, parseSums, checkLatest, downloadAsset, verifyReleaseArchive,
    readInstalledVersion, readJournal, installRelease, rollback, recoverIfNeeded, commitInstalled, updateToLatest,
};
