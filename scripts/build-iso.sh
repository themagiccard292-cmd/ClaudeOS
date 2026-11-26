#!/usr/bin/env bash
# Build claudeos-<version>-amd64.iso by remastering the official Ubuntu desktop ISO.
# See docs/BUILDING.md for the full description of every stage and docs/ARCHITECTURE.md C7 for the contract.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ISO_BUILDER_DIR="$REPO_ROOT/iso-builder"

# shellcheck source=iso-builder/config/build.conf
source "$ISO_BUILDER_DIR/config/build.conf"
for lib in common download preflight rootfs chroot squashfs bootcfg repack; do
  # shellcheck source=/dev/null
  source "$ISO_BUILDER_DIR/lib/$lib.sh"
done

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Remaster the Ubuntu ${ISO_VERSION} desktop ISO into $(output_iso_name "$ISO_VERSION").
Needs root, ~${MIN_FREE_GB} GB free in the work dir and network access (apt + npm inside the chroot).

Options:
  --work-dir DIR      scratch directory (default: \$WORK_DIR or ./work)
  --out-dir DIR       where the ISO and its .sha256 are written (default: ./dist)
  --cache-dir DIR     where downloads are kept between runs (default: \$CACHE_DIR or ./cache)
  --ubuntu-iso PATH   use this local Ubuntu ISO instead of downloading it (still SHA256-verified)
  --skip-download     do not download anything; use the cached ISO/SHA256SUMS
  --keep-work         keep the work dir afterwards (needed to resume a failed build)
  --no-gpg            do not verify the GPG signature of SHA256SUMS (same as SKIP_GPG=1)
  --dry-run           print every command that would run; touches nothing, needs no root/network
  -h, --help          show this help

Environment: ISO_VERSION (${ISO_VERSION}), JOBS, SQUASHFS_COMP (zstd|xz), SKIP_GPG=1, ALLOW_UNPINNED=1,
SOURCE_DATE_EPOCH, DEBS_DIR (default iso-builder/out/debs).
EOF
}

parse_args() {
  WORK_DIR="${WORK_DIR:-$PWD/work}"
  OUT_DIR="${OUT_DIR:-$PWD/dist}"
  CACHE_DIR="${CACHE_DIR:-$PWD/cache}"
  UBUNTU_ISO=""
  SKIP_DOWNLOAD=0
  KEEP_WORK=0
  DRY_RUN=0
  SKIP_GPG="${SKIP_GPG:-0}"
  while (($#)); do
    case "$1" in
      --work-dir | --out-dir | --cache-dir | --ubuntu-iso)
        [[ $# -ge 2 && -n "$2" ]] || die "$1 needs a value (see --help)"
        case "$1" in
          --work-dir) WORK_DIR="$2" ;;
          --out-dir) OUT_DIR="$2" ;;
          --cache-dir) CACHE_DIR="$2" ;;
          --ubuntu-iso) UBUNTU_ISO="$2" ;;
        esac
        shift 2
        ;;
      --skip-download) SKIP_DOWNLOAD=1 && shift ;;
      --keep-work) KEEP_WORK=1 && shift ;;
      --no-gpg) SKIP_GPG=1 && shift ;;
      --dry-run) DRY_RUN=1 && shift ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
  done
  WORK_DIR="$(realpath -m -- "$WORK_DIR")"
  OUT_DIR="$(realpath -m -- "$OUT_DIR")"
  CACHE_DIR="$(realpath -m -- "$CACHE_DIR")"
  if [[ -n "$UBUNTU_ISO" ]]; then
    UBUNTU_ISO="$(realpath -m -- "$UBUNTU_ISO")"
    SOURCE_ISO="$UBUNTU_ISO"
  else
    SOURCE_ISO="$CACHE_DIR/$(iso_filename "$ISO_VERSION")"
  fi
  if path_is_under "$WORK_DIR" "$OUT_DIR" || path_is_under "$WORK_DIR" "$CACHE_DIR" || path_is_under "$WORK_DIR" "$SOURCE_ISO"; then
    die "--out-dir, --cache-dir and the source ISO must not live inside the work dir (it is deleted after the build)"
  fi
  case "$WORK_DIR" in
    / | /bin | /boot | /dev | /etc | /home | /lib | /lib64 | /mnt | /opt | /proc | /root | /run | /sbin | /srv | /sys | /tmp | /usr | /var | "$(realpath -m -- "${HOME:-/root}")")
      die "refusing to use ${WORK_DIR} as the work dir; pick a dedicated directory"
      ;;
  esac
}

WORK_MARKER=.claudeos-iso-work

# Create the work dir (or adopt one from an earlier run, identified by our marker file).
init_work_dir() {
  if is_dry_run; then
    return 0
  fi
  if [[ -d "$WORK_DIR" && -n "$(ls -A "$WORK_DIR")" && ! -f "$WORK_DIR/$WORK_MARKER" ]]; then
    die "$WORK_DIR exists, is not empty and was not created by this script; refusing to use it"
  fi
  mkdir -p "$WORK_DIR"
  touch "$WORK_DIR/$WORK_MARKER"
}

on_exit() {
  local rc=$?
  trap - EXIT INT TERM
  if ! is_dry_run; then
    unmount_all || log_warn "some mounts below $WORK_DIR could not be removed - inspect with: findmnt -R $WORK_DIR"
    if [[ "$KEEP_WORK" == 1 ]]; then
      log_info "keeping the work dir $WORK_DIR (--keep-work); re-run with the same --work-dir to resume"
    elif [[ -f "$WORK_DIR/$WORK_MARKER" ]]; then
      safe_rm_rf "$WORK_DIR" "$WORK_DIR" || log_warn "work dir $WORK_DIR was not removed"
    fi
  fi
  if ((rc != 0)); then
    log_warn "build FAILED (exit ${rc})"
  fi
  exit "$rc"
}

main() {
  parse_args "$@"
  if is_dry_run; then
    log_info "DRY RUN - commands are printed with a leading '+', nothing is executed"
  fi
  log_info "ClaudeOS ${ISO_VERSION} ISO build: work=${WORK_DIR} out=${OUT_DIR} cache=${CACHE_DIR} source=${SOURCE_ISO}"
  init_work_dir
  trap on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  run_stage 1 preflight stage_preflight
  run_stage 2 download stage_download
  run_stage 3 extract stage_extract
  run_stage 4 rootfs stage_rootfs
  run_stage 5 customize stage_customize
  run_stage 6 squashfs stage_squashfs
  run_stage 7 bootconfig stage_bootconfig
  run_stage 8 repack stage_repack
  banner "Done: $OUT_DIR/$(output_iso_name "$ISO_VERSION")"
}

# Allow tests to source this file for its functions without running a build.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
