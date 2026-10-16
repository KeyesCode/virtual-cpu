import { describe, expect, it } from 'vitest';
import { isU8 } from '../bits.js';
import { TIMING_MODEL } from './constants.js';
import { INSTRUCTION_FORMATS } from './formats.js';
import {
  estimatedCycles,
  lookupOpcode,
  Op,
  opcodeById,
  opcodeByByte,
  opcodesByMnemonic,
  OPCODES,
} from './opcodes.js';
import {
  FLAG_NAMES,
  MNEMONICS,
  OPCODE_IDS,
  type FlagName,
  type InstructionCategory,
  type OpcodeId,
  type OpcodeInfo,
  type OperandSpec,
} from './types.js';

/** The minimum instruction set from the project brief, §5. */
const BRIEF_MNEMONICS = [
  'MOV',
  'LDI',
  'LOAD',
  'STORE',
  'ADD',
  'SUB',
  'MUL',
  'DIV',
  'INC',
  'DEC',
  'AND',
  'OR',
  'XOR',
  'NOT',
  'SHL',
  'SHR',
  'CMP',
  'JMP',
  'JZ',
  'JNZ',
  'JC',
  'JNC',
  'CALL',
  'RET',
  'PUSH',
  'POP',
  'NOP',
  'HLT',
];

/** Flag effects from the ISA v1.0 design: [written, cleared]; every other flag is unchanged. */
const SPEC_FLAGS: Record<OpcodeId, [FlagName[], FlagName[]]> = {
  NOP: [[], []],
  HLT: [[], []],
  MOV: [[], []],
  LDI: [[], []],
  LOAD_ABS: [[], []],
  LOAD_IND: [[], []],
  STORE_ABS: [[], []],
  STORE_IND: [[], []],
  ADD: [['Z', 'C', 'N', 'V'], []],
  SUB: [['Z', 'C', 'N', 'V'], []],
  MUL: [['Z', 'C', 'N', 'V'], []],
  DIV: [
    ['Z', 'N'],
    ['C', 'V'],
  ],
  INC: [['Z', 'N', 'V'], []],
  DEC: [['Z', 'N', 'V'], []],
  AND: [
    ['Z', 'N'],
    ['C', 'V'],
  ],
  OR: [
    ['Z', 'N'],
    ['C', 'V'],
  ],
  XOR: [
    ['Z', 'N'],
    ['C', 'V'],
  ],
  NOT: [
    ['Z', 'N'],
    ['C', 'V'],
  ],
  SHL: [['Z', 'C', 'N'], ['V']],
  SHR: [['Z', 'C', 'N'], ['V']],
  CMP: [['Z', 'C', 'N', 'V'], []],
  JMP: [[], []],
  JZ: [[], []],
  JNZ: [[], []],
  JC: [[], []],
  JNC: [[], []],
  CALL: [[], []],
  RET: [[], []],
  PUSH: [[], []],
  POP: [[], []],
};

const CATEGORY_BY_HIGH_NIBBLE: Record<number, InstructionCategory> = {
  0x0: 'system',
  0x1: 'data',
  0x2: 'arithmetic',
  0x3: 'logic',
  0x4: 'control',
  0x5: 'stack',
};

const REGISTER_PLACEHOLDER = { dest: 'Rd', src: 'Rs', lhs: 'Ra', rhs: 'Rb' } as const;

function renderOperand(operand: OperandSpec): string {
  switch (operand.role) {
    case 'dest':
    case 'src':
    case 'lhs':
    case 'rhs':
      return REGISTER_PLACEHOLDER[operand.role];
    case 'ptr':
      return '[Rp]';
    case 'imm':
      return 'imm8';
    case 'addr':
      return '[addr8]';
    case 'target':
      return 'addr8';
  }
}

function renderSyntax(info: OpcodeInfo): string {
  const operands = info.operands.map(renderOperand).join(', ');
  return operands === '' ? info.mnemonic : `${info.mnemonic} ${operands}`;
}

const isInFlagOrder = (flags: readonly FlagName[]): boolean => {
  const positions = flags.map((flag) => FLAG_NAMES.indexOf(flag));
  return positions.every((position, i) => i === 0 || (positions[i - 1] ?? -1) < position);
};

