import assert from 'node:assert/strict';

const repositoryPrefixPattern =
  /^(?:[a-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const tagPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const digestPattern = /digest:\s*(sha256:[a-f0-9]{64})\b/i;

export function requireRepositoryPrefix(value) {
  assert.equal(
    typeof value,
    'string',
    'Container repository prefix is required.',
  );
  const normalized = value.trim().replace(/\/+$/, '').toLowerCase();
  assert.match(
    normalized,
    repositoryPrefixPattern,
    'Container repository prefix is invalid.',
  );
  return normalized;
}

export function requireContainerTag(value) {
  assert.equal(typeof value, 'string', 'Container tag is required.');
  const normalized = value.trim();
  assert.match(normalized, tagPattern, 'Container tag is invalid.');
  return normalized;
}

export function parsePushedDigest(output) {
  const match = output.match(digestPattern);
  assert.ok(match, 'Docker push output did not contain a manifest digest.');
  return match[1].toLowerCase();
}

export function immutableImageReference(repository, digest) {
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  return `${repository}@${digest}`;
}
