# nautilus-extension: "Ask Claude" for GNOME Files

Right-click anything in GNOME Files (Nautilus 50, GTK4/libadwaita) and choose **Ask Claude**: the docked
Claude side panel opens with the selection attached to the composer. Deb package: `claudeos-nautilus`
(`Depends: python3-nautilus, claudeos-side-panel`).

| File | Installed to | Purpose |
|---|---|---|
| `claudeos_ask_claude.py` | `/usr/share/nautilus-python/extensions/` | `nautilus-python` `MenuProvider` that adds the menu item |
| `claudeos-ask-claude.desktop` | `/usr/share/applications/` | "Open With" entry for other file managers |
| `debian/postinst` | maintainer script | prints a restart hint, always exits 0 |
| `scripts/validate_desktop.py` | not installed | strict desktop-entry validator used by `make lint` |

## How it works

`get_file_items(files)` (Nautilus 4; the 3.x `(window, files)` form is tolerated) and
`get_background_items(current_folder)` return one `Nautilus.MenuItem` named `ClaudeOS::AskClaude`, labelled
"Ask Claude", icon `claudeos-panel` (shipped by the theme package). It appears for any selection (files,
folders, multi-select, mixed) and for the empty folder background, where it attaches the current folder.

Each item is turned into a local path with `Gio.File.get_path()`, which handles spaces, unicode, `%20` and
gvfs FUSE paths. Items without a local path (`trash:///`, `recent:///`, unmounted `smb://`/`sftp://`...) are
skipped, duplicates are dropped, order is kept, and with no local path left the menu item is not shown.

Activation runs exactly the ARCHITECTURE C2 command, as a list-form `subprocess.Popen` (no shell,
`start_new_session=True`, stdin/stdout/stderr to `/dev/null`):

```
claudeos-panel attach -- /abs/path/one "/abs/path/two with spaces" ...
```

The launcher is found with `shutil.which("claudeos-panel")`, then `/usr/bin/claudeos-panel`. At most 64 paths
are sent; a larger selection is truncated with a log line and a `notify-send` notification. The extension
never raises into Nautilus (errors go to stderr, i.e. the journal), never blocks the file manager (the child
is reaped on a daemon thread) and imports cleanly without PyGObject, so its helpers are unit-testable.

The `.desktop` entry uses `Exec=claudeos-panel attach -- %F` with `MimeType` covering directories, text,
images, PDF, archives, JSON, shell scripts, audio and video. Nemo and Thunar users can reach it via
"Open With". Dedicated Nemo/Thunar actions were left out: their argument quoting could not be verified here.

## Develop and test

```
make lint     # ruff + shellcheck + desktop-entry validation
make test     # pytest, offline, against a fake gi
make install DESTDIR=/tmp/stage   # stage the package payload
```

`desktop-file-validate` is used when installed; the built-in validator always runs, so the result is the same
on a bare machine. The tests replace `gi`, `Nautilus`, `GObject`, `Gio` and `GLib` with fakes and
`subprocess.Popen` with a recorder (one test runs a real throwaway script to prove hostile file names such as
`x; rm -rf ~` or `$(cmd)` stay inert).

Manual check on a ClaudeOS machine: `sudo apt install python3-nautilus`, install the package, run `nautilus -q`,
right-click a file. To debug, run `nautilus` from a terminal and watch stderr.

## Known limitations

- Not exercised against a real Nautilus 50 session: the fakes follow the documented `nautilus-python` 4.x API
  (`MenuProvider`, keyword-only `MenuItem`), but menu rendering in a live Files window is unverified.
- Nautilus loads extensions at start-up, so a running Files needs `nautilus -q` (or a log out and in) after install.
- `NoDisplay=false` also lists "Ask Claude" in the Activities grid; started from there it runs
  `claudeos-panel attach --` with no paths, which the launcher must treat as "show the panel".
- The 64-path cap and the "no local path" rule mean remote-only selections (e.g. an unmounted `smb://` share)
  show no menu item; mount the location in Files first.
