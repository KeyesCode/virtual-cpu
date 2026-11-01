import { describe, expect, it } from 'vitest';
import {
  BaselineManifestSchema,
  CampaignConfigSchema,
  CandidateDescriptorSchema,
  ExperimentStateSchema,
  MetricSchema,
  type CampaignConfig,
} from './index.js';

const hash = 'a'.repeat(64);

const config: CampaignConfig = {
  name: 'INT8 MAC Optimization',
  target: 'matmul-processing-element',
  baseline: 'verified-baseline-v1',
  objective: 'minimize-area-delay-product',
  maxExperiments: 100,
  maxConcurrentExperiments: 2,
  maxRuntimeHours: 24,
  allowedChanges: ['hardware/accelerators/matmul/rtl/'],
  requiredVerification: ['unit', 'differential', 'randomized'],
  stopConditions: { targetImprovementPercent: 15, stopOnBudgetExceeded: true },
};

describe('ExperimentStateSchema', () => {
  it('has the 14 states and refuses any other', () => {
    expect(ExperimentStateSchema.options).toHaveLength(14);
    expect(ExperimentStateSchema.safeParse('RUNNING').success).toBe(false);
  });
});

describe('MetricSchema', () => {
  it('accepts a measured value with its unit', () => {
    const metric = {
      value: 1234.5,
      unit: 'um^2',
      provenance: 'measured',
      method: 'liberty cell area',
      tool: 'yosys',
      toolVersion: '0.70+145',
    };
    expect(MetricSchema.parse(metric)).toEqual(metric);
  });

  it('accepts negative values, because slack can be negative', () => {
    expect(
      MetricSchema.safeParse({ value: -0.2, unit: 'ns', provenance: 'measured' }).success,
    ).toBe(true);
  });

  it('keeps an unavailable metric free of any value', () => {
    const metric = MetricSchema.parse({ provenance: 'unavailable', reason: 'no PDK' });
    expect(metric).toEqual({ provenance: 'unavailable', reason: 'no PDK' });
    expect(metric).not.toHaveProperty('value');
  });

  it.each([
    ['a value with no unit', { value: 1, provenance: 'measured' }],
    ['an unavailable metric carrying 0', { value: 0, provenance: 'unavailable', reason: 'no PDK' }],
    ['an unavailable metric with no reason', { provenance: 'unavailable' }],
    ['an unknown provenance', { value: 1, unit: 'ns', provenance: 'guessed' }],
    ['a value that is not finite', { value: Infinity, unit: 'ns', provenance: 'measured' }],
  ])('refuses %s', (_name, metric) => {
    expect(MetricSchema.safeParse(metric).success).toBe(false);
  });
});

describe('CampaignConfigSchema', () => {
  it('accepts the example of brief §16', () => {
    expect(CampaignConfigSchema.parse(config)).toEqual(config);
  });

  it.each([
    ['a negative experiment count', { maxExperiments: -1 }],
    ['more concurrency than experiments', { maxExperiments: 1, maxConcurrentExperiments: 2 }],
    ['an empty allowlist', { allowedChanges: [] }],
    ['the repository root', { allowedChanges: ['.'] }],
    ['an absolute path', { allowedChanges: ['/etc/passwd'] }],
    ['a path that climbs out', { allowedChanges: ['hardware/../..'] }],
    ['an unknown verification suite', { requiredVerification: ['vibes'] }],
    ['an unknown key', { allowEverything: true }],
  ])('refuses %s', (_name, change) => {
    expect(CampaignConfigSchema.safeParse({ ...config, ...change }).success).toBe(false);
  });
});

describe('BaselineManifestSchema', () => {
  const manifest = {
    name: 'verified-baseline-v1',
    sourceCommit: '1'.repeat(40),
    sourceContentHash: hash,
    parameters: { DATA_W: 8, ACC_W: 32 },
    verificationSuiteVersion: 'matmul-os-r1',
    synthesisConfig: { flow: 'abc -liberty' },
    timingConstraints: { clockPeriod: { value: 5, unit: 'ns' } },
    targetTechnology: 'sky130_fd_sc_hd__tt_025C_1v80',
    toolVersions: { yosys: '0.70+145' },
    metrics: { power: { provenance: 'unavailable', reason: 'no activity data' } },
  };

  it('accepts a complete manifest', () => {
    expect(BaselineManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it('refuses a clock period with no unit', () => {
    const timingConstraints = { clockPeriod: { value: 5 } };
    expect(BaselineManifestSchema.safeParse({ ...manifest, timingConstraints }).success).toBe(
      false,
    );
  });
});

describe('CandidateDescriptorSchema', () => {
  const descriptor = {
    candidateHash: hash,
    changedFiles: ['hardware/accelerators/matmul/rtl/processing_element.sv'],
    architectureParameters: { DATA_W: 8 },
  };

  it('accepts a candidate with no parent', () => {
    expect(CandidateDescriptorSchema.parse(descriptor)).toEqual(descriptor);
  });

  it('refuses a hash that is not SHA-256', () => {
    const candidate = { ...descriptor, candidateHash: 'abc' };
    expect(CandidateDescriptorSchema.safeParse(candidate).success).toBe(false);
  });
});
