import { describe, expect, it } from 'vitest';
import type { Metric } from '../domain/metric.js';
import {
  areaDelayProduct,
  energyPerOp,
  improvementPercent,
  perfPerWatt,
  throughputPerArea,
} from './derived.js';
import { estimated, measured, theoretical, unavailable } from './metric.js';

function value(metric: Metric): number {
  if (metric.provenance === 'unavailable') throw new Error(`unavailable: ${metric.reason}`);
  return metric.value;
}

describe('areaDelayProduct', () => {
  it('multiplies µm² by ns: 1,000 µm² × 2.5 ns = 2,500 µm²·ns', () => {
    expect(areaDelayProduct(measured(1000, 'um^2'), measured(2.5, 'ns'))).toMatchObject({
      value: 2500,
      unit: 'um^2*ns',
      provenance: 'measured',
    });
  });

  it('converts a delay in ps', () => {
    expect(value(areaDelayProduct(measured(1000, 'um^2'), measured(2500, 'ps')))).toBeCloseTo(
      2500,
      9,
    );
  });

  it('is unavailable, naming delay, when the delay is unavailable', () => {
    const adp = areaDelayProduct(measured(1000, 'um^2'), unavailable('STA not run'));
    expect(adp.provenance).toBe('unavailable');
    expect(adp).toEqual({ provenance: 'unavailable', reason: 'delay is unavailable: STA not run' });
  });

  it('refuses a cell count where an area is required', () => {
    expect(areaDelayProduct(measured(1008, 'count'), measured(2.5, 'ns'))).toEqual({
      provenance: 'unavailable',
      reason: 'area must be in um^2, got count',
    });
  });

  it('takes the weakest provenance', () => {
    expect(areaDelayProduct(measured(1000, 'um^2'), estimated(2.5, 'ns')).provenance).toBe(
      'estimated',
    );
  });

  it('refuses theoretical inputs unless allowed', () => {
    expect(areaDelayProduct(theoretical(1000, 'um^2'), measured(2.5, 'ns'))).toEqual({
      provenance: 'unavailable',
      reason: 'area is theoretical-only',
    });
    expect(
      areaDelayProduct(theoretical(1000, 'um^2'), measured(2.5, 'ns'), { allowTheoretical: true }),
    ).toMatchObject({ value: 2500, provenance: 'theoretical' });
  });
});

describe('improvementPercent', () => {
  it('baseline 2,500 vs candidate 2,125 is 15 %, estimated from estimated inputs', () => {
    const baseline = areaDelayProduct(estimated(1000, 'um^2'), estimated(2.5, 'ns'));
    const candidate = areaDelayProduct(estimated(850, 'um^2'), estimated(2.5, 'ns'));
    const improvement = improvementPercent(baseline, candidate);
    expect(Math.abs(value(improvement) - 15)).toBeLessThan(1e-9);
    expect(improvement).toMatchObject({ unit: '%', provenance: 'estimated' });
  });

  it('is negative when the candidate is worse', () => {
    expect(value(improvementPercent(measured(2500, 'um^2*ns'), measured(3000, 'um^2*ns')))).toBe(
      -20,
    );
  });

  it('propagates an unavailable candidate', () => {
    const candidateAdp = areaDelayProduct(measured(850, 'um^2'), unavailable('STA timed out'));
    const improvement = improvementPercent(measured(2500, 'um^2*ns'), candidateAdp);
    expect(improvement).toEqual({
      provenance: 'unavailable',
      reason: 'candidate is unavailable: delay is unavailable: STA timed out',
    });
  });

  it('refuses a zero baseline and mismatched units', () => {
    expect(improvementPercent(measured(0, 'um^2*ns'), measured(10, 'um^2*ns'))).toEqual({
      provenance: 'unavailable',
      reason: 'division by zero: baseline is 0',
    });
    expect(improvementPercent(measured(2500, 'um^2*ns'), measured(2500, 'count'))).toEqual({
      provenance: 'unavailable',
      reason: 'candidate must be in um^2*ns, got count',
    });
  });
});

describe('power and throughput metrics', () => {
  it('energy per operation: 2 mW at 100 MOPS = 20 pJ/op', () => {
    expect(energyPerOp(estimated(2, 'mW'), measured(100, 'MOPS'))).toMatchObject({
      value: 20,
      unit: 'pJ/op',
      provenance: 'estimated',
    });
  });

  it('performance per watt: 100 MOPS at 2 mW = 50 GOPS/W', () => {
    expect(value(perfPerWatt(measured(0.1, 'GOPS'), estimated(2000, 'uW')))).toBeCloseTo(50, 9);
  });

  it('throughput per area: 100 MOPS on 1,000 µm² = 100 GOPS/mm²', () => {
    expect(throughputPerArea(measured(100, 'MOPS'), measured(1000, 'um^2'))).toMatchObject({
      value: 100,
      unit: 'GOPS/mm^2',
    });
  });

  it('is unavailable when power is unavailable or zero', () => {
    expect(perfPerWatt(measured(100, 'MOPS'), unavailable('no power flow')).provenance).toBe(
      'unavailable',
    );
    expect(perfPerWatt(measured(100, 'MOPS'), estimated(0, 'mW'))).toEqual({
      provenance: 'unavailable',
      reason: 'division by zero: power is 0',
    });
  });
});
