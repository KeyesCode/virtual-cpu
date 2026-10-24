import { describe, expect, it } from 'vitest';
import { INT32_MIN } from './matmul.js';
import { PE_RESET_STATE, type PeInputs, type PeState, stepPe } from './pe.js';

const IDLE: PeInputs = { rst: false, clear: false, a: 0, aValid: false, b: 0, bValid: false };
const mac = (a: number, b: number): PeInputs => ({ ...IDLE, a, aValid: true, b, bValid: true });

function run(inputs: readonly PeInputs[], from: PeState = PE_RESET_STATE): PeState[] {
  const states: PeState[] = [];
  let state = from;
  for (const clock of inputs) {
    state = stepPe(state, clock);
    states.push(state);
  }
  return states;
}

describe('stepPe', () => {
  it('accumulates signed products, −128 × −128 = +16384 and 127 × −128 = −16256 included', () => {
    const states = run([mac(-128, -128), mac(127, -128), mac(-3, 5), mac(0, 127)]);
    expect(states.map((s) => s.acc)).toEqual([16384, 128, 113, 113]);
  });

  it('gives clear priority over a MAC in the same clock, and rst over both', () => {
    const [, cleared, after, reset] = run([
      mac(10, 10),
      { ...mac(99, 99), clear: true },
      mac(2, 3),
      { ...mac(4, 4), rst: true },
    ]);
    expect(cleared?.acc).toBe(0);
    expect(after?.acc).toBe(6);
    expect(reset).toEqual({ acc: 0, aOut: 4, aValidOut: false, bOut: 4, bValidOut: false });
  });

  it('holds acc unless both operands are valid', () => {
    const states = run([
      mac(5, 5),
      { ...IDLE, a: 7, aValid: true, b: 7 },
      { ...IDLE, a: 7, b: 7, bValid: true },
      { ...IDLE, a: -128, b: -128 },
    ]);
    expect(states.map((s) => s.acc)).toEqual([25, 25, 25, 25]);
  });

  it('forwards operands and valid bits one clock later, valid or not', () => {
    const states = run([mac(1, -1), { ...IDLE, a: 42, b: -42, bValid: true }]);
    expect(states[0]).toMatchObject({ aOut: 1, aValidOut: true, bOut: -1, bValidOut: true });
    expect(states[1]).toMatchObject({ aOut: 42, aValidOut: false, bOut: -42, bValidOut: true });
  });

  it('wraps the accumulator in two’s complement', () => {
    const [state] = run([mac(-128, -128)], { ...PE_RESET_STATE, acc: 2 ** 31 - 16384 });
    expect(state?.acc).toBe(INT32_MIN);
  });

  it('rejects an operand outside INT8', () => {
    expect(() => stepPe(PE_RESET_STATE, mac(128, 0))).toThrow('a must be a signed INT8');
    expect(() => stepPe(PE_RESET_STATE, mac(0, -129))).toThrow('b must be a signed INT8');
  });
});
