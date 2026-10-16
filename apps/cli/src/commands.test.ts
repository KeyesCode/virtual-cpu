import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { RunJsonSchema, runCli } from './index.js';

const root = resolve(import.meta.dirname, '../../..');
const examples = readdirSync(join(root, 'examples'))
  .filter((name) => name.endsWith('.asm'))
  .sort();

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'vcpu-cli-'));
});

/** Writes a scratch file and returns its absolute path. */
function scratchFile(name: string, contents: string | Uint8Array): string {
  const path = join(scratch, name);
  writeFileSync(path, contents);
  return path;
}

const cli = (args: string[], stdin?: string) =>
  runCli(args, { cwd: root, ...(stdin === undefined ? {} : { stdin }) });

describe('pnpm cpu run', () => {
  it('prints the status, registers, memory rows and summary for 01-addition', async () => {
    const result = await cli(['run', 'examples/01-addition.asm']);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Status: HALTED at PC 0x08 after 4 instructions');
    expect(result.stdout).toContain('R0 = 0x1E (30)');
    expect(result.stdout).toContain('  0x00  11 00 0A 11 10 14 20 01 01');
    expect(result.stdout).toContain('Est. cycles    13');
  });

  it('shows only non-zero memory rows unless --memory all', async () => {
    const rows = (out: string) =>
      out.split('\n').filter((line) => /^ {2}0x[0-9A-F]{2} {2}/.test(line));
    const nonZero = await cli(['run', 'examples/14-fibonacci.asm']);
    expect(rows(nonZero.stdout).map((line) => line.slice(2, 6))).toEqual(['0x00', '0x10', '0x80']);
    const all = await cli(['run', 'examples/14-fibonacci.asm', '--memory', 'all']);
    expect(rows(all.stdout)).toHaveLength(16);
  });

  it.each(examples)('halts %s with a schema-valid --json document', async (name) => {
    const result = await cli(['run', `examples/${name}`, '--json']);
    expect(result.exitCode).toBe(0);
    const document = RunJsonSchema.parse(JSON.parse(result.stdout));
    expect(document).toMatchObject({
      file: `examples/${name}`,
      stopReason: 'halted',
      status: 'HALTED',
    });
  });

  it('reports the 14-fibonacci results in --json', async () => {
    const result = await cli(['run', 'examples/14-fibonacci.asm', '--json']);
    const document = RunJsonSchema.parse(JSON.parse(result.stdout));
    expect(document.registers).toMatchObject({ R0: 55, R1: 89, R2: 0x8a });
    expect(document.flags).toEqual({ value: 0x08, Z: true, C: false, N: false, V: false });
    expect(document.memory.slice(0x80, 0x8a)).toEqual([0, 1, 1, 2, 3, 5, 8, 13, 21, 34]);
    expect(document.trace).toBeUndefined();
  });

  it('prints each step with --trace, and includes it in --json', async () => {
    const text = await cli(['run', 'examples/01-addition.asm', '--trace']);
    expect(text.stdout).toMatch(/#2 +0x06 {2}20 01 {5}ADD R0, R1 +R0 0x0A→0x1E/);
    const json = await cli(['run', 'examples/01-addition.asm', '--trace', '--json']);
    const document = RunJsonSchema.parse(JSON.parse(json.stdout));
    expect(document.trace?.map((entry) => entry.text)).toEqual([
      'LDI R0, 10',
      'LDI R1, 20',
      'ADD R0, R1',
      'HLT',
    ]);
  });

  it('exits 3 at the instruction limit', async () => {
    const result = await cli(['run', 'examples/12-countdown.asm', '--max-instructions', '5']);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain('stopped at the instruction limit (5)');
  });

  it('exits 2 on a CPU fault', async () => {
    const file = scratchFile('div-zero.asm', 'LDI R0, 1\nLDI R1, 0\nDIV R0, R1\nHLT\n');
    const result = await cli(['run', file, '--json']);
    expect(result.exitCode).toBe(2);
    const document = RunJsonSchema.parse(JSON.parse(result.stdout));
    expect(document.stopReason).toBe('faulted');
    expect(document.fault).toMatchObject({ code: 'DIVIDE_BY_ZERO', pc: 0x06 });
  });

  it('runs a .bin file from address 0x00', async () => {
    const file = scratchFile(
      'add.bin',
      Uint8Array.from([0x11, 0x00, 0x0a, 0x11, 0x10, 0x14, 0x20, 0x01, 0x01]),
    );
    const result = await cli(['run', file]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('R0 = 0x1E (30)');
  });
});

describe('pnpm cpu assemble and disassemble', () => {
  it.each(examples)('assembles %s and disassembles it back', async (name) => {
    const output = join(scratch, name.replace(/\.asm$/, '.bin'));
    const assembled = await cli(['assemble', `examples/${name}`, '-o', output]);
    expect(assembled.exitCode).toBe(0);
    expect(assembled.stdout).toContain(`Assembled examples/${name}`);
    const disassembled = await cli(['disassemble', output]);
    expect(disassembled.exitCode).toBe(0);
    expect(disassembled.stdout).toMatch(/^0x00 {2}/);
    expect(disassembled.stdout).toContain('HLT');
  });

  it('writes 14-fibonacci as raw bytes and prints it back as assembly', async () => {
    const output = join(scratch, 'fib.bin');
    await cli(['assemble', 'examples/14-fibonacci.asm', '-o', output]);
    const bytes = readFileSync(output);
    expect(bytes).toHaveLength(0x1d);
    expect(bytes[0x1a]).toBe(0x42); // JNZ
    const result = await cli(['disassemble', output, '--start', '0x18', '--end', '0x1C']);
    expect(result.stdout).toBe(
      '0x18  25 30     DEC R3\n0x1A  42 0C     JNZ 0x0C\n0x1C  01        HLT\n',
    );
  });

  it('prints a listing and the symbol table', async () => {
    const output = join(scratch, 'fib-listing.bin');
    const result = await cli([
      'assemble',
      'examples/14-fibonacci.asm',
      '-o',
      output,
      '--listing',
      '--symbols',
    ]);
    expect(result.stdout).toMatch(/0x1A {2}42 0C +26 {2}JNZ loop/);
    expect(result.stdout).toMatch(/loop +label +0x0C +19/);
  });

  it('reports errors as file:line:col with a caret and exits 1', async () => {
    const file = scratchFile('bad.asm', '; bad\n        LDI R9, 1\n        HLT\n');
    const result = await cli(['assemble', file, '-o', join(scratch, 'bad.bin')]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`${file}:2:13: error: unknown register "R9" (valid: R0–R7)`);
    expect(result.stderr).toContain('\n          LDI R9, 1\n              ^^\n');
  });

  it('marks bytes that do not decode', async () => {
    const file = scratchFile('data.bin', Uint8Array.from([0x01, 0xff]));
    const result = await cli(['disassemble', file]);
    expect(result.stdout).toBe(
      '0x00  01        HLT\n0x01  FF        .byte 0xFF  ; invalid opcode\n',
    );
  });
});

describe('pnpm cpu debug', () => {
  it('stops at a breakpoint on the 14-fibonacci JNZ', async () => {
    const result = await cli(
      ['debug', 'examples/14-fibonacci.asm'],
      'break 0x1A\nrun\nregs\nquit\n',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('(vcpu) break 0x1A\nBreakpoint 1 at 0x1A (line 26)');
    expect(result.stdout).toContain('Ran 11 instructions\nBreakpoint 1 at 0x1A (line 26)');
    expect(result.stdout).toContain('[PAUSED] PC 0x1A  JNZ 0x0C');
    expect(result.stdout).toContain('R3 = 0x09 (9)');
  });

  it('ends cleanly at the end of input', async () => {
    const result = await cli(['debug', 'examples/01-addition.asm'], 'run\n');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('HALTED after 4 instructions');
  });
});

describe('usage errors exit 64', () => {
  it.each([
    ['a missing file', ['run', 'examples/missing.asm'], 'no such file'],
    ['an unknown extension', ['run', 'README.md'], 'expected a .asm or .bin file'],
    ['a missing argument', ['assemble'], 'missing the <file.asm> to assemble'],
    ['an unknown flag', ['run', 'examples/01-addition.asm', '--fast'], "Unknown option '--fast'"],
    ['a bad --memory', ['run', 'examples/01-addition.asm', '--memory', 'some'], '--memory must be'],
    ['a bad --end', ['disassemble', 'x.bin', '--end', '0x100'], '--end must be an address'],
    [
      'the reserved benchmark command',
      ['benchmark', 'examples/01-addition.asm'],
      'not available yet',
    ],
  ])('for %s', async (_, args, message) => {
    const result = await cli(args);
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain(message);
  });

  it('for a .bin larger than memory', async () => {
    const file = scratchFile('big.bin', new Uint8Array(257));
    const result = await cli(['run', file]);
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain('257 bytes does not fit in the 256-byte memory');
  });

  it('for an unknown command', async () => {
    const result = await cli(['explode']);
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain('Unknown command: explode');
  });
});

describe('--help', () => {
  it.each(['assemble', 'run', 'debug', 'disassemble'])('is available for %s', async (name) => {
    const flag = await cli([name, '--help']);
    expect(flag.exitCode).toBe(0);
    expect(flag.stdout).toContain(`Usage: pnpm cpu ${name} `);
    expect((await cli(['help', name])).stdout).toBe(flag.stdout);
  });
});
