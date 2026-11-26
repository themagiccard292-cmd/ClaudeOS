# shellcheck shell=bash
# Stage 5: customise the merged root filesystem inside a chroot.
#
# Invariants enforced here (see docs/ARCHITECTURE.md C7 and CLAUDE.md non-negotiable #4):
#   * the kernel/modules in the rootfs never change (linux-*, grub*, shim* are held during the build and the
#     set of /lib/modules versions is compared before/after), because casper/vmlinuz + initrd are reused as-is;
#   * no service starts inside the chroot (policy-rc.d exits 101) and no initramfs is regenerated;
#   * everything the build adds for itself (policy-rc.d, diversions, local apt source, holds, resolv.conf,
#     apt lists) is removed again before the squashfs is written.

LOCALREPO_IN_CHROOT=/var/cache/claudeos-localrepo
LOCALREPO_LIST=/etc/apt/sources.list.d/claudeos-local.list

localrepo_dir() { printf '%s/localrepo\n' "$WORK_DIR"; }
chroot_state_dir() { printf '%s/chroot-state\n' "$WORK_DIR"; }

# in_chroot CMD...: run CMD inside the rootfs with a minimal, clean environment. env -i also guarantees
# that no ANTHROPIC_* / provider variables from the build host leak into anything run in the image.
in_chroot() {
  run chroot "$(rootfs_dir)" /usr/bin/env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/root LANG=C.UTF-8 LC_ALL=C.UTF-8 DEBIAN_FRONTEND=noninteractive \
    "$@"
}

APT_GET=(apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

# ------------------------------------------------------------------ pure helpers (unit tested)

# select_hold_packages: read `dpkg-query -W -f='${Package} ${db:Status-Abbrev}\n'` on stdin and print
# the installed packages that must not change: kernel images/headers/modules/meta (linux-*), grub* and shim*.
select_hold_packages() {
  awk '$2 ~ /^[hi]i/ && $1 ~ /^(linux-|grub|shim)/ { print $1 }' | LC_ALL=C sort -u
}

# packages_from_list FILE: package names from a packages.list (comments/blank lines removed).
packages_from_list() {
  sed -e 's/#.*//' -e 's/[[:space:]]\+$//' -e 's/^[[:space:]]\+//' "$1" | awk 'NF { print $1 }'
}

# node_version_ok VERSION MIN_MAJOR: Debian version string (e.g. 22.14.0+dfsg-1, 1:20.1) >= MIN_MAJOR.
node_version_ok() {
  local v="$1" min="$2" upstream major
  [[ -n "$v" && "$v" != "(none)" ]] || return 1
  upstream="${v#*:}"
  major="${upstream%%[.~+-]*}"
  [[ "$major" =~ ^[0-9]+$ ]] && ((major >= min))
}

# ensure_universe_deb822 FILE: add "universe" to every Components: line of a deb822 sources file that
# lacks it (the ISO's ubuntu.sources normally has it already). Prints "changed" or "unchanged".
ensure_universe_deb822() {
  local file="$1" tmp
  tmp="$(mktemp)"
  awk '
    /^Components:/ {
      has = 0
      for (i = 2; i <= NF; i++) if ($i == "universe") has = 1
      if (!has) { $0 = $0 " universe"; changed = 1 }
    }
    { print }
    END { exit changed ? 0 : 3 }
  ' "$file" >"$tmp" && { cat "$tmp" >"$file"; rm -f "$tmp"; echo changed; return 0; }
  local rc=$?
  rm -f "$tmp"
  if [[ $rc -eq 3 ]]; then
    echo unchanged
    return 0
  fi
  return "$rc"
}

# strip_cdrom_sources FILE: remove apt sources that point at the install disc (cdrom: / file:/cdrom). The
# stock image ships such an entry (cdrom.sources); during the build /cdrom does not exist, so `apt-get update`
# would die with "repository 'file:/cdrom ... Release' does not have a Release file". Handles deb822
# (*.sources: drops whole stanzas) and one-line (*.list / sources.list) files. Prints "changed" or "unchanged".
strip_cdrom_sources() {
  local file="$1" tmp
  tmp="$(mktemp)"
  case "$file" in
    *.sources)
      awk 'BEGIN { RS = ""; ORS = "\n\n" } /(^|\n)URIs:[^\n]*(cdrom:|file:\/+cdrom)/ { next } { print }' "$file" >"$tmp"
      ;;
    *)
      grep -Ev '^[[:space:]]*deb(-src)?[[:space:]].*(cdrom:|file:/+cdrom)' "$file" >"$tmp" || true
      ;;
  esac
  if cmp -s "$file" "$tmp"; then
    rm -f "$tmp"
    echo unchanged
  else
    cat "$tmp" >"$file"
    rm -f "$tmp"
    echo changed
  fi
}

