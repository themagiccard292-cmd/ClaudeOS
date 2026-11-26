"""Shared helpers for the theme tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="session")
def root() -> Path:
    return ROOT


@pytest.fixture(scope="session")
def tokens() -> dict:
    return json.loads((ROOT / "usr/share/claudeos/theme/tokens.json").read_text(encoding="utf-8"))
