import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  renderNodeAgentSystemdUnit,
  validateNodeAgentSystemdOptions,
} from './render-node-agent-systemd-unit.mjs';

const vpnNodeDirectory = fileURLToPath(new URL('.', import.meta.url));
const installerPath = join(vpnNodeDirectory, 'install-node-agent-systemd.sh');
const rendererPath = join(
  vpnNodeDirectory,
  'render-node-agent-systemd-unit.mjs',
);
const templatePath = join(
  vpnNodeDirectory,
  'systemd',
  'vpn-platform-node-agent.service.template',
);

const fixtures = [
  {
    name: 'Finland',
    projectRoot: '/home/vpnadmin/vpn-platform',
    stateDirectory: 'vpn-fi-01',
    nodeBinary: '/usr/bin/node',
    serviceUser: 'vpnadmin',
    serviceGroup: 'vpnadmin',
    dockerGroup: 'docker',
  },
  {
    name: 'Amsterdam',
    projectRoot: '/home/vpnadmin/vpn-platform',
    stateDirectory: 'vpn-nl-01',
    nodeBinary: '/home/vpnadmin/.local/node-v24.12.0/bin/node',
    serviceUser: 'vpnadmin',
    serviceGroup: 'vpnadmin',
    dockerGroup: 'docker',
  },
  {
    name: 'custom node',
    projectRoot: '/srv/vpn-platform',
    stateDirectory: 'edge_se-02',
    nodeBinary: '/opt/node/bin/node',
    serviceUser: 'vpnagent',
    serviceGroup: 'vpnagent',
    dockerGroup: 'containers',
  },
];

