'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeInstall, tmpDir, fakeGitHub } = require('./helpers.cjs');
const rv = require('../tools/release_version.cjs');
const { build, writeZip } = require('../tools/build_release.cjs');
const updater = require('../risustand-updater.cjs');

// One "newer" release built from a temp copy, shared by the tests below.
function buildNext({ mutate } = {}) {
    const src = makeInstall('rs-src-');
    if (mutate) mutate(src);
    const next = rv.nextPatchVersion(rv.readCurrentVersion(src));
    const r = build({ version: next, outputDir: tmpDir(), root: src, generatedAt: '2026-11-26T00:00:00Z' });
    return { version: next, zip: fs.readFileSync(r.zipPath), src };
}

function installWithSecrets() {
    const dir = makeInstall('rs-inst-');
    fs.writeFileSync(path.join(dir, '.risustand-token'), 'secret-token\n');
    fs.writeFileSync(path.join(dir, '.risustand-config.json'), '{"keep":true}');
    return dir;
}

test('tampering is rejected: CRC, checksum list, manifest repository, traversal', () => {
    const { version, zip } = buildNext();
    const flipped = Buffer.from(zip);
    flipped[200] ^= 0xff;
    assert.throws(() => updater.verifyReleaseArchive(flipped, { expectedVersion: version }), /zip_|CRC|crc|invalid|손상|ZIP/);

    const entries = updater.readZip(zip).map((e) => ({ name: e.name, data: e.data, mode: e.mode }));
    const prefix = `RisuStand-${version}/`;
    const swap = (rel, fn) => entries.map((e) => (e.name === prefix + rel ? { ...e, data: fn(e.data) } : e));

    const badRelay = writeZip(swap('risustand-relay-server.js', (d) => Buffer.concat([d, Buffer.from('\n// evil\n')])));
    assert.throws(() => updater.verifyReleaseArchive(badRelay, { expectedVersion: version }), (e) => e.code === 'checksum_mismatch');

    const badManifest = writeZip(swap('update-manifest.json', (d) => Buffer.from(d.toString().replace('rusinus12-droid/RisuStand', 'evil/RisuStand'))));
    assert.throws(() => updater.verifyReleaseArchive(badManifest, { expectedVersion: version }), (e) => ['manifest_mismatch', 'checksum_mismatch'].includes(e.code));

    const traversal = writeZip([...entries, { name: `${prefix}../evil.js`, data: Buffer.from('x') }]);
    assert.throws(() => updater.verifyReleaseArchive(traversal, { expectedVersion: version }), (e) => e.code === 'zip_entry_path_unsafe');

    const extra = writeZip([...entries, { name: `${prefix}payload.exe`, data: Buffer.from('x') }]);
    assert.throws(() => updater.verifyReleaseArchive(extra, { expectedVersion: version }), (e) => e.code === 'release_unexpected_file');

    assert.throws(() => updater.verifyReleaseArchive(zip, { expectedVersion: '9.9.9' }), (e) => e.code === 'release_layout_invalid');
});

test('syntax errors in a payload are rejected before install', () => {
    const { version, zip } = buildNext();
    const entries = updater.readZip(zip);
    const prefix = `RisuStand-${version}/`;
    const crypto = require('node:crypto');
    const broken = Buffer.from('function (\n');
    const files = new Map(entries.map((e) => [e.name.slice(prefix.length), e.data]));
    files.set('risustand-updater.cjs', broken);
    const manifest = JSON.parse(files.get('update-manifest.json'));
    manifest.files['risustand-updater.cjs'] = crypto.createHash('sha256').update(broken).digest('hex');
    files.set('update-manifest.json', Buffer.from(JSON.stringify(manifest)));
    files.set('SHA256SUMS.txt', Buffer.from([...files].filter(([r]) => r !== 'SHA256SUMS.txt').map(([r, d]) => `${crypto.createHash('sha256').update(d).digest('hex')}  ${r}`).join('\n')));
    const rebuilt = writeZip([...files].map(([r, d]) => ({ name: prefix + r, data: d })));
    assert.throws(() => updater.verifyReleaseArchive(rebuilt, { expectedVersion: version }), (e) => e.code === 'payload_syntax_error');
});

