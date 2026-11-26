# claudeos-side-panel: Electron panel + claudeos-panel launcher.
#   npm ci                          one-time prerequisite (install needs node_modules unless dist-package exists)
#   make lint test                  offline checks
#   make install DESTDIR=/tmp/root  stage the package payload (honours DESTDIR, PREFIX, SYSCONFDIR)

PREFIX     ?= /usr
SYSCONFDIR ?= /etc
DESTDIR    ?=
NPM        ?= npm
RUFF       ?= ruff
SHELLCHECK ?= shellcheck
PYTHON     ?= python3

APP_NAME := claudeos-panel-app
APP_DIR  := dist-package/$(APP_NAME)-linux-x64

.PHONY: all lint test install clean

all: lint test

lint:
	npx eslint .
	npx tsc --noEmit -p tsconfig.json
	npx tsc --noEmit -p tsconfig.main.json
	$(RUFF) check launcher
	$(SHELLCHECK) debian/postinst

test:
	npx vitest run
	$(PYTHON) -m pytest -q launcher/tests

install:
	test -d $(APP_DIR) || $(NPM) run package
	install -d -m 0755 $(DESTDIR)/opt/claudeos/panel
	cp -a $(APP_DIR)/. $(DESTDIR)/opt/claudeos/panel/
	chmod 0755 $(DESTDIR)/opt/claudeos/panel/$(APP_NAME)
	chmod 4755 $(DESTDIR)/opt/claudeos/panel/chrome-sandbox
	install -D -m 0755 launcher/claudeos-panel $(DESTDIR)$(PREFIX)/bin/claudeos-panel
	install -D -m 0644 desktop/claudeos-panel.desktop $(DESTDIR)$(PREFIX)/share/applications/claudeos-panel.desktop
	install -D -m 0644 desktop/apparmor/claudeos-panel $(DESTDIR)$(SYSCONFDIR)/apparmor.d/claudeos-panel

clean:
	rm -rf dist dist-package .pytest_cache .ruff_cache launcher/__pycache__ launcher/tests/__pycache__
