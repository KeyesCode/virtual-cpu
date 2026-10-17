import { readFileSync } from 'node:fs';
import { FixtureSchemaV1, type FixtureV1, parseTraceJsonl } from '@vcpu/shared';
import { describe, expect, it } from 'vitest';
import {
  compareEndState,
  compareTrace,
  formatFailureReport,
  parseRtlState,
  parseRtlTraceJsonl,
  RTL_STATE_FORMAT,
  type RtlState,
  type RtlTraceStep,
} from './compare.js';

const FIXTURES = new URL('../../../../fixtures/v1/', import.meta.url);

function load(name: string): { fixture: FixtureV1; trace: RtlTraceStep[]; state: RtlState } {
  const fixture = FixtureSchemaV1.parse(
    JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8')),
  );
  const trace = parseTraceJsonl(readFileSync(new URL(`${name}.trace.jsonl`, FIXTURES), 'utf8'));
  // What a correct RTL run reports: the emulator's own results, plus clock counts.
  const rtlTrace = trace.map((step, i) => ({ ...step, cycle: 5 * (i + 1) }));
  const { expected } = fixture;
  const state: RtlState = {
    format: RTL_STATE_FORMAT,
    status: expected.status,
    fault: expected.fault,
    instructions: expected.instructions,
    steps: trace.length,
    cycles: 5 * trace.length,
    registers: [...expected.registers],
    pc: expected.pc,
    sp: expected.sp,
    sd: expected.sd,
    flags: expected.flags,
    memory: [...expected.memory],
    stopReason: expected.status === 'HALTED' ? 'halted' : 'faulted',
  };
  return { fixture, trace: rtlTrace, state };
}

describe('compareEndState', () => {
  it('passes an identical end state', () => {
    const { fixture, state } = load('op-call-ret');
    expect(compareEndState(fixture.expected, state)).toEqual([]);
  });

  it('names a changed register, flag and memory byte', () => {
    const { fixture, state } = load('op-call-ret');
    const registers = [...state.registers];
    registers[3] = (registers[3] ?? 0) ^ 0x10;
    const memory = [...state.memory];
    memory[0xfe] = (memory[0xfe] ?? 0) ^ 0x01;
    const mismatches = compareEndState(fixture.expected, {
      ...state,
      registers,
      flags: state.flags ^ 0b1000,
      memory,
    });
    expect(mismatches.map((m) => m.field)).toEqual(['registers[3]', 'flags', 'memory[0xFE]']);
    expect(mismatches[0]).toMatchObject({
      scope: 'end-state',
      expected: fixture.expected.registers[3],
      actual: registers[3],
    });
  });

  it('names a changed fault number', () => {
    const { fixture, state } = load('fault-divide-by-zero');
    expect(state.fault).not.toBeNull();
    const fault = { code: 'STACK_OVERFLOW' as const, number: 6, pc: state.fault?.pc ?? 0 };
    const mismatches = compareEndState(fixture.expected, { ...state, fault });
    expect(mismatches.map((m) => m.field)).toEqual(['fault.code', 'fault.number']);
    expect(mismatches[1]).toMatchObject({ expected: 5, actual: 6 });
  });

  it('fails a run that hit its step limit', () => {
    const { fixture, state } = load('op-add');
    const mismatches = compareEndState(fixture.expected, {
      ...state,
      status: 'READY',
      stopReason: 'max_steps',
    });
    expect(mismatches.slice(0, 2)).toMatchObject([
      { field: 'stopReason', expected: 'halted', actual: 'max_steps' },
      { field: 'status', expected: 'HALTED', actual: 'READY' },
    ]);
  });
});

describe('compareTrace', () => {
  it('passes identical traces and ignores IR', () => {
    const { trace } = load('op-call-ret');
    const otherIr = trace.map((step) => ({ ...step, ir: [0] }));
    expect(compareTrace(trace, otherIr)).toEqual([]);
  });

  it('names the step and field of a changed memWrite', () => {
    const { trace } = load('op-call-ret');
    const index = trace.findIndex((step) => step.memWrites.length > 0);
    expect(index).toBeGreaterThanOrEqual(0);
    const actual = trace.map((step, i) =>
      i === index
        ? {
            ...step,
            memWrites: step.memWrites.map((w, k) => (k === 0 ? { ...w, value: w.value ^ 1 } : w)),
          }
        : step,
    );
    expect(compareTrace(trace, actual)).toEqual([
      {
        scope: 'trace',
        step: index,
        field: 'memWrites[0].value',
        expected: trace[index]?.memWrites[0]?.value,
        actual: (trace[index]?.memWrites[0]?.value ?? 0) ^ 1,
      },
    ]);
  });

  it('reports only the first diverging step', () => {
    const { trace } = load('op-call-ret');
    const actual = trace.map((step) => ({ ...step, sp: step.sp ^ 0x80 }));
    const mismatches = compareTrace(trace, actual);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ step: 0, field: 'sp' });
  });

  it('names a missing write and a changed fault on a precise-fault line', () => {
    const { trace } = load('fault-divide-by-zero');
    const last = trace.length - 1;
    const actual = trace.map((step, i) =>
      i === last
        ? { ...step, fault: 'STACK_OVERFLOW' as const, memWrites: [{ address: 1, value: 2 }] }
        : step,
    );
    expect(compareTrace(trace, actual).map((m) => [m.step, m.field])).toEqual([
      [last, 'fault'],
      [last, 'memWrites'],
    ]);
  });

  it('names a missing step', () => {
    const { trace } = load('op-add');
    expect(compareTrace(trace, trace.slice(0, -1))).toMatchObject([
      { step: trace.length - 1, field: 'step' },
    ]);
  });
});

describe('formatFailureReport', () => {
  it('names the fixture, step, PC, opcode, field and both values', () => {
    const { fixture, trace, state } = load('op-call-ret');
    const index = trace.findIndex((step) => step.memWrites.length > 0);
    const step = trace[index];
    const write = step?.memWrites[0];
    if (step === undefined || write === undefined) {
      throw new Error('op-call-ret has no memory write');
    }
    const actual = trace.map((s, i) =>
      i === index ? { ...s, memWrites: [{ ...write, value: write.value ^ 1 }] } : s,
    );
    const report = formatFailureReport('op-call-ret', compareTrace(trace, actual), {
      expectedTrace: trace,
      actualTrace: actual,
      expected: fixture.expected,
      actual: state,
    });
    const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
    expect(report).toContain(`FAIL op-call-ret: lock-step trace, step ${String(index)}`);
    expect(report).toContain(`PC 0x${hex(step.pc)}, opcode 0x${hex(step.ir[0] ?? 0)}`);
    expect(report).toMatch(
      new RegExp(`memWrites\\[0\\]\\.value\\s+0x${hex(write.value)} .*→ 0x${hex(write.value ^ 1)}`),
    );
    expect(report).toContain(`memory near 0x${hex(write.address)}`);
    expect(report).toContain('recent RTL steps');
  });
});

describe('parsers', () => {
  it('round-trip the runner formats', () => {
    const { trace, state } = load('op-call-ret');
    expect(parseRtlState(JSON.stringify(state))).toEqual(state);
    const jsonl = trace.map((step) => `${JSON.stringify(step)}\n`).join('');
    expect(parseRtlTraceJsonl(jsonl)).toEqual(trace);
  });

  it('rejects a trace line without its clock count', () => {
    const { trace } = load('op-add');
    const line: Partial<RtlTraceStep> = { ...trace[0] };
    delete line.cycle;
    expect(() => parseRtlTraceJsonl(`${JSON.stringify(line)}\n`)).toThrow();
  });
});
