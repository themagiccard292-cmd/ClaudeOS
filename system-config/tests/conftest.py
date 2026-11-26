"""Shared helpers: repo paths, fake executables, subprocess runner."""

from __future__ import annotations

import importlib.machinery
import importlib.util
import os
import stat
import subprocess
from pathlib import Path

import pytest

BASE = Path(__file__).resolve().parent.parent
SETTINGS = BASE / "etc/claude-code/managed-settings.json"
LIB = BASE / "usr/lib/claudeos"


def load_script(path: Path):
    """Import an extension-less python script as a module."""
    loader = importlib.machinery.SourceFileLoader(path.name.replace("-", "_"), str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def write_exe(path: Path, body: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/usr/bin/env bash\n" + body + "\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


@pytest.fixture
def fakebin(tmp_path):
    d = tmp_path / "fakebin"
    d.mkdir()
    return d


@pytest.fixture
def clean_env(tmp_path, fakebin):
    """Environment with only fakebin + coreutils on PATH, a temp HOME and no provider vars."""
    env = {
        "PATH": f"{fakebin}:/usr/bin:/bin",
        "HOME": str(tmp_path / "home"),
        "XDG_RUNTIME_DIR": str(tmp_path / "run"),
        "CLAUDEOS_CONFIG_DIR": str(tmp_path / "home/.config/claudeos"),
    }
    (tmp_path / "home").mkdir()
    (tmp_path / "run").mkdir()
    return env


def run(cmd, env, **kw):
    return subprocess.run([str(c) for c in cmd], env=env, capture_output=True, text=True, timeout=60, **kw)


def fake_claude(fakebin: Path, log: Path, logged_in: bool = True) -> Path:
    state = "true" if logged_in else "false"
    return write_exe(
        fakebin / "claude",
        f'echo "$@" >> "{log}"\n'
        f'echo "ANTHROPIC_API_KEY=${{ANTHROPIC_API_KEY-unset}}" >> "{log}"\n'
        'case "$1 $2" in\n'
        '  "auth status") echo \'{"loggedIn": ' + state + ', "authMethod": "claudeai"}\' ;;\n'
        '  "auth login") echo "login ok" ;;\n'
        '  "mcp add") : ;;\n'
        '  *) echo "2.1.332 (Claude Code)" ;;\n'
        "esac",
    )


__all__ = ["BASE", "LIB", "SETTINGS", "load_script", "write_exe", "run", "fake_claude", "os"]
