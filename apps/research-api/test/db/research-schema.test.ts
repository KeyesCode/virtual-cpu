import 'reflect-metadata';
import {
  CAMPAIGN_EVENT_TYPES,
  EXPERIMENT_STATES,
  FAILURE_CLASSES,
  type CampaignConfig,
  type Metric,
} from '@vcpu/research-core';
import { DataSource, type EntityManager } from 'typeorm';
import { v7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dataSourceOptions } from '../../src/data-source.js';
import {
  AgentRun,
  Artifact,
  Baseline,
  CampaignEvent,
  DesignCandidate,
  Experiment,
  ExperimentTransition,
  PowerResult,
  ResearchCampaign,
  ResearchFinding,
  ResearchProject,
  SynthesisResult,
  TimingResult,
  VerificationResult,
} from '../../src/entities/index.js';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  process.stderr.write('Skipping the research database tests: DATABASE_URL is not set.\n');
}

const hash = (seed: string) => seed.repeat(64).slice(0, 64);

const ns = (value: number): Metric => ({
  value,
  unit: 'ns',
  provenance: 'measured',
  method: 'report_checks',
  tool: 'opensta',
  toolVersion: '2.6.0',
});
const unavailable: Metric = { provenance: 'unavailable', reason: 'no PDK' };

const campaignConfig: CampaignConfig = {
  name: 'Campaign 001',
  target: 'matmul-processing-element',
  baseline: 'verified-baseline-v1',
  objective: 'minimize-area-delay-product',
  maxExperiments: 100,
  maxConcurrentExperiments: 2,
  maxRuntimeHours: 24,
  allowedChanges: ['hardware/accelerators/matmul/rtl/processing_element.sv'],
  requiredVerification: ['unit', 'differential', 'randomized'],
  stopConditions: { stopOnBudgetExceeded: true },
};

