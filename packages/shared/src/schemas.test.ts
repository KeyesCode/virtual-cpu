import { describe, expect, it } from 'vitest';
import { ProgramImageSchema, U8Schema } from './schemas.js';

describe('U8Schema', () => {
  it('accepts 0..255 integers only', () => {
    expect(U8Schema.safeParse(0).success).toBe(true);
    expect(U8Schema.safeParse(255).success).toBe(true);
    for (const value of [-1, 256, 1.5, '1', Number.NaN]) {
      expect(U8Schema.safeParse(value).success).toBe(false);
    }
  });
});

describe('ProgramImageSchema', () => {
  it('accepts an image with or without an origin', () => {
    expect(ProgramImageSchema.parse({ bytes: [0x11, 0x00, 0x0a, 0x01] })).toEqual({
      bytes: [0x11, 0x00, 0x0a, 0x01],
    });
    expect(ProgramImageSchema.parse({ origin: 0x80, bytes: [1, 2] })).toEqual({
      origin: 0x80,
      bytes: [1, 2],
    });
  });

  it('accepts an image that exactly fills memory', () => {
    expect(ProgramImageSchema.safeParse({ bytes: Array<number>(256).fill(0) }).success).toBe(true);
    expect(ProgramImageSchema.safeParse({ origin: 0xff, bytes: [0x01] }).success).toBe(true);
  });

  it('rejects non-byte values, a bad origin, and images that run past 0xFF', () => {
    expect(ProgramImageSchema.safeParse({ bytes: [256] }).success).toBe(false);
    expect(ProgramImageSchema.safeParse({ bytes: [-1] }).success).toBe(false);
    expect(ProgramImageSchema.safeParse({ origin: 256, bytes: [] }).success).toBe(false);
    expect(ProgramImageSchema.safeParse({ origin: 0xff, bytes: [0, 0] }).success).toBe(false);
    expect(ProgramImageSchema.safeParse({ bytes: Array<number>(257).fill(0) }).success).toBe(false);
  });
});
