#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'Run this installer through sudo.' >&2
  exit 1
fi

project_root='/home/vpnadmin/vpn-platform'
state_directory="$project_root/var/vpn-nl-01"
source_unit="$state_directory/vpn-platform-node-agent.service"
target_unit='/etc/systemd/system/vpn-platform-node-agent.service'

test -r "$source_unit"
test -r "$state_directory/agent.env"
test -r "$state_directory/control-plane-tls/ca.pem"
test -x '/home/vpnadmin/.local/node-v24.12.0/bin/node'

install -o root -g root -m 0644 "$source_unit" "$target_unit"
systemctl daemon-reload

if [[ -s "$state_directory/node-agent.pid" ]]; then
  old_pid="$(cat "$state_directory/node-agent.pid")"
  if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" 2>/dev/null; then
    kill "$old_pid"
    for _ in $(seq 1 30); do
      kill -0 "$old_pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$old_pid" 2>/dev/null; then
      echo "Old node-agent pid $old_pid did not stop cleanly." >&2
      exit 1
    fi
  fi
fi

systemctl enable --now vpn-platform-node-agent.service
systemctl is-enabled vpn-platform-node-agent.service
systemctl is-active vpn-platform-node-agent.service
systemctl --no-pager --full status vpn-platform-node-agent.service
