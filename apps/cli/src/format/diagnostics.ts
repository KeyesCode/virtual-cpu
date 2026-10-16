import { type Diagnostic, formatDiagnostic } from '@vcpu/assembler';

/**
 * Compiler-style diagnostics: `file:line:col: error: message`, then the source line and a caret
 * under the problem (the caret lines come from the assembler's own `formatDiagnostic`).
 */
export function formatDiagnostics(
  file: string,
  source: string,
  diagnostics: readonly Diagnostic[],
): string {
  return diagnostics
    .map((d) => {
      const header = `${file}:${String(d.line)}:${String(d.column)}: ${d.severity}: ${d.message}`;
      const caret = formatDiagnostic(d, source).split('\n').slice(1);
      return [header, ...caret].join('\n');
    })
    .join('\n');
}
