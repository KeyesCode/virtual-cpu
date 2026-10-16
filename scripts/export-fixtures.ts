/**
 * `pnpm fixtures:export`: regenerates `fixtures/v1/` from every example program and the targeted
 * ISA vectors in `scripts/fixtures/vectors.ts`. For each fixture it writes `<name>.json`
 * (format `vcpu8-fixture/1`), `<name>.mem.hex` / `<name>.expected.hex` ($readmemh images) and
 * `<name>.trace.jsonl` (one line per step), plus `fixture.schema.json`. The output is
 * deterministic: no timestamps, fixtures sorted by name, so regenerating a clean tree is a no-op.
 *
 * It fails loudly, writing nothing, when an example no longer assembles or no longer meets its
 * `.expect.json`, or when any program does not halt or fault within its instruction limit.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble, formatDiagnostic } from '@vcpu/assembler';
import { executeFixture, type FixtureExecution } from '@vcpu/cpu-core';
import {
  type Expectation,
  ExpectationSchema,
  FIXTURE_FORMAT_V1,
  type FixtureKind,
  fixtureJsonSchemaV1,
  FixtureSchemaV1,
  type FixtureV1,
  FLAG_MASKS,
  FLAG_NAMES,
  formatMemoryHex,
  formatTraceJsonl,
  ISA_VERSION,
  REGISTER_NAMES,
  resetFixtureState,
} from '@vcpu/shared';
import { VECTORS } from './fixtures/vectors.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES_DIR = join(ROOT, 'examples');
/** Fixtures for ISA 1.0.0. Any ISA change bumps `ISA_VERSION` and moves the output to a new folder. */
const OUT_DIR = join(ROOT, 'fixtures', 'v1');
const DEFAULT_MAX_INSTRUCTIONS = 1000;

interface Program {
  readonly name: string;
  readonly kind: FixtureKind;
  readonly description: string;
  readonly source: string;
  readonly maxInstructions: number;
  /** Examples only: checked against the run before anything is written. */
  readonly expectation?: Expectation;
}

interface Built {
  readonly fixture: FixtureV1;
  readonly execution: FixtureExecution;
}

