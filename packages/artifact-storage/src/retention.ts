import { z } from 'zod';
import { type ArtifactKind, ArtifactKindSchema } from './kinds.js';
import type { ArtifactStat, ArtifactStore } from './store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long to keep the bytes of each kind. `null` days means forever. */
export const RetentionPolicySchema = z.strictObject({
  /** Per-kind rules. A kind without a rule falls back to `defaultMaxAgeDays`. */
  rules: z.array(
    z.strictObject({
      kind: ArtifactKindSchema,
      maxAgeDays: z.number().positive().nullable(),
    }),
  ),
  defaultMaxAgeDays: z.number().positive().nullable(),
});
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

/**
 * The default policy: everything that makes an experiment reproducible or reports what it measured
 * is kept forever; bulky by-products expire. Waveforms after 14 days, tool logs after 30.
 */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  rules: [
    { kind: 'reproducibility-manifest', maxAgeDays: null },
    { kind: 'experiment-config', maxAgeDays: null },
    { kind: 'candidate-source', maxAgeDays: null },
    { kind: 'patch', maxAgeDays: null },
    { kind: 'test-vectors', maxAgeDays: null },
    { kind: 'verification-report', maxAgeDays: null },
    { kind: 'synthesis-report', maxAgeDays: null },
    { kind: 'timing-report', maxAgeDays: null },
    { kind: 'power-report', maxAgeDays: null },
    { kind: 'agent-output', maxAgeDays: null },
    { kind: 'tool-log', maxAgeDays: 30 },
    { kind: 'waveform', maxAgeDays: 14 },
  ],
  defaultMaxAgeDays: null,
};

/** One object the policy expires. */
export interface RetentionDecision {
  readonly sha256: string;
  readonly kinds: readonly ArtifactKind[];
  readonly size: number;
  readonly ageDays: number;
  /** The longest retention among the object's kinds, which it has outlived. */
  readonly maxAgeDays: number;
  readonly reason: string;
}

export interface RetentionReport {
  readonly dryRun: boolean;
  readonly at: string;
  /** Unpruned objects the engine looked at. */
  readonly examined: number;
  /** Objects pruned (or, in a dry run, that would be). */
  readonly pruned: readonly RetentionDecision[];
  readonly prunedBytes: number;
}

/** The number of days an object of these kinds is kept, or `null` for forever. */
export function retentionDaysFor(
  kinds: readonly ArtifactKind[],
  policy: RetentionPolicy,
): number | null {
  // Bytes stored under several kinds are kept for the longest of their rules.
  let longest = 0;
  for (const kind of kinds) {
    const rule = policy.rules.find((candidate) => candidate.kind === kind);
    const days = rule === undefined ? policy.defaultMaxAgeDays : rule.maxAgeDays;
    if (days === null) return null;
    longest = Math.max(longest, days);
  }
  return longest;
}

/** Whether the policy expires this object at `now`; returns the decision or `null`. */
export function evaluateRetention(
  stat: ArtifactStat,
  now: Date,
  policy: RetentionPolicy,
): RetentionDecision | null {
  if (stat.pruned) return null;
  const maxAgeDays = retentionDaysFor(stat.kinds, policy);
  if (maxAgeDays === null) return null;
  const ageDays = (now.getTime() - Date.parse(stat.storedAt)) / DAY_MS;
  if (ageDays <= maxAgeDays) return null;
  return {
    sha256: stat.sha256,
    kinds: stat.kinds,
    size: stat.size,
    ageDays,
    maxAgeDays,
    reason: `retention: ${stat.kinds.join('+')} older than ${String(maxAgeDays)} days`,
  };
}

/**
 * Applies a retention policy to a store: the bytes of every expired object are removed and its
 * metadata kept, marked `pruned`. With `dryRun` it only reports what it would prune.
 */
export const RetentionEngine = {
  async apply(
    now: Date,
    policy: RetentionPolicy,
    store: ArtifactStore,
    options: { readonly dryRun?: boolean } = {},
  ): Promise<RetentionReport> {
    const parsed = RetentionPolicySchema.parse(policy);
    const dryRun = options.dryRun === true;
    const pruned: RetentionDecision[] = [];
    let examined = 0;
    // Collect first, prune after: a backend need not support mutation during its own listing.
    const decisions: RetentionDecision[] = [];
    for await (const stat of store.list()) {
      examined += 1;
      const decision = evaluateRetention(stat, now, parsed);
      if (decision !== null) decisions.push(decision);
    }
    for (const decision of decisions) {
      if (dryRun || (await store.prune(decision.sha256, decision.reason, now))) {
        pruned.push(decision);
      }
    }
    return {
      dryRun,
      at: now.toISOString(),
      examined,
      pruned,
      prunedBytes: pruned.reduce((total, decision) => total + decision.size, 0),
    };
  },
};
