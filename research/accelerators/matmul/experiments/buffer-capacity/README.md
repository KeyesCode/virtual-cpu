# Experiment: buffer-capacity

**Question.** MAX_DIM sets the largest M, N and K the accelerator accepts, and with it the size of every buffer (A, B and C each hold MAX_DIM × MAX_DIM elements). On the 8 × 8 array, what do MAX_DIM 32, 64 and 128 cost in cells and memory bits, and what does each buy in the largest workload it can run?

Variants: the 8 × 8 array with MAX_DIM 32, 64 (the default, the baseline) and 128. The workloads are the benchmark's nine plus a 128 × 128 × 128 cube, a non-square 100 × 77 × 120 and a dot product of length 128, which only MAX_DIM 128 can run. A workload above a variant's MAX_DIM is recorded as "not supported by this variant", not as a failure.

```sh
make -C hardware/accelerators/matmul experiment NAME=buffer-capacity
```

## Answer

From [results/2026-10-24-b592629.md](results/2026-10-24-b592629.md): memory grows with MAX_DIM² (49,152, 196,608 and 786,432 bits for MAX_DIM 32, 64 and 128), while the generic logic barely moves (70,024, 70,120 and 70,269 cells, ±0.2 %). The cycles are identical on every workload all three run. MAX_DIM 32 runs 5 of the 12 workloads, 64 runs 9 and 128 all 12, including 128 × 128 × 128 in 86,275 cycles.

The Pareto rule names only MAX_DIM 32, because it weighs cycles on the common workloads against logic cells and is blind to capacity and memory. The real cost of capacity is memory. iCE40 needs 24, 48 and 192 EBRs (the UP5K has 30, so only MAX_DIM 32's buffers fit it). ECP5 needs 2, 24 and 48 block RAMs, but at MAX_DIM 32 the small A and B banks go into LUT RAM instead, so that variant uses 723 more ECP5 LUTs than MAX_DIM 64. Pick the smallest MAX_DIM that holds the largest workload you need. A larger product than that is a job for K-chunking and host-side tiling (future work), not for bigger buffers.
