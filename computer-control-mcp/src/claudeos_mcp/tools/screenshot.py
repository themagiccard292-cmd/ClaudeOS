"""Screenshot capture: crop/monitor selection, downscaling and the coordinate mapping."""

from __future__ import annotations

from mcp.server.fastmcp import Image

from ..backends.screen import crop_and_scale
from ..context import AppContext
from ..geometry import Mapping, downscaled_size


def _region_box(ctx: AppContext, region: list[int], width: int, height: int) -> tuple[int, int, int, int]:
    """Physical crop box for a region given in the last full screenshot's space."""
    if len(region) != 4:
        raise ValueError("region must be [x, y, width, height].")
    x, y, w, h = region
    if w <= 0 or h <= 0 or x < 0 or y < 0:
        raise ValueError("region needs x, y >= 0 and positive width and height.")
    m = ctx.mapping
    fx = fy = 1.0
    if m.from_screenshot and m.origin_x == 0 and m.origin_y == 0 and m.physical_width == m.desktop_width:
        fx, fy = m.factor_x, m.factor_y  # last shot was the whole desktop, downscaled
    left, top = round(x * fx), round(y * fy)
    right, bottom = min(width, round((x + w) * fx)), min(height, round((y + h) * fy))
    if left >= width or top >= height or right <= left or bottom <= top:
        raise ValueError(f"region {region} is outside the screen ({width}x{height} physical px).")
    return left, top, right, bottom


def take_screenshot(ctx: AppContext, *, region: list[int] | None, max_dimension: int,
                    monitor: str | None) -> list[Image | str]:
    capture = ctx.screen.capture()
    desktop_w, desktop_h = capture.width, capture.height
    box: tuple[int, int, int, int] | None = None
    if monitor:
        _, monitors = ctx.screen.xrandr()
        scale0, _ = ctx.screen.scale(ctx.config.screen_scale_override, capture.width)
        match = next((m for m in monitors if m.name.lower() == monitor.lower()), None)
        if match is None:
            names = ", ".join(m.name for m in monitors) or "none detected"
            raise ValueError(f"Unknown monitor {monitor!r}. Available: {names}.")
        box = (round(match.x * scale0), round(match.y * scale0),
               round((match.x + match.width) * scale0), round((match.y + match.height) * scale0))
        box = (box[0], box[1], min(box[2], desktop_w), min(box[3], desktop_h))
    elif region:
        box = _region_box(ctx, region, desktop_w, desktop_h)
    max_dimension = max(64, min(int(max_dimension), 4096))
    phys_w = box[2] - box[0] if box else desktop_w
    phys_h = box[3] - box[1] if box else desktop_h
    size = downscaled_size(phys_w, phys_h, max_dimension)
    png = crop_and_scale(capture.png, box, size)
    scale, source = ctx.screen.scale(ctx.config.screen_scale_override, desktop_w)
    ctx.set_mapping(Mapping(size[0], size[1], box[0] if box else 0, box[1] if box else 0, phys_w, phys_h,
                            desktop_w, desktop_h, scale))
    info = (
        f"Screenshot {size[0]}x{size[1]} px (captured {phys_w}x{phys_h} physical px via {capture.method}; "
        f"desktop {desktop_w}x{desktop_h}; scale {scale:g} from {source}). "
        "Mouse coordinates are pixels of THIS image."
    )
    return [Image(data=png, format="png"), info]
