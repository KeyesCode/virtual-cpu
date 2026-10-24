# Differential verification: every case is generated from a seed by @vcpu/accelerator-reference,
# its C computed by the reference model, run on the Verilator runner of each array size
# (mk/sim.mk) and compared element by element by `@vcpu/accelerator-reference verify`
# (packages/accelerator-reference/src/harness/verify.ts).
# docs/hardware/accelerators/verification-strategy.md explains the corpora, the reports and how
# to replay a failure.
#
#   make verify                    the directed corpus and COUNT random cases (default 40) from
#                                  SEED (default 1) on each of 4x4, 8x8 and 16x16
#   make verify SEED=7 COUNT=10
#   make verify-size ROWS=8        the same on one size (reports in build/reports/verify-8x8/)
#   make replay CASE=build/failures/<name> [SIM=<runner>]
#   make verify-mutant [MUTANT=<id>]  every mutant in scripts/mutants.txt must fail verify
#
# Reports: build/reports/verify.{json,md}; failing cases in build/failures/<RxC>-<name>/; case
# files in build/verify/<RxC>/; mutants in build/mutants/<id>/ and build/reports/mutants.json.

SEED         ?= 1
COUNT        ?= 40
MUTANT_COUNT ?= 10

VERIFY_SIMS := $(foreach size,$(SIM_SIZES),$(BUILD_DIR)/sim-$(size)/matmul_sim)
ACCEL_CLI    = cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/accelerator-reference cli

.PHONY: verify verify-size replay verify-mutant

# tools-check records the tool versions for the report's provenance; a missing optional tool
# must not stop verification, so its exit status is ignored.
verify: $(VERIFY_SIMS) ## Differential verification at 4x4, 8x8 and 16x16: directed + COUNT random cases each (SEED)
	@-$(MAKE) --no-print-directory tools-check > /dev/null 2>&1
	$(ACCEL_CLI) verify $(foreach sim,$(VERIFY_SIMS),--sim $(sim)) --seed $(SEED) --count $(COUNT)

verify-size: $(SIM_BIN) ## verify on the ROWS x COLS runner only (reports in build/reports/verify-<R>x<C>/)
	@-$(MAKE) --no-print-directory tools-check > /dev/null 2>&1
	$(ACCEL_CLI) verify --sim $(SIM_BIN) --seed $(SEED) --count $(COUNT) \
	  --reports $(BUILD_DIR)/reports/verify-$(SIZE)

# The runners are rebuilt first, so a replay after an RTL fix runs the fixed RTL (a mutant's
# failure keeps its own runner under build/mutants/).
replay: $(VERIFY_SIMS) ## Rerun a saved failing case on its own runner: CASE=build/failures/<name> [SIM=<runner>]
	@test -n "$(CASE)" || { echo "replay: set CASE=build/failures/<name>" >&2; exit 2; }
	$(ACCEL_CLI) verify --replay $(abspath $(CASE)) $(if $(SIM),--sim $(abspath $(SIM)))

verify-mutant: ## Build each mutant of rtl/ in scripts/mutants.txt and require verify to catch it (MUTANT=<id>)
	$(call need,$(VERILATOR))
	$(ACCEL_CLI) mutants --verilator $(VERILATOR) --seed $(SEED) --count $(MUTANT_COUNT) \
	  $(if $(MUTANT),--only $(MUTANT))
