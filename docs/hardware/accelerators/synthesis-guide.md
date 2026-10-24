# Accelerator synthesis guide

`make -C hardware/accelerators/matmul synth` (or `pnpm accel:synth`) turns the matmul accelerator RTL into logic with Yosys for the three required array sizes, 4 × 4, 8 × 8 and 16 × 16. It then places and routes each size on two FPGAs with nextpnr, where the design fits, and writes one summary that compares them. This page explains the flows, the target technologies and the numbers they produce. It also says what those numbers do not mean.

The short version:

- **Cell counts are not transistors and not area.** A Yosys cell is an abstract logic function, and an FPGA primitive is a programmable block. Neither one says how much silicon a chip would need.
- **The only timing figure is an FPGA estimate.** Fmax comes from nextpnr's timing model, holds only for the device, package and speed grade named beside it, and exists only where the design fits that device.
- **Power is not measured.** Nothing in this flow models energy, so the summary says "not measured" and never gives a number.
- **Every size runs with identical settings.** The scripts, devices, 12 MHz constraint and nextpnr seed are the same for every size, and the same as VCPU-8's flow ([Project 2's synthesis guide](../synthesis-guide.md)), so sizes can be compared with each other and with the CPU.

The general background on what synthesis does, why cells are not transistors and why timing needs a target is in the [Project 2 guide](../synthesis-guide.md#what-synthesis-does). This page covers what is specific to the accelerator.

## Contents

- [Running it](#running-it)
- [The flows](#the-flows)
- [The FPGA wrapper](#the-fpga-wrapper)
- [Results](#results)
- [How the multipliers map](#how-the-multipliers-map)
- [Memories](#memories)
- [Fit and Fmax](#fit-and-fmax)
- [Reading the numbers](#reading-the-numbers)
- [Comparing designs fairly](#comparing-designs-fairly)
- [The gates](#the-gates)
- [Warnings](#warnings)
- [Baseline and comparison](#baseline-and-comparison)
- [Limitations](#limitations)

## Running it

```sh
make -C hardware/accelerators/matmul synth                  # 4x4, 8x8 and 16x16; build/synth-<R>x<C>/ and build/synth/summary.{json,md}
make -C hardware/accelerators/matmul synth SYNTH_SIZES=4    # fewer sizes (not for the baseline)
make -C hardware/accelerators/matmul synth-size-8           # one size's flows, no summary
make -C hardware/accelerators/matmul synth-compare          # synth, then fail on any difference from the baseline
make -C hardware/accelerators/matmul synth-baseline         # synth, then rewrite research/accelerators/matmul/synth/baseline.*
make -C hardware/accelerators/matmul synth-latch-check      # prove the latch gate fails on a scratch copy with a latch
```

The tools are Yosys and nextpnr from the pinned OSS CAD Suite (`pnpm hardware:setup`, the same suite as Project 2). On an Apple M-series laptop, the three sizes take about 25 seconds, 1 minute and 3½ minutes. Most of that is `synth_ice40` mapping hundreds of multipliers into LUTs. Each size's outputs go to its own directory, `build/synth-4x4/`, `build/synth-8x8/` and `build/synth-16x16/`, and the summary over all of them goes to `build/synth/`. Every run starts from empty directories, so no report can be left over from an earlier run.

`make synth` fails if Yosys or nextpnr-ice40 is missing, if a [gate](#the-gates) fails in any Yosys run, if nextpnr fails for any reason other than "the design does not fit", or if a tool prints a warning that is not in the [reviewed allowlist](#warnings). nextpnr-ecp5 is optional: without it, the summary reports the ECP5 flow as absent. A design that does not fit a device is a result, not a failure. The summary records it with the utilisation nextpnr reported.

## The flows

| Flow    | Script                                          | Top                   | Target                                                                  | Result                                                  |
| ------- | ----------------------------------------------- | --------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| generic | `hardware/accelerators/matmul/synth/generic.ys` | `matmul_top`          | none: Yosys internal cells, no library                                  | cells, flip-flops, `$mul`, memories, gates, logic depth |
| iCE40   | `synth/ice40.ys`, then `nextpnr-ice40`          | `matmul_fpga_wrapper` | iCE40UP5K, SG48 package, pins from `hardware/fpga/matmul_up5k_sg48.pcf` | LUT/FF/BRAM/DSP use, fit, Fmax estimate                 |
| ECP5    | `synth/ecp5.ys`, then `nextpnr-ecp5` (optional) | `matmul_fpga_wrapper` | LFE5U-25F, CABGA256 package, speed grade 6, IO placed by nextpnr        | a second FPGA data point                                |

`hardware/accelerators/matmul/mk/synth.mk` holds every setting. The size is set with `chparam -set ROWS n -set COLS n` on the top, so all three sizes come from one RTL. The timing constraint is `--freq 12`, the iCEBreaker board's 12 MHz oscillator. The nextpnr seed is 1 so results are reproducible. Both match VCPU-8's flow.

The two FPGAs are the small parts that the open toolchain supports well:

- **iCE40UP5K**: 5,280 logic cells (a 4-input LUT plus a flip-flop each), 30 block RAMs of 4 Kibit (120 Kibit in all), 8 DSP blocks (`SB_MAC16`) and 4 single-port 256 Kibit SPRAMs.
- **LFE5U-25F**: 24,288 LUT4s and as many flip-flops, 56 block RAMs of 18 Kibit (`DP16KD`, 1,008 Kibit in all) and 28 `MULT18X18D` 18 × 18 multipliers.

### The generic flow

`generic.ys` does five things, in order:

1. Runs the [gates](#the-gates) on the design exactly as written.
2. Counts the `$mul` cells (`generic.mul.stat.json`) after `opt_expr`. `opt_expr` turns multiplications by a constant power of two into shifts; the controller's C-select index arithmetic has two such multiplies. What is left are the real multipliers, one per processing element. They have to be counted at this point because `synth` turns each one into a `$macc` cell (`alumacc`) and then into gates.
3. Records which arrays became memories (`memory -nomap`, `generic.memories.json`).
4. Runs the steps of `synth -top matmul_top` **without `memory_map`**, and writes per-module `stat` reports.
5. Flattens the design, remaps all logic to seven simple gate types with `abc -g AND,NAND,OR,NOR,XOR,XNOR,MUX` (ABC also uses `NOT`), counts the gates and measures the longest gate path with `ltp -noff`.

This flow differs from VCPU-8's in one deliberate way. With no target library, `memory_map` builds every inferred memory out of flip-flops and multiplexers. For VCPU-8's 256-byte RAM that is a few thousand cells. For the accelerator's 192 Kibit of buffers it would be about 196,000 flip-flops plus 4096-to-1 multiplexer trees. That would bury the array in every count and make ABC and `ltp` very slow. It would also describe a register file nobody would build. So the generic flow keeps each inferred memory as one `$mem_v2` cell and reports its storage in bits. The FPGA flows map the same memories to block RAM. `ltp` leaves the memory cells out because their reads are registered: a path ends at a memory's address or data input.

## The FPGA wrapper

`matmul_top` has well over 200 port bits: three 12-bit host addresses, 32-bit read data, two 32-bit cycle counters and debug taps. That is far more than a small FPGA package has pins. `hardware/fpga/matmul_fpga_wrapper.sv` gives the FPGA flows a pin-legal top with 25 pins. It is not a board design: no board has been brought up with it.

| Port                                | Width | Purpose                                                                                                                                     |
| ----------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `clk`, `rst`                        |  1, 1 | the clock pin, and an active-high reset passed through a two-flop synchronizer                                                              |
| `strobe`                            |     1 | each synchronized rising edge runs `cmd` with `data_in`                                                                                     |
| `cmd`                               |     3 | `ADDR_LO`, `ADDR_HI`, `WRITE_A`, `WRITE_B` (each writes and increments the address), `SET_M`, `SET_N`, `SET_K`, `CTRL` (byte select, start) |
| `data_in`                           |     8 | the command's data                                                                                                                          |
| `data_out`                          |     8 | one byte, chosen by `CTRL`, of the C element at the address register                                                                        |
| `led_busy`, `led_done`, `led_error` |     3 | `busy`, a `done` that stays lit until the next start, and `error`                                                                           |

A host streams A and B in one byte per strobe, sets M, N and K, starts the run and reads C back a byte at a time. So every buffer, the controller and the whole array stay live, and synthesis cannot remove them. It does remove the logic that only the unconnected ports use: the cycle counters, `error_code` and the `dbg_*` taps, and it adds the wrapper's own command registers. The pins in `matmul_up5k_sg48.pcf` follow the iCEBreaker layout, as VCPU-8's do: the 12 MHz oscillator, the user button for `rst`, and the PMOD connectors for the rest.

## Results

These are the figures in the committed baseline, [`research/accelerators/matmul/synth/baseline.md`](../../../research/accelerators/matmul/synth/baseline.md), which `make synth-compare` checks against a fresh run. Tools: Yosys 0.70+145 and nextpnr 0.11.1-63, OSS CAD Suite 2026-10-16.

### Scaling with the array size

| Array   | PEs |   Cells | Flip-flops | `$mul` | Memory banks | Memory bits | Abstract gates | Logic depth |
| ------- | --: | ------: | ---------: | -----: | -----------: | ----------: | -------------: | ----------: |
| 4 × 4   |  16 |  18,130 |      1,049 |     16 |            9 |     196,608 |         17,524 |    78 gates |
| 8 × 8   |  64 |  70,120 |      3,843 |     64 |           17 |     196,608 |         68,100 |    77 gates |
| 16 × 16 | 256 | 273,028 |     15,097 |    256 |           33 |     196,608 |        270,353 |    78 gates |

As expected, the logic grows with the number of PEs, that is quadratically in the array side:

- **The PEs are almost everything.** One `processing_element` is 1,008 generic cells: 50 flip-flops (the 32-bit accumulator, the two 8-bit forwarded operands and their two valid bits) and 958 cells of multiplier, accumulator adder and control. All PEs together are exactly 16, 64 and 256 times that: 16,128, 64,512 and 258,048 cells, or 89 %, 92 % and 95 % of the design.
- **Each doubling of the side multiplies the total by about 3.9.** 70,120 / 18,130 = 3.87 and 273,028 / 70,120 = 3.89. The PE logic alone grows by exactly 4. The total grows a little less because the buffers and part of the controller do not grow at all.
- **The controller grows, but less.** It is 1,757, 4,944 and 12,620 cells. Most of the growth is the multiplexer that selects one of the ROWS × COLS accumulators during STORE (16-, 64- and 256-to-1, 32 bits wide), plus the wider skew and mask logic. Its flip-flop count stays about 120.
- **The memory does not grow.** The buffers hold MAX_DIM² elements of A and B (8 bits) and of C (32 bits) at every size: 64 × 64 × 48 = 196,608 bits. A larger array only splits A and B into more banks. Each buffer has one bank per array row (A) or column (B), plus the one C buffer, so ROWS + COLS + 1 banks: 9, 17 and 33.
- **The logic depth does not grow.** The longest gate path is 77 to 78 gates at every size. It runs from the controller's tile-row register (`row0`), through an edge-mask compare, into PE (0, 0)'s A operand, then through its multiplier and the 32-bit accumulator adder into `acc[31]`. A systolic array only connects neighbours, so a bigger array adds PEs side by side, not in series. The controller's STORE multiplexer does get deeper, by one 2:1 level per doubling of the PE count (two per doubling of the side). At these sizes that path is still shorter than the MAC path.

### Generic synthesis by block (4 × 4)

| Block          | Module               |  Cells | Flip-flops | Memories |
| -------------- | -------------------- | -----: | ---------: | -------: |
| whole design   | `matmul_top`         | 18,130 |      1,049 |        9 |
| `u_array`      | `systolic_array`     | 16,349 |        926 |        0 |
| all 16 PEs     | `processing_element` | 16,128 |        800 |        0 |
| `u_controller` | `matmul_controller`  |  1,757 |        123 |        0 |
| `u_a_buffer`   | `input_buffer`       |     11 |          0 |        4 |
| `u_b_buffer`   | `input_buffer`       |     10 |          0 |        4 |
| `u_c_buffer`   | `output_buffer`      |      1 |          0 |        1 |

The array's 926 flip-flops are the PEs' 800 plus 126 of its own: the input skew registers (row i of A and column j of B are delayed i or j clocks, 8 data bits and a valid bit per stage, 108 bits at 4 × 4) and the counter that raises `tile_done`. The summary has the same table for every size.

## How the multipliers map

The RTL writes one signed 8 × 8 → 16 multiply per PE (`processing_element.sv`). Each flow builds it differently:

- **Generic:** a `$mul` cell, then `$macc` and generic gates. Multiplier and accumulator adder together are about 950 cells per PE.
- **iCE40:** 4-input LUTs and carry cells. `synth_ice40` uses the UP5K's `SB_MAC16` DSP blocks only with `-dsp`, which this flow does not pass, the same as VCPU-8's flow. Even with `-dsp`, the UP5K's 8 DSPs could hold only half of the 4 × 4 array's 16 multipliers, so most multipliers would still be LUTs. Built from LUTs, each PE costs about 430 LUT4s: the iCE40 LUT count grows by 20,717 from 4 × 4 to 8 × 8 (48 more PEs) and by 82,584 from 8 × 8 to 16 × 16 (192 more PEs).
- **ECP5:** one `MULT18X18D` per PE (`synth_ecp5` infers DSPs by default), plus about 30 LUTs per PE for the accumulator and control. The LFE5U-25F has 28 of them. That covers the 4 × 4 array's 16 (57 %), but not the 8 × 8 array's 64 or the 16 × 16 array's 256.

Mapping the extra multipliers to LUTs (`synth_ecp5 -nodsp`, or a mix) would be a design-space choice. It would change the settings between sizes, so this flow does not do it; the experiment runner is where such variants belong.

## Memories

| Buffer                                | Banks (4 × 4 / 8 × 8 / 16 × 16) | Bank shape (4 × 4 / 8 × 8 / 16 × 16) |    Bits |
| ------------------------------------- | ------------------------------- | ------------------------------------ | ------: |
| `u_a_buffer` (A, one bank per row)    | 4 / 8 / 16                      | 1,024 × 8 / 512 × 8 / 256 × 8        |  32,768 |
| `u_b_buffer` (B, one bank per column) | 4 / 8 / 16                      | 1,024 × 8 / 512 × 8 / 256 × 8        |  32,768 |
| `u_c_buffer` (C)                      | 1                               | 4,096 × 32                           | 131,072 |

Every bank was inferred as a memory with one write port and one registered read port, and both FPGA flows map every bank to block RAM: `SB_RAM40_4K` on iCE40, `DP16KD` on ECP5. [memory.md](memory.md) describes the layout and the banking.

On the iCE40UP5K the buffers alone do not fit. C needs 128 Kibit, which is 32 of the 4 Kibit block RAMs, and the device has 30. A and B add 16 more at 4 × 4 and 8 × 8, and 32 more at 16 × 16, because each 256 × 8 bank still takes a whole block RAM. That makes 48, 48 and 64 block RAMs against 30. The UP5K's SPRAM would have the capacity, but each SPRAM is single-port: one address for reads and writes. The C buffer is written by the controller and read by the host at independent addresses, so it cannot use SPRAM without an RTL change. On ECP5 the buffers take 16, 24 and 40 of 56 `DP16KD`s.

## Fit and Fmax

| Array   | Flow  | Fits   | LUTs (Yosys) | Logic cells (nextpnr)         | Block RAM   | DSP          | Fmax estimate |
| ------- | ----- | ------ | -----------: | ----------------------------- | ----------- | ------------ | ------------: |
| 4 × 4   | iCE40 | **no** |        7,286 | **7,721 / 5,280 (146 %)**     | **48 / 30** | 0 / 8        |             — |
| 4 × 4   | ECP5  | yes    |          737 | 1,613 / 24,288 (7 %)          | 16 / 56     | 16 / 28      |     52.22 MHz |
| 8 × 8   | iCE40 | **no** |       28,003 | **29,492 / 5,280 (559 %)**    | **48 / 30** | 0 / 8        |             — |
| 8 × 8   | ECP5  | **no** |        2,168 | 4,816 / 24,288 (20 %)         | 24 / 56     | **64 / 28**  |             — |
| 16 × 16 | iCE40 | **no** |      110,587 | **116,472 / 5,280 (2,206 %)** | **64 / 30** | 0 / 8        |             — |
| 16 × 16 | ECP5  | **no** |        8,045 | 17,769 / 24,288 (73 %)        | 40 / 56     | **256 / 28** |             — |

Only the 4 × 4 array fits, and only on the ECP5. The record is honest about the rest:

- **iCE40UP5K: no size fits.** The logic is 1.5 to 22 times the device, and the block RAM is over at every size (see [Memories](#memories)). The UP5K is a good fit for VCPU-8 (906 of 5,280 logic cells) but far too small for a matmul accelerator with 64 × 64 on-chip buffers.
- **LFE5U-25F: 4 × 4 fits; 8 × 8 and 16 × 16 do not, on DSP blocks alone.** Logic, flip-flops and block RAM would fit at 8 × 8 and 16 × 16 (73 % of the LUTs at 16 × 16). The multipliers need 64 and 256 `MULT18X18D`s, and the device has 28.

When a design does not fit, nextpnr prints its utilisation and stops before placement with an error like `Unable to place cell …, no BELs remaining to implement cell type 'ICESTORM_RAM'`. `mk/synth.mk` treats exactly that error as a result. It writes the line to `nextpnr-<family>.nofit`, and the summary records `fits: false`, the utilisation and the over-used resources. Any other nextpnr failure still fails `make synth`. A design that is not placed has no Fmax, so the summary gives none.

The 4 × 4 ECP5 build reaches **52.22 MHz (estimate)** against the 12 MHz constraint, so it meets the constraint with a wide margin. Its critical path is 19.15 ns, half logic and half routing. It runs from the controller's tile-row register through the edge masks into a PE's multiplier (`MULT18X18D`) and the 32-bit accumulator adder: the same structure as the generic longest path.

### What Fmax is and is not

Fmax is nextpnr's estimate, from its timing model of one device, package and speed grade, of the fastest clock at which every register-to-register path settles. The model is not a measurement on hardware. It changes with the placement, the seed and the nextpnr version, and it holds for no other device. It is not an ASIC clock frequency either: that would need a standard-cell library and static timing analysis, which this flow does not have. The generic flow's logic depth is a gate count on the longest path, a useful proxy for comparing RTL versions, but not a time. A design that does not fit has no Fmax at all, so the 8 × 8 and 16 × 16 arrays have no timing figure in this flow.

### Power

Power is **not measured**. Estimating it needs a characterised technology (a liberty file, or a vendor FPGA power model) and switching activity from a realistic workload. Neither is part of this flow, and RTL simulation cannot supply them. The summary says "not measured" and gives no number, so no report can rank these designs by power or energy per MAC.

## Reading the numbers

| Figure                                      | Depends on                                                        | Technology-independent? |
| ------------------------------------------- | ----------------------------------------------------------------- | ----------------------- |
| Generic cells, flip-flops, `$mul`           | the RTL and Yosys                                                 | yes, but tool-specific  |
| Memory banks and bits                       | the RTL coding style, MAX_DIM and Yosys's inference               | yes                     |
| Abstract gates and logic depth (in gates)   | the RTL, Yosys/ABC and the chosen gate set                        | yes, but tool-specific  |
| How a memory maps (block RAM or flip-flops) | the target's memory primitives                                    | no                      |
| LUT, carry, FF, block RAM and DSP counts    | the FPGA family and `synth_ice40` / `synth_ecp5`                  | no                      |
| Utilisation and fit                         | the device                                                        | no                      |
| Fmax and the critical path in ns            | device, package, speed grade, placement, nextpnr version and seed | no                      |

In `build/synth/summary.json` (schema `matmul-synth-summary/1`, `schemaVersion: 1`), each size has:

- `generic`: the totals, cell types and blocks, `mulCells` with `mulCellsByModule`, `memoryBanks`, `memoryBits`, `abstractGates` and `logicDepth`;
- `memories`: one entry per buffer, with how each FPGA flow mapped it;
- `fpga.ice40` and `fpga.ecp5`: either `fits: true` with the Yosys primitives, nextpnr utilisation, `fmaxMHz` (`fmaxIsEstimate: true`, with `timingLabel` naming the device), `meetsConstraint` and the critical path; or `fits: false` with the utilisation, `overUtilised` and nextpnr's `reason`; or `status: "absent"` when nextpnr-ecp5 is not installed.

`settings` records the identical flow settings and `power: "not measured"`. `provenance` records the commit, the dirty flag and the tool versions. `warnings` and `gate` record the [allowlist](#warnings) result.

## Comparing designs fairly

A synthesis number is only comparable with another made the same way:

- **Same flow settings.** Every size here uses the same scripts, devices, constraint and seed. A variant that changes one of them (for example `-nodsp`, or another seed) is a different experiment and has to say so.
- **Same tools.** Generic cells and gates are properties of this Yosys version's algorithms as well as of the design, and Fmax is a property of this nextpnr version. Compare only runs that the summary's `provenance.tools` shows were made with the same versions.
- **Same scope.** Compare the generic `matmul_top` with the generic `matmul_top`, and the wrapper with the wrapper. Their flip-flop counts differ, and the gap grows with the array: 1,049 generic against 1,047 (iCE40) and 1,049 (ECP5) at 4 × 4, 3,843 against 3,661 and 3,663 at 8 × 8, 15,097 against 14,267 and 14,269 at 16 × 16. The wrapper drops the cycle counters and debug taps and adds its own registers, but most of the gap is flattening. The FPGA flows flatten the design, so Yosys can merge flip-flops in different modules that have the same input. The generic flow keeps the hierarchy and counts every copy. Flattening the generic 8 × 8 design and merging identical cells takes it from 3,843 to 3,545 flip-flops.
- **Against VCPU-8.** Project 2's flow uses the same devices, the same 12 MHz constraint and the same seed, so the FPGA rows of the two summaries are comparable. On the iCE40UP5K the CPU fits in 906 logic cells, while the smallest accelerator needs 7,721 and 48 block RAMs. The generic counts are not directly comparable. VCPU-8's generic flow maps its 256-byte RAM to flip-flops, while this flow keeps memories as `$mem_v2` cells ([The generic flow](#the-generic-flow)). Compare the logic outside the memories, or compare the FPGA flows.
- **Per MAC, not per second.** Resources say what the array costs. What it does per clock is the benchmark reports' job, and turning cycles into time needs a clock frequency. Here the only one is the ECP5 estimate for 4 × 4.

## The gates

Every Yosys run, generic and FPGA, at every size, first checks the design exactly as written, before any optimisation. Any failure stops Yosys with a non-zero exit and fails `make synth`:

- `hierarchy -check`: every module and port resolves;
- `check -assert` after `proc`: no combinational loop, no net with two drivers, no used net without a driver;
- `select -assert-none t:$dlatch …`: no latch of any kind.

`check -assert` runs again after synthesis. `make synth-latch-check` proves that the latch gate works. It copies `rtl/` into `build/synth-latch/`, adds one latch to `matmul_controller` (once in an `always_comb`, which Yosys itself rejects, and once in an `always @*`, which only the gate's `select -assert-none` catches), and requires the generic flow to fail on both and name the latch. The sources in `rtl/` are never touched.

## Warnings

`synth-summary` collects every `Warning:` line (and ABC's `ABC: Warning:`) from every log of every size. It matches each one against the regular expressions in `hardware/accelerators/matmul/synth/warnings.allow`, and fails on any warning that matches none of them. Each entry carries its review as a comment, and the summary lists every warning with the entry that allowed it. There are two entries:

1. **`ABC: Warning: The network is combinational`**, in both of its forms. Yosys keeps the flip-flops itself and hands ABC only each module's combinational logic. ABC notes that this logic has no latches to optimise. It says nothing about the design. The generic flow prints it once per module and ABC run, so 69, 205 and 749 times; each FPGA flow prints it once.
2. **`ABC: Warning: AIG with boxes has internal fanout in 0 complex flops and 2 carries.`**, in the ECP5 flow only. The output of a carry cell (`CCU2C`) feeds more than one node in the network ABC9 optimises, so ABC9 maps around that box rather than through it. That limits ABC's optimisation; it is not a fault in the design. The same run's `&verify` reports "Networks are equivalent" at every size. The count is 2 at all three sizes, so these carries are in logic that does not grow with the array, not in the PEs.

nextpnr printed no warnings, and no Yosys warning appeared at any size.

## Baseline and comparison

`research/accelerators/matmul/synth/baseline.{json,md}` is the summary of a run from a clean tree at the commit it names. `make synth-compare` re-runs synthesis and compares every metric of the fresh summary with the baseline: cells, flip-flops, multipliers, memories, gates, depth, utilisation, fit, Fmax, critical path and warnings. It **fails (exit 1) on any difference** and prints each one as `path: baseline → fresh`. Differences in `provenance` (commit, dirty flag, tool versions) are printed as notes and never fail it. `SYNTH_BASELINE=<path without .json>` points it at another baseline, for example an edited copy, to show it fails.

When a change to the RTL is meant to change the numbers, run `make synth-baseline` from a clean tree after committing the change, and commit the new baseline in the same pull request. The diff of `baseline.md` is then the reviewable record of what the change cost.

## Limitations

- **No board.** The wrapper and the `.pcf` make the FPGA flows concrete; they have not been run on hardware. A real board would need an inverted reset button, a real host link (a UART or SPI bridge) and pin checks.
- **No size fits the UP5K, and only 4 × 4 fits the 25k ECP5.** Larger devices (an LFE5U-85F has 156 multipliers), LUT-mapped multipliers, or smaller buffers (a lower MAX_DIM) would change that. Those are design-space experiments, not this flow.
- **No timing figure without a fit.** The 8 × 8 and 16 × 16 arrays have generic logic depth but no Fmax.
- **No area, no power, no ASIC timing.** These need a technology library this flow does not use.
- **Cross-platform reproducibility.** The baseline was produced on macOS (arm64) with the pinned OSS CAD Suite. Yosys and ABC are deterministic for one build, but a build for another platform could map some logic differently. A `synth-compare` failure on another platform should be read as "the tools differ" before "the design changed": the provenance notes show the versions.
