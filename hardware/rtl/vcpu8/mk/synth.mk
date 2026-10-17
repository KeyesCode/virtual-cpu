# Synthesis: Yosys and nextpnr reports for the whole CPU (docs/hardware/synthesis-guide.md).
#
#   make synth              generic Yosys flow on vcpu8_top, then iCE40 (and ECP5, if installed)
#                           synthesis and place-and-route of hardware/fpga/vcpu8_fpga_wrapper.sv;
#                           writes build/synth/summary.{json,md}
#   make synth-baseline     make synth, then copy the summary to research/cpu/synth/baseline.*
#   make synth-compare      make synth, then print the deltas against the committed baseline
#   make synth-latch-check  prove the latch gate fails on copies of core/ with a latch added
#
# make synth fails on a hierarchy, latch, loop, multiple-driver or undriven-net check in any Yosys
# run, on a missing nextpnr-ice40, and on any warning not in synth/warnings.allow. Each run starts
# from an empty build/synth/, so no report can be left over from an earlier run.

SYNTH_DIR      := $(BUILD_DIR)/synth$(VARIANT_SUFFIX)
SYNTH_SCRIPTS  := $(HW_DIR)/synth
SYNTH_ALLOW    := $(SYNTH_SCRIPTS)/warnings.allow
SYNTH_BASELINE := $(REPO_ROOT)/research/cpu/synth/baseline

FPGA_DIR       := $(REPO_ROOT)/hardware/fpga
FPGA_WRAPPER   := $(FPGA_DIR)/vcpu8_fpga_wrapper.sv
# The program built into the FPGA RAM: the demonstration program, assembled into build/synth/ by
# the TypeScript assembler, so the CPU has real work to keep.
FPGA_PROGRAM   := $(HW_DIR)/tb/programs/wave-demo.asm
FPGA_INIT_FILE := $(SYNTH_DIR)/wave-demo.mem.hex

# Place-and-route targets. Both runs use one fixed seed, so their results are reproducible.
SYNTH_FREQ_MHZ := 12
SYNTH_SEED     := 1
ICE40_DEVICE   := up5k
ICE40_PACKAGE  := sg48
ICE40_PCF      := $(FPGA_DIR)/vcpu8_up5k_sg48.pcf
ECP5_DEVICE    := 25k
ECP5_PACKAGE   := CABGA256
ECP5_SPEED     := 6

NEXTPNR_ICE40 ?= $(TOOL_BIN)nextpnr-ice40
NEXTPNR_ECP5  ?= $(TOOL_BIN)nextpnr-ecp5

# A design variant (research/cpu/experiments/README.md): `rtl-tools experiment` sets
# SYNTH_DIR=build/variants/<hash>/synth, SYNTH_DEFINES to `-DNAME[=value]` flags for read_verilog
# and SYNTH_PARAMS to `NAME=value` top-level parameters, set with chparam on each top. Both are
# empty for the committed design. DIV_IMPL=ITER sets SYNTH_PARAMS to DIV_ITER=1 (and SYNTH_DIR to
# build/synth-div-iter/); synth-baseline is for the default design only.
SYNTH_DEFINES ?=
SYNTH_PARAMS  ?= $(if $(filter 1,$(DIV_ITER)),DIV_ITER=1)
# `$(call synth_chparam,<top>)`: `; chparam -set NAME value <top>` for each SYNTH_PARAMS entry.
synth_chparam = $(foreach p,$(SYNTH_PARAMS),; chparam -set $(subst =, ,$(p)) $(1))

# `$(call synth_read,<sources>)`: the Yosys commands that read the sources, packages first.
synth_read = read_verilog -sv -D SYNTHESIS $(SYNTH_DEFINES) $(1)
# `$(call synth_fpga_read,<core sources>)`: the same plus the FPGA wrapper and its program.
synth_fpga_read = $(call synth_read,$(1) $(FPGA_WRAPPER)); \
  chparam -set INIT_FILE "$(FPGA_INIT_FILE)" vcpu8_fpga_wrapper$(call synth_chparam,vcpu8_fpga_wrapper)
# `$(call synth_generic,<sources>,<dir>)`: the generic flow, with its outputs and log in <dir>.
synth_generic = cd $(2) && $(YOSYS) -q -l generic.log -p '$(call synth_read,$(1))$(call synth_chparam,vcpu8_top); script $(SYNTH_SCRIPTS)/generic.ys'

NEXTPNR_COMMON = --json $(1).json --freq $(SYNTH_FREQ_MHZ) --seed $(SYNTH_SEED) --timing-allow-fail \
  --report nextpnr-$(1).report.json -l nextpnr-$(1).log -q

SYNTH_SUMMARY_ARGS := --dir $(SYNTH_DIR) --allow $(SYNTH_ALLOW) --toolchain '$(TOOLCHAIN)' \
  --toolchain-version $(OSS_CAD_SUITE_VERSION) --init-file $(FPGA_PROGRAM) \
  --seed $(SYNTH_SEED) --ice40 $(ICE40_DEVICE):$(ICE40_PACKAGE) --ecp5 $(ECP5_DEVICE):$(ECP5_PACKAGE):$(ECP5_SPEED)

.PHONY: synth synth-baseline synth-compare synth-latch-check

