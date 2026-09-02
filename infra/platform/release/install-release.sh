#!/usr/bin/env bash

set -Eeuo pipefail

readonly DEFAULT_RELEASE_ROOT='/opt/meteora'
release_root="$DEFAULT_RELEASE_ROOT"
bundle_path=''
expected_commit=''
expected_sha256=''
staging_directory=''
temporary_link=''
switch_completed='0'
installation_completed='0'
previous_current_present='0'
previous_current_target=''

fail() {
  printf 'RELEASE_INSTALL_ERROR code=%s\n' "$1" >&2
  exit 1
}

cleanup() {
  local rollback_link
  if [[ "$switch_completed" == '1' && "$installation_completed" != '1' ]]; then
    rollback_link="$release_root/.current-rollback.$$.tmp"
    if [[ "$previous_current_present" == '1' ]]; then
      rm -f -- "$rollback_link" 2>/dev/null || true
      ln -s -- "$previous_current_target" "$rollback_link" 2>/dev/null || true
      mv -Tf -- "$rollback_link" "$release_root/current" 2>/dev/null || true
    else
      rm -f -- "$release_root/current" 2>/dev/null || true
    fi
    sync -f "$release_root" 2>/dev/null || true
    switch_completed='0'
  fi
  if [[ -n "$temporary_link" && ( -e "$temporary_link" || -L "$temporary_link" ) ]]; then
    rm -f -- "$temporary_link" 2>/dev/null || true
  fi
  if [[ -n "$staging_directory" && -d "$staging_directory" && ! -L "$staging_directory" ]]; then
    rm -rf -- "$staging_directory" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

require_value() {
  local option="$1"
  local value="${2:-}"
  [[ -n "$value" && "$value" != -* ]] || fail "missing-${option#--}"
}

while (($# > 0)); do
  case "$1" in
    --bundle)
      require_value "$1" "${2:-}"
      bundle_path="$2"
      shift 2
      ;;
    --expected-commit)
      require_value "$1" "${2:-}"
      expected_commit="$2"
      shift 2
      ;;
    --expected-sha256)
      require_value "$1" "${2:-}"
      expected_sha256="$2"
      shift 2
      ;;
    *) fail 'invalid-arguments' ;;
  esac
done

if [[ "${METEORA_RELEASE_TEST_MODE:-0}" == '1' ]]; then
  [[ -n "${METEORA_RELEASE_TEST_ROOT:-}" ]] || fail 'missing-test-root'
  release_root="$METEORA_RELEASE_TEST_ROOT"
  [[ "$release_root" != "$DEFAULT_RELEASE_ROOT" ]] || fail 'unsafe-test-root'
  case "$(uname -s)" in
    MINGW* | MSYS*) ;;
    *) [[ "$(id -u)" == '0' ]] || fail 'installer-requires-root' ;;
  esac
else
  [[ "$(id -u)" == '0' ]] || fail 'installer-requires-root'
  [[ -z "${METEORA_RELEASE_TEST_ROOT:-}" ]] || fail 'test-root-without-test-mode'
fi

for command in git sha256sum realpath mktemp sync; do
  command -v "$command" >/dev/null 2>&1 || fail "missing-command-$command"
done

[[ -n "$bundle_path" && -n "$expected_commit" && -n "$expected_sha256" ]] ||
  fail 'missing-required-argument'
