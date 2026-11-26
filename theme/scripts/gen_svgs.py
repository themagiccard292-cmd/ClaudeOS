#!/usr/bin/env python3
"""Generate the ClaudeOS wallpaper and icon SVGs from the C8 theme tokens.

The SVGs are committed (they are the shipped sources); this script is how they are
produced, so a palette change in ``usr/share/claudeos/theme/tokens.json`` propagates to
every asset.  Output is deterministic: ``tests/test_assets.py`` regenerates in memory and
compares against the committed files.

Only features that Chromium, librsvg and GNOME's SVG loaders render identically are used:
``linearGradient``, ``radialGradient``, ``polygon``/``path``/``rect``/``circle``/``line`` and a
single ``feGaussianBlur`` filter with an explicit region.  No text, no external references.

Usage:  gen_svgs.py [--check]      (--check exits 1 when a committed file is stale)
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOKENS = ROOT / "usr/share/claudeos/theme/tokens.json"

WALLPAPER_W, WALLPAPER_H = 3840, 2160

# Starburst centre, partly off-canvas at the top right so the burst reads as light entering
# the screen and the left two thirds stay calm behind windows.
BURST_CX, BURST_CY = 3290.0, 430.0

# (angle in degrees, clockwise from +x; ray length in px).  Hand-tuned, deliberately uneven
# like a hand-drawn asterisk.  Angles that point up/right leave the canvas; the rest fan out
# towards the lower left.
BOLD_RAYS: tuple[tuple[float, float], ...] = (
    (96, 1500),
    (121, 2050),
    (146, 1650),
    (169, 2450),
    (194, 1800),
    (219, 2150),
    (243, 1450),
    (-3, 1700),
    (22, 1550),
    (47, 1900),
    (71, 1450),
    (-28, 1500),
    (268, 1300),
    (-55, 1400),
)

# Very fine rays between the bold ones: (angle, inner radius, outer radius).
HAIRLINES: tuple[tuple[float, float, float], ...] = (
    (108, 520, 3300),
    (133, 640, 3900),
    (157, 560, 3500),
    (182, 700, 4200),
    (206, 600, 3200),
    (231, 760, 2800),
    (59, 540, 2600),
)

# Per-scheme wallpaper tuning.  Opacities are deliberately low: the picture sits behind
# windows all day and must stay calm.
WALLPAPER_STYLE = {
    "light": {
        "field_a": "#F8F7F3",
        "field_b": "#F2F0E9",
        "vignette": "#E8E3D6",
        "vignette_alpha": 0.55,
        "glow_alpha": 0.34,
        "core": "#FFE6D8",
        "core_alpha": 0.45,
        "ray_alpha": 0.19,
        "hair_alpha": 0.30,
        "hair_color": "#C6613F",
    },
    "dark": {
        "field_a": "#2A2927",
        "field_b": "#232321",
        "vignette": "#171716",
        "vignette_alpha": 0.60,
        "glow_alpha": 0.27,
        "core": "#F09A78",
        "core_alpha": 0.30,
        "ray_alpha": 0.16,
        "hair_alpha": 0.26,
        "hair_color": "#E58A68",
    },
}


def load_tokens() -> dict:
    return json.loads(TOKENS.read_text(encoding="utf-8"))


def f(value: float) -> str:
    """Compact, stable number formatting."""
    text = f"{value:.1f}"
    return text[:-2] if text.endswith(".0") else text


def polar(cx: float, cy: float, radius: float, degrees: float) -> tuple[float, float]:
    angle = math.radians(degrees)
    return cx + radius * math.cos(angle), cy + radius * math.sin(angle)


def ray_polygon(cx: float, cy: float, degrees: float, length: float) -> str:
    """A slim petal: narrow at the hub, widest a third of the way out, pointed tip."""
    half = length * 0.034
    points = [
        polar(cx, cy, 0, degrees),
        _offset(cx, cy, degrees, length * 0.30, half),
        polar(cx, cy, length, degrees),
        _offset(cx, cy, degrees, length * 0.30, -half),
    ]
    return " ".join(f"{f(x)},{f(y)}" for x, y in points)


def _offset(cx: float, cy: float, degrees: float, along: float, across: float) -> tuple[float, float]:
    x, y = polar(cx, cy, along, degrees)
    nx, ny = polar(0, 0, across, degrees + 90)
    return x + nx, y + ny


def gradient_stops(color: str, alphas: tuple[tuple[float, float], ...]) -> str:
    return "\n".join(
        f'      <stop offset="{f(o)}" stop-color="{color}" stop-opacity="{a:.3f}"/>' for o, a in alphas
    )


def wallpaper(scheme: str, tokens: dict) -> str:
    style = WALLPAPER_STYLE[scheme]
    accent = tokens["accent"]
    palette = tokens[scheme]
    cx, cy = BURST_CX, BURST_CY
    ga = style["glow_alpha"]
    # Eased falloff so the glow has no visible edge.
    glow_stops = gradient_stops(
        accent,
        (
            (0.00, ga),
            (0.10, ga * 0.86),
            (0.22, ga * 0.62),
            (0.38, ga * 0.38),
            (0.56, ga * 0.19),
            (0.78, ga * 0.06),
            (1.00, 0.0),
        ),
    )
    ra = style["ray_alpha"]
    ray_stops = gradient_stops(
        accent,
        ((0.00, ra), (0.30, ra * 0.78), (0.62, ra * 0.40), (1.00, 0.0)),
    )
    ha = style["hair_alpha"]
    hair_stops = gradient_stops(
        style["hair_color"],
        ((0.00, ha), (0.35, ha * 0.8), (0.75, ha * 0.35), (1.00, 0.0)),
    )
    core_stops = gradient_stops(
        style["core"],
        ((0.00, style["core_alpha"]), (0.45, style["core_alpha"] * 0.35), (1.00, 0.0)),
    )
    rays = "\n".join(
        f'    <polygon points="{ray_polygon(cx, cy, a, length)}"/>' for a, length in BOLD_RAYS
    )
    hairs = "\n".join(
        '    <line x1="{}" y1="{}" x2="{}" y2="{}"/>'.format(
            *(f(v) for v in (*polar(cx, cy, r0, a), *polar(cx, cy, r1, a)))
        )
        for a, r0, r1 in HAIRLINES
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!-- ClaudeOS {scheme} wallpaper. Generated by theme/scripts/gen_svgs.py from tokens.json; do not edit by hand. -->
<svg xmlns="http://www.w3.org/2000/svg" width="{WALLPAPER_W}" height="{WALLPAPER_H}" viewBox="0 0 {WALLPAPER_W} {WALLPAPER_H}">
  <title>ClaudeOS wallpaper ({scheme})</title>
  <defs>
    <!-- Base field: the C8 background tone with a barely-there diagonal drift. -->
    <linearGradient id="field" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{style["field_a"]}"/>
      <stop offset="0.55" stop-color="{palette["background"]}"/>
      <stop offset="1" stop-color="{style["field_b"]}"/>
    </linearGradient>
    <!-- Soft depth in the opposite corner. -->
    <radialGradient id="vignette" gradientUnits="userSpaceOnUse" cx="0" cy="{WALLPAPER_H}" r="2300">
      <stop offset="0" stop-color="{style["vignette"]}" stop-opacity="{style["vignette_alpha"]:.3f}"/>
      <stop offset="1" stop-color="{style["vignette"]}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="{f(cx)}" cy="{f(cy)}" r="2300">
{glow_stops}
    </radialGradient>
    <radialGradient id="core" gradientUnits="userSpaceOnUse" cx="{f(cx)}" cy="{f(cy)}" r="620">
{core_stops}
    </radialGradient>
    <radialGradient id="rayFade" gradientUnits="userSpaceOnUse" cx="{f(cx)}" cy="{f(cy)}" r="2500">
{ray_stops}
    </radialGradient>
    <radialGradient id="hairFade" gradientUnits="userSpaceOnUse" cx="{f(cx)}" cy="{f(cy)}" r="4200">
{hair_stops}
    </radialGradient>
    <filter id="soft" filterUnits="userSpaceOnUse" x="-300" y="-300" width="{WALLPAPER_W + 600}" height="{WALLPAPER_H + 600}">
      <feGaussianBlur stdDeviation="34"/>
    </filter>
  </defs>
  <rect width="{WALLPAPER_W}" height="{WALLPAPER_H}" fill="url(#field)"/>
  <rect width="{WALLPAPER_W}" height="{WALLPAPER_H}" fill="url(#vignette)"/>
  <circle cx="{f(cx)}" cy="{f(cy)}" r="2300" fill="url(#glow)"/>
  <!-- Large, softly blurred starburst. -->
  <g fill="url(#rayFade)" filter="url(#soft)">
{rays}
  </g>
  <circle cx="{f(cx)}" cy="{f(cy)}" r="620" fill="url(#core)"/>
  <!-- A few hairline rays. -->
  <g stroke="url(#hairFade)" stroke-width="2.4" stroke-linecap="round" fill="none">
{hairs}
  </g>
</svg>
"""


