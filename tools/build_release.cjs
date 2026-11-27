#!/usr/bin/env node
'use strict';
/**
 * RisuStand release builder.
 *
 *   node tools/build_release.cjs --check [--output-dir dist]       build the current VERSION, no source changes
 *   node tools/build_release.cjs --version 1.0.1 [--output-dir dist] bump every version location, then build
 *
 * Output (refuses to overwrite):
 *   <out>/RisuStand-<v>.zip              installer + updater payload (RisuStand-<v>/...)
 *   <out>/RisuStand-<v>.build-report.json
 *
 * The ZIP is reproducible: sorted entries, fixed timestamps (RISUSTAND_RELEASE_GENERATED_AT
 * or 1980-01-01), deterministic deflate. Re-running a release for the same commit yields
 * byte-identical assets, which Manual Release relies on when resuming.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { readCurrentVersion, verifyVersionConsistency, applyReleaseVersion, parseVersion } = require('./release_version.cjs');
const updater = require('../risustand-updater.cjs');

const UPDATE_URL = 'https://raw.githubusercontent.com/rusinus12-droid/RisuStand/refs/heads/main/risustand.js';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function dosDateTime(date) {
    const d = new Date(date);
    const y = Math.max(1980, d.getUTCFullYear());
    return {
        time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
        date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    };
}

/** entries: [{ name, data: Buffer, mode? }] -> Buffer (ZIP32, UTF-8 names, deflate) */
function writeZip(entries, { mtime = '1980-01-01T00:00:00Z' } = {}) {
    const { time, date } = dosDateTime(mtime);
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const name = Buffer.from(e.name, 'utf8');
        const crc = updater.crc32(e.data);
        const deflated = zlib.deflateRawSync(e.data, { level: 9 });
        const useDeflate = deflated.length < e.data.length;
        const body = useDeflate ? deflated : e.data;
        const method = useDeflate ? 8 : 0;
        const mode = e.mode || 0o644;

        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(0x0800, 6);
        lh.writeUInt16LE(method, 8);
        lh.writeUInt16LE(time, 10);
        lh.writeUInt16LE(date, 12);
        lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(body.length, 18);
        lh.writeUInt32LE(e.data.length, 22);
        lh.writeUInt16LE(name.length, 26);
        lh.writeUInt16LE(0, 28);
        locals.push(lh, name, body);

        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0);
        ch.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, so modes survive
        ch.writeUInt16LE(20, 6);
        ch.writeUInt16LE(0x0800, 8);
        ch.writeUInt16LE(method, 10);
        ch.writeUInt16LE(time, 12);
        ch.writeUInt16LE(date, 14);
        ch.writeUInt32LE(crc, 16);
        ch.writeUInt32LE(body.length, 20);
        ch.writeUInt32LE(e.data.length, 24);
        ch.writeUInt16LE(name.length, 28);
        ch.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
        ch.writeUInt32LE(offset, 42);
        centrals.push(ch, name);
        offset += lh.length + name.length + body.length;
    }
    const cd = Buffer.concat(centrals);
    const count = entries.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(count, 8);
    eocd.writeUInt16LE(count, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}

function checkPluginHeader(source) {
    const lines = source.match(/^\/\/@update-url\b[^\r\n]*$/gm) || [];
    if (lines.length !== 1 || lines[0] !== `//@update-url ${UPDATE_URL}`) throw new Error('plugin_update_url_invalid');
    if (!source.startsWith('//@name risustand\n')) throw new Error('plugin_header_must_start_file');
    const versionAt = source.indexOf('//@version');
    const line = source.slice(versionAt).split('\n')[0];
    if (Buffer.byteLength(source.slice(0, versionAt) + line) > 500) throw new Error('plugin_version_beyond_512_bytes');
}

// Defense in depth: the payload is an explicit allowlist, but never let a secret ride along.
const SECRET_NAME = /^\.risustand-|(^|\/)\.env(\.|$)|\.(pem|key)$/i;
function assertNoSecrets(root, payload) {
    for (const p of payload) if (SECRET_NAME.test(p.rel)) throw new Error(`secret_file_in_payload:${p.rel}`);
    const localSecrets = [];
    try {
        const t = fs.readFileSync(path.join(root, '.risustand-token'), 'utf8').trim();
        if (t.length >= 8) localSecrets.push(t);
    } catch (_) {}
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(root, '.risustand-config.json'), 'utf8'));
        const keys = [
            ...(cfg.profiles || []).map((p) => p && p.apiKey),
            cfg.translator && cfg.translator.apiKey,
            cfg.imageGen && cfg.imageGen.apiKey,
            cfg.tts && cfg.tts.apiKey,
        ];
        for (const k of keys) if (typeof k === 'string' && k.trim().length >= 8) localSecrets.push(k.trim());
    } catch (_) {}
    for (const p of payload) {
        const text = p.data.toString('utf8');
        for (const s of localSecrets) if (text.includes(s)) throw new Error(`secret_value_in_payload:${p.rel}`);
    }
}

