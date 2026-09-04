#!/usr/bin/env bash

set -Eeuo pipefail

readonly NODE_IMAGE='node@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99'
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
readonly METEORA_DIRECTORY='/etc/meteora'
readonly TARGET_FILE='/etc/meteora/platform.env'
readonly API_SECRET_GROUP_ID='29001'
readonly API_SECRET_GROUP_NAME='meteora-api-secret'
readonly BOT_SECRET_GROUP_ID='29002'
readonly BOT_SECRET_GROUP_NAME='meteora-bot-secret'

fail() {
  printf 'PLATFORM_ENV_ERROR code=%s\n' "$1" >&2
  exit 1
}

require_empty_group() {
  local expected_name="$1"
  local expected_gid="$2"
  local record
  local actual_name
  local actual_gid
  local members

  record="$(getent group "$expected_gid")" || fail "missing-$expected_name"
  IFS=: read -r actual_name _ actual_gid members <<<"$record"
  [[ "$actual_name" == "$expected_name" && "$actual_gid" == "$expected_gid" ]] ||
    fail "invalid-$expected_name"
  [[ -z "$members" ]] || fail "$expected_name-has-host-members"
}

[[ "$(id -u)" == '0' ]] || fail 'validator-requires-root'
command -v docker >/dev/null 2>&1 || fail 'missing-command-docker'
command -v getent >/dev/null 2>&1 || fail 'missing-command-getent'
require_empty_group "$API_SECRET_GROUP_NAME" "$API_SECRET_GROUP_ID"
require_empty_group "$BOT_SECRET_GROUP_NAME" "$BOT_SECRET_GROUP_ID"
[[ -f "$TARGET_FILE" && ! -L "$TARGET_FILE" ]] ||
  fail 'missing-platform-environment'
mode="$(stat -c '%a' -- "$TARGET_FILE")"
owner="$(stat -c '%u' -- "$TARGET_FILE")"
[[ "$owner" == '0' ]] || fail 'invalid-platform-environment-owner'
(( (8#$mode & 077) == 0 )) || fail 'insecure-platform-environment-mode'

docker run \
  --rm \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs '/tmp:rw,noexec,nosuid,nodev,size=32m' \
  --mount "type=bind,src=$SCRIPT_DIR,dst=/tool,readonly" \
  --mount "type=bind,src=$METEORA_DIRECTORY,dst=/etc/meteora,readonly" \
  --entrypoint node \
  "$NODE_IMAGE" \
  /tool/validate-platform-environment.mjs
