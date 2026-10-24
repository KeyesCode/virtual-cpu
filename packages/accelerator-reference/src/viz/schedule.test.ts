import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matmulInt8 } from '../model/matmul.js';
import { extractTrace, SYSTOLIC_PAGE_PATH, systolicPageTrace } from './page.js';
import { SYSTOLIC_4X4_EXAMPLE, tileSchedule, tileTrace } from './schedule.js';

// The "A 4 × 4 tile with K = 3, clock by clock" table of docs/hardware/accelerators/systolic-array.md,
// copied verbatim: clock, operand clock, the four "k at PE(i, 0…3)" columns, MACs, busy, tile_done.
// prettier-ignore
const DOCUMENTED_4X4_K3: readonly (readonly [number, string, string, string, string, string, number, number, number])[] = [
  [0, '–', '· · · ·', '· · · ·', '· · · ·', '· · · ·', 0, 0, 0],
  [1, '0', '0 · · ·', '· · · ·', '· · · ·', '· · · ·', 1, 1, 0],
  [2, '1', '1 0 · ·', '0 · · ·', '· · · ·', '· · · ·', 3, 1, 0],
  [3, '2', '2 1 0 ·', '1 0 · ·', '0 · · ·', '· · · ·', 6, 1, 0],
  [4, '3', '· 2 1 0', '2 1 0 ·', '1 0 · ·', '0 · · ·', 9, 1, 0],
  [5, '4', '· · 2 1', '· 2 1 0', '2 1 0 ·', '1 0 · ·', 10, 1, 0],
  [6, '5', '· · · 2', '· · 2 1', '· 2 1 0', '2 1 0 ·', 9, 1, 0],
  [7, '6', '· · · ·', '· · · 2', '· · 2 1', '· 2 1 0', 6, 1, 0],
  [8, '7', '· · · ·', '· · · ·', '· · · 2', '· · 2 1', 3, 1, 0],
  [9, '8', '· · · ·', '· · · ·', '· · · ·', '· · · 2', 1, 1, 0],
  [10, '9', '· · · ·', '· · · ·', '· · · ·', '· · · ·', 0, 0, 1],
];

describe('tileSchedule', () => {
  it('equals the documented 4 × 4, K = 3 cycle table', () => {
    const rows = tileSchedule({ rows: 4, cols: 4, k: 3 }).map((step) => [
      step.clock,
      step.operandClock === null ? '–' : String(step.operandClock),
      ...step.macK.map((row) => row.map((k) => (k === null ? '·' : String(k))).join(' ')),
      step.macs,
      Number(step.busy),
      Number(step.tileDone),
    ]);
    expect(rows).toEqual(DOCUMENTED_4X4_K3);
  });
});

describe('tileTrace', () => {
  it('ends with every accumulator equal to the reference product of the page example', () => {
    const { rows, cols, k, a, b } = SYSTOLIC_4X4_EXAMPLE;
    const trace = tileTrace(SYSTOLIC_4X4_EXAMPLE);
    const expected = Array.from(matmulInt8(a, b, { m: rows, n: cols, k }));
    const last = trace.clocks.at(-1);
    expect(last?.tileDone).toBe(true);
    expect(last?.acc.flat()).toEqual(expected);
    expect(last?.final.flat().every(Boolean)).toBe(true);
    expect(trace.c).toEqual(expected);
  });
});

describe('systolic-4x4.html', () => {
  it('embeds the trace the schedule regenerates (run gen-viz after changing it)', () => {
    const html = readFileSync(SYSTOLIC_PAGE_PATH, 'utf8');
    expect(extractTrace(html)).toEqual(JSON.parse(JSON.stringify(systolicPageTrace())));
  });
});
