# Building the ClaudeOS ISO

`scripts/build-iso.sh` remasters the official Ubuntu 26.04.1 desktop ISO into `claudeos-26.04.1-amd64.iso`.
The contract is `docs/ARCHITECTURE.md` C7; this file explains how to run it and why each stage exists.

## Prerequisites

* Ubuntu 24.04 / 26.04 (or Debian) build host, **root** (loop/overlay mounts, chroot), amd64.
* ~45 GB free in the work dir (checked by preflight), 8 GB RAM recommended, network access (apt + npm inside the chroot).
* Packages: `xorriso squashfs-tools rsync gnupg curl dpkg-dev gawk python3 python3-yaml`.
* The module packages: `make debs` (needs `npm ci` in `side-panel/` for the panel package once it ships a `package.meta`).

```bash
make debs                       # iso-builder/out/debs (local file apt repo used by the chroot)
sudo scripts/build-iso.sh       # -> dist/claudeos-26.04.1-amd64.iso + .sha256
scripts/build-iso.sh --dry-run  # prints every command, needs no root and no network
```

Options: `--work-dir --out-dir --cache-dir --ubuntu-iso PATH --skip-download --keep-work --no-gpg --dry-run`.
Environment: `SQUASHFS_COMP=zstd|xz` (zstd default; xz is ~10% smaller but slower), `SKIP_GPG=1`, `ALLOW_UNPINNED=1`,
`SOURCE_DATE_EPOCH`, `JOBS`, `DEBS_DIR`.

## Stages

Every stage writes a stamp file in `<work>/.stamps`; re-running with `--keep-work` resumes. An EXIT trap unmounts
everything in reverse order and only then deletes the work dir through `safe_rm_rf` (refuses `/`, `$HOME`, system
directories, paths outside the work dir, and anything with a mount still below it).

1. **preflight** - root, required tools, free disk.
2. **download** - ISO + `SHA256SUMS` (+ `.gpg`). The SHA256 must match BOTH the fetched SUMS and the pinned hash
   `601e30fb...da1f`; any disagreement fails unless `ALLOW_UNPINNED=1`. The GPG signature fails closed unless `SKIP_GPG=1`.
   The signing fingerprints in `iso-builder/config/build.conf` are marked "verify before release".
3. **extract** - `xorriso -osirrox` copies the ISO tree; vmlinuz/initrd hashes are recorded.
4. **rootfs** - the stock ISO ships layered squashfs files (`minimal`, `minimal.standard`, `minimal.standard.live`).
   They are loop-mounted and merged through a read-only **overlayfs** into a work rootfs with `rsync -aHAXx` so
   whiteouts and file capabilities are honoured. Hosts without overlayfs use `lib/flatten_layers.py` (manual whiteout/opaque handling).
5. **customize** - chroot with bind mounts and `policy-rc.d`; `apt-mark hold` on `linux-*`, `grub*`, `shim*` (the kernel in the
   squashfs MUST match `casper/vmlinuz`, which we keep byte-identical; asserted); enable universe; install our debs from a local
   file repo and `iso-builder/config/packages.list` (includes grub-pc-bin, grub-efi-amd64-signed, shim-signed, efibootmgr so the
   installer can set up the bootloader offline); nodejs >= 22 (official-tarball fallback, checksum-verified); run
   `install-claude-code.sh` and `setup-venv.sh` (build fails if `claude --version` or `import mcp` fails); remove the
   `ubuntu-desktop-bootstrap` snap from the seed (YAML-aware) and stock installer autostarts; branding; dconf/schemas/icon cache;
   check `chrome-sandbox` is `4755 root`; clean apt, tmp, machine-id, resolv.conf; write the dpkg manifest.
6. **squashfs** - ONE `casper/filesystem.squashfs` (+ `.size`, `.manifest`); all other casper squashfs/manifests and
   `install-sources.yaml` are removed so casper and Calamares see a single flat image.
7. **bootconfig** - `grub.cfg`/`loopback.cfg` entries become "Try or Install ClaudeOS" / "ClaudeOS (safe graphics)"; an existing
   `layerfs-path=` is pointed at `filesystem.squashfs` (the stock 26.04.1 file has none); `.disk/info`; `md5sum.txt` in stock format.
