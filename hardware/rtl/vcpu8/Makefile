# VCPU-8 RTL build. Run `make -C hardware/rtl/vcpu8 help` for the targets.
#
# Tickets add targets as fragments in mk/<topic>.mk, which are included below, and register unit
# tests by appending to UNIT_TESTS (`UNIT_TESTS += regfile` plus a `test-regfile` target), so no
# two tickets edit the same lines of this file. Whole-CPU checks append their target name to
# SYSTEM_TESTS (`SYSTEM_TESTS += fixtures`); `make test` runs them after the unit tests. Outputs go
# to build/, which is git-ignored.

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

# Divider implementation: DIV_IMPL=COMB (the default, the v1 design) or DIV_IMPL=ITER, the
# iterative vcpu8_divider (research/cpu/experiments/div-impl/). It becomes the integer parameter
# DIV_ITER of the tops (-G for Verilator, chparam for Yosys). sim, simulate, fixtures, verify,
# benchmark, wave, lint, synth and formal accept it; a non-default build gets its own directory
# (build/sim-div-iter/, build/synth-div-iter/, …), so the two never overwrite each other.
DIV_IMPL ?= COMB
ifeq ($(DIV_IMPL),COMB)
  DIV_ITER := 0
else ifeq ($(DIV_IMPL),ITER)
  DIV_ITER := 1
else
  $(error DIV_IMPL must be COMB or ITER, not '$(DIV_IMPL)')
endif
# Build-directory suffix and Verilator flag: empty for the default, so its paths and commands are
# exactly as before.
VARIANT_SUFFIX := $(if $(filter 1,$(DIV_ITER)),-div-iter)
VARIANT_GFLAGS := $(if $(filter 1,$(DIV_ITER)),-GDIV_ITER=1)

LINT_FLAGS := --lint-only -Wall --top-module vcpu8_top $(VARIANT_GFLAGS)

UNIT_TESTS   :=
SYSTEM_TESTS :=

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
