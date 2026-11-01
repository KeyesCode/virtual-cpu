import { z } from 'zod';

export const METRIC_PROVENANCES = ['measured', 'estimated', 'theoretical', 'unavailable'] as const;
export const MetricProvenanceSchema = z.enum(METRIC_PROVENANCES);
export type MetricProvenance = z.infer<typeof MetricProvenanceSchema>;

/** The three tiers of decisions §3, which are never mixed in one comparison. */
export const METRIC_TIERS = ['technology-independent', 'technology-mapped', 'physical'] as const;
export const MetricTierSchema = z.enum(METRIC_TIERS);
export type MetricTier = z.infer<typeof MetricTierSchema>;

/** A physical amount. A number with no unit is not representable. */
export const QuantitySchema = z.strictObject({
  value: z.number(),
  unit: z.string().min(1),
});
export type Quantity = z.infer<typeof QuantitySchema>;

export const AvailableMetricSchema = z.strictObject({
  value: z.number(),
  unit: z.string().min(1),
  provenance: z.enum(['measured', 'estimated', 'theoretical']),
  method: z.string().min(1).optional(),
  tool: z.string().min(1).optional(),
  toolVersion: z.string().min(1).optional(),
});
export type AvailableMetric = z.infer<typeof AvailableMetricSchema>;

/** Has no `value` key at all, so that "unavailable" can never be read as 0. */
export const UnavailableMetricSchema = z.strictObject({
  provenance: z.literal('unavailable'),
  reason: z.string().min(1),
});
export type UnavailableMetric = z.infer<typeof UnavailableMetricSchema>;

export const MetricSchema = z.discriminatedUnion('provenance', [
  AvailableMetricSchema,
  UnavailableMetricSchema,
]);
export type Metric = z.infer<typeof MetricSchema>;

export const MetricMapSchema = z.record(z.string().min(1), MetricSchema);
export type MetricMap = z.infer<typeof MetricMapSchema>;
