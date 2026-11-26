# ClaudeOS architecture and cross-module contracts

ClaudeOS is Ubuntu 26.04.1 LTS (Resolute Raccoon, amd64) plus: the official Claude Code CLI, a docked
Claude-style side panel, computer-control tooling, an "Ask Claude" Nautilus action, a Calamares installer and a
warm Claude-inspired theme. This document is the **single source of truth for every interface between modules**.
Module owners must conform to it; if a contract must change, change it here in the same commit.

```
                        ┌──────────── Super+C (GNOME custom keybinding) ───────────┐
Nautilus "Ask Claude" ──┤                                                          │
(nautilus-extension)    ▼                                                          ▼
                 claudeos-panel (python3 CLI, C2) ── NDJSON over unix socket (C1) ──► Electron side panel
                                                                                      │  main process
                                                                                      │  spawns (C3)
                                                                                      ▼
                                                              claude -p --input-format stream-json ...   (Claude Pro OAuth)
                                                                                      │  MCP stdio
                                                                                      ▼
                                              claudeos-desktop MCP server (C4)  ──approval-request──► panel socket (C1)
                                              screen / input / windows / clipboard / shell / files / system
```

## 0. Module map and ownership

| Dir | Deliverable | Deb package | Language |
|---|---|---|---|
| `side-panel/` | Electron + React + Tailwind docked panel, `claudeos-panel` launcher, onboarding wizard UI | `claudeos-side-panel` | TS / Python launcher |
| `nautilus-extension/` | "Ask Claude" context-menu extension (nautilus-python, GTK4 / Nautilus 50) | `claudeos-nautilus` | Python |
| `computer-control-mcp/` | MCP server `claudeos-desktop` + safety classifier + permission-prompt tool | `claudeos-computer-control` | Python (`mcp` SDK) |
| `calamares-config/` | Calamares settings, modules, branding, slideshow, post-install, live launcher | `claudeos-calamares` | YAML/QML/sh |
| `system-config/` | OS `CLAUDE.md`, Claude Code managed settings, MCP config, first-boot, doctor, ydotool/udev/systemd, dconf, autostart | `claudeos-core` | sh/Python/JSON |
| `theme/` | Warm theme: wallpapers (light+dark), GTK css, dconf defaults, icons/branding assets | `claudeos-theme` | SVG/CSS/dconf |
| `iso-builder/` + `scripts/` + `.github/` | deb packaging, ISO pipeline, CI | meta `claudeos-desktop` | bash |

Rules for all modules:
- **Zero API keys.** Nothing may read, require, prompt for or persist `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`.
  Every process we spawn that runs `claude` MUST strip those variables (and `ANTHROPIC_BASE_URL`,
  `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`) from its environment.
  Login is `claude auth login --claudeai` (subscription OAuth). Status is `claude auth status --json`.
- Python code must run on 3.12–3.14 (Ubuntu 26.04 ships 3.14.3). Lint with `ruff` (root `ruff.toml`), test with `pytest`.
- Shell scripts: `#!/usr/bin/env bash` + `set -euo pipefail`, must pass `shellcheck` with no warnings.
- Every module has a `Makefile` with targets `lint`, `test`, `install`, `clean` (see C6).
- No network access in tests. No test may touch the real `claude` binary or real input devices.
- Never print or log OAuth tokens. Never write secrets to disk.

## 1. Verified facts (checked against the real artifacts on 2026-11-25)

### 1.1 Ubuntu 26.04.1 desktop ISO (`https://releases.ubuntu.com/26.04.1/ubuntu-26.04.1-desktop-amd64.iso`, 6.04 GiB)
- SHA256 (from `SHA256SUMS`): `601e30fbf5d97759367c632e2c33630665039b7e2158fd068403da3ccf1bda1f`. `SHA256SUMS` + `SHA256SUMS.gpg` live next to it.
- `.disk/info`: `Ubuntu 26.04.1 LTS "Resolute Raccoon" - Release amd64 (20260826)`; `.disk/cd_type`: `full_cd/single`.
- Top level: `.disk boot boot.catalog casper dists EFI md5sum.txt pool ubuntu`. **No isolinux.** BIOS boot is GRUB El Torito
  (`boot/grub/i386-pc`), UEFI is `EFI/boot/{bootx64,grubx64,mmx64}.efi` (shim + signed grub; do not touch these).