# disable_cdrom_sources: apply strip_cdrom_sources to every apt source file of the rootfs.
disable_cdrom_sources() {
  local root f
  root="$(rootfs_dir)"
  if is_dry_run; then
    dry_note "remove cdrom: / file:/cdrom apt sources from $root/etc/apt (sources.list, sources.list.d/*)"
    return 0
  fi
  for f in "$root/etc/apt/sources.list" "$root"/etc/apt/sources.list.d/*.sources "$root"/etc/apt/sources.list.d/*.list; do
    [[ -f "$f" ]] || continue
    if [[ "$(strip_cdrom_sources "$f")" == changed ]]; then
      log_info "removed cdrom source(s) from ${f#"$root"/}"
      # A file left with no stanzas/lines is dead weight (and confuses apt): drop it.
      [[ -s "$f" ]] && grep -q '[^[:space:]]' "$f" || rm -f "$f"
    fi
  done
}

# write_default_ubuntu_sources FILE CODENAME: used only when the rootfs has no ubuntu.sources at all.
write_default_ubuntu_sources() {
  cat >"$1" <<EOF
Types: deb
URIs: http://archive.ubuntu.com/ubuntu/
Suites: $2 $2-updates $2-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: $2-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
}

# set_kv FILE KEY VALUE: set KEY="VALUE" in an os-release style file (replace or append).
set_kv() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { line = k "=\"" v "\"" }
    index($0, k "=") == 1 { if (!done) print line; done = 1; next }
    { print }
    END { if (!done) print line }
  ' "$file" >"$tmp"
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

# brand_os_release FILE VERSION BASE_PRETTY: C7 os-release branding. ID=ubuntu / ID_LIKE=debian are kept
# so that tooling which keys off the distribution ID keeps working.
brand_os_release() {
  local file="$1" version="$2"
  set_kv "$file" NAME "${PRODUCT_NAME:-ClaudeOS}"
  set_kv "$file" PRETTY_NAME "${PRODUCT_NAME:-ClaudeOS} ${version} (Ubuntu ${version} LTS)"
  set_kv "$file" VERSION_ID "$version"
  set_kv "$file" CLAUDEOS_BASE "ubuntu-${version}"
}

# brand_rootfs ROOT VERSION: os-release, lsb-release, /etc/issue{,.net}, GRUB distributor.
brand_rootfs() {
  local root="$1" version="$2" osr="$1/usr/lib/os-release"
  # /etc/os-release is normally a symlink to ../usr/lib/os-release; edit the real file.
  [[ -f "$osr" ]] || osr="$root/etc/os-release"
  brand_os_release "$osr" "$version"
  if [[ -f "$root/etc/lsb-release" ]]; then
    set_kv "$root/etc/lsb-release" DISTRIB_DESCRIPTION "${PRODUCT_NAME:-ClaudeOS} ${version}"
  fi
  printf '%s %s \\n \\l\n\n' "${PRODUCT_NAME:-ClaudeOS}" "$version" >"$root/etc/issue"
  printf '%s %s\n' "${PRODUCT_NAME:-ClaudeOS}" "$version" >"$root/etc/issue.net"
  mkdir -p "$root/etc/default/grub.d"
  # grub-install derives the EFI directory (/EFI/<id>) from GRUB_DISTRIBUTOR. Signed GRUB/shim only
  # chainload from /EFI/ubuntu, so the id must stay "ubuntu" even though os-release says ClaudeOS.
  printf '# Installed by the ClaudeOS ISO builder: keep the EFI directory id "ubuntu" (Secure Boot).\nGRUB_DISTRIBUTOR="Ubuntu"\n' \
    >"$root/etc/default/grub.d/50-claudeos-distributor.cfg"
}

# ------------------------------------------------------------------ chroot plumbing

chroot_mount() {
  local root
  root="$(rootfs_dir)"
  local d
  for d in proc sys dev dev/pts run; do
    run mkdir -p "$root/$d"
    mount_tracked "$root/$d" --bind "/$d"
  done
  run mkdir -p "$root$LOCALREPO_IN_CHROOT"
  mount_tracked "$root$LOCALREPO_IN_CHROOT" --bind -o ro "$(localrepo_dir)"
}

# Replace resolv.conf with the host's for network access; the original (usually a symlink to the
# systemd-resolved stub) is saved once and restored by chroot_restore_resolv.
chroot_setup_resolv() {
  local root state
  root="$(rootfs_dir)"
  state="$(chroot_state_dir)"
  run mkdir -p "$state"
  if is_dry_run || [[ ! -e "$state/resolv.conf.orig" && ! -L "$state/resolv.conf.orig" ]]; then
    if is_dry_run || [[ -e "$root/etc/resolv.conf" || -L "$root/etc/resolv.conf" ]]; then
      run cp -a "$root/etc/resolv.conf" "$state/resolv.conf.orig"
    fi
  fi
  run rm -f "$root/etc/resolv.conf"
  run cp -L /etc/resolv.conf "$root/etc/resolv.conf"
}

chroot_restore_resolv() {
  local root state
  root="$(rootfs_dir)"
  state="$(chroot_state_dir)"
  run rm -f "$root/etc/resolv.conf"
  if is_dry_run || [[ -e "$state/resolv.conf.orig" || -L "$state/resolv.conf.orig" ]]; then
    run cp -a "$state/resolv.conf.orig" "$root/etc/resolv.conf"
  fi
}

chroot_block_services() {
  local root
  root="$(rootfs_dir)"
  if is_dry_run; then
    printf '+ printf %q > %q\n' '#!/bin/sh\nexit 101\n' "$root/usr/sbin/policy-rc.d"
  else
    printf '#!/bin/sh\n# ClaudeOS ISO build: never start services in the chroot.\nexit 101\n' >"$root/usr/sbin/policy-rc.d"
  fi
  run chmod 0755 "$root/usr/sbin/policy-rc.d"
  # No initramfs regeneration: casper/initrd from the original ISO is reused unchanged.
  if is_dry_run || ! in_chroot dpkg-divert --list /usr/sbin/update-initramfs | grep -q claudeos; then
    in_chroot dpkg-divert --local --rename --divert /usr/sbin/update-initramfs.claudeos-build --add /usr/sbin/update-initramfs
  fi
  if is_dry_run; then
    printf '+ printf %q > %q\n' '#!/bin/sh\nexit 0\n' "$root/usr/sbin/update-initramfs"
  else
    printf '#!/bin/sh\n# ClaudeOS ISO build: initramfs generation disabled during the build.\nexit 0\n' >"$root/usr/sbin/update-initramfs"
  fi
  run chmod 0755 "$root/usr/sbin/update-initramfs"
}

chroot_unblock_services() {
  local root
  root="$(rootfs_dir)"
  run rm -f "$root/usr/sbin/update-initramfs"
  in_chroot dpkg-divert --local --rename --divert /usr/sbin/update-initramfs.claudeos-build --remove /usr/sbin/update-initramfs
  run rm -f "$root/usr/sbin/policy-rc.d"
}

# ------------------------------------------------------------------ build steps

kernel_snapshot() { find "$(rootfs_dir)/lib/modules" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | LC_ALL=C sort; }

hold_kernel_packages() {
  local state
  state="$(chroot_state_dir)"
  if is_dry_run; then
    dry_note "hold every installed linux-*, grub*, shim* package (from dpkg-query)"
    in_chroot apt-mark hold '<linux-* grub* shim* packages>'
    return 0
  fi
  # shellcheck disable=SC2016 # dpkg-query format fields, not shell variables
  in_chroot dpkg-query -W -f='${Package} ${db:Status-Abbrev}\n' | select_hold_packages >"$state/held-packages"
  [[ -s "$state/held-packages" ]] || die "found no linux-*/grub*/shim* packages to hold - unexpected rootfs"
  mapfile -t held <"$state/held-packages"
  in_chroot apt-mark hold "${held[@]}" >/dev/null
  log_info "held ${#held[@]} kernel/bootloader packages"
  kernel_snapshot >"$state/kernels.before"
}

