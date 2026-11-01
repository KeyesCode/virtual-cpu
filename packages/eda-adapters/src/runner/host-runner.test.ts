import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostCommandRunner, processGroupAlive } from './host-runner.js';

describe('HostCommandRunner', () => {
  let dir: string;
  const options = (timeoutMs = 5000, maxLogBytes = 1024) => ({
    cwd: dir,
    timeoutMs,
    maxLogBytes,
    stdoutPath: join(dir, 'logs', 'out.log'),
    stderrPath: join(dir, 'logs', 'err.log'),
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'host-runner-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records the exit code, the streams and the times of a command', async () => {
    const record = await new HostCommandRunner().run(
      'sh',
      ['-c', 'echo out; echo err >&2; exit 3'],
      options(),
    );
    expect(record).toMatchObject({
      command: 'sh',
      cwd: dir,
      exitCode: 3,
      signal: null,
      timedOut: false,
      spawnError: null,
      stdout: { bytes: 4, truncated: false },
    });
    expect(readFileSync(record.stdout.path, 'utf8')).toBe('out\n');
    expect(readFileSync(record.stderr.path, 'utf8')).toBe('err\n');
    expect(Date.parse(record.finishedAt)).toBeGreaterThanOrEqual(Date.parse(record.startedAt));
  });

  it('caps a log with a marker and records the full size', async () => {
    const record = await new HostCommandRunner().run(
      'sh',
      ['-c', 'head -c 5000 /dev/zero | tr "\\0" x'],
      options(5000, 100),
    );
    expect(record.stdout).toMatchObject({ bytes: 5000, truncated: true });
    expect(readFileSync(record.stdout.path, 'utf8')).toBe(
      `${'x'.repeat(100)}\n[log truncated: kept 100 of 5000 bytes]\n`,
    );
  });

  it('records a command that cannot start', async () => {
    const record = await new HostCommandRunner().run('no-such-command-here', [], options());
    expect(record.pid).toBeNull();
    expect(record.spawnError).toContain('ENOENT');
  });

  it('kills the whole process tree of a command that overruns', async () => {
    const record = await new HostCommandRunner({ killGraceMs: 100 }).run(
      'sh',
      ['-c', 'sleep 60 & sleep 60 & wait'],
      options(50),
    );
    expect(record.timedOut).toBe(true);
    expect(record.pid).not.toBeNull();
    await vi.waitFor(() => {
      expect(processGroupAlive(record.pid ?? 0)).toBe(false);
    });
  });

  it('kills with SIGKILL a child that ignores SIGTERM', async () => {
    const record = await new HostCommandRunner({ killGraceMs: 100 }).run(
      'sh',
      ['-c', 'trap "" TERM; sleep 60 & wait; sleep 60'],
      options(50),
    );
    expect(record.timedOut).toBe(true);
    await vi.waitFor(() => {
      expect(processGroupAlive(record.pid ?? 0)).toBe(false);
    });
  });
});