8. **repack** - `xorriso -indev ORIG -outdev NEW -boot_image any replay` keeps the original hybrid BIOS+UEFI boot records
   (El Torito, appended EFI partition, GRUB MBR) exactly, replacing only `/casper` and the changed files. Volume id
   `ClaudeOS 26.04.1 amd64`. The result is verified by parsing `xorriso -report_el_torito plain -report_system_area plain`
   (BIOS and EFI must both be present). `-boot_image any replay` was chosen over `-report_el_torito as_mkisofs` because it needs
   no hand-maintained option list that could drift from the Ubuntu image.

The final filesystem is >4 GiB; the ISO is written with `-file_size_limit off` (multi-extent), which Linux isofs/casper reads.

## Testing the result in QEMU

```bash
qemu-system-x86_64 -enable-kvm -m 6G -smp 4 -cdrom dist/claudeos-26.04.1-amd64.iso -boot d \
  -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd   # UEFI; omit for BIOS
```

## Release builds and the 2 GiB limit

`.github/workflows/build-iso.yml` runs on `v*` tags or manually. GitHub release assets are limited to 2 GiB and the ISO is
larger, so the release carries parts `claudeos-26.04.1-amd64.iso.part-aa`, `-ab`, ... (1900 MiB each) plus `SHA256SUMS`.
Reassemble with `scripts/join-iso.sh DIR` or `cat claudeos-*.iso.part-* > claudeos-26.04.1-amd64.iso && sha256sum -c SHA256SUMS`.
The whole ISO is also uploaded as a workflow artifact (7 days).

## Troubleshooting

* "mounts still below work dir": `findmnt -R <work>`; unmount, re-run. Cleanup never `rm -rf`s a mounted tree.
* Hash mismatch: Ubuntu may have re-spun the image; verify out of band, then update the pin in `build.conf` (or `ALLOW_UNPINNED=1`).
* No overlayfs (containers): the fallback flattener is used automatically; needs `rsync` and root.
* Disk full: the work dir needs ~45 GB; point `--work-dir` at a big disk.

## Verified vs not verified

Verified (offline, in `make -C iso-builder test`): argument parsing and dry run, `safe_rm_rf`, stamp/unmount ordering, hash/GPG
decision logic, hold-package selection, layer chain, grub/loopback rewrite against the real 26.04.1 files, `.disk/info`,
`md5sum.txt`, boot-report parser against recorded xorriso output, snap seed editing, whiteout fallback, deb building with real `dpkg-deb`,
workflow structure, and real `mksquashfs`/`xorriso` calls on tiny synthetic inputs.

**Not verified**: a full run of the pipeline (needs root, ~45 GB, network), booting the ISO (BIOS/UEFI/Secure Boot),
the Calamares install, `claude` inside the chroot, and the GitHub workflows on a real runner.

## Getting the full ISO (one file)

GitHub release assets are capped at 2 GiB per file and the ISO is several GiB, so there are three ways to obtain it:

| Source | Command | Notes |
|---|---|---|
| **ghcr.io (recommended)** | `scripts/download-iso.sh --repo OWNER/ClaudeOS` | Single full file, resumable, verifies the registry digest and the SHA256. Needs `curl` + `jq`. The CI job `publish-ghcr` pushes `ghcr.io/<owner>/claudeos-iso:<version>` (also `:latest`) on tag pushes or when `publish` is ticked. **New packages are private by default**: make the package public once (repo → Packages → `claudeos-iso` → Package settings → Change visibility), or set `GH_TOKEN` (a token with `read:packages`) to download a private one. |
| Workflow artifact | `scripts/download-iso.sh --source artifact --repo OWNER/ClaudeOS --run-id <id>` | Full ISO, needs `gh` logged in, expires after 7 days. Also downloadable from the Actions run page. |
| Release parts | `scripts/download-iso.sh --source release --repo OWNER/ClaudeOS` | Split `*.iso.part-NN` files joined by `scripts/join-iso.sh`; verifies SHA256SUMS. |

Verified: the downloader is covered by offline tests against a fake registry. Not verified: an actual push to ghcr.io or a download from it (that needs a real CI run).