- `casper/` has `vmlinuz`, `initrd` and a **layered** root: `minimal.squashfs` (3.4 GB) → `minimal.standard.squashfs` (590 MB)
  → `minimal.standard.live.squashfs` (793 MB; live-only: casper, calamares-less installer snap `ubuntu-desktop-bootstrap`, gparted, zfs...).
  Plus many language (`minimal.de.squashfs`...) and `*enhanced-secureboot*` variant layers, each with `.manifest/.size`.
  `casper/install-sources.yaml` describes them for the *stock* Subiquity-based installer only.
- `boot/grub/grub.cfg` is tiny (entries "Try or Install Ubuntu" / "Ubuntu (safe graphics)", kernel args `--- quiet splash`,
  **no `layerfs-path=`**); `boot/grub/loopback.cfg` mirrors it with `iso-scan/filename=${iso_path}`.
- casper (`26.04.2`, read from the shipped initrd): with `layerfs-path=<file>` it mounts that squashfs plus every parent layer
  (name minus last dot-suffix); **without it, it mounts every `*.squashfs` in `/casper` as an overlay lower layer**.
  The boot medium is at `/cdrom` in the live session. Live user is `ubuntu` (GDM autologin, passwordless sudo). casper masks
  `gnome-initial-setup` for the live user.
- Package versions in the ISO: GNOME Shell 50.1, Nautilus 50.2.2 (GTK4/libadwaita), GDM 50.1, Python 3.14.3, python3-gi 3.56,
  xdg-desktop-portal 1.21.1 (+gnome, +gtk), Xwayland 24.1.10, Yaru 26.04.5.1, ptyxis 50.1 (terminal), snapd 2.76.3, apparmor 5.0.2,
  `shim-signed`, `grub-efi-amd64-signed`, `initramfs-tools`, `xorriso`, `squashfs-tools 4.7.5`.
  **Not present** (we must install): nodejs/npm, python3-nautilus, ydotool, xdotool, grim, wl-clipboard, xclip, gnome-screenshot, calamares, x11-xserver-utils, librsvg2-bin.
  The stock installer is the snap `ubuntu-desktop-bootstrap`, seeded in `/var/lib/snapd/seed` of the live layer.
- GNOME 50 is **Wayland-only** (no X11 session). Consequences: `xdotool`/`grim` do not control native Wayland windows; input needs
  `ydotool` (uinput); screenshots go through `gnome-screenshot` / the xdg-desktop-portal Screenshot API; Electron must run under
  XWayland (`--ozone-platform=x11`) to be able to position itself and stay on top; Electron `globalShortcut` does NOT work on
  Wayland, so **Super+C is a GNOME custom keybinding** that runs `claudeos-panel toggle`.
- Ubuntu restricts unprivileged user namespaces via AppArmor: the Electron app must ship a SUID `chrome-sandbox` (mode 4755) and/or an AppArmor profile.

### 1.2 Claude Code CLI (`@anthropic-ai/claude-code` 2.1.332, `engines.node >= 22`, native binary via optionalDependencies)
- `claude auth login [--claudeai|--console] [--email <e>] [--sso]`, `claude auth status [--json|--text]` (JSON default:
  `{"loggedIn":bool,"authMethod":"...","apiProvider":"firstParty",...}`), `claude auth logout`, `claude setup-token`.
- Flags we use: `-p/--print`, `--input-format stream-json`, `--output-format stream-json`, `--verbose`, `--include-partial-messages`,
  `--replay-user-messages`, `--model <alias|id>` (aliases `opus`, `sonnet`, `haiku`, `fable`), `--effort <low|medium|high|xhigh|max>`,
  `--permission-mode <acceptEdits|auto|bypassPermissions|manual|dontAsk|plan>`, `--permission-prompt-tool <mcp__server__tool>`,
  `--permission-prompts <host|none>`, `--mcp-config <file...>`, `--strict-mcp-config`, `--settings <file|json>`, `--add-dir <dir...>`,
  `--resume <session-id>`, `--session-id <uuid>`, `--append-system-prompt <text>`, `--allowedTools`, `--disallowedTools`.
- The binary contains (verified by string search): `/etc/claude-code/managed-settings.json`, `/etc/claude-code`, setting key `forceLoginMethod`,
  env `DISABLE_AUTOUPDATER`, flag `--permission-prompt-tool`. Managed memory file path on Linux: `/etc/claude-code/CLAUDE.md`.
