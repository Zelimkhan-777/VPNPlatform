#!/usr/bin/env bash

set -Eeuo pipefail

readonly NODE_IMAGE='node@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99'
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
readonly METEORA_DIRECTORY='/etc/meteora'
readonly TARGET_FILE='/etc/meteora/platform.env'

fail() {
  printf 'PLATFORM_ENV_ERROR code=%s\n' "$1" >&2
  exit 1
}

[[ "$(id -u)" == '0' ]] || fail 'validator-requires-root'
command -v docker >/dev/null 2>&1 || fail 'missing-command-docker'
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
