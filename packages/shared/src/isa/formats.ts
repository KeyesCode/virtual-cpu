import { deepFreeze } from '../freeze.js';
import type { InstructionFormat, InstructionLength } from './types.js';

export interface FormatInfo {
  readonly format: InstructionFormat;
  readonly length: InstructionLength;
  /** Register fields in the register byte (byte 1): 0 = no register byte, 1 = `a` only, 2 = `a` and `b`. */
  readonly registerFields: 0 | 1 | 2;
  /** Kind of the trailing byte (the instruction's last byte), if the format has one. */
  readonly trailingByte: 'imm8' | 'addr8' | null;
  /** Byte layout, as written in the docs. */
  readonly layout: string;
}

/** The six instruction formats of ISA v1.0. */
export const INSTRUCTION_FORMATS = deepFreeze({
  N: { format: 'N', length: 1, registerFields: 0, trailingByte: null, layout: '[op]' },
  R: { format: 'R', length: 2, registerFields: 1, trailingByte: null, layout: '[op] [rrrr 0000]' },
  RR: {
    format: 'RR',
    length: 2,
    registerFields: 2,
    trailingByte: null,
    layout: '[op] [aaaa bbbb]',
  },
  RI: {
    format: 'RI',
    length: 3,
    registerFields: 1,
    trailingByte: 'imm8',
    layout: '[op] [rrrr 0000] [imm8]',
  },
  RA: {
    format: 'RA',
    length: 3,
    registerFields: 1,
    trailingByte: 'addr8',
    layout: '[op] [rrrr 0000] [addr8]',
  },
  A: { format: 'A', length: 2, registerFields: 0, trailingByte: 'addr8', layout: '[op] [addr8]' },
} as const satisfies { readonly [F in InstructionFormat]: FormatInfo & { readonly format: F } });

/** Offset of the register byte within an instruction, when the format has one. */
export const REGISTER_BYTE_OFFSET = 1;
