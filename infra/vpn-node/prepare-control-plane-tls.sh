#!/usr/bin/env bash
set -euo pipefail

state_directory="${VPN_NODE_STATE_DIRECTORY:-vpn-fi-01}"
if [[ ! "$state_directory" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo 'VPN_NODE_STATE_DIRECTORY must contain only lowercase letters, digits, and hyphens' >&2
  exit 1
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tls_directory="$root/var/$state_directory/control-plane-tls"
mkdir -p "$tls_directory"
chmod 700 "$tls_directory"

if [[ ! -s "$tls_directory/ca-key.pem" || ! -s "$tls_directory/ca.pem" ]]; then
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 \
    -subj '/CN=VPNPlatform node-agent local CA' \
    -keyout "$tls_directory/ca-key.pem" \
    -out "$tls_directory/ca.pem"
fi

if [[ ! -s "$tls_directory/server-key.pem" || ! -s "$tls_directory/server-cert.pem" ]]; then
  temporary_directory="$(mktemp -d)"
  trap 'rm -rf "$temporary_directory"' EXIT
  openssl req -new -newkey rsa:3072 -sha256 -nodes \
    -subj '/CN=127.0.0.1' \
    -keyout "$tls_directory/server-key.pem" \
    -out "$temporary_directory/server.csr"
  cat > "$temporary_directory/server.ext" <<'EOF'
subjectAltName=IP:127.0.0.1
extendedKeyUsage=serverAuth
keyUsage=digitalSignature,keyEncipherment
EOF
  openssl x509 -req -sha256 -days 825 \
    -in "$temporary_directory/server.csr" \
    -CA "$tls_directory/ca.pem" \
    -CAkey "$tls_directory/ca-key.pem" \
    -CAcreateserial \
    -extfile "$temporary_directory/server.ext" \
    -out "$tls_directory/server-cert.pem"
fi

chmod 600 "$tls_directory/ca-key.pem" "$tls_directory/server-key.pem"
chmod 644 "$tls_directory/ca.pem" "$tls_directory/server-cert.pem"
openssl verify -CAfile "$tls_directory/ca.pem" "$tls_directory/server-cert.pem"
