import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { arch, homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StageResultSchema } from '@vcpu/research-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { YosysAdapter } from './adapter.js';
import { matmulTopDesign, peDesign, type SynthesisDesign } from './script.js';

/**
 * The adapter on the real Yosys and the committed RTL. These need the pinned toolchain
 * (`pnpm hardware:setup`) and skip without it. The liberty test also needs the network the first time:
 * it downloads the sky130hd library into the temporary directory, and skips when offline.
 */

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const MATMUL = join('hardware', 'accelerators', 'matmul');

/** The same file for any host: the sandbox image will vendor it under hardware/asic/sky130hd/. */
const LIBERTY_NAME = 'sky130_fd_sc_hd__tt_025C_1v80.lib';
const LIBERTY_URL = `https://raw.githubusercontent.com/The-OpenROAD-Project/OpenROAD-flow-scripts/v3.0/flow/platforms/sky130hd/lib/${LIBERTY_NAME}`;
const LIBERTY_SHA256 = 'ec0e1067a35c8bf20b11e58d1e8ac53326067e4dac84a125cc1b917a3518d0d9';

function toolchainMissing(): string | null {
  const version = /^OSS_CAD_SUITE_VERSION=(.+)$/m.exec(
    readFileSync(join(REPO, 'hardware', 'toolchain.env'), 'utf8'),
  )?.[1];
  const tools = process.env['VCPU8_TOOLS_DIR'] ?? join(homedir(), '.cache', 'vcpu8');
  const bin = join(tools, `oss-cad-suite-${version ?? '?'}`, 'bin', 'yosys');
  return existsSync(bin) ? null : `${bin} not found: run 'pnpm hardware:setup'`;
}

interface BaselineCounts {
  readonly cells: number;
  readonly flipFlops: number;
  readonly combinational: number;
  readonly memories: number;
}

interface Baseline {
  readonly provenance: { readonly tools: Readonly<Record<string, string>> };
  readonly sizes: readonly {
    readonly size: string;
    readonly generic: {
      readonly total: BaselineCounts;
      readonly blocks: readonly (BaselineCounts & { readonly block: string })[];
      readonly byType: Readonly<Record<string, number>>;
      readonly mulCells: number;
      readonly memoryBits: number;
      readonly abstractGates: number;
      readonly logicDepth: { readonly length: number };
    };
  }[];
}

/** This platform's baseline, chosen as mk/platform.mk chooses it. */
function readBaseline(): Baseline {
  const name = platform() === 'linux' && arch() === 'x64' ? 'baseline-linux-x64' : 'baseline';
  const file = join(REPO, 'research', 'accelerators', 'matmul', 'synth', `${name}.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as Baseline;
}

/** The library, downloaded once per temporary directory; null when offline. */
async function fetchLiberty(): Promise<string | null> {
  const dir = join(tmpdir(), `vcpu-sky130hd-${LIBERTY_SHA256.slice(0, 16)}`);
  const file = join(dir, LIBERTY_NAME);
  if (!existsSync(file)) {
    let bytes: Buffer;
    try {
      const response = await fetch(LIBERTY_URL, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) return null;
      bytes = Buffer.from(await response.arrayBuffer());
    } catch {
      return null;
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== LIBERTY_SHA256) throw new Error(`${LIBERTY_URL} has sha256 ${digest}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, bytes);
  }
  return file;
}

const missing = toolchainMissing();
if (missing !== null) console.warn(`Yosys integration tests skipped: ${missing}`);

