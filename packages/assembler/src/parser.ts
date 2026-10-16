import type { RegisterIndex } from '@vcpu/shared';
import { diagnostic, type Diagnostic, type SourceLocation } from './diagnostics.js';
import { splitLines, tokenizeLine, type Token } from './lexer.js';

/** A register operand. `index` is `null` for a bad register name, which was already reported. */
export interface RegisterRef extends SourceLocation {
  readonly index: RegisterIndex | null;
  readonly text: string;
}

/** A value written as a literal or as a symbol name. */
export type ValueRef =
  | (SourceLocation & {
      readonly kind: 'literal';
      readonly value: number | null;
      readonly text: string;
    })
  | (SourceLocation & { readonly kind: 'symbol'; readonly name: string; readonly text: string });

/**
 * The four syntactic operand forms. Variant selection works on these forms only:
 * `Rn`, `value`, `[Rn]` and `[value]`.
 */
export type Operand =
  | (SourceLocation & {
      readonly form: 'register';
      readonly register: RegisterRef;
      readonly text: string;
    })
  | (SourceLocation & { readonly form: 'value'; readonly value: ValueRef; readonly text: string })
  | (SourceLocation & {
      readonly form: 'indirect';
      readonly register: RegisterRef;
      readonly text: string;
    })
  | (SourceLocation & {
      readonly form: 'absolute';
      readonly value: ValueRef;
      readonly text: string;
    });

export interface LabelDef extends SourceLocation {
  readonly name: string;
}

export type DirectiveName = '.org' | '.byte' | '.equ';

export interface StatementBody extends SourceLocation {
  readonly kind: 'instruction' | 'directive';
  /** The mnemonic or directive as written. */
  readonly name: string;
  /** The name's own location (the body's location covers the whole statement). */
  readonly nameLocation: SourceLocation;
  readonly operands: readonly Operand[];
  /** The statement's source text, from the name to the end of the last operand. */
  readonly text: string;
  /** True when the line had a syntax error; such a statement is laid out but never encoded. */
  readonly malformed: boolean;
}

export interface Statement {
  readonly line: number;
  readonly labels: readonly LabelDef[];
  readonly body: StatementBody | null;
}

const REGISTER_LIKE = /^[rR]([0-9]+)$/;

/** True for any `R<digits>` spelling, valid (R0–R7) or not. Such names are never symbols. */
export function isRegisterLike(name: string): boolean {
  return REGISTER_LIKE.test(name);
}

function toRegister(token: Token, diagnostics: Diagnostic[]): RegisterRef {
  const digits = REGISTER_LIKE.exec(token.text)?.[1] ?? '';
  const number = Number.parseInt(digits, 10);
  const valid = /^[0-7]$/.test(digits);
  if (!valid) {
    diagnostics.push(diagnostic(token, 'unknown-register', token.text));
  }
  return {
    index: valid ? (number as RegisterIndex) : null,
    text: token.text,
    line: token.line,
    column: token.column,
    span: token.span,
  };
}

function spanning(first: SourceLocation, last: SourceLocation): SourceLocation {
  return {
    line: first.line,
    column: first.column,
    span: { start: first.span.start, end: last.span.end },
  };
}

function describeToken(token: Token | undefined): string {
  return token === undefined ? 'end of line' : `"${token.text}"`;
}

/** Parses the whole source into statements, one per line (blank lines give an empty statement). */
export function parse(source: string, diagnostics: Diagnostic[]): Statement[] {
  return splitLines(source).map((line) => {
    const tokens = tokenizeLine(line, diagnostics);
    return parseLine(line.line, tokens, (start, end) => source.slice(start, end), diagnostics);
  });
}

