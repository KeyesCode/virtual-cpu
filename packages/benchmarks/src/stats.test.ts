import { describe, expect, it } from 'vitest';
import { mean, median, percentile, stddev, summarize } from './stats.js';

describe('stats', () => {
  it('computes the mean and the median of odd and even counts', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('computes the Bessel-corrected sample standard deviation', () => {
    // Deviations from 5: −3 −1 −1 −1 0 0 2 4 → squares sum to 32; 32 / 7.
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(stddev([42])).toBe(0);
  });

  it('interpolates percentiles linearly between closest ranks', () => {
    const values = [10, 20, 30, 40, 50];
    expect(percentile(values, 0)).toBe(10);
    expect(percentile(values, 100)).toBe(50);
    expect(percentile(values, 25)).toBe(20);
    // rank (5 − 1) · 0.05 = 0.2 → 10 + 0.2 · 10
    expect(percentile(values, 5)).toBeCloseTo(12, 12);
    expect(percentile(values, 95)).toBeCloseTo(48, 12);
  });

  it('does not reorder its input', () => {
    const values = [3, 1, 2];
    summarize(values);
    expect(values).toEqual([3, 1, 2]);
  });

  it('summarizes every statistic at once', () => {
    expect(summarize([4, 1, 3, 2])).toEqual({
      n: 4,
      min: 1,
      max: 4,
      mean: 2.5,
      median: 2.5,
      stddev: Math.sqrt(5 / 3),
      p5: 1.15,
      p95: 3.85,
    });
  });

  it('rejects empty and non-finite samples and out-of-range percentiles', () => {
    expect(() => mean([])).toThrow(RangeError);
    expect(() => summarize([1, Number.NaN])).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
});
