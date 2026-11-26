# shellcheck shell=bash
# Stage 6: write the single casper/filesystem.squashfs (+ .size, .manifest) and drop the stock layers.

# mksquashfs_args SRC DEST: the full mksquashfs command line for the configured compressor.
mksquashfs_args() {
  local src="$1" dest="$2"
  local args=(mksquashfs "$src" "$dest" -noappend -b "${SQUASHFS_BLOCK_SIZE:-1M}")
  case "${SQUASHFS_COMP:-zstd}" in
    zstd) args+=(-comp zstd -Xcompression-level "${SQUASHFS_ZSTD_LEVEL:-19}") ;;
    xz) args+=(-comp xz -Xbcj x86) ;;
    *)
      log_warn "unsupported SQUASHFS_COMP='${SQUASHFS_COMP}' (use zstd or xz)"
      return 1
      ;;
  esac
  [[ -n "${JOBS:-}" ]] && args+=(-processors "$JOBS")
  # xattrs are kept (default): file capabilities such as cap_net_raw on ping live in security.* xattrs.
  # Pseudo filesystems and scratch dirs keep their (empty) directories but none of their contents.
  args+=(-wildcards -e 'proc/*' 'sys/*' 'dev/*' 'run/*' 'tmp/*' 'var/tmp/*')
  printf '%s\0' "${args[@]}"
}

# casper_cleanup CASPER_DIR: delete every stock rootfs artefact (all *.squashfs layers, their
# *.manifest*, *.size and install-sources.yaml). vmlinuz, initrd and anything else are kept.
# Prints the deleted file names.
casper_cleanup() {
  local dir="$1"
  find "$dir" -maxdepth 1 -type f \( -name '*.squashfs' -o -name '*.manifest' -o -name '*.manifest.*' \
    -o -name '*.size' -o -name 'install-sources.yaml' \) -printf '%f\n' -delete | LC_ALL=C sort
}

# validate_manifest FILE: every line is "<package>[:arch]<TAB><version>" (dpkg-query -W format); prints count.
validate_manifest() {
  awk -F '\t' '
    NF != 2 || $1 !~ /^[a-z0-9][a-z0-9+.-]+(:[a-z0-9]+)?$/ || $2 !~ /^[A-Za-z0-9.+~:-]+$/ { bad = NR; exit }
    { n++ }
    END { if (bad || n == 0) { if (bad) printf "invalid manifest line %d\n", bad > "/dev/stderr"; exit 1 } print n }
  ' "$1"
}

# rootfs_size_bytes DIR: uncompressed size casper/ubiquity-style (du -sx in bytes).
rootfs_size_bytes() { du -sx --block-size=1 "$1" | cut -f1; }

stage_squashfs() {
  local rootfs casper tmp_sq
  rootfs="$(rootfs_dir)"
  casper="$(iso_tree)/casper"
  tmp_sq="$WORK_DIR/filesystem.squashfs.new"
  local cmd=()
  mapfile -d '' -t cmd < <(mksquashfs_args "$rootfs" "$tmp_sq")
  ((${#cmd[@]})) || die "bad squashfs settings"
  run rm -f "$tmp_sq"
  run "${cmd[@]}"
  if is_dry_run; then
    printf '+ du -sx --block-size=1 %q | cut -f1 > %q\n' "$rootfs" "$casper/filesystem.size"
    dry_note "delete casper/*.squashfs, *.manifest*, *.size, install-sources.yaml (keep vmlinuz, initrd)"
  else
    local pkgs
    pkgs="$(validate_manifest "$WORK_DIR/filesystem.manifest")" || die "bad or missing filesystem.manifest from the customise stage"
    log_info "filesystem.manifest lists ${pkgs} packages"
    local size deleted
    size="$(rootfs_size_bytes "$rootfs")"
    deleted="$(casper_cleanup "$casper")"
    log_info "removed stock casper files: ${deleted//$'\n'/ }"
  fi
  run mv "$tmp_sq" "$casper/filesystem.squashfs"
  run cp "$WORK_DIR/filesystem.manifest" "$casper/filesystem.manifest"
  if ! is_dry_run; then
    printf '%s\n' "$size" >"$casper/filesystem.size"
  fi
  assert_boot_files_unchanged "$(iso_tree)"
}
