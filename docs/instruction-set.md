# Instruction Set

This document specifies **VCPU-8 ISA version 1.0.0**: instruction formats, encodings, the opcode map, the exact semantics and flag rules of every instruction, the timing model and the assembly syntax.

The authoritative definition is the opcode table in `@vcpu/shared` (`packages/shared/src/isa/opcodes.ts`). The emulator, assembler, disassembler, debugger and hardware fixtures all import that table, and no other package re-declares an opcode number. A test (`docs-sync.test.ts`) renders the opcode map below from the code and fails if this document drifts from it.

Related documents: [architecture.md](architecture.md) (registers, FLAGS, block diagram), [memory-model.md](memory-model.md) (memory map, stack) and [cpu-execution.md](cpu-execution.md) (the execution cycle, faults, reset).

## Conventions

- All values are 8-bit unsigned bytes unless stated otherwise. `0x2A` is hexadecimal, `0b101010` is binary.
- `Rd` is the destination register. For ALU instructions it is also the first source operand. `Rs` is a source register, `Rp` is a register that holds a data address, and `Ra`/`Rb` are the two operands of `CMP`.
- `imm8` is an 8-bit immediate. `addr8` is an 8-bit absolute address, and `[addr8]` means "the memory byte at `addr8`".
- `mem[x]` is the memory byte at address `x`. `a[7]` is bit 7 (the most significant bit) of `a`, and `a[0]` is bit 0.
- `x mod 256` is the mathematical remainder, always in `0..255`.
- In pseudocode, `a` is the value of the first operand before the instruction executes, `b` is the value of the second operand, and `r` is the 8-bit result.

## Instruction formats

An instruction is 1, 2 or 3 bytes long. Byte 0 is always the opcode. The opcode alone determines the format, and the format determines the length.

| Format | Bytes | Layout                     | Used by                                               |
| ------ | ----- | -------------------------- | ----------------------------------------------------- |
| N      | 1     | `[op]`                     | NOP, HLT, RET                                         |
| R      | 2     | `[op] [rrrr 0000]`         | INC, DEC, NOT, SHL, SHR, PUSH, POP                    |
| RR     | 2     | `[op] [aaaa bbbb]`         | MOV, LOAD [Rp], STORE [Rp], ADD … DIV, AND … XOR, CMP |
| RI     | 3     | `[op] [rrrr 0000] [imm8]`  | LDI                                                   |
| RA     | 3     | `[op] [rrrr 0000] [addr8]` | LOAD [addr8], STORE [addr8]                           |
| A      | 2     | `[op] [addr8]`             | JMP, JZ, JNZ, JC, JNC, CALL                           |

### The register byte

Formats R, RR, RI and RA carry a **register byte** at offset 1.

- Bits 7–4 hold field **a**, and bits 3–0 hold field **b**.
- A used field holds a register number 0–7. A value of 8–15 in a used field is a `MALFORMED_OPERAND` fault.
- Formats R, RI and RA use only field a. Their field b is unused and must be `0000`. Any other value is a `MALFORMED_OPERAND` fault.
- Field a is checked before field b, so a byte with both fields bad reports field a.

Of the 256 possible register bytes, 64 are valid for RR (`0x00`–`0x77` with both nibbles ≤ 7), and 8 are valid for R/RI/RA (`0x00`, `0x10`, … `0x70`).

`encodeRegisterByte(a, b)` and `decodeRegisterByte(byte, fieldsUsed)` in `@vcpu/shared` implement these rules. Decoding never throws on a malformed byte: it returns a typed error that the CPU turns into `MALFORMED_OPERAND`.

### Operand order versus encoding order

Assembly operands are written destination first, as in `LDI R0, 10`. Two instructions encode their operands in a different order from the one they are written in:

- `STORE [addr8], Rs` puts `Rs` in field a and the address in the trailing byte.
- `STORE [Rp], Rs` puts the pointer `Rp` in field a and `Rs` in field b.

Each operand's field (`a`, `b` or the trailing `byte`) is listed in the `operands` of its opcode-table row, so the assembler and the disassembler are driven by the table rather than by special cases.

## Addressing modes

