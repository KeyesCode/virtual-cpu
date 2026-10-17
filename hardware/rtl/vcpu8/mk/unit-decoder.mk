# Decoder unit test: tb/unit/tb_vcpu8_decoder.sv checks core/vcpu8_decoder.sv against vectors that
# @vcpu/rtl-tools derives from the TypeScript ISA (decoder-ops.hex) and from cpu-core decode()
# (decoder-rb.hex), plus the 30-row decoder table of docs/hardware-porting.md.

DECODER_VECTORS_DIR := $(BUILD_DIR)/vectors
DECODER_OPS_HEX     := $(DECODER_VECTORS_DIR)/decoder-ops.hex
DECODER_RB_HEX      := $(DECODER_VECTORS_DIR)/decoder-rb.hex
DECODER_STAMP       := $(DECODER_VECTORS_DIR)/decoder.stamp
DECODER_BUILD_DIR   := $(BUILD_DIR)/unit/decoder
DECODER_SIM         := $(DECODER_BUILD_DIR)/Vtb_vcpu8_decoder
DECODER_RTL         := $(HW_DIR)/core/vcpu8_decoder.sv
DECODER_TB          := $(HW_DIR)/tb/unit/tb_vcpu8_decoder.sv
DECODER_SRCS        := $(RTL_PKGS) $(DECODER_RTL) $(DECODER_TB)
DECODER_MUTANT_DIR  := $(BUILD_DIR)/unit/decoder-mutant
DECODER_MUTANT_RTL  := $(DECODER_MUTANT_DIR)/vcpu8_decoder.sv
DECODER_MUTANT_SIM  := $(DECODER_MUTANT_DIR)/obj/Vtb_vcpu8_decoder

# The vectors are regenerated when the generator, the ISA or cpu-core changes.
DECODER_VECTOR_DEPS := $(wildcard $(REPO_ROOT)/packages/rtl-tools/src/gen/*.ts \
                                  $(REPO_ROOT)/packages/shared/src/isa/*.ts \
                                  $(REPO_ROOT)/packages/cpu-core/src/*.ts)

UNIT_TESTS += decoder

.PHONY: gen-decoder-vectors test-decoder test-decoder-mutant

gen-decoder-vectors: $(DECODER_STAMP) ## Write the decoder test vectors to build/vectors/

# One generator run writes both files; the stamp stands for the pair.
$(DECODER_STAMP): $(DECODER_VECTOR_DEPS)
	cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/rtl-tools gen:decoder-vectors --out-dir $(DECODER_VECTORS_DIR)
	@touch $@

$(DECODER_SIM): $(DECODER_SRCS)
	$(call need,$(VERILATOR))
	@mkdir -p $(DECODER_BUILD_DIR)
	$(VERILATOR) --binary --timing --quiet -Wall --top-module tb_vcpu8_decoder \
	  -Mdir $(DECODER_BUILD_DIR) -o Vtb_vcpu8_decoder $(DECODER_SRCS)

test-decoder: $(DECODER_SIM) $(DECODER_STAMP) ## Decoder: 256 opcodes, 65,536 register bytes, 30 directed rows
	$(DECODER_SIM) +ops=$(DECODER_OPS_HEX) +rb=$(DECODER_RB_HEX)

# Mutation check: a copy of the decoder in build/ with PUSH's stack_op changed to STACK_NONE must
# make the testbench fail and name PUSH. The source in core/ is never touched.
test-decoder-mutant: $(DECODER_STAMP) ## Prove the decoder test fails, naming PUSH, on a broken PUSH row
	$(call need,$(VERILATOR))
	@mkdir -p $(DECODER_MUTANT_DIR)/obj
	sed '/OP_PUSH: begin/,/end/s/STACK_PUSH/STACK_NONE/' $(DECODER_RTL) > $(DECODER_MUTANT_RTL)
	@if cmp -s $(DECODER_RTL) $(DECODER_MUTANT_RTL); then \
	  echo "test-decoder-mutant: the mutation did not apply to $(DECODER_RTL)" >&2; exit 1; fi
	$(VERILATOR) --binary --timing --quiet -Wall --top-module tb_vcpu8_decoder \
	  -Mdir $(DECODER_MUTANT_DIR)/obj -o Vtb_vcpu8_decoder $(RTL_PKGS) $(DECODER_MUTANT_RTL) $(DECODER_TB)
	@if $(DECODER_MUTANT_SIM) +ops=$(DECODER_OPS_HEX) +rb=$(DECODER_RB_HEX) > $(DECODER_MUTANT_DIR)/run.log 2>&1; then \
	  cat $(DECODER_MUTANT_DIR)/run.log; \
	  echo "test-decoder-mutant: the testbench passed a decoder whose PUSH row is broken" >&2; exit 1; fi
	@grep 'MISMATCH directed: opcode 0x50 (PUSH) .*stack_op' $(DECODER_MUTANT_DIR)/run.log || { \
	  cat $(DECODER_MUTANT_DIR)/run.log; \
	  echo "test-decoder-mutant: the testbench failed but did not name PUSH's stack_op" >&2; exit 1; }
	@echo "test-decoder-mutant: the testbench caught the broken PUSH row"
