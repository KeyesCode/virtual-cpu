import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_DIM, matmulInt8 } from '../model/matmul.js';
import { leadingOperands, topSuitePlan, writeTopSuite } from './top-vectors.js';
import { readCase, readOutput } from './vectors.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'accel-top-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('topSuitePlan', () => {
  it('lists the directed products first, with the reuse cases right after the first', () => {
    const plan = topSuitePlan({ rows: 8, cols: 8, seed: 3, count: 20 });
    const directed = plan.filter((testCase) => !testCase.random);
    expect(directed.map((testCase) => testCase.name)).toEqual([
      'random-m64-n64-k64-s3',
      'reuse-m40-n27-k33-s3',
      'reuse-m64-n64-k64-s3',
      'random-m4-n4-k4-s3',
      'random-m8-n8-k8-s3',
      'random-m16-n16-k16-s3',
      'random-m32-n32-k32-s3',
      'random-m13-n11-k19-s3',
      'random-m1-n45-k30-s3',
      'random-m37-n1-k50-s3',
      'random-m53-n61-k1-s3',
      'random-m1-n1-k1-s3',
      'zero-m23-n29-k31-s3',
      'identity-m27-n20-k20-s3',
      'min-m64-n64-k64-s3',
      'max-m64-n64-k64-s3',
      'mixed-m33-n35-k37-s3',
    ]);
    expect(plan.slice(0, directed.length).every((testCase) => !testCase.random)).toBe(true);
    expect(plan.filter((testCase) => testCase.reuse).map((testCase) => testCase.generator)).toEqual(
      ['random', 'random'],
    );
    const random = plan.filter((testCase) => testCase.random);
    expect(random).toHaveLength(20);
    for (const testCase of random) {
      for (const dim of [testCase.dims.m, testCase.dims.n, testCase.dims.k]) {
        expect(dim).toBeGreaterThanOrEqual(1);
        expect(dim).toBeLessThanOrEqual(MAX_DIM);
      }
      expect(testCase.reuse).toBe(false);
    }
    expect(new Set(plan.map((testCase) => testCase.name)).size).toBe(plan.length);
  });

  it('is a function of its seed', () => {
    const options = { rows: 4, cols: 4, count: 5 };
    expect(topSuitePlan({ ...options, seed: 7 })).toEqual(topSuitePlan({ ...options, seed: 7 }));
    expect(topSuitePlan({ ...options, seed: 7 })).not.toEqual(
      topSuitePlan({ ...options, seed: 8 }),
    );
  });

  it('rejects an array side outside 1 … MAX_DIM and a bad count', () => {
    expect(() => topSuitePlan({ rows: 0, cols: 4, seed: 1, count: 1 })).toThrow(
      'M must be at least 1',
    );
    expect(() => topSuitePlan({ rows: 4, cols: 4, seed: 1, count: -1 })).toThrow('count');
  });
});

describe('leadingOperands', () => {
  it('takes the leading submatrices and refuses a larger product', () => {
    const from = { m: 2, n: 3, k: 2 };
    const operands = { a: Int8Array.from([1, 2, 3, 4]), b: Int8Array.from([5, 6, 7, 8, 9, 10]) };
    const sub = leadingOperands(operands, from, { m: 2, n: 2, k: 1 });
    expect(Array.from(sub.a)).toEqual([1, 3]);
    expect(Array.from(sub.b)).toEqual([5, 6]);
    expect(() => leadingOperands(operands, from, { m: 3, n: 1, k: 1 })).toThrow('is not inside');
  });
});

describe('writeTopSuite', () => {
  it('writes every case, its reference C and cases.txt with the reuse flags', () => {
    const dir = tempDir();
    const suite = writeTopSuite(dir, { rows: 4, cols: 4, seed: 1, count: 2 });
    expect(readFileSync(suite.list, 'utf8')).toBe(
      suite.cases.map((testCase) => `${testCase.name}${testCase.reuse ? ' reuse' : ''}\n`).join(''),
    );
    for (const testCase of suite.cases) {
      const back = readCase(join(dir, `${testCase.name}.in`));
      expect(back).toMatchObject(testCase.dims);
      expect(readOutput(join(dir, `${testCase.name}.expected`))).toEqual(
        matmulInt8(back.a, back.b, back),
      );
    }
    // A reuse case's operands are the leading submatrices of the first case's.
    const first = readCase(join(dir, `${suite.cases[0]?.name ?? ''}.in`));
    const firstOperands = { a: Int8Array.from(first.a), b: Int8Array.from(first.b) };
    for (const testCase of suite.cases.filter((c) => c.reuse)) {
      const back = readCase(join(dir, `${testCase.name}.in`));
      const expected = leadingOperands(firstOperands, first, testCase.dims);
      expect(Array.from(back.a)).toEqual(Array.from(expected.a));
      expect(Array.from(back.b)).toEqual(Array.from(expected.b));
    }
  });
});
