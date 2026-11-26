"""Mouse and keyboard backends.

- :class:`YdotoolBackend` — Wayland (GNOME 50 has no X11 session). Needs the ``ydotoold`` daemon
  (systemd user unit shipped by system-config) and write access to ``/dev/uinput``. Talks the
  ydotool 1.x CLI: ``mousemove -x X -y Y``, ``mousemove -w -x 0 -y N`` (wheel), ``click 0xC0``,
  ``key 29:1 20:1 20:0 29:0``, ``type --file -``.
- :class:`XdotoolBackend` — real X11 sessions; on Wayland it only reaches XWayland windows.

:func:`select_backend` picks one from ``CLAUDEOS_INPUT_BACKEND``, ``XDG_SESSION_TYPE`` and what is installed.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from ..geometry import plan_ydotool_moves
from ..keys import Combo
from ..runner import Runner

BUTTONS = {"left": 0, "right": 1, "middle": 2}
_XDO_BUTTONS = {"left": "1", "middle": "2", "right": "3"}


class InputError(RuntimeError):
    pass


class InputBackend:
    name = "none"

    def move(self, x: int, y: int) -> None:
        raise NotImplementedError

    def click(self, button: str, clicks: int) -> None:
        raise NotImplementedError

    def button(self, button: str, down: bool) -> None:
        raise NotImplementedError

    def scroll(self, dx: int, dy: int) -> None:
        raise NotImplementedError

    def keys(self, combos: list[Combo]) -> None:
        raise NotImplementedError

    def type_text(self, text: str) -> None:
        raise NotImplementedError


def ydotool_socket(env: Mapping[str, str]) -> str:
    """$YDOTOOL_SOCKET, else $XDG_RUNTIME_DIR/.ydotool_socket (where our ydotoold unit listens)."""
    if env.get("YDOTOOL_SOCKET"):
        return env["YDOTOOL_SOCKET"]
    runtime = env.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return os.path.join(runtime, ".ydotool_socket")


class YdotoolBackend(InputBackend):
    name = "ydotool"

    def __init__(
        self,
        runner: Runner,
        env: Mapping[str, str],
        *,
        units_per_px: float = 1.0,
        max_step: int = 0,
        socket_exists: Callable[[str], bool] = os.path.exists,
    ) -> None:
        self._runner = runner
        self._socket = ydotool_socket(env)
        self._units = units_per_px
        self._max_step = max_step
        self._socket_exists = socket_exists

    def _run(self, *args: str, data: bytes | None = None) -> None:
        if not self._socket_exists(self._socket):
            raise InputError(
                f"ydotoold is not running (no socket at {self._socket}). Start it with "
                "`systemctl --user start ydotoold` and make sure you can write /dev/uinput "
                "(ClaudeOS ships a udev rule; log out and back in after installing). Run `claudeos-doctor`."
            )
        result = self._runner.run(
            ["ydotool", *args], timeout=30, input=data, env={"YDOTOOL_SOCKET": self._socket}
        )
        if not result.ok:
            raise InputError(f"ydotool {args[0]} failed: {result.describe_failure()}")

    def move(self, x: int, y: int) -> None:
        for dx, dy in plan_ydotool_moves(x, y, units_per_px=self._units, max_step=self._max_step):
            self._run("mousemove", "-x", str(dx), "-y", str(dy))

    def click(self, button: str, clicks: int) -> None:
        code = BUTTONS[button] | 0xC0  # 0x40 down + 0x80 up
        args = ["click"]
        if clicks > 1:
            args += ["--repeat", str(clicks), "--next-delay", "60"]
        self._run(*args, hex(code))

    def button(self, button: str, down: bool) -> None:
        self._run("click", hex(BUTTONS[button] | (0x40 if down else 0x80)))

    def scroll(self, dx: int, dy: int) -> None:
        # Wheel: positive dy scrolls down for the user, which is a negative wheel value.
        if dx or dy:
            self._run("mousemove", "--wheel", "-x", str(dx), "-y", str(-dy))

    def keys(self, combos: list[Combo]) -> None:
        args: list[str] = []
        for combo in combos:
            args += combo.ydotool_args()
        self._run("key", "--key-delay", "20", *args)

    def type_text(self, text: str) -> None:
        if not text.isascii():
            raise InputError(
                "ydotool can only type ASCII characters (it emulates a US keyboard). For other text, "
                "call clipboard_write with the text and then key_press('ctrl+v')."
            )
        self._run("type", "--key-delay", "8", "--file", "-", data=text.encode())


class XdotoolBackend(InputBackend):
    name = "xdotool"

    def __init__(self, runner: Runner) -> None:
        self._runner = runner

    def _run(self, *args: str) -> None:
        result = self._runner.run(["xdotool", *args], timeout=30)
        if not result.ok:
            raise InputError(f"xdotool {args[0]} failed: {result.describe_failure()}")

    def move(self, x: int, y: int) -> None:
        self._run("mousemove", "--sync", str(x), str(y))

    def click(self, button: str, clicks: int) -> None:
        self._run("click", "--repeat", str(clicks), "--delay", "60", _XDO_BUTTONS[button])

    def button(self, button: str, down: bool) -> None:
        self._run("mousedown" if down else "mouseup", _XDO_BUTTONS[button])

    def scroll(self, dx: int, dy: int) -> None:
        for count, button in ((dy, "5" if dy > 0 else "4"), (dx, "7" if dx > 0 else "6")):
            if count:
                self._run("click", "--repeat", str(abs(count)), "--delay", "30", button)

    def keys(self, combos: list[Combo]) -> None:
        self._run("key", "--clearmodifiers", "--delay", "40", *[c.xdotool_name() for c in combos])

    def type_text(self, text: str) -> None:
        self._run("type", "--clearmodifiers", "--delay", "8", "--", text)


@dataclass(frozen=True)
class Selection:
    backend: str | None  # "ydotool" | "xdotool" | None
    reason: str


def select_backend(*, override: str, session_type: str, has: Callable[[str], bool], display: bool) -> Selection:
    """Choose an input backend (pure; ``has(name)`` says whether a program is installed)."""
    if override:
        if override not in ("ydotool", "xdotool"):
            return Selection(None, f"CLAUDEOS_INPUT_BACKEND={override!r} is not 'ydotool' or 'xdotool'.")
        if not has(override):
            return Selection(None, f"CLAUDEOS_INPUT_BACKEND={override} but {override} is not installed.")
        return Selection(override, "forced by CLAUDEOS_INPUT_BACKEND")
    if session_type == "x11":
        if has("xdotool"):
            return Selection("xdotool", "X11 session")
        if has("ydotool"):
            return Selection("ydotool", "X11 session without xdotool")
        return Selection(None, "Install xdotool (X11) or ydotool.")
    if has("ydotool"):
        return Selection("ydotool", "Wayland session" if session_type == "wayland" else "default")
    if has("xdotool") and display:
        return Selection(
            "xdotool", "ydotool missing; xdotool only reaches XWayland windows on Wayland (install ydotool)"
        )
    return Selection(None, "Install ydotool (sudo apt install ydotool) and enable the ydotoold user service.")
