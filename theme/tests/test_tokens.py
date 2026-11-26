"""tokens.json must equal the C8 contract and meet WCAG contrast targets."""

from __future__ import annotations

import pytest

C8 = {
    "light": {
        "background": "#F5F4EF",
        "surface": "#FFFFFF",
        "border": "#E6E4DD",
        "text": "#1F1E1D",
        "text-muted": "#6F6D66",
    },
    "dark": {
        "background": "#262624",
        "surface": "#1E1E1C",
        "border": "#383835",
        "text": "#ECEAE3",
        "text-muted": "#A5A39B",
    },
}


def luminance(hex_colour: str) -> float:
    def lin(c: int) -> float:
        v = c / 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4

    r, g, b = (int(hex_colour[i : i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


def contrast(a: str, b: str) -> float:
    hi, lo = sorted((luminance(a), luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def test_palette_matches_c8(tokens):
    assert tokens["light"] == C8["light"]
    assert tokens["dark"] == C8["dark"]
    assert tokens["accent"] == "#D97757"


def test_fonts_and_gnome_defaults(tokens):
    assert tokens["fonts"]["serif"] == '"Newsreader", "Tiempos Text", Georgia, serif'
    assert tokens["fonts"]["sans"] == '"Inter", "Styrene B", system-ui, sans-serif'
    assert tokens["fonts"]["mono"] == '"JetBrains Mono", ui-monospace, monospace'
    assert tokens["gnome"]["accent-color"] == "orange"
    assert tokens["gnome"]["color-scheme"] == "default"


@pytest.mark.parametrize("scheme", ["light", "dark"])
@pytest.mark.parametrize("surface", ["background", "surface"])
def test_text_contrast(tokens, scheme, surface):
    p = tokens[scheme]
    assert contrast(p["text"], p[surface]) >= 4.5
    # Muted text is secondary UI text; require the 3:1 floor from the brief.
    assert contrast(p["text-muted"], p[surface]) >= 3.0


@pytest.mark.parametrize("scheme", ["light", "dark"])
def test_accent_text_and_on_accent(tokens, scheme):
    bg = tokens[scheme]["background"]
    assert contrast(tokens["derived"]["accent-text"][scheme], bg) >= 4.5
    assert contrast(tokens["derived"]["on-accent"], tokens["accent"]) >= 4.5
