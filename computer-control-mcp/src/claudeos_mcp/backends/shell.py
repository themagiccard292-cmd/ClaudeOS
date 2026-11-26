"""Execution half of ``run_command`` (the gate runs before this is ever called)."""

from __future__ import annotations

import os
import re
import shlex

from ..config import OUTPUT_LIMIT_CHARS
from ..runner import Runner

MAX_TIMEOUT_S = 600
# Anything here means the string needs a real shell (pipes, globs, variables, redirects...).
_SHELL_SYNTAX = re.compile(r"[|&;<>()$`*?\[\]{}~!#\n]")


class CommandError(RuntimeError):
    pass


def needs_shell(command: str) -> bool:
    return bool(_SHELL_SYNTAX.search(command))


def build_argv(command: str) -> list[str]:
    """Plain commands are exec'd directly; only real shell syntax goes through ``bash -c``
    (with exactly the string the classifier saw)."""
    if needs_shell(command):
        return ["bash", "-c", command]
    try:
        argv = shlex.split(command)
    except ValueError:
        return ["bash", "-c", command]
    if not argv:
        raise CommandError("Empty command.")
    return argv


def validate_cwd(cwd: str | None, home: str) -> str:
    if not cwd:
        return home
    path = home + cwd[1:] if cwd == "~" or cwd.startswith("~/") else cwd
    if not os.path.isabs(path):
        path = os.path.join(home, path)
    path = os.path.normpath(path)
    if not os.path.isdir(path):
        raise CommandError(f"Working directory {path} does not exist or is not a directory.")
    return path


def truncate(text: str, limit: int = OUTPUT_LIMIT_CHARS) -> str:
    if len(text) <= limit:
        return text
    head = limit * 3 // 4
    tail = limit - head
    return f"{text[:head]}\n… [{len(text) - limit} characters omitted] …\n{text[-tail:]}"


def run_command(runner: Runner, command: str, *, cwd: str, timeout_s: float) -> str:
    timeout_s = max(1.0, min(float(timeout_s), MAX_TIMEOUT_S))
    result = runner.run(build_argv(command), timeout=timeout_s, cwd=cwd)
    out = result.stdout.decode("utf-8", "replace")
    err = result.stderr.decode("utf-8", "replace")
    if result.timed_out:
        status = f"TIMED OUT after {timeout_s:g}s; the whole process group was killed. Partial output below."
    else:
        status = f"exit code {result.returncode}"
    parts = [status]
    if out:
        parts.append("--- stdout ---\n" + out.rstrip("\n"))
    if err:
        parts.append("--- stderr ---\n" + err.rstrip("\n"))
    if not out and not err:
        parts.append("(no output)")
    if result.truncated:
        parts.append("(output exceeded the capture buffer and was cut)")
    return truncate("\n".join(parts))
