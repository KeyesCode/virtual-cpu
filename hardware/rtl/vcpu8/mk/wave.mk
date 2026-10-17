# Waveforms: a tracing build of the RTL runner and `make wave`, which runs a program on it and
# writes an FST (or VCD) of every signal for GTKWave. docs/hardware/simulation-guide.md explains how
# to read it.
#
#   make wave                                    tb/programs/wave-demo.asm → build/waves/wave-demo.fst
#   make wave PROGRAM=examples/14-fibonacci.asm  any .asm or .mem.hex, looked up as for `simulate`
#   make wave WAVE_FORMAT=vcd [MAX_CYCLES=N]     VCD instead of FST; MAX_CYCLES defaults to 10,000
#   make wave-check                              the demo's dump has every signal and 15 retirements
#
# The tracing runner is built into build/sim-trace/, apart from build/sim/, so `make test`,
# `simulate` and `fixtures` keep the fast untraced runner and never write a waveform. It writes VCD
# (Verilator --trace); for FST, GTKWave's vcd2fst converts it. The pinned Verilator's own FST
# writer (--trace-fst) links liblz4, which OSS CAD Suite does not ship.

WAVE_FORMAT ?= fst
ifeq ($(filter fst vcd,$(WAVE_FORMAT)),)
  $(error WAVE_FORMAT must be fst or vcd, not '$(WAVE_FORMAT)')
endif

SIM_TRACE_DIR := $(BUILD_DIR)/sim-trace$(VARIANT_SUFFIX)
SIM_TRACE_BIN := $(SIM_TRACE_DIR)/vcpu8_sim

WAVE_DIR      := $(HW_DIR)/tb/wave
WAVE_GTKW     := $(WAVE_DIR)/vcpu8.gtkw
WAVE_DEMO     := $(HW_DIR)/tb/programs/wave-demo.asm
WAVE_OUT      := $(BUILD_DIR)/waves
WAVE_PROGRAM   = $(or $(PROGRAM),$(WAVE_DEMO))
WAVE_SOURCE    = $(firstword $(wildcard $(REPO_ROOT)/$(WAVE_PROGRAM) $(WAVE_PROGRAM)))
WAVE_NAME      = $(basename $(basename $(notdir $(WAVE_PROGRAM))))
WAVE_FILE      = $(WAVE_OUT)/$(WAVE_NAME).$(WAVE_FORMAT)

VCD2FST ?= $(TOOL_BIN)vcd2fst
FST2VCD ?= $(TOOL_BIN)fst2vcd

$(SIM_TRACE_BIN): $(SIM_SRCS) $(SIM_CPP)
	$(call need,$(VERILATOR))
	@mkdir -p $(SIM_TRACE_DIR)
	$(VERILATOR) --cc --exe --build -O3 -Wall --quiet --top-module vcpu8_sim_top $(VARIANT_GFLAGS) \
	  --trace --trace-structs --trace-max-array 256 --timescale 1ns/1ns \
	  -CFLAGS -Wno-unknown-warning-option -Mdir $(SIM_TRACE_DIR)/obj -o $(SIM_TRACE_BIN) \
	  $(SIM_SRCS) $(SIM_CPP) > $(SIM_TRACE_DIR)/build.log
	@echo "built $(SIM_TRACE_BIN)"

.PHONY: sim-trace wave wave-check

sim-trace: $(SIM_TRACE_BIN) ## Build the tracing runner build/sim-trace/vcpu8_sim

wave: $(SIM_TRACE_BIN) ## Write build/waves/<name>.fst for PROGRAM (default the demo); WAVE_FORMAT=vcd
	$(if $(filter fst,$(WAVE_FORMAT)),$(call need,$(VCD2FST)))
	@test -n "$(WAVE_SOURCE)" || { echo "wave: $(WAVE_PROGRAM) not found" >&2; exit 2; }
	@mkdir -p $(WAVE_OUT)
	@case "$(WAVE_SOURCE)" in \
	  *.asm) cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/rtl-tools cli assemble $(abspath $(WAVE_SOURCE)) \
	           --out $(WAVE_OUT)/$(WAVE_NAME).mem.hex ;; \
	  *) cp $(WAVE_SOURCE) $(WAVE_OUT)/$(WAVE_NAME).mem.hex ;; \
	esac
	$(SIM_TRACE_BIN) --image $(WAVE_OUT)/$(WAVE_NAME).mem.hex --max-cycles $(or $(MAX_CYCLES),10000) \
	  $(if $(MAX_STEPS),--max-steps $(MAX_STEPS)) --wave $(WAVE_OUT)/$(WAVE_NAME).run.vcd --quiet \
	  --state $(WAVE_OUT)/$(WAVE_NAME).state.json --trace $(WAVE_OUT)/$(WAVE_NAME).trace.jsonl
ifeq ($(WAVE_FORMAT),fst)
	$(VCD2FST) -v $(WAVE_OUT)/$(WAVE_NAME).run.vcd -f $(WAVE_FILE) > /dev/null
	@rm -f $(WAVE_OUT)/$(WAVE_NAME).run.vcd
else
	@mv $(WAVE_OUT)/$(WAVE_NAME).run.vcd $(WAVE_FILE)
endif
	@test -s $(WAVE_FILE) || { echo "wave: $(WAVE_FILE) was not written" >&2; exit 1; }
	@sed -nE 's/^  "(status|stopReason|instructions|cycles)": "?([^",]*)"?,?$$/  \1 \2/p' \
	  $(WAVE_OUT)/$(WAVE_NAME).state.json
	@echo "wrote $(WAVE_FILE)"
	@echo "view it (from $(HW_DIR)):"
	@echo "  gtkwave build/waves/$(WAVE_NAME).$(WAVE_FORMAT) tb/wave/vcpu8.gtkw"

# The demo's FST, converted to VCD with GTKWave's fst2vcd, must hold every signal the save file and
# the guide name, and retire must pulse once per instruction the TypeScript emulator retires on the
# same image. The filter files in tb/wave/ must match the enums in core/vcpu8_types_pkg.sv.
wave-check: ## Check the demo waveform: every signal of vcpu8.gtkw present, retire count = emulator's
	$(call need,$(FST2VCD))
	@$(MAKE) --no-print-directory wave PROGRAM= WAVE_FORMAT=fst
	$(FST2VCD) -f $(WAVE_OUT)/wave-demo.fst -o $(WAVE_OUT)/wave-demo.check.vcd
	cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/rtl-tools cli wave-check \
	  --vcd $(WAVE_OUT)/wave-demo.check.vcd --image $(WAVE_OUT)/wave-demo.mem.hex \
	  --gtkw $(WAVE_GTKW) --filters $(WAVE_DIR)
