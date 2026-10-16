import {
  MAX_ADDRESS,
  MEMORY_SIZE,
  MNEMONICS,
  opcodesByMnemonic,
  type Mnemonic,
  type OpcodeInfo,
  type OperandSpec,
} from '@vcpu/shared';
import { diagnostic, type Diagnostic, type SourceLocation } from './diagnostics.js';
import {
  isRegisterLike,
  type DirectiveName,
  type Operand,
  type Statement,
  type StatementBody,
  type ValueRef,
} from './parser.js';

export type SymbolKind = 'label' | 'equ';

export interface AssemblerSymbol {
  readonly name: string;
  readonly kind: SymbolKind;
  /** A label's address, or a `.equ` constant's value. */
  readonly value: number;
  /** Where the symbol is defined. */
  readonly line: number;
  readonly column: number;
}

/** The result of laying out one statement in pass 1. */
export type Placement =
  | {
      readonly kind: 'instruction';
      readonly body: StatementBody;
      readonly address: number;
      /** `null` when no opcode variant matched; the statement is then never encoded. */
      readonly info: OpcodeInfo | null;
    }
  | { readonly kind: 'bytes'; readonly body: StatementBody; readonly address: number };

export interface Layout {
  readonly placements: readonly Placement[];
  readonly symbols: ReadonlyMap<string, AssemblerSymbol>;
}

/** Inclusive limits for a value used as an immediate (or `.byte`) and as an address. */
export const IMMEDIATE_RANGE = { min: -0x80, max: 0xff } as const;
export const ADDRESS_RANGE = { min: 0x00, max: MAX_ADDRESS } as const;

const MNEMONIC_SET: ReadonlySet<string> = new Set(MNEMONICS);
const DIRECTIVES: readonly DirectiveName[] = ['.org', '.byte', '.equ'];

export function lookupMnemonic(name: string): Mnemonic | null {
  const upper = name.toUpperCase();
  return MNEMONIC_SET.has(upper) ? (upper as Mnemonic) : null;
}

/** Why `name` cannot name a symbol, or `null` if it can. */
export function reservedNameReason(name: string): string | null {
  if (isRegisterLike(name)) return 'a register name';
  if (lookupMnemonic(name) !== null) return 'a mnemonic';
  return null;
}

/** True when an operand's syntactic form fits an opcode-table operand spec. */
export function operandFits(operand: Operand, spec: OperandSpec): boolean {
  switch (spec.kind) {
    case 'reg':
      return operand.form === 'register';
    case 'regIndirect':
      return operand.form === 'indirect';
    case 'imm8':
      return operand.form === 'value';
    case 'addr8':
      // A data address is written in brackets; a jump or call target is written bare.
      return operand.form === (spec.role === 'addr' ? 'absolute' : 'value');
  }
}

/** How a spec is written, for error messages. */
function describeSpec(spec: OperandSpec): string {
  switch (spec.kind) {
    case 'reg':
      return 'a register';
    case 'regIndirect':
      return 'a register in brackets like [R1]';
    case 'imm8':
      return 'an immediate value';
    case 'addr8':
      return spec.role === 'addr' ? 'an address in brackets like [0x80]' : 'an address or label';
  }
}

function pluralOperands(count: number): string {
  return `${String(count)} operand${count === 1 ? '' : 's'}`;
}

/**
 * Picks the opcode variant whose operand specs fit the written operand forms, reporting a
 * count or kind mismatch. Selection is purely syntactic: `[Rn]` selects register-indirect,
 * any other bracketed operand selects absolute.
 */
