#!/usr/bin/env python3
"""xmllint-style checks without xmllint: every SVG/XML under the module parses, every JSON loads."""

from __future__ import annotations

import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP = {".venv", ".pytest_cache", ".ruff_cache", "__pycache__"}


def main() -> int:
    bad = 0
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file() or SKIP & set(path.relative_to(ROOT).parts):
            continue
        try:
            if path.suffix in {".svg", ".xml"}:
                ET.parse(path)
            elif path.suffix == ".json":
                json.loads(path.read_text(encoding="utf-8"))
        except (ET.ParseError, ValueError) as exc:
            print(f"{path.relative_to(ROOT)}: {exc}", file=sys.stderr)
            bad += 1
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
