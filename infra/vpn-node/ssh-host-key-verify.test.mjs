import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectPresentedSshFingerprints,
  compareSshFingerprints,
  fingerprintSshKeyLine,
  parseExpectedSshFingerprints,
} from './ssh-host-key-verify.mjs';

function sshKeygen(args) {
  const result = spawnSync('ssh-keygen', args, {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || 'ssh-keygen failed');
  }
  return result.stdout.trim();
}

function fingerprintFromPublicFile(path) {
  const output = sshKeygen(['-lf', path, '-E', 'sha256']);
  const match = output.match(/SHA256:[A-Za-z0-9+/]+/);
  assert.ok(match, 'ssh-keygen did not print a SHA256 fingerprint');
  return match[0];
}

test('parses provider-console fingerprints and rejects MD5 or extra types', () => {
  const parsed = parseExpectedSshFingerprints(
    JSON.stringify({
      source: 'provider-console',
      fingerprints: {
        'ssh-ed25519': 'SHA256:abcdefghijklmnopqrstuvwxABCDEFGHIJKLMNopqrs',
        'ssh-rsa': 'SHA256:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq',
      },
    }),
  );
  assert.equal(
    parsed['ssh-ed25519'],
    'SHA256:abcdefghijklmnopqrstuvwxABCDEFGHIJKLMNopqrs',
  );

  assert.throws(
    () =>
      parseExpectedSshFingerprints(
        JSON.stringify({
          source: 'ssh-keyscan',
          fingerprints: parsed,
        }),
      ),
    /provider-console/,
  );
  assert.throws(
    () =>
      parseExpectedSshFingerprints(
        JSON.stringify({
          source: 'provider-console',
          fingerprints: {
            'ssh-ed25519': 'MD5:aa:bb',
            'ssh-rsa': parsed['ssh-rsa'],
          },
        }),
      ),
    /SHA256/,
  );
});

test('matches presented host keys to provider-console fingerprints without accepting them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ssh-host-key-'));
  try {
    const ed25519Path = join(directory, 'ed25519');
    const rsaPath = join(directory, 'rsa');
    sshKeygen(['-q', '-t', 'ed25519', '-f', ed25519Path, '-N', '']);
    sshKeygen(['-q', '-t', 'rsa', '-b', '2048', '-f', rsaPath, '-N', '']);
    const ed25519Pub = (await readFile(`${ed25519Path}.pub`, 'utf8')).trim();
    const rsaPub = (await readFile(`${rsaPath}.pub`, 'utf8')).trim();
    const presented = collectPresentedSshFingerprints(
      [
        `# comment`,
        `203.0.113.30 ${ed25519Pub}`,
        `203.0.113.30 ${rsaPub}`,
      ].join('\n'),
    );
    const expected = {
      'ssh-ed25519': fingerprintFromPublicFile(`${ed25519Path}.pub`),
      'ssh-rsa': fingerprintFromPublicFile(`${rsaPath}.pub`),
    };

    assert.equal(
      fingerprintSshKeyLine(ed25519Pub).fingerprint,
      expected['ssh-ed25519'],
    );
    assert.deepEqual(compareSshFingerprints(expected, presented), {
      matched: ['ssh-ed25519', 'ssh-rsa'],
      accepted: false,
    });
    assert.throws(
      () =>
        compareSshFingerprints(
          {
            ...expected,
            'ssh-ed25519': 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          },
          presented,
        ),
      /does not match provider console/,
    );
    assert.throws(
      () =>
        compareSshFingerprints(expected, {
          'ssh-ed25519': expected['ssh-ed25519'],
        }),
      /ssh-rsa was not presented/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
