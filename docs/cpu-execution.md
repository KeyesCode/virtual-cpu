# CPU Execution

This document defines how VCPU-8 (ISA version 1.0.0) executes instructions: the steps of one instruction, how PC advances, every fault case, reset, and the status machine. It is precise enough to build a cycle-by-cycle RTL implementation whose architectural results match the TypeScript emulator bit for bit.

[instruction-set.md](instruction-set.md) defines the encodings and per-instruction semantics, and [memory-model.md](memory-model.md) defines memory and the stack.

## Architectural state

| State  | Width / range             | Reset value     |
| ------ | ------------------------- | --------------- |
| R0–R7  | 8 bits each               | `0x00`          |
| PC     | 8 bits                    | `0x00`          |
| SP     | 8 bits                    | `0xFF`          |
| SD     | 0–64 (7 bits)             | `0`             |
| FLAGS  | 8 bits, bits 7–4 always 0 | `0x00`          |
| status | READY … FAULTED           | READY           |
| fault  | none, or code + address   | none            |
| memory | 256 × 8 bits              | the reset image |

**IR** (instruction register) holds the instruction being executed: its opcode byte, its operand bytes and the decoded fields. IR is visible to the debugger and the trace, but it is **not** compared by hardware fixtures. After reset IR is empty (`null` in the emulator; an RTL design may reset it to `0x00` with a "valid" bit cleared).

Metrics (instruction count, estimated cycles, memory-access counts, branch counts) are **not** architectural state. They are defined below so that every tool counts them identically.

## The execution cycle

Each `step()` executes exactly one instruction through the following steps. Steps 1–5 only **read** state. Step 6 is the single point where architectural state changes, which is what makes faults precise.

```
0. Gate       if status is HALTED or FAULTED: do nothing and return.
1. Fetch      op ← mem[PC]; info ← opcodeByByte[op]
              info undefined                    → fault INVALID_OPCODE
2. Bounds     L ← info.length
              PC + L > 0x100                    → fault INSTRUCTION_OVERRUN
3. Decode     operand bytes ← mem[PC+1 … PC+L−1]; IR ← opcode + operand bytes
              if the format has a register byte: validate it (field a, then field b)
              malformed                         → fault MALFORMED_OPERAND
4. Next PC    seq ← PC + L                      (may equal 0x100)
              CALL and seq == 0x100             → fault PC_OVERFLOW (precise)
5. Execute    read operand registers / memory; compute result, flags, target
              DIV with Rs == 0                  → fault DIVIDE_BY_ZERO
              PUSH or CALL with SD == 64        → fault STACK_OVERFLOW
              POP or RET with SD == 0           → fault STACK_UNDERFLOW
6. Commit     write the destination register, the memory byte, FLAGS, SP and SD
7. PC update  HLT                    → PC unchanged; status ← HALTED
              JMP, CALL              → PC ← target
              Jcc, condition true    → PC ← target
              RET                    → PC ← popped byte
              otherwise              → PC ← seq; if seq == 0x100:
                                        PC unchanged; status ← FAULTED (PC_OVERFLOW)
8. Metrics    instructions += 1; cycles += estimatedCycles(info, transferred);
              data reads / writes, branches taken / not taken
9. Trace      emit one trace entry (address, bytes, mnemonic, register, flag and memory changes)
```

In step 5 an instruction reads all of its operands before anything is written. When the same register is both a source and the destination (`ADD R0, R0`, `LOAD R1, [R1]`), the source is always the value from before the instruction.

Execution is fully deterministic. The result depends only on the architectural state and memory, never on wall-clock time, host number formats or randomness. The core has no delays, and `run({ maxInstructions })` is just repeated `step()` calls that stop on HALTED, FAULTED, a debugger pause or the instruction limit. Reaching the instruction limit is not a fault: the CPU stays runnable.

## Faults

A fault stops the CPU: status ← FAULTED, and the fault record holds the **fault code** and the **address** of the faulting instruction (its PC). Later `step()` and `run()` calls do nothing until `reset()`.

### Precise faults

Every fault except the post-commit `PC_OVERFLOW` is **precise**:

- Nothing architectural changes: registers, FLAGS, memory, SP and SD all keep their values.
- PC stays at the faulting instruction's address.
- The instruction is not retired, so the instruction count, cycles and memory counters are unchanged.

A debugger can therefore show exactly the state in which the bad instruction was about to run.

### The post-commit PC_OVERFLOW

When an instruction whose next PC is sequential (anything except HLT, JMP, a taken Jcc, CALL and RET) sits so that PC + L = `0x100`:

1. Its effects **are** committed (registers, memory, FLAGS, SP, SD), and it is retired and counted.
2. Then status ← FAULTED with `PC_OVERFLOW`, and **PC is left at that instruction's address**, because `0x100` cannot be stored in the 8-bit PC.

Examples: `NOP` at `0xFF`; `INC R0` at `0xFE` (R0 is incremented, then the CPU faults); `LDI R0, 1` at `0xFD`; a JZ at `0xFE` whose condition is false. A taken branch at `0xFE` does not fault, because its next PC is the target.

