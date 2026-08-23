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

served_fingerprint() {
  timeout 8 openssl s_client \
    -connect "127.0.0.1:$VPN_NODE_PORT" \
    -servername "$VPN_NODE_TLS_HOSTNAME" </dev/null 2>/dev/null |
    openssl x509 -outform DER 2>/dev/null |
    sha256sum | awk '{print $1}'
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
  VPN_NODE_STATE_DIRECTORY="$VPN_NODE_STATE_DIRECTORY" \
    docker compose -f "$compose_file" restart xray >/dev/null
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
  id "$VPN_NODE_TLS_OWNER" >/dev/null
  command -v docker >/dev/null

  local stage backup_cert backup_key expected_fingerprint current_fingerprint
  local stale_stage
  for stale_stage in "$tls_directory"/.renew.*; do
    [[ -d "$stale_stage" ]] || continue
    cleanup_stage "$stale_stage" "$tls_directory"
  done
  stage="$(mktemp -d "$tls_directory/.renew.XXXXXX")"
  backup_cert="$stage/rollback-cert.pem"
  backup_key="$stage/rollback-key.pem"
  trap "cleanup_stage '$stage' '$tls_directory'" EXIT

  cp -p "$tls_directory/cert.pem" "$backup_cert"
  cp -p "$tls_directory/key.pem" "$backup_key"
  install -o "$VPN_NODE_TLS_OWNER" -m 0640 \
    "$lineage/fullchain.pem" "$stage/cert.pem"
  install -o "$VPN_NODE_TLS_OWNER" -m 0640 \
    "$lineage/privkey.pem" "$stage/key.pem"
  chgrp "$VPN_NODE_TLS_GROUP" "$stage/cert.pem" "$stage/key.pem"
  validate_pair "$stage/cert.pem" "$stage/key.pem"

  expected_fingerprint="$(
    openssl x509 -in "$lineage/fullchain.pem" -outform DER |
      sha256sum | awk '{print $1}'
  )"

  if ! mv -f "$stage/cert.pem" "$tls_directory/cert.pem" ||
    ! mv -f "$stage/key.pem" "$tls_directory/key.pem"; then
    rollback "$backup_cert" "$backup_key" "$tls_directory"
    echo 'Could not atomically replace TLS files; previous files were restored.' >&2
    exit 1
  fi

  if ! VPN_NODE_STATE_DIRECTORY="$VPN_NODE_STATE_DIRECTORY" \
    docker compose -f "$compose_file" restart xray >/dev/null; then
    rollback "$backup_cert" "$backup_key" "$tls_directory"
    echo 'Xray restart failed; previous TLS files were restored.' >&2
    exit 1
  fi

  current_fingerprint=''
  for _ in $(seq 1 15); do
    current_fingerprint="$(served_fingerprint || true)"
    [[ "$current_fingerprint" == "$expected_fingerprint" ]] && break
    sleep 1
  done
  if [[ "$current_fingerprint" != "$expected_fingerprint" ]]; then
    rollback "$backup_cert" "$backup_key" "$tls_directory"
    echo 'Xray did not serve the renewed certificate; previous TLS files were restored.' >&2
    exit 1
  fi

  cleanup_stage "$stage" "$tls_directory"
  trap - EXIT
  echo 'XRAY_TLS_DEPLOYED'
}

main "$@"
