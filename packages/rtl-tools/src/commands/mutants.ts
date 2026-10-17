import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HW_DIR } from '../verify/corpora.js';
import { describeMismatch, replayCommand, runVerify, type VerifyOptions } from './verify.js';

/**
 * Proves the differential verification can fail: each mutant is a copy of `core/` in
 * `build/mutants/<id>/` with one textual change from `scripts/mutants.txt`, built into its own
 * RTL runner, and `verify` must report at least one mismatching case on it. The real `core/` is
 * only read.
 */

export const MUTANTS_DEFAULTS = {
  list: join(HW_DIR, 'scripts', 'mutants.txt'),
  core: join(HW_DIR, 'core'),
  out: join(HW_DIR, 'build', 'mutants'),
  simTop: join(HW_DIR, 'tb', 'sim', 'vcpu8_sim_top.sv'),
  simCpp: join(HW_DIR, 'tb', 'sim', 'vcpu8_sim.cpp'),
  report: join(HW_DIR, 'build', 'reports', 'mutants.json'),
} as const;

export interface Mutant {
  readonly id: string;
  /** A file in `core/`. */
  readonly file: string;
  /** The bug it plants, in words. */
  readonly what: string;
  /** Text that must occur exactly once in the file, and what replaces it. */
  readonly from: string;
  readonly to: string;
}

export class MutantError extends Error {
  override readonly name = 'MutantError';
}

/**
 * `mutants.txt`: blocks of `[id]` followed by `file:`, `what:`, `from:` and `to:` lines. `#`
 * starts a comment line. Values are trimmed.
 */
export function parseMutants(text: string): Mutant[] {
  const mutants: Mutant[] = [];
  let current: Record<string, string> | null = null;
  const finish = () => {
    if (current === null) return;
    const { id, file, what, from, to } = current;
    if (
      id === undefined ||
      file === undefined ||
      what === undefined ||
      from === undefined ||
      to === undefined
    ) {
      throw new MutantError(`mutant ${id ?? '?'} needs file, what, from and to`);
    }
    if (from === to) throw new MutantError(`mutant ${id}: from and to are the same`);
    mutants.push({ id, file, what, from, to });
  };
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const header = /^\[([a-z0-9-]+)\]$/.exec(line);
    if (header?.[1] !== undefined) {
      finish();
      if (mutants.some((m) => m.id === header[1])) {
        throw new MutantError(`line ${String(index + 1)}: duplicate mutant ${header[1]}`);
      }
      current = { id: header[1] };
      return;
    }
    const field = /^(file|what|from|to):\s*(.*)$/.exec(line);
    if (current === null || field?.[1] === undefined || field[2] === undefined) {
      throw new MutantError(
        `line ${String(index + 1)}: expected [id] or file/what/from/to: ${line}`,
      );
    }
    current[field[1]] = field[2].trim();
  });
  finish();
  return mutants;
}

/**
 * Copies every `core/*.sv` into `outCore` and applies the mutation. Throws when the `from` text
 * no longer occurs exactly once: a mutant that stopped applying is an error, never a skip.
 */
export function applyMutant(core: string, outCore: string, mutant: Mutant): void {
  rmSync(outCore, { recursive: true, force: true });
  mkdirSync(outCore, { recursive: true });
  const files = readdirSync(core).filter((f) => f.endsWith('.sv'));
  if (!files.includes(mutant.file)) {
    throw new MutantError(`mutant ${mutant.id}: core/${mutant.file} does not exist`);
  }
  for (const file of files) {
    let text = readFileSync(join(core, file), 'utf8');
    if (file === mutant.file) {
      const count = text.split(mutant.from).length - 1;
      if (count !== 1) {
        throw new MutantError(
          `mutant ${mutant.id} no longer applies: "${mutant.from}" occurs ${String(count)} times in core/${file} (expected once); update scripts/mutants.txt`,
        );
      }
      text = text.replace(mutant.from, () => mutant.to);
    }
    writeFileSync(join(outCore, file), text);
  }
}

/** The mutant's core sources in the Makefile's order: packages first, then the rest, sorted. */
function rtlSources(core: string): string[] {
  const files = readdirSync(core)
    .filter((f) => f.endsWith('.sv'))
    .sort();
  const pkgs = files.filter((f) => f.endsWith('_pkg.sv'));
  return [...pkgs, ...files.filter((f) => !pkgs.includes(f))].map((f) => join(core, f));
}

export interface MutantsOptions {
  readonly list: string;
  readonly core: string;
  readonly out: string;
  readonly simTop: string;
  readonly simCpp: string;
  readonly verilator: string;
  readonly report: string;
  /** Only this mutant, if set. */
  readonly only?: string | undefined;
  /** The verify run to repeat on each mutant (sim, work, failures and reports are replaced). */
  readonly verify: VerifyOptions;
}

