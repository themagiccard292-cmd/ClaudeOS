from __future__ import annotations

import json
import os
import socket
import threading
from pathlib import Path

import pytest

from claudeos_mcp.config import Config
from claudeos_mcp.context import build_context
from claudeos_mcp.runner import RunResult
from claudeos_mcp.testing import FakeRunner, screenshot_writer


@pytest.fixture
def home(tmp_path: Path) -> Path:
    h = tmp_path / "home"
    h.mkdir()
    return h


class FakePanel:
    """A REAL unix-socket server speaking the C1 NDJSON approval protocol."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.mode = "allow"  # allow | deny | timeout | malformed | close | wrong-id
        self.requests: list[dict] = []
        self._srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._srv.bind(path)
        self._srv.listen(8)
        self._stop = False
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        while not self._stop:
            try:
                conn, _ = self._srv.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn: socket.socket) -> None:
        with conn:
            data = b""
            while b"\n" not in data:
                chunk = conn.recv(65536)
                if not chunk:
                    return
                data += chunk
            req = json.loads(data.split(b"\n", 1)[0])
            self.requests.append(req)
            mode = self.mode
            if mode == "timeout":
                threading.Event().wait(5)
                return
            if mode == "close":
                return
            if mode == "malformed":
                conn.sendall(b"this is not json\n")
                return
            rid = "other" if mode == "wrong-id" else req["id"]
            decision = "allow" if mode == "allow" else "deny"
            if mode == "wrong-id":
                conn.sendall(json.dumps({"id": rid, "ok": True, "decision": "allow"}).encode() + b"\n")
                threading.Event().wait(5)
                return
            conn.sendall(json.dumps({"id": rid, "ok": True, "decision": decision}).encode() + b"\n")

    def close(self) -> None:
        self._stop = True
        self._srv.close()


@pytest.fixture
def panel(tmp_path: Path):
    d = Path(os.environ.get("TMPDIR", "/tmp")) / f"cos-{os.getpid()}-{tmp_path.name[-8:]}"
    d.mkdir(mode=0o700, exist_ok=True)
    p = FakePanel(str(d / "panel.sock"))
    yield p
    p.close()
    try:
        os.unlink(p.path)
        d.rmdir()
    except OSError:
        pass


@pytest.fixture
def make_ctx(home: Path):
    def factory(runner: FakeRunner | None = None, *, socket_path: str | None = None, **env_extra: str):
        env = {"HOME": str(home), "XDG_SESSION_TYPE": "wayland", "USER": "tester",
               "XDG_RUNTIME_DIR": str(home / "run"),
               "CLAUDEOS_PANEL_SOCKET": socket_path or str(home / "no-such.sock"),
               "CLAUDEOS_APPROVAL_TIMEOUT_MS": "300", **env_extra}
        runner = runner or FakeRunner(programs={
            "gnome-screenshot": screenshot_writer(2560, 1440), "ydotool": RunResult(0),
            "gio": RunResult(0)})
        ctx = build_context(Config.from_env(env), runner)
        ctx.socket_exists = lambda _p: True
        return ctx

    return factory
