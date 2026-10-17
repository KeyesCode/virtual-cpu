import { describe, expect, it } from 'vitest';
import { divVectors, formatDivVector, renderDivVectors } from './div-vectors.js';

const vectors = [...divVectors()];
const { hex, count } = renderDivVectors();

describe('divider vectors', () => {
  it('cover every (a, b ≠ 0) pair once: 256 × 255 = 65,280 records', () => {
    expect(count).toBe(65_280);
    expect(vectors).toHaveLength(count);
    expect(vectors.some((v) => v.b === 0)).toBe(false);
    expect(new Set(vectors.map((v) => v.a * 256 + v.b)).size).toBe(count);
  });

  it('render one 6-digit record per line, deterministically', () => {
    const lines = hex.split('\n');
    expect(lines.pop()).toBe('');
    expect(lines).toHaveLength(count);
    expect(lines.every((line) => /^[0-9A-F]{6}$/.test(line))).toBe(true);
    expect(renderDivVectors().hex).toBe(hex);
  });

  // The edge cases of the ticket: 0 / x = 0, 0xFF / 1 = 0xFF, x / x = 1.
  it.each([
    [0x00, 0x07, 0x00, '000700'],
    [0xff, 0x01, 0xff, 'FF01FF'],
    [0x2a, 0x2a, 0x01, '2A2A01'],
    [0xff, 0x10, 0x0f, 'FF100F'],
    [0x01, 0xff, 0x00, '01FF00'],
  ] as const)('a=%i b=%i gives q=%i, packed %s', (a, b, q, packed) => {
    const vector = vectors.find((v) => v.a === a && v.b === b);
    expect(vector).toEqual({ a, b, q });
    expect(vector === undefined ? '' : formatDivVector(vector)).toBe(packed);
  });
});