test('renders isolated Finland, Amsterdam and custom systemd units', async () => {
  const template = await readFile(templatePath, 'utf8');
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'vpn-systemd-render-'));

  try {
    for (const fixture of fixtures) {
      const rendered = renderNodeAgentSystemdUnit(template, fixture);
      const fixturePath = join(
        temporaryRoot,
        `${fixture.stateDirectory}.service`,
      );
      await writeFile(fixturePath, rendered);

      const persisted = await readFile(fixturePath, 'utf8');
      assert.match(
        persisted,
        new RegExp(
          `Description=VPNPlatform node agent \\(${fixture.stateDirectory}\\)`,
        ),
      );
      assert.match(persisted, new RegExp(`User=${fixture.serviceUser}`));
      assert.match(persisted, new RegExp(`Group=${fixture.serviceGroup}`));
      assert.match(
        persisted,
        new RegExp(`SupplementaryGroups=${fixture.dockerGroup}`),
      );
      assert.ok(
        persisted.includes(
          `WorkingDirectory=${fixture.projectRoot}/apps/node-agent`,
        ),
      );
      assert.ok(
        persisted.includes(
          `ExecStart=${fixture.nodeBinary} --env-file=${fixture.projectRoot}/var/${fixture.stateDirectory}/agent.env dist/main.js`,
        ),
      );
      assert.ok(
        persisted.includes(
          `ExecStartPre=/usr/bin/env VPN_NODE_STATE_DIRECTORY=${fixture.stateDirectory} /bin/bash ${fixture.projectRoot}/infra/vpn-node/xray-serving-lifecycle.sh stop-and-verify ${fixture.projectRoot}/infra/docker-compose.vpn-node.yml`,
        ),
      );
      assert.doesNotMatch(persisted, /__[A-Z0-9_]+__/);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('rejects values that could escape a systemd directive', () => {
  const base = fixtures[0];
  const invalidOverrides = [
    { projectRoot: 'relative/path' },
    { projectRoot: '/srv/vpn platform' },
    { projectRoot: '/srv/../vpn-platform' },
    { stateDirectory: '../vpn-fi-01' },
    { stateDirectory: 'vpn-fi-01/other' },
    { stateDirectory: 'vpn-fi-01\nExecStart=/bin/false' },
    { nodeBinary: '/usr/bin/node --inspect' },
    { serviceUser: 'vpnadmin\nRootDirectory=/' },
    { serviceUser: 'root' },
    { serviceGroup: 'root' },
    { dockerGroup: 'root' },
    { serviceGroup: 'VPNADMIN' },
    { dockerGroup: 'docker.service' },
  ];

  for (const override of invalidOverrides) {
    assert.throws(() =>
      validateNodeAgentSystemdOptions({ ...base, ...override }),
    );
  }
});

test('renderer CLI rejects missing and duplicate parameters', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'vpn-systemd-cli-'));
  const outputPath = join(temporaryRoot, 'node-agent.service');

  try {
    const missing = spawnSync(
      process.execPath,
      [
        rendererPath,
        '--project-root',
        '/srv/vpn-platform',
        '--output',
        outputPath,
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /stateDirectory is required/);

    const duplicate = spawnSync(
      process.execPath,
      [
        rendererPath,
        '--project-root',
        '/srv/vpn-platform',
        '--project-root',
        '/opt/vpn-platform',
        '--output',
        outputPath,
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /duplicate option --project-root/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('renderer CLI writes each offline fixture into a temporary root', async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'vpn-systemd-cli-success-'),
  );

  try {
    for (const fixture of fixtures) {
      const outputPath = join(
        temporaryRoot,
        `${fixture.stateDirectory}.service`,
      );
      const result = spawnSync(
        process.execPath,
        [
          rendererPath,
          '--project-root',
          fixture.projectRoot,
          '--state-directory',
          fixture.stateDirectory,
          '--node-binary',
          fixture.nodeBinary,
          '--service-user',
          fixture.serviceUser,
          '--service-group',
          fixture.serviceGroup,
          '--docker-group',
          fixture.dockerGroup,
          '--output',
          outputPath,
        ],
        { encoding: 'utf8' },
      );

      assert.equal(result.status, 0, result.stderr);
      const rendered = await readFile(outputPath, 'utf8');
      assert.ok(rendered.includes(fixture.projectRoot));
      assert.ok(rendered.includes(fixture.stateDirectory));
      assert.ok(rendered.includes(fixture.nodeBinary));
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('production Xray serving is not auto-resumed outside node-agent', async () => {
  const compose = await readFile(
    join(vpnNodeDirectory, '..', 'docker-compose.vpn-node.yml'),
    'utf8',
  );
  const xrayService = compose.split(/\n  xray:\n/)[1] ?? '';
  assert.match(xrayService, /restart: ["']no["']/);
  assert.doesNotMatch(xrayService, /unless-stopped/);
  assert.match(compose, /control-plane-proxy:[\s\S]*restart: unless-stopped/);

  const template = await readFile(templatePath, 'utf8');
  assert.match(
    template,
    /xray-serving-lifecycle\.sh stop-and-verify __PROJECT_ROOT__\/infra\/docker-compose\.vpn-node\.yml/,
  );
  assert.doesNotMatch(template, /compose .* (?:up|start|restart) xray/);

  const deployHook = await readFile(
    join(vpnNodeDirectory, 'certbot', 'vpn-platform-xray-deploy.sh'),
    'utf8',
  );
  assert.match(deployHook, /xray-serving-lifecycle\.sh/);
  assert.match(deployHook, /run_xray_lifecycle handoff/);
  assert.match(deployHook, /run_xray_lifecycle wait-served-fingerprint/);
  assert.ok(
    deployHook.indexOf('run_xray_lifecycle wait-served-fingerprint') <
      deployHook.indexOf("echo 'XRAY_TLS_DEPLOYED'"),
  );
  assert.doesNotMatch(deployHook, /restart xray/);
  assert.doesNotMatch(deployHook, /compose .* (?:up|start) xray/);
});

test('installer contains no legacy process signalling path', async () => {
  const source = await readFile(installerPath, 'utf8');
  assert.doesNotMatch(source, /(^|[;&|]\s*)kill(?:\s|$)/m);
  assert.match(source, /Legacy PID marker exists/);
  assert.match(source, /no process was signalled/);
  assert.match(source, /Duplicate option/);
  assert.match(source, /runuser --user "\$service_user"/);
  assert.match(source, /service_uid="\$\(id -u "\$service_user"\)"/);
  assert.match(source, /service_group_gid/);
  assert.match(source, /docker_group_gid/);
  assert.match(source, /inherited_group_ids/);
  assert.match(source, /must not resolve to root ID 0/);
  assert.match(source, /install -m 0600 -- "\$rendered_unit" "\$render_only"/);
  assert.match(source, /test -x \/usr\/bin\/chronyc/);
  assert.match(source, /does not install chrony or change its configuration/);
  assert.doesNotMatch(
    source,
    /apt-get|dnf install|chrony\.conf|timedatectl|systemctl (?:stop|disable) systemd-timesyncd/,
  );
  assert.doesNotMatch(source, /vpn-nl-01|node-v24\.12\.0|\/home\/vpnadmin/);
});

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

test(
  'installer passes bash syntax validation',
  { skip: !bashExecutable },
  () => {
    const result = spawnSync(bashExecutable, ['-n', installerPath], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  },
);

test(
  'Xray TLS deploy hook passes bash syntax validation',
  { skip: !bashExecutable },
  () => {
    const deployHook = join(
      vpnNodeDirectory,
      'certbot',
      'vpn-platform-xray-deploy.sh',
    );
    const result = spawnSync(bashExecutable, ['-n', deployHook], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  },
);

async function createInstallerFixture(stateDirectory) {
  const root = await mkdtemp(join(tmpdir(), 'vpn-systemd-installer-'));
  await mkdir(join(root, 'apps', 'node-agent'), { recursive: true });
  await mkdir(join(root, 'apps', 'node-agent', 'dist'), { recursive: true });
  await mkdir(join(root, 'var', stateDirectory, 'control-plane-tls'), {
    recursive: true,
  });
  await writeFile(
    join(root, 'apps', 'node-agent', 'dist', 'main.js'),
    '// offline fixture\n',
  );
  await writeFile(
    join(root, 'var', stateDirectory, 'agent.env'),
    'NODE_ENV=production\n',
  );
  await writeFile(
    join(root, 'var', stateDirectory, 'control-plane-tls', 'ca.pem'),
    'offline-test-ca\n',
  );
  return root;
}

function installerArguments(projectRoot, stateDirectory, outputPath) {
  const argumentsList = [
    installerPath,
    '--project-root',
    projectRoot,
    '--state-directory',
    stateDirectory,
    '--node-binary',
    process.execPath,
    '--service-user',
    'vpnagent',
    '--service-group',
    'vpnagent',
    '--docker-group',
    'docker',
  ];

  if (outputPath !== undefined) {
    argumentsList.push('--render-only', outputPath);
  }
  return argumentsList;
}

test(
  'installer rejects an option-shaped render-only path before file access',
  { skip: !bashExecutable },
  () => {
    const result = spawnSync(
      bashExecutable,
      installerArguments('/not-used', 'vpn-fi-01', '--help'),
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 2);
    assert.match(result.stderr, /absolute POSIX path/);
  },
);

test(
  'offline installer renders independent state fixtures without systemd access',
  { skip: !bashExecutable || process.platform === 'win32' },
  async () => {
    for (const stateDirectory of ['vpn-fi-01', 'vpn-nl-01', 'edge-se-02']) {
      const root = await createInstallerFixture(stateDirectory);
      const outputPath = join(root, `${stateDirectory}.service`);

      try {
        const result = spawnSync(
          bashExecutable,
          installerArguments(root, stateDirectory, outputPath),
          { encoding: 'utf8' },
        );
        assert.equal(result.status, 0, result.stderr);
        const rendered = await readFile(outputPath, 'utf8');
        assert.ok(rendered.includes(`/var/${stateDirectory}/agent.env`));
        assert.ok(
          rendered.includes(
            `Description=VPNPlatform node agent (${stateDirectory})`,
          ),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);

test(
  'installer rejects an actual root UID before privilege or systemd access',
  { skip: !bashExecutable || process.platform === 'win32' },
  async () => {
    const stateDirectory = 'vpn-fi-01';
    const root = await createInstallerFixture(stateDirectory);

    try {
      const argumentsList = installerArguments(root, stateDirectory);
      const userIndex = argumentsList.indexOf('--service-user') + 1;
      const serviceGroupIndex = argumentsList.indexOf('--service-group') + 1;
      const dockerGroupIndex = argumentsList.indexOf('--docker-group') + 1;
      argumentsList[userIndex] = 'root';
      argumentsList[serviceGroupIndex] = 'root';
      argumentsList[dockerGroupIndex] = 'root';

      const result = spawnSync(bashExecutable, argumentsList, {
        encoding: 'utf8',
      });
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /service user UID must not resolve to root ID 0/,
      );
      assert.doesNotMatch(result.stderr, /Run this installer through sudo/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'stale legacy PID is left untouched',
  { skip: !bashExecutable },
  async () => {
    const stateDirectory = 'vpn-fi-01';
    const root = await createInstallerFixture(stateDirectory);
    const unrelatedProcess = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      {
        stdio: 'ignore',
      },
    );

    try {
      await writeFile(
        join(root, 'var', stateDirectory, 'node-agent.pid'),
        `${unrelatedProcess.pid}\n`,
      );
      const result = spawnSync(
        bashExecutable,
        installerArguments(root, stateDirectory),
        { encoding: 'utf8' },
      );

      assert.equal(result.status, 1);
      assert.match(result.stderr, /no process was signalled/);
      assert.doesNotThrow(() => process.kill(unrelatedProcess.pid, 0));
    } finally {
      unrelatedProcess.kill('SIGTERM');
      await rm(root, { recursive: true, force: true });
    }
  },
);
