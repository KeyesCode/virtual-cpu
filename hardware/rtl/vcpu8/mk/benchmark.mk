# RTL performance: the Project 1 benchmark programs (examples/*.asm, the @vcpu/benchmarks set) on
# the RTL runner, each gated on the differential comparison with @vcpu/cpu-core before any number
# is reported, and the research/cpu/ experiment framework. `@vcpu/rtl-tools benchmark` and
# `experiment` (packages/rtl-tools/src/bench/) do the work; docs/hardware/performance-analysis.md
# explains the numbers.
#
#   make benchmark                    build/reports/benchmark.{json,md}: cycles, retired
#                                     instructions, CPI, cycles per class, branches, calls and
#                                     returns, data reads and writes, the emulator's
#                                     instructional estimate and cycles / Fmax per FPGA flow
#   make benchmark-baseline           make benchmark, then commit-ready copies in
#                                     research/cpu/reports/<date>-<shortsha>-default.{json,md}
#   make benchmark-compare            make benchmark, then require its modelled sections to equal
#                                     the newest committed research/cpu/reports/*-default.json
#   make benchmark-mutant-check       prove a mutant runner fails the benchmark (BENCH_MUTANT=<id>)
#   make experiment NAME=<dir>        verify, benchmark and synth every variant of
#                                     research/cpu/experiments/<dir>/experiment.json
#
# BENCH_SYNTH is the synthesis summary the Fmax comes from: the committed baseline by default,
# BENCH_SYNTH=build/synth/summary.json after a fresh make synth, or BENCH_SYNTH=none.
#
# DIV_IMPL=ITER benchmarks the iterative-divider runner (build/sim-div-iter/) and labels the report
# with the variant div-iter. Its Fmax comes from build/synth-div-iter/summary.json, which
# `make synth DIV_IMPL=ITER` writes (the report says so if it is absent), never from the committed
# baseline, which is the default design's. benchmark-baseline and benchmark-compare are for the
# default design only.

# Named here rather than through sim.mk's SIM_BIN, which is defined after this fragment is read.
BENCH_SIM       := $(BUILD_DIR)/sim$(VARIANT_SUFFIX)/vcpu8_sim
ifeq ($(DIV_ITER),1)
BENCH_SYNTH     ?= $(BUILD_DIR)/synth$(VARIANT_SUFFIX)/summary.json
BENCH_VARIANT   := --variant '{"name":"div-iter","description":"Iterative divider (DIV_IMPL=ITER).","parameters":{"DIV_ITER":1}}'
else
BENCH_SYNTH     ?= $(REPO_ROOT)/research/cpu/synth/baseline.json
BENCH_VARIANT   :=
endif
BENCH_REPORT    := $(BUILD_DIR)/reports/benchmark.json
BENCH_PUBLISHED := $(REPO_ROOT)/research/cpu/reports
BENCH_MUTANT    ?= alu-shr-carry
BENCH_MUTANT_OUT = $(BUILD_DIR)/benchmark-mutant
EXPERIMENTS_DIR := $(REPO_ROOT)/research/cpu/experiments

BENCH_TOOLS = cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/rtl-tools cli
BENCH_ARGS  = --synth $(if $(filter none,$(BENCH_SYNTH)),none,$(abspath $(BENCH_SYNTH))) $(BENCH_VARIANT)
# `$(call bench_default_only,<target>)`: refuse a non-default DIV_IMPL.
bench_default_only = @test '$(DIV_IMPL)' = COMB || { echo "$(1): only for the default design (DIV_IMPL=COMB)" >&2; exit 2; }
# Tool versions for the report's provenance. tools-check writes the file before it checks that
# every required tool is present, so a machine without (say) nextpnr still benchmarks.
bench_tool_versions = @$(MAKE) --no-print-directory tools-check > /dev/null 2>&1 || true

.PHONY: benchmark benchmark-baseline benchmark-compare benchmark-mutant-check experiment

