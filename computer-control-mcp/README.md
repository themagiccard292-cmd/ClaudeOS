# claudeos-computer-control

The `claudeos-desktop` MCP server for ClaudeOS (Ubuntu 26.04 / GNOME 50, Wayland). It lets Claude Code see the screen,
drive mouse and keyboard, manage windows, apps, clipboard, files and system settings, behind a safety classifier that
**fails closed**. Contract: `docs/ARCHITECTURE.md` C1 (approval socket) and C4 (tools and rules).

Stdio server on the official `mcp` SDK (FastMCP, pinned `<2`): `python -m claudeos_mcp`, launched by
`bin/claudeos-computer-control-mcp` (`/opt/claudeos/venv`, else system `python3`).

## Tools

screenshot, screen_info, mouse_move, mouse_click, mouse_drag, scroll, type_text, key_press, wait, list_windows,
focus_window, open_app, open_url, clipboard_read, clipboard_write, run_command, read_file, write_file, list_dir,
search_files, move_path, delete_path, system_info, notify, gsettings, systemd, dbus_call, request_permission.
No tool raises to the client; failures come back as `Error: ...` text.

* **Coordinates** are pixels of the most recent screenshot (downscaled to `max_dimension`, default 1568); the server maps
  them to physical pixels (`geometry.py`).
* **Input**: `ydotool` on Wayland (socket `$XDG_RUNTIME_DIR/.ydotool_socket`), `xdotool` on X11/XWayland; override with
  `CLAUDEOS_INPUT_BACKEND`. ydotool only does relative motion, so absolute moves are "home then relative": move by
  `-32000,-32000` (clamps to the top-left), then by the target (`plan_ydotool_moves`; tune with
  `CLAUDEOS_YDOTOOL_UNITS_PER_PX` / `CLAUDEOS_YDOTOOL_MAX_STEP`).
* **Screenshots**: `gnome-screenshot -f` -> xdg-desktop-portal (gdbus) -> `grim` -> `import`/`scrot` (X11).
* **Windows**: only XWayland windows via wmctrl/xdotool; native Wayland windows cannot be listed (stated in the output).

## Safety

`safety/` holds one data-driven rule table (`rules.py`, id/level/risk/reason/predicate), a shell tokenizer that unwraps
`bash -c`, `sudo`, `env`, `xargs`, `find -exec`... (`shellparse.py`) and the classifier (`classifier.py`); the worst
segment wins. `request_permission` is the `--permission-prompt-tool` target: block -> deny, confirm -> asks the human via
the panel socket (`approval.py`), allow -> allow; unreachable/timeout/malformed/deny -> deny. `run_command` and the file,
systemd, gsettings and dbus tools re-apply the gate themselves (defence in depth); an approval given through
`request_permission` is reused once for the same call within 120 s.
Reading credential files (`~/.claude/.credentials*`, `/etc/shadow`) is blocked; modifying them asks.

## Develop

    make lint test      # ruff + shellcheck; pytest (bootstraps .venv once, needs PyPI the first time)
    make install DESTDIR=/tmp/root

Tests are offline: fake runner (`testing.py`), a real unix-socket fake panel, and an integration test that spawns the
server over stdio. **`CLAUDEOS_MCP_FAKE=1`** is a test hook (only the exact value `1`): it swaps every external program
for in-process fakes (a 2560x1440 fake screenshot, a recording ydotool). Safety and the approval socket stay real.

## Not verified here

Real Wayland input, real portal screenshots, `gio trash`, wmctrl and the live `claude` permission-prompt flow were not
exercised on a real GNOME session. Non-ASCII `type_text` is unsupported on ydotool (use clipboard + ctrl+v).
