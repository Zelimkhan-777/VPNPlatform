import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const vpnNodeDirectory = fileURLToPath(new URL('.', import.meta.url));
const lifecyclePath = join(vpnNodeDirectory, 'xray-serving-lifecycle.sh');
const deployHookPath = join(
  vpnNodeDirectory,
  'certbot',
  'vpn-platform-xray-deploy.sh',
);
const installerPath = join(
  vpnNodeDirectory,
  'install-xray-certificate-renewal.sh',
);
const unitTemplatePath = join(
  vpnNodeDirectory,
  'systemd',
  'vpn-platform-node-agent.service.template',
);
const packageJsonPath = join(vpnNodeDirectory, '..', '..', 'package.json');

function findBash() {
  if (spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0) {
    return 'bash';
  }

  if (process.platform === 'win32') {
    const gitPaths = spawnSync('where.exe', ['git'], { encoding: 'utf8' })
      .stdout.split(/\r?\n/)
      .filter(Boolean);
    for (const gitPath of gitPaths) {
      const candidate = join(dirname(dirname(gitPath)), 'bin', 'bash.exe');
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

const bashExecutable = findBash();

async function createCommandStubs(root) {
  const dockerPath = join(root, 'docker');
  const systemctlPath = join(root, 'systemctl');
  const dockerLog = join(root, 'docker.log');
  const systemctlLog = join(root, 'systemctl.log');
  await writeFile(
    dockerPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$VPN_LIFECYCLE_DOCKER_LOG"
if [[ "\${VPN_LIFECYCLE_DOCKER_PS_FAIL:-}" == '1' && "$*" == *ps* ]]; then
  echo 'injected docker ps failure' >&2
  exit 1
fi
if [[ "$*" == *ps* ]]; then
  printf '%s' "\${VPN_LIFECYCLE_RUNNING_IDS:-}"
  exit 0
fi
exit 0
`,
  );
  await writeFile(
    systemctlPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$VPN_LIFECYCLE_SYSTEMCTL_LOG"
if [[ "\${VPN_LIFECYCLE_SYSTEMCTL_FAIL:-}" == '1' ]]; then
  echo 'injected systemctl failure' >&2
  exit 1
fi
exit 0
`,
  );
  await chmod(dockerPath, 0o755);
  await chmod(systemctlPath, 0o755);
  return { dockerPath, systemctlPath, dockerLog, systemctlLog };
}

function runLifecycle(bash, stubs, argumentsList, extraEnv = {}) {
  return spawnSync(bash, [lifecyclePath, ...argumentsList], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dirname(stubs.dockerPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
      VPN_NODE_STATE_DIRECTORY: 'vpn-fi-01',
      DOCKER_BIN: stubs.dockerPath,
      SYSTEMCTL_BIN: stubs.systemctlPath,
      VPN_LIFECYCLE_DOCKER_LOG: stubs.dockerLog,
      VPN_LIFECYCLE_SYSTEMCTL_LOG: stubs.systemctlLog,
      ...extraEnv,
    },
  });
}

test(
  'lifecycle script passes bash syntax validation',
  { skip: !bashExecutable },
  () => {
    const result = spawnSync(bashExecutable, ['-n', lifecyclePath], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  },
);

test(
  'verify-stopped requires a successful empty docker ps',
  { skip: !bashExecutable },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'vpn-xray-lifecycle-'));
    try {
      const stubs = await createCommandStubs(root);
      const stopped = runLifecycle(bashExecutable, stubs, ['verify-stopped']);
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.match(
        await readFile(stubs.dockerLog, 'utf8'),
        /ps .*status=running/,
      );

      const probeFailed = runLifecycle(
        bashExecutable,
        stubs,
        ['verify-stopped'],
        {
          VPN_LIFECYCLE_DOCKER_PS_FAIL: '1',
        },
      );
      assert.notEqual(probeFailed.status, 0);
      assert.match(probeFailed.stderr, /docker ps did not succeed/);

      const stillRunning = runLifecycle(
        bashExecutable,
        stubs,
        ['verify-stopped'],
        { VPN_LIFECYCLE_RUNNING_IDS: 'xray-still-up' },
      );
      assert.notEqual(stillRunning.status, 0);
      assert.match(stillRunning.stderr, /still running/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'handoff stops Xray, verifies the post-condition, then restarts node-agent',
  { skip: !bashExecutable },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'vpn-xray-handoff-'));
    try {
      const stubs = await createCommandStubs(root);
      const composeFile = join(root, 'docker-compose.vpn-node.yml');
      await writeFile(composeFile, 'name: fixture\n');
      const result = runLifecycle(bashExecutable, stubs, [
        'handoff',
        composeFile,
      ]);
      assert.equal(result.status, 0, result.stderr);
      const dockerLog = await readFile(stubs.dockerLog, 'utf8');
      assert.match(dockerLog, /compose -f .* stop --timeout 0 xray/);
      assert.match(dockerLog, /ps .*status=running/);
      assert.equal(
        await readFile(stubs.systemctlLog, 'utf8'),
        'restart vpn-platform-node-agent.service\n',
      );

      const leftover = runLifecycle(
        bashExecutable,
        stubs,
        ['handoff', composeFile],
        { VPN_LIFECYCLE_RUNNING_IDS: 'xray-still-up' },
      );
      assert.notEqual(leftover.status, 0);
      assert.match(leftover.stderr, /still running/);
      assert.equal(
        await readFile(stubs.systemctlLog, 'utf8'),
        'restart vpn-platform-node-agent.service\n',
      );

      const probeFailed = runLifecycle(
        bashExecutable,
        stubs,
        ['handoff', composeFile],
        { VPN_LIFECYCLE_DOCKER_PS_FAIL: '1' },
      );
      assert.notEqual(probeFailed.status, 0);
      assert.match(probeFailed.stderr, /docker ps did not succeed/);
      assert.equal(
        await readFile(stubs.systemctlLog, 'utf8'),
        'restart vpn-platform-node-agent.service\n',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function writeWaitStubs(root, helperBody) {
  const helperPath = join(root, 'served-fingerprint');
  const sleepPath = join(root, 'sleep');
  const nowPath = join(root, 'now');
  const timeoutPath = join(root, 'timeout');
  const countPath = join(root, 'count');
  const clockPath = join(root, 'clock');
  const cancelPath = join(root, 'cancel');
  const sleepLog = join(root, 'sleep.log');
  const timeoutLog = join(root, 'timeout.log');
  await writeFile(countPath, '0\n');
  await writeFile(clockPath, '1000\n');
  await writeFile(sleepLog, '');
  await writeFile(timeoutLog, '');
  await writeFile(helperPath, helperBody);
  await writeFile(
    sleepPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'slept\\n' >>"$VPN_LIFECYCLE_SLEEP_LOG"
clock="$(cat "$VPN_LIFECYCLE_CLOCK_FILE")"
printf '%s\\n' "$((clock + 1))" >"$VPN_LIFECYCLE_CLOCK_FILE"
`,
  );
  await writeFile(
    nowPath,
    `#!/usr/bin/env bash
set -euo pipefail
cat "$VPN_LIFECYCLE_CLOCK_FILE"
`,
  );
  await writeFile(
    timeoutPath,
    `#!/usr/bin/env bash
set -euo pipefail
budget="$1"
shift
printf '%s\\n' "$budget" >>"$VPN_LIFECYCLE_TIMEOUT_LOG"
if [[ "\${VPN_LIFECYCLE_TIMEOUT_ENFORCE:-}" == '1' ]]; then
  "$@" &
  child=$!
  sleep "$budget"
  : >"$VPN_LIFECYCLE_CANCEL_FILE"
  wait "$child" 2>/dev/null || true
  exit 124
fi
exec "$@"
`,
  );
  await chmod(helperPath, 0o755);
  await chmod(sleepPath, 0o755);
  await chmod(nowPath, 0o755);
  await chmod(timeoutPath, 0o755);
  return {
    helperPath,
    sleepPath,
    nowPath,
    timeoutPath,
    countPath,
    clockPath,
    cancelPath,
    sleepLog,
    timeoutLog,
  };
}

function waitFingerprintEnv(stubs, extraEnv = {}) {
  return {
    ...process.env,
    SERVED_TLS_FINGERPRINT_HELPER: stubs.helperPath,
    SLEEP_BIN: stubs.sleepPath,
    TIMEOUT_BIN: stubs.timeoutPath,
    MONOTONIC_NOW_HELPER: stubs.nowPath,
    VPN_LIFECYCLE_COUNT_FILE: stubs.countPath,
    VPN_LIFECYCLE_CLOCK_FILE: stubs.clockPath,
    VPN_LIFECYCLE_CANCEL_FILE: stubs.cancelPath,
    VPN_LIFECYCLE_SLEEP_LOG: stubs.sleepLog,
    VPN_LIFECYCLE_TIMEOUT_LOG: stubs.timeoutLog,
    ...extraEnv,
  };
}

test(
  'wait-served-fingerprint requires a matching live TLS hash within the budget',
  { skip: !bashExecutable },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'vpn-xray-tls-wait-'));
    try {
      const stubs = await writeWaitStubs(
        root,
        `#!/usr/bin/env bash
set -euo pipefail
count="$(cat "$VPN_LIFECYCLE_COUNT_FILE")"
count=$((count + 1))
printf '%s\\n' "$count" >"$VPN_LIFECYCLE_COUNT_FILE"
if ((count >= 3)); then
  printf 'abc123matched\\n'
else
  printf 'wrong-fingerprint\\n'
fi
`,
      );

      const matched = spawnSync(
        bashExecutable,
        [
          lifecyclePath,
          'wait-served-fingerprint',
          'node.example.test',
          '443',
          'abc123matched',
          '5',
        ],
        {
          encoding: 'utf8',
          env: waitFingerprintEnv(stubs),
        },
      );
      assert.equal(matched.status, 0, matched.stderr);
      assert.match(matched.stdout, /XRAY_TLS_FINGERPRINT_MATCHED/);
      assert.equal((await readFile(stubs.countPath, 'utf8')).trim(), '3');
      assert.equal(
        (await readFile(stubs.sleepLog, 'utf8')).trim().split('\n').length,
        2,
      );
      assert.equal(
        (await readFile(stubs.timeoutLog, 'utf8')).trim(),
        '5\n4\n3',
      );

      await writeFile(stubs.countPath, '0\n');
      await writeFile(stubs.clockPath, '1000\n');
      await writeFile(stubs.sleepLog, '');
      await writeFile(stubs.timeoutLog, '');
      const timedOut = spawnSync(
        bashExecutable,
        [
          lifecyclePath,
          'wait-served-fingerprint',
          'node.example.test',
          '443',
          'never-matches',
          '2',
        ],
        {
          encoding: 'utf8',
          env: waitFingerprintEnv(stubs),
        },
      );
      assert.notEqual(timedOut.status, 0);
      assert.match(
        timedOut.stderr,
        /did not serve the expected TLS certificate/,
      );
      assert.doesNotMatch(timedOut.stdout, /XRAY_TLS_FINGERPRINT_MATCHED/);
      assert.equal((await readFile(stubs.countPath, 'utf8')).trim(), '2');
      assert.equal(
        (await readFile(stubs.sleepLog, 'utf8')).trim().split('\n').length,
        2,
      );
      assert.equal((await readFile(stubs.timeoutLog, 'utf8')).trim(), '2\n1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'wait-served-fingerprint caps a slow probe by the remaining wall-clock budget',
  { skip: !bashExecutable },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'vpn-xray-tls-slow-'));
    try {
      const stubs = await writeWaitStubs(
        root,
        `#!/usr/bin/env bash
set -euo pipefail
count="$(cat "$VPN_LIFECYCLE_COUNT_FILE")"
count=$((count + 1))
printf '%s\\n' "$count" >"$VPN_LIFECYCLE_COUNT_FILE"
for _ in {1..80}; do
  if [[ -f "$VPN_LIFECYCLE_CANCEL_FILE" ]]; then
    exit 124
  fi
  sleep 0.1
done
printf 'slow-wrong-fingerprint\\n'
`,
      );

      const env = waitFingerprintEnv(stubs, {
        VPN_LIFECYCLE_TIMEOUT_ENFORCE: '1',
      });
      delete env.MONOTONIC_NOW_HELPER;
      delete env.SLEEP_BIN;
      const started = Date.now();
      const timedOut = spawnSync(
        bashExecutable,
        [
          lifecyclePath,
          'wait-served-fingerprint',
          'node.example.test',
          '443',
          'never-matches',
          '2',
        ],
        {
          encoding: 'utf8',
          timeout: 10_000,
          env,
        },
      );
      const elapsedMs = Date.now() - started;
      const probeCount = Number(
        (await readFile(stubs.countPath, 'utf8')).trim(),
      );
      const probeBudgets = (await readFile(stubs.timeoutLog, 'utf8'))
        .trim()
        .split('\n');
      assert.notEqual(timedOut.status, 0);
      assert.match(
        timedOut.stderr,
        /did not serve the expected TLS certificate/,
      );
      assert.doesNotMatch(timedOut.stdout, /XRAY_TLS_FINGERPRINT_MATCHED/);
      assert.ok(probeCount >= 1 && probeCount <= 2, `probes=${probeCount}`);
      assert.equal(probeBudgets[0], '2');
      assert.ok(
        probeBudgets.every((budget) => Number(budget) <= 2),
        `probe budgets exceeded remaining time: ${probeBudgets.join(',')}`,
      );
      assert.ok(
        elapsedMs < 4500,
        `slow probe exceeded the wall-clock budget: ${elapsedMs}ms`,
      );
      assert.ok(
        elapsedMs >= 1500,
        `slow probe returned too quickly to have been bounded: ${elapsedMs}ms`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('TLS deploy, systemd and installer keep the node-agent wakeup path', async () => {
  const lifecycle = await readFile(lifecyclePath, 'utf8');
  assert.match(lifecycle, /NODE_AGENT_UNIT='vpn-platform-node-agent\.service'/);
  assert.match(lifecycle, /"\$SYSTEMCTL_BIN" restart "\$NODE_AGENT_UNIT"/);
  assert.match(lifecycle, /handoff_to_node_agent/);
  assert.match(
    lifecycle,
    /TLS_HANDOFF_WAIT_SECONDS="\$\{TLS_HANDOFF_WAIT_SECONDS:-120\}"/,
  );
  assert.match(lifecycle, /wait-served-fingerprint/);
  assert.match(lifecycle, /monotonic_now_seconds/);
  assert.match(lifecycle, /TLS_PROBE_TIMEOUT_SECONDS=8/);
  assert.match(lifecycle, /docker ps did not succeed/);
  assert.match(lifecycle, /a container is still running/);

  const deployHook = await readFile(deployHookPath, 'utf8');
  assert.match(deployHook, /xray-serving-lifecycle\.sh/);
  assert.match(deployHook, /run_xray_lifecycle handoff/);
  assert.match(deployHook, /run_xray_lifecycle wait-served-fingerprint/);
  assert.match(
    deployHook,
    /openssl x509 -in "\$lineage\/fullchain\.pem" -outform DER/,
  );
  assert.ok(
    deployHook.indexOf('run_xray_lifecycle handoff') <
      deployHook.indexOf('run_xray_lifecycle wait-served-fingerprint'),
  );
  assert.ok(
    deployHook.indexOf('run_xray_lifecycle wait-served-fingerprint') <
      deployHook.indexOf("echo 'XRAY_TLS_DEPLOYED'"),
  );
  assert.doesNotMatch(deployHook, /xray_is_running/);
  assert.doesNotMatch(deployHook, /restart xray/);
  assert.doesNotMatch(deployHook, /compose .* (?:up|start) xray/);

  const unit = await readFile(unitTemplatePath, 'utf8');
  assert.match(unit, /xray-serving-lifecycle\.sh stop-and-verify/);

  const installer = await readFile(installerPath, 'utf8');
  assert.match(installer, /NODE_AGENT_ACTIVE_AFTER_TLS_DEPLOY/);
  assert.match(installer, /wait-served-fingerprint/);
  assert.match(installer, /xray-serving-lifecycle\.sh/);
  assert.match(
    installer,
    /systemctl is-active vpn-platform-node-agent\.service/,
  );
  assert.doesNotMatch(installer, /State\.Status.*running/);
  assert.doesNotMatch(installer, /seq 1 30/);
  assert.match(installer, /XRAY_TLS_SERVED_AFTER_HANDOFF/);

  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  assert.match(
    packageJson.scripts['vpn-node:up'],
    /up -d control-plane-proxy$/,
  );
  assert.doesNotMatch(packageJson.scripts['vpn-node:up'], /\bup -d$/);
  assert.equal(packageJson.scripts['vpn-node:restart'], undefined);
  assert.match(
    packageJson.scripts['vpn-node:break-glass-start-xray'],
    /up -d xray$/,
  );
});
