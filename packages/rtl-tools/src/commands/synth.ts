import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AllowEntry,
  buildSummary,
  collectWarnings,
  compareSummaries,
  type FpgaInputs,
  type FpgaTarget,
  formatDelta,
  NextpnrReportSchema,
  nextpnrVersion,
  parseAllowlist,
  renderSummaryMarkdown,
  StatJsonSchema,
  SYNTH_SUMMARY_FORMAT,
  type SynthWarning,
  yosysVersion,
} from '../synth/summary.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');

/** The generic flow's top, and the FPGA wrapper every FPGA flow builds. */
const GENERIC_TOP = 'vcpu8_top';
const FPGA_TOP = 'vcpu8_fpga_wrapper';

export interface SynthSummaryOptions {
  /** build/synth/, holding every output of `make synth`. */
  readonly dir: string;
  /** synth/warnings.allow. */
  readonly allow: string;
  /** The Makefile's TOOLCHAIN: the pinned OSS CAD Suite's directory, or `PATH`. */
  readonly toolchain: string;
  readonly toolchainVersion: string;
  /** The program built into the FPGA RAM. */
  readonly initFile: string;
  readonly seed: number;
  readonly targets: readonly FpgaTarget[];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function git(args: readonly string[]): string {
  const run = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (run.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
  }
  return run.stdout.trim();
}

/** `up5k:sg48` → iCE40 target; `25k:CABGA256:6` → ECP5 target. */
export function parseTarget(family: 'ice40' | 'ecp5', spec: string): FpgaTarget | undefined {
  const [device, pkg, speed, ...extra] = spec.split(':');
  if (
    device === undefined ||
    device === '' ||
    pkg === undefined ||
    pkg === '' ||
    extra.length > 0
  ) {
    return undefined;
  }
  if ((family === 'ecp5') !== (speed !== undefined && speed !== '')) {
    return undefined;
  }
  return { family, device, package: pkg, speed: speed ?? null };
}

/**
 * Build summary.json and summary.md in `options.dir` from the outputs of `make synth`. Returns
 * the exit code: 0 when every gate passed, 1 when a warning is not in the allowlist.
 */
export function runSynthSummary(
  options: SynthSummaryOptions,
  write: (text: string) => void,
): number {
  const at = (file: string): string => join(options.dir, file);
  const allow: AllowEntry[] = parseAllowlist(readFileSync(options.allow, 'utf8'));
  // Absolute paths in warnings and sources are machine-specific; report them repository-relative.
  const strip = [`${REPO_ROOT}/`, `${options.toolchain}/`].filter((p) => p !== 'PATH/');
  const warnings: SynthWarning[] = [];
  const logWarnings = (file: string): void => {
    warnings.push(...collectWarnings(file, readFileSync(at(file), 'utf8'), allow, strip));
  };
  logWarnings('generic.log');

  const genericStat = StatJsonSchema.parse(readJson(at('generic.stat.json')));
  const tools: Record<string, string | null> = { yosys: yosysVersion(genericStat.creator) };
  const fpga: Record<string, FpgaInputs | { absent: string }> = {};
  const initFile = relative(REPO_ROOT, options.initFile);
  for (const target of options.targets) {
    const tool = `nextpnr-${target.family}`;
    if (!existsSync(at(`${tool}.report.json`))) {
      // make synth fails before this point when nextpnr-ice40 is missing; ECP5 is optional.
      if (target.family === 'ice40') {
        throw new Error(`${at(`${tool}.report.json`)} is missing: did nextpnr-ice40 run?`);
      }
      tools[tool] = null;
      fpga[target.family] = { absent: `${tool} is not installed` };
      continue;
    }
    tools[tool] = nextpnrVersion(readFileSync(at(`${tool}.version`), 'utf8'));
    logWarnings(`${target.family}.log`);
    logWarnings(`${tool}.log`);
    fpga[target.family] = {
      target,
      top: FPGA_TOP,
      initFile,
      seed: options.seed,
      stat: StatJsonSchema.parse(readJson(at(`${target.family}.stat.json`))),
      report: NextpnrReportSchema.parse(readJson(at(`${tool}.report.json`))),
      yosysLog: readFileSync(at(`${target.family}.log`), 'utf8'),
    };
  }

  const summary = buildSummary({
    gitSha: git(['rev-parse', 'HEAD']),
    gitDirty: git(['status', '--porcelain']) !== '',
    toolchain:
      options.toolchain === 'PATH'
        ? `tools from PATH (not the pinned OSS CAD Suite ${options.toolchainVersion})`
        : `OSS CAD Suite ${options.toolchainVersion}`,
    tools,
    top: GENERIC_TOP,
    genericStat,
    gatesStat: StatJsonSchema.parse(readJson(at('generic.gates.stat.json'))),
    ltp: readFileSync(at('generic.ltp.txt'), 'utf8'),
    memories: readJson(at('generic.memories.json')),
    netlist: readJson(at('generic.json')),
    fpga,
    warnings,
    allow,
    repoRoot: REPO_ROOT,
  });

  writeFileSync(at('summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(at('summary.md'), renderSummaryMarkdown(summary));

  const { total, gates } = summary.generic;
  write(
    `synth: ${GENERIC_TOP} ${String(total.cells)} generic cells (${String(total.flipFlops)} flip-flops, ` +
      `${String(total.combinational)} combinational); logic depth ${String(gates.logicDepth.length)} gates\n`,
  );
  for (const memory of summary.memories) {
    write(
      `synth: memory ${memory.module}.${memory.name} (${memory.kind}) → ` +
        `${Object.entries(memory.fpga)
          .map(([family, mapped]) => `${family}: ${mapped ?? 'flow absent'}`)
          .join(', ')}\n`,
    );
  }
  for (const [family, flow] of Object.entries(summary.fpga)) {
    write(
      flow.status === 'absent'
        ? `synth: ${family} not run: ${flow.reason}\n`
        : `synth: ${family} ${flow.device}: ${String(flow.synth.luts)} LUTs, ${String(flow.synth.flipFlops)} FFs, ` +
            `${String(flow.synth.blockRam)} block RAM; Fmax ${flow.pnr.fmaxMHz.toFixed(2)} MHz ` +
            `(target ${String(flow.pnr.constraintMHz)} MHz, ${flow.pnr.meetsConstraint ? 'met' : 'NOT met'}) ` +
            `for ${flow.timingLabel}\n`,
    );
  }
  write(`synth: wrote ${at('summary.json')} and ${at('summary.md')}\n`);
  if (!summary.gate.passed) {
    write(
      `synth: FAILED: ${String(summary.gate.failures.length)} warnings not in ${options.allow}:\n` +
        summary.gate.failures.map((failure) => `  ${failure}\n`).join(''),
    );
    return 1;
  }
  write(
    `synth: gates passed; ${String(warnings.reduce((n, w) => n + w.count, 0))} warnings, all in the reviewed allowlist\n`,
  );
  return 0;
}

/** Print the deltas between a fresh summary and the committed baseline. */
export function runSynthCompare(
  baselinePath: string,
  summaryPath: string,
  write: (text: string) => void,
): number {
  if (!existsSync(baselinePath)) {
    write(`synth-compare: no baseline at ${baselinePath}; run make synth-baseline and commit it\n`);
    return 1;
  }
  const baseline = readJson(baselinePath);
  const fresh = readJson(summaryPath);
  for (const [name, value] of [
    ['baseline', baseline],
    ['summary', fresh],
  ] as const) {
    if ((value as { format?: unknown }).format !== SYNTH_SUMMARY_FORMAT) {
      write(`synth-compare: the ${name} is not a ${SYNTH_SUMMARY_FORMAT} file\n`);
      return 1;
    }
  }
  const { deltas, provenance } = compareSummaries(baseline, fresh);
  for (const delta of provenance) {
    write(`synth-compare: note: ${formatDelta(delta).trim()}\n`);
  }
  const name = relative(REPO_ROOT, baselinePath);
  if (deltas.length === 0) {
    write(`synth-compare: 0 deltas: the fresh summary matches ${name}\n`);
  } else {
    write(`synth-compare: ${String(deltas.length)} deltas against ${name} (baseline → fresh):\n`);
    for (const delta of deltas) write(`${formatDelta(delta)}\n`);
  }
  return 0;
}
