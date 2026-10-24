# Waveforms: a tracing build of the matmul runner and `make wave`, which runs a case on it and
# writes an FST (or VCD) of every signal for GTKWave. docs/hardware/accelerators/simulation-guide.md
# explains how to read it.
#
#   make wave                                    tb/wave/demo.in on 4x4 → build/waves/demo.fst
#   make wave CASE=<file.in> [ROWS=8]            any case, looked up as for `simulate`
#   make wave WAVE_FORMAT=vcd                    VCD instead of FST
#   make wave-check                              the demo's dump has every signal, 4 tiles, 1 done
#
# The tracing runner is built into build/sim-trace-<R>x<C>/, apart from build/sim-<R>x<C>/, so
# `make test`, `simulate` and `verify` keep the fast untraced runner and never write a waveform.
# It writes VCD (Verilator --trace); for FST, GTKWave's vcd2fst converts it. The pinned
# Verilator's own FST writer (--trace-fst) links liblz4, which OSS CAD Suite does not ship.
#
# --trace-max-array 256 dumps every array of the datapath (skew registers, the PE grid's operand
# and accumulator buses) but not the buffer memories (each bank holds MAX_DIM² / banks ≥ 1,024
# elements), which would make the dump of every clock several times larger; the host port and
# the controller's buffer addresses, read data and C writes show what goes in and out of them.

WAVE_FORMAT ?= fst
ifeq ($(filter fst vcd,$(WAVE_FORMAT)),)
  $(error WAVE_FORMAT must be fst or vcd, not '$(WAVE_FORMAT)')
endif

SIM_TRACE_BIN := $(BUILD_DIR)/sim-trace-$(SIZE)/matmul_sim

WAVE_DIR    := $(HW_DIR)/tb/wave
WAVE_GTKW   := $(WAVE_DIR)/matmul.gtkw
WAVE_DEMO   := $(WAVE_DIR)/demo.in
WAVE_OUT    := $(BUILD_DIR)/waves
WAVE_CASE    = $(or $(CASE),$(WAVE_DEMO))
WAVE_SOURCE  = $(firstword $(wildcard $(REPO_ROOT)/$(WAVE_CASE) $(WAVE_CASE)))
WAVE_NAME    = $(basename $(notdir $(WAVE_CASE)))
WAVE_FILE    = $(WAVE_OUT)/$(WAVE_NAME).$(WAVE_FORMAT)

VCD2FST ?= $(TOOL_BIN)vcd2fst
FST2VCD ?= $(TOOL_BIN)fst2vcd

# The same sources as mk/sim.mk at ROWS x COLS, with tracing compiled in. An explicit rule, since
# mk/sim.mk's pattern build/sim-%/matmul_sim would also match build/sim-trace-<R>x<C>/.
$(SIM_TRACE_BIN): $(RTL_SRCS) $(SIM_TOP) $(SIM_CPP) $(HW_DIR)/mk/wave.mk
	$(call need,$(VERILATOR))
	@mkdir -p $(dir $@)
	$(VERILATOR) --cc --exe --build -O3 -Wall --quiet -j 0 --top-module matmul_sim_top \
	  $(SIZE_GFLAGS) --trace --trace-structs --trace-max-array 256 --timescale 1ns/1ns \
	  -CFLAGS -Wno-unknown-warning-option -Mdir $(dir $@)obj -o $@ \
	  $(RTL_SRCS) $(SIM_TOP) $(SIM_CPP) > $(dir $@)build.log
	@echo "built $@"

.PHONY: sim-trace wave wave-check

sim-trace: $(SIM_TRACE_BIN) ## Build the tracing runner build/sim-trace-<R>x<C>/matmul_sim (ROWS=4|8|16)

wave: $(SIM_TRACE_BIN) ## Write build/waves/<name>.fst of CASE (default tb/wave/demo.in) on ROWS x COLS; WAVE_FORMAT=vcd
	$(if $(filter fst,$(WAVE_FORMAT)),$(call need,$(VCD2FST)))
	@test -n "$(WAVE_SOURCE)" || { echo "wave: $(WAVE_CASE) not found" >&2; exit 2; }
	@mkdir -p $(WAVE_OUT)
	@rm -f $(WAVE_FILE)
	$(SIM_TRACE_BIN) --case $(abspath $(WAVE_SOURCE)) --wave $(WAVE_OUT)/$(WAVE_NAME).run.vcd --quiet \
	  --out $(WAVE_OUT)/$(WAVE_NAME).out --cycles $(WAVE_OUT)/$(WAVE_NAME).cycles.json
ifeq ($(WAVE_FORMAT),fst)
	$(VCD2FST) -v $(WAVE_OUT)/$(WAVE_NAME).run.vcd -f $(WAVE_FILE) > /dev/null
	@rm -f $(WAVE_OUT)/$(WAVE_NAME).run.vcd
else
	@mv $(WAVE_OUT)/$(WAVE_NAME).run.vcd $(WAVE_FILE)
endif
	@test -s $(WAVE_FILE) || { echo "wave: $(WAVE_FILE) was not written" >&2; exit 1; }
	@sed -nE 's/^  "(m|n|k|tiles|transferIn|busy|transferOut|total|stop)": "?([^",]*)"?,?$$/  \1 \2/p' \
	  $(WAVE_OUT)/$(WAVE_NAME).cycles.json
	@echo "wrote $(WAVE_FILE) ($$(wc -c < $(WAVE_FILE) | tr -d ' ') bytes, $(SIZE) array)"
	@echo "view it (from $(HW_DIR)):"
	@echo "  gtkwave build/waves/$(WAVE_NAME).$(WAVE_FORMAT) tb/wave/matmul.gtkw"

# The demo's FST, converted back to VCD with GTKWave's fst2vcd (so the check reads the file a
# viewer opens), must hold every signal the save file and the guide name, tile_done must pulse
# once per output tile and done once, and C must match tb/wave/demo.expected. The filter files in
# tb/wave/ must match the enums in rtl/matmul_pkg.sv.
wave-check: ## Check the demo waveform: every signal of matmul.gtkw present, 4 tile_done pulses, 1 done
	$(call need,$(FST2VCD))
	@$(MAKE) --no-print-directory wave CASE= ROWS=4 COLS=4 WAVE_FORMAT=fst
	$(FST2VCD) -f $(WAVE_OUT)/demo.fst -o $(WAVE_OUT)/demo.check.vcd
	@cmp -s $(WAVE_DIR)/demo.expected $(WAVE_OUT)/demo.out || \
	  { echo "wave-check: C of the demo differs from tb/wave/demo.expected" >&2; exit 1; }
	$(ACCEL_CLI) wave-check --vcd $(WAVE_OUT)/demo.check.vcd --gtkw $(WAVE_GTKW) \
	  --filters $(WAVE_DIR) --expect-tiles 4 --expect-done 1
