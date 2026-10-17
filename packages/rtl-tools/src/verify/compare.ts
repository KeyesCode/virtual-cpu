import {
  CpuStatus,
  type FixtureExpectedState,
  FixtureFaultSchema,
  type FixtureTraceStep,
  FixtureTraceStepSchema,
  FlagsByteSchema,
  MemoryImageSchema,
  opcodeByByte,
  REGISTER_COUNT,
  StackDepthSchema,
  U8Schema,
} from '@vcpu/shared';
import { z } from 'zod';

/**
 * Compares what the RTL runner (`build/sim/vcpu8_sim`) reports with what the emulator produced:
 * the end state against a fixture's `expected`, and the per-step trace against its
 * `.trace.jsonl`, in lock-step. Pure functions over parsed data, so the fixture check and the
 * differential verification share them.
 */

/** The runner's `--state` output. */
export const RTL_STATE_FORMAT = 'vcpu8-rtl-state/1';

/** Why the runner stopped. Only `halted` and `faulted` are ends the emulator can reach. */
export const RtlStopReasonSchema = z.enum(['halted', 'faulted', 'max_steps', 'max_cycles']);
export type RtlStopReason = z.output<typeof RtlStopReasonSchema>;

/** The RTL's architectural state when the runner stopped, plus its step and clock counts. */
export const RtlStateSchema = z.strictObject({
  format: z.literal(RTL_STATE_FORMAT),
  status: z.enum([CpuStatus.READY, CpuStatus.HALTED, CpuStatus.FAULTED]),
  fault: FixtureFaultSchema.nullable(),
  /** Retired instructions (`instret`). */
  instructions: z.number().int().min(0),
  /** Retirements plus a final precise fault. */
  steps: z.number().int().min(0),
  /** Clock cycles from reset release to the stop. */
  cycles: z.number().int().min(0),
  registers: z.array(U8Schema).length(REGISTER_COUNT),
  pc: U8Schema,
  sp: U8Schema,
  sd: StackDepthSchema,
  flags: FlagsByteSchema,
  memory: MemoryImageSchema,
  stopReason: RtlStopReasonSchema,
});
export type RtlState = z.output<typeof RtlStateSchema>;

/** One line of the runner's `--trace` output: a fixture trace line plus the clock count. */
export const RtlTraceStepSchema = FixtureTraceStepSchema.extend({
  /** Clock cycles from reset release to the end of this step. */
  cycle: z.number().int().min(0),
});
export type RtlTraceStep = z.output<typeof RtlTraceStepSchema>;

export function parseRtlState(text: string): RtlState {
  return RtlStateSchema.parse(JSON.parse(text));
}

export function parseRtlTraceJsonl(text: string): RtlTraceStep[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => RtlTraceStepSchema.parse(JSON.parse(line)));
}

export type MismatchValue = number | string | null;

/** One field that differs. `step` is the trace step, or null for the end state. */
export interface Mismatch {
  readonly scope: 'end-state' | 'trace';
  readonly step: number | null;
  /** The field's path, e.g. `registers[1]`, `memory[0x80]`, `fault.number`, `memWrites[0].value`. */
  readonly field: string;
  readonly expected: MismatchValue;
  readonly actual: MismatchValue;
}

