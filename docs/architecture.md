# Architecture

VCPU-8 is an educational 8-bit CPU. This document gives its programmer's model and block structure for **ISA version 1.0.0**. Together with the three documents below, it specifies the machine precisely enough to reimplement it in SystemVerilog (Project 2) and get bit-identical results.

| Document                                 | Covers                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [instruction-set.md](instruction-set.md) | Formats, encodings, opcode map, per-instruction semantics and flags, timing, assembly syntax, design decisions |
| [memory-model.md](memory-model.md)       | Memory map, address rules, the stack and its depth counter, program images                                     |
| [cpu-execution.md](cpu-execution.md)     | The execution cycle, PC update, every fault, reset, statuses, metrics                                          |

## At a glance

| Property         | Value                                                                      |
| ---------------- | -------------------------------------------------------------------------- |
| Word size        | 8 bits; every register, address and memory cell is one byte                |
| Address space    | 256 bytes (`0x00`–`0xFF`), unified code and data (von Neumann)             |
| Registers        | R0–R7 general purpose; PC, SP, SD, FLAGS; IR (internal)                    |
| Flags            | Z (zero), C (carry/borrow), N (negative), V (signed overflow)              |
| Instructions     | 28 mnemonics, 30 opcodes, 1–3 bytes, 6 formats                             |
| Addressing modes | register, immediate, absolute, register-indirect                           |
| Stack            | 64 bytes at `0xC0`–`0xFF`, grows down, bounded by the depth counter SD     |
| Arithmetic       | 8-bit two's complement; results wrap modulo 256; flags report the overflow |
| Faults           | 7 fault codes; all precise except a post-commit PC overflow                |
| Interrupts, I/O  | none in v1.0; programs communicate through memory                          |

## Programmer's model

| Register | Width | Reset  | Visible to programs | Purpose                                                                |
| -------- | ----- | ------ | ------------------- | ---------------------------------------------------------------------- |
| R0–R7    | 8     | `0x00` | read/write          | General purpose; all eight are interchangeable                         |
| PC       | 8     | `0x00` | via jumps only      | Address of the next instruction                                        |
| SP       | 8     | `0xFF` | no (implicit)       | Address the next push writes                                           |
| SD       | 0–64  | `0`    | no (implicit)       | Stack depth: bytes currently pushed; detects overflow and underflow    |
| FLAGS    | 8     | `0x00` | via branches only   | `0000 ZCNV`; bits 7–4 always read 0                                    |
| IR       | —     | empty  | no                  | The instruction being executed (opcode, operand bytes, decoded fields) |

No instruction reads or writes PC, SP, SD or FLAGS as a value. Programs observe FLAGS only through conditional branches. SP and SD change only through PUSH, POP, CALL and RET, so `SP == 0xFF − SD` at all times.

### FLAGS

```
bit:   7   6   5   4   3   2   1   0
      [0] [0] [0] [0] [Z] [C] [N] [V]
mask:                 08  04  02  01
```