function syntaxCheck(file) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`syntax_error:${path.relative(ROOT, file)}\n${r.stderr}`);
}

function parseArgs(argv) {
    const out = { check: false, version: null, outputDir: path.join(ROOT, 'dist') };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--check') out.check = true;
        else if (a === '--version') out.version = parseVersion(argv[++i]).text;
        else if (a === '--output-dir') out.outputDir = path.resolve(argv[++i]);
        else throw new Error(`unknown_argument:${a}`);
    }
    if (out.check === Boolean(out.version)) throw new Error('use exactly one of --check or --version <x.y.z>');
    return out;
}

function build({ check, version, outputDir, root = ROOT, generatedAt = process.env.RISUSTAND_RELEASE_GENERATED_AT || '1980-01-01T00:00:00Z', buildId = process.env.RISUSTAND_RELEASE_BUILD_ID || 'local' }) {
    let bump = null;
    if (version) bump = applyReleaseVersion(root, version);
    const v = verifyVersionConsistency(root, readCurrentVersion(root));

    const plugin = fs.readFileSync(path.join(root, 'risustand.js'), 'utf8');
    checkPluginHeader(plugin);
    for (const rel of updater.PAYLOAD_FILES) if (/\.(c?js)$/.test(rel)) syntaxCheck(path.join(root, rel));

    const policy = JSON.parse(fs.readFileSync(path.join(root, 'release-policy.json'), 'utf8'));
    const prefix = `RisuStand-${v}/`;
    const payload = [];
    for (const rel of updater.PAYLOAD_FILES) {
        const file = path.join(root, rel);
        if (!fs.existsSync(file)) throw new Error(`payload_missing:${rel}`);
        payload.push({ rel, data: fs.readFileSync(file), mode: updater.EXECUTABLE_FILES.has(rel) ? 0o755 : 0o644 });
    }
    assertNoSecrets(root, payload);
    const manifest = {
        schema: updater.MANIFEST_SCHEMA,
        repository: updater.REPOSITORY.slug,
        version: v,
        tag: `v${v}`,
        channel: policy.channel || 'stable',
        assetName: updater.expectedAssetName(v),
        updatePolicy: policy.updatePolicy,
        minimumSourceVersion: policy.minimumSourceVersion,
        updaterContract: updater.UPDATER_CONTRACT,
        components: { relay: v, plugin: v, updater: v },
        files: Object.fromEntries(payload.map((p) => [p.rel, sha256(p.data)])),
    };
    const manifestBuf = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const sumsBuf = Buffer.from(
        [...payload.map((p) => [p.rel, p.data]), ['update-manifest.json', manifestBuf]]
            .sort((a, b) => (a[0] < b[0] ? -1 : 1))
            .map(([rel, data]) => `${sha256(data)}  ${rel}`)
            .join('\n') + '\n'
    );
    const zip = writeZip(
        [
            ...payload.map((p) => ({ name: prefix + p.rel, data: p.data, mode: p.mode })),
            { name: prefix + 'update-manifest.json', data: manifestBuf },
            { name: prefix + 'SHA256SUMS.txt', data: sumsBuf },
        ],
        { mtime: generatedAt }
    );

    // Self-test: the shipped updater must accept what we built.
    updater.verifyReleaseArchive(zip, { expectedVersion: v });

    fs.mkdirSync(outputDir, { recursive: true });
    const zipPath = path.join(outputDir, updater.expectedAssetName(v));
    const reportPath = path.join(outputDir, `RisuStand-${v}.build-report.json`);
    for (const f of [zipPath, reportPath]) if (fs.existsSync(f)) throw new Error(`refusing_to_overwrite:${f}`);
    fs.writeFileSync(zipPath, zip, { flag: 'wx' });
    const report = {
        schema: 'risustand.build-report.v1',
        packageVersion: v,
        releaseTag: `v${v}`,
        assetName: path.basename(zipPath),
        archiveSha256: sha256(zip),
        archiveBytes: zip.length,
        buildId,
        generatedAt,
        mode: check ? 'check' : 'release',
        previousVersion: bump ? bump.previousVersion : null,
        changedFiles: bump ? bump.changedFiles : [],
        updatePolicy: policy.updatePolicy,
        updaterVerified: true,
        pluginUpdateUrl: UPDATE_URL,
        files: manifest.files,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    return { zipPath, reportPath, report };
}

if (require.main === module) {
    try {
        const r = build(parseArgs(process.argv.slice(2)));
        console.log(`Built ${r.report.assetName} (${r.report.archiveBytes} bytes, sha256 ${r.report.archiveSha256})`);
        console.log(`Report: ${r.reportPath}`);
    } catch (e) {
        console.error(`build_release failed: ${e.message}`);
        process.exit(1);
    }
}

module.exports = { build, writeZip, checkPluginHeader, UPDATE_URL };