function hex2(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function describeFault(fault: { code: string; pc: number } | null): string | null {
  return fault === null ? null : `${fault.code} at 0x${hex2(fault.pc)}`;
}

function describeWrites(writes: FixtureTraceStep['memWrites']): string {
  return `[${writes.map((w) => `0x${hex2(w.address)}←0x${hex2(w.value)}`).join(', ')}]`;
}

class Collector {
  readonly mismatches: Mismatch[] = [];

  constructor(
    private readonly scope: Mismatch['scope'],
    private readonly step: number | null,
  ) {}

  check(field: string, expected: MismatchValue, actual: MismatchValue): void {
    if (expected !== actual) {
      this.mismatches.push({ scope: this.scope, step: this.step, field, expected, actual });
    }
  }

  bytes(field: string, expected: readonly number[], actual: readonly number[], hexIndex = false) {
    expected.forEach((value, i) => {
      this.check(`${field}[${hexIndex ? `0x${hex2(i)}` : String(i)}]`, value, actual[i] ?? null);
    });
  }
}

/**
 * Every end-state field of a fixture: the stop, status, fault, retired instructions, R0–R7, PC,
 * SP, SD, FLAGS and all 256 memory bytes. A run that hit a step or cycle limit is a mismatch,
 * because every fixture halts or faults within its `maxInstructions`.
 */
export function compareEndState(expected: FixtureExpectedState, actual: RtlState): Mismatch[] {
  const c = new Collector('end-state', null);
  if (actual.stopReason === 'max_steps' || actual.stopReason === 'max_cycles') {
    c.check(
      'stopReason',
      expected.status === CpuStatus.HALTED ? 'halted' : 'faulted',
      actual.stopReason,
    );
  }
  c.check('status', expected.status, actual.status);
  if (expected.fault === null || actual.fault === null) {
    c.check('fault', describeFault(expected.fault), describeFault(actual.fault));
  } else {
    c.check('fault.code', expected.fault.code, actual.fault.code);
    c.check('fault.number', expected.fault.number, actual.fault.number);
    c.check('fault.pc', expected.fault.pc, actual.fault.pc);
  }
  c.check('instructions', expected.instructions, actual.instructions);
  c.bytes('registers', expected.registers, actual.registers);
  c.check('pc', expected.pc, actual.pc);
  c.check('sp', expected.sp, actual.sp);
  c.check('sd', expected.sd, actual.sd);
  c.check('flags', expected.flags, actual.flags);
  c.bytes('memory', expected.memory, actual.memory, true);
  return c.mismatches;
}

/**
 * One trace line against the emulator's: every field except `ir`. IR is not architectural, and a
 * design that fetches differently may legitimately show other bytes (docs/hardware-porting.md).
 *
 * A precise-fault line needs no rule of its own. The emulator writes the state from before the
 * step into it (registers, FLAGS, SP, SD, `nextPc` equal to `pc`, no memory writes), so an RTL
 * line that matches it field by field proves the fault wrote nothing and held PC. That it did not
 * retire is checked by the end state's `instructions`.
 */
export function compareStep(expected: FixtureTraceStep, actual: FixtureTraceStep): Mismatch[] {
  const c = new Collector('trace', expected.step);
  c.check('step', expected.step, actual.step);
  c.check('pc', expected.pc, actual.pc);
  c.check('status', expected.status, actual.status);
  c.check('fault', expected.fault, actual.fault);
  c.bytes('regs', expected.regs, actual.regs);
  c.check('flags', expected.flags, actual.flags);
  c.check('sp', expected.sp, actual.sp);
  c.check('sd', expected.sd, actual.sd);
  c.check('nextPc', expected.nextPc, actual.nextPc);
  if (expected.memWrites.length !== actual.memWrites.length) {
    c.check('memWrites', describeWrites(expected.memWrites), describeWrites(actual.memWrites));
  } else {
    expected.memWrites.forEach((write, i) => {
      const other = actual.memWrites[i];
      c.check(`memWrites[${String(i)}].address`, write.address, other?.address ?? null);
      c.check(`memWrites[${String(i)}].value`, write.value, other?.value ?? null);
    });
  }
  return c.mismatches;
}

/**
 * Lock-step comparison: the mismatches of the first step that differs, or a missing or extra
 * step; empty when the traces agree line for line.
 */
export function compareTrace(
  expected: readonly FixtureTraceStep[],
  actual: readonly FixtureTraceStep[],
): Mismatch[] {
  const steps = Math.max(expected.length, actual.length);
  for (let i = 0; i < steps; i += 1) {
    const want = expected[i];
    const got = actual[i];
    if (want === undefined || got === undefined) {
      return [
        {
          scope: 'trace',
          step: i,
          field: 'step',
          expected:
            want === undefined
              ? `none (the emulator stopped after ${String(i)} steps)`
              : `step ${String(i)}`,
          actual:
            got === undefined
              ? `none (the RTL stopped after ${String(i)} steps)`
              : `step ${String(i)}`,
        },
      ];
    }
    const mismatches = compareStep(want, got);
    if (mismatches.length > 0) {
      return mismatches;
    }
  }
  return [];
}

/** What a failure report shows besides the mismatches themselves. */
export interface FailureContext {
  readonly expectedTrace: readonly FixtureTraceStep[];
  readonly actualTrace: readonly FixtureTraceStep[];
  readonly expected: FixtureExpectedState;
  readonly actual: RtlState;
  /** RTL steps listed before the failing one (default 5). */
  readonly history?: number;
}

function opcodeName(byte: number | undefined): string {
  if (byte === undefined) {
    return '?';
  }
  return `0x${hex2(byte)} ${opcodeByByte[byte]?.id ?? '(invalid)'}`;
}

function formatValue(value: MismatchValue): string {
  if (typeof value === 'number') {
    return `0x${hex2(value)} (${String(value)})`;
  }
  return value === null ? 'null' : value;
}

function formatRegisters(regs: readonly number[]): string {
  return regs.map((value, i) => `R${String(i)}=${hex2(value)}`).join(' ');
}

function formatMemoryRow(memory: readonly number[], row: number): string {
  const bytes = memory.slice(row * 16, row * 16 + 16).map(hex2);
  return `0x${hex2(row * 16)}: ${bytes.join(' ')}`;
}

function formatStep(step: FixtureTraceStep): string {
  const bytes = step.ir.map(hex2).join(' ');
  return [
    `step ${String(step.step).padStart(4)}`,
    `pc 0x${hex2(step.pc)}`,
    (opcodeByByte[step.ir[0] ?? 0]?.id ?? '(invalid)').padEnd(9),
    `[${bytes}]`.padEnd(10),
    formatRegisters(step.regs),
    `FLAGS=${hex2(step.flags)} SP=${hex2(step.sp)} SD=${String(step.sd)}`,
    `next=0x${hex2(step.nextPc)}`,
    step.status,
    ...(step.fault === null ? [] : [step.fault]),
    ...(step.memWrites.length === 0 ? [] : [`writes ${describeWrites(step.memWrites)}`]),
  ].join('  ');
}

/** The memory address a mismatch is about, if any. */
function addressOf(mismatch: Mismatch, context: FailureContext): number | null {
  const memory = /^memory\[0x([0-9A-F]{2})\]$/.exec(mismatch.field);
  if (memory?.[1] !== undefined) {
    return Number.parseInt(memory[1], 16);
  }
  if (mismatch.field.startsWith('memWrites') && mismatch.step !== null) {
    const step = context.expectedTrace[mismatch.step] ?? context.actualTrace[mismatch.step];
    return step?.memWrites[0]?.address ?? null;
  }
  return null;
}

/**
 * A readable failure report: where it failed (fixture, step, PC, opcode), each differing field
 * with its expected and actual value, the registers on both sides, the memory around the address
 * involved (or the failing instruction), and the RTL's most recent steps.
 */
export function formatFailureReport(
  name: string,
  mismatches: readonly Mismatch[],
  context: FailureContext,
): string {
  const first = mismatches[0];
  if (first === undefined) {
    return `PASS ${name}\n`;
  }
  const { expectedTrace, actualTrace, expected, actual } = context;
  const lines: string[] = [];

  let step: FixtureTraceStep | undefined;
  let where: string;
  let expectedRegs: readonly number[];
  let actualRegs: readonly number[];
  if (first.scope === 'trace' && first.step !== null) {
    step = expectedTrace[first.step] ?? actualTrace[first.step];
    where = `lock-step trace, step ${String(first.step)}`;
    expectedRegs = expectedTrace[first.step]?.regs ?? [];
    actualRegs = actualTrace[first.step]?.regs ?? [];
  } else {
    step = actualTrace.at(-1);
    where = `end state, after step ${step === undefined ? '-' : String(step.step)} (the last)`;
    expectedRegs = expected.registers;
    actualRegs = actual.registers;
  }
  lines.push(`FAIL ${name}: ${where}`);
  if (step !== undefined) {
    lines.push(
      `  instruction: PC 0x${hex2(step.pc)}, opcode ${opcodeName(step.ir[0])}, bytes [${step.ir.map(hex2).join(' ')}]`,
    );
  }

  const width = Math.max(5, ...mismatches.map((m) => m.field.length));
  lines.push(`  ${'field'.padEnd(width)}  expected → actual`);
  for (const m of mismatches.slice(0, 16)) {
    lines.push(`  ${m.field.padEnd(width)}  ${formatValue(m.expected)} → ${formatValue(m.actual)}`);
  }
  if (mismatches.length > 16) {
    lines.push(`  … and ${String(mismatches.length - 16)} more`);
  }

  lines.push(
    '  registers',
    `    expected  ${formatRegisters(expectedRegs)}`,
    `    actual    ${formatRegisters(actualRegs)}`,
  );

  const address = addressOf(first, context) ?? step?.pc ?? 0;
  const row = Math.floor(address / 16);
  lines.push(
    `  memory near 0x${hex2(address)} (final contents)`,
    `    expected  ${formatMemoryRow(expected.memory, row)}`,
    `    actual    ${formatMemoryRow(actual.memory, row)}`,
  );

  const history = context.history ?? 5;
  const last = first.scope === 'trace' && first.step !== null ? first.step : actualTrace.length - 1;
  const recent = actualTrace.slice(Math.max(0, last - history), last + 1);
  if (recent.length > 0) {
    lines.push('  recent RTL steps');
    for (const s of recent) {
      lines.push(`    ${formatStep(s)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
