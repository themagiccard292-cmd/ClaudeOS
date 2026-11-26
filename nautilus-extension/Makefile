# claudeos-nautilus: the "Ask Claude" extension for GNOME Files.
#   make lint test                  offline checks (ruff, shellcheck, desktop-entry validation, pytest)
#   make install DESTDIR=/tmp/root  stage the package payload (honours DESTDIR and PREFIX)

PREFIX  ?= /usr
DESTDIR ?=
PYTHON  ?= python3
RUFF    ?= ruff
SHELLCHECK ?= shellcheck

EXTENSION_DIR   := $(DESTDIR)$(PREFIX)/share/nautilus-python/extensions
APPLICATION_DIR := $(DESTDIR)$(PREFIX)/share/applications

EXTENSION := claudeos_ask_claude.py
DESKTOP   := claudeos-ask-claude.desktop

.PHONY: all lint lint-python lint-shell lint-desktop test install clean

all: lint test

lint: lint-python lint-shell lint-desktop

lint-python:
	$(RUFF) check .

lint-shell:
	$(SHELLCHECK) debian/postinst

# desktop-file-validate when installed, plus the strict built-in validator (always).
lint-desktop:
	$(PYTHON) scripts/validate_desktop.py $(DESKTOP)

test:
	$(PYTHON) -m pytest

install:
	install -d -m 0755 $(EXTENSION_DIR) $(APPLICATION_DIR)
	install -m 0644 $(EXTENSION) $(EXTENSION_DIR)/$(EXTENSION)
	install -m 0644 $(DESKTOP) $(APPLICATION_DIR)/$(DESKTOP)

clean:
	rm -rf .pytest_cache .ruff_cache __pycache__ tests/__pycache__ scripts/__pycache__
