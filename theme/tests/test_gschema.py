"""The gschema override: keys exist in the (fixture) real schemas, values compile."""

from __future__ import annotations

import configparser
import shutil
import subprocess

import pytest

ALLOWED = {
    "org.gnome.desktop.interface": {"accent-color", "color-scheme", "monospace-font-name"},
    "org.gnome.desktop.background": {
        "picture-uri",
        "picture-uri-dark",
        "picture-options",
        "primary-color",
        "secondary-color",
    },
    "org.gnome.desktop.screensaver": {"picture-uri", "picture-options", "primary-color", "secondary-color"},
    "org.gnome.shell": {"favorite-apps"},
}
OVERRIDE = "usr/share/glib-2.0/schemas/90_claudeos.gschema.override"


def groups(root):
    cp = configparser.ConfigParser(interpolation=None, delimiters=("=",))
    cp.optionxform = str
    cp.read(root / OVERRIDE, encoding="utf-8")
    return cp


def test_keys_in_allow_list(root):
    cp = groups(root)
    assert cp.sections()
    for section in cp.sections():
        schema = section.split(":")[0]
        assert schema in ALLOWED, section
        assert set(cp[section]) <= ALLOWED[schema], section


def test_no_custom_keybindings(root):
    assert "custom-keybinding" not in (root / OVERRIDE).read_text(encoding="utf-8")


def test_values(root):
    cp = groups(root)
    s = cp["org.gnome.desktop.interface"]
    assert s["accent-color"] == "'orange'" and s["color-scheme"] == "'default'"
    b = cp["org.gnome.desktop.background"]
    assert b["picture-uri"].endswith("claudeos-light.png'") and b["picture-uri-dark"].endswith("claudeos-dark.png'")
    assert b["picture-options"] == "'zoom'"
    fav = cp["org.gnome.shell"]["favorite-apps"]
    assert fav.startswith("['claudeos-panel.desktop', 'org.gnome.Nautilus.desktop'")
    assert "org.gnome.Settings.desktop" in fav


def test_monospace_font_requires_declared_dependency(root):
    meta = (root / "package.meta").read_text(encoding="utf-8")
    assert "fonts-jetbrains-mono" in meta
    assert "JetBrains Mono 11" in (root / OVERRIDE).read_text(encoding="utf-8")


@pytest.mark.skipif(not shutil.which("glib-compile-schemas"), reason="glib-compile-schemas not installed")
def test_compiles_and_wins_over_ubuntu(root, tmp_path):
    fixtures = root / "tests/fixtures/schemas"
    for f in fixtures.iterdir():
        shutil.copy(f, tmp_path / f.name)
    shutil.copy(root / OVERRIDE, tmp_path / "90_claudeos.gschema.override")
    result = subprocess.run(
        ["glib-compile-schemas", "--strict", str(tmp_path)], capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr
