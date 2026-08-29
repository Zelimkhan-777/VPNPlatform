import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { requireHttpOrigin } from '../apps/web/api-proxy-target.mjs';
import { runWithDockerCleanup } from './container-image-smoke-cleanup.mjs';
import { applicationImages } from './container-image-manifest.mjs';
import {
  ociRevisionForProvenance,
  requireCleanCiProvenance,
  resolveGitSourceProvenance,
} from './git-source-provenance.mjs';

const dockerfileUrl = new URL('../Dockerfile', import.meta.url);
const dockerignoreUrl = new URL('../.dockerignore', import.meta.url);
const buildScriptUrl = new URL('./build-container-images.mjs', import.meta.url);
const smokeScriptUrl = new URL('./smoke-container-images.mjs', import.meta.url);
const ciWorkflowUrl = new URL('../.github/workflows/ci.yml', import.meta.url);

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

test('web API proxy build target is a required HTTP(S) origin', () => {
  assert.equal(requireHttpOrigin('http://api:3001'), 'http://api:3001');
  assert.equal(
    requireHttpOrigin('https://api.example.test/'),
    'https://api.example.test',
  );

  for (const value of [
    undefined,
    '',
    'api:3001',
    'ftp://api.example.test',
    'https://user:password@api.example.test',
    'https://api.example.test/path',
    'https://api.example.test?query=value',
    'https://api.example.test#fragment',
  ]) {
    assert.throws(() => requireHttpOrigin(value), /WEB_API_PROXY_TARGET/);
  }
});

test('image build passes the proxy target and shares the pnpm deploy cache', async () => {
  const [dockerfile, buildScript] = await Promise.all([
    readFile(dockerfileUrl, 'utf8'),
    readFile(buildScriptUrl, 'utf8'),
  ]);

  assert.match(dockerfile, /^ARG WEB_API_PROXY_TARGET$/m);
  assert.match(
    dockerfile,
    /^ENV WEB_API_PROXY_TARGET=\$WEB_API_PROXY_TARGET$/m,
  );
  assert.equal(
    dockerfile.match(
      /^RUN --mount=type=cache,id=pnpm-store,target=\/pnpm\/store/gm,
    )?.length,
    4,
  );
  assert.equal(dockerfile.match(/deploy --prod --legacy/g)?.length, 3);
  assert.doesNotMatch(dockerfile, /deploy[^\n]*--offline/);
  assert.match(buildScript, /WEB_API_PROXY_TARGET=/);
  assert.match(buildScript, /applicationImageBuildIdLabel/);
  assert.match(buildScript, /ociRevisionForProvenance/);
  assert.match(buildScript, /requireCleanCiProvenance/);
});

function result(status, stderr = '') {
  return { status, stdout: '', stderr };
}

function fakeCleanupDocker(containers, networks, failingRemoval) {
  return (arguments_) => {
    const [area, action, name] = arguments_;
    if (area === 'rm') {
      const containerName = arguments_.at(-1);
      if (!containers.has(containerName)) {
        return result(1, `No such container: ${containerName}`);
      }
      if (failingRemoval === containerName) {
        return result(1, 'permission denied');
      }
      containers.delete(containerName);
      return result(0);
    }
    if (area === 'container' && action === 'inspect') {
      return containers.has(name)
        ? result(0)
        : result(1, `No such container: ${name}`);
    }
    if (area === 'network' && action === 'rm') {
      if (!networks.has(name)) return result(1, `network ${name} not found`);
      networks.delete(name);
      return result(0);
    }
    if (area === 'network' && action === 'inspect') {
      return networks.has(name)
        ? result(0)
        : result(1, `network ${name} not found`);
    }
    throw new Error(`Unexpected fake Docker call: ${arguments_.join(' ')}`);
  };
}

test('failure after API and web start removes every tracked Docker resource', () => {
  const containerNames = ['api-test', 'web-test'];
  const networkName = 'network-test';
  const containers = new Set();
  const networks = new Set();

  assert.throws(
    () =>
      runWithDockerCleanup(
        {
          run: fakeCleanupDocker(containers, networks),
          containerNames,
          networkName,
        },
        (resources) => {
          resources.trackNetwork(networkName);
          networks.add(networkName);
          resources.trackContainer(containerNames[0]);
          containers.add(containerNames[0]);
          resources.trackContainer(containerNames[1]);
          containers.add(containerNames[1]);
          throw new Error('injected failure after web start');
        },
      ),
    /injected failure after web start/,
  );

  assert.equal(containers.size, 0);
  assert.equal(networks.size, 0);
});

