# Processing-element unit test: rtl/processing_element.sv against the clock-level PE model of
# @vcpu/accelerator-reference, one clock per vector line (tb/unit/tb_processing_element.sv).
#
# The vectors (the directed segments, then PE_RANDOM_CLOCKS random clocks from PE_SEED) are
# regenerated whenever the generator, the model or this file changes. test-pe also proves the
# harness can fail: test-pe-corrupt reruns the testbench on a copy of the vectors with the expected
# accumulator of the first wrapped clock (−2^31, in the overflow-up segment) changed by one, and
# requires a non-zero exit that names that line.

UNIT_TESTS += pe

PE_SEED          := 1
PE_RANDOM_CLOCKS := 20000

PE_VECTORS  := $(BUILD_DIR)/vectors/pe.vec
PE_REF_SRC  := $(REPO_ROOT)/packages/accelerator-reference/src
PE_GEN_DEPS := $(PE_REF_SRC)/harness/pe-vectors.ts $(PE_REF_SRC)/model/pe.ts \
               $(PE_REF_SRC)/model/matmul.ts $(PE_REF_SRC)/model/prng.ts $(PE_REF_SRC)/cli.ts \
               $(HW_DIR)/mk/unit-pe.mk
PE_TB       := $(HW_DIR)/tb/unit/tb_processing_element.sv
PE_TB_DIR   := $(BUILD_DIR)/unit/pe
PE_TB_BIN   := $(PE_TB_DIR)/Vtb_processing_element
PE_BAD_DIR  := $(BUILD_DIR)/unit/pe-corrupt

.PHONY: gen-pe-vectors test-pe test-pe-corrupt

gen-pe-vectors: $(PE_VECTORS) ## Generate build/vectors/pe.vec from the TypeScript PE model

$(PE_VECTORS): $(PE_GEN_DEPS)
	cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/accelerator-reference gen-pe-vectors \
	  --seed $(PE_SEED) --count $(PE_RANDOM_CLOCKS) --out $(PE_VECTORS)

$(PE_TB_BIN): $(RTL_PKGS) $(HW_DIR)/rtl/processing_element.sv $(PE_TB)
	$(call need,$(VERILATOR))
	@mkdir -p $(PE_TB_DIR)
	$(VERILATOR) --binary --timing --timescale 1ns/1ps -O3 -Wall -j 0 --top-module tb_processing_element \
	  -Mdir $(PE_TB_DIR) -CFLAGS -Wno-unknown-warning-option -o Vtb_processing_element \
	  $(RTL_PKGS) $(HW_DIR)/rtl/processing_element.sv $(PE_TB) > $(PE_TB_DIR).build.log

test-pe: $(PE_TB_BIN) $(PE_VECTORS) ## PE unit test: directed segments + 20,000 random clocks vs the TypeScript model
	$(PE_TB_BIN) +vectors=$(PE_VECTORS)
	@$(MAKE) --no-print-directory test-pe-corrupt

test-pe-corrupt: $(PE_TB_BIN) $(PE_VECTORS) ## Check a corrupted PE vector makes the test fail
	@mkdir -p $(PE_BAD_DIR)
	@line=$$(awk 'NF == 11 && $$7 == -2147483648 { print NR; exit }' $(PE_VECTORS)); \
	if [ -z "$$line" ]; then echo "test-pe-corrupt: no clock in $(PE_VECTORS) expects acc = -2147483648" >&2; exit 1; fi; \
	awk -v n=$$line 'NR == n { $$7 = $$7 + 1 } { print }' $(PE_VECTORS) > $(PE_BAD_DIR)/pe.vec; \
	if $(PE_TB_BIN) +vectors=$(PE_BAD_DIR)/pe.vec > $(PE_BAD_DIR)/run.log 2>&1; then \
	  echo "test-pe-corrupt: the testbench passed a corrupted vector; see $(PE_BAD_DIR)/run.log" >&2; exit 1; fi; \
	grep "^MISMATCH line $$line " $(PE_BAD_DIR)/run.log || { \
	  echo "test-pe-corrupt: the failure did not name line $$line; see $(PE_BAD_DIR)/run.log" >&2; exit 1; }; \
	echo "test-pe-corrupt: corrupting the expected wrapped accumulator on line $$line fails the test as it should"
