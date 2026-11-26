#!/usr/bin/env bash
# Install (or update) the Claude Code CLI globally with npm.
#
# Layout decision: NPM_CONFIG_PREFIX defaults to /usr, so npm puts the package in
# /usr/lib/node_modules and links the launcher at /usr/bin/claude. No /usr/local symlink
# is needed. Override with CLAUDEOS_NPM_PREFIX (tests, unusual images).
# Env: CLAUDE_CODE_VERSION (default "latest"), CLAUDEOS_NPM_PREFIX, npm proxy variables are honoured.
# Exits non-zero on any failure: the ISO build relies on that. Writes no tokens or config.
set -euo pipefail

VERSION="${CLAUDE_CODE_VERSION:-latest}"
PREFIX="${CLAUDEOS_NPM_PREFIX:-/usr}"
MIN_NODE_MAJOR=22

die() { echo "install-claude-code: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node not found; install nodejs >= ${MIN_NODE_MAJOR} first"
command -v npm >/dev/null 2>&1 || die "npm not found; install npm first"

node_version="$(node --version 2>/dev/null || true)"
node_major="${node_version#v}"
node_major="${node_major%%.*}"
case "$node_major" in
  '' | *[!0-9]*) die "cannot parse node version '${node_version}'" ;;
esac
if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
  die "Node.js ${MIN_NODE_MAJOR} or newer is required (found ${node_version})"
fi

echo "Installing @anthropic-ai/claude-code@${VERSION} into ${PREFIX} ..."
NPM_CONFIG_PREFIX="$PREFIX" npm install -g --no-fund --no-audit \
  "@anthropic-ai/claude-code@${VERSION}" || die "npm install failed"

claude_bin="${PREFIX}/bin/claude"
[ -x "$claude_bin" ] || die "npm finished but ${claude_bin} is missing"

# Verify with a scrubbed environment: no provider/credential variables reach the CLI.
if ! installed="$(env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL \
  -u CLAUDE_CODE_USE_BEDROCK -u CLAUDE_CODE_USE_VERTEX -u CLAUDE_CODE_USE_FOUNDRY \
  "$claude_bin" --version 2>&1)"; then
  die "'${claude_bin} --version' failed: ${installed}"
fi
echo "Installed: ${installed}"
