import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_DIM, matmulInt8 } from '../model/matmul.js';
import { tileSuitePlan, writeTileCase, writeTileSuite } from './tile-vectors.js';
import { readCase, readOutput } from './vectors.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'accel-tiles-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('tileSuitePlan', () => {
  it('lists the directed tiles first, then the random ones', () => {
    const plan = tileSuitePlan({ rows: 8, cols: 8, seed: 3, count: 30 });
    expect(plan.filter((testCase) => !testCase.random).map((testCase) => testCase.name)).toEqual([
      'zero-8x8-k16-s3',
      'identity-8x8-k8-s3',
      'min-8x8-k64-s3',
      'max-8x8-k64-s3',
      'mixed-8x8-k17-s3',
      'random-8x8-k1-s3',
      'random-8x8-k3-s3',
      'random-8x8-k64-s3',
    ]);
    const random = plan.filter((testCase) => testCase.random);
    expect(random).toHaveLength(30);
    expect(plan.slice(0, 8).every((testCase) => !testCase.random)).toBe(true);
    for (const testCase of random) {
      expect(testCase.k).toBeGreaterThanOrEqual(1);
      expect(testCase.k).toBeLessThanOrEqual(MAX_DIM);
      expect(testCase.name).toContain(`-k${String(testCase.k)}-s${String(testCase.seed)}`);
    }
    expect(new Set(plan.map((testCase) => testCase.name)).size).toBe(plan.length);
  });

  it('is a function of its seed', () => {
    const options = { rows: 4, cols: 4, count: 5 };
    expect(tileSuitePlan({ ...options, seed: 7 })).toEqual(tileSuitePlan({ ...options, seed: 7 }));
    expect(tileSuitePlan({ ...options, seed: 7 })).not.toEqual(
      tileSuitePlan({ ...options, seed: 8 }),
    );
  });

  it('rejects an array side outside 1 … MAX_DIM and a bad count', () => {
    expect(() => tileSuitePlan({ rows: 0, cols: 4, seed: 1, count: 1 })).toThrow(
      'M must be at least 1',
    );
    expect(() => tileSuitePlan({ rows: 4, cols: 65, seed: 1, count: 1 })).toThrow(
      'N must be at most 64',
    );
    expect(() => tileSuitePlan({ rows: 4, cols: 4, seed: 1, count: -1 })).toThrow('count');
  });
});

describe('writeTileSuite', () => {
  it('writes one ROWS × COLS matmul case per tile and cases.txt in run order', () => {
    const dir = tempDir();
    const suite = writeTileSuite(dir, { rows: 4, cols: 2, seed: 1, count: 2 });
    expect(readFileSync(suite.list, 'utf8')).toBe(
      suite.cases.map((testCase) => `${testCase.name}\n`).join(''),
    );
    for (const testCase of suite.cases) {
      const back = readCase(join(dir, `${testCase.name}.in`));
      expect(back).toMatchObject({ m: 4, n: 2, k: testCase.k });
      expect(readOutput(join(dir, `${testCase.name}.expected`))).toEqual(
        matmulInt8(back.a, back.b, back),
      );
    }
  });

  it('writes the directed extremes and the identity', () => {
    const dir = tempDir();
    const array = { rows: 4, cols: 4 };
    const min = writeTileCase(dir, array, { name: 'min', generator: 'min', k: MAX_DIM, seed: 0 });
    expect(Array.from(min.c)).toEqual(new Array<number>(16).fill(MAX_DIM * 128 * 128));
    const identity = writeTileCase(dir, array, {
      name: 'identity',
      generator: 'identity',
      k: 4,
      seed: 5,
    });
    expect(Array.from(identity.c)).toEqual(Array.from(readCase(identity.input).a));
  });
});
