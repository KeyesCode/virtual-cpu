import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  collectWarnings,
  compareSummaries,
  countCells,
  deviceName,
  moduleName,
  moduleStats,
  type NextpnrReport,
  parseAllowlist,
  parseLtp,
  parseMemories,
  parseMemoryMapping,
  placeAndRoute,
  StatJsonSchema,
} from './summary.js';

// `stat -json` of the generic flow, captured from the pinned Yosys 0.70+145 on the RTL of this
// commit (build/synth/generic.stat.json), keeping only the fields the parser reads.
const STAT = StatJsonSchema.parse(
  JSON.parse(readFileSync(new URL('testdata/generic.stat.json', import.meta.url), 'utf8')),
);

// The head and tail of the same run's `ltp -noff` output.
const LTP = `24. Executing LTP pass (find longest path).

Longest topological path in vcpu8_top (length=83):
    0: \\u_core.u_control.state [2]
    1: $abc$22588$flatten\\u_core.\\u_control.$abc$22295$auto$rtlil.cc:3439:NotGate$21817 (via $abc$22598$blif$22598$1)
    2: $abc$22598$new_n38 (via $abc$22598$blif$22598$3)
   80: \\u_core.alu_r [0] (via $abc$22599$blif$22599$542)
   83: \\u_core.u_registers.wd [0] (via $abc$22590$blif$22590$420)
   ff: \\u_core.u_registers.r[2] [0] (via $flatten\\u_core.\\u_registers.$auto$ff.cc:337:slice$7815)
`;

const bits = (n: number, width = 32): string => n.toString(2).padStart(width, '0');

describe('moduleName', () => {
  it('strips the escape and the parameter suffix', () => {
    expect(moduleName('\\vcpu8_top')).toBe('vcpu8_top');
    expect(moduleName("$paramod\\vcpu8_memory\\INIT_FILE=t0'")).toBe('vcpu8_memory');
    expect(moduleName('$paramod$0123abcd\\vcpu8_memory')).toBe('vcpu8_memory');
  });
});

describe('countCells', () => {
  it('separates flip-flops, memories and combinational cells and drops $scopeinfo', () => {
    const counts = countCells({
      $_SDFFCE_PN0P_: 64,
      $_DFFE_PP_: 3,
      $_MUX_: 80,
      $_AND_: 31,
      $mem_v2: 1,
      $scopeinfo: 5,
    });
    expect(counts).toMatchObject({ cells: 179, flipFlops: 67, memories: 1, combinational: 111 });
    expect(Object.keys(counts.byType)).not.toContain('$scopeinfo');
  });
});

describe('moduleStats on a captured stat -json', () => {
  const stats = moduleStats(STAT);

  it('counts each module without its submodules', () => {
    expect(stats.local.vcpu8_registers).toMatchObject({
      cells: 270,
      flipFlops: 64,
      combinational: 206,
    });
    expect(stats.local.vcpu8_flags).toMatchObject({ cells: 8, flipFlops: 4, combinational: 4 });
    expect(stats.local.vcpu8_top).toMatchObject({ cells: 0 });
    expect(stats.children.vcpu8_top).toEqual({ vcpu8_core: 1, vcpu8_memory: 1 });
  });

  it('sums every subtree, and the whole design equals the sum of its modules', () => {
    const local = Object.values(stats.local);
    const sum = (key: 'cells' | 'flipFlops') => local.reduce((n, c) => n + c[key], 0);
    expect(stats.subtrees.vcpu8_top?.cells).toBe(sum('cells'));
    expect(stats.subtrees.vcpu8_top?.flipFlops).toBe(sum('flipFlops'));
    const core = stats.subtrees.vcpu8_core;
    const memory = stats.local.vcpu8_memory;
    expect(core).toBeDefined();
    expect(memory).toBeDefined();
    expect((core?.cells ?? 0) + (memory?.cells ?? 0)).toBe(stats.subtrees.vcpu8_top?.cells);
    expect(Object.keys(stats.subtrees).sort()).toEqual(['vcpu8_core', 'vcpu8_top']);
  });
});

