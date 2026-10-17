# RTL program runner: build/sim/vcpu8_sim, the Verilated vcpu8_top driven by tb/sim/vcpu8_sim.cpp.
# It runs one 256-byte image to HALTED, FAULTED or a step/cycle limit and writes the end state
# (JSON) and a per-step trace (JSONL); see the header of vcpu8_sim.cpp.
#
#   make sim                                     build the runner
#   make simulate PROGRAM=examples/14-fibonacci.asm
#   make simulate PROGRAM=fixtures/v1/op-add.mem.hex [MAX_STEPS=N] [MAX_CYCLES=N]
#
# PROGRAM is a .asm file, assembled by @vcpu/rtl-tools with the TypeScript assembler, or a
# $readmemh image. A relative path is looked up from the repository root first, then from here.
# The outputs go to build/simulate/<name>.{mem.hex,state.json,trace.jsonl}.
#
# DIV_IMPL=ITER builds the iterative-divider runner into build/sim-div-iter/ instead.

SIM_DIR  := $(BUILD_DIR)/sim$(VARIANT_SUFFIX)
SIM_BIN  := $(SIM_DIR)/vcpu8_sim
SIM_TOP  := $(HW_DIR)/tb/sim/vcpu8_sim_top.sv
SIM_CPP  := $(HW_DIR)/tb/sim/vcpu8_sim.cpp
SIM_SRCS := $(RTL_SRCS) $(SIM_TOP)

$(SIM_BIN): $(SIM_SRCS) $(SIM_CPP)
	$(call need,$(VERILATOR))
	@mkdir -p $(SIM_DIR)
	$(VERILATOR) --cc --exe --build -O3 -Wall --quiet --top-module vcpu8_sim_top $(VARIANT_GFLAGS) \
	  -CFLAGS -Wno-unknown-warning-option -Mdir $(SIM_DIR)/obj -o $(SIM_BIN) \
	  $(SIM_SRCS) $(SIM_CPP) > $(SIM_DIR)/build.log
	@echo "built $(SIM_BIN)"

.PHONY: sim simulate

sim: $(SIM_BIN) ## Build the RTL program runner build/sim/vcpu8_sim

SIMULATE_OUT    := $(BUILD_DIR)/simulate
SIMULATE_SOURCE  = $(firstword $(wildcard $(REPO_ROOT)/$(PROGRAM) $(PROGRAM)))
SIMULATE_NAME    = $(basename $(basename $(notdir $(PROGRAM))))
SIMULATE_ARGS    = $(if $(MAX_STEPS),--max-steps $(MAX_STEPS)) $(if $(MAX_CYCLES),--max-cycles $(MAX_CYCLES))

simulate: $(SIM_BIN) ## Run PROGRAM=<file.asm|file.hex> on the RTL to HALTED or FAULTED
	@test -n "$(PROGRAM)" || { echo "simulate: set PROGRAM=<file.asm|file.mem.hex>" >&2; exit 2; }
	@test -n "$(SIMULATE_SOURCE)" || { echo "simulate: $(PROGRAM) not found" >&2; exit 2; }
	@mkdir -p $(SIMULATE_OUT)
	@case "$(SIMULATE_SOURCE)" in \
	  *.asm) cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/rtl-tools cli assemble $(abspath $(SIMULATE_SOURCE)) \
	           --out $(SIMULATE_OUT)/$(SIMULATE_NAME).mem.hex ;; \
	  *) cp $(SIMULATE_SOURCE) $(SIMULATE_OUT)/$(SIMULATE_NAME).mem.hex ;; \
	esac
	$(SIM_BIN) --image $(SIMULATE_OUT)/$(SIMULATE_NAME).mem.hex $(SIMULATE_ARGS) \
	  --state $(SIMULATE_OUT)/$(SIMULATE_NAME).state.json --trace $(SIMULATE_OUT)/$(SIMULATE_NAME).trace.jsonl