describe.skipIf(missing !== null)('YosysAdapter on the real toolchain', () => {
  const adapter = new YosysAdapter({ repoRoot: REPO });
  const baseline = readBaseline();
  const fourByFour = baseline.sizes.find((size) => size.size === '4x4')?.generic;
  let scratch: string;
  let runs = 0;

  const outDir = (): string => {
    runs += 1;
    return join(scratch, `run-${String(runs)}`);
  };

  const generic = (design: SynthesisDesign, timeoutMs = 120_000) =>
    adapter.synthesizeGeneric({ design, outDir: outDir(), timeoutMs });

  /** A scratch copy of the RTL with `text` added to the end of the PE module. */
  function editedPe(text: string): SynthesisDesign {
    runs += 1;
    const workspace = join(scratch, `ws-${String(runs)}`);
    const rtl = join(workspace, MATMUL, 'rtl');
    cpSync(join(REPO, MATMUL, 'rtl'), rtl, { recursive: true });
    const file = join(rtl, 'processing_element.sv');
    const source = readFileSync(file, 'utf8');
    writeFileSync(file, source.replace(/^endmodule/m, `${text}\nendmodule`));
    return peDesign(workspace);
  }

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'yosys-integration-'));
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('reproduces the processing_element row of the baseline', async () => {
    const row = fourByFour?.blocks.find((b) => b.block === 'u_array: one processing_element');
    const result = await generic(peDesign(REPO));

    expect(() => StageResultSchema.parse(result)).not.toThrow();
    expect(result).toMatchObject({ ok: true, failureClass: null });
    expect(result.toolVersion).toBe(baseline.provenance.tools['yosys']);
    const report = result.outcome;
    expect(report.cells).toMatchObject({ value: row?.cells, provenance: 'measured' });
    expect(report.flipFlops).toMatchObject({ value: row?.flipFlops });
    expect(report.mulCells).toMatchObject({ value: 1 });
    expect(report.memories).toMatchObject({ value: 0 });
    expect(report.areaUm2.provenance).toBe('unavailable');
  });

  it('reproduces the 4 × 4 totals of the baseline', async () => {
    const result = await generic(matmulTopDesign(REPO));

    expect(result).toMatchObject({ ok: true, failureClass: null });
    const report = result.outcome;
    expect(report.cells).toMatchObject({ value: fourByFour?.total.cells });
    expect(report.flipFlops).toMatchObject({ value: fourByFour?.total.flipFlops });
    expect(report.mulCells).toMatchObject({ value: 16 });
    expect(report.mulCells).toMatchObject({ value: fourByFour?.mulCells });
    expect(report.memories).toMatchObject({ value: fourByFour?.total.memories });
    expect(report.memoryBits).toMatchObject({ value: fourByFour?.memoryBits });
    expect(report.abstractGates).toMatchObject({ value: fourByFour?.abstractGates });
    expect(report.logicDepthGates).toMatchObject({ value: fourByFour?.logicDepth.length });
    expect(report.cellsByType).toEqual(fourByFour?.byType);
  });

  it.each([
    ['always @*', 'latch', 'logic latch_q;\nalways @* if (clear) latch_q = rst;'],
    ['always_comb', 'latch', 'logic latch_q;\nalways_comb if (clear) latch_q = rst;'],
    ['a loop', 'loop', 'logic x, y;\nassign x = clear & y;\nassign y = x | rst;'],
    ['two drivers', 'multi-driver', 'logic d;\nassign d = clear;\nassign d = rst;'],
    ['an undriven net', 'undriven', 'logic n, m;\nassign m = rst & n;'],
    ['an unknown module', 'hierarchy', 'nope u_nope ();'],
    ['a syntax error', 'elaboration', 'assign ;'],
  ])('fails %s on the %s gate', async (_name, gate, text) => {
    const result = await generic(editedPe(text));

    expect(() => StageResultSchema.parse(result)).not.toThrow();
    expect(result).toMatchObject({ ok: false, failureClass: 'unsupported-design' });
    expect(result.outcome.gates).toContainEqual({ name: gate, status: 'failed' });
    expect(result.outcome.cells.provenance).toBe('unavailable');
  });

  it('classes a timeout as a timeout', async () => {
    const result = await generic(matmulTopDesign(REPO), 1);
    expect(result).toMatchObject({ ok: false, failureClass: 'timeout' });
  });

  it('classes a missing binary as infrastructure', async () => {
    const absent = new YosysAdapter({ repoRoot: REPO, yosys: join(scratch, 'no-yosys') });
    const result = await absent.synthesizeGeneric({
      design: peDesign(REPO),
      outDir: outDir(),
      timeoutMs: 10_000,
    });
    expect(result).toMatchObject({ ok: false, failureClass: 'infrastructure-failure' });
  });

  it('marks area unavailable without a liberty file', async () => {
    const result = await adapter.synthesizeMapped({
      design: peDesign(REPO),
      outDir: outDir(),
      timeoutMs: 10_000,
    });
    expect(result.ok).toBe(true);
    expect(result.outcome.areaUm2.provenance).toBe('unavailable');
    expect(result.outcome.netlistFile).toBeNull();
  });

  it(
    'maps the PE to sky130hd: area, netlist and the same flip-flops',
    { timeout: 180_000 },
    async (test) => {
      const liberty = await fetchLiberty();
      if (liberty === null) {
        test.skip();
        return;
      }
      const run = () =>
        adapter.synthesizeMapped({
          design: peDesign(REPO),
          liberty,
          outDir: outDir(),
          timeoutMs: 120_000,
        });
      const result = await run();

      expect(() => StageResultSchema.parse(result)).not.toThrow();
      expect(result).toMatchObject({ ok: true, failureClass: null });
      const report = result.outcome;
      expect(report.areaUm2).toMatchObject({
        unit: 'um^2',
        provenance: 'estimated',
        method: 'yosys-stat-liberty',
        tool: 'yosys',
        toolVersion: result.toolVersion,
      });
      const area = (report.areaUm2 as { value: number }).value;
      expect(area).toBeGreaterThan(0);
      expect(report.flipFlops).toMatchObject({ value: 50 });
      expect(report.liberty?.sha256).toBe(LIBERTY_SHA256);

      const cells = Object.keys(report.mappedCellsByType ?? {});
      expect(cells.length).toBeGreaterThan(0);
      expect(cells.every((cell) => cell.startsWith('sky130_fd_sc_hd__'))).toBe(true);
      expect(cells.filter((cell) => cell.includes('lpflow'))).toEqual([]);
      const netlist = readFileSync(report.netlistFile ?? '', 'utf8');
      expect(netlist).toMatch(/^module processing_element/m);
      expect(netlist).toContain('sky130_fd_sc_hd__dfxtp_1');

      // The same design and settings from another directory: the area may not depend on the path.
      const again = await run();
      expect(again.outcome.areaUm2).toEqual(report.areaUm2);
      expect(again.outcome.mappedCellsByType).toEqual(report.mappedCellsByType);
    },
  );
});
