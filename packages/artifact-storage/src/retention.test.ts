import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDiskArtifactStore } from './local-disk.js';
import {
  DEFAULT_RETENTION_POLICY,
  RetentionEngine,
  RetentionPolicySchema,
  retentionDaysFor,
} from './retention.js';

const NOW = new Date('2026-11-30T00:00:00.000Z');

function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

describe('RetentionEngine', () => {
  let root: string;
  let clock: Date;
  let store: LocalDiskArtifactStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vcpu-retention-'));
    clock = NOW;
    store = await LocalDiskArtifactStore.open({ root, clock: () => clock });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function putAt(
    daysOld: number,
    content: string,
    kind: Parameters<typeof store.put>[1]['kind'],
  ) {
    clock = daysBefore(daysOld);
    const { sha256 } = await store.put(content, { kind });
    clock = NOW;
    return sha256;
  }

  it('prunes a 20-day-old waveform under the default policy and never a manifest', async () => {
    const waveform = await putAt(20, 'old waveform', 'waveform');
    const manifest = await putAt(400, 'ancient manifest', 'reproducibility-manifest');

    const report = await RetentionEngine.apply(NOW, DEFAULT_RETENTION_POLICY, store);

    expect(report.pruned.map((decision) => decision.sha256)).toEqual([waveform]);
    expect(await store.has(waveform)).toBe(false);
    expect(await store.stat(waveform)).toMatchObject({
      kinds: ['waveform'],
      size: 'old waveform'.length,
      pruned: true,
      prunedAt: NOW.toISOString(),
    });
    expect(await store.has(manifest)).toBe(true);
    expect((await store.stat(manifest))?.pruned).toBe(false);
  });

  it('prunes exactly what the policy says and nothing else', async () => {
    const youngWaveform = await putAt(13, 'young waveform', 'waveform');
    const oldWaveform = await putAt(15, 'old waveform', 'waveform');
    const youngLog = await putAt(29, 'young log', 'tool-log');
    const oldLog = await putAt(31, 'old log', 'tool-log');
    const kept = await Promise.all(
      (
        [
          'candidate-source',
          'patch',
          'test-vectors',
          'verification-report',
          'synthesis-report',
          'timing-report',
          'power-report',
          'agent-output',
          'experiment-config',
        ] as const
      ).map((kind) => putAt(1000, `forever ${kind}`, kind)),
    );

    const report = await RetentionEngine.apply(NOW, DEFAULT_RETENTION_POLICY, store);

    expect(report.examined).toBe(4 + kept.length);
    expect(report.pruned.map((decision) => decision.sha256).sort()).toEqual(
      [oldLog, oldWaveform].sort(),
    );
    expect(report.prunedBytes).toBe('old waveform'.length + 'old log'.length);
    for (const sha256 of [youngWaveform, youngLog, ...kept])
      expect(await store.has(sha256)).toBe(true);

    // A second run finds nothing more to do.
    expect((await RetentionEngine.apply(NOW, DEFAULT_RETENTION_POLICY, store)).pruned).toEqual([]);
  });

  it('keeps bytes stored under several kinds for the longest of their rules', async () => {
    const shared = await putAt(20, 'shared bytes', 'waveform');
    await store.put('shared bytes', { kind: 'reproducibility-manifest' });
    await RetentionEngine.apply(NOW, DEFAULT_RETENTION_POLICY, store);
    expect(await store.has(shared)).toBe(true);
  });

  it('reports without pruning in a dry run', async () => {
    const waveform = await putAt(20, 'old waveform', 'waveform');
    const report = await RetentionEngine.apply(NOW, DEFAULT_RETENTION_POLICY, store, {
      dryRun: true,
    });
    expect(report.dryRun).toBe(true);
    expect(report.pruned).toMatchObject([
      { sha256: waveform, maxAgeDays: 14, reason: 'retention: waveform older than 14 days' },
    ]);
    expect(report.pruned[0]?.ageDays).toBeCloseTo(20);
    expect(await store.has(waveform)).toBe(true);
  });

  it('applies a custom policy and its default to kinds without a rule', async () => {
    const log = await putAt(3, 'recent log', 'tool-log');
    const report = await putAt(3, 'recent report', 'synthesis-report');
    const policy = { rules: [{ kind: 'tool-log' as const, maxAgeDays: 7 }], defaultMaxAgeDays: 2 };
    const result = await RetentionEngine.apply(NOW, policy, store);
    expect(result.pruned.map((decision) => decision.sha256)).toEqual([report]);
    expect(await store.has(log)).toBe(true);
  });
});

describe('retention policy', () => {
  it('validates', () => {
    expect(RetentionPolicySchema.safeParse(DEFAULT_RETENTION_POLICY).success).toBe(true);
    expect(
      RetentionPolicySchema.safeParse({
        rules: [{ kind: 'waveform', maxAgeDays: -1 }],
        defaultMaxAgeDays: null,
      }).success,
    ).toBe(false);
    expect(
      RetentionPolicySchema.safeParse({
        rules: [{ kind: 'core-dump', maxAgeDays: 1 }],
        defaultMaxAgeDays: null,
      }).success,
    ).toBe(false);
  });

  it('gives each kind its documented default', () => {
    expect(retentionDaysFor(['waveform'], DEFAULT_RETENTION_POLICY)).toBe(14);
    expect(retentionDaysFor(['tool-log'], DEFAULT_RETENTION_POLICY)).toBe(30);
    expect(retentionDaysFor(['waveform', 'tool-log'], DEFAULT_RETENTION_POLICY)).toBe(30);
    expect(retentionDaysFor(['reproducibility-manifest'], DEFAULT_RETENTION_POLICY)).toBeNull();
    expect(retentionDaysFor(['agent-output'], DEFAULT_RETENTION_POLICY)).toBeNull();
  });
});
