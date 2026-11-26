"""Windows and applications.

GNOME 50 is Wayland-only and restricts ``org.gnome.Shell.Eval`` and window introspection over
D-Bus, so native Wayland windows cannot be listed or focused from outside the shell. What does
work: XWayland windows via ``wmctrl``/``xdotool``, and launching/raising apps through their
``.desktop`` files (``gtk-launch``/``gio launch``), which also focuses a running single-instance app.
Results say so plainly instead of pretending.
"""

from __future__ import annotations

import configparser
import os
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from urllib.parse import urlparse

from ..runner import Runner

WAYLAND_LIMIT = (
    "Note: on GNOME Wayland only XWayland windows can be listed/focused; native Wayland windows "
    "(most GNOME apps, Firefox, ...) are invisible to these tools. Take a screenshot to see the "
    "desktop, use open_app to launch or raise an app, or key_press('super') and type the app name."
)
ALLOWED_URL_SCHEMES = ("http", "https", "file", "mailto")


@dataclass(frozen=True)
class Window:
    id: str
    desktop: str
    pid: str
    wm_class: str
    title: str


def parse_wmctrl(text: str) -> list[Window]:
    """Parse ``wmctrl -lpx``: ``0x0340000a  0 4242 ptyxis.Ptyxis  host Title words``."""
    windows = []
    for line in text.splitlines():
        parts = line.split(None, 5)
        if len(parts) >= 5:
            title = parts[5] if len(parts) == 6 else ""
            windows.append(Window(parts[0], parts[1], parts[2], parts[3], title))
    return windows


class WindowBackend:
    def __init__(self, runner: Runner, *, session_type: str, env: Mapping[str, str]) -> None:
        self._runner = runner
        self._session = session_type
        self._display = bool(env.get("DISPLAY"))

    @property
    def wayland(self) -> bool:
        return self._session != "x11"

    def list_windows(self) -> tuple[list[Window] | None, str]:
        """(windows or None when nothing can enumerate them, explanatory note)."""
        note = WAYLAND_LIMIT if self.wayland else ""
        if not self._display:
            return None, "No X display available, so no windows can be enumerated. " + WAYLAND_LIMIT
        if self._runner.which("wmctrl"):
            result = self._runner.run(["wmctrl", "-lpx"], timeout=5)
            if result.ok:
                return parse_wmctrl(result.text()), note
        if self._runner.which("xdotool"):
            result = self._runner.run(["xdotool", "search", "--onlyvisible", "--name", ""], timeout=5)
            if result.returncode in (0, 1):
                windows = []
                for wid in result.text().split()[:200]:
                    name = self._runner.run(["xdotool", "getwindowname", wid], timeout=5)
                    windows.append(Window(hex(int(wid)), "", "", "", name.text().strip()))
                return windows, note
        return None, "Neither wmctrl nor xdotool is installed. " + WAYLAND_LIMIT

    def focus(self, id_or_title: str) -> str:
        target = id_or_title.strip()
        if not target:
            raise ValueError("Give a window id (from list_windows) or part of its title.")
        is_id = bool(re.fullmatch(r"0x[0-9a-fA-F]+|\d+", target))
        if self._display and self._runner.which("wmctrl"):
            argv = ["wmctrl", "-i", "-a", target] if is_id else ["wmctrl", "-a", target]
            if self._runner.run(argv, timeout=5).ok:
                return f"Focused window {target!r}."
        if self._display and self._runner.which("xdotool"):
            argv = (
                ["xdotool", "windowactivate", "--sync", str(int(target, 0))]
                if is_id
                else ["xdotool", "search", "--limit", "1", "--name", re.escape(target), "windowactivate", "--sync"]
            )
            if self._runner.run(argv, timeout=5).ok:
                return f"Focused window {target!r}."
        raise LookupError(
            f"Could not focus {target!r}: no matching XWayland window. " + WAYLAND_LIMIT
            + " Alternatively press alt+Tab with key_press."
        )


# -- applications -------------------------------------------------------------------------


@dataclass(frozen=True)
class DesktopEntry:
    id: str  # file name without .desktop
    path: str
    name: str
    hidden: bool


