# Synthesis: Yosys and nextpnr reports for the 4×4, 8×8 and 16×16 arrays
# (docs/hardware/accelerators/synthesis-guide.md).
#
#   make synth              for each size in SYNTH_SIZES: the generic Yosys flow on matmul_top, then
#                           iCE40 (and ECP5, if installed) synthesis and place-and-route of
#                           hardware/fpga/matmul_fpga_wrapper.sv, in build/synth-<R>x<C>/; then
#                           writes build/synth/summary.{json,md} over every size
#   make synth-size-<R>     one size's flows only (no summary)
#   make synth-baseline     make synth, then copy the summary to
#                           research/accelerators/matmul/synth/baseline.*
#   make synth-compare      make synth, then fail on any difference from the committed baseline
#   make synth-latch-check  prove the latch gate fails on copies of rtl/ with a latch added
#
# Every size runs with identical settings, and with the same frequency target and nextpnr seed as
# VCPU-8's flow (hardware/rtl/vcpu8/mk/synth.mk), so the designs can be compared. make synth fails
# on a hierarchy, latch, loop, multiple-driver or undriven-net check in any Yosys run, on a missing
# nextpnr-ice40, on any nextpnr failure other than "the design does not fit the device", and on
# any warning not in synth/warnings.allow. A design that does not fit is a result, not a failure:
# the summary records it with the utilisation nextpnr reported. Each run starts from empty
# directories, so no report can be left over from an earlier run.

# Square arrays, ROWS = COLS = each entry. Override to run fewer (`make synth SYNTH_SIZES=4`); the
# baseline is only for the full set.
SYNTH_SIZES       ?= 4 8 16
SYNTH_ALL_SIZES   := 4 8 16
SYNTH_DIR         := $(BUILD_DIR)/synth
SYNTH_SCRIPTS     := $(HW_DIR)/synth
SYNTH_ALLOW       := $(SYNTH_SCRIPTS)/warnings.allow
SYNTH_BASELINE    ?= $(REPO_ROOT)/research/accelerators/matmul/synth/baseline
synth_size_dir     = $(BUILD_DIR)/synth-$(1)x$(1)

FPGA_DIR     := $(REPO_ROOT)/hardware/fpga
FPGA_WRAPPER := $(FPGA_DIR)/matmul_fpga_wrapper.sv

# Place-and-route targets: the same devices, 12 MHz target and seed as VCPU-8.
SYNTH_FREQ_MHZ := 12
SYNTH_SEED     := 1
ICE40_DEVICE   := up5k
ICE40_PACKAGE  := sg48
ICE40_PCF      := $(FPGA_DIR)/matmul_up5k_sg48.pcf
ECP5_DEVICE    := 25k
ECP5_PACKAGE   := CABGA256
ECP5_SPEED     := 6

NEXTPNR_ICE40 ?= $(TOOL_BIN)nextpnr-ice40
NEXTPNR_ECP5  ?= $(TOOL_BIN)nextpnr-ecp5

# The one nextpnr failure that is a result: the design needs more of some resource than the device
# has. nextpnr reports its utilisation before placement, so the summary still has the numbers.
SYNTH_NO_FIT := ^ERROR: Unable to place cell .*, no BELs remaining to implement cell type

# `$(call synth_read,<sources>)`: the Yosys command that reads the sources, packages first.
synth_read = read_verilog -sv -D SYNTHESIS $(1)
# `$(call synth_size,<top>,<n>)`: set an n × n array on <top>.
synth_size = chparam -set ROWS $(2) -set COLS $(2) $(1)

NEXTPNR_COMMON = --json $(1).json --freq $(SYNTH_FREQ_MHZ) --seed $(SYNTH_SEED) --timing-allow-fail \
  --report nextpnr-$(1).report.json -l nextpnr-$(1).log -q

# `$(call synth_pnr,<family>,<nextpnr command>)`: run place and route in the current directory.
# A run that stops only because the design does not fit leaves nextpnr-<family>.nofit (the error
# line) instead of a report; any other failure fails the recipe.
synth_pnr = if $(2) $(call NEXTPNR_COMMON,$(1)); then :; else status=$$?; \
  if grep -E '$(SYNTH_NO_FIT)' nextpnr-$(1).log > nextpnr-$(1).nofit; then \
    echo "nextpnr-$(1): the design does not fit: $$(cat nextpnr-$(1).nofit)"; \
  else rm -f nextpnr-$(1).nofit; echo "nextpnr-$(1) failed (exit $$status); see $$PWD/nextpnr-$(1).log" >&2; exit $$status; fi; fi

