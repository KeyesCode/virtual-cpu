import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyCommand, CommandRecordSchema } from '@vcpu/research-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunOptions } from './command-runner.js';
import { SANDBOX_IMAGE, sandboxMissing } from '../test-support/sandbox.js';
import { SANDBOX_LABEL, SandboxCommandRunner, type SandboxRunnerOptions } from './sandbox.js';

/**
 * The isolation of the EDA sandbox, on the real image. These need Docker and the image
 * (`pnpm research:sandbox:build`, or EDA_SANDBOX_IMAGE naming another), and skip without them.
 */

const missing = sandboxMissing();
if (missing !== null) console.warn(`Sandbox isolation tests skipped: ${missing}`);

describe.skipIf(missing !== null)('SandboxCommandRunner isolation', { timeout: 120_000 }, () => {
  let scratch: string;
  let baseline: string;
  let workspace: string;
  let out: string;
  let runs = 0;

  const runner = (options: Partial<SandboxRunnerOptions> = {}) =>
    new SandboxCommandRunner({
      image: SANDBOX_IMAGE,
      baselineDir: baseline,
      workspaceDir: workspace,
      outputDir: out,
      ...options,
    });

  const options = (overrides: Partial<RunOptions> = {}): RunOptions => {
    runs += 1;
    return {
      cwd: workspace,
      timeoutMs: 60_000,
      maxLogBytes: 1 << 20,
      stdoutPath: join(out, 'logs', `${String(runs)}.stdout.log`),
      stderrPath: join(out, 'logs', `${String(runs)}.stderr.log`),
      ...overrides,
    };
  };

  /** `sh -c script` in a container: the record and both streams. */
  async function sh(
    script: string,
    using = runner(),
    overrides: Partial<RunOptions> = {},
  ): Promise<{
    record: Awaited<ReturnType<SandboxCommandRunner['run']>>;
    stdout: string;
    stderr: string;
  }> {
    const record = await using.run('sh', ['-c', script], options(overrides));
    expect(() => CommandRecordSchema.parse(record)).not.toThrow();
    const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
    return { record, stdout: read(record.stdout.path), stderr: read(record.stderr.path) };
  }

  const containersLeft = (name: string) =>
    spawnSync(
      'docker',
      ['ps', '--all', '--quiet', '--filter', `label=${SANDBOX_LABEL}`, '--filter', `name=${name}`],
      { encoding: 'utf8' },
    ).stdout.trim();

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'sandbox-isolation-'));
    baseline = join(scratch, 'baseline');
    workspace = join(scratch, 'workspace');
    out = join(scratch, 'out');
    for (const dir of [baseline, workspace, out]) mkdirSync(dir);
    writeFileSync(join(baseline, 'golden.txt'), 'frozen\n');
  });
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('runs a command and records the image it ran in', async () => {
    const { record, stdout } = await sh(`cat ${baseline}/golden.txt; pwd`);
    expect(record).toMatchObject({ exitCode: 0, timedOut: false, spawnError: null });
    expect(stdout).toBe(`frozen\n${workspace}\n`);
    expect(record.sandbox?.imageId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.sandbox?.container).toMatch(/^eda-sandbox-/);
    expect(record.policyViolation).toBeNull();
  });

  it('has no network: DNS and TCP both fail', async () => {
    const dns = await sh('getent hosts example.com');
    expect(dns.record.exitCode).not.toBe(0);
    const tcp = await sh(
      `python3 -c "import socket; socket.create_connection(('1.1.1.1', 53), timeout=3)"`,
    );
    expect(tcp.record.exitCode).not.toBe(0);
    expect(tcp.stderr).toMatch(/Network is unreachable|OSError/);
    // Only loopback: no route at all (the kernel's tunnel stubs may be listed, but are down).
    const routes = await sh('tail -n +2 /proc/net/route; tail -n +1 /proc/net/ipv6_route');
    expect(routes.stdout.split('\n').filter((l) => l !== '' && !/ lo$/.test(l))).toEqual([]);
  });

  it('runs as a non-root user with no capabilities and no privilege escalation', async () => {
    const { stdout } = await sh('id -u; grep -E "^(CapEff|NoNewPrivs):" /proc/self/status');
    const [uid = '', capEff = '', noNewPrivs = ''] = stdout.trim().split('\n');
    expect(uid).not.toBe('0');
    expect(capEff).toMatch(/^CapEff:\s+0+$/);
    expect(noNewPrivs).toMatch(/^NoNewPrivs:\s+1$/);
    const asRoot = await sh('id -u', runner({ user: '0:0' }));
    expect(asRoot.record.spawnError).toContain('non-root');
  });

  it('mounts the baseline read-only', async () => {
    const { record, stderr } = await sh(`touch ${baseline}/x`);
    expect(record.exitCode).not.toBe(0);
    expect(stderr).toMatch(/Read-only file system/);
    expect(existsSync(join(baseline, 'x'))).toBe(false);
  });

  it('lets a command write only to the workspace, the output directory and /tmp', async () => {
    for (const path of ['/x', '/etc/x', '/opt/x', '/opt/sky130hd/x', '/usr/local/bin/x']) {
      const { record } = await sh(`touch ${path}`);
      expect(record.exitCode, path).not.toBe(0);
    }
    const { record } = await sh(
      `touch ${workspace}/w ${out}/o /tmp/t && test ! -e /var/run/docker.sock`,
    );
    expect(record.exitCode).toBe(0);
    expect(existsSync(join(workspace, 'w'))).toBe(true);
    expect(existsSync(join(out, 'o'))).toBe(true);
  });

  it('stops a fork bomb at the process limit', async () => {
    const bomb = [
      'import os, signal',
      'pids = []',
      'try:',
      '    for _ in range(500):',
      '        pid = os.fork()',
      '        if pid == 0:',
      '            signal.pause()',
      '            os._exit(0)',
      '        pids.append(pid)',
      '    print("forked", len(pids))',
      'except OSError:',
      '    print("fork failed after", len(pids))',
      'for pid in pids:',
      '    os.kill(pid, signal.SIGKILL)',
    ].join('\n');
    writeFileSync(join(workspace, 'bomb.py'), bomb);
    const { record, stdout } = await sh('python3 bomb.py', runner({ pidsLimit: 32 }));
    expect(record.exitCode).toBe(0);
    const forked = Number(/^fork failed after (\d+)$/m.exec(stdout)?.[1] ?? NaN);
    expect(forked).toBeLessThan(32);
  });

  it('kills a command at its timeout and leaves no container', async () => {
    const started = Date.now();
    const { record } = await sh('sleep 60', runner(), { timeoutMs: 2000 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(record.timedOut).toBe(true);
    expect(classifyCommand(record)).toBe('timeout');
    await vi.waitFor(
      () => {
        expect(containersLeft(record.sandbox?.container ?? '')).toBe('');
      },
      { timeout: 10_000, interval: 250 },
    );
  });

  it('passes no host environment, and refuses a variable off the allow-list', async () => {
    const secret = 'postgres://research:secret@127.0.0.1/research';
    process.env['DATABASE_URL'] = secret;
    try {
      const { stdout } = await sh('env');
      expect(stdout).not.toContain('DATABASE_URL');
      expect(stdout).not.toContain(secret);
      expect(stdout).toMatch(/^HOME=\/tmp$/m);

      const refused = await sh('env', runner(), { env: { DATABASE_URL: secret } });
      expect(refused.record.spawnError).toContain('DATABASE_URL');
      expect(classifyCommand(refused.record)).toBe('infrastructure-failure');

      const allowed = await sh('echo "$PE_SEED"', runner({ envAllow: ['PE_SEED'] }), {
        env: { PE_SEED: '7' },
      });
      expect(allowed.stdout).toBe('7\n');
    } finally {
      delete process.env['DATABASE_URL'];
    }
  });

  it('fails an output over its size cap as a policy violation and deletes it', async () => {
    const { record } = await sh(
      `head -c 3000000 /dev/zero > ${out}/big.bin`,
      runner({ maxOutputBytes: 1_000_000 }),
    );
    expect(record.exitCode).toBe(0);
    expect(record.policyViolation).toContain('big.bin');
    expect(classifyCommand(record)).toBe('policy-violation');
    expect(existsSync(join(out, 'big.bin'))).toBe(false);
  });

  it('refuses a baseline that holds a credential file', async () => {
    const dirty = join(scratch, 'dirty-baseline');
    mkdirSync(dirty);
    writeFileSync(join(dirty, '.env'), 'RESEARCH_API_TOKEN=x\n');
    const { record } = await sh('true', runner({ baselineDir: dirty }));
    expect(record.spawnError).toContain('.env');
    expect(record.pid).toBeNull();
  });

  it('records a missing image as an infrastructure failure', async () => {
    const { record } = await sh('true', runner({ image: 'silicon-lab/no-such-image:none' }));
    expect(record.spawnError).toContain('research:sandbox:build');
    expect(classifyCommand(record)).toBe('infrastructure-failure');
  });
});
