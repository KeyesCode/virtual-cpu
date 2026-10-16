import {
  type CpuFault,
  type CpuMetrics,
  type CpuObserver,
  type CpuState,
  createCpu,
  DEFAULT_MAX_INSTRUCTIONS,
  type DecodedInstruction,
  type ProgramInput,
  type TraceEntry,
} from '@vcpu/cpu-core';
import { CpuStatus, type FlagName } from '@vcpu/shared';
import { type Breakpoint, BreakpointTable, type BreakpointTarget } from './breakpoints.js';
import { DEFAULT_HISTORY_CAPACITY, HistoryBuffer, type HistoryStats } from './history.js';
import {
  type CurrentInstruction,
  currentInstruction,
  flagsOf,
  instructionText,
  type StackView,
  stackView,
  timeline,
} from './inspect.js';
import type { SourceMap } from './source-map.js';
import {
  type PendingHit,
  type Watchpoint,
  type WatchpointHit,
  WatchpointTable,
  type WatchpointTarget,
} from './watchpoints.js';

export interface DebugSessionOptions {
  /** The program to load: raw bytes at 0x00, or a `ProgramImage` (an assembled image works). */
  readonly program: ProgramInput;
  /** The assembler's source map, for breakpoints by line and source lines in inspection. */
  readonly sourceMap?: SourceMap | null;
  /** Steps `stepBack()` can undo (default 1024). 0 disables step-back. */
  readonly historyCapacity?: number;
  /** Trace entries the CPU keeps for the timeline (default 1024). */
  readonly traceCapacity?: number;
}

/**
 * Why `step()` or `run()` returned:
 * - `step`: `step()` executed its one instruction.
 * - `breakpoint`: an enabled breakpoint is at PC; that instruction has not executed.
 * - `watchpoint`: an instruction made a watched access; that instruction has executed.
 * - `halted` / `faulted`: the CPU is HALTED / FAULTED.
 * - `limit`: `maxInstructions` instructions ran.
 * - `paused`: `pause()` was called from a listener during `run()`.
 */
export type DebugStopReason =
  'step' | 'breakpoint' | 'watchpoint' | 'halted' | 'faulted' | 'limit' | 'paused';

interface StopBase {
  /** Instructions executed by this call. */
  readonly executed: number;
  /** PC now. */
  readonly pc: number;
  /** Every watchpoint hit by the last instruction executed (empty when none). */
  readonly hits: readonly WatchpointHit[];
  readonly fault: CpuFault | null;
}

export type DebugStop =
  | (StopBase & {
      readonly stopReason: 'breakpoint';
      readonly address: number;
      readonly breakpoint: Breakpoint;
    })
  | (StopBase & { readonly stopReason: 'watchpoint'; readonly hit: WatchpointHit })
  | (StopBase & { readonly stopReason: Exclude<DebugStopReason, 'breakpoint' | 'watchpoint'> });

export type StepBackResult =
  | {
      readonly ok: true;
      /** The step that was undone. */
      readonly undone: TraceEntry;
      readonly pc: number;
      /** Steps still undoable. */
      readonly remaining: number;
    }
  | { readonly ok: false; readonly reason: 'no-history'; readonly message: string };

export interface DebugRunOptions {
  /** Upper bound on instructions in this call (default 1,000,000). */
  readonly maxInstructions?: number;
}

export type StepListener = (entry: TraceEntry, hits: readonly WatchpointHit[]) => void;
export type StopListener = (stop: DebugStop) => void;

export interface DebugSession {
  /** Executes one instruction, even one with a breakpoint. */
  step(): DebugStop;
  /** Undoes the most recent step from history, or says there is no more history. */
  stepBack(): StepBackResult;
  /**
   * Executes until a breakpoint, a watchpoint hit, HALTED, FAULTED, the instruction limit or
   * `pause()`. A breakpoint at the PC the run starts from does not re-trigger when the session just
   * stopped there.
   */
  run(options?: DebugRunOptions): DebugStop;
  /** From a listener during `run()`: stop after the current instruction. Otherwise does nothing. */
  pause(): void;
  /** Resets the CPU to the loaded program and clears history. Breakpoints and watchpoints stay. */
  reset(): void;

