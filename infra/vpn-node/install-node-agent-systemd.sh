#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: install-node-agent-systemd.sh \
  --project-root /absolute/path/to/vpn-platform \
  --state-directory vpn-fi-01 \
  --node-binary /absolute/path/to/node \
  --service-user vpnadmin \
  [--service-group vpnadmin] \
  [--docker-group docker] \
  [--render-only /path/to/output.service]
EOF
}

require_value() {
  if [[ $# -lt 2 || -z "$2" ]]; then
    usage
    exit 2
  fi
}

declare -A seen_options=()
require_once() {
  local option="$1"
  if [[ -n "${seen_options[$option]:-}" ]]; then
    echo "Duplicate option: $option" >&2
    usage
    exit 2
  fi
  seen_options[$option]=1
}

validate_render_only_path() {
  local path="$1"
  if [[ ! "$path" =~ ^/([A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+$ ]] ||
    [[ "$path" == */./* || "$path" == */. || "$path" == */../* || "$path" == */.. ]]; then
    echo '--render-only must be an absolute POSIX path without whitespace or dot segments.' >&2
    exit 2
  fi
}

require_non_root_numeric_id() {
  local label="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "$label did not resolve to a numeric ID." >&2
    exit 1
  fi
  if [[ "$value" == '0' ]]; then
    echo "$label must not resolve to root ID 0." >&2
    exit 1
  fi
}

project_root=''
state_directory=''
node_binary=''
service_user=''
service_group=''
docker_group='docker'
render_only=''

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-root)
      require_value "$@"
      require_once "$1"
      project_root="$2"
      shift 2
      ;;
    --state-directory)
      require_value "$@"
      require_once "$1"
      state_directory="$2"
      shift 2
      ;;
    --node-binary)
      require_value "$@"
      require_once "$1"
      node_binary="$2"
      shift 2
      ;;
    --service-user)
      require_value "$@"
      require_once "$1"
      service_user="$2"
      shift 2
      ;;
    --service-group)
      require_value "$@"
      require_once "$1"
      service_group="$2"
      shift 2
      ;;
    --docker-group)
      require_value "$@"
      require_once "$1"
      docker_group="$2"
      shift 2
      ;;
    --render-only)
      require_value "$@"
      require_once "$1"
      render_only="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$project_root" || -z "$state_directory" || -z "$node_binary" || -z "$service_user" ]]; then
  usage
  exit 2
fi
if [[ -z "$service_group" ]]; then
  service_group="$service_user"
fi
if [[ -n "$render_only" ]]; then
  validate_render_only_path "$render_only"
fi

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
renderer="$script_directory/render-node-agent-systemd-unit.mjs"
state_path="$project_root/var/$state_directory"
legacy_pid_path="$state_path/node-agent.pid"

test -r "$renderer"
test -d "$project_root/apps/node-agent"
test -r "$project_root/apps/node-agent/dist/main.js"
test -r "$state_path/agent.env"
test -r "$state_path/control-plane-tls/ca.pem"
test -x "$node_binary"

if [[ -e "$legacy_pid_path" ]]; then
  echo "Legacy PID marker exists at $legacy_pid_path; no process was signalled." >&2
  echo 'Verify the legacy process identity and stop it through an explicit operator procedure before retrying.' >&2
  exit 1
fi

rendered_unit="$(mktemp)"
cleanup() {
  rm -f -- "$rendered_unit"
}
trap cleanup EXIT

renderer_arguments=(
  "$renderer"
  --project-root "$project_root"
  --state-directory "$state_directory"
  --node-binary "$node_binary"
  --service-user "$service_user"
  --service-group "$service_group"
  --docker-group "$docker_group"
  --output "$rendered_unit"
)

if [[ -n "$render_only" ]]; then
  "$node_binary" "${renderer_arguments[@]}"
  install -m 0600 -- "$rendered_unit" "$render_only"
  exit 0
fi

service_uid="$(id -u "$service_user")"
service_primary_gid="$(id -g "$service_user")"
service_group_entry="$(getent group "$service_group")"
docker_group_entry="$(getent group "$docker_group")"
IFS=':' read -r _ _ service_group_gid _ <<<"$service_group_entry"
IFS=':' read -r _ _ docker_group_gid _ <<<"$docker_group_entry"
read -r -a inherited_group_ids <<<"$(id -G "$service_user")"

require_non_root_numeric_id 'service user UID' "$service_uid"
require_non_root_numeric_id 'service user primary GID' "$service_primary_gid"
require_non_root_numeric_id 'service group GID' "$service_group_gid"
require_non_root_numeric_id 'Docker group GID' "$docker_group_gid"
for inherited_group_id in "${inherited_group_ids[@]}"; do
  require_non_root_numeric_id 'service user inherited GID' "$inherited_group_id"
done

if ! test -x /usr/bin/chronyc; then
  echo 'Production node-agent requires /usr/bin/chronyc as a deployment prerequisite.' >&2
  echo 'Install and start chrony before this installer. The installer does not install chrony or change its configuration.' >&2
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'Run this installer through sudo.' >&2
  exit 1
fi
command -v runuser >/dev/null

chown "$service_user:$service_group" "$rendered_unit"
runuser --user "$service_user" -- "$node_binary" "${renderer_arguments[@]}"

target_unit='/etc/systemd/system/vpn-platform-node-agent.service'
install -o root -g root -m 0644 "$rendered_unit" "$target_unit"
systemctl daemon-reload
systemctl enable vpn-platform-node-agent.service
systemctl restart vpn-platform-node-agent.service
systemctl is-enabled vpn-platform-node-agent.service
systemctl is-active vpn-platform-node-agent.service
systemctl --no-pager --full status vpn-platform-node-agent.service
