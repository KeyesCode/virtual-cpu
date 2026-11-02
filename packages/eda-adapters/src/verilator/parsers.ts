import { z } from 'zod';

/** One `%Error…` or `%Warning…` line of Verilator. */
export interface VerilatorDiagnostic {
  readonly severity: 'error' | 'warning';
  /** The code after the dash (`PINNOTFOUND`), or null. */
  readonly code: string | null;
  /** The source location, or null when the line names none. */
  readonly file: string | null;
  readonly line: number | null;
  readonly message: string;
}

const DIAGNOSTIC = /^%(Error|Warning)(?:-([A-Z0-9_]+))?: (?:([^\s:]+):(\d+):(?:\d+:)? )?(.*)$/gm;
/** Closing lines that repeat what was said, and the stop a testbench's $fatal prints. */
const NOT_A_FINDING = /^Exiting due to |Verilog \$(stop|finish)/;

/** The findings in Verilator's output. */
export function parseVerilatorDiagnostics(text: string): VerilatorDiagnostic[] {
  const found: VerilatorDiagnostic[] = [];
  for (const [, severity, code, file, line, message = ''] of text.matchAll(DIAGNOSTIC)) {
    if (NOT_A_FINDING.test(message)) continue;
    found.push({
      severity: severity === 'Error' ? 'error' : 'warning',
      code: code ?? null,
      file: file ?? null,
      line: line === undefined ? null : Number(line),
      message,
    });
  }
  return found;
}

/** A warning that says the frozen PE interface changed, which -Wno-fatal would let through. */
export function isInterfaceWarning(diagnostic: VerilatorDiagnostic): boolean {
  if (diagnostic.severity !== 'warning') return false;
  if (diagnostic.code === 'PINMISSING') return true;
  return (
    diagnostic.code?.startsWith('WIDTH') === true && /port connection/i.test(diagnostic.message)
  );
}

/** An error about the design, not a fault of Verilator or of its C++ build. */
export function isDesignError(diagnostic: VerilatorDiagnostic): boolean {
  return (
    diagnostic.severity === 'error' &&
    (diagnostic.file !== null || diagnostic.code !== null) &&
    !/internal error/i.test(diagnostic.message)
  );
}

export interface PeMismatch {
  /** The line of pe.vec. */
  readonly line: number;
  readonly segment: string;
  readonly detail: string;
}

/** What `tb_processing_element` printed; `make test-pe` has no other machine output. */
export interface PeUnitLog {
  /** True only when the PASS line is present. */
  readonly passed: boolean;
  /** The clocks checked, or null without a PASS or `N of M checks failed` line. */
  readonly checks: number | null;
  readonly randomClocks: number | null;
  readonly seed: string | null;
  /** The clocks that failed, or null without the `N of M checks failed` line. */
  readonly failedChecks: number | null;
  /** The mismatches printed, at most the testbench's MAX_REPORTED. */
  readonly mismatches: readonly PeMismatch[];
}

const PE_PASS = /^tb_processing_element: PASS \((\d+) checks, (\d+) random clocks, seed (\S+)\)$/m;
const PE_FAILED = /tb_processing_element: (\d+) of (\d+) checks failed$/m;
const PE_MISMATCH = /^MISMATCH line (\d+) \(segment '([^']*)'\): (.*)$/gm;

export function parsePeUnitLog(log: string): PeUnitLog {
  const pass = PE_PASS.exec(log);
  // After the PASS line, test-pe-corrupt prints the mismatch it provoked on a corrupted vector.
  const text = pass === null ? log : log.slice(0, pass.index);
  const failed = PE_FAILED.exec(text);
  return {
    passed: pass !== null,
    checks:
      pass?.[1] !== undefined
        ? Number(pass[1])
        : failed?.[2] !== undefined
          ? Number(failed[2])
          : null,
    randomClocks: pass?.[2] !== undefined ? Number(pass[2]) : null,
    seed: pass?.[3] ?? null,
    failedChecks: failed?.[1] !== undefined ? Number(failed[1]) : null,
    mismatches: [...text.matchAll(PE_MISMATCH)].map(([, line, segment = '', detail = '']) => ({
      line: Number(line),
      segment,
      detail,
    })),
  };
}

const CountsSchema = z.object({
  cases: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  directed: z.number().int().nonnegative(),
  random: z.number().int().nonnegative(),
});
export type VerifyCounts = z.infer<typeof CountsSchema>;

const VerifyCaseSchema = z.object({
  size: z.string().regex(/^\d+x\d+$/),
  name: z.string().min(1),
  kind: z.enum(['directed', 'random']),
  generator: z.string().min(1),
  seed: z.number().int().nonnegative(),
  dims: z.object({
    m: z.number().int().positive(),
    n: z.number().int().positive(),
    k: z.number().int().positive(),
  }),
  passed: z.boolean(),
  reason: z.string().nullable(),
  mismatches: z.number().int().nonnegative(),
  firstMismatches: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      i: z.number().int().nonnegative(),
      j: z.number().int().nonnegative(),
      expected: z.number().int(),
      actual: z.number().int(),
    }),
  ),
  /** Null when the runner wrote no clock counts, that is, when it did not finish. */
  cycles: z.object({ stop: z.string() }).nullable(),
  saved: z.string().nullable(),
});
export type VerifyCase = z.infer<typeof VerifyCaseSchema>;

/** The parts of `verify.json` (schema `matmul-verify` v1) the adapter reads. */
export const VerifyReportSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('matmul-verify'),
  passed: z.boolean(),
  seed: z.number().int().nonnegative(),
  countPerSize: z.number().int().nonnegative(),
  corpora: z.array(z.enum(['directed', 'random'])),
  provenance: z.object({
    revision: z.string().min(1),
    git: z.object({ commit: z.string().nullable(), dirty: z.boolean().nullable() }),
  }),
  sizes: z.array(CountsSchema.extend({ size: z.string(), sim: z.string() })),
  totals: CountsSchema,
  cases: z.array(VerifyCaseSchema),
});
export type VerifyReport = z.infer<typeof VerifyReportSchema>;

export function parseVerifyReport(text: string): VerifyReport {
  return VerifyReportSchema.parse(JSON.parse(text));
}

/**
 * The harness's message for a runner that died, as opposed to a design that answered wrongly (a
 * wrong C, an error stop or a cycle-limit timeout, all of which the runner survives and reports).
 */
export function isRunnerFailure(verifyCase: VerifyCase): boolean {
  return verifyCase.cycles === null && verifyCase.reason?.startsWith('the runner failed') === true;
}

/** `build/tool-versions.json`, as `make tools-check` writes it. */
export const ToolVersionsSchema = z.object({
  toolchain: z.object({ pinnedVersion: z.string(), path: z.string().nullable() }),
  tools: z.record(z.string(), z.object({ path: z.string(), version: z.string() }).nullable()),
});
export type ToolVersions = z.infer<typeof ToolVersionsSchema>;

export function parseToolVersions(text: string): ToolVersions {
  return ToolVersionsSchema.parse(JSON.parse(text));
}
