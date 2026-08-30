#!/usr/bin/env bash
set -euo pipefail

COMPOSE_PROJECT='vpn-platform-vpn-node'
COMPOSE_SERVICE='xray'
NODE_AGENT_UNIT='vpn-platform-node-agent.service'
DOCKER_BIN="${DOCKER_BIN:-docker}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
SLEEP_BIN="${SLEEP_BIN:-sleep}"
OPENSSL_BIN="${OPENSSL_BIN:-openssl}"
TIMEOUT_BIN="${TIMEOUT_BIN:-timeout}"
# Matches LOCAL_FAIL_CLOSED_RESERVE_MS; covers 79s apply plus agent restart.
TLS_HANDOFF_WAIT_SECONDS="${TLS_HANDOFF_WAIT_SECONDS:-120}"
TLS_PROBE_TIMEOUT_SECONDS=8

usage() {
  cat >&2 <<'EOF'
Usage: xray-serving-lifecycle.sh verify-stopped
       xray-serving-lifecycle.sh stop-and-verify <compose-file>
       xray-serving-lifecycle.sh restart-agent
       xray-serving-lifecycle.sh handoff <compose-file>
       xray-serving-lifecycle.sh wait-served-fingerprint <hostname> <port> <sha256> [timeout-seconds]
EOF
}

verify_xray_stopped() {
  local ids
  if ! ids="$(
    "$DOCKER_BIN" ps \
      --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
      --filter "label=com.docker.compose.service=${COMPOSE_SERVICE}" \
      --filter 'status=running' \
      --format '{{.ID}}'
  )"; then
    echo 'Xray stop verification failed: docker ps did not succeed.' >&2
    return 1
  fi
  if [[ -n "$ids" ]]; then
    echo 'Xray stop verification failed: a container is still running.' >&2
    return 1
  fi
}

stop_and_verify_xray() {
  local compose_file="${1:-}"
  if [[ -z "$compose_file" ]]; then
    usage
    return 2
  fi
  : "${VPN_NODE_STATE_DIRECTORY:?Missing VPN_NODE_STATE_DIRECTORY}"
  VPN_NODE_STATE_DIRECTORY="$VPN_NODE_STATE_DIRECTORY" \
    "$DOCKER_BIN" compose -f "$compose_file" stop --timeout 0 xray >/dev/null
  verify_xray_stopped
}

restart_node_agent() {
  "$SYSTEMCTL_BIN" restart "$NODE_AGENT_UNIT"
}

handoff_to_node_agent() {
  stop_and_verify_xray "${1:-}"
  restart_node_agent
}

monotonic_now_seconds() {
  if [[ -n "${MONOTONIC_NOW_HELPER:-}" ]]; then
    "$MONOTONIC_NOW_HELPER"
    return
  fi
  if [[ -r /proc/uptime ]]; then
    awk '{printf "%d\n", $1}' /proc/uptime
    return
  fi
  date +%s
}

served_tls_fingerprint() {
  local hostname="$1"
  local port="$2"
  local probe_timeout="${3:-$TLS_PROBE_TIMEOUT_SECONDS}"
  if [[ ! "$probe_timeout" =~ ^[1-9][0-9]*$ ]]; then
    echo 'TLS probe timeout must be a positive integer.' >&2
    return 2
  fi
  if [[ -n "${SERVED_TLS_FINGERPRINT_HELPER:-}" ]]; then
    "$TIMEOUT_BIN" "$probe_timeout" \
      "$SERVED_TLS_FINGERPRINT_HELPER" "$hostname" "$port"
    return
  fi
  "$TIMEOUT_BIN" "$probe_timeout" "$OPENSSL_BIN" s_client \
    -connect "127.0.0.1:${port}" \
    -servername "$hostname" </dev/null 2>/dev/null |
    "$OPENSSL_BIN" x509 -outform DER 2>/dev/null |
    sha256sum | awk '{print $1}'
}

wait_served_tls_fingerprint() {
  local hostname="${1:-}"
  local port="${2:-}"
  local expected="${3:-}"
  local timeout_seconds="${4:-$TLS_HANDOFF_WAIT_SECONDS}"
  local current=''
  local start_at=''
  local now=''
  local deadline=0
  local remaining=0
  local probe_budget=0
  local attempted=0

  if [[ -z "$hostname" || -z "$port" || -z "$expected" ]]; then
    usage
    return 2
  fi
  if [[ ! "$timeout_seconds" =~ ^[0-9]+$ ]]; then
    echo 'TLS handoff wait timeout must be a non-negative integer.' >&2
    return 2
  fi

  start_at="$(monotonic_now_seconds)"
  if [[ ! "$start_at" =~ ^[0-9]+$ ]]; then
    echo 'TLS handoff clock source returned a non-integer timestamp.' >&2
    return 2
  fi
  deadline=$((start_at + timeout_seconds))

  while true; do
    now="$(monotonic_now_seconds)"
    if [[ ! "$now" =~ ^[0-9]+$ ]]; then
      echo 'TLS handoff clock source returned a non-integer timestamp.' >&2
      return 2
    fi
    remaining=$((deadline - now))
    if ((attempted > 0 && remaining <= 0)); then
      break
    fi
    if ((remaining > 0)); then
      probe_budget="$remaining"
      if ((probe_budget > TLS_PROBE_TIMEOUT_SECONDS)); then
        probe_budget="$TLS_PROBE_TIMEOUT_SECONDS"
      fi
    else
      # timeout=0 is a single immediate check; keep the ordinary probe cap.
      probe_budget="$TLS_PROBE_TIMEOUT_SECONDS"
    fi
    attempted=$((attempted + 1))
    current="$(served_tls_fingerprint "$hostname" "$port" "$probe_budget" || true)"
    if [[ -n "$current" && "$current" == "$expected" ]]; then
      echo 'XRAY_TLS_FINGERPRINT_MATCHED'
      return 0
    fi
    now="$(monotonic_now_seconds)"
    if [[ ! "$now" =~ ^[0-9]+$ ]]; then
      echo 'TLS handoff clock source returned a non-integer timestamp.' >&2
      return 2
    fi
    remaining=$((deadline - now))
    if ((remaining <= 0)); then
      break
    fi
    "$SLEEP_BIN" 1
  done
  echo 'Xray did not serve the expected TLS certificate after node-agent handoff.' >&2
  return 1
}

case "${1:-}" in
  verify-stopped)
    verify_xray_stopped
    ;;
  stop-and-verify)
    stop_and_verify_xray "${2:-}"
    ;;
  restart-agent)
    restart_node_agent
    ;;
  handoff)
    handoff_to_node_agent "${2:-}"
    ;;
  wait-served-fingerprint)
    wait_served_tls_fingerprint "${2:-}" "${3:-}" "${4:-}" "${5:-}"
    ;;
  *)
    usage
    exit 2
    ;;
esac