function selectVariant(
  body: StatementBody,
  mnemonic: Mnemonic,
  diagnostics: Diagnostic[],
): OpcodeInfo | null {
  const variants = opcodesByMnemonic[mnemonic];
  const expected = variants[0]?.operands.length ?? 0;
  const forms = variants.map((info) => info.syntax).join(' or ');
  if (body.operands.length !== expected) {
    const extra = body.operands[expected];
    const where: SourceLocation = extra ?? body.nameLocation;
    const message =
      expected === 0
        ? `${mnemonic} takes no operands, got ${String(body.operands.length)}`
        : `${mnemonic} expects ${pluralOperands(expected)} (${forms}), got ${String(body.operands.length)}`;
    diagnostics.push(diagnostic(where, 'operand-count', message));
    return null;
  }
  const match = variants.find((info) =>
    info.operands.every((spec, index) => {
      const operand = body.operands[index];
      return operand !== undefined && operandFits(operand, spec);
    }),
  );
  if (match !== undefined) {
    return match;
  }
  // Report the first operand that fits no variant at its position.
  for (const [index, operand] of body.operands.entries()) {
    const specs = variants.flatMap((info) => info.operands[index] ?? []);
    if (!specs.some((spec) => operandFits(operand, spec))) {
      const wanted = [...new Set(specs.map(describeSpec))].join(' or ');
      diagnostics.push(
        diagnostic(
          operand,
          'operand-kind',
          `operand ${String(index + 1)} of ${mnemonic} must be ${wanted}, got "${operand.text}"`,
        ),
      );
      return null;
    }
  }
  diagnostics.push(
    diagnostic(body, 'operand-kind', `operands do not match any form of ${mnemonic}: ${forms}`),
  );
  return null;
}

/** Size used for layout when no variant matched, so later labels stay as close as possible. */
function fallbackLength(mnemonic: Mnemonic, body: StatementBody): number {
  const variants = opcodesByMnemonic[mnemonic];
  const indirect = body.operands.some((operand) => operand.form === 'indirect');
  const guess =
    variants.find(
      (info) => info.operands.some((spec) => spec.kind === 'regIndirect') === indirect,
    ) ?? variants[0];
  return guess?.length ?? 0;
}

/**
 * Pass 1: walks the statements with a location counter, defines labels and `.equ` constants,
 * applies `.org`, and sizes every instruction from the shared opcode table.
 */
export function layout(
  statements: readonly Statement[],
  origin: number,
  diagnostics: Diagnostic[],
): Layout {
  const symbols = new Map<string, AssemblerSymbol>();
  const placements: Placement[] = [];
  // Every name defined anywhere, to tell "defined below" apart from "never defined".
  const definedSomewhere = new Set<string>();
  for (const statement of statements) {
    for (const label of statement.labels) definedSomewhere.add(label.name);
    const body = statement.body;
    const first = body?.operands[0];
    if (
      body?.name.toLowerCase() === '.equ' &&
      first?.form === 'value' &&
      first.value.kind === 'symbol'
    ) {
      definedSomewhere.add(first.value.name);
    }
  }

  let lc = origin;
  let overflowReported = false;

  const define = (name: string, kind: SymbolKind, value: number, at: SourceLocation): void => {
    const reserved = reservedNameReason(name);
    if (reserved !== null) {
      diagnostics.push(diagnostic(at, 'reserved-name', name, reserved));
      return;
    }
    const existing = symbols.get(name);
    if (existing !== undefined) {
      diagnostics.push(diagnostic(at, 'duplicate-symbol', name, existing.line));
      return;
    }
    symbols.set(name, { name, kind, value, line: at.line, column: at.column });
  };

  /** Resolves a value that pass 1 needs right away (`.org`, `.equ`). */
  const resolveNow = (value: ValueRef, directive: string): number | null => {
    if (value.kind === 'literal') return value.value;
    const symbol = symbols.get(value.name);
    if (symbol !== undefined) return symbol.value;
    diagnostics.push(
      definedSomewhere.has(value.name)
        ? diagnostic(value, 'symbol-not-yet-defined', value.name, directive)
        : diagnostic(value, 'undefined-symbol', value.name),
    );
    return null;
  };

  const place = (placement: Placement, size: number): void => {
    if (lc + size > MEMORY_SIZE) {
      if (!overflowReported) {
        diagnostics.push(diagnostic(placement.body, 'overflow', lc, size));
        overflowReported = true;
      }
    } else if (!placement.body.malformed) {
      placements.push(placement);
    }
    lc += size;
  };

  for (const statement of statements) {
    for (const label of statement.labels) {
      define(label.name, 'label', lc, label);
    }
    const body = statement.body;
    if (body === null) continue;

    if (body.kind === 'instruction') {
      const mnemonic = lookupMnemonic(body.name);
      if (mnemonic === null) {
        diagnostics.push(diagnostic(body.nameLocation, 'unknown-mnemonic', body.name));
        continue;
      }
      const info = body.malformed ? null : selectVariant(body, mnemonic, diagnostics);
      place(
        { kind: 'instruction', body, address: lc, info },
        info?.length ?? fallbackLength(mnemonic, body),
      );
      continue;
    }

    const directive = DIRECTIVES.find((name) => name === body.name.toLowerCase());
    if (directive === undefined) {
      diagnostics.push(diagnostic(body.nameLocation, 'unknown-directive', body.name));
      continue;
    }
    if (body.malformed) {
      if (directive === '.byte') place({ kind: 'bytes', body, address: lc }, body.operands.length);
      continue;
    }
    const values = directiveValues(body, directive, diagnostics);
    if (values === null) {
      continue;
    }
    if (directive === '.byte') {
      place({ kind: 'bytes', body, address: lc }, values.length);
    } else if (directive === '.org') {
      const target = values[0] === undefined ? null : resolveNow(values[0], '.org');
      if (target === null || values[0] === undefined) continue;
      if (!checkRange(target, values[0], 'address', ADDRESS_RANGE, diagnostics)) continue;
      if (target < lc) {
        // Applied anyway, so that any output it would overwrite is reported as an overlap.
        diagnostics.push(diagnostic(body, 'org-backwards', target, lc));
      }
      lc = target;
    } else {
      const [name, valueRef] = values;
      if (name === undefined || valueRef === undefined) continue;
      if (name.kind !== 'symbol') {
        diagnostics.push(
          diagnostic(name, 'syntax', `.equ needs a name first, found "${name.text}"`),
        );
        continue;
      }
      const value = resolveNow(valueRef, '.equ');
      if (
        value === null ||
        !checkRange(value, valueRef, 'constant', IMMEDIATE_RANGE, diagnostics)
      ) {
        continue;
      }
      define(name.name, 'equ', value, name);
    }
  }

  return { placements, symbols };
}

