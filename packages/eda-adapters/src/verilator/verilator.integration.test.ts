import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StageResultSchema } from '@vcpu/research-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HostCommandRunner, processGroupAlive } from '../runner/host-runner.js';
import { SandboxCommandRunner } from '../runner/sandbox.js';
import { SANDBOX_IMAGE, sandboxMissing } from '../test-support/sandbox.js';
import { VerilatorAdapter, type VerilatorRunContext } from './adapter.js';

/**
 * The adapter on the real Project 3 flows, against scratch copies of the RTL. These need the pinned
 * toolchain (`pnpm hardware:setup`), and skip without it.
 */

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const MATMUL = join(REPO, 'hardware', 'accelerators', 'matmul');

function toolchainMissing(): string | null {
  const version = /^OSS_CAD_SUITE_VERSION=(.+)$/m.exec(
    readFileSync(join(REPO, 'hardware', 'toolchain.env'), 'utf8'),
  )?.[1];
  const tools = process.env['VCPU8_TOOLS_DIR'] ?? join(homedir(), '.cache', 'vcpu8');
  const bin = join(tools, `oss-cad-suite-${version ?? '?'}`, 'bin', 'verilator');
  return existsSync(bin) ? null : `${bin} not found: run 'pnpm hardware:setup'`;
}

interface Mutant {
  readonly id: string;
  readonly file: string;
  readonly from: string;
  readonly to: string;
}

/** scripts/mutants.txt: `[id]` then `key: value` lines. */
function readMutants(): Mutant[] {
  const text = readFileSync(join(MATMUL, 'scripts', 'mutants.txt'), 'utf8');
  return [...text.matchAll(/^\[(.+)\]\nfile: (.+)\nwhat: .+\nfrom: (.+)\nto: +(.+)$/gm)].map(
    ([, id = '', file = '', from = '', to = '']) => ({ id, file, from, to }),
  );
}

/** The unmodified RTL through lint, unit and differential: every stage passes. */
async function greenPath(
  adapter: VerilatorAdapter,
  context: VerilatorRunContext,
): Promise<{ unitChecks: number; totals: unknown; lintWarnings: readonly string[] }> {
  const lint = await adapter.lint(context);
  expect(lint.ok, lint.message ?? '').toBe(true);
  expect(lint.outcome).toEqual({ errors: [], warnings: [] });
  expect(lint.toolVersion).toMatch(/^Verilator 5\./);

  const unit = await adapter.unitTestPe(context);
  expect(unit.ok, unit.message ?? '').toBe(true);
  expect(unit.outcome.checks).toBeGreaterThan(0);
  expect(unit.outcome.runs.map((r) => r.seed)).toEqual([1, 7]);
  for (const run of unit.outcome.runs) expect(existsSync(run.vectorFile)).toBe(true);

  const verify = await adapter.differentialVerify(context);
  expect(verify.ok, verify.message ?? '').toBe(true);
  const report = JSON.parse(readFileSync(verify.outcome.reportFile ?? '', 'utf8')) as {
    totals: { cases: number };
  };
  expect(verify.outcome.totals?.cases).toBe(report.totals.cases);
  expect(verify.outcome.totals?.random).toBe(10);
  expect(verify.outcome.firstFailure).toBeNull();
  for (const stage of [lint, unit, verify]) StageResultSchema.parse(stage);
  return {
    unitChecks: unit.outcome.checks,
    totals: verify.outcome.totals,
    lintWarnings: lint.warnings,
  };
}

const missing = toolchainMissing();
if (missing !== null) console.warn(`Verilator integration tests skipped: ${missing}`);

