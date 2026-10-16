import { describe, expect, it } from 'vitest';
import { createDebugSession } from '../index.js';
import { ARRAY_MAX, FIBONACCI, lineOf, sessionFor, STACK } from './fixtures.js';

describe('inspection', () => {
  it('shows the stack as SP, depth and the live slots, top first', () => {
    const session = sessionFor(STACK);
    expect(session.getStackView()).toEqual({ sp: 0xff, depth: 0, slots: [] });

    for (let i = 0; i < 4; i += 1) session.step(); // LDI, LDI, PUSH R0, PUSH R1

    expect(session.getStackView()).toEqual({
      sp: 0xfd,
      depth: 2,
      slots: [
        { address: 0xfe, value: 4 },
        { address: 0xff, value: 3 },
      ],
    });
  });

  it('describes the instruction at PC with its source line', () => {
    const session = sessionFor(FIBONACCI);
    const current = session.getCurrentInstruction();

    expect(current).toMatchObject({
      address: 0,
      bytes: [0x11, 0x00, 0x00],
      text: 'LDI R0, 0',
      fault: null,
      source: { line: lineOf(FIBONACCI, 'LDI R0, 0'), text: 'LDI R0, 0' },
    });
    expect(current.instruction?.id).toBe('LDI');
  });

  it('describes bytes at PC that do not decode', () => {
    const session = createDebugSession({ program: [0xff] });
    expect(session.getCurrentInstruction()).toMatchObject({
      address: 0,
      bytes: [0xff],
      instruction: null,
      text: '.byte 0xFF',
      fault: { code: 'INVALID_OPCODE', pc: 0 },
      source: null,
    });
  });

  it('reads registers, flags and memory', () => {
    const session = sessionFor(ARRAY_MAX);
    expect(session.getFlags()).toEqual({ Z: false, C: false, N: false, V: false });
    session.run();

    expect(session.getRegisters()[0]).toBe(255);
    // SHL 0x80 → 0x00 with carry out; SUB 0 − 0 → 0.
    expect(session.getFlags()).toEqual({ Z: true, C: false, N: false, V: false });
    expect(session.readMemory(0xa0, 1)).toEqual([255]);
    expect(session.readMemory()).toHaveLength(256);
    expect(session.readMemory(0xf0)).toHaveLength(16);
    expect(() => session.readMemory(0xff, 2)).toThrow(RangeError);
    expect(() => session.readMemory(-1, 1)).toThrow(RangeError);
  });

  it('serves the trace, a timeline and the instruction count', () => {
    const session = sessionFor(FIBONACCI);
    session.run();
    const trace = session.getExecutionTrace();

    expect(session.getInstructionCount()).toBe(trace.length);
    expect(session.getMetrics().instructions).toBe(trace.length);
    expect(session.getTimeline()).toEqual(trace);
    expect(session.getTimeline(2).map((entry) => entry.instruction?.mnemonic)).toEqual([
      'JNZ',
      'HLT',
    ]);
    expect(session.getTimeline(0)).toEqual([]);
    expect(() => session.getTimeline(-1)).toThrow(RangeError);
  });

  it('keeps traceCapacity entries in the timeline', () => {
    const session = sessionFor(FIBONACCI, { traceCapacity: 4 });
    session.run();
    expect(session.getTimeline()).toHaveLength(4);
    expect(session.stepBack().ok).toBe(true);
    expect(session.getTimeline()).toHaveLength(3);
  });
});
