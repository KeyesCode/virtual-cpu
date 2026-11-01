import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CommandRecord } from '@vcpu/research-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandRunner, RunOptions } from '../runner/command-runner.js';
import { HostCommandRunner, processGroupAlive } from '../runner/host-runner.js';
import { VerilatorAdapter, type VerilatorRunContext } from './adapter.js';

type Script = (
  command: string,
  args: readonly string[],
  options: RunOptions,
) => {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};

/** A runner that runs nothing: each command's result comes from `script`. */
function scripted(script: Script): CommandRunner {
  return {
    run: (command, args, options) => {
      const { exitCode = 0, stdout = '', stderr = '' } = script(command, args, options);
      mkdirSync(dirname(options.stdoutPath), { recursive: true });
      writeFileSync(options.stdoutPath, stdout);
      writeFileSync(options.stderrPath, stderr);
      const now = new Date().toISOString();
      const record: CommandRecord = {
        command,
        args: [...args],
        cwd: options.cwd,
        pid: 1,
        startedAt: now,
        finishedAt: now,
        wallTimeMs: 1,
        exitCode,
        signal: null,
        timedOut: false,
        spawnError: null,
        stdout: { path: options.stdoutPath, bytes: stdout.length, truncated: false },
        stderr: { path: options.stderrPath, bytes: stderr.length, truncated: false },
      };
      return Promise.resolve(record);
    },
  };
}

