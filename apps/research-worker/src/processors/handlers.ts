import type { FailureClass, StageState } from '@vcpu/research-core';
import type { Logger } from 'pino';

/** What a stage handler is given for one attempt. */
export interface StageContext {
  readonly experimentId: string;
  readonly campaignId: string;
  readonly stage: StageState;
  readonly attempt: number;
  /**
   * The key the stage's output is stored under. A handler that finds output under it from an
   * earlier attempt reuses it instead of doing the work again: that is what makes a re-run after a
   * crash or a recovery safe.
   */
  readonly idempotencyKey: string;
  /**
   * Aborted on timeout, cancellation, lease loss or shutdown. A handler passes it to every command
   * it starts (for example `spawn(..., { signal })`) so the command is killed with it.
   */
  readonly signal: AbortSignal;
  readonly logger: Logger;
}

/**
 * How one attempt of a stage ended. A design failure (`incorrect-design`, `unsupported-design`,
 * `policy-violation`) is a result and is returned, never thrown, so it cannot be mistaken for an
 * outage.
 */
export type StageOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly failureClass: FailureClass; readonly message: string };

export type StageHandler = (context: StageContext) => Promise<StageOutcome>;
export type StageHandlers = Partial<Record<StageState, StageHandler>>;

/**
 * A classified failure a handler may throw instead of returning. Any other thrown error is an
 * `infrastructure-failure`: the handler did not get far enough to say what went wrong.
 */
export class StageFailure extends Error {
  constructor(
    readonly failureClass: FailureClass,
    message: string,
  ) {
    super(message);
    this.name = 'StageFailure';
  }
}

/** Handlers that succeed at once, for every stage. The real EDA handlers come with the pipeline. */
export function createNoopHandlers(stages: readonly StageState[]): StageHandlers {
  const succeed: StageHandler = () => Promise.resolve({ ok: true });
  return Object.fromEntries(stages.map((stage) => [stage, succeed]));
}
