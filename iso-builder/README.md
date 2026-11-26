# iso-builder

Debian packaging, the ISO remaster pipeline and CI for ClaudeOS.

* `build-debs.sh [--out DIR] [--only m,...]` - one `.deb` per module with a `package.meta` (`make install DESTDIR=...`,
  `dpkg-deb --root-owner-group -Zxz`, SUID preserved, path-allow-list lint) plus the meta package `claudeos-desktop` and a flat
  `Packages.gz` index in `out/debs`. The installer package is only *Recommended* by the meta package so that purging Calamares
  from the installed system does not remove ClaudeOS.
* `lib/` - the pipeline stages used by `scripts/build-iso.sh` (see `docs/BUILDING.md`); `flatten_layers.py`, `seed_edit.py`, `scan_packages.py` helpers.
* `config/` - `build.conf` (pinned hash, GPG fingerprints, node fallback), `packages.list`.
* `tests/` - offline pytest suite; `make test-integration` adds real xorriso/mksquashfs runs.

```bash
make -C iso-builder bootstrap   # optional venv with pytest/PyYAML/ruff
make -C iso-builder lint test
```

Known limits: the full ISO build/boot has not been run in CI-less sandboxes; see `docs/BUILDING.md`.
