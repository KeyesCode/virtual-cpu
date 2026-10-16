/** Summary statistics of one set of samples, all in the samples' own unit. */
export interface SampleStats {
  /** Number of samples. */
  readonly n: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly median: number;
  /** Sample standard deviation (n − 1 denominator); 0 for a single sample. */
  readonly stddev: number;
  /** 5th percentile, linearly interpolated. */
  readonly p5: number;
  /** 95th percentile, linearly interpolated. */
  readonly p95: number;
}

function assertSamples(values: readonly number[]): void {
  if (values.length === 0) {
    throw new RangeError('at least one sample is required');
  }
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`samples must be finite numbers, got ${String(value)}`);
    }
  }
}

function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

export function mean(values: readonly number[]): number {
  assertSamples(values);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * The `p`-th percentile (0–100) with linear interpolation between closest ranks (the
 * "type 7" definition used by NumPy, R and spreadsheets): rank `(n − 1) · p / 100`.
 */
export function percentile(values: readonly number[], p: number): number {
  assertSamples(values);
  if (!(p >= 0 && p <= 100)) {
    throw new RangeError(`percentile must be between 0 and 100, got ${String(p)}`);
  }
  return percentileOfSorted(sorted(values), p);
}

function percentileOfSorted(ascending: readonly number[], p: number): number {
  const rank = ((ascending.length - 1) * p) / 100;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const low = ascending[lower] ?? 0;
  const high = ascending[upper] ?? 0;
  return low + (high - low) * (rank - lower);
}

export function median(values: readonly number[]): number {
  return percentile(values, 50);
}

/** Sample standard deviation (Bessel-corrected); 0 for a single sample. */
export function stddev(values: readonly number[]): number {
  const average = mean(values);
  if (values.length === 1) return 0;
  const squares = values.reduce((sum, value) => sum + (value - average) ** 2, 0);
  return Math.sqrt(squares / (values.length - 1));
}

export function summarize(values: readonly number[]): SampleStats {
  assertSamples(values);
  const ascending = sorted(values);
  return {
    n: values.length,
    min: ascending[0] ?? 0,
    max: ascending.at(-1) ?? 0,
    mean: mean(values),
    median: percentileOfSorted(ascending, 50),
    stddev: stddev(values),
    p5: percentileOfSorted(ascending, 5),
    p95: percentileOfSorted(ascending, 95),
  };
}
