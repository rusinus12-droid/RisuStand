'use strict';
// Release transaction state, ported from Librarian-System's Manual Release.
//  prepare : no release commit at HEAD -> bump to next patch (or the requested higher version)
//  current : requested == VERSION      -> publish HEAD as-is (no version commit)
//  resume  : HEAD is "chore(release): vX.Y.Z" -> finish that exact release (tag/assets)

const { compareVersions, nextPatchVersion, SEMVER } = require('./release_version.cjs');

const RELEASE_SUBJECT = /^chore\(release\): v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseReleaseCommitSubject(subject) {
  const m = String(subject || '').trim().match(RELEASE_SUBJECT);
  return m ? `v${m.slice(1).join('.')}` : null;
}

function determineReleaseState({ headSubject, currentVersion, parentVersion }) {
  const releaseTag = parseReleaseCommitSubject(headSubject);
  if (!releaseTag) return { phase: 'prepare', previousVersion: String(currentVersion).trim(), targetVersion: null, releaseTag: null };
  const targetVersion = releaseTag.slice(1);
  if (String(currentVersion).trim() !== targetVersion) throw new Error(`release_commit_version_mismatch:${targetVersion}:${currentVersion}`);
  if (parentVersion != null && String(parentVersion).trim() === targetVersion) throw new Error(`release_commit_parent_version_not_advanced:${targetVersion}`);
  return { phase: 'resume', previousVersion: parentVersion == null ? null : String(parentVersion).trim(), targetVersion, releaseTag };
}

function resolveReleaseTarget({ state, currentVersion, requestedVersion = '' }) {
  const current = String(currentVersion || '').trim();
  const requested = String(requestedVersion || '').trim().replace(/^v/i, '');
  if (requested && !SEMVER.test(requested)) throw new Error(`release_requested_version_invalid:${requested}`);
  if (state?.phase === 'resume') {
    if (requested && requested !== state.targetVersion) throw new Error(`release_requested_version_conflicts_with_release_commit:${requested}:${state.targetVersion}`);
    return state;
  }
  if (!requested) return { ...state, phase: 'prepare', previousVersion: current, targetVersion: nextPatchVersion(current) };
  const order = compareVersions(requested, current);
  if (order < 0) throw new Error(`release_requested_version_below_current:${requested}:${current}`);
  if (order === 0) return { ...state, phase: 'current', previousVersion: current, targetVersion: current };
  return { ...state, phase: 'prepare', previousVersion: current, targetVersion: requested };
}

function verifyReleaseShaFence({ expectedSha, currentMainSha, stage = 'fence' }) {
  const expected = String(expectedSha || '').trim();
  const current = String(currentMainSha || '').trim();
  if (!expected || !current) throw new Error(`release_sha_fence_missing:${stage}`);
  if (expected !== current) {
    const err = new Error(`main changed during release (${stage}).\nvalidated: ${expected}\ncurrent main: ${current}\nRe-run Manual Release against the current main commit.`);
    err.code = 'RELEASE_SHA_FENCE_MISMATCH';
    throw err;
  }
  return { ok: true, sha: expected, stage };
}

module.exports = { RELEASE_SUBJECT, parseReleaseCommitSubject, determineReleaseState, resolveReleaseTarget, verifyReleaseShaFence };