SYNTH_SUMMARY_ARGS = --dir $(BUILD_DIR) --sizes $(subst $(space),$(comma),$(strip $(SYNTH_SIZES))) \
  --allow $(SYNTH_ALLOW) --toolchain '$(TOOLCHAIN)' --toolchain-version $(OSS_CAD_SUITE_VERSION) \
  --revision $(REVISION) --freq $(SYNTH_FREQ_MHZ) --seed $(SYNTH_SEED) \
  --ice40 $(ICE40_DEVICE):$(ICE40_PACKAGE) --ecp5 $(ECP5_DEVICE):$(ECP5_PACKAGE):$(ECP5_SPEED)
empty :=
space := $(empty) $(empty)
comma := ,

.PHONY: synth synth-baseline synth-compare synth-latch-check

# $(call synth_size_target,<n>): synth-size-<n>, every flow for the n × n array.
define synth_size_target
.PHONY: synth-size-$(1)

synth-size-$(1):
	$$(call need,$(YOSYS))
	$$(call need,$(NEXTPNR_ICE40))
	@rm -rf $(call synth_size_dir,$(1)) && mkdir -p $(call synth_size_dir,$(1))
	cd $(call synth_size_dir,$(1)) && $(YOSYS) -q -l generic.log \
	  -p '$(call synth_read,$(RTL_SRCS)); $(call synth_size,matmul_top,$(1)); script $(SYNTH_SCRIPTS)/generic.ys'
	cd $(call synth_size_dir,$(1)) && $(YOSYS) -q -l ice40.log \
	  -p '$(call synth_read,$(RTL_SRCS) $(FPGA_WRAPPER)); $(call synth_size,matmul_fpga_wrapper,$(1)); script $(SYNTH_SCRIPTS)/ice40.ys'
	@cd $(call synth_size_dir,$(1)) && \
	  $$(call synth_pnr,ice40,$(NEXTPNR_ICE40) --$(ICE40_DEVICE) --package $(ICE40_PACKAGE) --pcf $(ICE40_PCF))
	@if command -v $(NEXTPNR_ECP5) > /dev/null 2>&1; then \
	  set -e; cd $(call synth_size_dir,$(1)); \
	  echo "$(YOSYS) -q -l ecp5.log … script $(SYNTH_SCRIPTS)/ecp5.ys"; \
	  $(YOSYS) -q -l ecp5.log \
	    -p '$(call synth_read,$(RTL_SRCS) $(FPGA_WRAPPER)); $(call synth_size,matmul_fpga_wrapper,$(1)); script $(SYNTH_SCRIPTS)/ecp5.ys'; \
	  $$(call synth_pnr,ecp5,$(NEXTPNR_ECP5) --$(ECP5_DEVICE) --package $(ECP5_PACKAGE) --speed $(ECP5_SPEED)); \
	else \
	  echo "nextpnr-ecp5 not found: the summary reports the ECP5 flow as absent"; \
	fi
endef
$(foreach n,$(sort $(SYNTH_ALL_SIZES) $(SYNTH_SIZES)),$(eval $(call synth_size_target,$(n))))

synth: ## Yosys + nextpnr reports for SYNTH_SIZES (4 8 16) in build/synth-*/ and build/synth/; fails on any gate
	@rm -rf $(SYNTH_DIR) && mkdir -p $(SYNTH_DIR)
	@set -e; for n in $(SYNTH_SIZES); do $(MAKE) --no-print-directory synth-size-$$n; done
	@$(NEXTPNR_ICE40) --version > $(SYNTH_DIR)/nextpnr-ice40.version 2>&1
	@if command -v $(NEXTPNR_ECP5) > /dev/null 2>&1; then \
	  $(NEXTPNR_ECP5) --version > $(SYNTH_DIR)/nextpnr-ecp5.version 2>&1; fi
	cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/accelerator-reference cli synth-summary $(SYNTH_SUMMARY_ARGS)

