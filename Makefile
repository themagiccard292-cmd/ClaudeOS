# ClaudeOS root Makefile. Each module owns its own Makefile (lint/test/install/clean).
MODULES := side-panel nautilus-extension computer-control-mcp calamares-config system-config theme iso-builder
VERSION := $(shell cat VERSION)

.PHONY: help lint test ci lint-repo debs iso clean $(addprefix lint-,$(MODULES)) $(addprefix test-,$(MODULES))

help:
	@echo "make lint      - lint every module + repo-wide shell/yaml/json checks"
	@echo "make test      - run every module's test suite (offline)"
	@echo "make ci        - lint + test"
	@echo "make debs      - build .deb packages into iso-builder/out/debs"
	@echo "make iso       - build claudeos-$(VERSION)-amd64.iso (needs root, network, ~40 GB)"
	@echo "make clean"

lint: lint-repo $(addprefix lint-,$(MODULES))
test: $(addprefix test-,$(MODULES))
ci: lint test

$(addprefix lint-,$(MODULES)): lint-%:
	$(MAKE) -C $* lint

$(addprefix test-,$(MODULES)): test-%:
	$(MAKE) -C $* test

lint-repo:
	bash scripts/lint-all.sh

debs:
	bash iso-builder/build-debs.sh

iso:
	sudo bash scripts/build-iso.sh

clean:
	@for m in $(MODULES); do $(MAKE) -C $$m clean || true; done
