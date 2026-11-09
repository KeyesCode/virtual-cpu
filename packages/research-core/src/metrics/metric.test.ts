import { describe, expect, it } from 'vitest';
import {
  conversionFactor,
  convert,
  estimated,
  isAvailable,
  measured,
  requireUnit,
  theoretical,
  unavailable,
  weakestProvenance,
} from './metric.js';
import { PpaSnapshotSchema, unavailablePpaSnapshot } from './ppa.js';

describe('metric constructors', () => {
  it('builds tagged metrics with their source', () => {
    expect(measured(1000, 'um^2', { tool: 'yosys', toolVersion: '0.70+145' })).toEqual({
      value: 1000,
      unit: 'um^2',
      provenance: 'measured',
      tool: 'yosys',
      toolVersion: '0.70+145',
    });
    expect(estimated(1.5, 'mW').provenance).toBe('estimated');
    expect(theoretical(1, 'ops/cycle').provenance).toBe('theoretical');
  });

  it('refuses NaN, infinities, negatives and unknown units at construction', () => {
    expect(() => measured(Number.NaN, 'ns')).toThrow(RangeError);
    expect(() => measured(Number.POSITIVE_INFINITY, 'ns')).toThrow(RangeError);
    expect(() => measured(-1, 'um^2')).toThrow(/cannot be negative/);
    expect(() => measured(1, 'furlongs' as never)).toThrow(/unknown metric unit/);
    expect(measured(-0.2, 'ns', { signed: true }).value).toBe(-0.2);
  });

  it('keeps unavailable distinct from zero', () => {
    const metric = unavailable('no OpenROAD in the image');
    expect(metric).toEqual({ provenance: 'unavailable', reason: 'no OpenROAD in the image' });
    expect('value' in metric).toBe(false);
    expect(isAvailable(metric)).toBe(false);
    expect(() => unavailable(' ')).toThrow(RangeError);
  });

  it('orders provenance measured > estimated > theoretical', () => {
    expect(weakestProvenance(['measured', 'measured'])).toBe('measured');
    expect(weakestProvenance(['measured', 'estimated'])).toBe('estimated');
    expect(weakestProvenance(['theoretical', 'estimated'])).toBe('theoretical');
  });
});

describe('units', () => {
  it('converts within a dimension only', () => {
    expect(conversionFactor('ps', 'ns')).toBe(1e-3);
    expect(conversionFactor('W', 'mW')).toBe(1e3);
    expect(conversionFactor('um^2', 'count')).toBeUndefined();
    expect(conversionFactor('cycles', 'ns')).toBeUndefined();
    expect(convert(measured(2500, 'ps'), 'ns')).toMatchObject({ value: 2.5, unit: 'ns' });
  });

  it('requireUnit refuses a count where an area is required', () => {
    expect(requireUnit(measured(1008, 'count'), 'um^2', 'area')).toEqual({
      ok: false,
      reason: 'area must be in um^2, got count',
    });
    expect(requireUnit(unavailable('not run'), 'um^2', 'area')).toEqual({
      ok: false,
      reason: 'area is unavailable: not run',
    });
  });
});

describe('PpaSnapshotSchema', () => {
  it('accepts an all-unavailable snapshot', () => {
    expect(PpaSnapshotSchema.parse(unavailablePpaSnapshot('not evaluated'))).toBeTruthy();
  });

  it('refuses a field in the wrong unit and measured power', () => {
    const snapshot = unavailablePpaSnapshot('not evaluated');
    snapshot.area.cellArea = measured(1008, 'count');
    snapshot.power.total = measured(1.2, 'mW');
    const result = PpaSnapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(false);
    const paths = result.error?.issues.map((issue) => issue.path.join('.'));
    expect(paths).toEqual(['area.cellArea.unit', 'power.total.provenance']);
  });

  it('allows negative slack but not negative area', () => {
    const snapshot = unavailablePpaSnapshot('not evaluated');
    snapshot.performance.worstSlack = measured(-0.3, 'ns', { signed: true });
    expect(PpaSnapshotSchema.safeParse(snapshot).success).toBe(true);
    snapshot.area.cellArea = { value: -1, unit: 'um^2', provenance: 'measured' };
    expect(PpaSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });
});
