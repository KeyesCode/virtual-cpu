# Unit tests for the state-holding modules: the register file, FLAGS and the memory. Each
# testbench is built with Verilator into build/unit/<name>/ and run; it exits non-zero on failure.

UNIT_TESTS += registers flags memory

UNIT_DIR    := $(BUILD_DIR)/unit
UNIT_VFLAGS := --binary --timing --timescale 1ns/1ps -Wall -j 0
UNIT_FIXTURE_HEX := $(REPO_ROOT)/fixtures/v1/example-01-addition.mem.hex

# `$(call unit_build,<name>,<testbench top>,<sources>,<extra flags>)`: build and run one testbench.
unit_build = mkdir -p $(UNIT_DIR)/$(1) && $(VERILATOR) $(UNIT_VFLAGS) $(4) --top-module $(2) -Mdir $(UNIT_DIR)/$(1) -o $(2) \
  $(RTL_PKGS) $(3) $(HW_DIR)/tb/unit/$(2).sv

.PHONY: test-registers test-flags test-memory

test-registers: ## Register file unit test (reset, writes, read-during-write, 10,000 random ops)
	$(call need,$(VERILATOR))
	$(call unit_build,registers,tb_vcpu8_registers,$(HW_DIR)/core/vcpu8_registers.sv,)
	$(UNIT_DIR)/registers/tb_vcpu8_registers

test-flags: ## FLAGS unit test (exhaustive old × mask × new, byte view, reset)
	$(call need,$(VERILATOR))
	$(call unit_build,flags,tb_vcpu8_flags,$(HW_DIR)/core/vcpu8_flags.sv,)
	$(UNIT_DIR)/flags/tb_vcpu8_flags

test-memory: ## Memory unit test (256 addresses, latency, read-first, INIT_FILE, reset)
	$(call need,$(VERILATOR))
	$(call unit_build,memory,tb_vcpu8_memory,$(HW_DIR)/core/vcpu8_memory.sv $(HW_DIR)/core/vcpu8_registers.sv,'-GFIXTURE_HEX="$(UNIT_FIXTURE_HEX)"')
	$(UNIT_DIR)/memory/tb_vcpu8_memory
