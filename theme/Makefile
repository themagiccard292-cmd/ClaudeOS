# claudeos-theme: warm Claude-inspired desktop theme (see README.md).
PREFIX     ?= /usr
SYSCONFDIR ?= /etc
LIBDIR     ?= $(PREFIX)/lib
DESTDIR    ?=
PYTHON     ?= python3

# The in-tree files use the literal /usr prefix; rewrite it when PREFIX differs.
SUBST = sed 's|/usr/|$(PREFIX)/|g'

SHELL_SCRIPTS := usr/lib/claudeos/theme-apply debian/postinst debian/postrm

.PHONY: all lint test install generate assets clean

all: lint test

lint:
	ruff check scripts tests
	shellcheck $(SHELL_SCRIPTS)
	$(PYTHON) scripts/lint_data.py
	$(PYTHON) scripts/gen_svgs.py --check
	$(PYTHON) scripts/gen_gtk_css.py --check

test:
	$(PYTHON) -m pytest -q tests

install:
	install -d $(DESTDIR)$(PREFIX)/share/backgrounds/claudeos \
	           $(DESTDIR)$(PREFIX)/share/gnome-background-properties \
	           $(DESTDIR)$(PREFIX)/share/glib-2.0/schemas \
	           $(DESTDIR)$(PREFIX)/share/claudeos/theme/gtk-3.0 \
	           $(DESTDIR)$(PREFIX)/share/claudeos/theme/gtk-4.0 \
	           $(DESTDIR)$(LIBDIR)/claudeos \
	           $(DESTDIR)$(SYSCONFDIR)/skel/.config/gtk-3.0 \
	           $(DESTDIR)$(SYSCONFDIR)/skel/.config/gtk-4.0
	install -m 0644 usr/share/backgrounds/claudeos/*.svg usr/share/backgrounds/claudeos/*.png \
	        $(DESTDIR)$(PREFIX)/share/backgrounds/claudeos/
	$(SUBST) usr/share/gnome-background-properties/claudeos.xml \
	        > $(DESTDIR)$(PREFIX)/share/gnome-background-properties/claudeos.xml
	$(SUBST) usr/share/glib-2.0/schemas/90_claudeos.gschema.override \
	        > $(DESTDIR)$(PREFIX)/share/glib-2.0/schemas/90_claudeos.gschema.override
	chmod 0644 $(DESTDIR)$(PREFIX)/share/gnome-background-properties/claudeos.xml \
	        $(DESTDIR)$(PREFIX)/share/glib-2.0/schemas/90_claudeos.gschema.override
	install -m 0644 usr/share/claudeos/theme/tokens.json $(DESTDIR)$(PREFIX)/share/claudeos/theme/
	for v in 3.0 4.0; do \
	  install -m 0644 etc/skel/.config/gtk-$$v/gtk.css $(DESTDIR)$(SYSCONFDIR)/skel/.config/gtk-$$v/gtk.css; \
	  install -m 0644 etc/skel/.config/gtk-$$v/gtk.css $(DESTDIR)$(PREFIX)/share/claudeos/theme/gtk-$$v/gtk.css; \
	done
	$(SUBST) usr/lib/claudeos/theme-apply > $(DESTDIR)$(LIBDIR)/claudeos/theme-apply
	chmod 0755 $(DESTDIR)$(LIBDIR)/claudeos/theme-apply
	cd usr/share/icons/hicolor && find . -type f \( -name '*.svg' -o -name '*.png' \) | while read -r f; do \
	  install -D -m 0644 "$$f" "$(DESTDIR)$(PREFIX)/share/icons/hicolor/$$f"; \
	done

# Regenerate the committed SVG/CSS sources from tokens.json.
generate:
	$(PYTHON) scripts/gen_svgs.py
	$(PYTHON) scripts/gen_gtk_css.py

# Re-render the PNGs (needs node + a global Playwright, and Pillow); not part of lint/test.
assets: generate
	NODE_PATH="$$(npm root -g)" node scripts/render_assets.js \
	  usr/share/backgrounds/claudeos/claudeos-light.svg usr/share/backgrounds/claudeos/claudeos-light.png 3840 2160 \
	  usr/share/backgrounds/claudeos/claudeos-dark.svg usr/share/backgrounds/claudeos/claudeos-dark.png 3840 2160
	$(PYTHON) scripts/optimize_png.py --colors 120 usr/share/backgrounds/claudeos/*.png
	for n in panel installer; do for z in 48 64 128 256; do \
	  NODE_PATH="$$(npm root -g)" node scripts/render_assets.js \
	    usr/share/icons/hicolor/scalable/apps/claudeos-$$n.svg \
	    usr/share/icons/hicolor/$${z}x$${z}/apps/claudeos-$$n.png $$z $$z; \
	done; done
	$(PYTHON) scripts/optimize_png.py usr/share/icons/hicolor/*x*/apps/*.png

clean:
	$(PYTHON) -c "import shutil; [shutil.rmtree(d, ignore_errors=True) for d in ('.pytest_cache', '.ruff_cache', 'scripts/__pycache__', 'tests/__pycache__')]"
