import { z } from 'zod';
import { type Metric, MetricSchema } from '../domain/metric.js';
import { type MetricUnit, unavailable } from './metric.js';

/**
 * The units each field of a {@link PpaSnapshot} accepts. A field in any other unit is refused by
 * {@link PpaSnapshotSchema}; an unavailable field is always accepted.
 */
export const PPA_UNITS = {
  /** Brief §14 performance. Tier 1 (STA at the frozen clock) for the timing fields. */
  performance: {
    /** Execution cycles of the measured workload. */
    cycles: ['cycles'],
    /** Multiply-accumulates completed per clock. */
    macsPerCycle: ['ops/cycle'],
    /** Operations per second at the operating clock. */
    throughput: ['MOPS', 'GOPS'],
    /** First operand in to result out. */
    latency: ['cycles', 'ns', 'ps'],
    /** The clock constraint the design was timed against. */
    clockPeriod: ['ns', 'ps'],
    /** The worst path STA reported: the delay in the campaign's ADP. */
    criticalPath: ['ns', 'ps'],
    /** Worst slack at `clockPeriod`; negative when timing fails. */
    worstSlack: ['ns', 'ps'],
    /** Sum of the negative slack of all failing endpoints (0 or negative). */
    totalNegativeSlack: ['ns', 'ps'],
    /** Share of PE-cycles doing useful work. */
    peUtilization: ['%'],
  },
  /** Brief §14 area. Tier 1 (liberty-mapped) except `coreArea`, which is Tier 2 (physical). */
  area: {
    /** Total cell area from the liberty file. The area in the campaign's ADP. */
    cellArea: ['um^2'],
    logicCells: ['count'],
    sequentialCells: ['count'],
    memoryBits: ['bits'],
    memoryArea: ['um^2'],
    /** Floorplanned core area, from the physical flow only. */
    coreArea: ['um^2'],
  },
  /** Brief §14 power. Never `measured`: no physical measurement exists. */
  power: {
    dynamic: ['W', 'mW', 'uW'],
    leakage: ['W', 'mW', 'uW'],
    total: ['W', 'mW', 'uW'],
    /** Share of nets with annotated switching activity. */
    switchingActivityCoverage: ['%'],
    voltage: ['V'],
    frequency: ['MHz', 'GHz'],
  },
  /** Tier 0: Yosys generic synthesis. Counts, never area or delay. */
  technologyIndependent: {
    genericCells: ['count'],
    flipFlops: ['count'],
    /** `$mul` cells. */
    mulCells: ['count'],
    /** `abc -g AND,NAND,OR,NOR,XOR,XNOR,MUX` gates. */
    abstractGates: ['count'],
    /** `ltp -noff` levels. */
    logicDepth: ['count'],
  },
} as const satisfies Record<string, Record<string, readonly MetricUnit[]>>;

/** The fields that hold a signed quantity. */
const SIGNED_FIELDS: ReadonlySet<string> = new Set(['worstSlack', 'totalNegativeSlack']);

/** A metric schema that accepts only `units` (and refuses `measured` when `measurable` is false). */
export function metricInUnits(
  units: readonly MetricUnit[],
  options: { measurable?: boolean; signed?: boolean } = {},
): z.ZodType<Metric> {
  return MetricSchema.superRefine((metric, context) => {
    if (metric.provenance === 'unavailable') return;
    if (!(units as readonly string[]).includes(metric.unit)) {
      context.addIssue({
        code: 'custom',
        message: `unit must be one of ${units.join(', ')}, got ${metric.unit}`,
        path: ['unit'],
      });
    }
    if (!Number.isFinite(metric.value) || (metric.value < 0 && options.signed !== true)) {
      context.addIssue({
        code: 'custom',
        message: `value must be finite${options.signed === true ? '' : ' and non-negative'}`,
        path: ['value'],
      });
    }
    if (options.measurable === false && metric.provenance === 'measured') {
      context.addIssue({
        code: 'custom',
        message: 'cannot be measured without a physical measurement; use estimated',
        path: ['provenance'],
      });
    }
  });
}

type MetricGroup<T> = { [K in keyof T]: Metric };
type MetricGroupShape<T> = { [K in keyof T]: z.ZodType<Metric> };

function groupSchema<T extends Record<string, readonly MetricUnit[]>>(
  units: T,
  options: { measurable?: boolean } = {},
) {
  const shape = Object.fromEntries(
    Object.entries(units).map(([field, fieldUnits]) => [
      field,
      metricInUnits(fieldUnits, { ...options, signed: SIGNED_FIELDS.has(field) }),
    ]),
  ) as MetricGroupShape<T>;
  return z.strictObject(shape);
}

export const PpaSnapshotSchema = z.strictObject({
  performance: groupSchema(PPA_UNITS.performance),
  area: groupSchema(PPA_UNITS.area),
  power: groupSchema(PPA_UNITS.power, { measurable: false }).extend({
    /** How power was estimated (tool, activity source), or null when no estimate exists. */
    method: z.string().min(1).nullable(),
  }),
  technologyIndependent: groupSchema(PPA_UNITS.technologyIndependent),
});

/** Every PPA value of one evaluated design, each with its unit and provenance. */
export type PpaSnapshot = z.infer<typeof PpaSnapshotSchema>;

function unavailableGroup<T extends Record<string, readonly MetricUnit[]>>(
  units: T,
  reason: string,
): MetricGroup<T> {
  return Object.fromEntries(
    Object.keys(units).map((field) => [field, unavailable(reason)]),
  ) as MetricGroup<T>;
}

/** A snapshot in which nothing is known yet: the starting point a pipeline fills in. */
export function unavailablePpaSnapshot(reason: string): PpaSnapshot {
  return {
    performance: unavailableGroup(PPA_UNITS.performance, reason),
    area: unavailableGroup(PPA_UNITS.area, reason),
    power: { ...unavailableGroup(PPA_UNITS.power, reason), method: null },
    technologyIndependent: unavailableGroup(PPA_UNITS.technologyIndependent, reason),
  };
}
