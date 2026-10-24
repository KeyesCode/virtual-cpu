# Memory: `input_buffer`, `output_buffer` and the host port

The accelerator keeps A, B and C entirely on chip, in three buffers sized for the largest r1 matmul (64 × 64 · 64 × 64). A and B sit in `input_buffer`s, banked so that one clock reads a whole edge of a tile (one A element per array row and one B element per array column); C sits in one `output_buffer`, written one element per clock by the controller's STORE state. A simplified synchronous host port fills A and B and reads C back. It is a testbench convenience, not a production memory system.

- RTL: [rtl/input_buffer.sv](../../../hardware/accelerators/matmul/rtl/input_buffer.sv), [rtl/output_buffer.sv](../../../hardware/accelerators/matmul/rtl/output_buffer.sv), wired in [rtl/matmul_top.sv](../../../hardware/accelerators/matmul/rtl/matmul_top.sv)
- Driven by: [matmul_controller](controller.md) (read addresses, stores) and the host port
- Contract: [architecture.md](architecture.md#memory-buffers-and-the-host-port)

## Sizes

Every buffer holds `MAX_DIM`² = 4096 elements, whatever the array size; only the banking changes with `ROWS` and `COLS`.

| Buffer             | Instance     | Element | Banks  | Entries per bank | 4 × 4    | 8 × 8    | 16 × 16  | Bits    |
| ------------------ | ------------ | ------- | ------ | ---------------- | -------- | -------- | -------- | ------- |
| `input_buffer` (A) | `u_a_buffer` | INT8    | `ROWS` | 4096 / `ROWS`    | 4 × 1024 | 8 × 512  | 16 × 256 | 32 768  |
| `input_buffer` (B) | `u_b_buffer` | INT8    | `COLS` | 4096 / `COLS`    | 4 × 1024 | 8 × 512  | 16 × 256 | 32 768  |
| `output_buffer`    | `u_c_buffer` | INT32   | 1      | 4096             | 1 × 4096 | 1 × 4096 | 1 × 4096 | 131 072 |

That is 196 608 bits (24 KiB) of RAM for every size: 9 RAMs at 4 × 4, 17 at 8 × 8 and 33 at 16 × 16.

## Data layout and banking

Every matrix is row-major with a fixed row stride of `MAX_DIM`, whatever M, N and K are: A[i, k] is at i · 64 + k, B[k, j] at k · 64 + j and C[i, j] at i · 64 + j. A 12-bit address is therefore a 6-bit row index and a 6-bit column index side by side, so nothing needs a multiplier or a divider, and a smaller matrix uses the top-left corner of its buffer.

`input_buffer` banks by address bits. Its `BANK_LSB` parameter says where the log₂ `BANKS` bank bits are; the address within the bank is the address with those bits removed:

| Buffer | `BANKS` | `BANK_LSB` | Bank of A[i, k] / B[k, j] | Address within the bank (bits)            |
| ------ | ------- | ---------- | ------------------------- | ----------------------------------------- |
| A      | `ROWS`  | 6          | i mod `ROWS`              | {i / `ROWS`, k}: 6 − log₂ `ROWS` + 6 bits |
| B      | `COLS`  | 0          | j mod `COLS`              | {k, j / `COLS`}: 6 + 6 − log₂ `COLS` bits |

The read port takes one flat address whose bank bits are zero, the address of the tile's first row (A) or first column (B), and bank b returns the element b rows down (A) or b columns along (B). For a tile with first row row0 and first column col0 (multiples of `ROWS` and `COLS`), the controller's read in COMPUTE clock k is

- A: address row0 · 64 + k, and bank r returns A[row0 + r, k], for r = 0 … `ROWS` − 1;
- B: address k · 64 + col0, and bank c returns B[k, col0 + c], for c = 0 … `COLS` − 1.

Every bank serves exactly one read per clock, and every bank reads the same address within itself. Rows past M (or columns past N) of an edge tile read whatever the buffer holds there, stale data from an earlier, larger run or never-written entries, and the controller replaces them by zeros before the array.

## Bandwidth

| Path                         | Per clock            | 4 × 4   | 8 × 8    | 16 × 16  | When                |
| ---------------------------- | -------------------- | ------- | -------- | -------- | ------------------- |
| A and B reads (to the array) | `ROWS` + `COLS` INT8 | 8 bytes | 16 bytes | 32 bytes | every COMPUTE clock |
| C writes (from the array)    | 1 INT32              | 4 bytes | 4 bytes  | 4 bytes  | every STORE clock   |
| Host A write, host B write   | 1 INT8 each          | 2 bytes | 2 bytes  | 2 bytes  | while `busy` is low |
| Host C read                  | 1 INT32              | 4 bytes | 4 bytes  | 4 bytes  | while `busy` is low |

The read bandwidth is why A is banked by row and B by column: a single-ported 4096-entry RAM could feed one element per clock, but the array consumes `ROWS` + `COLS`. The single C write port is the r1 bottleneck on large arrays (see [controller.md](controller.md#cycle-formulas)): a 16 × 16 tile computes in K + 32 clocks and stores in 256.

## Read and write timing

Each bank, and the output buffer, is one RAM inference pattern: one `always_ff` with a write port and a registered read, and no reset of the contents (`rst` leaves A, B and C as they are, so a run after a reset can reuse them).

- **Reads are registered**: `rd_data` in clock t + 1 is the element at the `rd_addr` of clock t. The controller issues each read address one clock before it needs the data (PREPARE_TILE primes k = 0). The host's C read is the same: `host_c_rdata` in clock t + 1 is C at the `host_c_addr` of clock t, so reading M · N elements takes M · N + 1 clocks.
- **Writes take effect at the clock edge**: a write in clock t is readable from clock t + 1. A read and a write of the same address in one clock read the old element.
- **The host writes only while `busy` is low.** `matmul_top` gates `host_a_we` and `host_b_we` with `!busy`, so a host write during a run is dropped, never mixed into the operands being read. The controller writes C only in STORE (while `busy`), the host reads it only after `done`.

## Maximum dimensions and capacity

M, N and K are each 1 … 64. One matmul of up to 64 × 64 · 64 × 64 fits in the buffers; a dimension of 0 is rejected with `ERR_DIM_ZERO` and one above 64 with `ERR_DIM_TOO_LARGE` (the full 16-bit `cfg_*` value is checked, so nothing is truncated into range). Raising `MAX_DIM` (a power of two) grows every buffer to `MAX_DIM`² entries and every address by two bits per doubling.

## The host port is a testbench convenience

The host port (`host_a_we/addr/wdata`, `host_b_we/addr/wdata`, `host_c_addr/rdata`) is synchronous, one element per port per clock, with no burst, DMA, AXI or flow control. It exists so a testbench or the Verilator runner can load operands and read results; a production accelerator would stream A and B from an external memory with its own bandwidth limit and probably double-buffer them behind the compute. That is why every report counts the three phases separately:

- **transfer in**: max(M · K, K · N) clocks when A and B are written in parallel (what `tb_matmul_top` does), M · K + K · N one after the other;
- **compute and store**: `cycles_compute` and `cycles_store` from the controller ([controller.md](controller.md#cycle-formulas));
- **transfer out**: M · N + 1 clocks.

For 64 × 64 · 64 × 64 on the 16 × 16 array that is 4096 clocks in, 1536 compute, 4096 store and 4097 out: the testbench host port costs more clocks than the arithmetic. A run that reuses the operands already in the buffers (the testbench's reuse cases) skips the transfer in.

## RAM inference

A hand-run check with the pinned Yosys 0.70+145 (the synthesis ticket's `make synth` produces the official reports), from `hardware/accelerators/matmul`:

```sh
yosys -q -p 'read_verilog -sv rtl/matmul_pkg.sv rtl/input_buffer.sv rtl/output_buffer.sv rtl/matmul_controller.sv
  rtl/processing_element.sv rtl/systolic_array.sv rtl/matmul_top.sv; chparam -set ROWS 16 -set COLS 16 matmul_top;
  hierarchy -check -top matmul_top; proc; check -assert; flatten; opt_clean; memory -nomap; stat'
```

`check -assert` passes (no latch, no multiple drivers, no combinational loop) and `memory -nomap` leaves one `$mem_v2` per bank: 9 at 4 × 4, 17 at 8 × 8 and 33 at 16 × 16. Each has one write port and one read port with `RD_CLK_ENABLE` = 1 (a synchronous read, the registered output merged into the memory), 8 bits × 4096 / `BANKS` entries for A and B and 32 bits × 4096 for C, so each maps onto block RAM where the target has it rather than onto flip-flops.
