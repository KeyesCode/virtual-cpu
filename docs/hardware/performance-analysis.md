# Performance analysis

This document reports how many clock cycles the VCPU-8 RTL (revision `vcpu8-mc-r1`) spends on the Project 1 benchmark programs. It compares those cycles with the emulator's instructional timing model, and it turns them into an estimated run time from the synthesis Fmax. Every number below comes from the committed report [research/cpu/reports/2026-10-17-4620822-default.md](../../research/cpu/reports/2026-10-17-4620822-default.md) (JSON beside it). That report was written by `make -C hardware/rtl/vcpu8 benchmark-baseline` at commit `4620822`, from a clean working tree.

```sh
make -C hardware/rtl/vcpu8 benchmark            # build/reports/benchmark.{json,md}
make -C hardware/rtl/vcpu8 benchmark-compare    # rerun, and require the committed report's numbers
pnpm hardware:benchmark                         # the same as make benchmark, from the repository root
```

## What is measured

The benchmark runs the 20 programs in `examples/`, the same set `pnpm bench` (`@vcpu/benchmarks`) times on the emulator. Each program runs on the RTL runner (`build/sim/vcpu8_sim`, the Verilated `vcpu8_top`). The runner counts clock edges from reset release, and its trace records the cycle count at every `retire` pulse. From that trace `@vcpu/rtl-tools` computes:

- **total clock cycles**, **retired instructions** (`instret`) and **CPI**;
- **cycles per instruction class and per opcode**: the clocks between one instruction's `retire` pulse and the previous one's, grouped by the ISA class (`system`, `data`, `arithmetic`, `logic`, `control`, `stack`) and by opcode;
- **conditional branches taken and not taken**: a JZ, JNZ, JC or JNC is taken when its condition held on the flags before it, which also settles a branch whose target is the next instruction. It also counts **jumps, calls and returns**;
- **data-memory reads and writes** (LOAD, POP, RET read; STORE, PUSH, CALL write), from the opcode table. Instruction fetches are counted apart, as fetched bytes;
- the emulator's **instructional-model estimated cycles** for the same run (below);
- an **estimated execution time** = cycles / Fmax for each FPGA flow in the synthesis baseline.

### The correctness gate

No number is reported for a run that is not correct. Before any metric is computed, each program also runs live on `@vcpu/cpu-core`, and the differential comparator of `make verify` ([verification-strategy.md](verification-strategy.md)) checks two things. Every trace step must match: PC, registers, FLAGS, SP, SD, status, fault, next PC and memory writes. The full end state must match too, including all 256 memory bytes. The program must also halt within its `.expect.json` `maxInstructions`. A program that reaches its step limit or faults is a failure. Finally, the branch, data-access and fetched-byte counts taken from the RTL trace must equal the emulator's own counters, so a metric bug cannot pass unnoticed.

A program that fails gets status `failed`, a reason and its first differences, and no numbers. The suite then has no totals, and the benchmark exits 1. `make benchmark-mutant-check` proves this on a mutant runner. It builds the `alu-shr-carry` mutant (SHR shifts bit 1 into C) with the verify ticket's mutant infrastructure and runs the benchmark against it. `09-shift-right` fails (`step 6 flags: expected 4, actual 0`), the other 19 programs keep their numbers, and the suite has no totals.

## CPI

```text
CPI = total clock cycles / retired instructions
```

