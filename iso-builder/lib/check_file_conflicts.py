#!/usr/bin/env python3
"""Fail if two of our .deb packages ship the same file path.

dpkg refuses to install two packages that own one file ("trying to overwrite ... which is also in
package ..."), which would otherwise only surface ~30 minutes into the ISO build, inside the chroot.
Usage: check_file_conflicts.py DEBS_DIR   (exit 0 = clean, 1 = conflicts, 2 = usage/tool error)
"""

from __future__ import annotations

import io
import subprocess
import sys
import tarfile
from collections import defaultdict
from pathlib import Path


def package_files(deb: Path) -> set[str]:
    """Regular files and symlinks (not directories) inside a .deb, normalised without the leading './'."""
    tar = subprocess.run(["dpkg-deb", "--fsys-tarfile", str(deb)], capture_output=True, check=True).stdout
    with tarfile.open(fileobj=io.BytesIO(tar)) as tf:
        return {m.name.removeprefix("./") for m in tf.getmembers() if not m.isdir()}


def find_conflicts(debs: list[Path]) -> dict[str, list[str]]:
    owners: dict[str, list[str]] = defaultdict(list)
    for deb in sorted(debs):
        name = deb.name.split("_", 1)[0]
        for path in package_files(deb):
            owners[path].append(name)
    return {p: o for p, o in owners.items() if len(o) > 1}


def main(argv: list[str]) -> int:
    if len(argv) != 2 or not Path(argv[1]).is_dir():
        print(__doc__, file=sys.stderr)
        return 2
    try:
        conflicts = find_conflicts(list(Path(argv[1]).glob("*.deb")))
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"check_file_conflicts: cannot read packages: {exc}", file=sys.stderr)
        return 2
    for path, owners in sorted(conflicts.items()):
        print(f"CONFLICT /{path}: shipped by {', '.join(owners)}", file=sys.stderr)
    return 1 if conflicts else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