test('install replaces program files, keeps secrets, stages changed launchers, then commits', () => {
    const { version, zip } = buildNext({
        mutate: (src) => fs.appendFileSync(path.join(src, 'start-risustand-remote.bat'), 'REM changed\r\n'),
    });
    const dir = installWithSecrets();
    const before = updater.readInstalledVersion(dir);
    const verified = updater.verifyReleaseArchive(zip, { expectedVersion: version });
    const r = updater.installRelease(dir, verified);

    assert.equal(r.from, before);
    assert.equal(r.to, version);
    assert.equal(updater.readInstalledVersion(dir), version);
    assert.match(fs.readFileSync(path.join(dir, 'risustand-relay-server.js'), 'utf8'), new RegExp(`RELAY_VERSION = '${version.replace(/\./g, '\\.')}'`));
    assert.equal(fs.readFileSync(path.join(dir, '.risustand-token'), 'utf8'), 'secret-token\n');
    assert.equal(fs.readFileSync(path.join(dir, '.risustand-config.json'), 'utf8'), '{"keep":true}');
    assert.deepEqual(r.stagedLaunchers, ['start-risustand-remote.bat']);
    assert.ok(fs.existsSync(path.join(dir, 'start-risustand-remote.bat.new')));
    assert.ok(!fs.readFileSync(path.join(dir, 'start-risustand-remote.bat'), 'utf8').includes('REM changed'));
    assert.equal(updater.readJournal(dir).state, 'installed');

    assert.equal(updater.commitInstalled(dir, '0.0.0'), false);
    assert.equal(updater.commitInstalled(dir, version), true);
    assert.equal(updater.readJournal(dir).state, 'committed');
    assert.throws(() => updater.installRelease(dir, verified), (e) => e.code === 'not_newer');
});

test('rollback restores the previous version; an interrupted install is recovered at start', () => {
    const { version, zip } = buildNext();
    const dir = installWithSecrets();
    const before = updater.readInstalledVersion(dir);
    const relayBefore = fs.readFileSync(path.join(dir, 'risustand-relay-server.js'));
    updater.installRelease(dir, updater.verifyReleaseArchive(zip, { expectedVersion: version }));
    assert.equal(updater.rollback(dir).rolledBack, true);
    assert.equal(updater.readInstalledVersion(dir), before);
    assert.ok(fs.readFileSync(path.join(dir, 'risustand-relay-server.js')).equals(relayBefore));
    assert.equal(updater.rollback(dir).rolledBack, false);

    // Simulate a crash mid-copy.
    updater.installRelease(dir, updater.verifyReleaseArchive(zip, { expectedVersion: version }));
    const j = updater.readJournal(dir);
    fs.writeFileSync(path.join(dir, '.update', 'journal.json'), JSON.stringify({ ...j, state: 'installing' }));
    assert.equal(updater.recoverIfNeeded(dir).rolledBack, true);
    assert.equal(updater.readInstalledVersion(dir), before);
});

test('policy gates: manual_required and minimumSourceVersion block auto-install', () => {
    const manual = buildNext({
        mutate: (src) => {
            const p = path.join(src, 'release-policy.json');
            fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, 'utf8')), updatePolicy: 'manual_required' }, null, 2) + '\n');
        },
    });
    const dir = installWithSecrets();
    assert.throws(() => updater.installRelease(dir, updater.verifyReleaseArchive(manual.zip, { expectedVersion: manual.version })), (e) => e.code === 'manual_update_required');

    const tooNew = buildNext({
        mutate: (src) => {
            const p = path.join(src, 'release-policy.json');
            fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, 'utf8')), minimumSourceVersion: '99.0.0' }, null, 2) + '\n');
        },
    });
    assert.throws(() => updater.installRelease(dir, updater.verifyReleaseArchive(tooNew.zip, { expectedVersion: tooNew.version })), (e) => e.code === 'source_version_too_old');
    assert.equal(updater.readJournal(dir), null, 'nothing was touched');
});

test('updateToLatest against a fake GitHub: digest required and enforced, then installs', async () => {
    const { version, zip } = buildNext();

    const noDigest = fakeGitHub({ version, zip, digest: null });
    const dir1 = installWithSecrets();
    await assert.rejects(updater.updateToLatest({ root: dir1, fetchImpl: noDigest.fetchImpl }), (e) => e.code === 'release_asset_digest_missing');

    const wrong = fakeGitHub({ version, zip, digest: 'a'.repeat(64) });
    await assert.rejects(updater.updateToLatest({ root: dir1, fetchImpl: wrong.fetchImpl }), (e) => e.code === 'release_sha256_mismatch');
    assert.equal(updater.readJournal(dir1), null);

    const draft = fakeGitHub({ version, zip, draft: true });
    assert.equal((await updater.updateToLatest({ root: dir1, fetchImpl: draft.fetchImpl })).updated, false);

    const good = fakeGitHub({ version, zip });
    const phases = [];
    const r = await updater.updateToLatest({ root: dir1, fetchImpl: good.fetchImpl, onPhase: (p) => phases.push(p) });
    assert.equal(r.updated, true);
    assert.deepEqual(phases, ['checking', 'downloading', 'verifying', 'installing']);
    assert.equal(updater.readInstalledVersion(dir1), version);
    assert.ok(good.calls[0].endsWith('/repos/rusinus12-droid/RisuStand/releases/latest'));

    const again = await updater.updateToLatest({ root: dir1, fetchImpl: good.fetchImpl });
    assert.equal(again.updated, false);
});
