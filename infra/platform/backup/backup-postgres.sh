#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

require_restic_runtime
require_platform_runtime
load_policy
acquire_backup_lock

BACKUP_SUMMARY_FILE="$(mktemp /run/meteora-postgres-backup.XXXXXX.json)"
readonly BACKUP_SUMMARY_FILE
cleanup() {
  rm -f -- "$BACKUP_SUMMARY_FILE"
}
trap cleanup EXIT INT TERM

printf 'POSTGRES_BACKUP_STARTED\n'
set +e
# shellcheck disable=SC2016
run_platform_compose exec -T postgres sh -ceu \
  'exec pg_dump --format=custom --no-owner --no-privileges --dbname "$POSTGRES_DB" --username "$POSTGRES_USER"' |
  run_restic stdin backup \
    --stdin \
    --stdin-filename "$BACKUP_STDIN_PATH" \
    --tag "$BACKUP_TAG" \
    --json >"$BACKUP_SUMMARY_FILE"
pipeline_status=("${PIPESTATUS[@]}")
set -e

snapshot_id="$(sed -n 's/.*"snapshot_id":[[:space:]]*"\([0-9a-f]\{64\}\)".*/\1/p' "$BACKUP_SUMMARY_FILE" | tail -n 1)"
if [[ "${pipeline_status[0]}" != '0' || "${pipeline_status[1]}" != '0' ]]; then
  if [[ "$snapshot_id" =~ ^[0-9a-f]{64}$ ]]; then
    run_restic none forget "$snapshot_id" --prune --quiet ||
      fail 'failed-backup-snapshot-needs-manual-removal'
  fi
  [[ "${pipeline_status[1]}" == '0' ]] || fail 'restic-backup-failed'
  fail 'postgres-dump-failed'
fi
[[ "$snapshot_id" =~ ^[0-9a-f]{64}$ ]] || fail 'missing-backup-snapshot-id'
printf 'POSTGRES_BACKUP_CREATED\n'

run_restic none forget \
  --tag "$BACKUP_TAG" \
  --keep-daily "$BACKUP_KEEP_DAILY" \
  --keep-weekly "$BACKUP_KEEP_WEEKLY" \
  --keep-monthly "$BACKUP_KEEP_MONTHLY" \
  --prune \
  --quiet
printf 'POSTGRES_BACKUP_RETENTION_COMPLETE\n'

run_restic none check \
  --read-data-subset "$BACKUP_CHECK_READ_DATA_SUBSET" \
  --quiet
printf 'POSTGRES_BACKUP_CHECK_COMPLETE\n'
