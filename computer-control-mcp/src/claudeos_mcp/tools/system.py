"""Shell, file, system and permission tools. Each risky tool re-applies the safety gate itself."""

from __future__ import annotations

import json
from typing import Annotated, Any, Literal

from mcp.server.fastmcp import FastMCP, Image
from pydantic import Field

from ..backends import files, shell
from ..backends.system import system_info as collect_system_info
from ..config import READ_DEFAULT_BYTES, READ_MAX_BYTES
from ..context import AppContext
from ._common import denied, safe_tool


def register(mcp: FastMCP, ctx: AppContext) -> None:
    home = ctx.config.home

    def path_of(raw: str) -> str:
        return files.expand(raw, home)

    @mcp.tool()
    @safe_tool
    def run_command(
        command: Annotated[str, Field(description="Shell command line (bash syntax). Pipes, &&, quotes work.")],
        cwd: Annotated[str | None, Field(description="Working directory; default is the home folder")] = None,
        timeout_s: Annotated[float, Field(description="Seconds before the process group is killed (max 600)", gt=0)] = 60,
    ) -> str:
        """Run a shell command and return its exit code, stdout and stderr (truncated to 20 000 chars).
        Dangerous commands are blocked; risky ones (sudo, rm -r, package changes...) ask the user first.
        Prefer this over clicking through the GUI whenever a command can do the job."""
        gate = ctx.gate.check("run_command", {"command": command, "cwd": cwd}, cwd=cwd)
        if not gate.allowed:
            return denied(gate)
        return shell.run_command(ctx.runner, command, cwd=shell.validate_cwd(cwd, home), timeout_s=timeout_s)

    @mcp.tool()
    @safe_tool
    def read_file(
        path: Annotated[str, Field(description="File path (~ allowed; relative = from home)")],
        offset: Annotated[int, Field(description="Byte offset to start at", ge=0)] = 0,
        limit: Annotated[int, Field(description="Max bytes (default 1 MiB, max 5 MiB)", gt=0)] = READ_DEFAULT_BYTES,
    ) -> list[Image | str] | str:
        """Read a text file (images are returned as images). Binary files are refused."""
        gate = ctx.gate.check("read_file", {"path": path})
        if not gate.allowed:
            return denied(gate)
        result = files.read_file(path_of(path), offset=offset, max_bytes=min(limit, READ_MAX_BYTES))
        if result.image is not None:
            return [Image(data=result.image, format=result.image_format), f"Image file {path}."]
        return result.text or ""

    @mcp.tool()
    @safe_tool
    def write_file(
        path: Annotated[str, Field(description="File path to write")],
        content: Annotated[str, Field(description="Full new content (UTF-8)")],
        append: Annotated[bool, Field(description="Append instead of overwrite")] = False,
        create_dirs: Annotated[bool, Field(description="Create missing parent folders")] = False,
    ) -> str:
        """Write a text file. Overwrites unless append=true. Writes under /etc, /usr... ask the user."""
        gate = ctx.gate.check("write_file", {"path": path, "content": content, "append": append})
        if not gate.allowed:
            return denied(gate)
        return files.write_file(path_of(path), content, append=append, create_dirs=create_dirs)

    @mcp.tool()
    @safe_tool
    def list_dir(
        path: Annotated[str, Field(description="Folder path")] = "~",
        show_hidden: Annotated[bool, Field(description="Include dotfiles")] = False,
        limit: Annotated[int, Field(description="Max entries", ge=1, le=5000)] = 500,
    ) -> str:
        """List a folder: type, modified time, name and size."""
        return files.list_dir(path_of(path), show_hidden=show_hidden, limit=limit)

    @mcp.tool()
    @safe_tool
    def search_files(
        root: Annotated[str, Field(description="Folder to search")] = "~",
        name_pattern: Annotated[str, Field(description="Glob for file names, e.g. '*.py'")] = "*",
        contains: Annotated[str | None, Field(description="Only files whose text contains this (case-insensitive)")] = None,
        max_results: Annotated[int, Field(description="Max results (<= 2000)")] = 200,
        max_depth: Annotated[int, Field(description="Max folder depth")] = 8,
    ) -> str:
        """Find files by name and optionally by content. Skips .git, node_modules and caches."""
        return files.search_files(path_of(root), home=home, name_pattern=name_pattern, contains=contains,
                                  max_results=max_results, max_depth=max_depth)

    @mcp.tool()
    @safe_tool
    def move_path(
        source: Annotated[str, Field(description="Existing file or folder")],
        destination: Annotated[str, Field(description="New path, or a folder to move into")],
        overwrite: Annotated[bool, Field(description="Replace an existing target")] = False,
    ) -> str:
        """Move or rename a file or folder."""
        gate = ctx.gate.check("move_path", {"source": source, "destination": destination})
        if not gate.allowed:
            return denied(gate)
        return files.move_path(path_of(source), path_of(destination), overwrite=overwrite)

    @mcp.tool()
    @safe_tool
    def delete_path(
        path: Annotated[str, Field(description="File or folder to delete")],
        permanent: Annotated[bool, Field(description="true = delete for good (asks the user); default moves to Trash")] = False,
    ) -> str:
        """Delete a file or folder. By default it goes to the Trash (`gio trash`) and can be restored."""
        gate = ctx.gate.check("delete_path", {"path": path, "permanent": permanent})
        if not gate.allowed:
            return denied(gate)
        return files.delete_path(path_of(path), permanent=permanent, runner=ctx.runner)

    @mcp.tool()
    @safe_tool
    def system_info() -> str:
        """OS, kernel, session, CPU, memory, disk and uptime (never environment variables)."""
        return collect_system_info(ctx.config.env, {})

    @mcp.tool()
    @safe_tool
    def notify(
        title: Annotated[str, Field(description="Notification title")],
        body: Annotated[str, Field(description="Notification text")] = "",
        urgency: Annotated[Literal["low", "normal", "critical"], Field(description="Urgency")] = "normal",
    ) -> str:
        """Show a desktop notification."""
        return ctx.system.notify(title, body, urgency)

    @mcp.tool()
    @safe_tool
    def gsettings(
        action: Annotated[str, Field(description="get, set, reset, reset-recursively, list-keys, list-recursively, range, describe")],
        schema: Annotated[str, Field(description="e.g. org.gnome.desktop.interface")],
        key: Annotated[str | None, Field(description="e.g. color-scheme")] = None,
        value: Annotated[str | None, Field(description="GVariant text for set, e.g. \"'prefer-dark'\" or true")] = None,
    ) -> str:
        """Read or change GNOME settings (dconf). Resets of whole schemas ask the user."""
        params = {"action": action, "schema": schema, "key": key, "value": value}
        gate = ctx.gate.check("gsettings", params)
        if not gate.allowed:
            return denied(gate)
        return ctx.system.gsettings(action, schema, key, value)

    @mcp.tool()
    @safe_tool
    def systemd(
        action: Annotated[str, Field(description="status, start, stop, restart, enable, disable, is-active...")],
        unit: Annotated[str, Field(description="Unit name, e.g. ssh.service")],
        scope: Annotated[Literal["user", "system"], Field(description="user (default) or system")] = "user",
    ) -> str:
        """Query or control systemd units. Stopping/disabling system units asks the user."""
        gate = ctx.gate.check("systemd", {"action": action, "unit": unit, "scope": scope})
        if not gate.allowed:
            return denied(gate)
        return ctx.system.systemd(action, unit, scope)

    @mcp.tool()
    @safe_tool
    def dbus_call(
        bus: Annotated[Literal["session", "system"], Field(description="session or system bus")],
        dest: Annotated[str, Field(description="Bus name, e.g. org.freedesktop.Notifications")],
        path: Annotated[str, Field(description="Object path, e.g. /org/freedesktop/Notifications")],
        method: Annotated[str, Field(description="Interface.Method")],
        args: Annotated[list[str] | None, Field(description="GVariant-text arguments")] = None,
    ) -> str:
        """Call a D-Bus method through gdbus. Calls on the system bus ask the user."""
        gate = ctx.gate.check("dbus_call", {"bus": bus, "dest": dest, "path": path, "method": method, "args": args or []})
        if not gate.allowed:
            return denied(gate)
        return ctx.system.dbus_call(bus, dest, path, method, args or [])

    @mcp.tool()
    @safe_tool
    def request_permission(
        tool_name: Annotated[str, Field(description="Tool Claude Code wants to run")],
        input: Annotated[dict[str, Any], Field(description="The tool's input")],  # noqa: A002 - Claude Code's field name
        tool_use_id: Annotated[str | None, Field(description="Claude Code's tool_use id")] = None,
    ) -> str:
        """Target of `claude --permission-prompt-tool`. Classifies the call: block -> deny, confirm -> asks
        the human in the panel (deny when unreachable), allow -> allow. Returns a JSON string."""
        result = ctx.gate.check(tool_name, input, remember=True)
        if result.allowed:
            return json.dumps({"behavior": "allow", "updatedInput": input})
        return json.dumps({"behavior": "deny", "message": result.message or "Denied."})
