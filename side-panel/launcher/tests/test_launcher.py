"""Tests for the claudeos-panel launcher using a fake socket server and a fake app script."""

from __future__ import annotations

import json
import os
import socket
import stat
import subprocess
import sys
import threading
from pathlib import Path

import pytest

LAUNCHER = Path(__file__).resolve().parent.parent / "claudeos-panel"


class FakePanel:
    def __init__(self, path: Path, reply: dict | None = None) -> None:
        self.path = path
        self.reply = reply or {"ok": True}
        self.requests: list[dict] = []
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(str(path))
        self.server.listen(5)
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            with conn:
                data = b""
                while b"\n" not in data:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    data += chunk
                if not data:
                    continue  # connectivity probe
                req = json.loads(data.split(b"\n")[0])
                self.requests.append(req)
                conn.sendall(json.dumps({"id": req.get("id"), **self.reply}).encode() + b"\n")

    def close(self) -> None:
        self.server.close()


@pytest.fixture
def sock_path(tmp_path: Path) -> Path:
    return tmp_path / "p.sock"


def run(args: list[str], sock_path: Path, app: str = "/nonexistent", cwd: Path | None = None):
    env = {**os.environ, "CLAUDEOS_PANEL_SOCKET": str(sock_path), "CLAUDEOS_PANEL_APP": app}
    return subprocess.run(
        [sys.executable, str(LAUNCHER), *args], env=env, cwd=cwd, capture_output=True, text=True, timeout=30, check=False
    )


def test_executable() -> None:
    assert LAUNCHER.stat().st_mode & stat.S_IXUSR


def test_default_is_show(sock_path: Path) -> None:
    panel = FakePanel(sock_path, {"ok": True, "visible": True})
    try:
        assert run([], sock_path).returncode == 0
        assert panel.requests[0]["cmd"] == "show"
    finally:
        panel.close()


@pytest.mark.parametrize("cmd", ["toggle", "show", "hide", "new-chat", "onboarding", "quit"])
def test_simple_commands(cmd: str, sock_path: Path) -> None:
    panel = FakePanel(sock_path)
    try:
        assert run([cmd], sock_path).returncode == 0
        assert panel.requests[0]["cmd"] == cmd
    finally:
        panel.close()


def test_status_prints_json(sock_path: Path) -> None:
    panel = FakePanel(sock_path, {"ok": True, "visible": False, "width": 440, "signedIn": None, "version": "1"})
    try:
        res = run(["status"], sock_path)
        assert res.returncode == 0
        assert json.loads(res.stdout)["width"] == 440
    finally:
        panel.close()


def test_attach_resolves_relative_paths_and_separator(sock_path: Path, tmp_path: Path) -> None:
    panel = FakePanel(sock_path)
    try:
        res = run(["attach", "--", "rel.txt", "-dash.txt", "/abs/x"], sock_path, cwd=tmp_path)
        assert res.returncode == 0
        assert panel.requests[0]["paths"] == [str(tmp_path / "rel.txt"), str(tmp_path / "-dash.txt"), "/abs/x"]
    finally:
        panel.close()


def test_attach_with_zero_paths_just_shows(sock_path: Path) -> None:
    panel = FakePanel(sock_path)
    try:
        assert run(["attach", "--"], sock_path).returncode == 0
        assert panel.requests[0] == {**panel.requests[0], "cmd": "attach", "paths": []}
    finally:
        panel.close()


def test_ask(sock_path: Path, tmp_path: Path) -> None:
    panel = FakePanel(sock_path)
    try:
        assert run(["ask", "what", "is this", "--send", "--path", "f.txt"], sock_path, cwd=tmp_path).returncode == 0
        req = panel.requests[0]
        assert req["text"] == "what is this" and req["send"] is True and req["paths"] == [str(tmp_path / "f.txt")]
    finally:
        panel.close()


def test_no_spawn_fails_when_absent(sock_path: Path) -> None:
    res = run(["show", "--no-spawn"], sock_path)
    assert res.returncode == 1
    assert res.stderr.strip().count("\n") == 0 and "not running" in res.stderr


def test_unknown_command_and_empty_ask(sock_path: Path) -> None:
    assert run(["frobnicate"], sock_path).returncode == 1
    assert run(["ask"], sock_path).returncode == 1


def test_refused_request_exits_1(sock_path: Path) -> None:
    panel = FakePanel(sock_path, {"ok": False, "error": "unknown-command"})
    try:
        res = run(["show"], sock_path)
        assert res.returncode == 1 and "unknown-command" in res.stderr
    finally:
        panel.close()


FAKE_APP = """#!/usr/bin/env python3
import os, socket, sys, time
open(os.environ["FAKE_APP_LOG"], "w").write(" ".join(sys.argv[1:]))
path = os.environ["CLAUDEOS_PANEL_SOCKET"]
s = socket.socket(socket.AF_UNIX); s.bind(path); s.listen(5)
s.settimeout(5)
try:
    while True:
        c, _ = s.accept()
        d = c.recv(4096)
        if d:
            import json
            c.sendall(json.dumps({"id": json.loads(d)["id"], "ok": True}).encode() + b"\\n")
        c.close()
except Exception:
    pass
"""


def test_spawns_app_then_sends(sock_path: Path, tmp_path: Path) -> None:
    app = tmp_path / "app"
    app.write_text(FAKE_APP)
    app.chmod(0o755)
    log = tmp_path / "app.log"
    os.environ["FAKE_APP_LOG"] = str(log)
    try:
        res = run(["show"], sock_path, app=str(app))
    finally:
        del os.environ["FAKE_APP_LOG"]
    assert res.returncode == 0, res.stderr
    assert "--ozone-platform=x11" in log.read_text()


def test_background_spawns_hidden_and_does_not_send(sock_path: Path, tmp_path: Path) -> None:
    app = tmp_path / "app"
    app.write_text(FAKE_APP)
    app.chmod(0o755)
    log = tmp_path / "app.log"
    os.environ["FAKE_APP_LOG"] = str(log)
    try:
        assert run(["--background"], sock_path, app=str(app)).returncode == 0
        for _ in range(50):
            if log.exists() and log.read_text():
                break
            threading.Event().wait(0.1)
    finally:
        del os.environ["FAKE_APP_LOG"]
    assert "--background" in log.read_text()


def test_background_noop_when_running(sock_path: Path) -> None:
    panel = FakePanel(sock_path)
    try:
        assert run(["--background"], sock_path).returncode == 0
        assert panel.requests == []
    finally:
        panel.close()


def test_missing_app_is_a_clean_error(sock_path: Path) -> None:
    res = run(["show"], sock_path, app="/nonexistent/app")
    assert res.returncode == 1 and "cannot start" in res.stderr
