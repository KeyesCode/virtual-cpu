# Formal verification: SymbiYosys over the properties in formal/ (see
# docs/hardware/formal-verification.md). Each task's run goes to build/formal/<task>/, its log to
# build/formal/<task>.log, and a failure's counterexample to build/formal/<task>/engine_0/trace*.vcd.
#
#   make formal            alu_prove, core_prove and core_bmc; every task must PASS
#   make formal-selftest   a deliberately false property must FAIL with a trace
#   make formal-mutant     a copy of the RTL whose rf_we ignores the FSM state must fail we_rf
#
# FORMAL_DIR runs the tasks of another copy of formal/ (beside its own core/), as formal-mutant
# does. Differential simulation (`make test`) remains the primary correctness evidence.
#
# DIV_IMPL=ITER proves the same tasks on the iterative divider: a copy of core/ and formal/ in
# build/formal-div-iter/, whose core tasks set DIV_ITER = 1 on formal_core_top with chparam before
# hierarchy. alu_prove is the same in both: it proves vcpu8_alu with its default parameter (the
# other operations are the same source either way), and test-divider checks the divider
# exhaustively.

FORMAL_ITER_DIR := $(BUILD_DIR)/formal-div-iter
ifeq ($(DIV_ITER),1)
  FORMAL_DIR    ?= $(FORMAL_ITER_DIR)/formal
  FORMAL_OUT    ?= $(FORMAL_ITER_DIR)/out
endif
FORMAL_DIR    ?= $(HW_DIR)/formal
FORMAL_OUT    ?= $(BUILD_DIR)/formal
FORMAL_CORE_TASKS := core_prove core_bmc
FORMAL_TASKS  := alu_prove core_prove core_bmc
FORMAL_SH     := $(HW_DIR)/scripts/formal.sh
# The solvers the .sby engines name: every task uses smtbmc with boolector, which ran core_bmc
# about nine times faster than yices with the pinned suite.
FORMAL_SOLVERS := $(TOOL_BIN)boolector

FORMAL_MUTANT_DIR := $(BUILD_DIR)/formal-mutant
FORMAL_MUTANT_RTL := $(FORMAL_MUTANT_DIR)/core/vcpu8_control.sv

.PHONY: formal formal-selftest formal-mutant formal-tools

formal-tools:
	$(call need,$(SBY))
	$(call need,$(YOSYS))
	@for s in $(FORMAL_SOLVERS); do command -v $$s > /dev/null 2>&1 || { \
	  echo "SMT solver $$s not found; the formal tasks need it. Run 'pnpm hardware:setup' to install OSS CAD Suite $(OSS_CAD_SUITE_VERSION) into $(OSS_CAD_SUITE_DIR)." >&2; \
	  exit 127; }; done

formal: formal-tools ## SymbiYosys: prove the ALU and core properties (k-induction and BMC); DIV_IMPL=ITER
ifeq ($(DIV_ITER),1)
	@rm -rf $(FORMAL_ITER_DIR) && mkdir -p $(FORMAL_ITER_DIR)
	@cp -R $(HW_DIR)/core $(HW_DIR)/formal $(FORMAL_ITER_DIR)/
	@set -e; for t in $(FORMAL_CORE_TASKS); do \
	  awk '/^hierarchy -top formal_core_top$$/ { print "chparam -set DIV_ITER 1 formal_core_top" } { print }' \
	    $(HW_DIR)/formal/$$t.sby > $(FORMAL_ITER_DIR)/formal/$$t.sby; \
	  grep -q '^chparam -set DIV_ITER 1 formal_core_top$$' $(FORMAL_ITER_DIR)/formal/$$t.sby || { \
	    echo "formal: could not set DIV_ITER in $$t.sby" >&2; exit 1; }; \
	done
	@echo "formal: DIV_IMPL=ITER, core tasks with DIV_ITER = 1 (build/formal-div-iter/)"
endif
	@bash $(FORMAL_SH) $(FORMAL_OUT) $(foreach t,$(FORMAL_TASKS),$(FORMAL_DIR)/$(t).sby)

formal-selftest: formal-tools ## Check a deliberately false formal property fails with a trace
	@bash $(FORMAL_SH) --expect-fail selftest_instret_frozen $(FORMAL_OUT) $(HW_DIR)/formal/selftest/instret_frozen.sby
	@echo "formal-selftest: the false property fails with a counterexample, as it should"

# A copy of core/ and formal/ in build/ with rf_we no longer gated by WRITEBACK; core/ is never touched.
formal-mutant: formal-tools ## Check core_prove fails on we_rf when rf_we is allowed outside WRITEBACK
	@rm -rf $(FORMAL_MUTANT_DIR) && mkdir -p $(FORMAL_MUTANT_DIR)
	@cp -R $(HW_DIR)/core $(HW_DIR)/formal $(FORMAL_MUTANT_DIR)/
	sed 's/assign rf_we      = state == vcpu8_types_pkg::FSM_WRITEBACK \&\& dec_rf_we;/assign rf_we      = dec_rf_we;/' \
	  $(HW_DIR)/core/vcpu8_control.sv > $(FORMAL_MUTANT_RTL)
	@if cmp -s $(HW_DIR)/core/vcpu8_control.sv $(FORMAL_MUTANT_RTL); then \
	  echo "formal-mutant: the mutation did not apply to core/vcpu8_control.sv" >&2; exit 1; fi
	@bash $(FORMAL_SH) --expect-fail we_rf $(FORMAL_MUTANT_DIR)/out $(FORMAL_MUTANT_DIR)/formal/core_prove.sby
	@echo "formal-mutant: core_prove fails on we_rf for the broken rf_we, as it should"
