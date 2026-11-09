import type { ExperimentState, FailureClass } from '../domain/experiment.js';
import type {
  ExperimentEvent,
  StageState,
  Transition,
  TransitionOptions,
} from '../state/machine.js';

/** The orchestration view of one experiment: its state, its lease and its heartbeat. */
export interface ExperimentRecord {
  readonly id: string;
  readonly campaignId: string;
  readonly status: ExperimentState;
  readonly failureClass: FailureClass | null;
  readonly failureReason: string | null;
  /** Attempts started of the current stage; 0 between stages. */
  readonly stageAttempt: number;
  /** The worker holding the current stage, or null. */
  readonly leaseOwner: string | null;
  readonly heartbeatAt: Date | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

/** One persisted state change. */
export interface TransitionRecord {
  readonly id: string;
  readonly experimentId: string;
  readonly fromState: ExperimentState | null;
  readonly toState: ExperimentState;
  readonly failureClass: FailureClass | null;
  readonly reason: string | null;
  /** The stage attempt that caused it, or null when no stage attempt did. */
  readonly attempt: number | null;
  readonly at: Date;
}

export interface AppendTransitionOptions extends TransitionOptions {
  /** Refuse unless the experiment is still in this state (a compare-and-set). */
  readonly expectedState?: ExperimentState;
  /** The stage attempt that caused the move, recorded on the transition row. */
  readonly attempt?: number;
  /** Refuse unless this worker still holds the stage's lease (it was not taken over). */
  readonly expectedLeaseOwner?: string;
}

export interface ClaimRequest {
  readonly stage: StageState;
  readonly owner: string;
  readonly attempt: number;
  /** A lease whose heartbeat is older than this is dead and may be taken over. */
  readonly staleBefore: Date;
}

/**
 * Persistence of the experiment lifecycle. Implementations must apply the status change and append
 * its `ExperimentTransition` row in one database transaction, and must decide legality with
 * `transition()` from the state machine, never by their own rules.
 */
export interface ExperimentRepository {
  load(id: string): Promise<ExperimentRecord | null>;

  /**
   * Apply `event` to the experiment's current state, in one transaction: lock the row, compute the
   * move with `transition()`, update the status (and failure class and reason, `startedAt` on
   * `start`, `completedAt` on a terminal state), release the lease, reset the stage attempt, refresh
   * the heartbeat and append the transition row. Throws `InvalidTransition` for an illegal move,
   * `StaleExperimentState` when `expectedState` no longer holds and `LeaseLost` when
   * `expectedLeaseOwner` no longer holds the lease.
   */
  appendTransition(
    id: string,
    event: ExperimentEvent,
    options?: AppendTransitionOptions,
  ): Promise<{ experiment: ExperimentRecord; transition: Transition; row: TransitionRecord }>;

  /**
   * Take the lease of the current stage for `owner`: succeeds only when the experiment is in
   * `stage`, the attempt is not older than the recorded one, and the lease is free, already
   * `owner`'s, or stale. Sets the heartbeat and the stage attempt. Returns null when it did not win.
   */
  claim(id: string, request: ClaimRequest): Promise<ExperimentRecord | null>;

  /** Refresh the heartbeat while `owner` holds the lease. False when it no longer does. */
  heartbeat(id: string, owner: string): Promise<boolean>;

  /**
   * Record that `attempt` of the current stage failed and a retry is scheduled: the lease is
   * released and the heartbeat refreshed. False when `owner` no longer holds the lease.
   */
  releaseForRetry(id: string, owner: string, attempt: number): Promise<boolean>;

  /** Experiments in `states` whose heartbeat is older than `staleBefore` (or missing). */
  findStale(
    states: readonly ExperimentState[],
    staleBefore: Date,
    limit: number,
  ): Promise<ExperimentRecord[]>;

  /**
   * Take a stale experiment over for recovery: refresh its heartbeat and clear its lease, but only
   * while it is still in `expected.status` at `expected.stageAttempt` with a heartbeat older than
   * `staleBefore`. Of several racing recoverers exactly one wins (a conditional
   * `UPDATE … RETURNING`); the others get null.
   */
  reclaimStale(
    id: string,
    expected: { readonly status: ExperimentState; readonly stageAttempt: number },
    staleBefore: Date,
  ): Promise<ExperimentRecord | null>;

  transitions(id: string): Promise<TransitionRecord[]>;
}

/** The experiment moved on before a compare-and-set transition was applied. */
export class StaleExperimentState extends Error {
  constructor(
    readonly experimentId: string,
    readonly expected: ExperimentState,
    readonly actual: ExperimentState,
  ) {
    super(`experiment ${experimentId} is ${actual}, not ${expected}`);
    this.name = 'StaleExperimentState';
  }
}

export class ExperimentNotFound extends Error {
  constructor(readonly experimentId: string) {
    super(`experiment ${experimentId} does not exist`);
    this.name = 'ExperimentNotFound';
  }
}

/** Another worker took the stage over (this one's heartbeat went stale). */
export class LeaseLost extends Error {
  constructor(
    readonly experimentId: string,
    readonly owner: string,
    readonly holder: string | null,
  ) {
    super(`experiment ${experimentId}: lease is held by ${holder ?? 'nobody'}, not ${owner}`);
    this.name = 'LeaseLost';
  }
}
