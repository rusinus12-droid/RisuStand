'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { REPO, makeInstall, tmpDir } = require('./helpers.cjs');
const rv = require('../tools/release_version.cjs');
const rt = require('../tools/release_transaction.cjs');
const { build, UPDATE_URL } = require('../tools/build_release.cjs');
const updater = require('../risustand-updater.cjs');

test('repo version is consistent across every declared location', () => {
    rv.verifyVersionConsistency(REPO);
});

test('plugin header: exact update URL, version within the first 512 bytes, constant in sync', () => {
    const src = fs.readFileSync(path.join(REPO, 'risustand.js'), 'utf8');
    assert.deepEqual(src.match(/^\/\/@update-url\b[^\r\n]*$/gm), [`//@update-url ${UPDATE_URL}`]);
    const at = src.indexOf('//@version');
    assert.ok(Buffer.byteLength(src.slice(0, at)) < 400);
    const version = src.match(/^\/\/@version (\S+)$/m)[1];
    assert.equal(src.match(/const RISUSTAND_VERSION = '([^']+)';/)[1], version);
});

test('applyReleaseVersion bumps every location and refuses non-increasing versions', () => {
    const dir = makeInstall();
    const cur = rv.readCurrentVersion(dir);
    const next = rv.nextPatchVersion(cur);
    const r = rv.applyReleaseVersion(dir, next);
    assert.equal(r.version, next);
    assert.deepEqual(r.changedFiles, [...rv.VERSION_TRANSACTION_FILES].sort());
    rv.verifyVersionConsistency(dir, next);
    assert.throws(() => rv.applyReleaseVersion(dir, next), /version_must_increase/);
    assert.throws(() => rv.applyReleaseVersion(dir, cur), /version_must_increase/);
});

test('version drift is detected', () => {
    const dir = makeInstall();
    const f = path.join(dir, 'risustand-relay-server.js');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/const RELAY_VERSION = '[^']+';/, "const RELAY_VERSION = '0.0.1';"));
    assert.throws(() => rv.verifyVersionConsistency(dir), /RELAY_VERSION/);
});

test('release transaction: prepare / current / resume', () => {
    const base = rt.determineReleaseState({ headSubject: 'feat: x', currentVersion: '1.2.3', parentVersion: null });
    assert.equal(base.phase, 'prepare');
    assert.equal(rt.resolveReleaseTarget({ state: base, currentVersion: '1.2.3' }).targetVersion, '1.2.4');
    assert.equal(rt.resolveReleaseTarget({ state: base, currentVersion: '1.2.3', requestedVersion: '1.2.3' }).phase, 'current');
    assert.equal(rt.resolveReleaseTarget({ state: base, currentVersion: '1.2.3', requestedVersion: 'v2.0.0' }).targetVersion, '2.0.0');
    assert.throws(() => rt.resolveReleaseTarget({ state: base, currentVersion: '1.2.3', requestedVersion: '1.2.2' }), /below_current/);
    assert.throws(() => rt.resolveReleaseTarget({ state: base, currentVersion: '1.2.3', requestedVersion: '1.2' }), /invalid/);

    const resume = rt.determineReleaseState({ headSubject: 'chore(release): v1.2.4', currentVersion: '1.2.4', parentVersion: '1.2.3' });
    assert.equal(resume.phase, 'resume');
    assert.equal(rt.resolveReleaseTarget({ state: resume, currentVersion: '1.2.4' }).targetVersion, '1.2.4');
    assert.throws(() => rt.resolveReleaseTarget({ state: resume, currentVersion: '1.2.4', requestedVersion: '1.3.0' }), /conflicts/);
    assert.throws(() => rt.determineReleaseState({ headSubject: 'chore(release): v1.2.4', currentVersion: '1.2.3' }), /mismatch/);
    assert.throws(() => rt.verifyReleaseShaFence({ expectedSha: 'a', currentMainSha: 'b' }), /main changed/);
});

test('builder output is reproducible and accepted by the shipped updater', () => {
    const src = makeInstall();
    const a = build({ check: true, outputDir: tmpDir(), root: src, generatedAt: '2026-11-26T00:00:00Z' });
    const b = build({ check: true, outputDir: tmpDir(), root: src, generatedAt: '2026-11-26T00:00:00Z' });
    assert.equal(a.report.archiveSha256, b.report.archiveSha256);
    const zip = fs.readFileSync(a.zipPath);
    const v = rv.readCurrentVersion(src);
    const verified = updater.verifyReleaseArchive(zip, { expectedVersion: v });
    assert.equal(verified.manifest.repository, 'rusinus12-droid/RisuStand');
    assert.equal(verified.modes.get('start-risustand-remote.sh'), 0o755);
    assert.throws(() => build({ check: true, outputDir: path.dirname(a.zipPath), root: src }), /refusing_to_overwrite/);
});

test('secrets never ship: git ignores them and the builder refuses leaked values', () => {
    const { execFileSync } = require('node:child_process');
    let ignored = null;
    try {
        ignored = execFileSync('git', ['check-ignore', '.risustand-token', '.risustand-config.json', '.update/journal.json', 'dist/x.zip'], { cwd: REPO, encoding: 'utf8' });
    } catch (_) {}
    if (ignored !== null) assert.equal(ignored.trim().split(/\r?\n/).length, 4);

    const src = makeInstall();
    const token = 'tok_' + 'abcdef0123456789';
    fs.writeFileSync(path.join(src, '.risustand-token'), token);
    const zip = fs.readFileSync(build({ check: true, outputDir: tmpDir(), root: src }).zipPath);
    assert.ok(!zip.includes(Buffer.from(token)), 'token file is not packaged');
    assert.ok(!updater.readZip(zip).some((e) => /\.risustand-/.test(e.name)));

    fs.appendFileSync(path.join(src, 'README.md'), `\n${token}\n`);
    assert.throws(() => build({ check: true, outputDir: tmpDir(), root: src }), /secret_value_in_payload:README\.md/);
});

test('prebuilt CI release (if provided) passes updater verification', { skip: !process.env.RISUSTAND_PREBUILT_RELEASE_DIR }, () => {
    const dir = process.env.RISUSTAND_PREBUILT_RELEASE_DIR;
    const zipName = fs.readdirSync(dir).find((n) => updater.parseAssetVersion(n));
    const v = updater.parseAssetVersion(zipName);
    assert.equal(v, rv.readCurrentVersion(REPO));
    updater.verifyReleaseArchive(fs.readFileSync(path.join(dir, zipName)), { expectedVersion: v });
});
