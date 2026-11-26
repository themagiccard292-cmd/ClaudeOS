#!/usr/bin/env python3
"""Re-save PNGs with maximum compression (Pillow).

Usage: optimize_png.py [--colors N] FILE...

Without ``--colors`` the pixels are untouched (lossless).  With ``--colors N`` the image is
flattened to RGB and reduced to an adaptive N-colour palette; the wallpapers are smooth
gradients, so ~120 colours keeps them visually clean while fitting the < 1.2 MB budget
that a 3840x2160 truecolour render (3+ MB) cannot meet.
"""

from __future__ import annotations

import argparse
import sys

from PIL import Image


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--colors", type=int, default=0, help="quantise to an N-colour palette")
    parser.add_argument("files", nargs="+")
    args = parser.parse_args()
    for path in args.files:
        with Image.open(path) as im:
            im.load()
            if args.colors:
                im = im.convert("RGB").quantize(
                    args.colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE
                )
            im.save(path, format="PNG", optimize=True, compress_level=9)
        print(f"optimised {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
