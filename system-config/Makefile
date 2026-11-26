# claudeos-core: OS integration layer.
PREFIX     ?= /usr
SYSCONFDIR ?= /etc
LIBDIR     ?= $(PREFIX)/lib
DESTDIR    ?=
PYTHON     ?= python3
SHELL_SCRIPTS := usr/lib/claudeos/install-claude-code.sh usr/lib/claudeos/claudeos-firstboot \
  usr/lib/claudeos/apply-branding.sh usr/bin/claudeos-update usr/bin/claudeos-login \
  debian/postinst debian/prerm debian/postrm
PY_SCRIPTS := usr/lib/claudeos/claudeos-doctor usr/lib/claudeos/claudeos-session-init
JSON_FILES := etc/claude-code/managed-settings.json etc/claudeos/mcp.json

.PHONY: lint test install clean schema

lint:
	shellcheck $(SHELL_SCRIPTS)
	ruff check --config ../ruff.toml $(PY_SCRIPTS) tests
	@for f in $(JSON_FILES); do jq empty $$f || exit 1; done

test:
	$(PYTHON) -m pytest -q tests

# Refresh the cached settings schema (needs network).
schema:
	curl -sSLf -o tests/fixtures/claude-code-settings.schema.json https://json.schemastore.org/claude-code-settings.json

install:
	install -d $(DESTDIR)$(SYSCONFDIR)/claude-code $(DESTDIR)$(SYSCONFDIR)/claudeos \
	  $(DESTDIR)$(SYSCONFDIR)/dconf/profile $(DESTDIR)$(SYSCONFDIR)/dconf/db/claudeos.d \
	  $(DESTDIR)$(SYSCONFDIR)/environment.d $(DESTDIR)$(SYSCONFDIR)/skel/.config \
	  $(DESTDIR)$(SYSCONFDIR)/xdg/autostart $(DESTDIR)$(PREFIX)/bin $(DESTDIR)$(LIBDIR)/claudeos \
	  $(DESTDIR)$(LIBDIR)/modules-load.d $(DESTDIR)$(LIBDIR)/systemd/user \
	  $(DESTDIR)$(LIBDIR)/udev/rules.d $(DESTDIR)$(PREFIX)/share/claudeos/branding
	install -m 0644 etc/claude-code/CLAUDE.md etc/claude-code/managed-settings.json $(DESTDIR)$(SYSCONFDIR)/claude-code/
	install -m 0644 etc/claudeos/mcp.json $(DESTDIR)$(SYSCONFDIR)/claudeos/
	install -m 0644 etc/dconf/profile/user $(DESTDIR)$(SYSCONFDIR)/dconf/profile/
	install -m 0644 etc/dconf/db/claudeos.d/20-claudeos-keybindings $(DESTDIR)$(SYSCONFDIR)/dconf/db/claudeos.d/
	install -m 0644 etc/environment.d/60-claudeos.conf $(DESTDIR)$(SYSCONFDIR)/environment.d/
	install -m 0644 etc/skel/.config/gnome-initial-setup-done $(DESTDIR)$(SYSCONFDIR)/skel/.config/
	install -m 0644 etc/xdg/autostart/*.desktop $(DESTDIR)$(SYSCONFDIR)/xdg/autostart/
	install -m 0755 usr/bin/claudeos-update usr/bin/claudeos-login $(DESTDIR)$(PREFIX)/bin/
	install -m 0755 usr/lib/claudeos/* $(DESTDIR)$(LIBDIR)/claudeos/
	install -m 0644 usr/lib/modules-load.d/claudeos-uinput.conf $(DESTDIR)$(LIBDIR)/modules-load.d/
	install -m 0644 usr/lib/systemd/user/ydotoold.service $(DESTDIR)$(LIBDIR)/systemd/user/
	install -m 0644 usr/lib/udev/rules.d/60-claudeos-uinput.rules $(DESTDIR)$(LIBDIR)/udev/rules.d/
	install -m 0644 usr/share/claudeos/branding/* $(DESTDIR)$(PREFIX)/share/claudeos/branding/

clean:
	rm -rf .pytest_cache tests/__pycache__ .ruff_cache
