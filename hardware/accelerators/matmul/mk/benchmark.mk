# Benchmark: the workloads of the brief (the cubes 4 … 64 and a non-square set) on the 4x4, 8x8
# and 16x16 runners (mk/sim.mk), every case gated on an element-by-element match with
# @vcpu/accelerator-reference before any number is recorded. `@vcpu/accelerator-reference
# benchmark` (packages/accelerator-reference/src/harness/benchmark.ts) does the work;
# docs/hardware/accelerators/performance-analysis.md explains the numbers and
# research/accelerators/matmul/README.md the report schema.
#
#   make benchmark                 build/reports/benchmark.{json,csv,md}: transfer-in, compute,
#                                  store, transfer-out and total cycles, MACs, PE utilization and
#                                  MACs and ops per cycle of every workload on every size (SEED)
#   make benchmark-baseline        make benchmark, then commit-ready copies in
#                                  research/accelerators/matmul/reports/<date>-<shortsha>.*;
#                                  refused from a dirty working tree unless ALLOW_DIRTY=1
#   make benchmark-compare         make benchmark, then require its modelled sections to equal
#                                  the newest committed reports/*.json, or BASELINE=<file> (a
#                                  relative path is looked up from the repository root first,
#                                  then from here)

# The sizes are named here rather than through sim.mk's SIM_SIZES, which is defined after this
# fragment is read (prerequisites expand when the rule is read).
BENCH_SIZES     := 4x4 8x8 16x16
BENCH_SIMS      := $(foreach size,$(BENCH_SIZES),$(BUILD_DIR)/sim-$(size)/matmul_sim)
BENCH_OUT       := $(BUILD_DIR)/reports
BENCH_REPORT    := $(BENCH_OUT)/benchmark.json
BENCH_PUBLISHED := $(REPO_ROOT)/research/accelerators/matmul/reports
BENCH_BASELINE   = $(if $(BASELINE),$(firstword $(wildcard $(REPO_ROOT)/$(BASELINE) $(abspath $(BASELINE)))),$(lastword $(sort $(wildcard $(BENCH_PUBLISHED)/*.json))))
BENCH_ARGS       = $(foreach sim,$(BENCH_SIMS),--sim $(sim)) --seed $(SEED) --out $(BENCH_OUT)
# Tool versions for the report's provenance; a missing optional tool must not stop the benchmark.
bench_tool_versions = @-$(MAKE) --no-print-directory tools-check > /dev/null 2>&1

.PHONY: benchmark benchmark-baseline benchmark-compare

benchmark: $(BENCH_SIMS) ## Cycles, utilization and MACs/ops per cycle of the benchmark workloads, gated on the reference
	$(bench_tool_versions)
	$(ACCEL_CLI) benchmark $(BENCH_ARGS)

benchmark-baseline: $(BENCH_SIMS) ## make benchmark, and write research/accelerators/matmul/reports/<date>-<sha>.*
	$(bench_tool_versions)
	$(ACCEL_CLI) benchmark $(BENCH_ARGS) --publish $(BENCH_PUBLISHED) $(if $(filter 1,$(ALLOW_DIRTY)),--allow-dirty)
	cd $(REPO_ROOT) && pnpm --silent exec prettier --log-level warn --write $(BENCH_PUBLISHED)

benchmark-compare: benchmark ## make benchmark, then diff its modelled sections against the committed report
	@test -n '$(BENCH_BASELINE)' || { echo "benchmark-compare: $(if $(BASELINE),$(BASELINE) not found,no research/accelerators/matmul/reports/*.json; run make benchmark-baseline)" >&2; exit 2; }
	$(ACCEL_CLI) benchmark-compare --baseline $(BENCH_BASELINE) --report $(BENCH_REPORT)