def application_dirs(env: Mapping[str, str]) -> list[str]:
    home = env.get("HOME", os.path.expanduser("~"))
    data_home = env.get("XDG_DATA_HOME") or os.path.join(home, ".local/share")
    data_dirs = (env.get("XDG_DATA_DIRS") or "/usr/local/share:/usr/share").split(":")
    dirs = [data_home] + data_dirs + ["/var/lib/snapd/desktop", "/var/lib/flatpak/exports/share"]
    return [os.path.join(d, "applications") for d in dirs if d]


def read_desktop_entries(dirs: Iterable[str]) -> list[DesktopEntry]:
    entries: dict[str, DesktopEntry] = {}
    for directory in dirs:
        if not os.path.isdir(directory):
            continue
        for fname in sorted(os.listdir(directory)):
            if not fname.endswith(".desktop"):
                continue
            entry_id = fname[: -len(".desktop")]
            if entry_id in entries:  # earlier dirs take precedence (XDG rules)
                continue
            path = os.path.join(directory, fname)
            parser = configparser.ConfigParser(interpolation=None, strict=False)
            try:
                parser.read(path, encoding="utf-8")
                section = parser["Desktop Entry"]
            except (configparser.Error, KeyError, UnicodeDecodeError, OSError):
                continue
            hidden = section.get("NoDisplay", "false") == "true" or section.get("Hidden", "false") == "true"
            entries[entry_id] = DesktopEntry(entry_id, path, section.get("Name", entry_id), hidden)
    return list(entries.values())


def resolve_app(name: str, entries: list[DesktopEntry]) -> DesktopEntry | None:
    """Match by desktop id, id suffix (``org.gnome.Nautilus`` ← ``nautilus``), then display name."""
    wanted = name.strip().removesuffix(".desktop").lower()
    if not wanted:
        return None
    visible = sorted(entries, key=lambda e: e.hidden)
    for test in (
        lambda e: e.id.lower() == wanted,
        lambda e: e.id.lower().rsplit(".", 1)[-1] == wanted,
        lambda e: e.name.lower() == wanted,
        lambda e: e.name.lower().startswith(wanted),
        lambda e: wanted in e.name.lower(),
    ):
        for entry in visible:
            if test(entry):
                return entry
    return None


class AppLauncher:
    def __init__(self, runner: Runner, env: Mapping[str, str], entries_dirs: list[str] | None = None) -> None:
        self._runner = runner
        self._env = env
        self._dirs = entries_dirs if entries_dirs is not None else application_dirs(env)

    def open_app(self, name: str) -> str:
        entry = resolve_app(name, read_desktop_entries(self._dirs))
        if entry is not None:
            if self._runner.which("gtk-launch"):
                result = self._runner.run(["gtk-launch", entry.id], timeout=15)
                if result.ok:
                    return f"Launched {entry.name} ({entry.id}.desktop)."
            if self._runner.which("gio"):
                result = self._runner.run(["gio", "launch", entry.path], timeout=15)
                if result.ok:
                    return f"Launched {entry.name} ({entry.path})."
        program = name.strip()
        if re.fullmatch(r"[A-Za-z0-9._+-]+", program) and (path := self._runner.which(program)):
            pid = self._runner.spawn_detached([path], cwd=self._env.get("HOME"))
            return f"Started {path} (pid {pid})."
        raise LookupError(
            f"No application matches {name!r}. Give a desktop id (e.g. org.gnome.Nautilus, firefox_firefox), "
            "the name shown in the app grid, or a program on PATH."
        )

    def open_url(self, url: str) -> str:
        parsed = urlparse(url.strip())
        if parsed.scheme.lower() not in ALLOWED_URL_SCHEMES:
            raise ValueError(
                f"Refusing to open {url!r}: only {', '.join(ALLOWED_URL_SCHEMES)} URLs are allowed."
            )
        if parsed.scheme.lower() in ("http", "https") and not parsed.netloc:
            raise ValueError(f"{url!r} has no host.")
        if path := self._runner.which("xdg-open"):
            argv = [path, url.strip()]
        elif path := self._runner.which("gio"):
            argv = [path, "open", url.strip()]
        else:
            raise LookupError("Neither xdg-open nor gio is installed (sudo apt install xdg-utils).")
        self._runner.spawn_detached(argv)
        return f"Opened {url.strip()} with the default application."
