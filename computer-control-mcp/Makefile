# claudeos-computer-control: the `claudeos-desktop` MCP server.
#   make lint test                  offline after the first run (the test venv is bootstrapped once; needs PyPI)
#   make install DESTDIR=/tmp/root  stage the package payload

PREFIX     ?= /usr
DESTDIR    ?=
PYTHON     ?= python3
SHELLCHECK ?= shellcheck
VENV       := .venv
VPY        := $(VENV)/bin/python
LIBDIR     := $(DESTDIR)$(PREFIX)/lib/claudeos/computer-control

.PHONY: all lint test install clean venv

all: lint test

# Idempotent: only re-installs when requirements.txt/pyproject.toml change.
venv: $(VENV)/.stamp
$(VENV)/.stamp: requirements.txt pyproject.toml
	test -x $(VPY) || $(PYTHON) -m venv $(VENV)
	$(VPY) -m pip install --quiet --disable-pip-version-check -r requirements.txt pytest ruff
	touch $@

lint: venv
	$(VENV)/bin/ruff check .
	$(SHELLCHECK) bin/claudeos-computer-control-mcp setup-venv.sh debian/postinst

test: venv
	$(VPY) -m pytest -q

install:
	install -d -m 0755 $(LIBDIR) $(DESTDIR)$(PREFIX)/bin
	cp -r src $(LIBDIR)/src
	find $(LIBDIR)/src -name __pycache__ -type d -prune -exec rm -rf {} +
	install -m 0644 requirements.txt $(LIBDIR)/requirements.txt
	install -m 0755 setup-venv.sh $(LIBDIR)/setup-venv.sh
	install -m 0755 bin/claudeos-computer-control-mcp $(DESTDIR)$(PREFIX)/bin/claudeos-computer-control-mcp

clean:
	rm -rf .pytest_cache .ruff_cache $(VENV)
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
