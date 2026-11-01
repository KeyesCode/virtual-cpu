import { z } from 'zod';
import { GitCommitSchema, Sha256Schema } from './primitives.js';
import { MetricMapSchema, QuantitySchema } from './metric.js';

/** Timing is fixed before a baseline is created, because the baseline row is immutable. */
export const TimingConstraintsSchema = z.looseObject({
  clockPeriod: QuantitySchema,
});
export type TimingConstraints = z.infer<typeof TimingConstraintsSchema>;

/** A frozen hardware baseline (brief §9), as written to research/baselines/<name>/baseline.json. */
export const BaselineManifestSchema = z.strictObject({
  name: z.string().min(1),
  sourceCommit: GitCommitSchema,
  sourceContentHash: Sha256Schema,
  parameters: z.record(z.string().min(1), z.union([z.number(), z.string()])),
  verificationSuiteVersion: z.string().min(1),
  synthesisConfig: z.record(z.string(), z.unknown()),
  timingConstraints: TimingConstraintsSchema,
  targetTechnology: z.string().min(1),
  toolVersions: z.record(z.string().min(1), z.string().min(1)),
  metrics: MetricMapSchema,
});
export type BaselineManifest = z.infer<typeof BaselineManifestSchema>;
