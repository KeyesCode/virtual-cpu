# Synthesis guide

`make -C hardware/rtl/vcpu8 synth` (or `pnpm hardware:synth`) turns the VCPU-8 RTL into logic with Yosys, places and routes it on two FPGAs with nextpnr, and writes a summary of what came out. This page explains what synthesis does, what each number in the summary means and, as importantly, what it does not mean.

The short version:

- **Cell counts are not transistor counts.** A Yosys cell is an abstract logic function. An FPGA primitive is a programmable block. Neither says how many transistors a chip would need.
- **No area and no power is measured.** Nothing in this flow knows the size or the energy of a gate, so the summary claims neither.
- **The only timing figure is an FPGA estimate.** Fmax comes from nextpnr's place-and-route timing model and holds only for the device, package and speed grade named beside it. There is no ASIC clock frequency, because that needs a standard-cell (liberty) library, which this flow does not use.

## Contents

- [Running it](#running-it)
- [What synthesis does](#what-synthesis-does)
- [The flows](#the-flows)
- [What depends on what](#what-depends-on-what)
- [Results](#results)
- [Reading the reports](#reading-the-reports)
- [The gates](#the-gates)
- [Warnings](#warnings)
- [Baseline and comparison](#baseline-and-comparison)
- [Limitations](#limitations)

## Running it

```sh
make -C hardware/rtl/vcpu8 synth              # all flows; writes build/synth/summary.{json,md}
make -C hardware/rtl/vcpu8 synth-compare      # synth, then the deltas against the committed baseline
make -C hardware/rtl/vcpu8 synth-baseline     # synth, then rewrite research/cpu/synth/baseline.*
make -C hardware/rtl/vcpu8 synth-latch-check  # prove the latch gate fails on a scratch copy with a latch
```

The tools are Yosys and nextpnr from the pinned OSS CAD Suite (`pnpm hardware:setup`, [README](README.md#toolchain-setup)). `make synth` takes about ten seconds. Each run starts from an empty `build/synth/`, so no file can be left over from an earlier run.

`make synth` fails if Yosys or nextpnr-ice40 is missing, if any structural gate fails, or if any tool prints a warning that is not in the reviewed allowlist. nextpnr-ecp5 is optional: without it, the summary reports the ECP5 flow as absent.

## What synthesis does

RTL describes behaviour: "on the clock edge, if `we`, store `wdata` at `mem[addr]`", "`r = a + b`". A synthesis tool turns that description into a netlist, which is a list of logic elements and the wires between them. Yosys does this in stages, and each stage is visible in the logs in `build/synth/`.

1. **Elaboration** (`hierarchy`). Yosys reads the SystemVerilog, resolves every module, port and parameter, and builds the module tree: `vcpu8_top` contains `vcpu8_core` and `vcpu8_memory`, and the core contains the control unit, decoder, register file, FLAGS and ALU.
2. **Processes** (`proc`). Each `always_ff` block becomes flip-flops with the logic that computes their next value. Each `always_comb` block becomes plain logic. A combinational block that does not assign a signal on every path would need a latch to remember the old value. That is a design error here, and the gate catches it ([The gates](#the-gates)).
3. **Coarse optimisation and inference.** Yosys recognises larger structures: adders, comparators, multiplexers, and arrays that it can build as a memory (`$mem_v2`) rather than as separate flip-flops ([Memory inference](#memory-inference)).
4. **Mapping.** The generic flow maps everything to Yosys's internal gate library (`$_AND_`, `$_MUX_`, `$_SDFFE_PP0P_` and so on), with ABC minimising the combinational logic. The FPGA flows map instead to the FPGA's own primitives: 4-input lookup tables, carry cells, flip-flops and block RAM.
5. **Place and route** (FPGA only). nextpnr puts each primitive at a site on a real device, connects them through the device's routing, and estimates the delay of every path from the device's timing model.

## The flows

| Flow    | Script                                          | Top                  | Target                                                                 | Result                          |
| ------- | ----------------------------------------------- | -------------------- | ---------------------------------------------------------------------- | ------------------------------- |
| generic | `hardware/rtl/vcpu8/synth/generic.ys`           | `vcpu8_top`          | none: Yosys internal cells                                             | cell counts, gates, logic depth |
| iCE40   | `synth/ice40.ys`, then `nextpnr-ice40`          | `vcpu8_fpga_wrapper` | iCE40UP5K, SG48 package, pins from `hardware/fpga/vcpu8_up5k_sg48.pcf` | LUT/FF/BRAM use, Fmax estimate  |
| ECP5    | `synth/ecp5.ys`, then `nextpnr-ecp5` (optional) | `vcpu8_fpga_wrapper` | LFE5U-25F, CABGA256 package, speed grade 6, IO placed by nextpnr       | a second FPGA data point        |

The make fragment `hardware/rtl/vcpu8/mk/synth.mk` holds every flow setting: the devices, the 12 MHz timing target (the iCEBreaker board's oscillator), the nextpnr seed (1, so results are reproducible) and the program built into the RAM.

### The generic flow

`generic.ys` runs the [gates](#the-gates) on the design exactly as written, records which arrays became memories (`memory -nomap`), then runs `synth -top vcpu8_top` and writes `stat` reports per module. Next it flattens the design and remaps all logic to seven simple gate types with `abc -g AND,NAND,OR,NOR,XOR,XNOR,MUX` (ABC also uses `NOT`). It counts those gates and measures the longest gate path with `ltp -noff`.

`vcpu8_top` is synthesized with every debug port connected, so nothing is removed. A generic netlist has no RAM cell, so `synth` ends with `memory_map`, which builds the 256 × 8 RAM out of 2,048 flip-flops and their multiplexers. That makes the RAM dominate the generic total. The summary therefore also gives the core on its own (`vcpu8_core` with submodules).

### The FPGA flows and the wrapper

`vcpu8_top` has 214 port bits, far more than a small FPGA has pins. `hardware/fpga/vcpu8_fpga_wrapper.sv` keeps `clk` and `rst` and brings out eight status bits: `status`, `retire` and `PC[3:0]`. These depend on the PC, the FSM, the branch flags, and through them on the ALU, the register file and the RAM, so synthesis cannot optimise the CPU away. The wrapper passes its `rst` pin through a two-flop synchronizer. `make synth` assembles the demonstration program `hardware/rtl/vcpu8/tb/programs/wave-demo.asm` ([simulation-guide.md](simulation-guide.md)) into `build/synth/wave-demo.mem.hex` and sets the wrapper's `INIT_FILE` to it, so the RAM's power-on contents are a real program.

The wrapper does let synthesis remove the logic that only the unconnected debug ports use. That covers the 32-bit `instret` counter, `retire_pc`, `retire_op`, `fault_code`, `fault_pc` and the `dbg_*` taps. This is the main reason the FPGA flip-flop counts (150 and 124) are below the generic core's 182. On iCE40, Yosys also adds flip-flops and LUTs around the block RAM to give it the read-first behaviour that `vcpu8_memory` promises ([memory-interface.md](memory-interface.md#1-synthesizable-memory-hardware)). This is one reason the iCE40 count is higher than the ECP5 count.

The LUT counts are also far below the generic gate counts. There is no large unexplained gap:

- the RAM's 3,443 generic multiplexer and decode cells become one block RAM;
- a 4-input LUT holds any function of four inputs, which takes several 2-input generic gates;
- the adder, subtractor and divider chains go into dedicated carry cells (`SB_CARRY`, `CCU2C`);
- on ECP5, the multiplier went into one `MULT18X18D` DSP block. `synth_ice40` uses the UP5K's DSP cells only with `-dsp`, which this flow does not pass, so on iCE40 the multiplier is built from LUTs.

## What depends on what

| Figure                                      | Depends on                                                        | Technology-independent? |
| ------------------------------------------- | ----------------------------------------------------------------- | ----------------------- |
| Flip-flop count (generic)                   | the RTL and Yosys                                                 | yes                     |
| Generic cell counts by type                 | the RTL, Yosys and its internal cell set                          | yes, but tool-specific  |
| Abstract-gate count (`abc -g`)              | the RTL, Yosys/ABC and the chosen gate set                        | yes, but tool-specific  |
| Logic depth (`ltp`), in gates               | the same as the gate count                                        | yes, but tool-specific  |
| Memory inference (`$mem_v2`)                | the RTL coding style and Yosys                                    | yes                     |
| How a memory is mapped (block RAM or flops) | the target's memory primitives                                    | no                      |
| LUT, carry, FF, block RAM and DSP counts    | the FPGA family and `synth_ice40`/`synth_ecp5`                    | no                      |
| Utilisation (used / available)              | the device                                                        | no                      |
| Fmax and the critical path in ns            | device, package, speed grade, placement, nextpnr version and seed | no                      |

"Tool-specific" means the number is a property of this Yosys version's algorithms as well as of the design. A different synthesis tool, or a later Yosys, can count the same logic differently. Compare those numbers only between runs made with the same tools. The summary records the versions.

### Why cells are not transistors

A Yosys `$_AND_` cell is the logical function AND. It is not a circuit. In CMOS an AND gate is typically a NAND followed by an inverter, but a library can build it many other ways, and a `$_MUX_` or a flip-flop can take anywhere from a handful to dozens of transistors depending on the cell design. Synthesis for a real chip also merges, splits, resizes and buffers gates to meet timing. So no fixed factor turns these counts into transistors, and the summary never multiplies by one. The same holds for FPGA primitives: a LUT4 is a 16-bit configuration memory and a multiplexer tree, whatever function it implements.

### Why there is no area or power

Area needs the physical size of every cell, which only a cell library or an FPGA's own resource model gives. The FPGA utilisation percentages describe the share of one device that is used, not silicon area. Power needs that library plus switching activity from a realistic workload. None of these is part of this flow, so the summary claims neither, and RTL simulation cannot supply them either.

### Why timing needs a target

A gate takes time only when it is a real circuit: a cell in a library characterised for a process, voltage and temperature, or a LUT on a specific FPGA. The generic netlist has no delays, so its logic depth is a count of gates on the longest path, not a time. It is a useful proxy for comparing two versions of the RTL, but a gate count says nothing about nanoseconds. An ASIC clock frequency would need a liberty (`.lib`) file and static timing analysis. This project has neither, so it claims no ASIC Fmax. The Fmax figures come only from nextpnr, for the named FPGA, and each one is an estimate from its timing model, not a measurement on hardware.

## Results

These are the figures in the committed baseline, [`research/cpu/synth/baseline.md`](../../research/cpu/synth/baseline.md), which `make synth-compare` checks against a fresh run. Tools: Yosys 0.70+145 and nextpnr 0.11.1-63, OSS CAD Suite 2026-10-16.

### Generic (Yosys internal cells)

| Module                                | Cells | Flip-flops | Combinational |
| ------------------------------------- | ----: | ---------: | ------------: |
| `vcpu8_top`, whole design             | 7,480 |      2,238 |         5,242 |
| `vcpu8_core`, the CPU without the RAM | 1,981 |        182 |         1,799 |
| `vcpu8_memory` (RAM as flops)         | 5,499 |      2,056 |         3,443 |
| `vcpu8_alu`                           |   826 |          0 |           826 |
| `vcpu8_control`                       |   492 |        114 |           378 |
| `vcpu8_registers`                     |   270 |         64 |           206 |
| `vcpu8_core` (datapath muxes only)    |   251 |          0 |           251 |
| `vcpu8_decoder`                       |   134 |          0 |           134 |
| `vcpu8_flags`                         |     8 |          4 |             4 |

The memory's 2,056 flip-flops are its 2,048 storage bits and the 8-bit registered read. The core's 182 are the register file (64), FLAGS (4) and the control unit (114: the FSM state, PC, SP, SD, IR, status, the fault code and PC, the retirement outputs and the 32-bit `instret`, less any bit Yosys found to be constant).

Flattened and remapped to simple gates, the design is **7,013 cells: 2,238 flip-flops and 4,775 gates**. The longest combinational path is **83 gates**. It runs from the FSM state register, through the register-byte select (`dec_rb`), a register-file read port (`rb_data`) and the ALU result (`alu_r`), to the register file's write data (`wd`).

### Memory inference

| Memory                   | Shape                                 | Read ports        | Generic              | iCE40                     | ECP5                 |
| ------------------------ | ------------------------------------- | ----------------- | -------------------- | ------------------------- | -------------------- |
| `vcpu8_memory.mem` (RAM) | 256 × 8, 1 write port                 | 1, registered     | flip-flops and logic | block RAM (`SB_RAM40_4K`) | block RAM (`DP16KD`) |
| `vcpu8_registers.r`      | 8 × 8, 9 write ports                  | 10, combinational | flip-flops and logic | flip-flops and logic      | flip-flops and logic |
| `vcpu8_decoder`: 8 ROMs  | 8 tables of 128 words, 17 bits in all | 8, combinational  | logic                | logic                     | logic                |

Both arrays were inferred as Yosys memories. The register file stays in flip-flops on both FPGAs, and that is the right result. It has two operand read ports and eight debug read ports, all combinational, and its synchronous reset clears every word. FPGA block RAM has a registered read and no reset of its contents, so it cannot hold the register file. Its nine write ports are the one real write port plus the reset loop, which writes all eight words. The ROMs are constant tables that Yosys extracted from the `case` statements of the ISA lookup functions (`proc_rom`), indexed by opcode bits. They become plain logic.

### FPGA

| Flow  | Device                      | LUT4 | Carry | Flip-flops | Block RAM | DSP | Logic cells used              | Fmax estimate | Target | Met    |
| ----- | --------------------------- | ---: | ----: | ---------: | --------: | --: | ----------------------------- | ------------: | -----: | ------ |
| iCE40 | iCE40UP5K SG48              |  719 |   142 |        150 |         1 |   0 | 896 / 5,280 (`ICESTORM_LC`)   |     10.63 MHz | 12 MHz | **no** |
| ECP5  | LFE5U-25F CABGA256, speed 6 |  511 |    91 |        124 |         1 |   1 | 771 / 24,288 (`TRELLIS_COMB`) |     27.11 MHz | 12 MHz | yes    |

The iCE40 also uses 10 of 39 `SB_IO` pins and 2 of 8 global buffers. ECP5 also uses 74 `PFUMX` and 4 `L6MUX21` wide-multiplexer cells, 10 IO and one clock buffer (`DCCA`). The logic-cell column counts `ICESTORM_LC` on iCE40 and `TRELLIS_COMB` on ECP5, which are different structures, so the two are not directly comparable.

**Each Fmax holds only for its named device and speed grade, as estimated by nextpnr after placement and routing, with seed 1.** It is not a measurement on a board. The iCE40UP5K is a low-power part, and nextpnr-ice40 has no speed-grade option for it. On it the design misses the 12 MHz target. The ECP5 estimate meets it with room to spare.

#### The critical path

On both FPGAs the critical path ends at a register-file flip-flop and runs through the ALU's divider.

- **iCE40:** 94.09 ns: 37.56 ns of logic in 70 stages and 53.91 ns of routing (the rest is clock-to-out and setup). Of its nets, 47 come from `hardware/rtl/vcpu8/core/vcpu8_alu.sv:31`, the `a / b` of the combinational divider, and 1 from line 29, the subtractor.
- **ECP5:** 36.89 ns, with 11.18 ns of logic in 61 stages and 20.10 ns of routing. 16 of its nets come from the same divider line.

The path starts at the RAM's read data, which in OPERAND1 is the register byte that selects the register-file read ports. A register is written only in WRITEBACK, when that select comes from IR.rb instead. Static timing analysis does not know the FSM, so it times the structural path. The functional path in WRITEBACK still passes through the same register read and the same divider. The combinational divider is the brief's "simplest correct implementation first", and these numbers are the input for the divider experiment, which compares it with an iterative divider. This ticket reports them as measured and does not change the RTL.

## Reading the reports

Everything is in `hardware/rtl/vcpu8/build/synth/` after `make synth`.

| File                                    | What it is                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `summary.json`, `summary.md`            | The summary built from all the files below by `@vcpu/rtl-tools synth-summary`                                 |
| `generic.log`                           | The full Yosys log of the generic flow, every pass in order                                                   |
| `generic.memories.json`                 | The `$mem_v2` cells after `memory -nomap`, with their size, width and ports: the memory-inference result      |
| `generic.stat.txt`, `generic.stat.json` | `stat` per module after `synth`: cells by type, then a "design hierarchy" section with submodules included    |
| `generic.gates.stat.json`               | `stat` of the flattened design after `abc -g`: the abstract-gate count                                        |
| `generic.ltp.txt`                       | `ltp -noff`: the longest topological path, one cell per line                                                  |
| `generic.json`                          | The generic netlist (Yosys JSON), hierarchical                                                                |
| `ice40.log`, `ecp5.log`                 | Yosys logs of the FPGA flows; `memory_libmap` lines say how each memory was mapped                            |
| `ice40.stat.*`, `ecp5.stat.*`           | `stat` of the flattened FPGA netlists: LUTs, carries, flip-flops, RAM and DSP primitives                      |
| `ice40.json`, `ecp5.json`               | The FPGA netlists that nextpnr reads                                                                          |
| `nextpnr-*.log`                         | The place-and-route logs: utilisation, Fmax and the critical-path listing                                     |
| `nextpnr-*.report.json`                 | nextpnr's `--report`: utilisation, Fmax per clock and every critical path with per-net delays and RTL sources |

How to read the main ones:

- **`stat` cell types.** `$_AND_`, `$_OR_`, `$_XOR_`, `$_MUX_` and so on are single gates. `$_ANDNOT_` is `A & ~B` and `$_ORNOT_` is `A | ~B`. Flip-flops are `$_DFF_P_` (plain, rising edge), `$_DFFE_PP_` (with an enable), `$_SDFF_PP0_` (with a synchronous reset to 0), `$_SDFFE_PP0P_`/`PP1P_` (reset to 0 or 1, with an enable) and `$_SDFFCE_PN0P_` (an enable that also gates the reset). The letters give the polarity of each control input. The summary counts every `$_…DFF…_` type as a flip-flop and every other cell as combinational, and leaves out `$scopeinfo`, a bookkeeping cell that is not hardware.
- **Local counts and the hierarchy.** In `stat`, each module's numbers exclude its submodules, and the "design hierarchy" section adds them. The summary's per-module table shows the local counts, and "(with submodules)" rows show the subtrees.
- **`ltp`.** `length=83` counts cells on the path. Lines with a name starting `\` are signals from the RTL. The rest are wires that ABC made. The `ff:` line is the flip-flop the path ends at.
- **nextpnr utilisation.** `ICESTORM_LC` is an iCE40 logic cell (a LUT4, a carry and a flip-flop). Packing can put a LUT and a flip-flop in one cell, or use a cell for a carry alone, so the count is not the sum of LUTs and flip-flops. `ICESTORM_RAM` is a 4-kbit block RAM, `SB_GB` a global clock or reset buffer and `SB_IO` a pin.
- **nextpnr Fmax.** The log prints a "Max frequency" line twice: once after placement and once after routing. The routed figure (the second, and the one in the report JSON) is the one the summary uses. "FAIL at 12.00 MHz" means the estimate is below the `--freq` target.

## The gates

Every Yosys flow runs these checks on the design exactly as written, before any optimisation, so a defect on a signal that synthesis would later remove is still caught. Any failure stops Yosys with a non-zero exit and fails `make synth`.

| Check                                                                              | Fails on                                                                         |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `hierarchy -check -top …`                                                          | a missing module, an unknown port or parameter                                   |
| `proc`, for an `always_comb` that would need a latch                               | Yosys's own error: `Latch inferred for signal … from always_comb process`        |
| `select -assert-none t:$dlatch t:$adlatch t:$dlatchsr t:$_DLATCH_* t:$_DLATCHSR_*` | any latch, including one from an `always @*` block, which Yosys accepts silently |
| `check -assert`, after `proc` and again after mapping                              | a combinational loop, a net with more than one driver, a used net with no driver |
| the warning allowlist (`synth-summary`)                                            | any warning in any Yosys or nextpnr log that is not in `synth/warnings.allow`    |

`make synth-latch-check` proves the latch gates work. It copies `core/` into `build/synth-latch/` twice and adds a latch to `vcpu8_core` each time: `always_comb if (rst) latch_q = retire;` in one copy, and the same with `always @*` in the other. The generic flow must fail on both, on the latch: the first through Yosys's `always_comb` check, the second through the `select -assert-none` gate. `core/` itself is never touched.

## Warnings

`@vcpu/rtl-tools synth-summary` collects every line that starts with `Warning:` (or `ABC: Warning:`) in `generic.log`, `ice40.log`, `ecp5.log` and the two nextpnr logs. It matches each against the regular expressions in `hardware/rtl/vcpu8/synth/warnings.allow`. A warning that matches none of them fails `make synth`. The summary lists every warning with its count and the pattern that allowed it, and it lists any allowlist entry that matched nothing.

The allowlist has two entries. Both were reviewed against the warnings the current RTL produces:

| Warning                                                           | Where                                                   | Review                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ABC: Warning: The network is combinational …`                    | 555 times in `generic.log`, once in each FPGA Yosys log | Yosys keeps flip-flops itself and hands ABC only the combinational logic of each module, once per module and per ABC pass. ABC notes that the network it was given has no latches, so its sequential optimisations do not apply. That is how Yosys always calls ABC, and it says nothing about the design.                                                                     |
| `Warning: Max frequency for clock '…': N MHz (FAIL at 12.00 MHz)` | `nextpnr-ice40.log`                                     | The iCE40UP5K estimate misses the 12 MHz target because of the single-cycle combinational divider (see [the critical path](#the-critical-path)). Per this ticket's scope it is reported as measured, with `meetsConstraint: false` in the summary, and the RTL is not changed. The pattern accepts only this exact message, so any other nextpnr warning still fails the gate. |

Yosys printed no warning of its own about the RTL: no width mismatches, no undriven or unused-but-driven nets, no implicit declarations. If a change produces one, read it, fix the RTL if it is a real problem, and add an allowlist entry, with its review as a comment, only if the design is correct as it stands.

## Baseline and comparison

`research/cpu/synth/baseline.json` and `baseline.md` are the committed summary. [research/cpu/README.md](../../research/cpu/README.md) describes the folder. Only `make synth-baseline` rewrites them. `make synth-compare` reruns synthesis and prints every value that differs from the baseline, by its path in the JSON, for example `fpga.ice40.synth.luts: 719 → 731 (+12)`. It ignores the `provenance` block (git commit, tool versions) and prints differences there only as notes. On an unchanged tree it reports 0 deltas. Yosys and nextpnr are deterministic with a fixed seed, which repeated runs confirm.

Rewrite the baseline when a change moves the numbers on purpose, and commit it in the same change, so the diff shows the cost.

## Limitations

- No ASIC flow, no standard-cell library and therefore no ASIC timing, area or power.
- Fmax is a nextpnr estimate for the named devices. Nobody has measured it on a board. Board bring-up and bitstream programming are Project 5.
- The pin file follows the iCEBreaker layout for concreteness, but no board has been tested with it. The ECP5 IO is placed by nextpnr.
- Static timing analysis does not know the FSM, so it times structural paths that the control unit never exercises in one cycle. A multicycle constraint could exclude them, but nextpnr is not given one.
- The FPGA counts describe the CPU behind `vcpu8_fpga_wrapper`, without the debug-only logic. The generic counts describe the full `vcpu8_top`, debug ports included.
