"""Screen, mouse, keyboard, windows, apps and clipboard tools."""

from __future__ import annotations

import time
from typing import Annotated, Literal

from mcp.server.fastmcp import FastMCP, Image
from pydantic import Field

from ..context import AppContext
from ..geometry import (
    Mapping,
    physical_to_backend,
    screenshot_to_physical,
)
from ..keys import parse_keys
from ._common import safe_tool
from .screenshot import take_screenshot

Button = Literal["left", "right", "middle"]


def _to_backend(ctx: AppContext, x: float, y: float) -> tuple[int, int]:
    """Screenshot-space point -> device coordinates of the active input backend."""
    mapping = ctx.mapping
    px, py = screenshot_to_physical(x, y, mapping)
    scale, _ = ctx.current_scale()
    backend = ctx.input()
    return physical_to_backend(px, py, backend=backend.name, session_type=ctx.config.session_type, scale=scale)


def _describe_mapping(m: Mapping) -> str:
    if not m.from_screenshot:
        return "No screenshot taken yet: coordinates are treated as physical pixels. Take a screenshot first."
    return (
        f"Last screenshot: {m.image_width}x{m.image_height} px covering {m.physical_width}x{m.physical_height} "
        f"physical px at ({m.origin_x},{m.origin_y}) of a {m.desktop_width}x{m.desktop_height} desktop."
    )