Total clock cycles count from reset release to the clock edge where the CPU stops (the HLT's `retire`). Retired instructions are `instret`; HLT is one of them. A program that retires nothing has no CPI (`null`), never a division by zero. The unit tests in `packages/rtl-tools/src/bench/metrics.test.ts` check the formula and that case.

## Results

All 20 programs passed the correctness gate.

| Program               | Instructions | RTL cycles |   RTL CPI | Branches taken / not | Calls / returns | Data reads / writes | Model cycles | Model CPI |
| --------------------- | -----------: | ---------: | --------: | -------------------: | --------------: | ------------------: | -----------: | --------: |
| 01-addition           |            4 |         21 |     5.250 |                0 / 0 |           0 / 0 |               0 / 0 |           13 |     3.250 |
| 02-subtraction        |            9 |         50 |     5.556 |                0 / 0 |           0 / 0 |               0 / 2 |           34 |     3.778 |
| 03-multiplication     |            9 |         50 |     5.556 |                0 / 0 |           0 / 0 |               0 / 2 |           40 |     4.444 |
| 04-division           |           10 |         53 |     5.300 |                0 / 0 |           0 / 0 |               0 / 2 |           45 |     4.500 |
| 05-and                |           14 |         78 |     5.571 |                0 / 0 |           0 / 0 |               0 / 3 |           53 |     3.786 |
| 06-or                 |            9 |         50 |     5.556 |                0 / 0 |           0 / 0 |               0 / 2 |           34 |     3.778 |
| 07-xor                |           13 |         71 |     5.462 |                0 / 0 |           0 / 0 |               0 / 3 |           48 |     3.692 |
| 08-shift-left         |            9 |         48 |     5.333 |                0 / 0 |           0 / 0 |               0 / 2 |           32 |     3.556 |
| 09-shift-right        |           45 |        230 |     5.111 |               10 / 6 |           0 / 0 |               0 / 2 |          152 |     3.378 |
| 10-compare            |           17 |         94 |     5.529 |                0 / 3 |           0 / 0 |               0 / 3 |           63 |     3.706 |
| 11-conditional-branch |           13 |         69 |     5.308 |                1 / 1 |           0 / 0 |               0 / 2 |           46 |     3.538 |
| 12-countdown          |           54 |        261 |     4.833 |                9 / 1 |           0 / 0 |              0 / 11 |          173 |     3.204 |
| 13-sum-integers       |           57 |        288 |     5.053 |               1 / 10 |           0 / 0 |               0 / 1 |          186 |     3.263 |
| 14-fibonacci          |           85 |        428 |     5.035 |                9 / 1 |           0 / 0 |              0 / 10 |          277 |     3.259 |
| 15-factorial-overflow |           48 |        244 |     5.083 |               10 / 2 |           0 / 0 |               0 / 7 |          183 |     3.813 |
| 16-array-sum          |           58 |        295 |     5.086 |               12 / 4 |           0 / 0 |               8 / 2 |          201 |     3.466 |
| 17-array-max          |           70 |        356 |     5.086 |               12 / 4 |           0 / 0 |               9 / 2 |          239 |     3.414 |
| 18-memory-copy        |           40 |        202 |     5.050 |                5 / 1 |           0 / 0 |               6 / 6 |          139 |     3.475 |
| 19-subroutines        |           16 |         79 |     4.938 |                0 / 0 |           3 / 3 |               3 / 4 |           66 |     4.125 |
| 20-stack              |           55 |        278 |     5.055 |                8 / 2 |           0 / 0 |             10 / 10 |          196 |     3.564 |
| **total**             |      **635** |   **3245** | **5.110** |              77 / 35 |           3 / 3 |             36 / 76 |     **2220** | **3.496** |

The suite retires 635 instructions in 3,245 clock cycles, a CPI of 5.110. Per program, CPI ranges from 4.833 (`12-countdown`) to 5.571 (`05-and`). Programs heavy in 3-byte instructions (LDI and the absolute LOAD/STORE) sit higher, and loops of 2-byte instructions with a HLT or RET sit lower.

### Per class

Clocks between consecutive `retire` pulses, over the whole suite:

| Class      | Instructions | Cycles |   CPI | Min clocks | Max clocks |
| ---------- | -----------: | -----: | ----: | ---------: | ---------: |
| system     |           30 |    120 | 4.000 |          4 |          4 |
| data       |          210 |   1153 | 5.490 |          5 |          6 |
| arithmetic |          208 |   1040 | 5.000 |          5 |          5 |
| logic      |           49 |    245 | 5.000 |          5 |          5 |
| control    |          128 |    637 | 4.977 |          4 |          5 |
| stack      |           10 |     50 | 5.000 |          5 |          5 |

Every opcode took the same number of clocks every time it ran (the minimum equals the maximum per opcode). The number depends only on the instruction's length and on whether it has an operand phase: 4 for the 1-byte NOP, HLT and RET, 5 for every 2-byte instruction, 6 for every 3-byte instruction. These are exactly the counts measured on the 98 fixtures in [vcpu8-microarchitecture.md](vcpu8-microarchitecture.md#clocks-per-instruction). The `data` class mixes 5-clock MOV and indirect LOAD/STORE with 6-clock LDI and absolute LOAD/STORE. The `control` class mixes 5-clock jumps, branches and CALL with the 4-clock RET.

## Compared with the instructional timing model

The emulator reports **estimated cycles** from the instructional timing model ([instruction-set.md](../instruction-set.md#timing-model)): 1 cycle per instruction byte, 1 for execute, 1 per data access, extra cycles for MUL and DIV, and 1 more when control transfers. The model is a teaching aid for comparing programs. It is not a circuit, and nothing measured it. The RTL cycles are clock edges of a real (simulated) circuit. The two must not be mixed, and every report labels them separately. [hardware-porting.md](../hardware-porting.md#instructional-timing-vs-real-cycles) explains the difference in general. Here are the two side by side for every opcode the suite ran. The model column is the opcode table's `baseCycles`, plus `branchTakenPenalty` when control transfers.

| Opcode                           | Length | Retired | RTL clocks | Model cycles |
| -------------------------------- | -----: | ------: | ---------: | -----------: |
| NOP, HLT                         |      1 |      30 |          4 |            2 |
| RET                              |      1 |       3 |          4 |        3 + 1 |
| MOV                              |      2 |      42 |          5 |            3 |
| ADD, SUB, INC, DEC               |      2 |     196 |          5 |            3 |
| AND, OR, XOR, NOT, SHL, SHR, CMP |      2 |      49 |          5 |            3 |
| MUL                              |      2 |      11 |          5 |            6 |
| DIV                              |      2 |       1 |          5 |           10 |
| LOAD/STORE `[Rp]`                |      2 |      65 |          5 |            4 |
| PUSH, POP                        |      2 |      10 |          5 |            4 |
| JMP, JZ, JNZ, JC, JNC            |      2 |     122 |          5 |        3 + 1 |
| CALL                             |      2 |       3 |          5 |        4 + 1 |
| LDI                              |      3 |      72 |          6 |            4 |
| LOAD/STORE `[addr8]`             |      3 |      31 |          6 |            5 |

Over the suite the model estimates 2,220 cycles (CPI 3.496), against 3,245 measured RTL cycles (CPI 5.110). The RTL takes 1.46 times as many cycles. The reasons:

- **The FSM spends separate clocks on DECODE and WRITEBACK.** The model charges one cycle per byte plus one for execute. The RTL adds a DECODE state after the fetch and a WRITEBACK state after EXECUTE, which is 2 more clocks on every instruction. An ALU instruction costs 3 in the model and 5 on the RTL.
- **Data accesses overlap.** A LOAD's read is addressed in EXECUTE and arrives in WRITEBACK, and a STORE or PUSH writes in WRITEBACK, so a data access adds no state. The model charges 1 extra cycle for it. That is why LOAD/STORE and PUSH/POP are only 1 clock above the model, against 2 for ALU instructions.
- **MUL and DIV are combinational.** The model charges MUL 6 and DIV 10, for an iterative unit. This design multiplies and divides in one EXECUTE clock, so both take 5, fewer than the model. `03-multiplication` and `04-division` therefore have the lowest RTL-to-model ratios in the suite (1.250 and 1.178). The prediction of 12 clocks for an 8-iteration divider in hardware-porting.md is for a design this one is not; the iterative divider is the next experiment.
- **No taken-branch penalty** (next section).

`19-subroutines` also has a low ratio (1.197). Its CALL, RET, PUSH and POP each pay a data-access cycle in the model that the RTL hides in WRITEBACK.

## Branch behaviour

The design has no pipeline and does not fetch ahead, so a taken branch costs exactly what a branch not taken costs. Nothing has to be flushed. The suite ran 112 conditional branches: 77 taken and 35 not taken. Every one took 5 clocks: JNZ, for example, retired 67 times, with a minimum and maximum of 5 clocks. JMP and CALL also take 5 clocks, the same as any 2-byte instruction. The model adds 1 cycle whenever control transfers, so it charges taken branches more than branches not taken; the RTL does not.

Branch outcomes are still reported per program. They describe the program's behaviour, and a future pipelined revision would pay for each taken branch. Then the same counts would explain its CPI.

## Estimated execution time

```text
estimated time (µs) = RTL cycles / Fmax (MHz)
```

The Fmax comes from the committed synthesis baseline, [research/cpu/synth/baseline.json](../../research/cpu/synth/baseline.json) (synthesised at `f6f9ef7`). There, nextpnr placed and routed the CPU in `hardware/fpga/vcpu8_fpga_wrapper.sv` for two devices:

| FPGA flow | Device and timing model                                                          | Fmax (MHz) | Suite (3,245 cycles) |
| --------- | -------------------------------------------------------------------------------- | ---------: | -------------------: |
| iCE40     | iCE40UP5K SG48, nextpnr-ice40 timing model (the device has a single speed grade) |      10.63 |            305.27 µs |
| ECP5      | LFE5U-25F CABGA256, speed grade 6, nextpnr-ecp5 timing model                     |      27.11 |            119.70 µs |

Per-program estimates are in the report (`14-fibonacci`: 428 cycles, 40.26 µs on the iCE40 and 15.79 µs on the ECP5). Caveats:

- **It is an estimate, not a measurement.** Fmax is nextpnr's static timing analysis of one placement (seed 1), with its device timing model. Nothing ran on hardware. Another seed, another nextpnr version or a small RTL change moves it. The iCE40 build does not meet its 12 MHz constraint, so the design as it stands cannot run at 12 MHz on that part.
- **Cycles are exact; the time inherits the estimate's error.** The cycle counts are deterministic. The time is only as good as the Fmax, and it is labelled with the device and timing model it came from.
- **It covers the CPU alone.** It leaves out loading the program, I/O, and anything a board would add. The synthesised design is the FPGA wrapper with the demo program in its RAM, not exactly the design the runner simulates (the runner loads the RAM through DPI).
- **No synthesis, no time.** Without a synthesis summary (`BENCH_SYNTH=none`, or a missing or failing summary), the report says why and leaves the time estimates out. The run does not fail.

The critical path (in the baseline, through the ALU into the register file) sets Fmax. A design that trades cycles for a shorter path can therefore be faster in time while being slower in cycles. Comparing that trade is what the experiment framework is for.

## Host runtime is not processor performance

Every report has a separate `host` section. It records how long this machine took to simulate each program: the live `@vcpu/cpu-core` reference and the RTL runner process. It also records the runtime and the CPU model. For the committed report the suite took 125 ms of wall-clock time on an Apple M2 Pro. Three runs measured 125, 133 and 139 ms. That is simulator speed. It says nothing about the processor, it varies from run to run, and it is never mixed into the modelled numbers. The Markdown report prints it last, under its own heading.

## Reproducibility

Everything except `provenance` (time, commit, runner path, tool versions) and `host` is deterministic. Two runs of `make benchmark` give byte-identical JSON once those two sections are removed:

```sh
make -C hardware/rtl/vcpu8 benchmark && cp hardware/rtl/vcpu8/build/reports/benchmark.json /tmp/run1.json
make -C hardware/rtl/vcpu8 benchmark
pnpm --silent --filter @vcpu/rtl-tools cli benchmark-compare --baseline /tmp/run1.json \
  --report hardware/rtl/vcpu8/build/reports/benchmark.json
# benchmark-compare: the modelled sections are byte-identical (provenance and host removed)
```

`jq 'del(.provenance, .host)'` on both files gives the same result. `make benchmark-compare` runs the same check against the newest committed `research/cpu/reports/*-default.json`, and it fails when the design's cycles have changed. When they change on purpose, bump `hardware/rtl/vcpu8/REVISION` ([research/cpu/README.md](../../research/cpu/README.md#the-architecture-revision)) and commit a new report with `make benchmark-baseline`.

## Running an experiment

A microarchitecture change is evaluated as an experiment. It compares variants of the RTL (Verilog defines or parameters, never a different ISA), and each variant is verified, benchmarked and synthesised:

```sh
make -C hardware/rtl/vcpu8 experiment NAME=smoke
```

[research/cpu/experiments/README.md](../../research/cpu/experiments/README.md) documents `experiment.json`, the stages and what gets committed. The `smoke` experiment runs the committed design as its only variant. Its result, [research/cpu/experiments/smoke/results/2026-10-17-4620822.md](../../research/cpu/experiments/smoke/results/2026-10-17-4620822.md), shows the variant passing verify on 331 cases (fixtures, examples, directed programs, regressions and 200 random programs). Its benchmark gives 3,245 cycles at CPI 5.110, with 53 cycles for the DIV-heavy program `04-division`. Synthesis gives 7,480 generic cells, 2,238 flip-flops, 719 iCE40 LUTs at 10.63 MHz and 511 ECP5 LUTs at 27.11 MHz. These match the baseline report and the synthesis baseline.

## Limits of these numbers

- **The suite is small.** It has 20 teaching programs and 635 retired instructions. DIV retires once, JC once and LOAD `[addr8]` once. The per-class CPI reflects this program mix, not a representative workload.
- **Cycle counts are from simulation.** They are the cycles of the RTL as Verilated. They hold for the same RTL on an FPGA only if timing closes at the chosen clock.
- **Generic cells are not transistors.** The cell counts in the reports are generic Yosys cells and FPGA LUTs ([synthesis-guide.md](synthesis-guide.md)). They are not silicon area, and nothing here measures power.