describe.skipIf(missing !== null)('VerilatorAdapter on the real toolchain', () => {
  const adapter = new VerilatorAdapter({ repoRoot: REPO });
  const fastKill = new VerilatorAdapter({
    repoRoot: REPO,
    runner: new HostCommandRunner({ killGraceMs: 200 }),
  });
  let scratch: string;
  let buildBefore: string[];
  let copies = 0;

  /** A candidate workspace (a full copy of matmul without build/) and its output directory. */
  function candidate(edit?: (rtl: string) => void): VerilatorRunContext {
    copies += 1;
    const root = join(scratch, String(copies));
    const hw = join(root, 'ws', 'hardware', 'accelerators', 'matmul');
    cpSync(MATMUL, hw, { recursive: true, filter: (src) => src !== join(MATMUL, 'build') });
    edit?.(join(hw, 'rtl'));
    return {
      workspaceRoot: join(root, 'ws'),
      outDir: join(root, 'out'),
      campaignSeed: 1,
      experimentSeed: 7,
      count: 10,
      timeoutMs: 180_000,
      peRandomClocks: 2000,
    };
  }

  const listBuild = () =>
    existsSync(join(MATMUL, 'build')) ? readdirSync(join(MATMUL, 'build')).sort() : [];
  const edit = (path: string, from: string, to: string) => {
    const text = readFileSync(path, 'utf8');
    expect(text.split(from).length - 1, `${from} in ${path}`).toBe(1);
    writeFileSync(
      path,
      text.replace(from, () => to),
    );
  };

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'verilator-integration-'));
    buildBefore = listBuild();
  });
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
    expect(listBuild()).toEqual(buildBefore);
  });

  it('passes the unmodified RTL, with counts from verify.json', { timeout: 300_000 }, async () => {
    await greenPath(adapter, candidate());
  });

  const mutants = readMutants();

  it('reads every mutant of scripts/mutants.txt', () => {
    expect(mutants.map((m) => m.id)).toContain('pe-sign-extension');
    expect(mutants).toHaveLength(
      readFileSync(join(MATMUL, 'scripts', 'mutants.txt'), 'utf8').match(/^\[.+\]$/gm)?.length ?? 0,
    );
  });

  it.each(mutants)(
    'rejects $id as incorrect, with its failing case',
    { timeout: 300_000 },
    async (mutant) => {
      const context = candidate((rtl) => {
        edit(join(rtl, mutant.file), mutant.from, mutant.to);
      });
      const lint = await adapter.lint(context);
      expect(lint.ok, lint.message ?? '').toBe(true);
      const verify = await adapter.differentialVerify(context);
      expect(verify.ok).toBe(false);
      expect(verify.failureClass, verify.message ?? '').toBe('incorrect-design');
      const first = verify.outcome.firstFailure;
      expect(first?.reason).toBeTruthy();
      expect(first?.savedDir?.startsWith(context.outDir)).toBe(true);
      expect(first?.caseFile).toBeTruthy();
      expect(first?.files.length).toBeGreaterThan(0);
      for (const file of first?.files ?? []) expect(existsSync(file)).toBe(true);
    },
  );

  it('fails the PE unit test on a PE mutant', { timeout: 300_000 }, async () => {
    const mutant = mutants.find((m) => m.id === 'pe-sign-extension');
    const context = candidate((rtl) => {
      edit(join(rtl, 'processing_element.sv'), mutant?.from ?? '', mutant?.to ?? '');
    });
    const unit = await adapter.unitTestPe(context);
    expect(unit.failureClass, unit.message ?? '').toBe('incorrect-design');
    expect(unit.outcome.firstFailure?.line).toBeGreaterThan(0);
    expect(existsSync(unit.outcome.firstFailure?.vectorFile ?? '')).toBe(true);
  });

  it('rejects a PE with a renamed port as unsupported', { timeout: 300_000 }, async () => {
    const context = candidate((rtl) => {
      const pe = join(rtl, 'processing_element.sv');
      const text = readFileSync(pe, 'utf8');
      writeFileSync(pe, text.replaceAll(/\bacc\b/g, 'acc_q'));
    });
    expect((await adapter.lint(context)).failureClass).toBe('unsupported-design');
    expect((await adapter.unitTestPe(context)).failureClass).toBe('unsupported-design');
    expect((await adapter.differentialVerify(context)).failureClass).toBe('unsupported-design');
  });

  it('rejects a PE with a narrowed port as unsupported', { timeout: 300_000 }, async () => {
    const context = candidate((rtl) => {
      edit(
        join(rtl, 'processing_element.sv'),
        'output logic signed [ACC_W-1:0]  acc',
        'output logic signed [ACC_W-2:0]  acc',
      );
    });
    const lint = await adapter.lint(context);
    expect(lint.failureClass, JSON.stringify(lint.outcome)).toBe('unsupported-design');
  });

  it('keeps going past a warning, which is recorded', { timeout: 300_000 }, async () => {
    const mutant = mutants.find((m) => m.id === 'pe-clear-ignored');
    const context = candidate((rtl) => {
      edit(join(rtl, 'processing_element.sv'), mutant?.from ?? '', mutant?.to ?? '');
    });
    const lint = await adapter.lint(context);
    expect(lint.ok).toBe(true);
    expect(lint.warnings.join('\n')).toContain('UNUSEDSIGNAL');
  });

  it('writes a waveform of a failing case', { timeout: 300_000 }, async () => {
    const mutant = mutants.find((m) => m.id === 'pe-sign-extension');
    const context = candidate((rtl) => {
      edit(join(rtl, 'processing_element.sv'), mutant?.from ?? '', mutant?.to ?? '');
    });
    const verify = await adapter.differentialVerify(context);
    const wave = await adapter.wave(context, verify.outcome.firstFailure?.caseFile ?? '');
    expect(wave.ok, wave.message ?? '').toBe(true);
    expect(wave.outcome.waveFile?.startsWith(context.outDir)).toBe(true);
    expect(wave.outcome.bytes).toBeGreaterThan(0);
  });

  it('reports a 1 ms timeout and leaves no process group', { timeout: 60_000 }, async () => {
    const verify = await fastKill.differentialVerify({ ...candidate(), timeoutMs: 1 });
    expect(verify.failureClass).toBe('timeout');
    await vi.waitFor(() => {
      for (const { pid } of verify.commands) {
        expect(pid !== null && processGroupAlive(pid)).toBe(false);
      }
    });
  });

  it('kills a verify run in flight, simulators included', { timeout: 120_000 }, async () => {
    const context = candidate();
    await fastKill.differentialVerify({ ...context, count: 0 });
    // Far more cases than fit, so the runners are still being started when the time runs out.
    const verify = await fastKill.differentialVerify({
      ...context,
      count: 100_000,
      timeoutMs: 5000,
    });
    expect(verify.failureClass).toBe('timeout');
    expect(verify.commands.at(-1)?.command).toBe('pnpm');
    expect(verify.commands.at(-1)?.timedOut).toBe(true);
    await vi.waitFor(() => {
      for (const { pid } of verify.commands) {
        expect(pid !== null && processGroupAlive(pid)).toBe(false);
      }
      // Every simulator path holds the output directory, so this also finds any that left the group.
      expect(spawnSync('pgrep', ['-f', context.outDir]).status).toBe(1);
    });
  });

  it('leaves the Project 3 tree in the repository untouched', () => {
    expect(listBuild()).toEqual(buildBefore);
  });
});

