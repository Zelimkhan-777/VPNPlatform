#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

require_restic_runtime
acquire_backup_lock

printf 'BACKUP_REPOSITORY_INIT_STARTED\n'
run_restic none init
printf 'BACKUP_REPOSITORY_INIT_COMPLETE\n'
