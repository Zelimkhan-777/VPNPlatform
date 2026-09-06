#!/usr/bin/env bash

set -Eeuo pipefail

readonly EXPECTED_HOSTNAME='platform-1'
readonly EXPECTED_OS_ID='ubuntu'
readonly EXPECTED_OS_VERSION='24.04'
readonly PLATFORM_ENV_FILE='/etc/meteora/platform.env'
SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIRECTORY
REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIRECTORY/../.." && pwd -P)"
readonly REPOSITORY_ROOT

fail() {
  printf 'PLATFORM_PREFLIGHT_ERROR code=%s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'Usage: sudo bash infra/platform/preflight.sh --expected-public-ip <IPv4>\n' >&2
  exit 2
}

is_ipv4() {
  local value="$1"
  local octet
  local -a octets
  [[ "$value" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  IFS='.' read -r -a octets <<<"$value"
  for octet in "${octets[@]}"; do
    [[ "$octet" =~ ^0$|^[1-9][0-9]{0,2}$ ]] || return 1
    ((10#$octet <= 255)) || return 1
  done
}

read_strict_value() {
  local file="$1"
  local key="$2"
  local value
  value="$(awk -F= -v expected="$key" '$1 == expected { print substr($0, index($0, "=") + 1) }' "$file")"
  [[ -n "$value" ]] || fail "missing-${key,,}"
  printf '%s' "$value"
}

assert_service_active() {
  local service="$1"
  [[ "$(systemctl is-active "$service")" == 'active' ]] ||
    fail "inactive-service-$service"
}

assert_sshd_setting() {
  local key="$1"
  local expected="$2"
  local actual
  actual="$(sshd -T | awk -v expected="$key" '$1 == expected { print $2 }')"
  [[ "$actual" == "$expected" ]] || fail "invalid-sshd-$key"
}

assert_ufw_status() {
  local ufw_status="$1"
  local firewall_rules
  local firewall_rule
  local ipv4_ssh_rules=0
  local ipv6_ssh_rules=0

  grep -Fqx 'Status: active' <<<"$ufw_status" || fail 'ufw-inactive'
  grep -Eq '^Default: deny \(incoming\), allow \(outgoing\), (deny|disabled) \(routed\)$' \
    <<<"$ufw_status" || fail 'ufw-default-policy'
  firewall_rules="$(
    awk '
      found && NF { print }
      /^--[[:space:]]+------[[:space:]]+----[[:space:]]*$/ { found = 1 }
      END { if (!found) exit 1 }
    ' <<<"$ufw_status"
  )" || fail 'invalid-ufw-rule-table'
  [[ -n "$firewall_rules" ]] || fail 'ufw-ssh-not-limited'

  while IFS= read -r firewall_rule; do
    if [[ "$firewall_rule" =~ ^22/tcp[[:space:]]+LIMIT[[:space:]]+IN[[:space:]]+Anywhere$ ]]; then
      ((ipv4_ssh_rules += 1))
    elif [[ "$firewall_rule" =~ ^22/tcp[[:space:]]+\(v6\)[[:space:]]+LIMIT[[:space:]]+IN[[:space:]]+Anywhere[[:space:]]+\(v6\)$ ]]; then
      ((ipv6_ssh_rules += 1))
    else
      fail 'unexpected-ufw-rule'
    fi
  done <<<"$firewall_rules"

  ((ipv4_ssh_rules == 1)) || fail 'ufw-ssh-not-limited'
  ((ipv6_ssh_rules <= 1)) || fail 'duplicate-ufw-ipv6-ssh-rule'
}

assert_public_listeners() {
  local listener_output
  local protocol
  local local_address
  local -a listener_fields

  listener_output="$(ss -H -lntu)" || fail 'listener-scan-failed'
  [[ -n "$listener_output" ]] || fail 'listener-scan-empty'
  while read -r -a listener_fields; do
    ((${#listener_fields[@]} == 6)) || fail 'invalid-listener-scan-output'
    protocol="${listener_fields[0]}"
    local_address="${listener_fields[4]}"
    [[ "$protocol" =~ ^(tcp|udp)$ && -n "$local_address" ]] ||
      fail 'invalid-listener-scan-output'
    case "$protocol $local_address" in
      tcp\ 127.* | udp\ 127.* | tcp\ \[::1\]:* | udp\ \[::1\]:*) ;;
      tcp\ *:22) ;;
      *) fail 'unexpected-public-listener' ;;
    esac
  done <<<"$listener_output"
}

assert_domain_dns() {
  local domain="$1"
  local key="$2"
  local expected_public_ip="$3"
  local ipv4_output
  local addresses
  local address
  local all_address_output
  local ipv6_addresses

  ipv4_output="$(getent ahostsv4 "$domain")" || fail "dns-query-failed-${key,,}"
  addresses="$(awk '$2 == "STREAM" { print $1 }' <<<"$ipv4_output" | sort -u)"
  [[ -n "$addresses" ]] || fail "dns-missing-${key,,}"
  while IFS= read -r address; do
    [[ "$address" == "$expected_public_ip" ]] || fail "dns-mismatch-${key,,}"
  done <<<"$addresses"

  all_address_output="$(getent --no-addrconfig ahosts "$domain")" ||
    fail "dns-query-failed-${key,,}"
  ipv6_addresses="$(
    awk '$2 == "STREAM" && $1 ~ /:/ && tolower($1) !~ /^::ffff:/ { print $1 }' \
      <<<"$all_address_output" | sort -u
  )"
  [[ -z "$ipv6_addresses" ]] || fail "dns-unexpected-aaaa-${key,,}"
}

main() {
  local expected_public_ip=''
  local os_id
  local os_version
  local ufw_status
  local domain

  while (($# > 0)); do
    case "$1" in
      --expected-public-ip)
        (($# >= 2)) || usage
        expected_public_ip="$2"
        shift 2
        ;;
      *) usage ;;
    esac
  done

  is_ipv4 "$expected_public_ip" || fail 'invalid-expected-public-ip'
  [[ "$(id -u)" == '0' ]] || fail 'requires-root'
  export LC_ALL=C

  for command in awk docker getent git hostname id ss sshd systemctl timedatectl ufw uname; do
    command -v "$command" >/dev/null 2>&1 || fail "missing-command-$command"
  done

  [[ "$(hostname)" == "$EXPECTED_HOSTNAME" ]] || fail 'unexpected-hostname'
  [[ -f /etc/os-release ]] || fail 'invalid-os-release'
  os_id="$(read_strict_value /etc/os-release ID)"
  os_version="$(read_strict_value /etc/os-release VERSION_ID)"
  os_id="${os_id%\"}"
  os_id="${os_id#\"}"
  os_version="${os_version%\"}"
  os_version="${os_version#\"}"
  [[ "$os_id" == "$EXPECTED_OS_ID" ]] || fail 'unexpected-os-id'
  [[ "$os_version" == "$EXPECTED_OS_VERSION" ]] || fail 'unexpected-os-version'
  [[ "$(uname -m)" == 'x86_64' ]] || fail 'unexpected-architecture'
  [[ "$(timedatectl show --property=Timezone --value)" == 'UTC' ]] ||
    fail 'unexpected-timezone'
  [[ "$(timedatectl show --property=NTPSynchronized --value)" == 'yes' ]] ||
    fail 'ntp-not-synchronized'

  for service in docker containerd ssh fail2ban unattended-upgrades; do
    assert_service_active "$service"
  done
  [[ -z "$(systemctl --failed --no-legend --plain)" ]] || fail 'failed-systemd-units'

  assert_sshd_setting permitrootlogin no
  assert_sshd_setting passwordauthentication no
  assert_sshd_setting pubkeyauthentication yes

  ufw_status="$(ufw status verbose)" || fail 'ufw-status-failed'
  assert_ufw_status "$ufw_status"
  assert_public_listeners

  [[ -z "$(docker ps -a --format '{{.ID}}')" ]] || fail 'existing-containers'
  command -v xray >/dev/null 2>&1 && fail 'xray-binary-present'
  if systemctl list-unit-files --no-legend --no-pager | awk '{ print $1 }' |
    grep -Eq '(^|-)xray\.service$'; then
    fail 'xray-systemd-unit-present'
  fi

  [[ "$(git -c safe.directory="$REPOSITORY_ROOT" -C "$REPOSITORY_ROOT" rev-parse --show-toplevel)" == "$REPOSITORY_ROOT" ]] ||
    fail 'unexpected-repository-root'
  [[ -z "$(git -c safe.directory="$REPOSITORY_ROOT" -C "$REPOSITORY_ROOT" status --porcelain --untracked-files=all)" ]] ||
    fail 'dirty-checkout'
  git -c safe.directory="$REPOSITORY_ROOT" -C "$REPOSITORY_ROOT" \
    rev-parse --verify 'HEAD^{commit}' >/dev/null ||
    fail 'invalid-checkout-head'

  bash "$SCRIPT_DIRECTORY/secrets/validate.sh" >/dev/null
  docker compose \
    --env-file "$PLATFORM_ENV_FILE" \
    -f "$REPOSITORY_ROOT/infra/docker-compose.production.yml" \
    config --quiet

  for key in ROOT_DOMAIN APP_DOMAIN API_DOMAIN SUB_DOMAIN; do
    domain="$(read_strict_value "$PLATFORM_ENV_FILE" "$key")"
    assert_domain_dns "$domain" "$key" "$expected_public_ip"
  done

  printf 'PLATFORM_PREFLIGHT_READY checks=host,ssh,firewall,tcp-udp-listeners,checkout,environment,compose,dns-a-no-aaaa\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