# ---------------------------------------------------------------------------------------
# Icons
# ---------------------------------------------------------------------------------------

# 12 rays, 30 degrees apart, deliberately uneven lengths (in a 128 unit grid) so the mark
# reads as a hand-drawn starburst rather than a gear.
ICON_RAYS: tuple[float, ...] = (37, 30, 36, 29, 38, 31, 36, 30, 38, 29, 35, 31)


def starburst_rects(cx: float, cy: float, scale: float, width: float, fill: str) -> str:
    """Rounded rays as rotated rects (centre-anchored); renders crisply at every size."""
    lines = []
    for i, length in enumerate(ICON_RAYS):
        angle = i * 30.0 - 90.0
        ln = length * scale
        w = width * scale
        # Rect covers the hub (-w/2 .. ln) along the +y axis then is rotated about the centre.
        lines.append(
            f'    <rect x="{f(cx - w / 2)}" y="{f(cy - w / 2)}" width="{f(w)}" height="{f(ln + w / 2)}" '
            f'rx="{f(w / 2)}" fill="{fill}" transform="rotate({f(angle - 90 + 180)} {f(cx)} {f(cy)})"/>'
        )
    return "\n".join(lines)


def panel_icon(tokens: dict) -> str:
    accent = tokens["accent"]
    light = tokens["light"]
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!-- ClaudeOS panel icon. Generated by theme/scripts/gen_svgs.py from tokens.json; do not edit by hand. -->
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <title>ClaudeOS panel</title>
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FBFAF7"/>
      <stop offset="1" stop-color="{light["background"]}"/>
    </linearGradient>
    <radialGradient id="burst" gradientUnits="userSpaceOnUse" cx="64" cy="64" r="42">
      <stop offset="0" stop-color="#E58463"/>
      <stop offset="1" stop-color="{accent}"/>
    </radialGradient>
    <filter id="shadow" filterUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">
      <feGaussianBlur stdDeviation="2.2"/>
    </filter>
  </defs>
  <rect x="9" y="12" width="110" height="110" rx="26" fill="#1F1E1D" fill-opacity="0.22" filter="url(#shadow)"/>
  <rect x="8" y="8" width="112" height="112" rx="26" fill="url(#tile)"/>
  <rect x="8.5" y="8.5" width="111" height="111" rx="25.5" fill="none" stroke="{light["border"]}"/>
  <g fill="url(#burst)">
{starburst_rects(64, 64, 1.0, 9.0, "url(#burst)")}
  </g>