- `claude mcp add --scope user <name> -- <command> [args...]` registers a user-scope stdio MCP server.

### 1.3 Known limitations (document, do not hide)
- Nothing here has been booted on real hardware. ISO build + install are validated by dry-run/unit tests and static checks only.
- GitHub release assets are limited to 2 GiB per file; the ISO is ~5-7 GiB, so releases publish **split parts** + checksums (see C7/iso-builder).
- Calamares' partition page uses the built-in label "Erase disk"; the product name appears in its description text from branding.
- Screenshot/input behaviour under GNOME Wayland depends on portal permissions and `/dev/uinput` access; `claudeos-doctor` reports what is missing.

## 2. Installed filesystem layout

```
/usr/bin/claudeos-panel                         launcher/CLI (python3)                          side-panel
/opt/claudeos/panel/                            Electron app dir (binary: claudeos-panel-app)   side-panel
/usr/share/applications/claudeos-panel.desktop                                                  side-panel
/usr/share/nautilus-python/extensions/claudeos_ask_claude.py                                    nautilus-extension
/usr/share/applications/claudeos-ask-claude.desktop  (Open With / other file managers)    nautilus-extension
/usr/lib/claudeos/computer-control/             python package `claudeos_mcp` + requirements    computer-control-mcp
/usr/bin/claudeos-computer-control-mcp          launcher -> /opt/claudeos/venv/bin/python -m claudeos_mcp
/opt/claudeos/venv/                              created by `/usr/lib/claudeos/computer-control/setup-venv.sh`
/etc/claude-code/managed-settings.json          Claude Code managed settings                    system-config
/etc/claude-code/CLAUDE.md                      OS system prompt (managed memory)               system-config
/etc/claudeos/mcp.json                          MCP config passed by the panel via --mcp-config system-config
/usr/lib/claudeos/{install-claude-code.sh,claudeos-doctor,claudeos-session-init,claudeos-firstboot}   system-config
/usr/bin/claudeos-login                         terminal login helper                           system-config
/etc/xdg/autostart/claudeos-{panel,session-init,firstboot}.desktop                             system-config
/usr/lib/systemd/user/ydotoold.service, /usr/lib/udev/rules.d/60-claudeos-uinput.rules          system-config
/etc/dconf/db/claudeos.d/*, /etc/dconf/profile/user                                              system-config (keys) + theme (values)
/etc/skel/.config/gnome-initial-setup-done                                                      system-config
/usr/share/backgrounds/claudeos/*, /usr/share/claudeos/theme/*, /etc/skel/.config/gtk-{3,4}.0/*  theme
/etc/calamares/**, /usr/share/calamares/branding/claudeos/**, /usr/lib/claudeos/calamares/*     calamares-config
/etc/xdg/autostart/claudeos-installer.desktop (live only), /usr/share/applications/claudeos-install.desktop   calamares-config
```

User state: `~/.config/claudeos/` (`panel.json` settings, `conversations/<id>.json`, `onboarding-done` stamp). Claude Code's own state stays in `~/.claude`.
Runtime socket: `$XDG_RUNTIME_DIR/claudeos/panel.sock` (dir 0700, socket 0600; fallback `/tmp/claudeos-$UID/panel.sock`).

Environment overrides (tests and dev): `CLAUDEOS_CLAUDE_BIN` (path to claude; default PATH lookup then `/usr/local/bin/claude`, `/usr/bin/claude`),
`CLAUDEOS_PANEL_SOCKET`, `CLAUDEOS_MCP_CONFIG` (default `/etc/claudeos/mcp.json`), `CLAUDEOS_CONFIG_DIR` (default `~/.config/claudeos`),
`CLAUDEOS_PANEL_APP` (Electron binary the launcher spawns; default `/opt/claudeos/panel/claudeos-panel-app`).

## C1. Panel control socket (NDJSON)

One JSON object per line, UTF-8, `\n` terminated. Client sends a request, server replies with exactly one response line carrying the same `id`
(except `approval-request`, whose reply arrives only after the human decides, or on timeout). Unknown `cmd` → `{ok:false,error:"unknown-command"}`.
The server ignores unknown fields and must never crash on malformed lines (reply `{ok:false,error:"bad-request"}`).

