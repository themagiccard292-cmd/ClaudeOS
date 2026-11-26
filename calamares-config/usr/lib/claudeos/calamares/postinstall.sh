#!/usr/bin/env bash
# ClaudeOS post-install, run by Calamares (shellprocess) INSIDE the target chroot.
#   postinstall.sh prepare   before initramfs/bootloader: kernel sanity, purge live-only packages
#   postinstall.sh finalize  after the bootloader: first-boot flags, keyboard, EFI fallback, verify
#   postinstall.sh [all]     both, in order
# Non-critical problems are logged and skipped; exit 1 only if the system would not boot.
# CLAUDEOS_ROOT prefixes every path (tests); empty in the real chroot.
set -euo pipefail

ROOT="${CLAUDEOS_ROOT:-}"
LOG="$ROOT/var/log/claudeos-postinstall.log"
CRITICAL=0

mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG" >&2 || true; }
warn() { log "WARN: $*"; }
critical() { log "CRITICAL: $*"; CRITICAL=1; }

kernels() { # prints kernel versions found in /boot
  local f
  for f in "$ROOT"/boot/vmlinuz-*; do
    [ -e "$f" ] && printf '%s\n' "${f##*/vmlinuz-}"
  done
  return 0
}

ensure_kernel() {
  local ver
  if [ -n "$(kernels)" ]; then return 0; fi
  ver="$(uname -r)"
  if [ -r "$ROOT/cdrom/casper/vmlinuz" ]; then
    log "No kernel in /boot; copying live kernel as vmlinuz-$ver"
    cp "$ROOT/cdrom/casper/vmlinuz" "$ROOT/boot/vmlinuz-$ver" || warn "kernel copy failed"
  fi
}

# update-initramfs -u refuses to run when the initrd does not exist (LP#1829805).
ensure_initrd_placeholders() {
  local v
  while IFS= read -r v; do
    [ -n "$v" ] || continue
    [ -e "$ROOT/boot/initrd.img-$v" ] || : >"$ROOT/boot/initrd.img-$v"
  done < <(kernels)
}

installed_pkgs() { # filter arguments down to installed packages
  local p
  for p in "$@"; do
    if dpkg-query -W -f='${db:Status-Abbrev}' "$p" 2>/dev/null | grep -q '^.i'; then
      printf '%s\n' "$p"
    fi
  done
  return 0
}

purge_live_packages() {
  local keep=() purge=() p
  command -v dpkg-query >/dev/null 2>&1 || { warn "dpkg-query missing; skipping purge"; return 0; }
  # Purging the installer cascades to the claudeos-desktop meta package; protect the
  # real components from a later `apt autoremove`.
  while IFS= read -r p; do
    case "$p" in claudeos-calamares | claudeos-desktop) ;; *) keep+=("$p") ;; esac
  done < <(dpkg-query -W -f='${Package}\n' 'claudeos-*' 2>/dev/null || true)
  if [ "${#keep[@]}" -gt 0 ]; then
    apt-mark manual "${keep[@]}" >>"$LOG" 2>&1 || warn "apt-mark manual failed"
  fi
  mapfile -t purge < <(installed_pkgs casper calamares claudeos-calamares ubuntu-desktop-bootstrap)
  if [ "${#purge[@]}" -eq 0 ]; then
    log "No live-only packages installed"
    return 0
  fi
  log "Purging: ${purge[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get -y purge --no-autoremove "${purge[@]}" >>"$LOG" 2>&1 \
    || warn "apt-get purge failed (non-fatal)"
}

remove_live_leftovers() {
  rm -f "$ROOT/etc/xdg/autostart/claudeos-installer.desktop" \
    "$ROOT/usr/share/applications/claudeos-install.desktop" \
    "$ROOT/etc/sudoers.d/casper" "$ROOT/etc/sudoers.d/99-casper" 2>/dev/null || true
  # Remove a leftover casper live user, but only when another regular user exists.
  if grep -q '^ubuntu:' "$ROOT/etc/passwd" 2>/dev/null; then
    if awk -F: '$1 != "ubuntu" && $3 >= 1000 && $3 < 60000 {f=1} END {exit !f}' "$ROOT/etc/passwd"; then
      log "Removing leftover live user 'ubuntu'"
      userdel --remove ubuntu >>"$LOG" 2>&1 || warn "userdel ubuntu failed"
    else
      warn "'ubuntu' is the only regular user; leaving it"
    fi
  fi
  # A live autologin must not survive into the installed system.
  local gdm="$ROOT/etc/gdm3/custom.conf"
  if [ -f "$gdm" ] && grep -q '^AutomaticLogin=ubuntu' "$gdm"; then
    sed -i -e 's/^AutomaticLogin=ubuntu/#&/' -e 's/^AutomaticLoginEnable=.*/AutomaticLoginEnable=False/' "$gdm" \
      || warn "could not clean $gdm"
  fi
}

