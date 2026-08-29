import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireHttpOrigin } from '../apps/web/api-proxy-target.mjs';
import {
  applicationImageBuildIdLabel,
  applicationImageBuildReceiptUrl,
  applicationImageRevisionLabel,
  applicationImageSourceFingerprintLabel,
  applicationImageSourceHeadLabel,
  applicationImageSourceStateLabel,
  applicationImages,
} from './container-image-manifest.mjs';
import {
  ociRevisionForProvenance,
  requireCleanCiProvenance,
  resolveGitSourceProvenance,
} from './git-source-provenance.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const dockerExecutable = process.platform === 'win32' ? 'docker.exe' : 'docker';
const buildReceiptPath = fileURLToPath(applicationImageBuildReceiptUrl);
const buildId = randomUUID();
const webApiProxyTarget = requireHttpOrigin(process.env.WEB_API_PROXY_TARGET);
const source = resolveGitSourceProvenance(repositoryRoot);
requireCleanCiProvenance(source);
const ociRevision = ociRevisionForProvenance(source);
const sourceLabels = [
  '--label',
  `${applicationImageSourceStateLabel}=${source.state}`,
  '--label',
  `${applicationImageSourceHeadLabel}=${source.headRevision}`,
  '--label',
  `${applicationImageSourceFingerprintLabel}=${source.fingerprint}`,
  '--label',
  `${applicationImageRevisionLabel}=${ociRevision}`,
];

rmSync(buildReceiptPath, { force: true });

for (const image of applicationImages) {
  const targetArguments =
    image.name === 'web'
      ? ['--build-arg', `WEB_API_PROXY_TARGET=${webApiProxyTarget}`]
      : [];
  const result = spawnSync(
    dockerExecutable,
    [
      'buildx',
      'build',
      '--load',
      '--progress=plain',
      '--target',
      image.name,
      '--label',
      `${applicationImageBuildIdLabel}=${buildId}`,
      ...sourceLabels,
      ...targetArguments,
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

mkdirSync(dirname(buildReceiptPath), { recursive: true });
writeFileSync(
  buildReceiptPath,
  `${JSON.stringify(
    {
      buildId,
      source,
      ociRevision,
      webApiProxyTarget,
      images: applicationImages,
    },
    null,
    2,
  )}\n`,
  { encoding: 'utf8', mode: 0o600 },
);

process.stdout.write(
  `CONTAINER_IMAGES_BUILT images=${applicationImages.length} source=${source.state} fingerprint=${source.fingerprint}\n`,
);