| Mode              | Syntax    | Meaning                                                   | Used by             |
| ----------------- | --------- | --------------------------------------------------------- | ------------------- |
| Register          | `Rn`      | The value in register Rn                                  | ALU, MOV, PUSH, POP |
| Immediate         | `imm8`    | The byte encoded in the instruction                       | LDI                 |
| Absolute          | `[addr8]` | The memory byte at the address encoded in the instruction | LOAD, STORE         |
| Register-indirect | `[Rp]`    | The memory byte at the address held in register Rp        | LOAD, STORE         |
| Absolute target   | `addr8`   | A code address, the new PC                                | JMP, Jcc, CALL      |

Every 8-bit value is a valid address, because memory is exactly 256 bytes. Data addresses therefore never fault.

## Opcode map

Columns: **Bytes** is the encoded length. **Encoding** is the byte template: two hex digits are the opcode, `d`/`s`/`p`/`a`/`b` are the 4-bit register fields (`d` = Rd, `s` = Rs, `p` = Rp, `a` = Ra, `b` = Rb), `0` is a nibble that must be zero, `ii` is the immediate byte and `mm` is the address byte. **Z C N V** give each flag's effect: `Δ` = computed from the result, `0` = cleared, `–` = unchanged. **Cycles** is the estimated cost without a control transfer, and **Taken** is the penalty added when control transfers (see [Timing model](#timing-model)).

<!-- opcode-map:start -->

| Opcode | Mnemonic | Syntax            | Format | Bytes | Encoding | Z   | C   | N   | V   | Cycles | Taken |
| ------ | -------- | ----------------- | ------ | ----- | -------- | --- | --- | --- | --- | ------ | ----- |
| 0x00   | NOP      | NOP               | N      | 1     | 00       | –   | –   | –   | –   | 2      | –     |
| 0x01   | HLT      | HLT               | N      | 1     | 01       | –   | –   | –   | –   | 2      | –     |
| 0x10   | MOV      | MOV Rd, Rs        | RR     | 2     | 10 ds    | –   | –   | –   | –   | 3      | –     |
| 0x11   | LDI      | LDI Rd, imm8      | RI     | 3     | 11 d0 ii | –   | –   | –   | –   | 4      | –     |
| 0x12   | LOAD     | LOAD Rd, [addr8]  | RA     | 3     | 12 d0 mm | –   | –   | –   | –   | 5      | –     |
| 0x13   | LOAD     | LOAD Rd, [Rp]     | RR     | 2     | 13 dp    | –   | –   | –   | –   | 4      | –     |
| 0x14   | STORE    | STORE [addr8], Rs | RA     | 3     | 14 s0 mm | –   | –   | –   | –   | 5      | –     |
| 0x15   | STORE    | STORE [Rp], Rs    | RR     | 2     | 15 ps    | –   | –   | –   | –   | 4      | –     |
| 0x20   | ADD      | ADD Rd, Rs        | RR     | 2     | 20 ds    | Δ   | Δ   | Δ   | Δ   | 3      | –     |
| 0x21   | SUB      | SUB Rd, Rs        | RR     | 2     | 21 ds    | Δ   | Δ   | Δ   | Δ   | 3      | –     |
| 0x22   | MUL      | MUL Rd, Rs        | RR     | 2     | 22 ds    | Δ   | Δ   | Δ   | Δ   | 6      | –     |
| 0x23   | DIV      | DIV Rd, Rs        | RR     | 2     | 23 ds    | Δ   | 0   | Δ   | 0   | 10     | –     |
| 0x24   | INC      | INC Rd            | R      | 2     | 24 d0    | Δ   | –   | Δ   | Δ   | 3      | –     |
| 0x25   | DEC      | DEC Rd            | R      | 2     | 25 d0    | Δ   | –   | Δ   | Δ   | 3      | –     |
| 0x30   | AND      | AND Rd, Rs        | RR     | 2     | 30 ds    | Δ   | 0   | Δ   | 0   | 3      | –     |
| 0x31   | OR       | OR Rd, Rs         | RR     | 2     | 31 ds    | Δ   | 0   | Δ   | 0   | 3      | –     |
| 0x32   | XOR      | XOR Rd, Rs        | RR     | 2     | 32 ds    | Δ   | 0   | Δ   | 0   | 3      | –     |
| 0x33   | NOT      | NOT Rd            | R      | 2     | 33 d0    | Δ   | 0   | Δ   | 0   | 3      | –     |
| 0x34   | SHL      | SHL Rd            | R      | 2     | 34 d0    | Δ   | Δ   | Δ   | 0   | 3      | –     |
| 0x35   | SHR      | SHR Rd            | R      | 2     | 35 d0    | Δ   | Δ   | Δ   | 0   | 3      | –     |
| 0x36   | CMP      | CMP Ra, Rb        | RR     | 2     | 36 ab    | Δ   | Δ   | Δ   | Δ   | 3      | –     |
| 0x40   | JMP      | JMP addr8         | A      | 2     | 40 mm    | –   | –   | –   | –   | 3      | +1    |
| 0x41   | JZ       | JZ addr8          | A      | 2     | 41 mm    | –   | –   | –   | –   | 3      | +1    |
| 0x42   | JNZ      | JNZ addr8         | A      | 2     | 42 mm    | –   | –   | –   | –   | 3      | +1    |
| 0x43   | JC       | JC addr8          | A      | 2     | 43 mm    | –   | –   | –   | –   | 3      | +1    |
| 0x44   | JNC      | JNC addr8         | A      | 2     | 44 mm    | –   | –   | –   | –   | 3      | +1    |
| 0x45   | CALL     | CALL addr8        | A      | 2     | 45 mm    | –   | –   | –   | –   | 4      | +1    |
| 0x46   | RET      | RET               | N      | 1     | 46       | –   | –   | –   | –   | 3      | +1    |
| 0x50   | PUSH     | PUSH Rs           | R      | 2     | 50 s0    | –   | –   | –   | –   | 4      | –     |
| 0x51   | POP      | POP Rd            | R      | 2     | 51 d0    | –   | –   | –   | –   | 4      | –     |

