"""The single doorway to external programs.

Every backend receives a :class:`Runner` instead of calling :mod:`subprocess` itself, so
tests can inject :class:`claudeos_mcp.testing.FakeRunner` and nothing real is executed.

:class:`SubprocessRunner` guarantees, for every command:
- the child runs in its own session/process group and the WHOLE group is killed on timeout;
- stdout/stderr are drained concurrently into bounded buffers (no deadlock, no memory blow-up);
- the environment is scrubbed of API-key/provider variables (ARCHITECTURE §0).
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import threading
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol

# Variables that must never reach a child process (ARCHITECTURE §0, CLAUDE.md non-negotiable 1).
_STRIP_EXACT = frozenset(
    {
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDE_CODE_OAUTH_TOKEN",
    }
)
_STRIP_PREFIXES = ("ANTHROPIC_",)

DEFAULT_CAPTURE_BYTES = 2 * 1024 * 1024
_KILL_GRACE_S = 2.0


def child_env(base: Mapping[str, str] | None = None, extra: Mapping[str, str] | None = None) -> dict[str, str]:
    """Return a copy of ``base`` (default: os.environ) without secrets/provider switches."""
    env = {
        k: v
        for k, v in (os.environ if base is None else base).items()
        if k not in _STRIP_EXACT and not k.startswith(_STRIP_PREFIXES)
    }
    if extra:
        env.update(extra)
    return env


@dataclass(frozen=True)
class RunResult:
    returncode: int | None
    stdout: bytes = b""
    stderr: bytes = b""
    timed_out: bool = False
    truncated: bool = False

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out

    def text(self) -> str:
        return self.stdout.decode("utf-8", "replace")

    def err_text(self) -> str:
        return self.stderr.decode("utf-8", "replace").strip()

    def describe_failure(self) -> str:
        if self.timed_out:
            return "timed out"
        detail = self.err_text() or self.text().strip()
        return f"exit code {self.returncode}" + (f": {detail[:500]}" if detail else "")


class Runner(Protocol):
    def which(self, name: str) -> str | None: ...

    def run(
        self,
        argv: Sequence[str],
        *,
        timeout: float = 30.0,
        input: bytes | None = None,
        cwd: str | None = None,
        env: Mapping[str, str] | None = None,
        capture: bool = True,
        max_capture: int = DEFAULT_CAPTURE_BYTES,
    ) -> RunResult: ...

    def spawn_detached(self, argv: Sequence[str], *, cwd: str | None = None) -> int: ...


class _BoundedReader(threading.Thread):
    """Drain a pipe, keeping at most ``limit`` bytes, so the child never blocks on a full pipe."""

    def __init__(self, stream, limit: int) -> None:
        super().__init__(daemon=True)
        self._stream = stream
        self._limit = limit
        self.data = bytearray()
        self.truncated = False

    def run(self) -> None:
        try:
            while chunk := self._stream.read(65536):
                room = self._limit - len(self.data)
                if room > 0:
                    self.data += chunk[:room]
                if len(chunk) > max(room, 0):
                    self.truncated = True
        except (OSError, ValueError):
            pass
        finally:
            try:
                self._stream.close()
            except OSError:
                pass


def _kill_group(proc: subprocess.Popen) -> None:
    """SIGTERM the process group, then SIGKILL it if it lingers."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            return
        try:
            proc.wait(timeout=_KILL_GRACE_S)
            if sig == signal.SIGTERM:
                # Leader is gone; still SIGKILL stragglers left in the group.
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            return
        except subprocess.TimeoutExpired:
            continue


class SubprocessRunner:
    """Real implementation of :class:`Runner`."""

    def __init__(self, base_env: Mapping[str, str] | None = None) -> None:
        self._base_env = base_env

    def which(self, name: str) -> str | None:
        path = child_env(self._base_env).get("PATH")
        return shutil.which(name, path=path)

    def run(
        self,
        argv: Sequence[str],
        *,
        timeout: float = 30.0,
        input: bytes | None = None,
        cwd: str | None = None,
        env: Mapping[str, str] | None = None,
        capture: bool = True,
        max_capture: int = DEFAULT_CAPTURE_BYTES,
    ) -> RunResult:
        sink = subprocess.PIPE if capture else subprocess.DEVNULL
        try:
            proc = subprocess.Popen(
                list(argv),
                stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                stdout=sink,
                stderr=sink,
                cwd=cwd,
                env=child_env(self._base_env, env),
                start_new_session=True,
            )
        except FileNotFoundError:
            return RunResult(127, stderr=f"command not found: {argv[0]}".encode())
        except OSError as exc:
            return RunResult(126, stderr=f"cannot execute {argv[0]}: {exc}".encode())

        readers: list[_BoundedReader] = []
        if capture:
            readers = [_BoundedReader(proc.stdout, max_capture), _BoundedReader(proc.stderr, max_capture)]
            for reader in readers:
                reader.start()
        if input is not None:
            threading.Thread(target=self._feed, args=(proc, input), daemon=True).start()

        timed_out = False
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            _kill_group(proc)
        for reader in readers:
            # A daemonised grandchild in another session may keep the pipe open: do not hang on it.
            reader.join(timeout=3.0)
        out, err = (bytes(r.data) for r in readers) if readers else (b"", b"")
        return RunResult(
            None if timed_out else proc.returncode,
            out,
            err,
            timed_out=timed_out,
            truncated=any(r.truncated for r in readers),
        )

    @staticmethod
    def _feed(proc: subprocess.Popen, data: bytes) -> None:
        try:
            proc.stdin.write(data)
        except (BrokenPipeError, OSError):
            pass
        finally:
            try:
                proc.stdin.close()
            except OSError:
                pass

    def spawn_detached(self, argv: Sequence[str], *, cwd: str | None = None) -> int:
        """Start a GUI app that must outlive this server (new session, stdio to /dev/null)."""
        proc = subprocess.Popen(
            list(argv),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd=cwd,
            env=child_env(self._base_env),
            start_new_session=True,
            close_fds=True,
        )
        return proc.pid
