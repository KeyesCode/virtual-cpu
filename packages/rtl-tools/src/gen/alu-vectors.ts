import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALU_OPERATIONS, type AluOpcodeId } from '@vcpu/cpu-core';

/** Where `make test-alu` expects the vectors; build/ is git-ignored. */
export const ALU_VECTORS_PATH = fileURLToPath(
  new URL('../../../../hardware/rtl/vcpu8/build/vectors/alu.hex', import.meta.url),
);

/** The hand-written types package whose `alu_op_t` gives each operation's select value. */
export const TYPES_PKG_PATH = fileURLToPath(
  new URL('../../../../hardware/rtl/vcpu8/core/vcpu8_types_pkg.sv', import.meta.url),
);

/**
 * Record op field for CMP. CMP has no `alu_op_t` value of its own (the decoder selects ALU_SUB),
 * so its vectors carry this code; the testbench drives ALU_SUB for it and expects `cmp()`'s
 * result. Must match VEC_OP_CMP in tb/unit/tb_vcpu8_alu.sv.
 */
export const VEC_OP_CMP = 0xf;

/** How each operation is swept. */
type Sweep = 'binary' | 'divide' | 'flags' | 'unary';

/** Generation order and sweep of every ALU operation. */
export const ALU_SWEEPS: readonly (readonly [AluOpcodeId, Sweep])[] = [
  ['ADD', 'binary'],
  ['SUB', 'binary'],
  ['CMP', 'binary'],
  ['MUL', 'binary'],
  ['DIV', 'divide'],
  ['INC', 'flags'],
  ['DEC', 'flags'],
  ['AND', 'binary'],
  ['OR', 'binary'],
  ['XOR', 'binary'],
  ['NOT', 'unary'],
  ['SHL', 'unary'],
  ['SHR', 'unary'],
];

/** One test: the inputs the testbench drives and the outputs `@vcpu/cpu-core` produced. */
export interface AluVector {
  readonly id: AluOpcodeId;
  /** The record's op field: the `alu_op_t` value, or VEC_OP_CMP. */
  readonly code: number;
  readonly a: number;
  readonly b: number;
  /** Incoming FLAGS (ZCNV); only INC and DEC read it, for C. */
  readonly flagsIn: number;
  readonly result: number;
  readonly flags: number;
}

/** `ALU_<NAME> = 4'd<n>` entries of `alu_op_t` in the types package source. */
export function parseAluOpCodes(typesPkgSource: string): ReadonlyMap<string, number> {
  const codes = new Map<string, number>();
  for (const match of typesPkgSource.matchAll(/\bALU_(\w+)\s*=\s*4'd(\d+)/g)) {
    codes.set(match[1] ?? '', Number(match[2]));
  }
  return codes;
}

/** Record op field for each operation, taken from `alu_op_t` so the two can never disagree. */
export function aluOpCodes(
  typesPkgSource = readFileSync(TYPES_PKG_PATH, 'utf8'),
): ReadonlyMap<AluOpcodeId, number> {
  const parsed = parseAluOpCodes(typesPkgSource);
  const codes = new Map<AluOpcodeId, number>();
  for (const [id] of ALU_SWEEPS) {
    const code = id === 'CMP' ? VEC_OP_CMP : parsed.get(id);
    if (code === undefined) {
      throw new Error(`alu_op_t has no ALU_${id}`);
    }
    codes.set(id, code);
  }
  return codes;
}

function* sweepInputs(sweep: Sweep): Generator<readonly [number, number, number]> {
  for (let a = 0; a < 0x100; a += 1) {
    if (sweep === 'binary' || sweep === 'divide') {
      for (let b = sweep === 'divide' ? 1 : 0; b < 0x100; b += 1) {
        yield [a, b, 0];
      }
    } else if (sweep === 'flags') {
      for (let flags = 0; flags < 0x10; flags += 1) {
        yield [a, 0, flags];
      }
    } else {
      yield [a, 0, 0];
    }
  }
}

/** Every ALU test vector, in generation order, computed by calling `ALU_OPERATIONS`. */
export function* aluVectors(codes = aluOpCodes()): Generator<AluVector> {
  for (const [id, sweep] of ALU_SWEEPS) {
    const operation = ALU_OPERATIONS[id];
    const code = codes.get(id) ?? 0;
    for (const [a, b, flagsIn] of sweepInputs(sweep)) {
      const { result, flags } = operation(a, b, flagsIn);
      yield { id, code, a, b, flagsIn, result, flags };
    }
  }
}

const hex = (value: number, digits: number): string =>
  value.toString(16).toUpperCase().padStart(digits, '0');

/**
 * One `$readmemh` word of 36 bits (9 hex digits):
 * `{op[3:0], a[7:0], b[7:0], flags_in[3:0], r[7:0], flags[3:0]}`, flags as ZCNV.
 */
export function formatAluVector(vector: AluVector): string {
  return (
    hex(vector.code, 1) +
    hex(vector.a, 2) +
    hex(vector.b, 2) +
    hex(vector.flagsIn, 1) +
    hex(vector.result, 2) +
    hex(vector.flags, 1)
  );
}

/** The vectors file (one record per line) and the record count the testbench reads from alu.meta. */
export function renderAluVectors(codes = aluOpCodes()): { hex: string; count: number } {
  const lines: string[] = [];
  for (const vector of aluVectors(codes)) {
    lines.push(formatAluVector(vector));
  }
  return { hex: `${lines.join('\n')}\n`, count: lines.length };
}
