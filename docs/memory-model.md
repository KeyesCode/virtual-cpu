# Memory Model

VCPU-8 (ISA version 1.0.0) has a single **256-byte** memory, addressed `0x00`–`0xFF`. Code and data share it, as in a von Neumann machine. Every location is an 8-bit byte. There are no multi-byte words, so byte order (endianness) never comes up.

The constants on this page are exported by `@vcpu/shared`: `MEMORY_SIZE`, `MEMORY_MAP`, `STACK_CAPACITY` and `RESET_SP`.

## Memory map

| Range         | Size  | Region    | Use                                               |
| ------------- | ----- | --------- | ------------------------------------------------- |
| `0x00`–`0x7F` | 128 B | `program` | Code. Execution starts at `0x00` after reset.     |
| `0x80`–`0xBF` | 64 B  | `data`    | Variables, arrays, I/O-style output cells.        |
| `0xC0`–`0xFF` | 64 B  | `stack`   | The hardware stack, growing **down** from `0xFF`. |

```
0x00 ┌──────────────────────────┐ ← PC after reset
     │ program (128 B)          │
0x7F ├──────────────────────────┤
0x80 │ data (64 B)              │
0xBF ├──────────────────────────┤
0xC0 │ stack (64 B)             │ ← lowest stack slot (SD = 64)
     │          ▲ grows down    │
0xFF └──────────────────────────┘ ← SP after reset; first PUSH writes here
```

The regions are a **convention** and are not protected. Any instruction may read or write any address, the CPU may execute bytes anywhere, and a program longer than 128 bytes simply continues into the data region. The assembler and the dashboard use the map to label and colour memory, but the CPU never checks it. The only bound the CPU enforces is the stack depth (below).

## Addresses never wrap

Every address is a single byte, so every data address (`[addr8]`, `[Rp]`, `SP`) is always in range, and LOAD and STORE can never fault on an address. The address space **never wraps around** from `0xFF` to `0x00`:

- **Instruction fetch.** An instruction whose bytes would run past `0xFF` (PC + length > `0x100`) faults with `INSTRUCTION_OVERRUN` before any operand byte is read.
- **Sequential PC.** If the next sequential PC would be `0x100`, the CPU faults with `PC_OVERFLOW` after the instruction commits. A `HLT` at `0xFF` is legal, because HLT does not advance PC.
- **Return address.** A CALL at `0xFE` would push the return address `0x100`, so it faults with `PC_OVERFLOW` and pushes nothing.
- **Stack.** The stack is bounded by the depth counter SD, never by SP wrapping.

[cpu-execution.md](cpu-execution.md) defines the exact fault behaviour.

## Reads, writes and fetches

- **Instruction fetches** read the opcode and operand bytes at PC … PC + L − 1. They are not data accesses.
- **Data reads** happen in exactly four instructions: LOAD (both variants), POP and RET. Each reads one byte.
- **Data writes** happen in exactly four instructions: STORE (both variants), PUSH and CALL. Each writes one byte.

No instruction touches more than one data byte. Reads have no side effects. Memory that a program has not written holds `0x00`, because loading a program zero-fills memory first.

Debugger watchpoints and the dashboard's memory-access metrics count only data reads and data writes. Instruction fetches are reported separately, if at all.

**Self-modifying code is allowed.** A STORE into the code area takes effect the next time those bytes are fetched. An instruction that overwrites its own bytes has already been fetched, so it completes as fetched.

## Stack

The stack holds bytes pushed by `PUSH` and return addresses pushed by `CALL`. Two registers describe it:

- **SP** (stack pointer, 8-bit) is the address the **next push** will write. It resets to `0xFF`.
- **SD** (stack depth, 0–64) is the number of bytes currently on the stack. It resets to `0`. SD is architectural state, so it is part of every CPU snapshot and hardware fixture.

`STACK_CAPACITY` is **64**: the stack occupies `0xC0`–`0xFF` when full.

```
push(v):
    if SD == 64: fault STACK_OVERFLOW        (precise: nothing changes)
    mem[SP] ← v
    SP ← SP − 1
    SD ← SD + 1

pop():
    if SD == 0:  fault STACK_UNDERFLOW       (precise: nothing changes)
    SP ← SP + 1
    v ← mem[SP]
    SD ← SD − 1
    return v
```

`pop()` does not clear the byte it reads, and the old value stays in memory until it is overwritten.

### The SP/SD invariant

No instruction in ISA v1.0 writes SP directly, so the following always holds:

```
SP == 0xFF − SD        and        0 ≤ SD ≤ 64
```

Therefore SP stays within `0xBF`–`0xFF`. SP equals `0xBF` only when the stack is full, and the next push faults before writing there. Overflow and underflow are detected from **SD**, never from SP wrapping. The CPU core asserts this invariant in its tests. A hardware implementation may store either SP or SD and derive the other, but snapshots and fixtures carry both.

### Example

| After               | SP     | SD  | Stack bytes (`0xFF` downward)  |
| ------------------- | ------ | --- | ------------------------------ |
| reset               | `0xFF` | 0   | —                              |
| `PUSH R0` (R0 = 7)  | `0xFE` | 1   | `07`                           |
| `CALL 0x40` at 0x10 | `0xFD` | 2   | `07 12`                        |
| `RET`               | `0xFE` | 1   | `07` (`0xFE` still holds `12`) |
| `POP R1`            | `0xFF` | 0   | — (R1 = 7)                     |

### The stack is not protected

The stack region is ordinary memory. A STORE may overwrite pushed values, and a program can corrupt a return address that way. Pushes may also overwrite data that a program placed in `0xC0`–`0xFF`. The depth bound prevents the stack from growing below `0xC0`. It does not stop other instructions from writing into the stack region.

## Program images and reset

A **program image** is a list of bytes plus an optional origin (default `0x00`). `ProgramImageSchema` (Zod) in `@vcpu/shared` validates any image loaded from outside the code: every byte must be 0–255, and `origin + bytes.length ≤ 256`.

`loadProgram(image)` zero-fills all 256 bytes, writes the image at its origin, records that memory contents as the **reset image**, and then performs a reset. `reset()` restores the reset image, so every run of the same program starts from identical memory. [cpu-execution.md](cpu-execution.md#reset) lists the register reset values.
