import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandRecord } from '@vcpu/research-core';
import { parseLtp } from '@vcpu/rtl-tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandRunner, RunOptions } from '../runner/command-runner.js';
import { YosysAdapter, type SynthesisContext } from './adapter.js';
import {
  classifyYosysLog,
  designCells,
  memoryBits,
  mulCells,
  parseLibertyStat,
  parseStat,
} from './parsers.js';
import {
  buildGenericScript,
  buildMappedScript,
  matmulRtlSources,
  peDesign,
  SKY130HD_DONT_USE,
  type SynthesisDesign,
} from './script.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

const PE: SynthesisDesign = {
  top: 'processing_element',
  params: { DATA_W: 8, ACC_W: 32 },
  sources: ['/rtl/matmul_pkg.sv', '/rtl/processing_element.sv'],
};

describe('Yosys scripts', () => {
  it('keeps the steps of synth/generic.ys, with the top parameterised', () => {
    const committed = readFileSync(
      join(REPO, 'hardware', 'accelerators', 'matmul', 'synth', 'generic.ys'),
      'utf8',
    );
    const steps = committed
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => line.replaceAll('matmul_top', PE.top));
    expect(buildGenericScript(PE).steps.trimEnd().split('\n')).toEqual(steps);
  });

  it('runs the steps through the script command, as Project 3 does', () => {
    expect(buildGenericScript(PE).entry).toBe(
      'read_verilog -sv -D SYNTHESIS /rtl/matmul_pkg.sv /rtl/processing_element.sv\n' +
        'chparam -set DATA_W 8 -set ACC_W 32 processing_element\n' +
        'script generic.ys\n',
    );
  });

  it('leaves out chparam for a design with no parameters', () => {
    expect(buildGenericScript({ ...PE, params: {} }).entry).not.toContain('chparam');
  });

  it('maps in the order of the ticket, after the structural gates', () => {
    const { steps } = buildMappedScript(PE, '/lib/hd.lib', ['x_*']);
    const lines = steps.trimEnd().split('\n');
    expect(lines.slice(0, 2)).toEqual(['hierarchy -check -top processing_element', 'proc']);
    expect(lines.slice(4)).toEqual([
      'synth -top processing_element',
      'tee -q -o mapped.ff.stat.json stat -json',
      'dfflibmap -dont_use x_* -liberty /lib/hd.lib',
      'abc -dont_use x_* -liberty /lib/hd.lib',
      'opt_clean',
      'tee -q -o mapped.stat.json stat -liberty /lib/hd.lib -json',
      'write_verilog -noattr mapped.v',
      'write_json mapped.json',
    ]);
  });

  it('rejects what would change the meaning of a script', () => {
    expect(() => buildGenericScript({ ...PE, top: 'pe; shell rm' })).toThrow(/module or parameter/);
    expect(() => buildGenericScript({ ...PE, params: { 'A;B': 1 } })).toThrow(/parameter/);
    expect(() => buildGenericScript({ ...PE, params: { A: 1.5 } })).toThrow(/integer/);
    expect(() => buildGenericScript({ ...PE, sources: ['/a b.sv'] })).toThrow(/path/);
    expect(() => buildGenericScript({ ...PE, sources: [] })).toThrow(/source/);
    expect(() => buildMappedScript(PE, '/a;b.lib', [])).toThrow(/path/);
  });

  it('lists the RTL as the Makefile does: packages first', () => {
    const sources = matmulRtlSources(REPO).map((file) => file.split('/').pop());
    expect(sources[0]).toBe('matmul_pkg.sv');
    expect(sources.slice(1)).toEqual([...sources.slice(1)].sort());
    expect(sources).toContain('processing_element.sv');
    expect(peDesign(REPO).params).toEqual({ DATA_W: 8, ACC_W: 32 });
  });
});