describe('VerilatorAdapter', () => {
  let outDir: string;
  let context: VerilatorRunContext;
  const repoRoot = '/repo';

  /** Answers tools-check by writing tool-versions.json, as the Makefile would. */
  const tools = (
    verilator: { path: string; version: string } | null,
    path: string | null = '/t',
  ) => {
    writeFileSync(
      join(outDir, 'build', 'tool-versions.json'),
      JSON.stringify({
        toolchain: { name: 'oss-cad-suite', pinnedVersion: '2026-10-16', path },
        tools: { verilator },
      }),
    );
  };
  const pinned = { path: '/t/verilator', version: 'Verilator 5.053' };

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'verilator-adapter-'));
    mkdirSync(join(outDir, 'build'));
    context = {
      workspaceRoot: '/ws',
      outDir,
      campaignSeed: 1,
      experimentSeed: 2,
      count: 4,
      timeoutMs: 5000,
    };
  });
  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('runs make in the candidate copy with the repository and the build directory overridden', async () => {
    tools(pinned);
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const adapter = new VerilatorAdapter({
      repoRoot,
      runner: scripted((_, args, { cwd }) => {
        calls.push({ args, cwd });
        return {};
      }),
    });
    const lint = await adapter.lint(context);
    expect(lint.ok).toBe(true);
    expect(lint.toolVersion).toBe('Verilator 5.053');
    expect(calls).toEqual([
      {
        cwd: '/ws/hardware/accelerators/matmul',
        args: [
          'lint',
          'REPO_ROOT=/repo',
          `BUILD_DIR=${join(outDir, 'build')}`,
          'ROWS=4',
          'VERILATOR=$(TOOL_BIN)verilator -Wno-fatal',
        ],
      },
    ]);
  });

  it('refuses to run on the repository itself or to write into its Project 3 tree', async () => {
    const adapter = new VerilatorAdapter({ repoRoot, runner: scripted(() => ({})) });
    await expect(adapter.lint({ ...context, workspaceRoot: '/repo' })).rejects.toThrow(
      'candidate copy',
    );
    await expect(
      adapter.lint({ ...context, outDir: '/repo/hardware/accelerators/matmul/build/x' }),
    ).rejects.toThrow('outDir');
  });

  it('reports a missing toolchain as infrastructure, with the install hint', async () => {
    const adapter = new VerilatorAdapter({
      repoRoot,
      runner: scripted(() => {
        tools(null, null);
        return { exitCode: 2 };
      }),
    });
    const lint = await adapter.lint(context);
    expect(lint.failureClass).toBe('infrastructure-failure');
    expect(lint.message).toContain('pnpm hardware:setup');
  });

  it('warns when Verilator is not the pinned one', async () => {
    tools(pinned, null);
    const adapter = new VerilatorAdapter({ repoRoot, runner: scripted(() => ({})) });
    const lint = await adapter.lint(context);
    expect(lint.ok).toBe(true);
    expect(lint.warnings[0]).toContain('not the pinned OSS CAD Suite');
  });

  it('records a warning and keeps the stage ok', async () => {
    tools(pinned);
    const adapter = new VerilatorAdapter({
      repoRoot,
      runner: scripted(() => ({
        stderr: "%Warning-UNUSEDSIGNAL: /ws/rtl/pe.sv:23:36: Signal is not used: 'clear'\n",
      })),
    });
    const lint = await adapter.lint(context);
    expect(lint.ok).toBe(true);
    expect(lint.warnings).toEqual(["UNUSEDSIGNAL pe.sv:23: Signal is not used: 'clear'"]);
  });

  it('rejects an interface change that only warns', async () => {
    tools(pinned);
    const adapter = new VerilatorAdapter({
      repoRoot,
      runner: scripted(() => ({
        stderr:
          "%Warning-PINMISSING: /ws/rtl/systolic_array.sv:130:9: Instance has missing pin: 'x'\n",
      })),
    });
    expect((await adapter.lint(context)).failureClass).toBe('unsupported-design');
  });

  it('reports a failure that names no design error as a tool failure', async () => {
    tools(pinned);
    const adapter = new VerilatorAdapter({
      repoRoot,
      runner: scripted(() => ({ exitCode: 2, stderr: 'make: *** [lint] Segmentation fault\n' })),
    });
    expect((await adapter.lint(context)).failureClass).toBe('tool-failure');
  });

  it('runs the unit test once per seed and sums the checks', async () => {
    tools(pinned);
    const seeds: (string | undefined)[] = [];
    const adapter = new VerilatorAdapter({
      repoRoot,
      runner: scripted((_, args) => {
        seeds.push(args.find((a) => a.startsWith('PE_SEED=')));
        return { stdout: 'tb_processing_element: PASS (100 checks, 20 random clocks, seed 1)\n' };
      }),
    });
    const unit = await adapter.unitTestPe({ ...context, peRandomClocks: 20 });
    expect(seeds).toEqual(['PE_SEED=1', 'PE_SEED=2']);
    expect(unit.ok).toBe(true);
    expect(unit.outcome.checks).toBe(200);
    expect(unit.outcome.runs.map((r) => r.vectorFile)).toEqual([
      join(outDir, 'unit', 'seed-1', 'pe.vec'),
      join(outDir, 'unit', 'seed-2', 'pe.vec'),
    ]);
  });

  it('classifies a mismatch despite the testbench stop that follows it', async () => {
    tools(pinned);
    const adapter = new VerilatorAdapter({
      repoRoot,
      runner: scripted(() => ({
        exitCode: 2,
        stdout: [
          "MISMATCH line 42 (segment 'clear'): rst=0: expected acc=0, got acc=7",
          '[28] %Fatal: tb.sv:189: Assertion failed in tb: tb_processing_element: 3 of 100 checks failed',
          '%Error: /ws/tb/unit/tb.sv:189: Verilog $stop',
        ].join('\n'),
      })),
    });
    const unit = await adapter.unitTestPe(context);
    expect(unit.failureClass).toBe('incorrect-design');
    expect(unit.outcome.firstFailure).toMatchObject({ seed: 1, line: 42, failedChecks: 3 });
    expect(unit.outcome.runs).toHaveLength(1);
  });

  it('does not pass a unit test whose make failed after the PASS line', async () => {
    tools(pinned);
    const adapter = new VerilatorAdapter({
      repoRoot,
      runner: scripted(() => ({
        exitCode: 2,
        stdout: 'tb_processing_element: PASS (100 checks, 20 random clocks, seed 1)\n',
        stderr: 'test-pe-corrupt: the testbench passed a corrupted vector\n',
      })),
    });
    expect((await adapter.unitTestPe(context)).failureClass).toBe('tool-failure');
  });

  it('reports verify without a report as a tool failure, whatever the console said', async () => {
    tools(pinned);
    const adapter = new VerilatorAdapter({
      repoRoot,
      runner: scripted((command) =>
        command === 'pnpm' ? { exitCode: 2, stdout: 'verify: PASS, 42/42 cases\n' } : {},
      ),
    });
    const verify = await adapter.differentialVerify(context);
    expect(verify.failureClass).toBe('tool-failure');
    expect(verify.outcome.totals).toBeNull();
  });

  it('reports an unreadable verify.json as a tool failure', async () => {
    tools(pinned);
    const adapter = new VerilatorAdapter({
      repoRoot,
      runner: scripted((command, args) => {
        if (command === 'pnpm') {
          const reports = args[args.indexOf('--reports') + 1] ?? '';
          mkdirSync(reports, { recursive: true });
          writeFileSync(join(reports, 'verify.json'), '{"kind":"matmul-verify"');
        }
        return {};
      }),
    });
    const verify = await adapter.differentialVerify(context);
    expect(verify.failureClass).toBe('tool-failure');
    expect(verify.message).toContain('unreadable verify.json');
  });

  it('times out on the verify stage and leaves no process behind', async () => {
    tools(pinned);
    const host = new HostCommandRunner({ killGraceMs: 100 });
    const pids: number[] = [];
    // Stands in for the real tree: a group of a shell and the "simulators" it started.
    const runner: CommandRunner = {
      run: async (_command, _args, options) => {
        const record = await host.run('sh', ['-c', 'sleep 60 & sleep 60 & wait'], {
          ...options,
          cwd: outDir,
        });
        if (record.pid !== null) pids.push(record.pid);
        return record;
      },
    };
    const verify = await new VerilatorAdapter({ repoRoot, runner }).differentialVerify({
      ...context,
      timeoutMs: 1,
    });
    expect(verify.failureClass).toBe('timeout');
    expect(verify.commands[0]?.timedOut).toBe(true);
    expect(pids).toHaveLength(1);
    await vi.waitFor(() => {
      expect(pids.some(processGroupAlive)).toBe(false);
    });
  });
});