test('production smoke wires every long-lived resource through checked cleanup', async () => {
  const smokeScript = await readFile(smokeScriptUrl, 'utf8');
  assert.match(smokeScript, /runWithDockerCleanup/);
  assert.equal(smokeScript.match(/resources\.trackContainer\(/g)?.length, 4);
  assert.equal(smokeScript.match(/resources\.trackNetwork\(/g)?.length, 1);
});

test('CI rejects a dirty or mismatched image source checkout', async () => {
  const workflow = await readFile(ciWorkflowUrl, 'utf8');
  assert.match(workflow, /git status --porcelain=v1 --untracked-files=all/);
  assert.match(workflow, /git rev-parse HEAD/);
  assert.match(workflow, /\$GITHUB_SHA/);
});

test('cleanup failure preserves both the smoke and cleanup errors', () => {
  const containerName = 'api-test';
  const containers = new Set([containerName]);
  const networks = new Set();

  assert.throws(
    () =>
      runWithDockerCleanup(
        {
          run: fakeCleanupDocker(containers, networks, containerName),
          containerNames: [containerName],
          networkName: 'network-test',
        },
        (resources) => {
          resources.trackContainer(containerName);
          throw new Error('primary smoke failure');
        },
      ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /smoke failed and cleanup also failed/i);
      assert.ok(
        error.errors.some((item) => /primary smoke failure/.test(item.message)),
      );
      assert.ok(
        error.errors.some((item) => /permission denied/.test(item.message)),
      );
      assert.ok(error.errors.some((item) => /still exists/.test(item.message)));
      return true;
    },
  );
});

test('cleanup accepts an already absent resource only after verifying absence', () => {
  assert.doesNotThrow(() =>
    runWithDockerCleanup(
      {
        run: fakeCleanupDocker(new Set(), new Set()),
        containerNames: ['already-absent'],
        networkName: 'network-test',
      },
      (resources) => resources.trackContainer('already-absent'),
    ),
  );
});

function runGit(repository, arguments_) {
  const execution = spawnSync('git', arguments_, {
    cwd: repository,
    encoding: 'utf8',
  });
  assert.equal(execution.status, 0, execution.stderr);
}

test('Git provenance distinguishes clean HEAD from tracked and untracked changes', () => {
  const repository = mkdtempSync(join(tmpdir(), 'vpn-platform-provenance-'));
  try {
    runGit(repository, ['init', '--quiet']);
    runGit(repository, ['config', 'user.email', 'test@example.invalid']);
    runGit(repository, ['config', 'user.name', 'Container Test']);
    runGit(repository, ['config', 'core.autocrlf', 'false']);
    writeFileSync(join(repository, 'tracked.txt'), 'committed\n');
    runGit(repository, ['add', 'tracked.txt']);
    runGit(repository, ['commit', '--quiet', '-m', 'fixture']);

    const clean = resolveGitSourceProvenance(repository);
    assert.deepEqual(clean, {
      state: 'clean',
      headRevision: clean.headRevision,
      fingerprint: clean.headRevision,
    });
    assert.doesNotThrow(() => requireCleanCiProvenance(clean, 'true'));
    assert.equal(ociRevisionForProvenance(clean), clean.headRevision);

    writeFileSync(join(repository, 'tracked.txt'), 'modified\n');
    writeFileSync(join(repository, 'untracked.txt'), 'untracked one\n');
    const dirty = resolveGitSourceProvenance(repository);
    assert.equal(dirty.state, 'dirty');
    assert.equal(dirty.headRevision, clean.headRevision);
    assert.match(dirty.fingerprint, /^[a-f0-9]{64}$/);
    assert.throws(
      () => requireCleanCiProvenance(dirty, 'true'),
      /require a clean checkout/,
    );
    assert.doesNotThrow(() => requireCleanCiProvenance(dirty, 'false'));
    assert.equal(
      ociRevisionForProvenance(dirty),
      `${dirty.headRevision}-dirty-${dirty.fingerprint}`,
    );

    writeFileSync(join(repository, 'untracked.txt'), 'untracked two\n');
    assert.notEqual(
      resolveGitSourceProvenance(repository).fingerprint,
      dirty.fingerprint,
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
