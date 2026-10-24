import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { matmulInt8 } from '../model/matmul.js';
import { generateOperands } from '../model/prng.js';
import {
  CaseMetaSchema,
  compareOutputs,
  formatCaseInput,
  formatOutput,
  parseCaseInput,
  parseOutput,
  readCase,
  readOutput,
  writeCase,
} from './vectors.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'accel-vectors-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('the text format', () => {
  it('writes M N K, then A, then B, one decimal per line with LF endings', () => {
    const text = formatCaseInput({ m: 1, n: 2, k: 2, a: [-1, 2], b: [3, -128, 127, 0] });
    expect(text).toBe('1 2 2\n-1\n2\n3\n-128\n127\n0\n');
    expect(formatOutput([254, -128])).toBe('254\n-128\n');
  });

  it('rejects a malformed header, a bad value count and a non-integer line', () => {
    expect(() => parseCaseInput('1 1\n0\n0\n')).toThrow("expected 'M N K'");
    expect(() => parseCaseInput('1 1 2\n0\n0\n0\n')).toThrow('expected 2 values of A and 2 of B');
    expect(() => parseCaseInput('1 1 1\n0\n 1\n')).toThrow('<input>:3');
    expect(() => parseCaseInput('0 1 1\n')).toThrow('M must be at least 1');
    expect(() => parseCaseInput('1 1 1\n0\n200\n')).toThrow('B[0][0] must be a signed INT8');
    expect(() => parseOutput('1\n2147483648\n')).toThrow('outside the INT32 range');
  });
});

describe('writeCase', () => {
  it('round-trips a case and its expected output', () => {
    const dir = tempDir();
    const dims = { m: 13, n: 11, k: 19 };
    const { a, b } = generateOperands('random', 1, dims);
    const written = writeCase(dir, 'r', { ...dims, a, b }, { seed: 1, generator: 'random' });
    expect(written.input).toBe(join(dir, 'r.in'));
    const back = readCase(written.input);
    expect(back).toEqual({ ...dims, a, b });
    expect(readOutput(written.expected)).toEqual(matmulInt8(a, b, dims));
    const meta = CaseMetaSchema.parse(JSON.parse(readFileSync(written.meta, 'utf8')));
    expect(meta).toEqual(written.caseMeta);
    expect(meta).toMatchObject({
      name: 'r',
      seed: 1,
      generator: 'random',
      dims,
      macs: 13 * 11 * 19,
      fitsInt32: true,
    });
    const lines = readFileSync(written.input, 'utf8').split('\n');
    expect(lines).toHaveLength(1 + 13 * 19 + 19 * 11 + 1);
    expect(lines.at(-1)).toBe('');
  });

  it('records fitsInt32 false and the wrapped output for an overflowing case', () => {
    const dir = tempDir();
    const k = 140_000;
    const a = new Int8Array(k).fill(-128);
    const written = writeCase(
      dir,
      'overflow',
      { m: 1, n: 1, k, a, b: a },
      { seed: null, generator: 'overflow' },
      { maxDim: k },
    );
    expect(written.caseMeta.fitsInt32).toBe(false);
    expect(written.caseMeta.maxAbsExact).toBe(16384 * k);
    expect(readFileSync(written.expected, 'utf8')).toBe(`${String((16384 * k) | 0)}\n`);
  });

  it('rejects a case name that is not a plain file name', () => {
    expect(() =>
      writeCase(
        tempDir(),
        '../x',
        { m: 1, n: 1, k: 1, a: [1], b: [1] },
        { seed: 1, generator: 'x' },
      ),
    ).toThrow('A case name');
  });
});

describe('compareOutputs', () => {
  it('lists every differing element with its row and column', () => {
    expect(compareOutputs([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6], 3)).toEqual([]);
    expect(compareOutputs([1, 2, 3, 4, 5, 6], [1, 9, 3, 4, 5, -6], 3)).toEqual([
      { index: 1, i: 0, j: 1, expected: 2, actual: 9 },
      { index: 5, i: 1, j: 2, expected: 6, actual: -6 },
    ]);
  });

  it('throws when the lengths differ', () => {
    expect(() => compareOutputs([1, 2], [1], 2)).toThrow('Expected 2 output values, got 1');
  });
});
