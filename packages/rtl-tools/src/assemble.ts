import { assemble, formatDiagnostic } from '@vcpu/assembler';
import { formatMemoryHex } from '@vcpu/shared';

/** The program as a 256-line `$readmemh` image, or the assembler's error messages. */
export type AssembledHex =
  | { readonly ok: true; readonly hex: string }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Assembles VCPU-8 source with the Project 1 assembler into the image the RTL runner loads: all
 * 256 bytes, one per line as two uppercase hex digits (the fixtures' `.mem.hex` format).
 */
export function assembleToHex(source: string): AssembledHex {
  const result = assemble(source);
  if (!result.ok) {
    return {
      ok: false,
      errors: result.diagnostics
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => formatDiagnostic(diagnostic, source)),
    };
  }
  return { ok: true, hex: formatMemoryHex(Array.from(result.bytes.image)) };
}
