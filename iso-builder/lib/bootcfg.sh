# shellcheck shell=bash
# Stage 7: boot menu, .disk/info and md5sum.txt.

# rewrite_grub_cfg < IN > OUT: rebrand menu entry titles and point an existing layerfs-path= at the
# single merged squashfs. Everything else (kernel args "--- quiet splash", EFI entries) is untouched.
# The stock 26.04.1 grub.cfg has no layerfs-path= (casper then stacks every *.squashfs in /casper, and
# after stage 6 there is exactly one), so normally only the titles change.
rewrite_grub_cfg() {
  sed -E \
    -e '/^[[:space:]]*menuentry[[:space:]]/ s/Ubuntu/'"${PRODUCT_NAME:-ClaudeOS}"'/g' \
    -e 's/(^|[[:space:]])layerfs-path=[^[:space:]]+/\1layerfs-path=filesystem.squashfs/g'
}

# check_grub_cfg FILE: sanity checks on a rewritten boot menu.
check_grub_cfg() {
  local f="$1" product="${PRODUCT_NAME:-ClaudeOS}"
  grep -q "menuentry \"Try or Install ${product}\"" "$f" || { log_warn "$f: no 'Try or Install ${product}' entry"; return 1; }
  if grep -E '^[[:space:]]*menuentry[[:space:]]' "$f" | grep -q Ubuntu; then
    log_warn "$f: a menu entry still says Ubuntu"
    return 1
  fi
  grep -q -- '--- quiet splash' "$f" || { log_warn "$f: kernel args '--- quiet splash' missing"; return 1; }
  if grep -o 'layerfs-path=[^[:space:]]*' "$f" | grep -qv '^layerfs-path=filesystem\.squashfs$'; then
    log_warn "$f: layerfs-path points somewhere other than filesystem.squashfs"
    return 1
  fi
}

# disk_info_codename FILE: the quoted codename of an Ubuntu .disk/info ("Resolute Raccoon").
disk_info_codename() { sed -n 's/^[^"]*"\([^"]*\)".*$/\1/p' "$1" | head -n1; }

# build_date: YYYYMMDD from SOURCE_DATE_EPOCH (reproducible) or now, in UTC.
build_date() {
  if [[ -n "${SOURCE_DATE_EPOCH:-}" ]]; then
    date -u -d "@${SOURCE_DATE_EPOCH}" +%Y%m%d
  else
    date -u +%Y%m%d
  fi
}

# disk_info_line VERSION CODENAME DATE  (the stock file has no trailing newline; neither has ours)
disk_info_line() { printf '%s %s "%s" - Release %s (%s)' "${PRODUCT_NAME:-ClaudeOS}" "$1" "$2" "${ISO_ARCH:-amd64}" "$3"; }

# generate_md5sum TREE: write TREE/md5sum.txt in the stock format ("<md5>  ./path", C-locale path
# order, md5sum.txt and boot.catalog excluded).
generate_md5sum() {
  local tree="$1" tmp
  # The temporary file lives next to (not inside) the tree so it is not listed itself.
  tmp="$(mktemp -p "$(dirname "$tree")" md5sum.XXXXXX)"
  (
    cd "$tree" || exit 1
    find . -type f ! -path ./md5sum.txt ! -path ./boot.catalog -print0 | LC_ALL=C sort -z | xargs -0 -r md5sum
  ) >"$tmp"
  chmod 0644 "$tmp"
  mv "$tmp" "$tree/md5sum.txt"
}

stage_bootconfig() {
  local tree f
  tree="$(iso_tree)"
  for f in boot/grub/grub.cfg boot/grub/loopback.cfg; do
    if is_dry_run; then
      printf '+ rewrite_grub_cfg < %q > %q (rebrand menu titles; layerfs-path= -> filesystem.squashfs if present)\n' "$tree/$f" "$tree/$f"
      continue
    fi
    [[ -f "$tree/$f" ]] || die "ISO has no $f"
    rewrite_grub_cfg <"$tree/$f" >"$tree/$f.new"
    check_grub_cfg "$tree/$f.new" || die "rewritten $f failed the sanity checks"
    mv "$tree/$f.new" "$tree/$f"
  done
  if is_dry_run; then
    printf '+ printf %q > %q\n' "$(disk_info_line "$ISO_VERSION" "<codename from .disk/info>" "$(build_date)")" "$tree/.disk/info"
    printf '+ (cd %q && find . -type f ! -path ./md5sum.txt ! -path ./boot.catalog | sort | xargs md5sum) > %q\n' "$tree" "$tree/md5sum.txt"
    return 0
  fi
  local codename
  codename="$(disk_info_codename "$tree/.disk/info")"
  [[ -n "$codename" ]] || die "cannot read the release codename from .disk/info"
  disk_info_line "$ISO_VERSION" "$codename" "$(build_date)" >"$tree/.disk/info"
  log_info ".disk/info: $(cat "$tree/.disk/info")"
  generate_md5sum "$tree"
  log_info "md5sum.txt: $(wc -l <"$tree/md5sum.txt") entries"
}
