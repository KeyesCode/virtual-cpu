import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import {
  classifyCommand,
  type CommandRecord,
  type FailureClass,
  type Metric,
  type StageResult,
  type UnavailableMetric,
} from '@vcpu/research-core';
import {
  type AllowEntry,
  collectWarnings,
  parseAllowlist,
  parseLtp,
  type SynthWarning,
  yosysVersion,
} from '@vcpu/rtl-tools';
import type { CommandRunner } from '../runner/command-runner.js';
import { HostCommandRunner } from '../runner/host-runner.js';
import {
  classifyYosysLog,
  designCells,
  MAPPED_WARNING_ALLOW,
  memoryBits,
  mulCells,
  parseLibertyStat,
  parseStat,
  SYNTHESIS_GATES,
  type SynthesisGateName,
  type YosysFailure,
} from './parsers.js';
import {
  buildGenericScript,
  buildMappedScript,
  SKY130HD_DONT_USE,
  type SynthesisDesign,
  type YosysScripts,
} from './script.js';

const MATMUL_DIR = join('hardware', 'accelerators', 'matmul');
const INSTALL_HINT = "run 'pnpm hardware:setup' to install the pinned OSS CAD Suite";
const DEFAULT_MAX_LOG_BYTES = 1 << 20;

const LIBERTY_METHOD = 'yosys-stat-liberty';
const STAT_METHOD = 'yosys-stat-json';

/** One synthesis run: the design, where its outputs go and how long it may take. */
export interface SynthesisContext {
  readonly design: SynthesisDesign;
  /** Each flow writes to `<outDir>/<flow>/`, emptied first, and logs to `<outDir>/logs/`. */
  readonly outDir: string;
  /** The wall-clock limit of the stage, all of its commands together. */
  readonly timeoutMs: number;
  readonly maxLogBytes?: number;
}

export interface MappedSynthesisContext extends SynthesisContext {
  /** Without one, nothing runs and the physical metrics are `unavailable`. */
  readonly liberty?: string;
  /** Cell name globs kept out of the mapping; {@link SKY130HD_DONT_USE} unless set. */
  readonly dontUse?: readonly string[];
}

export interface SynthesisGate {
  readonly name: SynthesisGateName;
  /** `unknown` when the run stopped before establishing it. */
  readonly status: 'passed' | 'failed' | 'unknown';
}

export interface SynthesisArtifact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Everything a flow established. A metric the flow does not produce is `unavailable`, never 0. */
export interface SynthesisReport {
  readonly flow: 'generic' | 'mapped';
  readonly top: string;
  readonly params: Readonly<Record<string, number>>;
  readonly cells: Metric;
  readonly flipFlops: Metric;
  readonly mulCells: Metric;
  readonly abstractGates: Metric;
  /** A gate count on the longest path, not a delay. */
  readonly logicDepthGates: Metric;
  readonly memories: Metric;
  readonly memoryBits: Metric;
  /** Standard-cell area, estimated without wiring. Generic cells have no area. */
  readonly areaUm2: Metric;
  /** Generic cells by type, without the instances of submodules; null when not established. */
  readonly cellsByType: Readonly<Record<string, number>> | null;
  /** Library cells by type; null when not established. */
  readonly mappedCellsByType: Readonly<Record<string, number>> | null;
  /** The mapped netlist, for static timing; null when not written. */
  readonly netlistFile: string | null;
  /** The library the design was mapped to, and the cells kept out of the mapping. */
  readonly liberty: {
    readonly path: string;
    readonly sha256: string;
    readonly dontUse: readonly string[];
  } | null;
  readonly gates: readonly SynthesisGate[];
  readonly warnings: readonly SynthWarning[];
  /** Every file of the run, the scripts among them, with its hash. */
  readonly artifacts: readonly SynthesisArtifact[];
}

type Measured = Pick<
  SynthesisReport,
  | 'cells'
  | 'flipFlops'
  | 'mulCells'
  | 'abstractGates'
  | 'logicDepthGates'
  | 'memories'
  | 'memoryBits'
  | 'areaUm2'
  | 'cellsByType'
  | 'mappedCellsByType'
  | 'netlistFile'
>;

function unavailable(reason: string): UnavailableMetric {
  return { provenance: 'unavailable', reason };
}

