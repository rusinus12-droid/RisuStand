'use strict';
// Version source of truth: VERSION. A release bumps every declared location with
// exact-count replacements so a drifted file fails loudly instead of shipping stale.

const fs = require('node:fs');
const path = require('node:path');

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseVersion(value, code = 'version_invalid') {
  const text = String(value || '').trim().replace(/^v/i, '');
  const match = text.match(SEMVER);
  if (!match) throw new Error(`${code}:${value}`);
  return { text, parts: match.slice(1).map(Number) };
}

function compareVersions(left, right) {
  const a = parseVersion(left).parts;
  const b = parseVersion(right).parts;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

function nextPatchVersion(current) {
  const p = parseVersion(current).parts;
  return `${p[0]}.${p[1]}.${p[2] + 1}`;
}

const esc = (v) => v.replace(/\./g, '\\.');

// Every place that carries the package version, relative to the repo root.
// `pattern(v)` must match exactly `count` times for version v.
const VERSION_LOCATIONS = [
  { file: 'risustand.js', pattern: (v) => new RegExp(`^//@version ${esc(v)}$`, 'gm'), render: (v) => `//@version ${v}`, count: 1 },
  { file: 'risustand.js', pattern: (v) => new RegExp(`^    const RISUSTAND_VERSION = '${esc(v)}';$`, 'gm'), render: (v) => `    const RISUSTAND_VERSION = '${v}';`, count: 1 },
  { file: 'risustand-relay-server.js', pattern: (v) => new RegExp(`^ \\* RisuStand Remote Relay Server v${esc(v)}$`, 'gm'), render: (v) => ` * RisuStand Remote Relay Server v${v}`, count: 1 },
  { file: 'risustand-relay-server.js', pattern: (v) => new RegExp(`^const RELAY_VERSION = '${esc(v)}';$`, 'gm'), render: (v) => `const RELAY_VERSION = '${v}';`, count: 1 },
  { file: 'README.md', pattern: (v) => new RegExp(`^# 📖 RisuStand v${esc(v)} \\(리수 독서대\\)$`, 'gm'), render: (v) => `# 📖 RisuStand v${v} (리수 독서대)`, count: 1 },
];

// Files a release commit may touch ("chore(release): vX.Y.Z").
const VERSION_TRANSACTION_FILES = Object.freeze(['VERSION', 'release-policy.json', 'risustand.js', 'risustand-relay-server.js', 'README.md']);

function readCurrentVersion(root) {
  return parseVersion(fs.readFileSync(path.join(root, 'VERSION'), 'utf8'), 'version_file_invalid').text;
}

// Throws unless every declared location carries `version` exactly as expected.
function verifyVersionConsistency(root, version = readCurrentVersion(root)) {
  const problems = [];
  for (const loc of VERSION_LOCATIONS) {
    const src = fs.readFileSync(path.join(root, loc.file), 'utf8');
    const n = [...src.matchAll(loc.pattern(version))].length;
    if (n !== loc.count) problems.push(`${loc.file}: expected ${loc.count} match(es) of ${loc.render(version)}, found ${n}`);
  }
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'release-policy.json'), 'utf8'));
  if (policy.version !== version) problems.push(`release-policy.json: version ${policy.version} != ${version}`);
  if (problems.length) throw new Error(`version_inconsistent:\n  ${problems.join('\n  ')}`);
  return version;
}

function applyReleaseVersion(root, targetVersion) {
  const current = verifyVersionConsistency(root);
  const target = parseVersion(targetVersion).text;
  if (compareVersions(target, current) <= 0) throw new Error(`version_must_increase:${current}->${target}`);
  const changed = new Set();
  const write = (rel, text) => { fs.writeFileSync(path.join(root, rel), text, 'utf8'); changed.add(rel); };

  write('VERSION', `${target}\n`);
  const byFile = new Map();
  for (const loc of VERSION_LOCATIONS) {
    const src = byFile.get(loc.file) ?? fs.readFileSync(path.join(root, loc.file), 'utf8');
    byFile.set(loc.file, src.replace(loc.pattern(current), loc.render(target)));
  }
  for (const [rel, text] of byFile) write(rel, text);
  const policyPath = path.join(root, 'release-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  policy.version = target;
  write('release-policy.json', `${JSON.stringify(policy, null, 2)}\n`);

  verifyVersionConsistency(root, target);
  return { previousVersion: current, version: target, changedFiles: [...changed].sort() };
}

module.exports = {
  SEMVER, parseVersion, compareVersions, nextPatchVersion,
  VERSION_LOCATIONS, VERSION_TRANSACTION_FILES,
  readCurrentVersion, verifyVersionConsistency, applyReleaseVersion,
};
