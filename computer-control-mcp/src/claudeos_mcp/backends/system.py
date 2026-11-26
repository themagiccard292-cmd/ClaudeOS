"""System information and control: notifications, gsettings, systemd units, D-Bus calls.

``system_info`` reports a fixed set of facts; it never dumps the environment (tokens live there).
"""

from __future__ import annotations

import os
import platform
import re
import shutil
from collections.abc import Mapping

from ..runner import Runner

GSETTINGS_ACTIONS = ("get", "set", "reset", "reset-recursively", "list-keys", "list-recursively", "range", "describe")
SYSTEMD_ACTIONS = (
    "status", "is-active", "is-enabled", "start", "stop", "restart", "reload", "enable", "disable", "mask", "unmask",
)
_SCHEMA_RE = re.compile(r"^[A-Za-z0-9.-]+(:/[A-Za-z0-9/._-]*/)?$")
_KEY_RE = re.compile(r"^[a-z0-9-]+$")
_UNIT_RE = re.compile(r"^[A-Za-z0-9:_.@\\-]+$")
_BUS_NAME_RE = re.compile(r"^(:[0-9.]+|[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)+)$")
_OBJECT_PATH_RE = re.compile(r"^/([A-Za-z0-9_]+(/[A-Za-z0-9_]+)*)?$")
_METHOD_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$")


class SystemToolError(RuntimeError):
    pass


def _read(path: str) -> str:
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


def os_release() -> str:
    for line in _read("/etc/os-release").splitlines():
        if line.startswith("PRETTY_NAME="):
            return line.split("=", 1)[1].strip().strip('"')
    return platform.platform()


def _meminfo() -> str:
    values = {}
    for line in _read("/proc/meminfo").splitlines():
        key, _, rest = line.partition(":")
        if key in ("MemTotal", "MemAvailable"):
            values[key] = int(rest.split()[0]) // 1024
    if not values:
        return "unknown"
    return f"{values.get('MemAvailable', '?')} MiB available of {values.get('MemTotal', '?')} MiB"


def _uptime() -> str:
    raw = _read("/proc/uptime").split()
    if not raw:
        return "unknown"
    seconds = int(float(raw[0]))
    return f"{seconds // 86400}d {seconds % 86400 // 3600}h {seconds % 3600 // 60}m"


def _cpu() -> str:
    for line in _read("/proc/cpuinfo").splitlines():
        if line.startswith("model name"):
            return f"{line.split(':', 1)[1].strip()} ({os.cpu_count()} threads)"
    return f"{platform.machine()} ({os.cpu_count()} threads)"


def _disk(path: str) -> str:
    try:
        usage = shutil.disk_usage(path)
    except OSError:
        return "unknown"
    gib = 1024**3
    return f"{usage.free / gib:.1f} GiB free of {usage.total / gib:.1f} GiB"


def system_info(env: Mapping[str, str], extra: Mapping[str, str]) -> str:
    """Plain-text summary. Only named, non-secret facts; never the environment."""
    home = env.get("HOME", "~")
    lines = {
        "OS": os_release(),
        "Kernel": platform.release(),
        "Hostname": platform.node(),
        "User": env.get("USER", ""),
        "Home": home,
        "Session": f"{env.get('XDG_SESSION_TYPE', 'unknown')} / {env.get('XDG_CURRENT_DESKTOP', 'unknown')}",
        "CPU": _cpu(),
        "Memory": _meminfo(),
        "Disk /": _disk("/"),
        "Disk home": _disk(home),
        "Uptime": _uptime(),
        "Python": platform.python_version(),
    }
    lines.update(extra)
    return "\n".join(f"{k}: {v}" for k, v in lines.items())


class SystemBackend:
    def __init__(self, runner: Runner) -> None:
        self._runner = runner

    def _run(self, argv: list[str], what: str, timeout: float = 20) -> str:
        if not self._runner.which(argv[0]):
            raise SystemToolError(f"{argv[0]} is not installed.")
        result = self._runner.run(argv, timeout=timeout)
        output = (result.text() + ("\n" + result.err_text() if result.err_text() else "")).strip()
        if not result.ok:
            raise SystemToolError(f"{what} failed ({result.describe_failure()}).")
        return output

    def notify(self, title: str, body: str, urgency: str) -> str:
        self._run(["notify-send", "--app-name=Claude", f"--urgency={urgency}", "--", title, body], "notify-send")
        return "Notification shown."

    def gsettings(self, action: str, schema: str, key: str | None, value: str | None) -> str:
        if action not in GSETTINGS_ACTIONS:
            raise ValueError(f"action must be one of {', '.join(GSETTINGS_ACTIONS)}")
        if not _SCHEMA_RE.match(schema or ""):
            raise ValueError(f"Invalid schema {schema!r} (e.g. org.gnome.desktop.interface).")
        argv = ["gsettings", action, schema]
        if action in ("get", "set", "reset", "range", "describe"):
            if not key or not _KEY_RE.match(key):
                raise ValueError(f"action {action!r} needs a key such as 'color-scheme'.")
            argv.append(key)
        if action == "set":
            if value is None:
                raise ValueError("action 'set' needs a value in GVariant syntax, e.g. \"'prefer-dark'\" or 'true'.")
            argv.append(value)
        output = self._run(argv, f"gsettings {action}")
        return output or f"gsettings {action} {schema} {key or ''} done."

    def systemd(self, action: str, unit: str, scope: str) -> str:
        if action not in SYSTEMD_ACTIONS:
            raise ValueError(f"action must be one of {', '.join(SYSTEMD_ACTIONS)}")
        if scope not in ("user", "system"):
            raise ValueError("scope must be 'user' or 'system'")
        if not _UNIT_RE.match(unit or ""):
            raise ValueError(f"Invalid unit name {unit!r}.")
        argv = ["systemctl", "--no-pager"] + (["--user"] if scope == "user" else []) + [action, "--", unit]
        result = self._runner.run(argv, timeout=60) if self._runner.which("systemctl") else None
        if result is None:
            raise SystemToolError("systemctl is not installed.")
        output = (result.text() + "\n" + result.err_text()).strip()
        # status/is-* use non-zero exit codes to report state, not failure.
        if action in ("status", "is-active", "is-enabled") and not result.timed_out:
            return output or f"exit code {result.returncode}"
        if not result.ok:
            raise SystemToolError(f"systemctl {action} {unit} failed ({result.describe_failure()}).")
        return output or f"systemctl {'--user ' if scope == 'user' else ''}{action} {unit}: done."

    def dbus_call(self, bus: str, dest: str, path: str, method: str, args: list[str]) -> str:
        if bus not in ("session", "system"):
            raise ValueError("bus must be 'session' or 'system'")
        if not _BUS_NAME_RE.match(dest or ""):
            raise ValueError(f"Invalid destination bus name {dest!r}.")
        if not _OBJECT_PATH_RE.match(path or ""):
            raise ValueError(f"Invalid object path {path!r}.")
        if not _METHOD_RE.match(method or ""):
            raise ValueError(f"method must be Interface.Method, got {method!r}.")
        argv = ["gdbus", "call", f"--{bus}", "--dest", dest, "--object-path", path, "--method", method, "--", *args]
        return self._run(argv, "gdbus call", timeout=30) or "(no return value)"
