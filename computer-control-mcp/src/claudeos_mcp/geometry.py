"""Pure coordinate math: screenshot space ↔ physical pixels ↔ input-device units.

Three coordinate spaces exist:

- **screenshot space** – pixels of the (downscaled, possibly cropped) image Claude last saw.
  All mouse tools take coordinates in this space.
- **physical** – real framebuffer pixels of the whole desktop (what gnome-screenshot captures).
- **logical** – physical / scale factor (GNOME's "200 %" etc.). Wayland pointer motion,
  and therefore ydotool's relative moves, is measured in logical pixels.

ydotool cannot place the pointer absolutely: the uinput device it drives only emits relative
motion. :func:`plan_ydotool_moves` therefore uses the *home-then-relative* strategy: one huge
negative move pins the pointer to the top-left corner (the compositor clamps it at 0,0 no matter
how much acceleration is applied), then a relative move of exactly the target's logical offset
follows. That is exact when the pointer acceleration profile is ``flat``; with adaptive
acceleration, ``CLAUDEOS_YDOTOOL_MAX_STEP`` splits the move into small steps (less
acceleration) and ``CLAUDEOS_YDOTOOL_UNITS_PER_PX`` calibrates the remaining gain.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

HOME_DISTANCE = 32_000  # larger than any desktop in logical px; clamps to the top-left corner


def downscaled_size(width: int, height: int, max_dimension: int) -> tuple[int, int]:
    """Size after shrinking so the long edge is at most ``max_dimension`` (never upscales)."""
    if width <= 0 or height <= 0:
        raise ValueError("image has no pixels")
    long_edge = max(width, height)
    if max_dimension <= 0 or long_edge <= max_dimension:
        return width, height
    factor = max_dimension / long_edge
    return max(1, round(width * factor)), max(1, round(height * factor))


@dataclass(frozen=True)
class Mapping:
    """How the last screenshot relates to the physical desktop."""

    image_width: int
    image_height: int
    origin_x: int  # physical x of the image's left edge (non-zero for region/monitor shots)
    origin_y: int
    physical_width: int  # physical size of the captured area
    physical_height: int
    desktop_width: int  # physical size of the whole desktop
    desktop_height: int
    scale: float  # logical scale factor
    from_screenshot: bool = True

    @property
    def factor_x(self) -> float:
        return self.physical_width / self.image_width

    @property
    def factor_y(self) -> float:
        return self.physical_height / self.image_height


def default_mapping(scale: float = 1.0) -> Mapping:
    """Before any screenshot: identity mapping, unknown desktop size."""
    return Mapping(0, 0, 0, 0, 0, 0, 0, 0, scale, from_screenshot=False)


class OutOfBounds(ValueError):
    pass


def screenshot_to_physical(x: float, y: float, m: Mapping) -> tuple[int, int]:
    """Map a point in the last screenshot to physical desktop pixels.

    Without a screenshot the coordinates are taken as physical pixels (scale 1)."""
    if not m.from_screenshot:
        if x < 0 or y < 0:
            raise OutOfBounds(f"({x}, {y}) is negative")
        return round(x), round(y)
    if not (0 <= x <= m.image_width and 0 <= y <= m.image_height):
        raise OutOfBounds(
            f"({x}, {y}) is outside the last screenshot ({m.image_width}x{m.image_height}). "
            "Use coordinates from the most recent screenshot."
        )
    px = m.origin_x + min(m.physical_width - 1, math.floor(x * m.factor_x))
    py = m.origin_y + min(m.physical_height - 1, math.floor(y * m.factor_y))
    return px, py


def physical_to_logical(px: int, py: int, scale: float) -> tuple[int, int]:
    scale = scale if scale > 0 else 1.0
    return round(px / scale), round(py / scale)


def physical_to_backend(px: int, py: int, *, backend: str, session_type: str, scale: float) -> tuple[int, int]:
    """Device coordinates for an input backend.

    - ydotool (uinput relative motion) on Wayland moves in logical pixels;
    - xdotool on a real X11 session uses physical pixels; on XWayland the X screen is logical.
    """
    if backend == "xdotool" and session_type == "x11":
        return px, py
    return physical_to_logical(px, py, scale)


def plan_ydotool_moves(
    target_x: int,
    target_y: int,
    *,
    units_per_px: float = 1.0,
    max_step: int = 0,
    home: bool = True,
) -> list[tuple[int, int]]:
    """Relative moves (dx, dy) that bring the pointer to logical ``(target_x, target_y)``.

    The first move (when ``home``) is ``(-HOME_DISTANCE, -HOME_DISTANCE)``; the rest add up to
    the target scaled by ``units_per_px``. With ``max_step > 0`` the travel is split into steps
    whose components never exceed ``max_step`` and are spread evenly (no tiny remainder step).
    """
    if target_x < 0 or target_y < 0:
        raise ValueError("target must be non-negative")
    moves: list[tuple[int, int]] = [(-HOME_DISTANCE, -HOME_DISTANCE)] if home else []
    dx = round(target_x * units_per_px)
    dy = round(target_y * units_per_px)
    if dx == 0 and dy == 0:
        return moves
    steps = 1 if max_step <= 0 else max(1, math.ceil(max(abs(dx), abs(dy)) / max_step))
    done_x = done_y = 0
    for i in range(1, steps + 1):
        nx, ny = round(dx * i / steps), round(dy * i / steps)
        moves.append((nx - done_x, ny - done_y))
        done_x, done_y = nx, ny
    return moves


def detect_scale(
    *,
    override: float | None,
    image_width: int | None,
    x_screen_width: int | None,
    gsettings_factor: int | None,
) -> tuple[float, str]:
    """Best guess of the logical scale factor and where it came from."""
    if override:
        return override, "CLAUDEOS_SCREEN_SCALE"
    if image_width and x_screen_width and x_screen_width > 0:
        ratio = image_width / x_screen_width
        if 0.9 <= ratio <= 4.1:
            # XWayland's root window is in logical pixels: physical/logical = scale.
            return round(ratio * 4) / 4 or 1.0, "screenshot width / XWayland screen width"
    if gsettings_factor and gsettings_factor > 0:
        return float(gsettings_factor), "org.gnome.desktop.interface scaling-factor"
    return 1.0, "default (could not detect; set CLAUDEOS_SCREEN_SCALE if clicks land off-target)"


@dataclass(frozen=True)
class Monitor:
    name: str
    x: int
    y: int
    width: int
    height: int
    primary: bool


_XRANDR_SCREEN = re.compile(r"^Screen \d+:.*current (\d+) x (\d+)")
_XRANDR_OUTPUT = re.compile(r"^(\S+) connected( primary)? (\d+)x(\d+)\+(\d+)\+(\d+)")


def parse_xrandr(text: str) -> tuple[tuple[int, int] | None, list[Monitor]]:
    """Parse ``xrandr --current`` output into (screen size, monitors)."""
    screen = None
    monitors: list[Monitor] = []
    for line in text.splitlines():
        if m := _XRANDR_SCREEN.match(line):
            screen = (int(m.group(1)), int(m.group(2)))
        elif m := _XRANDR_OUTPUT.match(line):
            monitors.append(
                Monitor(m.group(1), int(m.group(5)), int(m.group(6)), int(m.group(3)), int(m.group(4)), bool(m.group(2)))
            )
    return screen, monitors