describe('parseLtp', () => {
  it('reads the length, the ends and the named signals on the path', () => {
    expect(parseLtp(LTP)).toEqual({
      length: 83,
      from: 'u_core.u_control.state[2]',
      to: 'u_core.u_registers.wd[0]',
      endFlipFlop: 'u_core.u_registers.r[2][0]',
      through: ['u_core.u_control.state[2]', 'u_core.alu_r[0]', 'u_core.u_registers.wd[0]'],
    });
  });

  it('rejects output without a path', () => {
    expect(() => parseLtp('nothing here')).toThrow(/Longest topological path/);
  });
});

describe('parseMemories', () => {
  const cell = (memid: string, size: number, width: number, rd: string, wr: number) => ({
    type: '$mem_v2',
    parameters: {
      MEMID: memid,
      SIZE: bits(size),
      WIDTH: bits(width),
      RD_PORTS: bits(rd.length),
      RD_CLK_ENABLE: rd,
      WR_PORTS: bits(wr),
    },
  });

  it('lists RAMs by name and groups each module’s ROMs', () => {
    const memories = parseMemories({
      modules: {
        "$paramod\\vcpu8_memory\\INIT_FILE=t0'": { cells: { mem: cell('\\mem', 256, 8, '1', 1) } },
        vcpu8_registers: { cells: { r: cell('\\r', 8, 8, '0000000000', 9) } },
        vcpu8_decoder: {
          cells: {
            a: cell('$auto$proc_rom.cc:155:do_switch$242', 128, 3, '0', 0),
            b: cell('$auto$proc_rom.cc:155:do_switch$246', 128, 1, '0', 0),
          },
        },
      },
    });
    expect(memories).toEqual([
      {
        module: 'vcpu8_memory',
        name: 'mem',
        kind: 'ram',
        count: 1,
        words: 256,
        width: 8,
        readPorts: 1,
        syncReadPorts: 1,
        writePorts: 1,
      },
      {
        module: 'vcpu8_registers',
        name: 'r',
        kind: 'ram',
        count: 1,
        words: 8,
        width: 8,
        readPorts: 10,
        syncReadPorts: 0,
        writePorts: 9,
      },
      {
        module: 'vcpu8_decoder',
        name: '2 ROMs',
        kind: 'rom',
        count: 2,
        words: 128,
        width: 4,
        readPorts: 2,
        syncReadPorts: 0,
        writePorts: 0,
      },
    ]);
  });
});

describe('parseMemoryMapping', () => {
  it('reads memory_libmap block-RAM and FF mappings, keyed by instance path', () => {
    const log = [
      'mapping memory vcpu8_fpga_wrapper.u_cpu.u_mem.mem via $__ICE40_RAM4K_',
      'using FF mapping for memory vcpu8_fpga_wrapper.$flatten\\u_cpu.\\u_core.\\u_decoder.$auto$proc_rom.cc:155:do_switch$257',
      'using FF mapping for memory vcpu8_fpga_wrapper.u_cpu.u_core.u_registers.r',
    ].join('\n');
    expect(parseMemoryMapping(log)).toEqual({
      'u_cpu.u_mem.mem': 'block RAM ($__ICE40_RAM4K_)',
      'u_cpu.u_core.u_decoder.$auto$proc_rom.cc:155:do_switch$257':
        'flip-flops and logic (FF mapping)',
      'u_cpu.u_core.u_registers.r': 'flip-flops and logic (FF mapping)',
    });
  });
});

describe('warnings and the allowlist', () => {
  const allow = parseAllowlist(
    [
      '# Header comment, not attached to anything.',
      '',
      '# ABC sees only combinational logic.',
      '^ABC: Warning: The network is combinational',
    ].join('\n'),
  );

  it('attaches the comment block above each pattern as its review', () => {
    expect(allow).toEqual([
      {
        pattern: '^ABC: Warning: The network is combinational',
        review: 'ABC sees only combinational logic.',
      },
    ]);
  });

  it('counts each warning, strips machine paths and leaves unreviewed ones unallowed', () => {
    const log = [
      'ABC: Warning: The network is combinational.',
      'ABC: Warning: The network is combinational.',
      'Warning: Resizing cell port top.u from 3 bits to 2 bits in /repo/core/x.sv:4',
      'Info: not a warning',
    ].join('\n');
    expect(collectWarnings('generic.log', log, allow, ['/repo/'])).toEqual([
      {
        source: 'generic.log',
        message: 'ABC: Warning: The network is combinational.',
        count: 2,
        allowedBy: '^ABC: Warning: The network is combinational',
      },
      {
        source: 'generic.log',
        message: 'Warning: Resizing cell port top.u from 3 bits to 2 bits in core/x.sv:4',
        count: 1,
        allowedBy: null,
      },
    ]);
  });
});

