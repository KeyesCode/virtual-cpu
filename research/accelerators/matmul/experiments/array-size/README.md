# Experiment: array-size

**Question.** The brief requires 4 × 4, 8 × 8 and 16 × 16 arrays of the same RTL. What does each step up in array size buy in cycles on the benchmark workloads, and what does it cost in generic cells, flip-flops, multipliers and FPGA resources? Which sizes are Pareto-optimal on total cycles and cells?

Variants: `ROWS = COLS` = 4, 8 and 16, every other parameter at its default (MAX_DIM 64); the baseline is 8 × 8. The workloads are the benchmark's nine ([BENCHMARK_WORKLOADS](../../../../../packages/accelerator-reference/src/harness/benchmark.ts)).

```sh
make -C hardware/accelerators/matmul experiment NAME=array-size
```

## Answer

From [results/2026-10-24-5019637.md](results/2026-10-24-5019637.md): over the nine workloads, going from 8 × 8 to 16 × 16 saves 13.9 % of the total cycles (39,437 → 33,950) and costs 3.9 times the generic cells (70,120 → 273,028). Dropping to 4 × 4 costs 51.4 % more cycles (59,708) and saves 74.1 % of the cells (18,130). The cycle gain shrinks with each step because r1 stores C one element per clock and pays ROWS + COLS fill and drain clocks per tile. On the smallest workloads (4 × 4 × 4, 1 × 64 × 1) the larger arrays are even slower.

All three sizes are Pareto-optimal on (total cycles, generic cells), so the choice depends on the target. Only 4 × 4 fits the LFE5U-25F (nextpnr estimate 52.22 MHz). 8 × 8 and 16 × 16 need more MULT18X18D blocks than it has, and no size fits the iCE40UP5K. The buffers are the same 196,608 bits at every size, because MAX_DIM, not the array, sets them.
