import {
  FaultCode,
  FIXTURE_FORMAT_V1,
  fixtureJsonSchemaV1,
  FixtureSchemaV1,
  type FixtureV1,
  formatMemoryHex,
  ISA_VERSION,
  lookupOpcode,
  OPCODE_IDS,
  type OpcodeId,
  parseMemoryHex,
  parseTraceJsonl,
} from '@vcpu/shared';
import { describe, expect, it } from 'vitest';
import { executeFixture } from '../fixture.js';

// Re-runs every committed fixture in `fixtures/v1/` on this core. A failure means cpu-core's
// behaviour drifted from the fixtures an RTL testbench verifies against: fix the core, or (for an
// intended ISA change) bump ISA_VERSION and regenerate with `pnpm fixtures:export`.
const FIXTURE_DIR = '../../../../fixtures/v1/';
const SCHEMA_FILE = 'fixture.schema.json';

const jsonFiles = import.meta.glob<unknown>('../../../../fixtures/v1/*.json', {
  eager: true,
  import: 'default',
});
const memHexFiles = import.meta.glob<string>('../../../../fixtures/v1/*.mem.hex', {
  eager: true,
  query: '?raw',
  import: 'default',
});
const expectedHexFiles = import.meta.glob<string>('../../../../fixtures/v1/*.expected.hex', {
  eager: true,
  query: '?raw',
  import: 'default',
});
const traceFiles = import.meta.glob<string>('../../../../fixtures/v1/*.trace.jsonl', {
  eager: true,
  query: '?raw',
  import: 'default',
});
const exampleSources = import.meta.glob<string>('../../../../examples/*.asm', {
  eager: true,
  query: '?raw',
  import: 'default',
});

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

const fixtureNames = Object.keys(jsonFiles)
  .map(baseName)
  .filter((file) => file !== SCHEMA_FILE)
  .map((file) => file.replace(/\.json$/, ''))
  .sort();

function fileOf<T>(files: Record<string, T>, name: string, suffix: string): T {
  const content = files[`${FIXTURE_DIR}${name}${suffix}`];
  expect(content, `${name}${suffix} is missing`).toBeDefined();
  return content as T;
}

function parseFixture(name: string): FixtureV1 {
  const parsed = FixtureSchemaV1.safeParse(fileOf(jsonFiles, name, '.json'));
  expect(parsed.error?.issues ?? [], `${name}.json is invalid`).toEqual([]);
  return FixtureSchemaV1.parse(fileOf(jsonFiles, name, '.json'));
}

const HEX_LINE = /^[0-9A-F]{2}$/;

function expectReadmemhImage(text: string, file: string): void {
  expect(text.endsWith('\n'), `${file} ends with a newline`).toBe(true);
  const lines = text.slice(0, -1).split('\n');
  expect(lines, `${file} has 256 lines`).toHaveLength(256);
  expect(
    lines.filter((line) => !HEX_LINE.test(line)),
    `${file} lines not matching ${String(HEX_LINE)}`,
  ).toEqual([]);
}

describe('fixtures/v1', () => {
  it('holds a fixture for every example program', () => {
    const examples = Object.keys(exampleSources).map(
      (path) => `example-${baseName(path).replace(/\.asm$/, '')}`,
    );
    expect(examples.length).toBeGreaterThan(0);
    expect(examples.filter((name) => !fixtureNames.includes(name))).toEqual([]);
  });

  it('has no hex or trace file without a fixture', () => {
    const orphans = [memHexFiles, expectedHexFiles, traceFiles]
      .flatMap((files) => Object.keys(files).map(baseName))
      .map((file) => file.replace(/\.(mem\.hex|expected\.hex|trace\.jsonl)$/, ''))
      .filter((name) => !fixtureNames.includes(name));
    expect(orphans).toEqual([]);
  });

  it(`commits ${SCHEMA_FILE} generated from FixtureSchemaV1`, () => {
    expect(jsonFiles[`${FIXTURE_DIR}${SCHEMA_FILE}`]).toEqual(fixtureJsonSchemaV1());
  });

  for (const name of fixtureNames) {
    it(`${name} still runs to its expected state on cpu-core`, () => {
      const fixture = parseFixture(name);
      expect(fixture.format).toBe(FIXTURE_FORMAT_V1);
      expect(fixture.isaVersion).toBe(ISA_VERSION);
      expect(fixture.name).toBe(name);

      const execution = executeFixture(fixture.initial, fixture.maxInstructions);
      expect(execution.expected).toEqual(fixture.expected);
      expect(execution.trace).toEqual(parseTraceJsonl(fileOf(traceFiles, name, '.trace.jsonl')));

      const memHex = fileOf(memHexFiles, name, '.mem.hex');
      const expectedHex = fileOf(expectedHexFiles, name, '.expected.hex');
      expectReadmemhImage(memHex, `${name}.mem.hex`);
      expectReadmemhImage(expectedHex, `${name}.expected.hex`);
      expect(parseMemoryHex(memHex)).toEqual(fixture.initial.memory);
      expect(parseMemoryHex(expectedHex)).toEqual(fixture.expected.memory);
      expect(memHex).toBe(formatMemoryHex(fixture.initial.memory));
      expect(expectedHex).toBe(formatMemoryHex(fixture.expected.memory));
    });
  }

  it('retires every ISA opcode in at least one fixture', () => {
    const retired = new Set<OpcodeId>();
    for (const name of fixtureNames) {
      for (const step of parseTraceJsonl(fileOf(traceFiles, name, '.trace.jsonl'))) {
        const info = lookupOpcode(step.ir[0] ?? -1);
        // Count only steps that completed without a fault.
        if (info !== undefined && step.fault === null) {
          retired.add(info.id);
        }
      }
    }
    expect(OPCODE_IDS.filter((id) => !retired.has(id))).toEqual([]);
  });

  it('ends at least one fixture with each fault code', () => {
    const raised = new Set(
      fixtureNames.map((name) => parseFixture(name).expected.fault?.code).filter(Boolean),
    );
    expect(Object.values(FaultCode).filter((code) => !raised.has(code))).toEqual([]);
  });
});
