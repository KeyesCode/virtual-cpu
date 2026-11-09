import type { AvailableMetric, Metric, UnavailableMetric } from '../domain/metric.js';

/**
 * Every unit a research metric may carry. A unit outside this list cannot be built with the
 * constructors here, so two metrics can only be combined when their units are known.
 */
export const METRIC_UNITS = [
  // Area
  'um^2',
  // Time
  'ps',
  'ns',
  // Frequency
  'MHz',
  'GHz',
  // Power
  'W',
  'mW',
  'uW',
  // Voltage
  'V',
  // Counts and sizes
  'count',
  'bits',
  'cycles',
  'ops/cycle',
  // Throughput, in millions or billions of operations per second
  'MOPS',
  'GOPS',
  // Ratios
  '%',
  // Derived
  'um^2*ns',
  'pJ/op',
  'GOPS/W',
  'GOPS/mm^2',
] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

export function isMetricUnit(unit: string): unit is MetricUnit {
  return (METRIC_UNITS as readonly string[]).includes(unit);
}

/**
 * Units that measure the same dimension, with the factor that converts one of them into the
 * dimension's base unit (the first of each group). Units outside every group convert only to
 * themselves: a `count` is never an area, and `cycles` are never `ns`.
 */
const DIMENSIONS: readonly (readonly [MetricUnit, number][])[] = [
  [
    ['ns', 1],
    ['ps', 1e-3],
  ],
  [
    ['MHz', 1],
    ['GHz', 1e3],
  ],
  [
    ['mW', 1],
    ['W', 1e3],
    ['uW', 1e-3],
  ],
  [
    ['MOPS', 1],
    ['GOPS', 1e3],
  ],
];

function factorToBase(unit: MetricUnit): { dimension: number; factor: number } | undefined {
  for (const [dimension, units] of DIMENSIONS.entries()) {
    const entry = units.find(([candidate]) => candidate === unit);
    if (entry) return { dimension, factor: entry[1] };
  }
  return undefined;
}

/**
 * The factor that turns a value in `from` into a value in `to`, or undefined when the two units
 * measure different things.
 */
export function conversionFactor(from: MetricUnit, to: MetricUnit): number | undefined {
  if (from === to) return 1;
  const source = factorToBase(from);
  const target = factorToBase(to);
  if (!source || !target || source.dimension !== target.dimension) return undefined;
  return source.factor / target.factor;
}

/** Where a value came from: the tool and the way it was obtained. */
export interface MetricSource {
  method?: string;
  tool?: string;
  toolVersion?: string;
  /**
   * Allows a negative value, for the few quantities that are signed (slack, improvement). Every
   * other quantity is refused when negative.
   */
  signed?: boolean;
}

/** Builds an available metric of the given provenance, refusing non-finite and unknown-unit values. */
export function availableMetric(
  provenance: AvailableMetric['provenance'],
  value: number,
  unit: MetricUnit,
  source: MetricSource,
): AvailableMetric {
  if (!isMetricUnit(unit)) throw new RangeError(`unknown metric unit: ${String(unit)}`);
  if (!Number.isFinite(value)) {
    throw new RangeError(`a ${provenance} metric needs a finite value, got ${String(value)}`);
  }
  if (value < 0 && source.signed !== true) {
    throw new RangeError(
      `a ${provenance} metric in ${unit} cannot be negative, got ${String(value)}`,
    );
  }
  const metric: AvailableMetric = { value: value === 0 ? 0 : value, unit, provenance };
  if (source.method !== undefined) metric.method = source.method;
  if (source.tool !== undefined) metric.tool = source.tool;
  if (source.toolVersion !== undefined) metric.toolVersion = source.toolVersion;
  return metric;
}

/** A value a tool reported for this exact design and configuration. */
export function measured(value: number, unit: MetricUnit, source: MetricSource = {}) {
  return availableMetric('measured', value, unit, source);
}

/** A value from a model or estimator (for example power from assumed switching activity). */
export function estimated(value: number, unit: MetricUnit, source: MetricSource = {}) {
  return availableMetric('estimated', value, unit, source);
}

/** A value from the architecture alone, such as a peak rate nobody has measured. */
export function theoretical(value: number, unit: MetricUnit, source: MetricSource = {}) {
  return availableMetric('theoretical', value, unit, source);
}

/** A value that does not exist. It has no `value`, so it can never be read as 0. */
export function unavailable(reason: string): UnavailableMetric {
  if (reason.trim() === '') throw new RangeError('an unavailable metric needs a reason');
  return { provenance: 'unavailable', reason };
}

export function isAvailable(metric: Metric): metric is AvailableMetric {
  return metric.provenance !== 'unavailable';
}

export function isUnavailable(metric: Metric): metric is UnavailableMetric {
  return metric.provenance === 'unavailable';
}

/** Strongest first: a derived value is only as strong as its weakest input. */
const PROVENANCE_STRENGTH: readonly AvailableMetric['provenance'][] = [
  'measured',
  'estimated',
  'theoretical',
];

/** The weakest of the given provenances (`measured` for none). */
export function weakestProvenance(
  provenances: readonly AvailableMetric['provenance'][],
): AvailableMetric['provenance'] {
  let weakest = 0;
  for (const provenance of provenances) {
    weakest = Math.max(weakest, PROVENANCE_STRENGTH.indexOf(provenance));
  }
  return PROVENANCE_STRENGTH[weakest] ?? 'theoretical';
}

/** A metric read in a required unit, or the reason it cannot be. */
export type Resolved =
  | { ok: true; value: number; provenance: AvailableMetric['provenance'] }
  | { ok: false; reason: string };

/**
 * Reads `metric` in `unit`, converting within a dimension (ps to ns, W to mW). Refuses an
 * unavailable metric and one whose unit measures something else; `name` labels the reason.
 */
export function requireUnit(metric: Metric, unit: MetricUnit, name: string): Resolved {
  if (isUnavailable(metric)) {
    return { ok: false, reason: `${name} is unavailable: ${metric.reason}` };
  }
  const factor = isMetricUnit(metric.unit) ? conversionFactor(metric.unit, unit) : undefined;
  if (factor === undefined) {
    return { ok: false, reason: `${name} must be in ${unit}, got ${metric.unit}` };
  }
  return { ok: true, value: metric.value * factor, provenance: metric.provenance };
}

/** Converts an available metric into another unit of the same dimension. */
export function convert(metric: Metric, unit: MetricUnit): Metric {
  const resolved = requireUnit(metric, unit, 'metric');
  if (!resolved.ok) return unavailable(resolved.reason);
  const converted: AvailableMetric = {
    ...(metric as AvailableMetric),
    value: resolved.value,
    unit,
  };
  return converted;
}
