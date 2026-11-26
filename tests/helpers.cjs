'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const updater = require('../risustand-updater.cjs');

/** Copies the shippable files into a fresh temp dir (never touches the repo). */
function makeInstall(prefix = 'rs-test-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    for (const rel of updater.PAYLOAD_FILES) fs.copyFileSync(path.join(REPO, rel), path.join(dir, rel));
    return dir;
}

function tmpDir(prefix = 'rs-out-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Fake fetch serving one GitHub "latest release" with the given zip. */
function fakeGitHub({ version, zip, digest, assetName = updater.expectedAssetName(version), draft = false }) {
    const calls = [];
    const crypto = require('node:crypto');
    const sha = digest === undefined ? crypto.createHash('sha256').update(zip).digest('hex') : digest;
    const fetchImpl = async (url) => {
        calls.push(url);
        if (url.endsWith('/releases/latest')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    tag_name: `v${version}`,
                    draft,
                    prerelease: false,
                    html_url: `https://github.com/rusinus12-droid/RisuStand/releases/tag/v${version}`,
                    body: 'notes',
                    assets: [{ name: assetName, browser_download_url: 'https://example.invalid/asset.zip', size: zip.length, digest: sha ? `sha256:${sha}` : null }],
                }),
            };
        }
        if (url === 'https://example.invalid/asset.zip') {
            return { ok: true, status: 200, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length) };
        }
        return { ok: false, status: 404 };
    };
    return { fetchImpl, calls };
}

module.exports = { REPO, makeInstall, tmpDir, fakeGitHub };
