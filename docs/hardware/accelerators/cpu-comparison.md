# VCPU-8 versus the matmul accelerator

This document compares the Project 2 CPU, VCPU-8 (`hardware/rtl/vcpu8/`, revision `vcpu8-mc-r1`), with the INT8 matmul accelerator on the same small INT8 × INT8 → INT32 matrix products (brief §13). Both run on their RTL in Verilator, both are checked element by element against `@vcpu/accelerator-reference`, and both are reported in clock cycles, memory accesses and synthesis resources, never in time or energy. The CPU's ISA and RTL are unchanged: the CPU side is an ordinary VCPU-8 program.

```sh
make -C hardware/accelerators/matmul compare-cpu          # build/reports/cpu-comparison.{json,md}
make -C hardware/accelerators/matmul compare-cpu-publish  # also research/accelerators/matmul/comparisons/<date>-<sha>.*
```

`compare-cpu` builds the VCPU-8 RTL runner through its own Makefile (`make -C hardware/rtl/vcpu8 sim`) and the 4 × 4 accelerator runner (`build/sim-4x4/matmul_sim`), then runs `@vcpu/accelerator-reference compare-cpu` ([compare-cpu.ts](../../../packages/accelerator-reference/src/harness/compare-cpu.ts)). The generated CPU programs and their RTL traces stay in `build/compare-cpu/cpu/` (`<workload>.asm`, `.mem.hex`, `.state.json`, `.trace.jsonl`), so any of them can be rerun with `make -C hardware/rtl/vcpu8 simulate PROGRAM=hardware/accelerators/matmul/build/compare-cpu/cpu/4x4x4-random.asm`.

## Method

