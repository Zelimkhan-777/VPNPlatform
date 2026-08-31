#!/usr/bin/env bash
set -Eeuo pipefail

report_error() {
  local status="$?"
  printf 'XRAY_TLS_DEPLOY_FAILED status=%s line=%s command=%s\n' \
    "$status" "${BASH_LINENO[0]}" "$BASH_COMMAND" >&2
  exit "$status"
}
trap report_error ERR

config_path='/etc/vpn-platform/xray-tls-renew.conf'
cleanup_stage_path=''
cleanup_tls_directory=''

load_config() {
  if [[ ! -r "$config_path" ]]; then
    echo "Missing renewal configuration: $config_path" >&2
    return 1
  fi

  local owner mode
  owner="$(stat -c '%u' "$config_path")"
  mode="$(stat -c '%a' "$config_path")"
  if [[ "$owner" != '0' ]] || (( (8#$mode & 8#22) != 0 )); then
    echo 'Renewal configuration must be root-owned and not group/world-writable.' >&2
    return 1
  fi

  # The file is installed by the root-only installer and contains no secrets.
  # shellcheck disable=SC1090
  source "$config_path"

  : "${VPN_PLATFORM_PROJECT_ROOT:?Missing VPN_PLATFORM_PROJECT_ROOT}"
  : "${VPN_NODE_STATE_DIRECTORY:?Missing VPN_NODE_STATE_DIRECTORY}"
  : "${VPN_NODE_TLS_HOSTNAME:?Missing VPN_NODE_TLS_HOSTNAME}"
  : "${VPN_NODE_TLS_OWNER:?Missing VPN_NODE_TLS_OWNER}"
  : "${VPN_NODE_TLS_GROUP:?Missing VPN_NODE_TLS_GROUP}"
  : "${VPN_NODE_PORT:?Missing VPN_NODE_PORT}"

  [[ "$VPN_PLATFORM_PROJECT_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]]
  [[ "$VPN_NODE_STATE_DIRECTORY" =~ ^[a-z0-9][a-z0-9-]*$ ]]
  [[ "$VPN_NODE_TLS_HOSTNAME" =~ ^[A-Za-z0-9.-]+$ ]]
  [[ "$VPN_NODE_TLS_OWNER" =~ ^[a-z_][a-z0-9_-]*$ ]]
  [[ "$VPN_NODE_TLS_GROUP" =~ ^[0-9]+$ ]]
  [[ "$VPN_NODE_PORT" =~ ^[0-9]+$ ]]
}

validate_pair() {
  local cert="$1"
  local key="$2"
  local cert_public_key key_public_key

  test -s "$cert"
  test -s "$key"
  openssl x509 -in "$cert" -noout -checkend 86400 >/dev/null
  openssl x509 -in "$cert" -noout -checkhost "$VPN_NODE_TLS_HOSTNAME" >/dev/null

  cert_public_key="$(
    openssl x509 -in "$cert" -pubkey -noout |
      openssl pkey -pubin -outform DER 2>/dev/null |
      sha256sum | awk '{print $1}'
  )"
  key_public_key="$(
    openssl pkey -in "$key" -pubout -outform DER 2>/dev/null |
      sha256sum | awk '{print $1}'
  )"
  [[ -n "$cert_public_key" && "$cert_public_key" == "$key_public_key" ]]
}

lifecycle_script() {
  printf '%s/infra/vpn-node/xray-serving-lifecycle.sh' \
    "$VPN_PLATFORM_PROJECT_ROOT"
}

run_xray_lifecycle() {
  VPN_NODE_STATE_DIRECTORY="$VPN_NODE_STATE_DIRECTORY" \
    /bin/bash "$(lifecycle_script)" "$@"
}

cleanup_stage() {
  local stage="$1"
  local tls_directory="$2"
  [[ "$stage" == "$tls_directory"/.renew.* ]]
  rm -f \
    "$stage/cert.pem" \
    "$stage/key.pem" \
    "$stage/rollback-cert.pem" \
    "$stage/rollback-key.pem"
  rmdir "$stage" 2>/dev/null || true
}

cleanup_current_stage() {
  [[ -n "$cleanup_stage_path" && -n "$cleanup_tls_directory" ]] || return 0
  cleanup_stage "$cleanup_stage_path" "$cleanup_tls_directory"
}

rollback() {
  local backup_cert="$1"
  local backup_key="$2"
  local tls_directory="$3"
  local compose_file="$VPN_PLATFORM_PROJECT_ROOT/infra/docker-compose.vpn-node.yml"

  install -o "$VPN_NODE_TLS_OWNER" -m 0640 \
    "$backup_cert" "$tls_directory/cert.pem"
  install -o "$VPN_NODE_TLS_OWNER" -m 0640 \
    "$backup_key" "$tls_directory/key.pem"
  chgrp "$VPN_NODE_TLS_GROUP" \
    "$tls_directory/cert.pem" "$tls_directory/key.pem"
  run_xray_lifecycle stop-and-verify "$compose_file"
}

main() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo 'The Xray certificate deploy hook must run as root.' >&2
    exit 1
  fi

  load_config

  if [[ "${1:-}" == '--validate-only' ]]; then
    [[ $# -eq 2 ]]
    validate_pair "$2/fullchain.pem" "$2/privkey.pem"
    echo 'TLS_PAIR_VALID'
    exit 0
  fi
  [[ $# -eq 0 ]]

  local lineage="${RENEWED_LINEAGE:-}"
  if [[ -z "$lineage" ]]; then
    echo 'RENEWED_LINEAGE is required.' >&2
    exit 1
  fi
  if [[ -n "${RENEWED_DOMAINS:-}" ]] &&
    ! grep -Fqw -- "$VPN_NODE_TLS_HOSTNAME" <<<"$RENEWED_DOMAINS"; then
    exit 0
  fi

  local canonical_lineage canonical_cert canonical_key
  canonical_lineage="$(readlink -f "$lineage")"
  canonical_cert="$(readlink -f "$lineage/fullchain.pem")"
  canonical_key="$(readlink -f "$lineage/privkey.pem")"
  if [[ "$lineage" != /etc/letsencrypt/live/* ]] ||
    [[ "$canonical_lineage" != "$lineage" ]] ||
    [[ "$canonical_cert" != /etc/letsencrypt/archive/* ]] ||
    [[ "$canonical_key" != /etc/letsencrypt/archive/* ]]; then
    echo 'RENEWED_LINEAGE is outside the Certbot live/archive directories.' >&2
    exit 1
  fi
  validate_pair "$lineage/fullchain.pem" "$lineage/privkey.pem"

  local tls_directory="$VPN_PLATFORM_PROJECT_ROOT/var/$VPN_NODE_STATE_DIRECTORY/tls"
  local compose_file="$VPN_PLATFORM_PROJECT_ROOT/infra/docker-compose.vpn-node.yml"
  test -d "$tls_directory"
  test -r "$tls_directory/cert.pem"
  test -r "$tls_directory/key.pem"
  test -r "$compose_file"
  test -r "$(lifecycle_script)"
  id "$VPN_NODE_TLS_OWNER" >/dev/null
  command -v docker >/dev/null

  local stage backup_cert backup_key
  local stale_stage
  for stale_stage in "$tls_directory"/.renew.*; do
    [[ -d "$stale_stage" ]] || continue
    cleanup_stage "$stale_stage" "$tls_directory"
  done
  stage="$(mktemp -d "$tls_directory/.renew.XXXXXX")"
  backup_cert="$stage/rollback-cert.pem"
  backup_key="$stage/rollback-key.pem"
  cleanup_stage_path="$stage"
  cleanup_tls_directory="$tls_directory"
  trap cleanup_current_stage EXIT

  cp -p "$tls_directory/cert.pem" "$backup_cert"
  cp -p "$tls_directory/key.pem" "$backup_key"
  install -o "$VPN_NODE_TLS_OWNER" -m 0640 \
    "$lineage/fullchain.pem" "$stage/cert.pem"
  install -o "$VPN_NODE_TLS_OWNER" -m 0640 \
    "$lineage/privkey.pem" "$stage/key.pem"
  chgrp "$VPN_NODE_TLS_GROUP" "$stage/cert.pem" "$stage/key.pem"
  validate_pair "$stage/cert.pem" "$stage/key.pem"

  if ! mv -f "$stage/cert.pem" "$tls_directory/cert.pem" ||
    ! mv -f "$stage/key.pem" "$tls_directory/key.pem"; then
    rollback "$backup_cert" "$backup_key" "$tls_directory"
    echo 'Could not atomically replace TLS files; previous files were restored.' >&2
    exit 1
  fi

  # Stop is verified, then systemd restarts node-agent so resume cannot miss
  # the cached-fingerprint shortcut. Agent reload/read-back stays the owner.
  if ! run_xray_lifecycle handoff "$compose_file"; then
    rollback "$backup_cert" "$backup_key" "$tls_directory"
    echo 'Could not stop Xray or hand off serving to node-agent; previous TLS files were restored.' >&2
    exit 1
  fi

  # Automatic renewals do not re-run the installer. This wait is the hook
  # success barrier; do not start Xray from Certbot on timeout.
  local expected_fingerprint
  expected_fingerprint="$(
    openssl x509 -in "$lineage/fullchain.pem" -outform DER |
      sha256sum | awk '{print $1}'
  )"
  if [[ -z "$expected_fingerprint" ]] ||
    ! run_xray_lifecycle wait-served-fingerprint \
      "$VPN_NODE_TLS_HOSTNAME" "$VPN_NODE_PORT" "$expected_fingerprint"; then
    rollback "$backup_cert" "$backup_key" "$tls_directory"
    echo 'Xray did not serve the renewed certificate after node-agent handoff; previous TLS files were restored.' >&2
    exit 1
  fi

  cleanup_current_stage
  cleanup_stage_path=''
  cleanup_tls_directory=''
  trap - EXIT
  echo 'XRAY_TLS_DEPLOYED'
}

main "$@"
