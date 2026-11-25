# CLAUDE.md — working on the ClaudeOS repository

ClaudeOS = Ubuntu 26.04.1 LTS (Resolute Raccoon, amd64) + Claude Code CLI + a docked Claude-style side panel with full
computer control, an "Ask Claude" Nautilus action, a Calamares installer, and a warm Claude-inspired theme. This repo
builds all of it and repacks the official Ubuntu ISO into `claudeos-26.04.1-amd64.iso`.

**Read `docs/ARCHITECTURE.md` first.** It defines every cross-module contract (socket protocol, CLI, backend flags, MCP tools,
safety classifier, packaging, ISO pipeline, theme tokens) and records what was verified against the real ISO and the real
`claude` binary. Do not re-derive those facts; do not silently deviate from them.

## Layout

| Path | What | Check with |
|---|---|---|
| `side-panel/` | Electron + React + Tailwind docked panel, `claudeos-panel` launcher, onboarding wizard | `make -C side-panel lint test` |
| `nautilus-extension/` | "Ask Claude" nautilus-python extension | `make -C nautilus-extension lint test` |
| `computer-control-mcp/` | MCP server `claudeos-desktop` + safety classifier | `make -C computer-control-mcp lint test` |
| `calamares-config/` | Calamares config/branding/slideshow/post-install | `make -C calamares-config lint test` |
| `system-config/` | OS prompt `/etc/claude-code/CLAUDE.md`, managed settings, first-boot, doctor, services | `make -C system-config lint test` |
| `theme/` | warm theme, wallpapers, dconf | `make -C theme lint test` |
| `iso-builder/`, `scripts/`, `.github/` | deb packaging, ISO pipeline, CI | `make -C iso-builder lint test` |

Root: `make lint`, `make test`, `make ci`, `make debs`, `make iso`.

## Non-negotiables

1. **No API keys, ever.** Authentication is Claude Pro/Max subscription OAuth (`claude auth login --claudeai`). Any spawned
   `claude` process gets `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and the Bedrock/Vertex/Foundry switches stripped.
   Managed settings pin `forceLoginMethod: "claudeai"`.
2. **Safety is layered and fails closed.** Block-class actions never run; confirm-class actions need a human click in the panel;
   if the approval channel is unreachable the answer is deny. Screen contents are untrusted input (prompt-injection aware).
3. **GNOME 50 is Wayland-only.** No `globalShortcut`, no `xdotool` for native windows, no `grim`. See `docs/ARCHITECTURE.md` §1.1.
4. **The squashfs kernel must match `casper/vmlinuz`.** The ISO builder holds kernel/grub/shim packages in the chroot.
5. Be honest about verification: ISO build/boot, Wayland input and the live `claude` stream have not been exercised on real systems from CI-less
   sandboxes. Tests use fakes (`CLAUDEOS_CLAUDE_BIN`, stubbed `gi`, mocked subprocess). Say so in PRs and docs instead of implying otherwise.

## Conventions

- Python 3.12–3.14, `ruff` (root `ruff.toml`), `pytest`; type hints on public functions.
- TypeScript strict, ESLint flat config, Vitest; React function components + hooks; Tailwind tokens live in `tailwind.config.js` / CSS variables.
- Bash: `#!/usr/bin/env bash`, `set -euo pipefail`, `shellcheck` clean, quote everything, no `eval`.
- YAML: `yamllint` with root `.yamllint`. JSON must parse (`jq empty`).
- Tests are offline and deterministic. Never call the real `claude`, real `ydotool`, real `xorriso`/`mksquashfs` in unit tests (use fakes or `--dry-run`).
- Keep commits scoped per module. Contract changes go in `docs/ARCHITECTURE.md` in the same commit.

## Branding / design tokens (must match the Claude desktop app feel)

Light `#F5F4EF` bg, `#FFFFFF` elevated, `#E6E4DD` hairlines · Dark `#262624` bg, `#1E1E1C` elevated, `#383835` hairlines · accent `#D97757`.
Serif (Newsreader → Tiempos → Georgia) for Claude's replies and greetings; Inter for UI; JetBrains Mono for code.
