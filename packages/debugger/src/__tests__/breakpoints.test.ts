import { describe, expect, it } from 'vitest';
import { BreakpointError, createDebugSession } from '../index.js';
import { addressOf, ARRAY_MAX, FIBONACCI, lineOf, sessionFor } from './fixtures.js';

describe('breakpoints', () => {
  it('stops before JNZ loop in fibonacci, with the JNZ not yet executed', () => {
    const session = sessionFor(FIBONACCI);
    const jnz = addressOf(FIBONACCI, 'JNZ loop');
    session.addBreakpoint({ line: lineOf(FIBONACCI, 'JNZ loop') });

    const stop = session.run();

    expect(stop.stopReason).toBe('breakpoint');
    expect(stop).toMatchObject({ address: jnz, pc: jnz });
    const state = session.getState();
    expect(state.pc).toBe(jnz);
    // The DEC before it ran (R3 went 8 → 7); the JNZ itself did not.
    expect(state.registers[3]).toBe(7);
    expect(state.ir?.mnemonic).toBe('DEC');
    expect(session.getTimeline(1)[0]?.instruction?.mnemonic).toBe('DEC');
  });

  it('does not re-trigger when resuming from the breakpoint, and hits again next time round', () => {
    const session = sessionFor(FIBONACCI);
    const jnz = addressOf(FIBONACCI, 'JNZ loop');
    session.addBreakpoint({ address: jnz });

    expect(session.run().stopReason).toBe('breakpoint');
    const second = session.run();

    expect(second.stopReason).toBe('breakpoint');
    expect(second.executed).toBeGreaterThan(1);
    expect(session.getState().registers[3]).toBe(6);
  });

  it('stops on a breakpoint at the very first instruction', () => {
    const session = sessionFor(FIBONACCI);
    session.addBreakpoint({ address: 0 });

    const stop = session.run();

    expect(stop).toMatchObject({ stopReason: 'breakpoint', executed: 0, pc: 0 });
    expect(session.getInstructionCount()).toBe(0);
  });

  it('lets step() execute the instruction under a breakpoint', () => {
    const session = sessionFor(FIBONACCI);
    session.addBreakpoint({ address: 0 });

    expect(session.step()).toMatchObject({ stopReason: 'step', executed: 1 });
    expect(session.getState().pc).toBe(3);
  });

  it('re-arms the breakpoint after any other movement', () => {
    const session = sessionFor(FIBONACCI);
    const jnz = addressOf(FIBONACCI, 'JNZ loop');
    session.addBreakpoint({ address: jnz });
    session.run();

    // Step back over the DEC and forward again: PC is back on the breakpoint but the session did
    // not just stop there, so the run stops at once.
    session.stepBack();
    session.step();
    expect(session.run()).toMatchObject({ stopReason: 'breakpoint', executed: 0, pc: jnz });
  });

  it('skips disabled breakpoints and honours removal', () => {
    const session = sessionFor(FIBONACCI);
    const breakpoint = session.addBreakpoint({ address: addressOf(FIBONACCI, 'JNZ loop') });

    expect(session.toggleBreakpoint(breakpoint.id).enabled).toBe(false);
    expect(session.run().stopReason).toBe('halted');

    session.reset();
    expect(session.toggleBreakpoint(breakpoint.id, true).enabled).toBe(true);
    expect(session.run().stopReason).toBe('breakpoint');

    session.reset();
    expect(session.removeBreakpoint(breakpoint.id)).toBe(true);
    expect(session.removeBreakpoint(breakpoint.id)).toBe(false);
    expect(session.run().stopReason).toBe('halted');
  });

  it('lists breakpoints in address order and dedupes by address', () => {
    const session = sessionFor(FIBONACCI);
    const late = session.addBreakpoint({ address: addressOf(FIBONACCI, 'HLT') });
    const early = session.addBreakpoint({ line: lineOf(FIBONACCI, 'LDI R1, 1') });

    expect(session.addBreakpoint({ address: early.address })).toBe(early);
    expect(session.listBreakpoints()).toEqual([early, late]);
    expect(early).toMatchObject({ address: 3, line: lineOf(FIBONACCI, 'LDI R1, 1') });
    expect(late.line).toBe(lineOf(FIBONACCI, 'HLT'));
  });

  it('rejects lines without code, lines without a source map and bad addresses', () => {
    const session = sessionFor(FIBONACCI);
    expect(() => session.addBreakpoint({ line: 1 })).toThrow(BreakpointError);
    expect(() => session.addBreakpoint({ line: lineOf(FIBONACCI, '.equ') })).toThrow(
      /Line 2 has no instruction/,
    );
    expect(() => session.addBreakpoint({ address: 256 })).toThrow(BreakpointError);
    expect(() => session.toggleBreakpoint(99)).toThrow(/no breakpoint 99/);

    const bare = createDebugSession({ program: [0x01] });
    expect(() => bare.addBreakpoint({ line: 1 })).toThrow(/need a source map/);
    expect(bare.addBreakpoint({ address: 0 })).toMatchObject({ line: null, warning: null });
  });

  it('warns about a breakpoint on data, inside an instruction or outside the code, which never hits', () => {
    const session = sessionFor(ARRAY_MAX);
    const table = addressOf(ARRAY_MAX, '.byte 7, 200, 3, 255, 9');

    const onData = session.addBreakpoint({ address: table + 1 });
    const inside = session.addBreakpoint({ address: 1 });
    const outside = session.addBreakpoint({ address: 0xf0 });

    expect(onData.warning).toMatch(/is data \(`.byte 7, 200, 3, 255, 9`/);
    expect(inside.warning).toMatch(/inside `LDI R1, table`/);
    expect(outside.warning).toMatch(/0xF0 is outside the assembled code/);
    expect(session.run().stopReason).toBe('halted');
  });
});
