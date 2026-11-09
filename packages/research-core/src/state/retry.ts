import { z } from 'zod';
import { FAILURE_CLASSES, type FailureClass } from '../domain/experiment.js';

/**
 * The three classes a retry can fix: the tool, the clock or the machine went wrong, not the design.
 * Everything else is a result (`incorrect-design`, `unsupported-design`, `policy-violation`) or a
 * stop (`budget-exceeded`), and running it again would only spend budget and hide the finding.
 */
export const RETRYABLE_FAILURE_CLASSES = [
  'tool-failure',
  'timeout',
  'infrastructure-failure',
] as const satisfies readonly FailureClass[];
export type RetryableFailureClass = (typeof RETRYABLE_FAILURE_CLASSES)[number];

/** The classes that end an experiment as `REJECTED`: the design itself is wrong or out of bounds. */
export const REJECTION_FAILURE_CLASSES = [
  'incorrect-design',
  'unsupported-design',
  'policy-violation',
] as const satisfies readonly FailureClass[];
export type RejectionFailureClass = (typeof REJECTION_FAILURE_CLASSES)[number];

export function isRetryableFailureClass(value: FailureClass): value is RetryableFailureClass {
  return (RETRYABLE_FAILURE_CLASSES as readonly FailureClass[]).includes(value);
}

export function isRejectionFailureClass(value: FailureClass): value is RejectionFailureClass {
  return (REJECTION_FAILURE_CLASSES as readonly FailureClass[]).includes(value);
}

/** Exponential backoff: `delayMs × 2^(attempt − 1)`, capped at `maxDelayMs`. */
export const BackoffSchema = z.strictObject({
  delayMs: z.number().int().nonnegative(),
  maxDelayMs: z.number().int().nonnegative(),
});
export type Backoff = z.infer<typeof BackoffSchema>;

/**
 * How one failure class is retried. `maxAttempts` counts every attempt of the stage, the first
 * included, so a non-retryable class has exactly one.
 */
export const RetryRuleSchema = z.discriminatedUnion('retryable', [
  z.strictObject({
    retryable: z.literal(true),
    maxAttempts: z.number().int().min(1),
    backoff: BackoffSchema,
  }),
  z.strictObject({ retryable: z.literal(false), maxAttempts: z.literal(1) }),
]);
export type RetryRule = z.infer<typeof RetryRuleSchema>;

export const RetryPolicySchema = z
  .strictObject(
    Object.fromEntries(FAILURE_CLASSES.map((failureClass) => [failureClass, RetryRuleSchema])) as {
      [K in FailureClass]: typeof RetryRuleSchema;
    },
  )
  .refine(
    (policy) =>
      FAILURE_CLASSES.every(
        (failureClass) => policy[failureClass].retryable === isRetryableFailureClass(failureClass),
      ),
    { message: 'only tool-failure, timeout and infrastructure-failure may be retryable' },
  );
export type RetryPolicy = Readonly<Record<FailureClass, RetryRule>>;

const never = { retryable: false, maxAttempts: 1 } as const;

/**
 * The default caps. A tool that crashes three times on the same input is broken for that input; a
 * stage that times out twice will time out again; infrastructure (Docker, Postgres, Redis, a worker
 * that died) gets the most patience because it usually comes back.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  'incorrect-design': never,
  'unsupported-design': never,
  'tool-failure': {
    retryable: true,
    maxAttempts: 3,
    backoff: { delayMs: 2_000, maxDelayMs: 30_000 },
  },
  timeout: { retryable: true, maxAttempts: 2, backoff: { delayMs: 5_000, maxDelayMs: 30_000 } },
  'infrastructure-failure': {
    retryable: true,
    maxAttempts: 5,
    backoff: { delayMs: 5_000, maxDelayMs: 60_000 },
  },
  'budget-exceeded': never,
  'policy-violation': never,
};

/** The delay before attempt `attemptsMade + 1`, after `attemptsMade` attempts have failed. */
export function backoffDelayMs(backoff: Backoff, attemptsMade: number): number {
  const exponent = Math.max(0, attemptsMade - 1);
  return Math.min(backoff.maxDelayMs, backoff.delayMs * 2 ** exponent);
}

/** Whether a retryable class has used up its attempts. A non-retryable class always has. */
export function retriesExhausted(
  failureClass: FailureClass,
  attemptsMade: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): boolean {
  return attemptsMade >= policy[failureClass].maxAttempts;
}

/** What to do after a stage attempt failed with `failureClass`. */
export type FailureDecision =
  | { readonly action: 'retry'; readonly nextAttempt: number; readonly delayMs: number }
  | {
      readonly action: 'reject';
      readonly failureClass: RejectionFailureClass;
    }
  | { readonly action: 'fail'; readonly failureClass: RetryableFailureClass }
  | { readonly action: 'cancel'; readonly failureClass: 'budget-exceeded' };

/**
 * Decide a failed attempt. `attemptsMade` counts the attempt that just failed. Correctness and
 * policy failures are never retried, whatever the count; a retryable class is retried until its
 * cap, then fails the experiment.
 */
export function decideFailure(
  failureClass: FailureClass,
  attemptsMade: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): FailureDecision {
  if (failureClass === 'budget-exceeded') return { action: 'cancel', failureClass };
  if (isRejectionFailureClass(failureClass)) return { action: 'reject', failureClass };
  const rule = policy[failureClass];
  if (rule.retryable && attemptsMade < rule.maxAttempts) {
    return {
      action: 'retry',
      nextAttempt: attemptsMade + 1,
      delayMs: backoffDelayMs(rule.backoff, attemptsMade),
    };
  }
  return { action: 'fail', failureClass };
}