  addBreakpoint(target: BreakpointTarget): Breakpoint;
  removeBreakpoint(id: number): boolean;
  toggleBreakpoint(id: number, enabled?: boolean): Breakpoint;
  listBreakpoints(): readonly Breakpoint[];

  addWatchpoint(target: WatchpointTarget): Watchpoint;
  removeWatchpoint(id: number): boolean;
  toggleWatchpoint(id: number, enabled?: boolean): Watchpoint;
  listWatchpoints(): readonly Watchpoint[];

  /** READY, RUNNING (inside `run()`), PAUSED (a run stopped short), HALTED or FAULTED. */
  getStatus(): CpuStatus;
  getState(): CpuState;
  getRegisters(): readonly number[];
  getFlags(): Readonly<Record<FlagName, boolean>>;
  /** `length` bytes from `start` (default: all 256 from 0x00), wrapping is not allowed. */
  readMemory(start?: number, length?: number): readonly number[];
  getStackView(): StackView;
  getCurrentInstruction(): CurrentInstruction;
  getExecutionTrace(): readonly TraceEntry[];
  /** The newest `count` trace entries (all kept ones when omitted), oldest first. */
  getTimeline(count?: number): readonly TraceEntry[];
  /** Retired instructions since reset; goes back down with `stepBack()`. */
  getInstructionCount(): number;
  getMetrics(): CpuMetrics;
  getHistoryStats(): HistoryStats;

  /** Called after every executed instruction, inside `run()` too. Returns an unsubscribe function. */
  onStep(listener: StepListener): () => void;
  /** Called when `step()` or `run()` returns. Returns an unsubscribe function. */
  onStop(listener: StopListener): () => void;
}

/** Thrown when a listener calls a method that would re-enter the session. */
export class DebugSessionBusyError extends Error {
  override readonly name = 'DebugSessionBusyError';
}

function isTerminal(status: CpuStatus): boolean {
  return status === CpuStatus.HALTED || status === CpuStatus.FAULTED;
}

class Session implements DebugSession {
  readonly #cpu;
  readonly #sourceMap: SourceMap | null;
  readonly #history: HistoryBuffer;
  readonly #breakpoints: BreakpointTable;
  readonly #watchpoints = new WatchpointTable();
  readonly #stepListeners = new Set<StepListener>();
  readonly #stopListeners = new Set<StopListener>();
  /** Hits recorded by the observer during the current instruction. */
  #pending: PendingHit[] = [];
  // What the CPU had before the next step, tracked here so a step needs no full state snapshot.
  #ir: DecodedInstruction | null = null;
  #cpuStatus: CpuStatus = CpuStatus.READY;
  #pc = 0;
  /** Set when `run()` stopped at the breakpoint at this address; the next run steps past it. */
  #resumeFrom: number | null = null;
  #running = false;
  #stoppedShort = false;
  #pauseRequested = false;
  #busy = false;

