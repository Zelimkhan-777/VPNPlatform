import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function git(repositoryRoot, arguments_, encoding = 'utf8') {
  const result = spawnSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `git ${arguments_.join(' ')} failed: ${String(result.stderr)}`,
  );
  return result.stdout;
}

function nullSeparatedPaths(output) {
  return output
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'en'));
}

export function resolveGitSourceProvenance(repositoryRoot) {
  const headRevision = git(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  assert.match(headRevision, /^[a-f0-9]{40}$/);

  const trackedDiff = git(
    repositoryRoot,
    ['diff', '--binary', 'HEAD', '--', '.'],
    null,
  );
  const untrackedPaths = nullSeparatedPaths(
    git(
      repositoryRoot,
      ['ls-files', '--others', '--exclude-standard', '-z'],
      null,
    ),
  );

  if (trackedDiff.length === 0 && untrackedPaths.length === 0) {
    return {
      state: 'clean',
      headRevision,
      fingerprint: headRevision,
    };
  }

  const fingerprint = createHash('sha256');
  fingerprint.update('vpn-platform-dirty-source-v1\0');
  fingerprint.update(trackedDiff);
  for (const path of untrackedPaths) {
    fingerprint.update('\0untracked\0');
    fingerprint.update(path);
    fingerprint.update('\0');
    fingerprint.update(readFileSync(resolve(repositoryRoot, path)));
  }

  return {
    state: 'dirty',
    headRevision,
    fingerprint: fingerprint.digest('hex'),
  };
}

export function requireCleanCiProvenance(provenance, ci = process.env.CI) {
  if (ci === 'true' && provenance.state !== 'clean') {
    throw new Error(
      `CI image builds require a clean checkout at ${provenance.headRevision}; ` +
        `received dirty fingerprint ${provenance.fingerprint}`,
    );
  }
}

export function ociRevisionForProvenance(provenance) {
  return provenance.state === 'clean'
    ? provenance.headRevision
    : `${provenance.headRevision}-dirty-${provenance.fingerprint}`;
}