benchmark: $(BENCH_SIM) ## Cycles, CPI and branches of the benchmark programs on the RTL, gated on verify
	$(bench_tool_versions)
	$(BENCH_TOOLS) benchmark --sim $(BENCH_SIM) $(BENCH_ARGS) --out $(BENCH_REPORT)

benchmark-baseline: $(BENCH_SIM) ## make benchmark, and write research/cpu/reports/<date>-<sha>-default.*
	$(call bench_default_only,benchmark-baseline)
	$(bench_tool_versions)
	$(BENCH_TOOLS) benchmark --sim $(BENCH_SIM) $(BENCH_ARGS) --out $(BENCH_REPORT) --publish $(BENCH_PUBLISHED)
	cd $(REPO_ROOT) && pnpm --silent exec prettier --log-level warn --write $(BENCH_PUBLISHED)

benchmark-compare: benchmark ## make benchmark, then diff its modelled sections against the committed report
	$(call bench_default_only,benchmark-compare)
	@latest='$(lastword $(sort $(wildcard $(BENCH_PUBLISHED)/*-default.json)))'; \
	  test -n "$$latest" || { echo "benchmark-compare: no research/cpu/reports/*-default.json; run make benchmark-baseline" >&2; exit 2; }; \
	  $(BENCH_TOOLS) benchmark-compare --baseline "$$latest" --report $(BENCH_REPORT)

# A mutant of core/ from scripts/mutants.txt, built (and caught) by the verify ticket's mutant
# infrastructure, must fail the benchmark's correctness gate: exit non-zero, and the programs it
# breaks reported as FAILED with no numbers. core/ itself is never touched.
benchmark-mutant-check: ## Prove the benchmark gate rejects a mutant runner (BENCH_MUTANT=<id>)
	$(call need,$(VERILATOR))
	@rm -rf $(BENCH_MUTANT_OUT) && mkdir -p $(BENCH_MUTANT_OUT)
	$(BENCH_TOOLS) mutants --verilator $(VERILATOR) --only $(BENCH_MUTANT) --count 0 \
	  --out $(BENCH_MUTANT_OUT)/mutants --report $(BENCH_MUTANT_OUT)/mutants.json
	@if ( $(BENCH_TOOLS) benchmark --sim $(BENCH_MUTANT_OUT)/mutants/$(BENCH_MUTANT)/sim/vcpu8_sim \
	       $(BENCH_ARGS) --work $(BENCH_MUTANT_OUT)/work --out $(BENCH_MUTANT_OUT)/benchmark.json ) \
	       > $(BENCH_MUTANT_OUT)/benchmark.log 2>&1; then \
	  cat $(BENCH_MUTANT_OUT)/benchmark.log; \
	  echo "benchmark-mutant-check: the benchmark passed mutant $(BENCH_MUTANT)" >&2; exit 1; fi
	@grep -E '^benchmark: FAIL, ' $(BENCH_MUTANT_OUT)/benchmark.log && \
	  grep -E '^\| [^|]+ \| FAILED: ' $(BENCH_MUTANT_OUT)/benchmark.md && \
	  grep -E '^No suite totals' $(BENCH_MUTANT_OUT)/benchmark.md > /dev/null || { \
	  cat $(BENCH_MUTANT_OUT)/benchmark.log; \
	  echo "benchmark-mutant-check: the report does not show the failing programs without numbers" >&2; exit 1; }
	@echo "benchmark-mutant-check: mutant $(BENCH_MUTANT) fails the benchmark gate, as it should"

experiment: ## Verify, benchmark and synth each variant of research/cpu/experiments/$(NAME)/
	@test -n "$(NAME)" || { echo "experiment: set NAME=<dir in research/cpu/experiments/>" >&2; exit 2; }
	$(call need,$(VERILATOR))
	$(bench_tool_versions)
	$(BENCH_TOOLS) experiment $(NAME) --verilator $(VERILATOR) --make $(MAKE)
	cd $(REPO_ROOT) && pnpm --silent exec prettier --log-level warn --write $(EXPERIMENTS_DIR)/$(NAME)/results
