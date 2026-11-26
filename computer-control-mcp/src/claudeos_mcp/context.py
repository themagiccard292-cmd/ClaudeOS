"""Per-process state shared by all tools: config, runner, gate, backends and the screen mapping."""

from __future__ import annotations

import getpass
import os
import sys
import threading
from collections.abc import Callable
from dataclasses import dataclass, field

from .approval import ApprovalClient
from .backends.clipboard import ClipboardBackend
from .backends.input_ import InputBackend, InputError, XdotoolBackend, YdotoolBackend, select_backend
from .backends.portal import portal_screenshot
from .backends.screen import ScreenBackend
from .backends.system import SystemBackend
from .backends.windows import AppLauncher, WindowBackend
from .config import Config
from .gate import Gate
from .geometry import Mapping, default_mapping
from .runner import Runner, SubprocessRunner


@dataclass
class AppContext:
    config: Config
    runner: Runner
    gate: Gate
    screen: ScreenBackend
    windows: WindowBackend
    apps: AppLauncher
    clipboard: ClipboardBackend
    system: SystemBackend
    socket_exists: Callable[[str], bool] = os.path.exists
    _mapping: Mapping = field(default_factory=default_mapping)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _input: InputBackend | None = None

    # -- screen mapping (coordinates are in the last screenshot's space) ------------------
    @property
    def mapping(self) -> Mapping:
        with self._lock:
            return self._mapping

    def set_mapping(self, mapping: Mapping) -> None:
        with self._lock:
            self._mapping = mapping

    def current_scale(self) -> tuple[float, str]:
        m = self.mapping
        if m.from_screenshot:
            return m.scale, "from the last screenshot"
        return self.screen.scale(self.config.screen_scale_override, None)

    # -- input --------------------------------------------------------------------------
    def input_selection(self):
        return select_backend(
            override=self.config.input_backend_override,
            session_type=self.config.session_type,
            has=lambda name: self.runner.which(name) is not None,
            display=bool(self.config.env.get("DISPLAY")),
        )

    def input(self) -> InputBackend:
        if self._input is None:
            selection = self.input_selection()
            if selection.backend == "ydotool":
                self._input = YdotoolBackend(
                    self.runner,
                    self.config.env,
                    units_per_px=self.config.ydotool_units_per_px,
                    max_step=self.config.ydotool_max_step,
                    socket_exists=self.socket_exists,
                )
            elif selection.backend == "xdotool":
                self._input = XdotoolBackend(self.runner)
            else:
                raise InputError(f"No input backend available: {selection.reason}")
        return self._input


def build_context(config: Config | None = None, runner: Runner | None = None) -> AppContext:
    config = config or Config.from_env()
    portal = portal_screenshot
    socket_exists: Callable[[str], bool] = os.path.exists
    if runner is None:
        if config.fake:
            from .testing import fake_runner, no_portal

            print("claudeos-desktop: CLAUDEOS_MCP_FAKE=1 - using fake backends (test hook)", file=sys.stderr)
            runner = fake_runner()
            portal = no_portal
            socket_exists = lambda _path: True  # noqa: E731
        else:
            runner = SubprocessRunner(config.env)
    user = config.env.get("USER") or getpass.getuser()
    gate = Gate(
        ApprovalClient(config.panel_sockets),
        home=config.home,
        user=user,
        timeout_ms=config.approval_timeout_ms,
    )
    return AppContext(
        config=config,
        runner=runner,
        gate=gate,
        screen=ScreenBackend(runner, session_type=config.session_type, portal=portal),
        windows=WindowBackend(runner, session_type=config.session_type, env=config.env),
        apps=AppLauncher(runner, config.env),
        clipboard=ClipboardBackend(runner, config.env),
        system=SystemBackend(runner),
        socket_exists=socket_exists,
    )
