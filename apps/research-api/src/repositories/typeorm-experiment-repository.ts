import {
  ExperimentNotFound,
  LeaseLost,
  StaleExperimentState,
  isTerminal,
  transition,
  type AppendTransitionOptions,
  type ClaimRequest,
  type ExperimentEvent,
  type ExperimentRecord,
  type ExperimentRepository,
  type ExperimentState,
  type FailureClass,
  type Transition,
  type TransitionRecord,
} from '@vcpu/research-core';
import type { DataSource, EntityManager } from 'typeorm';
import { newId } from '../entities/new-id.js';

interface ExperimentRow {
  id: string;
  campaign_id: string;
  status: ExperimentState;
  failure_class: FailureClass | null;
  failure_reason: string | null;
  stage_attempt: number;
  lease_owner: string | null;
  heartbeat_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
}

interface TransitionRow {
  id: string;
  experiment_id: string;
  from_state: ExperimentState | null;
  to_state: ExperimentState;
  failure_class: FailureClass | null;
  reason: string | null;
  attempt: number | null;
  at: Date;
}

const EXPERIMENT_COLUMNS = `id, campaign_id, status, failure_class, failure_reason, stage_attempt,
  lease_owner, heartbeat_at, started_at, completed_at`;

function toExperiment(row: ExperimentRow): ExperimentRecord {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    status: row.status,
    failureClass: row.failure_class,
    failureReason: row.failure_reason,
    stageAttempt: row.stage_attempt,
    leaseOwner: row.lease_owner,
    heartbeatAt: row.heartbeat_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function toTransition(row: TransitionRow): TransitionRecord {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    fromState: row.from_state,
    toState: row.to_state,
    failureClass: row.failure_class,
    reason: row.reason,
    attempt: row.attempt,
    at: row.at,
  };
}

/**
 * `UPDATE … RETURNING` through TypeORM's `query` comes back as `[rows, affectedCount]` on Postgres,
 * and a `SELECT` as the rows alone.
 */
async function updateReturning<T>(
  manager: EntityManager | DataSource,
  sql: string,
  parameters: unknown[],
): Promise<T[]> {
  const result: unknown = await manager.query(sql, parameters);
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0])) {
    return result[0] as T[];
  }
  return result as T[];
}

/**
 * The experiment lifecycle on PostgreSQL. Legality comes from `transition()` in research-core; this
 * class only makes each move atomic: the row is locked, the status updated and the transition row
 * appended in one database transaction.
 */
export class TypeOrmExperimentRepository implements ExperimentRepository {
  constructor(private readonly dataSource: DataSource) {}

  async load(id: string): Promise<ExperimentRecord | null> {
    const rows: ExperimentRow[] = await this.dataSource.query(
      `SELECT ${EXPERIMENT_COLUMNS} FROM experiment WHERE id = $1`,
      [id],
    );
    return rows[0] ? toExperiment(rows[0]) : null;
  }

