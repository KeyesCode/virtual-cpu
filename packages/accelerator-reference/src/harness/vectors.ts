import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  fitsInt32,
  INT32_MAX,
  INT32_MIN,
  matmulExact,
  matmulInt8,
  type MatmulDims,
  type MatmulOptions,
  maxAbs,
  validateDims,
  validateInt8Matrix,
} from '../model/matmul.js';

/**
 * The plain-text test-vector format the C++/SV side reads (it has no JSON parser). Every file is
 * one decimal integer per line, LF line endings, a final LF:
 *
 * - `<case>.in`: `M N K` on line 1, then the M·K values of A, then the K·N values of B, row-major.
 * - `<case>.expected`: the M·N INT32 values of C from {@link matmulInt8}, row-major.
 * - `<case>.out`: written by the RTL runner, in the `.expected` format.
 * - `<case>.json`: the sidecar ({@link CaseMetaSchema}), for the TypeScript side only.
 */

export const CaseMetaSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('matmul-case'),
  name: z.string().min(1),
  /** The PRNG seed, or null for a case not drawn from one. */
  seed: z.number().int().nonnegative().nullable(),
  /** A `gen-vectors` generator name, or a free label for a hand-written case. */
  generator: z.string().min(1),
  dims: z.object({
    m: z.number().int().positive(),
    n: z.number().int().positive(),
    k: z.number().int().positive(),
  }),
  /** One MAC per (i, j, k): M·N·K. */
  macs: z.number().int().positive(),
  /** Whether every exact result fits in INT32, so the expected output equals the mathematical C. */
  fitsInt32: z.boolean(),
  /** The largest |C[i][j]| before wrapping. */
  maxAbsExact: z.number().int().nonnegative(),
});
export type CaseMeta = z.infer<typeof CaseMetaSchema>;

export interface MatmulCase extends MatmulDims {
  readonly a: ArrayLike<number>;
  readonly b: ArrayLike<number>;
}

export interface CaseProvenance {
  readonly seed: number | null;
  readonly generator: string;
}

export interface WrittenCase {
  readonly input: string;
  readonly expected: string;
  readonly meta: string;
  readonly caseMeta: CaseMeta;
  readonly c: Int32Array;
}

function lines(values: Iterable<number>): string {
  let out = '';
  for (const value of values) {
    out += `${String(value)}\n`;
  }
  return out;
}

/** The `.in` text of a case. */
export function formatCaseInput(testCase: MatmulCase): string {
  const { m, n, k, a, b } = testCase;
  return `${String(m)} ${String(n)} ${String(k)}\n${lines(Array.from(a))}${lines(Array.from(b))}`;
}

/** The `.expected` / `.out` text of an M·N result. */
export function formatOutput(c: Iterable<number>): string {
  return lines(c);
}

/** The sidecar of a case, from the exact (unwrapped) product. */
export function caseMeta(
  name: string,
  testCase: MatmulCase,
  provenance: CaseProvenance,
  options: MatmulOptions = {},
): CaseMeta {
  const exact = matmulExact(testCase.a, testCase.b, testCase, options);
  return CaseMetaSchema.parse({
    schemaVersion: 1,
    kind: 'matmul-case',
    name,
    seed: provenance.seed,
    generator: provenance.generator,
    dims: { m: testCase.m, n: testCase.n, k: testCase.k },
    macs: testCase.m * testCase.n * testCase.k,
    fitsInt32: fitsInt32(exact),
    maxAbsExact: maxAbs(exact),
  });
}

/** Writes `<name>.in`, `<name>.expected` and `<name>.json` into `dir` (created if missing). */
export function writeCase(
  dir: string,
  name: string,
  testCase: MatmulCase,
  provenance: CaseProvenance,
  options: MatmulOptions = {},
): WrittenCase {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new RangeError(
      `A case name starts with a letter or digit and uses only letters, digits, '.', '_' and '-', got '${name}'`,
    );
  }
  const c = matmulInt8(testCase.a, testCase.b, testCase, options);
  const meta = caseMeta(name, testCase, provenance, options);
  mkdirSync(dir, { recursive: true });
  const input = join(dir, `${name}.in`);
  const expected = join(dir, `${name}.expected`);
  const metaFile = join(dir, `${name}.json`);
  writeFileSync(input, formatCaseInput(testCase));
  writeFileSync(expected, formatOutput(c));
  writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  return { input, expected, meta: metaFile, caseMeta: meta, c };
}

