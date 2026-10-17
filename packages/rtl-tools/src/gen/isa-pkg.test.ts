import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OPCODES } from '@vcpu/shared';
import { describe, expect, it } from 'vitest';
import { flagMask, ISA_PKG_PATH, renderIsaPackage } from './isa-pkg.js';

const rendered = renderIsaPackage();

/** `OP_<ID>: <fn> = <value>;` case lines of one generated lookup function, keyed by opcode id. */
function caseValues(fn: string): Map<string, string> {
  const pattern = new RegExp(`^ {6}OP_(\\w+):\\s+${fn} = ([^;]+);$`, 'gm');
  return new Map([...rendered.matchAll(pattern)].map((m) => [m[1] ?? '', m[2] ?? '']));
}

/** `opcode byte → FLAGS mask` from the decoder table in docs/hardware-porting.md. */
function portingDocMasks(): Map<number, string> {
  const doc = readFileSync(
    fileURLToPath(new URL('../../../../docs/hardware-porting.md', import.meta.url)),
    'utf8',
  );
  const masks = new Map<number, string>();
  for (const line of doc.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const op = /^`0x([0-9A-F]{2})`$/.exec(cells[1] ?? '');
    const mask = /^`([01]{4})`$/.exec(cells[9] ?? '');
    if (op?.[1] !== undefined && mask?.[1] !== undefined) {
      masks.set(Number.parseInt(op[1], 16), mask[1]);
    }
  }
  return masks;
}

describe('vcpu8_isa_pkg.sv', () => {
  it('is the committed file, byte for byte', () => {
    // On failure: run `pnpm hardware:gen` and commit hardware/rtl/vcpu8/core/vcpu8_isa_pkg.sv.
    expect(readFileSync(ISA_PKG_PATH, 'utf8')).toBe(rendered);
  });

  it('is deterministic and ends with one newline', () => {
    expect(renderIsaPackage()).toBe(rendered);
    expect(rendered.endsWith('endpackage\n')).toBe(true);
    expect(rendered).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('declares an OP_ localparam for each of the 30 opcodes', () => {
    const declared = [
      ...rendered.matchAll(/localparam logic \[7:0\] OP_(\w+)\s+= 8'h([0-9A-F]{2});/g),
    ];
    expect(OPCODES).toHaveLength(30);
    expect(declared.map((m) => [m[1], Number.parseInt(m[2] ?? '', 16)])).toEqual(
      OPCODES.map((info) => [info.id, info.opcode]),
    );
  });

  it('gives every opcode a row in every lookup function', () => {
    for (const fn of [
      'isa_valid',
      'isa_len',
      'isa_fields',
      'isa_flag_mask',
      'isa_ctrl',
      'isa_cond',
      'isa_data_read',
      'isa_data_write',
    ]) {
      expect([...caseValues(fn).keys()], fn).toEqual(OPCODES.map((info) => info.id));
    }
    const lengths = caseValues('isa_len');
    for (const info of OPCODES) {
      expect(lengths.get(info.id), info.id).toBe(`2'd${String(info.length)}`);
    }
  });

  it('uses the flag masks of docs/hardware-porting.md', () => {
    const docMasks = portingDocMasks();
    const generated = caseValues('isa_flag_mask');
    expect(docMasks.size).toBe(OPCODES.length);
    for (const info of OPCODES) {
      const expected = ['INC', 'DEC'].includes(info.id)
        ? '1011'
        : info.opcode >= 0x20 && info.opcode <= 0x36
          ? '1111'
          : '0000';
      expect(flagMask(info).toString(2).padStart(4, '0'), info.id).toBe(expected);
      expect(docMasks.get(info.opcode), info.id).toBe(expected);
      expect(generated.get(info.id), info.id).toBe(`4'b${expected}`);
    }
  });
});