<!-- opcode-map:end -->

**Every other opcode byte is invalid.** The 226 bytes not listed above (`0x02`–`0x0F`, `0x16`–`0x1F`, `0x26`–`0x2F`, `0x37`–`0x3F`, `0x47`–`0x4F` and `0x52`–`0xFF`) cause an `INVALID_OPCODE` fault. Opcodes are grouped by their high nibble: `0x0_` system, `0x1_` data movement, `0x2_` arithmetic, `0x3_` logic and compare, `0x4_` control flow, `0x5_` stack.

### Encoding examples

| Assembly           | Bytes      |
| ------------------ | ---------- |
| `NOP`              | `00`       |
| `LDI R0, 10`       | `11 00 0A` |
| `LDI R3, -1`       | `11 30 FF` |
| `MOV R2, R5`       | `10 25`    |
| `LOAD R1, [0x80]`  | `12 10 80` |
| `LOAD R1, [R2]`    | `13 12`    |
| `STORE [0x81], R4` | `14 40 81` |
| `STORE [R2], R1`   | `15 21`    |
| `ADD R0, R1`       | `20 01`    |
| `INC R7`           | `24 70`    |
| `CMP R0, R1`       | `36 01`    |
| `JNZ 0x04`         | `42 04`    |
| `CALL 0x40`        | `45 40`    |
| `PUSH R6`          | `50 60`    |

The program `LDI R0, 10 / LDI R1, 20 / ADD R0, R1 / HLT` assembles to `11 00 0A 11 10 14 20 01 01` and leaves R0 = 30 (`0x1E`).

## Flags

FLAGS is an 8-bit register. Only bits 3–0 exist, and bits 7–4 always read 0:

```
bit:   7   6   5   4   3   2   1   0
      [0] [0] [0] [0] [Z] [C] [N] [V]
```

