import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BUILD_DIR, HW_DIR } from './report.js';
import { replayCommand, runVerify, sizeName, type VerifyOptions } from './verify.js';

/**
 * Proves the differential verification can fail (`make verify-mutant`): each mutant is a copy of
 * `rtl/` in `build/mutants/<id>/rtl/` with one textual change from `scripts/mutants.txt`, built
 * into its own runner for every array size, and `verify` must report at least one failing case
 * on it. The real `rtl/` is only read. The same file format as VCPU-8's
 * hardware/rtl/vcpu8/scripts/mutants.txt, parsed here so this package depends on no other
 * workspace.
 */

export const MUTANTS_DEFAULTS = {
  list: join(HW_DIR, 'scripts', 'mutants.txt'),
  rtl: join(HW_DIR, 'rtl'),
  out: join(BUILD_DIR, 'mutants'),
  simTop: join(HW_DIR, 'tb', 'sim', 'matmul_sim_top.sv'),
  simCpp: join(HW_DIR, 'tb', 'sim', 'matmul_sim.cpp'),
  report: join(BUILD_DIR, 'reports', 'mutants.json'),
  sizes: [
    { rows: 4, cols: 4 },
    { rows: 8, cols: 8 },
    { rows: 16, cols: 16 },
  ],
  count: 10,
} as const;

export interface Mutant {
  readonly id: string;
  /** A file in `rtl/`. */
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
 * Copies every `rtl/*.sv` into `outRtl` and applies the mutation. Throws when the `from` text no
 * longer occurs exactly once: a mutant that stopped applying is an error, never a skip.
 */
export function applyMutant(rtl: string, outRtl: string, mutant: Mutant): void {
  rmSync(outRtl, { recursive: true, force: true });
  mkdirSync(outRtl, { recursive: true });
  const files = readdirSync(rtl).filter((f) => f.endsWith('.sv'));
  if (!files.includes(mutant.file)) {
    throw new MutantError(`mutant ${mutant.id}: rtl/${mutant.file} does not exist`);
  }
  for (const file of files) {
    let text = readFileSync(join(rtl, file), 'utf8');
    if (file === mutant.file) {
      const count = text.split(mutant.from).length - 1;
      if (count !== 1) {
        throw new MutantError(
          `mutant ${mutant.id} no longer applies: "${mutant.from}" occurs ${String(count)} times in rtl/${file} (expected once); update scripts/mutants.txt`,
        );
      }
      text = text.replace(mutant.from, () => mutant.to);
    }
    writeFileSync(join(outRtl, file), text);
  }
}

/** The RTL sources in the Makefile's order: packages first, then the rest, sorted. */
function rtlSources(rtl: string): string[] {
  const files = readdirSync(rtl)
    .filter((f) => f.endsWith('.sv'))
    .sort();
  const pkgs = files.filter((f) => f.endsWith('_pkg.sv'));
  return [...pkgs, ...files.filter((f) => !pkgs.includes(f))].map((f) => join(rtl, f));
}

/** Runs a build; resolves with its exit code and combined output. */
function build(command: string, args: readonly string[]): Promise<{ code: number; log: string }> {
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (chunk: Buffer) => (log += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()));
    child.on('error', (error) => {
      done({ code: 127, log: `${log}${error.message}\n` });
    });
    child.on('close', (code) => {
      done({ code: code ?? 1, log });
    });
  });
}

export interface MutantsOptions {
  readonly list: string;
  readonly rtl: string;
  readonly out: string;
  readonly simTop: string;
  readonly simCpp: string;
  readonly verilator: string;
  readonly report: string;
  readonly sizes: readonly { readonly rows: number; readonly cols: number }[];
  /** Only this mutant, if set. */
  readonly only?: string | undefined;
  /** The verify run to repeat on each mutant (sims, work, failures and reports are replaced). */
  readonly verify: VerifyOptions;
}

