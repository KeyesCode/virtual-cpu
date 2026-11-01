import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isDesignError,
  isInterfaceWarning,
  isRunnerFailure,
  parsePeUnitLog,
  parseToolVersions,
  parseVerifyReport,
  parseVerilatorDiagnostics,
} from './parsers.js';

const fixture = (name: string) =>
  readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8');

describe('parseVerilatorDiagnostics', () => {
  it('reads errors and warnings with their codes and locations', () => {
    const found = parseVerilatorDiagnostics(fixture('verilator-renamed-port.txt'));
    expect(found.map((d) => [d.severity, d.code, d.line])).toEqual([
      ['warning', 'PINMISSING', 130],
      ['error', 'PINNOTFOUND', 142],
    ]);
    expect(found[1]?.file).toBe('/ws/rtl/systolic_array.sv');
    expect(found[1]?.message).toBe("Pin not found: 'acc'");
  });

  it('skips the closing line and a testbench stop, which report nothing new', () => {
    const log = [
      '%Error: Exiting due to 1 error(s)',
      '%Error: /ws/tb/unit/tb_processing_element.sv:189: Verilog $stop',
    ].join('\n');
    expect(parseVerilatorDiagnostics(log)).toEqual([]);
  });

  it('reads a syntax error, which has a location and no code', () => {
    const [error] = parseVerilatorDiagnostics(
      "%Error: /ws/rtl/pe.sv:39:18: syntax error, unexpected ==, expecting '='",
    );
    expect(error).toMatchObject({ code: null, file: '/ws/rtl/pe.sv', line: 39 });
    expect(error !== undefined && isDesignError(error)).toBe(true);
  });
});

describe('the diagnostic classes', () => {
  const warning = (code: string, message: string) => ({
    severity: 'warning' as const,
    code,
    file: '/ws/rtl/systolic_array.sv',
    line: 1,
    message,
  });

  it('treats a missing pin and a port width change as interface changes', () => {
    expect(isInterfaceWarning(warning('PINMISSING', "Instance has missing pin: 'x'"))).toBe(true);
    expect(
      isInterfaceWarning(
        warning('WIDTHTRUNC', "Output port connection 'acc' expects 32 bits on the pin connection"),
      ),
    ).toBe(true);
  });

  it('leaves a warning inside the logic alone', () => {
    expect(isInterfaceWarning(warning('UNUSEDSIGNAL', "Signal is not used: 'clear'"))).toBe(false);
    expect(isInterfaceWarning(warning('WIDTHEXPAND', 'Operator ADD expects 32 bits'))).toBe(false);
  });

  it('does not blame the design for a Verilator fault or a failed C++ build', () => {
    const [internal, cpp] = parseVerilatorDiagnostics(
      [
        '%Error: Internal Error: /ws/rtl/pe.sv:1:1: ../V3Ast.cpp:12: broken',
        '%Error: make -C /out/obj exited with 2',
      ].join('\n'),
    );
    expect(internal !== undefined && isDesignError(internal)).toBe(false);
    expect(cpp !== undefined && isDesignError(cpp)).toBe(false);
  });
});

describe('parsePeUnitLog', () => {
  it('reads the check count of a passing run', () => {
    expect(parsePeUnitLog(fixture('pe-pass.txt'))).toEqual({
      passed: true,
      checks: 284355,
      randomClocks: 20000,
      seed: '7',
      failedChecks: null,
      mismatches: [],
    });
  });

  it('reads the mismatches and the failure count of a failing run', () => {
    const log = parsePeUnitLog(fixture('pe-mismatch.txt'));
    expect(log.passed).toBe(false);
    expect(log.checks).toBe(284355);
    expect(log.failedChecks).toBe(282558);
    expect(log.mismatches).toHaveLength(2);
    expect(log.mismatches[0]).toMatchObject({ line: 42, segment: 'clear' });
  });

  it('reports no result for a log that holds neither line', () => {
    expect(parsePeUnitLog('make: *** [test-pe] Error 2\n')).toMatchObject({
      passed: false,
      checks: null,
      failedChecks: null,
    });
  });
});

describe('parseVerifyReport', () => {
  it('reads a passing report', () => {
    const report = parseVerifyReport(fixture('verify-pass.json'));
    expect(report.passed).toBe(true);
    expect(report.totals).toMatchObject({ cases: 24, failed: 0, directed: 22, random: 2 });
  });

  it('reads the failing cases of a failing report', () => {
    const report = parseVerifyReport(fixture('verify-fail.json'));
    const failed = report.cases.filter((c) => !c.passed);
    expect(report.passed).toBe(false);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.saved).toBe('/out/build/failures/4x4-rand-0');
    expect(failed[0]?.firstMismatches[0]).toMatchObject({ i: 0, j: 1, expected: 5, actual: 6 });
    expect(failed.every(isRunnerFailure)).toBe(false);
  });

  it('tells a runner that died from a design that answered wrongly', () => {
    const [died] = parseVerifyReport(fixture('verify-runner-died.json')).cases;
    expect(died !== undefined && isRunnerFailure(died)).toBe(true);
  });

  it('refuses another schema', () => {
    const other = JSON.stringify({ ...JSON.parse(fixture('verify-pass.json')), schemaVersion: 2 });
    expect(() => parseVerifyReport(other)).toThrow();
  });
});

describe('parseToolVersions', () => {
  it('reads a tool that is present and one that is missing', () => {
    const { toolchain, tools } = parseToolVersions(
      JSON.stringify({
        toolchain: { name: 'oss-cad-suite', pinnedVersion: '2026-10-16', path: null },
        tools: { verilator: { path: '/bin/verilator', version: 'Verilator 5.053' }, yosys: null },
      }),
    );
    expect(toolchain.path).toBeNull();
    expect(tools['verilator']?.version).toBe('Verilator 5.053');
    expect(tools['yosys']).toBeNull();
  });
});
