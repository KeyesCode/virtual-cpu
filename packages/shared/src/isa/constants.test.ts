import { describe, expect, it } from 'vitest';
import {
  CPU_STATUS_NUMBERS,
  FAULT_CODE_NUMBERS,
  FLAG_BITS,
  FLAG_MASKS,
  FLAGS_USED_MASK,
  MEMORY_MAP,
  MEMORY_SIZE,
  NO_FAULT_NUMBER,
  RESET_SP,
  STACK_CAPACITY,
} from './constants.js';
import { packFlags, unpackFlags } from './flags.js';
import { CpuStatus, FaultCode, FLAG_NAMES } from './types.js';

describe('memory map', () => {
  it('tiles 0x00..0xFF with no gaps or overlaps', () => {
    const regions = [MEMORY_MAP.program, MEMORY_MAP.data, MEMORY_MAP.stack];
    let next = 0;
    for (const region of regions) {
      expect(region.start).toBe(next);
      expect(region.size).toBe(region.end - region.start + 1);
      next = region.end + 1;
    }
    expect(next).toBe(MEMORY_SIZE);
  });

  it('sizes the stack region to the stack capacity, ending at the reset SP', () => {
    expect(MEMORY_MAP.stack.size).toBe(STACK_CAPACITY);
    expect(MEMORY_MAP.stack.end).toBe(RESET_SP);
  });
});

describe('FLAGS layout', () => {
  it('places Z, C, N, V at bits 3..0', () => {
    expect(FLAG_BITS).toEqual({ Z: 3, C: 2, N: 1, V: 0 });
    for (const name of FLAG_NAMES) {
      expect(FLAG_MASKS[name]).toBe(1 << FLAG_BITS[name]);
    }
    expect(FLAG_NAMES.reduce((mask, name) => mask | FLAG_MASKS[name], 0)).toBe(FLAGS_USED_MASK);
  });

  it('packs and unpacks all 16 FLAGS values', () => {
    for (let byte = 0; byte <= FLAGS_USED_MASK; byte += 1) {
      expect(packFlags(unpackFlags(byte))).toBe(byte);
    }
    expect(unpackFlags(0b1010)).toEqual({ Z: true, C: false, N: true, V: false });
  });

  it('rejects FLAGS bytes with bits 7..4 set', () => {
    for (let byte = FLAGS_USED_MASK + 1; byte <= 0xff; byte += 1) {
      expect(() => unpackFlags(byte)).toThrow(RangeError);
    }
  });
});

describe('numeric encodings', () => {
  it('numbers every fault code 1..7 uniquely, leaving 0 for no fault', () => {
    const numbers = Object.values(FaultCode).map((code) => FAULT_CODE_NUMBERS[code]);
    expect(numbers.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(NO_FAULT_NUMBER).toBe(0);
  });

  it('numbers every status uniquely', () => {
    const numbers = Object.values(CpuStatus).map((status) => CPU_STATUS_NUMBERS[status]);
    expect(numbers.sort()).toEqual([0, 1, 2, 3, 4]);
  });
});
