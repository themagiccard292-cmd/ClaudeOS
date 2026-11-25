"""Activation: the exact process the extension starts, and how it fails."""

from __future__ import annotations

import logging
import subprocess
import threading
from pathlib import Path
from typing import Any

import pytest
from conftest import SpawnRecorder, file_info

HOSTILE = [
    "/tmp/x; rm -rf ~",
    "/tmp/$(touch pwned)",
    "/tmp/`id`",
    "/tmp/a && b | c > d",
    '/tmp/it\'s "quoted"',
    "/tmp/-rf",
    "/tmp/--help",
    "/tmp/new\nline",
    "/tmp/*.txt",
    "/tmp/~",
]


def activate(provider: Any, paths: list[str]) -> None:
    items = provider.get_file_items([file_info(p) for p in paths])
    items[0].activate()


def reaper_threads() -> list[threading.Thread]:
    return [t for t in threading.enumerate() if t.name == "claudeos-ask-claude-reaper"]


# --------------------------------------------------------------------------- argv / kwargs


def test_argv_is_launcher_attach_dashdash_paths(
    provider: Any, spawn: SpawnRecorder, launcher: str
) -> None:
    activate(provider, ["/home/u/a b.txt", "/home/u/dir"])
    ((argv, _kwargs),) = spawn.calls
    assert argv == [launcher, "attach", "--", "/home/u/a b.txt", "/home/u/dir"]


def test_launcher_is_resolved_to_the_path_lookup_result(
    provider: Any, spawn: SpawnRecorder, launcher: str
) -> None:
    activate(provider, ["/a"])
    assert spawn.calls[0][0][0] == launcher
    assert Path(launcher).name == "claudeos-panel"


def test_detached_with_no_stdio(provider: Any, spawn: SpawnRecorder, launcher: str) -> None:
    activate(provider, ["/a"])
    ((_argv, kwargs),) = spawn.calls
    assert kwargs["start_new_session"] is True
    assert kwargs["stdin"] == kwargs["stdout"] == kwargs["stderr"] == subprocess.DEVNULL
    assert set(kwargs) == {"stdin", "stdout", "stderr", "start_new_session"}


def test_no_shell_is_ever_used(provider: Any, spawn: SpawnRecorder, launcher: str) -> None:
    activate(provider, ["/a"])
    ((argv, kwargs),) = spawn.calls
    assert isinstance(argv, list)
    assert not kwargs.get("shell", False)
    assert "executable" not in kwargs


def test_hostile_paths_are_single_verbatim_argv_elements(
    provider: Any, spawn: SpawnRecorder, launcher: str
) -> None:
    activate(provider, HOSTILE)
    ((argv, kwargs),) = spawn.calls
    assert argv == [launcher, "attach", "--", *HOSTILE]
    assert not kwargs.get("shell", False)


