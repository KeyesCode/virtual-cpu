import { z } from 'zod';
import { QuantitySchema } from '../domain/metric.js';
import { Sha256Schema } from '../domain/primitives.js';
import { PpaSnapshotSchema } from './ppa.js';

/**
 * Everything that must be identical for two evaluations to be compared (brief §15, decisions §5):
 * the frozen baseline, the tools, the sandbox image, the library, the clock constraint, the
 * synthesis and physical-design settings and the campaign's fixed verification seeds and counts.
 * Nothing experiment-specific (such as the experiment's own seed) belongs here.
 */
export const EvaluationConfigSchema = z.strictObject({
  baselineId: z.string().min(1),
  /** Tool name to exact version, e.g. `{ yosys: '0.70+145', opensta: '2.6.0' }`. */
  toolVersions: z.record(z.string().min(1), z.string().min(1)),
  /** The sandbox image digest, e.g. `sha256:…`. */
  imageDigest: z.string().min(1),
  /** The PDK and standard-cell library, e.g. `sky130_fd_sc_hd`. */
  targetTechnology: z.string().min(1),
  /** The liberty file, relative to the repository, e.g. `…/sky130_fd_sc_hd__tt_025C_1v80.lib`. */
  libertyFile: z.string().min(1),
  libertySha256: Sha256Schema,
  /** The frozen clock constraint STA times against. */
  clockPeriod: QuantitySchema,
  synthesisSettings: z.record(z.string(), z.unknown()),
  /** Null when the physical flow (Tier 2) is not run. */
  physicalDesignSettings: z.record(z.string(), z.unknown()).nullable(),
  /** The campaign's fixed seeds and corpus sizes. */
  verification: z.record(z.string().min(1), z.union([z.string(), z.number(), z.boolean()])),
});
export type EvaluationConfig = z.infer<typeof EvaluationConfigSchema>;

/** One design evaluated under one configuration. */
export const EvaluationSchema = z.strictObject({
  evaluationConfig: EvaluationConfigSchema,
  evaluationConfigHash: Sha256Schema,
  ppa: PpaSnapshotSchema,
});
export type Evaluation = z.infer<typeof EvaluationSchema>;

/**
 * JSON with object keys sorted at every level, so equal values give equal text. An `undefined`
 * property is left out, as `JSON.stringify` does; anything else JSON cannot represent faithfully
 * (non-finite numbers, `undefined` in an array, functions, symbols, bigints) is refused.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`cannot canonicalise ${String(value)}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  throw new TypeError(`cannot canonicalise a ${typeof value}`);
}

/** A SHA-256 function returning lowercase hex, e.g. one built on `node:crypto` by the caller. */
export type Sha256Hasher = (text: string) => string;

/**
 * `evaluationConfigHash`: the SHA-256 of the canonical JSON of the config. The hasher is injected
 * so this package stays free of Node APIs.
 */
export function hashEvaluationConfig(config: EvaluationConfig, sha256: Sha256Hasher): string {
  const digest = sha256(canonicalJson(EvaluationConfigSchema.parse(config)));
  if (!Sha256Schema.safeParse(digest).success) {
    throw new TypeError('the hasher must return a lowercase hexadecimal SHA-256 digest');
  }
  return digest;
}
