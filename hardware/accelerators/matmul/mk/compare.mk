# CPU comparison (brief §13): the same INT8 -> INT32 products on VCPU-8, the Project 2 CPU, and on
# the 4x4 accelerator. Each CPU workload is a generated VCPU-8 program
# (packages/accelerator-reference/src/harness/cpu-program.ts) run on the emulator and on the
# Project 2 RTL runner, which is built by its own Makefile and otherwise left alone; the
# accelerator runs the same operands on build/sim-4x4/matmul_sim. Every row is gated on
# @vcpu/accelerator-reference; workloads that do not fit in the CPU's 256 bytes are listed as
# unsupported with their byte counts. docs/hardware/accelerators/cpu-comparison.md explains the
# method and the numbers.
#
#   make compare-cpu               build/reports/cpu-comparison.{json,md} (SEED)
#   make compare-cpu-publish       make compare-cpu, then (when every row passed) commit-ready
#                                  copies in research/accelerators/matmul/comparisons/<date>-<sha>.*;
#                                  refused from a dirty working tree unless ALLOW_DIRTY=1

VCPU8_DIR         := $(REPO_ROOT)/hardware/rtl/vcpu8
COMPARE_VCPU8_SIM := $(VCPU8_DIR)/build/sim/vcpu8_sim
COMPARE_ACCEL_SIM := $(BUILD_DIR)/sim-4x4/matmul_sim
COMPARE_OUT       := $(BUILD_DIR)/reports
COMPARE_PUBLISHED := $(REPO_ROOT)/research/accelerators/matmul/comparisons
COMPARE_ARGS       = --vcpu8-sim $(COMPARE_VCPU8_SIM) --accel-sim $(COMPARE_ACCEL_SIM) --seed $(SEED) \
                     --work $(BUILD_DIR)/compare-cpu --out $(COMPARE_OUT)
# The VCPU-8 runner is rebuilt by its own Makefile, which knows its sources; tool versions are for
# the report's provenance, and a missing optional tool must not stop the comparison.
compare_prepare = @$(MAKE) --no-print-directory -C $(VCPU8_DIR) sim && \
  { $(MAKE) --no-print-directory tools-check > /dev/null 2>&1 || true; }

.PHONY: compare-cpu compare-cpu-publish

compare-cpu: $(COMPARE_ACCEL_SIM) ## VCPU-8 vs the 4x4 accelerator on tiny INT8 products: cycles, memory accesses, resources
	$(compare_prepare)
	$(ACCEL_CLI) compare-cpu $(COMPARE_ARGS)

compare-cpu-publish: $(COMPARE_ACCEL_SIM) ## make compare-cpu, and write research/accelerators/matmul/comparisons/<date>-<sha>.*
	$(compare_prepare)
	$(ACCEL_CLI) compare-cpu $(COMPARE_ARGS) --publish $(COMPARE_PUBLISHED) $(if $(filter 1,$(ALLOW_DIRTY)),--allow-dirty)
	cd $(REPO_ROOT) && pnpm --silent exec prettier --log-level warn --write $(COMPARE_PUBLISHED)
