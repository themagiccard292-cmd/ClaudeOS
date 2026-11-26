"""Shared helpers: run bash functions from the pipeline libraries in a throw-away shell."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

ISO_BUILDER = Path(__file__).resolve().parents[1]
REPO = ISO_BUILDER.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"
UBUNTU = FIXTURES / "ubuntu-26.04.1"
sys.path.insert(0, str(ISO_BUILDER / "lib"))

LIBS = ["config/build.conf", "lib/common.sh", "lib/download.sh", "lib/preflight.sh", "lib/rootfs.sh",
        "lib/chroot.sh", "lib/squashfs.sh", "lib/bootcfg.sh", "lib/repack.sh", "lib/deb.sh"]


@pytest.fixture
def sh(tmp_path):
    """sh(script, stdin=None, env=None) -> CompletedProcess; all libs are sourced, WORK_DIR=tmp/work."""

    def run(script: str, stdin: str | None = None, env: dict | None = None):
        prelude = "set -euo pipefail\nISO_BUILDER_DIR={0}\nWORK_DIR={1}\n".format(ISO_BUILDER, tmp_path / "work")
        prelude += "".join(f"source {ISO_BUILDER / lib}\n" for lib in LIBS)
        import os

        return subprocess.run(["bash", "-c", prelude + script], input=stdin, capture_output=True, text=True,
                              env={**os.environ, **(env or {})}, check=False)

    return run
