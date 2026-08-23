#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'Run this installer through sudo.' >&2
  exit 1
fi
if [[ $# -ne 2 ]]; then
  echo 'Usage: install-xray-certificate-renewal.sh <state-directory> <tls-hostname>' >&2
  exit 1
fi

state_directory="$1"
tls_hostname="$2"
project_root='/home/vpnadmin/vpn-platform'
source_directory="$project_root/var/$state_directory/certbot-hooks"
config_directory='/etc/vpn-platform'
config_path="$config_directory/xray-tls-renew.conf"
lineage="/etc/letsencrypt/live/$tls_hostname"
deploy_target='/etc/letsencrypt/renewal-hooks/deploy/vpn-platform-xray'
pre_target='/etc/letsencrypt/renewal-hooks/pre/vpn-platform-ufw-80'
post_target='/etc/letsencrypt/renewal-hooks/post/vpn-platform-ufw-80'

[[ "$state_directory" =~ ^[a-z0-9][a-z0-9-]*$ ]]
[[ "$tls_hostname" =~ ^[A-Za-z0-9.-]+$ ]]
log_path="$project_root/var/$state_directory/certificate-renewal-install.log"
install -o vpnadmin -m 0600 /dev/null "$log_path"
exec > >(tee "$log_path") 2>&1
echo 'CERTIFICATE_RENEWAL_INSTALL_STARTED'

test -d "$project_root"
test -d "$project_root/var/$state_directory/tls"
test -s "$lineage/fullchain.pem"
test -s "$lineage/privkey.pem"
test -r "/etc/letsencrypt/renewal/$tls_hostname.conf"
test -r "$source_directory/vpn-platform-acme-pre.sh"
test -r "$source_directory/vpn-platform-acme-post.sh"
test -r "$source_directory/vpn-platform-xray-deploy.sh"
id vpnadmin >/dev/null
command -v certbot >/dev/null
command -v docker >/dev/null
command -v ufw >/dev/null

install -d -o root -g root -m 0755 "$config_directory"
config_temporary="$(mktemp)"
trap 'rm -f "$config_temporary"' EXIT
{
  printf "VPN_PLATFORM_PROJECT_ROOT='%s'\n" "$project_root"
  printf "VPN_NODE_STATE_DIRECTORY='%s'\n" "$state_directory"
  printf "VPN_NODE_TLS_HOSTNAME='%s'\n" "$tls_hostname"
  printf "VPN_NODE_TLS_OWNER='vpnadmin'\n"
  printf "VPN_NODE_TLS_GROUP='65532'\n"
  printf "VPN_NODE_PORT='443'\n"
} >"$config_temporary"
install -o root -g root -m 0644 "$config_temporary" "$config_path"

install -o root -g root -m 0755 \
  "$source_directory/vpn-platform-acme-pre.sh" "$pre_target"
install -o root -g root -m 0755 \
  "$source_directory/vpn-platform-acme-post.sh" "$post_target"
install -o root -g root -m 0755 \
  "$source_directory/vpn-platform-xray-deploy.sh" "$deploy_target"
echo 'CERTBOT_HOOKS_INSTALLED'

before_cert="$(sha256sum "$project_root/var/$state_directory/tls/cert.pem" | awk '{print $1}')"
before_key="$(sha256sum "$project_root/var/$state_directory/tls/key.pem" | awk '{print $1}')"
before_started="$(docker inspect -f '{{.State.StartedAt}}' vpn-platform-vpn-node-xray-1)"

failure_fixture="$(mktemp -d)"
cleanup_fixture() {
  rm -f \
    "$failure_fixture/matching.key" \
    "$failure_fixture/fullchain.pem" \
    "$failure_fixture/privkey.pem"
  rmdir "$failure_fixture" 2>/dev/null || true
}
trap 'rm -f "$config_temporary"; cleanup_fixture' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj "/CN=$tls_hostname" -addext "subjectAltName=DNS:$tls_hostname" \
  -keyout "$failure_fixture/matching.key" \
  -out "$failure_fixture/fullchain.pem" >/dev/null 2>&1
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out "$failure_fixture/privkey.pem" >/dev/null 2>&1
if "$deploy_target" --validate-only "$failure_fixture" >/dev/null 2>&1; then
  echo 'Mismatch fixture unexpectedly passed TLS validation.' >&2
  exit 1
fi

after_failure_cert="$(sha256sum "$project_root/var/$state_directory/tls/cert.pem" | awk '{print $1}')"
after_failure_key="$(sha256sum "$project_root/var/$state_directory/tls/key.pem" | awk '{print $1}')"
after_failure_started="$(docker inspect -f '{{.State.StartedAt}}' vpn-platform-vpn-node-xray-1)"
[[ "$before_cert" == "$after_failure_cert" ]]
[[ "$before_key" == "$after_failure_key" ]]
[[ "$before_started" == "$after_failure_started" ]]
echo 'TLS_FAILURE_PATH_OK'

echo 'TLS_SUCCESS_PATH_STARTING'
RENEWED_LINEAGE="$lineage" RENEWED_DOMAINS="$tls_hostname" "$deploy_target"
echo 'TLS_SUCCESS_PATH_OK'

echo 'CERTBOT_DRY_RUN_STARTING'
certbot renew --cert-name "$tls_hostname" --dry-run --no-random-sleep-on-renew
if [[ -e /run/vpn-platform-certbot-opened-80 ]]; then
  echo 'Temporary ACME UFW marker remained after dry-run.' >&2
  exit 1
fi
if ufw status | grep -Eq '(^|[[:space:]])80/tcp([[:space:]]|$)'; then
  echo 'Temporary ACME 80/tcp rule remained after dry-run.' >&2
  exit 1
fi

systemctl enable --now certbot.timer
systemctl is-enabled certbot.timer
systemctl is-active certbot.timer
docker inspect -f '{{.State.Status}}' vpn-platform-vpn-node-xray-1 | grep -qx running
openssl x509 -in "$project_root/var/$state_directory/tls/cert.pem" \
  -noout -checkhost "$tls_hostname" >/dev/null
stat -c '%a %U %g %n' \
  "$project_root/var/$state_directory/tls/cert.pem" \
  "$project_root/var/$state_directory/tls/key.pem"
echo 'XRAY_CERTIFICATE_RENEWAL_READY'