interface MutantResult {
  readonly id: string;
  readonly what: string;
  readonly caught: boolean;
  readonly error: string | null;
  readonly failedCases: number;
  readonly totalCases: number;
  /** The failing cases per array size. */
  readonly failedBySize: Readonly<Record<string, number>>;
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
  write(
    `mutants: ${String(mutants.length)} from ${options.list}, each verified on ${options.sizes.map(sizeName).join(', ')}\n`,
  );

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
        failedBySize: {},
        firstFailure: null,
        replay: null,
      });
      write(`ERROR    ${mutant.id}: ${error}\n`);
    };
    try {
      rmSync(dir, { recursive: true, force: true });
      applyMutant(options.rtl, join(dir, 'rtl'), mutant);
    } catch (error) {
      fail((error as Error).message);
      continue;
    }

    // One runner per size, built in parallel. -Wno-fatal: a mutant may add a lint warning.
    const sims = options.sizes.map((size) => join(dir, `sim-${sizeName(size)}`, 'matmul_sim'));
    const builds = await Promise.all(
      options.sizes.map((size, index) => {
        const sim = sims[index] ?? '';
        mkdirSync(dirname(sim), { recursive: true });
        return build(options.verilator, [
          '--cc',
          '--exe',
          '--build',
          '-O3',
          '-Wall',
          '-Wno-fatal',
          '--quiet',
          '-j',
          '0',
          '--top-module',
          'matmul_sim_top',
          `-GROWS=${String(size.rows)}`,
          `-GCOLS=${String(size.cols)}`,
          '-CFLAGS',
          '-Wno-unknown-warning-option',
          '-Mdir',
          join(dirname(sim), 'obj'),
          '-o',
          sim,
          ...rtlSources(join(dir, 'rtl')),
          options.simTop,
          options.simCpp,
        ]);
      }),
    );
    writeFileSync(join(dir, 'build.log'), builds.map((b) => b.log).join(''));
    const broken = builds.findIndex((b) => b.code !== 0);
    if (broken !== -1) {
      fail(
        `the mutant does not build at ${sizeName(options.sizes[broken] ?? { rows: 0, cols: 0 })} (exit ${String(builds[broken]?.code)}); see ${join(dir, 'build.log')}`,
      );
      continue;
    }

    let log = '';
    const outcome = await runVerify(
      {
        ...options.verify,
        sims,
        work: join(dir, 'verify'),
        failures: join(dir, 'failures'),
        reports: join(dir, 'reports'),
        keepFailures: 3 * options.sizes.length,
      },
      (text) => {
        log += text;
      },
    );
    writeFileSync(join(dir, 'verify.log'), log);
    const first = outcome.failures.find((f) => f.saved !== null) ?? outcome.failures[0];
    const caught = outcome.exitCode === 1 && outcome.failures.length > 0;
    const failedBySize: Record<string, number> = {};
    for (const s of outcome.report?.sizes ?? []) failedBySize[s.size] = s.failed;
    const result: MutantResult = {
      id: mutant.id,
      what: mutant.what,
      caught,
      error:
        outcome.exitCode > 1
          ? `verify exited ${String(outcome.exitCode)}; see ${join(dir, 'verify.log')}`
          : null,
      failedCases: outcome.failures.length,
      totalCases: outcome.report?.totals.cases ?? 0,
      failedBySize,
      firstFailure:
        first === undefined ? null : `${first.size} ${first.name}: ${first.reason ?? '-'}`,
      replay: first?.saved == null ? null : replayCommand(first.saved),
    };
    results.push(result);
    const bySize = Object.entries(failedBySize)
      .map(([size, n]) => `${size} ${String(n)}`)
      .join(', ');
    write(
      caught
        ? `caught   ${mutant.id} (${mutant.what}): ${String(result.failedCases)}/${String(result.totalCases)} cases fail (${bySize}); first ${result.firstFailure ?? '-'}\n         ${result.replay ?? ''}\n`
        : `SURVIVED ${mutant.id} (${mutant.what}): verify exited ${String(outcome.exitCode)} with ${String(result.failedCases)} failing cases; see ${join(dir, 'verify.log')}\n`,
    );
  }

  const caught = results.filter((r) => r.caught).length;
  mkdirSync(dirname(options.report), { recursive: true });
  writeFileSync(
    options.report,
    `${JSON.stringify({ schemaVersion: 1, kind: 'matmul-mutants', total: results.length, caught, mutants: results }, null, 2)}\n`,
  );
  write(
    caught === results.length
      ? `verify-mutant: all ${String(caught)} mutants caught\n`
      : `verify-mutant: FAIL, ${String(results.length - caught)} of ${String(results.length)} mutants not caught: ${results
          .filter((r) => !r.caught)
          .map((r) => r.id)
          .join(', ')}\n`,
  );
  write(`wrote ${options.report}\n`);
  return caught === results.length ? 0 : 1;
}