const hex = (value: number): string => `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;

/** The text of an example's header comment up to its first blank line, as one sentence-ish line. */
function exampleDescription(source: string): string {
  const purpose = /^;\s*Purpose:\s*(.+(?:\n;\s{2,}.+)*)/m.exec(source)?.[1];
  const title = /^;\s*\S+\.asm\s+—\s+(.+)$/m.exec(source)?.[1];
  const text = purpose ?? title ?? 'Example program.';
  return text.replace(/\n;\s+/g, ' ').trim();
}

function examplePrograms(): Program[] {
  return readdirSync(EXAMPLES_DIR)
    .filter((file) => file.endsWith('.asm'))
    .map((file) => {
      const base = file.replace(/\.asm$/, '');
      const source = readFileSync(join(EXAMPLES_DIR, file), 'utf8');
      const expectation = ExpectationSchema.parse(
        JSON.parse(readFileSync(join(EXAMPLES_DIR, `${base}.expect.json`), 'utf8')),
      );
      return {
        name: `example-${base}`,
        kind: 'example' as const,
        description: exampleDescription(source),
        source,
        maxInstructions: expectation.maxInstructions,
        expectation,
      };
    });
}

/** Every way the run differs from an example's expectation; empty when it meets it. */
function expectationMismatches(execution: FixtureExecution, expectation: Expectation): string[] {
  const { expected } = execution;
  const problems: string[] = [];
  if (expected.status !== expectation.status) {
    const fault = expected.fault === null ? '' : ` (${expected.fault.code} at ${hex(expected.fault.pc)})`;
    problems.push(`status ${expected.status}${fault}, expected ${expectation.status}`);
  }
  const registers: Record<string, number | undefined> = {
    ...Object.fromEntries(REGISTER_NAMES.map((name, index) => [name, expected.registers[index]])),
    PC: expected.pc,
    SP: expected.sp,
  };
  for (const [name, want] of Object.entries(expectation.registers ?? {})) {
    if (want !== undefined && registers[name] !== want) {
      problems.push(`${name} = ${hex(registers[name] ?? 0)}, expected ${hex(want)}`);
    }
  }
  for (const flag of FLAG_NAMES) {
    const want = expectation.flags?.[flag];
    const actual = (expected.flags & FLAG_MASKS[flag]) === 0 ? 0 : 1;
    if (want !== undefined && actual !== want) {
      problems.push(`flag ${flag} = ${String(actual)}, expected ${String(want)}`);
    }
  }
  for (const range of expectation.memory ?? []) {
    range.bytes.forEach((want, offset) => {
      const address = range.address + offset;
      if (expected.memory[address] !== want) {
        problems.push(`mem[${hex(address)}] = ${hex(expected.memory[address] ?? 0)}, expected ${hex(want)}`);
      }
    });
  }
  return problems;
}

function build(program: Program): Built {
  const assembled = assemble(program.source);
  if (!assembled.ok) {
    const errors = assembled.diagnostics.map((d) => formatDiagnostic(d, program.source));
    throw new Error(`${program.name} does not assemble:\n${errors.join('\n')}`);
  }
  const initial = resetFixtureState(assembled.bytes.image);
  let execution: FixtureExecution;
  try {
    execution = executeFixture(initial, program.maxInstructions);
  } catch (error) {
    throw new Error(`${program.name}: ${(error as Error).message}`, { cause: error });
  }
  if (program.expectation !== undefined) {
    const problems = expectationMismatches(execution, program.expectation);
    if (problems.length > 0) {
      throw new Error(
        `${program.name} no longer meets its .expect.json:\n  ${problems.join('\n  ')}`,
      );
    }
  }
  const fixture = FixtureSchemaV1.parse({
    format: FIXTURE_FORMAT_V1,
    isaVersion: ISA_VERSION,
    name: program.name,
    kind: program.kind,
    description: program.description,
    source: program.source,
    initial,
    maxInstructions: program.maxInstructions,
    expected: execution.expected,
  });
  return { fixture, execution };
}

/**
 * JSON with two-space indentation, except that arrays of numbers are printed 16 per line, so a
 * memory image reads as a hex-dump-shaped block of 16 rows.
 */
function toJson(value: unknown, indent = ''): string {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every((item) => typeof item === 'number')) {
      if (value.length <= 16) return `[${value.join(', ')}]`;
      const rows: string[] = [];
      for (let start = 0; start < value.length; start += 16) {
        rows.push(`${inner}${value.slice(start, start + 16).join(', ')}`);
      }
      return `[\n${rows.join(',\n')}\n${indent}]`;
    }
    return `[\n${value.map((item) => `${inner}${toJson(item, inner)}`).join(',\n')}\n${indent}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return '{}';
    const body = entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${toJson(item, inner)}`);
    return `{\n${body.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

function main(): void {
  const programs: Program[] = [
    ...examplePrograms(),
    ...VECTORS.map((vector) => ({
      ...vector,
      maxInstructions: vector.maxInstructions ?? DEFAULT_MAX_INSTRUCTIONS,
    })),
  ];
  const names = new Set<string>();
  for (const { name } of programs) {
    if (names.has(name)) throw new Error(`Duplicate fixture name ${name}`);
    names.add(name);
  }

  // Build everything before touching the output folder, so a failure leaves it as it was.
  const built = programs
    .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
    .map(build);

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'fixture.schema.json'), `${toJson(fixtureJsonSchemaV1())}\n`);
  for (const { fixture, execution } of built) {
    const base = join(OUT_DIR, fixture.name);
    writeFileSync(`${base}.json`, `${toJson(fixture)}\n`);
    writeFileSync(`${base}.mem.hex`, formatMemoryHex(fixture.initial.memory));
    writeFileSync(`${base}.expected.hex`, formatMemoryHex(fixture.expected.memory));
    writeFileSync(`${base}.trace.jsonl`, formatTraceJsonl(execution.trace));
  }

  const counts = new Map<FixtureKind, number>();
  for (const { fixture } of built) counts.set(fixture.kind, (counts.get(fixture.kind) ?? 0) + 1);
  const summary = [...counts].map(([kind, count]) => `${String(count)} ${kind}`).join(', ');
  console.log(`Wrote ${String(built.length)} fixtures (${summary}) to ${OUT_DIR}`);
}

main();