describe('Yosys parsers', () => {
  const top = 'processing_element';

  it('reads a PE run', () => {
    const stat = parseStat(fixture('pe-generic.stat.json'), top);
    expect(designCells(stat)).toMatchObject({ cells: 1008, flipFlops: 50, memories: 0 });
    expect(mulCells(parseStat(fixture('pe-generic.mul.stat.json'), top))).toBe(1);
    expect(designCells(parseStat(fixture('pe-generic.gates.stat.json'), top)).combinational).toBe(
      973,
    );
    expect(parseLtp(fixture('pe-generic.ltp.txt')).length).toBe(64);
    expect(memoryBits(fixture('pe-generic.memories.json'), stat, top)).toBe(0);
  });

  it('counts a hierarchy: no submodule instances, every memory', () => {
    const stat = parseStat(fixture('matmul-4x4.stat.json'), 'matmul_top');
    expect(designCells(stat)).toMatchObject({ cells: 18130, flipFlops: 1049, memories: 9 });
    expect(Object.keys(designCells(stat).byType).filter((t) => t.includes('paramod'))).toEqual([]);
    expect(memoryBits(fixture('matmul-4x4.memories.json'), stat, 'matmul_top')).toBe(196608);
  });

  it('multiplies memory bits by the instances of their module', () => {
    const block = (types: Record<string, number>) => ({
      num_cells: 1,
      num_cells_by_type: types,
    });
    const stat = {
      creator: 'Yosys',
      design: block({}),
      modules: {
        '\\top': block({ '\\bank': 3 }),
        '\\bank': block({ $mem_v2: 1 }),
      },
    };
    const memories = {
      modules: {
        '\\bank': {
          cells: { m: { type: '$mem_v2', parameters: { SIZE: '10000', WIDTH: '1000' } } },
        },
      },
    };
    expect(memoryBits(JSON.stringify(memories), stat, 'top')).toBe(3 * 16 * 8);
  });

  it('reads the liberty area', () => {
    const stat = parseLibertyStat(fixture('pe-mapped.stat.json'), top);
    expect(stat.design.area).toBeGreaterThan(0);
    expect(Object.keys(designCells(stat).byType).every((t) => t.startsWith('sky130'))).toBe(true);
  });

  it('fails loudly on a stat it does not recognise', () => {
    expect(() => parseStat(fixture('pe-generic.stat.json'), 'other')).toThrow(/no module other/);
    expect(() => parseStat('{}', top)).toThrow();
    expect(() => parseStat('not json', top)).toThrow();
    // A generic stat has no area, and a renamed field must not read as 0.
    expect(() => parseLibertyStat(fixture('pe-generic.stat.json'), top)).toThrow();
  });
});

describe('classifyYosysLog', () => {
  const failed = (log: string) => classifyYosysLog(log);

  it.each([
    ['latch', 'ERROR: Assertion failed: selection is not empty: t:$dlatch t:$adlatch t:$dlatchsr'],
    ['latch', "ERROR: Latch inferred for signal `\\t.\\l' from always_comb process `\\t.$x'."],
    ['hierarchy', "ERROR: Module `\\nope' referenced in module `\\t' in cell `\\u' is not part of"],
    ['hierarchy', "ERROR: Module `s' referenced in module `t' in cell `u' does not have a port"],
    ['elaboration', "pe.sv:1: ERROR: syntax error, unexpected ';', expecting ')'"],
    ['elaboration', 'pe.sv:1.2-3.4: ERROR: Unsupported expression'],
  ])('reads a %s failure as the design', (gate, line) => {
    const failure = failed(`some output\n${line}\n`);
    expect(failure.failureClass).toBe('unsupported-design');
    expect(failure.gates).toEqual([gate]);
  });

  it.each([
    ['loop', 'Warning: found logic loop in module t:'],
    ['multi-driver', 'Warning: multiple conflicting drivers for t.\\b:'],
    ['undriven', 'Warning: Wire t.\\n is used but has no driver.'],
    ['check', 'Warning: some check Yosys adds later.'],
  ])('names the %s problem of check -assert', (gate, warning) => {
    const log = `${warning}\nERROR: Found 1 problems in 'check -assert'.\n`;
    expect(failed(log)).toMatchObject({ failureClass: 'unsupported-design', gates: [gate] });
  });

  it('names every problem of one check', () => {
    const log = [
      'Warning: found logic loop in module t:',
      'Warning: Wire t.\\n is used but has no driver.',
      "ERROR: Found 2 problems in 'check -assert'.",
    ].join('\n');
    expect(failed(log).gates).toEqual(['loop', 'undriven']);
  });

  it('does not blame the design for a tool or a missing file', () => {
    expect(failed("ERROR: File `/no/file.sv' not found or is a directory")).toMatchObject({
      failureClass: 'infrastructure-failure',
      gates: [],
    });
    expect(failed('ERROR: ABC: execution of command "x" failed: return code 1')).toMatchObject({
      failureClass: 'tool-failure',
      gates: [],
    });
    expect(failed('script.ys:3: ERROR: No such command: nope')).toMatchObject({
      failureClass: 'tool-failure',
      gates: [],
    });
    expect(failed('Segmentation fault\n')).toMatchObject({ failureClass: 'tool-failure' });
  });
});

