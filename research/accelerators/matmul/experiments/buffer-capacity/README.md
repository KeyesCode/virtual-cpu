# Experiment: buffer-capacity

**Question.** MAX_DIM sets the largest M, N and K the accelerator accepts, and with it the size of every buffer (A, B and C each hold MAX_DIM × MAX_DIM elements). On the 8 × 8 array, what do MAX_DIM 32, 64 and 128 cost in cells and memory bits, and what does each buy in the largest workload it can run?

Variants: the 8 × 8 array with MAX_DIM 32, 64 (the default, the baseline) and 128. The workloads are the benchmark's nine plus a 128 × 128 × 128 cube, a non-square 100 × 77 × 120 and a dot product of length 128, which only MAX_DIM 128 can run. A workload above a variant's MAX_DIM is recorded as "not supported by this variant", not as a failure.

```sh
make -C hardware/accelerators/matmul experiment NAME=buffer-capacity
```
