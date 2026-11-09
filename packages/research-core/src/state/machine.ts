import {
  EXPERIMENT_STATES,
  type ExperimentState,
  type FailureClass,
} from '../domain/experiment.js';
import {
  DEFAULT_RETRY_POLICY,
  isRejectionFailureClass,
  isRetryableFailureClass,
  retriesExhausted,
  type RejectionFailureClass,
  type RetryableFailureClass,
  type RetryPolicy,
} from './retry.js';

/** The states in which a stage does work, in pipeline order. */
export const STAGE_STATES = [
  'PREPARING',
  'GENERATING',
  'STATIC_VALIDATION',
  'COMPILING',
  'VERIFYING',
  'SYNTHESIZING',
  'PHYSICAL_ANALYSIS',
  'SCORING',
] as const satisfies readonly ExperimentState[];
export type StageState = (typeof STAGE_STATES)[number];

export const TERMINAL_STATES = [
  'COMPLETED',
  'REJECTED',
  'FAILED',
  'CANCELLED',
] as const satisfies readonly ExperimentState[];
export type TerminalState = (typeof TERMINAL_STATES)[number];

/** The stages a plan may leave out: generation for a supplied candidate, Tier 2 when unavailable. */
export const OPTIONAL_STAGES = [
  'GENERATING',
  'PHYSICAL_ANALYSIS',
] as const satisfies readonly StageState[];

export function isStageState(state: ExperimentState): state is StageState {
  return (STAGE_STATES as readonly ExperimentState[]).includes(state);
}

export function isTerminal(state: ExperimentState): state is TerminalState {
  return (TERMINAL_STATES as readonly ExperimentState[]).includes(state);
}

/**
 * What can happen to an experiment.
 *
 * - `enqueue`: it was put on the queue.
 * - `start`: a worker picked it up and begins the first stage.
 * - `advance`: the current stage succeeded; `to` is the next stage of the plan, or `COMPLETED`.
 * - `reject`: a stage found the design wrong or out of bounds. Never retried.
 * - `fail`: a retryable failure, after the retry policy's attempts for its class ran out.
 * - `cancel`: a person or a campaign stop ended it.
 * - `budget-exceeded`: a campaign limit was reached while it was live; it ends `CANCELLED` and keeps
 *   the class, so a budget stop is never mistaken for a broken tool.
 */
export type ExperimentEvent =
  | { readonly type: 'enqueue' }
  | { readonly type: 'start' }
  | { readonly type: 'advance'; readonly to: ExperimentState }
  | {
      readonly type: 'reject';
      readonly failureClass: RejectionFailureClass;
      readonly reason: string;
    }
  | {
      readonly type: 'fail';
      readonly failureClass: RetryableFailureClass;
      readonly attemptsMade: number;
      readonly reason: string;
    }
  | { readonly type: 'cancel'; readonly reason: string }
  | { readonly type: 'budget-exceeded'; readonly reason: string };
export type ExperimentEventType = ExperimentEvent['type'];

export const EXPERIMENT_EVENT_TYPES = [
  'enqueue',
  'start',
  'advance',
  'reject',
  'fail',
  'cancel',
  'budget-exceeded',
] as const satisfies readonly ExperimentEventType[];

type Edges = Readonly<Partial<Record<ExperimentEventType, readonly ExperimentState[]>>>;

/** Every live state can be cancelled, by a person or by a budget stop. */
const stoppable = { cancel: ['CANCELLED'], 'budget-exceeded': ['CANCELLED'] } as const;
/** Every stage can reject the design or fail after its retries. */
const stage = { ...stoppable, reject: ['REJECTED'], fail: ['FAILED'] } as const;

/**
 * The transition table: the only legal moves. Anything not listed is refused. `advance` skips only
 * an optional stage (`GENERATING` after `PREPARING`, `PHYSICAL_ANALYSIS` after `SYNTHESIZING`).
 */
export const TRANSITIONS: Readonly<Record<ExperimentState, Edges>> = {
  CREATED: { enqueue: ['QUEUED'], ...stoppable },
  QUEUED: { start: ['PREPARING'], ...stoppable },
  PREPARING: { advance: ['GENERATING', 'STATIC_VALIDATION'], ...stage },
  GENERATING: { advance: ['STATIC_VALIDATION'], ...stage },
  STATIC_VALIDATION: { advance: ['COMPILING'], ...stage },
  COMPILING: { advance: ['VERIFYING'], ...stage },
  VERIFYING: { advance: ['SYNTHESIZING'], ...stage },
  SYNTHESIZING: { advance: ['PHYSICAL_ANALYSIS', 'SCORING'], ...stage },
  PHYSICAL_ANALYSIS: { advance: ['SCORING'], ...stage },
  SCORING: { advance: ['COMPLETED'], ...stage },
  COMPLETED: {},
  REJECTED: {},
  FAILED: {},
  CANCELLED: {},
};

/** One `(from, event, to)` row of the table, for documentation and exhaustive tests. */
export interface TransitionEdge {
  readonly from: ExperimentState;
  readonly event: ExperimentEventType;
  readonly to: ExperimentState;
}

