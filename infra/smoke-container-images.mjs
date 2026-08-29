import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  applicationImageBuildIdLabel,
  applicationImageBuildReceiptUrl,
  applicationImageRevisionLabel,
  applicationImageSourceFingerprintLabel,
  applicationImageSourceHeadLabel,
  applicationImageSourceStateLabel,
  applicationImages,
} from './container-image-manifest.mjs';
import { runWithDockerCleanup } from './container-image-smoke-cleanup.mjs';
import { ociRevisionForProvenance } from './git-source-provenance.mjs';

const dockerExecutable = process.platform === 'win32' ? 'docker.exe' : 'docker';
const receipt = JSON.parse(
  readFileSync(applicationImageBuildReceiptUrl, 'utf8'),
);
const runId = randomUUID();
const networkName = `vpn-platform-images-${runId}`;
const containerNames = {
  api: `vpn-platform-api-${runId}`,
  worker: `vpn-platform-worker-${runId}`,
  bot: `vpn-platform-bot-${runId}`,
  web: `vpn-platform-web-${runId}`,
};

function spawnDocker(arguments_, options = {}) {
  return spawnSync(dockerExecutable, arguments_, {
    encoding: 'utf8',
    ...options,
  });
}

function runDocker(arguments_, options = {}) {
  const result = spawnDocker(arguments_, options);
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

function waitForHealth(containerName) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const state = JSON.parse(
      runDocker(['inspect', '--format', '{{json .State}}', containerName]),
    );
    if (state.Health?.Status === 'healthy') return;
    assert.equal(
      state.Running,
      true,
      `${containerName} exited before becoming healthy`,
    );
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  assert.fail(`${containerName} did not become healthy.`);
}

function assertHttpOk(containerName, url) {
  const responseBody = runDocker([
    'exec',
    containerName,
    'node',
    '-e',
    [
      'const url=process.argv[1];',
      'fetch(url).then(async response=>{',
      'const body=await response.text();',
      "if(response.status!==200){console.error('unexpected status',response.status);process.exit(1)}",
      'process.stdout.write(body)',
      '}).catch(()=>process.exit(1))',
    ].join(''),
    url,
  ]);
  assert.ok(responseBody.length > 0, `${url} returned an empty response.`);
  return responseBody;
}

assert.deepEqual(receipt.images, applicationImages);
assert.equal(typeof receipt.buildId, 'string');
assert.ok(receipt.buildId.length > 0);
assert.match(receipt.source?.state, /^(clean|dirty)$/);
assert.match(receipt.source?.headRevision, /^[a-f0-9]{40}$/);
assert.match(receipt.source?.fingerprint, /^[a-f0-9]{40,64}$/);
assert.equal(receipt.ociRevision, ociRevisionForProvenance(receipt.source));

for (const image of applicationImages) {
  const configuration = inspect(image.reference).Config;
  assert.equal(configuration.User, 'node', `${image.name} must be non-root.`);
  assert.equal(
    configuration.Labels?.[applicationImageBuildIdLabel],
    receipt.buildId,
    `${image.name} was not built by the immediately preceding image build.`,
  );
  assert.equal(
    configuration.Labels?.[applicationImageSourceStateLabel],
    receipt.source.state,
    `${image.name} has the wrong source state.`,
  );
  assert.equal(
    configuration.Labels?.[applicationImageSourceHeadLabel],
    receipt.source.headRevision,
    `${image.name} has the wrong source HEAD.`,
  );
  assert.equal(
    configuration.Labels?.[applicationImageSourceFingerprintLabel],
    receipt.source.fingerprint,
    `${image.name} has the wrong source fingerprint.`,
  );
  assert.equal(
    configuration.Labels?.[applicationImageRevisionLabel],
    receipt.ociRevision,
    `${image.name} exposes a misleading OCI revision.`,
  );
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

const proxyTarget = new URL(receipt.webApiProxyTarget);
assert.equal(
  proxyTarget.protocol,
  'http:',
  'The local image smoke requires an HTTP WEB_API_PROXY_TARGET.',
);
assert.equal(
  proxyTarget.port || '80',
  '3001',
  'The local image smoke requires WEB_API_PROXY_TARGET port 3001.',
);

function runEntrypointSmoke(injectedFailure) {
  return runWithDockerCleanup(
    {
      run: spawnDocker,
      containerNames: Object.values(containerNames),
      networkName,
    },
    (resources) => {
      resources.trackNetwork(networkName);
      runDocker(['network', 'create', '--driver', 'bridge', networkName]);

      resources.trackContainer(containerNames.api);
      runDocker([
        'run',
        '--detach',
        '--name',
        containerNames.api,
        '--network',
        networkName,
        '--network-alias',
        proxyTarget.hostname,
        '--env',
        'NODE_ENV=production',
        '--env',
        'LOG_LEVEL=silent',
        '--env',
        'DATABASE_URL=postgresql://smoke:smoke@database.invalid:5432/smoke',
        '--env',
        'REDIS_URL=redis://redis.invalid:6379',
        '--env',
        `API_REDIS_KEY_NAMESPACE=smoke-${runId}`,
        '--env',
        'TELEGRAM_WEB_APP_BOT_TOKEN=smoke:test-only',
        '--env',
        'AUTH_SESSION_PEPPER=smoke-auth-session-pepper-0000000000000000',
        '--env',
        'SUBSCRIPTION_TOKEN_PEPPER=smoke-subscription-pepper-000000000000000',
        '--env',
        'NODE_AGENT_CREDENTIAL_PEPPER=smoke-node-agent-pepper-0000000000000000',
        '--env',
        'DATA_PLANE_CREDENTIAL_PEPPER=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        '--env',
        'SUBSCRIPTION_FEED_BASE_URL=https://subscription.invalid',
        '--env',
        'CABINET_ORIGIN=https://cabinet.invalid',
        'vpn-platform/api:ci',
      ]);
      waitForHealth(containerNames.api);

      resources.trackContainer(containerNames.worker);
      runDocker([
        'run',
        '--name',
        containerNames.worker,
        '--network',
        'none',
        '--env',
        'LOG_LEVEL=silent',
        'vpn-platform/worker:ci',
      ]);
      resources.trackContainer(containerNames.bot);
      runDocker([
        'run',
        '--name',
        containerNames.bot,
        '--network',
        'none',
        '--env',
        'LOG_LEVEL=silent',
        'vpn-platform/bot:ci',
      ]);

      resources.trackContainer(containerNames.web);
      runDocker([
        'run',
        '--detach',
        '--name',
        containerNames.web,
        '--network',
        networkName,
        'vpn-platform/web:ci',
      ]);
      waitForHealth(containerNames.web);

      if (injectedFailure) throw injectedFailure;

      const directApiBody = assertHttpOk(
        containerNames.web,
        `${proxyTarget.origin}/health/live`,
      );
      assert.deepEqual(JSON.parse(directApiBody), { status: 'ok' });
      assertHttpOk(containerNames.web, 'http://127.0.0.1:3000/');
      const proxiedApiBody = assertHttpOk(
        containerNames.web,
        'http://127.0.0.1:3000/api/health/live',
      );
      assert.deepEqual(JSON.parse(proxiedApiBody), { status: 'ok' });
    },
  );
}

const injectedFailure = new Error('injected failure after API and web start');
assert.throws(
  () => runEntrypointSmoke(injectedFailure),
  (error) => error === injectedFailure,
);
runEntrypointSmoke();

process.stdout.write(
  `CONTAINER_IMAGES_OK images=${applicationImages.length} source=${receipt.source.state} fingerprint=${receipt.source.fingerprint}\n`,
);