# Map the chosen locale (LANG) to an XKB layout[:variant]; empty output = leave unchanged.
layout_for_locale() {
  local lang="${1%%.*}" lc cc
  lang="${lang%%@*}"
  lc="${lang%%_*}"
  cc="${lang#*_}"
  [ "$cc" != "$lang" ] || cc=""
  case "$lc" in
    ar) echo ara; return ;;
    el) echo gr; return ;;
  esac
  case "$lc:$cc" in
    en:GB) echo gb ;;
    en:IE) echo ie ;;
    en:*) echo us ;;
    ca:ES) echo es:cat ;;
    fr:CH | de:CH) echo "ch:$lc" ;;
    nb:* | nn:*) echo no ;;
    sv:*) echo se ;;
    da:*) echo dk ;;
    cs:*) echo cz ;;
    ja:*) echo jp ;;
    ko:*) echo kr ;;
    zh:CN) echo cn ;;
    zh:TW) echo tw ;;
    he:*) echo il ;;
    uk:*) echo ua ;;
    et:*) echo ee ;;
    sl:*) echo si ;;
    sq:*) echo al ;;
    hy:*) echo am ;;
    ga:*) echo ie ;;
    hi:*) echo in ;;
    vi:*) echo vn ;;
    pt:BR) echo br ;;
    *:?*) printf '%s\n' "${cc,,}" ;;
    *) printf '%s\n' "$lc" ;;
  esac
}

configure_keyboard() {
  local lang="" f spec layout variant kb="$ROOT/etc/default/keyboard" lst="$ROOT/usr/share/X11/xkb/rules/evdev.lst"
  for f in "$ROOT/etc/default/locale" "$ROOT/etc/locale.conf"; do
    [ -r "$f" ] || continue
    lang="$(sed -n 's/^LANG=//p' "$f" | tr -d "\"'" | head -n1)"
    [ -z "$lang" ] || break
  done
  if [ -z "$lang" ]; then warn "no LANG found; keyboard left unchanged"; return 0; fi
  spec="$(layout_for_locale "$lang")"
  [ -n "$spec" ] || return 0
  layout="${spec%%:*}"
  variant=""
  [ "$spec" = "$layout" ] || variant="${spec#*:}"
  if [ -r "$lst" ] && ! grep -Eq "^ +$layout +" "$lst"; then
    warn "xkb layout '$layout' (from $lang) unknown; keyboard left unchanged"
    return 0
  fi
  log "Keyboard layout from locale $lang: $layout${variant:+ ($variant)}"
  mkdir -p "$(dirname "$kb")"
  [ -f "$kb" ] || printf 'XKBMODEL="pc105"\nXKBLAYOUT="us"\nXKBVARIANT=""\nXKBOPTIONS=""\nBACKSPACE="guess"\n' >"$kb"
  sed -i -e "s/^XKBLAYOUT=.*/XKBLAYOUT=\"$layout\"/" -e "s/^XKBVARIANT=.*/XKBVARIANT=\"$variant\"/" "$kb" \
    || warn "could not update $kb"
}

# Make the removable-media path a shim chain so Secure Boot also works through it.
ensure_efi_fallback() {
  local esp="$ROOT/boot/efi/EFI" f
  [ -f "$esp/ubuntu/shimx64.efi" ] || return 0
  mkdir -p "$esp/BOOT"
  cp "$esp/ubuntu/shimx64.efi" "$esp/BOOT/BOOTX64.EFI" || { warn "shim fallback copy failed"; return 0; }
  for f in fbx64.efi mmx64.efi grubx64.efi; do
    if [ -f "$esp/ubuntu/$f" ]; then cp "$esp/ubuntu/$f" "$esp/BOOT/$f" || warn "copy $f failed"; fi
  done
}

ensure_initrds() {
  local v
  while IFS= read -r v; do
    [ -n "$v" ] || continue
    if [ ! -s "$ROOT/boot/initrd.img-$v" ]; then
      log "initrd for $v missing; generating"
      update-initramfs -c -k "$v" >>"$LOG" 2>&1 || critical "update-initramfs failed for $v"
    fi
  done < <(kernels)
}

write_install_info() {
  local src="unknown"
  [ -r "$ROOT/cdrom/.disk/info" ] && src="$(head -n1 "$ROOT/cdrom/.disk/info")"
  {
    printf 'install_date=%s\n' "$(date -u +%FT%TZ)"
    printf 'source_iso=%s\n' "$src"
  } >"$ROOT/etc/claudeos-install-info" || warn "could not write install info"
}

prepare() {
  ensure_kernel
  ensure_initrd_placeholders
  purge_live_packages
  remove_live_leftovers
}

finalize() {
  remove_live_leftovers
  mkdir -p "$ROOT/etc/skel/.config"
  [ -e "$ROOT/etc/skel/.config/gnome-initial-setup-done" ] || : >"$ROOT/etc/skel/.config/gnome-initial-setup-done"
  configure_keyboard
  ensure_efi_fallback
  ensure_initrds
  write_install_info
  [ -n "$(kernels)" ] || critical "no kernel in /boot"
  [ -s "$ROOT/boot/grub/grub.cfg" ] || critical "/boot/grub/grub.cfg missing"
}

case "${1:-all}" in
  prepare) prepare ;;
  finalize) finalize ;;
  all) prepare; finalize ;;
  *) echo "usage: $0 [prepare|finalize|all]" >&2; exit 2 ;;
esac
exit "$CRITICAL"
