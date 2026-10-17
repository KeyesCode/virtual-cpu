# Decoder unit test: tb/unit/tb_vcpu8_decoder.sv checks core/vcpu8_decoder.sv against vectors that
# @vcpu/rtl-tools derives from the TypeScript ISA (decoder-ops.hex) and from cpu-core decode()
# (decoder-rb.hex), plus the 30-row decoder table of docs/hardware-porting.md.

DECODER_VECTORS_DIR := $(BUILD_DIR)/vectors
DECODER_OPS_HEX     := $(DECODER_VECTORS_DIR)/decoder-ops.hex
DECODER_RB_HEX      := $(DECODER_VECTORS_DIR)/decoder-rb.hex
DECODER_STAMP       := $(DECODER_VECTORS_DIR)/decoder.stamp
DECODER_BUILD_DIR   := $(BUILD_DIR)/unit/decoder
DECODER_SIM         := $(DECODER_BUILD_DIR)/Vtb_vcpu8_decoder
DECODER_SRCS        := $(RTL_PKGS) $(HW_DIR)/core/vcpu8_decoder.sv $(HW_DIR)/tb/unit/tb_vcpu8_decoder.sv

# The vectors are regenerated when the generator, the ISA or cpu-core changes.
DECODER_VECTOR_DEPS := $(wildcard $(REPO_ROOT)/packages/rtl-tools/src/gen/*.ts \
                                  $(REPO_ROOT)/packages/shared/src/isa/*.ts \
                                  $(REPO_ROOT)/packages/cpu-core/src/*.ts)

UNIT_TESTS += decoder

.PHONY: gen-decoder-vectors test-decoder

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
