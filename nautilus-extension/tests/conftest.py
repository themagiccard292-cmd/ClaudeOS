"""Test harness: a fake PyGObject (`gi`) faithful enough to load and drive the extension.

The real ``Nautilus-4.0`` typelib is only available inside a GNOME session, so the tests install
stand-ins for ``gi`` and ``gi.repository.{Nautilus,GObject,Gio,GLib}``.  The fakes mimic the
behaviour the extension depends on:

* ``Nautilus.MenuItem`` takes keyword properties only (as every GObject constructor does) and
  ``connect('activate', cb, *user_data)`` calls ``cb(item, *user_data)``;
* ``Nautilus.FileInfo`` exposes ``get_uri / get_location / get_name / is_directory /
  get_uri_scheme``;
* ``Gio.File.new_for_uri(...).get_path()`` percent-decodes ``file://`` URIs, returns ``None`` for
  virtual or unmounted locations and maps gvfs mounts to their FUSE path.
"""

from __future__ import annotations

import importlib
import subprocess
import sys
import types
import urllib.parse
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parent.parent
for entry in (ROOT, ROOT / "scripts"):
    if str(entry) not in sys.path:
        sys.path.insert(0, str(entry))

MODULE_NAME = "claudeos_ask_claude"


# --------------------------------------------------------------------------- Gio / GLib fakes


class FakeGLibError(Exception):
    """Stands in for ``GLib.Error``."""


class FakeGFile:
    """Stands in for ``Gio.File`` (only the calls the extension makes)."""

    #: ``scheme://authority`` -> local FUSE directory, like gvfs under /run/user/<uid>/gvfs.
    fuse_mounts: dict[str, str] = {}

    def __init__(self, uri: str) -> None:
        self._uri = uri

    @classmethod
    def new_for_uri(cls, uri: str) -> FakeGFile:
        return cls(uri)

    def get_uri(self) -> str:
        return self._uri

    def get_path(self) -> str | None:
        parts = urllib.parse.urlsplit(self._uri)
        if parts.scheme == "file" and parts.netloc in ("", "localhost"):
            return urllib.parse.unquote(parts.path)
        mount = self.fuse_mounts.get(f"{parts.scheme}://{parts.netloc}")
        if mount:
            return mount + urllib.parse.unquote(parts.path)
        return None  # trash:///, recent:///, smb://host/share (unmounted), ...


# --------------------------------------------------------------------------- Nautilus fakes


class FakeMenuProvider:
    """Stands in for ``Nautilus.MenuProvider`` (an interface: no behaviour of its own)."""


class FakeGObject:
    """Stands in for ``GObject.GObject``."""

    def __init__(self) -> None:
        pass


class FakeMenuItem:
    """Stands in for ``Nautilus.MenuItem``: keyword-only construction, GObject-style signals."""

    def __init__(self, *, name: str, label: str, tip: str = "", icon: str = "") -> None:
        self.name, self.label, self.tip, self.icon = name, label, tip, icon
        self._handlers: list[tuple[str, Callable[..., Any], tuple[Any, ...]]] = []

    def get_property(self, prop: str) -> str:
        return getattr(self, prop)

    def connect(self, signal: str, callback: Callable[..., Any], *user_data: Any) -> int:
        self._handlers.append((signal, callback, user_data))
        return len(self._handlers)

    def emit(self, signal: str) -> None:
        for name, callback, user_data in list(self._handlers):
            if name == signal:
                callback(self, *user_data)

    def activate(self) -> None:
        self.emit("activate")


class FakeFileInfo:
    """Stands in for ``Nautilus.FileInfo``."""

    def __init__(self, uri: str, *, directory: bool = False) -> None:
        self._uri = uri
        self._directory = directory

    def get_uri(self) -> str:
        return self._uri

    def get_uri_scheme(self) -> str:
        return urllib.parse.urlsplit(self._uri).scheme

    def get_name(self) -> str:
        return urllib.parse.unquote(self._uri.rstrip("/").rsplit("/", 1)[-1])

    def is_directory(self) -> bool:
        return self._directory

    def get_location(self) -> FakeGFile:
        return FakeGFile.new_for_uri(self._uri)


def file_info(path: str, *, directory: bool = False) -> FakeFileInfo:
    """A ``FileInfo`` for a local ``path`` (URI built the way GIO does: percent-encoded)."""
    return FakeFileInfo("file://" + urllib.parse.quote(path, safe="/"), directory=directory)


