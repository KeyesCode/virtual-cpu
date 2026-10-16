import type { BenchmarkReport, ProgramResult } from './report.js';

/** Default regression threshold: an IPS drop larger than this percentage is flagged. */
export const DEFAULT_REGRESSION_THRESHOLD_PCT = 5;

/**
 * - `regression` / `improvement`: instructions per second moved by more than the threshold.
 * - `unchanged`: within the threshold, which is treated as noise.
 * - `new` / `missing`: the program is only in the current / only in the baseline report.
 * - `error`: either report holds an error for it, so there is nothing to compare.
 */
export type ComparisonStatus =
  'regression' | 'improvement' | 'unchanged' | 'new' | 'missing' | 'error';

export interface ProgramComparison {
  readonly name: string;
  readonly status: ComparisonStatus;
  readonly baselineIps: number | null;
  readonly currentIps: number | null;
  /** (current − baseline) / baseline × 100 for instructions per second; positive is faster. */
  readonly ipsDeltaPct: number | null;
  readonly baselineMedianNs: number | null;
  readonly currentMedianNs: number | null;
  /** The same delta for the median host time per run; negative is faster. */
  readonly timeDeltaPct: number | null;
  /**
   * The simulated instruction count or estimated cycles differ: the program or the CPU's behavior
   * changed, so the host numbers measure different work.
   */
  readonly simulatedChanged: boolean;
}

export interface ReportComparison {
  readonly thresholdPct: number;
  readonly programs: readonly ProgramComparison[];
  readonly regressions: number;
  /** Environment and settings that differ, e.g. `cpuModel: Apple M1 → Apple M3`. */
  readonly differences: readonly string[];
}

function deltaPct(baseline: number, current: number): number | null {
  return baseline === 0 ? null : ((current - baseline) / baseline) * 100;
}

function compareProgram(
  name: string,
  baseline: ProgramResult | undefined,
  current: ProgramResult | undefined,
  thresholdPct: number,
): ProgramComparison {
  const empty = {
    name,
    baselineIps: null,
    currentIps: null,
    ipsDeltaPct: null,
    baselineMedianNs: null,
    currentMedianNs: null,
    timeDeltaPct: null,
    simulatedChanged: false,
  };
  if (baseline === undefined) return { ...empty, status: 'new' };
  if (current === undefined) return { ...empty, status: 'missing' };
  if (baseline.status !== 'ok' || current.status !== 'ok') return { ...empty, status: 'error' };

  const baselineIps = baseline.host.instructionsPerSecond;
  const currentIps = current.host.instructionsPerSecond;
  const ipsDeltaPct = deltaPct(baselineIps, currentIps);
  let status: ComparisonStatus = 'unchanged';
  if (ipsDeltaPct !== null && ipsDeltaPct < -thresholdPct) status = 'regression';
  else if (ipsDeltaPct !== null && ipsDeltaPct > thresholdPct) status = 'improvement';
  return {
    name,
    status,
    baselineIps,
    currentIps,
    ipsDeltaPct,
    baselineMedianNs: baseline.host.timePerRunNs.median,
    currentMedianNs: current.host.timePerRunNs.median,
    timeDeltaPct: deltaPct(baseline.host.timePerRunNs.median, current.host.timePerRunNs.median),
    simulatedChanged:
      baseline.simulated.instructions !== current.simulated.instructions ||
      baseline.simulated.estimatedCycles !== current.simulated.estimatedCycles,
  };
}

function differences(baseline: BenchmarkReport, current: BenchmarkReport): string[] {
  const pairs: [string, unknown, unknown][] = [
    ['isaVersion', baseline.isaVersion, current.isaVersion],
    ['runtime', baseline.environment.runtime, current.environment.runtime],
    ['platform', baseline.environment.platform, current.environment.platform],
    ['arch', baseline.environment.arch, current.environment.arch],
    ['cpuModel', baseline.environment.cpuModel, current.environment.cpuModel],
    ...Object.entries(baseline.settings).map(([key, value]): [string, unknown, unknown] => [
      `settings.${key}`,
      value,
      current.settings[key as keyof BenchmarkReport['settings']],
    ]),
  ];
  return pairs
    .filter(([, before, after]) => before !== after)
    .map(([key, before, after]) => `${key}: ${String(before)} → ${String(after)}`);
}

/**
 * Compares `current` against `baseline`, program by program (baseline order, then programs only
 * in `current`). Host numbers from different machines or settings are not comparable; see
 * `differences`.
 */
export function compareReports(
  baseline: BenchmarkReport,
  current: BenchmarkReport,
  options: { readonly thresholdPct?: number } = {},
): ReportComparison {
  const thresholdPct = options.thresholdPct ?? DEFAULT_REGRESSION_THRESHOLD_PCT;
  if (!(Number.isFinite(thresholdPct) && thresholdPct >= 0)) {
    throw new RangeError(`thresholdPct must be ≥ 0, got ${String(thresholdPct)}`);
  }
  const before = new Map(baseline.programs.map((p) => [p.name, p]));
  const after = new Map(current.programs.map((p) => [p.name, p]));
  const names = [...before.keys(), ...[...after.keys()].filter((name) => !before.has(name))];
  const programs = names.map((name) =>
    compareProgram(name, before.get(name), after.get(name), thresholdPct),
  );
  return {
    thresholdPct,
    programs,
    regressions: programs.filter((p) => p.status === 'regression').length,
    differences: differences(baseline, current),
  };
}