`FLAG_BITS`, `FLAG_MASKS`, `packFlags` and `unpackFlags` in `@vcpu/shared` define this layout. [instruction-set.md](instruction-set.md#flags) gives the exact rule each instruction uses for each flag.

### The stack depth counter (SD)

An 8-bit SP cannot tell a full stack from an empty one once it wraps. So VCPU-8 keeps a separate architectural **stack depth counter**, SD, which counts the bytes on the stack (0–64). A push at SD = 64 faults with `STACK_OVERFLOW`, and a pop at SD = 0 faults with `STACK_UNDERFLOW`. SP never wraps, because those checks happen first. SD is part of every snapshot and every hardware fixture. See [memory-model.md](memory-model.md#stack).

## Block diagram

```
                ┌──────────────────────────────────────────────────────────────┐
                │                         CONTROL UNIT                         │
                │  status FSM (READY/RUNNING/PAUSED/HALTED/FAULTED), fault reg  │
                │  decoder: opcode table lookup → format, length, operands,     │
                │           ALU op, flag-write mask, control-flow kind          │
                └──────┬──────────────┬──────────────┬───────────────┬─────────┘
                       │ control      │              │               │
                ┌──────▼─────┐  ┌─────▼──────┐  ┌────▼────┐   ┌──────▼──────┐
                │  PC (8)    │  │  IR        │  │ SP (8)  │   │ FLAGS (4)   │
                │  +L / tgt  │  │ op | reg | │  │ SD (7)  │   │  Z C N V    │
                └──────┬─────┘  │ imm/addr   │  └────┬────┘   └──────▲──────┘
                       │        └─────▲──────┘       │               │ flags
                       │ fetch addr   │ fetched      │ stack addr    │
                ┌──────▼──────────────┴──────────────▼──────┐  ┌─────┴──────┐
                │              ADDRESS MUX                  │  │    ALU     │
                │  PC+i (fetch) | addr8 | Rp | SP (stack)   │  │ ADD SUB MUL│
                └──────────────────────┬────────────────────┘  │ DIV INC DEC│
                                       │ address               │ AND OR XOR │
                ┌──────────────────────▼────────────────────┐  │ NOT SHL SHR│
                │       MEMORY  256 × 8  (code + data)      │  │ CMP        │
                │  0x00 program │ 0x80 data │ 0xC0 stack    │  └─▲───▲───┬──┘
                └───────────┬───────────────────▲───────────┘    │   │   │ result
                            │ read data         │ write data      │a  │b  │
                ┌───────────▼───────────────────┴─────────────────┴───┴───▼──┐
                │                 REGISTER FILE  R0–R7 (8 × 8)               │
                │        read port a, read port b, one write port            │
                └────────────────────────────────────────────────────────────┘
```

Data paths:

- **Fetch.** The address mux selects PC, PC + 1 and PC + 2. Memory returns the opcode and operand bytes into IR.
- **Decode.** The control unit looks up the opcode. This is the same table as `opcodeByByte` in `@vcpu/shared`. The lookup yields the length, the register-byte fields to validate, and the trailing-byte kind.
- **Execute.**
  - ALU instructions read Rd and Rs through the two register-file read ports. The ALU returns an 8-bit result and the four flag values, and the flag-write mask decides which flags change.
  - LOAD and STORE drive the address mux with `addr8` or `Rp`.
  - PUSH, POP, CALL and RET drive it with SP. For a pop, the address is SP + 1.
- **Writeback.** At most one register is written, at most one memory byte is written, and FLAGS, SP, SD and PC are updated, all at the same commit point. Fault checks happen before that point, which makes faults precise.

This is a conceptual datapath. The emulator executes each instruction as one atomic step. The cycle counts it reports come from the instructional timing model, not from this diagram.

## Design principles

- **One source of truth.** `@vcpu/shared` holds the ISA as a frozen, typed table. The emulator, assembler, disassembler, debugger, dashboard and fixture exporter import it and never re-declare an opcode, length, flag rule or cycle count. A test keeps [instruction-set.md](instruction-set.md) in sync with the table.
- **No host-language semantics.** Every 8-bit value passes through checked helpers: `u8`, `low8`, `toSigned8`, `fromSigned8` and `bit`. Arithmetic is defined mathematically (modulo 256, explicit carry and overflow rules), so a SystemVerilog implementation computes the same bits.
- **Determinism.** The same reset image and the same number of steps always give the same state. There are no timers, interrupts, randomness or wall-clock dependence in the core.
- **No silent wrapping of the address space.** Instructions, PC and the stack never wrap past `0xFF`. Each such case is a defined fault (see [cpu-execution.md](cpu-execution.md#faults)).
- **Precise faults.** A faulting instruction changes nothing, except the documented post-commit `PC_OVERFLOW`. The state a debugger shows is always the state the bad instruction saw.
- **Portable core.** `@vcpu/shared` and `@vcpu/cpu-core` import no React, Node or browser APIs. ESLint enforces this.

## Where it lives in code

`@vcpu/shared` (`packages/shared/src`) exports:

| Export                                                                             | What it is                                                   |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `ISA`                                                                              | The whole definition in one frozen object                    |
| `ISA_VERSION`, `CPU_NAME`                                                          | `"1.0.0"`, `"VCPU-8"`                                        |
| `OPCODES`, `Op`, `opcodeByByte`, `opcodesByMnemonic`, `opcodeById`, `lookupOpcode` | The opcode table and its lookups                             |
| `INSTRUCTION_FORMATS`, `REGISTER_BYTE_OFFSET`                                      | Format lengths and layouts                                   |
| `MNEMONICS`, `OPCODE_IDS`, `FLAG_NAMES`, `FaultCode`, `CpuStatus` and the types    | Enumerations                                                 |
| `MEMORY_SIZE`, `MEMORY_MAP`, `STACK_CAPACITY`, `RESET_*`, `REGISTER_NAMES`         | Machine constants                                            |
| `FLAG_BITS`, `FLAG_MASKS`, `FLAGS_USED_MASK`, `packFlags`, `unpackFlags`           | FLAGS layout                                                 |
| `TIMING_MODEL`, `estimatedCycles`                                                  | The instructional timing model                               |
| `FAULT_CODE_NUMBERS`, `CPU_STATUS_NUMBERS`, `NO_FAULT_NUMBER`                      | Numeric encodings for hardware fixtures                      |
| `u8`, `isU8`, `low8`, `toSigned8`, `fromSigned8`, `isS8`, `bit`                    | Checked 8-bit helpers (they throw a RangeError on bad input) |
| `encodeRegisterByte`, `decodeRegisterByte`, `isRegisterIndex`                      | Register-byte encoding; decoding returns a typed error       |
| `U8Schema`, `ProgramImageSchema`                                                   | Zod schemas for data loaded from outside the code            |

## Versioning

`ISA_VERSION` follows semantic versioning. Any change to an encoding, a length, a flag rule, a fault rule, reset values or the timing model bumps it. Such a change also gets an entry under [Design decisions](instruction-set.md#design-decisions) and regenerated hardware fixtures. Purely additive helpers in `@vcpu/shared` that change no behaviour do not bump it.

## Limitations of v1.0

- There are no interrupts, I/O ports or privileged modes. Output is by convention through data memory.
- Programs cannot read or write PC, SP or FLAGS directly. There is no branch on N or V, so signed comparisons need extra instructions.
- There is no memory protection. The regions are conventions, and a program can overwrite its own code or the stack.
- MUL keeps only the low byte, and DIV discards the remainder.
- Cycle counts are estimates from an instructional model, not measurements of a real circuit.