def test_hostile_paths_run_nothing_for_real(
    provider: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """End to end with a real subprocess: a script that records its argv, one line per arg."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    record = tmp_path / "argv.bin"
    script = bindir / "claudeos-panel"
    script.write_text(f'#!/bin/sh\nfor a in "$@"; do printf \'%s\\0\' "$a" >> "{record}"; done\n')
    script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bindir}:/usr/bin:/bin")
    victim = tmp_path / "pwned"
    paths = [f"/tmp/x; touch {victim}", f"/tmp/$(touch {victim})", f"/tmp/`touch {victim}`"]

    activate(provider, paths)
    for thread in reaper_threads():
        thread.join(timeout=10)

    assert record.read_bytes().decode().split("\0")[:-1] == ["attach", "--", *paths]
    assert not victim.exists()


def test_selection_order_is_preserved(provider: Any, spawn: SpawnRecorder, launcher: str) -> None:
    paths = ["/z", "/a", "/m"]
    activate(provider, paths)
    assert spawn.calls[0][0][3:] == paths


def test_background_item_runs_attach_with_the_folder(
    provider: Any, spawn: SpawnRecorder, launcher: str
) -> None:
    (item,) = provider.get_background_items(file_info("/home/u/Some Dir", directory=True))
    item.activate()
    assert spawn.calls[0][0] == [launcher, "attach", "--", "/home/u/Some Dir"]


def test_building_the_menu_starts_nothing(
    provider: Any, spawn: SpawnRecorder, launcher: str
) -> None:
    provider.get_file_items([file_info("/a")])
    provider.get_background_items(file_info("/", directory=True))
    assert spawn.calls == []


def test_activating_twice_launches_twice(
    provider: Any, spawn: SpawnRecorder, launcher: str
) -> None:
    (item,) = provider.get_file_items([file_info("/a")])
    item.activate()
    item.activate()
    assert len(spawn.attach_calls()) == 2


def test_child_is_reaped_off_thread_without_blocking(
    ext: Any, monkeypatch: pytest.MonkeyPatch, launcher: str
) -> None:
    gate = threading.Event()
    reaped = threading.Event()

    class SlowProc:
        def wait(self) -> int:
            gate.wait(timeout=10)
            reaped.set()
            return 0

    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: SlowProc())
    assert ext.attach(["/a"]) is True  # returns while the child is still "running"
    assert not reaped.is_set()
    gate.set()
    assert reaped.wait(timeout=10)


# --------------------------------------------------------------------------- launcher lookup


def test_falls_back_to_usr_bin_when_not_on_path(
    ext: Any, spawn: SpawnRecorder, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fallback = tmp_path / "usr-bin-claudeos-panel"
    fallback.write_text("#!/bin/sh\n")
    fallback.chmod(0o755)
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    monkeypatch.setattr(ext, "FALLBACK_LAUNCHER", str(fallback))
    assert ext.attach(["/a"]) is True
    assert spawn.calls[0][0] == [str(fallback), "attach", "--", "/a"]


def test_default_fallback_is_usr_bin_claudeos_panel(ext: Any) -> None:
    assert ext.FALLBACK_LAUNCHER == "/usr/bin/claudeos-panel"
    assert ext.LAUNCHER == "claudeos-panel"


def test_non_executable_fallback_is_not_used(
    ext: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fallback = tmp_path / "claudeos-panel"
    fallback.write_text("not executable")
    fallback.chmod(0o644)
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    monkeypatch.setattr(ext, "FALLBACK_LAUNCHER", str(fallback))
    assert ext.find_launcher() is None


def test_missing_launcher_is_graceful(
    ext: Any,
    provider: Any,
    spawn: SpawnRecorder,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    monkeypatch.setattr(ext, "FALLBACK_LAUNCHER", str(tmp_path / "missing"))
    with caplog.at_level(logging.ERROR, logger="claudeos.nautilus"):
        activate(provider, ["/a"])  # must not raise
    assert spawn.calls == []
    assert "claudeos-panel not found" in caplog.text


def test_missing_launcher_notifies_when_notify_send_exists(
    ext: Any, spawn: SpawnRecorder, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    bindir = tmp_path / "bin"
    bindir.mkdir()
    notifier = bindir / "notify-send"
    notifier.write_text("#!/bin/sh\n")
    notifier.chmod(0o755)
    monkeypatch.setenv("PATH", str(bindir))
    monkeypatch.setattr(ext, "FALLBACK_LAUNCHER", str(tmp_path / "missing"))
    assert ext.attach(["/a"]) is False
    ((argv, kwargs),) = spawn.calls
    assert argv[0] == str(notifier)
    assert argv[-2:] == ["Ask Claude", "The Claude side panel is not installed."]
    assert kwargs["start_new_session"] is True


@pytest.mark.parametrize(
    "error", [FileNotFoundError("gone"), PermissionError("nope"), OSError("x")]
)
def test_popen_failure_is_graceful(
    provider: Any,
    spawn: SpawnRecorder,
    launcher: str,
    error: Exception,
    caplog: pytest.LogCaptureFixture,
) -> None:
    spawn.error = error
    with caplog.at_level(logging.ERROR, logger="claudeos.nautilus"):
        activate(provider, ["/a"])  # must not raise
    assert "cannot start" in caplog.text


def test_unexpected_error_during_activation_is_contained(
    ext: Any, provider: Any, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def explode(_paths: Any) -> bool:
        raise RuntimeError("unexpected")

    monkeypatch.setattr(ext, "attach", explode)
    with caplog.at_level(logging.ERROR, logger="claudeos.nautilus"):
        activate(provider, ["/a"])
    assert "activation failed" in caplog.text


def test_attach_with_no_paths_does_nothing(ext: Any, spawn: SpawnRecorder, launcher: str) -> None:
    assert ext.attach([]) is False
    assert spawn.calls == []


# --------------------------------------------------------------------------- the 64-path cap


def test_selection_over_the_cap_is_truncated_to_64_with_a_notification(
    provider: Any,
    spawn: SpawnRecorder,
    launcher: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    notifier = Path(launcher).with_name("notify-send")
    notifier.write_text("#!/bin/sh\n")
    notifier.chmod(0o755)
    paths = [f"/data/f{n:03}" for n in range(200)]
    with caplog.at_level(logging.WARNING, logger="claudeos.nautilus"):
        activate(provider, paths)
    ((attach_argv, _),) = spawn.attach_calls()
    assert attach_argv == [launcher, "attach", "--", *paths[:64]]
    assert len(attach_argv) == 3 + 64
    notices = [c for c in spawn.calls if c[0][0] == str(notifier)]
    assert len(notices) == 1
    assert notices[0][0][-1] == "Only the first 64 selected items were attached."
    assert "attaching the first 64" in caplog.text


def test_exactly_64_paths_are_not_truncated(
    provider: Any, spawn: SpawnRecorder, launcher: str, caplog: pytest.LogCaptureFixture
) -> None:
    paths = [f"/data/f{n:03}" for n in range(64)]
    with caplog.at_level(logging.WARNING, logger="claudeos.nautilus"):
        activate(provider, paths)
    ((argv, _),) = spawn.calls
    assert argv[3:] == paths
    assert caplog.text == ""


def test_truncation_without_notify_send_still_attaches(
    provider: Any, spawn: SpawnRecorder, launcher: str
) -> None:
    activate(provider, [f"/data/f{n}" for n in range(100)])
    ((argv, _),) = spawn.calls  # no notify-send on PATH, so only the launcher ran
    assert len(argv) == 3 + 64