# synth-baseline refuses to start (before the minutes of synthesis) unless it runs every size from
# a clean tree, so the baseline's commit identifies exactly the design it measured.
ifneq ($(filter synth-baseline,$(MAKECMDGOALS)),)
  ifneq ($(sort $(SYNTH_SIZES)),$(sort $(SYNTH_ALL_SIZES)))
    $(error synth-baseline: only for SYNTH_SIZES='$(SYNTH_ALL_SIZES)', not '$(SYNTH_SIZES)')
  endif
  ifneq ($(shell git -C $(REPO_ROOT) status --porcelain),)
    $(error synth-baseline: commit or stash your changes first; the baseline must come from a clean tree)
  endif
endif

synth-baseline: synth ## Rewrite research/accelerators/matmul/synth/baseline.{json,md} from a fresh make synth from a clean tree
	@mkdir -p $(dir $(SYNTH_BASELINE))
	cp $(SYNTH_DIR)/summary.json $(SYNTH_BASELINE).json
	cp $(SYNTH_DIR)/summary.md $(SYNTH_BASELINE).md
	cd $(REPO_ROOT) && pnpm --silent exec prettier --log-level warn --write $(SYNTH_BASELINE).json $(SYNTH_BASELINE).md

synth-compare: synth ## Fail on any difference between a fresh make synth and the committed baseline
	cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/accelerator-reference cli synth-compare \
	  --baseline $(SYNTH_BASELINE).json --summary $(SYNTH_DIR)/summary.json

# Latch gate check: copies of rtl/ in build/ with one latch added to matmul_controller, once in an
# always_comb (Yosys itself rejects the latch) and once in an always @* (only the gate's
# `select -assert-none t:$dlatch` catches it). The generic flow (at 4 × 4) must fail on both and
# name the latch. The sources in rtl/ are never touched.
SYNTH_LATCH_DIR  := $(BUILD_DIR)/synth-latch
SYNTH_LATCH_comb := always_comb|Latch inferred for signal .*latch_q
SYNTH_LATCH_star := always @*|Assertion failed: selection is not empty: t:\$$dlatch

synth-latch-check: ## Prove the synth gate fails on a latch added to a scratch copy of rtl/
	$(call need,$(YOSYS))
	@rm -rf $(SYNTH_LATCH_DIR)
	@set -e; for variant in comb star; do \
	  case $$variant in comb) spec='$(SYNTH_LATCH_comb)' ;; star) spec='$(SYNTH_LATCH_star)' ;; esac; \
	  block="$${spec%%|*}"; expect="$${spec#*|}"; dir=$(SYNTH_LATCH_DIR)/$$variant; \
	  mkdir -p $$dir/rtl; cp $(RTL_SRCS) $$dir/rtl/; \
	  awk -v block="$$block" '/^endmodule/ { print "  logic latch_q;"; print "  " block " if (start) latch_q = tile_done;" } { print }' \
	    $(HW_DIR)/rtl/matmul_controller.sv > $$dir/rtl/matmul_controller.sv; \
	  grep -q 'latch_q = tile_done' $$dir/rtl/matmul_controller.sv || { echo "synth-latch-check: the latch was not added" >&2; exit 1; }; \
	  srcs="$$(for f in $(notdir $(RTL_SRCS)); do printf '%s ' $$dir/rtl/$$f; done)"; \
	  if ( cd $$dir && $(YOSYS) -q -l generic.log -p "read_verilog -sv -D SYNTHESIS $$srcs; script $(SYNTH_SCRIPTS)/generic.ys" ) \
	       > $$dir/run.log 2>&1; then \
	    echo "synth-latch-check: the synth gate passed a design with a latch ($$block)" >&2; exit 1; fi; \
	  grep -E "$$expect" $$dir/generic.log > /dev/null || { \
	    tail -n 20 $$dir/generic.log; \
	    echo "synth-latch-check: synthesis failed ($$block), but not on the latch" >&2; exit 1; }; \
	  echo "synth-latch-check: $$block latch rejected: $$(grep -m 1 -E "$$expect" $$dir/generic.log)"; \
	done
	@echo "synth-latch-check: the synth gate fails on both latches, as it should"
