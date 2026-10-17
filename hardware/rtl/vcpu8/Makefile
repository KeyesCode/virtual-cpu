# VCPU-8 RTL build. Run `make -C hardware/rtl/vcpu8 help` for the targets.
#
# Tickets add targets as fragments in mk/<topic>.mk, which are included below, and register unit
# tests by appending to UNIT_TESTS (`UNIT_TESTS += regfile` plus a `test-regfile` target), so no
# two tickets edit the same lines of this file. Outputs go to build/, which is git-ignored.

HW_DIR    := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
REPO_ROOT := $(abspath $(HW_DIR)/../../..)
BUILD_DIR := $(HW_DIR)/build

# Toolchain: the pinned OSS CAD Suite installed by `pnpm hardware:setup`, if present; otherwise
# whatever is on PATH. Tools are named by absolute path because GNU Make 3.81 (the macOS default)
# runs simple recipe lines without a shell and looks them up on the original PATH; the exported
# PATH still reaches scripts and tools that call other tools (sby runs yosys and the solvers).
include $(REPO_ROOT)/hardware/toolchain.env
VCPU8_TOOLS_DIR   ?= $(HOME)/.cache/vcpu8
OSS_CAD_SUITE_DIR ?= $(VCPU8_TOOLS_DIR)/oss-cad-suite-$(OSS_CAD_SUITE_VERSION)
ifneq ($(wildcard $(OSS_CAD_SUITE_DIR)/bin/yosys),)
  export PATH := $(OSS_CAD_SUITE_DIR)/bin:$(PATH)
  TOOLCHAIN := $(OSS_CAD_SUITE_DIR)
  TOOL_BIN  := $(OSS_CAD_SUITE_DIR)/bin/
else
  TOOLCHAIN := PATH
  TOOL_BIN  :=
endif

VERILATOR ?= $(TOOL_BIN)verilator
YOSYS     ?= $(TOOL_BIN)yosys
SBY       ?= $(TOOL_BIN)sby

# `$(call need,<tool>)`: fail with a pointer to the installer when a tool is missing.
need = @command -v $(1) > /dev/null 2>&1 || { \
  echo "$(1) not found. Run 'pnpm hardware:setup' to install OSS CAD Suite $(OSS_CAD_SUITE_VERSION) into $(OSS_CAD_SUITE_DIR)." >&2; \
  exit 127; }

# RTL sources: packages first, then every other core/*.sv, so new modules need no list edits.
RTL_PKGS := $(sort $(wildcard $(HW_DIR)/core/*_pkg.sv))
RTL_SRCS := $(RTL_PKGS) $(sort $(filter-out $(RTL_PKGS),$(wildcard $(HW_DIR)/core/*.sv)))

# -Wno-MULTITOP: lint reads every core module at once, and until vcpu8_top instantiates them each
# one is its own top.
LINT_FLAGS := --lint-only -Wall -Wno-MULTITOP

UNIT_TESTS :=

.DEFAULT_GOAL := help

include $(sort $(wildcard $(HW_DIR)/mk/*.mk))

.PHONY: help tools-check lint test clean

help: ## List the targets
	@echo "VCPU-8 RTL (toolchain: $(TOOLCHAIN))"
	@echo
	@grep -h -E '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | sort | \
	  awk 'BEGIN { FS = ":.*## " } { printf "  %-14s %s\n", $$1, $$2 }'

tools-check: ## Print the tool versions and write build/tool-versions.json
	@mkdir -p $(BUILD_DIR)
	@TOOLCHAIN='$(TOOLCHAIN)' OSS_CAD_SUITE_VERSION='$(OSS_CAD_SUITE_VERSION)' \
	  bash $(HW_DIR)/scripts/tool-versions.sh $(BUILD_DIR)/tool-versions.json

lint: ## Verilator --lint-only -Wall over every core/*.sv
	$(call need,$(VERILATOR))
	$(VERILATOR) $(LINT_FLAGS) $(RTL_SRCS)

test: ## Run every registered unit test (UNIT_TESTS)
ifeq ($(strip $(UNIT_TESTS)),)
	@echo "0 unit tests registered"
else
	@set -e; for t in $(UNIT_TESTS); do $(MAKE) --no-print-directory test-$$t; done
	@echo "$(words $(UNIT_TESTS)) unit tests passed: $(UNIT_TESTS)"
endif

clean: ## Remove build/
	rm -rf $(BUILD_DIR)