describe('opcode table', () => {
  it('has 30 opcodes, unique and in ascending order', () => {
    expect(OPCODES).toHaveLength(30);
    const bytes = OPCODES.map((info) => info.opcode);
    expect(new Set(bytes).size).toBe(30);
    expect(bytes).toEqual([...bytes].sort((x, y) => x - y));
    for (const byte of bytes) {
      expect(isU8(byte)).toBe(true);
    }
  });

  it('gives every opcode a unique id that matches Op and OPCODE_IDS', () => {
    expect(OPCODES.map((info) => info.id)).toEqual([...OPCODE_IDS]);
    expect(Object.keys(Op)).toEqual([...OPCODE_IDS]);
    for (const info of OPCODES) {
      expect(Op[info.id]).toBe(info.opcode);
      expect(opcodeById[info.id]).toBe(info);
    }
  });

  it('covers every mnemonic the brief requires, and nothing else', () => {
    const tableMnemonics = new Set(OPCODES.map((info) => info.mnemonic));
    expect([...tableMnemonics].sort()).toEqual([...BRIEF_MNEMONICS].sort());
    expect([...MNEMONICS].sort()).toEqual([...BRIEF_MNEMONICS].sort());
  });

  it.each(OPCODES)('$id: length matches its $format format', (info) => {
    expect(info.length).toBe(INSTRUCTION_FORMATS[info.format].length);
  });

  it.each(OPCODES)('$id: operands fit the $format format', (info) => {
    const format = INSTRUCTION_FORMATS[info.format];
    const fields = info.operands.map((operand) => operand.field);
    expect(new Set(fields).size).toBe(fields.length);

    const registerFields = fields.filter((field) => field !== 'byte').sort();
    expect(registerFields).toEqual(['a', 'b'].slice(0, format.registerFields));

    const trailing = info.operands.filter((operand) => operand.field === 'byte');
    expect(trailing.map((operand) => operand.kind)).toEqual(
      format.trailingByte === null ? [] : [format.trailingByte],
    );

    for (const operand of info.operands) {
      const expectedKind = {
        dest: 'reg',
        src: 'reg',
        lhs: 'reg',
        rhs: 'reg',
        ptr: 'regIndirect',
        imm: 'imm8',
        addr: 'addr8',
        target: 'addr8',
      }[operand.role];
      expect(operand.kind).toBe(expectedKind);
    }
  });

  it.each(OPCODES)('$id: syntax string matches its operands', (info) => {
    expect(info.syntax).toBe(renderSyntax(info));
  });

  it.each(OPCODES)('$id: category matches the opcode high nibble', (info) => {
    expect(info.category).toBe(CATEGORY_BY_HIGH_NIBBLE[info.opcode >> 4]);
  });

  it.each(OPCODES)('$id: flag effects match the ISA design', (info) => {
    const [written, cleared] = SPEC_FLAGS[info.id];
    expect(info.flagsWritten).toEqual(written);
    expect(info.flagsCleared).toEqual(cleared);
    expect(info.flagsWritten.filter((flag) => info.flagsCleared.includes(flag))).toEqual([]);
    expect(isInFlagOrder(info.flagsWritten)).toBe(true);
    expect(isInFlagOrder(info.flagsCleared)).toBe(true);
  });

  it.each(OPCODES)('$id: control flow, condition and penalty agree', (info) => {
    const transfersControl = ['jump', 'branch', 'call', 'return'].includes(info.controlFlow);
    expect(info.branchTakenPenalty).toBe(transfersControl ? TIMING_MODEL.branchTakenPenalty : 0);
    expect(info.condition !== null).toBe(info.controlFlow === 'branch');
    expect(transfersControl).toBe(info.category === 'control');
    if (transfersControl) {
      expect(info.flagsWritten).toEqual([]);
      expect(info.flagsCleared).toEqual([]);
    }
  });

  it('defines the four conditional branches on Z and C', () => {
    const conditions = OPCODES.filter((info) => info.controlFlow === 'branch').map((info) => [
      info.id,
      info.condition,
    ]);
    expect(conditions).toEqual([
      ['JZ', { flag: 'Z', value: 1 }],
      ['JNZ', { flag: 'Z', value: 0 }],
      ['JC', { flag: 'C', value: 1 }],
      ['JNC', { flag: 'C', value: 0 }],
    ]);
    expect(opcodeById.HLT.controlFlow).toBe('halt');
    expect(opcodeById.JMP.controlFlow).toBe('jump');
    expect(opcodeById.CALL.controlFlow).toBe('call');
    expect(opcodeById.RET.controlFlow).toBe('return');
  });

  it('marks exactly the data-memory accesses of the ISA design', () => {
    const readers = OPCODES.filter((info) => info.dataReads === 1).map((info) => info.id);
    const writers = OPCODES.filter((info) => info.dataWrites === 1).map((info) => info.id);
    expect(readers).toEqual(['LOAD_ABS', 'LOAD_IND', 'RET', 'POP']);
    expect(writers).toEqual(['STORE_ABS', 'STORE_IND', 'CALL', 'PUSH']);
  });

  it.each(OPCODES)('$id: base cycles follow the timing model', (info) => {
    const extra = info.id === 'MUL' ? 3 : info.id === 'DIV' ? 7 : 0;
    expect(info.extraExecuteCycles).toBe(extra);
    expect(info.baseCycles).toBe(
      info.length * TIMING_MODEL.fetchCyclesPerByte +
        TIMING_MODEL.executeCycles +
        (info.dataReads + info.dataWrites) * TIMING_MODEL.dataAccessCycles +
        info.extraExecuteCycles,
    );
    expect(estimatedCycles(info, false)).toBe(info.baseCycles);
    expect(estimatedCycles(info, true)).toBe(info.baseCycles + info.branchTakenPenalty);
  });

  it('keeps the timing model constants of the ISA design', () => {
    expect(TIMING_MODEL).toEqual({
      fetchCyclesPerByte: 1,
      executeCycles: 1,
      dataAccessCycles: 1,
      mulExtraCycles: 3,
      divExtraCycles: 7,
      branchTakenPenalty: 1,
    });
    expect(opcodeById.MUL.extraExecuteCycles).toBe(TIMING_MODEL.mulExtraCycles);
    expect(opcodeById.DIV.extraExecuteCycles).toBe(TIMING_MODEL.divExtraCycles);
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(OPCODES)).toBe(true);
    for (const info of OPCODES) {
      expect(Object.isFrozen(info)).toBe(true);
      expect(Object.isFrozen(info.operands)).toBe(true);
      expect(Object.isFrozen(info.flagsWritten)).toBe(true);
      for (const operand of info.operands) {
        expect(Object.isFrozen(operand)).toBe(true);
      }
    }
    expect(() => {
      (OPCODES[0] as { baseCycles: number }).baseCycles = 99;
    }).toThrow(TypeError);
  });
});

