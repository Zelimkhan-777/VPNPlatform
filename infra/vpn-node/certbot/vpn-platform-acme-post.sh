#!/usr/bin/env bash
set -euo pipefail

marker='/run/vpn-platform-certbot-opened-80'

if [[ ! -e "$marker" ]]; then
  exit 0
fi

if command -v ufw >/dev/null 2>&1; then
  ufw --force delete allow 80/tcp >/dev/null 2>&1 || {
    echo 'Could not remove the temporary ACME 80/tcp rule.' >&2
    exit 1
  }
fi

rm -f "$marker"
echo 'Closed temporary ACME 80/tcp rule.'
