import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FixtureSchemaV1, formatTraceJsonl, parseTraceJsonl } from '@vcpu/shared';

const FIXTURE_FILES = ['.json', '.mem.hex', '.expected.hex', '.trace.jsonl'] as const;

function copyFixture(name: string, from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const ext of FIXTURE_FILES) {
    copyFileSync(join(from, name + ext), join(to, name + ext));
  }
}

/**
 * Writes two tampered fixture copies for `make fixtures-tamper`, which requires the fixture check
 * to fail on each with a precise report. `fixturesDir` is only read.
 *
 * - `<outDir>/register/`: `op-add` with expected R0 one higher (an end-state mismatch).
 * - `<outDir>/memwrite/`: `op-push-full-stack` with the first trace memory write's value changed
 *   (a lock-step mismatch).
 *
 * Returns a one-line description of what was changed.
 */
export function writeTamperedFixtures(fixturesDir: string, outDir: string): string {
  const registerDir = join(outDir, 'register');
  copyFixture('op-add', fixturesDir, registerDir);
  const fixturePath = join(registerDir, 'op-add.json');
  const fixture = FixtureSchemaV1.parse(JSON.parse(readFileSync(fixturePath, 'utf8')));
  const r0 = fixture.expected.registers[0] ?? 0;
  fixture.expected.registers[0] = (r0 + 1) & 0xff;
  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  const memwriteDir = join(outDir, 'memwrite');
  copyFixture('op-push-full-stack', fixturesDir, memwriteDir);
  const tracePath = join(memwriteDir, 'op-push-full-stack.trace.jsonl');
  const steps = parseTraceJsonl(readFileSync(tracePath, 'utf8'));
  const step = steps.find((s) => s.memWrites.length > 0);
  const write = step?.memWrites[0];
  if (step === undefined || write === undefined) {
    throw new Error('op-push-full-stack has no memory write to tamper with');
  }
  write.value ^= 0x01;
  writeFileSync(tracePath, formatTraceJsonl(steps));

  return `op-add: expected R0 ${String(r0)} → ${String(fixture.expected.registers[0])}; op-push-full-stack: step ${String(step.step)} memWrites[0].value changed`;
}