const sandboxSkip = sandboxMissing(REPO);
if (sandboxSkip !== null) console.warn(`Verilator sandbox tests skipped: ${sandboxSkip}`);

describe.skipIf(sandboxSkip !== null)('VerilatorAdapter in the EDA sandbox image', () => {
  let scratch: string;

  /** A candidate copy of matmul and its output directory under `name`. */
  function candidate(name: string): VerilatorRunContext {
    const root = join(scratch, name);
    cpSync(MATMUL, join(root, 'ws', 'hardware', 'accelerators', 'matmul'), {
      recursive: true,
      filter: (src) => src !== join(MATMUL, 'build'),
    });
    return {
      workspaceRoot: join(root, 'ws'),
      outDir: join(root, 'out'),
      campaignSeed: 1,
      experimentSeed: 7,
      count: 10,
      // amd64 under emulation on Apple Silicon compiles the simulators several times slower.
      timeoutMs: 900_000,
      peRandomClocks: 2000,
    };
  }

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'verilator-sandbox-'));
  });
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it(
    'passes the unmodified RTL with the same counts as the host run',
    { timeout: 3_600_000 },
    async () => {
      const context = candidate('sandbox');
      const runner = new SandboxCommandRunner({
        image: SANDBOX_IMAGE,
        baselineDir: REPO,
        workspaceDir: context.workspaceRoot,
        outputDir: context.outDir,
      });
      const adapter = new VerilatorAdapter({ repoRoot: REPO, runner });
      const sandboxed = await greenPath(adapter, context);

      if (missing !== null) return;
      const host = await greenPath(new VerilatorAdapter({ repoRoot: REPO }), candidate('host'));
      expect(sandboxed).toEqual(host);
    },
  );
});
