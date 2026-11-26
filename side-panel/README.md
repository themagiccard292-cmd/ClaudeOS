# ClaudeOS side panel

Docked Claude-style panel for ClaudeOS: Electron + React + Tailwind UI backed by the local Claude Code CLI (subscription OAuth, never API keys).
Package `claudeos-side-panel` (amd64). Contracts: `docs/ARCHITECTURE.md` C1 (socket), C2 (CLI), C3 (backend), C6 (packaging), C9 (onboarding).

## Layout
- `src/renderer/` React UI. `src/shared/protocol.ts` types and IPC channel names shared by all processes.
- `src/main/core/` electron-free logic with injected dependencies (claude binary, stream parser, session manager, auth, C1 socket server,
  approvals, stores, doctor, files, dock/strut, logger). `src/main/electron/` + `main.ts` are thin glue (windows, IPC validation, app wiring).
- `src/preload/` contextBridge implementation of `ClaudeOSApi`.
- `launcher/claudeos-panel` python3 CLI (C2); `desktop/` desktop entry and AppArmor profile; `debian/postinst`.

## Develop and test
One-time: `npm ci`. Then `make lint test` (eslint, both tsc projects, ruff, shellcheck, vitest, pytest). `make install DESTDIR=/tmp/root` runs
`npm run package` unless `dist-package/` exists and stages `/opt/claudeos/panel` (chrome-sandbox 4755), the launcher, desktop entry and AppArmor profile.
Tests use a fake `claude` (`test/fixtures/fake-claude.mjs` via `CLAUDEOS_CLAUDE_BIN`) and never call the real CLI. `test/smoke-xvfb.test.ts`
boots the packaged app under Xvfb and is skipped when `xvfb-run` or `dist-package/` is missing.

## Environment
`CLAUDEOS_PANEL_SOCKET`, `CLAUDEOS_PANEL_APP`, `CLAUDEOS_CONFIG_DIR`, `CLAUDEOS_CLAUDE_BIN`, `CLAUDEOS_MCP_CONFIG`, `CLAUDEOS_DEV_URL`,
`CLAUDEOS_OZONE` (default x11), `CLAUDEOS_NO_SANDBOX=1` (debug only; Chromium additionally needs `--no-sandbox` on the command line when run as root).

## Known limitations
Not exercised on a real GNOME Wayland session: XWayland docking, struts and always-on-top behaviour are best effort. The live `claude` stream was
only tested against fixtures and the fake binary.