| Flag | Bit | Mask   | Meaning                                                                                                   |
| ---- | --- | ------ | --------------------------------------------------------------------------------------------------------- |
| Z    | 3   | `0x08` | Zero: the result is `0x00`                                                                                |
| C    | 2   | `0x04` | Carry: unsigned carry out of ADD, **borrow** out of SUB/CMP, high byte of MUL, bit shifted out by SHL/SHR |
| N    | 1   | `0x02` | Negative: bit 7 of the result (the sign bit in two's complement)                                          |
| V    | 0   | `0x01` | Signed overflow: the two's-complement result is wrong for the operands                                    |

The CPU has no signed or unsigned modes. Every instruction computes the same bits, and only the meaning a program gives the flags differs: C reports unsigned overflow and V reports signed overflow.

### Exact flag rules

`a` and `b` are the operand values before execution, and `r` is the 8-bit result. "Z, N from r" means `Z = (r == 0)` and `N = r[7]`. A flag not mentioned is unchanged.

| Instruction | Result                       | Z         | C                | N                 | V                               |
| ----------- | ---------------------------- | --------- | ---------------- | ----------------- | ------------------------------- |
| ADD         | `r = (a + b) mod 256`        | `r == 0`  | `a + b > 0xFF`   | `r[7]`            | `a[7] == b[7] and r[7] != a[7]` |
| SUB         | `r = (a − b) mod 256`        | `r == 0`  | `a < b` (borrow) | `r[7]`            | `a[7] != b[7] and r[7] != a[7]` |
| CMP         | as SUB; `r` is discarded     | `r == 0`  | `a < b` (borrow) | `r[7]`            | `a[7] != b[7] and r[7] != a[7]` |
| MUL         | `p = a × b`, `r = p mod 256` | `r == 0`  | `p > 0xFF`       | `r[7]`            | `p > 0xFF` (same as C)          |
| DIV         | `r = floor(a ÷ b)`, `b ≠ 0`  | `r == 0`  | 0                | `r[7]`            | 0                               |
| INC         | `r = (a + 1) mod 256`        | `r == 0`  | unchanged        | `r[7]`            | `a == 0x7F`                     |
| DEC         | `r = (a − 1) mod 256`        | `r == 0`  | unchanged        | `r[7]`            | `a == 0x80`                     |
| AND         | `r = a AND b`                | `r == 0`  | 0                | `r[7]`            | 0                               |
| OR          | `r = a OR b`                 | `r == 0`  | 0                | `r[7]`            | 0                               |
| XOR         | `r = a XOR b`                | `r == 0`  | 0                | `r[7]`            | 0                               |
| NOT         | `r = 0xFF XOR a`             | `r == 0`  | 0                | `r[7]`            | 0                               |
| SHL         | `r = (a × 2) mod 256`        | `r == 0`  | `a[7]`           | `r[7]`            | 0                               |
| SHR         | `r = floor(a ÷ 2)`           | `r == 0`  | `a[0]`           | `r[7]` (always 0) | 0                               |
| all others  | —                            | unchanged | unchanged        | unchanged         | unchanged                       |

Instructions that leave **all** flags unchanged: NOP, HLT, MOV, LDI, LOAD, STORE, JMP, JZ, JNZ, JC, JNC, CALL, RET, PUSH, POP. Loading a zero with LDI, LOAD or POP does **not** set Z.

Worked examples:

| Instruction (a, b)   | r      | Z   | C   | N   | V   | Why                                          |
| -------------------- | ------ | --- | --- | --- | --- | -------------------------------------------- |
| ADD (`0xFF`, `0x01`) | `0x00` | 1   | 1   | 0   | 0   | unsigned wrap; −1 + 1 = 0 is signed-correct  |
| ADD (`0x7F`, `0x01`) | `0x80` | 0   | 0   | 1   | 1   | 127 + 1 overflows signed                     |
| ADD (`0x80`, `0x80`) | `0x00` | 1   | 1   | 0   | 1   | −128 + −128 overflows both ways              |
| SUB (`0x00`, `0x01`) | `0xFF` | 0   | 1   | 1   | 0   | borrow; 0 − 1 = −1 is signed-correct         |
| SUB (`0x80`, `0x01`) | `0x7F` | 0   | 0   | 0   | 1   | −128 − 1 overflows signed                    |
| CMP (`0x05`, `0x05`) | —      | 1   | 0   | 0   | 0   | equal                                        |
| MUL (`0x10`, `0x10`) | `0x00` | 1   | 1   | 0   | 1   | 256 does not fit; the low byte is 0          |
| DIV (`0xFF`, `0x01`) | `0xFF` | 0   | 0   | 1   | 0   | N reflects bit 7 even though DIV is unsigned |
| INC (`0xFF`)         | `0x00` | 1   | –   | 0   | 0   | C is not touched by INC                      |
| DEC (`0x80`)         | `0x7F` | 0   | –   | 0   | 1   | −128 − 1 overflows signed                    |
| SHL (`0x81`)         | `0x02` | 0   | 1   | 0   | 0   | bit 7 shifted into C                         |

### Comparing and branching

`CMP Ra, Rb` sets the flags exactly as `SUB Ra, Rb` would, without writing Ra. Afterwards:

| Relation (unsigned) | Test  | Branch |
| ------------------- | ----- | ------ |
| Ra == Rb            | Z = 1 | `JZ`   |
| Ra != Rb            | Z = 0 | `JNZ`  |
| Ra < Rb             | C = 1 | `JC`   |
| Ra >= Rb            | C = 0 | `JNC`  |

For signed operands, Ra < Rb exactly when N ≠ V. ISA v1.0 has no branch on N or V, and no instruction copies FLAGS into a register, so signed comparisons need a different approach. For example, `XOR` both operands with `0x80` first, which maps the signed order onto the unsigned order.

## Instruction reference

Each entry gives the encoding, the operation, the flags and any fault the instruction can raise **in addition to** the faults any instruction can raise:

- `INSTRUCTION_OVERRUN`: the instruction would extend past `0xFF`.
- `MALFORMED_OPERAND`: formats R, RR, RI and RA only.
- `PC_OVERFLOW`: a sequential next PC of `0x100`.

[cpu-execution.md](cpu-execution.md) gives the full fault model. `push` and `pop` are defined in [memory-model.md](memory-model.md#stack).

### System

- **NOP** (`00`, 1 byte, 2 cycles). Does nothing; PC ← PC + 1.
- **HLT** (`01`, 1 byte, 2 cycles). Status ← HALTED. PC is **not** advanced, so it keeps pointing at the `HLT`, and `HLT` at `0xFF` is legal. The instruction counts as executed. Later `step()`/`run()` calls do nothing until `reset()`.

### Data movement

- **MOV Rd, Rs** (`10 ds`, 2 bytes, 3 cycles). Rd ← Rs. `MOV Rn, Rn` is a legal no-op.
- **LDI Rd, imm8** (`11 d0 ii`, 3 bytes, 4 cycles). Rd ← imm8.
- **LOAD Rd, [addr8]** (`12 d0 mm`, 3 bytes, 5 cycles). Rd ← mem[addr8]. One data read.
- **LOAD Rd, [Rp]** (`13 dp`, 2 bytes, 4 cycles). Rd ← mem[Rp]. One data read. The address is the value of Rp before the instruction, so `LOAD R1, [R1]` is well defined.
- **STORE [addr8], Rs** (`14 s0 mm`, 3 bytes, 5 cycles). mem[addr8] ← Rs. One data write.
- **STORE [Rp], Rs** (`15 ps`, 2 bytes, 4 cycles). mem[Rp] ← Rs. One data write.

None of these change the flags. A STORE may write anywhere, including the program and the stack region (see [memory-model.md](memory-model.md)).

### Arithmetic

- **ADD Rd, Rs** (`20 ds`, 3 cycles). Rd ← (Rd + Rs) mod 256. Flags Z C N V.
- **SUB Rd, Rs** (`21 ds`, 3 cycles). Rd ← (Rd − Rs) mod 256. Flags Z C N V, with C = borrow.
- **MUL Rd, Rs** (`22 ds`, 6 cycles). Rd ← low byte of the unsigned product. Flags Z C N V, with C = V = (high byte ≠ 0).
- **DIV Rd, Rs** (`23 ds`, 10 cycles). Rd ← floor(Rd ÷ Rs), unsigned; the remainder is discarded. Flags Z N, with C and V cleared. **Fault:** Rs = 0 → `DIVIDE_BY_ZERO`. The fault is precise, so Rd and the flags are untouched.
- **INC Rd** (`24 d0`, 3 cycles). Rd ← (Rd + 1) mod 256. Flags Z N V; C is unchanged.
- **DEC Rd** (`25 d0`, 3 cycles). Rd ← (Rd − 1) mod 256. Flags Z N V; C is unchanged.

When Rd and Rs name the same register, both operands are its value before the instruction. For example, `ADD R0, R0` doubles R0 and `SUB R0, R0` clears it with Z = 1.

### Logic and compare

- **AND / OR / XOR Rd, Rs** (`30`/`31`/`32 ds`, 3 cycles). Bitwise. Flags Z N, with C and V cleared.
- **NOT Rd** (`33 d0`, 3 cycles). Rd ← 0xFF XOR Rd (one's complement). Flags Z N, with C and V cleared.
- **SHL Rd** (`34 d0`, 3 cycles). C ← Rd[7]; Rd ← (Rd × 2) mod 256. Flags Z C N, with V cleared.
- **SHR Rd** (`35 d0`, 3 cycles). C ← Rd[0]; Rd ← floor(Rd ÷ 2). This is a logical shift, so bit 7 becomes 0 and N is always 0. Flags Z C N, with V cleared.
- **CMP Ra, Rb** (`36 ab`, 3 cycles). Computes Ra − Rb for the flags only (Z C N V, as SUB). No register is written.

### Control flow

- **JMP addr8** (`40 mm`, 3 cycles + 1). PC ← addr8.
- **JZ / JNZ / JC / JNC addr8** (`41`–`44 mm`, 3 cycles, + 1 when taken). If the condition holds (Z = 1 / Z = 0 / C = 1 / C = 0), PC ← addr8; otherwise PC ← PC + 2.
- **CALL addr8** (`45 mm`, 4 cycles + 1). push(PC + 2), then PC ← addr8. One data write. **Faults:** SD = 64 → `STACK_OVERFLOW`; a return address of `0x100` (CALL at `0xFE`) → `PC_OVERFLOW`, precise, with nothing pushed (Design decision D1).
- **RET** (`46`, 1 byte, 3 cycles + 1). PC ← pop(). One data read. **Fault:** SD = 0 → `STACK_UNDERFLOW`.

A jump target can be any address 0x00–0xFF, including one inside the data or stack region. Control flow never changes the flags.

### Stack

- **PUSH Rs** (`50 s0`, 4 cycles). push(Rs). One data write. **Fault:** SD = 64 → `STACK_OVERFLOW`.
- **POP Rd** (`51 d0`, 4 cycles). Rd ← pop(). One data read. **Fault:** SD = 0 → `STACK_UNDERFLOW`. Flags are unchanged.

## Timing model

VCPU-8 reports **estimated cycles** from an instructional timing model. These are not measured clock cycles from real hardware, and the dashboard and CLI label them as estimates. One instruction costs:

```
cycles = L                          1 cycle per fetched instruction byte
       + 1                          execute
       + 1 per data-memory access   LOAD, STORE, PUSH, POP, CALL, RET (instruction fetches excluded)
       + 3 extra for MUL, 7 extra for DIV
       + 1 when control transfers   JMP, CALL and RET always; JZ/JNZ/JC/JNC only when taken
```

The opcode table stores the first four terms as `baseCycles` and the last as `branchTakenPenalty`. `estimatedCycles(info, controlTransferred)` in `@vcpu/shared` adds them up. The constants live in `TIMING_MODEL`. A test checks every `baseCycles` value against the formula.

An instruction that faults precisely is not retired and adds no cycles. An instruction that raises the post-commit `PC_OVERFLOW` is retired, so its cycles are counted.

## Assembly syntax

The assembler ticket implements this syntax, and the disassembler emits it in canonical form: upper-case mnemonics, `R0`–`R7`, hex addresses `0x..`, and `, ` between operands.

- **Comments** start with `;` and run to the end of the line.
- **Case:** mnemonics, register names and directives are case-insensitive. Labels and `.equ` names are case-sensitive identifiers matching `[A-Za-z_][A-Za-z0-9_]*`. A name cannot be a mnemonic or look like a register (`R` followed by digits, in any case, so `R9` is rejected too); both are errors.
- **Labels:** `name:` on its own line or before an instruction. A label's value is the address of the next emitted byte.
- **Literals:** decimal `42` and `-5`, hex `0x2A`, binary `0b101010`, character `'A'` (printable ASCII, or one of the escapes `'\n'`, `'\t'`, `'\r'`, `'\0'`, `'\\'`, `'\''`). A `;` inside a character literal is not a comment.
- **Ranges:** immediates (`LDI`) and `.byte` values accept −128..255. Negative values are stored in two's complement, so `-1` becomes `0xFF`. Addresses (`[addr8]`, jump targets, `.org`) accept 0..255. A value out of range is an assembler error, never silently wrapped.
- **Operand forms:** `LDI R0, 10` · `MOV R1, R0` · `LOAD R1, [0x80]` · `LOAD R1, [R2]` · `STORE [OUT], R1` · `STORE [R2], R1` · `CMP R0, R1` · `JNZ loop` · `CALL sub` · `PUSH R3`. An address or immediate may be a literal, a label or a `.equ` name.
- **Directives:**
  - `.org addr` moves the output position forward, and the skipped bytes stay 0. Moving it backward, or overlapping output that was already emitted, is an error.
  - `.byte v[, v…]` emits raw bytes.
  - `.equ NAME, value` defines a constant in −128..255.
  - The values of `.org` and `.equ` are needed during the first pass, so they must be literals or symbols defined above them. Labels and constants used by instructions and `.byte` may be defined anywhere.
  - A backward `.org` is reported but still applied, so any instruction it makes overwrite earlier output is reported as an overlap too.
- **Errors** report the line and column, for example an unknown mnemonic, a bad register name, an operand form that does not match any variant of the mnemonic, an out-of-range value, an undefined or duplicate label, or a program that runs past `0xFF`. One run reports every error, in source order, e.g. `line 1, col 5: unknown register "R9" (valid: R0–R7)` and `line 1, col 9: immediate 300 out of range (valid: -128..255)` for `LDI R9, 300`.

`LOAD` and `STORE` have two opcodes each. The assembler picks the variant from the operand form: `[Rn]` selects the register-indirect variant, and any other bracketed operand selects the absolute one.

The disassembler (`disassemble` in `@vcpu/assembler`) is a linear sweep, and it never throws on any byte sequence. Immediates are printed in decimal and addresses in hex (or as a label name, when labels are given). A byte that cannot start an instruction is printed as `.byte 0xNN` and decoding resumes at the next byte: an invalid opcode, an opcode whose register byte breaks the format's rules, and an instruction that would run past the end of the decoded range. Its output reassembles to the same bytes.

## Design decisions

The ISA v1.0 proposal fixed the opcodes, formats, flag rules, stack, faults, reset state, timing model and assembly syntax. This section lists every place where the code and these documents deviate from it or make it more precise. Any future change needs an `ISA_VERSION` bump and an entry here.

- **D1 — CALL at `0xFE` faults with `PC_OVERFLOW` (defect fix).** The proposal defined CALL as `push(PC + 2)`. At `PC = 0xFE` the return address would be `0x100`, which does not fit in a byte. The proposal does not cover this case, and silently pushing `0x00` would make the address space wrap, which memory never does. CALL therefore raises a **precise** `PC_OVERFLOW` when PC + 2 = `0x100`: nothing is pushed and nothing changes. This is the only precise use of `PC_OVERFLOW`. The sequential fall-through case stays post-commit, as proposed.
- **D2 — Fault priority is explicit.** When an instruction meets several fault conditions, the first one in this order is reported: `INVALID_OPCODE` → `INSTRUCTION_OVERRUN` → `MALFORMED_OPERAND` (field a before field b) → `PC_OVERFLOW` (CALL return address) → `DIVIDE_BY_ZERO` / `STACK_OVERFLOW` / `STACK_UNDERFLOW`. At most one of the last three can apply to any instruction. The order matches the cycle steps of the proposal; the proposal did not state it.
- **D3 — "Taken" means control transferred.** The proposal charged +1 "when a jump/branch/call/return changes PC". This ISA charges it whenever the instruction transfers control: JMP, CALL and RET always, and a conditional branch when its condition holds. The penalty applies even when the target equals PC + L. This makes the cost depend only on the instruction and the flags, never on the target address.
- **D4 — Flags are listed in bit order (Z C N V).** The proposal wrote flags as "Z N C V". The code and these tables use FLAGS bit order (bit 3 → bit 0), and the semantics are unchanged.
- **D5 — Placeholder names.** The register-indirect pointer is written `[Rp]` (the proposal wrote `[Rs]` for LOAD and `[Ra]` for STORE), and the compare operands are written `Ra, Rb`. Only the notation changed; the encodings are as proposed.
- **D6 — Numeric fault and status codes (addition).** Hardware fixtures need numbers, not strings. `FAULT_CODE_NUMBERS` maps no fault = 0, `INVALID_OPCODE` = 1, `MALFORMED_OPERAND` = 2, `INSTRUCTION_OVERRUN` = 3, `PC_OVERFLOW` = 4, `DIVIDE_BY_ZERO` = 5, `STACK_OVERFLOW` = 6, `STACK_UNDERFLOW` = 7, which fits in 3 bits. `CPU_STATUS_NUMBERS` maps READY = 0, RUNNING = 1, PAUSED = 2, HALTED = 3, FAULTED = 4.
- **D7 — Metrics count retired instructions only.** A precisely faulting instruction adds nothing to the instruction count, cycles or memory-access counters. Data-memory access counts never include instruction fetches.
