"""Client side of the panel's ``approval-request`` (C1).

Sends one NDJSON request over the panel's unix socket and waits for the human's answer.
It FAILS CLOSED: only a reply carrying our ``id`` and exactly ``"decision": "allow"`` allows;
a missing socket, a socket owned by another user, a timeout, a malformed or truncated reply,
``ok:false`` or ``deny`` all deny.
"""

from __future__ import annotations

import json
import os
import socket
import stat
import time
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

MAX_REPLY_BYTES = 1024 * 1024
_PREVIEW_STR = 2000  # long strings (file contents...) are cut in the approval card
_PREVIEW_JSON = 20_000
CLIENT_GRACE_S = 5.0  # extra time beyond timeoutMs for the panel's own timeout reply


@dataclass(frozen=True)
class ApprovalResult:
    allowed: bool
    message: str


def preview_input(value: Any) -> Any:
    """A display copy of a tool input with long strings truncated (the card is for humans)."""
    if isinstance(value, str):
        if len(value) > _PREVIEW_STR:
            return value[:_PREVIEW_STR] + f"… [{len(value) - _PREVIEW_STR} more characters]"
        return value
    if isinstance(value, dict):
        return {str(k): preview_input(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [preview_input(v) for v in value[:200]]
    if value is None or isinstance(value, bool | int | float):
        return value
    return str(value)


def _owned_by_us(path: str) -> bool:
    """The socket and its directory must belong to us: a socket planted by another user in a
    world-writable fallback location (/tmp) must never be able to approve anything."""
    try:
        st = os.stat(path)
        parent = os.stat(os.path.dirname(path) or ".")
    except OSError:
        return False
    uid = os.getuid()
    return stat.S_ISSOCK(st.st_mode) and st.st_uid == uid and parent.st_uid == uid


class ApprovalClient:
    def __init__(self, socket_candidates: Sequence[str], *, connect_timeout: float = 3.0) -> None:
        self._candidates = list(socket_candidates)
        self._connect_timeout = connect_timeout

    def socket_path(self) -> str | None:
        for path in self._candidates:
            if os.path.exists(path):
                return path
        return None

    def request(
        self,
        *,
        tool: str,
        tool_input: Any,
        summary: str,
        risk: str,
        reason: str,
        timeout_ms: int,
    ) -> ApprovalResult:
        path = self.socket_path()
        if path is None:
            return ApprovalResult(
                False,
                "Denied: the ClaudeOS panel is not running, so nobody can approve this action "
                f"(no socket at {' or '.join(self._candidates)}).",
            )
        if not _owned_by_us(path):
            return ApprovalResult(False, f"Denied: approval socket {path} is not owned by this user.")
        request_id = uuid.uuid4().hex
        payload = {
            "id": request_id,
            "cmd": "approval-request",
            "tool": tool,
            "input": preview_input(tool_input),
            "summary": summary,
            "risk": risk,
            "reason": reason,
            "timeoutMs": int(timeout_ms),
        }
        line = json.dumps(payload, ensure_ascii=False)
        if len(line) > _PREVIEW_JSON:
            payload["input"] = {"preview": line[:_PREVIEW_STR] + "…"}
            line = json.dumps(payload, ensure_ascii=False)
        deadline = time.monotonic() + timeout_ms / 1000 + CLIENT_GRACE_S
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                sock.settimeout(self._connect_timeout)
                sock.connect(path)
                sock.sendall(line.encode() + b"\n")
                return self._await_reply(sock, request_id, deadline)
        except TimeoutError:
            return ApprovalResult(False, "Denied: no answer from the user before the approval timed out.")
        except OSError as exc:
            return ApprovalResult(False, f"Denied: could not reach the ClaudeOS panel ({exc.strerror or exc}).")

    @staticmethod
    def _await_reply(sock: socket.socket, request_id: str, deadline: float) -> ApprovalResult:
        buffer = b""
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            sock.settimeout(remaining)
            chunk = sock.recv(65536)
            if not chunk:
                return ApprovalResult(False, "Denied: the panel closed the connection without an answer.")
            buffer += chunk
            if len(buffer) > MAX_REPLY_BYTES:
                return ApprovalResult(False, "Denied: oversized reply from the panel.")
            while b"\n" in buffer:
                raw, buffer = buffer.split(b"\n", 1)
                if not raw.strip():
                    continue
                try:
                    reply = json.loads(raw)
                except ValueError:
                    return ApprovalResult(False, "Denied: malformed reply from the panel.")
                if not isinstance(reply, dict):
                    return ApprovalResult(False, "Denied: malformed reply from the panel.")
                if reply.get("id") != request_id:
                    continue  # not ours (e.g. an unsolicited event); keep waiting
                message = reply.get("message")
                message = message if isinstance(message, str) else ""
                if reply.get("ok") is not False and reply.get("decision") == "allow":
                    return ApprovalResult(True, message or "Approved by the user.")
                return ApprovalResult(False, f"Denied by the user{': ' + message if message else '.'}")
