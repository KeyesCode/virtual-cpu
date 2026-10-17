import { disassemble } from '@vcpu/assembler';
import {
  CpuStatus,
  type FixtureExpectedState,
  type FixtureFault,
  FixtureFaultSchema,
  type FixtureTraceStep,
  FixtureTraceStepSchema,
  FLAG_MASKS,
  FLAG_NAMES,
  FlagsByteSchema,
  MemoryImageSchema,
  opcodeByByte,
  REGISTER_COUNT,
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

/**
 * SD as the RTL reports it: the register is 7 bits wide, so a broken stack check can push it past
 * 64. The formats accept that, so the comparison names the value instead of the parse failing.
 */
export const RtlStackDepthSchema = z.number().int().min(0).max(127);

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
  sd: RtlStackDepthSchema,
  flags: FlagsByteSchema,
  memory: MemoryImageSchema,
  stopReason: RtlStopReasonSchema,
});
export type RtlState = z.output<typeof RtlStateSchema>;

/** One line of the runner's `--trace` output: a fixture trace line plus the clock count. */
export const RtlTraceStepSchema = FixtureTraceStepSchema.extend({
  sd: RtlStackDepthSchema,
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
 * Where a run ended and the architectural state there: what the live reference
 * (`runReference`) produces for any program, including one cut off at its step limit, and what a
 * fixture's `expected` is plus the stop its status implies.
 */
export interface EndState {
  readonly stopReason: 'halted' | 'faulted' | 'max_steps';
  readonly status: typeof CpuStatus.READY | typeof CpuStatus.HALTED | typeof CpuStatus.FAULTED;
  readonly fault: FixtureFault | null;
  readonly instructions: number;
  readonly registers: readonly number[];
  readonly pc: number;
  readonly sp: number;
  readonly sd: number;
  readonly flags: number;
  readonly memory: readonly number[];
}

/**
 * Every end-state field: the stop, status, fault, retired instructions, R0–R7, PC, SP, SD, FLAGS
 * and all 256 memory bytes. Both sides run under the same step limit, so a run the reference
 * cut off at the limit must be cut off there on the RTL too, with the same state.
 */
export function compareEnd(expected: EndState, actual: RtlState): Mismatch[] {
  const c = new Collector('end-state', null);
  c.check('stopReason', expected.stopReason, actual.stopReason);
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

/** A fixture's `expected` as an end state: every fixture halts or faults within its limit. */
export function fixtureEndState(expected: FixtureExpectedState): EndState {
  return { ...expected, stopReason: expected.status === CpuStatus.HALTED ? 'halted' : 'faulted' };
}

/**
 * Every end-state field of a fixture (`compareEnd`). A run that hit a step or cycle limit is a
 * mismatch, because every fixture halts or faults within its `maxInstructions`.
 */
export function compareEndState(expected: FixtureExpectedState, actual: RtlState): Mismatch[] {
  return compareEnd(fixtureEndState(expected), actual);
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
  /** The reference (emulator) trace. */
  readonly expectedTrace: readonly FixtureTraceStep[];
  readonly actualTrace: readonly FixtureTraceStep[];
  readonly expected: Pick<EndState, 'registers' | 'pc' | 'sp' | 'sd' | 'flags' | 'memory'>;
  readonly actual: RtlState;
  /** Steps listed from each side, ending at the failing one (default 16). */
  readonly history?: number;
  /** Lines printed under the headline, e.g. the corpus, seed and step limit. */
  readonly details?: readonly string[];
  /** The command that reruns this case. */
  readonly replay?: string;
}

function opcodeName(byte: number | undefined): string {
  if (byte === undefined) {
    return '?';
  }
  return `0x${hex2(byte)} ${opcodeByByte[byte]?.id ?? '(invalid)'}`;
}

/** The instruction's canonical assembly, or `.byte` lines for bytes that do not decode. */
function disassembly(bytes: readonly number[]): string {
  return disassemble(bytes)
    .map((line) => line.text)
    .join('; ');
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

function formatFlags(flags: number): string {
  const set = FLAG_NAMES.filter((name) => (flags & FLAG_MASKS[name]) !== 0);
  return `FLAGS=${hex2(flags)} (${set.length === 0 ? '-' : set.join(' ')})`;
}

interface ArchView {
  readonly regs: readonly number[];
  readonly flags: number;
  readonly sp: number;
  readonly sd: number;
  readonly pc: number;
}

function formatArch(view: ArchView | undefined): string {
  if (view === undefined) {
    return '(no such step)';
  }
  return [
    formatRegisters(view.regs),
    formatFlags(view.flags),
    `SP=${hex2(view.sp)} SD=${String(view.sd)} PC=${hex2(view.pc)}`,
  ].join('  ');
}

function stepView(step: FixtureTraceStep | undefined): ArchView | undefined {
  return step === undefined ? undefined : { ...step, pc: step.nextPc };
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
    return (
      step?.memWrites[0]?.address ??
      context.actualTrace[mismatch.step]?.memWrites[0]?.address ??
      null
    );
  }
  return null;
}

/** `rows` of memory from both sides, under a heading. */
function memoryBlock(
  heading: string,
  rows: readonly number[],
  expected: readonly number[],
  actual: readonly number[],
): string[] {
  const lines = [`  ${heading}`];
  for (const row of rows) {
    const mark = expected.slice(row * 16, row * 16 + 16).some((v, i) => v !== actual[row * 16 + i])
      ? '  ≠'
      : '';
    lines.push(`    expected  ${formatMemoryRow(expected, row)}`);
    lines.push(`    actual    ${formatMemoryRow(actual, row)}${mark}`);
  }
  return lines;
}

/**
 * A readable failure report: where it failed (case, step, PC, opcode and its disassembly), each
 * differing field with its expected and actual value, every register and flag on both sides, the
 * memory around the address involved (or the failing instruction) and the stack, the most recent
 * steps of both sides, and how to rerun the case.
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

  const inTrace = first.scope === 'trace' && first.step !== null;
  const last = inTrace ? first.step : actualTrace.length - 1;
  const step = expectedTrace[last] ?? actualTrace[last];
  const where = inTrace
    ? `lock-step trace, step ${String(last)}`
    : `end state, after step ${step === undefined ? '-' : String(step.step)} (the last)`;
  lines.push(`FAIL ${name}: ${where}`);
  for (const detail of context.details ?? []) {
    lines.push(`  ${detail}`);
  }
  if (step !== undefined) {
    lines.push(
      `  instruction: PC 0x${hex2(step.pc)}, opcode ${opcodeName(step.ir[0])}, bytes [${step.ir.map(hex2).join(' ')}] = ${disassembly(step.ir)}`,
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

  if (inTrace) {
    lines.push(
      `  registers and flags after step ${String(last)}`,
      `    expected  ${formatArch(stepView(expectedTrace[last]))}`,
      `    actual    ${formatArch(stepView(actualTrace[last]))}`,
    );
  } else {
    lines.push(
      '  registers and flags at the end',
      `    expected  ${formatArch({ ...expected, regs: expected.registers })}`,
      `    actual    ${formatArch({ ...actual, regs: actual.registers })}`,
    );
  }

  const address = addressOf(first, context) ?? step?.pc ?? 0;
  const row = Math.floor(address / 16);
  const near = [row - 1, row, row + 1].filter((r) => r >= 0 && r < 16);
  lines.push(
    ...memoryBlock(
      `memory near 0x${hex2(address)} (final contents)`,
      near,
      expected.memory,
      actual.memory,
    ),
  );
  // The stack grows down from 0xFF: show up to four rows from its top on either side, as SP was
  // at the failing step (or at the end).
  const expectedSp = inTrace ? (expectedTrace[last]?.sp ?? expected.sp) : expected.sp;
  const actualSp = inTrace ? (actualTrace[last]?.sp ?? actual.sp) : actual.sp;
  const top = Math.min(expectedSp, actualSp) + 1;
  if (top <= 0xff) {
    const stackRows: number[] = [];
    for (let r = Math.floor(top / 16); r < Math.min(16, Math.floor(top / 16) + 4); r += 1) {
      if (!near.includes(r)) {
        stackRows.push(r);
      }
    }
    if (stackRows.length > 0) {
      lines.push(
        ...memoryBlock(
          `stack from 0x${hex2(top)} (final contents; SP ${inTrace ? `after step ${String(last)}` : 'at the end'} expected ${hex2(expectedSp)}, actual ${hex2(actualSp)})`,
          stackRows,
          expected.memory,
          actual.memory,
        ),
      );
    }
  } else {
    lines.push(
      `  stack empty on both sides ${inTrace ? `after step ${String(last)}` : 'at the end'} (SP = 0xFF)`,
    );
  }

  const history = context.history ?? 16;
  for (const [label, trace] of [
    ['emulator', expectedTrace],
    ['RTL', actualTrace],
  ] as const) {
    const end = Math.min(last, trace.length - 1);
    const recent = trace.slice(Math.max(0, end - history + 1), end + 1);
    if (recent.length > 0) {
      lines.push(`  recent ${label} steps (last ${String(recent.length)})`);
      for (const s of recent) {
        lines.push(`    ${formatStep(s)}`);
      }
    }
  }
  if (context.replay !== undefined) {
    lines.push(`  replay: ${context.replay}`);
  }
  return `${lines.join('\n')}\n`;
}
