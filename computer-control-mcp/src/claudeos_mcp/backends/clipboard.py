"""Clipboard via ``wl-paste``/``wl-copy`` (Wayland), falling back to ``xclip`` (X11/XWayland)."""

from __future__ import annotations

from collections.abc import Mapping

from ..runner import Runner

MAX_CLIPBOARD_CHARS = 100_000


class ClipboardError(RuntimeError):
    pass


class ClipboardBackend:
    def __init__(self, runner: Runner, env: Mapping[str, str]) -> None:
        self._runner = runner
        self._wayland = bool(env.get("WAYLAND_DISPLAY"))
        self._x11 = bool(env.get("DISPLAY"))

    def _tools(self) -> list[str]:
        tools = []
        if self._wayland and self._runner.which("wl-paste") and self._runner.which("wl-copy"):
            tools.append("wl")
        if self._x11 and self._runner.which("xclip"):
            tools.append("xclip")
        if not tools:
            raise ClipboardError(
                "No clipboard tool available: install wl-clipboard (Wayland) or xclip (X11)."
            )
        return tools

    def read(self) -> str:
        errors = []
        for tool in self._tools():
            if tool == "wl":
                result = self._runner.run(["wl-paste", "--no-newline", "--type", "text/plain;charset=utf-8"], timeout=5)
                if not result.ok and b"No suitable type" in result.stderr:
                    types = self._runner.run(["wl-paste", "--list-types"], timeout=5).text().split()
                    return "[clipboard holds no text; available types: " + ", ".join(types[:10]) + "]"
                if not result.ok and b"Nothing is copied" in result.stderr:
                    return ""
            else:
                result = self._runner.run(["xclip", "-selection", "clipboard", "-o"], timeout=5)
            if result.ok:
                return result.text()
            errors.append(f"{tool}: {result.describe_failure()}")
        raise ClipboardError("Could not read the clipboard: " + "; ".join(errors))

    def write(self, text: str) -> None:
        errors = []
        for tool in self._tools():
            # Both tools fork a process that keeps serving the selection: do not capture its pipes.
            argv = ["wl-copy", "--type", "text/plain;charset=utf-8"] if tool == "wl" else ["xclip", "-selection", "clipboard", "-i"]
            result = self._runner.run(argv, timeout=5, input=text.encode(), capture=False)
            if result.ok:
                return
            errors.append(f"{tool}: {result.describe_failure()}")
        raise ClipboardError("Could not write the clipboard: " + "; ".join(errors))
