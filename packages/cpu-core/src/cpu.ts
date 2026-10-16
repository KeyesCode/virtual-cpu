import {
  CpuStatus,
  FaultCode,
  FLAG_MASKS,
  FLAG_NAMES,
  MEMORY_SIZE,
  opcodeById,
  type OpcodeInfo,
  type ProgramImage,
  ProgramImageSchema,
  REGISTER_NAMES,
  STACK_CAPACITY,
} from '@vcpu/shared';
import { ALU_OPERATIONS } from './alu.js';
import { decode } from './decoder.js';
import { byteAt, Memory } from './memory.js';
import { type CpuMetrics, MetricsCounter } from './metrics.js';
import { createRegisterFile, resetRegisterFile } from './registers.js';
import { type CpuFault, type CpuState, type DecodedInstruction, snapshotState } from './state.js';
import {
  type FlagChange,
  type MemoryRead,
  type MemoryWrite,
  type RegisterChange,
  TraceBuffer,
  type TraceEntry,
} from './trace.js';

/** Returned by an observer callback to stop a `run()`; anything else lets it continue. */
export type ObserverVerdict = 'break' | undefined;

export interface BeforeExecuteEvent {
  /** Address of the instruction about to execute. */
  readonly pc: number;
}

export interface MemoryReadEvent {
  /** Address of the instruction performing the access. */
  readonly pc: number;
  readonly address: number;
  readonly value: number;
}

export interface MemoryWriteEvent {
  /** Address of the instruction performing the access. */
  readonly pc: number;
  readonly address: number;
  readonly value: number;
  /** The byte that was replaced. */
  readonly previous: number;
}

/**
 * Hooks for tools such as the debugger. Instruction fetches are not reported; only data accesses
 * (LOAD, STORE, PUSH, POP, CALL, RET) are. Callbacks must not throw, and must not call `step()`,
 * `run()`, `reset()` or `loadProgram()` (they throw `CpuBusyError`); reading state and `pause()`
 * are fine.
 *
 * - `beforeExecute` runs before every instruction fetch. Returning `'break'` stops `run()` before
 *   that instruction executes (stop reason `breakpoint`); `step()` always executes it.
 * - `onMemoryRead` / `onMemoryWrite` run during the access. Returning `'break'` stops `run()`
 *   after the accessing instruction completes (stop reason `watchpoint`).
 */
export interface CpuObserver {
  beforeExecute?(event: BeforeExecuteEvent): ObserverVerdict;
  onMemoryRead?(event: MemoryReadEvent): ObserverVerdict;
  onMemoryWrite?(event: MemoryWriteEvent): ObserverVerdict;
}

export interface CpuOptions {
  /** Trace entries kept (default 1024). 0 disables the trace, which keeps `run()` allocation-light. */
  readonly traceCapacity?: number;
  readonly observer?: CpuObserver | null;
}

export interface StepResult {
  /** Status after the step. */
  readonly status: CpuStatus;
  /** What the step did; `null` when the CPU was HALTED or FAULTED and did nothing. */
  readonly entry: TraceEntry | null;
}

export interface RunOptions {
  /** Upper bound on steps in this call (default `DEFAULT_MAX_INSTRUCTIONS`). */
  readonly maxInstructions?: number;
}

/**
 * Why `run()` returned:
 * - `halted` / `faulted`: the CPU is now HALTED / FAULTED (or already was).
 * - `limit`: `maxInstructions` steps ran. Not a fault: the CPU can continue.
 * - `paused`: `pause()` was called.
 * - `breakpoint`: `beforeExecute` returned `'break'`; the instruction at PC has not run.
 * - `watchpoint`: a memory hook returned `'break'`; the accessing instruction has run.
 */
export type StopReason = 'halted' | 'faulted' | 'limit' | 'paused' | 'breakpoint' | 'watchpoint';

export interface RunResult {
  /** Steps performed by this call, a faulting one included. */
  readonly executed: number;
  readonly stopReason: StopReason;
}