  constructor(options: DebugSessionOptions) {
    this.#sourceMap = options.sourceMap ?? null;
    this.#history = new HistoryBuffer(options.historyCapacity ?? DEFAULT_HISTORY_CAPACITY);
    this.#breakpoints = new BreakpointTable(this.#sourceMap);
    const observer: CpuObserver = {
      onMemoryRead: ({ pc, address, value }) => {
        this.#watchpoints.match('read', pc, address, value, value, this.#pending);
        return undefined;
      },
      onMemoryWrite: ({ pc, address, value, previous }) => {
        this.#watchpoints.match('write', pc, address, previous, value, this.#pending);
        return undefined;
      },
    };
    this.#cpu = createCpu({
      observer,
      ...(options.traceCapacity === undefined ? {} : { traceCapacity: options.traceCapacity }),
    });
    this.#cpu.loadProgram(options.program);
    this.#pc = this.#cpu.getState().pc;
  }

  step(): DebugStop {
    return this.#exclusive('step', () => {
      this.#resumeFrom = null;
      if (isTerminal(this.#cpuStatus)) {
        return this.#stop(this.#terminalReason(), 0, []);
      }
      const hits = this.#executeOne();
      const reason = isTerminal(this.#cpuStatus)
        ? this.#terminalReason()
        : hits.length > 0
          ? 'watchpoint'
          : 'step';
      return this.#stop(reason, 1, hits);
    });
  }

  stepBack(): StepBackResult {
    return this.#exclusive('stepBack', () => {
      const delta = this.#history.pop();
      if (delta === null) {
        return Object.freeze({
          ok: false,
          reason: 'no-history',
          message:
            this.#history.capacity === 0
              ? 'No more history: step-back is disabled (historyCapacity is 0)'
              : 'No more history: already at the oldest recorded step',
        } as const);
      }
      this.#cpu.undoStep(delta);
      this.#ir = delta.ir;
      this.#cpuStatus = delta.status;
      this.#pc = delta.entry.pc;
      this.#resumeFrom = null;
      return Object.freeze({
        ok: true,
        undone: delta.entry,
        pc: delta.entry.pc,
        remaining: this.#history.size,
      } as const);
    });
  }

  run(options: DebugRunOptions = {}): DebugStop {
    const maxInstructions = options.maxInstructions ?? DEFAULT_MAX_INSTRUCTIONS;
    if (!Number.isSafeInteger(maxInstructions) || maxInstructions < 0) {
      throw new RangeError(
        `maxInstructions must be a non-negative integer, got ${String(maxInstructions)}`,
      );
    }
    return this.#exclusive('run', () => {
      const resumeFrom = this.#resumeFrom;
      this.#resumeFrom = null;
      this.#pauseRequested = false;
      this.#running = true;
      let executed = 0;
      let hits: readonly WatchpointHit[] = [];
      try {
        for (;;) {
          if (isTerminal(this.#cpuStatus)) {
            return this.#stop(this.#terminalReason(), executed, hits);
          }
          if (hits.length > 0) {
            return this.#stop('watchpoint', executed, hits);
          }
          if (this.#pausePending()) {
            return this.#stop('paused', executed, hits);
          }
          if (executed >= maxInstructions) {
            return this.#stop('limit', executed, hits);
          }
          const pc = this.#pc;
          const breakpoint = this.#breakpoints.at(pc);
          if (breakpoint !== undefined && !(executed === 0 && resumeFrom === pc)) {
            this.#resumeFrom = pc;
            return this.#stop('breakpoint', executed, hits, breakpoint);
          }
          hits = this.#executeOne();
          executed += 1;
        }
      } finally {
        this.#running = false;
        this.#pauseRequested = false;
      }
    });
  }

  pause(): void {
    if (this.#running) {
      this.#pauseRequested = true;
    }
  }

  reset(): void {
    this.#exclusive('reset', () => {
      this.#cpu.reset();
      this.#history.clear();
      this.#ir = null;
      this.#cpuStatus = CpuStatus.READY;
      this.#pc = this.#cpu.getState().pc;
      this.#resumeFrom = null;
      this.#stoppedShort = false;
    });
  }

  addBreakpoint(target: BreakpointTarget): Breakpoint {
    return this.#breakpoints.add(target);
  }

  removeBreakpoint(id: number): boolean {
    return this.#breakpoints.remove(id);
  }

  toggleBreakpoint(id: number, enabled?: boolean): Breakpoint {
    return this.#breakpoints.toggle(id, enabled);
  }

  listBreakpoints(): readonly Breakpoint[] {
    return this.#breakpoints.list();
  }

  addWatchpoint(target: WatchpointTarget): Watchpoint {
    return this.#watchpoints.add(target);
  }

  removeWatchpoint(id: number): boolean {
    return this.#watchpoints.remove(id);
  }

  toggleWatchpoint(id: number, enabled?: boolean): Watchpoint {
    return this.#watchpoints.toggle(id, enabled);
  }

  listWatchpoints(): readonly Watchpoint[] {
    return this.#watchpoints.list();
  }

  getStatus(): CpuStatus {
    if (isTerminal(this.#cpuStatus)) {
      return this.#cpuStatus;
    }
    if (this.#running) {
      return CpuStatus.RUNNING;
    }
    return this.#stoppedShort ? CpuStatus.PAUSED : CpuStatus.READY;
  }

  getState(): CpuState {
    return this.#cpu.getState();
  }

  getRegisters(): readonly number[] {
    return this.#cpu.getState().registers;
  }

  getFlags(): Readonly<Record<FlagName, boolean>> {
    return flagsOf(this.#cpu.getState().flags);
  }

  readMemory(start = 0, length?: number): readonly number[] {
    const memory = this.#cpu.getState().memory;
    const count = length ?? memory.length - start;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(count) ||
      start < 0 ||
      count < 0 ||
      start + count > memory.length
    ) {
      throw new RangeError(
        `readMemory(${String(start)}, ${String(length)}) is outside the ${String(memory.length)}-byte memory`,
      );
    }
    return Object.freeze(memory.slice(start, start + count));
  }

  getStackView(): StackView {
    return stackView(this.#cpu.getState());
  }

  getCurrentInstruction(): CurrentInstruction {
    return currentInstruction(this.#cpu.getState(), this.#sourceMap);
  }

  getExecutionTrace(): readonly TraceEntry[] {
    return this.#cpu.getExecutionTrace();
  }

  getTimeline(count?: number): readonly TraceEntry[] {
    return timeline(this.#cpu.getExecutionTrace(), count);
  }

  getInstructionCount(): number {
    return this.#cpu.getMetrics().instructions;
  }

  getMetrics(): CpuMetrics {
    return this.#cpu.getMetrics();
  }

  getHistoryStats(): HistoryStats {
    return this.#history.stats();
  }

  onStep(listener: StepListener): () => void {
    this.#stepListeners.add(listener);
    return () => this.#stepListeners.delete(listener);
  }

  onStop(listener: StopListener): () => void {
    this.#stopListeners.add(listener);
    return () => this.#stopListeners.delete(listener);
  }

  /** Runs a mutating method, refusing re-entry from a listener. */
  #exclusive<T>(method: string, body: () => T): T {
    if (this.#busy) {
      throw new DebugSessionBusyError(
        `${method}() cannot be called while the session is executing`,
      );
    }
    this.#busy = true;
    try {
      return body();
    } finally {
      this.#busy = false;
    }
  }

  /** Executes one instruction, records its delta and returns the watchpoint hits it made. */
  #executeOne(): readonly WatchpointHit[] {
    const before = { ir: this.#ir, status: this.#cpuStatus };
    this.#pending = [];
    const { status, entry } = this.#cpu.step();
    if (entry === null) {
      throw new Error('The CPU did not execute a step from a non-terminal status');
    }
    this.#history.push(Object.freeze({ entry, ...before }));
    this.#cpuStatus = status;
    this.#pc = entry.nextPc;
    // IR holds the last retired instruction; a precisely faulting step (0 cycles) retires nothing.
    if (entry.cycles > 0) {
      this.#ir = entry.instruction;
    }
    const text = instructionText(entry.bytes);
    const hits = Object.freeze(
      this.#pending.map((hit) => Object.freeze({ ...hit, instruction: entry.instruction, text })),
    );
    this.#pending = [];
    for (const listener of this.#stepListeners) {
      listener(entry, hits);
    }
    return hits;
  }

  /** Read through a method because a step listener sets it while `run()` is in its loop. */
  #pausePending(): boolean {
    return this.#pauseRequested;
  }

  #terminalReason(): 'halted' | 'faulted' {
    return this.#cpuStatus === CpuStatus.HALTED ? 'halted' : 'faulted';
  }

  #stop(
    reason: DebugStopReason,
    executed: number,
    hits: readonly WatchpointHit[],
    breakpoint?: Breakpoint,
  ): DebugStop {
    const state = this.#cpu.getState();
    const base = { executed, pc: state.pc, hits, fault: state.fault };
    let stop: DebugStop;
    if (reason === 'breakpoint' && breakpoint !== undefined) {
      stop = { ...base, stopReason: 'breakpoint', address: breakpoint.address, breakpoint };
    } else if (reason === 'watchpoint' && hits[0] !== undefined) {
      stop = { ...base, stopReason: 'watchpoint', hit: hits[0] };
    } else if (reason !== 'breakpoint' && reason !== 'watchpoint') {
      stop = { ...base, stopReason: reason };
    } else {
      throw new Error(`A ${reason} stop needs its breakpoint or hit`);
    }
    if (reason !== 'step') {
      this.#stoppedShort = !isTerminal(this.#cpuStatus);
    }
    const frozen = Object.freeze(stop);
    for (const listener of this.#stopListeners) {
      listener(frozen);
    }
    return frozen;
  }
}

/** Creates a debug session with the program loaded and the CPU in its reset state. */
export function createDebugSession(options: DebugSessionOptions): DebugSession {
  return new Session(options);
}