function parseLine(
  line: number,
  tokens: readonly Token[],
  sliceSource: (start: number, end: number) => string,
  diagnostics: Diagnostic[],
): Statement {
  let i = 0;
  const labels: LabelDef[] = [];
  const peek = (offset = 0): Token | undefined => tokens[i + offset];

  for (
    let token = peek();
    token?.kind === 'identifier' && peek(1)?.kind === 'colon';
    token = peek()
  ) {
    labels.push({ name: token.text, line: token.line, column: token.column, span: token.span });
    i += 2;
  }

  const head = peek();
  if (head === undefined) {
    return { line, labels, body: null };
  }
  if (head.kind !== 'identifier' && head.kind !== 'directive') {
    diagnostics.push(
      diagnostic(
        head,
        'syntax',
        `expected a label, mnemonic or directive, found ${describeToken(head)}`,
      ),
    );
    return { line, labels, body: null };
  }
  i += 1;

  let malformed = false;
  const operands: Operand[] = [];
  const fail = (token: Token | undefined, message: string): void => {
    malformed = true;
    diagnostics.push(
      diagnostic(token ?? endOfLine(tokens[tokens.length - 1] ?? head), 'syntax', message),
    );
  };

  const parseValue = (token: Token): ValueRef | null => {
    if (token.kind === 'number' || token.kind === 'char') {
      return { kind: 'literal', value: token.value, text: token.text, ...locationOf(token) };
    }
    if (token.kind === 'identifier' && !isRegisterLike(token.text)) {
      return { kind: 'symbol', name: token.text, text: token.text, ...locationOf(token) };
    }
    return null;
  };

  const parseOperand = (): Operand | null => {
    const first = peek();
    if (first === undefined) {
      fail(first, 'expected an operand, found end of line');
      return null;
    }
    if (first.kind === 'lbracket') {
      const inner = peek(1);
      const close = peek(2);
      if (inner === undefined || (inner.kind !== 'identifier' && parseValue(inner) === null)) {
        fail(inner, `expected a register or an address after "[", found ${describeToken(inner)}`);
        return null;
      }
      if (close?.kind !== 'rbracket') {
        fail(close, `expected "]", found ${describeToken(close)}`);
        return null;
      }
      i += 3;
      const location = spanning(first, close);
      const text = sliceSource(location.span.start, location.span.end);
      if (isRegisterLike(inner.text)) {
        return { form: 'indirect', register: toRegister(inner, diagnostics), text, ...location };
      }
      const value = parseValue(inner);
      return value === null ? null : { form: 'absolute', value, text, ...location };
    }
    if (first.kind === 'identifier' && isRegisterLike(first.text)) {
      i += 1;
      return {
        form: 'register',
        register: toRegister(first, diagnostics),
        text: first.text,
        ...locationOf(first),
      };
    }
    const value = parseValue(first);
    if (value === null) {
      fail(first, `expected an operand, found ${describeToken(first)}`);
      return null;
    }
    i += 1;
    return { form: 'value', value, text: first.text, ...locationOf(first) };
  };

  if (peek() !== undefined) {
    for (;;) {
      const operand = parseOperand();
      if (operand === null) break;
      operands.push(operand);
      const next = peek();
      if (next === undefined) break;
      if (next.kind !== 'comma') {
        fail(next, `expected "," between operands, found ${describeToken(next)}`);
        break;
      }
      i += 1;
      if (peek() === undefined) {
        fail(next, 'expected an operand after ","');
        break;
      }
    }
  }

  const last = operands[operands.length - 1] ?? head;
  const location = spanning(head, last);
  return {
    line,
    labels,
    body: {
      kind: head.kind === 'directive' ? 'directive' : 'instruction',
      name: head.text,
      nameLocation: locationOf(head),
      operands,
      text: sliceSource(location.span.start, location.span.end),
      malformed,
      ...location,
    },
  };
}

/** The empty position just after the last token, where something is missing. */
function endOfLine(last: Token): SourceLocation {
  return {
    line: last.line,
    column: last.column + last.text.length,
    span: { start: last.span.end, end: last.span.end },
  };
}

function locationOf(token: SourceLocation): SourceLocation {
  return { line: token.line, column: token.column, span: token.span };
}
