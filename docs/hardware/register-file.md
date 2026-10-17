# Register File and FLAGS

This page describes the two modules that hold VCPU-8's general architectural state: `vcpu8_registers` (R0–R7) and `vcpu8_flags` (FLAGS). Both live in `hardware/rtl/vcpu8/core/`, and both are tested on their own by `make -C hardware/rtl/vcpu8 test`. The PC, SP, SD and IR registers live in the control unit, not here.

## Flip-flops and sequential logic

A **flip-flop** stores one bit. On each rising edge of `clk`, it copies its input D to its output Q, and Q then holds that value until the next rising edge, whatever D does in between. A register is a row of flip-flops sharing one clock: R0 is 8 flip-flops, and the whole register file is 8 × 8 = 64.

The RTL has two kinds of logic:

- **Sequential logic** has memory. Its outputs depend on what happened at earlier clock edges. In SystemVerilog it is written in `always_ff @(posedge clk)` with nonblocking assignments (`<=`), and it synthesizes to flip-flops. The register contents and FLAGS are sequential.
- **Combinational logic** has no memory. Its outputs are a function of its present inputs only, and they settle shortly after an input changes, with no clock involved. It is written with `assign` or `always_comb`, and it synthesizes to gates and multiplexers. The read ports, the write decode, the FLAGS mask merge and the FLAGS byte view are combinational.

The design rule is that every piece of state is in an `always_ff` and changes only on a clock edge, and everything between flip-flops is combinational with no loops. One clock edge is then one well-defined step of the machine, which is what lets the RTL match the emulator at every instruction boundary.

## `vcpu8_registers`

```text
                 we ──┐
  wa[2:0] ──► 3→8 decode ──► one load enable per register
  wd[7:0] ─────────────────► D of R0 … R7   (8 × 8 flip-flops, synchronous reset)
                                   │
                                   ├──► 8:1 mux, select ra_addr ──► ra_data[7:0]
                                   ├──► 8:1 mux, select rb_addr ──► rb_data[7:0]
                                   └──► {R7, …, R0} ──────────────► dbg_regs[63:0]
```

| Port       | Dir | Bits | Meaning                                                               |
| ---------- | --- | ---- | --------------------------------------------------------------------- |
| `clk`      | in  | 1    | The CPU clock. All writes happen on its rising edge.                  |
| `rst`      | in  | 1    | Synchronous, active-high reset.                                       |
| `ra_addr`  | in  | 3    | Read port A address: register-byte field a.                           |
| `rb_addr`  | in  | 3    | Read port B address: register-byte field b.                           |
| `ra_data`  | out | 8    | Contents of `R[ra_addr]`, combinational.                              |
| `rb_data`  | out | 8    | Contents of `R[rb_addr]`, combinational.                              |
| `we`       | in  | 1    | Write enable.                                                         |
| `wa`       | in  | 3    | Write address: always register-byte field a (the destination `Rd`).   |
| `wd`       | in  | 8    | Write data.                                                           |
| `dbg_regs` | out | 64   | All eight registers packed, R0 in bits 7:0 … R7 in bits 63:56. Debug. |

### Read ports

Each read port is an **8:1 multiplexer**: the 3-bit address selects one of the eight register outputs. The ports are written as `assign ra_data = r[ra_addr];`, so they are combinational. A new address gives new data within the same cycle, with no clock edge needed. The two ports are independent and may read the same register or different ones.

### Write port

The write port is a **3-to-8 decoder** on `wa`, ANDed with `we`. Exactly one register's flip-flops are enabled when `we` is high, and none when it is low. On the rising edge, the enabled register loads `wd` and the other seven reload their own value. Yosys builds the 64 storage bits as flip-flops with a synchronous reset and a clock enable (`$_SDFFCE_*`). For the module on its own, a generic `synth -top vcpu8_registers` reports 268 cells, 64 of them flip-flops and 80 of them `$_MUX_`.

`wa` is always field a, because every VCPU-8 instruction that writes a general register writes the register named in field a (`MOV Rd, Rs`, `LDI Rd, imm`, `ADD Rd, Rs`, `POP Rd` and so on). The decoder therefore needs no write-address multiplexer.

R0 is an ordinary register. There is no hard-wired zero register, and a write to R0 is stored like any other.

### Read-during-write

When a read port reads the register that is being written in the same cycle:

- **before the clock edge**, the read returns the **old** value;
- **after the edge**, it returns the **new** value.

There is no bypass (forwarding) path from `wd` to the read ports. This falls out of the structure: the read ports look at the flip-flop outputs, and the flip-flops change only on the edge.

