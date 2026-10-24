# Design-space exploration: every variant of research/accelerators/matmul/experiments/<NAME>/
# experiment.json (parameters such as ROWS, COLS and MAX_DIM, and defines) is built (mk/sim.mk's
# sim-variant), verified against the reference, benchmarked on the benchmark workloads and
# synthesised with every flow of make synth (mk/synth.mk with SYNTH_ROOT, SYNTH_PARAMS and
# SYNTH_DEFINES), in that order; `@vcpu/accelerator-reference experiment`
# (packages/accelerator-reference/src/harness/experiment.ts) does the work.
# research/accelerators/matmul/experiments/README.md documents the format.
#
#   make experiment NAME=<dir>     results/<date>-<shortsha>.{json,md} beside experiment.json:
#                                  every metric per variant, deltas against the baseline variant
#                                  and the Pareto-optimal variants on (total cycles, generic
#                                  cells); refused from a dirty working tree unless ALLOW_DIRTY=1
#
# Each variant builds in build/variants/<hash>/ (sim/, synth-<R>x<C>/, synth/, the logs); its
# verify and benchmark reports go to build/experiments/<NAME>/<variant>/. Exit 1 when a variant
# failed a stage.

EXPERIMENTS_DIR := $(REPO_ROOT)/research/accelerators/matmul/experiments
# The make the runner calls for each variant. Named through a variable so that the recipe below
# does not mention $(MAKE) directly, which would make `make -n experiment` run the experiment.
EXPERIMENT_MAKE  = $(MAKE)

.PHONY: experiment

# tools-check records the tool versions for the results' provenance; a missing optional tool must
# not stop the experiment, so its exit status is ignored. The results are formatted even when a
# variant failed, and the recipe then exits with the runner's status.
experiment: ## Verify, benchmark and synth each variant of research/accelerators/matmul/experiments/$(NAME)/
	@test -n "$(NAME)" || { echo "experiment: set NAME=<dir in research/accelerators/matmul/experiments/>" >&2; exit 2; }
	@test -f $(EXPERIMENTS_DIR)/$(NAME)/experiment.json || { echo "experiment: no $(EXPERIMENTS_DIR)/$(NAME)/experiment.json" >&2; exit 2; }
	$(call need,$(VERILATOR))
	@-$(MAKE) --no-print-directory tools-check > /dev/null 2>&1
	@status=0; ( $(ACCEL_CLI) experiment --spec $(EXPERIMENTS_DIR)/$(NAME)/experiment.json \
	  --out $(EXPERIMENTS_DIR)/$(NAME)/results --make $(EXPERIMENT_MAKE) \
	  $(if $(filter 1,$(ALLOW_DIRTY)),--allow-dirty) ) || status=$$?; \
	if [ -d $(EXPERIMENTS_DIR)/$(NAME)/results ]; then \
	  cd $(REPO_ROOT) && pnpm --silent exec prettier --log-level warn --write $(EXPERIMENTS_DIR)/$(NAME)/results; fi; \
	exit $$status
