import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const backupRoot = fileURLToPath(new URL('.', import.meta.url));
const read = (name) => readFile(`${backupRoot}/${name}`, 'utf8');

const immutableDigest = /@[s]ha256:[0-9a-f]{64}'/;

test('backup runtime pins images and parses policy through an allowlist', async () => {
  const common = await read('common.sh');

  assert.match(common, /restic\/restic:0\.19\.1@sha256:/);
  assert.match(common, /postgres:17\.6-alpine@sha256:/);
  assert.equal(
    (common.match(new RegExp(immutableDigest, 'g')) ?? []).length,
    2,
  );
  assert.match(common, /case "\$key" in/);
  assert.match(common, /BACKUP_KEEP_DAILY \| BACKUP_KEEP_WEEKLY/);
  assert.doesNotMatch(common, /source\s+"?\$BACKUP_POLICY_FILE/);
  assert.doesNotMatch(common, /\beval\b/);
  assert.match(common, /--read-only/);
  assert.match(common, /--cap-drop ALL/);
  assert.match(common, /no-new-privileges/);
});

test('database dump is streamed encrypted and a failed pipeline snapshot is removed by exact id', async () => {
  const script = await read('backup-postgres.sh');

  assert.match(script, /set -Eeuo pipefail/);
  assert.match(script, /pg_dump --format=custom --no-owner --no-privileges/);
  assert.match(script, /\|\s*\n\s*run_restic stdin backup/);
  assert.match(script, /--stdin-filename "\$BACKUP_STDIN_PATH"/);
  assert.match(script, /--json >"\$BACKUP_SUMMARY_FILE"/);
  assert.match(script, /pipeline_status=\("\$\{PIPESTATUS\[@\]\}"\)/);
  assert.match(script, /run_restic none forget "\$snapshot_id" --prune/);
  assert.doesNotMatch(script, /pg_dump[^\n]*>/);
  assert.doesNotMatch(script, /\.dump["']?\s*>/);
});

test('retention and repository data checks are explicit', async () => {
  const [script, policy] = await Promise.all([
    read('backup-postgres.sh'),
    read('backup-policy.env.example'),
  ]);

  assert.match(policy, /^BACKUP_KEEP_DAILY=14$/m);
  assert.match(policy, /^BACKUP_KEEP_WEEKLY=8$/m);
  assert.match(policy, /^BACKUP_KEEP_MONTHLY=12$/m);
  assert.match(policy, /^BACKUP_CHECK_READ_DATA_SUBSET=5%$/m);
  assert.match(script, /--keep-daily "\$BACKUP_KEEP_DAILY"/);
  assert.match(script, /--keep-weekly "\$BACKUP_KEEP_WEEKLY"/);
  assert.match(script, /--keep-monthly "\$BACKUP_KEEP_MONTHLY"/);
  assert.match(script, /--read-data-subset "\$BACKUP_CHECK_READ_DATA_SUBSET"/);
});

test('restore drill selects a tagged snapshot and cannot expose a PostgreSQL listener', async () => {
  const script = await read('restore-drill.sh');

  assert.match(script, /snapshots[\s\S]*--tag "\$BACKUP_TAG"[\s\S]*--latest 1/);
  assert.match(
    script,
    /run_restic none dump[\s\S]*"\$snapshot_id" "\$BACKUP_STDIN_PATH"/,
  );
  assert.doesNotMatch(script, /run_restic none dump\s+\\?\s*latest/);
  assert.match(script, /--network none/);
  assert.doesNotMatch(script, /--publish|-p\s+[0-9]/);
  assert.match(script, /--tmpfs \/var\/lib\/postgresql\/data/);
  assert.match(script, /trap cleanup EXIT INT TERM/);
  assert.match(script, /restore-missing-prisma-migrations/);
  assert.match(script, /restore-has-failed-migrations/);
  assert.match(script, /POSTGRES_RESTORE_DRILL_COMPLETE/);
});

test('systemd schedules are persistent and run hardened one-shot services', async () => {
  const [backupService, backupTimer, drillService, drillTimer] =
    await Promise.all([
      read('systemd/meteora-postgres-backup.service'),
      read('systemd/meteora-postgres-backup.timer'),
      read('systemd/meteora-postgres-restore-drill.service'),
      read('systemd/meteora-postgres-restore-drill.timer'),
    ]);

  for (const service of [backupService, drillService]) {
    assert.match(service, /^Type=oneshot$/m);
    assert.match(service, /^UMask=0077$/m);
    assert.match(service, /^NoNewPrivileges=yes$/m);
    assert.match(service, /^ProtectSystem=strict$/m);
    assert.match(service, /^User=root$/m);
  }
  assert.match(backupTimer, /^OnCalendar=\*-\*-\* 02:15:00 UTC$/m);
  assert.match(backupTimer, /^RandomizedDelaySec=30m$/m);
  assert.match(drillTimer, /^OnCalendar=monthly$/m);
  assert.match(drillTimer, /^RandomizedDelaySec=2h$/m);
  assert.match(backupTimer, /^Persistent=true$/m);
  assert.match(drillTimer, /^Persistent=true$/m);
});

test('examples are non-production and secrets stay outside the checkout', async () => {
  const [environment, documentation] = await Promise.all([
    read('backup.env.example'),
    read('README.md'),
  ]);

  assert.match(environment, /TEST-ONLY fixture/);
  assert.match(environment, /example\.invalid/);
  assert.match(
    environment,
    /^RESTIC_PASSWORD_FILE=\/run\/secrets\/restic-password$/m,
  );
  assert.match(documentation, /\/etc\/meteora\/backup\.env/);
  assert.match(documentation, /не записывается на\s+диск в открытом виде/);
  assert.match(documentation, /не\s+перезаписывают production volume/);
});

test('disposable smoke preserves an encrypted no-network round trip', async () => {
  const smoke = await read('smoke.mjs');

  assert.match(smoke, /TEST_ONLY_/);
  assert.match(smoke, /--network',\s*\n\s*'none'/);
  assert.match(smoke, /pg_dump/);
  assert.match(smoke, /resticArguments\(\['dump', snapshotId/);
  assert.match(smoke, /pg_restore/);
  assert.match(smoke, /METEORA_BACKUP_OK/);
  assert.match(
    smoke,
    /await rm\(temporaryRoot, \{ recursive: true, force: true \}\)/,
  );
  assert.doesNotMatch(smoke, /--publish/);
});
