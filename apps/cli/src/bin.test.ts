import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const cliDir = resolve(import.meta.dirname, '..');
const root = resolve(cliDir, '../..');

describe('bin.ts', () => {
  it('runs as a process, resolving paths against INIT_CWD and setting the exit code', () => {
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'src/bin.ts', ...args], {
        cwd: cliDir,
        env: { ...process.env, INIT_CWD: root },
        encoding: 'utf8',
      });
    const ok = run('run', 'examples/01-addition.asm');
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('R0 = 0x1E (30)');
    expect(run('run', 'examples/12-countdown.asm', '--max-instructions', '3').status).toBe(3);
  }, 30_000);
});
