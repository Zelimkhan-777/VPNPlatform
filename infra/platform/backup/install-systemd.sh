#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

[[ "$(id -u)" == '0' ]] || fail 'installer-requires-root'
require_restic_runtime
require_platform_runtime

for unit in \
  meteora-postgres-backup.service \
  meteora-postgres-backup.timer \
  meteora-postgres-restore-drill.service \
  meteora-postgres-restore-drill.timer; do
  install \
    --owner root \
    --group root \
    --mode 0644 \
    "$SCRIPT_DIR/systemd/$unit" \
    "/etc/systemd/system/$unit"
done

systemctl daemon-reload
systemctl enable --now \
  meteora-postgres-backup.timer \
  meteora-postgres-restore-drill.timer

printf 'POSTGRES_BACKUP_SYSTEMD_INSTALLED\n'