| `cmd` | request fields | response |
|---|---|---|
| `toggle` / `show` / `hide` | – | `{ok:true,visible:boolean}` |
| `new-chat` | – | `{ok:true}` (also shows) |
| `attach` | `paths:string[]` (absolute), `newChat?:boolean` (default false) | `{ok:true,attached:number}` — shows panel, adds file pills, focuses composer |
| `ask` | `text:string`, `paths?:string[]`, `send?:boolean` (default false) | `{ok:true}` |
| `onboarding` | – | `{ok:true}` — opens the first-run wizard (centered window) |
| `status` | – | `{ok:true,visible,width,signedIn:boolean\|null,version}` |
| `quit` | – | `{ok:true}` |
| `approval-request` | `tool:string,input:any,summary:string,risk:"low"\|"medium"\|"high"\|"critical",reason?:string,timeoutMs?:number(default 120000)` | later: `{ok:true,decision:"allow"\|"deny",message?:string}`; on timeout/dismiss `decision:"deny"` |

`approval-request` also shows the panel and displays an Allow/Deny card in the UI. Clients (the MCP server) **fail closed**: if the socket
is unreachable or the response is not exactly `decision:"allow"`, the action is denied.

## C2. `claudeos-panel` CLI (python3, side-panel/launcher)

`claudeos-panel [toggle|show|hide|new-chat|attach <path>...|ask <text> [--send] [--path P]...|onboarding|status|quit] [--background] [--no-spawn]`
- Default command (no args) = `show`. `--background` = start the app hidden if not running, do nothing if running (used by autostart).
- Connects to the C1 socket; if refused/missing and not `--no-spawn`, spawns `$CLAUDEOS_PANEL_APP` detached (new session, stdio to /dev/null,
  flags `--ozone-platform=x11 --enable-features=... ` as the side-panel owner sees fit), polls the socket up to 20 s, then sends the command.
- Relative paths are resolved to absolute before sending. Exit code 0 on success, 1 on failure with a one-line stderr message. `status` prints the JSON response.
- The Nautilus extension and the `.desktop` actions MUST invoke exactly `claudeos-panel attach -- <abs paths...>` (list-form exec, no shell).

## C3. Panel main process ↔ `claude` backend

Spawn (one long-lived process per conversation, cwd = `$HOME`):
```
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages
       --model <alias> --effort <level> --permission-mode <mode>
       --permission-prompt-tool mcp__claudeos-desktop__request_permission
       --mcp-config ${CLAUDEOS_MCP_CONFIG:-/etc/claudeos/mcp.json}
       [--resume <sessionId>] [--add-dir <dir>]...
```
- env = process env minus the API/provider variables listed in §0. Never pass `--dangerously-skip-permissions`.
- stdin, one line per user turn: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."} , {"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}]}}`.
  Attached files/dirs are described in a leading text block ("The user attached: - /abs/path (file, 12 KB) ...") so Claude reads them with its own tools; images ≤ 5 MB are also embedded as image blocks.
- stdout is NDJSON. Shapes the parser must handle (and **ignore anything unknown**, never throw):
  - `{"type":"system","subtype":"init","session_id","model","tools":[...],"mcp_servers":[{"name","status"}]}`
  - `{"type":"stream_event","event":{"type":"message_start|content_block_start|content_block_delta|content_block_stop|message_delta|message_stop", ...}}`
    with deltas `text_delta{text}`, `thinking_delta{thinking}`, `input_json_delta{partial_json}`; blocks `text|thinking|tool_use{id,name,input}`
  - `{"type":"assistant","message":{"id","content":[{"type":"text|thinking|tool_use",...}]}}` (complete message)
  - `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id","content":string|[{type:"text",text}|{type:"image",source}],"is_error"?}]}}`
  - `{"type":"result","subtype":"success|error_*","is_error","result","session_id","total_cost_usd","duration_ms","num_turns"}`
