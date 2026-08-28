import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { applicationImages } from './container-image-manifest.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const dockerExecutable = process.platform === 'win32' ? 'docker.exe' : 'docker';

for (const image of applicationImages) {
  const result = spawnSync(
    dockerExecutable,
    [
      'buildx',
      'build',
      '--load',
      '--progress=plain',
      '--target',
      image.name,
      '--tag',
      image.reference,
      '.',
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
    },
  );
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  assert.equal(result.status, 0, `Could not build ${image.name} image.`);
}

process.stdout.write(
  `CONTAINER_IMAGES_BUILT images=${applicationImages.length}\n`,
);
