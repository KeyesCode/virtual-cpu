# Verilator matmul runner: build/sim-<R>x<C>/matmul_sim, the Verilated matmul_top at ROWS × COLS
# (through tb/sim/matmul_sim_top.sv) driven by tb/sim/matmul_sim.cpp. It runs one case file
# through the host port and the start/busy/done handshake and writes C and the clock counts; see
# the header of matmul_sim.cpp.
#
#   make sim [ROWS=8]                            build the runner for one size
#   make sim-all                                 build it for 4x4, 8x8 and 16x16
#   make simulate CASE=<file.in> [ROWS=8] [REPEAT=N]
#
# CASE is a matmul case (`pnpm accel:gen-vectors` writes them, verify saves them under
# build/failures/); a relative path is looked up from the repository root first, then from here.
# simulate prints the clock breakdown, writes build/simulate-<R>x<C>/<name>.{out,cycles.json} and,
# when <name>.expected sits next to the case, checks C against it (exit 1 when they differ).

SIM_TOP   := $(HW_DIR)/tb/sim/matmul_sim_top.sv
SIM_CPP   := $(HW_DIR)/tb/sim/matmul_sim.cpp
SIM_SIZES := 4x4 8x8 16x16
SIM_BIN   := $(BUILD_DIR)/sim-$(SIZE)/matmul_sim

# Any <R>x<C> builds from the same sources with -GROWS=<R> -GCOLS=<C>.
$(BUILD_DIR)/sim-%/matmul_sim: $(RTL_SRCS) $(SIM_TOP) $(SIM_CPP) $(HW_DIR)/mk/sim.mk
	$(call need,$(VERILATOR))
	@mkdir -p $(dir $@)
	$(VERILATOR) --cc --exe --build -O3 -Wall --quiet -j 0 --top-module matmul_sim_top \
	  -GROWS=$(word 1,$(subst x, ,$*)) -GCOLS=$(word 2,$(subst x, ,$*)) \
	  -CFLAGS -Wno-unknown-warning-option -Mdir $(dir $@)obj -o $@ \
	  $(RTL_SRCS) $(SIM_TOP) $(SIM_CPP) > $(dir $@)build.log
	@echo "built $@"

.PHONY: sim sim-all simulate

sim: $(SIM_BIN) ## Build the Verilator matmul runner build/sim-<R>x<C>/matmul_sim (ROWS=4|8|16)

sim-all: $(foreach size,$(SIM_SIZES),$(BUILD_DIR)/sim-$(size)/matmul_sim) ## Build the runner for 4x4, 8x8 and 16x16

SIMULATE_OUT      := $(BUILD_DIR)/simulate-$(SIZE)
SIMULATE_SOURCE    = $(firstword $(wildcard $(REPO_ROOT)/$(CASE) $(CASE)))
SIMULATE_NAME      = $(basename $(notdir $(CASE)))
SIMULATE_EXPECTED  = $(basename $(SIMULATE_SOURCE)).expected

simulate: $(SIM_BIN) ## Run CASE=<file.in> on the ROWS x COLS runner: clock breakdown, C checked against <name>.expected
	@test -n "$(CASE)" || { echo "simulate: set CASE=<file.in>" >&2; exit 2; }
	@test -n "$(SIMULATE_SOURCE)" || { echo "simulate: $(CASE) not found" >&2; exit 2; }
	@mkdir -p $(SIMULATE_OUT)
	$(SIM_BIN) --case $(abspath $(SIMULATE_SOURCE)) $(if $(REPEAT),--repeat $(REPEAT)) \
	  --out $(SIMULATE_OUT)/$(SIMULATE_NAME).out --cycles $(SIMULATE_OUT)/$(SIMULATE_NAME).cycles.json
	@echo "wrote $(SIMULATE_OUT)/$(SIMULATE_NAME).out and $(SIMULATE_NAME).cycles.json"
	@if [ -f "$(SIMULATE_EXPECTED)" ]; then \
	  if cmp -s "$(SIMULATE_EXPECTED)" "$(SIMULATE_OUT)/$(SIMULATE_NAME).out"; then \
	    echo "C matches $(SIMULATE_EXPECTED) ($$(wc -l < "$(SIMULATE_EXPECTED)" | tr -d ' ') elements)"; \
	  else \
	    echo "C differs from $(SIMULATE_EXPECTED); run 'make verify' for an element-by-element report" >&2; exit 1; \
	  fi; \
	else \
	  echo "no $(SIMULATE_EXPECTED) next to the case: C not checked"; \
	fi
