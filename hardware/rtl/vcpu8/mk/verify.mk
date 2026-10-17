# Differential verification: each program runs on @vcpu/cpu-core (live) and on the RTL runner,
# and `@vcpu/rtl-tools verify` (packages/rtl-tools/src/commands/verify.ts) compares the
# architectural state after every step and at the end. docs/hardware/verification-strategy.md
# explains the corpora, the reports and how to replay a failure.
#
#   make verify                         fixtures/v1, examples/, tb/programs/, tb/regressions/ and
#                                       COUNT random programs from SEED (default 1000 from 1)
#   make verify SEED=5000 COUNT=200
#   make verify-long                    the same with LONG_COUNT (100,000) random programs
#   make replay CASE=build/failures/<name> [SIM=<runner>]
#   make promote CASE=build/failures/<name>
#   make verify-mutants                 every mutant in scripts/mutants.txt must fail verify
#
# Reports: build/reports/verify.{json,md} (verify-long: build/reports/verify-long/), failing
# cases in build/failures/<name>/, mutants in build/mutants/<id>/ and build/reports/mutants.json.

SEED         ?= 1
COUNT        ?= 1000
LONG_COUNT   ?= 100000
MUTANT_COUNT ?= $(COUNT)

RTL_TOOLS = cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/rtl-tools cli

.PHONY: verify verify-long replay promote verify-mutants

verify: $(SIM_BIN) ## Differential verification of every corpus, TypeScript CPU vs RTL (SEED, COUNT)
	$(RTL_TOOLS) verify --all --seed $(SEED) --count $(COUNT) --sim $(SIM_BIN)

verify-long: $(SIM_BIN) ## verify with LONG_COUNT (100,000) random programs
	$(RTL_TOOLS) verify --all --seed $(SEED) --count $(LONG_COUNT) --sim $(SIM_BIN) \
	  --failures $(BUILD_DIR)/failures-long --reports $(BUILD_DIR)/reports/verify-long

replay: $(SIM_BIN) ## Rerun a saved failing case with its own runner: CASE=build/failures/<name>
	@test -n "$(CASE)" || { echo "replay: set CASE=build/failures/<name>" >&2; exit 2; }
	$(RTL_TOOLS) verify --replay $(abspath $(CASE)) $(if $(SIM),--sim $(abspath $(SIM)))

promote: ## Copy a saved failing case into tb/regressions/, which verify always replays
	@test -n "$(CASE)" || { echo "promote: set CASE=build/failures/<name>" >&2; exit 2; }
	$(RTL_TOOLS) verify --promote $(abspath $(CASE))

verify-mutants: ## Build each mutant of core/ in scripts/mutants.txt and require verify to catch it
	$(call need,$(VERILATOR))
	$(RTL_TOOLS) mutants --verilator $(VERILATOR) --seed $(SEED) --count $(MUTANT_COUNT) \
	  $(if $(MUTANT),--only $(MUTANT))
