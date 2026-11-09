import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { STAGE_STATES, type StageState } from '@vcpu/research-core';
import type { StageContext, StageHandler, StageHandlers, StageOutcome } from './handlers.js';

/** One line of the fixture journal. */
export interface FixtureJournalEntry {
  readonly experimentId: string;
  readonly stage: StageState;
  readonly attempt: number;
  /** `start` and `done` bracket real work; `reused` is a re-run that found its own output. */
  readonly event: 'start' | 'done' | 'reused' | 'command';
  readonly pid: number;
  /** The pid of the command a slow stage started. */
  readonly commandPid?: number;
}

export interface FixtureOptions {
  /** Simulated work per stage, in ms. */
  readonly delayMs?: number;
  /**
   * Scripted results: return an outcome to end the attempt with it, or undefined for success. May
   * also throw (a `StageFailure`, say).
   */
  readonly script?: (context: StageContext) => StageOutcome | undefined;
  /**
   * A stage that runs a real command (`sleep`) for `ms`, started with the stage's abort signal, so
   * a cancel, timeout or shutdown kills the process.
   */
  readonly slowStage?: { readonly stage: StageState; readonly ms: number };
  /**
   * A JSON-lines file of what ran. Shared across processes, so a restarted worker sees the stage
   * outputs a killed one completed.
   */
  readonly journal?: string;
}

export interface FixtureStats {
  inFlight: number;
  maxInFlight: number;
  readonly calls: { experimentId: string; stage: StageState; attempt: number }[];
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}

function runCommand(seconds: number, signal: AbortSignal, onStart: (pid: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('sleep', [String(seconds)], { signal, stdio: 'ignore' });
    if (child.pid !== undefined) onStart(child.pid);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`sleep exited ${String(code)}`));
    });
  });
}

/**
 * Deterministic stage handlers for tests and for exercising the orchestration without EDA tools.
 * Each stage is idempotent the way a real one must be: it records its output under the stage's
 * idempotency key, and a re-run that finds it does no work.
 */
export function createFixtureHandlers(options: FixtureOptions = {}): {
  handlers: StageHandlers;
  stats: FixtureStats;
} {
  const stats: FixtureStats = { inFlight: 0, maxInFlight: 0, calls: [] };
  const completed = new Set<string>();

  const record = (entry: FixtureJournalEntry) => {
    if (options.journal) appendFileSync(options.journal, `${JSON.stringify(entry)}\n`);
  };
  const isCompleted = (key: string) => {
    if (completed.has(key)) return true;
    if (!options.journal || !existsSync(options.journal)) return false;
    return readFileSync(options.journal, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as FixtureJournalEntry)
      .some((entry) => entry.event === 'done' && `${entry.experimentId}:${entry.stage}` === key);
  };

  const handler: StageHandler = async (context) => {
    const { experimentId, stage, attempt } = context;
    const entry = { experimentId, stage, attempt, pid: process.pid };
    stats.calls.push({ experimentId, stage, attempt });
    if (isCompleted(context.idempotencyKey)) {
      record({ ...entry, event: 'reused' });
      return { ok: true };
    }
    stats.inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    try {
      record({ ...entry, event: 'start' });
      if (options.slowStage?.stage === stage) {
        await runCommand(Math.ceil(options.slowStage.ms / 1000), context.signal, (commandPid) => {
          record({ ...entry, event: 'command', commandPid });
        });
      } else if (options.delayMs) {
        await sleep(options.delayMs, context.signal);
      }
      const scripted = options.script?.(context);
      if (scripted && !scripted.ok) return scripted;
      completed.add(context.idempotencyKey);
      record({ ...entry, event: 'done' });
      return { ok: true };
    } finally {
      stats.inFlight -= 1;
    }
  };

  return {
    handlers: Object.fromEntries(STAGE_STATES.map((stage) => [stage, handler])),
    stats,
  };
}