- This schema is taken from the Claude Agent SDK documentation, not captured from a live session. Tests use a fake `claude` (`CLAUDEOS_CLAUDE_BIN`).
- "Not signed in" detection: stderr/result text containing `not logged in`, `/login`, `authentication`, `401`, `OAuth` → emit `auth-required` and show sign-in.
- Stop = send SIGINT to the process (then SIGKILL after 3 s); the next send respawns with `--resume`.
- Auth flow: `claude auth login --claudeai` with piped stdio; capture the first `https://` URL from stdout/stderr → `LoginEvent{url}` + `xdg-open`;
  if the CLI asks for a pasted code, emit `need-code` and write the code to stdin; poll `claude auth status --json` every 2 s (max 10 min) → `success`.
  If the CLI exits immediately complaining about a TTY, fall back to opening a terminal (`ptyxis -- claudeos-login`, else `x-terminal-emulator -e claudeos-login`) → `fallback-terminal`.

## C4. MCP server `claudeos-desktop` (computer-control-mcp)

stdio MCP server built on the official Python `mcp` SDK (FastMCP), entry `python -m claudeos_mcp`. Registered as `claudeos-desktop`
(tool names therefore look like `mcp__claudeos-desktop__screenshot`). Tools (snake_case, JSON-schema typed, every tool returns text or image content, never raises to the client):

