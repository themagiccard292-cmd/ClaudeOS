"""Runtime configuration, read once from the environment.

Every knob is an environment variable so the panel, `claudeos-doctor` and the tests
can steer the server without a config file:

- ``CLAUDEOS_PANEL_SOCKET``      approval socket (default ``$XDG_RUNTIME_DIR/claudeos/panel.sock``,
                                 fallback ``/tmp/claudeos-$UID/panel.sock``)
- ``CLAUDEOS_INPUT_BACKEND``     force ``ydotool`` or ``xdotool`` (default: auto)
- ``CLAUDEOS_SCREEN_SCALE``      logical scale factor override (e.g. ``2`` or ``1.25``)
- ``CLAUDEOS_YDOTOOL_UNITS_PER_PX``  pointer calibration for ydotool relative moves (default 1.0)
- ``CLAUDEOS_YDOTOOL_MAX_STEP``  split ydotool moves into steps of at most N units (0 = one move)
- ``CLAUDEOS_APPROVAL_TIMEOUT_MS`` how long a human gets to answer an approval card (default 120000)
- ``CLAUDEOS_MCP_FAKE``          TEST HOOK: ``1`` swaps every external program for in-process fakes.
                                 Inert for any other value. Never set it in production.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_APPROVAL_TIMEOUT_MS = 120_000
OUTPUT_LIMIT_CHARS = 20_000
READ_DEFAULT_BYTES = 1024 * 1024
READ_MAX_BYTES = 5 * 1024 * 1024


def _float(env: Mapping[str, str], key: str, default: float | None) -> float | None:
    raw = env.get(key, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _int(env: Mapping[str, str], key: str, default: int) -> int:
    raw = env.get(key, "").strip()
    try:
        return max(0, int(raw)) if raw else default
    except ValueError:
        return default


def panel_socket_candidates(env: Mapping[str, str]) -> list[str]:
    """Socket paths to try, in order (C1 / ARCHITECTURE §2)."""
    explicit = env.get("CLAUDEOS_PANEL_SOCKET", "").strip()
    if explicit:
        return [explicit]
    candidates = []
    runtime = env.get("XDG_RUNTIME_DIR", "").strip()
    if runtime:
        candidates.append(os.path.join(runtime, "claudeos", "panel.sock"))
    candidates.append(f"/tmp/claudeos-{os.getuid()}/panel.sock")
    return candidates


@dataclass(frozen=True)
class Config:
    home: str
    session_type: str  # "wayland", "x11" or "" (unknown)
    input_backend_override: str
    screen_scale_override: float | None
    ydotool_units_per_px: float
    ydotool_max_step: int
    approval_timeout_ms: int
    panel_sockets: list[str] = field(default_factory=list)
    fake: bool = False
    env: Mapping[str, str] = field(default_factory=dict, repr=False)

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Config:
        env = dict(os.environ if env is None else env)
        home = env.get("HOME") or str(Path.home())
        return cls(
            home=os.path.normpath(home),
            session_type=env.get("XDG_SESSION_TYPE", "").strip().lower(),
            input_backend_override=env.get("CLAUDEOS_INPUT_BACKEND", "").strip().lower(),
            screen_scale_override=_float(env, "CLAUDEOS_SCREEN_SCALE", None),
            ydotool_units_per_px=_float(env, "CLAUDEOS_YDOTOOL_UNITS_PER_PX", 1.0) or 1.0,
            ydotool_max_step=_int(env, "CLAUDEOS_YDOTOOL_MAX_STEP", 0),
            approval_timeout_ms=_int(env, "CLAUDEOS_APPROVAL_TIMEOUT_MS", DEFAULT_APPROVAL_TIMEOUT_MS)
            or DEFAULT_APPROVAL_TIMEOUT_MS,
            panel_sockets=panel_socket_candidates(env),
            # Only the exact value "1" enables the fakes; anything else is ignored.
            fake=env.get("CLAUDEOS_MCP_FAKE") == "1",
            env=env,
        )
