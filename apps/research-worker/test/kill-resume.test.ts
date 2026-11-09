import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@vcpu/research-api/repositories';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureJournalEntry } from '../src/processors/fixture.js';
import { createExperimentsQueue } from '../src/queue.js';
import { enqueueExperiment } from '../src/worker.js';
import { stagesFor } from '@vcpu/research-core';
import {
  SIX_STAGES,
  createTestDatabase,
  dropQueuePrefix,
  integration,
  newQueuePrefix,
  redisUrl,
  seedCampaign,
  seedExperiment,
  testLogger,
  waitFor,
  type TestDatabase,
} from './support.js';

const childEntry = join(import.meta.dirname, 'child-worker.ts');

describe.skipIf(!integration)('kill and resume (worker as a child process)', () => {
  let database: TestDatabase;
  let directory: string;
  const prefix = newQueuePrefix();
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
    directory = await mkdtemp(join(tmpdir(), 'research-worker-kill-'));
  });

  afterAll(async () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    await dropQueuePrefix(prefix);
    await database.drop();
    await rm(directory, { recursive: true, force: true });
  });

  function spawnWorker(name: string, extraEnv: Record<string, string>): ChildProcess {
    const log = createWriteStream(join(directory, `${name}.log`));
    const child = spawn(process.execPath, ['--import', 'tsx', childEntry], {
      cwd: join(import.meta.dirname, '..'),
      env: {
        ...process.env,
        // tsx applies a tsconfig only to the files it includes: the research-api entities need its
        // legacy-decorator settings, as `pnpm research:worker` gives them.
        TSX_TSCONFIG_PATH: join(import.meta.dirname, '../../research-api/tsconfig.json'),
        DATABASE_URL: database.url,
        REDIS_URL: redisUrl ?? '',
        RESEARCH_QUEUE_PREFIX: prefix,
        WORKER_ID: name,
        WORKER_CONCURRENCY: '2',
        WORKER_SKIP_STAGES: 'GENERATING,PHYSICAL_ANALYSIS',
        HEARTBEAT_MS: '250',
        STALE_AFTER_MS: '2000',
        RECOVERY_INTERVAL_MS: '1000',
        LOG_LEVEL: 'info',
        FIXTURE_JOURNAL: join(directory, 'journal.jsonl'),
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    children.push(child);
    return child;
  }

  const journal = (): FixtureJournalEntry[] => {
    const path = join(directory, 'journal.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as FixtureJournalEntry);
  };

  it(
    'resumes after SIGKILL during stage 3 of 6 without repeating a completed stage',
    { timeout: 90_000 },
    async () => {
      const plan = stagesFor(SIX_STAGES);
      expect(plan).toHaveLength(6);
      expect(plan[2]).toBe('COMPILING');

      const campaignId = await seedCampaign(database.dataSource);
      const id = await seedExperiment(database.dataSource, campaignId);
      const { experiments } = createRepositories(database.dataSource);

      const first = spawnWorker('worker-a', {
        FIXTURE_SLOW_STAGE: 'COMPILING',
        FIXTURE_SLOW_MS: '60000',
      });
      const queue = createExperimentsQueue(redisUrl ?? '', prefix);
      try {
        await enqueueExperiment({ experiments, queue, logger: testLogger, plan }, id);
      } finally {
        await queue.close();
      }

      // Stage 3 is running in worker A: its command has started and A holds the lease.
      const running = await waitFor(
        'worker A to be running COMPILING',
        () =>
          Promise.resolve(
            journal().find((entry) => entry.stage === 'COMPILING' && entry.event === 'command'),
          ),
        30_000,
      );
      expect((await experiments.load(id))?.leaseOwner).toBe('worker-a');

      first.kill('SIGKILL');
      await new Promise((resolve) => first.once('exit', resolve));
      if (running.commandPid !== undefined) {
        try {
          process.kill(running.commandPid, 'SIGKILL'); // the orphaned `sleep`
        } catch {
          // already gone
        }
      }
      const killedAt = Date.now();

      spawnWorker('worker-b', {});
      const done = await waitFor(
        'the experiment to complete in worker B',
        async () => {
          const experiment = await experiments.load(id);
          return experiment?.status === 'COMPLETED' ? experiment : undefined;
        },
        60_000,
        200,
      );
      const resumedInMs = Date.now() - killedAt;

      const rows = await experiments.transitions(id);
      expect(rows.map((row) => row.toState)).toEqual(['CREATED', 'QUEUED', ...plan, 'COMPLETED']);
      // One row per stage boundary, chained, with no duplicate.
      rows.forEach((row, index) => {
        expect(row.fromState).toBe(index === 0 ? null : rows[index - 1]?.toState);
      });
      expect(new Set(rows.map((row) => row.toState)).size).toBe(rows.length);

      const entries = journal();
      const doneBy = (stage: string) =>
        entries.filter((entry) => entry.stage === stage && entry.event === 'done');
      // The stages A completed ran once, in A; the one A was killed in ran again, in B.
      for (const stage of plan) expect(doneBy(stage), stage).toHaveLength(1);
      const aPid = entries.find((entry) => entry.stage === 'PREPARING')?.pid;
      expect(doneBy('PREPARING')[0]?.pid).toBe(aPid);
      expect(doneBy('STATIC_VALIDATION')[0]?.pid).toBe(aPid);
      expect(doneBy('COMPILING')[0]?.pid).not.toBe(aPid);
      expect(
        entries.filter((entry) => entry.stage === 'COMPILING' && entry.event === 'start'),
      ).toHaveLength(2);

      process.stdout.write(
        [
          `kill-and-resume: experiment ${id} killed in COMPILING (stage 3 of 6),`,
          `resumed by worker-b and COMPLETED ${String(resumedInMs)} ms after SIGKILL`,
          ...rows.map(
            (row) =>
              `  ${row.at.toISOString()}  ${String(row.fromState).padEnd(17)} -> ${row.toState.padEnd(17)} attempt=${String(row.attempt)}`,
          ),
          ...entries.map(
            (entry) =>
              `  journal pid=${String(entry.pid)} ${entry.stage.padEnd(17)} attempt=${String(entry.attempt)} ${entry.event}`,
          ),
          '',
        ].join('\n'),
      );
      expect(done.completedAt).not.toBeNull();
    },
  );
});