interface MutantResult {
  readonly id: string;
  readonly what: string;
  readonly caught: boolean;
  readonly error: string | null;
  readonly failedCases: number;
  readonly totalCases: number;
  readonly firstFailure: string | null;
  readonly replay: string | null;
}

/** Builds and verifies every mutant; exit code 0 only when every one was caught. */
export async function runMutants(
  options: MutantsOptions,
  write: (text: string) => void,
): Promise<number> {
  let mutants: Mutant[];
  try {
    mutants = parseMutants(readFileSync(options.list, 'utf8')).filter(
      (m) => options.only === undefined || m.id === options.only,
    );
  } catch (error) {
    write(`mutants: ${(error as Error).message}\n`);
    return 2;
  }
  if (mutants.length === 0) {
    write(
      `mutants: no mutant${options.only === undefined ? '' : ` named ${options.only}`} in ${options.list}\n`,
    );
    return 2;
  }
  write(`mutants: ${String(mutants.length)} from ${options.list}\n`);

  const results: MutantResult[] = [];
  for (const mutant of mutants) {
    const dir = join(options.out, mutant.id);
    const fail = (error: string) => {
      results.push({
        id: mutant.id,
        what: mutant.what,
        caught: false,
        error,
        failedCases: 0,
        totalCases: 0,
        firstFailure: null,
        replay: null,
      });
      write(`ERROR    ${mutant.id}: ${error}\n`);
    };
    try {
      applyMutant(options.core, join(dir, 'core'), mutant);
    } catch (error) {
      fail((error as Error).message);
      continue;
    }

    const sim = join(dir, 'sim', 'vcpu8_sim');
    mkdirSync(join(dir, 'sim'), { recursive: true });
    const build = spawnSync(
      options.verilator,
      [
        '--cc',
        '--exe',
        '--build',
        '-O3',
        '-Wall',
        '-Wno-fatal',
        '--quiet',
        '--top-module',
        'vcpu8_sim_top',
        '-CFLAGS',
        '-Wno-unknown-warning-option',
        '-Mdir',
        join(dir, 'sim', 'obj'),
        '-o',
        sim,
        ...rtlSources(join(dir, 'core')),
        options.simTop,
        options.simCpp,
      ],
      { encoding: 'utf8', maxBuffer: 64 << 20 },
    );
    writeFileSync(join(dir, 'build.log'), `${build.stdout}${build.stderr}`);
    if (build.error !== undefined || build.status !== 0) {
      fail(
        `the mutant does not build (${build.error?.message ?? `exit ${String(build.status)}`}); see ${join(dir, 'build.log')}`,
      );
      continue;
    }

    let log = '';
    const outcome = await runVerify(
      {
        ...options.verify,
        sim,
        work: join(dir, 'work'),
        failures: join(dir, 'failures'),
        reports: join(dir, 'reports'),
        keepFailures: 5,
      },
      (text) => {
        log += text;
      },
    );
    writeFileSync(join(dir, 'verify.log'), log);
    const first = outcome.failures[0];
    const caught = outcome.exitCode === 1 && outcome.failures.length > 0;
    const total = outcome.summaries.reduce((sum, s) => sum + s.cases, 0);
    const result: MutantResult = {
      id: mutant.id,
      what: mutant.what,
      caught,
      error:
        outcome.exitCode > 1
          ? `verify exited ${String(outcome.exitCode)}; see ${join(dir, 'verify.log')}`
          : null,
      failedCases: outcome.failures.length,
      totalCases: total,
      firstFailure:
        first === undefined
          ? null
          : `${first.name}: ${first.error ?? describeMismatch(first.mismatches[0])}`,
      replay: first?.saved == null ? null : replayCommand(first.saved),
    };
    results.push(result);
    write(
      caught
        ? `caught   ${mutant.id} (${mutant.what}): ${String(result.failedCases)}/${String(total)} cases differ; first ${result.firstFailure ?? '-'}\n         ${result.replay ?? ''}\n`
        : `SURVIVED ${mutant.id} (${mutant.what}): verify exited ${String(outcome.exitCode)} with ${String(result.failedCases)} failing cases; see ${join(dir, 'verify.log')}\n`,
    );
  }

  const caught = results.filter((r) => r.caught).length;
  mkdirSync(dirname(options.report), { recursive: true });
  writeFileSync(
    options.report,
    `${JSON.stringify({ format: 'vcpu8-rtl-mutants/1', total: results.length, caught, mutants: results }, null, 2)}\n`,
  );
  write(
    caught === results.length
      ? `verify-mutants: all ${String(caught)} mutants caught\n`
      : `verify-mutants: FAIL, ${String(results.length - caught)} of ${String(results.length)} mutants not caught: ${results
          .filter((r) => !r.caught)
          .map((r) => r.id)
          .join(', ')}\n`,
  );
  write(`wrote ${options.report}\n`);
  return caught === results.length ? 0 : 1;
}