### Fault table

| Code (number)             | Raised when                                                         | Instructions             | Kind        |
| ------------------------- | ------------------------------------------------------------------- | ------------------------ | ----------- |
| `INVALID_OPCODE` (1)      | `mem[PC]` is not one of the 30 opcodes                              | —                        | precise     |
| `MALFORMED_OPERAND` (2)   | a used register field is 8–15, or an unused register field is not 0 | R, RR, RI and RA formats | precise     |
| `INSTRUCTION_OVERRUN` (3) | PC + L > `0x100`: the instruction's bytes cross the end of memory   | any of length 2 or 3     | precise     |
| `PC_OVERFLOW` (4)         | sequential next PC = `0x100`                                        | all sequential ones      | post-commit |
| `PC_OVERFLOW` (4)         | CALL's return address PC + 2 = `0x100` (CALL at `0xFE`)             | CALL                     | precise     |
| `DIVIDE_BY_ZERO` (5)      | the divisor Rs is `0x00`                                            | DIV                      | precise     |
| `STACK_OVERFLOW` (6)      | a push with SD = 64                                                 | PUSH, CALL               | precise     |
| `STACK_UNDERFLOW` (7)     | a pop with SD = 0                                                   | POP, RET                 | precise     |

The numbers are `FAULT_CODE_NUMBERS` in `@vcpu/shared` (0 = no fault). LOAD and STORE cannot fault on their address, because every byte is a valid address.

### Fault priority

At most one fault is reported per step. When several conditions hold, the first in step order wins: `INVALID_OPCODE` → `INSTRUCTION_OVERRUN` → `MALFORMED_OPERAND` (field a before field b) → `PC_OVERFLOW` (CALL) → `DIVIDE_BY_ZERO` / `STACK_OVERFLOW` / `STACK_UNDERFLOW`. At most one of the last three can apply to any instruction. Some consequences:

- An invalid opcode at `0xFF` is `INVALID_OPCODE`, not an overrun.
- The bytes `11 90` at `0xFE` (an LDI with a bad register field and no room for its immediate) are `INSTRUCTION_OVERRUN`. The bounds check happens before the register byte is examined, so no byte past `0xFF` is ever read.
- A CALL at `0xFE` with a full stack is `PC_OVERFLOW`.

## Status machine

| Status    | Meaning                                                                  | `step()`                 |
| --------- | ------------------------------------------------------------------------ | ------------------------ |
| `READY`   | Reset or loaded; can execute                                             | executes one instruction |
| `RUNNING` | A `run()` loop is executing                                              | —                        |
| `PAUSED`  | A run was paused by the user, a breakpoint or a watchpoint; can continue | executes one instruction |
| `HALTED`  | HLT executed                                                             | no-op until `reset()`    |
| `FAULTED` | A fault occurred; the fault record says which and where                  | no-op until `reset()`    |

Transitions:

| From                         | Event                                                                                                      | To        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | --------- |
| any                          | `reset()` or `loadProgram()`                                                                               | `READY`   |
| `READY`, `PAUSED`            | `run()`                                                                                                    | `RUNNING` |
| `RUNNING`                    | the loop stops without halting or faulting: `pause()`, a breakpoint, a watchpoint or the instruction limit | `PAUSED`  |
| `READY`, `RUNNING`, `PAUSED` | a step executes HLT                                                                                        | `HALTED`  |
| `READY`, `RUNNING`, `PAUSED` | a step faults                                                                                              | `FAULTED` |

Architecturally, READY, RUNNING and PAUSED are the same "can execute" state. The table above is the baseline; the core and debugger may refine how the run loop moves between these three. HALTED and FAULTED are terminal until `reset()`. `CPU_STATUS_NUMBERS` in `@vcpu/shared` gives their numeric encodings for fixtures.

## Reset

`reset()` puts the CPU into a fully defined state:

- R0–R7 = `0x00`, FLAGS = `0x00`, PC = `0x00`, SP = `0xFF`, SD = 0
- IR empty, no fault, status = READY
- metrics and the trace cleared
- memory = the reset image, which is the memory captured by the last `loadProgram()`: zero-filled, then the program bytes written at their addresses. Before any program is loaded, all 256 bytes are `0x00`.

Two CPUs that load the same image and execute the same number of steps end in identical architectural state. Hardware fixtures rely on this.

## Metrics and timing

Metrics are counted at step 8, for **retired** instructions only:

- **instructions**: +1 per retired instruction. HLT counts, and an instruction that raises the post-commit `PC_OVERFLOW` counts.
- **estimated cycles**: `baseCycles + (transferred ? branchTakenPenalty : 0)` from the opcode table. "Transferred" is true for JMP, CALL and RET, and for a conditional branch whose condition held. These are **estimates** from the instructional timing model in [instruction-set.md](instruction-set.md#timing-model), not measured clock cycles.
- **data reads / data writes**: from the opcode table's `dataReads` / `dataWrites`. Instruction fetches are excluded.
- **branches taken / not taken**: conditional branches only (JZ, JNZ, JC, JNC).

A precisely faulting instruction changes no metric.
