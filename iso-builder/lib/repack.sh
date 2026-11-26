# shellcheck shell=bash
# Stage 8: write the new ISO with xorriso, replaying the original boot setup, then verify it.
#
# Approach: load the ORIGINAL image as -indev and write a NEW image to -outdev. `-boot_image any replay`
# re-applies exactly the El Torito catalog (BIOS: GRUB eltorito.img; UEFI: the appended FAT ESP holding
# shim + signed GRUB), the hybrid MBR/GPT system area and the appended partition of the original, so
# BIOS, UEFI and Secure Boot behave like the stock ISO. Only the paths we changed are touched:
# /casper is replaced as a whole, and the edited boot menus, .disk/info and md5sum.txt are mapped over
# their originals. Everything else (pool/, EFI/, boot/grub modules...) is copied from the original image.

# Paths (relative to the ISO root) that the pipeline modifies.
REPACK_CHANGED_FILES=(boot/grub/grub.cfg boot/grub/loopback.cfg .disk/info md5sum.txt)

# xorriso_repack_args ORIG TREE OUT VOLID: print the xorriso argv, NUL separated.
xorriso_repack_args() {
  local orig="$1" tree="$2" out="$3" volid="$4" f
  # -file_size_limit off: the merged filesystem.squashfs can exceed 4 GiB (stored as an ISO level 3
  # multi-extent file, which the Linux isofs driver used by casper reads fine).
  local args=(xorriso -indev "$orig" -outdev "$out" -boot_image any replay -volid "$volid"
    -file_size_limit off --
    -rm_r /casper -- -map "$tree/casper" /casper)
  for f in "${REPACK_CHANGED_FILES[@]}"; do
    args+=(-map "$tree/$f" "/$f")
  done
  # Re-apply the default permissions of the original image for the new files.
  args+=(-chmod_r a+rX,go-w /casper --)
  args+=(-commit)
  printf '%s\0' "${args[@]}"
}

# verify_boot_report: read the text of
#   xorriso -indev ISO -report_el_torito plain -report_system_area plain
# on stdin; print a one-line summary and succeed only if BOTH a BIOS El Torito boot image AND a UEFI boot
# path (an El Torito UEFI image, an EFI System Partition GPT type GUID, or an MBR 0xef partition) exist.
# Pure function over text so it can be unit tested with recorded xorriso output.
verify_boot_report() {
  awk '
    /^El Torito boot img[[:space:]]*:/ {
      if ($0 ~ /[[:space:]]BIOS[[:space:]]/) bios = 1
      if ($0 ~ /[[:space:]]UEFI[[:space:]]/) efi_et = 1
    }
    # EFI System Partition type GUID C12A7328-F81F-11D2-BA4B-00A0C93EC93B in xorriso byte order.
    /^GPT type GUID[[:space:]]*:/ && tolower($0) ~ /28732ac11ff8d211ba4b00a0c93ec93b/ { efi_gpt = 1 }
    /^MBR partition[[:space:]]*:/ && tolower($0) ~ /[[:space:]]0xef[[:space:]]/ { efi_mbr = 1 }
    /^System area summary:/ && /grub2-mbr/ { grub_mbr = 1 }
    END {
      efi = efi_et || efi_gpt || efi_mbr
      printf "bios_eltorito=%s uefi_eltorito=%s esp_gpt=%s esp_mbr=%s grub2_mbr=%s\n", \
        bios ? "yes" : "no", efi_et ? "yes" : "no", efi_gpt ? "yes" : "no", efi_mbr ? "yes" : "no", grub_mbr ? "yes" : "no"
      exit (bios && efi) ? 0 : 1
    }
  '
}

boot_report() { xorriso -indev "$1" -report_el_torito plain -report_system_area plain 2>&1; }

stage_repack() {
  local tree out_iso volid
  tree="$(iso_tree)"
  out_iso="$OUT_DIR/$(output_iso_name "$ISO_VERSION")"
  volid="$(volume_id "$ISO_VERSION")"
  local cmd=()
  mapfile -d '' -t cmd < <(xorriso_repack_args "$SOURCE_ISO" "$tree" "$out_iso" "$volid")
  run mkdir -p "$OUT_DIR"
  run rm -f "$out_iso" "$out_iso.sha256"
  run "${cmd[@]}"
  if is_dry_run; then
    printf '+ xorriso -indev %q -report_el_torito plain -report_system_area plain | verify_boot_report\n' "$out_iso"
    printf '+ (cd %q && sha256sum %q > %q)\n' "$OUT_DIR" "$(basename "$out_iso")" "$(basename "$out_iso").sha256"
    return 0
  fi
  local report summary
  report="$(boot_report "$out_iso")"
  printf '%s\n' "$report" >"$WORK_DIR/boot-report.txt"
  if ! summary="$(verify_boot_report <<<"$report")"; then
    die "boot verification failed for $out_iso ($summary); see $WORK_DIR/boot-report.txt"
  fi
  log_info "boot verification: $summary"
  verify_iso_boot_files "$out_iso"
  (cd "$OUT_DIR" && sha256sum "$(basename "$out_iso")" >"$(basename "$out_iso").sha256")
  log_info "wrote $out_iso ($(du -h "$out_iso" | cut -f1)) and $(basename "$out_iso").sha256"
}

# verify_iso_boot_files ISO: casper/vmlinuz and casper/initrd inside the new image are the originals.
verify_iso_boot_files() {
  local iso="$1" chk
  chk="$(mktemp -d -p "$WORK_DIR" verify.XXXXXX)"
  mkdir -p "$chk/casper"
  xorriso -osirrox on -indev "$iso" -extract /casper/vmlinuz "$chk/casper/vmlinuz" \
    -extract /casper/initrd "$chk/casper/initrd" >/dev/null 2>&1 || die "cannot read casper/vmlinuz+initrd back from $iso"
  assert_boot_files_unchanged "$chk"
  safe_rm_rf "$WORK_DIR" "$chk"
}
