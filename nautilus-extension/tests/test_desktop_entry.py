"""The freedesktop entry: validator verdict, contract match (ARCHITECTURE C2), validator strictness."""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path

import pytest
import validate_desktop as vd
from conftest import ROOT

DESKTOP = ROOT / "claudeos-ask-claude.desktop"
ARCHITECTURE = ROOT.parent / "docs" / "ARCHITECTURE.md"

REQUIRED_MIME_TYPES = {
    "inode/directory",
    "application/octet-stream",
    "text/*",
    "image/*",
    "application/pdf",
    "application/zip",
    "application/json",
    "application/x-shellscript",
    "video/*",
    "audio/*",
}


def entry() -> dict[str, str]:
    groups, problems = vd.parse_groups(DESKTOP.read_text(encoding="utf-8"))
    assert problems == []
    assert list(groups) == ["Desktop Entry"]
    return groups["Desktop Entry"]


# --------------------------------------------------------------------------- our file


def test_desktop_file_passes_the_validator() -> None:
    assert vd.validate_file(DESKTOP) == []


def test_validator_cli_accepts_the_file(capsys: pytest.CaptureFixture[str]) -> None:
    assert vd.main([str(DESKTOP)]) == 0
    assert capsys.readouterr().out.strip().endswith("ok")


def test_required_keys_and_values() -> None:
    e = entry()
    assert e["Type"] == "Application"
    assert e["Name"] == "Ask Claude"
    assert e["Icon"] == "claudeos-panel"
    assert e["Terminal"] == "false"
    assert e["NoDisplay"] == "false"
    assert e["Categories"] == "Utility;"
    assert "X-GNOME-UsesNotifications" not in e


def test_mime_type_list_covers_the_required_types() -> None:
    value = entry()["MimeType"]
    assert value.endswith(";")
    assert set(value.rstrip(";").split(";")) >= REQUIRED_MIME_TYPES


def test_exec_is_the_c2_list_form_invocation() -> None:
    tokens, problems = vd.tokenize_exec(entry()["Exec"])
    assert problems == []
    assert [t for t, _ in tokens] == ["claudeos-panel", "attach", "--", "%F"]


@pytest.mark.skipif(not ARCHITECTURE.exists(), reason="docs/ARCHITECTURE.md not in this checkout")
def test_exec_matches_architecture_c2() -> None:
    text = ARCHITECTURE.read_text(encoding="utf-8")
    section = text.split("## C2.", 1)[1].split("\n## ", 1)[0]
    line = next(ln for ln in section.splitlines() if "MUST invoke exactly" in ln)
    contract = re.search(r"`(claudeos-panel attach -- [^`]+)`", line)
    assert contract, "C2 no longer spells out the exact invocation"
    contract_argv = contract.group(1).split()  # claudeos-panel attach -- <abs paths...>
    exec_argv = entry()["Exec"].split()  # claudeos-panel attach -- %F
    assert exec_argv[:3] == contract_argv[:3] == ["claudeos-panel", "attach", "--"]
    assert exec_argv[3:] == ["%F"]  # %F = the absolute paths of every selected file


# --------------------------------------------------------------------------- validator strictness

GOOD = """\
[Desktop Entry]
Type=Application
Name=Demo
Exec=demo --flag %F
Icon=demo
Categories=Utility;
MimeType=text/plain;image/*;
"""


def problems_for(text: str) -> list[str]:
    return vd.validate_text(text)


def test_validator_accepts_a_minimal_good_entry() -> None:
    assert problems_for(GOOD) == []


@pytest.mark.parametrize(
    ("mutation", "expected"),
    [
        (lambda t: t.replace("Name=Demo\n", ""), "missing required key Name"),
        (lambda t: t.replace("Type=Application\n", ""), "missing required key Type"),
        (lambda t: t.replace("Type=Application", "Type=Gadget"), "Type must be one of"),
        (lambda t: t.replace("Exec=demo --flag %F\n", ""), "needs Exec"),
        (lambda t: t.replace("Utility;", "Utility"), "Categories must be a ';'-terminated"),
        (lambda t: t.replace("image/*;", "image/*"), "MimeType must be a ';'-terminated"),
        (lambda t: t.replace("text/plain;", "text/plain;;"), "MimeType has an empty element"),
        (lambda t: t.replace("text/plain", "textplain"), "invalid type"),
        (lambda t: t.replace("Utility;", "Whatever;"), "main category"),
        (lambda t: t.replace("%F", "%d"), "illegal or deprecated field code %d"),
        (lambda t: t.replace("%F", "%x"), "illegal or deprecated field code %x"),
        (lambda t: t.replace("%F", "%F %U"), "at most one of"),
        (lambda t: t.replace("%F", "%F%U"), "must be an argument of its own"),
        (lambda t: t.replace("%F", "file=%F"), "must be an argument of its own"),
        (lambda t: t.replace("%F", '"%F"'), "inside a quoted"),
        (lambda t: t.replace("--flag", "--a;b"), "unquoted reserved character ';'"),
        (lambda t: t.replace("--flag", "$HOME"), "unquoted reserved character '$'"),
        (lambda t: t.replace("--flag", '"unterminated'), "unterminated quote"),
        (lambda t: t.replace("Icon=demo", "Icon=demo.png"), "must not carry a file extension"),
        (lambda t: t + "Terminal=yes\n", "Terminal must be true or false"),
        (lambda t: t + "Bogus=1\n", "unknown key Bogus"),
        (lambda t: t + "Name=Again\n", "duplicate key Name"),
        (lambda t: t + "Exec[de]=x\n", "Exec cannot be localised"),
        (lambda t: t + "Version=9.9\n", "unknown Version"),
        (lambda t: t + "just a line\n", "not a valid Key=Value"),
        (lambda t: t + "\n[Desktop Entry]\n", "duplicate group"),
        (lambda t: t.rstrip("\n"), "must end with a newline"),
        (lambda t: "# only a comment\n", "missing [Desktop Entry]"),
        (lambda t: "Name=orphan\n" + t, "key outside of any group"),
        (lambda t: "[Other]\n" + t, "first group must be [Desktop Entry]"),
    ],
)
def test_validator_rejects_broken_entries(mutation: Callable[[str], str], expected: str) -> None:
    problems = problems_for(mutation(GOOD))
    assert any(expected in p for p in problems), problems


def test_validator_accepts_quoted_exec_arguments_and_x_keys() -> None:
    text = GOOD.replace("Exec=demo --flag %F", 'Exec="/opt/my app/run" --name "a b" %F %%')
    text += "X-Custom-Key=1\nName[de]=Beispiel\n"
    assert problems_for(text) == []


def test_validator_cli_reports_and_fails(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    bad = tmp_path / "bad.desktop"
    bad.write_text(GOOD.replace("Name=Demo\n", ""), encoding="utf-8")
    assert vd.main([str(bad)]) == 1
    assert "missing required key Name" in capsys.readouterr().err
    assert vd.main([]) == 2


def test_validator_rejects_non_utf8(tmp_path: Path) -> None:
    bad = tmp_path / "latin1.desktop"
    bad.write_bytes(b"[Desktop Entry]\nName=Caf\xe9\n")
    assert vd.validate_file(bad)[0].startswith("cannot read as UTF-8")
