# @vcpu/debugger

A debug session around `@vcpu/cpu-core`, shared by the web dashboard and `pnpm cpu debug`. It drives the core only through its public API (`step()`, the observer hook and `undoStep()`), so the debugger never has its own copy of CPU behaviour. Like the core, it uses no Node or browser APIs, no timers and no wall-clock time: the same calls always give the same stops.

## Usage

```ts
import { assemble } from '@vcpu/assembler';
import { createDebugSession } from '@vcpu/debugger';

const { bytes, sourceMap } = assemble(source);
const session = createDebugSession({ program: bytes.image, sourceMap, historyCapacity: 1024 });

session.addBreakpoint({ line: 18 }); // or { address: 0x1E }
session.addWatchpoint({ address: 0x85, kind: 'write' }); // or { range: { start, end }, kind }

const stop = session.run({ maxInstructions: 10_000 });
if (stop.stopReason === 'breakpoint') stop.address; // PC; that instruction has not run
if (stop.stopReason === 'watchpoint') stop.hit; // { access, pc, text, address, oldValue, newValue, … }

session.step(); // one instruction, even one under a breakpoint
session.stepBack(); // { ok: true, undone, pc, remaining } or { ok: false, reason: 'no-history', message }
session.reset(); // back to the loaded program; breakpoints and watchpoints stay
```

`createDebugSession({ program, sourceMap?, historyCapacity?, traceCapacity? })` loads `program` (raw bytes at 0x00, a `ProgramImage`, or an assembled 256-byte image) into a new CPU. The source map is the assembler's `sourceMap`; it is needed for breakpoints by line and for source lines in inspection.

## Stops

`step()` and `run()` return a `DebugStop`: `{ stopReason, executed, pc, hits, fault }`, plus `address` and `breakpoint` for a breakpoint stop and `hit` (the first of `hits`) for a watchpoint stop.

| `stopReason` | Meaning                                                                                 |
| ------------ | --------------------------------------------------------------------------------------- |
| `step`       | `step()` executed its instruction.                                                      |
| `breakpoint` | An enabled breakpoint is at PC. The instruction there has **not** executed.             |
| `watchpoint` | The last instruction made a watched access. That instruction **has** executed.          |
| `halted`     | The CPU is HALTED.                                                                      |
| `faulted`    | The CPU is FAULTED; `fault` says why.                                                   |
| `limit`      | `run()` executed `maxInstructions` instructions (default 1,000,000).                    |
| `paused`     | `pause()` was called from an `onStep` listener; it stops after the current instruction. |

A HALTED or FAULTED session stays put until `stepBack()` or `reset()`. `getStatus()` is READY, RUNNING (inside `run()`), PAUSED (a run stopped short), HALTED or FAULTED.

## Breakpoints

A breakpoint is checked against PC before each instruction, so `run()` stops **before** the instruction at its address executes. A breakpoint by `line` resolves to the first instruction on that line through the source map; a line with no instruction (a comment, a label alone, `.equ`, `.byte`) throws `BreakpointError`. A breakpoint on an address the source map shows is not the start of an instruction (data, an operand byte, or nothing assembled) is still added, with a `warning` that it never hits unless execution reaches that address.

Resuming does not re-trigger: when `run()` stopped at a breakpoint, the next `run()` executes that instruction before it checks breakpoints again. After any other movement (`step()`, `stepBack()`, `reset()`), the breakpoint at PC hits at once. `step()` always executes, breakpoint or not.

`addBreakpoint`, `removeBreakpoint`, `toggleBreakpoint(id, enabled?)` and `listBreakpoints()` manage them. Adding one at an address that already has a breakpoint returns the existing one.

## Watchpoints

A watchpoint covers one address or an inclusive range and has a kind: `read`, `write` or `access` (both). Only data accesses count (LOAD, STORE, PUSH, POP, and the return address of CALL and RET), never instruction fetches. An access happens partway through an instruction, so `run()` stops **after** the accessing instruction completes. `step()` reports hits in `hits` (and returns `watchpoint`) but still executes only one instruction.

Each `WatchpointHit` has the `watchpoint`, the `access` that happened (`read` or `write`), the instruction's `pc`, its decoded `instruction` and assembly `text`, the `address`, and `oldValue` / `newValue` (equal for a read). One instruction can match several watchpoints; `hits` lists each match.

## Step back and its memory bound

Every executed instruction pushes a reversible delta onto a ring buffer of `historyCapacity` entries (default 1024; 0 disables step-back). A delta is the step's trace entry (register, SP, SD, FLAGS and PC changes and every written byte, each with the value before) plus the IR and status before the step. `stepBack()` hands the newest delta to the core's `undoStep()`, which restores the registers, flags, memory, PC, SP, SD, IR, status, fault, metrics and trace. Stepping back over HLT or a fault returns to the READY state before it.

When the buffer is full the oldest delta is dropped, so the bound is enforced, not advisory. `stepBack()` past the oldest delta returns `{ ok: false, reason: 'no-history', message }`. `getHistoryStats()` returns `{ entries, capacity, approxBytes, maxApproxBytes }`: `approxBytes` estimates what the held deltas use, and `maxApproxBytes` is the estimate for a full buffer of the largest possible deltas (a 3-byte instruction changing 10 registers, 4 flags, 1 read and 1 write). The figures use rough per-object sizes and real engines differ, but each delta is bounded in size, so the total is too. `reset()` clears history.

## Inspection

| Method                    | Returns                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `getState()`              | The core's frozen `CpuState`: registers, PC, SP, SD, FLAGS, IR, status, fault and all 256 memory bytes. |
| `getRegisters()`          | R0–R7.                                                                                                  |
| `getFlags()`              | `{ Z, C, N, V }` as booleans.                                                                           |
| `readMemory(start, len)`  | Bytes from `start` (default the whole memory). Throws a RangeError past 0xFF.                           |
| `getStackView()`          | `{ sp, depth, slots }`: the live slots SP+1 … 0xFF, top of stack first.                                 |
| `getCurrentInstruction()` | The instruction at PC: `address`, `bytes`, decoded `instruction`, `text`, `fault` and source map entry. |
| `getExecutionTrace()`     | The core's kept trace entries, oldest first.                                                            |
| `getTimeline(n)`          | The newest `n` trace entries (all when omitted), oldest first.                                          |
| `getInstructionCount()`   | Retired instructions since reset; it goes down with `stepBack()`.                                       |
| `getMetrics()`            | The core's metrics.                                                                                     |
| `getHistoryStats()`       | See above.                                                                                              |

## Events

`onStep(listener)` is called after every executed instruction, inside `run()` too, with the trace entry and its hits. `onStop(listener)` is called when `step()` or `run()` returns, with the `DebugStop`. Both return an unsubscribe function. Listeners may read state and call `pause()`; calling `step()`, `stepBack()`, `run()` or `reset()` from one throws `DebugSessionBusyError`.

## Tests

```sh
pnpm --filter @vcpu/debugger test
```

The suite covers breakpoint timing and resume, every watchpoint kind, history limits and the memory figures, inspection, and a `fast-check` property test: for each fixture program and every `examples/*.asm`, random steps then as many step-backs restore an identical state, metrics and trace at every point.
