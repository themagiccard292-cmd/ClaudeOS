# iso-builder: deb packaging, ISO pipeline (scripts/build-iso.sh) and CI (.github/).
PREFIX ?= /usr
SYSCONFDIR ?= /etc
DESTDIR ?=
REPO_ROOT := $(abspath ..)
VENV := .venv
PYTHON := $(if $(wildcard $(VENV)/bin/python),$(VENV)/bin/python,python3)
RUFF := $(if $(wildcard $(VENV)/bin/ruff),$(VENV)/bin/ruff,ruff)

SHELL_SOURCES := build-debs.sh $(wildcard lib/*.sh) config/build.conf \
	$(wildcard $(REPO_ROOT)/scripts/*.sh)
PY_SOURCES := lib tests $(REPO_ROOT)/scripts
WORKFLOWS := $(wildcard $(REPO_ROOT)/.github/workflows/*.yml)

.PHONY: all bootstrap lint test test-integration install clean

all: lint test

# One-time: a venv with the test/lint tools (pytest, PyYAML, ruff). Not needed if they are installed system-wide.
bootstrap:
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install --quiet -r requirements-dev.txt

lint:
	shellcheck -x --source-path=$(REPO_ROOT) $(SHELL_SOURCES)
	$(RUFF) check --config $(REPO_ROOT)/ruff.toml $(PY_SOURCES)
	yamllint -c $(REPO_ROOT)/.yamllint $(WORKFLOWS)
	$(PYTHON) -c 'import sys, yaml; [yaml.safe_load(open(f)) for f in sys.argv[1:]]' $(WORKFLOWS)

# Unit tests: offline, no root, no real xorriso/mksquashfs runs.
test:
	$(PYTHON) -m pytest -q -m "not integration" tests

# Synthetic-ISO integration test: needs root, xorriso, squashfs-tools, rsync and overlay/loop mounts.
test-integration:
	$(PYTHON) -m pytest -q -m integration tests

# Payload of the claudeos-desktop meta package (built by build-debs.sh).
install:
	install -D -m 0644 config/claudeos-desktop.README \
		$(DESTDIR)$(PREFIX)/share/doc/claudeos-desktop/README

clean:
	rm -rf out .pytest_cache tests/__pycache__ lib/__pycache__
