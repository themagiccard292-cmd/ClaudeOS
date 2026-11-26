#!/usr/bin/env python3
"""Write an apt flat-repository ``Packages`` index for a directory of .deb files.

Fallback for hosts without ``dpkg-scanpackages`` (dpkg-dev) and ``apt-ftparchive`` (apt-utils).
Each stanza is the package's control file (read with ``dpkg-deb -f``) plus the fields apt needs to
fetch and verify it: Filename (``./<name>.deb``, relative to the flat repo), Size, MD5sum, SHA1,
SHA256. Stanzas are sorted by package name then file name for reproducibility.
"""

from __future__ import annotations

import argparse
import hashlib
import subprocess
import sys
from pathlib import Path

# Fields dpkg-scanpackages emits first, in this order; any other control field follows.
LEADING = ["Package", "Version", "Architecture", "Maintainer", "Installed-Size"]


def control_fields(deb: Path) -> str:
    return subprocess.run(
        ["dpkg-deb", "-f", str(deb)], check=True, capture_output=True, text=True
    ).stdout


def parse_control(text: str) -> list[tuple[str, str]]:
    """Parse a control paragraph into ordered (field, value) pairs; continuation lines kept."""
    fields: list[tuple[str, str]] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        if line[0] in " \t" and fields:
            name, value = fields[-1]
            fields[-1] = (name, value + "\n" + line)
            continue
        name, _, value = line.partition(":")
        fields.append((name.strip(), value.strip()))
    return fields


def stanza(deb: Path, rel: str) -> tuple[str, str]:
    fields = parse_control(control_fields(deb))
    data = deb.read_bytes()
    lookup = dict(fields)
    ordered = [(k, lookup[k]) for k in LEADING if k in lookup]
    rest = [(k, v) for k, v in fields if k not in LEADING and k != "Description"]
    extra = [
        ("Filename", rel),
        ("Size", str(len(data))),
        ("MD5sum", hashlib.md5(data).hexdigest()),  # noqa: S324 - apt index field, not security
        ("SHA1", hashlib.sha1(data).hexdigest()),  # noqa: S324
        ("SHA256", hashlib.sha256(data).hexdigest()),
    ]
    tail = [("Description", lookup["Description"])] if "Description" in lookup else []
    text = "".join(f"{k}: {v}\n" for k, v in ordered + rest + extra + tail)
    return lookup.get("Package", ""), text


def build_index(repo: Path) -> str:
    entries = []
    for deb in sorted(repo.glob("*.deb")):
        name, text = stanza(deb, f"./{deb.name}")
        entries.append((name, deb.name, text))
    entries.sort()
    return "\n".join(text for _, _, text in entries)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate a flat-repo Packages index.")
    parser.add_argument("repo", type=Path)
    args = parser.parse_args(argv)
    sys.stdout.write(build_index(args.repo))
    return 0


if __name__ == "__main__":
    sys.exit(main())
