#!/usr/bin/env bash

set -Eeuo pipefail

readonly RESTIC_IMAGE='restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510'
# shellcheck disable=SC2034
readonly RESTORE_POSTGRES_IMAGE='postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94'
# shellcheck disable=SC2034
readonly BACKUP_TAG='meteora-postgres'
# shellcheck disable=SC2034
readonly BACKUP_STDIN_PATH='postgres/platform.dump'

BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-/etc/meteora/backup.env}"
BACKUP_POLICY_FILE="${BACKUP_POLICY_FILE:-/etc/meteora/backup-policy.env}"
BACKUP_SECRET_DIR="${BACKUP_SECRET_DIR:-/etc/meteora/backup-secrets}"
BACKUP_LOCK_FILE="${BACKUP_LOCK_FILE:-/run/lock/meteora-postgres-backup.lock}"
PLATFORM_ENV_FILE="${PLATFORM_ENV_FILE:-/etc/meteora/platform.env}"
PLATFORM_COMPOSE_FILE="${PLATFORM_COMPOSE_FILE:-/opt/meteora/current/infra/docker-compose.production.yml}"
BACKUP_LOCAL_REPOSITORY_DIR="${BACKUP_LOCAL_REPOSITORY_DIR:-}"

fail() {
  printf 'BACKUP_ERROR code=%s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing-command-$1"
}

require_absolute_path() {
  local value="$1"
  local label="$2"
  [[ "$value" == /* && "$value" != *$'\n'* && "$value" != *$'\r'* ]] ||
    fail "invalid-$label-path"
}

require_private_file() {
  local path="$1"
  local label="$2"
  local mode
  local owner

  require_absolute_path "$path" "$label"
  [[ -f "$path" && ! -L "$path" ]] || fail "missing-$label"
  mode="$(stat -c '%a' -- "$path")"
  owner="$(stat -c '%u' -- "$path")"
  (( (8#$mode & 077) == 0 )) || fail "insecure-$label-mode"
  [[ "$owner" == "$(id -u)" ]] || fail "invalid-$label-owner"
}

require_private_directory() {
  local path="$1"
  local label="$2"
  local mode
  local owner

  require_absolute_path "$path" "$label"
  [[ -d "$path" && ! -L "$path" ]] || fail "missing-$label"
  mode="$(stat -c '%a' -- "$path")"
  owner="$(stat -c '%u' -- "$path")"
  (( (8#$mode & 077) == 0 )) || fail "insecure-$label-mode"
  [[ "$owner" == "$(id -u)" ]] || fail "invalid-$label-owner"
}

require_restic_runtime() {
  require_command docker
  require_command flock
  require_private_file "$BACKUP_ENV_FILE" 'backup-env'
  require_private_file "$BACKUP_POLICY_FILE" 'backup-policy'
  require_private_directory "$BACKUP_SECRET_DIR" 'backup-secret-dir'
  require_private_file "$BACKUP_SECRET_DIR/restic-password" 'restic-password'
  if [[ -n "$BACKUP_LOCAL_REPOSITORY_DIR" ]]; then
    require_private_directory "$BACKUP_LOCAL_REPOSITORY_DIR" 'local-repository'
  fi
}

require_platform_runtime() {
  require_absolute_path "$PLATFORM_ENV_FILE" 'platform-env'
  require_absolute_path "$PLATFORM_COMPOSE_FILE" 'platform-compose'
  [[ -f "$PLATFORM_ENV_FILE" && ! -L "$PLATFORM_ENV_FILE" ]] ||
    fail 'missing-platform-env'
  [[ -f "$PLATFORM_COMPOSE_FILE" && ! -L "$PLATFORM_COMPOSE_FILE" ]] ||
    fail 'missing-platform-compose'
}

load_policy() {
  local line
  local key
  local value

  BACKUP_KEEP_DAILY=''
  BACKUP_KEEP_WEEKLY=''
  BACKUP_KEEP_MONTHLY=''
  BACKUP_CHECK_READ_DATA_SUBSET=''

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" =~ ^([A-Z_]+)=([^[:space:]]+)$ ]] || fail 'invalid-policy-line'
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    case "$key" in
      BACKUP_KEEP_DAILY | BACKUP_KEEP_WEEKLY | BACKUP_KEEP_MONTHLY | BACKUP_CHECK_READ_DATA_SUBSET)
        printf -v "$key" '%s' "$value"
        ;;
      *) fail 'unknown-policy-key' ;;
    esac
  done <"$BACKUP_POLICY_FILE"

  [[ "$BACKUP_KEEP_DAILY" =~ ^[1-9][0-9]*$ ]] || fail 'invalid-keep-daily'
  [[ "$BACKUP_KEEP_WEEKLY" =~ ^[1-9][0-9]*$ ]] || fail 'invalid-keep-weekly'
  [[ "$BACKUP_KEEP_MONTHLY" =~ ^[1-9][0-9]*$ ]] || fail 'invalid-keep-monthly'
  [[ "$BACKUP_CHECK_READ_DATA_SUBSET" =~ ^([1-9]|[1-9][0-9]|100)%$ ]] ||
    fail 'invalid-check-subset'
}

acquire_backup_lock() {
  require_absolute_path "$BACKUP_LOCK_FILE" 'backup-lock'
  exec 9>"$BACKUP_LOCK_FILE"
  flock -n 9 || fail 'operation-already-running'
}

run_restic() {
  local stdin_mode="$1"
  shift
  local docker_arguments=(
    run
    --rm
    --read-only
    --cap-drop ALL
    --security-opt no-new-privileges
    --tmpfs '/tmp:rw,noexec,nosuid,nodev,size=64m'
    --env-file "$BACKUP_ENV_FILE"
    --env HOME=/tmp
    --env XDG_CACHE_HOME=/tmp/cache
    --mount "type=bind,src=$BACKUP_SECRET_DIR,dst=/run/secrets,readonly"
  )

  [[ "$stdin_mode" == 'stdin' ]] && docker_arguments+=(-i)
  [[ "$stdin_mode" == 'none' ]] || [[ "$stdin_mode" == 'stdin' ]] ||
    fail 'invalid-restic-stdin-mode'

  if [[ -n "$BACKUP_LOCAL_REPOSITORY_DIR" ]]; then
    docker_arguments+=(
      --mount "type=bind,src=$BACKUP_LOCAL_REPOSITORY_DIR,dst=/repository"
    )
  fi

  docker "${docker_arguments[@]}" "$RESTIC_IMAGE" "$@"
}

run_platform_compose() {
  docker compose \
    --env-file "$PLATFORM_ENV_FILE" \
    -f "$PLATFORM_COMPOSE_FILE" \
    "$@"
}
