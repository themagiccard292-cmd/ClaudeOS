"""ClaudeOS "Ask Claude" extension for GNOME Files (Nautilus 50, GTK4/libadwaita).

Adds an **Ask Claude** entry to the context menu of any selection (files, folders, mixed)
and to the empty-folder background menu.  Activating it runs, exactly as ARCHITECTURE C2
requires and without a shell::

    claudeos-panel attach -- <absolute path>...

The launcher shows the docked side panel and attaches the paths to the composer.

Design rules for code that runs inside the file-manager process:

* never raise out of a Nautilus callback (log to stderr and return no items);
* never block: the launcher is spawned detached and reaped by a daemon thread;
* paths are passed verbatim as separate argv elements (no shell, no quoting);
* the module stays importable without PyGObject so the pure helpers can be unit-tested.

Loaded by ``python3-nautilus`` from ``/usr/share/nautilus-python/extensions/`` (system) or
``~/.local/share/nautilus-python/extensions/`` (per user).
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import threading
from collections.abc import Iterable, Sequence
from typing import Any

try:
    import gi

    try:
        gi.require_version("Nautilus", "4.0")
    except ValueError:  # Nautilus 3.x (GNOME <= 42); the *args signatures below cover it
        gi.require_version("Nautilus", "3.0")
    from gi.repository import Gio, GObject, Nautilus
except (ImportError, ValueError):  # no PyGObject / no Nautilus typelib: helpers only
    GObject = Gio = Nautilus = None

log = logging.getLogger("claudeos.nautilus")

ITEM_NAME = "ClaudeOS::AskClaude"
LABEL = "Ask Claude"
TIP = "Open the Claude side panel with the selected items attached"
ICON = "claudeos-panel"  # shipped by the theme package

LAUNCHER = "claudeos-panel"
FALLBACK_LAUNCHER = "/usr/bin/claudeos-panel"
NOTIFY = "notify-send"

#: Most paths handed to one `claudeos-panel attach`; the rest are dropped with a notification.
MAX_PATHS = 64


# --------------------------------------------------------------------------- path extraction


def _location(file_info: Any) -> Any:
    """Return the ``Gio.File`` of a ``Nautilus.FileInfo`` (``get_location`` then ``get_uri``)."""
    get_location = getattr(file_info, "get_location", None)
    gfile = get_location() if callable(get_location) else None
    if gfile is None and Gio is not None:
        uri = file_info.get_uri()
        if uri:
            gfile = Gio.File.new_for_uri(uri)
    return gfile


def local_path(file_info: Any) -> str | None:
    """Absolute local path of a Nautilus item, or ``None`` when it has none.

    ``Gio.File.get_path()`` decodes ``%20``/unicode URIs and maps gvfs mounts to their FUSE
    path under ``/run/user/<uid>/gvfs``.  It returns ``None`` for virtual locations such as
    ``trash:///``, ``recent:///`` and unmounted network URIs, which are therefore skipped.
    """
    gfile = _location(file_info)
    if gfile is None:
        return None
    path = gfile.get_path()
    if not path or not os.path.isabs(path):
        return None
    return str(path)


def collect_paths(items: Iterable[Any], limit: int = MAX_PATHS + 1) -> list[str]:
    """Local paths of ``items`` in selection order, deduplicated, at most ``limit`` of them.

    One item that cannot be resolved is skipped, never fatal.  Stopping at ``limit`` keeps the
    menu fast when someone selects thousands of files; callers ask for one more than
    ``MAX_PATHS`` so they can tell that the selection was truncated.
    """
    paths: list[str] = []
    seen: set[str] = set()
    for item in items:
        try:
            path = local_path(item)
        except Exception:
            log.exception("Ask Claude: cannot resolve a selected item, skipping it")
            continue
        if path is not None and path not in seen:
            seen.add(path)
            paths.append(path)
            if len(paths) >= limit:
                break
    return paths


# --------------------------------------------------------------------------- launching


def find_launcher() -> str | None:
    """Resolve the ``claudeos-panel`` launcher: ``$PATH`` first, then ``/usr/bin``."""
    found = shutil.which(LAUNCHER)
    if found:
        return found
    if os.path.isfile(FALLBACK_LAUNCHER) and os.access(FALLBACK_LAUNCHER, os.X_OK):
        return FALLBACK_LAUNCHER
    return None


def build_command(launcher: str, paths: Sequence[str]) -> list[str]:
    """The C2 invocation.  ``--`` ends option parsing so no path can act as a flag."""
    return [launcher, "attach", "--", *paths]


def _spawn(argv: Sequence[str]) -> bool:
    """Start ``argv`` detached (own session, no stdio, no shell) and reap it off-thread."""
    try:
        proc = subprocess.Popen(
            list(argv),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except (OSError, ValueError) as exc:
        log.error("Ask Claude: cannot start %s: %s", argv[0], exc)
        return False
    # `claudeos-panel attach` may wait up to 20 s for the app to come up; collect its exit
    # status on a daemon thread so it never lingers as a zombie of the file manager.
    threading.Thread(target=proc.wait, name="claudeos-ask-claude-reaper", daemon=True).start()
    return True


def _notify(body: str) -> None:
    """Best-effort desktop notification; silently does nothing without ``notify-send``."""
    notifier = shutil.which(NOTIFY)
    if notifier:
        _spawn([notifier, f"--app-name={LABEL}", f"--icon={ICON}", LABEL, body])


def attach(paths: Sequence[str]) -> bool:
    """Ask the panel to attach ``paths``.  Returns whether the launcher was started."""
    if not paths:
        return False
    if len(paths) > MAX_PATHS:
        log.warning("Ask Claude: %d items selected, attaching the first %d", len(paths), MAX_PATHS)
        _notify(f"Only the first {MAX_PATHS} selected items were attached.")
        paths = paths[:MAX_PATHS]

    launcher = find_launcher()
    if launcher is None:
        log.error("Ask Claude: %s not found in PATH or %s", LAUNCHER, FALLBACK_LAUNCHER)
        _notify("The Claude side panel is not installed.")
        return False
    if _spawn(build_command(launcher, paths)):
        return True
    _notify("Could not start the Claude side panel.")
    return False


# --------------------------------------------------------------------------- Nautilus provider

_BASES: tuple[type, ...] = (
    (GObject.GObject, Nautilus.MenuProvider) if Nautilus is not None else (object,)
)


class AskClaudeProvider(*_BASES):
    """Adds the "Ask Claude" item to file and folder-background context menus."""

    def _menu_items(self, items: Iterable[Any]) -> list[Any]:
        if Nautilus is None:
            return []
        paths = collect_paths(items)
        if not paths:
            return []
        item = Nautilus.MenuItem(name=ITEM_NAME, label=LABEL, tip=TIP, icon=ICON)
        item.connect("activate", self._on_activate, paths)
        return [item]

    def _on_activate(self, _menu_item: Any, paths: list[str]) -> None:
        try:
            attach(paths)
        except Exception:
            log.exception("Ask Claude: activation failed")

    # Nautilus 4 passes ``(files)``; Nautilus 3 passed ``(window, files)``.  The last argument
    # is the payload in both, so ``*args`` serves every version.
    def get_file_items(self, *args: Any) -> list[Any]:
        """Context-menu items for the selected files/folders."""
        try:
            return self._menu_items(args[-1]) if args else []
        except Exception:
            log.exception("Ask Claude: building the file menu failed")
            return []

    def get_background_items(self, *args: Any) -> list[Any]:
        """Context-menu items for a right-click on the empty folder background."""
        try:
            return self._menu_items([args[-1]]) if args else []
        except Exception:
            log.exception("Ask Claude: building the background menu failed")
            return []
