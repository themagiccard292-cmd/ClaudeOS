#!/usr/bin/env python3
"""Merge overlayfs-style layer directories into one tree without mounting overlayfs.

Fallback for build hosts where `mount -t overlay` is unavailable. Layers are given bottom-most
first (e.g. the unsquashfs'ed minimal, minimal.standard, minimal.standard.live). The semantics
follow the kernel overlayfs rules that apply to read-only lower layers:

* a character device with device number 0/0 is a *whiteout*: the path is deleted from the result;
* a directory with xattr ``trusted.overlay.opaque=y`` is *opaque*: everything below it from lower
  layers is hidden, only the upper layer's contents survive;
* any other entry replaces (non-directories) or merges into (directories) what lies below.

The copy itself is done by rsync (-aHAX --numeric-ids) so hard links, ACLs, xattrs (file
capabilities!) and devices are preserved exactly as in the primary overlay+rsync path.
"""

from __future__ import annotations

import argparse
import os
import shutil
import stat
import subprocess
import sys
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path

OPAQUE_XATTR = "trusted.overlay.opaque"
OVERLAY_XATTR_PREFIX = "trusted.overlay."


def is_whiteout(st: os.stat_result) -> bool:
    return stat.S_ISCHR(st.st_mode) and st.st_rdev == 0


def is_opaque(path: str) -> bool:
    try:
        return os.getxattr(path, OPAQUE_XATTR, follow_symlinks=False) == b"y"
    except OSError:
        return False


@dataclass
class LayerScan:
    whiteouts: list[str] = field(default_factory=list)  # relative paths
    opaque_dirs: list[str] = field(default_factory=list)  # relative paths


def scan_layer(layer: Path) -> LayerScan:
    """Find whiteouts and opaque directories in one layer (paths relative to the layer root)."""
    result = LayerScan()
    # Whiteouts are character devices, so os.walk lists them among the non-directory names.
    for dirpath, _dirnames, filenames in os.walk(layer):
        rel_dir = os.path.relpath(dirpath, layer)
        if rel_dir != "." and is_opaque(dirpath):
            result.opaque_dirs.append(rel_dir)
        for name in filenames:
            if is_whiteout(os.lstat(os.path.join(dirpath, name))):
                result.whiteouts.append(os.path.normpath(os.path.join(rel_dir, name)))
    result.whiteouts.sort()
    result.opaque_dirs.sort()
    return result


def _remove(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    elif path.exists() or path.is_symlink():
        path.unlink()


def apply_deletions(root: Path, scan: LayerScan) -> None:
    """Delete whiteout targets and empty opaque directories' lower contents in ROOT."""
    for rel in scan.whiteouts:
        _remove(root / rel)
    for rel in scan.opaque_dirs:
        target = root / rel
        if target.is_symlink() or (target.exists() and not target.is_dir()):
            target.unlink()
        elif target.is_dir():
            for child in target.iterdir():
                _remove(child)


def strip_overlay_xattrs(root: Path, rel_dirs: Iterable[str]) -> None:
    for rel in rel_dirs:
        path = root / rel
        try:
            names = os.listxattr(path, follow_symlinks=False)
        except OSError:
            continue
        for name in names:
            if name.startswith(OVERLAY_XATTR_PREFIX):
                os.removexattr(path, name, follow_symlinks=False)


def rsync_copy(src: Path, dest: Path, excludes: list[str]) -> None:
    cmd = ["rsync", "-aHAX", "--numeric-ids", "--force"]
    # Anchored excludes ("/path") so a whiteout only matches its own location.
    for rel in excludes:
        cmd.append("--exclude=/" + rel)
    cmd += [f"{src}/", f"{dest}/"]
    subprocess.run(cmd, check=True)


Copier = Callable[[Path, Path, list[str]], None]


def flatten(layers: list[Path], dest: Path, copier: Copier = rsync_copy) -> None:
    """Merge LAYERS (bottom first) into DEST."""
    dest.mkdir(parents=True, exist_ok=True)
    for index, layer in enumerate(layers):
        scan = scan_layer(layer)
        if index > 0:
            apply_deletions(dest, scan)
        copier(layer, dest, scan.whiteouts)
        strip_overlay_xattrs(dest, scan.opaque_dirs)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("dest", type=Path, help="destination root filesystem directory")
    parser.add_argument("layers", type=Path, nargs="+", help="layer directories, bottom-most first")
    args = parser.parse_args(argv)
    for layer in args.layers:
        if not layer.is_dir():
            parser.error(f"not a directory: {layer}")
    flatten(args.layers, args.dest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
