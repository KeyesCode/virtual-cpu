import {
  INSTRUCTION_FORMATS,
  MEMORY_SIZE,
  encodeRegisterByte,
  fromSigned8,
  type OperandSpec,
} from '@vcpu/shared';
import { diagnostic, type Diagnostic } from './diagnostics.js';
import type { Operand, ValueRef } from './parser.js';
import {
  ADDRESS_RANGE,
  IMMEDIATE_RANGE,
  checkRange,
  type AssemblerSymbol,
  type Layout,
  type Placement,
} from './pass1.js';

/** An inclusive range of addresses. */
export interface AddressRange {
  readonly start: number;
  readonly end: number;
}

/** The assembled memory image. */
export interface AssembledImage {
  /** All 256 bytes of memory; bytes nothing was emitted to are 0. */
  readonly image: Uint8Array;
  /** The address ranges that hold emitted bytes, in address order, adjacent ranges merged. */
  readonly ranges: readonly AddressRange[];
}

/** Where the bytes at an address came from. */
export interface SourceMapEntry {
  readonly address: number;
  /** Bytes this entry covers: the instruction length, or 1 for each `.byte` value. */
  readonly length: number;
  readonly line: number;
  readonly column: number;
  /** The statement's source text, e.g. `ADD R0, R1`. */
  readonly text: string;
}

export interface Emission {
  readonly bytes: AssembledImage;
  readonly sourceMap: ReadonlyMap<number, SourceMapEntry>;
}

/**
 * Pass 2: resolves symbols, range-checks every value, encodes instructions through the shared
 * opcode table and writes the bytes, reporting output that overlaps earlier output.
 */
export function emit(layout: Layout, diagnostics: Diagnostic[]): Emission {
  const image = new Uint8Array(MEMORY_SIZE);
  /** The source line that emitted each byte; `undefined` while the byte is unused. */
  const owner: (number | undefined)[] = new Array<number | undefined>(MEMORY_SIZE).fill(undefined);
  const sourceMap = new Map<number, SourceMapEntry>();

  const resolve = (ref: ValueRef): number | null => {
    if (ref.kind === 'literal') return ref.value;
    const symbol: AssemblerSymbol | undefined = layout.symbols.get(ref.name);
    if (symbol === undefined) {
      diagnostics.push(diagnostic(ref, 'undefined-symbol', ref.name));
      return null;
    }
    return symbol.value;
  };

  /** An immediate or `.byte` value as its byte, or `null` if it is unresolved or out of range. */
  const immediateByte = (ref: ValueRef): number | null => {
    const value = resolve(ref);
    if (value === null || !checkRange(value, ref, 'immediate', IMMEDIATE_RANGE, diagnostics)) {
      return null;
    }
    return value < 0 ? fromSigned8(value) : value;
  };

  const addressByte = (ref: ValueRef): number | null => {
    const value = resolve(ref);
    if (value === null || !checkRange(value, ref, 'address', ADDRESS_RANGE, diagnostics)) {
      return null;
    }
    return value;
  };

  /** The trailing byte of an instruction: an immediate or an address. */
  const operandByte = (operand: Operand, spec: OperandSpec): number | null => {
    const ref = operand.form === 'value' || operand.form === 'absolute' ? operand.value : null;
    if (ref === null) return null;
    return spec.kind === 'imm8' ? immediateByte(ref) : addressByte(ref);
  };

  /** Writes bytes unless any of them is already taken; returns false on overlap. */
  const write = (placement: Placement, address: number, bytes: readonly number[]): boolean => {
    for (const [i] of bytes.entries()) {
      const taken = owner[address + i];
      if (taken !== undefined) {
        diagnostics.push(diagnostic(placement.body, 'overlap', address + i, taken));
        return false;
      }
    }
    for (const [i, byte] of bytes.entries()) {
      image[address + i] = byte;
      owner[address + i] = placement.body.line;
    }
    return true;
  };

  for (const placement of layout.placements) {
    const { body } = placement;
    if (placement.kind === 'bytes') {
      const values = body.operands.map((operand) =>
        operand.form === 'value' ? immediateByte(operand.value) : null,
      );
      const bytes = values.filter((value): value is number => value !== null);
      if (bytes.length !== values.length || !write(placement, placement.address, bytes)) continue;
      body.operands.forEach((operand, i) => {
        const address = placement.address + i;
        sourceMap.set(address, {
          address,
          length: 1,
          line: operand.line,
          column: operand.column,
          text: body.text,
        });
      });
      continue;
    }

    const { info } = placement;
    if (info === null) continue;
    const fields = { a: 0, b: 0 };
    let trailing: number | null = null;
    let valid = true;
    // Every operand is checked, even after a bad one, so one run reports all problems.
    for (const [index, spec] of info.operands.entries()) {
      const operand = body.operands[index];
      if (operand === undefined) {
        valid = false;
      } else if (spec.field === 'byte') {
        trailing = operandByte(operand, spec);
        valid &&= trailing !== null;
      } else {
        const register =
          operand.form === 'register' || operand.form === 'indirect'
            ? operand.register.index
            : null;
        if (register === null) {
          valid = false;
        } else {
          fields[spec.field] = register;
        }
      }
    }
    if (!valid) continue;

    const format = INSTRUCTION_FORMATS[info.format];
    const bytes = [info.opcode];
    if (format.registerFields > 0) bytes.push(encodeRegisterByte(fields.a, fields.b));
    if (trailing !== null) bytes.push(trailing);
    if (!write(placement, placement.address, bytes)) continue;
    sourceMap.set(placement.address, {
      address: placement.address,
      length: bytes.length,
      line: body.line,
      column: body.column,
      text: body.text,
    });
  }

  return { bytes: { image, ranges: usedRanges(owner) }, sourceMap };
}

function usedRanges(owner: readonly (number | undefined)[]): AddressRange[] {
  const ranges: AddressRange[] = [];
  let start: number | null = null;
  for (let address = 0; address <= MEMORY_SIZE; address += 1) {
    const used = address < MEMORY_SIZE && owner[address] !== undefined;
    if (used && start === null) start = address;
    if (!used && start !== null) {
      ranges.push({ start, end: address - 1 });
      start = null;
    }
  }
  return ranges;
}
