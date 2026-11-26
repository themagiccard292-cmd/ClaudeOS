"""Spawns the real server over stdio with the official MCP client (CLAUDEOS_MCP_FAKE=1 test hook)."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from .test_tools import EXPECTED_TOOLS

SRC = str(Path(__file__).resolve().parent.parent / "src")


async def _session_run(env_extra: dict[str, str], body, tmp_home: Path):
    env = {"PATH": os.environ["PATH"], "HOME": str(tmp_home), "PYTHONPATH": SRC, "XDG_SESSION_TYPE": "wayland",
           "XDG_RUNTIME_DIR": str(tmp_home / "run"), "CLAUDEOS_PANEL_SOCKET": str(tmp_home / "none.sock"),
           **env_extra}
    params = StdioServerParameters(command=sys.executable, args=["-m", "claudeos_mcp"], env=env)
    async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
        await session.initialize()
        return await body(session)


def test_stdio_tool_set_and_fake_screenshot(tmp_path: Path) -> None:
    async def body(session: ClientSession):
        tools = await session.list_tools()
        assert {t.name for t in tools.tools} == EXPECTED_TOOLS
        shot = await session.call_tool("screenshot", {})
        assert [c.type for c in shot.content] == ["image", "text"]
        assert "1568x882" in shot.content[1].text
        click = await session.call_tool("mouse_click", {"x": 10, "y": 10})
        assert "done" in click.content[0].text
        perm = await session.call_tool("request_permission",
                                       {"tool_name": "Bash", "input": {"command": "rm -rf /"}})
        assert json.loads(perm.content[0].text)["behavior"] == "deny"
        perm = await session.call_tool("request_permission",
                                       {"tool_name": "Bash", "input": {"command": "sudo ls"}})
        assert json.loads(perm.content[0].text)["behavior"] == "deny"  # no panel -> fail closed

    asyncio.run(_session_run({"CLAUDEOS_MCP_FAKE": "1"}, body, tmp_path))


def test_fake_hook_is_inert_unless_exactly_one(tmp_path: Path) -> None:
    async def body(session: ClientSession):
        shot = await session.call_tool("screenshot", {})
        assert "Error" in shot.content[0].text  # real backends: nothing available in the sandbox

    asyncio.run(_session_run({"CLAUDEOS_MCP_FAKE": "true", "PATH": "/nonexistent"}, body, tmp_path))
