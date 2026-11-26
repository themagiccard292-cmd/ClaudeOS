"""Screen capture with a fallback chain, plus crop/downscale and screen geometry.

Chain (first that works wins):
1. ``gnome-screenshot -f FILE``                       GNOME (Wayland or X11)
2. xdg-desktop-portal Screenshot (see ``portal.py``) any desktop with a portal backend
3. ``grim FILE``                                      wlroots compositors only (not GNOME)
4. ``import -window root FILE`` / ``scrot -o FILE``   real X11 sessions only
"""

from __future__ import annotations

import io
import os
import tempfile
from collections.abc import Callable
from dataclasses import dataclass

from PIL import Image

from ..geometry import Monitor, detect_scale, parse_xrandr
from ..runner import Runner
from .portal import PortalError

INSTALL_HINT = (
    "No screenshot method worked. On ClaudeOS install `gnome-screenshot` "
    "(sudo apt install gnome-screenshot) and make sure the xdg-desktop-portal-gnome service runs; "
    "the first portal screenshot may need you to allow it once. Run `claudeos-doctor` for details."
)


class ScreenshotError(RuntimeError):
    pass


@dataclass(frozen=True)
class Capture:
    png: bytes
    width: int
    height: int
    method: str


def _png_size(data: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(data)) as img:
        return img.size


class ScreenBackend:
    def __init__(
        self,
        runner: Runner,
        *,
        session_type: str,
        portal: Callable[[float], str],
        tmp_dir: str | None = None,
    ) -> None:
        self._runner = runner
        self._session = session_type
        self._portal = portal
        self._tmp_dir = tmp_dir

    # -- capture -------------------------------------------------------------------------
    def _file_method(self, argv_for: Callable[[str], list[str]], name: str) -> Capture:
        fd, path = tempfile.mkstemp(prefix="claudeos-shot-", suffix=".png", dir=self._tmp_dir)
        os.close(fd)
        try:
            os.unlink(path)  # tools refuse to overwrite / want to create the file themselves
            result = self._runner.run(argv_for(path), timeout=20)
            if not result.ok:
                raise ScreenshotError(f"{name}: {result.describe_failure()}")
            if not os.path.exists(path) or os.path.getsize(path) == 0:
                raise ScreenshotError(f"{name}: produced no image")
            with open(path, "rb") as fh:
                data = fh.read()
        finally:
            if os.path.exists(path):
                os.unlink(path)
        width, height = _png_size(data)
        return Capture(data, width, height, name)

    def _portal_method(self) -> Capture:
        try:
            path = self._portal(30.0)
        except PortalError as exc:
            raise ScreenshotError(f"xdg-desktop-portal: {exc}") from exc
        try:
            with open(path, "rb") as fh:
                data = fh.read()
        except OSError as exc:
            raise ScreenshotError(f"xdg-desktop-portal: cannot read {path}: {exc}") from exc
        finally:
            # The portal saves into ~/Pictures; do not litter the user's folder.
            try:
                os.unlink(path)
            except OSError:
                pass
        # Normalise to PNG whatever the portal produced.
        with Image.open(io.BytesIO(data)) as img:
            buf = io.BytesIO()
            img.save(buf, "PNG")
            return Capture(buf.getvalue(), img.size[0], img.size[1], "xdg-desktop-portal")

    def methods(self) -> list[tuple[str, Callable[[], Capture]]]:
        chain: list[tuple[str, Callable[[], Capture]]] = []
        which = self._runner.which
        if which("gnome-screenshot"):
            chain.append(("gnome-screenshot", lambda: self._file_method(lambda p: ["gnome-screenshot", "-f", p], "gnome-screenshot")))
        chain.append(("xdg-desktop-portal", self._portal_method))
        if which("grim") and self._session != "x11":
            chain.append(("grim", lambda: self._file_method(lambda p: ["grim", p], "grim")))
        if self._session == "x11":
            if which("import"):
                chain.append(("import", lambda: self._file_method(lambda p: ["import", "-window", "root", p], "import")))
            if which("scrot"):
                chain.append(("scrot", lambda: self._file_method(lambda p: ["scrot", "-o", p], "scrot")))
        return chain

    def capture(self) -> Capture:
        errors: list[str] = []
        for _name, method in self.methods():
            try:
                return method()
            except (ScreenshotError, OSError, ValueError) as exc:
                errors.append(str(exc))
        raise ScreenshotError(INSTALL_HINT + "\nTried:\n- " + "\n- ".join(errors or ["nothing available"]))

    # -- geometry ------------------------------------------------------------------------
    def xrandr(self) -> tuple[tuple[int, int] | None, list[Monitor]]:
        if not self._runner.which("xrandr"):
            return None, []
        result = self._runner.run(["xrandr", "--current"], timeout=5)
        return parse_xrandr(result.text()) if result.ok else (None, [])

    def gsettings_scale(self) -> int | None:
        if not self._runner.which("gsettings"):
            return None
        result = self._runner.run(["gsettings", "get", "org.gnome.desktop.interface", "scaling-factor"], timeout=5)
        try:
            return int(result.text().split()[-1]) if result.ok else None
        except (ValueError, IndexError):
            return None

    def scale(self, override: float | None, image_width: int | None) -> tuple[float, str]:
        screen, _ = self.xrandr() if not override else (None, [])
        return detect_scale(
            override=override,
            image_width=image_width,
            x_screen_width=screen[0] if screen else None,
            gsettings_factor=None if override else self.gsettings_scale(),
        )


def crop_and_scale(png: bytes, box: tuple[int, int, int, int] | None, size: tuple[int, int]) -> bytes:
    """Crop ``png`` to ``box`` (left, top, right, bottom; physical px), resize to ``size``, encode PNG."""
    with Image.open(io.BytesIO(png)) as img:
        img = img.convert("RGB")
        if box is not None:
            img = img.crop(box)
        if img.size != size:
            img = img.resize(size, Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, "PNG", optimize=True)
        return buf.getvalue()
