import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { applicationImages } from './container-image-manifest.mjs';

const dockerExecutable = process.platform === 'win32' ? 'docker.exe' : 'docker';

function runDocker(arguments_, options = {}) {
  const result = spawnSync(dockerExecutable, arguments_, {
    encoding: 'utf8',
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `docker ${arguments_.join(' ')} failed:\n${result.stderr}`,
  );
  return result.stdout.trim();
}

function inspect(reference) {
  return JSON.parse(runDocker(['image', 'inspect', reference]))[0];
}

function waitForHealth(containerName, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = runDocker([
      'inspect',
      '--format',
      '{{.State.Health.Status}}',
      containerName,
    ]);
    if (status === expected) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  assert.fail(`${containerName} did not become ${expected}.`);
}

for (const image of applicationImages) {
  const configuration = inspect(image.reference).Config;
  assert.equal(configuration.User, 'node', `${image.name} must be non-root.`);
  runDocker([
    'run',
    '--rm',
    '--network',
    'none',
    '--entrypoint',
    'node',
    image.reference,
    '-e',
    'if(process.getuid?.()===0)process.exit(1)',
  ]);
}

assert.ok(inspect('vpn-platform/api:ci').Config.Healthcheck);
assert.ok(inspect('vpn-platform/web:ci').Config.Healthcheck);
assert.equal(inspect('vpn-platform/worker:ci').Config.Healthcheck, undefined);
assert.equal(inspect('vpn-platform/bot:ci').Config.Healthcheck, undefined);

for (const reference of ['vpn-platform/api:ci', 'vpn-platform/worker:ci']) {
  runDocker([
    'run',
    '--rm',
    '--network',
    'none',
    '--entrypoint',
    'node',
    reference,
    '-e',
    "const {PrismaClient}=require('@prisma/client');const client=new PrismaClient();client.$disconnect()",
  ]);
}
runDocker([
  'run',
  '--rm',
  '--network',
  'none',
  '--entrypoint',
  'node',
  'vpn-platform/bot:ci',
  '-e',
  "try{require.resolve('@prisma/client');process.exit(1)}catch{}",
]);

const healthyContainer = `vpn-platform-web-healthy-${randomUUID()}`;
const unhealthyContainer = `vpn-platform-web-unhealthy-${randomUUID()}`;
try {
  runDocker([
    'run',
    '--detach',
    '--name',
    healthyContainer,
    '--network',
    'none',
    'vpn-platform/web:ci',
  ]);
  waitForHealth(healthyContainer, 'healthy');

  runDocker([
    'run',
    '--detach',
    '--name',
    unhealthyContainer,
    '--network',
    'none',
    '--env',
    'PORT=3999',
    'vpn-platform/web:ci',
  ]);
  waitForHealth(unhealthyContainer, 'unhealthy');
} finally {
  spawnSync(dockerExecutable, [
    'rm',
    '--force',
    healthyContainer,
    unhealthyContainer,
  ]);
}

process.stdout.write(
  `CONTAINER_IMAGES_OK images=${applicationImages.length}\n`,
);