  appendTransition(
    id: string,
    event: ExperimentEvent,
    options: AppendTransitionOptions = {},
  ): Promise<{ experiment: ExperimentRecord; transition: Transition; row: TransitionRecord }> {
    return this.dataSource.transaction(async (manager) => {
      const locked: ExperimentRow[] = await manager.query(
        `SELECT ${EXPERIMENT_COLUMNS} FROM experiment WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const current = locked[0];
      if (!current) throw new ExperimentNotFound(id);
      if (options.expectedState !== undefined && current.status !== options.expectedState) {
        throw new StaleExperimentState(id, options.expectedState, current.status);
      }
      if (
        options.expectedLeaseOwner !== undefined &&
        current.lease_owner !== options.expectedLeaseOwner
      ) {
        throw new LeaseLost(id, options.expectedLeaseOwner, current.lease_owner);
      }
      const move = transition(
        current.status,
        event,
        options.retryPolicy ? { retryPolicy: options.retryPolicy } : {},
      );
      const terminal = isTerminal(move.to);

      const [updated] = await updateReturning<ExperimentRow>(
        manager,
        `UPDATE experiment
            SET status = $2,
                failure_class = $3,
                failure_reason = $4,
                stage_attempt = 0,
                lease_owner = NULL,
                heartbeat_at = CASE WHEN $5 THEN NULL ELSE now() END,
                started_at = CASE WHEN $6 THEN COALESCE(started_at, now()) ELSE started_at END,
                completed_at = CASE WHEN $5 THEN now() ELSE completed_at END
          WHERE id = $1
          RETURNING ${EXPERIMENT_COLUMNS}`,
        [id, move.to, move.failureClass, move.reason, terminal, event.type === 'start'],
      );
      const [row] = await updateReturning<TransitionRow>(
        manager,
        `INSERT INTO experiment_transition
           (id, experiment_id, from_state, to_state, failure_class, reason, attempt, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp())
         RETURNING id, experiment_id, from_state, to_state, failure_class, reason, attempt, at`,
        [newId(), id, move.from, move.to, move.failureClass, move.reason, options.attempt ?? null],
      );
      if (!updated || !row) throw new Error(`experiment ${id}: transition was not written`);
      return { experiment: toExperiment(updated), transition: move, row: toTransition(row) };
    });
  }

  async claim(id: string, request: ClaimRequest): Promise<ExperimentRecord | null> {
    const rows = await updateReturning<ExperimentRow>(
      this.dataSource,
      `UPDATE experiment
          SET lease_owner = $2, heartbeat_at = now(), stage_attempt = $4
        WHERE id = $1
          AND status = $3
          AND stage_attempt <= $4
          AND (lease_owner IS NULL OR lease_owner = $2 OR heartbeat_at IS NULL OR heartbeat_at < $5)
        RETURNING ${EXPERIMENT_COLUMNS}`,
      [id, request.owner, request.stage, request.attempt, request.staleBefore],
    );
    return rows[0] ? toExperiment(rows[0]) : null;
  }

  async heartbeat(id: string, owner: string): Promise<boolean> {
    const rows = await updateReturning<{ id: string }>(
      this.dataSource,
      `UPDATE experiment SET heartbeat_at = now()
        WHERE id = $1 AND lease_owner = $2
        RETURNING id`,
      [id, owner],
    );
    return rows.length > 0;
  }

  async releaseForRetry(id: string, owner: string, attempt: number): Promise<boolean> {
    const rows = await updateReturning<{ id: string }>(
      this.dataSource,
      `UPDATE experiment SET lease_owner = NULL, heartbeat_at = now()
        WHERE id = $1 AND lease_owner = $2 AND stage_attempt = $3
        RETURNING id`,
      [id, owner, attempt],
    );
    return rows.length > 0;
  }

  async findStale(
    states: readonly ExperimentState[],
    staleBefore: Date,
    limit: number,
  ): Promise<ExperimentRecord[]> {
    const rows: ExperimentRow[] = await this.dataSource.query(
      `SELECT ${EXPERIMENT_COLUMNS} FROM experiment
        WHERE status = ANY($1::text[]) AND (heartbeat_at IS NULL OR heartbeat_at < $2)
        ORDER BY heartbeat_at NULLS FIRST, id
        LIMIT $3`,
      [states, staleBefore, limit],
    );
    return rows.map(toExperiment);
  }

  async reclaimStale(
    id: string,
    expected: { readonly status: ExperimentState; readonly stageAttempt: number },
    staleBefore: Date,
  ): Promise<ExperimentRecord | null> {
    const rows = await updateReturning<ExperimentRow>(
      this.dataSource,
      `UPDATE experiment SET heartbeat_at = now(), lease_owner = NULL
        WHERE id = $1 AND status = $2 AND stage_attempt = $3
          AND (heartbeat_at IS NULL OR heartbeat_at < $4)
        RETURNING ${EXPERIMENT_COLUMNS}`,
      [id, expected.status, expected.stageAttempt, staleBefore],
    );
    return rows[0] ? toExperiment(rows[0]) : null;
  }

  async transitions(id: string): Promise<TransitionRecord[]> {
    const rows: TransitionRow[] = await this.dataSource.query(
      `SELECT id, experiment_id, from_state, to_state, failure_class, reason, attempt, at
         FROM experiment_transition WHERE experiment_id = $1
        ORDER BY at, id`,
      [id],
    );
    return rows.map(toTransition);
  }
}
