import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
  {
    file: 'infra/docker-compose.production.yml',
    envFile: 'infra/platform/production.env.example',
    profiles: ['bot'],
    projectName: 'meteora-platform-production',
    services: [
      'api',
      'bot',
      'migrate',
      'postgres',
      'redis',
      'reverse-proxy',
      'web',
      'worker',
    ],
  },
];

function renderCompose(file, options = {}) {
  const envFile = options.envFile ?? '.env.example';
  const profiles = (options.profiles ?? []).flatMap((profile) => [
    '--profile',
    profile,
  ]);
  const result = spawnSync(
    dockerExecutable,
    [
      'compose',
      '--env-file',
      envFile,
      ...profiles,
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
    const rendered = renderCompose(manifest.file, manifest);
    assert.equal(rendered.name, manifest.projectName);
    assert.deepEqual(Object.keys(rendered.services).sort(), manifest.services);
  }
});

test('production control plane publishes only the reverse proxy', () => {
  const rendered = renderCompose('infra/docker-compose.production.yml', {
    envFile: 'infra/platform/production.env.example',
    profiles: ['bot'],
  });
  const publishedServices = Object.entries(rendered.services)
    .filter(([, service]) => service.ports)
    .map(([name]) => name);

  assert.deepEqual(publishedServices, ['reverse-proxy']);
  assert.deepEqual(rendered.services['reverse-proxy'].ports, [
    {
      mode: 'ingress',
      target: 80,
      published: '80',
      protocol: 'tcp',
    },
    {
      mode: 'ingress',
      target: 443,
      published: '443',
      protocol: 'tcp',
    },
  ]);
  assert.equal(rendered.networks.data.internal, true);
  assert.equal(rendered.services.postgres.ports, undefined);
  assert.equal(rendered.services.redis.ports, undefined);
  assert.equal(rendered.services.xray, undefined);
  assert.ok(Object.hasOwn(rendered.services.worker.networks, 'egress'));
  assert.ok(Object.hasOwn(rendered.services.bot.networks, 'egress'));
  assert.equal(rendered.services.bot.networks.data, undefined);
  assert.equal(rendered.services.postgres.networks.egress, undefined);
  assert.equal(rendered.services.redis.networks.egress, undefined);
});

test('production images and migration ordering are fail-closed', () => {
  const rendered = renderCompose('infra/docker-compose.production.yml', {
    envFile: 'infra/platform/production.env.example',
    profiles: ['bot'],
  });

  for (const serviceName of [
    'reverse-proxy',
    'web',
    'api',
    'worker',
    'bot',
    'postgres',
    'redis',
  ]) {
    assert.match(
      rendered.services[serviceName].image,
      /@sha256:[a-f0-9]{64}$/,
      `${serviceName} must use an immutable image digest`,
    );
  }

  assert.deepEqual(rendered.services.migrate.command, [
    'node',
    'dist/cli/migrate-deploy.js',
  ]);
  assert.equal(rendered.services.migrate.restart, 'no');
  assert.equal(
    rendered.services.api.depends_on.migrate.condition,
    'service_completed_successfully',
  );
  assert.equal(
    rendered.services.worker.depends_on.migrate.condition,
    'service_completed_successfully',
  );
  assert.equal(
    rendered.services.api.environment.TRUSTED_PROXY_IPS,
    rendered.services['reverse-proxy'].networks.edge.ipv4_address,
  );
});

test('production runtime drops privileges and keeps the inactive bot opt-in', () => {
  const rendered = renderCompose('infra/docker-compose.production.yml', {
    envFile: 'infra/platform/production.env.example',
    profiles: ['bot'],
  });

  for (const serviceName of [
    'reverse-proxy',
    'web',
    'migrate',
    'api',
    'worker',
    'bot',
  ]) {
    const service = rendered.services[serviceName];
    assert.equal(service.read_only, true);
    assert.ok(service.cap_drop.includes('ALL'));
    assert.ok(service.security_opt.includes('no-new-privileges:true'));
  }
  assert.deepEqual(rendered.services.bot.profiles, ['bot']);
  assert.equal(rendered.services.bot.restart, 'no');
});

