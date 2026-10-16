import { diagnostic, type Diagnostic, type SourceLocation } from './diagnostics.js';

export type TokenKind =
  'identifier' | 'directive' | 'number' | 'char' | 'comma' | 'colon' | 'lbracket' | 'rbracket';

export interface Token extends SourceLocation {
  readonly kind: TokenKind;
  /** The exact source text of the token. */
  readonly text: string;
  /** Numeric value of a `number` or `char` token; `null` when the literal was invalid (already reported). */
  readonly value: number | null;
}

/** One physical source line. `offset` is where the line starts in the whole source. */
export interface SourceLine {
  readonly line: number;
  readonly offset: number;
  /** The line without its terminator (a trailing `\r` is dropped). */
  readonly text: string;
}

export function splitLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let offset = 0;
  source.split('\n').forEach((raw, index) => {
    lines.push({ line: index + 1, offset, text: raw.endsWith('\r') ? raw.slice(0, -1) : raw });
    offset += raw.length + 1;
  });
  return lines;
}

const PUNCTUATION: Readonly<Record<string, TokenKind>> = {
  ',': 'comma',
  ':': 'colon',
  '[': 'lbracket',
  ']': 'rbracket',
};

const CHAR_ESCAPES: Readonly<Record<string, number>> = {
  n: 0x0a,
  t: 0x09,
  r: 0x0d,
  '0': 0x00,
  '\\': 0x5c,
  "'": 0x27,
};

const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isWordChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string): boolean => /[0-9]/.test(c);

/** Parses the body of a number literal (no sign); `null` if it is malformed. */
function parseNumberBody(body: string): number | null {
  if (/^0[xX][0-9A-Fa-f]+$/.test(body)) return Number.parseInt(body.slice(2), 16);
  if (/^0[bB][01]+$/.test(body)) return Number.parseInt(body.slice(2), 2);
  if (/^[0-9]+$/.test(body)) return Number.parseInt(body, 10);
  return null;
}

/**
 * Splits one source line into tokens. A `;` outside a character literal starts a comment.
 * Problems are appended to `diagnostics`; the lexer never throws and always returns the
 * tokens it could read.
 */
export function tokenizeLine(source: SourceLine, diagnostics: Diagnostic[]): Token[] {
  const { text } = source;
  const tokens: Token[] = [];
  const locate = (start: number, end: number): SourceLocation => ({
    line: source.line,
    column: start + 1,
    span: { start: source.offset + start, end: source.offset + end },
  });
  const push = (kind: TokenKind, start: number, end: number, value: number | null = null): void => {
    tokens.push({ kind, text: text.slice(start, end), value, ...locate(start, end) });
  };

  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === ';') break;
    if (c === ' ' || c === '\t') {
      i += 1;
      continue;
    }
    const punctuation = PUNCTUATION[c];
    if (punctuation !== undefined) {
      push(punctuation, i, i + 1);
      i += 1;
      continue;
    }
    if (isDigit(c) || (c === '-' && isDigit(text.charAt(i + 1)))) {
      const start = i;
      i += c === '-' ? 1 : 0;
      while (i < text.length && isWordChar(text.charAt(i))) i += 1;
      const literal = text.slice(start, i);
      const negative = literal.startsWith('-');
      const body = parseNumberBody(negative ? literal.slice(1) : literal);
      if (body === null) {
        diagnostics.push(diagnostic(locate(start, i), 'invalid-number', literal));
      }
      push('number', start, i, body === null ? null : negative ? -body : body);
      continue;
    }
    if (isIdentStart(c) || c === '.') {
      const start = i;
      i += 1;
      while (i < text.length && isWordChar(text.charAt(i))) i += 1;
      if (c === '.' && i === start + 1) {
        diagnostics.push(diagnostic(locate(start, i), 'unexpected-character', '.'));
        continue;
      }
      push(c === '.' ? 'directive' : 'identifier', start, i);
      continue;
    }
    if (c === "'") {
      i = lexChar(i);
      continue;
    }
    diagnostics.push(diagnostic(locate(i, i + 1), 'unexpected-character', c));
    i += 1;
  }
  return tokens;

  /** Reads a character literal starting at the opening quote; returns the index after it. */
  function lexChar(start: number): number {
    let i = start + 1;
    let value: number | null = null;
    let problem: string | null = null;
    const c = text.charAt(i);
    if (c === '' || c === "'") {
      problem = c === '' ? 'missing closing quote' : 'empty literal';
      i += c === '' ? 0 : 1;
    } else {
      if (c === '\\') {
        const escaped = CHAR_ESCAPES[text.charAt(i + 1)];
        if (escaped === undefined) {
          problem = `unknown escape "\\${text.charAt(i + 1)}" (valid: \\n \\t \\r \\0 \\\\ \\')`;
        } else {
          value = escaped;
        }
        i += 2;
      } else {
        const code = c.codePointAt(0) ?? 0;
        if (code < 0x20 || code > 0x7e) {
          problem = 'only printable ASCII characters are allowed';
        } else {
          value = code;
        }
        i += c.length;
      }
      if (text.charAt(i) === "'") {
        i += 1;
      } else {
        // Skip to the closing quote, if there is one, so the rest of the line still lexes.
        const close = text.indexOf("'", i);
        problem ??=
          close === -1 ? 'missing closing quote' : 'a literal holds exactly one character';
        i = close === -1 ? text.length : close + 1;
      }
    }
    if (problem !== null) {
      diagnostics.push(diagnostic(locate(start, i), 'invalid-char', problem));
      value = null;
    }
    push('char', start, i, value);
    return i;
  }
}
