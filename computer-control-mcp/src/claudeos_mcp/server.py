"""FastMCP server assembly."""

from __future__ import annotations

import logging
import sys

from mcp.server.fastmcp import FastMCP

from . import SERVER_NAME
from .config import Config
from .context import AppContext, build_context
from .tools import desktop, system

INSTRUCTIONS = (
    "ClaudeOS desktop control. Take a screenshot before clicking; mouse coordinates are pixels of the "
    "latest screenshot. Prefer run_command/file tools over GUI clicking. Risky actions ask the user in the "
    "side panel; blocked actions are refused."
)


def build_server(ctx: AppContext | None = None) -> FastMCP:
    ctx = ctx or build_context(Config.from_env())
    mcp = FastMCP(SERVER_NAME, instructions=INSTRUCTIONS)
    desktop.register(mcp, ctx)
    system.register(mcp, ctx)
    return mcp


def main() -> None:
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    build_server().run(transport="stdio")