- screen: `screenshot(region?, max_dimension=1568, monitor?)` (image + one text block with scale metadata), `screen_info()`
- input: `mouse_move(x,y)`, `mouse_click(x?,y?,button="left",clicks=1)`, `mouse_drag(from_x,from_y,to_x,to_y)`, `scroll(x?,y?,dx=0,dy=0)`, `type_text(text)`, `key_press(keys)` (e.g. `"ctrl+alt+t"`, `"Return"`), `wait(seconds<=30)`
  Coordinates are in **screenshot space** (the last screenshot's downscaled pixels) and are mapped to physical pixels by the server; `screen_info` reports the scale.
  Backends auto-selected: `ydotool` (Wayland, needs `ydotoold` + `/dev/uinput`), `xdotool` (X11/XWayland); failures return actionable text.
- windows/apps: `list_windows()`, `focus_window(id_or_title)`, `open_app(name)`, `open_url(url)` (http/https/file/mailto only)
- clipboard: `clipboard_read()`, `clipboard_write(text)` (`wl-paste`/`wl-copy`, fallback `xclip`)
- shell: `run_command(command, cwd?, timeout_s=60)` — safety-gated (below), output truncated to 20 000 chars
- files: `read_file`, `write_file`, `list_dir`, `search_files`, `move_path`, `delete_path(path, permanent=false)` (default = move to trash via `gio trash`)
- system: `system_info()`, `notify(title, body)`, `gsettings(action,schema,key,value?)`, `systemd(action,unit,scope="user")`, `dbus_call(bus,dest,path,method,args?)`
- `request_permission(tool_name, input, tool_use_id?)` — the **`--permission-prompt-tool`** target. Returns a JSON **string**:
  `{"behavior":"allow","updatedInput":<input>}` or `{"behavior":"deny","message":"..."}`.

Safety classifier (single module, shared by `run_command`, file tools and `request_permission`): `classify(tool_name, input) -> Verdict(level, risk, reason, rule_id)` with
`level ∈ {allow, confirm, block}`:
- **block** (never executed, not even with approval; tell the user to do it manually): `rm -rf /`-style on `/`, `/usr`, `/etc`, `/boot`, `/bin`, `/lib*`, `/var`, `/home` roots or `$HOME`/`~`/`*` wildcards of those; `mkfs*` / `wipefs` / `shred` / `dd of=/dev/*` / redirect to `/dev/sd*|nvme*|mmcblk*`; `fdisk|parted|sgdisk|sfdisk|cfdisk` writes; fork bombs; `chmod|chown -R` on `/` or system dirs; `rm` of `/etc/claude-code` or `/opt/claudeos`; piping network downloads to a shell as root.
- **confirm** (human approval via C1 `approval-request`): any `sudo`/`pkexec`/`su`; `rm -r*` or `rm` of >5 paths; `apt|apt-get|dpkg|snap|npm -g|pip` install/remove/purge; `systemctl` stop/disable/mask/restart of system units; `kill -9`/`pkill`/`killall`; `reboot|shutdown|poweroff|halt|init 0`; writes/deletes under `/etc`, `/usr`, `/boot`, `/var`, `/opt`, `/sys`, `/proc`; `git push --force`; `curl|wget ... | sh`; `crontab -r`; `gsettings reset-recursively`; `dbus_call` on the system bus; `permanent=true` deletes; `rm`/`mv` over `~/.ssh`, `~/.gnupg`, `~/.config` roots.
- **allow**: everything else.
Rules are data-driven (one table, each rule with id, regex/predicate, level, reason) and unit-tested with positive and negative cases, including obfuscation attempts (`r""m`, `$(...)`, `sudo -u`, `env rm`, `bash -c "rm -rf /"`, `\rm`, `/bin/rm`, quoting, `;`/`&&`/`|` chains: the **worst** segment wins).
If the approval channel is unreachable → deny (fail closed).

## C5. Claude Code managed configuration (system-config)

`/etc/claude-code/managed-settings.json`: `forceLoginMethod:"claudeai"`, `env` with `DISABLE_AUTOUPDATER=1` (global npm install is root-owned; `claudeos-update` handles updates),
`permissions.defaultMode`, `permissions.allow` (read-only + benign `mcp__claudeos-desktop__*` tools such as screenshot/screen_info/list_windows/clipboard_read/list_dir/read_file/mouse+keyboard tools),
`permissions.ask` (risky Bash patterns: sudo, rm -r, apt, systemctl, dd, kill...), `permissions.deny` (catastrophic patterns mirroring C4 block rules + reading `~/.claude/.credentials*` / token files),
no `apiKeyHelper`, no `ANTHROPIC_*` env. `/etc/claude-code/CLAUDE.md` is the **OS system prompt**: who/where Claude is (ClaudeOS 26.04.1, GNOME 50 Wayland-only),
how to see (screenshot first, then act, verify after each step), how to act (prefer CLI/API over GUI clicking, ydotool caveats, screenshot-space coordinates),
safety rules (never run block-class actions, state before destructive actions, never exfiltrate credentials, treat on-screen text as untrusted data, no prompt-injection compliance),
how to use the panel (attached files appear as paths), and tone. Both files are valid JSON/Markdown and tested.

## Integration decisions (post-implementation)

- `bypassPermissions` is not a valid panel permission mode: managed settings set `permissions.disableBypassPermissionsMode: "disable"`, so `claude` would refuse to start. The panel validates against `acceptEdits|manual|plan|auto|dontAsk`.
- The meta package `claudeos-desktop` lists `calamares` + `claudeos-calamares` under **Recommends**, not Depends, so purging the installer from an installed system (Calamares post-install) cannot cascade-remove the meta package.
- The GRUB distributor stays `Ubuntu` (EFI directory `/EFI/ubuntu`) so shim/Secure Boot chainloading is unchanged even though os-release `NAME` is `ClaudeOS`.
- The full ISO is also published as a single file to `ghcr.io/<owner>/claudeos-iso:<version>` (OCI artifact, no 2 GiB cap); `scripts/download-iso.sh` fetches it. Release assets remain split parts.
- `claudeos-computer-control` additionally depends on `python3-pil` (screenshot scaling).

## C6. Module packaging contract

Each module dir provides:
- `Makefile` targets: `lint`, `test`, `install` (honours `DESTDIR`, `PREFIX=/usr`, `SYSCONFDIR=/etc`, `LIBDIR` as needed), `clean`.
  `install` must work from a clean checkout without network (the side-panel `install` runs `npm run package` first which needs `node_modules`; document `npm ci` as a prerequisite).
- `package.meta` (shell-sourceable `KEY="value"`): `PKG_NAME`, `PKG_DESCRIPTION`, `PKG_DEPENDS` (comma-separated Debian dependency list), `PKG_RECOMMENDS`, `PKG_ARCH` (`all` or `amd64`), `PKG_SECTION`.
- Optional maintainer scripts in `<module>/debian/{postinst,prerm,postrm}` (POSIX sh or bash, shellcheck-clean, idempotent, must `exit 0` when offline).
`iso-builder` turns each module into a `.deb` with `dpkg-deb --build --root-owner-group` (no debhelper), version = `VERSION` file (`26.04.1`) + `+claudeosN`.
A meta package `claudeos-desktop` depends on all module packages plus: `nodejs (>= 22)`, `npm`, `calamares`, `python3-nautilus`, `python3-venv`, `ydotool`, `xdotool`, `grim`, `wl-clipboard`, `xclip`, `gnome-screenshot`, `x11-xserver-utils`, `librsvg2-bin`, `libnotify-bin`, `xdg-utils`, `jq`.

Required runtime dependencies per module (also put them in that module's `package.meta`):
side-panel: `libgtk-3-0t64, libnss3, libxss1, libasound2t64, xdg-utils, python3, x11-utils` · nautilus: `python3-nautilus, claudeos-side-panel` · computer-control: `python3, python3-venv, ydotool, xdotool, wl-clipboard, xclip, gnome-screenshot, libglib2.0-bin, libnotify-bin, xdg-utils` ·
calamares: `calamares, x11-xserver-utils, policykit-1 | polkitd, rsync, squashfs-tools, qml-module-qtquick2 | qt6-declarative-dev-tools` · core: `nodejs (>= 22), npm, python3, dconf-cli, jq, curl, claudeos-computer-control` · theme: `librsvg2-bin, dconf-cli`.

## C7. ISO pipeline contract (iso-builder ↔ calamares-config ↔ system-config)

`scripts/build-iso.sh [--work-dir D] [--out-dir D] [--skip-download] [--dry-run] [--keep-work] [--ubuntu-iso PATH]` (env `ISO_VERSION=26.04.1`, `JOBS`):
1. download `ubuntu-26.04.1-desktop-amd64.iso` (+`SHA256SUMS`, `SHA256SUMS.gpg`), verify SHA256 (mandatory) and GPG (when possible; fail closed unless `SKIP_GPG=1`).
2. Merge the layered squashfs (`minimal` → `minimal.standard` → `minimal.standard.live`) through a **read-only overlayfs mount** (so whiteouts/opaque dirs are applied) and copy into a work rootfs.
3. Chroot (bind /proc /sys /dev /dev/pts /run, copy resolv.conf): `apt-mark hold` all `linux-*`, `grub*`, `shim*` packages first (the ISO's `casper/vmlinuz`+`initrd` are kept, so **the kernel in the squashfs must not change**); enable universe; install the meta package `claudeos-desktop` from a local file repo of our debs;
   run `/usr/lib/claudeos/install-claude-code.sh` (npm -g `@anthropic-ai/claude-code`, fail the build if `claude --version` fails) and `/usr/lib/claudeos/computer-control/setup-venv.sh`; remove the `ubuntu-desktop-bootstrap` snap from `/var/lib/snapd/seed` (seed.yaml entry + files) and any
   `ubuntu-desktop-bootstrap`/`ubiquity` autostart/desktop files; brand `os-release` (keep `ID=ubuntu`, `ID_LIKE=debian`; set `NAME="ClaudeOS"`, `PRETTY_NAME="ClaudeOS 26.04.1 (Ubuntu 26.04.1 LTS)"`, `VERSION_ID="26.04.1"`; add `CLAUDEOS_BASE=ubuntu-26.04.1`), `/etc/issue`, `lsb-release` DISTRIB_DESCRIPTION, GRUB distributor, `dconf update`, `glib-compile-schemas`; clean apt lists/caches/tmp/machine-id/resolv.conf.
4. Produce ONE squashfs `casper/filesystem.squashfs` (zstd or xz) + `filesystem.manifest` (`dpkg-query -W`) + `filesystem.size`; delete every other `casper/*.squashfs|*.manifest*|*.size` and `casper/install-sources.yaml`. Keep `casper/vmlinuz` and `casper/initrd` untouched.
5. Rewrite `boot/grub/grub.cfg` + `loopback.cfg` (menu "Try or Install ClaudeOS", "ClaudeOS (safe graphics)"; if `layerfs-path=X` exists rewrite to `layerfs-path=filesystem.squashfs`, else leave absent), `.disk/info` (`ClaudeOS 26.04.1 "Resolute Raccoon" - Release amd64 (YYYYMMDD)`), regenerate `md5sum.txt`.
6. Repack with `xorriso`, **replaying the original boot setup** (`-boot_image any replay` against the original ISO, or `-report_el_torito as_mkisofs`) so hybrid BIOS + UEFI (+ Secure Boot via the untouched shim/grub) is preserved; verify afterwards with `xorriso -indev OUT -report_el_torito plain` + `-report_system_area plain` (assert both a BIOS and an EFI boot image/partition exist). Output `claudeos-26.04.1-amd64.iso` + `.sha256`.
- Calamares contract: installer source is **`/cdrom/casper/filesystem.squashfs`** (`unpackfs`), `sourcefs: squashfs`. Calamares must not install `casper`, `calamares`, live autostarts into the target:
  `/usr/lib/claudeos/calamares/postinstall.sh` runs in the target chroot (`shellprocess`, `dontChroot: false`) and purges `casper calamares claudeos-installer ubuntu-desktop-bootstrap`-style live-only packages, removes `/etc/xdg/autostart/claudeos-installer.desktop`, runs `update-initramfs -u -k all`, enables first-boot.
- Live session: `/etc/xdg/autostart/claudeos-installer.desktop` (calamares-config) runs `/usr/lib/claudeos/calamares/launch-installer` only when `/cdrom/casper/filesystem.squashfs` exists and `boot=casper` is in `/proc/cmdline`; the first-boot wizard (system-config) must **not** run in the live session (same check). Calamares needs root on Wayland: `xhost +si:localuser:root`, `pkexec env DISPLAY=... XAUTHORITY=... QT_QPA_PLATFORM=xcb calamares`.
- GitHub release: `.github/workflows/build-iso.yml` triggers on tag push `v*` and `workflow_dispatch`; builds in `/mnt`-backed work dir after freeing disk; because of the 2 GiB per-asset limit it uploads `claudeos-26.04.1-amd64.iso.part-NN` (≤ 1.9 GiB each) + `SHA256SUMS` + `join` instructions, and also uploads the full ISO as a workflow artifact. `scripts/join-iso.sh` reassembles and verifies.

## C8. Theme contract (theme ↔ side-panel ↔ system-config)

| token | light | dark |
|---|---|---|
| background | `#F5F4EF` | `#262624` |
| surface (elevated cards, composer) | `#FFFFFF` | `#1E1E1C` |
| border (hairline) | `#E6E4DD` | `#383835` |
| accent (terracotta) | `#D97757` | `#D97757` |
| text | `#1F1E1D` | `#ECEAE3` |
| text-muted | `#6F6D66` | `#A5A39B` |

Fonts: assistant prose + greeting = serif stack `"Newsreader", "Tiempos Text", Georgia, serif`; UI + user bubbles = `"Inter", "Styrene B", system-ui, sans-serif`; code = `"JetBrains Mono", ui-monospace, monospace`. The panel bundles Inter/Newsreader/JetBrains Mono via `@fontsource/*` (works offline).
GNOME defaults (dconf, theme module values): `accent-color='orange'`, `color-scheme='default'` (light, user can switch), `picture-uri`/`picture-uri-dark` → `/usr/share/backgrounds/claudeos/claudeos-{light,dark}.png`, favorite apps include `claudeos-panel.desktop`, custom keybinding `<Super>c` → `claudeos-panel toggle`.
The panel follows the OS scheme (`nativeTheme` / `prefers-color-scheme`) unless the user overrides it in panel settings.

## C9. First-boot onboarding (system-config + side-panel)

`/etc/xdg/autostart/claudeos-firstboot.desktop` → `/usr/lib/claudeos/claudeos-firstboot`: exits immediately in the live session; if `~/.config/claudeos/onboarding-done` is absent **or** `claude auth status --json` says `loggedIn:false`, run `claudeos-panel onboarding`.
The wizard (React, in the panel app) steps: Welcome → Sign in with Claude (runs the C3 auth flow, shows the URL + code field + progress, never mentions API keys) → Computer-control check (runs `claudeos-doctor --json`, shows fixes) → Safety summary (what needs confirmation) → Done (writes the stamp via IPC, opens the panel). A terminal fallback `claudeos-login` does the same sign-in in a TTY.
`claudeos-doctor [--json]` checks: claude installed + version, auth status, `/dev/uinput` access, `ydotoold` socket, screenshot backend, MCP venv, panel binary, keybinding present, session type. Output `{checks:[{id,label,status:"ok|warn|fail",detail,fix}],ok}`.

## C10. Quality gates (what "done" means)

`make lint` and `make test` pass at repo root offline: `shellcheck` on every shell script, `ruff` on Python, `eslint` + `tsc --noEmit` on TypeScript, `yamllint` on YAML (root `.yamllint`), JSON validity, `vitest`/`pytest` suites green.
`scripts/build-iso.sh --dry-run` prints every step it would run, exits 0 without root or network. CI workflow YAML must parse (`yamllint` + `python -c 'yaml.safe_load'`).
