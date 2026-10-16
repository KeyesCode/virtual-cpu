import type { BenchmarkReport, ProgramResult, ReportComparison } from '@vcpu/benchmarks';
import { opcodeById, OPCODES } from '@vcpu/shared';

/** A host duration in the unit that keeps it readable: `850 ns`, `12.34 µs`, `3.21 ms`. */
export function formatNs(ns: number): string {
  if (ns < 1e3) return `${ns.toFixed(0)} ns`;
  if (ns < 1e6) return `${(ns / 1e3).toFixed(2)} µs`;
  if (ns < 1e9) return `${(ns / 1e6).toFixed(2)} ms`;
  return `${(ns / 1e9).toFixed(2)} s`;
}

/** Instructions per second as `12.34 M/s`. */
export function formatIps(ips: number): string {
  return `${(ips / 1e6).toFixed(2)} M/s`;
}

/** `+12.3%` / `-4.0%`; `—` for `null`. */
export function formatPct(pct: number | null): string {
  if (pct === null) return '—';
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

/**
 * Left-aligned first column, right-aligned numbers, two spaces between columns. `minWidths` pads
 * columns further, so rows printed one at a time still line up.
 */
export function formatTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  minWidths: readonly number[] = [],
): string {
  const widths = header.map((h, i) =>
    Math.max(h.length, minWidths[i] ?? 0, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: readonly string[]) =>
    `  ${cells
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
      .join('  ')
      .trimEnd()}`;
  return [line(header), ...rows.map(line)].join('\n');
}

function labelled(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  return rows.map(([label, value]) => `  ${label.padEnd(width)}${value}`);
}

/** The `--samples`/`--warmup` line shared by every benchmark printout. */
export function formatSettings(settings: BenchmarkReport['settings']): string {
  const modes = settings.trace ? 'per mode (trace off, trace on)' : '(trace timing off)';
  return `${String(settings.warmupIterations)} warm-up + ${String(settings.samples)} timed samples ${modes}; each sample repeats the program for at least ${String(settings.minSampleMs)} ms`;
}

/** One program's host section and simulated section, labelled apart. */
export function formatProgramResult(result: ProgramResult): string {
  if (result.status === 'error') {
    return `  ${result.name}: not benchmarked: ${result.error}`;
  }
  const { host, simulated } = result;
  const t = host.timePerRunNs;
  const cv = t.mean > 0 ? (t.stddev / t.mean) * 100 : 0;
  const hostRows: [string, string][] = [
    ['Runs per sample', String(host.runsPerSample)],
    ['Median', formatNs(t.median)],
    ['Mean', `${formatNs(t.mean)} ± ${formatNs(t.stddev)} stddev (${cv.toFixed(1)}%)`],
    ['p5 / p95', `${formatNs(t.p5)} / ${formatNs(t.p95)}`],
    ['Min / max', `${formatNs(t.min)} / ${formatNs(t.max)}`],
    ['Instructions/s', `${formatIps(host.instructionsPerSecond)} (from the median)`],
    ['ns/instruction', host.nsPerInstruction.toFixed(1)],
  ];
  if (host.traced !== null) {
    hostRows.push([
      'Trace on',
      `median ${formatNs(host.traced.timePerRunNs.median)}: trace overhead ${formatPct(result.traceOverheadPct)}`,
    ]);
  }

  const total = simulated.instructions;
  const opcodes = OPCODES.map((info) => info.id)
    .filter((id) => simulated.opcodeCounts[id] !== undefined)
    .map((id) => [id, simulated.opcodeCounts[id] ?? 0] as const)
    .sort((a, b) => b[1] - a[1]);
  const simulatedRows: [string, string][] = [
    ['Instructions', String(total)],
    [
      'Est. cycles',
      `${String(simulated.estimatedCycles)} (timing-model estimate, not measured clock cycles)`,
    ],
    ['Memory reads', String(simulated.memoryReads)],
    ['Memory writes', String(simulated.memoryWrites)],
    ['Fetched bytes', String(simulated.fetchedBytes)],
    [
      'Branches',
      `${String(simulated.branchesTaken)} taken, ${String(simulated.branchesNotTaken)} not taken`,
    ],
  ];

  return [
    'Host time: measured on this machine, per program run (reset + run to HLT)',
    ...labelled(hostRows),
    '',
    'Simulated: deterministic CPU metrics, identical on every machine',
    ...labelled(simulatedRows),
    '  Opcode frequencies',
    formatTable(
      ['  Opcode', 'Count', 'Share'],
      opcodes.map(([id, count]) => [
        `  ${opcodeById[id].syntax}`,
        String(count),
        `${((count / total) * 100).toFixed(1)}%`,
      ]),
    ),
  ].join('\n');
}

export const SUITE_HOST_HEADER = ['Program', 'Median/run', 'CV', 'Instr/s', 'ns/instr', 'Trace'];

/** One row of the suite's host table; an errored program shows its error instead. */
export function suiteHostRow(result: ProgramResult): string[] {
  if (result.status === 'error') return [result.name, `error: ${result.error}`];
  const t = result.host.timePerRunNs;
  return [
    result.name,
    formatNs(t.median),
    `${(t.mean > 0 ? (t.stddev / t.mean) * 100 : 0).toFixed(1)}%`,
    formatIps(result.host.instructionsPerSecond),
    result.host.nsPerInstruction.toFixed(1),
    formatPct(result.traceOverheadPct),
  ];
}

/** The suite's simulated table: one row per program. */
export function formatSuiteSimulated(results: readonly ProgramResult[]): string {
  return formatTable(
    ['Program', 'Instr', 'Est. cycles', 'Reads', 'Writes', 'Taken', 'Not taken'],
    results.flatMap((r) => {
      const s = r.simulated;
      if (s === null) return [];
      return [
        [
          r.name,
          String(s.instructions),
          String(s.estimatedCycles),
          String(s.memoryReads),
          String(s.memoryWrites),
          String(s.branchesTaken),
          String(s.branchesNotTaken),
        ],
      ];
    }),
  );
}

const STATUS_TEXT = {
  regression: 'REGRESSION',
  improvement: 'faster',
  unchanged: 'within noise',
  new: 'new',
  missing: 'missing',
  error: 'error',
} as const;

export function formatComparison(comparison: ReportComparison): string {
  const rows = comparison.programs.map((p) => [
    p.name,
    p.baselineIps === null ? '—' : formatIps(p.baselineIps),
    p.currentIps === null ? '—' : formatIps(p.currentIps),
    formatPct(p.ipsDeltaPct),
    p.baselineMedianNs === null ? '—' : formatNs(p.baselineMedianNs),
    p.currentMedianNs === null ? '—' : formatNs(p.currentMedianNs),
    `${STATUS_TEXT[p.status]}${p.simulatedChanged ? ' (simulated work changed)' : ''}`,
  ]);
  const lines = [
    formatTable(
      ['Program', 'Baseline IPS', 'Current IPS', 'Δ IPS', 'Baseline/run', 'Current/run', 'Status'],
      rows,
    ),
    '',
    `${String(comparison.regressions)} regression${comparison.regressions === 1 ? '' : 's'} (IPS drop over ${String(comparison.thresholdPct)}%).`,
  ];
  if (comparison.differences.length > 0) {
    lines.push(
      '',
      'The reports differ in environment or settings, so host numbers are not directly comparable:',
      ...comparison.differences.map((d) => `  ${d}`),
    );
  }
  return lines.join('\n');
}
