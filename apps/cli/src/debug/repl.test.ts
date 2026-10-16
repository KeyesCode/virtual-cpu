import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assemble } from '@vcpu/assembler';
import { createDebugSession } from '@vcpu/debugger';
import { describe, expect, it } from 'vitest';
import { createDebugRepl } from './repl.js';

const source = readFileSync(
  resolve(import.meta.dirname, '../../../../examples/14-fibonacci.asm'),
  'utf8',
);

function fibonacciRepl() {
  const { bytes, sourceMap } = assemble(source);
  const session = createDebugSession({ program: bytes.image, sourceMap });
  const repl = createDebugRepl(session, { hasSource: true, maxInstructions: 1000 });
  return { session, run: (line: string) => repl.execute(line).output, repl };
}

describe('createDebugRepl', () => {
  it('starts at the first instruction with its source line', () => {
    expect(fibonacciRepl().repl.location()).toBe(
      '[READY] PC 0x00  LDI R0, 0           ; line 15: LDI R0, 0',
    );
  });

  it('steps, prints each executed instruction and steps back', () => {
    const { run, session } = fibonacciRepl();
    expect(run('step 2')).toBe(
      [
        '#0     0x00  11 00 00  LDI R0, 0',
        '#1     0x03  11 10 01  LDI R1, 1           R1 0x00→0x01',
        '[READY] PC 0x06  LDI R2, 128         ; line 17: LDI R2, OUT',
      ].join('\n'),
    );
    expect(run('back 5').split('\n')).toEqual([
      'Undid #1     0x03  11 10 01  LDI R1, 1           R1 0x00→0x01',
      'Undid #0     0x00  11 00 00  LDI R0, 0',
      'No more history: already at the oldest recorded step',
      '[READY] PC 0x00  LDI R0, 0           ; line 15: LDI R0, 0',
    ]);
    expect(session.getInstructionCount()).toBe(0);
  });

  it('sets breakpoints by line and address and runs to them', () => {
    const { run } = fibonacciRepl();
    expect(run('break 26')).toBe('Breakpoint 1 at 0x1A (line 26)');
    expect(run('run')).toContain('Breakpoint 1 at 0x1A (line 26)');
    expect(run('break 0x1C')).toBe('Breakpoint 2 at 0x1C (line 27)');
    expect(run('break')).toBe('Breakpoint 1 at 0x1A (line 26)\nBreakpoint 2 at 0x1C (line 27)');
    expect(run('break 1')).toMatch(/^error: /);
  });

  it('reports the instruction and access behind a watchpoint hit', () => {
    const { run } = fibonacciRepl();
    expect(run('watch 0x85 w')).toBe('Watchpoint 1 on 0x85 (write)');
    expect(run('run')).toContain(
      'Watchpoint 1 (write): STORE [R2], R0 at 0x0C wrote [0x85] 0x00 → 0x05',
    );
    expect(run('watch 0x85 x')).toBe('error: watch kind must be r, w or rw, got "x"');
  });

  it('runs to HLT and shows memory, the stack and the trace', () => {
    const { run } = fibonacciRepl();
    expect(run('run')).toContain('HALTED after 85 instructions');
    expect(run('mem 0x80 10')).toContain('  0x80  00 01 01 02 03 05 08 0D 15 22');
    expect(run('stack')).toBe('SP = 0xFF  depth = 0\n  (empty)');
    expect(run('trace 1')).toBe('#84    0x1C  01        HLT                 halted');
    expect(run('reset')).toContain('[READY] PC 0x00');
    expect(run('trace')).toBe('No instructions executed yet');
  });

  it('rejects unknown commands without throwing', () => {
    const { repl } = fibonacciRepl();
    expect(repl.execute('jump 3').output).toBe(
      'Unknown command "jump". Type "help" for the commands.',
    );
    expect(repl.execute('toString').output).toContain('Unknown command');
    expect(repl.execute('step 0').output).toBe(
      'error: step count must be a positive integer, got "0"',
    );
    expect(repl.execute('quit')).toEqual({ output: '', quit: true });
  });
});
