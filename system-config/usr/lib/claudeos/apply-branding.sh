#!/usr/bin/env bash
# Apply ClaudeOS branding (os-release, /etc/issue, /etc/issue.net, lsb-release description).
# Usage: apply-branding.sh [--revert]
# Idempotent. The original os-release is preserved once: via dpkg-divert on a real root
# (so base-files upgrades do not undo the branding), plus a copy under the branding dir.
# Env: ROOT (target root, default empty = "/"), BRANDING_DIR.
set -euo pipefail

ROOT="${ROOT:-}"
BRANDING="${BRANDING_DIR:-${ROOT}/usr/share/claudeos/branding}"
ORIG="${BRANDING}/os-release.ubuntu-orig"
ACTION=apply
[ "${1:-}" = "--revert" ] && ACTION=revert

# Real file behind /etc/os-release (normally the symlink target /usr/lib/os-release).
os_release_target="${ROOT}/usr/lib/os-release"
[ -e "$os_release_target" ] || os_release_target="${ROOT}/etc/os-release"
[ -L "${ROOT}/etc/os-release" ] || [ ! -e "${ROOT}/etc/os-release" ] || os_release_target="${ROOT}/etc/os-release"
rel_path="${os_release_target#"$ROOT"}"

use_divert=0
if [ -z "$ROOT" ] && [ "$(id -u)" -eq 0 ] && command -v dpkg-divert >/dev/null 2>&1; then
  use_divert=1
fi

# Replace or append KEY=value line in a file (value given as the full line).
set_line() { # file key line
  local file="$1" key="$2" line="$3" tmp
  tmp="$(mktemp)"
  if [ -f "$file" ] && grep -q "^${key}=" "$file"; then
    awk -v k="$key" -v l="$line" 'index($0, k "=") == 1 { print l; next } { print }' "$file" >"$tmp"
  else
    { [ -f "$file" ] && cat "$file"; printf '%s\n' "$line"; } >"$tmp"
  fi
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

if [ "$ACTION" = apply ]; then
  [ -f "${BRANDING}/os-release.claudeos" ] || { echo "apply-branding: missing ${BRANDING}/os-release.claudeos" >&2; exit 1; }

  if [ ! -e "$ORIG" ] && [ -f "$os_release_target" ] && ! grep -q '^CLAUDEOS_BASE=' "$os_release_target"; then
    cp -a "$os_release_target" "$ORIG"
  fi
  if [ "$use_divert" -eq 1 ] && [ -z "$(dpkg-divert --list "$rel_path" 2>/dev/null)" ]; then
    dpkg-divert --package claudeos-core --add --rename --divert "${rel_path}.ubuntu" "$rel_path" >/dev/null || true
  fi
  # Install as a regular file (never write through a symlink that points elsewhere).
  install -m 0644 "${BRANDING}/os-release.claudeos" "${os_release_target}.claudeos-new"
  mv -f "${os_release_target}.claudeos-new" "$os_release_target"

  [ -f "${BRANDING}/issue" ] && install -m 0644 "${BRANDING}/issue" "${ROOT}/etc/issue"
  [ -f "${BRANDING}/issue.net" ] && install -m 0644 "${BRANDING}/issue.net" "${ROOT}/etc/issue.net"
  if [ -f "${BRANDING}/lsb-release.claudeos" ] && [ -f "${ROOT}/etc/lsb-release" ]; then
    if [ ! -e "${ROOT}/etc/lsb-release.ubuntu-orig" ]; then
      cp -a "${ROOT}/etc/lsb-release" "${ROOT}/etc/lsb-release.ubuntu-orig"
    fi
    set_line "${ROOT}/etc/lsb-release" DISTRIB_DESCRIPTION "$(grep '^DISTRIB_DESCRIPTION=' "${BRANDING}/lsb-release.claudeos")"
  fi
  echo "ClaudeOS branding applied."
else
  if [ "$use_divert" -eq 1 ] && [ -n "$(dpkg-divert --list "$rel_path" 2>/dev/null)" ]; then
    rm -f "$os_release_target"
    dpkg-divert --package claudeos-core --remove --rename "$rel_path" >/dev/null || true
  elif [ -f "$ORIG" ]; then
    cp -a "$ORIG" "$os_release_target"
  fi
  [ -f "${ROOT}/etc/lsb-release.ubuntu-orig" ] && mv -f "${ROOT}/etc/lsb-release.ubuntu-orig" "${ROOT}/etc/lsb-release"
  if [ -f "${ROOT}/etc/os-release" ] && ! grep -q '^CLAUDEOS_BASE=' "${ROOT}/etc/os-release"; then
    printf 'Ubuntu 26.04.1 LTS \\n \\l\n\n' >"${ROOT}/etc/issue"
    printf 'Ubuntu 26.04.1 LTS\n' >"${ROOT}/etc/issue.net"
  fi
  echo "ClaudeOS branding reverted."
fi