describe('lookup tables', () => {
  it('opcodeByByte has 256 entries matching the table, undefined everywhere else', () => {
    expect(opcodeByByte).toHaveLength(256);
    expect(Object.isFrozen(opcodeByByte)).toBe(true);
    for (let byte = 0; byte <= 0xff; byte += 1) {
      const expected = OPCODES.find((info) => info.opcode === byte);
      expect(opcodeByByte[byte]).toBe(expected);
      expect(lookupOpcode(byte)).toBe(expected);
    }
    expect(opcodeByByte.filter((info) => info === undefined)).toHaveLength(226);
  });

  it('lookupOpcode returns undefined for values that are not bytes', () => {
    for (const value of [-1, 256, 1.5, Number.NaN]) {
      expect(lookupOpcode(value)).toBeUndefined();
    }
  });

  it('opcodesByMnemonic partitions the table; only LOAD and STORE have two variants', () => {
    expect(Object.keys(opcodesByMnemonic).sort()).toEqual([...MNEMONICS].sort());
    const flattened = Object.values(opcodesByMnemonic)
      .flat()
      .sort((x, y) => x.opcode - y.opcode);
    expect(flattened).toEqual([...OPCODES]);
    for (const mnemonic of MNEMONICS) {
      const variants = opcodesByMnemonic[mnemonic];
      expect(variants.every((info) => info.mnemonic === mnemonic)).toBe(true);
      expect(variants).toHaveLength(mnemonic === 'LOAD' || mnemonic === 'STORE' ? 2 : 1);
    }
    expect(opcodesByMnemonic.LOAD.map((info) => info.id)).toEqual(['LOAD_ABS', 'LOAD_IND']);
    expect(opcodesByMnemonic.STORE.map((info) => info.id)).toEqual(['STORE_ABS', 'STORE_IND']);
  });
});
