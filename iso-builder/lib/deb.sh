# shellcheck shell=bash
# Helpers for building Debian binary packages with plain dpkg-deb (no debhelper), shared by
# iso-builder/build-debs.sh and lib/node-deb.sh.

DEB_MAINTAINER="ClaudeOS Maintainers <noreply@users.noreply.github.com>"

# Top-level locations a package may ship files in. Everything else (/home, /root, /tmp, /run, /srv,
# /mnt, /media, /boot, /dev, /proc, /sys, /usr/local, /var/{tmp,log,cache,...}) is rejected.
DEB_ALLOWED_PREFIXES=(usr etc opt lib var/lib)

# format_description TEXT: Debian Description value (first line = synopsis, following lines indented,
# empty lines become " .").
format_description() {
  local first=1 line out=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    if ((first)); then
      out="$line"
      first=0
    elif [[ -z "${line// /}" ]]; then
      out+=$'\n .'
    else
      out+=$'\n '"$line"
    fi
  done <<<"$1"
  printf '%s\n' "$out"
}

# path_allowed REL: REL is a path inside a package (no leading "./" or "/").
path_allowed() {
  local rel="${1#./}" p
  rel="${rel#/}"
  rel="${rel%/}"
  [[ -z "$rel" ]] && return 0
  [[ "$rel" == usr/local || "$rel" == usr/local/* ]] && return 1
  for p in "${DEB_ALLOWED_PREFIXES[@]}"; do
    # Parents of an allowed prefix (e.g. "var" for "var/lib") are directories we must allow too.
    if [[ "$rel" == "$p" || "$rel" == "$p"/* || "$p" == "$rel"/* ]]; then
      return 0
    fi
  done
  return 1
}

# check_deb_listing: read `dpkg-deb -c` output on stdin; print offending paths, fail if any.
check_deb_listing() {
  local bad=0 line path
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    # Columns: perms owner/group size date time path [-> target]
    path="$(awk '{ print $6 }' <<<"$line")"
    if ! path_allowed "$path"; then
      printf '%s\n' "$path"
      bad=1
    fi
  done
  return "$bad"
}

# check_stage_tree STAGE: same check on a staged directory before building.
check_stage_tree() {
  local stage="$1" rel bad=0
  while IFS= read -r rel; do
    if ! path_allowed "$rel"; then
      printf '%s\n' "/$rel"
      bad=1
    fi
  done < <(cd "$stage" && find . -mindepth 1 -path ./DEBIAN -prune -o -print | sed 's|^\./||' | LC_ALL=C sort)
  return "$bad"
}

# installed_size_kib STAGE: like dpkg-gencontrol - sum of per-file sizes rounded up to KiB, 1 per dir/link.
installed_size_kib() {
  (cd "$1" && find . -mindepth 1 -path ./DEBIAN -prune -o -printf '%y %s\n') |
    awk '{ if ($1 == "f") total += int(($2 + 1023) / 1024); else total += 1 } END { print total + 0 }'
}

# write_control STAGE: write STAGE/DEBIAN/control from PKG_* variables
# (PKG_NAME PKG_VERSION PKG_ARCH PKG_DEPENDS PKG_RECOMMENDS PKG_SECTION PKG_DESCRIPTION, optional
#  PKG_PROVIDES PKG_CONFLICTS PKG_REPLACES).
write_control() {
  local stage="$1"
  mkdir -p "$stage/DEBIAN"
  {
    printf 'Package: %s\n' "$PKG_NAME"
    printf 'Version: %s\n' "$PKG_VERSION"
    printf 'Architecture: %s\n' "${PKG_ARCH:-all}"
    printf 'Maintainer: %s\n' "$DEB_MAINTAINER"
    printf 'Installed-Size: %s\n' "$(installed_size_kib "$stage")"
    [[ -n "${PKG_DEPENDS:-}" ]] && printf 'Depends: %s\n' "$PKG_DEPENDS"
    [[ -n "${PKG_RECOMMENDS:-}" ]] && printf 'Recommends: %s\n' "$PKG_RECOMMENDS"
    [[ -n "${PKG_PROVIDES:-}" ]] && printf 'Provides: %s\n' "$PKG_PROVIDES"
    [[ -n "${PKG_CONFLICTS:-}" ]] && printf 'Conflicts: %s\n' "$PKG_CONFLICTS"
    [[ -n "${PKG_REPLACES:-}" ]] && printf 'Replaces: %s\n' "$PKG_REPLACES"
    printf 'Section: %s\n' "${PKG_SECTION:-misc}"
    printf 'Priority: optional\n'
    printf 'Description: %s\n' "$(format_description "$PKG_DESCRIPTION")"
  } >"$stage/DEBIAN/control"
}

# normalize_tree STAGE EPOCH: deterministic mtimes (clamped to EPOCH) for reproducible packages.
normalize_tree() {
  find "$1" -newermt "@$2" -exec touch -h -d "@$2" {} +
}

# build_deb STAGE OUTDIR: build OUTDIR/<pkg>_<version>_<arch>.deb and print its path.
build_deb() {
  local stage="$1" outdir="$2" deb
  deb="$outdir/${PKG_NAME}_${PKG_VERSION}_${PKG_ARCH:-all}.deb"
  rm -f "$deb"
  dpkg-deb --build --root-owner-group -Zxz "$stage" "$deb" >/dev/null
  printf '%s\n' "$deb"
}

# lint_deb DEB: control parses, expected fields present, every path allowed.
lint_deb() {
  local deb="$1" f bad
  dpkg-deb -I "$deb" >/dev/null || { log_warn "$deb: dpkg-deb -I failed"; return 1; }
  for f in Package Version Architecture Maintainer Description; do
    [[ -n "$(dpkg-deb -f "$deb" "$f")" ]] || { log_warn "$deb: missing control field $f"; return 1; }
  done
  if ! bad="$(dpkg-deb -c "$deb" | check_deb_listing)"; then
    log_warn "$deb ships files outside the allowed prefixes (${DEB_ALLOWED_PREFIXES[*]}): ${bad//$'\n'/ }"
    return 1
  fi
}