unhold_kernel_packages() {
  local state
  state="$(chroot_state_dir)"
  if is_dry_run; then
    in_chroot apt-mark unhold '<held packages>'
    return 0
  fi
  mapfile -t held <"$state/held-packages"
  in_chroot apt-mark unhold "${held[@]}" >/dev/null
}

assert_kernel_unchanged() {
  is_dry_run && { dry_note "assert /lib/modules versions are unchanged"; return 0; }
  local state
  state="$(chroot_state_dir)"
  kernel_snapshot >"$state/kernels.after"
  cmp -s "$state/kernels.before" "$state/kernels.after" ||
    die "kernel modules changed during customisation: $(diff "$state/kernels.before" "$state/kernels.after" | tr '\n' ' ')"
}

enable_universe() {
  local root src codename
  root="$(rootfs_dir)"
  src="$root/etc/apt/sources.list.d/ubuntu.sources"
  if is_dry_run; then
    dry_note "ensure 'universe' is in every Components: line of $src"
    return 0
  fi
  if [[ -f "$src" ]]; then
    log_info "universe in ubuntu.sources: $(ensure_universe_deb822 "$src")"
  else
    codename="$(sed -n 's/^VERSION_CODENAME=//p' "$root/etc/os-release" | tr -d '"')"
    [[ -n "$codename" ]] || die "cannot determine VERSION_CODENAME for ubuntu.sources"
    log_warn "rootfs has no ubuntu.sources; writing the default archive sources for ${codename}"
    write_default_ubuntu_sources "$src" "$codename"
  fi
}

