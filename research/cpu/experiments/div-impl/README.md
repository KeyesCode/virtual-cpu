# Experiment: combinational versus iterative DIV

The first microarchitecture experiment on VCPU-8 (brief §16). v1 divides with a combinational 8 ÷ 8 array divider inside the ALU, the simplest correct option. This experiment compares it with `vcpu8_divider`, a restoring divider that finds one quotient bit per clock. The ISA, every result and every flag stay the same; only the cycles and the hardware change.

- Definition: [experiment.json](experiment.json)
- Results of the run: [results/2026-10-17-6028b98.md](results/2026-10-17-6028b98.md) (JSON beside it)
- The divider: [docs/hardware/alu.md#iterative-divider](../../../../docs/hardware/alu.md#iterative-divider); the FSM wait: [docs/hardware/control-unit.md](../../../../docs/hardware/control-unit.md#div-with-the-iterative-divider)

## Hypothesis

The combinational divider is the deepest logic in the CPU: on both FPGAs nextpnr's critical path runs through its `a / b` line into the register file. Replacing it with an iterative divider should:

- cost 8 extra clock cycles per DIV, and nothing for any other instruction;
- remove that path, so the logic depth falls and Fmax rises;
- add a handful of flip-flops (the divider's state) and remove the divider array's logic.

On a workload with few divisions, the higher Fmax should more than pay for the extra cycles, so the iterative design should finish sooner in time.

## The variants

| Variant    | Parameters     | DIV                                                                                                                                                                               |
| ---------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `div-comb` | none           | The default design: the ALU's combinational divider, one EXECUTE cycle. DIV takes 5 clocks.                                                                                       |
| `div-iter` | `DIV_ITER = 1` | `vcpu8_divider`, started in EXECUTE after the divide-by-zero check; the FSM stays in EXECUTE until its `done` pulse, 8 cycles later. DIV takes 13 clocks. The ALU has no divider. |

`DIV_ITER` is an integer parameter on `vcpu8_top`, `vcpu8_core`, `vcpu8_control`, `vcpu8_alu`, the runner's `vcpu8_sim_top`, `vcpu8_fpga_wrapper` and the formal harness. It is an integer rather than a `DIV_IMPL` string because the experiment framework passes parameters as integers (Verilator `-G`, Yosys `chparam`). The make targets spell it `DIV_IMPL=COMB` (the default) or `DIV_IMPL=ITER`.

## Setup

- **Commit** `6028b98` (`git.dirty: false`), revision `vcpu8-mc-r1`, ISA 1.0.0, run 2026-10-17 with `make -C hardware/rtl/vcpu8 experiment NAME=div-impl`. Nothing was reused from a cache: both runners and both syntheses were built in this run.
- **Tools**, from the pinned OSS CAD Suite 2026-10-16: Verilator 5.053 (rev v5.052-448), Yosys 0.70+145, nextpnr 0.11.1-63 (ice40 and ecp5).
- **Verification**, each variant before anything was measured: `verify` on every corpus (98 fixtures, 20 examples, 12 directed programs, 2 regressions and 1,000 random programs from seed 1), with full opcode and fault coverage required.
- **Benchmark**: the 20 programs in `examples/`, each gated on the lock-step comparison with `@vcpu/cpu-core`.
- **Synthesis**: `make synth` for each variant. Generic Yosys on `vcpu8_top`, then `vcpu8_fpga_wrapper` placed and routed for the iCE40UP5K SG48 (nextpnr-ice40 timing model) and the LFE5U-25F CABGA256, speed grade 6 (nextpnr-ecp5 timing model), both at a 12 MHz target with seed 1.

## Results

Both variants passed every stage. The verify run was 1,132 cases for each, all matching the reference at every instruction boundary.

| Metric                                          |        `div-comb` |     `div-iter` |           Change |
| ----------------------------------------------- | ----------------: | -------------: | ---------------: |
| Suite cycles (20 programs, 635 instructions)    |             3,245 |          3,253 |     +8 (+0.25 %) |
| CPI                                             |             5.110 |          5.123 |           +0.013 |
| `04-division` cycles (the one DIV in the suite) |                53 |             61 |       +8 (+15 %) |
| Generic cells (`vcpu8_top`, Yosys)              |             7,480 |          7,399 |     −81 (−1.1 %) |
| Generic flip-flops                              |             2,238 |          2,267 |              +29 |
| Logic depth (gates, `ltp -noff`)                |                82 |             57 |      −25 (−30 %) |
| iCE40 LUT4 / carry / logic cells                |   727 / 143 / 906 | 744 / 88 / 874 |  +17 / −55 / −32 |
| iCE40 flip-flops                                |               150 |            179 |              +29 |
| iCE40 Fmax (12 MHz target)                      | 10.48 MHz, missed | 18.09 MHz, met |    +7.61 (+73 %) |
| iCE40 suite time (cycles / Fmax)                |          309.6 µs |       179.8 µs |   −129.8 (−42 %) |
| iCE40 `04-division` time                        |           5.06 µs |        3.37 µs |            −33 % |
| ECP5 LUT4 / carry / `TRELLIS_COMB`              |    507 / 91 / 767 | 646 / 52 / 800 | +139 / −39 / +33 |
| ECP5 flip-flops                                 |               124 |            153 |              +29 |
| ECP5 Fmax (12 MHz target)                       |    28.21 MHz, met | 41.53 MHz, met |   +13.32 (+47 %) |
| ECP5 suite time (cycles / Fmax)                 |          115.0 µs |        78.3 µs |    −36.7 (−32 %) |
| ECP5 `04-division` time                         |           1.88 µs |        1.47 µs |            −22 % |

Per program, only `04-division` changes (53 → 61 cycles); the other 19 programs execute no DIV and take exactly the same cycles. The `04-division` times and the logic-cell counts are taken from the per-variant synthesis summaries the run wrote (`hardware/rtl/vcpu8/build/variants/<hash>/synth/summary.json`); everything else is in the committed result.

## Analysis

**Cycles.** The FSM change costs exactly what it predicts: 8 cycles per DIV, nothing else. DIV holds EXECUTE for 9 cycles instead of 1, because the divider's first iteration happens at the start edge and `done` is registered. The benchmark suite retires one DIV in 635 instructions, so the suite grows by 0.25 % and CPI by 0.013. A program that divides constantly would pay up to 13 / 5 = 2.6 times the cycles per DIV.

**Timing.** This is where the iterative divider wins. Without the array divider the generic logic depth falls from 82 to 57 gates, and the longest path leaves the ALU: it now runs from the FSM state through the opcode decode, the instruction length and the next-PC adder to the RAM address. nextpnr agrees. On the iCE40 the critical path shrinks from 95.4 ns in 73 logic stages to 55.3 ns in 16, and Fmax rises from 10.48 to 18.09 MHz. The design now meets the 12 MHz target it missed, and the reviewed `Max frequency … FAIL` warning no longer appears. On the ECP5 the path shrinks from 35.5 ns in 60 stages to 24.1 ns in 16, now through the multiplier's product into FLAGS, and Fmax rises from 28.21 to 41.53 MHz.

**Time.** Cycles / Fmax falls on both devices: the whole suite runs 42 % faster on the iCE40 and 32 % faster on the ECP5. That includes `04-division`, the program that pays for the change, which still finishes a third sooner on the iCE40. From the measured numbers, the iterative design finishes later only when DIV is a large share of the instructions executed. With the suite's CPI of 5.110 for everything else, the break-even is a DIV share of 5.110 × (18.09 / 10.48 − 1) / 8 ≈ 46 % on the iCE40 and 5.110 × (41.53 / 28.21 − 1) / 8 ≈ 30 % on the ECP5. That is arithmetic on this run's figures, not a measurement.

**Area.** The changes are small and point different ways, because the two dividers map differently:

- The generic Yosys design shrinks by 81 cells. The ALU loses 205 cells (826 → 621), and the divider adds 117 and the control unit 7.
- Exactly 29 flip-flops are added, the divider's state: the divisor (8), the partial remainder (8), the quotient shift register (8), the step counter (3), `busy` and `done`.
- On both FPGAs the array divider's subtractors had ridden on the carry chains (iCE40 `SB_CARRY` 143 → 88, ECP5 `CCU2C` 91 → 52). Removing them frees carry cells rather than LUTs, while the divider's registers, muxes and the remainder logic need LUTs. On the iCE40, LUTs rise by 17, but the logic cells actually occupied (`ICESTORM_LC`, which pack a LUT, a carry and a flip-flop) fall from 906 to 874 of 5,280. On the ECP5, LUT4s rise by 139, along with wide multiplexers (`PFUMX` 73 → 144, `L6MUX21` 0 → 59), and occupied combinational slots (`TRELLIS_COMB`) rise from 767 to 800 of 24,288, or 4.3 %.

Either way the cost is a few percent of devices that are mostly empty: the CPU uses about 17 % of the iCE40UP5K's logic cells and about 3 % of the LFE5U-25F's.

**How much of this is noise.** nextpnr's estimate depends on the placement and ABC's mapping, and both move with small netlist changes. This ticket measured that directly. Adding the `DIV_ITER` parameter changed no logic in the default design, only its module names (a `$paramod` ALU). Yet it moved the committed default design's iCE40 figures from 719 LUTs at 10.63 MHz to 727 at 10.48 MHz, and its ECP5 figures from 511 LUTs at 27.11 MHz to 507 at 28.21 MHz: up to 4 % on Fmax and 1.1 % on LUTs. The baseline was rewritten for it (`research/cpu/synth/baseline.json`). The +73 % and +47 % Fmax gains are an order of magnitude above that noise, so the timing conclusion is solid. The area differences of a few percent are near it, and only their direction per device should be read from one seed.

## The variant's verification

Architectural behaviour is identical between the variants, and that was checked, not assumed:

- `make test-divider`: all 65,280 `(a, b ≠ 0)` pairs against `div()` from `@vcpu/cpu-core`, with `q × b + rem = a`, `rem < b`, the start/busy/done handshake and `done` exactly 8 cycles after start; plus start-while-busy, reset-while-busy and an X-free `b = 0` sweep. 0 mismatches.
- `make verify DIV_IMPL=ITER`: the same 1,132 cases as the default run, with the same coverage (all 30 opcodes retired, all 7 faults hit), all matching. Also run with 20,000 random programs: `make verify-long DIV_IMPL=ITER LONG_COUNT=20000`, 20,132 cases, all matching.
- `fault-divide-by-zero` passes under ITER: the DIV by zero faults in its first EXECUTE cycle with nothing written. The formal property `div_busy_execute` proves that the divider is never started then, since it would still be busy in FAULTED.
- `tb/programs/div-pc-overflow.asm` (new): a DIV at `0xFE` commits its quotient and flags before the post-commit `PC_OVERFLOW` on both variants (33 cycles on `div-comb`, 41 on `div-iter`).
- `make formal DIV_IMPL=ITER`: every core property, with EXECUTE → EXECUTE allowed only while a DIV waits and bounded to 9 cycles (`div_wait_bounded`); `core_prove` closes at k = 10.

## Recommendation

**A future revision should switch to the iterative divider.** It costs 8 cycles per DIV, which on this suite is 0.25 % more cycles, and in exchange it raises the estimated Fmax by 73 % on the iCE40UP5K and 47 % on the ECP5. That makes the whole suite, and even its DIV-heavy program, faster in time on both devices, and it is what lets the design meet 12 MHz on the iCE40. Area is roughly a wash: generic cells and iCE40 logic cells go down, ECP5 slots go up by 4 %, and 29 flip-flops are added. Only a workload in which DIV is more than about 30 % (ECP5) to 46 % (iCE40) of the instructions executed would run slower.

The switch should come with:

- **A revision bump.** Making ITER the default changes DIV's cycle count, so it is `vcpu8-mc-r2`, with a new benchmark report and synthesis baseline.
- **A look at the next critical path.** In the generic netlist the longest path now runs through the fetch and decode logic to the RAM address. nextpnr's iCE40 path runs from the RAM's read data into the register file in 16 stages, and its ECP5 path through the multiplier's product into FLAGS. The combinational multiplier is the obvious next experiment: on the iCE40 it is built from LUTs and carries, and the UP5K's DSP blocks are unused.
- **A second seed.** Before relying on the area figures, repeat the synthesis with another nextpnr seed. The timing gain is far outside the noise; the area differences are not.

This ticket keeps `COMB` as the default, as asked.

## Architecture revision

`hardware/rtl/vcpu8/REVISION` stays `vcpu8-mc-r1`. The default design's cycles are unchanged: the new default report, [2026-10-17-937d447-default](../../reports/2026-10-17-937d447-default.md), has exactly the cycle, instruction and per-program figures of the earlier `2026-10-17-4620822-default`, and differs only in its synthesis section and the time estimates derived from it. The iterative divider is a variant chosen by a parameter, and the research rules ([research/cpu/README.md](../../README.md#the-architecture-revision)) record variants in the report rather than in the revision. The result records `div-iter` with its parameters and hash (`dc2a7876cbd4`).

## Reproducing

```sh
make -C hardware/rtl/vcpu8 experiment NAME=div-impl    # about 40 s on an Apple M2 Pro, nothing cached
make -C hardware/rtl/vcpu8 test-divider
make -C hardware/rtl/vcpu8 verify DIV_IMPL=ITER
make -C hardware/rtl/vcpu8 formal DIV_IMPL=ITER
make -C hardware/rtl/vcpu8 synth DIV_IMPL=ITER         # build/synth-div-iter/summary.{json,md}
make -C hardware/rtl/vcpu8 benchmark DIV_IMPL=ITER     # with build/synth-div-iter's Fmax, once synthesised
```

Run the experiment from a clean working tree, so the result's commit identifies the design exactly.

## Limits

- **One DIV in the suite.** The benchmark programs are teaching examples. Cycle effects on real workloads depend on how often they divide; the break-even above is the way to read them.
- **Fmax is an estimate.** It is nextpnr's static timing for one placement (seed 1) per device, not a measurement on a board.
- **Static timing does not know the FSM.** The combinational divider's path was timed as one cycle, although its operands are stable from EXECUTE and its result is only written at the end of WRITEBACK. A multicycle constraint could in principle relax that path without the iterative divider, but nextpnr is given no such constraint, and this experiment did not try one.
- **Generic cells are not transistors**, and no power was measured.
