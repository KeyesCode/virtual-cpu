export type DiagnosticSeverity = 'error' | 'warning';

/** A half-open range of UTF-16 offsets into the source text: `source.slice(start, end)`. */
export interface SourceSpan {
  readonly start: number;
  readonly end: number;
}

/** A single source position plus its span. Lines and columns are 1-based. */
export interface SourceLocation {
  readonly line: number;
  readonly column: number;
  readonly span: SourceSpan;
}

/**
 * Every message the assembler can report, as a function from its details to the text. The
 * code is stable (tools may match on it); the text is for people.
 */
export const MESSAGES = {
  'unexpected-character': (char: string) => `unexpected character "${char}"`,
  'invalid-number': (text: string) =>
    `invalid number "${text}" (use decimal 42, hex 0x2A or binary 0b101010)`,
  'invalid-char': (detail: string) => `invalid character literal: ${detail}`,
  'unknown-register': (text: string) => `unknown register "${text}" (valid: R0–R7)`,
  'unknown-mnemonic': (text: string) => `unknown mnemonic "${text}"`,
  'unknown-directive': (text: string) => `unknown directive "${text}" (valid: .org, .byte, .equ)`,
  syntax: (detail: string) => detail,
  'operand-count': (detail: string) => detail,
  'operand-kind': (detail: string) => detail,
  'value-out-of-range': (detail: string) => detail,
  'undefined-symbol': (name: string) => `undefined symbol "${name}"`,
  'symbol-not-yet-defined': (name: string, directive: string) =>
    `"${name}" must be defined above this ${directive}: its value is needed here`,
  'duplicate-symbol': (name: string, firstLine: number) =>
    `duplicate symbol "${name}" (first defined on line ${String(firstLine)})`,
  'reserved-name': (name: string, what: string) =>
    `"${name}" cannot be used as a symbol name: it is ${what}`,
  'org-backwards': (target: number, current: number) =>
    `.org ${hex(target)} moves backwards (the current address is ${hex(current)})`,
  overlap: (address: number, otherLine: number) =>
    `output at ${hex(address)} overlaps bytes already emitted by line ${String(otherLine)}`,
  overflow: (address: number, size: number) =>
    `program runs past the end of memory (0xFF): ${String(size)} byte${size === 1 ? '' : 's'} at ${hex(address)}`,
} as const;

export type DiagnosticCode = keyof typeof MESSAGES;

export interface Diagnostic extends SourceLocation {
  readonly severity: DiagnosticSeverity;
  readonly code: DiagnosticCode;
  readonly message: string;
}

/** `0x2A` style, two digits minimum, upper case. */
export function hex(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** Builds an error diagnostic, taking the message from the catalog. */
export function diagnostic<C extends DiagnosticCode>(
  location: SourceLocation,
  code: C,
  ...args: Parameters<(typeof MESSAGES)[C]>
): Diagnostic {
  const format = MESSAGES[code] as (...messageArgs: Parameters<(typeof MESSAGES)[C]>) => string;
  return {
    severity: 'error',
    code,
    message: format(...args),
    line: location.line,
    column: location.column,
    span: location.span,
  };
}

/**
 * Formats a diagnostic for a terminal, e.g. `line 7, col 9: unknown register "R9" (valid:
 * R0–R7)`. With the source, it adds the offending line and a caret under the span.
 */
export function formatDiagnostic(d: Diagnostic, source?: string): string {
  const prefix = d.severity === 'warning' ? 'warning: ' : '';
  const header = `line ${String(d.line)}, col ${String(d.column)}: ${prefix}${d.message}`;
  if (source === undefined) {
    return header;
  }
  const lineText = (source.split('\n')[d.line - 1] ?? '').replace(/\r$/, '');
  // Keep tabs so the caret lines up whatever the terminal's tab width.
  const indent = lineText.slice(0, d.column - 1).replace(/[^\t]/g, ' ');
  const width = Math.max(1, Math.min(d.span.end - d.span.start, lineText.length - d.column + 1));
  return `${header}\n  ${lineText}\n  ${indent}${'^'.repeat(width)}`;
}
