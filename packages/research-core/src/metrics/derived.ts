import type { AvailableMetric, Metric } from '../domain/metric.js';
import {
  availableMetric,
  isMetricUnit,
  isUnavailable,
  type MetricUnit,
  requireUnit,
  unavailable,
  weakestProvenance,
} from './metric.js';

export interface DeriveOptions {
  /**
   * Lets a theoretical input through; the result is then `theoretical`. Off by default, so a
   * derived value is never built on numbers nobody measured or estimated.
   */
  allowTheoretical?: boolean;
}

interface Input {
  name: string;
  metric: Metric;
  unit: MetricUnit;
}

/**
 * Reads every input in its required unit and computes the result with the weakest input's
 * provenance. `compute` returns a number, or a string saying why there is no result.
 */
function derive(
  inputs: readonly Input[],
  output: { unit: MetricUnit; method: string; signed?: boolean },
  options: DeriveOptions,
  compute: (values: number[]) => number | string,
): Metric {
  const values: number[] = [];
  const provenances: AvailableMetric['provenance'][] = [];
  for (const input of inputs) {
    const resolved = requireUnit(input.metric, input.unit, input.name);
    if (!resolved.ok) return unavailable(resolved.reason);
    if (resolved.provenance === 'theoretical' && options.allowTheoretical !== true) {
      return unavailable(`${input.name} is theoretical-only`);
    }
    values.push(resolved.value);
    provenances.push(resolved.provenance);
  }
  const result = compute(values);
  if (typeof result === 'string') return unavailable(result);
  if (!Number.isFinite(result)) return unavailable(`${output.method} is not finite`);
  return availableMetric(weakestProvenance(provenances), result, output.unit, {
    method: output.method,
    signed: output.signed ?? false,
  });
}

function nonZero(name: string, value: number): string | undefined {
  return value === 0 ? `division by zero: ${name} is 0` : undefined;
}

/**
 * Area-delay product in µm²·ns: cell area (µm²) × critical-path delay (ns, ps is converted).
 * The campaign's ADP is the sky130hd liberty cell area times the STA critical path at the
 * frozen clock constraint.
 */
export function areaDelayProduct(area: Metric, delay: Metric, options: DeriveOptions = {}) {
  return derive(
    [
      { name: 'area', metric: area, unit: 'um^2' },
      { name: 'delay', metric: delay, unit: 'ns' },
    ],
    { unit: 'um^2*ns', method: 'area-delay product: area (um^2) x delay (ns)' },
    options,
    ([a = 0, d = 0]) => a * d,
  );
}

/**
 * Relative improvement versus the baseline, in %, for a lower-is-better metric such as ADP
 * (brief §15): `(baseline − candidate) / baseline × 100`. Positive is better, negative is worse.
 * Both metrics must be in the same dimension (the candidate is converted to the baseline's unit).
 * Full precision: rounding is the caller's job.
 */
export function improvementPercent(
  baseline: Metric,
  candidate: Metric,
  options: DeriveOptions = {},
) {
  if (isUnavailable(baseline)) return unavailable(`baseline is unavailable: ${baseline.reason}`);
  if (!isMetricUnit(baseline.unit))
    return unavailable(`baseline has unknown unit ${baseline.unit}`);
  return derive(
    [
      { name: 'baseline', metric: baseline, unit: baseline.unit },
      { name: 'candidate', metric: candidate, unit: baseline.unit },
    ],
    { unit: '%', method: 'improvement: (baseline - candidate) / baseline x 100', signed: true },
    options,
    ([b = 0, c = 0]) => nonZero('baseline', b) ?? ((b - c) * 100) / b,
  );
}

/** Energy per operation in pJ/op: total power ÷ throughput (mW ÷ MOPS = nJ/op, × 1000). */
export function energyPerOp(power: Metric, throughput: Metric, options: DeriveOptions = {}) {
  return derive(
    [
      { name: 'power', metric: power, unit: 'mW' },
      { name: 'throughput', metric: throughput, unit: 'MOPS' },
    ],
    { unit: 'pJ/op', method: 'energy per operation: power / throughput' },
    options,
    ([p = 0, t = 0]) => nonZero('throughput', t) ?? (p / t) * 1e3,
  );
}

/** Performance per watt in GOPS/W: throughput ÷ total power (MOPS ÷ mW = GOPS/W). */
export function perfPerWatt(throughput: Metric, power: Metric, options: DeriveOptions = {}) {
  return derive(
    [
      { name: 'throughput', metric: throughput, unit: 'MOPS' },
      { name: 'power', metric: power, unit: 'mW' },
    ],
    { unit: 'GOPS/W', method: 'performance per watt: throughput / power' },
    options,
    ([t = 0, p = 0]) => nonZero('power', p) ?? t / p,
  );
}

/** Throughput per area in GOPS/mm²: throughput ÷ area (MOPS ÷ µm² × 1000). */
export function throughputPerArea(throughput: Metric, area: Metric, options: DeriveOptions = {}) {
  return derive(
    [
      { name: 'throughput', metric: throughput, unit: 'MOPS' },
      { name: 'area', metric: area, unit: 'um^2' },
    ],
    { unit: 'GOPS/mm^2', method: 'throughput per area: throughput / area' },
    options,
    ([t = 0, a = 0]) => nonZero('area', a) ?? (t / a) * 1e3,
  );
}