describe('placeAndRoute', () => {
  const step = (type: string, delay: number, sources?: string[]) => ({
    type,
    delay,
    from: { cell: 'a' },
    to: { cell: 'b' },
    ...(sources === undefined ? {} : { sources }),
  });
  const report: NextpnrReport = {
    fmax: { clk: { achieved: 10.627670288085938, constraint: 12 } },
    utilization: {
      ICESTORM_LC: { available: 5280, used: 896 },
      ICESTORM_PLL: { available: 1, used: 0 },
    },
    critical_paths: [
      { from: '<async>', to: 'posedge clk', path: [step('routing', 1)] },
      {
        from: 'posedge clk',
        to: 'posedge clk',
        path: [
          step('clk-to-q', 1.39),
          step('routing', 1.76, ['/repo/hardware/rtl/vcpu8/core/vcpu8_alu.sv:31.40-31.45']),
          step('logic', 1.23),
          step('routing', 2.95, [
            '/repo/hardware/rtl/vcpu8/core/vcpu8_alu.sv:31.40-31.45',
            '/tools/share/yosys/ice40/cells_map.v:6.21-6.22',
          ]),
          step('setup', 0.5),
        ],
      },
    ],
  };

  it('reports Fmax against its constraint and the register-to-register path', () => {
    expect(placeAndRoute(report, '/repo')).toEqual({
      clock: 'clk',
      fmaxMHz: 10.63,
      constraintMHz: 12,
      meetsConstraint: false,
      utilisation: { ICESTORM_LC: { available: 5280, used: 896 } },
      criticalPath: {
        from: 'a',
        to: 'b',
        delayNs: 7.83,
        logicNs: 1.23,
        routingNs: 4.71,
        logicStages: 1,
        rtlSources: [{ location: 'hardware/rtl/vcpu8/core/vcpu8_alu.sv:31', nets: 2 }],
      },
    });
  });
});

describe('deviceName', () => {
  it('names the parts behind nextpnr device flags', () => {
    expect(deviceName({ family: 'ice40', device: 'up5k', package: 'sg48', speed: null })).toBe(
      'iCE40UP5K',
    );
    expect(deviceName({ family: 'ecp5', device: '25k', package: 'CABGA256', speed: '6' })).toBe(
      'LFE5U-25F',
    );
    expect(
      deviceName({ family: 'ecp5', device: 'um5g-45k', package: 'CABGA381', speed: '8' }),
    ).toBe('LFE5UM5G-45F');
  });
});

describe('compareSummaries', () => {
  const summary = {
    format: 'vcpu8-synth-summary/1',
    provenance: { gitSha: 'aaa', tools: { yosys: 'Yosys 0.70' } },
    generic: { total: { cells: 7480, flipFlops: 2238 } },
    warnings: [{ message: 'x', count: 1 }],
  };

  it('finds no deltas between identical metrics, whatever the provenance', () => {
    const fresh = { ...summary, provenance: { gitSha: 'bbb', tools: { yosys: 'Yosys 0.70' } } };
    const result = compareSummaries(summary, fresh);
    expect(result.deltas).toEqual([]);
    expect(result.provenance).toEqual([
      { path: 'provenance.gitSha', baseline: 'aaa', fresh: 'bbb' },
    ]);
  });

  it('reports changed, added and removed metrics by path', () => {
    const fresh = {
      ...summary,
      generic: { total: { cells: 7500, flipFlops: 2238, memories: 0 } },
      warnings: [],
    };
    expect(compareSummaries(summary, fresh).deltas).toEqual([
      { path: 'generic.total.cells', baseline: 7480, fresh: 7500 },
      { path: 'generic.total.memories', baseline: undefined, fresh: 0 },
      { path: 'warnings[0].count', baseline: 1, fresh: undefined },
      { path: 'warnings[0].message', baseline: 'x', fresh: undefined },
    ]);
  });
});
