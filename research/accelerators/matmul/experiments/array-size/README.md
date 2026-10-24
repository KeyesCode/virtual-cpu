# Experiment: array-size

**Question.** The brief requires 4 × 4, 8 × 8 and 16 × 16 arrays of the same RTL. What does each step up in array size buy in cycles on the benchmark workloads, and what does it cost in generic cells, flip-flops, multipliers and FPGA resources? Which sizes are Pareto-optimal on total cycles and cells?

Variants: `ROWS = COLS` = 4, 8 and 16, every other parameter at its default (MAX_DIM 64); the baseline is 8 × 8. The workloads are the benchmark's nine ([BENCHMARK_WORKLOADS](../../../../../packages/accelerator-reference/src/harness/benchmark.ts)).

```sh
make -C hardware/accelerators/matmul experiment NAME=array-size
```
