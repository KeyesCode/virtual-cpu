# Systolic-array unit test: rtl/systolic_array.sv at 4×4, 8×8 and 16×16 (the required sizes) and
# 4×8 (non-square, so a ROWS/COLS mix-up cannot pass), one single-tile matmul per case, every
# element compared to @vcpu/accelerator-reference (tb/unit/tb_systolic_array.sv).
#
# Each size has its own suite (the directed tiles, then ARRAY_RANDOM_TILES random tiles from
# ARRAY_SEED) in build/vectors/array-<R>x<C>/ and its own Verilator build in
# build/unit/array-<R>x<C>/ (-GROWS -GCOLS of the same RTL). A suite is regenerated whenever the
# generator, the model, this file, ARRAY_SEED or ARRAY_RANDOM_TILES changes
# (`make test-array ARRAY_SEED=5 ARRAY_RANDOM_TILES=200` runs other tiles). `make trace-array`
# prints the 4×4, K = 3 tile clock by clock, the table in docs/hardware/accelerators/systolic-array.md.
# test-array also proves the harness can fail: test-array-corrupt reruns the 4×4 testbench on a copy
# of its suite with C[0][0] of the first random tile changed by one, and requires a non-zero exit
# that names that element.

UNIT_TESTS += array

# <name>:<rows>:<cols>; test-array-<name> runs each.
ARRAY_SIZES        := 4:4:4 8:8:8 16:16:16 4x8:4:8
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
ARRAY_BAD_DIR  := $(BUILD_DIR)/unit/array-corrupt

.PHONY: test-array trace-array test-array-corrupt

# $(call array_size,<name>,<rows>,<cols>): the suite, binary and test-array-<name> target of a
# <rows>×<cols> array. (Their help lines are on test-array: `make help` cannot read a define.)
define array_size
ARRAY_SUITE_$(1) := $(BUILD_DIR)/vectors/array-$(2)x$(3)
ARRAY_BIN_$(1)   := $(BUILD_DIR)/unit/array-$(2)x$(3)/Vtb_systolic_array

.PHONY: gen-array-vectors-$(1) test-array-$(1)

gen-array-vectors-$(1): $$(ARRAY_SUITE_$(1))/cases.txt

$$(ARRAY_SUITE_$(1))/cases.txt: $(ARRAY_GEN_DEPS)
	rm -rf $$(ARRAY_SUITE_$(1))
	cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/accelerator-reference gen-tile-suite \
	  --rows $(2) --cols $(3) --seed $(ARRAY_SEED) --count $(ARRAY_RANDOM_TILES) --out $$(ARRAY_SUITE_$(1))

$$(ARRAY_BIN_$(1)): $(ARRAY_RTL) $(ARRAY_TB) $(HW_DIR)/mk/unit-array.mk
	$$(call need,$(VERILATOR))
	@mkdir -p $$(dir $$@)
	$(VERILATOR) --binary --timing --timescale 1ns/1ps -O3 -Wall -j 0 --top-module tb_systolic_array \
	  -GROWS=$(2) -GCOLS=$(3) -Mdir $$(dir $$@) -CFLAGS -Wno-unknown-warning-option -o Vtb_systolic_array \
	  $(ARRAY_RTL) $(ARRAY_TB) > $$(dir $$@)build.log

test-array-$(1): $$(ARRAY_BIN_$(1)) $$(ARRAY_SUITE_$(1))/cases.txt
	$$(ARRAY_BIN_$(1)) +suite=$$(ARRAY_SUITE_$(1))
endef
# $(call size_field,<n>,<name>:<rows>:<cols>): field n of an ARRAY_SIZES entry.
size_field = $(word $(1),$(subst :, ,$(2)))
$(foreach size,$(ARRAY_SIZES),$(eval $(call array_size,$(call size_field,1,$(size)),$(call size_field,2,$(size)),$(call size_field,3,$(size)))))

ARRAY_NAMES := $(foreach size,$(ARRAY_SIZES),$(call size_field,1,$(size)))

test-array: ## Array unit test vs the reference at 4x4, 8x8, 16x16 and 4x8 (test-array-4|8|16|4x8 runs one)
	@set -e; for name in $(ARRAY_NAMES); do $(MAKE) --no-print-directory test-array-$$name; done
	@$(MAKE) --no-print-directory test-array-corrupt
	@echo "test-array: 4x4, 8x8, 16x16 and 4x8 passed ($(ARRAY_RANDOM_TILES) random tiles each, seed $(ARRAY_SEED))"

test-array-corrupt: $(ARRAY_BIN_4) $(ARRAY_SUITE_4)/cases.txt ## Check a corrupted array tile makes the test fail
	@rm -rf $(ARRAY_BAD_DIR) && cp -R $(ARRAY_SUITE_4) $(ARRAY_BAD_DIR)
	@name=$$(grep -m 1 '^rand[0-9]' $(ARRAY_BAD_DIR)/cases.txt); \
	if [ -z "$$name" ]; then echo "test-array-corrupt: $(ARRAY_SUITE_4) has no random tile" >&2; exit 1; fi; \
	awk 'NR == 1 { $$1 = $$1 + 1 } { print }' $(ARRAY_SUITE_4)/$$name.expected > $(ARRAY_BAD_DIR)/$$name.expected; \
	if $(ARRAY_BIN_4) +suite=$(ARRAY_BAD_DIR) > $(ARRAY_BAD_DIR)/run.log 2>&1; then \
	  echo "test-array-corrupt: the testbench passed a corrupted tile; see $(ARRAY_BAD_DIR)/run.log" >&2; exit 1; fi; \
	grep "^MISMATCH $$name: C\[0\]\[0\] expected" $(ARRAY_BAD_DIR)/run.log || { \
	  echo "test-array-corrupt: the failure did not name C[0][0] of $$name; see $(ARRAY_BAD_DIR)/run.log" >&2; exit 1; }; \
	echo "test-array-corrupt: corrupting C[0][0] of $$name fails the test as it should"

trace-array: $(ARRAY_BIN_4) $(ARRAY_SUITE_4)/cases.txt ## Print the 4x4, K = 3 tile clock by clock (build/unit/array-4x4/trace-k3.md)
	$(ARRAY_BIN_4) +suite=$(ARRAY_SUITE_4) +trace=random-4x4-k3-s$(ARRAY_SEED) > $(ARRAY_TRACE).log
	sed -n 's/^TRACE //p' $(ARRAY_TRACE).log > $(ARRAY_TRACE)
	@cat $(ARRAY_TRACE)