export function transitionEdges(): TransitionEdge[] {
  return EXPERIMENT_STATES.flatMap((from) =>
    EXPERIMENT_EVENT_TYPES.flatMap((event) =>
      (TRANSITIONS[from][event] ?? []).map((to) => ({ from, event, to })),
    ),
  );
}

/** A legal move, with what the persisted transition row records. */
export interface Transition {
  readonly from: ExperimentState;
  readonly to: ExperimentState;
  readonly event: ExperimentEvent;
  readonly failureClass: FailureClass | null;
  readonly reason: string | null;
}

export class InvalidTransition extends Error {
  constructor(
    readonly from: ExperimentState,
    readonly event: ExperimentEvent,
    detail: string,
  ) {
    super(`invalid transition from ${from} on ${event.type}: ${detail}`);
    this.name = 'InvalidTransition';
  }
}

export interface TransitionOptions {
  /** The policy whose caps decide whether a `fail` is allowed yet. */
  readonly retryPolicy?: RetryPolicy;
}

/**
 * Apply `event` to `state`. Returns the move, or throws `InvalidTransition` when the table does not
 * allow it, when `advance` names a target the table does not list, when a class does not belong to
 * its event, or when `fail` arrives while the class still has retries left.
 */
export function transition(
  state: ExperimentState,
  event: ExperimentEvent,
  options: TransitionOptions = {},
): Transition {
  const targets = TRANSITIONS[state][event.type];
  if (!targets || targets.length === 0) {
    throw new InvalidTransition(state, event, `${state} does not accept ${event.type}`);
  }
  const to = event.type === 'advance' ? event.to : targets[0];
  if (to === undefined || !targets.includes(to)) {
    throw new InvalidTransition(state, event, `${state} cannot advance to ${String(to)}`);
  }

  switch (event.type) {
    case 'reject':
      if (!isRejectionFailureClass(event.failureClass)) {
        throw new InvalidTransition(
          state,
          event,
          `${String(event.failureClass)} is not a rejection class`,
        );
      }
      return { from: state, to, event, failureClass: event.failureClass, reason: event.reason };
    case 'fail': {
      if (!isRetryableFailureClass(event.failureClass)) {
        throw new InvalidTransition(
          state,
          event,
          `${String(event.failureClass)} is not a retryable class`,
        );
      }
      const policy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
      if (!retriesExhausted(event.failureClass, event.attemptsMade, policy)) {
        throw new InvalidTransition(
          state,
          event,
          `${event.failureClass} has retries left (${String(event.attemptsMade)} of ${String(policy[event.failureClass].maxAttempts)} attempts made)`,
        );
      }
      return { from: state, to, event, failureClass: event.failureClass, reason: event.reason };
    }
    case 'budget-exceeded':
      return { from: state, to, event, failureClass: 'budget-exceeded', reason: event.reason };
    case 'cancel':
      return { from: state, to, event, failureClass: null, reason: event.reason };
    case 'enqueue':
    case 'start':
    case 'advance':
      return { from: state, to, event, failureClass: null, reason: null };
  }
}

export function canTransition(
  state: ExperimentState,
  event: ExperimentEvent,
  options: TransitionOptions = {},
): boolean {
  try {
    transition(state, event, options);
    return true;
  } catch (error) {
    if (error instanceof InvalidTransition) return false;
    throw error;
  }
}

/** Which optional stages an experiment runs. Both default to on. */
export interface StagePlanConfig {
  /** Off for a supplied candidate that skips the agent entirely. */
  readonly generation?: boolean;
  /** Off when the sandbox has no Tier 2 flow. */
  readonly physicalAnalysis?: boolean;
}

/** The stages an experiment runs, in order. Every adjacent pair is an `advance` edge of the table. */
export function stagesFor(config: StagePlanConfig = {}): StageState[] {
  return STAGE_STATES.filter(
    (state) =>
      (state !== 'GENERATING' || config.generation !== false) &&
      (state !== 'PHYSICAL_ANALYSIS' || config.physicalAnalysis !== false),
  );
}

/** The state after `current` succeeds: the next stage of the plan, or `COMPLETED` after the last. */
export function nextState(
  plan: readonly StageState[],
  current: StageState,
): StageState | 'COMPLETED' {
  const index = plan.indexOf(current);
  if (index < 0) throw new Error(`${current} is not a stage of this plan`);
  return plan[index + 1] ?? 'COMPLETED';
}

/**
 * The key a stage's work is idempotent under: a stage that finds output under its key from an
 * earlier attempt reuses it rather than doing the work again.
 */
export function stageIdempotencyKey(experimentId: string, stage: StageState): string {
  return `${experimentId}:${stage}`;
}

/**
 * The queue job id of one attempt of one stage. The attempt is part of it because a queue will not
 * add a job under an id it already holds, and a retry or a recovery needs a new job.
 */
export function stageJobId(experimentId: string, stage: StageState, attempt: number): string {
  return `${stageIdempotencyKey(experimentId, stage)}:${String(attempt)}`;
}
