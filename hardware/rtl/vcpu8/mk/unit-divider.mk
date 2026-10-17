# Divider unit test: core/vcpu8_divider.sv, the iterative divider of DIV_IMPL=ITER, against the
# quotient @vcpu/cpu-core's div() gives for every (a, b != 0) pair, with its remainder and its
# start/busy/done handshake checked as well (tb/unit/tb_vcpu8_divider.sv). It runs whatever
# DIV_IMPL is, since the module is the same either way.
#
# The vectors are regenerated whenever the generator or the TypeScript ALU changes.

UNIT_TESTS += divider

DIV_VECTORS  := $(BUILD_DIR)/vectors/div.hex
DIV_META     := $(BUILD_DIR)/vectors/div.meta
DIV_GEN_DEPS := $(REPO_ROOT)/packages/rtl-tools/src/gen/div-vectors.ts \
                $(REPO_ROOT)/packages/rtl-tools/src/cli.ts \
                $(REPO_ROOT)/packages/cpu-core/src/alu.ts
DIV_TB       := $(HW_DIR)/tb/unit/tb_vcpu8_divider.sv
DIV_TB_DIR   := $(BUILD_DIR)/unit/divider
DIV_TB_BIN   := $(DIV_TB_DIR)/Vtb_vcpu8_divider

.PHONY: gen-div-vectors test-divider

gen-div-vectors: $(DIV_VECTORS) ## Generate build/vectors/div.hex from the TypeScript ALU's div

$(DIV_VECTORS): $(DIV_GEN_DEPS)
	cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/rtl-tools gen:div-vectors --out $(DIV_VECTORS)

$(DIV_META): $(DIV_VECTORS)

$(DIV_TB_BIN): $(HW_DIR)/core/vcpu8_divider.sv $(DIV_TB)
	$(call need,$(VERILATOR))
	@mkdir -p $(DIV_TB_DIR)
	$(VERILATOR) --binary --timing -O3 -Wall --top-module tb_vcpu8_divider -Mdir $(DIV_TB_DIR) \
	  -CFLAGS -Wno-unknown-warning-option -o Vtb_vcpu8_divider $(HW_DIR)/core/vcpu8_divider.sv $(DIV_TB) > $(DIV_TB_DIR).build.log

test-divider: $(DIV_TB_BIN) $(DIV_VECTORS) $(DIV_META) ## Exhaustive iterative-divider test: 65,280 vectors and the handshake
	$(DIV_TB_BIN) +vectors=$(DIV_VECTORS)
