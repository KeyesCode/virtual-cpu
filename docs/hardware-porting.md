# Hardware Porting

This document explains how to build VCPU-8 (ISA version 1.0.0) in SystemVerilog, and how to prove that the design matches the TypeScript emulator using the committed test fixtures. It is the hand-off from Project 1 (the emulator) to Project 2 (the RTL CPU).

It does not restate the ISA. Encodings and per-instruction semantics are in [instruction-set.md](instruction-set.md), the execution steps, faults and reset are in [cpu-execution.md](cpu-execution.md), and memory and the stack are in [memory-model.md](memory-model.md). Where this document gives an equation, it is the same rule written in hardware terms. If the two ever disagree, the code in `@vcpu/shared` and `@vcpu/cpu-core` is authoritative, and the fixtures show what that code does.

## What the RTL must match

An RTL implementation is correct when, at every **instruction boundary**, its architectural state equals the emulator's state after the same number of steps:

| State                | Width                    | Compared |
| -------------------- | ------------------------ | -------- |
| R0–R7                | 8 × 8 bits               | yes      |
| PC                   | 8 bits                   | yes      |
| SP                   | 8 bits                   | yes      |
| SD (stack depth)     | 7 bits, 0–64             | yes      |
| FLAGS                | 4 bits (bits 7–4 read 0) | yes      |
| memory               | 256 × 8 bits             | yes      |
| status               | RUN / HALTED / FAULTED   | yes      |
| fault code, fault PC | 3 bits, 8 bits           | yes      |
| retired instructions | counter                  | yes      |
| IR                   | opcode + 2 operand bytes | no       |
| clock cycles         | —                        | no       |

