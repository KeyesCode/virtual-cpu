# Systolic-array unit test: rtl/systolic_array.sv at 4×4, 8×8 and 16×16, one single-tile matmul per
# case, every element compared to @vcpu/accelerator-reference (tb/unit/tb_systolic_array.sv).
#
# Each size has its own suite (the directed tiles, then ARRAY_RANDOM_TILES random tiles from
# ARRAY_SEED) in build/vectors/array-<R>x<C>/ and its own Verilator build in
# build/unit/array-<R>x<C>/ (-GROWS -GCOLS of the same RTL). A suite is regenerated whenever the
# generator, the model, this file, ARRAY_SEED or ARRAY_RANDOM_TILES changes
# (`make test-array ARRAY_SEED=5 ARRAY_RANDOM_TILES=200` runs other tiles). `make trace-array`
# prints the 4×4, K = 3 tile clock by clock, the table in docs/hardware/accelerators/systolic-array.md.

UNIT_TESTS += array

ARRAY_SIZES        := 4 8 16
ARRAY_SEED         ?= 1
ARRAY_RANDOM_TILES ?= 30

# Holds the seed and count the suites were generated with; rewritten (so every suite is
# regenerated) only when either changes.
ARRAY_PARAMS      := $(BUILD_DIR)/vectors/array.params
ARRAY_PARAMS_TEXT := seed $(ARRAY_SEED) random-tiles $(ARRAY_RANDOM_TILES)
ifneq ($(shell cat $(ARRAY_PARAMS) 2> /dev/null),$(ARRAY_PARAMS_TEXT))
  $(shell mkdir -p $(dir $(ARRAY_PARAMS)) && echo '$(ARRAY_PARAMS_TEXT)' > $(ARRAY_PARAMS))
endif
ARRAY_REF_SRC  := $(REPO_ROOT)/packages/accelerator-reference/src
ARRAY_GEN_DEPS := $(ARRAY_REF_SRC)/harness/tile-vectors.ts $(ARRAY_REF_SRC)/harness/vectors.ts \
                  $(ARRAY_REF_SRC)/model/matmul.ts $(ARRAY_REF_SRC)/model/prng.ts $(ARRAY_REF_SRC)/cli.ts \
                  $(REPO_ROOT)/packages/accelerator-reference/package.json $(HW_DIR)/mk/unit-array.mk \
                  $(ARRAY_PARAMS)
ARRAY_TB       := $(HW_DIR)/tb/unit/tb_systolic_array.sv
ARRAY_RTL      := $(RTL_PKGS) $(HW_DIR)/rtl/processing_element.sv $(HW_DIR)/rtl/systolic_array.sv
ARRAY_TRACE    := $(BUILD_DIR)/unit/array-4x4/trace-k3.md

.PHONY: test-array trace-array

# $(call array_size,<side>): the suite, binary and test-array-<side> target of a <side>×<side> array.
define array_size
ARRAY_SUITE_$(1) := $(BUILD_DIR)/vectors/array-$(1)x$(1)
ARRAY_BIN_$(1)   := $(BUILD_DIR)/unit/array-$(1)x$(1)/Vtb_systolic_array

.PHONY: gen-array-vectors-$(1) test-array-$(1)

gen-array-vectors-$(1): $$(ARRAY_SUITE_$(1))/cases.txt ## Generate the $(1)x$(1) array tile suite

$$(ARRAY_SUITE_$(1))/cases.txt: $(ARRAY_GEN_DEPS)
	rm -rf $$(ARRAY_SUITE_$(1))
	cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/accelerator-reference gen-tile-suite \
	  --rows $(1) --cols $(1) --seed $(ARRAY_SEED) --count $(ARRAY_RANDOM_TILES) --out $$(ARRAY_SUITE_$(1))

$$(ARRAY_BIN_$(1)): $(ARRAY_RTL) $(ARRAY_TB) $(HW_DIR)/mk/unit-array.mk
	$$(call need,$(VERILATOR))
	@mkdir -p $$(dir $$@)
	$(VERILATOR) --binary --timing --timescale 1ns/1ps -O3 -Wall -j 0 --top-module tb_systolic_array \
	  -GROWS=$(1) -GCOLS=$(1) -Mdir $$(dir $$@) -CFLAGS -Wno-unknown-warning-option -o Vtb_systolic_array \
	  $(ARRAY_RTL) $(ARRAY_TB) > $$(dir $$@)build.log

test-array-$(1): $$(ARRAY_BIN_$(1)) $$(ARRAY_SUITE_$(1))/cases.txt ## Array unit test at $(1)x$(1): directed + ARRAY_RANDOM_TILES random tiles
	$$(ARRAY_BIN_$(1)) +suite=$$(ARRAY_SUITE_$(1))
endef
$(foreach side,$(ARRAY_SIZES),$(eval $(call array_size,$(side))))

test-array: ## Array unit test at 4x4, 8x8 and 16x16 against the reference
	@set -e; for side in $(ARRAY_SIZES); do $(MAKE) --no-print-directory test-array-$$side; done
	@echo "test-array: 4x4, 8x8 and 16x16 passed ($(ARRAY_RANDOM_TILES) random tiles each, seed $(ARRAY_SEED))"

trace-array: $(ARRAY_BIN_4) $(ARRAY_SUITE_4)/cases.txt ## Print the 4x4, K = 3 tile clock by clock (build/unit/array-4x4/trace-k3.md)
	$(ARRAY_BIN_4) +suite=$(ARRAY_SUITE_4) +trace=random-4x4-k3-s$(ARRAY_SEED) > $(ARRAY_TRACE).log
	sed -n 's/^TRACE //p' $(ARRAY_TRACE).log > $(ARRAY_TRACE)
	@cat $(ARRAY_TRACE)
