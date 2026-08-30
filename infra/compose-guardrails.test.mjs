import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const dockerExecutable = process.platform === 'win32' ? 'docker.exe' : 'docker';

const manifests = [
  {
    file: 'infra/docker-compose.yml',
    projectName: 'vpn-platform-local',
    services: ['postgres', 'redis'],
  },
  {
    file: 'infra/docker-compose.xray-local.yml',
    projectName: 'vpn-platform-xray-local',
    services: ['xray-a', 'xray-b', 'xray-tls-init'],
  },
  {
    file: 'infra/docker-compose.vpn-node.yml',
    projectName: 'vpn-platform-vpn-node',
    services: ['control-plane-proxy', 'xray'],
  },
];

function renderCompose(file) {
  const result = spawnSync(
    dockerExecutable,
    [
      'compose',
      '--env-file',
      '.env.example',
      '-f',
      file,
      'config',
      '--format',
      'json',
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        COMPOSE_DISABLE_ENV_FILE: '1',
      },
    },
  );

  assert.equal(
    result.status,
    0,
    `${file} must render without a Docker daemon:\n${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}

test('all versioned Compose manifests render deterministically offline', () => {
  for (const manifest of manifests) {
    const rendered = renderCompose(manifest.file);
    assert.equal(rendered.name, manifest.projectName);
    assert.deepEqual(Object.keys(rendered.services).sort(), manifest.services);
  }
});

test('production Xray exposes a Handler API healthcheck without publishing it', () => {
  const rendered = renderCompose('infra/docker-compose.vpn-node.yml');
  const xray = rendered.services.xray;

  assert.deepEqual(xray.healthcheck.test, [
    'CMD',
    'xray',
    'api',
    'inboundusercount',
    '--server=127.0.0.1:10085',
    '-tag=vless-tcp-tls',
  ]);
  assert.equal(xray.restart, 'no');
  assert.equal(
    rendered.services['control-plane-proxy'].restart,
    'unless-stopped',
  );
  assert.deepEqual(xray.ports, [
    {
      mode: 'ingress',
      target: 443,
      published: '443',
      protocol: 'tcp',
    },
  ]);
});