/**
 * The integers of a vector file, one per line; throws naming the first malformed line, counting
 * from `firstLine`.
 */
function parseLines(text: string, file: string, firstLine = 1): number[] {
  const rows = text.split('\n');
  if (rows.at(-1) === '') {
    rows.pop();
  }
  return rows.map((row, index) => {
    if (!/^-?\d+$/.test(row)) {
      throw new SyntaxError(
        `${file}:${String(firstLine + index)}: expected one integer, got '${row}'`,
      );
    }
    return Number(row);
  });
}

/** Parses `.in` text back into a case, validating the dimensions and every INT8 value. */
export function parseCaseInput(
  text: string,
  file = '<input>',
  options: MatmulOptions = {},
): MatmulCase {
  const newline = text.indexOf('\n');
  const header = newline === -1 ? text : text.slice(0, newline);
  const match = /^(\d+) (\d+) (\d+)$/.exec(header);
  if (match === null) {
    throw new SyntaxError(`${file}:1: expected 'M N K', got '${header}'`);
  }
  const dims = { m: Number(match[1]), n: Number(match[2]), k: Number(match[3]) };
  validateDims(dims, options);
  const values = parseLines(newline === -1 ? '' : text.slice(newline + 1), file, 2);
  const aCount = dims.m * dims.k;
  const bCount = dims.k * dims.n;
  if (values.length !== aCount + bCount) {
    throw new RangeError(
      `${file}: expected ${String(aCount)} values of A and ${String(bCount)} of B, got ${String(values.length)} values`,
    );
  }
  const a = values.slice(0, aCount);
  const b = values.slice(aCount);
  validateInt8Matrix('A', a, dims.m, dims.k);
  validateInt8Matrix('B', b, dims.k, dims.n);
  return { ...dims, a: Int8Array.from(a), b: Int8Array.from(b) };
}

export function readCase(file: string, options: MatmulOptions = {}): MatmulCase {
  return parseCaseInput(readFileSync(file, 'utf8'), file, options);
}

/** Parses `.expected` / `.out` text: INT32 decimals, one per line. */
export function parseOutput(text: string, file = '<output>'): Int32Array {
  const values = parseLines(text, file);
  values.forEach((value, index) => {
    if (value < INT32_MIN || value > INT32_MAX) {
      throw new RangeError(
        `${file}:${String(index + 1)}: ${String(value)} is outside the INT32 range`,
      );
    }
  });
  return Int32Array.from(values);
}

/** Reads a `.out` (or `.expected`) file. */
export function readOutput(file: string): Int32Array {
  return parseOutput(readFileSync(file, 'utf8'), file);
}

export interface OutputMismatch {
  /** Row-major index into C. */
  readonly index: number;
  readonly i: number;
  readonly j: number;
  readonly expected: number;
  readonly actual: number;
}

/**
 * Every element where `actual` differs from `expected`, for an M × N result with `n` columns.
 * Throws when the two lengths differ: a short or long output is a runner failure, not a mismatch.
 */
export function compareOutputs(
  expected: ArrayLike<number>,
  actual: ArrayLike<number>,
  n: number,
): OutputMismatch[] {
  if (expected.length !== actual.length) {
    throw new RangeError(
      `Expected ${String(expected.length)} output values, got ${String(actual.length)}`,
    );
  }
  const mismatches: OutputMismatch[] = [];
  for (let index = 0; index < expected.length; index += 1) {
    const want = expected[index] ?? 0;
    const got = actual[index] ?? 0;
    if (want !== got) {
      mismatches.push({
        index,
        i: Math.floor(index / n),
        j: index % n,
        expected: want,
        actual: got,
      });
    }
  }
  return mismatches;
}
