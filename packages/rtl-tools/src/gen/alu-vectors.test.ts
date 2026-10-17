import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ALU_SWEEPS,
  aluOpCodes,
  type AluVector,
  aluVectors,
  formatAluVector,
  parseAluOpCodes,
  renderAluVectors,
  TYPES_PKG_PATH,
  VEC_OP_CMP,
} from './alu-vectors.js';

const vectors = [...aluVectors()];
const { hex, count } = renderAluVectors();

/** The record with these inputs. */
function lookup(id: AluVector['id'], a: number, b = 0, flagsIn = 0): AluVector {
  const vector = vectors.find(
    (v) => v.id === id && v.a === a && v.b === b && v.flagsIn === flagsIn,
  );
  if (vector === undefined) {
    throw new Error(`no ${id} vector for a=${String(a)} b=${String(b)} flags=${String(flagsIn)}`);
  }
  return vector;
}

describe('ALU vectors', () => {
  it('cover every operand exhaustively: 7 × 65,536 + 65,280 + 2 × 256 × 16 + 3 × 256 records', () => {
    expect(count).toBe(7 * 65_536 + 65_280 + 2 * 256 * 16 + 3 * 256);
    expect(count).toBe(532_992);
    expect(vectors).toHaveLength(count);
    const perOp = new Map<string, number>();
    for (const v of vectors) {
      perOp.set(v.id, (perOp.get(v.id) ?? 0) + 1);
    }
    expect(Object.fromEntries(perOp)).toEqual({
      ADD: 65_536,
      SUB: 65_536,
      CMP: 65_536,
      MUL: 65_536,
      DIV: 65_280,
      INC: 4_096,
      DEC: 4_096,
      AND: 65_536,
      OR: 65_536,
      XOR: 65_536,
      NOT: 256,
      SHL: 256,
      SHR: 256,
    });
    expect(vectors.some((v) => v.id === 'DIV' && v.b === 0)).toBe(false);
  });

  it('render one 9-digit record per line, deterministically', () => {
    const lines = hex.split('\n');
    expect(lines.pop()).toBe('');
    expect(lines).toHaveLength(count);
    expect(lines.every((line) => /^[0-9A-F]{9}$/.test(line))).toBe(true);
    expect(renderAluVectors().hex).toBe(hex);
  });

  it('take op codes from alu_op_t in vcpu8_types_pkg.sv, with CMP on its own code', () => {
    const declared = parseAluOpCodes(readFileSync(TYPES_PKG_PATH, 'utf8'));
    const codes = aluOpCodes();
    for (const [id] of ALU_SWEEPS) {
      expect(codes.get(id)).toBe(id === 'CMP' ? VEC_OP_CMP : declared.get(id));
    }
    expect([...declared.values()]).not.toContain(VEC_OP_CMP);
    expect(() => aluOpCodes("typedef enum logic [3:0] { ALU_ADD = 4'd0 } alu_op_t;")).toThrow(
      /ALU_SUB/,
    );
  });

  it('pack {op, a, b, flags_in, r, flags}', () => {
    expect(formatAluVector(lookup('ADD', 0x7f, 0x01))).toBe('07F010803');
    expect(formatAluVector(lookup('INC', 0xff, 0, 0b0100))).toBe('4FF00400C');
    expect(formatAluVector(lookup('CMP', 0x00, 0x01))).toBe('F00010FF6');
  });

  // The documented edge cases (docs/instruction-set.md#exact-flag-rules), ZCNV = bits 3..0.
  it.each([
    ['ADD', 0x7f, 0x01, 0, 0x80, 0b0011],
    ['ADD', 0xff, 0x01, 0, 0x00, 0b1100],
    ['SUB', 0x00, 0x01, 0, 0xff, 0b0110],
    ['SUB', 0x80, 0x01, 0, 0x7f, 0b0001],
    ['CMP', 0x05, 0x05, 0, 0x00, 0b1000],
    ['MUL', 0x10, 0x10, 0, 0x00, 0b1101],
    ['DIV', 0xff, 0x10, 0, 0x0f, 0b0000],
    ['INC', 0xff, 0, 0b0100, 0x00, 0b1100],
    ['INC', 0x7f, 0, 0b1111, 0x80, 0b0111],
    ['DEC', 0x00, 0, 0b0100, 0xff, 0b0110],
    ['DEC', 0x80, 0, 0b0000, 0x7f, 0b0001],
    ['NOT', 0x0f, 0, 0, 0xf0, 0b0010],
    ['SHL', 0x81, 0, 0, 0x02, 0b0100],
    ['SHR', 0x01, 0, 0, 0x00, 0b1100],
  ] as const)('%s a=%i b=%i flags=%i gives r=%i flags=%i', (id, a, b, flagsIn, result, flags) => {
    expect(lookup(id, a, b, flagsIn)).toMatchObject({ result, flags });
  });
});