1. **Workloads.** M × K × N cubes with random operands from seed 1: 2 × 2 × 2, 3 × 3 × 3 and 4 × 4 × 4, the largest that fits in the CPU's memory; 4 × 4 × 4 again with every operand −128 (every product 16 384, and every element of C 65 536, which carries into its third byte); then 5 × 5 × 5 (the smallest cube that does not fit) and the benchmark cubes 8 × 8 × 8 and 16 × 16 × 16, which run on the accelerator and are listed as unsupported on the CPU.
2. **The same data.** Each workload's A and B come from the reference model's generator and go, unchanged, into the CPU program's image and into the accelerator's case file.
3. **CPU.** [cpu-program.ts](../../../packages/accelerator-reference/src/harness/cpu-program.ts) generates the VCPU-8 program, the Project 1 assembler assembles it, and it runs twice: on the emulator (`@vcpu/cpu-core`: retired instructions, data reads and writes, fetched bytes, and the ISA timing model's estimate) and on the Project 2 RTL runner `hardware/rtl/vcpu8/build/sim/vcpu8_sim` (clock cycles, end state, and a per-step trace from which data reads, writes and fetched bytes are counted with the opcode table). C is read back from the end memory of each.
4. **Accelerator.** The same operands run on the 4 × 4 runner through the benchmark path ([performance-analysis.md](performance-analysis.md)): transfer-in, compute, store and transfer-out clocks, PE utilisation, MACs per cycle.
5. **Gate.** A CPU row has numbers only when the program halted on both the emulator and the RTL, C equals the reference on both, both retired the same number of instructions with the same data reads, data writes and fetched bytes, and their 256-byte end memories are identical. An accelerator row has numbers only when `done` pulsed and C equals the reference. Any failure is reported with its reason and `compare-cpu` exits 1. A workload whose program does not fit in memory is `unsupported`, with its code, data and stack byte counts, never dropped.
6. **Resources** come from the two committed synthesis baselines, `research/cpu/synth/baseline.json` and `research/accelerators/matmul/synth/baseline.json` (4 × 4).

## The VCPU-8 program

VCPU-8 has eight 8-bit registers, 256 bytes of memory for code, data and stack, an 8-bit `ADD` that sets the carry flag but no add-with-carry, and a `MUL` that keeps only the low byte of the unsigned product ([instruction-set.md](../../instruction-set.md)). The program therefore builds each signed INT8 MAC out of 8-bit steps. The code is the same 147 bytes for every workload; only the immediates (K, N, K · N − 1) and the data change.

### Signed 8 × 8 → 16-bit multiply

Shift-and-add, chosen over `MUL` on nibbles because it is shorter (the 4 × 4 × 4 program fits only because the code is small) and needs no 16-bit shifts of partial products:

```asm
mac:    LOAD R4, [R1]       ; R5:R4 = the multiplicand a, sign-extended below
        LOAD R6, [R2]       ; R6 = the multiplier b, taken as unsigned bits u
        XOR R0, R0          ; R0 = product high byte = 0
        MOV R5, R4
        SHL R5              ; C = sign of a
        MOV R5, R0          ; MOV keeps the flags
        MOV R7, R0          ; R7 = product low byte = 0
        JNC mul_bit
        DEC R5              ; a < 0: R5 = 0xFF
mul_bit: SHR R6             ; C = the next bit of u
        JNC mul_shift
        ADD R7, R4          ; R0:R7 += R5:R4
        JNC mul_hi
        INC R0
mul_hi: ADD R0, R5
mul_shift:
        SHL R5              ; R5:R4 <<= 1
        SHL R4
        JNC mul_next
        INC R5
mul_next:
        OR R6, R6
        JNZ mul_bit         ; until no bit of u is left
        LOAD R5, [R2]
        SHL R5              ; C = sign of b
        JNC acc_ext
        LOAD R4, [R1]
        SUB R0, R4          ; b < 0: u = b + 256, so take 256 * a back off
```

The multiplicand is a sign-extended to 16 bits, and the multiplier's bits are read as the unsigned byte u (u = b, or b + 256 when b < 0). Adding a · 2^i for every set bit i of u gives a · u mod 2^16; when b < 0 that is a · b + 256 · a, so subtracting a from the high byte leaves a · b. Every INT8 product lies in −16 256 … 16 384, so the 16-bit two's-complement result is exact. The loop ends as soon as no bit of u is left: one pass per bit up to u's highest set bit, always eight for a negative b. This is why the CPU's cycles depend on the data and the accelerator's do not.

### INT32 accumulate without add-with-carry

```asm
acc_ext:
        MOV R4, R0
        SHL R4              ; C = sign of the product
        JNC acc_init
        DEC R6              ; R6 = extension byte: 0 (the loop left R6 = 0) or 0xFF
acc_init:
        PUSH R3
        LDI R3, 4
        LOAD R5, [cptr]     ; R5 = &C[i][j]
        AND R4, R4          ; C = 0: no carry into byte 0
acc:    LOAD R4, [R5]
        JNC acc_add
        INC R7              ; carry in: addend byte + 1 ...
        JZ acc_store        ; ... 0xFF + 1 wrapped: the byte stays, C stays 1
acc_add:
        ADD R4, R7
acc_store:
        STORE [R5], R4
        INC R5
        MOV R7, R0          ; next addend byte: product high byte, then the extension
        MOV R0, R6
        DEC R3
        JNZ acc
        POP R3
```

C[i][j] is four little-endian bytes in memory, and the addend is the product sign-extended to 32 bits (low byte, high byte, then the extension byte twice). The carry of each `ADD` stays in the C flag across the next iteration, because `LOAD`, `STORE`, `MOV`, `INC` and `DEC` leave C alone, and is added into the next addend byte with `INC` before its `ADD`. When that `INC` wraps (an addend byte of 0xFF plus a carry), the memory byte is unchanged and the carry continues. This is a complete 32-bit add, so C wraps on overflow exactly like the reference's `| 0`; [cpu-program.test.ts](../../../packages/accelerator-reference/src/harness/cpu-program.test.ts) checks this by starting C at values next to INT32's limits. `R3` (the k counter) is pushed so the loop has a register for its byte count: the program's one stack byte.

The k, j and i loops step registers and compare addresses with labels (`R1` = &A[i][k] steps by 1, `R2` = &B[k][j] by N; after a row, `R1` is already &A[i + 1][0]), so there are no loop-counter variables in memory, and `cptr`, the address of the C element being accumulated, is initialised by the image.

### Cost of one MAC

Over all 65 536 (a, b) pairs, each a 1 × 1 × 1 program on the emulator with its product checked against a · b, one MAC into a zero accumulator retires **67 to 158 instructions (mean 127.8)**: 60 that always run, 7 per multiplier pass, 3 more per set multiplier bit, and one or two for each sign fix-up and carry. The minimum is a · 0, the maximum (−1) · (−1). The loops around the MACs add 5 instructions per MAC (the k step) and about 10 per C element.

### Memory map and the largest workload

| Workload  | Code      | `cptr` | A         | B         | C         | Free      | Stack | Total bytes |
| --------- | --------- | ------ | --------- | --------- | --------- | --------- | ----- | ----------- |
| 2 × 2 × 2 | 0x00–0x92 | 0x93   | 0x94–0x97 | 0x98–0x9B | 0x9C–0xAB | 0xAC–0xFE | 0xFF  | 173         |
| 3 × 3 × 3 | 0x00–0x92 | 0x93   | 0x94–0x9C | 0x9D–0xA5 | 0xA6–0xC9 | 0xCA–0xFE | 0xFF  | 203         |
| 4 × 4 × 4 | 0x00–0x92 | 0x93   | 0x94–0xA3 | 0xA4–0xB3 | 0xB4–0xF3 | 0xF4–0xFE | 0xFF  | 245         |

A workload needs 147 bytes of code, 1 + M · K + K · N + 4 · M · N bytes of data and 1 byte of stack. 4 × 4 × 4 needs 245 of the 256 bytes, so it is the largest cube that fits; 5 × 5 × 5 needs 299 (code 147 + data 151 + stack 1). The program does not follow the memory map's program/data/stack convention ([memory-model.md](../../memory-model.md)), which the CPU does not enforce: the code runs past 0x7F (it ends at 0x92), and the data use what would be the stack region, all but 0xFF, the one byte the program pushes.

## Results

From [research/accelerators/matmul/comparisons/](../../../research/accelerators/matmul/comparisons/) (seed 1; the report records its commit, toolchain and runners). Every CPU row passed the gate on the emulator and the RTL, and every accelerator row on the 4 × 4 runner.

| Workload        | MACs | CPU cycles (RTL) | CPU instructions | CPU data reads / writes | CPU MACs/cycle | Accelerator total cycles (in + compute + store + out) | Accelerator MACs/cycle (total) | Cycle ratio |
| --------------- | ---: | ---------------: | ---------------: | ----------------------: | -------------: | ----------------------------------------------------: | -----------------------------: | ----------: |
| 2x2x2-random    |    8 |            5 617 |            1 114 |                 76 / 44 |         0.0014 |                                   26 (4 + 10 + 4 + 5) |                          0.308 |       216.0 |
| 3x3x3-random    |   27 |           18 555 |            3 685 |               258 / 144 |         0.0015 |                                  42 (9 + 11 + 9 + 10) |                          0.643 |       441.8 |
| 4x4x4-random    |   64 |           43 112 |            8 567 |               612 / 336 |         0.0015 |                                64 (16 + 12 + 16 + 17) |                          1.000 |       673.6 |
| 4x4x4-min       |   64 |           40 632 |            8 071 |               640 / 336 |         0.0016 |                                64 (16 + 12 + 16 + 17) |                          1.000 |       634.9 |
| 5x5x5-random    |  125 |      unsupported |                — |                       — |              — |                                                   134 |                          0.933 |           — |
| 8x8x8-random    |  512 |      unsupported |                — |                       — |              — |                                                   263 |                          1.947 |           — |
| 16x16x16-random | 4096 |      unsupported |                — |                       — |              — |                                                 1 171 |                          3.498 |           — |

The cycle ratio is CPU RTL cycles ÷ accelerator total cycles: two clock counts of different designs at an unspecified clock, not a speed-up.

| Design          | Generic cells | Generic flip-flops | ECP5 LUTs | ECP5 flip-flops | ECP5 block RAM | ECP5 DSP | iCE40UP5K    |
| --------------- | ------------: | -----------------: | --------: | --------------: | -------------: | -------: | ------------ |
| VCPU-8          |         7 480 |              2 238 |       507 |             124 |              1 |        1 | fits         |
| Accelerator 4×4 |        18 130 |              1 049 |       737 |           1 049 |             16 |       16 | does not fit |

VCPU-8's generic count includes its 256-byte memory mapped to 2 048 flip-flops; without it (`vcpu8_core`) the CPU is 1 981 cells and 182 flip-flops. The accelerator's generic count leaves its buffers (196 608 bits) out as memory cells. The ECP5 columns put both designs' memories in block RAM and their multipliers in DSP blocks, so they are the closest like-for-like figures.

## Interpretation

- **Where the CPU's clocks go.** About 135 instructions and 670 clocks per MAC on 4 × 4 × 4, at a CPI of 5.03: the RTL is multicycle (4 to 6 clocks per instruction, [vcpu8-microarchitecture.md](../vcpu8-microarchitecture.md)), which is why its cycles are about 1.5 times the ISA timing model's estimate (28 477 for 4 × 4 × 4). Most of a MAC is the shift-and-add loop and the four-byte read-modify-write of the accumulator, not the loads of A and B.
- **The data change the CPU's cost.** All −128 is _faster_ than random data (40 632 against 43 112 clocks) although its products are the largest: 0x80 has one set bit, so each multiply adds once in its eight passes, while a random multiplier byte has four set bits on average, each an addition. The accelerator's 64 clocks are the same for both.
- **The accelerator's clocks for these tiny products are mostly transfer.** At 4 × 4 × 4, 12 of the 64 clocks are compute; the other 52 move A, B and C through the one-element-per-clock testbench host port. Even so, it needs 674 times fewer clocks than the CPU on this product, with 16 multipliers and 32-bit adders working in parallel, against one 8-bit ALU step at a time.
- **The cost beside the clocks.** On ECP5 the accelerator uses about 1.5 times the CPU's LUTs, 8.5 times its flip-flops, 16 times its block RAM and 16 DSP blocks against 1, and it does not fit the iCE40UP5K that the CPU fits. Most of the block RAM is buffer capacity for 64 × 64 matrices, which these products do not use.
- **What does not fit.** Anything larger than 4 × 4 × 4 is unsupported on VCPU-8: its 256 bytes hold code, operands and four-byte results together. The accelerator runs those products (8 × 8 × 8 at 1.95 MACs per total clock, 16 × 16 × 16 at 3.50).

## How this comparison follows the fair-comparison rules

The rules are those of [from-rtl-to-silicon.md § 13](from-rtl-to-silicon.md#13-how-to-compare-accelerator-designs-fairly).

1. **Correctness first:** every reported row passed the gate above on every machine it ran on; a failing row has no numbers.
2. **The same workloads and data:** the same seeded operands on both machines, small and (accelerator-only) larger products.
3. **The same things counted:** MACs (M · N · K) on both; the accelerator's transfers are reported separately and included in its total; the CPU's instruction fetches are reported apart from its data accesses. The two "memory access" counts are labelled as different quantities.
4. **Cycles are not time:** no clock frequency is assumed. The synthesis baselines record Fmax estimates for named FPGAs; applying them would give labelled time estimates, and this report does not.
5. **The same tools:** both baselines and both runners use the pinned OSS CAD Suite; the report records the versions and commits.
6. **The cost beside the speed:** resources sit next to the clock counts.
7. **No power:** not measured for either design.
8. **No simulator wall-clock:** none is reported.
9. **No single score:** the cycle ratio is labelled as a clock-count ratio, and the resource table stays beside it.
10. **The differences not in the numbers** are the report's "What differs" section: ISA versus fixed function, unsigned low-byte `MUL` versus a signed INT8 MAC, software multi-byte INT32 versus a hardware 32-bit adder, 256 bytes of unified memory versus on-chip buffers and a host port, no clock frequency, no power.

## What would make VCPU-8 faster here

These are recommendations for a future ISA revision, not changes made here (the ISA is not modified): an add-with-carry would remove the carry branches from the accumulate loop, a signed multiply that returns the high byte (or a 16-bit product) would replace the eight-pass shift-and-add with one instruction, and a larger address space would let products beyond 4 × 4 × 4 run at all.