/** Every metric unavailable for one reason: a flow that did not get as far as measuring. */
function nothingMeasured(reason: string): Measured {
  const metric = unavailable(reason);
  return {
    cells: metric,
    flipFlops: metric,
    mulCells: metric,
    abstractGates: metric,
    logicDepthGates: metric,
    memories: metric,
    memoryBits: metric,
    areaUm2: metric,
    cellsByType: null,
    mappedCellsByType: null,
    netlistFile: null,
  };
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function artifactsIn(dir: string): SynthesisArtifact[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((file) => {
      const path = join(dir, file);
      const bytes = readFileSync(path);
      return {
        path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    });
}

function ended(record: CommandRecord, what: string): string {
  if (record.spawnError !== null) return `${what} could not start: ${record.spawnError}`;
  if (record.timedOut) return `${what} overran the stage timeout and was killed`;
  return `${what} exited ${String(record.exitCode ?? record.signal)}`;
}

function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** One flow's commands, against one deadline. */
class FlowRun {
  readonly commands: CommandRecord[] = [];
  toolVersion: string | null = null;
  readonly deadline: number;

  constructor(
    private readonly runner: CommandRunner,
    private readonly stage: string,
    private readonly context: SynthesisContext,
    private readonly cwd: string,
  ) {
    this.deadline = Date.now() + context.timeoutMs;
  }

  async exec(label: string, command: string, args: readonly string[]): Promise<CommandRecord> {
    const name = `${this.stage}-${String(this.commands.length + 1)}-${label}`;
    const logs = join(resolve(this.context.outDir), 'logs');
    const record = await this.runner.run(command, args, {
      cwd: this.cwd,
      timeoutMs: Math.max(1, this.deadline - Date.now()),
      maxLogBytes: this.context.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES,
      stdoutPath: join(logs, `${name}.stdout.log`),
      stderrPath: join(logs, `${name}.stderr.log`),
    });
    this.commands.push(record);
    return record;
  }

  result(
    failure: Pick<YosysFailure, 'failureClass' | 'message'> | null,
    warnings: readonly SynthWarning[],
    report: SynthesisReport,
  ): StageResult<SynthesisReport> {
    return {
      stage: this.stage,
      ok: failure === null,
      failureClass: failure?.failureClass ?? null,
      message: failure?.message ?? null,
      commands: this.commands,
      toolVersion: this.toolVersion,
      wallTimeMs: this.commands.reduce((total, c) => total + c.wallTimeMs, 0),
      warnings: warnings.map(
        (w) => `${w.message}${w.count > 1 ? ` (${String(w.count)} times)` : ''}`,
      ),
      outcome: report,
    };
  }
}

interface FlowSpec {
  readonly stage: string;
  readonly flow: SynthesisReport['flow'];
  readonly scripts: YosysScripts;
  /** Warnings this flow accepts beyond synth/warnings.allow. */
  readonly extraAllow: readonly AllowEntry[];
  /** Reads the run's outputs; a throw is a `tool-failure` with the raw files kept. */
  readonly measure: (dir: string, version: string) => Measured;
  /** The design-level failure the outputs show, if any. */
  readonly inspect?: (measured: Measured) => YosysFailure | null;
  readonly liberty: SynthesisReport['liberty'];
}

/**
 * Synthesises a design with the pinned Yosys, at two tiers that are never mixed: docs/research-engine/
 * eda-adapters.md lists the flows, the gates and the assumptions. The Yosys scripts are written into
 * the run's directory, so the exact scripts are artifacts. A failed design is a result; only misuse of the
 * adapter rejects.
 */
export class YosysAdapter {
  private readonly repoRoot: string;
  private readonly runner: CommandRunner;
  private readonly yosys: string | undefined;

  constructor(options: {
    readonly repoRoot: string;
    readonly runner?: CommandRunner;
    /** The binary; the pinned OSS CAD Suite's unless set, as a sandbox runner needs. */
    readonly yosys?: string;
  }) {
    this.repoRoot = resolve(options.repoRoot);
    this.runner = options.runner ?? new HostCommandRunner();
    this.yosys = options.yosys;
  }

  /** Tier 0: the steps of synth/generic.ys on `design.top`. Counts, never area. */
  async synthesizeGeneric(context: SynthesisContext): Promise<StageResult<SynthesisReport>> {
    const { top } = context.design;
    return this.flow(context, {
      stage: 'synth-generic',
      flow: 'generic',
      scripts: buildGenericScript(context.design),
      extraAllow: [],
      liberty: null,
      measure: (dir, version) => {
        const read = (file: string) => readFileSync(join(dir, file), 'utf8');
        const stat = parseStat(read('generic.stat.json'), top);
        const cells = designCells(stat);
        const gates = designCells(parseStat(read('generic.gates.stat.json'), top));
        const count = (value: number, unit: string, method = STAT_METHOD): Metric => ({
          value,
          unit,
          provenance: 'measured',
          method,
          tool: 'yosys',
          toolVersion: version,
        });
        return {
          cells: count(cells.cells, 'cells'),
          flipFlops: count(cells.flipFlops, 'flip-flops'),
          mulCells: count(mulCells(parseStat(read('generic.mul.stat.json'), top)), 'multipliers'),
          abstractGates: count(gates.combinational, 'gates'),
          logicDepthGates: count(parseLtp(read('generic.ltp.txt')).length, 'gates', 'yosys-ltp'),
          memories: count(cells.memories, 'memories'),
          memoryBits: count(memoryBits(read('generic.memories.json'), stat, top), 'bits'),
          areaUm2: unavailable('generic cells have no area: map to a liberty file'),
          cellsByType: cells.byType,
          mappedCellsByType: null,
          netlistFile: null,
        };
      },
    });
  }

  /**
   * Tier 1: `synth`, then `dfflibmap` and `abc` onto a liberty file, with the same structural gates.
   * With no liberty file nothing runs: that is a missing input, not a failed design.
   */
  async synthesizeMapped(context: MappedSynthesisContext): Promise<StageResult<SynthesisReport>> {
    const { design, liberty } = context;
    this.assertOutDir(context);
    if (liberty === undefined) {
      const reason = 'no liberty file: the design was not mapped to a library';
      const run = new FlowRun(this.runner, 'synth-mapped', context, context.outDir);
      const report = this.report('mapped', design, nothingMeasured(reason), null, [], [], []);
      return { ...run.result(null, [], report), warnings: [reason] };
    }

    const dontUse = context.dontUse ?? SKY130HD_DONT_USE;
    const libertyFile = resolve(liberty);
    const scripts = buildMappedScript(design, libertyFile, dontUse);
    if (!existsSync(libertyFile)) {
      const run = new FlowRun(this.runner, 'synth-mapped', context, context.outDir);
      const message = `liberty file not found: ${libertyFile}`;
      const report = this.report('mapped', design, nothingMeasured(message), null, [], [], []);
      return run.result({ failureClass: 'infrastructure-failure', message }, [], report);
    }

    return this.flow(context, {
      stage: 'synth-mapped',
      flow: 'mapped',
      scripts,
      extraAllow: MAPPED_WARNING_ALLOW,
      liberty: { path: libertyFile, sha256: sha256(libertyFile), dontUse },
      measure: (dir, version) => {
        const read = (file: string) => readFileSync(join(dir, file), 'utf8');
        const stat = parseLibertyStat(read('mapped.stat.json'), design.top);
        const mapped = designCells(stat);
        const generic = designCells(parseStat(read('mapped.ff.stat.json'), design.top));
        const tool = { tool: 'yosys', toolVersion: version };
        const notInThisFlow = unavailable('measured by the generic flow, not the mapped one');
        return {
          cells: {
            value: mapped.cells,
            unit: 'cells',
            provenance: 'measured',
            method: LIBERTY_METHOD,
            ...tool,
          },
          flipFlops: {
            value: generic.flipFlops,
            unit: 'flip-flops',
            provenance: 'measured',
            method: STAT_METHOD,
            ...tool,
          },
          mulCells: notInThisFlow,
          abstractGates: notInThisFlow,
          logicDepthGates: notInThisFlow,
          memories: notInThisFlow,
          memoryBits: notInThisFlow,
          areaUm2: {
            value: stat.design.area,
            unit: 'um^2',
            provenance: 'estimated',
            method: LIBERTY_METHOD,
            ...tool,
          },
          cellsByType: null,
          mappedCellsByType: mapped.byType,
          netlistFile: join(dir, 'mapped.v'),
        };
      },
      inspect: (measured) => {
        const unmapped = Object.keys(measured.mappedCellsByType ?? {}).filter((type) =>
          type.startsWith('$'),
        );
        return unmapped.length === 0
          ? null
          : {
              failureClass: 'unsupported-design',
              gates: ['unmapped-cells'],
              message: `failed the unmapped-cells gate: no library cell for ${unmapped.join(', ')}`,
            };
      },
    });
  }

  private report(
    flow: SynthesisReport['flow'],
    design: SynthesisDesign,
    measured: Measured,
    liberty: SynthesisReport['liberty'],
    gates: readonly SynthesisGate[],
    warnings: readonly SynthWarning[],
    artifacts: readonly SynthesisArtifact[],
  ): SynthesisReport {
    return {
      flow,
      top: design.top,
      params: design.params,
      ...measured,
      liberty,
      gates,
      warnings,
      artifacts,
    };
  }

  private async flow(
    context: SynthesisContext,
    spec: FlowSpec,
  ): Promise<StageResult<SynthesisReport>> {
    this.assertOutDir(context);
    const { design } = context;
    const dir = join(resolve(context.outDir), spec.flow);
    const run = new FlowRun(this.runner, spec.stage, context, dir);
    const finish = (
      failure: Pick<YosysFailure, 'failureClass' | 'message'> | null,
      failedGates: readonly SynthesisGateName[],
      /** Whether Yosys ran to its end, so that every gate not listed as failed passed. */
      ranToEnd: boolean,
      measured: Measured,
      warnings: readonly SynthWarning[] = [],
    ): StageResult<SynthesisReport> => {
      const gates = SYNTHESIS_GATES.filter((g) => spec.flow === 'mapped' || g !== 'unmapped-cells');
      const status = (name: SynthesisGateName): SynthesisGate['status'] => {
        if (failedGates.includes(name)) return 'failed';
        return ranToEnd ? 'passed' : 'unknown';
      };
      const report = this.report(
        spec.flow,
        design,
        measured,
        spec.liberty,
        gates.map((name) => ({ name, status: status(name) })),
        warnings,
        artifactsIn(dir),
      );
      return run.result(failure, warnings, report);
    };
    const stopped = (failureClass: FailureClass, message: string) =>
      finish({ failureClass, message }, [], false, nothingMeasured(message));

    try {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'script.ys'), spec.scripts.entry);
      writeFileSync(join(dir, spec.scripts.stepsFile), spec.scripts.steps);
      const allow = [...this.allowlist(), ...spec.extraAllow];
      const yosys = this.yosysBinary();

      const version = await run.exec('version', yosys, ['-V']);
      const versionFailure = classifyCommand(version);
      if (versionFailure !== null) {
        return stopped(versionFailure, `${ended(version, 'yosys -V')}: ${INSTALL_HINT}`);
      }
      run.toolVersion = yosysVersion(readIfPresent(version.stdout.path).trim());

      const record = await run.exec(spec.flow, yosys, ['-q', '-l', 'yosys.log', '-s', 'script.ys']);
      const base = classifyCommand(record);
      if (base === 'timeout' || base === 'infrastructure-failure') {
        return stopped(base, ended(record, 'yosys'));
      }

      const log = readIfPresent(join(dir, 'yosys.log'));
      const strip = [...new Set(design.sources.map((source) => `${dirname(resolve(source))}/`))];
      const warnings = collectWarnings('yosys', log, allow, strip);
      if (base !== null) {
        const stderr = readIfPresent(record.stderr.path);
        const failure = classifyYosysLog(`${log}\n${stderr}`);
        // A design failure names its own ERROR line; anything else needs how the command ended.
        const message =
          failure.gates.length === 0
            ? `${ended(record, 'yosys')}: ${failure.message}`
            : failure.message;
        return finish(
          { ...failure, message },
          failure.gates,
          false,
          nothingMeasured(message),
          warnings,
        );
      }

      let measured: Measured;
      try {
        measured = spec.measure(dir, run.toolVersion);
      } catch (error) {
        const message = `unreadable Yosys output: ${(error as Error).message}`;
        return finish(
          { failureClass: 'tool-failure', message },
          [],
          false,
          nothingMeasured(message),
          warnings,
        );
      }

      const unreviewed = warnings.filter((warning) => warning.allowedBy === null);
      if (unreviewed.length > 0) {
        const message = `failed the warnings gate: ${String(unreviewed.length)} warnings not in synth/warnings.allow, first: ${unreviewed[0]?.message ?? ''}`;
        return finish(
          { failureClass: 'unsupported-design', message },
          ['warnings'],
          true,
          measured,
          warnings,
        );
      }
      const found = spec.inspect?.(measured) ?? null;
      if (found !== null) {
        return finish(
          found,
          found.gates,
          true,
          { ...measured, areaUm2: unavailable(found.message) },
          warnings,
        );
      }
      return finish(null, [], true, measured, warnings);
    } catch (error) {
      return stopped('infrastructure-failure', (error as Error).message);
    }
  }

  /** The reviewed warnings of the repository, which a candidate cannot edit. */
  private allowlist(): AllowEntry[] {
    const file = join(this.repoRoot, MATMUL_DIR, 'synth', 'warnings.allow');
    return parseAllowlist(readFileSync(file, 'utf8'));
  }

  private yosysBinary(): string {
    if (this.yosys !== undefined) return this.yosys;
    const env = readFileSync(join(this.repoRoot, 'hardware', 'toolchain.env'), 'utf8');
    const version = /^OSS_CAD_SUITE_VERSION=(.+)$/m.exec(env)?.[1];
    if (version === undefined) throw new Error('hardware/toolchain.env has no version');
    const tools = process.env['VCPU8_TOOLS_DIR'] ?? join(homedir(), '.cache', 'vcpu8');
    return join(tools, `oss-cad-suite-${version}`, 'bin', 'yosys');
  }

  /** The repository's own Project 3 tree is never written to. */
  private assertOutDir(context: SynthesisContext): void {
    const inside = relative(join(this.repoRoot, MATMUL_DIR), resolve(context.outDir));
    if (!inside.startsWith('..')) {
      throw new Error(`outDir must be outside ${MATMUL_DIR}: ${context.outDir}`);
    }
  }
}
