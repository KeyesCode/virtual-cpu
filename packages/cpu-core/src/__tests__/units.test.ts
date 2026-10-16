import { MEMORY_SIZE } from '@vcpu/shared';
import { describe, expect, it } from 'vitest';
import { byteAt, Memory } from '../memory.js';
import { createRegisterFile, resetRegisterFile } from '../registers.js';
import { DEFAULT_TRACE_CAPACITY, TraceBuffer, type TraceEntry } from '../trace.js';

describe('Memory', () => {
  it('starts zeroed and reads back what was written', () => {
    const memory = new Memory();
    expect(memory.toArray()).toEqual(new Array<number>(MEMORY_SIZE).fill(0));
    memory.write(0xff, 0xab);
    memory.write(0x00, 0x01);
    expect([memory.read(0x00), memory.read(0xff)]).toEqual([0x01, 0xab]);
    expect(memory.view()[0xff]).toBe(0xab);
  });

  it('validates addresses and values as unsigned bytes', () => {
    const memory = new Memory();
    for (const bad of [-1, 256, 1.5, Number.NaN]) {
      expect(() => memory.read(bad)).toThrow(RangeError);
      expect(() => {
        memory.write(bad, 0);
      }).toThrow(RangeError);
      expect(() => {
        memory.write(0, bad);
      }).toThrow(RangeError);
    }
  });

  it('restores a full 256-byte image and rejects anything else', () => {
    const memory = new Memory();
    const image = new Uint8Array(MEMORY_SIZE).map((_, i) => i);
    memory.restore(image);
    expect(memory.toArray()).toEqual(Array.from(image));
    expect(() => {
      memory.restore(new Uint8Array(255));
    }).toThrow(RangeError);
  });

  it('toArray returns a copy', () => {
    const memory = new Memory();
    const copy = memory.toArray();
    copy[0] = 9;
    expect(memory.read(0)).toBe(0);
  });

  it('byteAt rejects an address past the end of a short array', () => {
    expect(byteAt([1, 2], 1)).toBe(2);
    expect(() => byteAt([1, 2], 2)).toThrow(/outside the 2-byte memory/);
  });
});

describe('register file', () => {
  it('resets to the documented values', () => {
    const file = createRegisterFile();
    file.r.fill(9);
    file.pc = 5;
    file.sp = 0x80;
    file.sd = 3;
    file.flags = 0x0f;
    resetRegisterFile(file);
    expect({ ...file, r: Array.from(file.r) }).toEqual({
      r: [0, 0, 0, 0, 0, 0, 0, 0],
      pc: 0,
      sp: 0xff,
      sd: 0,
      flags: 0,
    });
  });
});

describe('TraceBuffer', () => {
  const entry = (sequence: number): TraceEntry => ({ sequence }) as TraceEntry;

  it('defaults to 1024 entries', () => {
    expect(new TraceBuffer().capacity).toBe(DEFAULT_TRACE_CAPACITY);
    expect(DEFAULT_TRACE_CAPACITY).toBe(1024);
  });

  it('keeps the newest entries, oldest first, once it wraps', () => {
    const buffer = new TraceBuffer(3);
    for (let i = 0; i < 7; i += 1) {
      buffer.push(entry(i));
    }
    expect(buffer.size).toBe(3);
    expect(buffer.toArray().map((e) => e.sequence)).toEqual([4, 5, 6]);
    buffer.clear();
    expect(buffer.toArray()).toEqual([]);
    buffer.push(entry(9));
    expect(buffer.toArray().map((e) => e.sequence)).toEqual([9]);
  });

  it('is disabled at capacity 0', () => {
    const buffer = new TraceBuffer(0);
    buffer.push(entry(1));
    expect(buffer.enabled).toBe(false);
    expect(buffer.toArray()).toEqual([]);
  });

  it('rejects a negative or fractional capacity', () => {
    expect(() => new TraceBuffer(-1)).toThrow(RangeError);
    expect(() => new TraceBuffer(1.5)).toThrow(RangeError);
  });
});