</svg>
"""


def installer_icon(tokens: dict) -> str:
    accent = tokens["accent"]
    light = tokens["light"]
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!-- ClaudeOS installer icon. Generated by theme/scripts/gen_svgs.py from tokens.json; do not edit by hand. -->
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <title>Install ClaudeOS</title>
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#E2825F"/>
      <stop offset="1" stop-color="#CF6A47"/>
    </linearGradient>
    <filter id="shadow" filterUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">
      <feGaussianBlur stdDeviation="2.2"/>
    </filter>
  </defs>
  <rect x="9" y="12" width="110" height="110" rx="26" fill="#1F1E1D" fill-opacity="0.22" filter="url(#shadow)"/>
  <rect x="8" y="8" width="112" height="112" rx="26" fill="url(#tile)"/>
  <rect x="8.5" y="8.5" width="111" height="111" rx="25.5" fill="none" stroke="#FFFFFF" stroke-opacity="0.28"/>
  <!-- Starburst, up and to the left. -->
{starburst_rects(52, 50, 0.62, 9.0, light["background"])}
  <!-- Disc with a down arrow in the lower right. -->
  <circle cx="88" cy="88" r="25" fill="{light["background"]}"/>
  <circle cx="88" cy="88" r="25" fill="none" stroke="#1F1E1D" stroke-opacity="0.14"/>
  <path d="M88 74v22m-10-9 10 10 10-10" fill="none" stroke="{accent}" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
"""