test('production bot signing secrets are isolated from unrelated services', () => {
  const rendered = renderCompose('infra/docker-compose.production.yml', {
    envFile: 'infra/platform/production.env.example',
    profiles: ['bot', 'bot-admin'],
  });

  assert.deepEqual(rendered.services.api.group_add, ['29001']);
  assert.deepEqual(rendered.services.api.volumes, [
    {
      type: 'bind',
      source: '/etc/meteora/platform-secrets/bot-signing-kek',
      target: '/run/secrets/bot-signing-kek',
      read_only: true,
      bind: { create_host_path: false },
    },
  ]);
  assert.deepEqual(rendered.services.bot.group_add, ['29002']);
  assert.deepEqual(rendered.services.bot.volumes, [
    {
      type: 'bind',
      source: '/etc/meteora/bot-secrets/credential',
      target: '/run/secrets/bot-credential',
      read_only: true,
      bind: { create_host_path: false },
    },
  ]);
  for (const serviceName of ['web', 'worker', 'migrate']) {
    assert.equal(rendered.services[serviceName].volumes, undefined);
    assert.equal(
      Object.keys(rendered.services[serviceName].environment ?? {}).some(
        (key) => key.includes('BOT_SIGNING'),
      ),
      false,
    );
  }

  const admin = rendered.services['bot-credential-admin'];
  assert.deepEqual(admin.profiles, ['bot-admin']);
  assert.equal(admin.user, '0:0');
  assert.deepEqual(Object.keys(admin.networks), ['data']);
  assert.equal(admin.ports, undefined);
  assert.deepEqual(admin.group_add, ['29001', '29002']);
  assert.deepEqual(admin.entrypoint, ['node', 'dist/cli/bot-credential.js']);
  assert.deepEqual(admin.volumes, [
    {
      type: 'bind',
      source: '/etc/meteora/platform-secrets/bot-signing-kek',
      target: '/run/secrets/bot-signing-kek',
      read_only: true,
      bind: { create_host_path: false },
    },
    {
      type: 'bind',
      source: '/etc/meteora/bot-secrets',
      target: '/run/bot-secrets',
      bind: { create_host_path: false },
    },
  ]);
  assert.equal(rendered.services.web.group_add, undefined);
  assert.equal(rendered.services.worker.group_add, undefined);
  assert.equal(rendered.services.migrate.group_add, undefined);
});

test('production services have no host-level container escape configuration', () => {
  const rendered = renderCompose('infra/docker-compose.production.yml', {
    envFile: 'infra/platform/production.env.example',
    profiles: ['bot'],
  });

  for (const [serviceName, service] of Object.entries(rendered.services)) {
    assert.notEqual(service.privileged, true, `${serviceName} is privileged`);
    assert.notEqual(
      service.network_mode,
      'host',
      `${serviceName} uses the host network`,
    );
    assert.notEqual(service.pid, 'host', `${serviceName} uses the host PID ns`);
    for (const volume of service.volumes ?? []) {
      assert.notEqual(
        volume.source,
        '/var/run/docker.sock',
        `${serviceName} mounts the Docker socket`,
      );
    }
  }

  assert.deepEqual(Object.keys(rendered.services.postgres.networks), ['data']);
  assert.deepEqual(Object.keys(rendered.services.redis.networks), ['data']);
  assert.deepEqual(Object.keys(rendered.services.migrate.networks), ['data']);
});

test('production proxy keeps domains configurable and redacts subscription paths', async () => {
  const caddyfile = await readFile(
    new URL('./platform/Caddyfile', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(caddyfile, /mymeteora\.ru/);
  for (const variable of [
    'ROOT_DOMAIN',
    'APP_DOMAIN',
    'API_DOMAIN',
    'SUB_DOMAIN',
  ]) {
    assert.match(caddyfile, new RegExp(`\\{\\$${variable}\\}`));
  }
  assert.match(caddyfile, /request>uri regexp \^\/sub\/\.\*\$ \/sub\/REDACTED/);
  assert.match(caddyfile, /handle \/sub\/\*/);
  assert.match(caddyfile, /handle_path \/api\/\*/);
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