The CPU relies on this. An instruction reads its sources before anything is written, and its write-back happens on a later edge. So `ADD R0, R0` doubles the old R0, and `LOAD R1, [R1]` uses the old R1 as the address. The Project 1 vectors `op-add-same-register` and `op-load-ind` check both cases.

### Reset

`rst` is **synchronous** and **active-high**. When `rst` is 1 at a rising edge, every register loads `RESET_REG` (`8'h00`, from `vcpu8_isa_pkg`). Reset takes priority over a write in the same cycle. Nothing changes between edges, so reset must be held for at least one rising edge. After reset no output is X: all registers read `8'h00`.

### Debug tap

`dbg_regs` exposes all eight registers at once, packed with R0 in the low byte. Nothing in the CPU's own datapath reads it. Testbenches compare it with the emulator's registers at every instruction boundary, and it will drive a debug or loader interface later. It is plain wiring from the flip-flops and adds no logic.

### Why invalid register encodings never reach the register file

The ISA's register byte has two 4-bit fields, so an encoding can name registers 8–15, which do not exist. The register file's ports are only 3 bits wide, so an encoding of 8–15 cannot even be presented to it, and a truncated 4-bit value would silently pick the wrong register.

That never happens, because the **decoder** validates the register byte first ([instruction-set.md](../instruction-set.md)):

- a used field holding 8–15 is a `MALFORMED_OPERAND` fault;
- an unused field b (formats R, RI and RA) that is not `0000` is a `MALFORMED_OPERAND` fault.

A faulting instruction never reaches EXECUTE or WRITEBACK, so `we` is never raised for it, and the fields reach `ra_addr`, `rb_addr` and `wa` as 3 bits only after validation. Register index validation is therefore the decoder's job, and the register file can assume that every address is a real register. The tests for invalid encodings belong to the decoder ticket. This module's tests show that all eight 3-bit indices are distinct storage.

## `vcpu8_flags`

FLAGS holds four bits, **Z** (zero), **C** (carry), **N** (negative) and **V** (overflow), at bit positions `FLAG_Z = 3`, `FLAG_C = 2`, `FLAG_N = 1` and `FLAG_V = 0`, taken from `vcpu8_isa_pkg`.

| Port         | Dir | Bits | Meaning                                                   |
| ------------ | --- | ---- | --------------------------------------------------------- |
| `clk`, `rst` | in  | 1    | As for the register file: synchronous, active-high reset. |
| `mask`       | in  | 4    | Which flags this instruction updates (1 = update).        |
| `new_flags`  | in  | 4    | The ALU's flag results, in the same bit order.            |
| `flags`      | out | 4    | `{Z, C, N, V}`.                                           |
| `flags_byte` | out | 8    | The architectural 8-bit FLAGS byte, `{4'h0, Z, C, N, V}`. |

### The mask rule

Each instruction updates only the flags in its mask and leaves the others alone:

```text
flags <= (flags & ~mask) | (new_flags & mask)
```

For every bit this is a 2:1 multiplexer in front of the flip-flop: if the mask bit is 1 the flip-flop loads the new flag, otherwise it reloads its own value. A generic `synth -top vcpu8_flags` gives 4 `$_MUX_` and 4 flip-flops with a synchronous reset. A zero mask holds every flag, so FLAGS needs no separate write enable. The control unit is meant to drive a zero mask on every cycle except an ALU instruction's write-back, with each opcode's mask taken from `vcpu8_isa_pkg::isa_flag_mask`.

FLAGS has the same read-during-write behaviour as the register file: `flags` shows the old value until the edge and the updated value after it.

`rst` clears FLAGS to `RESET_FLAGS` (`4'h0`), taking priority over any update in that cycle. Bits 7–4 of `flags_byte` are constant zeros, matching the emulator, which always reads them as 0.

## Tests

| Testbench                       | What it proves                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tb/unit/tb_vcpu8_registers.sv` | Reset of every register (also after they were written); write and read-back of each register; `we = 0` holds everything; back-to-back writes to the same and to different registers; read-during-write on both ports; every pair of read addresses; 10,000 random operations (fixed-seed xorshift, occasional resets) checked against a model, including `dbg_regs`. |
| `tb/unit/tb_vcpu8_flags.sv`     | All 16 × 16 × 16 (old flags, mask, new flags) combinations, each checked after the edge and held before it; the byte view and its zero top nibble; reset, including reset winning over an update.                                                                                                                                                                    |

Each testbench counts its errors and ends with `$fatal(1, …)` if any check failed, so `make test` exits non-zero. Run one with `make -C hardware/rtl/vcpu8 test-registers` or `test-flags`.
