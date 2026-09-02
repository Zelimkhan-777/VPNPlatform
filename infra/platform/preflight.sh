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

expected_public_ip=''
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

ufw_status="$(ufw status verbose)"
grep -Fqx 'Status: active' <<<"$ufw_status" || fail 'ufw-inactive'
grep -Fq 'Default: deny (incoming), allow (outgoing)' <<<"$ufw_status" ||
  fail 'ufw-default-policy'
grep -Eq '^22/tcp[[:space:]]+LIMIT IN[[:space:]]+' <<<"$ufw_status" ||
  fail 'ufw-ssh-not-limited'
if grep -Eq '^(80|443)/tcp[[:space:]]+' <<<"$ufw_status"; then
  fail 'public-http-firewall-already-open'
fi

while IFS= read -r local_address; do
  case "$local_address" in
    0.0.0.0:22|'[::]:22'|'*:22') ;;
    0.0.0.0:*|'[::]:'*|'*:'*) fail 'unexpected-public-listener' ;;
  esac
done < <(ss -H -lnt | awk '{ print $4 }')

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
  addresses="$(getent ahostsv4 "$domain" | awk '$2 == "STREAM" { print $1 }' | sort -u)"
  [[ -n "$addresses" ]] || fail "dns-missing-${key,,}"
  while IFS= read -r address; do
    [[ "$address" == "$expected_public_ip" ]] || fail "dns-mismatch-${key,,}"
  done <<<"$addresses"
done

printf 'PLATFORM_PREFLIGHT_READY checks=host,ssh,firewall,listeners,checkout,environment,compose,dns\n'