[[ "$expected_commit" =~ ^[0-9a-f]{40}$ ]] || fail 'invalid-expected-commit'
[[ "$expected_sha256" =~ ^[0-9a-f]{64}$ ]] || fail 'invalid-expected-sha256'
[[ "$bundle_path" == /* && "$bundle_path" != *$'\n'* && "$bundle_path" != *$'\r'* ]] ||
  fail 'invalid-bundle-path'
[[ -f "$bundle_path" && ! -L "$bundle_path" ]] || fail 'invalid-bundle-file'
canonical_bundle="$(realpath -e -- "$bundle_path" 2>/dev/null)" || fail 'invalid-bundle-path'
[[ "$canonical_bundle" == "$bundle_path" ]] || fail 'non-canonical-bundle-path'

[[ "$release_root" == /* && "$release_root" != *$'\n'* && "$release_root" != *$'\r'* ]] ||
  fail 'invalid-release-root'
[[ -d "$release_root" && ! -L "$release_root" ]] || fail 'invalid-release-root'
canonical_root="$(realpath -e -- "$release_root" 2>/dev/null)" || fail 'invalid-release-root'
[[ "$canonical_root" == "$release_root" ]] || fail 'non-canonical-release-root'
releases_directory="$release_root/releases"
[[ -d "$releases_directory" && ! -L "$releases_directory" ]] || fail 'invalid-releases-directory'
[[ "$(realpath -e -- "$releases_directory" 2>/dev/null)" == "$releases_directory" ]] ||
  fail 'non-canonical-releases-directory'

if [[ "${METEORA_RELEASE_TEST_MODE:-0}" != '1' ]]; then
  [[ "$(stat -c '%u' -- "$release_root")" == '0' ]] || fail 'invalid-release-root-owner'
  [[ "$(stat -c '%u' -- "$releases_directory")" == '0' ]] ||
    fail 'invalid-releases-directory-owner'
  root_mode="$(stat -c '%a' -- "$release_root")"
  releases_mode="$(stat -c '%a' -- "$releases_directory")"
  (( (8#$root_mode & 022) == 0 )) || fail 'insecure-release-root-mode'
  (( (8#$releases_mode & 022) == 0 )) || fail 'insecure-releases-directory-mode'
fi

actual_sha256="$(sha256sum -- "$bundle_path" 2>/dev/null | awk '{ print $1 }')" ||
  fail 'bundle-sha256-read-failed'
[[ "$actual_sha256" == "$expected_sha256" ]] || fail 'bundle-sha256-mismatch'

verification_repository="$(mktemp -d -- "$release_root/.verify-${expected_commit}.XXXXXXXX")"
staging_directory="$verification_repository"
git -C "$verification_repository" init --bare --quiet >/dev/null 2>&1 ||
  fail 'verification-repository-init-failed'
git -C "$verification_repository" bundle verify "$bundle_path" >/dev/null 2>&1 ||
  fail 'git-bundle-verification-failed'
bundle_heads="$(git bundle list-heads "$bundle_path" 2>/dev/null)" ||
  fail 'git-bundle-heads-failed'
[[ "$(awk 'NF >= 2 { count += 1 } END { print count + 0 }' <<<"$bundle_heads")" == '1' ]] ||
  fail 'unexpected-bundle-head-count'
awk -v commit="$expected_commit" -v ref="refs/heads/release-$expected_commit" \
  '$1 == commit && $2 == ref { found = 1 } END { exit !found }' \
  <<<"$bundle_heads" || fail 'expected-commit-not-in-bundle-heads'
rm -rf -- "$verification_repository" 2>/dev/null || fail 'verification-cleanup-failed'
staging_directory=''

final_release="$releases_directory/$expected_commit"
[[ ! -e "$final_release" && ! -L "$final_release" ]] || fail 'release-already-exists'
staging_directory="$(mktemp -d -- "$releases_directory/.install-${expected_commit}.XXXXXXXX")"
git clone --no-checkout --quiet "$bundle_path" "$staging_directory/repository" >/dev/null 2>&1 ||
  fail 'release-clone-failed'
git -C "$staging_directory/repository" checkout --detach --quiet "$expected_commit" >/dev/null 2>&1 ||
  fail 'release-checkout-failed'
git -C "$staging_directory/repository" remote remove origin >/dev/null 2>&1 ||
  fail 'release-remote-removal-failed'
[[ "$(git -C "$staging_directory/repository" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" == "$expected_commit" ]] ||
  fail 'materialized-commit-mismatch'
git -C "$staging_directory/repository" fsck --full --strict >/dev/null 2>&1 ||
  fail 'materialized-object-verification-failed'
[[ -z "$(git -C "$staging_directory/repository" status --porcelain --untracked-files=all 2>/dev/null)" ]] ||
  fail 'materialized-checkout-dirty'

sync -f "$staging_directory/repository" 2>/dev/null || fail 'checkout-sync-failed'
mv -- "$staging_directory/repository" "$final_release" 2>/dev/null ||
  fail 'release-rename-failed'
rmdir -- "$staging_directory" 2>/dev/null || fail 'staging-cleanup-failed'
staging_directory=''
sync -f "$releases_directory" 2>/dev/null || fail 'releases-sync-failed'

if [[ "${METEORA_RELEASE_TEST_MODE:-0}" == '1' && "${METEORA_RELEASE_TEST_FAIL_BEFORE_SWITCH:-0}" == '1' ]]; then
  fail 'injected-before-switch'
fi

if [[ -e "$release_root/current" || -L "$release_root/current" ]]; then
  [[ -L "$release_root/current" ]] || fail 'unsafe-current-type'
  previous_current_target="$(readlink -- "$release_root/current" 2>/dev/null)" ||
    fail 'invalid-current-target'
  previous_current_resolved="$(realpath -e -- "$release_root/current" 2>/dev/null)" ||
    fail 'invalid-current-target'
  [[ "$previous_current_resolved" == "$releases_directory/"* ]] ||
    fail 'current-target-outside-releases'
  previous_current_present='1'
fi

temporary_link="$release_root/.current-${expected_commit}.$$.tmp"
[[ ! -e "$temporary_link" && ! -L "$temporary_link" ]] || fail 'temporary-link-exists'
ln -s -- "$final_release" "$temporary_link" 2>/dev/null || fail 'current-link-create-failed'
sync -f "$release_root" 2>/dev/null || fail 'pre-switch-sync-failed'
switch_completed='1'
mv -Tf -- "$temporary_link" "$release_root/current" 2>/dev/null || fail 'current-switch-failed'
temporary_link=''
sync -f "$release_root" 2>/dev/null || fail 'post-switch-sync-failed'

if [[ "${METEORA_RELEASE_TEST_MODE:-0}" == '1' && "${METEORA_RELEASE_TEST_FAIL_AFTER_SWITCH:-0}" == '1' ]]; then
  fail 'injected-after-switch'
fi

[[ -L "$release_root/current" ]] || fail 'current-is-not-symlink'
[[ "$(realpath -e -- "$release_root/current" 2>/dev/null)" == "$final_release" ]] ||
  fail 'current-target-mismatch'
installation_completed='1'

printf 'RELEASE_INSTALL_COMPLETE commit=%s\n' "$expected_commit"
