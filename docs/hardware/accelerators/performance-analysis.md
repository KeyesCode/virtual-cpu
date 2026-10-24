# Performance analysis

This document reports how many clock cycles the INT8 matmul accelerator (revision `matmul-os-r1`) spends on the benchmark workloads of the Project 3 brief, on the 4 × 4, 8 × 8 and 16 × 16 arrays, and explains what each number shows. Every number below comes from the committed baseline report [research/accelerators/matmul/reports/2026-10-24-16e2ff1.md](../../../research/accelerators/matmul/reports/2026-10-24-16e2ff1.md) (JSON and CSV beside it), which `make benchmark-baseline` wrote at commit `16e2ff1` from a clean working tree. [research/accelerators/matmul/README.md](../../../research/accelerators/matmul/README.md) documents the report schema.

```sh
make -C hardware/accelerators/matmul benchmark            # build/reports/benchmark.{json,csv,md}
make -C hardware/accelerators/matmul benchmark-compare    # rerun, and require the committed report's numbers
make -C hardware/accelerators/matmul benchmark-baseline   # rewrite the committed report (clean tree only)
pnpm accel:benchmark                                      # make benchmark, from the repository root
```

**No clock frequency is assumed anywhere in this document or in the reports.** Cycles are clock edges of the simulated RTL, not time. A number of operations per second (or a TOPS figure) needs a clock frequency, and the only acceptable source for one is a static timing estimate for a named device (below, [Combining cycles with a clock estimate](#combining-cycles-with-a-clock-estimate)), which this report does not use.

## What is measured

The benchmark runs nine workloads, written **M × K × N** (A is M × K, B is K × N, C is M × N):

| Workload     |    MACs | Why                                                  |
| ------------ | ------: | ---------------------------------------------------- |
| 4 × 4 × 4    |      64 | one 4 × 4 tile                                       |
| 8 × 8 × 8    |     512 | cube                                                 |
| 16 × 16 × 16 |   4,096 | cube                                                 |
| 32 × 32 × 32 |  32,768 | cube                                                 |
| 64 × 64 × 64 | 262,144 | the largest product within capacity (`MAX_DIM` = 64) |
| 13 × 19 × 11 |   2,717 | non-square; edge tiles in M and N on every array     |
| 64 × 8 × 64  |  32,768 | large C, short reduction (K = 8)                     |
| 8 × 64 × 64  |  32,768 | few output rows, long reduction                      |
| 1 × 64 × 1   |      64 | a single dot product of length 64                    |

Each workload runs on each of the three Verilator runners (`build/sim-<R>x<C>/matmul_sim`, the Verilated `matmul_top` driven through its host port; [verification-strategy.md](verification-strategy.md) describes the runner): 27 cases. The operands are signed INT8 from the reference model's seeded `random` generator (seed 1, `SEED=` to change it), the same A and B for a workload on every array size.

### The correctness gate

No number is reported for a result that is not correct. Every case's C is computed by `@vcpu/accelerator-reference` first, and the case gets numbers only when the controller reached `done` and every element of the runner's C equals the reference, the same comparison `make verify` makes. A case that fails gets status `failed`, the reason and no numbers, and the benchmark exits 1; the case files stay in `build/benchmark/<R>x<C>/` for `make simulate CASE=…`. All 27 cases of the baseline passed. The cycle counts are also exactly the controller formulas of [controller.md](controller.md#cycle-formulas) for every one of the 27 cases, which the unit test `packages/accelerator-reference/src/harness/benchmark.test.ts` checks against the committed baseline.

## The columns

One **MAC** is one multiply plus one accumulate: a signed INT8 × INT8 product added into a signed INT32 accumulator. A workload is M · N · K MACs. The reports count MACs; where they give **ops**, each MAC is two operations (ops = 2 × MACs), the convention most accelerator figures use.

| Column (JSON / CSV)                              | Meaning                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `macs`                                           | M · N · K                                                                                                                |
| `tiles`                                          | ⌈M / ROWS⌉ · ⌈N / COLS⌉ output tiles; an edge tile counts as a whole tile                                                |
| `peakMacsPerCycle`                               | ROWS · COLS: one MAC per PE per clock, the most the array can do                                                         |
| `transferIn` / `transfer_in`                     | Clocks to write A and B through the host port, both ports in parallel, one element per port per clock: max(M · K, K · N) |
| `compute`                                        | The controller's `cycles_compute`: the PREPARE_TILE, COMPUTE and DRAIN clocks of every tile, T · (K + ROWS + COLS)       |
| `store`                                          | The controller's `cycles_store`: the STORE clocks, one per element of C, M · N                                           |
| `busy`                                           | The clocks `busy` was high: compute + store + one LOAD clock + one NEXT_TILE clock per tile                              |
| `transferOut` / `transfer_out`                   | Clocks to read C through the registered host read port: M · N + 1                                                        |
| `total`                                          | transferIn + 1 (the `start` clock) + busy + transferOut: the whole run as a host sees it                                 |
| `fillDrain` / `fill_drain`                       | compute − T · K: the compute clocks in which no new operand enters the array (PREPARE_TILE and DRAIN), T · (ROWS + COLS) |
| `utilization`                                    | macs / (ROWS · COLS · compute): the fraction of PE-clocks of the compute phase that did a useful MAC                     |
| `macsPerCycleCompute` / `macs_per_cycle_compute` | macs / compute: the array's rate while it computes                                                                       |
| `macsPerCycleTotal` / `macs_per_cycle_total`     | macs / total: the rate a host sees, transfers and stores included                                                        |
| `opsPerCycleCompute`, `opsPerCycleTotal`         | 2 · macs / compute and 2 · macs / total                                                                                  |
| `bytesIn` / `bytes_in`, `bytesOut` / `bytes_out` | M · K + K · N INT8 operand bytes in; 4 · M · N INT32 result bytes out                                                    |

Utilization is defined over the compute phase on purpose: it measures how well the dataflow keeps the PEs busy. STORE, the transfers and the handshake clocks are not in its denominator; their cost shows in `macsPerCycleTotal` instead, and the two together separate "the array is idle inside a tile" from "the array waits for everything else".

## Results

All 27 cases passed the correctness gate. Total cycles and PE utilization:

| Workload (M × K × N) |    MACs | Total 4x4 | Total 8x8 | Total 16x16 | Utilization 4x4 | Utilization 8x8 | Utilization 16x16 |
| -------------------- | ------: | --------: | --------: | ----------: | --------------: | --------------: | ----------------: |
| 4 × 4 × 4            |      64 |        64 |        72 |          88 |           0.333 |           0.050 |             0.007 |
| 8 × 8 × 8            |     512 |       263 |       220 |         236 |           0.500 |           0.333 |             0.050 |
| 16 × 16 × 16         |   4,096 |     1,171 |       903 |         820 |           0.667 |           0.500 |             0.333 |
| 32 × 32 × 32         |  32,768 |     5,699 |     3,859 |       3,335 |           0.800 |           0.667 |             0.500 |
| 64 × 64 × 64         | 262,144 |    30,979 |    17,475 |      13,843 |           0.889 |           0.800 |             0.667 |
| 13 × 19 × 11         |   2,717 |       872 |       680 |         588 |           0.524 |           0.303 |             0.208 |
| 64 × 8 × 64          |  32,768 |    13,059 |    10,307 |       9,363 |           0.500 |           0.333 |             0.200 |
| 8 × 64 × 64          |  32,768 |     7,459 |     5,771 |       5,511 |           0.889 |           0.800 |             0.333 |
| 1 × 64 × 1           |      64 |       142 |       150 |         166 |           0.056 |           0.013 |             0.003 |

MACs per cycle, during compute and over the whole run (ops per cycle are twice these):

| Workload (M × K × N) | Compute 4x4 | Compute 8x8 | Compute 16x16 | Total 4x4 | Total 8x8 | Total 16x16 |
| -------------------- | ----------: | ----------: | ------------: | --------: | --------: | ----------: |
| 4 × 4 × 4            |       5.333 |       3.200 |         1.778 |     1.000 |     0.889 |       0.727 |
| 16 × 16 × 16         |      10.667 |      32.000 |        85.333 |     3.498 |     4.536 |       4.995 |
| 64 × 64 × 64         |      14.222 |      51.200 |       170.667 |     8.462 |    15.001 |      18.937 |
| 64 × 8 × 64          |       8.000 |      21.333 |        51.200 |     2.509 |     3.179 |       3.500 |
| 8 × 64 × 64          |      14.222 |      51.200 |        85.333 |     4.393 |     5.678 |       5.946 |
| 1 × 64 × 1           |       0.889 |       0.800 |         0.667 |     0.451 |     0.427 |       0.386 |

Where the clocks of a run go, for the largest workload and the short-K one:

| Case                |  Transfer in |       Compute |        Store | Start, LOAD, NEXT_TILE | Transfer out |  Total |
| ------------------- | -----------: | ------------: | -----------: | ---------------------: | -----------: | -----: |
| 64 × 64 × 64, 4x4   | 4,096 (13 %) | 18,432 (59 %) | 4,096 (13 %) |                    258 | 4,097 (13 %) | 30,979 |
| 64 × 64 × 64, 8x8   | 4,096 (23 %) |  5,120 (29 %) | 4,096 (23 %) |                     66 | 4,097 (23 %) | 17,475 |
| 64 × 64 × 64, 16x16 | 4,096 (30 %) |  1,536 (11 %) | 4,096 (30 %) |                     18 | 4,097 (30 %) | 13,843 |
| 64 × 8 × 64, 16x16  |    512 (5 %) |     640 (7 %) | 4,096 (44 %) |                     18 | 4,097 (44 %) |  9,363 |

The per-array tables of the report have every column for every case.

## Fill and drain

Inside one tile, the output-stationary array ([systolic-array.md](systolic-array.md)) streams the whole reduction K through in K clocks, but the skew means the last PE, PE(ROWS − 1, COLS − 1), sees its first operands ROWS + COLS − 2 clocks after the first PE, and its accumulator register adds one more. With the PREPARE_TILE clock that primes the buffers' registered read, every tile costs

```text
compute clocks per tile = 1 (PREPARE_TILE) + K (COMPUTE) + ROWS + COLS − 1 (DRAIN) = K + ROWS + COLS
```

of which ROWS + COLS are fill and drain, not depending on K. For a full tile (every PE holding a real output element), utilization is therefore

```text
utilization of a full tile = K / (K + ROWS + COLS)
```

and the measurements are exactly that: K = 64 gives 64 / 72 = 0.889 on 4 × 4, 64 / 80 = 0.800 on 8 × 8 and 64 / 96 = 0.667 on 16 × 16 (the 64 × 64 × 64 row); K = 8 gives 8 / 16 = 0.500, 8 / 24 = 0.333 and 8 / 40 = 0.200 (64 × 8 × 64). The `fill_drain` column is T · (ROWS + COLS) in every case: 2,048 of the 18,432 compute clocks of 64 × 64 × 64 on 4 × 4 (256 tiles × 8), 512 of the 1,536 on 16 × 16 (16 tiles × 32).

Two things follow. **A short reduction wastes the array**: fill and drain are fixed per tile, so 64 × 8 × 64 runs at 0.200 utilization on 16 × 16 against 0.667 for 64 × 64 × 64, even though every tile of both is full. **A larger array needs a longer K for the same efficiency**: ROWS + COLS grows with the array, so at K = 64 the 16 × 16 array is idle a third of the compute time while the 4 × 4 array is idle a ninth. r1 starts a tile only after the previous one drained; overlapping one tile's drain with the next tile's fill would remove most of this overhead and is a design-space experiment, not part of r1.

## Edge tiles and small matrices

An edge tile is computed with zeros on the rows past M and the columns past N, and those PEs' results are masked out of the store ([controller.md](controller.md)). They spend the clocks but do no useful MAC, so utilization drops by the fraction of masked PEs:

- **13 × 19 × 11 on 16 × 16** is one tile in which 13 · 11 = 143 of the 256 PEs hold a real output: 143 / 256 · 19 / (19 + 32) = 0.208, as measured.
- **13 × 19 × 11 on 8 × 8** is four tiles (8 × 8, 8 × 3, 5 × 8, 5 × 3) of 19 + 16 clocks: 2,717 / (64 · 140) = 0.303. On 4 × 4 it is 12 tiles covering 16 × 12 = 192 output positions, of which 143 are real, so less is masked: 143 / 192 · 19 / (19 + 8) = 0.524.
- **8 × 64 × 64 on 16 × 16** uses only 8 of the 16 rows of every tile: half of the full-tile 0.667, 0.333. On 4 × 4 and 8 × 8, where 8 is a multiple of ROWS, every tile is full and the workload reaches the 64 × 64 × 64 utilization.
- **4 × 4 × 4** fills the 4 × 4 array (0.333 = 4 / 12, the short K) but occupies 16 of 256 PEs of the 16 × 16 one: 0.007.
- **1 × 64 × 1** keeps one PE busy: 1 / 16 · 64 / 72 = 0.056 on 4 × 4, 0.003 on 16 × 16. A dot product is the worst case for any 2-D array; it is a vector job.

So a bigger array is only faster when the matrices fill its tiles: for 4 × 4 × 4 and 1 × 64 × 1 the 16 × 16 array takes more total clocks than the 4 × 4 one (88 against 64, 166 against 142), because its fill and drain are longer and nothing fills the extra PEs.

## Stores, transfers and memory bandwidth

The compute phase is only part of a run. Two r1 design choices show up directly in the totals:

- **STORE writes one element of C per clock** (M · N clocks per run), after each tile's drain and before the next tile starts. On 16 × 16 a full tile's 256 stores take longer than its K + 32 compute clocks whenever K < 224, i.e. always within `MAX_DIM` = 64: for 64 × 64 × 64 the STORE clocks (4,096) are 2.7 times the compute clocks (1,536), and for 64 × 8 × 64 they are 6.4 times. Storing a whole row of a tile per clock, or overlapping the stores of one tile with the compute of the next, are the obvious next experiments; [controller.md](controller.md) already notes this bottleneck.
- **The host port moves one element per port per clock**: A and B in parallel (at most 2 bytes per clock when A and B are the same size; 8 × 64 × 64 is limited by its 64 × 64 B, 4,608 bytes in 4,096 clocks), and C out at one INT32 per clock. Transfer in and out together are 26 % of the 64 × 64 × 64 run on 4 × 4 and 59 % of it on 16 × 16, and between 37.5 % and 66.5 % of every run of the workloads smaller than 32 × 32 × 32.

This is why the total MACs per cycle stay far below the peak while the compute-phase rate approaches it. For 64 × 64 × 64 on 16 × 16 the array does 170.7 MACs per clock while it computes (of a peak of 256), but only 18.9 averaged over the run. The operands for that rate come from the on-chip buffers, which feed one A element per array row and one B element per array column every COMPUTE clock: ROWS + COLS = 32 bytes per clock on 16 × 16. The arithmetic intensity of the workload, MACs per byte moved through the host port, is 262,144 / (4,096 + 4,096 + 16,384) = 10.7 MACs per byte; to keep 256 PEs busy from outside the chip, the host side would have to deliver about 256 / 10.7 ≈ 24 bytes per clock, where the r1 host port writes at most 2 operand bytes per clock. The host port is a testbench convenience, not a production memory system ([memory.md](memory.md)), and the reports count its clocks separately precisely so that a better memory interface can be measured against them.

## Combining cycles with a clock estimate

Cycles become time only through a clock frequency, and this report deliberately has none. The synthesis ticket's nextpnr runs give an Fmax **estimate** for a named FPGA (a static timing analysis at one place-and-route seed, not a measurement on hardware). A later report may combine the two as `estimated time = total cycles / Fmax` and `estimated MACs per second = macs / estimated time`, but only labelled as an estimate for that device and timing model, from the same commit's synthesis summary, the way the Project 2 benchmark does ([../performance-analysis.md](../performance-analysis.md)). Any figure of that kind not derived this way would be a hypothetical assumption and must be labelled so. Simulator wall-clock time (the report's `host` section) measures the simulator on the machine that ran it, never the accelerator.

## Reproducibility

Everything in a report except `provenance` (creation time, git commit and dirty flag, runners, tool versions) and `host` (simulator wall-clock) is deterministic for a given design, workload set and seed. `make benchmark-compare` reruns the benchmark and fails unless those sections equal the newest committed report byte for byte, listing every number that moved. A change that moves cycle counts must bump `hardware/accelerators/matmul/REVISION` and commit a new baseline with `make benchmark-baseline` from a clean tree, in the same pull request.
