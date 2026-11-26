"""Packaging contract (ARCHITECTURE C6): Makefile install, package.meta, maintainer script."""

from __future__ import annotations

import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest
from conftest import ROOT

needs_make = pytest.mark.skipif(shutil.which("make") is None, reason="make not installed")


def read_meta() -> dict[str, str]:
    meta: dict[str, str] = {}
    for line in (ROOT / "package.meta").read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r'([A-Z_]+)="([^"]*)"', line)
        assert match, f'package.meta line is not KEY="value": {line!r}'
        meta[match.group(1)] = match.group(2)
    return meta


def mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


@needs_make
def test_make_install_stages_the_payload(tmp_path: Path) -> None:
    subprocess.run(["make", "-C", str(ROOT), "install", f"DESTDIR={tmp_path}"], check=True)
    extension = tmp_path / "usr/share/nautilus-python/extensions/claudeos_ask_claude.py"
    desktop = tmp_path / "usr/share/applications/claudeos-ask-claude.desktop"
    assert extension.read_bytes() == (ROOT / "claudeos_ask_claude.py").read_bytes()
    assert desktop.read_bytes() == (ROOT / "claudeos-ask-claude.desktop").read_bytes()
    assert mode(extension) == 0o644
    assert mode(desktop) == 0o644
    staged = sorted(p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*") if p.is_file())
    assert staged == [
        "usr/share/applications/claudeos-ask-claude.desktop",
        "usr/share/nautilus-python/extensions/claudeos_ask_claude.py",
    ]


@needs_make
def test_make_install_honours_prefix(tmp_path: Path) -> None:
    subprocess.run(
        ["make", "-C", str(ROOT), "install", f"DESTDIR={tmp_path}", "PREFIX=/usr/local"], check=True
    )
    assert (
        tmp_path / "usr/local/share/nautilus-python/extensions/claudeos_ask_claude.py"
    ).is_file()
    assert (tmp_path / "usr/local/share/applications/claudeos-ask-claude.desktop").is_file()


def test_package_meta_follows_the_contract() -> None:
    meta = read_meta()
    assert meta["PKG_NAME"] == "claudeos-nautilus"
    assert meta["PKG_ARCH"] == "all"
    depends = {d.strip() for d in meta["PKG_DEPENDS"].split(",")}
    assert depends == {"python3-nautilus", "claudeos-side-panel"}  # ARCHITECTURE C6
    assert meta["PKG_DESCRIPTION"] and meta["PKG_SECTION"] and "PKG_RECOMMENDS" in meta


def test_postinst_is_executable_and_always_succeeds() -> None:
    postinst = ROOT / "debian" / "postinst"
    assert mode(postinst) & 0o111
    for args in (["configure"], ["configure", "26.04.1"], ["abort-upgrade"], []):
        result = subprocess.run(
            [str(postinst), *args], capture_output=True, text=True, check=False, timeout=30
        )
        assert result.returncode == 0, result.stderr
    configured = subprocess.run([str(postinst), "configure"], capture_output=True, text=True)
    assert "nautilus -q" in configured.stdout