def register(mcp: FastMCP, ctx: AppContext) -> None:
    @mcp.tool()
    @safe_tool
    def screenshot(
        region: Annotated[
            list[int] | None,
            Field(description="Optional [x, y, width, height] in the coordinate space of the LAST full screenshot "
                  "(zoom into a small area for detail). Omit for the whole screen."),
        ] = None,
        max_dimension: Annotated[int, Field(description="Longest edge in pixels after downscaling (default 1568).")] = 1568,
        monitor: Annotated[str | None, Field(description="Monitor name from screen_info (e.g. 'DP-1'); default whole desktop.")] = None,
    ) -> list[Image | str] | str:
        """Capture the screen and return it as an image plus a text line describing its scale.

        Always take a screenshot before clicking: mouse coordinates you pass to other tools are
        pixels of the MOST RECENT screenshot image. After every action, screenshot again to verify.
        Use `region` to zoom into part of the screen when text is too small to read."""
        return take_screenshot(ctx, region=region, max_dimension=max_dimension, monitor=monitor)

    @mcp.tool()
    @safe_tool
    def screen_info() -> str:
        """Report session type, desktop size, scale factor, monitors, input backend and how screenshot
        coordinates map to the real screen. Call it when clicks land in the wrong place."""
        lines = [f"Session: {ctx.config.session_type or 'unknown'}"]
        screen, monitors = ctx.screen.xrandr()
        if screen:
            lines.append(f"X screen (logical px): {screen[0]}x{screen[1]}")
        for mon in monitors:
            lines.append(f"Monitor {mon.name}: {mon.width}x{mon.height} at ({mon.x},{mon.y})" + (" primary" if mon.primary else ""))
        scale, source = ctx.current_scale()
        lines.append(f"Scale factor: {scale:g} ({source})")
        selection = ctx.input_selection()
        lines.append(f"Input backend: {selection.backend or 'none'} ({selection.reason})")
        lines.append(_describe_mapping(ctx.mapping))
        return "\n".join(lines)

    @mcp.tool()
    @safe_tool
    def mouse_move(
        x: Annotated[int, Field(description="X in the last screenshot's pixels")],
        y: Annotated[int, Field(description="Y in the last screenshot's pixels")],
    ) -> str:
        """Move the mouse pointer to (x, y), given in pixels of the most recent screenshot."""
        ctx.input().move(*_to_backend(ctx, x, y))
        return f"Moved pointer to ({x}, {y})."

    @mcp.tool()
    @safe_tool
    def mouse_click(
        x: Annotated[int | None, Field(description="X in screenshot pixels; omit to click at the current position")] = None,
        y: Annotated[int | None, Field(description="Y in screenshot pixels; omit to click at the current position")] = None,
        button: Annotated[Button, Field(description="left, right or middle")] = "left",
        clicks: Annotated[int, Field(description="1 = click, 2 = double-click, 3 = triple-click", ge=1, le=3)] = 1,
    ) -> str:
        """Click a mouse button, optionally after moving to (x, y) in screenshot pixels.
        Screenshot again afterwards to check the result."""
        backend = ctx.input()
        if (x is None) != (y is None):
            return "Error: give both x and y, or neither."
        if x is not None and y is not None:
            backend.move(*_to_backend(ctx, x, y))
        backend.click(button, clicks)
        where = f" at ({x}, {y})" if x is not None else ""
        return f"{button} click x{clicks}{where} done."

    @mcp.tool()
    @safe_tool
    def mouse_drag(
        from_x: Annotated[int, Field(description="Start X in screenshot pixels")],
        from_y: Annotated[int, Field(description="Start Y in screenshot pixels")],
        to_x: Annotated[int, Field(description="End X in screenshot pixels")],
        to_y: Annotated[int, Field(description="End Y in screenshot pixels")],
    ) -> str:
        """Press the left button at the start point, drag to the end point and release
        (select text, move windows, drag files)."""
        backend = ctx.input()
        start = _to_backend(ctx, from_x, from_y)
        end = _to_backend(ctx, to_x, to_y)
        backend.move(*start)
        backend.button("left", True)
        try:
            time.sleep(0.1)
            backend.move(*end)
            time.sleep(0.1)
        finally:
            backend.button("left", False)
        return f"Dragged from ({from_x}, {from_y}) to ({to_x}, {to_y})."

    @mcp.tool()
    @safe_tool
    def scroll(
        x: Annotated[int | None, Field(description="X to scroll at (screenshot pixels); omit for the current position")] = None,
        y: Annotated[int | None, Field(description="Y to scroll at (screenshot pixels)")] = None,
        dx: Annotated[int, Field(description="Horizontal clicks; positive = right")] = 0,
        dy: Annotated[int, Field(description="Vertical clicks; positive = down (content moves up), negative = up")] = 0,
    ) -> str:
        """Scroll the mouse wheel, optionally after moving to (x, y)."""
        backend = ctx.input()
        if (x is None) != (y is None):
            return "Error: give both x and y, or neither."
        if x is not None and y is not None:
            backend.move(*_to_backend(ctx, x, y))
        backend.scroll(dx, dy)
        return f"Scrolled dx={dx}, dy={dy}."

    @mcp.tool()
    @safe_tool
    def type_text(text: Annotated[str, Field(description="Text to type into the focused window")]) -> str:
        """Type text as if on the keyboard into the focused field. Click the field first. For non-ASCII
        text or very long text prefer clipboard_write + key_press('ctrl+v')."""
        ctx.input().type_text(text)
        return f"Typed {len(text)} characters."

    @mcp.tool()
    @safe_tool
    def key_press(
        keys: Annotated[str, Field(description="Key or combo, e.g. 'Return', 'ctrl+c', 'ctrl+alt+t', 'alt+F4', "
                        "'super'. Space-separate several to press in sequence: 'ctrl+a Delete'.")],
    ) -> str:
        """Press a key or key combination (modifiers joined with '+')."""
        combos = parse_keys(keys)
        ctx.input().keys(combos)
        return f"Pressed {keys}."

    @mcp.tool()
    @safe_tool
    def wait(seconds: Annotated[float, Field(description="Seconds to wait, 0-30", ge=0, le=30)] = 1.0) -> str:
        """Pause so a window, page or animation can finish before the next screenshot."""
        seconds = max(0.0, min(float(seconds), 30.0))
        time.sleep(seconds)
        return f"Waited {seconds:g}s."

    @mcp.tool()
    @safe_tool
    def list_windows() -> str:
        """List open windows (id, desktop, pid, class, title). On Wayland only XWayland windows can be
        listed; native GNOME windows are invisible here, so rely on screenshots for those."""
        windows, note = ctx.windows.list_windows()
        if windows is None:
            return note
        rows = [f"{w.id}  {w.wm_class or '-'}  pid={w.pid or '-'}  {w.title}" for w in windows] or ["(no windows)"]
        return "\n".join(rows + ([f"Note: {note}"] if note else []))

    @mcp.tool()
    @safe_tool
    def focus_window(id_or_title: Annotated[str, Field(description="Window id from list_windows, or part of the title")]) -> str:
        """Bring a window to the front (XWayland windows only on Wayland; otherwise click it or use alt+Tab)."""
        return ctx.windows.focus(id_or_title)

    @mcp.tool()
    @safe_tool
    def open_app(name: Annotated[str, Field(description="Application name or desktop id, e.g. 'Files', 'firefox'")]) -> str:
        """Launch an installed application by its name, desktop id or command."""
        return ctx.apps.open_app(name)

    @mcp.tool()
    @safe_tool
    def open_url(url: Annotated[str, Field(description="http, https, file or mailto URL")]) -> str:
        """Open a URL in the default application. Only http, https, file and mailto are allowed."""
        return ctx.apps.open_url(url)

    @mcp.tool()
    @safe_tool
    def clipboard_read() -> str:
        """Return the current clipboard text."""
        return ctx.clipboard.read()

    @mcp.tool()
    @safe_tool
    def clipboard_write(text: Annotated[str, Field(description="Text to place on the clipboard")]) -> str:
        """Replace the clipboard text (then key_press('ctrl+v') pastes it)."""
        ctx.clipboard.write(text)
        return f"Clipboard set ({len(text)} characters)."


