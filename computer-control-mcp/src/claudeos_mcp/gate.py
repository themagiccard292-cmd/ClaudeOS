"""The safety gate: classify, then allow / ask the human / refuse.

Used twice for defence in depth:
1. ``request_permission`` (Claude Code's permission prompt tool) gates every tool call Claude makes;
2. each risky claudeos-desktop tool (``run_command``, file tools, ``systemd``...) gates itself again
   right before acting, so a call that bypassed the prompt still cannot run a block-class action.

To avoid asking the human twice for the same thing, an approval granted through
``request_permission`` for one of our own tools is remembered for a short time and consumed
(single use) by that tool's own gate.
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from .approval import ApprovalClient
from .safety.classifier import MCP_PREFIX, classify
from .safety.rules import Verdict

APPROVAL_REUSE_S = 120.0
_SUMMARY_MAX = 300


@dataclass(frozen=True)
class GateResult:
    allowed: bool
    verdict: Verdict
    message: str


def _one_line(text: str) -> str:
    text = " ⏎ ".join(part.strip() for part in str(text).splitlines() if part.strip())
    return text if len(text) <= _SUMMARY_MAX else text[: _SUMMARY_MAX - 1] + "…"


def describe(tool_name: str, params: Mapping[str, Any]) -> str:
    """One-line human summary of a tool call, shown on the approval card."""
    short = tool_name.removeprefix(MCP_PREFIX)
    p = params
    if short in ("Bash", "run_command"):
        where = f" (in {p['cwd']})" if p.get("cwd") else ""
        return _one_line(f"Run shell command: {p.get('command', '')}{where}")
    if short in ("Write", "write_file"):
        return _one_line(f"Write file {p.get('file_path') or p.get('path', '')}")
    if short in ("Edit", "MultiEdit", "NotebookEdit"):
        return _one_line(f"Edit file {p.get('file_path') or p.get('notebook_path', '')}")
    if short in ("Read", "read_file"):
        return _one_line(f"Read file {p.get('file_path') or p.get('path', '')}")
    if short == "delete_path":
        how = "permanently" if p.get("permanent") else "to the trash"
        return _one_line(f"Delete {p.get('path', '')} ({how})")
    if short == "move_path":
        return _one_line(f"Move {p.get('source', '')} → {p.get('destination', '')}")
    if short == "dbus_call":
        return _one_line(f"D-Bus {p.get('bus', 'session')} bus: {p.get('method', '')} on {p.get('dest', '')}")
    if short == "systemd":
        scope = "" if p.get("scope", "user") != "user" else "--user "
        return _one_line(f"systemctl {scope}{p.get('action', '')} {p.get('unit', '')}")
    if short == "gsettings":
        return _one_line(f"gsettings {p.get('action', '')} {p.get('schema', '')} {p.get('key') or ''}")
    try:
        args = json.dumps(dict(p), ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        args = ""
    return _one_line(f"Use tool {tool_name} {args}")


class Gate:
    def __init__(
        self,
        approval: ApprovalClient,
        *,
        home: str,
        user: str,
        timeout_ms: int,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._approval = approval
        self._home = home
        self._user = user
        self._timeout_ms = timeout_ms
        self._clock = clock
        self._granted: dict[tuple[str, str], float] = {}
        self._lock = threading.Lock()

    def classify(self, tool_name: str, params: Mapping[str, Any], cwd: str | None = None) -> Verdict:
        return classify(tool_name, params, home=self._home, cwd=cwd, user=self._user)

    def check(self, tool_name: str, params: Mapping[str, Any], *, cwd: str | None = None,
              remember: bool = False) -> GateResult:
        """Decide whether ``tool_name(params)`` may run. Blocking; may wait for the human."""
        verdict = self.classify(tool_name, params, cwd)
        if verdict.level == "allow":
            return GateResult(True, verdict, "")
        if verdict.level == "block":
            return GateResult(
                False,
                verdict,
                f"Blocked by ClaudeOS safety rules [{verdict.rule_id}]: {verdict.reason} "
                "Claude will not do this, even with approval.",
            )
        summary = describe(tool_name, params)
        key = (tool_name.removeprefix(MCP_PREFIX), summary)
        if not remember and self._consume(key):
            return GateResult(True, verdict, "Approved by the user (via the permission prompt).")
        decision = self._approval.request(
            tool=tool_name,
            tool_input=dict(params),
            summary=summary,
            risk=verdict.risk,
            reason=f"{verdict.reason} [{verdict.rule_id}]",
            timeout_ms=self._timeout_ms,
        )
        if decision.allowed and remember and tool_name.startswith(MCP_PREFIX):
            with self._lock:
                self._granted[key] = self._clock() + APPROVAL_REUSE_S
        return GateResult(decision.allowed, verdict, decision.message)

    def _consume(self, key: tuple[str, str]) -> bool:
        with self._lock:
            expiry = self._granted.pop(key, None)
        return expiry is not None and expiry >= self._clock()