add_localrepo_source() {
  local root
  root="$(rootfs_dir)"
  if is_dry_run; then
    printf '+ echo %q > %q\n' "deb [trusted=yes] file:$LOCALREPO_IN_CHROOT ./" "$root$LOCALREPO_LIST"
  else
    printf 'deb [trusted=yes] file:%s ./\n' "$LOCALREPO_IN_CHROOT" >"$root$LOCALREPO_LIST"
  fi
}

# Build the local repository from the debs produced by iso-builder/build-debs.sh.
prepare_localrepo() {
  local repo debs_dir
  repo="$(localrepo_dir)"
  debs_dir="${DEBS_DIR:-$ISO_BUILDER_DIR/out/debs}"
  if ! is_dry_run; then
    compgen -G "$debs_dir/*.deb" >/dev/null || die "no .deb files in $debs_dir - run 'make debs' (iso-builder/build-debs.sh) first"
  fi
  run mkdir -p "$repo"
  if is_dry_run; then
    printf '+ cp %q/*.deb %q/\n' "$debs_dir" "$repo"
  else
    cp -- "$debs_dir"/*.deb "$repo/"
  fi
  run bash "$ISO_BUILDER_DIR/lib/repo-index.sh" "$repo"
}

# Install the node fallback package when the archive's nodejs is too old for Claude Code.
# Prints the package names to use for nodejs/npm.
maybe_node_fallback() {
  local candidate
  if is_dry_run; then
    dry_note "if the archive nodejs candidate is < ${NODE_MIN_MAJOR}: download node-v${NODE_FALLBACK_VERSION}-linux-x64.tar.xz, verify SHA256 and package it as claudeos-nodejs"
    return 0
  fi
  candidate="$(in_chroot apt-cache policy nodejs | awk '/Candidate:/ { print $2; exit }')"
  if node_version_ok "$candidate" "$NODE_MIN_MAJOR"; then
    log_info "archive nodejs candidate ${candidate} satisfies >= ${NODE_MIN_MAJOR}"
    return 0
  fi
  log_warn "archive nodejs candidate '${candidate:-none}' is older than ${NODE_MIN_MAJOR}; using the official tarball ${NODE_FALLBACK_VERSION}"
  local tarball="$CACHE_DIR/node-v${NODE_FALLBACK_VERSION}-linux-x64.tar.xz"
  [[ -f "$tarball" ]] || fetch "${NODE_DIST_URL}/v${NODE_FALLBACK_VERSION}/node-v${NODE_FALLBACK_VERSION}-linux-x64.tar.xz" "$tarball"
  verify_sha256 "$tarball" "$NODE_FALLBACK_SHA256" || die "node tarball checksum mismatch"
  bash "$ISO_BUILDER_DIR/lib/node-deb.sh" "$tarball" "$NODE_FALLBACK_VERSION" "$(localrepo_dir)"
  bash "$ISO_BUILDER_DIR/lib/repo-index.sh" "$(localrepo_dir)"
  in_chroot "${APT_GET[@]}" update
  NODE_PACKAGES_OVERRIDE="claudeos-nodejs"
}

install_packages() {
  local pkgs=() p
  NODE_PACKAGES_OVERRIDE=""
  maybe_node_fallback
  while IFS= read -r p; do
    if [[ -n "$NODE_PACKAGES_OVERRIDE" && ("$p" == nodejs || "$p" == npm) ]]; then
      continue
    fi
    pkgs+=("$p")
  done < <(packages_from_list "$ISO_BUILDER_DIR/config/packages.list")
  [[ -n "$NODE_PACKAGES_OVERRIDE" ]] && pkgs+=("$NODE_PACKAGES_OVERRIDE")
  in_chroot "${APT_GET[@]}" install claudeos-desktop "${pkgs[@]}"
}

run_claudeos_setup_scripts() {
  in_chroot /usr/lib/claudeos/install-claude-code.sh || die "install-claude-code.sh failed"
  in_chroot claude --version || die "'claude --version' failed inside the image"
  in_chroot /usr/lib/claudeos/computer-control/setup-venv.sh || die "computer-control setup-venv.sh failed"
  in_chroot /opt/claudeos/venv/bin/python -c 'import mcp' || die "the MCP venv cannot import mcp"
}

remove_stock_installer() {
  local root snap
  root="$(rootfs_dir)"
  for snap in $STOCK_INSTALLER_SNAPS; do
    run python3 "$ISO_BUILDER_DIR/lib/seed_edit.py" --seed-dir "$root/var/lib/snapd/seed" --snap "$snap"
  done
  if is_dry_run || in_chroot sh -c 'command -v snap' >/dev/null 2>&1; then
    if is_dry_run || [[ -f "$root/var/lib/snapd/seed/seed.yaml" ]]; then
      in_chroot snap debug validate-seed /var/lib/snapd/seed/seed.yaml || die "snap seed no longer validates"
    fi
  fi
  # Launchers / autostarts of the stock installers in the live session.
  local d
  for d in usr/share/applications etc/xdg/autostart usr/share/desktop-directories; do
    if is_dry_run; then
      printf '+ find %q -maxdepth 1 ( -name *ubuntu-desktop-bootstrap* -o -name *ubiquity* ) -delete\n' "$root/$d"
    elif [[ -d "$root/$d" ]]; then
      find "$root/$d" -maxdepth 1 \( -name '*ubuntu-desktop-bootstrap*' -o -name '*ubiquity*' \) -print -delete
    fi
  done
}

finalise_desktop() {
  local root
  root="$(rootfs_dir)"
  if is_dry_run; then
    dry_note "brand os-release/lsb-release/issue/GRUB distributor in $root"
  else
    brand_rootfs "$root" "$ISO_VERSION"
  fi
  if is_dry_run || [[ -x "$root/usr/lib/claudeos/apply-branding.sh" ]]; then
    in_chroot /usr/lib/claudeos/apply-branding.sh || die "apply-branding.sh failed"
  else
    log_warn "/usr/lib/claudeos/apply-branding.sh not installed by any package; only the builder's os-release branding applies"
  fi
  in_chroot dconf update
  in_chroot glib-compile-schemas /usr/share/glib-2.0/schemas
  # shellcheck disable=SC2016 # expanded by the shell inside the chroot, not here
  in_chroot sh -c 'for d in /usr/share/icons/*/; do [ -f "$d/index.theme" ] && gtk-update-icon-cache -q -f -t "$d"; done; true'
  in_chroot systemctl --global enable ydotoold.service
  local sandbox=/opt/claudeos/panel/chrome-sandbox
  in_chroot chown root:root "$sandbox"
  in_chroot chmod 4755 "$sandbox"
  if ! is_dry_run; then
    [[ "$(stat -c '%u:%g %a' "$root$sandbox")" == "0:0 4755" ]] || die "$sandbox must be root-owned with mode 4755"
  fi
}

