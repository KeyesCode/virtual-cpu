import { readFileSync } from 'node:fs';
import { FixtureSchemaV1, parseTraceJsonl } from '@vcpu/shared';
import { describe, expect, it } from 'vitest';
import { fixtureEndState } from './compare.js';
import { runReference } from './reference.js';

const FIXTURES = new URL('../../../../fixtures/v1/', import.meta.url);

function load(name: string) {
  const fixture = FixtureSchemaV1.parse(
    JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8')),
  );
  const trace = parseTraceJsonl(readFileSync(new URL(`${name}.trace.jsonl`, FIXTURES), 'utf8'));
  return { fixture, trace };
}

describe('runReference', () => {
  // A halt, a call/return, a loop, a precise fault and a post-commit fault.
  it.each([
    'op-add',
    'op-call-ret',
    'example-14-fibonacci',
    'fault-divide-by-zero',
    'fault-pc-overflow-inc',
  ])('reproduces the committed fixture %s exactly', (name) => {
    const { fixture, trace } = load(name);
    const run = runReference(fixture.initial.memory, fixture.maxInstructions);
    expect(run.trace).toEqual(trace);
    expect(run.end).toEqual(fixtureEndState(fixture.expected));
  });

  it('stops at the step limit in READY and reports max_steps', () => {
    const { fixture, trace } = load('example-14-fibonacci');
    const run = runReference(fixture.initial.memory, 5);
    expect(run.trace).toEqual(trace.slice(0, 5));
    expect(run.end).toMatchObject({
      stopReason: 'max_steps',
      status: 'READY',
      fault: null,
      instructions: 5,
      pc: trace[4]?.nextPc,
    });
  });
});
