#!/usr/bin/env bash

set -Eeuo pipefail

readonly NODE_IMAGE='node@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99'
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
readonly SECRET_DIRECTORY='/etc/meteora/platform-secrets'
readonly TARGET_FILE='/etc/meteora/platform-secrets/bot-signing-kek'
readonly LOCK_FILE='/run/lock/meteora-bot-signing-kek.lock'
readonly API_SECRET_GROUP_ID='29001'
readonly API_SECRET_GROUP_NAME='meteora-api-secret'

fail() {
  printf 'BOT_SIGNING_KEK_ERROR code=%s\n' "$1" >&2
  exit 1
}

require_empty_group() {
  local expected_name="$1"
  local expected_gid="$2"
  local record
  local actual_name
  local actual_gid
  local members

  record="$(getent group "$expected_gid")" || fail 'missing-api-secret-group'
  IFS=: read -r actual_name _ actual_gid members <<<"$record"
  [[ "$actual_name" == "$expected_name" && "$actual_gid" == "$expected_gid" ]] ||
    fail 'invalid-api-secret-group'
  [[ -z "$members" ]] || fail 'api-secret-group-has-host-members'
}

[[ "$(id -u)" == '0' ]] || fail 'initializer-requires-root'
command -v docker >/dev/null 2>&1 || fail 'missing-command-docker'
command -v flock >/dev/null 2>&1 || fail 'missing-command-flock'
command -v getent >/dev/null 2>&1 || fail 'missing-command-getent'
require_empty_group "$API_SECRET_GROUP_NAME" "$API_SECRET_GROUP_ID"
[[ -d "$SECRET_DIRECTORY" && ! -L "$SECRET_DIRECTORY" ]] ||
  fail 'missing-platform-secret-directory'
mode="$(stat -c '%a' -- "$SECRET_DIRECTORY")"
owner="$(stat -c '%u' -- "$SECRET_DIRECTORY")"
[[ "$owner" == '0' ]] || fail 'invalid-platform-secret-directory-owner'
(( (8#$mode & 077) == 0 )) || fail 'insecure-platform-secret-directory-mode'
[[ ! -e "$TARGET_FILE" && ! -L "$TARGET_FILE" ]] ||
  fail 'bot-kek-already-exists'

exec 9>"$LOCK_FILE"
flock -n 9 || fail 'initializer-already-running'

docker run \
  --rm \
  --network none \
  --read-only \
  --cap-drop ALL \
  --group-add "$API_SECRET_GROUP_ID" \
  --security-opt no-new-privileges \
  --tmpfs '/tmp:rw,noexec,nosuid,nodev,size=32m' \
  --mount "type=bind,src=$SCRIPT_DIR,dst=/tool,readonly" \
  --mount "type=bind,src=$SECRET_DIRECTORY,dst=/etc/meteora/platform-secrets" \
  --entrypoint node \
  "$NODE_IMAGE" \
  /tool/generate-bot-signing-kek.mjs

printf 'BOT_SIGNING_KEK_INITIALIZATION_COMPLETE\n'