/**
 * What `undoStep()` needs to reverse one step: its trace entry plus the IR and status the CPU had
 * before it. A step only starts from READY or PAUSED, so the fault before it was always `null`.
 */
export interface StepUndo {
  readonly entry: TraceEntry;
  readonly ir: DecodedInstruction | null;
  readonly status: CpuStatus;
}

/** A program as raw bytes loaded at 0x00, or a `ProgramImage` with an origin. */
export type ProgramInput = ProgramImage | readonly number[] | Uint8Array;

export interface Cpu {
  /** Restores the reset state and the memory image of the last `loadProgram()`. */
  reset(): void;
  /** Zero-fills memory, writes the program, records it as the reset image and resets. */
  loadProgram(program: ProgramInput): void;
  /** Executes one instruction. Does nothing when HALTED or FAULTED. */
  step(): StepResult;
  /** Steps until HALTED, FAULTED, the instruction limit, `pause()` or an observer break. */
  run(options?: RunOptions): RunResult;
  /** Asks a `run()` in progress (that is, an observer callback) to stop after the current step. */
  pause(): void;
  getState(): CpuState;
  /** The kept trace entries, oldest first. */
  getExecutionTrace(): readonly TraceEntry[];
  getMetrics(): CpuMetrics;
  setObserver(observer: CpuObserver | null): void;
  /**
   * Reverses the most recent step from its trace entry, for the debugger's step-back: memory
   * writes, registers, SP, SD, FLAGS, PC, IR, status, fault, metrics and the step counter return to
   * what they were before it, and the entry leaves the trace. Throws a RangeError for any entry but
   * the most recent step's.
   */
  undoStep(undo: StepUndo): void;
}

/** Default `maxInstructions` for `run()`, so an endless loop always returns. */
export const DEFAULT_MAX_INSTRUCTIONS = 1_000_000;

