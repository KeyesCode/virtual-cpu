import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseRtlState, parseRtlTraceJsonl, type RtlState, type RtlTraceStep } from './compare.js';

/** What the RTL runner did with a program, or why it could not say. */
export type RtlRun =
  | { readonly ok: true; readonly state: RtlState; readonly trace: readonly RtlTraceStep[] }
  | { readonly ok: false; readonly error: string };

export interface RtlRunFiles {
  /** The `$readmemh` image to run. */
  readonly image: string;
  /** Where the runner writes its end state and trace. */
  readonly state: string;
  readonly trace: string;
}

/**
 * Clock cycles allowed per step before the runner gives up. An instruction takes 4 to 6 clocks
 * (docs/hardware/vcpu8-microarchitecture.md), and an iterative divider would add about 8, so this
 * only stops an RTL that hangs without retiring: a `max_cycles` mismatch, not a stuck run.
 */
export const CYCLES_PER_STEP_LIMIT = 32;

/** Wall-clock limit for one runner process. */
export const RTL_TIMEOUT_MS = 60_000;

/**
 * Runs `build/sim/vcpu8_sim` (or a mutant's copy) on one image with the step limit the reference
 * used, and parses its outputs. A runner that crashes, times out or writes something unreadable
 * is reported with its stderr, never thrown.
 */
export async function runRtl(sim: string, files: RtlRunFiles, maxSteps: number): Promise<RtlRun> {
  const args = [
    '--image',
    files.image,
    '--max-steps',
    String(maxSteps),
    '--max-cycles',
    String(maxSteps * CYCLES_PER_STEP_LIMIT + 64),
    '--state',
    files.state,
    '--trace',
    files.trace,
    '--quiet',
  ];
  const failure = await new Promise<string | null>((resolve) => {
    execFile(
      sim,
      args,
      { timeout: RTL_TIMEOUT_MS, maxBuffer: 1 << 20 },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve(null);
        } else {
          const why = error.killed ? `timed out after ${String(RTL_TIMEOUT_MS)} ms` : error.message;
          resolve(
            `the RTL runner failed (${why.trim()})${stderr === '' ? '' : `: ${stderr.trim()}`}`,
          );
        }
      },
    );
  });
  if (failure !== null) {
    return { ok: false, error: failure };
  }
  try {
    const [state, trace] = await Promise.all([
      readFile(files.state, 'utf8'),
      readFile(files.trace, 'utf8'),
    ]);
    return { ok: true, state: parseRtlState(state), trace: parseRtlTraceJsonl(trace) };
  } catch (error) {
    return { ok: false, error: `cannot read the runner's output: ${(error as Error).message}` };
  }
}