type Script = (
  args: readonly string[],
  options: RunOptions,
) => Partial<Pick<CommandRecord, 'exitCode' | 'timedOut' | 'spawnError'>> & { stdout?: string };

/** A runner that runs nothing: `script` writes what the command would have written. */
function scripted(script: Script): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (command, args, options) => {
      calls.push([command, ...args]);
      const { stdout = '', ...ending } = script(args, options);
      mkdirSync(dirname(options.stdoutPath), { recursive: true });
      writeFileSync(options.stdoutPath, stdout);
      writeFileSync(options.stderrPath, '');
      const now = new Date().toISOString();
      return Promise.resolve({
        command,
        args: [...args],
        cwd: options.cwd,
        pid: 1,
        startedAt: now,
        finishedAt: now,
        wallTimeMs: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
        spawnError: null,
        stdout: { path: options.stdoutPath, bytes: stdout.length, truncated: false },
        stderr: { path: options.stderrPath, bytes: 0, truncated: false },
        ...ending,
      });
    },
  };
}

const VERSION = 'Yosys 0.70+145 (git sha1 a31d95ea0, Release, Clang 21.1.8)';

describe('YosysAdapter', () => {
  let root: string;
  let context: SynthesisContext;
  let liberty: string;

  /** Yosys, as a script: `outputs` are written into the run's directory. */
  const yosys = (outputs: Record<string, string>, log = '', exitCode = 0) =>
    scripted((args, options) => {
      if (args[0] === '-V') return { stdout: `${VERSION}\n` };
      writeFileSync(join(options.cwd, 'yosys.log'), log);
      for (const [file, text] of Object.entries(outputs)) {
        writeFileSync(join(options.cwd, file), text);
      }
      return { exitCode };
    });

  const adapter = (runner: CommandRunner) =>
    new YosysAdapter({ repoRoot: root, runner, yosys: '/bin/yosys' });

  const genericOutputs = {
    'generic.stat.json': fixture('pe-generic.stat.json'),
    'generic.mul.stat.json': fixture('pe-generic.mul.stat.json'),
    'generic.gates.stat.json': fixture('pe-generic.gates.stat.json'),
    'generic.ltp.txt': fixture('pe-generic.ltp.txt'),
    'generic.memories.json': fixture('pe-generic.memories.json'),
  };
  const mappedOutputs = {
    'mapped.stat.json': fixture('pe-mapped.stat.json'),
    'mapped.ff.stat.json': fixture('pe-mapped.ff.stat.json'),
    'mapped.v': 'module processing_element; endmodule\n',
  };
  const COMBINATIONAL = 'ABC: Warning: The network is combinational (run "fraig").\n';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'yosys-adapter-'));
    const synth = join(root, 'hardware', 'accelerators', 'matmul', 'synth');
    mkdirSync(synth, { recursive: true });
    writeFileSync(join(synth, 'warnings.allow'), '# reviewed\n^ABC: Warning: The network\n');
    liberty = join(root, 'cells.lib');
    writeFileSync(liberty, 'library (cells) {}\n');
    context = { design: PE, outDir: join(root, 'out'), timeoutMs: 1000 };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports a generic run from its JSON, never area', async () => {
    const runner = yosys(genericOutputs, COMBINATIONAL);
    const result = await adapter(runner).synthesizeGeneric(context);

    expect(result).toMatchObject({
      stage: 'synth-generic',
      ok: true,
      failureClass: null,
      toolVersion: 'Yosys 0.70+145 (git sha1 a31d95ea0)',
    });
    const report = result.outcome;
    expect(report.cells).toMatchObject({ value: 1008, unit: 'cells', provenance: 'measured' });
    expect(report.flipFlops).toMatchObject({ value: 50 });
    expect(report.mulCells).toMatchObject({ value: 1 });
    expect(report.abstractGates).toMatchObject({ value: 973 });
    expect(report.logicDepthGates).toMatchObject({ value: 64, method: 'yosys-ltp' });
    expect(report.areaUm2.provenance).toBe('unavailable');
    expect(report.gates.every((gate) => gate.status === 'passed')).toBe(true);
    expect(report.warnings[0]?.allowedBy).toBe('^ABC: Warning: The network');

    expect(runner.calls[1]).toEqual(['/bin/yosys', '-q', '-l', 'yosys.log', '-s', 'script.ys']);
    const dir = join(context.outDir, 'generic');
    expect(readFileSync(join(dir, 'script.ys'), 'utf8')).toContain('script generic.ys');
    const artifact = report.artifacts.find((a) => a.path === join(dir, 'generic.ys'));
    expect(artifact?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('starts from an empty directory, so no report is left over', async () => {
    const dir = join(context.outDir, 'generic');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'generic.stat.json'), fixture('pe-generic.stat.json'));
    const result = await adapter(yosys({})).synthesizeGeneric(context);
    expect(result).toMatchObject({ ok: false, failureClass: 'tool-failure' });
    expect(result.message).toMatch(/unreadable Yosys output/);
  });

  it('fails a design on a failed gate, and measures nothing', async () => {
    const log =
      'Warning: Latch inferred for signal\nERROR: Assertion failed: selection is not empty: t:$dlatch\n';
    const result = await adapter(yosys({}, log, 1)).synthesizeGeneric(context);
    expect(result).toMatchObject({ ok: false, failureClass: 'unsupported-design' });
    expect(result.message).toMatch(/latch gate/);
    expect(result.outcome.gates).toContainEqual({ name: 'latch', status: 'failed' });
    expect(result.outcome.gates).toContainEqual({ name: 'hierarchy', status: 'unknown' });
    expect(result.outcome.cells.provenance).toBe('unavailable');
  });

  it('fails a design on a warning nobody reviewed, keeping its numbers', async () => {
    const log = `${COMBINATIONAL}Warning: something new.\n`;
    const result = await adapter(yosys(genericOutputs, log)).synthesizeGeneric(context);
    expect(result).toMatchObject({ ok: false, failureClass: 'unsupported-design' });
    expect(result.message).toContain('Warning: something new.');
    expect(result.outcome.gates).toContainEqual({ name: 'warnings', status: 'failed' });
    expect(result.outcome.gates).toContainEqual({ name: 'latch', status: 'passed' });
    expect(result.outcome.cells).toMatchObject({ value: 1008 });
  });

  it('reports a missing module as a tool failure and keeps the raw file', async () => {
    const outputs = { ...genericOutputs, 'generic.stat.json': '{"creator":"y","modules":{}}' };
    const result = await adapter(yosys(outputs)).synthesizeGeneric(context);
    expect(result).toMatchObject({ ok: false, failureClass: 'tool-failure' });
    expect(result.outcome.artifacts.map((a) => a.path)).toContain(
      join(context.outDir, 'generic', 'generic.stat.json'),
    );
  });

  it('separates a crash, a timeout and a missing binary', async () => {
    const crash = await adapter(yosys({}, 'halfway\n', 139)).synthesizeGeneric(context);
    expect(crash).toMatchObject({ ok: false, failureClass: 'tool-failure' });
    expect(crash.message).toMatch(/exited 139.*no ERROR line/);

    const slow = scripted((args) =>
      args[0] === '-V' ? { stdout: VERSION } : { exitCode: null, timedOut: true },
    );
    expect(await adapter(slow).synthesizeGeneric(context)).toMatchObject({
      failureClass: 'timeout',
    });

    const absent = scripted(() => ({ exitCode: null, spawnError: 'spawn yosys ENOENT' }));
    const missing = await adapter(absent).synthesizeGeneric(context);
    expect(missing).toMatchObject({ failureClass: 'infrastructure-failure' });
    expect(missing.message).toMatch(/hardware:setup/);
    expect(absent.calls).toHaveLength(1);
  });

  it('calls a missing allowlist infrastructure, not a design failure', async () => {
    rmSync(join(root, 'hardware'), { recursive: true });
    const result = await adapter(yosys(genericOutputs)).synthesizeGeneric(context);
    expect(result).toMatchObject({ ok: false, failureClass: 'infrastructure-failure' });
  });

  it('marks area unavailable without a liberty file, and runs nothing', async () => {
    const runner = yosys({});
    const result = await adapter(runner).synthesizeMapped(context);

    expect(result.ok).toBe(true);
    expect(result.warnings[0]).toMatch(/no liberty file/);
    expect(runner.calls).toEqual([]);
    const { areaUm2 } = result.outcome;
    expect(areaUm2.provenance).toBe('unavailable');
    expect(areaUm2).not.toHaveProperty('value');
    expect(JSON.stringify(areaUm2)).not.toMatch(/\b0\b/);
    expect(result.outcome.netlistFile).toBeNull();
  });

  it('reports a mapped run: estimated area, library cells and the netlist', async () => {
    const log = `${COMBINATIONAL}ABC: Warning: Detected 9 multi-output cells (for example, "x__fa_1").\n`;
    const runner = yosys(mappedOutputs, log);
    const result = await adapter(runner).synthesizeMapped({ ...context, liberty });

    expect(result).toMatchObject({ stage: 'synth-mapped', ok: true });
    const report = result.outcome;
    expect(report.areaUm2).toMatchObject({
      unit: 'um^2',
      provenance: 'estimated',
      method: 'yosys-stat-liberty',
      tool: 'yosys',
    });
    expect((report.areaUm2 as { value: number }).value).toBeGreaterThan(0);
    expect(report.flipFlops).toMatchObject({ value: 50 });
    expect(report.mappedCellsByType?.['sky130_fd_sc_hd__dfxtp_1']).toBe(50);
    expect(report.netlistFile).toBe(join(context.outDir, 'mapped', 'mapped.v'));
    expect(existsSync(report.netlistFile ?? '')).toBe(true);
    expect(report.liberty).toMatchObject({ path: liberty, dontUse: SKY130HD_DONT_USE });
    expect(report.liberty?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.mulCells.provenance).toBe('unavailable');
  });

  it('gives no area when a cell stayed unmapped: it would be too low', async () => {
    const stat = JSON.parse(fixture('pe-mapped.stat.json')) as {
      design: { num_cells_by_type: Record<string, number> };
    };
    stat.design.num_cells_by_type['$_DLATCH_P_'] = 1;
    const outputs = { ...mappedOutputs, 'mapped.stat.json': JSON.stringify(stat) };
    const result = await adapter(yosys(outputs)).synthesizeMapped({ ...context, liberty });
    expect(result).toMatchObject({ ok: false, failureClass: 'unsupported-design' });
    expect(result.outcome.gates).toContainEqual({ name: 'unmapped-cells', status: 'failed' });
    expect(result.outcome.areaUm2.provenance).toBe('unavailable');
  });

  it('calls a named but absent liberty file infrastructure, not a missing input', async () => {
    const runner = yosys({});
    const result = await adapter(runner).synthesizeMapped({
      ...context,
      liberty: join(root, 'no.lib'),
    });
    expect(result).toMatchObject({ ok: false, failureClass: 'infrastructure-failure' });
    expect(result.outcome.areaUm2.provenance).toBe('unavailable');
    expect(runner.calls).toEqual([]);
  });

  it('rejects an outDir inside the Project 3 tree', async () => {
    const outDir = join(root, 'hardware', 'accelerators', 'matmul', 'build');
    await expect(adapter(yosys({})).synthesizeGeneric({ ...context, outDir })).rejects.toThrow(
      /outDir/,
    );
  });
});