// Every run gets its own schema, so these tests never touch the tables of the database they share
// and leave nothing behind, even though they revert the migration.
describe.skipIf(!databaseUrl)('research schema', () => {
  const schema = `research_test_${v7().replaceAll('-', '')}`;
  let dataSource: DataSource;

  function newProject(manager: EntityManager) {
    return manager.save(
      manager.create(ResearchProject, {
        name: `project-${v7()}`,
        description: 'The Project 3 MAC processing element',
        architectureType: 'mac-processing-element',
        sourceRepository: 'github.com/KeyesCode/virtual-cpu',
        baselineCommit: '1'.repeat(40),
        interfaceSpecVersion: 'matmul-os-r1',
      }),
    );
  }

  function newBaseline(manager: EntityManager, projectId: string, metrics: Baseline['metrics']) {
    return manager.save(
      manager.create(Baseline, {
        projectId,
        name: 'verified-baseline-v1',
        sourceCommit: '1'.repeat(40),
        sourceContentHash: hash('a'),
        parameters: { DATA_W: 8, ACC_W: 32 },
        verificationSuiteVersion: 'matmul-os-r1',
        synthesisConfig: { flow: 'abc -liberty' },
        timingConstraints: { clockPeriod: { value: 5, unit: 'ns' } },
        targetTechnology: 'sky130_fd_sc_hd__tt_025C_1v80',
        toolVersions: { yosys: '0.70+145' },
        metrics,
      }),
    );
  }

  async function newCampaign(manager: EntityManager) {
    const project = await newProject(manager);
    const baseline = await newBaseline(manager, project.id, {});
    return manager.save(
      manager.create(ResearchCampaign, {
        projectId: project.id,
        baselineId: baseline.id,
        name: 'Campaign 001',
        objective: 'minimize-area-delay-product',
        optimizationMetric: 'area-delay-product',
        config: campaignConfig,
        maxExperiments: 100,
        maxConcurrentExperiments: 2,
        maxRuntime: '24',
        maxRuntimeUnit: 'h',
      }),
    );
  }

  function newCandidate(manager: EntityManager, candidateHash: string) {
    return manager.save(
      manager.create(DesignCandidate, {
        candidateHash,
        changedFiles: campaignConfig.allowedChanges,
      }),
    );
  }

  function newExperiment(
    manager: EntityManager,
    campaignId: string,
    candidateId: string | null,
    evaluationConfigHash = hash('e'),
  ) {
    return manager.save(
      manager.create(Experiment, { campaignId, candidateId, evaluationConfigHash, seed: '1' }),
    );
  }

  // Each test runs in a transaction that is rolled back, so one refused write cannot affect another.
  async function rolledBack(body: (manager: EntityManager) => Promise<void>) {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.startTransaction();
    try {
      await body(queryRunner.manager);
    } finally {
      await queryRunner.rollbackTransaction();
      await queryRunner.release();
    }
  }

  // Runs a write that must be refused, inside a savepoint so that the test can carry on.
  async function expectRefused(
    manager: EntityManager,
    write: (manager: EntityManager) => Promise<unknown>,
    message: RegExp,
  ) {
    await manager.query('SAVEPOINT refused');
    await expect(write(manager)).rejects.toThrow(message);
    await manager.query('ROLLBACK TO SAVEPOINT refused');
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl ?? '');
    url.searchParams.set('options', `-c search_path=${schema}`);
    dataSource = new DataSource(dataSourceOptions(url.href));
    await dataSource.initialize();
    await dataSource.query(`CREATE SCHEMA ${schema}`);
    await dataSource.runMigrations();
  });

  afterAll(async () => {
    await dataSource.query(`DROP SCHEMA ${schema} CASCADE`);
    await dataSource.destroy();
  });

  it('keeps a whole campaign, experiment and results graph', async () => {
    await rolledBack(async (manager) => {
      const campaign = await newCampaign(manager);
      const candidate = await newCandidate(manager, hash('c'));
      const experiment = await newExperiment(manager, campaign.id, candidate.id);
      const report = await manager.save(
        manager.create(Artifact, {
          experimentId: experiment.id,
          kind: 'timing-report',
          name: 'sta.rpt',
          contentHash: hash('f'),
          sizeBytes: '1024',
          mediaType: 'text/plain',
        }),
      );
      await manager.save(
        manager.create(ExperimentTransition, {
          experimentId: experiment.id,
          fromState: null,
          toState: 'CREATED',
        }),
      );
      await manager.save(
        manager.create(VerificationResult, {
          experimentId: experiment.id,
          testSuite: 'unit',
          passed: true,
          failedTestCount: 0,
          randomSeed: '42',
          toolVersion: '5.053',
        }),
      );
      await manager.save(
        manager.create(SynthesisResult, {
          experimentId: experiment.id,
          tier: 'technology-mapped',
          topModule: 'processing_element',
          toolVersion: '0.70+145',
          targetLibrary: 'sky130_fd_sc_hd__tt_025C_1v80',
          cellCount: 1008,
          flipFlopCount: 50,
          estimatedArea: { value: 8123.4, unit: 'um^2', provenance: 'measured' },
        }),
      );
      await manager.save(
        manager.create(TimingResult, {
          experimentId: experiment.id,
          tier: 'technology-mapped',
          toolVersion: '2.6.0',
          targetClockPeriod: ns(5),
          criticalPathDelay: ns(4.2),
          worstNegativeSlack: ns(0),
          totalNegativeSlack: ns(0),
          timingConstraints: { clockPeriod: { value: 5, unit: 'ns' } },
          reportArtifactId: report.id,
        }),
      );
      await manager.save(
        manager.create(PowerResult, {
          experimentId: experiment.id,
          estimationMethod: 'none',
          switchingActivitySource: 'none',
          dynamicPower: unavailable,
          leakagePower: unavailable,
          totalPower: unavailable,
        }),
      );
      const agentRun = await manager.save(
        manager.create(AgentRun, {
          experimentId: experiment.id,
          provider: 'codex',
          model: 'gpt',
          promptVersion: 'rtl-engineer@1',
          inputTokens: '1200',
          outputTokens: '300',
          estimatedCost: { provenance: 'unavailable', reason: 'provider reports no price' },
          duration: { value: 61.5, unit: 's', provenance: 'measured' },
          exitCode: 0,
        }),
      );
      await manager.save(
        manager.create(Artifact, {
          experimentId: experiment.id,
          agentRunId: agentRun.id,
          kind: 'agent-output',
          name: 'output.json',
          contentHash: hash('d'),
          sizeBytes: '10',
          mediaType: 'application/json',
        }),
      );
      await manager.save(
        manager.create(ResearchFinding, {
          campaignId: campaign.id,
          experimentId: experiment.id,
          findingType: 'verified',
          summary: 'Candidate meets timing',
          confidenceLevel: 'high',
        }),
      );
      await manager.save(
        manager.create(CampaignEvent, {
          campaignId: campaign.id,
          experimentId: experiment.id,
          type: 'duplicate-candidate',
          actor: 'campaign-engine',
        }),
      );

      const timing = await manager.findOneOrFail(TimingResult, {
        where: { experimentId: experiment.id },
        relations: { experiment: { campaign: { baseline: { project: true } }, candidate: true } },
      });
      expect(timing.experiment.campaign.baseline.name).toBe('verified-baseline-v1');
      expect(timing.experiment.candidate?.candidateHash).toBe(hash('c'));
      expect(timing.criticalPathDelay).toEqual(ns(4.2));

      await manager.delete(Experiment, { id: experiment.id });
      await expect(manager.countBy(TimingResult, {})).resolves.toBe(0);
      await expect(manager.countBy(ExperimentTransition, {})).resolves.toBe(0);
      const orphan = await manager.findOneByOrFail(Artifact, { id: report.id });
      expect(orphan.experimentId).toBeNull();
    });
  });

  it('refuses a second candidate with the same hash', async () => {
    await rolledBack(async (manager) => {
      await newCandidate(manager, hash('c'));
      await expectRefused(manager, (m) => newCandidate(m, hash('c')), /uq_candidate_hash/);
    });
  });

  it('allows a candidate twice only under different evaluation configs', async () => {
    await rolledBack(async (manager) => {
      const campaign = await newCampaign(manager);
      const candidate = await newCandidate(manager, hash('c'));
      await newExperiment(manager, campaign.id, candidate.id, hash('1'));
      await newExperiment(manager, campaign.id, candidate.id, hash('2'));
      await expectRefused(
        manager,
        (m) => newExperiment(m, campaign.id, candidate.id, hash('1')),
        /uq_experiment_candidate_evaluation/,
      );
      await newExperiment(manager, campaign.id, null, hash('1'));
      await newExperiment(manager, campaign.id, null, hash('1'));
    });
  });

  it('refuses to delete a campaign that has experiments, and cascades its findings', async () => {
    await rolledBack(async (manager) => {
      const campaign = await newCampaign(manager);
      const experiment = await newExperiment(manager, campaign.id, null);
      await expectRefused(
        manager,
        (m) => m.delete(ResearchCampaign, { id: campaign.id }),
        /fk_experiment_campaign/,
      );

      await manager.save(
        manager.create(ResearchFinding, {
          campaignId: campaign.id,
          findingType: 'unresolved',
          summary: 'No candidate beat the baseline',
          confidenceLevel: 'low',
        }),
      );
      await manager.delete(Experiment, { id: experiment.id });
      await manager.delete(ResearchCampaign, { id: campaign.id });
      await expect(manager.countBy(ResearchFinding, {})).resolves.toBe(0);
    });
  });

  it('refuses an update to a baseline column', async () => {
    await rolledBack(async (manager) => {
      const project = await newProject(manager);
      const baseline = await newBaseline(manager, project.id, {});
      await expectRefused(
        manager,
        (m) => m.update(Baseline, { id: baseline.id }, { sourceCommit: '2'.repeat(40) }),
        /is immutable/,
      );
      await expectRefused(
        manager,
        (m) => m.update(Baseline, { id: baseline.id }, { targetTechnology: 'other' }),
        /is immutable/,
      );
    });
  });

  it('fills baseline metrics until they are frozen, and refuses every update after that', async () => {
    await rolledBack(async (manager) => {
      const project = await newProject(manager);
      const baseline = await newBaseline(manager, project.id, {});

      await manager.update(Baseline, { id: baseline.id }, { metrics: { delay: ns(4) } });
      await manager.update(
        Baseline,
        { id: baseline.id },
        { metrics: { delay: ns(4.5) }, metricsFrozenAt: new Date() },
      );

      const frozen = await manager.findOneByOrFail(Baseline, { id: baseline.id });
      expect(frozen.metrics).toEqual({ delay: ns(4.5) });
      await expectRefused(
        manager,
        (m) => m.update(Baseline, { id: baseline.id }, { metrics: { delay: ns(1) } }),
        /is frozen/,
      );
      await expectRefused(
        manager,
        (m) => m.update(Baseline, { id: baseline.id }, { metricsFrozenAt: null }),
        /is frozen/,
      );
    });
  });

  it('refuses to freeze a baseline with no metrics', async () => {
    await rolledBack(async (manager) => {
      const project = await newProject(manager);
      const baseline = await newBaseline(manager, project.id, {});
      await expectRefused(
        manager,
        (m) => m.update(Baseline, { id: baseline.id }, { metricsFrozenAt: new Date() }),
        /ck_baseline_frozen_has_metrics/,
      );
    });
  });

  it('reads an unavailable metric back as unavailable, not as 0', async () => {
    await rolledBack(async (manager) => {
      const campaign = await newCampaign(manager);
      const experiment = await newExperiment(manager, campaign.id, null);
      const { id } = await manager.save(
        manager.create(SynthesisResult, {
          experimentId: experiment.id,
          tier: 'technology-independent',
          topModule: 'processing_element',
          toolVersion: '0.70+145',
          targetLibrary: 'generic',
          cellCount: 0,
          flipFlopCount: 0,
          estimatedArea: unavailable,
        }),
      );

      const { estimatedArea } = await manager.findOneByOrFail(SynthesisResult, { id });
      expect(estimatedArea).toEqual({ provenance: 'unavailable', reason: 'no PDK' });
      expect(estimatedArea).not.toHaveProperty('value');
      expect(estimatedArea).not.toBe(0);

      const stored: { area: unknown }[] = await manager.query(
        `SELECT estimated_area->'value' AS area FROM synthesis_result WHERE id = $1`,
        [id],
      );
      expect(stored[0]?.area).toBeNull();
    });
  });

  it.each([
    ['a value with no unit', { value: 1, provenance: 'measured' }],
    ['a value as a string', { value: '1', unit: 'ns', provenance: 'measured' }],
    ['an unavailable metric carrying 0', { value: 0, provenance: 'unavailable', reason: 'x' }],
    ['an unavailable metric with no reason', { provenance: 'unavailable' }],
    ['an unknown provenance', { value: 1, unit: 'ns', provenance: 'guessed' }],
    ['a bare number', 0],
  ])('refuses %s in a metric column', async (_name, metric) => {
    await rolledBack(async (manager) => {
      const campaign = await newCampaign(manager);
      const experiment = await newExperiment(manager, campaign.id, null);
      await expectRefused(
        manager,
        (m) =>
          m.query(
            `INSERT INTO power_result (id, experiment_id, estimation_method,
               switching_activity_source, dynamic_power, leakage_power, total_power)
             VALUES ($1, $2, 'none', 'none', $3, $4, $4)`,
            [v7(), experiment.id, JSON.stringify(metric), JSON.stringify(unavailable)],
          ),
        /ck_power_dynamic_power/,
      );
    });
  });

  it('refuses a negative cell count and a rejected experiment with no failure class', async () => {
    await rolledBack(async (manager) => {
      const campaign = await newCampaign(manager);
      const experiment = await newExperiment(manager, campaign.id, null);
      await expectRefused(
        manager,
        (m) =>
          m.save(
            m.create(SynthesisResult, {
              experimentId: experiment.id,
              tier: 'technology-independent',
              topModule: 'processing_element',
              toolVersion: '0.70+145',
              targetLibrary: 'generic',
              cellCount: -1,
              flipFlopCount: 0,
              estimatedArea: unavailable,
            }),
          ),
        /ck_synthesis_cell_count/,
      );
      await expectRefused(
        manager,
        (m) => m.update(Experiment, { id: experiment.id }, { status: 'REJECTED' }),
        /ck_experiment_failed_has_class/,
      );
    });
  });

  it('accepts every value of the shared enums and refuses others', async () => {
    await rolledBack(async (manager) => {
      const campaign = await newCampaign(manager);
      const experiment = await newExperiment(manager, campaign.id, null);
      for (const failureClass of FAILURE_CLASSES) {
        for (const status of EXPERIMENT_STATES) {
          await manager.update(Experiment, { id: experiment.id }, { status, failureClass });
        }
      }
      for (const type of CAMPAIGN_EVENT_TYPES) {
        await manager.save(
          manager.create(CampaignEvent, { campaignId: campaign.id, type, actor: 'test' }),
        );
      }
      await expectRefused(
        manager,
        (m) => m.query(`UPDATE experiment SET status = 'RUNNING' WHERE id = $1`, [experiment.id]),
        /ck_experiment_status/,
      );
    });
  });

  it('declares the required indexes and keeps synchronize off', async () => {
    expect(dataSource.options.synchronize).toBe(false);
    const rows: { indexname: string }[] = await dataSource.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`,
    );
    expect(rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'idx_experiment_campaign_status',
        'idx_experiment_parent',
        'idx_transition_experiment_at',
        'idx_finding_campaign',
      ]),
    );
  });

  // This reverts every migration, so it has to stay the last test.
  it('reverts to no research tables, and migrates again from there', async () => {
    const tables = async (): Promise<string[]> => {
      const rows: { tablename: string }[] = await dataSource.query(
        `SELECT tablename FROM pg_tables
          WHERE schemaname = current_schema() AND tablename <> 'migrations'`,
      );
      return rows.map((row) => row.tablename);
    };

    await expect(tables()).resolves.toHaveLength(14);
    for (let left = dataSource.migrations.length; left > 0; left -= 1) {
      await dataSource.undoLastMigration();
    }
    await expect(tables()).resolves.toEqual([]);
    await dataSource.runMigrations();
    await expect(tables()).resolves.toHaveLength(14);
  });
});
