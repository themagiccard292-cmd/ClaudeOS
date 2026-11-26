"""Fakes for tests and for the ``CLAUDEOS_MCP_FAKE=1`` test hook.

The hook is inert unless the variable is exactly ``1``. When enabled, the server uses
:func:`fake_runner` instead of real programs: a fake ``gnome-screenshot`` that writes a
deterministic 2560x1440 PNG, a fake ``ydotool`` that records calls, and nothing else installed.
Safety gating and the approval socket stay REAL, so integration tests exercise them end to end.
"""

from __future__ import annotations

import io
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field

from .runner import RunResult

Handler = Callable[[list[str], bytes | None], RunResult]


@dataclass
class Call:
    argv: list[str]
    input: bytes | None = None
    cwd: str | None = None
    env: Mapping[str, str] | None = None


@dataclass
class FakeRunner:
    """Scriptable :class:`claudeos_mcp.runner.Runner`.

    ``programs`` maps a program name to a handler or a fixed :class:`RunResult`; anything not
    listed is "not installed" (``which`` → None, ``run`` → exit 127).
    """

    programs: dict[str, Handler | RunResult] = field(default_factory=dict)
    calls: list[Call] = field(default_factory=list)
    spawned: list[list[str]] = field(default_factory=list)

    def which(self, name: str) -> str | None:
        return f"/usr/bin/{name}" if name in self.programs else None

    def run(
        self,
        argv: Sequence[str],
        *,
        timeout: float = 30.0,
        input: bytes | None = None,
        cwd: str | None = None,
        env: Mapping[str, str] | None = None,
        capture: bool = True,
        max_capture: int = 0,
    ) -> RunResult:
        argv = list(argv)
        self.calls.append(Call(argv, input, cwd, env))
        name = argv[0].rsplit("/", 1)[-1]
        handler = self.programs.get(name)
        if handler is None:
            return RunResult(127, stderr=f"command not found: {name}".encode())
        if isinstance(handler, RunResult):
            return handler
        return handler(argv, input)

    def spawn_detached(self, argv: Sequence[str], *, cwd: str | None = None) -> int:
        self.spawned.append(list(argv))
        return 4242

    def argvs(self, program: str) -> list[list[str]]:
        return [c.argv for c in self.calls if c.argv[0].rsplit("/", 1)[-1] == program]


def make_png(width: int, height: int, color: tuple[int, int, int] = (217, 119, 87)) -> bytes:
    from PIL import Image

    img = Image.new("RGB", (width, height), color)
    # A contrasting square in the corner makes crops/scales visibly testable.
    img.paste((245, 244, 239), (0, 0, max(1, width // 10), max(1, height // 10)))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def screenshot_writer(width: int, height: int) -> Handler:
    """A fake ``gnome-screenshot -f FILE`` / ``grim FILE`` that writes a PNG to the last argument."""

    def handler(argv: list[str], _input: bytes | None) -> RunResult:
        with open(argv[-1], "wb") as fh:
            fh.write(make_png(width, height))
        return RunResult(0)

    return handler


def fake_runner() -> FakeRunner:
    """The runner used by ``CLAUDEOS_MCP_FAKE=1``."""
    return FakeRunner(
        programs={
            "gnome-screenshot": screenshot_writer(2560, 1440),
            "ydotool": RunResult(0),
        }
    )


def no_portal(_timeout: float) -> str:
    from .backends.portal import PortalError

    raise PortalError("portal disabled in fake mode")
