"""Helpers shared by the tool modules."""

from __future__ import annotations

import functools
import logging
from collections.abc import Callable
from typing import Any

from ..backends.files import FileToolError
from ..gate import GateResult
from ..keys import KeyParseError

log = logging.getLogger("claudeos_mcp")

# Errors whose message is already written for the model.
_EXPECTED = (ValueError, LookupError, RuntimeError, FileToolError, KeyParseError, OSError)


def safe_tool[F: Callable[..., Any]](fn: F) -> F:
    """Never raise to the client: turn any exception into an actionable text result."""

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return fn(*args, **kwargs)
        except _EXPECTED as exc:
            return f"Error: {exc}"
        except Exception as exc:  # noqa: BLE001 - last-resort guard, logged to stderr
            log.exception("tool %s crashed", fn.__name__)
            return f"Error: unexpected {type(exc).__name__} in {fn.__name__}: {exc}"

    return wrapper  # type: ignore[return-value]


def denied(result: GateResult) -> str:
    """Text returned when the gate refuses; the action was NOT performed."""
    return f"Not done. {result.message}".strip()
