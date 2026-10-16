import { U8Schema } from '@vcpu/shared';
import { z } from 'zod';
import type { Diagnostic } from './diagnostics.js';
import { parse } from './parser.js';
import { layout, type AssemblerSymbol } from './pass1.js';
import { emit, type AssembledImage, type SourceMapEntry } from './pass2.js';

export const AssembleOptionsSchema = z.strictObject({
  /** Address of the first emitted byte when the source has no `.org` first (default 0x00). */
  origin: U8Schema.optional(),
});
export type AssembleOptions = z.input<typeof AssembleOptionsSchema>;

export interface AssembleResult {
  /** True when there are no error diagnostics. */
  readonly ok: boolean;
  /** The memory image and the ranges that hold output. Partial when `ok` is false. */
  readonly bytes: AssembledImage;
  /** Labels and `.equ` constants by name, in definition order. */
  readonly symbols: ReadonlyMap<string, AssemblerSymbol>;
  /** Address of each instruction and `.byte` value → where it came from. */
  readonly sourceMap: ReadonlyMap<number, SourceMapEntry>;
  /** Every problem found, in source order. Assembly never stops at the first one. */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Assembles VCPU-8 source in two passes. Problems in the source are returned as diagnostics
 * and never thrown; only invalid `options` throw (a ZodError), since those are a caller bug.
 */
export function assemble(source: string, options: AssembleOptions = {}): AssembleResult {
  const { origin = 0 } = AssembleOptionsSchema.parse(options);
  const diagnostics: Diagnostic[] = [];
  const statements = parse(source, diagnostics);
  const laidOut = layout(statements, origin, diagnostics);
  const { bytes, sourceMap } = emit(laidOut, diagnostics);
  const sorted = [...diagnostics].sort(
    (x, y) => x.span.start - y.span.start || x.span.end - y.span.end,
  );
  return {
    ok: !sorted.some((d) => d.severity === 'error'),
    bytes,
    symbols: laidOut.symbols,
    sourceMap,
    diagnostics: sorted,
  };
}
