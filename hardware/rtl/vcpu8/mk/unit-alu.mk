# ALU unit test: core/vcpu8_alu.sv against every vector the TypeScript ALU produces.
#
# The vectors are regenerated whenever the generator, the TypeScript ALU or alu_op_t changes.
# test-alu also proves the harness can fail: it reruns the testbench on a copy of the vectors with
# one expected value corrupted and requires a non-zero exit that names that vector.

UNIT_TESTS += alu

ALU_VEC_DIR   := $(BUILD_DIR)/vectors
ALU_VECTORS   := $(ALU_VEC_DIR)/alu.hex
ALU_META      := $(ALU_VEC_DIR)/alu.meta
ALU_GEN_DEPS  := $(REPO_ROOT)/packages/rtl-tools/src/gen/alu-vectors.ts \
                 $(REPO_ROOT)/packages/rtl-tools/src/cli.ts \
                 $(REPO_ROOT)/packages/cpu-core/src/alu.ts \
                 $(HW_DIR)/core/vcpu8_types_pkg.sv
ALU_TB        := $(HW_DIR)/tb/unit/tb_vcpu8_alu.sv
ALU_TB_DIR    := $(BUILD_DIR)/unit/alu
ALU_TB_BIN    := $(ALU_TB_DIR)/Vtb_vcpu8_alu
ALU_BAD_DIR   := $(BUILD_DIR)/unit/alu-corrupt
# The record whose expected flags test-alu-corrupt flips: SUB 00-01, the 65,538th vector.
ALU_BAD_INDEX := 65537

.PHONY: gen-alu-vectors test-alu test-alu-corrupt

gen-alu-vectors: $(ALU_VECTORS) ## Generate build/vectors/alu.hex from the TypeScript ALU

$(ALU_VECTORS): $(ALU_GEN_DEPS)
	cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/rtl-tools gen:alu-vectors --out $(ALU_VECTORS)

$(ALU_META): $(ALU_VECTORS)

$(ALU_TB_BIN): $(RTL_PKGS) $(HW_DIR)/core/vcpu8_alu.sv $(ALU_TB)
	$(call need,$(VERILATOR))
	@mkdir -p $(ALU_TB_DIR)
	$(VERILATOR) --binary -O3 -Wall --top-module tb_vcpu8_alu -Mdir $(ALU_TB_DIR) \
	  -CFLAGS -Wno-unknown-warning-option -o Vtb_vcpu8_alu $(RTL_PKGS) $(HW_DIR)/core/vcpu8_alu.sv $(ALU_TB) > $(ALU_TB_DIR).build.log

test-alu: $(ALU_TB_BIN) $(ALU_VECTORS) $(ALU_META) ## Exhaustive ALU test against the TypeScript ALU
	$(ALU_TB_BIN) +vectors=$(ALU_VECTORS)
	@$(MAKE) --no-print-directory test-alu-corrupt

test-alu-corrupt: $(ALU_TB_BIN) $(ALU_VECTORS) $(ALU_META) ## Check a corrupted ALU vector makes the test fail
	@mkdir -p $(ALU_BAD_DIR)
	@cp $(ALU_META) $(ALU_BAD_DIR)/alu.meta
	@awk -v n=$(ALU_BAD_INDEX) 'NR == n + 1 { f = substr($$0, 9, 1); $$0 = substr($$0, 1, 8) (f == "0" ? "1" : "0") } { print }' \
	  $(ALU_VECTORS) > $(ALU_BAD_DIR)/alu.hex
	@if $(ALU_TB_BIN) +vectors=$(ALU_BAD_DIR)/alu.hex > $(ALU_BAD_DIR)/run.log 2>&1; then \
	  echo "test-alu-corrupt: the testbench passed a corrupted vector; see $(ALU_BAD_DIR)/run.log" >&2; exit 1; fi
	@grep "^MISMATCH vector $(ALU_BAD_INDEX): " $(ALU_BAD_DIR)/run.log || { \
	  echo "test-alu-corrupt: the failure did not name vector $(ALU_BAD_INDEX); see $(ALU_BAD_DIR)/run.log" >&2; exit 1; }
	@echo "test-alu-corrupt: a corrupted vector fails the test as it should"
