#!/usr/bin/env python3
"""Remove a snap from a classic snapd seed (``/var/lib/snapd/seed``).

The seed is described by ``seed.yaml``::

    snaps:
      - name: ubuntu-desktop-bootstrap
        channel: latest/stable/ubuntu-26.04
        classic: true
        file: ubuntu-desktop-bootstrap_421.snap

The entry is removed with a line-based edit that leaves every other byte of the file untouched
(no YAML re-serialisation, so comments/ordering/quoting snapd relies on survive). When PyYAML is
importable the result is re-parsed and checked semantically. The referenced ``snaps/<file>`` and
the matching ``assertions/<stem>.assert`` are deleted as well. Idempotent: removing a snap that is
not seeded succeeds and changes nothing.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

ITEM_RE = re.compile(r"^(?P<indent>\s*)-\s+(?P<rest>.*)$")
KEY_RE = re.compile(r"^\s*(?:-\s+)?(?P<key>[A-Za-z0-9_-]+):\s*(?P<value>.*?)\s*$")


@dataclass
class SeedEntry:
    start: int  # first line index (inclusive)
    end: int  # last line index (exclusive)
    name: str | None
    file: str | None


def _unquote(value: str) -> str:
    value = value.split(" #", 1)[0].strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        return value[1:-1]
    return value


def parse_entries(lines: list[str]) -> list[SeedEntry]:
    """Locate the items of the top-level ``snaps:`` sequence."""
    try:
        snaps_at = next(i for i, line in enumerate(lines) if re.match(r"^snaps:\s*(#.*)?$", line))
    except StopIteration:
        return []
    # The section ends at the next top-level key (column 0, not a comment, not a sequence dash).
    section_end = len(lines)
    for i in range(snaps_at + 1, len(lines)):
        line = lines[i]
        if line.strip() and not line.startswith((" ", "\t", "-", "#")):
            section_end = i
            break
    item_indent: str | None = None
    starts: list[int] = []
    for i in range(snaps_at + 1, section_end):
        m = ITEM_RE.match(lines[i])
        if not m:
            continue
        if item_indent is None:
            item_indent = m.group("indent")
        if m.group("indent") == item_indent:
            starts.append(i)
    entries: list[SeedEntry] = []
    for n, start in enumerate(starts):
        end = starts[n + 1] if n + 1 < len(starts) else section_end
        # Trailing blank/comment lines belong to the following context, not to this item.
        while end > start + 1 and not lines[end - 1].strip():
            end -= 1
        name = file = None
        key_indent: int | None = None
        for line in lines[start:end]:
            km = KEY_RE.match(line)
            if not km:
                continue
            col = line.index(km.group("key"))
            if key_indent is None:
                key_indent = col
            if col != key_indent:
                continue  # nested mapping - not one of the item's own keys
            if km.group("key") == "name":
                name = _unquote(km.group("value"))
            elif km.group("key") == "file":
                file = _unquote(km.group("value"))
        entries.append(SeedEntry(start, end, name, file))
    return entries


def remove_snap_from_yaml(text: str, snap: str) -> tuple[str, list[str]]:
    """Return (new_text, removed_files) with every entry named SNAP removed."""
    lines = text.splitlines(keepends=True)
    entries = [e for e in parse_entries(lines) if e.name == snap]
    removed_files = [e.file for e in entries if e.file]
    for entry in sorted(entries, key=lambda e: e.start, reverse=True):
        del lines[entry.start : entry.end]
    return "".join(lines), removed_files


def _validate(text: str, snap: str, expected_count: int) -> None:
    try:
        import yaml  # type: ignore[import-untyped]
    except ImportError:
        return
    data = yaml.safe_load(text) or {}
    snaps = data.get("snaps") or []
    names = [s.get("name") for s in snaps]
    if snap in names or len(snaps) != expected_count:
        raise SystemExit(f"seed.yaml validation failed after removing {snap}: {names}")


def remove_snap(seed_dir: Path, snap: str) -> tuple[bool, list[Path]]:
    """Edit SEED_DIR/seed.yaml in place and delete the snap's files.

    Returns (seed_yaml_changed, deleted_paths).
    """
    seed_yaml = seed_dir / "seed.yaml"
    text = seed_yaml.read_text(encoding="utf-8")
    before = len(parse_entries(text.splitlines(keepends=True)))
    new_text, files = remove_snap_from_yaml(text, snap)
    if new_text == text:
        return False, []
    after = len(parse_entries(new_text.splitlines(keepends=True)))
    _validate(new_text, snap, after)
    if before - after < 1:
        raise SystemExit(f"internal error: {snap} entry not removed")
    seed_yaml.write_text(new_text, encoding="utf-8")
    deleted: list[Path] = []
    for name in files:
        stem = name[: -len(".snap")] if name.endswith(".snap") else name
        for candidate in (seed_dir / "snaps" / name, seed_dir / "assertions" / f"{stem}.assert"):
            if candidate.exists():
                candidate.unlink()
                deleted.append(candidate)
    return True, deleted


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Remove a snap from a classic snapd seed.")
    parser.add_argument("--seed-dir", type=Path, required=True)
    parser.add_argument("--snap", required=True)
    args = parser.parse_args(argv)
    if not (args.seed_dir / "seed.yaml").is_file():
        print(f"no seed.yaml in {args.seed_dir}; nothing to do")
        return 0
    changed, deleted = remove_snap(args.seed_dir, args.snap)
    if not changed:
        print(f"{args.snap}: not seeded (ok)")
        return 0
    print(f"removed {args.snap} from {args.seed_dir / 'seed.yaml'}")
    for path in deleted:
        print(f"removed {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
