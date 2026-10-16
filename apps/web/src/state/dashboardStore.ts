import { assemble, type AssembleResult } from '@vcpu/assembler';
import type { CpuState, TraceEntry } from '@vcpu/cpu-core';
import {
  BreakpointError,
  createDebugSession,
  type CurrentInstruction,
  type DebugSession,
  type DebugStop,
  type HistoryStats,
} from '@vcpu/debugger';
import { CpuStatus } from '@vcpu/shared';
import { DEFAULT_EXAMPLE, findExample } from '../lib/examples';

/** Speed slider stops, in instructions per second. `max` runs unthrottled batches every frame. */
export const SPEEDS = [1, 2, 4, 8, 10, 20, 50, 100, 500, 1000, 5000, 'max'] as const;
export type Speed = (typeof SPEEDS)[number];
export const DEFAULT_SPEED: Speed = 4;
/** At or below this speed the instruction-cycle strip animates each instruction. */
export const ANIMATED_SPEED_LIMIT = 10;
/** Steps `Step back` can undo. */
export const HISTORY_CAPACITY = 1024;

/** In `max` mode: instructions per `run()` call, and how long one frame may keep calling it. */
const MAX_BATCH = 4096;
const MAX_FRAME_MS = 10;

/** What the CPU panels show, rebuilt once per action or animation frame. */
export interface CpuView {
  /** RUNNING while the scheduler is running; otherwise the debug session's status. */
  readonly status: CpuStatus;
  readonly state: CpuState;
  /** The instruction at PC, about to execute. */
  readonly current: CurrentInstruction;
  /** The most recent executed instruction (after a step back, the one before the undone step). */
  readonly lastEntry: TraceEntry | null;
  readonly instructionCount: number;
  /** Addresses of enabled breakpoints. */
  readonly breakpointAddresses: readonly number[];
  readonly history: HistoryStats;
}

export interface DashboardSnapshot {
  /** The example the editor was last loaded from, or `null` once none applies. */
  readonly exampleName: string | null;
  readonly source: string;
  /** Assembly of `source`, kept current as it is edited. */
  readonly assembly: AssembleResult;
  /** The source the CPU was loaded from. */
  readonly loadedSource: string;
  /** Source lines with a breakpoint (1-based). */
  readonly breakpointLines: ReadonlySet<number>;
  readonly speed: Speed;
  readonly running: boolean;
  readonly cpu: CpuView;
  /** Why the last run or step stopped. */
  readonly lastStop: DebugStop | null;
  /** A short note for the status line (e.g. no more history). */
  readonly notice: string | null;
}

/** Animation-frame hooks, injectable so tests can drive the scheduler by hand. */
export interface FrameScheduler {
  request(callback: (time: number) => void): number;
  cancel(id: number): void;
  now(): number;
}

const browserScheduler: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => {
    cancelAnimationFrame(id);
  },
  now: () => performance.now(),
};

interface Loaded {
  readonly source: string;
  readonly session: DebugSession;
}

/**
 * One debug session per dashboard. All CPU behaviour comes from `@vcpu/debugger`; this store only
 * paces it (a `requestAnimationFrame` loop) and turns its state into immutable snapshots for React's
 * `useSyncExternalStore`. Snapshots are rebuilt at most once per frame while running.
 */
export class DashboardStore {
  readonly #scheduler: FrameScheduler;
  readonly #listeners = new Set<() => void>();
  #exampleName: string | null;
  #source: string;
  #assembly: AssembleResult;
  #loaded: Loaded;
  #breakpointLines = new Set<number>();
  #speed: Speed = DEFAULT_SPEED;
  #running = false;
  #frameId: number | null = null;
  #lastFrameTime: number | null = null;
  /** Fractional instructions owed to the paced run. */
  #budget = 0;
  #lastStop: DebugStop | null = null;
  #notice: string | null = null;
  #snapshot: DashboardSnapshot;

