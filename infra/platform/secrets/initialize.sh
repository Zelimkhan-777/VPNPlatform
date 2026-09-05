#!/usr/bin/env bash

set -Eeuo pipefail

readonly NODE_IMAGE='node@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99'
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
readonly METEORA_DIRECTORY='/etc/meteora'
readonly CONFIG_FILE='/etc/meteora/platform-config.env'
readonly TOKEN_DIRECTORY='/etc/meteora/telegram-secrets'
readonly TOKEN_FILE='/etc/meteora/telegram-secrets/bot-token'
readonly TARGET_FILE='/etc/meteora/platform.env'
readonly LOCK_FILE='/run/lock/meteora-platform-environment.lock'

fail() {
  printf 'PLATFORM_ENV_ERROR code=%s\n' "$1" >&2
  exit 1
}

require_private_path() {
  local path="$1"
  local expected_type="$2"
  local label="$3"
  local mode
  local owner

  [[ ! -L "$path" ]] || fail "invalid-$label-type"
  if [[ "$expected_type" == 'file' ]]; then
    [[ -f "$path" ]] || fail "missing-$label"
  else
    [[ -d "$path" ]] || fail "missing-$label"
  fi
  mode="$(stat -c '%a' -- "$path")"
  owner="$(stat -c '%u' -- "$path")"
  [[ "$owner" == '0' ]] || fail "invalid-$label-owner"
  (( (8#$mode & 077) == 0 )) || fail "insecure-$label-mode"
}

require_bot_token() {
  local mode
  local owner
  local group
  [[ -f "$TOKEN_FILE" && ! -L "$TOKEN_FILE" ]] || fail 'missing-telegram-token'
  mode="$(stat -c '%a' -- "$TOKEN_FILE")"
  owner="$(stat -c '%u' -- "$TOKEN_FILE")"
  group="$(stat -c '%g' -- "$TOKEN_FILE")"
  [[ "$owner" == '0' && "$group" == '29002' && "$mode" == '440' ]] ||
    fail 'invalid-telegram-token-access'
}

require_bot_token_directory() {
  local mode
  local owner
  local group
  [[ -d "$TOKEN_DIRECTORY" && ! -L "$TOKEN_DIRECTORY" ]] ||
    fail 'missing-telegram-secret-directory'
  mode="$(stat -c '%a' -- "$TOKEN_DIRECTORY")"
  owner="$(stat -c '%u' -- "$TOKEN_DIRECTORY")"
  group="$(stat -c '%g' -- "$TOKEN_DIRECTORY")"
  [[ "$owner" == '0' && "$group" == '29002' && "$mode" == '750' ]] ||
    fail 'invalid-telegram-secret-directory-access'
}

[[ "$(id -u)" == '0' ]] || fail 'initializer-requires-root'
command -v docker >/dev/null 2>&1 || fail 'missing-command-docker'
command -v flock >/dev/null 2>&1 || fail 'missing-command-flock'
require_private_path "$METEORA_DIRECTORY" directory 'meteora-directory'
require_private_path "$CONFIG_FILE" file 'platform-config'
require_bot_token_directory
require_bot_token
[[ ! -e "$TARGET_FILE" && ! -L "$TARGET_FILE" ]] ||
  fail 'platform-environment-already-exists'

exec 9>"$LOCK_FILE"
flock -n 9 || fail 'initializer-already-running'

docker run \
  --rm \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs '/tmp:rw,noexec,nosuid,nodev,size=32m' \
  --mount "type=bind,src=$SCRIPT_DIR,dst=/tool,readonly" \
  --mount "type=bind,src=$METEORA_DIRECTORY,dst=/etc/meteora" \
  --entrypoint node \
  "$NODE_IMAGE" \
  /tool/generate-platform-environment.mjs

printf 'PLATFORM_ENV_INITIALIZATION_COMPLETE\n'
