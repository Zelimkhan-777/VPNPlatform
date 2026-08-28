import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { applicationImages } from './container-image-manifest.mjs';

const dockerfileUrl = new URL('../Dockerfile', import.meta.url);
const dockerignoreUrl = new URL('../.dockerignore', import.meta.url);

test('application image manifest covers the fixed control-plane topology', () => {
  assert.deepEqual(applicationImages, [
    { name: 'api', reference: 'vpn-platform/api:ci' },
    { name: 'worker', reference: 'vpn-platform/worker:ci' },
    { name: 'bot', reference: 'vpn-platform/bot:ci' },
    { name: 'web', reference: 'vpn-platform/web:ci' },
  ]);
});

test('Dockerfile pins its base and exposes every declared non-root target', async () => {
  const dockerfile = await readFile(dockerfileUrl, 'utf8');

  assert.match(dockerfile, /^ARG NODE_IMAGE=node@sha256:[a-f0-9]{64}$/m);
  for (const image of applicationImages) {
    assert.match(dockerfile, new RegExp(`^FROM \\S+ AS ${image.name}$`, 'm'));
  }
  assert.equal(
    dockerfile.match(/^USER node$/gm)?.length,
    applicationImages.length,
  );
});

test('Docker build context excludes secrets and local runtime state', async () => {
  const patterns = (await readFile(dockerignoreUrl, 'utf8')).split(/\r?\n/);

  for (const requiredPattern of ['.env', '.env.*', '.git', 'var']) {
    assert.ok(
      patterns.includes(requiredPattern),
      `${requiredPattern} must be ignored`,
    );
  }
});
