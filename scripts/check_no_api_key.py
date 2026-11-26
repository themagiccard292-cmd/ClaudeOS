#!/usr/bin/env python3
"""Guard: no code in the repository may READ, REQUIRE or SET an Anthropic API key.

ClaudeOS authenticates only with the Claude subscription OAuth flow. Code is allowed to *strip* the
variables from a child's environment (``unset``, ``env -u``, ``delete env.X``, ``del os.environ[...]``,
``.pop("X")``, or list the names as plain strings in a strip list); anything that dereferences or
assigns them is a violation:

    $ANTHROPIC_API_KEY  ${ANTHROPIC_API_KEY:-}  process.env.ANTHROPIC_API_KEY  process.env["..."]
    os.environ["..."]  os.environ.get("...")  os.getenv("...")  export ANTHROPIC_API_KEY=...

Usage: check_no_api_key.py [--root DIR] [FILE...]   (no FILEs: every git-tracked/untracked-unignored file)
Exit status 1 and a ``path:line: text`` report on violations.
"""

from __future__ import annotations

import argparse
import fnmatch
import re
import subprocess
import sys
from pathlib import Path

VARS = r"(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)"

# Occurrences that remove the variable. They are blanked out before the read patterns are checked.
STRIP_PATTERNS = [
    re.compile(rf"\bunset\s+(?:-v\s+)?(?:[A-Z_][A-Z0-9_]*\s+)*{VARS}"),
    re.compile(rf"(?:\benv\s+(?:-[a-zA-Z]+\s+)*)?(?:-u\s*|--unset[= ]){VARS}"),
    re.compile(rf"\bdelete\s+[\w.$]+(?:\.{VARS}|\[\s*['\"`]{VARS}['\"`]\s*\])"),
    re.compile(rf"\bdel\s+[\w.]+\[\s*['\"]{VARS}['\"]\s*\]"),
    re.compile(rf"\.pop\(\s*['\"]{VARS}['\"]"),
]

READ_PATTERNS = [
    re.compile(rf"\$\{{?{VARS}\b"),  # shell expansion
    re.compile(rf"process\.env\.{VARS}\b"),
    re.compile(rf"process\.env\[\s*['\"`]{VARS}['\"`]\s*\]"),
    re.compile(rf"environ\[\s*['\"]{VARS}['\"]\s*\]"),
    re.compile(rf"environ\.get\(\s*['\"]{VARS}['\"]"),
    re.compile(rf"getenv\(\s*['\"]{VARS}['\"]"),
    re.compile(rf"(?:^|[\s;&|]){VARS}\s*="),  # assignment / export X=
    re.compile(rf"\bexport\s+{VARS}\b"),
]

# Files that document the rule (and therefore spell out forbidden patterns) or test the guard itself.
EXCLUDED_GLOBS = [
    "docs/ARCHITECTURE.md",
    "CLAUDE.md",
    "*/tests/*",
    "tests/*",
    "*/test/*",
    "*.test.ts",
    "*.test.tsx",
    "*.spec.ts",
    "scripts/check_no_api_key.py",
]


def is_excluded(rel: str) -> bool:
    return any(fnmatch.fnmatch(rel, g) for g in EXCLUDED_GLOBS)


def line_violates(line: str) -> bool:
    for pattern in STRIP_PATTERNS:
        line = pattern.sub(" ", line)
    return any(p.search(line) for p in READ_PATTERNS)


def scan_file(path: Path) -> list[tuple[int, str]]:
    try:
        data = path.read_bytes()
    except OSError:
        return []
    if b"\0" in data[:4096] or b"ANTHROPIC_" not in data:
        return []
    text = data.decode("utf-8", errors="replace")
    return [(n, line.strip()) for n, line in enumerate(text.splitlines(), 1) if line_violates(line)]


def repo_files(root: Path) -> list[str]:
    out = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        check=True,
        capture_output=True,
    ).stdout
    return sorted({p for p in out.decode().split("\0") if p})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fail if code reads or sets an Anthropic API key.")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("files", nargs="*")
    args = parser.parse_args(argv)
    root = args.root.resolve()
    rels = args.files or repo_files(root)
    violations = 0
    for rel in rels:
        path = Path(rel) if Path(rel).is_absolute() else root / rel
        try:
            shown = str(path.resolve().relative_to(root))
        except ValueError:
            shown = str(path)
        if is_excluded(shown) or not path.is_file():
            continue
        for lineno, text in scan_file(path):
            print(f"{shown}:{lineno}: reads/sets an Anthropic API key: {text}")
            violations += 1
    if violations:
        print(
            f"check_no_api_key: {violations} violation(s). ClaudeOS uses subscription OAuth only; "
            "strip these variables (unset / env -u / delete env.X) instead of reading them.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
