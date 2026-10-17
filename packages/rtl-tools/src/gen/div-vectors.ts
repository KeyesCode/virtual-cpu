import { fileURLToPath } from 'node:url';
import { div } from '@vcpu/cpu-core';

/** Where `make test-divider` expects the vectors; build/ is git-ignored. */
export const DIV_VECTORS_PATH = fileURLToPath(
  new URL('../../../../hardware/rtl/vcpu8/build/vectors/div.hex', import.meta.url),
);

/** One test of vcpu8_divider: the operands and the quotient `@vcpu/cpu-core`'s `div` produced. */
export interface DivVector {
  readonly a: number;
  readonly b: number;
  readonly q: number;
}

/**
 * Every (a, b ≠ 0) pair, a major and b minor: 256 × 255 = 65,280 records. b = 0 is left out
 * because `div` throws there; the CPU raises DIVIDE_BY_ZERO before the divider starts.
 */
export function* divVectors(): Generator<DivVector> {
  for (let a = 0; a < 0x100; a += 1) {
    for (let b = 1; b < 0x100; b += 1) {
      yield { a, b, q: div(a, b).result };
    }
  }
}

const hex = (value: number): string => value.toString(16).toUpperCase().padStart(2, '0');

/** One `$readmemh` word of 24 bits (6 hex digits): `{a[7:0], b[7:0], q[7:0]}`. */
export function formatDivVector(vector: DivVector): string {
  return hex(vector.a) + hex(vector.b) + hex(vector.q);
}

/** The vectors file (one record per line) and the record count the testbench reads from div.meta. */
export function renderDivVectors(): { hex: string; count: number } {
  const lines: string[] = [];
  for (const vector of divVectors()) {
    lines.push(formatDivVector(vector));
  }
  return { hex: `${lines.join('\n')}\n`, count: lines.length };
}
