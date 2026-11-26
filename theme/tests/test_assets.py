"""Wallpapers, icons and their generators."""

from __future__ import annotations

import re
import struct
import subprocess
import sys
import xml.etree.ElementTree as ET

import pytest

BG = "usr/share/backgrounds/claudeos"
ICONS = "usr/share/icons/hicolor"
SVGS = [
    f"{BG}/claudeos-light.svg",
    f"{BG}/claudeos-dark.svg",
    f"{ICONS}/scalable/apps/claudeos-panel.svg",
    f"{ICONS}/scalable/apps/claudeos-installer.svg",
    f"{ICONS}/symbolic/apps/claudeos-panel-symbolic.svg",
]


def png_size(path) -> tuple[int, int]:
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    return struct.unpack(">II", data[16:24])


@pytest.mark.parametrize("rel", SVGS)
def test_svg_wellformed_and_self_contained(root, rel):
    path = root / rel
    tree = ET.parse(path)
    svg = tree.getroot()
    assert svg.tag == "{http://www.w3.org/2000/svg}svg"
    assert svg.get("viewBox")
    text = path.read_text(encoding="utf-8")
    assert "<script" not in text and "<image" not in text and "<text" not in text
    assert not re.search(r"(?:href|src)\s*=\s*[\"'](?!#)", text)
    assert not re.search(r"url\(\s*[\"']?(?!#)", text)
    assert "javascript:" not in text and "<foreignObject" not in text


@pytest.mark.parametrize("scheme", ["light", "dark"])
def test_wallpaper_png(root, scheme):
    path = root / BG / f"claudeos-{scheme}.png"
    assert png_size(path) == (3840, 2160)
    assert path.stat().st_size < 1_200_000


@pytest.mark.parametrize("name", ["panel", "installer"])
@pytest.mark.parametrize("size", [48, 64, 128, 256])
def test_icon_png(root, name, size):
    path = root / ICONS / f"{size}x{size}/apps/claudeos-{name}.png"
    assert png_size(path) == (size, size)
    assert path.stat().st_size < 100_000


def test_wallpaper_svg_viewbox_is_4k(root):
    for scheme in ("light", "dark"):
        svg = ET.parse(root / BG / f"claudeos-{scheme}.svg").getroot()
        assert svg.get("viewBox") == "0 0 3840 2160"


def test_background_properties_xml(root):
    xml = ET.parse(root / "usr/share/gnome-background-properties/claudeos.xml").getroot()
    assert xml.tag == "wallpapers"
    wp = xml.find("wallpaper")
    assert wp.findtext("filename") == f"/{BG}/claudeos-light.png"
    assert wp.findtext("filename-dark") == f"/{BG}/claudeos-dark.png"
    assert wp.findtext("options") == "zoom"


def test_generated_files_are_current(root):
    for script in ("gen_svgs.py", "gen_gtk_css.py"):
        result = subprocess.run(
            [sys.executable, str(root / "scripts" / script), "--check"], capture_output=True, text=True, check=False
        )
        assert result.returncode == 0, result.stderr
