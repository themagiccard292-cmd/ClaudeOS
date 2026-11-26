# claudeos-theme

The warm Claude-inspired look of ClaudeOS: wallpapers, app icons, GNOME defaults and GTK colour overrides.
Palette and fonts are the C8 contract in `docs/ARCHITECTURE.md`; `usr/share/claudeos/theme/tokens.json` is the single
source and `scripts/gen_svgs.py` / `scripts/gen_gtk_css.py` derive the committed SVGs and CSS from it.

## What ships

| Path | Purpose |
|---|---|
| `usr/share/backgrounds/claudeos/claudeos-{light,dark}.{svg,png}` | 3840x2160 wallpapers, no text, PNGs < 1.2 MB |
| `usr/share/gnome-background-properties/claudeos.xml` | Settings > Appearance entry |
| `usr/share/icons/hicolor/...` | `claudeos-panel`, `claudeos-installer` (scalable + 48/64/128/256), `claudeos-panel-symbolic` |
| `usr/share/glib-2.0/schemas/90_claudeos.gschema.override` | accent, colour scheme, wallpaper, screensaver, favourite apps, mono font (no keybindings: system-config's dconf profile owns `<Super>c`) |
| `etc/skel/.config/gtk-{3,4}.0/gtk.css` | libadwaita / GTK colour overrides for new users; copies under `usr/share/claudeos/theme/` |
| `usr/lib/claudeos/theme-apply` | installs those files for existing users, backing up user-modified ones; idempotent |

## Develop

    make lint test           # offline; ruff, shellcheck, SVG/JSON/XML lint, generator freshness, pytest
    make generate            # regenerate SVG/CSS from tokens.json
    make assets              # re-render PNGs (needs global Playwright + Pillow); not part of lint/test
    DESTDIR=$(mktemp -d) make install

## Design notes and limitations

* Ubuntu sets favourites, wallpaper and mono font in `[schema:ubuntu]` groups, which beat plain groups, so the override
  repeats each key in both. Verified against fixture copies of the GNOME 50 schemas; `glib-compile-schemas` is only run
  in tests when installed.
* GTK 4.20+/libadwaita evaluate `@media (prefers-color-scheme: dark)` in the user stylesheet, so one `gtk.css` carries
  both palettes. No `gtk-dark.css` is shipped because neither GTK nor libadwaita loads a user file of that name. GTK 3 has
  no such media query, so its file only sets the (scheme-independent) accent.
* Not verified on a real GNOME 50 session or ISO boot; rendering was checked in Chromium only.
