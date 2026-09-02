import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applicationImageBuildReceiptUrl,
  applicationImages,
} from './container-image-manifest.mjs';
import {
  immutableImageReference,
  parsePushedDigest,
  requireContainerTag,
  requireRepositoryPrefix,
} from './container-image-release.mjs';
import { resolveGitSourceProvenance } from './git-source-provenance.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const dockerExecutable = process.platform === 'win32' ? 'docker.exe' : 'docker';
const repositoryPrefix = requireRepositoryPrefix(
  process.env.CONTAINER_REPOSITORY_PREFIX,
);
const releaseTag = requireContainerTag(process.env.CONTAINER_RELEASE_TAG);
const receipt = JSON.parse(
  readFileSync(applicationImageBuildReceiptUrl, 'utf8'),
);
const currentSource = resolveGitSourceProvenance(repositoryRoot);
const manifestPath = fileURLToPath(
  new URL('../var/container-images/release-manifest.json', import.meta.url),
);
const environmentPath = fileURLToPath(
  new URL('../var/container-images/release-images.env', import.meta.url),
);

assert.deepEqual(
  currentSource,
  receipt.source,
  'Current source does not match the tested image build receipt.',
);
assert.equal(currentSource.state, 'clean', 'Refusing to publish dirty source.');
assert.deepEqual(
  receipt.images,
  applicationImages,
  'Build receipt does not contain the expected application images.',
);

function runDocker(arguments_) {
  const result = spawnSync(dockerExecutable, arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.status, 0, `docker ${arguments_.join(' ')} failed.`);
  return output;
}

const publishedImages = [];
for (const image of applicationImages) {
  const repository = `${repositoryPrefix}-${image.name}`;
  const mutableReference = `${repository}:${releaseTag}`;
  runDocker(['tag', image.reference, mutableReference]);
  const pushOutput = runDocker(['push', mutableReference]);
  const digest = parsePushedDigest(pushOutput);
  publishedImages.push({
    name: image.name,
    repository,
    tag: releaseTag,
    digest,
    immutableReference: immutableImageReference(repository, digest),
  });
}

const releaseManifest = {
  schemaVersion: 1,
  sourceHead: receipt.source.headRevision,
  sourceFingerprint: receipt.source.fingerprint,
  ociRevision: receipt.ociRevision,
  images: publishedImages,
};

mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
});
writeFileSync(
  environmentPath,
  `${publishedImages
    .map(
      (image) =>
        `${image.name.toUpperCase()}_IMAGE=${image.immutableReference}`,
    )
    .join('\n')}\n`,
  { encoding: 'utf8', mode: 0o600 },
);

process.stdout.write(
  `CONTAINER_IMAGES_PUBLISHED images=${publishedImages.length} source=${releaseManifest.sourceHead}\n`,
);
