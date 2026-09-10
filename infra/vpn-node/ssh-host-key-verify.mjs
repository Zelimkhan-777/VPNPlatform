import { createHash } from 'node:crypto';

export const EXPECTED_SSH_FINGERPRINT_RELATIVE_PATH =
  'expected-ssh-fingerprints.json';

const FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]+$/;
const KEY_TYPES = ['ssh-ed25519', 'ssh-rsa'];

export function normalizeSshFingerprint(value) {
  const fingerprint = String(value ?? '').trim();
  if (!FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new Error('SSH fingerprint must be a SHA256 digest');
  }
  return fingerprint;
}

export function parseExpectedSshFingerprints(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.source !== 'provider-console') {
    throw new Error(
      'Expected SSH fingerprints must come from provider-console',
    );
  }
  const fingerprints = parsed.fingerprints ?? {};
  const expected = {};
  for (const keyType of KEY_TYPES) {
    if (fingerprints[keyType] === undefined) {
      throw new Error(`Expected ${keyType} fingerprint is missing`);
    }
    expected[keyType] = normalizeSshFingerprint(fingerprints[keyType]);
  }
  const extra = Object.keys(fingerprints).filter(
    (keyType) => !KEY_TYPES.includes(keyType),
  );
  if (extra.length > 0) {
    throw new Error('Expected SSH fingerprints contain unsupported key types');
  }
  return expected;
}

export function fingerprintSshKeyLine(line) {
  const parts = line.trim().split(/\s+/);
  const keyType = parts[0];
  const material = parts[1];
  if (!KEY_TYPES.includes(keyType) || !material) {
    return null;
  }
  const digest = createHash('sha256')
    .update(Buffer.from(material, 'base64'))
    .digest('base64')
    .replace(/=+$/, '');
  return {
    type: keyType,
    fingerprint: `SHA256:${digest}`,
  };
}

export function collectPresentedSshFingerprints(keyscanOutput) {
  const presented = {};
  for (const line of String(keyscanOutput).split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const hashed = line.replace(/^[^ ]+ /, '');
    const parsed = fingerprintSshKeyLine(hashed);
    if (!parsed) continue;
    if (
      presented[parsed.type] &&
      presented[parsed.type] !== parsed.fingerprint
    ) {
      throw new Error(`SSH ${parsed.type} fingerprint is inconsistent`);
    }
    presented[parsed.type] = parsed.fingerprint;
  }
  return presented;
}

export function compareSshFingerprints(expected, presented) {
  const matched = [];
  for (const keyType of KEY_TYPES) {
    const expectedFingerprint = expected[keyType];
    const presentedFingerprint = presented[keyType];
    if (!presentedFingerprint) {
      throw new Error(`SSH ${keyType} was not presented by the host`);
    }
    if (presentedFingerprint !== expectedFingerprint) {
      throw new Error(
        `SSH ${keyType} fingerprint does not match provider console`,
      );
    }
    matched.push(keyType);
  }
  return { matched, accepted: false };
}
