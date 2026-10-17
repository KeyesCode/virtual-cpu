import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { HW_DIR, REPO } from '../verify/corpora.js';

/**
 * A design variant: the Verilog defines and top-level parameters one build of the RTL uses. The
 * default design is the variant with neither. Defines reach Verilator (`-D`) and Yosys
 * (`read_verilog -D`); parameters reach Verilator (`-G`, on the runner's top) and Yosys
 * (`chparam`, on each synthesis top), so a parameter must be declared on every top
 * (research/cpu/experiments/README.md). The ISA never changes between variants.
 */

const Identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'a Verilog identifier');

export const VariantSchema = z.strictObject({
  /** Lower-case name used in file names, e.g. `default`, `div-iterative`. */
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lower-case letters, digits and dashes'),
  description: z.string().default(''),
  /** `NAME: true` defines NAME; `NAME: value` defines NAME=value. */
  defines: z
    .record(Identifier, z.union([z.literal(true), z.number().int(), Identifier]))
    .default({}),
  /** Integer values for top-level parameters. */
  parameters: z.record(Identifier, z.number().int()).default({}),
});
export type Variant = z.output<typeof VariantSchema>;

export const DEFAULT_VARIANT: Variant = {
  name: 'default',
  description: 'The design as committed, with no defines or parameters.',
  defines: {},
  parameters: {},
};

function sorted<T>(record: Readonly<Record<string, T>>): [string, T][] {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 12 hex digits of the SHA-256 of the defines and parameters, in key order: the name and
 * description do not change the hardware, so they do not change the hash.
 */
export function variantHash(variant: Variant): string {
  const canonical = JSON.stringify({
    defines: sorted(variant.defines),
    parameters: sorted(variant.parameters),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

/** `-DNAME` / `-DNAME=value`, in key order; Verilator and Yosys spell them the same. */
export function defineFlags(variant: Variant): string[] {
  return sorted(variant.defines).map(([name, value]) =>
    value === true ? `-D${name}` : `-D${name}=${String(value)}`,
  );
}

/** Verilator's `-Gname=value` for each parameter, in key order. */
export function verilatorParameterFlags(variant: Variant): string[] {
  return sorted(variant.parameters).map(([name, value]) => `-G${name}=${String(value)}`);
}

/** `make synth` variables for this variant (mk/synth.mk). */
export function synthMakeArgs(variant: Variant): string[] {
  return [
    `SYNTH_DEFINES=${defineFlags(variant).join(' ')}`,
    `SYNTH_PARAMS=${sorted(variant.parameters)
      .map(([name, value]) => `${name}=${String(value)}`)
      .join(' ')}`,
  ];
}

/** The RTL sources in the Makefile's order: packages first, then every other `core/*.sv`. */
export function coreSources(core: string = join(HW_DIR, 'core')): string[] {
  const files = readdirSync(core)
    .filter((f) => f.endsWith('.sv'))
    .sort();
  const pkgs = files.filter((f) => f.endsWith('_pkg.sv'));
  return [...pkgs, ...files.filter((f) => !pkgs.includes(f))].map((f) => join(core, f));
}

/** SHA-256 over the names and contents of `files` and any extra strings. */
export function contentHash(files: readonly string[], extra: readonly string[] = []): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file).update('\0').update(readFileSync(file)).update('\0');
  }
  for (const text of extra) hash.update(text).update('\0');
  return hash.digest('hex');
}

/** Where a variant's runner, synthesis and reports live: `build/variants/<hash>/`. */
export function variantDir(variant: Variant): string {
  return join(HW_DIR, 'build', 'variants', variantHash(variant));
}

const SIM_TOP = join(HW_DIR, 'tb', 'sim', 'vcpu8_sim_top.sv');
const SIM_CPP = join(HW_DIR, 'tb', 'sim', 'vcpu8_sim.cpp');

export type RunnerBuild =
  | { readonly ok: true; readonly sim: string; readonly cached: boolean }
  | { readonly ok: false; readonly error: string };

/**
 * Builds the variant's RTL runner into `build/variants/<hash>/sim/`, with the same Verilator
 * command as mk/sim.mk plus the variant's flags. A build whose sources, flags and Verilator are
 * unchanged is reused: `sim/inputs.sha256` records what it was built from.
 */
export function buildRunner(variant: Variant, verilator: string): RunnerBuild {
  const dir = join(variantDir(variant), 'sim');
  const sim = join(dir, 'vcpu8_sim');
  const stamp = join(dir, 'inputs.sha256');
  const sources = [...coreSources(), SIM_TOP];
  const flags = [...defineFlags(variant), ...verilatorParameterFlags(variant)];
  const key = contentHash([...sources, SIM_CPP], [verilator, ...flags]);
  if (existsSync(sim) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === key) {
    return { ok: true, sim, cached: true };
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'variant.json'), `${JSON.stringify(variant, null, 2)}\n`);
  const build = spawnSync(
    verilator,
    [
      '--cc',
      '--exe',
      '--build',
      '-O3',
      '-Wall',
      '--quiet',
      '--top-module',
      'vcpu8_sim_top',
      ...flags,
      '-CFLAGS',
      '-Wno-unknown-warning-option',
      '-Mdir',
      join(dir, 'obj'),
      '-o',
      sim,
      ...sources,
      SIM_CPP,
    ],
    { encoding: 'utf8', maxBuffer: 64 << 20 },
  );
  writeFileSync(join(dir, 'build.log'), `${build.stdout}${build.stderr}`);
  if (build.error !== undefined || build.status !== 0) {
    return {
      ok: false,
      error: `the runner does not build (${build.error?.message ?? `exit ${String(build.status)}`}); see ${relative(REPO, join(dir, 'build.log'))}`,
    };
  }
  writeFileSync(stamp, `${key}\n`);
  return { ok: true, sim, cached: false };
}
