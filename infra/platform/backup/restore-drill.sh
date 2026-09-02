#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

require_restic_runtime
load_policy
acquire_backup_lock

DRILL_CONTAINER="meteora-postgres-restore-drill-$(date -u +%Y%m%d%H%M%S)-$$"
readonly DRILL_CONTAINER

cleanup() {
  docker rm --force "$DRILL_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

printf 'POSTGRES_RESTORE_DRILL_STARTED\n'
run_restic none check \
  --read-data-subset "$BACKUP_CHECK_READ_DATA_SUBSET" \
  --quiet

snapshot_id="$(
  run_restic none snapshots \
    --tag "$BACKUP_TAG" \
    --latest 1 \
    --json |
    sed -n 's/.*"id":[[:space:]]*"\([0-9a-f]\{64\}\)".*/\1/p' |
    tail -n 1
)"
[[ "$snapshot_id" =~ ^[0-9a-f]{64}$ ]] || fail 'backup-snapshot-not-found'

docker run \
  --detach \
  --name "$DRILL_CONTAINER" \
  --network none \
  --security-opt no-new-privileges \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=1g \
  --tmpfs /var/run/postgresql:rw,nosuid,nodev,size=16m \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  "$RESTORE_POSTGRES_IMAGE" >/dev/null

ready='no'
for _ in $(seq 1 90); do
  if docker exec "$DRILL_CONTAINER" pg_isready --username postgres >/dev/null 2>&1; then
    ready='yes'
    break
  fi
  sleep 1
done
[[ "$ready" == 'yes' ]] || fail 'restore-postgres-not-ready'

docker exec "$DRILL_CONTAINER" createdb --username postgres restore_drill
run_restic none dump \
  "$snapshot_id" "$BACKUP_STDIN_PATH" |
  docker exec -i "$DRILL_CONTAINER" pg_restore \
    --username postgres \
    --dbname restore_drill \
    --no-owner \
    --no-privileges \
    --exit-on-error

table_count="$(
  docker exec "$DRILL_CONTAINER" psql \
    --username postgres \
    --dbname restore_drill \
    --tuples-only \
    --no-align \
    --command "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';"
)"
[[ "$table_count" =~ ^[1-9][0-9]*$ ]] || fail 'restore-has-no-public-tables'

migration_table="$(
  docker exec "$DRILL_CONTAINER" psql \
    --username postgres \
    --dbname restore_drill \
    --tuples-only \
    --no-align \
    --command "SELECT to_regclass('public._prisma_migrations') IS NOT NULL;"
)"
[[ "$migration_table" == 't' ]] || fail 'restore-missing-prisma-migrations'

failed_migrations="$(
  docker exec "$DRILL_CONTAINER" psql \
    --username postgres \
    --dbname restore_drill \
    --tuples-only \
    --no-align \
    --command "SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;"
)"
[[ "$failed_migrations" == '0' ]] || fail 'restore-has-failed-migrations'

printf 'POSTGRES_RESTORE_DRILL_COMPLETE snapshot=%s tables=%s failed_migrations=0\n' \
  "$snapshot_id" "$table_count"
