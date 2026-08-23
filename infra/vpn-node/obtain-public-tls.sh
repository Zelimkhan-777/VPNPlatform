#!/usr/bin/env bash
set -euo pipefail

state_directory="${VPN_NODE_STATE_DIRECTORY:-vpn-fi-01}"
tls_hostname="${VPN_NODE_TLS_HOSTNAME:-}"
if [[ ! "$state_directory" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo 'VPN_NODE_STATE_DIRECTORY must contain only lowercase letters, digits, and hyphens' >&2
  exit 1
fi
if [[ ! "$tls_hostname" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo 'VPN_NODE_TLS_HOSTNAME is required and must be a DNS hostname' >&2
  exit 1
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tls_directory="$root/var/$state_directory/tls"

sudo -v
cleanup_http_rule() {
  sudo ufw --force delete allow 80/tcp >/dev/null 2>&1 || true
}

certificate_root="/etc/letsencrypt/live/$tls_hostname"
if ! sudo test -s "$certificate_root/fullchain.pem" || \
  ! sudo test -s "$certificate_root/privkey.pem"; then
  if sudo ufw status | grep -Eq '(^|[[:space:]])80/tcp([[:space:]]|$)'; then
    echo 'Port 80 already has a UFW rule; refusing to remove an operator-owned rule.' >&2
    exit 1
  fi
  trap cleanup_http_rule EXIT
  if ! command -v certbot >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y certbot
  fi
  sudo ufw allow 80/tcp comment 'Temporary ACME challenge'
  sudo certbot certonly --standalone --preferred-challenges http \
    --non-interactive --agree-tos --register-unsafely-without-email \
    --keep-until-expiring --domain "$tls_hostname"
  cleanup_http_rule
  trap - EXIT
fi

mkdir -p "$tls_directory"
sudo install -o vpnadmin -m 640 \
  "$certificate_root/fullchain.pem" \
  "$tls_directory/cert.pem"
sudo install -o vpnadmin -m 640 \
  "$certificate_root/privkey.pem" \
  "$tls_directory/key.pem"
sudo chown vpnadmin "$root/var/$state_directory" "$tls_directory"
sudo chgrp 65532 "$root/var/$state_directory" "$tls_directory" \
  "$tls_directory/cert.pem" "$tls_directory/key.pem"
sudo chmod 2750 "$root/var/$state_directory" "$tls_directory"
openssl x509 -in "$tls_directory/cert.pem" -noout -checkhost "$tls_hostname"

sudo ufw allow 443/tcp comment 'VPN VLESS/TLS'
sudo ufw status numbered
echo PUBLIC_TLS_READY