/** Thrown by `loadProgram()` for an image that is not valid bytes or does not fit in memory. */
export class ProgramLoadError extends Error {
  override readonly name = 'ProgramLoadError';
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid program image: ${issues.join('; ')}`);
    this.issues = issues;
  }
}

/** Thrown when an observer callback calls a method that would re-enter the CPU. */
export class CpuBusyError extends Error {
  override readonly name = 'CpuBusyError';
}

function isTerminal(status: CpuStatus): boolean {
  return status === CpuStatus.HALTED || status === CpuStatus.FAULTED;
}

function hex(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}

function writesDestination(info: OpcodeInfo): boolean {
  return info.operands.some((operand) => operand.role === 'dest');
}

const NO_CHANGES: readonly never[] = Object.freeze([]);

class VirtualCpu implements Cpu {
  readonly #regs = createRegisterFile();
  readonly #memory = new Memory();
  readonly #metrics = new MetricsCounter();
  readonly #trace: TraceBuffer;
  #observer: CpuObserver | null;
  #resetImage = new Uint8Array(MEMORY_SIZE);
  #ir: DecodedInstruction | null = null;
  #status: CpuStatus = CpuStatus.READY;
  #fault: CpuFault | null = null;
  #sequence = 0;
  #busy = false;
  #pauseRequested = false;
  #watchpointHit = false;

  // Per-step scratch, reused so an untraced step allocates as little as possible.
  #recording = false;
  #currentPc = 0;
  #reads = 0;
  #writes = 0;
  #readLog: MemoryRead[] = [];
  #writeLog: MemoryWrite[] = [];
  readonly #registersBefore = new Uint8Array(REGISTER_NAMES.length);

  constructor(options: CpuOptions) {
    this.#trace = new TraceBuffer(options.traceCapacity);
    this.#observer = options.observer ?? null;
    this.reset();
  }

  reset(): void {
    this.#assertIdle('reset');
    resetRegisterFile(this.#regs);
    this.#memory.restore(this.#resetImage);
    this.#ir = null;
    this.#status = CpuStatus.READY;
    this.#fault = null;
    this.#sequence = 0;
    this.#pauseRequested = false;
    this.#metrics.reset();
    this.#trace.clear();
  }

  loadProgram(program: ProgramInput): void {
    this.#assertIdle('loadProgram');
    const candidate =
      Array.isArray(program) || program instanceof Uint8Array
        ? { bytes: Array.from(program) }
        : program;
    const parsed = ProgramImageSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ProgramLoadError(
        parsed.error.issues.map((issue) =>
          issue.path.length === 0
            ? issue.message
            : `${issue.path.map(String).join('.')}: ${issue.message}`,
        ),
      );
    }
    const image = new Uint8Array(MEMORY_SIZE);
    image.set(parsed.data.bytes, parsed.data.origin ?? 0);
    this.#resetImage = image;
    this.reset();
  }

  step(): StepResult {
    this.#assertIdle('step');
    if (isTerminal(this.#status)) {
      return { status: this.#status, entry: null };
    }
    this.#busy = true;
    let entry: TraceEntry | null;
    try {
      this.#observer?.beforeExecute?.({ pc: this.#regs.pc });
      entry = this.#execute(true);
    } finally {
      this.#busy = false;
    }
    return { status: this.#status, entry };
  }

  run(options: RunOptions = {}): RunResult {
    const maxInstructions = options.maxInstructions ?? DEFAULT_MAX_INSTRUCTIONS;
    if (!Number.isSafeInteger(maxInstructions) || maxInstructions < 0) {
      throw new RangeError(
        `maxInstructions must be a non-negative integer, got ${String(maxInstructions)}`,
      );
    }
    this.#assertIdle('run');
    if (isTerminal(this.#status)) {
      return { executed: 0, stopReason: this.#terminalReason() };
    }

    this.#busy = true;
    this.#pauseRequested = false;
    this.#watchpointHit = false;
    this.#status = CpuStatus.RUNNING;
    let executed = 0;
    let stopReason: StopReason | null = null;
    try {
      while (stopReason === null) {
        stopReason = this.#pendingStop(executed, maxInstructions);
        if (stopReason === null) {
          this.#execute(this.#trace.enabled);
          executed += 1;
        }
      }
    } finally {
      this.#busy = false;
      this.#pauseRequested = false;
      this.#watchpointHit = false;
      this.#leaveRunning();
    }
    return { executed, stopReason };
  }

  pause(): void {
    if (this.#status === CpuStatus.RUNNING) {
      this.#pauseRequested = true;
    }
  }

  getState(): CpuState {
    return snapshotState(this.#regs, this.#memory, this.#ir, this.#status, this.#fault);
  }

  getExecutionTrace(): readonly TraceEntry[] {
    return Object.freeze(this.#trace.toArray());
  }

  getMetrics(): CpuMetrics {
    return this.#metrics.snapshot();
  }

  setObserver(observer: CpuObserver | null): void {
    this.#observer = observer;
  }

  undoStep(undo: StepUndo): void {
    this.#assertIdle('undoStep');
    const { entry, ir, status } = undo;
    if (entry.sequence !== this.#sequence - 1) {
      throw new RangeError(
        `undoStep() takes the most recent step (sequence ${String(this.#sequence - 1)}), got sequence ${String(entry.sequence)}`,
      );
    }
    if (status !== CpuStatus.READY && status !== CpuStatus.PAUSED) {
      throw new RangeError(`A step starts from READY or PAUSED, not ${status}`);
    }
    const regs = this.#regs;
    for (const write of entry.memoryWrites.toReversed()) {
      this.#memory.write(write.address, write.before);
    }
    for (const change of entry.registerChanges) {
      if (change.register === 'SP') {
        regs.sp = change.before;
      } else if (change.register === 'SD') {
        regs.sd = change.before;
      } else {
        regs.r[REGISTER_NAMES.indexOf(change.register)] = change.before;
      }
    }
    regs.flags = entry.flagsBefore;
    regs.pc = entry.pc;
    // A precisely faulting step costs 0 cycles and retired nothing; every retired step costs > 0.
    if (entry.instruction !== null && entry.cycles > 0) {
      this.#metrics.unretire(
        opcodeById[entry.instruction.id],
        entry.controlTransferred,
        entry.branchTaken,
        entry.memoryReads.length,
        entry.memoryWrites.length,
      );
    }
    this.#ir = ir;
    this.#status = status;
    this.#fault = null;
    this.#sequence -= 1;
    this.#trace.dropNewest(entry);
  }

  #assertIdle(method: string): void {
    if (this.#busy) {
      throw new CpuBusyError(`${method}() cannot be called while the CPU is executing`);
    }
  }

  /**
   * Why the run loop must stop before the next step, or `null` to keep going. Read through a method
   * because observer callbacks change these fields during `#execute`.
   */
  #pendingStop(executed: number, maxInstructions: number): StopReason | null {
    if (isTerminal(this.#status)) {
      return this.#terminalReason();
    }
    if (this.#watchpointHit) {
      return 'watchpoint';
    }
    if (this.#pauseRequested) {
      return 'paused';
    }
    if (executed >= maxInstructions) {
      return 'limit';
    }
    if (this.#observer?.beforeExecute?.({ pc: this.#regs.pc }) === 'break') {
      return 'breakpoint';
    }
    return null;
  }

  /** A run that stopped without halting or faulting leaves the CPU PAUSED. */
  #leaveRunning(): void {
    if (this.#status === CpuStatus.RUNNING) {
      this.#status = CpuStatus.PAUSED;
    }
  }

  #terminalReason(): StopReason {
    return this.#status === CpuStatus.HALTED ? 'halted' : 'faulted';
  }

  /**
   * One instruction: fetch → decode → read operands → check faults → commit → next PC → metrics →
   * trace. Every precise fault is detected before the first write, so it leaves all architectural
   * state unchanged. Builds and returns a trace entry when `record` is true.
   */
  #execute(record: boolean): TraceEntry | null {
    const regs = this.#regs;
    const pc = regs.pc;
    const decoded = decode(this.#memory.view(), pc);
    if (!decoded.ok) {
      return this.#raise(decoded.fault, decoded.bytes, null, record);
    }
    const instruction = decoded.instruction;
    const info = opcodeById[instruction.id];
    const a = instruction.a ?? 0;
    const b = instruction.b ?? 0;
    const byte = instruction.byte ?? 0;
    const sequential = pc + instruction.length;

    this.#recording = record;
    this.#currentPc = pc;
    this.#reads = 0;
    this.#writes = 0;
    const flagsBefore = regs.flags;
    const spBefore = regs.sp;
    const sdBefore = regs.sd;
    if (record) {
      this.#registersBefore.set(regs.r);
      this.#readLog = [];
      this.#writeLog = [];
    }

    let target: number | null = null;
    let branchTaken: boolean | null = null;
    switch (instruction.id) {
      case 'NOP':
      case 'HLT':
        break;
      case 'MOV':
        regs.r[a] = this.#reg(b);
        break;
      case 'LDI':
        regs.r[a] = byte;
        break;
      case 'LOAD_ABS':
        regs.r[a] = this.#load(byte);
        break;
      case 'LOAD_IND':
        regs.r[a] = this.#load(this.#reg(b));
        break;
      case 'STORE_ABS':
        this.#store(byte, this.#reg(a));
        break;
      case 'STORE_IND':
        this.#store(this.#reg(a), this.#reg(b));
        break;
      case 'PUSH':
        if (regs.sd >= STACK_CAPACITY) {
          return this.#stackFault(FaultCode.STACK_OVERFLOW, instruction, record);
        }
        this.#push(this.#reg(a));
        break;
      case 'POP':
        if (regs.sd === 0) {
          return this.#stackFault(FaultCode.STACK_UNDERFLOW, instruction, record);
        }
        regs.r[a] = this.#pop();
        break;
      case 'JMP':
      case 'JZ':
      case 'JNZ':
      case 'JC':
      case 'JNC': {
        const condition = info.condition;
        if (condition !== null) {
          const flagValue = (regs.flags & FLAG_MASKS[condition.flag]) !== 0 ? 1 : 0;
          branchTaken = flagValue === condition.value;
        }
        if (branchTaken !== false) {
          target = byte;
        }
        break;
      }
      case 'CALL':
        if (sequential >= MEMORY_SIZE) {
          return this.#raise(
            {
              code: FaultCode.PC_OVERFLOW,
              pc,
              detail: `CALL at ${hex(pc)}: the return address 0x100 does not fit in 8 bits`,
            },
            instruction.bytes,
            instruction,
            record,
          );
        }
        if (regs.sd >= STACK_CAPACITY) {
          return this.#stackFault(FaultCode.STACK_OVERFLOW, instruction, record);
        }
        this.#push(sequential);
        target = byte;
        break;
      case 'RET':
        if (regs.sd === 0) {
          return this.#stackFault(FaultCode.STACK_UNDERFLOW, instruction, record);
        }
        target = this.#pop();
        break;
      default: {
        // The remaining ids are exactly the ALU operations. Operands are read before any write.
        const lhs = this.#reg(a);
        const rhs = instruction.b === null ? 0 : this.#reg(b);
        if (instruction.id === 'DIV' && rhs === 0) {
          return this.#raise(
            {
              code: FaultCode.DIVIDE_BY_ZERO,
              pc,
              detail: `DIV R${String(a)}, R${String(b)}: the divisor R${String(b)} is 0`,
            },
            instruction.bytes,
            instruction,
            record,
          );
        }
        const result = ALU_OPERATIONS[instruction.id](lhs, rhs, regs.flags);
        if (writesDestination(info)) {
          regs.r[a] = result.result;
        }
        regs.flags = result.flags;
      }
    }

    let fault: CpuFault | null = null;
    if (info.controlFlow === 'halt') {
      this.#status = CpuStatus.HALTED;
    } else if (target !== null) {
      regs.pc = target;
    } else if (sequential === MEMORY_SIZE) {
      // Post-commit PC_OVERFLOW: the effects above stay, PC stays at this instruction.
      fault = Object.freeze({
        code: FaultCode.PC_OVERFLOW,
        pc,
        detail: `${instruction.mnemonic} at ${hex(pc)}: the next PC 0x100 is past the end of memory`,
      });
      this.#fault = fault;
      this.#status = CpuStatus.FAULTED;
    } else {
      regs.pc = sequential;
    }
    this.#ir = instruction;

    const transferred = target !== null;
    const cycles = this.#metrics.retire(info, transferred, branchTaken, this.#reads, this.#writes);
    const sequence = this.#sequence;
    this.#sequence += 1;
    if (!record) {
      return null;
    }

    const registerChanges: RegisterChange[] = [];
    REGISTER_NAMES.forEach((register, index) => {
      const before = byteAt(this.#registersBefore, index);
      const after = this.#reg(index);
      if (before !== after) {
        registerChanges.push(Object.freeze({ register, before, after }));
      }
    });
    if (spBefore !== regs.sp) {
      registerChanges.push(Object.freeze({ register: 'SP', before: spBefore, after: regs.sp }));
      registerChanges.push(Object.freeze({ register: 'SD', before: sdBefore, after: regs.sd }));
    }
    const flagChanges: FlagChange[] = [];
    for (const flag of FLAG_NAMES) {
      const before = (flagsBefore & FLAG_MASKS[flag]) !== 0;
      const after = (regs.flags & FLAG_MASKS[flag]) !== 0;
      if (before !== after) {
        flagChanges.push(Object.freeze({ flag, before, after }));
      }
    }

    return this.#emit({
      sequence,
      pc,
      nextPc: regs.pc,
      bytes: instruction.bytes,
      instruction,
      registerChanges: Object.freeze(registerChanges),
      flagsBefore,
      flagsAfter: regs.flags,
      flagChanges: Object.freeze(flagChanges),
      memoryReads: Object.freeze(this.#readLog),
      memoryWrites: Object.freeze(this.#writeLog),
      branchTaken,
      controlTransferred: transferred,
      cycles,
      status: this.#status,
      fault,
    });
  }

  /** A precise fault: status ← FAULTED and nothing else changes; the step is not retired. */
  #raise(
    fault: CpuFault,
    bytes: readonly number[],
    instruction: DecodedInstruction | null,
    record: boolean,
  ): TraceEntry | null {
    const frozen = Object.freeze({ ...fault });
    this.#fault = frozen;
    this.#status = CpuStatus.FAULTED;
    const sequence = this.#sequence;
    this.#sequence += 1;
    if (!record) {
      return null;
    }
    const flags = this.#regs.flags;
    return this.#emit({
      sequence,
      pc: fault.pc,
      nextPc: this.#regs.pc,
      bytes,
      instruction,
      registerChanges: NO_CHANGES,
      flagsBefore: flags,
      flagsAfter: flags,
      flagChanges: NO_CHANGES,
      memoryReads: NO_CHANGES,
      memoryWrites: NO_CHANGES,
      branchTaken: null,
      controlTransferred: false,
      cycles: 0,
      status: this.#status,
      fault: frozen,
    });
  }

  #stackFault(
    code: typeof FaultCode.STACK_OVERFLOW | typeof FaultCode.STACK_UNDERFLOW,
    instruction: DecodedInstruction,
    record: boolean,
  ): TraceEntry | null {
    const detail =
      code === FaultCode.STACK_OVERFLOW
        ? `${instruction.mnemonic} with the stack full (SD = ${String(STACK_CAPACITY)})`
        : `${instruction.mnemonic} with the stack empty (SD = 0)`;
    return this.#raise(
      { code, pc: instruction.address, detail },
      instruction.bytes,
      instruction,
      record,
    );
  }

  #emit(entry: TraceEntry): TraceEntry {
    const frozen = Object.freeze(entry);
    this.#trace.push(frozen);
    return frozen;
  }

  #reg(index: number): number {
    return byteAt(this.#regs.r, index);
  }

  #load(address: number): number {
    const value = this.#memory.read(address);
    this.#reads += 1;
    if (this.#recording) {
      this.#readLog.push(Object.freeze({ address, value }));
    }
    if (this.#observer?.onMemoryRead?.({ pc: this.#currentPc, address, value }) === 'break') {
      this.#watchpointHit = true;
    }
    return value;
  }

  #store(address: number, value: number): void {
    const previous = this.#memory.read(address);
    this.#memory.write(address, value);
    this.#writes += 1;
    if (this.#recording) {
      this.#writeLog.push(Object.freeze({ address, before: previous, after: value }));
    }
    const verdict = this.#observer?.onMemoryWrite?.({
      pc: this.#currentPc,
      address,
      value,
      previous,
    });
    if (verdict === 'break') {
      this.#watchpointHit = true;
    }
  }

  /** The caller has checked SD < STACK_CAPACITY. */
  #push(value: number): void {
    const regs = this.#regs;
    this.#store(regs.sp, value);
    regs.sp -= 1;
    regs.sd += 1;
  }

  /** The caller has checked SD > 0. */
  #pop(): number {
    const regs = this.#regs;
    regs.sp += 1;
    regs.sd -= 1;
    return this.#load(regs.sp);
  }
}

/** Creates a VCPU-8 in its reset state with all memory zero. */
export function createCpu(options: CpuOptions = {}): Cpu {
  return new VirtualCpu(options);
}