# --------------------------------------------------------------------------- module assembly


class FakeGi(types.ModuleType):
    """Stands in for the ``gi`` package: records and validates ``require_version`` calls."""

    def __init__(self, nautilus_versions: tuple[str, ...]) -> None:
        super().__init__("gi")
        self.nautilus_versions = nautilus_versions
        self.required: list[tuple[str, str]] = []
        self.repository = types.ModuleType("gi.repository")

    def require_version(self, namespace: str, version: str) -> None:
        self.required.append((namespace, version))
        if namespace == "Nautilus" and version not in self.nautilus_versions:
            raise ValueError(f"Namespace {namespace} not available for version {version}")

    def add_namespace(self, name: str, **members: Any) -> types.ModuleType:
        module = types.ModuleType(f"gi.repository.{name}")
        module.__dict__.update(members)
        setattr(self.repository, name, module)
        return module


def build_fake_gi(*, nautilus_versions: tuple[str, ...] = ("4.0",)) -> dict[str, types.ModuleType]:
    """Build the ``sys.modules`` entries for a fake ``gi`` offering ``nautilus_versions``."""
    gi = FakeGi(nautilus_versions)
    return {
        "gi": gi,
        "gi.repository": gi.repository,
        "gi.repository.Nautilus": gi.add_namespace(
            "Nautilus", MenuProvider=FakeMenuProvider, MenuItem=FakeMenuItem, FileInfo=FakeFileInfo
        ),
        "gi.repository.GObject": gi.add_namespace("GObject", GObject=FakeGObject),
        "gi.repository.Gio": gi.add_namespace("Gio", File=FakeGFile),
        "gi.repository.GLib": gi.add_namespace("GLib", Error=FakeGLibError),
    }


def import_extension(monkeypatch: pytest.MonkeyPatch, **fake_options: Any) -> types.ModuleType:
    """Import a fresh copy of the extension against a fresh fake ``gi``."""
    for name, module in build_fake_gi(**fake_options).items():
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.delitem(sys.modules, MODULE_NAME, raising=False)
    return importlib.import_module(MODULE_NAME)


# --------------------------------------------------------------------------- fixtures


@pytest.fixture
def ext(monkeypatch: pytest.MonkeyPatch) -> Iterator[types.ModuleType]:
    """The extension module imported with the fake ``gi`` (Nautilus 4.0 available)."""
    FakeGFile.fuse_mounts = {}
    module = import_extension(monkeypatch)
    yield module
    sys.modules.pop(MODULE_NAME, None)


@pytest.fixture
def provider(ext: types.ModuleType) -> Any:
    """An instance of the extension's provider class."""
    return ext.AskClaudeProvider()


class SpawnRecorder:
    """Records ``subprocess.Popen`` calls instead of running anything."""

    def __init__(self) -> None:
        self.calls: list[tuple[list[str], dict[str, Any]]] = []
        self.waited: list[Any] = []
        self.error: Exception | None = None

    def __call__(self, argv: Any, **kwargs: Any) -> Any:
        if self.error is not None:
            raise self.error
        self.calls.append((list(argv), kwargs))
        recorder = self

        class Proc:
            def wait(self, timeout: float | None = None) -> int:
                recorder.waited.append(self)
                return 0

        return Proc()

    def attach_calls(self) -> list[tuple[list[str], dict[str, Any]]]:
        """Only the launcher invocations (not notify-send)."""
        return [call for call in self.calls if call[0][1:2] == ["attach"]]


@pytest.fixture
def spawn(monkeypatch: pytest.MonkeyPatch) -> SpawnRecorder:
    """Replace ``subprocess.Popen`` for the duration of a test."""
    recorder = SpawnRecorder()
    monkeypatch.setattr(subprocess, "Popen", recorder)
    return recorder


@pytest.fixture
def launcher(ext: types.ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> str:
    """Put an executable ``claudeos-panel`` on PATH (no notify-send) and return its path."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    exe = bindir / "claudeos-panel"
    exe.write_text("#!/bin/sh\nexit 0\n")
    exe.chmod(0o755)
    monkeypatch.setenv("PATH", str(bindir))
    monkeypatch.setattr(ext, "FALLBACK_LAUNCHER", str(tmp_path / "no-such-launcher"))
    return str(exe)