def symbolic_icon() -> str:
    """16x16 symbolic starburst: one fill, ``path`` elements only (GTK recolours these)."""
    cx = cy = 8.0
    lengths = (6.6, 5.4, 6.4, 5.2, 6.6, 5.4, 6.4, 5.2, 6.6, 5.4, 6.4, 5.4)
    width = 1.7
    paths = []
    for i, length in enumerate(lengths):
        angle = math.radians(i * 30.0)
        ux, uy = math.sin(angle), -math.cos(angle)  # unit vector along the ray
        nx, ny = -uy, ux  # normal
        half = width / 2
        tip = (cx + ux * (length - half), cy + uy * (length - half))
        a = (cx + nx * half, cy + ny * half)
        b = (tip[0] + nx * half, tip[1] + ny * half)
        c = (tip[0] - nx * half, tip[1] - ny * half)
        d = (cx - nx * half, cy - ny * half)
        paths.append(
            f"M{f(a[0])} {f(a[1])}L{f(b[0])} {f(b[1])}"
            f"A{f(half)} {f(half)} 0 0 0 {f(c[0])} {f(c[1])}"
            f"L{f(d[0])} {f(d[1])}Z"
        )
    body = "".join(paths)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!-- ClaudeOS panel symbolic icon. Generated by theme/scripts/gen_svgs.py; GTK recolours the single fill. -->
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <path fill="#2e3436" d="{body}"/>
</svg>
"""


def outputs() -> dict[Path, str]:
    tokens = load_tokens()
    bg = ROOT / "usr/share/backgrounds/claudeos"
    apps = ROOT / "usr/share/icons/hicolor/scalable/apps"
    return {
        bg / "claudeos-light.svg": wallpaper("light", tokens),
        bg / "claudeos-dark.svg": wallpaper("dark", tokens),
        apps / "claudeos-panel.svg": panel_icon(tokens),
        apps / "claudeos-installer.svg": installer_icon(tokens),
        ROOT / "usr/share/icons/hicolor/symbolic/apps/claudeos-panel-symbolic.svg": symbolic_icon(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if committed files differ")
    args = parser.parse_args()
    stale = 0
    for path, text in outputs().items():
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                print(f"stale: {path.relative_to(ROOT)}", file=sys.stderr)
                stale += 1
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            print(f"wrote {path.relative_to(ROOT)}")
    return 1 if stale else 0


if __name__ == "__main__":
    sys.exit(main())
