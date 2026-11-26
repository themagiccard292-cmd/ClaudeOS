"""``classify(tool_name, input) -> Verdict`` — the single safety entry point (C4).

Shared by ``run_command``, the file tools, the system tools and ``request_permission``
(Claude Code's ``--permission-prompt-tool``). Shell strings are parsed by
:mod:`.shellparse`; wrappers (``sudo``, ``env``, ``nice``, ``nohup``, ``timeout``, ``xargs``,
``bash -c``, ``eval``, ``find -exec``...) are peeled off recursively; every resulting command
and every path it touches is matched against :data:`.rules.RULES`; the worst verdict wins.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from fnmatch import fnmatch
from typing import Any

from .rules import (
    ALLOW,
    PERMANENT_DELETE,
    SYSTEM_ROOTS,
    TOO_DEEP,
    UNKNOWN_TOOL,
    UNPARSEABLE,
    Command,
    Ctx,
    PathTarget,
    Verdict,
    rm_parts,
    rules_for,
    worst,
)
from .shellparse import DYNAMIC, ParseError, Segment, Word, parse

MCP_PREFIX = "mcp__claudeos-desktop__"
MAX_DEPTH = 8

# ------------------------------------------------------------------------------------------
# Wrapper peeling
# ------------------------------------------------------------------------------------------

_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?\+?=")
_KEYWORDS = frozenset({"!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "time"})
# Wrapper → options that consume the following argument.
_WRAPPER_ARG_OPTS: dict[str, frozenset[str]] = {
    "nice": frozenset({"-n", "--adjustment"}),
    "ionice": frozenset({"-c", "-n", "--class", "--classdata"}),
    "nohup": frozenset(),
    "setsid": frozenset(),
    "stdbuf": frozenset({"-i", "-o", "-e", "--input", "--output", "--error"}),
    "timeout": frozenset({"-s", "-k", "--signal", "--kill-after"}),
    "exec": frozenset({"-a"}),
    "builtin": frozenset(),
    "command": frozenset(),
    "chrt": frozenset(),
    "taskset": frozenset(),
    "xargs": frozenset(
        {"-a", "-d", "-E", "-e", "-I", "-i", "-L", "-l", "-n", "-P", "-s", "--arg-file", "--delimiter",
         "--max-args", "--max-procs", "--max-lines", "--max-chars", "--replace", "--eof"}
    ),
    "env": frozenset({"-u", "-C", "--unset", "--chdir", "-S", "--split-string"}),
    "sudo": frozenset({"-u", "-g", "-h", "-p", "-C", "-D", "-R", "-r", "-t", "-T", "-U", "--user", "--group",
                       "--host", "--prompt", "--close-from", "--chdir", "--chroot", "--role", "--type",
                       "--command-timeout", "--other-user"}),
    "doas": frozenset({"-u", "-C"}),
    "pkexec": frozenset({"--user"}),
    "run0": frozenset({"-u", "--user", "-g", "--group", "-D", "--chdir", "--setenv", "--unit",
                       "--property", "--description", "--slice", "--nice", "--machine"}),
    "busybox": frozenset(),
}
_ELEVATING = frozenset({"sudo", "doas", "pkexec", "run0"})
# Wrappers whose first positional is a parameter, not the command (timeout DURATION cmd, ...).
_LEADING_POSITIONALS = {"timeout": 1, "chrt": 1, "taskset": 1}
_FIND_EXPR_START = re.compile(r"^(-|\(|\)|!|,)")


@dataclass
class Nested:
    """A string that a wrapper hands to another shell (bash -c, su -c, eval, watch...)."""

    source: str
    elevated: bool


@dataclass
class _Unwrapped:
    commands: list[Command] = field(default_factory=list)
    nested: list[Nested] = field(default_factory=list)


def _skip_options(words: list[Word], arg_opts: frozenset[str]) -> int:
    """Index of the first non-option word, honouring options that take a value."""
    i = 0
    while i < len(words):
        value = words[i].value
        if value == "--":
            return i + 1
        if not value.startswith("-") or value == "-":
            return i
        if value in arg_opts:
            i += 2
            continue
        # -n10 / --user=root carry their value inline.
        i += 1
    return i


def _shell_c_source(words: list[Word]) -> tuple[str | None, bool]:
    """For ``bash [opts] -c STRING``: (STRING, True). For a plain ``bash`` call: (None, False)."""
    i = 0
    while i < len(words):
        value = words[i].value
        if value == "--" or not value.startswith(("-", "+")):
            return None, False
        if value in ("-o", "+o", "-O", "+O", "--rcfile", "--init-file"):
            i += 2
            continue
        if not value.startswith("--") and "c" in value[1:]:
            # The string is the first following non-option word.
            for w in words[i + 1 :]:
                if not w.value.startswith("-"):
                    return w.value, True
            return "", True
        i += 1
    return None, False


def _find_exec_commands(words: list[Word]) -> tuple[list[list[Word]], list[Word], bool]:
    """Split a ``find`` call into (-exec command word lists, start paths, has -delete)."""
    starts: list[Word] = []
    i = 0
    while i < len(words) and not _FIND_EXPR_START.match(words[i].value):
        starts.append(words[i])
        i += 1
    if not starts:
        starts = [Word(".")]
    execs: list[list[Word]] = []
    delete = False
    while i < len(words):
        value = words[i].value
        if value == "-delete":
            delete = True
        if value in ("-exec", "-execdir", "-ok", "-okdir"):
            j = i + 1
            cmd: list[Word] = []
            while j < len(words) and words[j].value not in (";", "+"):
                if words[j].value == "{}":
                    cmd.extend(Word(s.value, s.quoted, s.glob) for s in starts)
                else:
                    cmd.append(words[j])
                j += 1
            execs.append(cmd)
            i = j
        i += 1
    return execs, starts, delete


def _unwrap(words: list[Word], *, elevated: bool, unknown_args: bool, out: _Unwrapped, depth: int) -> Command | None:
    """Peel wrappers off ``words``; append the final command(s) to ``out``."""
    if depth > MAX_DEPTH:
        raise RecursionError
    while words:
        value = words[0].value
        if _ASSIGNMENT.match(value) or value in _KEYWORDS:
            words = words[1:]
            continue
        name = os.path.basename(value) if "/" in value and not value.endswith("/") else value
        if name in _WRAPPER_ARG_OPTS:
            if name == "command" and len(words) > 1 and words[1].value in ("-v", "-V"):
                break  # `command -v foo` only looks foo up
            if name == "env":
                # env -S "cmd args" splits its string like a shell.
                for k, w in enumerate(words[1:-1], start=1):
                    if w.value in ("-S", "--split-string") or w.value.startswith("--split-string="):
                        split = w.value.split("=", 1)[1] if "=" in w.value else words[k + 1].value
                        out.nested.append(Nested(split, elevated))
                        return None
            if name in ("sudo",) and any(w.value in ("-e", "--edit") for w in words[1:]):
                words = [Word("sudoedit")] + [w for w in words[1:] if w.value not in ("-e", "--edit")]
                elevated = True
                continue
            rest = words[1:]
            start = _skip_options(rest, _WRAPPER_ARG_OPTS[name])
            start += _LEADING_POSITIONALS.get(name, 0)
            if name in _ELEVATING:
                elevated = True
                if start >= len(rest):  # bare `sudo -i` / `sudo -s`: an interactive root shell
                    return _emit(out, Command(name, list(rest), elevated=True))
            if name == "xargs":
                unknown_args = True
                if start >= len(rest):  # bare xargs runs echo
                    return None
            words = rest[start:]
            continue
        if name == "su":
            elevated = True
            source = None
            for k, w in enumerate(words[1:], start=1):
                if w.value in ("-c", "--command") and k + 1 < len(words):
                    source = words[k + 1].value
                elif w.value.startswith("--command="):
                    source = w.value.split("=", 1)[1]
            if source is not None:
                out.nested.append(Nested(source, True))
            return _emit(out, Command("su", words[1:], elevated=True))
        if name in ("eval",):
            out.nested.append(Nested(" ".join(w.value for w in words[1:]), elevated))
            return _emit(out, Command("eval", words[1:], elevated=elevated))
        if name == "watch":
            start = _skip_options(words[1:], frozenset({"-n", "--interval", "-d", "--differences"}))
            out.nested.append(Nested(" ".join(w.value for w in words[1 + start :]), elevated))
            return None
        if name in ("sh", "bash", "dash", "zsh", "ksh", "mksh", "ash", "fish"):
            source, has_c = _shell_c_source(words[1:])
            if has_c and source is not None:
                out.nested.append(Nested(source, elevated))
        if name == "find":
            execs, _starts, _delete = _find_exec_commands(words[1:])
            for exec_words in execs:
                _unwrap(exec_words, elevated=elevated, unknown_args=False, out=out, depth=depth + 1)
        dynamic_name = DYNAMIC in value or (words[0].glob and not words[0].quoted)
        return _emit(
            out,
            Command(
                "" if dynamic_name else name,
                list(words[1:]),
                elevated=elevated,
                dynamic_name=dynamic_name,
                unknown_args=unknown_args,
            ),
        )
    return None


def _emit(out: _Unwrapped, cmd: Command) -> Command:
    out.commands.append(cmd)
    return cmd


# ------------------------------------------------------------------------------------------
# Path targets of a command
# ------------------------------------------------------------------------------------------

_WRITE_REDIRECTS = frozenset({">", ">>", ">|", "&>", "&>>", "<>"})


def _positional(words: list[Word]) -> list[Word]:
    out: list[Word] = []
    end = False
    for w in words:
        if end or not w.value.startswith("-") or w.value == "-":
            out.append(w)
        elif w.value == "--":
            end = True
    return out


def _looks_like_path(value: str) -> bool:
    return value.startswith(("/", "./", "../", "~")) or "/" in value or value in (".", "..")


def command_targets(cmd: Command) -> list[tuple[str, Word]]:
    """Every (op, path word) the command reads, writes or deletes (best effort)."""
    targets: list[tuple[str, Word]] = []
    name, args = cmd.name, cmd.args
    pos = _positional(args)
    if name in ("rm", "unlink", "rmdir", "shred", "srm", "wipe", "trash"):
        targets += [("delete", w) for w in (rm_parts(cmd)[1] if name == "rm" else pos)]
    elif name == "gio" and pos and pos[0].value in ("trash", "remove"):
        targets += [("delete", w) for w in pos[1:]]
    elif name == "mv":
        tdir = _option_value(args, ("-t", "--target-directory"))
        if tdir is not None:
            targets += [("delete", w) for w in pos] + [("write", tdir)]
        elif len(pos) >= 2:
            targets += [("delete", w) for w in pos[:-1]] + [("write", pos[-1])]
    elif name in ("cp", "install", "ln", "rsync", "scp", "sudoedit"):
        tdir = _option_value(args, ("-t", "--target-directory"))
        if name == "sudoedit":
            targets += [("write", w) for w in pos]
        elif tdir is not None:
            targets.append(("write", tdir))
        elif len(pos) >= 2 or (name == "install" and pos):
            targets.append(("write", pos[-1]))
    elif name in ("tee", "touch", "mkdir", "truncate", "mknod", "mkfifo"):
        values = pos if name != "truncate" else [w for w in pos if not w.value.isdigit()]
        targets += [("write", w) for w in values]
    elif name in ("chmod", "chown", "chgrp", "setfacl"):
        refs = any(w.value.startswith("--reference") for w in args)
        targets += [("write", w) for w in (pos if refs else pos[1:])]
    elif name == "sed" and any(w.value.startswith(("-i", "--in-place")) for w in args):
        has_script_opt = any(w.value in ("-e", "-f", "--expression", "--file") for w in args)
        targets += [("write", w) for w in (pos if has_script_opt else pos[1:])]
    elif name == "dd":
        for w in args:
            if w.value.startswith("of="):
                targets.append(("write", Word(w.value[3:], w.quoted, w.glob)))
    elif name == "find":
        _execs, starts, delete = _find_exec_commands(args)
        if delete:
            targets += [("delete", w) for w in starts]
    for op, word in cmd.redirects:
        if op in _WRITE_REDIRECTS:
            targets.append(("write", word))
        elif op in ("<", "<&") and not word.value.isdigit():
            targets.append(("read", word))
    # Anything path-shaped is at least read: catches `cat ~/.claude/.credentials.json`.
    for w in args:
        value = w.value.split("=", 1)[1] if w.value.startswith("-") and "=" in w.value else w.value
        if _looks_like_path(value) and not value.startswith("-"):
            targets.append(("read", Word(value, w.quoted, w.glob)))
    return targets


def _option_value(words: list[Word], names: tuple[str, ...]) -> Word | None:
    for k, w in enumerate(words):
        if w.value in names and k + 1 < len(words):
            return words[k + 1]
        for n in names:
            if n.startswith("--") and w.value.startswith(n + "="):
                return Word(w.value.split("=", 1)[1])
    return None


# ------------------------------------------------------------------------------------------
# Path classification
# ------------------------------------------------------------------------------------------


def _resolved_forms(path: str, op: str) -> tuple[str, ...]:
    """Lexical path plus its symlink-resolved form (for deletes, only the parent is resolved:
    ``rm link`` removes the link, not its target)."""
    lexical = os.path.normpath(path)
    if op == "delete" and not path.endswith("/"):
        resolved = os.path.join(os.path.realpath(os.path.dirname(lexical)), os.path.basename(lexical))
    else:
        resolved = os.path.realpath(lexical)
    resolved = os.path.normpath(resolved)
    return (lexical,) if resolved == lexical else (lexical, resolved)


def classify_path(op: str, path: str, *, home: str, cwd: str | None = None, via_shell: bool = False) -> Verdict:
    """Classify one read/write/delete of ``path`` (expands ~ / $HOME, resolves symlinks, globs)."""
    home = os.path.normpath(home)
    path = _expand_home(path, home)
    if not os.path.isabs(path):
        path = os.path.join(cwd or home, path)
    trailing = path.endswith("/")
    norm = os.path.normpath(path) + ("/" if trailing and path != "/" else "")
    candidates = [norm]
    base = os.path.basename(norm.rstrip("/"))
    if op == "delete" and any(ch in base for ch in "*?["):
        parent = os.path.dirname(norm.rstrip("/")) or "/"
        if any(fnmatch(root, norm.rstrip("/")) for root in SYSTEM_ROOTS | {home}):
            candidates.append(next(r for r in sorted(SYSTEM_ROOTS | {home}) if fnmatch(r, norm.rstrip("/"))))
        if base.strip("*?.[]!") == "":
            # `rm -rf dir/*` empties dir: as destructive as deleting dir itself.
            candidates.append(parent)
    verdicts: list[Verdict] = []
    for candidate in candidates:
        target = PathTarget(op, _resolved_forms(candidate, op), home, via_shell)
        verdicts += [r.verdict() for r in rules_for("path") if r.matches(target)]
    return worst(verdicts)


def _expand_home(path: str, home: str) -> str:
    if path == "~" or path.startswith("~/"):
        return home + path[1:]
    for var in ("$HOME", "${HOME}"):
        if path == var or path.startswith(var + "/"):
            return home + path[len(var) :]
    return path


# ------------------------------------------------------------------------------------------
# Shell classification
# ------------------------------------------------------------------------------------------


def _shell_env(ctx: Ctx) -> dict[str, str]:
    env = {"HOME": ctx.home, "PWD": ctx.cwd}
    if ctx.user:
        env["USER"] = env["LOGNAME"] = ctx.user
    return env


def classify_shell(command: str, *, home: str, cwd: str | None = None, user: str = "") -> Verdict:
    """Classify a shell command string (the worst segment wins)."""
    ctx = Ctx(home=os.path.normpath(home), cwd=os.path.normpath(cwd or home), user=user)
    try:
        return _classify_shell(command, ctx, elevated=False, depth=0)
    except RecursionError:
        return TOO_DEEP


def _classify_shell(command: str, ctx: Ctx, *, elevated: bool, depth: int) -> Verdict:
    if depth > MAX_DEPTH:
        raise RecursionError
    verdicts = [r.verdict() for r in rules_for("raw") if r.matches(command)]
    try:
        parsed = parse(command, _shell_env(ctx))
    except ParseError:
        return worst(verdicts + [UNPARSEABLE])
    for sub in parsed.substitutions:
        verdicts.append(_classify_shell(sub, ctx, elevated=elevated, depth=depth + 1))
    pipeline: list[str] = []
    for segment in parsed.segments:
        if not segment.piped:
            pipeline = []
        out = _Unwrapped()
        _unwrap(segment.words, elevated=elevated, unknown_args=False, out=out, depth=depth)
        for nested in out.nested:
            verdicts.append(_classify_shell(nested.source, ctx, elevated=nested.elevated, depth=depth + 1))
        commands = out.commands or [Command("", [], elevated=elevated)]
        for cmd in out.commands:
            cmd.redirects = segment.redirects
            cmd.pipe_from = list(pipeline)
            cmd.stdin_piped = segment.piped
            cmd.sub_sources = [s for w in segment.words for s in w.subs]
            verdicts += _classify_command(cmd, ctx)
        if not out.commands:
            # Redirection-only segment such as `> /dev/sda`.
            verdicts += _classify_targets(Command("", [], redirects=segment.redirects), ctx)
        pipeline += [c.name for c in commands]
    return worst(verdicts)


def _classify_command(cmd: Command, ctx: Ctx) -> list[Verdict]:
    verdicts = [r.verdict() for r in rules_for("command") if r.matches(cmd, ctx)]
    return verdicts + _classify_targets(cmd, ctx)


def _classify_targets(cmd: Command, ctx: Ctx) -> list[Verdict]:
    verdicts = []
    for op, word in command_targets(cmd):
        if not word.value or word.value.startswith(DYNAMIC):
            continue  # unknown at run time; shell.rm-unresolved-var covers the dangerous case
        value = word.value.replace(DYNAMIC, "*")
        verdicts.append(classify_path(op, value, home=ctx.home, cwd=ctx.cwd, via_shell=True))
    return verdicts


def segments_of(command: str, home: str) -> list[Segment]:
    """Parsed segments (exposed for tests and for deciding whether shell syntax is needed)."""
    return parse(command, {"HOME": home}).segments


# ------------------------------------------------------------------------------------------
# Tool dispatch
# ------------------------------------------------------------------------------------------

# Claude Code built-in tools that only read or talk to the network/model.
_SAFE_BUILTINS = frozenset(
    {"WebFetch", "WebSearch", "Glob", "Grep", "LS", "TodoWrite", "TodoRead", "Task", "Agent",
     "ExitPlanMode", "NotebookRead", "BashOutput", "KillShell", "ListMcpResourcesTool", "ReadMcpResourceTool"}
)
_WRITE_BUILTINS = frozenset({"Write", "Edit", "MultiEdit", "NotebookEdit"})
# claudeos-desktop tools that never need a gate.
_SAFE_MCP = frozenset(
    {"screenshot", "screen_info", "mouse_move", "mouse_click", "mouse_drag", "scroll", "type_text", "key_press",
     "wait", "list_windows", "focus_window", "open_app", "open_url", "clipboard_read", "clipboard_write",
     "list_dir", "search_files", "system_info", "notify", "request_permission"}
)


_DESKTOP_TOOLS = _SAFE_MCP | {"run_command", "read_file", "write_file", "delete_path", "move_path", "dbus_call",
                              "systemd", "gsettings"}


def _str(value: Any) -> str:
    return value if isinstance(value, str) else ""


def classify(tool_name: str, tool_input: Mapping[str, Any] | None, *, home: str, cwd: str | None = None,
             user: str = "") -> Verdict:
    """Classify a tool call. ``tool_name`` may be a Claude Code built-in (``Bash``, ``Write``...),
    a full MCP name (``mcp__claudeos-desktop__run_command``) or a bare claudeos-desktop tool name."""
    params: Mapping[str, Any] = tool_input if isinstance(tool_input, Mapping) else {}
    if tool_name.startswith(MCP_PREFIX):
        return classify_desktop_tool(tool_name[len(MCP_PREFIX) :], params, home=home, cwd=cwd, user=user)
    if tool_name == "Bash":
        command = _str(params.get("command"))
        return classify_shell(command, home=home, cwd=cwd, user=user) if command else ALLOW
    if tool_name in _WRITE_BUILTINS:
        path = _str(params.get("file_path")) or _str(params.get("notebook_path"))
        return classify_path("write", path, home=home, cwd=cwd) if path else UNKNOWN_TOOL
    if tool_name == "Read":
        path = _str(params.get("file_path"))
        return classify_path("read", path, home=home, cwd=cwd) if path else ALLOW
    if tool_name in _SAFE_BUILTINS:
        return ALLOW
    if tool_name in _DESKTOP_TOOLS:  # bare name of one of our own tools (used by their self-gate)
        return classify_desktop_tool(tool_name, params, home=home, cwd=cwd, user=user)
    return UNKNOWN_TOOL


def classify_desktop_tool(name: str, params: Mapping[str, Any], *, home: str, cwd: str | None = None,
                          user: str = "") -> Verdict:
    """Classifier for this server's own tools (bare names, e.g. ``run_command``)."""
    if name == "run_command":
        command = _str(params.get("command"))
        run_cwd = _str(params.get("cwd")) or cwd
        if run_cwd:
            run_cwd = _expand_home(run_cwd, os.path.normpath(home))
        return classify_shell(command, home=home, cwd=run_cwd, user=user) if command else ALLOW
    if name == "read_file":
        return classify_path("read", _str(params.get("path")), home=home, cwd=cwd)
    if name == "write_file":
        return classify_path("write", _str(params.get("path")), home=home, cwd=cwd)
    if name == "delete_path":
        verdict = classify_path("delete", _str(params.get("path")), home=home, cwd=cwd)
        return worst([verdict, PERMANENT_DELETE]) if params.get("permanent") else verdict
    if name == "move_path":
        return worst(
            [
                classify_path("delete", _str(params.get("source")), home=home, cwd=cwd),
                classify_path("write", _str(params.get("destination")), home=home, cwd=cwd),
            ]
        )
    if name in ("dbus_call", "systemd", "gsettings"):
        domain = "dbus" if name == "dbus_call" else name
        return worst([r.verdict() for r in rules_for(domain) if r.matches(dict(params))])
    if name in _SAFE_MCP:
        return ALLOW
    return UNKNOWN_TOOL
