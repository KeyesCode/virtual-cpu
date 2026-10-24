# Whole-accelerator unit test: rtl/matmul_top.sv (controller, buffers, array) at 4×4, 8×8 and
# 16×16 (the required sizes) and 4×8 (non-square, so a ROWS/COLS mix-up cannot pass), tiled
# matmuls of any M, N, K in 1 … 64 through the host port and the start/busy/done handshake, every
# element of C compared to @vcpu/accelerator-reference (tb/unit/tb_matmul_top.sv).
#
# Each size has its own suite (the directed products, then TOP_RANDOM_CASES random ones from
# TOP_SEED) in build/vectors/top-<R>x<C>/ and its own Verilator build in build/unit/top-<R>x<C>/
# (-GROWS -GCOLS of the same RTL). A suite is regenerated whenever the generator, the model, this
# file, TOP_SEED or TOP_RANDOM_CASES changes (`make test-top TOP_SEED=5 TOP_RANDOM_CASES=100` runs
# other products). test-top also proves the harness can fail: test-top-corrupt reruns the 4×4
# testbench on a copy of its suite with C[0][0] of the first random case changed by one, and
# requires a non-zero exit that names that element.

UNIT_TESTS += top

# <name>:<rows>:<cols>; test-top-<name> runs each.
TOP_SIZES        := 4:4:4 8:8:8 16:16:16 4x8:4:8
TOP_SEED         ?= 1
TOP_RANDOM_CASES ?= 24

# Holds the seed and count the suites were generated with; rewritten (so every suite is
# regenerated) only when either changes.
TOP_PARAMS      := $(BUILD_DIR)/vectors/top.params
TOP_PARAMS_TEXT := seed $(TOP_SEED) random-cases $(TOP_RANDOM_CASES)
ifneq ($(shell cat $(TOP_PARAMS) 2> /dev/null),$(TOP_PARAMS_TEXT))
  $(shell mkdir -p $(dir $(TOP_PARAMS)) && echo '$(TOP_PARAMS_TEXT)' > $(TOP_PARAMS))
endif
TOP_REF_SRC  := $(REPO_ROOT)/packages/accelerator-reference/src
TOP_GEN_DEPS := $(TOP_REF_SRC)/harness/top-vectors.ts $(TOP_REF_SRC)/harness/tile-vectors.ts \
                $(TOP_REF_SRC)/harness/vectors.ts $(TOP_REF_SRC)/model/matmul.ts \
                $(TOP_REF_SRC)/model/prng.ts $(TOP_REF_SRC)/cli.ts \
                $(REPO_ROOT)/packages/accelerator-reference/package.json $(HW_DIR)/mk/unit-top.mk \
                $(TOP_PARAMS)
TOP_TB      := $(HW_DIR)/tb/unit/tb_matmul_top.sv
TOP_BAD_DIR := $(BUILD_DIR)/unit/top-corrupt

.PHONY: test-top test-top-corrupt

# $(call top_size,<name>,<rows>,<cols>): the suite, binary and test-top-<name> target of a
# <rows>×<cols> array. (Their help lines are on test-top: `make help` cannot read a define.)
define top_size
TOP_SUITE_$(1) := $(BUILD_DIR)/vectors/top-$(2)x$(3)
TOP_BIN_$(1)   := $(BUILD_DIR)/unit/top-$(2)x$(3)/Vtb_matmul_top

.PHONY: gen-top-vectors-$(1) test-top-$(1)

gen-top-vectors-$(1): $$(TOP_SUITE_$(1))/cases.txt

$$(TOP_SUITE_$(1))/cases.txt: $(TOP_GEN_DEPS)
	rm -rf $$(TOP_SUITE_$(1))
	cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/accelerator-reference gen-top-suite \
	  --rows $(2) --cols $(3) --seed $(TOP_SEED) --count $(TOP_RANDOM_CASES) --out $$(TOP_SUITE_$(1))

$$(TOP_BIN_$(1)): $(RTL_SRCS) $(TOP_TB) $(HW_DIR)/mk/unit-top.mk
	$$(call need,$(VERILATOR))
	@mkdir -p $$(dir $$@)
	$(VERILATOR) --binary --timing --timescale 1ns/1ps -O3 -Wall -j 0 --top-module tb_matmul_top \
	  -GROWS=$(2) -GCOLS=$(3) -Mdir $$(dir $$@) -CFLAGS -Wno-unknown-warning-option -o Vtb_matmul_top \
	  $(RTL_SRCS) $(TOP_TB) > $$(dir $$@)build.log

test-top-$(1): $$(TOP_BIN_$(1)) $$(TOP_SUITE_$(1))/cases.txt
	$$(TOP_BIN_$(1)) +suite=$$(TOP_SUITE_$(1))
endef
# $(call top_field,<n>,<name>:<rows>:<cols>): field n of a TOP_SIZES entry.
top_field = $(word $(1),$(subst :, ,$(2)))
$(foreach size,$(TOP_SIZES),$(eval $(call top_size,$(call top_field,1,$(size)),$(call top_field,2,$(size)),$(call top_field,3,$(size)))))

TOP_NAMES := $(foreach size,$(TOP_SIZES),$(call top_field,1,$(size)))

test-top: ## matmul_top tiled matmuls vs the reference at 4x4, 8x8, 16x16 and 4x8 (test-top-4|8|16|4x8 runs one)
	@set -e; for name in $(TOP_NAMES); do $(MAKE) --no-print-directory test-top-$$name; done
	@$(MAKE) --no-print-directory test-top-corrupt
	@echo "test-top: 4x4, 8x8, 16x16 and 4x8 passed ($(TOP_RANDOM_CASES) random products each, seed $(TOP_SEED))"

test-top-corrupt: $(TOP_BIN_4) $(TOP_SUITE_4)/cases.txt ## Check a corrupted expected C makes the top test fail
	@rm -rf $(TOP_BAD_DIR) && cp -R $(TOP_SUITE_4) $(TOP_BAD_DIR)
	@name=$$(grep -m 1 '^rand[0-9]' $(TOP_BAD_DIR)/cases.txt); \
	if [ -z "$$name" ]; then echo "test-top-corrupt: $(TOP_SUITE_4) has no random case" >&2; exit 1; fi; \
	awk 'NR == 1 { $$1 = $$1 + 1 } { print }' $(TOP_SUITE_4)/$$name.expected > $(TOP_BAD_DIR)/$$name.expected; \
	if $(TOP_BIN_4) +suite=$(TOP_BAD_DIR) > $(TOP_BAD_DIR)/run.log 2>&1; then \
	  echo "test-top-corrupt: the testbench passed a corrupted product; see $(TOP_BAD_DIR)/run.log" >&2; exit 1; fi; \
	grep "^MISMATCH $$name: C\[0\]\[0\] expected" $(TOP_BAD_DIR)/run.log || { \
	  echo "test-top-corrupt: the failure did not name C[0][0] of $$name; see $(TOP_BAD_DIR)/run.log" >&2; exit 1; }; \
	echo "test-top-corrupt: corrupting C[0][0] of $$name fails the test as it should"
