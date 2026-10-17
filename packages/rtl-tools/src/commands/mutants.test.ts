import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMutant, MUTANTS_DEFAULTS, MutantError, parseMutants } from './mutants.js';

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vcpu8-mutant-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const mutants = parseMutants(readFileSync(MUTANTS_DEFAULTS.list, 'utf8'));

describe('scripts/mutants.txt', () => {
  it('lists at least the wrong carry, a swapped branch and the missing SD check', () => {
    expect(mutants.map((m) => m.id)).toEqual(
      expect.arrayContaining(['alu-add-carry', 'branch-inverted', 'sd-unchecked']),
    );
  });

  it.each(mutants.map((m) => [m.id, m] as const))('%s still applies to core/', (_id, mutant) => {
    const out = scratch();
    applyMutant(MUTANTS_DEFAULTS.core, out, mutant);
    const original = readFileSync(join(MUTANTS_DEFAULTS.core, mutant.file), 'utf8');
    const mutated = readFileSync(join(out, mutant.file), 'utf8');
    expect(mutated).not.toBe(original);
    expect(mutated).toBe(original.replace(mutant.from, mutant.to));
  });
});

describe('parseMutants and applyMutant', () => {
  it('rejects a block without a replacement', () => {
    expect(() => parseMutants('[x]\nfile: a.sv\nwhat: w\nfrom: a\n')).toThrow(MutantError);
  });

  it('fails, rather than skipping, when the text no longer occurs exactly once', () => {
    const [mutant] = parseMutants(
      '[gone]\nfile: vcpu8_alu.sv\nwhat: w\nfrom: no such text\nto: x\n',
    );
    if (mutant === undefined) throw new Error('no mutant parsed');
    expect(() => {
      applyMutant(MUTANTS_DEFAULTS.core, scratch(), mutant);
    }).toThrow(/no longer applies.*occurs 0 times/);
  });
});
