#!/usr/bin/env python3
"""Strict validator for freedesktop desktop entries (Desktop Entry Specification 1.5).

Runs ``desktop-file-validate`` when it is installed and always applies the built-in checks, so
``make lint`` gives the same verdict on a machine without desktop-file-utils.

Usage: ``validate_desktop.py FILE.desktop...``; exit status 1 when any file has a problem.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

KNOWN_VERSIONS = {"1.0", "1.1", "1.2", "1.3", "1.4", "1.5"}
MAIN_CATEGORIES = {
    "AudioVideo",
    "Audio",
    "Video",
    "Development",
    "Education",
    "Game",
    "Graphics",
    "Network",
    "Office",
    "Science",
    "Settings",
    "System",
    "Utility",
}
BOOLEAN_KEYS = {
    "Terminal",
    "NoDisplay",
    "Hidden",
    "StartupNotify",
    "DBusActivatable",
    "PrefersNonDefaultGPU",
    "SingleMainWindow",
}
LIST_KEYS = {
    "MimeType",
    "Categories",
    "Keywords",
    "OnlyShowIn",
    "NotShowIn",
    "Actions",
    "Implements",
}
STRING_KEYS = {
    "Type",
    "Version",
    "Name",
    "GenericName",
    "Comment",
    "Icon",
    "TryExec",
    "Exec",
    "Path",
    "StartupWMClass",
    "URL",
}
KNOWN_KEYS = BOOLEAN_KEYS | LIST_KEYS | STRING_KEYS
LOCALISED_KEYS = {"Name", "GenericName", "Comment", "Icon", "Keywords"}
TYPES = {"Application", "Link", "Directory"}

KEY_RE = re.compile(r"^(?P<key>[A-Za-z0-9-]+)(?:\[(?P<locale>[^\]]+)\])?$")
MIME_RE = re.compile(r"^[a-z0-9][a-z0-9!#$&^_.+-]*/(\*|[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*)$")
EXEC_FIELD_CODES = set("fFuUick")
# Characters that must sit inside a double-quoted Exec argument (spec, "The Exec key").
EXEC_RESERVED = set("\n\"'\\><~|&;$*?#()`")


def tokenize_exec(value: str) -> tuple[list[tuple[str, bool]], list[str]]:
    """Split an ``Exec`` value into ``(text, was_quoted)`` arguments plus quoting problems."""
    tokens: list[tuple[str, bool]] = []
    problems: list[str] = []
    buf: list[str] = []
    in_quotes = pending = quoted = False
    i = 0
    while i < len(value):
        ch = value[i]
        if in_quotes:
            if ch == "\\" and value[i + 1 : i + 2] in ('"', "`", "$", "\\"):
                buf.append(value[i + 1])
                i += 1
            elif ch == '"':
                in_quotes = False
            else:
                buf.append(ch)
        elif ch == '"':
            in_quotes = pending = quoted = True
        elif ch in " \t":
            if pending:
                tokens.append(("".join(buf), quoted))
                buf, pending, quoted = [], False, False
        else:
            if ch in EXEC_RESERVED:
                problems.append(f"unquoted reserved character {ch!r} in Exec")
            buf.append(ch)
            pending = True
        i += 1
    if in_quotes:
        problems.append("unterminated quote in Exec")
    if pending:
        tokens.append(("".join(buf), quoted))
    return tokens, problems


def check_exec(value: str) -> list[str]:
    """Problems with an ``Exec`` command line: quoting, field codes, their placement."""
    tokens, problems = tokenize_exec(value)
    if not tokens:
        return [*problems, "Exec is empty"]
    list_or_single = 0
    for text, quoted in tokens:
        literal = text.replace("%%", "")  # %% is an escaped percent sign
        if quoted:
            if "%" in literal:
                problems.append(f"field code inside a quoted Exec argument: {text!r}")
            continue
        for code in re.findall(r"%(.?)", literal):
            if code not in EXEC_FIELD_CODES:
                problems.append(f"illegal or deprecated field code %{code} in Exec")
            elif literal != f"%{code}":
                problems.append(f"field code %{code} must be an argument of its own: {text!r}")
            elif code in "fFuU":
                list_or_single += 1
    if list_or_single > 1:
        problems.append("Exec may contain at most one of %f %F %u %U")
    return problems


def check_list(key: str, value: str) -> list[str]:
    """Problems with a ``;``-separated list value."""
    if not value.endswith(";"):
        return [f"{key} must be a ';'-terminated list"]
    parts = re.split(r"(?<!\\);", value[:-1])
    if any(not part for part in parts):
        return [f"{key} has an empty element"]
    problems: list[str] = []
    if key == "MimeType":
        problems += [f"MimeType has an invalid type {p!r}" for p in parts if not MIME_RE.match(p)]
    elif key == "Categories" and not MAIN_CATEGORIES.intersection(parts):
        problems.append("Categories needs at least one registered main category")
    return problems


def parse_groups(text: str) -> tuple[dict[str, dict[str, str]], list[str]]:
    """Parse ``text`` into ``{group: {key: value}}``; also report syntax problems."""
    problems: list[str] = []
    groups: dict[str, dict[str, str]] = {}
    group: dict[str, str] | None = None
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.rstrip("\r")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.startswith("["):
            name = line[1:-1] if line.endswith("]") else ""
            if not name:
                problems.append(f"line {lineno}: malformed group header")
                group = None
            elif name in groups:
                problems.append(f"line {lineno}: duplicate group [{name}]")
                group = None
            else:
                if not groups and name != "Desktop Entry":
                    problems.append("the first group must be [Desktop Entry]")
                group = groups.setdefault(name, {})
            continue
        key, sep, value = line.partition("=")
        key = key.strip()
        if group is None:
            problems.append(f"line {lineno}: key outside of any group")
        elif not sep or not KEY_RE.match(key):
            problems.append(f"line {lineno}: not a valid Key=Value line")
        elif key in group:
            problems.append(f"line {lineno}: duplicate key {key}")
        else:
            group[key] = value.strip()
    return groups, problems


def validate_text(text: str) -> list[str]:
    """Return every problem found in the desktop entry ``text`` (empty list = valid)."""
    groups, problems = parse_groups(text)
    if not text.endswith("\n"):
        problems.append("file must end with a newline")
    entry = groups.get("Desktop Entry")
    if entry is None:
        return [*problems, "missing [Desktop Entry] group"]

    for required in ("Type", "Name"):
        if not entry.get(required):
            problems.append(f"missing required key {required}")
    if entry.get("Type") not in TYPES:
        problems.append(f"Type must be one of {sorted(TYPES)}")
    if entry.get("Type") == "Application" and not (
        entry.get("Exec") or entry.get("DBusActivatable") == "true"
    ):
        problems.append("Type=Application needs Exec (or DBusActivatable=true)")
    if "Version" in entry and entry["Version"] not in KNOWN_VERSIONS:
        problems.append(f"unknown Version {entry['Version']!r}")

    for full_key, value in entry.items():
        match = KEY_RE.match(full_key)
        key = match.group("key") if match else full_key
        if match and match.group("locale") and key not in LOCALISED_KEYS:
            problems.append(f"{key} cannot be localised")
        if key not in KNOWN_KEYS and not key.startswith("X-"):
            problems.append(f"unknown key {key} (custom keys must start with X-)")
        if key in BOOLEAN_KEYS and value not in {"true", "false"}:
            problems.append(f"{key} must be true or false, got {value!r}")
        if key in LIST_KEYS and value:
            problems += check_list(key, value)
    if entry.get("Exec"):
        problems += check_exec(entry["Exec"])
    icon = entry.get("Icon", "")
    if icon and not icon.startswith("/") and re.search(r"\.(png|svg|xpm)$", icon):
        problems.append("a themed Icon name must not carry a file extension")
    return problems


def validate_file(path: Path) -> list[str]:
    """``validate_text`` plus ``desktop-file-validate`` when that tool is installed."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return [f"cannot read as UTF-8: {exc}"]
    problems = validate_text(text)
    tool = shutil.which("desktop-file-validate")
    if tool:
        result = subprocess.run([tool, str(path)], capture_output=True, text=True, check=False)
        if result.returncode != 0:
            output = (result.stdout + result.stderr).splitlines()
            problems += [f"desktop-file-validate: {line}" for line in output if line.strip()]
    return problems


def main(argv: list[str]) -> int:
    """CLI entry point; returns the process exit status."""
    if not argv:
        print("usage: validate_desktop.py FILE.desktop...", file=sys.stderr)
        return 2
    status = 0
    for name in argv:
        problems = validate_file(Path(name))
        for problem in problems:
            print(f"{name}: {problem}", file=sys.stderr)
        if problems:
            status = 1
        else:
            print(f"{name}: ok")
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
