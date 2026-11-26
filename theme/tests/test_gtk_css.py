"""GTK stylesheets: balanced, valid @define-color, palette-correct."""

from __future__ import annotations

import re

import pytest

FILES = ["etc/skel/.config/gtk-3.0/gtk.css", "etc/skel/.config/gtk-4.0/gtk.css"]
REQUIRED = {
    "accent_bg_color",
    "accent_color",
    "accent_fg_color",
    "window_bg_color",
    "window_fg_color",
    "view_bg_color",
    "headerbar_bg_color",
    "card_bg_color",
    "popover_bg_color",
    "sidebar_bg_color",
}


def strip_comments(text: str) -> str:
    return re.sub(r"/\*.*?\*/", "", text, flags=re.S)


@pytest.mark.parametrize("rel", FILES)
def test_balanced_and_defines_valid(root, rel):
    css = strip_comments((root / rel).read_text(encoding="utf-8"))
    depth = 0
    for ch in css:
        depth += ch == "{"
        depth -= ch == "}"
        assert depth >= 0
    assert depth == 0
    for line in css.splitlines():
        line = line.strip()
        if line.startswith("@define-color"):
            assert re.fullmatch(r"@define-color [a-z_0-9]+ #[0-9A-Fa-f]{6};", line), line


def test_gtk4_defines_both_schemes(root, tokens):
    css = (root / FILES[1]).read_text(encoding="utf-8")
    light, _, dark = css.partition("@media (prefers-color-scheme: dark)")
    for name in REQUIRED:
        assert re.search(rf"@define-color {name} #", light)
        assert re.search(rf"@define-color {name} #", dark)
    assert f"@define-color window_bg_color {tokens['light']['background']};" in light
    assert f"@define-color window_bg_color {tokens['dark']['background']};" in dark
    assert f"@define-color accent_bg_color {tokens['accent']};" in light


def test_gtk3_only_scheme_neutral_colours(root, tokens):
    css = (root / FILES[0]).read_text(encoding="utf-8")
    assert "@media" not in css
    assert f"@define-color theme_selected_bg_color {tokens['accent']};" in css


def test_system_copy_matches_skel(root):
    # The Makefile installs the skel files as the system copies; both must stay one source.
    for rel in FILES:
        assert (root / rel).read_text(encoding="utf-8").startswith("/* claudeos-theme:managed sha256=")
