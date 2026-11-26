# calamares-config

Streamlined, ClaudeOS-branded Calamares (3.3.14, Ubuntu 26.04.1) configuration, package `claudeos-calamares`.
Flow: **Language (welcome) -> Timezone -> Disk (Erase disk preselected) -> Account -> Install -> Restart**.

## Pieces
- `etc/calamares/settings.conf`, `etc/calamares/modules/*.conf` - sequence and per-module config. `localecfg`, `hwclock`,
  `networkcfg`, `summary` are `noconfig` modules upstream, so they have no `.conf`.
- `usr/share/calamares/branding/claudeos/` - branding.desc (C8 palette), QML slideshow (`show.qml` + `Card.qml`), logo assets.
- `usr/lib/claudeos/calamares/launch-installer` - live-session launcher (silent unless `/cdrom/casper/filesystem.squashfs`
  exists and `boot=casper` is on the cmdline; `--force` skips only the cmdline check). Runs `xhost +si:localuser:root` then
  `pkexec env DISPLAY XAUTHORITY XDG_RUNTIME_DIR QT_QPA_PLATFORM=xcb calamares` (`CLAUDEOS_INSTALLER_DEBUG=1` adds `-d`).
  pkexec relies on the casper live user having passwordless polkit/sudo rights; there is no polkit rule of our own.
- `usr/lib/claudeos/calamares/postinstall.sh` - runs in the target chroot via `shellprocess`: `prepare` (before initramfs:
  kernel sanity, purge casper/calamares/claudeos-calamares/ubuntu-desktop-bootstrap with `--no-autoremove`, remove live
  autostarts and a leftover `ubuntu` user) and `finalize` (after bootloader: first-boot flag, keyboard from locale, shim
  removable-path fallback, initrd check, `/etc/claudeos-install-info`, log `/var/log/claudeos-postinstall.log`).
  Exit 1 only if no kernel or no `grub.cfg`. `CLAUDEOS_ROOT` prefixes all paths for tests.

## Decisions worth knowing
- **Keyboard**: Calamares only guesses a layout from the locale when the keyboard page is activated, so with no page
  the `keyboard` module would write the live layout. It is omitted; `finalize` maps the chosen `LANG` to an XKB layout.
  Caveat: the password is typed on the live (US) layout. Add `keyboard` after `locale` in `show` (and `exec`) to restore the page.
- **Partition label**: the page keeps the stock "Erase disk" label; the description uses branding `productName`.
- **GPT on BIOS** needs `createHybridBootloaderLayout` (bios_grub partition); BIOS installs also need `grub-pc-bin` in the squashfs.
- **EFI id stays `ubuntu`** (shim/signed grub are hard-wired to `\EFI\ubuntu`); `grubcfg` keeps `GRUB_DISTRIBUTOR`.
- Language packs are not installed (no network); translations arrive via Settings after install.

## Test
`make -C calamares-config lint test` (yamllint, shellcheck, ruff, pytest; offline). In a VM: boot the ISO under UEFI (OVMF),
the installer starts after ~3 s; try with and without Secure Boot. Not verified on real hardware or a real ISO boot.