  constructor(options: { scheduler?: FrameScheduler; example?: string } = {}) {
    this.#scheduler = options.scheduler ?? browserScheduler;
    const example = findExample(options.example ?? DEFAULT_EXAMPLE);
    this.#exampleName = example?.name ?? null;
    this.#source = example?.source ?? '';
    this.#assembly = assemble(this.#source);
    this.#loaded = this.#createSession();
    this.#snapshot = this.#buildSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): DashboardSnapshot => this.#snapshot;

  /** Replaces the editor text and re-assembles it for live diagnostics. */
  setSource(source: string): void {
    if (source === this.#source) return;
    this.#source = source;
    this.#assembly = assemble(source);
    this.#notice = null;
    this.#publish();
  }

  /** Puts an example in the editor. It runs once loaded into the CPU. */
  selectExample(name: string): void {
    const example = findExample(name);
    if (example === undefined) return;
    this.#exampleName = example.name;
    this.#breakpointLines = new Set();
    this.#source = example.source;
    this.#assembly = assemble(example.source);
    if (this.#source === this.#loaded.source) {
      this.#applyBreakpoints(this.#loaded.session);
    }
    this.#notice = null;
    this.#publish();
  }

  /** Re-assembles the editor text now and reports the result in the status line. */
  assembleNow(): void {
    this.#assembly = assemble(this.#source);
    const errors = this.#assembly.diagnostics.filter((d) => d.severity === 'error').length;
    this.#notice = errors === 0 ? 'Assembled. Load it into the CPU to run it.' : 'Assembly failed.';
    this.#publish();
  }

  /** Loads the assembled editor text into a fresh debug session. */
  load(): void {
    if (!this.#assembly.ok) return;
    this.#stopScheduler();
    this.#loaded = this.#createSession();
    this.#lastStop = null;
    this.#notice = null;
    this.#publish();
  }

  run(): void {
    if (this.#running || this.#isTerminal()) return;
    const session = this.#loaded.session;
    this.#notice = null;
    this.#budget = 1;
    // Resume past a breakpoint the CPU is sitting on, as a debugger's Continue does.
    if (session.listBreakpoints().some((b) => b.enabled && b.address === session.getState().pc)) {
      this.#lastStop = session.step();
      this.#budget = 0;
      if (this.#lastStop.stopReason !== 'step') {
        this.#publish();
        return;
      }
    }
    this.#running = true;
    this.#lastFrameTime = null;
    this.#scheduleFrame();
    this.#publish();
  }

  pause(): void {
    if (!this.#running) return;
    this.#stopScheduler();
    this.#publish();
  }

  step(): void {
    if (this.#running) return;
    this.#lastStop = this.#loaded.session.step();
    this.#notice = null;
    this.#publish();
  }

  stepBack(): void {
    if (this.#running) return;
    const result = this.#loaded.session.stepBack();
    this.#lastStop = null;
    this.#notice = result.ok ? null : result.message;
    this.#publish();
  }

  reset(): void {
    this.#stopScheduler();
    this.#loaded.session.reset();
    this.#lastStop = null;
    this.#notice = null;
    this.#publish();
  }

  setSpeed(speed: Speed): void {
    if (speed === this.#speed) return;
    this.#speed = speed;
    this.#budget = Math.min(this.#budget, 1);
    this.#publish();
  }

  /**
   * Adds or removes a breakpoint on a source line. Only lines that assemble to an instruction
   * take one. It applies to the CPU at once when the editor still holds the loaded program, and
   * otherwise from the next Load.
   */
  toggleBreakpoint(line: number): void {
    const lines = new Set(this.#breakpointLines);
    if (lines.has(line)) {
      lines.delete(line);
    } else if (lineHasInstruction(this.#assembly, line)) {
      lines.add(line);
    } else {
      return;
    }
    this.#breakpointLines = lines;
    if (this.#source === this.#loaded.source) {
      this.#applyBreakpoints(this.#loaded.session);
    }
    this.#publish();
  }

  /** The assembled program as a raw `.bin`: bytes 0x00 through the last emitted byte. */
  programBinary(): Uint8Array<ArrayBuffer> | null {
    if (!this.#assembly.ok) return null;
    const end = this.#assembly.bytes.ranges.reduce((max, range) => Math.max(max, range.end), -1);
    return new Uint8Array(this.#assembly.bytes.image.subarray(0, end + 1));
  }

  /** Stops the scheduler; the store stays usable. */
  dispose(): void {
    this.#stopScheduler();
  }

  #createSession(): Loaded {
    const session = createDebugSession({
      program: this.#assembly.bytes.image,
      sourceMap: this.#assembly.sourceMap,
      historyCapacity: HISTORY_CAPACITY,
    });
    this.#applyBreakpoints(session);
    return { source: this.#source, session };
  }

  /** Makes the session's breakpoints match `#breakpointLines`, dropping lines with no code. */
  #applyBreakpoints(session: DebugSession): void {
    for (const breakpoint of session.listBreakpoints()) {
      session.removeBreakpoint(breakpoint.id);
    }
    for (const line of [...this.#breakpointLines]) {
      try {
        session.addBreakpoint({ line });
      } catch (error) {
        if (!(error instanceof BreakpointError)) throw error;
        this.#breakpointLines.delete(line);
      }
    }
  }

  #isTerminal(): boolean {
    const status = this.#loaded.session.getStatus();
    return status === CpuStatus.HALTED || status === CpuStatus.FAULTED;
  }

  #scheduleFrame(): void {
    this.#frameId = this.#scheduler.request(this.#frame);
  }

  #stopScheduler(): void {
    this.#running = false;
    if (this.#frameId !== null) {
      this.#scheduler.cancel(this.#frameId);
      this.#frameId = null;
    }
  }

  #frame = (time: number): void => {
    this.#frameId = null;
    if (!this.#running) return;
    const session = this.#loaded.session;
    let stop: DebugStop | null = null;
    if (this.#speed === 'max') {
      const deadline = this.#scheduler.now() + MAX_FRAME_MS;
      do {
        stop = session.run({ maxInstructions: MAX_BATCH });
      } while (stop.stopReason === 'limit' && this.#scheduler.now() < deadline);
    } else {
      const elapsed = this.#lastFrameTime === null ? 0 : time - this.#lastFrameTime;
      // Cap the debt so a backgrounded tab does not burst when it comes back.
      this.#budget = Math.min(this.#budget + (elapsed / 1000) * this.#speed, 1 + this.#speed / 10);
      const count = Math.floor(this.#budget);
      if (count > 0) {
        this.#budget -= count;
        stop = session.run({ maxInstructions: count });
      }
    }
    this.#lastFrameTime = time;
    if (stop !== null) {
      this.#lastStop = stop;
      if (stop.stopReason !== 'limit') this.#running = false;
    }
    if (this.#running) this.#scheduleFrame();
    if (stop !== null || !this.#running) this.#publish();
  };

  #publish(): void {
    this.#snapshot = this.#buildSnapshot();
    for (const listener of this.#listeners) listener();
  }

  #buildSnapshot(): DashboardSnapshot {
    const session = this.#loaded.session;
    return Object.freeze({
      exampleName: this.#exampleName,
      source: this.#source,
      assembly: this.#assembly,
      loadedSource: this.#loaded.source,
      breakpointLines: new Set(this.#breakpointLines),
      speed: this.#speed,
      running: this.#running,
      cpu: Object.freeze({
        status: this.#running ? CpuStatus.RUNNING : session.getStatus(),
        state: session.getState(),
        current: session.getCurrentInstruction(),
        lastEntry: session.getTimeline(1)[0] ?? null,
        instructionCount: session.getInstructionCount(),
        breakpointAddresses: session
          .listBreakpoints()
          .filter((b) => b.enabled)
          .map((b) => b.address),
        history: session.getHistoryStats(),
      }),
      lastStop: this.#lastStop,
      notice: this.#notice,
    });
  }
}

/** True when `line` assembled to (the start of) an instruction. */
export function lineHasInstruction(assembly: AssembleResult, line: number): boolean {
  for (const entry of assembly.sourceMap.values()) {
    if (entry.line === line && !entry.text.startsWith('.')) return true;
  }
  return false;
}
