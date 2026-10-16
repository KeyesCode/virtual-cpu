# @vcpu/cpu-core

The VCPU-8 emulator. It executes real encoded machine-code bytes, following ISA v1.0 exactly as [docs/instruction-set.md](../../docs/instruction-set.md), [docs/memory-model.md](../../docs/memory-model.md) and [docs/cpu-execution.md](../../docs/cpu-execution.md) define it. Every ISA fact (opcodes, formats, flag lists, timing) comes from the shared table in `@vcpu/shared`.

The core is pure TypeScript. It uses no React, Node or browser APIs, no timers and no wall-clock time, so the same program always produces the same state, trace and metrics.

## Usage

```ts
import { createCpu } from '@vcpu/cpu-core';

const cpu = createCpu();

// LDI R0, 10 / LDI R1, 20 / ADD R0, R1 / HLT
cpu.loadProgram([0x11, 0x00, 0x0a, 0x11, 0x10, 0x14, 0x20, 0x01, 0x01]);

cpu.run({ maxInstructions: 1000 }); // { executed: 4, stopReason: 'halted' }

const state = cpu.getState();
state.registers[0]; // 30
state.status; // 'HALTED'

cpu.getMetrics(); // { instructions: 4, estimatedCycles: 13, memoryReads: 0, … }
cpu.getExecutionTrace(); // one TraceEntry per step, oldest first
```

`loadProgram` also takes a `Uint8Array` or a `ProgramImage` (`{ origin, bytes }`). It throws `ProgramLoadError` for an image that has bytes outside 0–255 or does not fit in the 256-byte memory. A successful load zero-fills memory, writes the program, records that memory as the reset image and resets the CPU. `reset()` restores the reset image, so a program that modifies itself starts fresh every time.

## API

| Member                                     | Behaviour                                                                                                                                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createCpu({ traceCapacity?, observer? })` | A CPU in its reset state with all memory zero. `traceCapacity` defaults to 1024; 0 disables the trace.                                                                                                          |
| `step()`                                   | Executes one instruction and returns `{ status, entry }`, where `entry` is that instruction's `TraceEntry`. On a HALTED or FAULTED CPU it does nothing and returns `entry: null`.                               |
| `run({ maxInstructions? })`                | Steps until HALTED, FAULTED, the instruction limit (default 1,000,000), `pause()` or an observer break. Returns `{ executed, stopReason }`. A run that stops without halting or faulting leaves the CPU PAUSED. |
| `pause()`                                  | Called from an observer callback during `run()`: stops after the current step. Outside a run it does nothing.                                                                                                   |
| `reset()`                                  | Registers to their reset values, memory to the reset image, metrics and trace cleared, status READY.                                                                                                            |
| `getState()`                               | A deep-frozen, JSON-serializable snapshot: `registers`, `pc`, `sp`, `sd`, `flags`, `ir`, `status`, `fault` and all 256 `memory` bytes.                                                                          |
| `getExecutionTrace()`                      | The kept `TraceEntry` objects, oldest first.                                                                                                                                                                    |
| `getMetrics()`                             | Retired instructions, per-opcode counts, data reads and writes, fetched bytes, conditional branches taken and not taken, and estimated cycles.                                                                  |
| `setObserver(observer \| null)`            | Attaches or removes a `CpuObserver`.                                                                                                                                                                            |
| `undoStep({ entry, ir, status })`          | Reverses the most recent step from its `TraceEntry`, given the IR and status before it (debugger step-back). See below.                                                                                         |

`stopReason` is one of `halted`, `faulted`, `limit`, `paused`, `breakpoint` or `watchpoint`.

### Trace entries

Each `TraceEntry` records the instruction address, the PC after the step, the raw bytes, the decoded instruction (`null` if it could not be decoded), register changes (SP and SD included), FLAGS before and after with per-flag changes, data-memory reads and writes, whether a conditional branch was taken, whether control transferred, the estimated cycles, the status after the step and any fault. A precisely faulting step lists no changes and costs 0 cycles.

### Faults

Faults follow [docs/cpu-execution.md](../../docs/cpu-execution.md#faults). Every fault except the sequential `PC_OVERFLOW` is precise: no register, flag, memory, SP or SD changes, PC stays at the faulting instruction, and no metric changes. The post-commit `PC_OVERFLOW` (a sequential instruction ending at 0xFF) commits its effects first and leaves PC at that instruction. A HALTED or FAULTED CPU stays inert until `reset()` or `loadProgram()`.

## Observer hook

A `CpuObserver` lets tools such as the debugger watch execution without forking the core:

```ts
cpu.setObserver({
  // Before every instruction. 'break' stops run() before this instruction (a breakpoint).
  beforeExecute: ({ pc }) => (breakpoints.has(pc) ? 'break' : undefined),
  // Data accesses only (LOAD, STORE, PUSH, POP, CALL, RET), never instruction fetches.
  // 'break' stops run() after the accessing instruction (a watchpoint).
  onMemoryWrite: ({ pc, address, value, previous }) => (watched.has(address) ? 'break' : undefined),
  onMemoryRead: ({ pc, address, value }) => undefined,
});
```

`step()` also calls `beforeExecute` but always executes the instruction, so a debugger continues from a breakpoint with `step()` followed by `run()`. Callbacks may read state and call `pause()`. Calling `step()`, `run()`, `reset()` or `loadProgram()` from a callback throws `CpuBusyError`.

## Undoing a step

`undoStep()` is the hook behind the debugger's step-back. It takes the most recent step's trace entry plus the IR and status (READY or PAUSED) the CPU had before that step, and puts back everything the step changed: the bytes it wrote, R0–R7, SP, SD, FLAGS, PC, IR, status, fault, metrics and the step counter. The entry also leaves the trace. It throws a RangeError for an entry that is not the most recent step's, and `CpuBusyError` from an observer callback. The core keeps no history itself: the caller holds the entries, so the caller also sets the memory bound.

## Building blocks

The package also exports its parts, for tools and tests:

- `decode(memory, pc)` decodes one instruction from a 256-byte memory and returns either the `DecodedInstruction` or the fault it would raise.
- The ALU: `add`, `sub`, `mul`, `div`, `inc`, `dec`, `and`, `or`, `xor`, `not`, `shl`, `shr` and `cmp`. Each is a pure function of unsigned bytes and the FLAGS byte, and returns `{ result, flags }`.

## Tests

```sh
pnpm --filter @vcpu/cpu-core test           # unit and property-based tests
pnpm --filter @vcpu/cpu-core test:coverage  # fails below 95% branch coverage
```

The suite tests every instruction, flag rule and fault, and checks that each precise fault leaves the state unchanged. It also runs the ALU exhaustively over all operand pairs, and with `fast-check`, against an independent BigInt and bit-string reference.