/** Checks a directive's operand count and that every operand is a plain value. */
function directiveValues(
  body: StatementBody,
  directive: DirectiveName,
  diagnostics: Diagnostic[],
): ValueRef[] | null {
  const counts: Record<DirectiveName, [number, string]> = {
    '.org': [1, '.org address'],
    '.equ': [2, '.equ NAME, value'],
    '.byte': [1, '.byte value[, value…]'],
  };
  const [count, syntax] = counts[directive];
  const got = body.operands.length;
  if (directive === '.byte' ? got < count : got !== count) {
    const extra = directive === '.byte' ? undefined : body.operands[count];
    diagnostics.push(
      diagnostic(
        extra ?? body.nameLocation,
        'operand-count',
        directive === '.byte'
          ? `.byte expects at least one value (${syntax})`
          : `${directive} expects ${pluralOperands(count)} (${syntax}), got ${String(got)}`,
      ),
    );
    return null;
  }
  const values: ValueRef[] = [];
  for (const operand of body.operands) {
    if (operand.form !== 'value') {
      diagnostics.push(
        diagnostic(
          operand,
          'operand-kind',
          `${directive} takes numbers, characters or symbols, got "${operand.text}"`,
        ),
      );
      return null;
    }
    values.push(operand.value);
  }
  return values;
}

/** Range-checks a resolved value; reports and returns false when it is out of range. */
export function checkRange(
  value: number,
  ref: ValueRef,
  what: 'immediate' | 'address' | 'constant',
  range: { readonly min: number; readonly max: number },
  diagnostics: Diagnostic[],
): boolean {
  if (value >= range.min && value <= range.max) {
    return true;
  }
  const shown = ref.kind === 'symbol' ? `"${ref.name}" (${String(value)})` : ref.text;
  diagnostics.push(
    diagnostic(
      ref,
      'value-out-of-range',
      `${what} ${shown} out of range (valid: ${String(range.min)}..${String(range.max)})`,
    ),
  );
  return false;
}