write_manifest() {
  # shellcheck disable=SC2016 # ${Package} is a dpkg-query format field, not a shell variable
  run_to "$WORK_DIR/filesystem.manifest" chroot "$(rootfs_dir)" dpkg-query -W --showformat='${Package}\t${Version}\n'
}

chroot_cleanup() {
  local root
  root="$(rootfs_dir)"
  run rm -f "$root$LOCALREPO_LIST"
  in_chroot "${APT_GET[@]}" clean
  run find "$root/var/lib/apt/lists" -mindepth 1 -delete
  run find "$root/tmp" "$root/var/tmp" -mindepth 1 -delete
  # Empty (not missing) machine-id: systemd generates a fresh one on first boot of each system.
  run truncate -s 0 "$root/etc/machine-id"
  if is_dry_run || [[ -f "$root/var/lib/dbus/machine-id" && ! -L "$root/var/lib/dbus/machine-id" ]]; then
    run rm -f "$root/var/lib/dbus/machine-id"
  fi
  run rm -f "$root/root/.bash_history" "$root/root/.python_history" "$root/root/.wget-hsts"
  chroot_restore_resolv
}

stage_customize() {
  local state
  state="$(chroot_state_dir)"
  run mkdir -p "$state"
  prepare_localrepo
  chroot_mount
  chroot_setup_resolv
  chroot_block_services
  hold_kernel_packages
  disable_cdrom_sources
  enable_universe
  add_localrepo_source
  in_chroot "${APT_GET[@]}" update
  install_packages
  run_claudeos_setup_scripts
  remove_stock_installer
  finalise_desktop
  assert_kernel_unchanged
  unhold_kernel_packages
  write_manifest
  chroot_unblock_services
  chroot_cleanup
  if ! is_dry_run; then
    unmount_all || die "could not unmount the chroot bind mounts"
  fi
}
