import { createCpu } from '@vcpu/cpu-core';
import { describe, expect, it } from 'vitest';
import { type MatmulDims, matmulInt8 } from '../model/matmul.js';
import { generateOperands } from '../model/prng.js';
import {
  CPU_STACK_BYTES,
  type CpuProgram,
  cpuDataBytes,
  generateCpuProgram,
  readCpuResult,
} from './cpu-program.js';

function program(dims: MatmulDims, a: ArrayLike<number>, b: ArrayLike<number>): CpuProgram {
  const result = generateCpuProgram(dims, a, b);
  if (!result.ok) throw new Error(result.reason);
  return result.program;
}

/** Runs the image on the emulator to HALTED and returns the end memory. */
function run(image: Uint8Array): readonly number[] {
  const cpu = createCpu({ traceCapacity: 0 });
  cpu.loadProgram(image);
  expect(cpu.run({ maxInstructions: 1_000_000 }).stopReason).toBe('halted');
  return cpu.getState().memory;
}

describe('generateCpuProgram', () => {
  it.each([
    ['2x2x2', { m: 2, n: 2, k: 2 }, 3],
    ['3x3x3', { m: 3, n: 3, k: 3 }, 11],
  ])('computes a %s product with negative operands exactly on the emulator', (_, dims, seed) => {
    const { a, b } = generateOperands('random', seed, dims);
    expect([...a, ...b].some((v) => v < 0)).toBe(true);
    const p = program(dims, a, b);
    expect(Array.from(readCpuResult(run(p.image), p))).toEqual(Array.from(matmulInt8(a, b, dims)));
  });

  it('gives the reference result for every operand −128 and for mixed signs at 3x3x3', () => {
    const dims = { m: 3, n: 3, k: 3 };
    for (const generator of ['min', 'max', 'mixed'] as const) {
      const { a, b } = generateOperands(generator, 1, dims);
      const p = program(dims, a, b);
      expect(Array.from(readCpuResult(run(p.image), p))).toEqual(
        Array.from(matmulInt8(a, b, dims)),
      );
    }
  });

  it('wraps the INT32 accumulator like the reference when C starts near the limits', () => {
    const dims = { m: 3, n: 3, k: 3 };
    const { a, b } = generateOperands('mixed', 2, dims);
    const p = program(dims, a, b);
    const image = p.image.slice();
    const start = [0x7fff_ffff, -0x8000_0000, -1, 0, 1, 0x7fff_0000, -0x7fff_0000, 0x1234, -2];
    start.forEach((value, e) => {
      for (let i = 0; i < 4; i += 1) image[p.layout.c + 4 * e + i] = (value >> (8 * i)) & 0xff;
    });
    const product = matmulInt8(a, b, dims);
    expect(Array.from(readCpuResult(run(image), p))).toEqual(
      start.map((value, e) => (value + (product[e] ?? 0)) | 0),
    );
  });

  it('fits 4x4x4 in memory and reports the bytes that make 5x5x5 unsupported', () => {
    const fits = generateCpuProgram({ m: 4, n: 4, k: 4 }, new Int8Array(16), new Int8Array(16));
    expect(fits.ok).toBe(true);
    if (fits.ok) expect(fits.program.totalBytes).toBeLessThanOrEqual(256);
    const dims = { m: 5, n: 5, k: 5 };
    const tooBig = generateCpuProgram(dims, new Int8Array(25), new Int8Array(25));
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) {
      expect(tooBig.dataBytes).toBe(cpuDataBytes(dims));
      expect(tooBig.totalBytes).toBe(tooBig.codeBytes + tooBig.dataBytes + CPU_STACK_BYTES);
      expect(tooBig.totalBytes).toBeGreaterThan(256);
    }
  });
});
