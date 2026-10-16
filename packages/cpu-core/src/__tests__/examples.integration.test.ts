import { assemble, formatDiagnostic } from '@vcpu/assembler';
import {
  type Expectation,
  ExpectationSchema,
  FLAG_MASKS,
  FLAG_NAMES,
  OPCODE_IDS,
  type OpcodeId,
  REGISTER_NAMES,
} from '@vcpu/shared';
import { describe, expect, it } from 'vitest';
import { createCpu, type RunResult } from '../cpu.js';
import type { CpuState } from '../state.js';
import type { CpuMetrics } from '../metrics.js';

/** The brief requires at least this many example programs. */
const MIN_EXAMPLES = 20;

// Every `examples/*.asm` is tested against its `<name>.expect.json`; adding an example needs no
// change here.
const sources = import.meta.glob<string>('../../../../examples/*.asm', {
  eager: true,
  query: '?raw',
  import: 'default',
});
const expectationFiles = import.meta.glob<unknown>('../../../../examples/*.expect.json', {
  eager: true,
  import: 'default',
});

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

interface Example {
  readonly name: string;
  readonly source: string;
  /** `undefined` when the example has no `.expect.json`, which fails its test. */
  readonly expectationFile: unknown;
}

const examples: readonly Example[] = Object.entries(sources)
  .map(([path, source]) => ({
    name: baseName(path).replace(/\.asm$/, ''),
    source,
    expectationFile: expectationFiles[path.replace(/\.asm$/, '.expect.json')],
  }))
  .sort((x, y) => x.name.localeCompare(y.name));

const hex = (value: number): string => `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;

interface ExampleRun {
  readonly run: RunResult;
  readonly state: CpuState;
  readonly metrics: CpuMetrics;
}

/** Assembles and runs an example; fails with the assembler's diagnostics if it does not assemble. */
function runExample(example: Example, expectation: Expectation): ExampleRun {
  const assembled = assemble(example.source);
  const errors = assembled.diagnostics.map((d) => formatDiagnostic(d, example.source));
  expect(assembled.ok, `${example.name}.asm does not assemble:\n${errors.join('\n')}`).toBe(true);
  const cpu = createCpu({ traceCapacity: 0 });
  cpu.loadProgram(assembled.bytes.image);
  const run = cpu.run({ maxInstructions: expectation.maxInstructions });
  return { run, state: cpu.getState(), metrics: cpu.getMetrics() };
}

/** Why the run stopped, for failure messages: the fault, or the stop reason and PC. */
function describeStop({ run, state }: ExampleRun): string {
  if (state.fault !== null) {
    return `faulted with ${state.fault.code} at ${hex(state.fault.pc)}: ${state.fault.detail}`;
  }
  return `stopped (${run.stopReason}) after ${String(run.executed)} instructions at PC ${hex(state.pc)}`;
}

function parseExpectation(example: Example): Expectation {
  expect(example.expectationFile, `${example.name}.expect.json is missing`).toBeDefined();
  const parsed = ExpectationSchema.safeParse(example.expectationFile);
  expect(parsed.error?.issues ?? [], `${example.name}.expect.json is invalid`).toEqual([]);
  return ExpectationSchema.parse(example.expectationFile);
}

/** Picks the actual value of each register the expectation lists. */
function actualRegisters(
  state: CpuState,
  expected: Expectation['registers'],
): Record<string, number> {
  const named: Record<string, number | undefined> = {
    ...Object.fromEntries(REGISTER_NAMES.map((name, index) => [name, state.registers[index]])),
    PC: state.pc,
    SP: state.sp,
  };
  return Object.fromEntries(Object.keys(expected ?? {}).map((name) => [name, named[name] ?? -1]));
}

describe('examples/', () => {
  it(`holds at least ${String(MIN_EXAMPLES)} example programs`, () => {
    expect(examples.length).toBeGreaterThanOrEqual(MIN_EXAMPLES);
  });

  it('has no expectation file without a program', () => {
    const programs = new Set(examples.map((example) => example.name));
    const orphans = Object.keys(expectationFiles)
      .map((path) => baseName(path).replace(/\.expect\.json$/, ''))
      .filter((name) => !programs.has(name));
    expect(orphans).toEqual([]);
  });

  for (const example of examples) {
    it(`${example.name}.asm meets ${example.name}.expect.json`, () => {
      const expectation = parseExpectation(example);
      const result = runExample(example, expectation);
      const { state } = result;

      expect(state.status, `${example.name} ${describeStop(result)}`).toBe(expectation.status);

      if (expectation.registers !== undefined) {
        expect(actualRegisters(state, expectation.registers), 'registers').toEqual(
          expectation.registers,
        );
      }
      if (expectation.flags !== undefined) {
        const flags = Object.fromEntries(
          FLAG_NAMES.filter((flag) => flag in (expectation.flags ?? {})).map((flag) => [
            flag,
            (state.flags & FLAG_MASKS[flag]) === 0 ? 0 : 1,
          ]),
        );
        expect(flags, 'flags').toEqual(expectation.flags);
      }
      for (const range of expectation.memory ?? []) {
        const actual = state.memory.slice(range.address, range.address + range.bytes.length);
        expect(actual, `memory at ${hex(range.address)}`).toEqual(range.bytes);
      }
    });
  }

  it('executes every ISA opcode at least once across the examples', () => {
    const executed = new Set<OpcodeId>();
    for (const example of examples) {
      const { metrics } = runExample(example, parseExpectation(example));
      for (const id of OPCODE_IDS) {
        if (metrics.opcodeCounts[id] > 0) executed.add(id);
      }
    }
    expect(OPCODE_IDS.filter((id) => !executed.has(id))).toEqual([]);
  });
});
