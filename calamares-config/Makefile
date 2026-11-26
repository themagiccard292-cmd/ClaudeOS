# calamares-config: lint / test / install / clean
PREFIX ?= /usr
SYSCONFDIR ?= /etc
DESTDIR ?=
PYTHON ?= python3
SHELL_SCRIPTS := usr/lib/claudeos/calamares/postinstall.sh usr/lib/claudeos/calamares/launch-installer debian/postinst

.PHONY: lint test install clean

lint:
	yamllint -c ../.yamllint etc usr
	shellcheck $(SHELL_SCRIPTS)
	ruff check tests

test:
	$(PYTHON) -m pytest -q tests

install:
	install -d $(DESTDIR)$(SYSCONFDIR)/calamares/modules $(DESTDIR)$(SYSCONFDIR)/xdg/autostart
	install -m 0644 etc/calamares/settings.conf $(DESTDIR)$(SYSCONFDIR)/calamares/
	install -m 0644 etc/calamares/modules/*.conf $(DESTDIR)$(SYSCONFDIR)/calamares/modules/
	install -m 0644 etc/xdg/autostart/claudeos-installer.desktop $(DESTDIR)$(SYSCONFDIR)/xdg/autostart/
	install -d $(DESTDIR)$(PREFIX)/lib/claudeos/calamares $(DESTDIR)$(PREFIX)/share/applications
	install -m 0755 usr/lib/claudeos/calamares/postinstall.sh usr/lib/claudeos/calamares/launch-installer $(DESTDIR)$(PREFIX)/lib/claudeos/calamares/
	install -m 0644 usr/share/applications/claudeos-install.desktop $(DESTDIR)$(PREFIX)/share/applications/
	install -d $(DESTDIR)$(PREFIX)/share/calamares/branding/claudeos $(DESTDIR)$(PREFIX)/share/icons/hicolor/scalable/apps
	install -m 0644 usr/share/calamares/branding/claudeos/* $(DESTDIR)$(PREFIX)/share/calamares/branding/claudeos/
	install -m 0644 usr/share/icons/hicolor/scalable/apps/claudeos-installer.svg $(DESTDIR)$(PREFIX)/share/icons/hicolor/scalable/apps/

clean:
	rm -rf .pytest_cache .ruff_cache tests/__pycache__
