import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const resticImage =
  'restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510';
const postgresImage =
  'postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94';
const suffix = randomUUID().slice(0, 8);
const sourceContainer = `meteora-backup-smoke-source-${suffix}`;
const restoreContainer = `meteora-backup-smoke-restore-${suffix}`;
const temporaryRoot = await mkdtemp(join(tmpdir(), 'meteora-backup-smoke-'));
const repository = join(temporaryRoot, 'repository');
const secrets = join(temporaryRoot, 'secrets');

function run(arguments_, options = {}) {
  const result = spawnSync(docker, arguments_, {
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

function resticArguments(command, { stdin = false } = {}) {
  return [
    'run',
    '--rm',
    ...(stdin ? ['-i'] : []),
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=64m',
    '--env',
    'RESTIC_REPOSITORY=/repository',
    '--env',
    'RESTIC_PASSWORD_FILE=/run/secrets/restic-password',
    '--env',
    'RESTIC_HOST=platform-smoke',
    '--env',
    'HOME=/tmp',
    '--env',
    'XDG_CACHE_HOME=/tmp/cache',
    '--mount',
    `type=bind,src=${repository},dst=/repository`,
    '--mount',
    `type=bind,src=${secrets},dst=/run/secrets,readonly`,
    resticImage,
    ...command,
  ];
}

function startPostgres(name) {
  run([
    'run',
    '--detach',
    '--name',
    name,
    '--network',
    'none',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/var/lib/postgresql/data:rw,nosuid,nodev,size=512m',
    '--tmpfs',
    '/var/run/postgresql:rw,nosuid,nodev,size=16m',
    '--env',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    postgresImage,
  ]);
}

async function waitForPostgres(name) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync(
      docker,
      ['exec', name, 'pg_isready', '--username', 'postgres'],
      { encoding: 'utf8' },
    );
    if (result.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`${name} did not become ready`);
}

async function pipeDocker(leftArguments, rightArguments) {
  const left = spawn(docker, leftArguments, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const right = spawn(docker, rightArguments, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  left.stdout.pipe(right.stdin);

  let leftError = '';
  let rightOutput = '';
  let rightError = '';
  left.stderr.setEncoding('utf8').on('data', (chunk) => (leftError += chunk));
  right.stdout
    .setEncoding('utf8')
    .on('data', (chunk) => (rightOutput += chunk));
  right.stderr.setEncoding('utf8').on('data', (chunk) => (rightError += chunk));

  const [leftCode, rightCode] = await Promise.all([
    new Promise((resolve) => left.on('close', resolve)),
    new Promise((resolve) => right.on('close', resolve)),
  ]);
  assert.equal(leftCode, 0, `pipeline source failed:\n${leftError}`);
  assert.equal(rightCode, 0, `pipeline destination failed:\n${rightError}`);
  return rightOutput.trim();
}

try {
  await mkdir(repository);
  await mkdir(secrets);
  await writeFile(
    join(secrets, 'restic-password'),
    `TEST_ONLY_${randomUUID()}\n`,
    {
      mode: 0o600,
    },
  );

  run(resticArguments(['init']));

  startPostgres(sourceContainer);
  await waitForPostgres(sourceContainer);
  run([
    'exec',
    sourceContainer,
    'psql',
    '--username',
    'postgres',
    '--dbname',
    'postgres',
    '--command',
    "CREATE TABLE public._prisma_migrations (id text PRIMARY KEY, finished_at timestamptz, rolled_back_at timestamptz); INSERT INTO public._prisma_migrations VALUES ('smoke', now(), NULL); CREATE TABLE public.backup_sentinel (value text NOT NULL); INSERT INTO public.backup_sentinel VALUES ('METEORA_BACKUP_OK');",
  ]);

  const summary = await pipeDocker(
    [
      'exec',
      sourceContainer,
      'pg_dump',
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      '--dbname',
      'postgres',
      '--username',
      'postgres',
    ],
    resticArguments(
      [
        'backup',
        '--stdin',
        '--stdin-filename',
        'postgres/platform.dump',
        '--tag',
        'meteora-postgres',
        '--json',
      ],
      { stdin: true },
    ),
  );
  const snapshotId = JSON.parse(summary.split('\n').at(-1)).snapshot_id;
  assert.match(snapshotId, /^[0-9a-f]{64}$/);
  const [selectedSnapshot] = JSON.parse(
    run(
      resticArguments([
        'snapshots',
        '--tag',
        'meteora-postgres',
        '--latest',
        '1',
        '--json',
      ]),
    ),
  );
  assert.equal(selectedSnapshot.id, snapshotId);
  run(resticArguments(['check', '--read-data']));

  startPostgres(restoreContainer);
  await waitForPostgres(restoreContainer);
  run([
    'exec',
    restoreContainer,
    'createdb',
    '--username',
    'postgres',
    'restore_drill',
  ]);
  await pipeDocker(
    resticArguments(['dump', snapshotId, 'postgres/platform.dump']),
    [
      'exec',
      '-i',
      restoreContainer,
      'pg_restore',
      '--username',
      'postgres',
      '--dbname',
      'restore_drill',
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
    ],
  );

  const sentinel = run([
    'exec',
    restoreContainer,
    'psql',
    '--username',
    'postgres',
    '--dbname',
    'restore_drill',
    '--tuples-only',
    '--no-align',
    '--command',
    'SELECT value FROM public.backup_sentinel;',
  ]);
  assert.equal(sentinel, 'METEORA_BACKUP_OK');
  process.stdout.write(
    `POSTGRES_BACKUP_SMOKE_COMPLETE snapshot=${snapshotId}\n`,
  );
} finally {
  spawnSync(docker, ['rm', '--force', sourceContainer, restoreContainer], {
    encoding: 'utf8',
  });
  await rm(temporaryRoot, { recursive: true, force: true });
}