synth: ## Yosys + nextpnr synthesis reports in build/synth/; fails on any gate
	$(call need,$(YOSYS))
	$(call need,$(NEXTPNR_ICE40))
	@rm -rf $(SYNTH_DIR) && mkdir -p $(SYNTH_DIR)
	cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/rtl-tools cli assemble $(FPGA_PROGRAM) --out $(FPGA_INIT_FILE)
	$(call synth_generic,$(RTL_SRCS),$(SYNTH_DIR))
	cd $(SYNTH_DIR) && $(YOSYS) -q -l ice40.log -p '$(call synth_fpga_read,$(RTL_SRCS)); script $(SYNTH_SCRIPTS)/ice40.ys'
	cd $(SYNTH_DIR) && $(NEXTPNR_ICE40) --$(ICE40_DEVICE) --package $(ICE40_PACKAGE) --pcf $(ICE40_PCF) \
	  $(call NEXTPNR_COMMON,ice40)
	@$(NEXTPNR_ICE40) --version > $(SYNTH_DIR)/nextpnr-ice40.version 2>&1
	@if command -v $(NEXTPNR_ECP5) > /dev/null 2>&1; then \
	  set -ex; cd $(SYNTH_DIR); \
	  $(YOSYS) -q -l ecp5.log -p '$(call synth_fpga_read,$(RTL_SRCS)); script $(SYNTH_SCRIPTS)/ecp5.ys'; \
	  $(NEXTPNR_ECP5) --$(ECP5_DEVICE) --package $(ECP5_PACKAGE) --speed $(ECP5_SPEED) $(call NEXTPNR_COMMON,ecp5); \
	  $(NEXTPNR_ECP5) --version > nextpnr-ecp5.version 2>&1; \
	else \
	  echo "nextpnr-ecp5 not found: the summary reports the optional ECP5 data point as absent"; \
	fi
	cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/rtl-tools cli synth-summary $(SYNTH_SUMMARY_ARGS)

synth-baseline: synth ## Rewrite research/cpu/synth/baseline.{json,md} from a fresh make synth
	@test '$(DIV_IMPL)' = COMB || { echo "synth-baseline: only for the default design (DIV_IMPL=COMB)" >&2; exit 2; }
	@mkdir -p $(dir $(SYNTH_BASELINE))
	cp $(SYNTH_DIR)/summary.json $(SYNTH_BASELINE).json
	cp $(SYNTH_DIR)/summary.md $(SYNTH_BASELINE).md
	cd $(REPO_ROOT) && pnpm --silent exec prettier --log-level warn --write $(SYNTH_BASELINE).json $(SYNTH_BASELINE).md

synth-compare: synth ## Print a fresh make synth's deltas against the committed baseline
	cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/rtl-tools cli synth-compare \
	  --baseline $(SYNTH_BASELINE).json --summary $(SYNTH_DIR)/summary.json

# Latch gate check: copies of core/ in build/ with one latch added to vcpu8_core, once in an
# always_comb (Yosys itself rejects the latch) and once in an always @* (only the gate's
# `select -assert-none t:$dlatch` catches it). The generic flow must fail on both and name the
# latch. The sources in core/ are never touched.
SYNTH_LATCH_DIR := $(BUILD_DIR)/synth-latch
SYNTH_LATCH_comb := always_comb|Latch inferred for signal .*latch_q
SYNTH_LATCH_star := always @*|Assertion failed: selection is not empty: t:\$$dlatch

synth-latch-check: ## Prove the synth gate fails on a latch added to a scratch copy of core/
	$(call need,$(YOSYS))
	@rm -rf $(SYNTH_LATCH_DIR)
	@set -e; for variant in comb star; do \
	  case $$variant in comb) spec='$(SYNTH_LATCH_comb)' ;; star) spec='$(SYNTH_LATCH_star)' ;; esac; \
	  block="$${spec%%|*}"; expect="$${spec#*|}"; dir=$(SYNTH_LATCH_DIR)/$$variant; \
	  mkdir -p $$dir/core; cp $(RTL_SRCS) $$dir/core/; \
	  awk -v block="$$block" '/^endmodule/ { print "  logic latch_q;"; print "  " block " if (rst) latch_q = retire;" } { print }' \
	    $(HW_DIR)/core/vcpu8_core.sv > $$dir/core/vcpu8_core.sv; \
	  grep -q 'latch_q = retire' $$dir/core/vcpu8_core.sv || { echo "synth-latch-check: the latch was not added" >&2; exit 1; }; \
	  srcs="$$(for f in $(notdir $(RTL_SRCS)); do printf '%s ' $$dir/core/$$f; done)"; \
	  if ( cd $$dir && $(YOSYS) -q -l generic.log -p "read_verilog -sv -D SYNTHESIS $$srcs; script $(SYNTH_SCRIPTS)/generic.ys" ) \
	       > $$dir/run.log 2>&1; then \
	    echo "synth-latch-check: the synth gate passed a design with a latch ($$block)" >&2; exit 1; fi; \
	  grep -E "$$expect" $$dir/generic.log > /dev/null || { \
	    tail -n 20 $$dir/generic.log; \
	    echo "synth-latch-check: synthesis failed ($$block), but not on the latch" >&2; exit 1; }; \
	  echo "synth-latch-check: $$block latch rejected: $$(grep -m 1 -E "$$expect" $$dir/generic.log)"; \
	done
	@echo "synth-latch-check: the synth gate fails on both latches, as it should"
