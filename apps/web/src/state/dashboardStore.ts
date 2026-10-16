import { assemble, type AssembleResult } from '@vcpu/assembler';
import type { CpuMetrics, CpuState, TraceEntry } from '@vcpu/cpu-core';
import {
  BreakpointError,
  createDebugSession,
  type CurrentInstruction,
  type DebugSession,
  type DebugStop,
  type HistoryStats,
  type StackView,
  type Watchpoint,
  type WatchpointHit,
  type WatchpointTarget,
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
/** Watchpoint hits the Watchpoints tab keeps; the oldest is dropped beyond it. */
export const HIT_LOG_CAPACITY = 100;
/** Host throughput is measured over this sliding window. */
export const THROUGHPUT_WINDOW_MS = 1000;

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
  /** Every trace entry the CPU still keeps (bounded), oldest first. */
  readonly trace: readonly TraceEntry[];
  readonly stack: StackView;
  readonly metrics: CpuMetrics;
  readonly watchpoints: readonly Watchpoint[];
}

/** A watchpoint hit and the step (trace sequence) that made it. */
export interface WatchHitRecord {
  readonly step: number;
  readonly hit: WatchpointHit;
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
  /** Watchpoint hits since load or reset, oldest first (at most `HIT_LOG_CAPACITY`). */
  readonly watchHits: readonly WatchHitRecord[];
  /**
   * Host throughput in instructions per second, measured here in the browser over a
   * `THROUGHPUT_WINDOW_MS` sliding window. While running it is `null` until a full window has
   * passed; once stopped it holds the last run's figure, or `null` when that run was too short.
   */
  readonly throughput: number | null;
}

interface ThroughputSample {
  readonly time: number;
  readonly count: number;
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
  /** Watchpoints, re-applied to every new session; kept in the session's list order. */
  #watchTargets: WatchpointTarget[] = [];
  #watchHits: WatchHitRecord[] = [];
  #samples: ThroughputSample[] = [];
  #throughput: number | null = null;
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
    this.#watchHits = [];
    this.#throughput = null;
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
    this.#samples = [];
    this.#throughput = null;
    this.#scheduleFrame();
    this.#publish();
  }

  pause(): void {
    if (!this.#running) return;
    this.#stopScheduler();
    this.#finishThroughput();
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
    if (result.ok) {
      const undone = result.undone.sequence;
      this.#watchHits = this.#watchHits.filter((record) => record.step < undone);
    }
    this.#lastStop = null;
    this.#notice = result.ok ? null : result.message;
    this.#publish();
  }

  reset(): void {
    this.#stopScheduler();
    this.#loaded.session.reset();
    this.#lastStop = null;
    this.#notice = null;
    this.#watchHits = [];
    this.#throughput = null;
    this.#publish();
  }

  setSpeed(speed: Speed): void {
    if (speed === this.#speed) return;
    this.#speed = speed;
    this.#budget = Math.min(this.#budget, 1);
    // A new pace starts a new measurement.
    this.#samples = [];
    this.#throughput = null;
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

  /** Adds a watchpoint to the CPU; it stays across Load and Reset. Throws `WatchpointError`. */
  addWatchpoint(target: WatchpointTarget): Watchpoint {
    const watchpoint = this.#loaded.session.addWatchpoint(target);
    this.#watchTargets = [...this.#watchTargets, target];
    this.#publish();
    return watchpoint;
  }

  removeWatchpoint(id: number): void {
    const session = this.#loaded.session;
    const index = session.listWatchpoints().findIndex((w) => w.id === id);
    if (index < 0 || !session.removeWatchpoint(id)) return;
    this.#watchTargets = this.#watchTargets.filter((_, i) => i !== index);
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
    for (const target of this.#watchTargets) {
      session.addWatchpoint(target);
    }
    session.onStep((entry, hits) => {
      if (hits.length === 0) return;
      const records = hits.map((hit) => Object.freeze({ step: entry.sequence, hit }));
      this.#watchHits = [...this.#watchHits, ...records].slice(-HIT_LOG_CAPACITY);
    });
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
    if (this.#samples.length === 0) {
      this.#samples.push({ time: this.#scheduler.now(), count: session.getInstructionCount() });
    }
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
    this.#sampleThroughput(session.getInstructionCount());
    if (this.#running) {
      this.#throughput = this.#windowRate(THROUGHPUT_WINDOW_MS);
    } else {
      this.#finishThroughput();
    }
    if (this.#running) this.#scheduleFrame();
    if (stop !== null || !this.#running) this.#publish();
  };

  /** Records the instruction count now and drops samples older than one window. */
  #sampleThroughput(count: number): void {
    const now = this.#scheduler.now();
    this.#samples.push({ time: now, count });
    // Keep the newest sample at or before the window start, so a full window spans the window.
    while (
      this.#samples.length > 2 &&
      (this.#samples[1]?.time ?? now) <= now - THROUGHPUT_WINDOW_MS
    ) {
      this.#samples.shift();
    }
  }

  /** Instructions per second over the kept samples, or `null` when they span less than `minSpan` ms. */
  #windowRate(minSpan: number): number | null {
    const first = this.#samples[0];
    const last = this.#samples.at(-1);
    if (first === undefined || last === undefined) return null;
    const span = last.time - first.time;
    if (span <= 0 || span < minSpan) return null;
    return ((last.count - first.count) * 1000) / span;
  }

  /**
   * Fixes the stopped run's throughput. A paced run needs a full window (its first instruction
   * runs at once, so a shorter span overstates the pace); an unthrottled one counts at any length.
   */
  #finishThroughput(): void {
    this.#throughput = this.#windowRate(this.#speed === 'max' ? 0 : THROUGHPUT_WINDOW_MS);
    this.#samples = [];
  }

  #publish(): void {
    this.#snapshot = this.#buildSnapshot();
    for (const listener of this.#listeners) listener();
  }

  #buildSnapshot(): DashboardSnapshot {
    const session = this.#loaded.session;
    const trace = session.getExecutionTrace();
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
        lastEntry: trace.at(-1) ?? null,
        instructionCount: session.getInstructionCount(),
        breakpointAddresses: session
          .listBreakpoints()
          .filter((b) => b.enabled)
          .map((b) => b.address),
        history: session.getHistoryStats(),
        trace,
        stack: session.getStackView(),
        metrics: session.getMetrics(),
        watchpoints: session.listWatchpoints(),
      }),
      lastStop: this.#lastStop,
      notice: this.#notice,
      watchHits: this.#watchHits,
      throughput: this.#throughput,
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
