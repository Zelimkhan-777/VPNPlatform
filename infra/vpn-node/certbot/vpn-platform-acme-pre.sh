#!/usr/bin/env bash
set -euo pipefail

marker='/run/vpn-platform-certbot-opened-80'

if ! command -v ufw >/dev/null 2>&1; then
  echo 'ufw is required for the ACME standalone renewal hook.' >&2
  exit 1
fi

if ! ufw status | head -n 1 | grep -q '^Status: active$'; then
  exit 0
fi

if ufw status | grep -Eq '(^|[[:space:]])80/tcp([[:space:]]|$)'; then
  exit 0
fi

ufw allow 80/tcp comment 'Temporary ACME renewal challenge' >/dev/null
install -o root -g root -m 0600 /dev/null "$marker"
echo 'Temporarily opened 80/tcp for ACME renewal.'
