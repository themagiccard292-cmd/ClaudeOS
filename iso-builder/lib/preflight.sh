# shellcheck shell=bash
# Stage 1 (preflight) and stage 2 (download + verify).

BUILD_TOOLS=(xorriso mksquashfs unsquashfs rsync gpg gpgv curl dpkg-deb dpkg-scanpackages gawk python3 sha256sum md5sum chroot mount umount mountpoint)
INSTALL_HINT="sudo apt-get install xorriso squashfs-tools rsync gnupg curl dpkg-dev gawk"

# free_gb DIR: free space (GiB, integer) of the filesystem holding DIR (or its nearest existing parent).
free_gb() {
  local d="$1"
  while [[ ! -d "$d" ]]; do d="$(dirname "$d")"; done
  df -P -B1G "$d" | awk 'NR == 2 { print $4 }'
}

stage_preflight() {
  local missing
  if ! missing="$(require_tools "${BUILD_TOOLS[@]}")"; then
    if is_dry_run; then
      log_warn "missing tools (ignored in --dry-run): ${missing//$'\n'/ }"
    else
      die "missing tools: ${missing//$'\n'/ }. Install them with: ${INSTALL_HINT}"
    fi
  fi
  if is_dry_run; then
    log_info "dry run: skipping root, disk space and overlayfs checks"
    return 0
  fi
  [[ "$(id -u)" -eq 0 ]] || die "the build needs root (loop/overlay mounts, chroot). Re-run with sudo, or use --dry-run."
  local free
  free="$(free_gb "$WORK_DIR")"
  ((free >= MIN_FREE_GB)) || die "only ${free} GB free under ${WORK_DIR}; at least ${MIN_FREE_GB} GB are needed (use --work-dir on a bigger disk)"
  log_info "free space under ${WORK_DIR}: ${free} GB (need ${MIN_FREE_GB})"
  if overlay_supported; then
    log_info "overlayfs available"
  else
    log_warn "overlayfs unavailable - stage 4 will use the unsquashfs + manual whiteout fallback"
  fi
}

# fetch_signing_keys KEYRING: build the gpgv keyring from UBUNTU_KEY_FILES or the keyserver.
fetch_signing_keys() {
  local keyring="$1" keydir fpr files=()
  keydir="$(dirname "$keyring")/keys"
  mkdir -p "$keydir"
  if [[ -n "$UBUNTU_KEY_FILES" ]]; then
    read -r -a files <<<"$UBUNTU_KEY_FILES"
  else
    for fpr in $UBUNTU_SIGNING_FPRS; do
      fetch "${UBUNTU_KEYSERVER}/pks/lookup?op=get&options=mr&search=0x${fpr}" "$keydir/$fpr.asc"
      files+=("$keydir/$fpr.asc")
    done
  fi
  build_keyring "$keyring" "${files[@]}"
}

stage_download() {
  local iso_name sums sig
  iso_name="$(iso_filename "$ISO_VERSION")"
  sums="$CACHE_DIR/SHA256SUMS-$ISO_VERSION"
  sig="$CACHE_DIR/SHA256SUMS-$ISO_VERSION.gpg"
  run mkdir -p "$CACHE_DIR"

  if [[ "$SKIP_DOWNLOAD" == 1 ]]; then
    log_info "--skip-download: using cached files only"
  else
    # SHA256SUMS(.gpg) are small and change if Ubuntu re-spins: always fetch them fresh.
    run rm -f "$sums" "$sig"
    fetch "$(sums_url "$ISO_VERSION" SHA256SUMS)" "$sums"
    fetch "$(sums_url "$ISO_VERSION" SHA256SUMS.gpg)" "$sig"
    if [[ -z "$UBUNTU_ISO" ]]; then
      fetch "$(iso_url "$ISO_VERSION")" "$CACHE_DIR/$iso_name"
    fi
  fi
  if is_dry_run; then
    dry_note "verify GPG signature of SHA256SUMS (gpgv, keys ${UBUNTU_SIGNING_FPRS}) unless SKIP_GPG=1"
    dry_note "verify SHA256 of $SOURCE_ISO against SHA256SUMS and the pinned hash"
    printf '+ sha256sum %q\n' "$SOURCE_ISO"
    return 0
  fi
  [[ -f "$SOURCE_ISO" ]] || die "ISO not found: $SOURCE_ISO (run without --skip-download, or pass --ubuntu-iso)"

  # GPG first: only a signed SHA256SUMS is used as a source of truth.
  local fetched=""
  if [[ "$SKIP_GPG" == 1 ]]; then
    log_warn "SKIP_GPG=1: the signature of SHA256SUMS is NOT verified"
  else
    [[ -f "$sums" && -f "$sig" ]] || die "SHA256SUMS/SHA256SUMS.gpg not available - cannot verify the signature (SKIP_GPG=1 to bypass)"
    local keyring="$WORK_DIR/gpg/ubuntu-cdimage.gpg"
    mkdir -p "$(dirname "$keyring")"
    fetch_signing_keys "$keyring"
    gpg_verify_sums "$sums" "$sig" "$keyring" "$UBUNTU_SIGNING_FPRS" || die "GPG verification of SHA256SUMS failed"
  fi
  if [[ -f "$sums" ]]; then
    fetched="$(parse_sha256sums "$sums" "$iso_name" || true)"
    [[ -n "$fetched" ]] || log_warn "SHA256SUMS has no entry for $iso_name"
  fi
  local pinned expected
  pinned="$(pinned_sha256_for "$ISO_VERSION" || true)"
  expected="$(resolve_expected_sha256 "$fetched" "$pinned" "${ALLOW_UNPINNED:-0}")" || die "cannot establish the expected SHA256 of $iso_name"
  log_info "computing SHA256 of $SOURCE_ISO (takes a minute)"
  verify_sha256 "$SOURCE_ISO" "$expected" || die "SHA256 verification of $SOURCE_ISO failed"
}