How many clock cycles an instruction takes, and what happens in the middle of an instruction, is up to the design. The emulator executes each instruction as one atomic step and has no notion of a clock. Its "estimated cycles" come from a teaching model, not from a circuit (see [Instructional timing vs real cycles](#instructional-timing-vs-real-cycles)).

## Module breakdown

```
vcpu8_top
├── control_fsm   FETCH → DECODE → OPERANDS → EXECUTE → WRITEBACK, status, fault and halt logic,
│                 PC, SP, SD, FLAGS, IR, retire counter
├── decoder       combinational: opcode → control signals (the opcode table as logic)
├── regfile       R0–R7: 8 × 8 flip-flops, 2 asynchronous read ports, 1 synchronous write port
├── alu           combinational: a, b, op, C_in → r, Z, C, N, V
└── ram256x8      256 × 8 synchronous single-port RAM (code, data and stack)
```

| Module        | Kind                     | Holds state                                     | Key ports                                                                                 |
| ------------- | ------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `vcpu8_top`   | structural               | —                                               | `clk`, `rst`, `status[2:0]`, `fault_code[2:0]`, `fault_pc[7:0]`, `retire`, debug taps     |
| `control_fsm` | sequential + next-state  | PC, SP, SD, FLAGS, IR, FSM state, status, fault | decoder outputs in; register-file, ALU and RAM controls out                               |
| `decoder`     | combinational            | —                                               | `opcode[7:0]` → `valid`, `len[1:0]`, field checks, mux selects, enables, `flag_mask[3:0]` |
| `regfile`     | sequential (8 × 8 flops) | R0–R7                                           | `ra_addr[2:0]`, `rb_addr[2:0]` → `ra_data`, `rb_data`; `we`, `wa[2:0]`, `wd[7:0]`         |
| `alu`         | combinational            | —                                               | `a[7:0]`, `b[7:0]`, `op`, `c_in` → `r[7:0]`, `z`, `c`, `n`, `v`                           |
| `ram256x8`    | synchronous RAM          | memory                                          | `addr[7:0]`, `we`, `wdata[7:0]` → `rdata[7:0]` (registered, 1-cycle read latency)         |

`vcpu8_top` should also expose debug taps for the testbench, such as `dbg_r[0:7]`, `dbg_pc`, `dbg_sp`, `dbg_sd`, `dbg_flags` and `instret`. Hierarchical references work just as well in simulation. Memory is loaded and dumped through the RAM's array (see [Using the fixtures in a testbench](#using-the-fixtures-in-a-testbench)).

## Registers

### Register file (`regfile`)

Eight 8-bit registers are built from flip-flops. Two combinational read ports serve the two register fields of an instruction, and one synchronous write port writes the destination.

```systemverilog
module regfile (
  input  logic       clk, rst,
  input  logic [2:0] ra_addr, rb_addr,   // field a = IR.rb[6:4], field b = IR.rb[2:0]
  output logic [7:0] ra_data, rb_data,
  input  logic       we,
  input  logic [2:0] wa,                 // always field a: every register-writing instruction writes Rd in field a
  input  logic [7:0] wd
);
  logic [7:0] r [8];
  assign ra_data = r[ra_addr];
  assign rb_data = r[rb_addr];
  always_ff @(posedge clk)
    if (rst)     r <= '{default: 8'h00};
    else if (we) r[wa] <= wd;
endmodule
```

Every instruction reads its sources before anything is written. Because the read ports are combinational and the write happens on the WRITEBACK clock edge, `ADD R0, R0` and `LOAD R1, [R1]` see the old value automatically (vectors `op-add-same-register`, `op-load-ind`).

### Special registers

| Register   | Bits | Reset   | Written in                       | Notes                                                                                |
| ---------- | ---- | ------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| PC         | 8    | `8'h00` | WRITEBACK only                   | Never wraps; see `PC_OVERFLOW`                                                       |
| SP         | 8    | `8'hFF` | WRITEBACK (PUSH, POP, CALL, RET) | Invariant `SP == 8'hFF - SD`; no instruction writes SP directly                      |
| SD         | 7    | `7'd0`  | WRITEBACK (PUSH, POP, CALL, RET) | 0–64; stack overflow and underflow are detected on SD, never on SP wrapping          |
| FLAGS      | 4    | `4'h0`  | WRITEBACK (ALU instructions)     | `{Z, C, N, V}` = bits 3–0. Reads of the 8-bit FLAGS byte return `{4'h0, Z, C, N, V}` |
| IR.op      | 8    | `8'h00` | DECODE                           | Opcode byte                                                                          |
| IR.rb      | 8    | `8'h00` | OPERANDS                         | Register byte: field a = `rb[7:4]`, field b = `rb[3:0]`                              |
| IR.tb      | 8    | `8'h00` | OPERANDS                         | Trailing byte: `imm8` or `addr8`, always the instruction's last byte                 |
| status     | 3    | RUN     | DECODE … WRITEBACK               | Encoded with `CPU_STATUS_NUMBERS`: READY = 0, HALTED = 3, FAULTED = 4                |
| fault_code | 3    | `3'd0`  | on a fault                       | `FAULT_CODE_NUMBERS` (table below); 0 = no fault                                     |
| fault_pc   | 8    | `8'h00` | on a fault                       | Address of the faulting instruction                                                  |
| instret    | ≥ 32 | 0       | WRITEBACK                        | Retired-instruction counter, compared with `expected.instructions`                   |

For the A format (JMP … CALL), the address byte is byte 1. Latch it into `IR.tb` so that "the trailing byte" means the same register for every format. The A format has no register byte.

The emulator's READY, RUNNING and PAUSED are all the same "can execute" state, because they only describe the software run loop. The RTL needs one RUN state, reported as READY (0) on `status`.

## ALU (`alu`)

The ALU is purely combinational. It takes the two operands `a` (field a, the destination or first operand) and `b` (field b), the operation and the incoming carry, and produces the 8-bit result `r` and four flag values. Every operation computes Z and N in the same way:

```
Z = (r == 8'h00)
N = r[7]
```

| Operation | Result `r`                               | C                        | V                                 |
| --------- | ---------------------------------------- | ------------------------ | --------------------------------- |
| ADD       | `s[7:0]` where `s = {1'b0,a} + {1'b0,b}` | `s[8]` (carry out)       | `(a[7] == b[7]) & (r[7] != a[7])` |
| SUB, CMP  | `d[7:0]` where `d = {1'b0,a} - {1'b0,b}` | `d[8]` (borrow: `a < b`) | `(a[7] != b[7]) & (r[7] != a[7])` |
| MUL       | `p[7:0]` where `p = a * b` (16 bits)     | `\|p[15:8]`              | `\|p[15:8]` (same as C)           |
| DIV       | `a / b` (unsigned, floor), `b != 0`      | `0`                      | `0`                               |
| INC       | `a + 8'd1`                               | `c_in` (unchanged)       | `a == 8'h7F`                      |
| DEC       | `a - 8'd1`                               | `c_in` (unchanged)       | `a == 8'h80`                      |
| AND       | `a & b`                                  | `0`                      | `0`                               |
| OR        | `a \| b`                                 | `0`                      | `0`                               |
| XOR       | `a ^ b`                                  | `0`                      | `0`                               |
| NOT       | `~a`                                     | `0`                      | `0`                               |
| SHL       | `{a[6:0], 1'b0}`                         | `a[7]`                   | `0`                               |
| SHR       | `{1'b0, a[7:1]}`                         | `a[0]`                   | `0` (and N is always 0)           |

These are exactly the rules in [instruction-set.md](instruction-set.md#exact-flag-rules) and `packages/cpu-core/src/alu.ts`. In particular:

- The 9-bit subtraction `{1'b0,a} - {1'b0,b}` has bit 8 set exactly when `a < b` unsigned. That bit is the **borrow**, and the C flag holds it directly. VCPU-8 does not use the inverted "carry = not borrow" convention of some CPUs.
- INC and DEC pass the incoming C through. The ALU needs `c_in` only for them.
- CMP is SUB with the register write disabled.
- `p = a * b` is a plain 8 × 8 → 16-bit unsigned product.

FLAGS are then updated through a per-opcode **flag mask** from the decoder:

```systemverilog
flags_next = (flags & ~flag_mask) | ({z, c, n, v} & flag_mask);
```

The mask is `4'b1111` for every ALU operation except INC and DEC, whose mask is `4'b1011` (Z, N and V; C is kept). A cleared flag such as C after AND is simply an ALU output of 0 under the mask. The mask is `4'b0000` for all other instructions. Loading a zero with LDI, LOAD or POP never sets Z.

**Division.** A combinational 8-bit divider is large and slow. A restoring divider that produces one quotient bit per clock (8 iterations in EXECUTE) is the usual choice. It changes only the cycle count, not the result. The divide-by-zero check (`b == 0`) must happen before any state is written, and it does not depend on the divider.

## Decoder (`decoder`)

The decoder turns the opcode byte into control signals. It is the opcode table in `packages/shared/src/isa/opcodes.ts` written as a `case` statement. Any opcode not listed sets `valid = 0`, which raises `INVALID_OPCODE`.

Column key:

- **len** is the instruction length in bytes.
- **fields** says which register-byte fields are used. `a` means field a is used and field b must be 0. `ab` means both are used. `—` means there is no register byte.
- **rf_we / wsel** is the register write enable and its data source. The write address is always field a.
- **mem** gives the data-memory access and its address source (`tb`, `A` = port a, `B` = port b, `SP`, `SP+1`).
- **wdata** is the memory write data.
- **mask** is the FLAGS write mask `ZCNV`.
- **stack** is the SP/SD update: `push` means SP − 1 and SD + 1, `pop` means SP + 1 and SD − 1.
- **pc_sel** selects the next PC: `seq` = PC + len, `hold` = unchanged, `tb` = target, `cond` = `tb` if the condition holds else `seq`, `mem` = the popped byte.

| Op     | Instruction       | len | fields | alu_op | rf_we / wsel | mem         | wdata | mask   | stack | pc_sel      |
| ------ | ----------------- | --- | ------ | ------ | ------------ | ----------- | ----- | ------ | ----- | ----------- |
| `0x00` | NOP               | 1   | —      | —      | —            | —           | —     | `0000` | —     | seq         |
| `0x01` | HLT               | 1   | —      | —      | —            | —           | —     | `0000` | —     | hold (halt) |
| `0x10` | MOV Rd, Rs        | 2   | ab     | —      | 1 / B        | —           | —     | `0000` | —     | seq         |
| `0x11` | LDI Rd, imm8      | 3   | a      | —      | 1 / tb       | —           | —     | `0000` | —     | seq         |
| `0x12` | LOAD Rd, [addr8]  | 3   | a      | —      | 1 / rdata    | read `tb`   | —     | `0000` | —     | seq         |
| `0x13` | LOAD Rd, [Rp]     | 2   | ab     | —      | 1 / rdata    | read `B`    | —     | `0000` | —     | seq         |
| `0x14` | STORE [addr8], Rs | 3   | a      | —      | —            | write `tb`  | A     | `0000` | —     | seq         |
| `0x15` | STORE [Rp], Rs    | 2   | ab     | —      | —            | write `A`   | B     | `0000` | —     | seq         |
| `0x20` | ADD Rd, Rs        | 2   | ab     | ADD    | 1 / alu      | —           | —     | `1111` | —     | seq         |
| `0x21` | SUB Rd, Rs        | 2   | ab     | SUB    | 1 / alu      | —           | —     | `1111` | —     | seq         |
| `0x22` | MUL Rd, Rs        | 2   | ab     | MUL    | 1 / alu      | —           | —     | `1111` | —     | seq         |
| `0x23` | DIV Rd, Rs        | 2   | ab     | DIV    | 1 / alu      | —           | —     | `1111` | —     | seq         |
| `0x24` | INC Rd            | 2   | a      | INC    | 1 / alu      | —           | —     | `1011` | —     | seq         |
| `0x25` | DEC Rd            | 2   | a      | DEC    | 1 / alu      | —           | —     | `1011` | —     | seq         |
| `0x30` | AND Rd, Rs        | 2   | ab     | AND    | 1 / alu      | —           | —     | `1111` | —     | seq         |
| `0x31` | OR Rd, Rs         | 2   | ab     | OR     | 1 / alu      | —           | —     | `1111` | —     | seq         |
| `0x32` | XOR Rd, Rs        | 2   | ab     | XOR    | 1 / alu      | —           | —     | `1111` | —     | seq         |
| `0x33` | NOT Rd            | 2   | a      | NOT    | 1 / alu      | —           | —     | `1111` | —     | seq         |
| `0x34` | SHL Rd            | 2   | a      | SHL    | 1 / alu      | —           | —     | `1111` | —     | seq         |
| `0x35` | SHR Rd            | 2   | a      | SHR    | 1 / alu      | —           | —     | `1111` | —     | seq         |
| `0x36` | CMP Ra, Rb        | 2   | ab     | SUB    | —            | —           | —     | `1111` | —     | seq         |
| `0x40` | JMP addr8         | 2   | —      | —      | —            | —           | —     | `0000` | —     | tb          |
| `0x41` | JZ addr8          | 2   | —      | —      | —            | —           | —     | `0000` | —     | cond Z = 1  |
| `0x42` | JNZ addr8         | 2   | —      | —      | —            | —           | —     | `0000` | —     | cond Z = 0  |
| `0x43` | JC addr8          | 2   | —      | —      | —            | —           | —     | `0000` | —     | cond C = 1  |
| `0x44` | JNC addr8         | 2   | —      | —      | —            | —           | —     | `0000` | —     | cond C = 0  |
| `0x45` | CALL addr8        | 2   | —      | —      | —            | write `SP`  | PC+2  | `0000` | push  | tb          |
| `0x46` | RET               | 1   | —      | —      | —            | read `SP+1` | —     | `0000` | pop   | mem         |
| `0x50` | PUSH Rs           | 2   | a      | —      | —            | write `SP`  | A     | `0000` | push  | seq         |
| `0x51` | POP Rd            | 2   | a      | —      | 1 / rdata    | read `SP+1` | —     | `0000` | pop   | seq         |

The two operand orders that differ from assembly order fall out of this table. `STORE [addr8], Rs` carries Rs in field a, so its write data is port A. `STORE [Rp], Rs` carries the pointer in field a and Rs in field b, so the address is port A and the write data is port B.

**Register-byte validation.** For `fields = a`, the byte is malformed when `rb[7]` is set (register 8–15) or when `rb[3:0] != 4'h0`. For `fields = ab`, it is malformed when `rb[7]` or `rb[3]` is set. A malformed byte raises `MALFORMED_OPERAND`. Field a is reported before field b, but both give the same fault code, so the order matters only for the emulator's message text.

### Datapath multiplexers

| Mux            | Inputs                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------ |
| RAM address    | `PC` (fetch opcode), `PC+1`, `PC+2` (operand bytes), `IR.tb`, `ra_data`, `rb_data`, `SP`, `SP+1` |
| RAM write data | `ra_data`, `rb_data`, `PC+2` (CALL's return address; CALL is 2 bytes)                            |
| Register write | `alu_r`, `IR.tb`, `ram_rdata`, `rb_data`                                                         |
| Next PC        | `PC + len` (8-bit, plus a 9th bit for overflow detection), `IR.tb`, `ram_rdata`, `PC` (hold)     |

## Control FSM (`control_fsm`)

Instructions are 1, 2 or 3 bytes long, and the RAM has one port with one cycle of read latency. A multi-cycle FSM is therefore the natural first design:

```
            ┌────────────────────────────────────────────────────────────────┐
            ▼                                                                │
 rst ─▶ FETCH ─▶ DECODE ─┬─(len = 1)──────────────────▶ EXECUTE ─▶ WRITEBACK ┘
                         └─▶ OPERANDS ─(len = 3)─▶ OPERANDS ─┘   │        │
                               │                                 │        ├─▶ HALTED  (HLT)
                               └── any fault ────────────────────┴────────┴─▶ FAULTED
```

| State     | Does                                                                                                                                                                                                                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FETCH     | Drive `ram_addr = PC`.                                                                                                                                                                                                                                                                                                                       |
| DECODE    | Latch `IR.op ← ram_rdata`. If `!valid`: fault `INVALID_OPCODE`. Else if `{1'b0,PC} + len > 9'h100`: fault `INSTRUCTION_OVERRUN`, without fetching any operand byte. Else, if `len > 1`, drive `ram_addr = PC+1`.                                                                                                                             |
| OPERANDS  | Latch byte 1: into `IR.rb` for register formats, or into `IR.tb` for the A format. For `len = 3`, drive `ram_addr = PC+2` and stay one more cycle to latch `IR.tb`. Then validate the register byte and fault `MALFORMED_OPERAND` if it is bad.                                                                                              |
| EXECUTE   | Compute `seq = {1'b0,PC} + len`. Check, in order: CALL with `seq == 9'h100` → `PC_OVERFLOW` (precise); DIV with `rb_data == 0` → `DIVIDE_BY_ZERO`; PUSH or CALL with `SD == 64` → `STACK_OVERFLOW`; POP or RET with `SD == 0` → `STACK_UNDERFLOW`. Drive the ALU. For LOAD, POP and RET, drive the read address (`tb`, `rb_data` or `SP+1`). |
| WRITEBACK | The single commit point. Write the register (data from the ALU, `IR.tb`, `rb_data` or `ram_rdata`, which now holds the EXECUTE read), the RAM (`we`), FLAGS through the mask, and SP/SD. Then set the next PC (see below), increment `instret` and pulse `retire`.                                                                           |
| HALTED    | Terminal until reset. Entered from WRITEBACK of HLT; PC stays at the HLT.                                                                                                                                                                                                                                                                    |
| FAULTED   | Terminal until reset. `fault_code` and `fault_pc` hold the fault.                                                                                                                                                                                                                                                                            |

**PC update in WRITEBACK.**

- HLT: PC is unchanged and status ← HALTED.
- JMP, CALL, or a branch whose condition holds: PC ← `IR.tb`.
- RET: PC ← `ram_rdata`.
- Otherwise, if `seq == 9'h100`: PC is unchanged, status ← FAULTED, `fault_code = PC_OVERFLOW`. This is the **post-commit** fault: the register, memory and flag writes of the same WRITEBACK still happen, and the instruction is retired.
- Otherwise: PC ← `seq[7:0]`.

### Faults, halt and priority

All faults except the post-commit `PC_OVERFLOW` are **precise**. They are detected in DECODE, OPERANDS or EXECUTE, before the WRITEBACK edge, so the FSM goes straight to FAULTED and never asserts a write enable. Because PC, SP, SD, FLAGS, the register file and the RAM are only written in WRITEBACK, precision comes from the structure of the FSM. No undo logic is needed.

Priority follows the order in which the FSM discovers the faults, which is also the emulator's order (see [cpu-execution.md](cpu-execution.md#fault-priority)):

1. `INVALID_OPCODE` (DECODE)
2. `INSTRUCTION_OVERRUN` (DECODE, before any operand byte is read, so no address past `0xFF` is ever driven)
3. `MALFORMED_OPERAND` (OPERANDS)
4. `PC_OVERFLOW` for a CALL at `0xFE` (EXECUTE, precise)
5. `DIVIDE_BY_ZERO`, `STACK_OVERFLOW` or `STACK_UNDERFLOW` (EXECUTE; at most one can apply)
6. `PC_OVERFLOW`, sequential (WRITEBACK, post-commit)

| Fault                 | Number | Kind        | Fixtures                                                                      |
| --------------------- | ------ | ----------- | ----------------------------------------------------------------------------- |
| no fault              | 0      | —           | —                                                                             |
| `INVALID_OPCODE`      | 1      | precise     | `fault-invalid-opcode`, `fault-invalid-opcode-at-ff`                          |
| `MALFORMED_OPERAND`   | 2      | precise     | `fault-malformed-register`, `-unused-field`, `-field-b`                       |
| `INSTRUCTION_OVERRUN` | 3      | precise     | `fault-instruction-overrun-at-fe`, `-at-ff`, `fault-overrun-before-malformed` |
| `PC_OVERFLOW`         | 4      | post-commit | `fault-pc-overflow-nop`, `-inc`, `-branch-not-taken`                          |
| `PC_OVERFLOW`         | 4      | precise     | `fault-pc-overflow-call`                                                      |
| `DIVIDE_BY_ZERO`      | 5      | precise     | `fault-divide-by-zero`                                                        |
| `STACK_OVERFLOW`      | 6      | precise     | `fault-stack-overflow`, `fault-stack-overflow-call`                           |
| `STACK_UNDERFLOW`     | 7      | precise     | `fault-stack-underflow-pop`, `fault-stack-underflow-ret`                      |

The numbers are `FAULT_CODE_NUMBERS` in `@vcpu/shared`, and a fixture's `expected.fault.number` uses them. A HLT at `0xFF` is legal (`op-hlt-at-ff`), and so is a taken jump at `0xFE` (`op-jmp-at-fe`).

### Per-instruction state sequence

With the FSM above, each instruction goes through these states:

| Class                                                          | States                                         | Clocks |
| -------------------------------------------------------------- | ---------------------------------------------- | ------ |
| NOP, HLT, RET                                                  | FETCH, DECODE, EXECUTE, WRITEBACK              | 4      |
| 2-byte: MOV, ALU, LOAD/STORE `[Rp]`, PUSH, POP, JMP, Jcc, CALL | FETCH, DECODE, OPERANDS, EXECUTE, WRITEBACK    | 5      |
| 3-byte: LDI, LOAD/STORE `[addr8]`                              | FETCH, DECODE, OPERANDS ×2, EXECUTE, WRITEBACK | 6      |
| DIV with a 1-bit-per-clock divider                             | as 2-byte, with EXECUTE lasting 8 clocks       | 12     |

Data reads (LOAD, POP, RET) are issued in EXECUTE and consumed in WRITEBACK, so they need no extra state with a one-cycle RAM. The WRITEBACK of one instruction can overlap the FETCH of the next once the basic design passes every fixture. That is an optimisation, not a requirement.

## Memory (`ram256x8`)

Memory is a 256 × 8 synchronous single-port RAM that holds code, data and the stack. It has an 8-bit address and a registered read (data appears the cycle after the address). Every 8-bit address is valid, so LOAD and STORE never fault on their address, and the regions in [memory-model.md](memory-model.md) are conventions with no protection logic. It infers block RAM on an FPGA:

```systemverilog
module ram256x8 (
  input  logic       clk, we,
  input  logic [7:0] addr, wdata,
  output logic [7:0] rdata
);
  logic [7:0] mem [256];
  always_ff @(posedge clk) begin
    if (we) mem[addr] <= wdata;
    rdata <= mem[addr];
  end
endmodule
```

Fetches and data accesses share the port, so a write never coincides with a fetch. Because the PC, operand addresses and the stack never wrap, no access ever needs an address past `0xFF`.

## Reset

`rst` is synchronous and active-high, and it is applied for at least one clock. It sets:

- R0–R7 = `8'h00`, PC = `8'h00`, SP = `8'hFF`, SD = 0, FLAGS = `4'h0`
- IR = 0, `instret` = 0, `fault_code` = 0, `fault_pc` = 0
- status = RUN (READY), and the FSM state = FETCH

Reset does **not** clear the RAM. The emulator's `reset()` restores the image captured by the last `loadProgram()`. The RTL equivalent is for the testbench to load the image with `$readmemh` before it releases reset. Every fixture starts from this reset state (`initial.registers` is all zeros, and so on), so no backdoor register loading is needed.

## Instructional timing vs real cycles

The emulator reports **estimated cycles** from the instructional timing model in [instruction-set.md](instruction-set.md#timing-model). Each instruction costs 1 cycle per instruction byte, plus 1 for execute, plus 1 per data access, plus extra for MUL and DIV, plus 1 when control transfers. That model is meant for teaching and benchmarking. It does not describe this FSM or any other circuit.

| Instruction    | Model (`baseCycles` + taken) | Reference FSM clocks | Why they differ                                               |
| -------------- | ---------------------------- | -------------------- | ------------------------------------------------------------- |
| NOP, HLT       | 2                            | 4                    | the FSM spends separate clocks on DECODE and WRITEBACK        |
| ADD … CMP, MOV | 3                            | 5                    | same                                                          |
| LDI            | 4                            | 6                    | same                                                          |
| LOAD/STORE abs | 5                            | 6                    | the data access overlaps WRITEBACK                            |
| MUL            | 6                            | 5                    | a single-cycle combinational multiplier needs no extra clocks |
| DIV            | 10                           | 12                   | an 8-iteration divider                                        |
| JMP, taken Jcc | 3 + 1                        | 5                    | no pipeline, so there is no taken-branch penalty              |
| CALL           | 4 + 1                        | 5                    | the push happens in WRITEBACK                                 |
| RET            | 3 + 1                        | 4                    | the pop read is issued in EXECUTE                             |

Other known differences between emulator steps and RTL cycles:

- **One step is one instruction.** `step()` is atomic. The trace has one line per instruction and none per clock. Compare at `retire` (and at the fault), never per clock.
- **Precise faults are steps, not retirements.** The emulator counts a precisely faulting step as a step (it is a trace line and counts toward `maxInstructions`) but not as a retired instruction. The RTL should do the same: no `retire` pulse, and `instret` unchanged.
- **The post-commit `PC_OVERFLOW` is a retirement.** It pulses `retire` and increments `instret`, then enters FAULTED.
- **Metrics are not hardware state.** Estimated cycles, branch counts and memory-access counts exist only in the emulator. Only `instret` has a hardware counterpart.
- **IR is not compared.** The trace's `ir` field shows what the emulator fetched. A design that prefetches will see different bus activity, and that is allowed.

## Using the fixtures in a testbench

`pnpm fixtures:export` writes `fixtures/v1/`. Every fixture `<name>` has four files. [fixtures/README.md](../fixtures/README.md) describes the format in full.

| File                  | Use in the testbench                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `<name>.mem.hex`      | `$readmemh` into the RAM before releasing reset                                                |
| `<name>.expected.hex` | `$readmemh` into a reference array, then compare the RAM to it after the run                   |
| `<name>.json`         | `maxInstructions`, the expected status, fault, registers, PC, SP, SD, FLAGS and `instructions` |
| `<name>.trace.jsonl`  | Lock-step: one line per step to compare at each `retire` or fault                              |

The `.hex` files have exactly 256 lines, one byte per line as two uppercase hex digits, with address 0 first. That is the plain `$readmemh` format, with no `@address` records and no comments.

### End-state test

The per-fixture scalars (`maxInstructions` and the `expected` registers) are easiest to pass in from a small script that reads `<name>.json`, for example with `+plusargs`, a generated `.svh` per fixture, or cocotb. The test itself is:

```systemverilog
// tb_vcpu8.sv: run one fixture to completion and compare the end state.
string name;  int unsigned max_steps;  logic [7:0] expected_mem [256];
initial begin
  void'($value$plusargs("FIXTURE=%s", name));
  void'($value$plusargs("MAX=%d", max_steps));
  $readmemh({"fixtures/v1/", name, ".mem.hex"},      dut.u_ram.mem);
  $readmemh({"fixtures/v1/", name, ".expected.hex"}, expected_mem);
  rst = 1; @(posedge clk); rst = 0;

  // A step is a retirement or a fault; stop at HALTED/FAULTED or after MAX steps.
  for (int steps = 0; steps < max_steps && dut.status == STATUS_READY; ) begin
    @(posedge clk);
    if (dut.retire || dut.status == STATUS_FAULTED) steps++;
  end
  if (dut.status == STATUS_READY) $fatal(1, "%s: still running after %0d steps", name, max_steps);

  foreach (expected_mem[a])
    if (dut.u_ram.mem[a] !== expected_mem[a])
      $error("%s: mem[%02h] = %02h, expected %02h", name, a, dut.u_ram.mem[a], expected_mem[a]);
  // …then compare dut.status, fault_code, fault_pc, R0–R7, PC, SP, SD, FLAGS and instret
  // with expected.{status, fault.number, fault.pc, registers, pc, sp, sd, flags, instructions}.
end
```

Compare the memory element by element, as above. Do not diff a `$writememh` dump against the `.expected.hex` file, because simulators differ in letter case and in whether they write address comments.

### Lock-step trace comparison

For debugging, compare after every step rather than only at the end. Each line of `<name>.trace.jsonl` is the state **after** step `n`:

```text
{"step":2,"pc":6,"ir":[69,11],"status":"READY","fault":null,"regs":[1,0,0,0,0,0,0,0],"flags":0,"sp":253,"sd":2,"nextPc":11,"memWrites":[{"address":254,"value":8}]}
```

At each `retire` pulse, or on entering FAULTED, take the next line and check:

- the instruction address: the PC at the instruction's FETCH equals `pc`
- after WRITEBACK: R0–R7 equal `regs`, and FLAGS, SP, SD and PC equal `flags`, `sp`, `sd` and `nextPc`
- the RAM writes during the instruction equal `memWrites`, in order
- the status equals `status`, and the fault code (if any) equals `fault`

A precise fault is the last line. Its state equals the line before it, and its `status` is `FAULTED`. Parsing JSON in SystemVerilog is awkward, so either drive the comparison from cocotb or a DPI-C helper, or convert each `.trace.jsonl` into a flat `$readmemh` vector file with a small script. The first mismatching step points straight at the instruction, and its `pc` and `ir` identify which decoder row or ALU equation is wrong.

### Suggested bring-up order

1. `op-nop`, `op-hlt`, `op-ldi-all-registers`: fetch, decode, the register write and the halt path.
2. `op-add*`, `op-sub*`, `op-cmp*`, `op-inc*`, `op-dec*`, logic and shifts: the ALU and the flag mask.
3. `op-load-*`, `op-store-*`, `op-mov`: the memory and write-back muxes.
4. `op-jmp*`, `op-jz` … `op-jnc`, `op-call-ret`, `op-push-*`: the PC mux and the stack.
5. `fault-*`: the fault detection, the priority order and the post-commit `PC_OVERFLOW`.
6. `example-*`: whole programs, 4 to 85 instructions each.

All 98 fixtures should then pass. The drift test (`packages/cpu-core/src/__tests__/fixtures.drift.test.ts`) guarantees that the emulator still produces every committed fixture, so a mismatch is a bug in the RTL, or in the emulator and this document together. It is never a stale fixture.

## ISA version freeze policy

- **ISA 1.0.0 is frozen.** `fixtures/v1/` is the contract between Project 1 and Project 2.
- **Any change to the ISA bumps `ISA_VERSION`.** That includes an encoding, length, flag rule, fault rule or priority, reset value or the timing model. The change also gets an entry under [Design decisions](instruction-set.md#design-decisions), and the fixtures are regenerated into a **new folder** (for example `fixtures/v2/`, with the exporter's output folder and the drift test's glob moved to match). `fixtures/v1/` is then left unchanged for RTL built against 1.0.0.
- **The fixture format is versioned separately.** A change to the JSON shape changes the `format` string (`vcpu8-fixture/2`) and `FixtureSchemaV1` gets a successor. A change to the ISA alone does not.
- **Drift is caught in CI.** If cpu-core's behaviour changes without a version bump, the drift test fails, because every committed fixture is run again and compared field by field.
