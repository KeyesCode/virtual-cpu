import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTerminal, type ExperimentState } from '@vcpu/research-core';
import { createRepositories } from '@vcpu/research-api/repositories';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerConfig } from '../src/config.js';
import { createFixtureHandlers, type FixtureJournalEntry } from '../src/processors/fixture.js';
import { StageFailure } from '../src/processors/handlers.js';
import { startWorker, type WorkerHandle } from '../src/worker.js';
import {
  FAST_RETRY_POLICY,
  createTestDatabase,
  delay,
  dropQueuePrefix,
  integration,
  seedCampaign,
  seedExperiment,
  testConfig,
  testLogger,
  waitFor,
  type TestDatabase,
} from './support.js';

const COMPLETED_PATH: ExperimentState[] = [
  'CREATED',
  'QUEUED',
  'PREPARING',
  'STATIC_VALIDATION',
  'COMPILING',
  'VERIFYING',
  'SYNTHESIZING',
  'SCORING',
  'COMPLETED',
];

describe.skipIf(!integration)('experiment orchestration (Redis + PostgreSQL)', () => {
  let database: TestDatabase;
  let campaignId: string;
  const handles: WorkerHandle[] = [];
  const prefixes: string[] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
    campaignId = await seedCampaign(database.dataSource);
  });

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()));
    await Promise.all(prefixes.splice(0).map((prefix) => dropQueuePrefix(prefix)));
  });

  afterAll(async () => {
    await database.drop();
  });

  async function start(
    fixture: ReturnType<typeof createFixtureHandlers>,
    overrides: Partial<WorkerConfig> = {},
  ): Promise<WorkerHandle> {
    const config = testConfig(database.url, overrides);
    prefixes.push(config.queuePrefix);
    const handle = await startWorker(config, {
      handlers: fixture.handlers,
      logger: testLogger,
      dataSource: database.dataSource,
    });
    handles.push(handle);
    return handle;
  }

  const repositories = () => createRepositories(database.dataSource);

  async function finished(handle: WorkerHandle, id: string, timeoutMs = 20_000) {
    return waitFor(
      `experiment ${id} to finish`,
      async () => {
        const experiment = await handle.experiments.load(id);
        return experiment && isTerminal(experiment.status) ? experiment : undefined;
      },
      timeoutMs,
    );
  }

  /** Every status change has its row, and the rows chain: each one starts where the last ended. */
  async function expectConsistentHistory(id: string): Promise<ExperimentState[]> {
    const { experiments } = repositories();
    const rows = await experiments.transitions(id);
    const experiment = await experiments.load(id);
    rows.forEach((row, index) => {
      expect(row.fromState).toBe(index === 0 ? null : rows[index - 1]?.toState);
    });
    expect(rows.at(-1)?.toState).toBe(experiment?.status);
    return rows.map((row) => row.toState);
  }

  it('writes one transition row per status change, in the same transaction', async () => {
    const fixture = createFixtureHandlers({ delayMs: 20 });
    const handle = await start(fixture);
    const ids = await Promise.all(
      [1, 2, 3].map(() => seedExperiment(database.dataSource, campaignId)),
    );
    for (const id of ids) await handle.enqueueExperiment(id);
    for (const id of ids) {
      expect((await finished(handle, id)).status).toBe('COMPLETED');
      expect(await expectConsistentHistory(id)).toEqual(COMPLETED_PATH);
    }

    // A transition row that cannot be written (attempt 0 breaks ck_transition_attempt) takes the
    // status change down with it.
    const id = await seedExperiment(database.dataSource, campaignId);
    await expect(
      handle.experiments.appendTransition(id, { type: 'enqueue' }, { attempt: 0 }),
    ).rejects.toThrow(/ck_transition_attempt/);
    expect((await handle.experiments.load(id))?.status).toBe('CREATED');
    expect(await expectConsistentHistory(id)).toEqual(['CREATED']);
  });

  it('rejects an incorrect design once, without a retry', async () => {
    const fixture = createFixtureHandlers({
      script: ({ stage }) =>
        stage === 'VERIFYING'
          ? { ok: false, failureClass: 'incorrect-design', message: 'mismatch at vector 7' }
          : undefined,
    });
    const handle = await start(fixture);
    const id = await seedExperiment(database.dataSource, campaignId);
    await handle.enqueueExperiment(id);

    const experiment = await finished(handle, id);
    expect(experiment).toMatchObject({ status: 'REJECTED', failureClass: 'incorrect-design' });
    await delay(300); // a retry would have been scheduled by now
    const attemptsMade = fixture.stats.calls.filter((call) => call.stage === 'VERIFYING').length;
    expect(attemptsMade).toBe(1);
    const rows = await handle.experiments.transitions(id);
    expect(rows.at(-1)).toMatchObject({
      fromState: 'VERIFYING',
      toState: 'REJECTED',
      failureClass: 'incorrect-design',
      reason: 'mismatch at vector 7',
      attempt: 1,
    });
    expect(await expectConsistentHistory(id)).toEqual([
      ...COMPLETED_PATH.slice(0, COMPLETED_PATH.indexOf('VERIFYING') + 1),
      'REJECTED',
    ]);
  });

  it('retries a tool failure up to its cap, then fails', async () => {
    const fixture = createFixtureHandlers({
      script: ({ stage }) => {
        if (stage === 'COMPILING') throw new StageFailure('tool-failure', 'verilator crashed');
        return undefined;
      },
    });
    const handle = await start(fixture);
    const id = await seedExperiment(database.dataSource, campaignId);
    await handle.enqueueExperiment(id);

    const experiment = await finished(handle, id);
    expect(experiment).toMatchObject({ status: 'FAILED', failureClass: 'tool-failure' });
    const cap = FAST_RETRY_POLICY['tool-failure'].maxAttempts;
    const attempts = fixture.stats.calls
      .filter((call) => call.stage === 'COMPILING')
      .map((call) => call.attempt);
    expect(attempts).toEqual(Array.from({ length: cap }, (_, index) => index + 1));
    expect((await handle.experiments.transitions(id)).at(-1)).toMatchObject({
      fromState: 'COMPILING',
      toState: 'FAILED',
      failureClass: 'tool-failure',
      attempt: cap,
    });
    expect(await expectConsistentHistory(id)).toEqual([
      'CREATED',
      'QUEUED',
      'PREPARING',
      'STATIC_VALIDATION',
      'COMPILING',
      'FAILED',
    ]);
  });

  it('times a stage out and retries it as a timeout', async () => {
    const fixture = createFixtureHandlers({ slowStage: { stage: 'SYNTHESIZING', ms: 5_000 } });
    const handle = await start(fixture, { stageTimeoutsMs: { SYNTHESIZING: 300 } });
    const id = await seedExperiment(database.dataSource, campaignId);
    await handle.enqueueExperiment(id);
    const experiment = await finished(handle, id);
    expect(experiment).toMatchObject({ status: 'FAILED', failureClass: 'timeout' });
    expect(
      fixture.stats.calls.filter((call) => call.stage === 'SYNTHESIZING').map((c) => c.attempt),
    ).toEqual([1, 2]);
  });

  it('never runs more stages at once than the configured concurrency', async () => {
    const fixture = createFixtureHandlers({ delayMs: 100 });
    const handle = await start(fixture, { concurrency: 2 });
    const ids = await Promise.all(
      Array.from({ length: 6 }, () => seedExperiment(database.dataSource, campaignId)),
    );
    for (const id of ids) await handle.enqueueExperiment(id);
    for (const id of ids) expect((await finished(handle, id, 30_000)).status).toBe('COMPLETED');
    expect(fixture.stats.maxInFlight).toBe(2);
    expect(fixture.stats.inFlight).toBe(0);
  });

  it('cancels a running experiment, kills its command and runs no further stage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'research-worker-'));
    try {
      const journal = join(directory, 'journal.jsonl');
      const fixture = createFixtureHandlers({
        journal,
        slowStage: { stage: 'COMPILING', ms: 30_000 },
      });
      const handle = await start(fixture);
      const id = await seedExperiment(database.dataSource, campaignId);
      await handle.enqueueExperiment(id);

      const entries = () =>
        (existsSync(journal) ? readFileSync(journal, 'utf8') : '')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as FixtureJournalEntry);
      const commandPid = await waitFor('the COMPILING command to start', async () =>
        Promise.resolve(entries().find((entry) => entry.event === 'command')?.commandPid),
      );

      await handle.cancelExperiment(id, 'stopped by a person');
      const experiment = await finished(handle, id, 5_000);
      expect(experiment).toMatchObject({
        status: 'CANCELLED',
        failureReason: 'stopped by a person',
      });
      await waitFor('the command to be killed', () => {
        try {
          process.kill(commandPid, 0);
          return Promise.resolve(undefined);
        } catch {
          return Promise.resolve(true);
        }
      });

      await delay(500);
      expect(fixture.stats.calls.map((call) => call.stage)).toEqual([
        'PREPARING',
        'STATIC_VALIDATION',
        'COMPILING',
      ]);
      expect(await expectConsistentHistory(id)).toEqual([
        'CREATED',
        'QUEUED',
        'PREPARING',
        'STATIC_VALIDATION',
        'COMPILING',
        'CANCELLED',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('cancels a queued experiment before it starts, and ignores a cancel after the end', async () => {
    const fixture = createFixtureHandlers();
    const handle = await start(fixture);
    const queued = await seedExperiment(database.dataSource, campaignId);
    await handle.experiments.appendTransition(queued, { type: 'enqueue' });
    expect((await handle.cancelExperiment(queued, 'not needed')).status).toBe('CANCELLED');
    await handle.enqueueExperiment(queued).catch(() => undefined);
    await delay(300);
    expect(fixture.stats.calls).toEqual([]);

    const done = await seedExperiment(database.dataSource, campaignId);
    await handle.enqueueExperiment(done);
    await finished(handle, done);
    expect((await handle.cancelExperiment(done, 'too late')).status).toBe('COMPLETED');
    expect(await expectConsistentHistory(done)).toEqual(COMPLETED_PATH);
  });

  it('recovers a stale heartbeat within one scheduler tick', async () => {
    const { experiments } = repositories();
    const id = await seedExperiment(database.dataSource, campaignId);
    // A worker took COMPILING and died: no job in the queue, the lease and heartbeat left behind.
    await experiments.appendTransition(id, { type: 'enqueue' });
    await experiments.appendTransition(id, { type: 'start' });
    await experiments.appendTransition(id, { type: 'advance', to: 'STATIC_VALIDATION' });
    await experiments.appendTransition(id, { type: 'advance', to: 'COMPILING' });
    await database.dataSource.query(
      `UPDATE experiment SET lease_owner = 'dead-worker', stage_attempt = 1,
          heartbeat_at = now() - interval '1 hour'
        WHERE id = $1`,
      [id],
    );

    const fixture = createFixtureHandlers();
    const recoveryIntervalMs = 1_000;
    const startedAt = Date.now();
    const handle = await start(fixture, { recoveryIntervalMs });
    await waitFor(
      'COMPILING to be re-run',
      () =>
        Promise.resolve(
          fixture.stats.calls.some((call) => call.stage === 'COMPILING') ? true : undefined,
        ),
      recoveryIntervalMs + 1_500,
    );
    expect(Date.now() - startedAt).toBeLessThan(recoveryIntervalMs + 1_500);
    expect((await finished(handle, id)).status).toBe('COMPLETED');
    // The dead attempt counts: the re-run is attempt 2.
    expect(fixture.stats.calls.find((call) => call.stage === 'COMPILING')?.attempt).toBe(2);
    expect(await expectConsistentHistory(id)).toEqual(COMPLETED_PATH);
  });

  it('lets only one of two racing recoverers take a stale experiment', async () => {
    const { experiments } = repositories();
    const id = await seedExperiment(database.dataSource, campaignId);
    await experiments.appendTransition(id, { type: 'enqueue' });
    await database.dataSource.query(
      `UPDATE experiment SET heartbeat_at = now() - interval '1 hour' WHERE id = $1`,
      [id],
    );
    const staleBefore = new Date(Date.now() - 60_000);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        experiments.reclaimStale(id, { status: 'QUEUED', stageAttempt: 0 }, staleBefore),
      ),
    );
    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });

  it('fails a stage whose worker keeps dying once the infrastructure cap is reached', async () => {
    const { experiments } = repositories();
    const id = await seedExperiment(database.dataSource, campaignId);
    await experiments.appendTransition(id, { type: 'enqueue' });
    await experiments.appendTransition(id, { type: 'start' });
    const cap = FAST_RETRY_POLICY['infrastructure-failure'].maxAttempts;
    await database.dataSource.query(
      `UPDATE experiment SET lease_owner = 'dead-worker', stage_attempt = $2,
          heartbeat_at = now() - interval '1 hour'
        WHERE id = $1`,
      [id, cap],
    );
    const handle = await start(createFixtureHandlers());
    // The scheduler's first pass may get there first; either way exactly one pass fails it.
    await handle.recoverStale();
    expect(await finished(handle, id, 5_000)).toMatchObject({
      status: 'FAILED',
      failureClass: 'infrastructure-failure',
    });
  });
});
