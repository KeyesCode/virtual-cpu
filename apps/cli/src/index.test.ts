import { describe, expect, it } from 'vitest';
import { runCli } from './index.js';

describe('@vcpu/cli', () => {
  it('prints usage for --help', () => {
    const result = runCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: pnpm cpu <command>');
  });
});
