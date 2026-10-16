import { MNEMONICS } from '@vcpu/shared';

/** Display classes for VCPU-8 assembly. Only for colouring: the assembler does the real parsing. */
export type TokenClass =
  'plain' | 'comment' | 'label' | 'directive' | 'mnemonic' | 'register' | 'number' | 'string';

export interface Segment {
  readonly text: string;
  readonly cls: TokenClass;
  /** Inside an error diagnostic's span. */
  readonly error: boolean;
}

const MNEMONIC_SET = new Set<string>(MNEMONICS);
const TOKEN =
  /(;.*$)|('(?:\\.|[^'\\])*'?)|(\.[A-Za-z_]\w*)|([A-Za-z_]\w*)(\s*:)?|(\$?-?(?:0[xX][0-9A-Fa-f]+|0[bB][01]+|\d+))/gy;

/** Classifies each character of one source line. */
export function classifyLine(text: string): TokenClass[] {
  const classes = new Array<TokenClass>(text.length).fill('plain');
  const mark = (start: number, end: number, cls: TokenClass): void => {
    classes.fill(cls, start, end);
  };
  let first = true;
  let i = 0;
  while (i < text.length) {
    TOKEN.lastIndex = i;
    const match = TOKEN.exec(text);
    if (match === null) {
      i += 1;
      continue;
    }
    const [whole, comment, char, directive, word, colon, number] = match;
    const end = i + whole.length;
    if (comment !== undefined) mark(i, end, 'comment');
    else if (char !== undefined) mark(i, end, 'string');
    else if (directive !== undefined) mark(i, end, 'directive');
    else if (word !== undefined) {
      if (colon !== undefined && first) mark(i, end, 'label');
      else if (/^[Rr][0-7]$/.test(word)) mark(i, end, 'register');
      else if (MNEMONIC_SET.has(word.toUpperCase())) mark(i, end, 'mnemonic');
      else if (colon !== undefined) mark(i, end, 'label');
    } else if (number !== undefined) mark(i, end, 'number');
    first = false;
    i = end;
  }
  return classes;
}

/**
 * Splits a line into coloured segments, flagging the columns in `errors` (0-based, half-open
 * `[start, end)`). An error past the end of the line is drawn on one trailing space.
 */
export function highlightLine(
  text: string,
  errors: readonly (readonly [number, number])[] = [],
): Segment[] {
  const padded = errors.some(([start]) => start >= text.length) ? `${text} ` : text;
  const classes = classifyLine(padded);
  const errorAt = new Array<boolean>(padded.length).fill(false);
  for (const [start, end] of errors) {
    const from = Math.min(start, padded.length - 1);
    errorAt.fill(true, Math.max(0, from), Math.max(from + 1, Math.min(end, padded.length)));
  }
  const segments: Segment[] = [];
  let start = 0;
  for (let i = 1; i <= padded.length; i += 1) {
    if (i === padded.length || classes[i] !== classes[start] || errorAt[i] !== errorAt[start]) {
      segments.push({
        text: padded.slice(start, i),
        cls: classes[start] ?? 'plain',
        error: errorAt[start] ?? false,
      });
      start = i;
    }
  }
  return segments;
}
