#!/usr/bin/env bash
# Create /opt/claudeos/venv and install the MCP server's Python dependencies (needs network).
# Exits non-zero on failure; the package postinst tolerates that.
set -euo pipefail

VENV="${CLAUDEOS_VENV:-/opt/claudeos/venv}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQUIREMENTS="${CLAUDEOS_REQUIREMENTS:-$HERE/requirements.txt}"

mkdir -p "$(dirname "$VENV")"
python3 -m venv "$VENV"
"$VENV/bin/python" -m pip install --quiet --disable-pip-version-check -r "$REQUIREMENTS"
"$VENV/bin/python" -c "import mcp.server.fastmcp, PIL" 
echo "claudeos-computer-control: venv ready at $VENV"
