# INT8 matmul accelerator (Project 3) build. Run `make -C hardware/accelerators/matmul help` for
# the targets; docs/hardware/accelerators/architecture.md is the design contract.
#
# Tickets add targets as fragments in mk/<topic>.mk, which are included below, and register unit
# tests by appending to UNIT_TESTS (`UNIT_TESTS += pe` plus a `test-pe` target), so no two tickets
# edit the same lines of this file. Whole-accelerator checks append their target name to
# SYSTEM_TESTS; `make test` runs them after the unit tests. Outputs go to build/, which is
# git-ignored.

HW_DIR    := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
REPO_ROOT := $(abspath $(HW_DIR)/../../..)
BUILD_DIR := $(HW_DIR)/build

# Toolchain: the pinned OSS CAD Suite installed by `pnpm hardware:setup` (shared with VCPU-8), if
# present; otherwise whatever is on PATH. Tools are named by absolute path because GNU Make 3.81
# (the macOS default) runs simple recipe lines without a shell and looks them up on the original
# PATH; the exported PATH still reaches scripts and tools that call other tools.
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

# `$(call need,<tool>)`: fail with a pointer to the installer when a tool is missing.
need = @command -v $(1) > /dev/null 2>&1 || { \
  echo "$(1) not found. Run 'pnpm hardware:setup' to install OSS CAD Suite $(OSS_CAD_SUITE_VERSION) into $(OSS_CAD_SUITE_DIR)." >&2; \
  exit 127; }

# The architecture revision every report records (see research/accelerators/matmul/README.md).
REVISION := $(shell cat $(HW_DIR)/REVISION)

# Array size: ROWS × COLS processing elements, one RTL for every size. The three required
# configurations are ROWS=4, 8 and 16 (square). They become the ROWS and COLS parameters of the
# tops (-G for Verilator, chparam for Yosys), and every per-size build directory carries SIZE as
# a suffix (build/sim-8x8/, build/synth-16x16/, …), so sizes never overwrite each other.
ROWS ?= 4
COLS ?= $(ROWS)
SIZE := $(ROWS)x$(COLS)
SIZE_GFLAGS := -GROWS=$(ROWS) -GCOLS=$(COLS)

# RTL sources: packages first, then every other rtl/*.sv, so new modules need no list edits.
RTL_PKGS := $(sort $(wildcard $(HW_DIR)/rtl/*_pkg.sv))
RTL_SRCS := $(RTL_PKGS) $(sort $(filter-out $(RTL_PKGS),$(wildcard $(HW_DIR)/rtl/*.sv)))

# Lint the whole accelerator from matmul_top at the chosen size once it exists; until then, lint
# whatever rtl/ holds (the packages) on its own.
ifneq ($(wildcard $(HW_DIR)/rtl/matmul_top.sv),)
  LINT_FLAGS := --lint-only -Wall --top-module matmul_top $(SIZE_GFLAGS)
else
  LINT_FLAGS := --lint-only -Wall
endif

UNIT_TESTS   :=
SYSTEM_TESTS :=

.DEFAULT_GOAL := help

include $(sort $(wildcard $(HW_DIR)/mk/*.mk))

.PHONY: help tools-check lint test clean

help: ## List the targets
	@echo "INT8 matmul accelerator $(REVISION), $(SIZE) array (toolchain: $(TOOLCHAIN))"
	@echo "Pick the array size with ROWS=4|8|16 (COLS defaults to ROWS)."
	@echo
	@grep -h -E '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | sort | \
	  awk 'BEGIN { FS = ":.*## " } { printf "  %-14s %s\n", $$1, $$2 }'

tools-check: ## Print the tool versions and write build/tool-versions.json
	@mkdir -p $(BUILD_DIR)
	@TOOLCHAIN='$(TOOLCHAIN)' OSS_CAD_SUITE_VERSION='$(OSS_CAD_SUITE_VERSION)' \
	  bash $(REPO_ROOT)/hardware/rtl/vcpu8/scripts/tool-versions.sh $(BUILD_DIR)/tool-versions.json

lint: ## Verilator --lint-only -Wall over every rtl/*.sv (from matmul_top at ROWS x COLS)
	$(call need,$(VERILATOR))
	$(VERILATOR) $(LINT_FLAGS) $(RTL_SRCS)

test: ## Run every registered unit test (UNIT_TESTS), then the system tests (SYSTEM_TESTS)
ifeq ($(strip $(UNIT_TESTS)),)
	@echo "0 unit tests registered"
else
	@set -e; for t in $(UNIT_TESTS); do $(MAKE) --no-print-directory test-$$t; done
	@echo "$(words $(UNIT_TESTS)) unit tests passed: $(UNIT_TESTS)"
endif
	@set -e; for t in $(SYSTEM_TESTS); do $(MAKE) --no-print-directory $$t; done

clean: ## Remove build/
	rm -rf $(BUILD_DIR)
