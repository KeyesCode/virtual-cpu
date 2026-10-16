import type { FixtureKind } from '@vcpu/shared';

/**
 * Targeted ISA test vectors exported beside the examples: every opcode, the flag corner cases of
 * docs/instruction-set.md and every fault code. Each is a short assembly program; the exporter
 * assembles it and records whatever cpu-core does, so the expected state is never hand-written
 * here. The drift test then pins that behaviour.
 */
export interface Vector {
  readonly name: string;
  readonly kind: Exclude<FixtureKind, 'example'>;
  readonly description: string;
  readonly source: string;
  /** Instruction limit (default 1000). */
  readonly maxInstructions?: number;
}

/** Leaves Z=1 C=1 N=0 V=1 (0x80 + 0x80) using only R6/R7. */
const SET_ZCV = 'LDI R6, 0x80\nLDI R7, 0x80\nADD R6, R7   ; Z=1 C=1 N=0 V=1\n';
/** Leaves Z=0 C=1 N=1 V=0 (0x00 − 0x01) using only R6/R7. */
const SET_CN = 'LDI R6, 0x00\nLDI R7, 0x01\nSUB R6, R7   ; Z=0 C=1 N=1 V=0\n';

/** `LDI R0, a; LDI R1, b; <op> R0, R1; HLT`, optionally after a flag preamble. */
function binary(op: string, a: number, b: number, preamble = ''): string {
  return `${preamble}LDI R0, ${hex(a)}\nLDI R1, ${hex(b)}\n${op} R0, R1\nHLT\n`;
}

/** `LDI R0, a; <op> R0; HLT`, optionally after a flag preamble. */
function unary(op: string, a: number, preamble = ''): string {
  return `${preamble}LDI R0, ${hex(a)}\n${op} R0\nHLT\n`;
}

function hex(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}

function alu(name: string, description: string, source: string): Vector {
  return { name, kind: 'instruction', description, source };
}

/** A conditional branch tried both ways: first with the condition false, then true. */
function branch(op: string, makeFalse: string, makeTrue: string, flag: string): Vector {
  return {
    name: `op-${op.toLowerCase()}`,
    kind: 'instruction',
    description: `${op} not taken, then taken. R0 = 1 marks the fall-through, R1 = 1 the target; R2 stays 0 because the skipped code never runs.`,
    source: `${makeFalse}${op} skip1      ; ${flag} does not hold: falls through
        LDI R0, 1
skip1:  ${makeTrue}${op} target     ; ${flag} holds: taken
        LDI R2, 0xEE      ; skipped
        HLT
target: LDI R1, 1
        HLT
`,
  };
}

const CMP_EQUAL = 'LDI R5, 3\nLDI R6, 3\nCMP R5, R6   ; Z=1 C=0\n';
const CMP_LESS = 'LDI R5, 2\nLDI R6, 3\nCMP R5, R6   ; Z=0 C=1\n';

const INSTRUCTION_VECTORS: readonly Vector[] = [
  // System
  {
    name: 'op-nop',
    kind: 'instruction',
    description: 'NOP changes nothing but PC.',
    source: 'NOP\nNOP\nHLT\n',
  },
  {
    name: 'op-hlt',
    kind: 'instruction',
    description: 'HLT at 0x00: status HALTED, PC not advanced, one instruction retired.',
    source: 'HLT\n',
  },
  {
    name: 'op-hlt-at-ff',
    kind: 'instruction',
    description: 'HLT at 0xFF is legal: it never advances PC, so there is no PC_OVERFLOW.',
    source: 'JMP last\n.org 0xFF\nlast: HLT\n',
  },
  // Data movement
  {
    name: 'op-ldi-all-registers',
    kind: 'instruction',
    description: 'LDI into each of R0–R7 (register field a = 0..7); LDI never changes FLAGS.',
    source:
      'LDI R0, 0x01\nLDI R1, 0x12\nLDI R2, 0x23\nLDI R3, 0x34\nLDI R4, 0x45\nLDI R5, 0x56\nLDI R6, 0x67\nLDI R7, 0xF8\nHLT\n',
  },
  {
    name: 'op-ldi-zero-keeps-flags',
    kind: 'instruction',
    description: 'LDI of 0 does not set Z: FLAGS keep C=1 N=1 from the preceding SUB.',
    source: `${SET_CN}LDI R0, 0\nHLT\n`,
  },
  {
    name: 'op-mov',
    kind: 'instruction',
    description: 'MOV R5, R3 copies; MOV R3, R3 is a no-op; FLAGS unchanged.',
    source: 'LDI R3, 0xA5\nMOV R5, R3\nMOV R3, R3\nHLT\n',
  },
  {
    name: 'op-load-abs',
    kind: 'instruction',
    description: 'LOAD Rd, [addr8] from the data region; loading 0 leaves Z clear and N set.',
    source: `${SET_CN}LOAD R1, [0x80]\nLOAD R2, [0x81]\nHLT\n.org 0x80\n.byte 0x9C, 0x00\n`,
  },
  {
    name: 'op-load-ind',
    kind: 'instruction',
    description:
      'LOAD Rd, [Rp], including LOAD R3, [R3] (the pointer is read before it is overwritten).',
    source:
      'LDI R2, 0x90\nLOAD R1, [R2]\nLDI R3, 0x91\nLOAD R3, [R3]\nHLT\n.org 0x90\n.byte 0x5E, 0xC3\n',
  },
  {
    name: 'op-store-abs',
    kind: 'instruction',
    description: 'STORE [addr8], Rs, including the last byte of memory (0xFF).',
    source: 'LDI R4, 0x5A\nSTORE [0x80], R4\nSTORE [0xFF], R4\nHLT\n',
  },
  {
    name: 'op-store-ind',
    kind: 'instruction',
    description: 'STORE [Rp], Rs, including STORE [R2], R2 (stores the pointer itself).',
    source: 'LDI R2, 0x81\nLDI R1, 0x3C\nSTORE [R2], R1\nINC R2\nSTORE [R2], R2\nHLT\n',
  },
  // Arithmetic
  alu('op-add', 'ADD 10 + 20 = 30: every flag 0.', binary('ADD', 10, 20)),
  alu(
    'op-add-carry-zero',
    'ADD 0xFF + 0x01 = 0x00: Z=1 C=1, no signed overflow (−1 + 1).',
    binary('ADD', 0xff, 0x01),
  ),
  alu(
    'op-add-signed-overflow',
    'ADD 0x7F + 0x01 = 0x80: N=1 V=1 (127 + 1).',
    binary('ADD', 0x7f, 0x01),
  ),
  alu(
    'op-add-both-overflow',
    'ADD 0x80 + 0x80 = 0x00: Z=1 C=1 V=1 (−128 + −128).',
    binary('ADD', 0x80, 0x80),
  ),
  alu(
    'op-add-same-register',
    'ADD R0, R0 with 0x41: both operands are read before the write; 0x82, N=1 V=1.',
    'LDI R0, 0x41\nADD R0, R0\nHLT\n',
  ),
  alu('op-sub', 'SUB 50 − 20 = 30: every flag 0.', binary('SUB', 50, 20)),
  alu('op-sub-zero', 'SUB 5 − 5 = 0: Z=1, no borrow.', binary('SUB', 5, 5)),
  alu('op-sub-borrow', 'SUB 0x00 − 0x01 = 0xFF: C=1 (borrow) N=1.', binary('SUB', 0x00, 0x01)),
  alu(
    'op-sub-signed-overflow',
    'SUB 0x80 − 0x01 = 0x7F: V=1 (−128 − 1).',
    binary('SUB', 0x80, 0x01),
  ),
  alu(
    'op-sub-positive-overflow',
    'SUB 0x7F − 0xFF = 0x80: C=1 (127 < 255 unsigned) N=1 V=1 (127 − (−1) = 128).',
    binary('SUB', 0x7f, 0xff),
  ),
  alu('op-mul', 'MUL 12 × 10 = 120: fits, C=0 V=0.', binary('MUL', 12, 10)),
  alu(
    'op-mul-overflow',
    'MUL 20 × 13 = 260 → 0x04: the product exceeds 0xFF, C=1 V=1.',
    binary('MUL', 20, 13),
  ),
  alu(
    'op-mul-zero-low-byte',
    'MUL 0x10 × 0x10 = 0x100 → 0x00: Z=1 C=1 V=1.',
    binary('MUL', 0x10, 0x10),
  ),
  alu('op-mul-negative', 'MUL 0x40 × 0x02 = 0x80: N=1, C=0 V=0.', binary('MUL', 0x40, 0x02)),
  alu('op-div', 'DIV 200 ÷ 7 = 28 (unsigned, rounded down).', binary('DIV', 200, 7)),
  alu('op-div-zero-quotient', 'DIV 3 ÷ 7 = 0: Z=1.', binary('DIV', 3, 7)),
  alu(
    'op-div-clears-c-v',
    'DIV 0xFF ÷ 0x01 = 0xFF after Z=1 C=1 V=1: N=1, and C and V are cleared.',
    binary('DIV', 0xff, 0x01, SET_ZCV),
  ),
  alu('op-inc', 'INC 0x41 = 0x42.', unary('INC', 0x41)),
  alu('op-inc-7f', 'INC 0x7F = 0x80: N=1 V=1.', unary('INC', 0x7f)),
  alu(
    'op-inc-ff-keeps-carry',
    'INC 0xFF = 0x00 after C=1: Z=1, C unchanged (still 1).',
    unary('INC', 0xff, SET_CN),
  ),
  alu('op-dec', 'DEC 0x42 = 0x41.', unary('DEC', 0x42)),
  alu('op-dec-80', 'DEC 0x80 = 0x7F: V=1.', unary('DEC', 0x80)),
  alu('op-dec-01', 'DEC 0x01 = 0x00: Z=1.', unary('DEC', 0x01)),
  alu(
    'op-dec-00-keeps-carry',
    'DEC 0x00 = 0xFF after C=1: N=1, C unchanged (still 1).',
    unary('DEC', 0x00, SET_CN),
  ),
  // Logic
  alu(
    'op-and',
    'AND 0xF0 & 0x3C = 0x30 after Z=1 C=1 V=1: C and V cleared.',
    binary('AND', 0xf0, 0x3c, SET_ZCV),
  ),
  alu('op-and-zero', 'AND 0xF0 & 0x0F = 0x00: Z=1.', binary('AND', 0xf0, 0x0f)),
  alu(
    'op-or',
    'OR 0x80 | 0x01 = 0x81 after Z=1 C=1 V=1: N=1, C and V cleared.',
    binary('OR', 0x80, 0x01, SET_ZCV),
  ),
  alu('op-xor', 'XOR 0xFF ^ 0x5A = 0xA5: N=1.', binary('XOR', 0xff, 0x5a)),
  alu(
    'op-xor-self',
    'XOR R0, R0 = 0x00 after C=1 N=1: Z=1, C cleared.',
    `${SET_CN}LDI R0, 0x77\nXOR R0, R0\nHLT\n`,
  ),
  alu(
    'op-not',
    'NOT 0x0F = 0xF0 after Z=1 C=1 V=1: N=1, C and V cleared.',
    unary('NOT', 0x0f, SET_ZCV),
  ),
  alu('op-not-ff', 'NOT 0xFF = 0x00: Z=1.', unary('NOT', 0xff)),
  alu('op-shl', 'SHL 0x81 = 0x02: bit 7 shifts into C.', unary('SHL', 0x81)),
  alu('op-shl-80', 'SHL 0x80 = 0x00: Z=1 C=1.', unary('SHL', 0x80)),
  alu(
    'op-shl-no-carry',
    'SHL 0x41 = 0x82 after C=1: N=1, C=0 (bit 7 was 0), V cleared.',
    unary('SHL', 0x41, SET_ZCV),
  ),
  alu('op-shr', 'SHR 0x81 = 0x40: bit 0 shifts into C.', unary('SHR', 0x81)),
  alu('op-shr-01', 'SHR 0x01 = 0x00: Z=1 C=1.', unary('SHR', 0x01)),
  alu(
    'op-shr-no-carry',
    'SHR 0x80 = 0x40 after C=1 N=1: C=0, N=0 (always 0 after SHR).',
    unary('SHR', 0x80, SET_CN),
  ),
  alu('op-cmp-equal', 'CMP 5, 5: Z=1; R0 is not written.', binary('CMP', 5, 5)),
  alu('op-cmp-less', 'CMP 2, 3: C=1 (borrow, unsigned less) N=1.', binary('CMP', 2, 3)),
  alu('op-cmp-greater', 'CMP 3, 2: every flag 0 (unsigned greater).', binary('CMP', 3, 2)),
  alu(
    'op-cmp-signed',
    'CMP 0x90, 0x10: unsigned greater (C=0) but signed less (N=1, V=0, so N ≠ V).',
    binary('CMP', 0x90, 0x10),
  ),
  alu(
    'op-cmp-signed-overflow',
    'CMP 0x10, 0x90: C=1 and V=1 (16 − (−112) = 128 overflows); signed greater because N = V.',
    binary('CMP', 0x10, 0x90),
  ),
  // Control flow
  {
    name: 'op-jmp',
    kind: 'instruction',
    description: 'JMP over an invalid opcode byte, which is never fetched.',
    source: 'JMP over\n.byte 0xFF\nover: LDI R0, 1\nHLT\n',
  },
  {
    name: 'op-jmp-at-fe',
    kind: 'instruction',
    description: 'A JMP at 0xFE: its next PC is the target, so there is no PC_OVERFLOW.',
    source: 'JMP edge\nback: HLT\n.org 0xFE\nedge: JMP back\n',
  },
  branch('JZ', CMP_LESS, CMP_EQUAL, 'Z=1'),
  branch('JNZ', CMP_EQUAL, CMP_LESS, 'Z=0'),
  branch('JC', CMP_EQUAL, CMP_LESS, 'C=1'),
  branch('JNC', CMP_LESS, CMP_EQUAL, 'C=0'),
  {
    name: 'op-call-ret',
    kind: 'instruction',
    description:
      'Nested CALL/RET: return addresses 0x02 and 0x08 are pushed at 0xFF and 0xFE, popped back, and stay in memory; SP/SD return to 0xFF/0.',
    source: `CALL outer
        HLT
outer:  LDI R0, 1
        CALL inner
        INC R0
        RET
inner:  LDI R1, 2
        RET
`,
  },
  {
    name: 'op-push-pop',
    kind: 'instruction',
    description: 'PUSH three registers, POP them back in reverse order (last in, first out).',
    source: `LDI R0, 0x11
LDI R1, 0x22
LDI R2, 0x33
PUSH R0
PUSH R1
PUSH R2
POP R3
POP R4
POP R5
HLT
`,
  },
  {
    name: 'op-push-full-stack',
    kind: 'instruction',
    description: '64 pushes fill the stack exactly: SD = 64, SP = 0xBF, no fault.',
    source: `        LDI R1, 64
loop:   PUSH R1
        DEC R1
        JNZ loop
        HLT
`,
  },
];

const FAULT_VECTORS: readonly Vector[] = [
  {
    name: 'fault-invalid-opcode',
    kind: 'fault',
    description: 'INVALID_OPCODE at 0x03 (byte 0x02): precise, R0 keeps the value LDI wrote.',
    source: 'LDI R0, 7\n.byte 0x02\n',
  },
  {
    name: 'fault-invalid-opcode-at-ff',
    kind: 'fault',
    description: 'An invalid opcode at 0xFF is INVALID_OPCODE, not INSTRUCTION_OVERRUN (priority).',
    source: 'JMP last\n.org 0xFF\nlast: .byte 0x60\n',
  },
  {
    name: 'fault-malformed-register',
    kind: 'fault',
    description: 'MALFORMED_OPERAND: LDI with register field a = 8 (bytes 11 80 01).',
    source: '.byte 0x11, 0x80, 0x01\n',
  },
  {
    name: 'fault-malformed-unused-field',
    kind: 'fault',
    description: 'MALFORMED_OPERAND: INC with its unused field b = 1 (bytes 24 01).',
    source: 'LDI R0, 5\n.byte 0x24, 0x01\n',
  },
  {
    name: 'fault-malformed-field-b',
    kind: 'fault',
    description: 'MALFORMED_OPERAND: ADD R0, R9 (bytes 20 09): field b names a register past R7.',
    source: '.byte 0x20, 0x09\n',
  },
  {
    name: 'fault-instruction-overrun-at-fe',
    kind: 'fault',
    description: 'INSTRUCTION_OVERRUN: a 3-byte LDI at 0xFE crosses the end of memory.',
    source: 'JMP edge\n.org 0xFE\nedge: .byte 0x11, 0x00\n',
  },
  {
    name: 'fault-instruction-overrun-at-ff',
    kind: 'fault',
    description: 'INSTRUCTION_OVERRUN: a 2-byte JMP opcode at 0xFF.',
    source: 'JMP edge\n.org 0xFF\nedge: .byte 0x40\n',
  },
  {
    name: 'fault-overrun-before-malformed',
    kind: 'fault',
    description:
      'Bytes 11 90 at 0xFE: INSTRUCTION_OVERRUN wins over MALFORMED_OPERAND because bounds are checked first.',
    source: 'JMP edge\n.org 0xFE\nedge: .byte 0x11, 0x90\n',
  },
  {
    name: 'fault-pc-overflow-nop',
    kind: 'fault',
    description:
      'Post-commit PC_OVERFLOW: NOP at 0xFF retires, then PC would be 0x100; PC stays 0xFF.',
    source: 'JMP last\n.org 0xFF\nlast: NOP\n',
  },
  {
    name: 'fault-pc-overflow-inc',
    kind: 'fault',
    description:
      'Post-commit PC_OVERFLOW: INC R0 at 0xFE commits R0 = 1 and its flags before faulting.',
    source: 'JMP edge\n.org 0xFE\nedge: INC R0\n',
  },
  {
    name: 'fault-pc-overflow-branch-not-taken',
    kind: 'fault',
    description: 'Post-commit PC_OVERFLOW: JZ at 0xFE with Z=0 falls through to 0x100.',
    source: 'JMP edge\n.org 0xFE\nedge: JZ 0x00\n',
  },
  {
    name: 'fault-pc-overflow-call',
    kind: 'fault',
    description:
      'Precise PC_OVERFLOW: CALL at 0xFE cannot push the return address 0x100; nothing is pushed.',
    source: 'JMP edge\n.org 0xFE\nedge: CALL 0x00\n',
  },
  {
    name: 'fault-divide-by-zero',
    kind: 'fault',
    description: 'DIVIDE_BY_ZERO: DIV R0, R1 with R1 = 0; R0 and FLAGS are unchanged.',
    source: `${SET_CN}LDI R0, 9\nDIV R0, R1\nHLT\n`,
  },
  {
    name: 'fault-stack-overflow',
    kind: 'fault',
    description: 'STACK_OVERFLOW on the 65th PUSH; SD stays 64, SP 0xBF, and 0xBF is not written.',
    source: `        LDI R1, 65
loop:   PUSH R1
        DEC R1
        JNZ loop
        HLT
`,
  },
  {
    name: 'fault-stack-overflow-call',
    kind: 'fault',
    description: 'STACK_OVERFLOW on a CALL with 64 bytes already on the stack.',
    source: `        LDI R1, 64
loop:   PUSH R1
        DEC R1
        JNZ loop
        CALL loop
        HLT
`,
  },
  {
    name: 'fault-stack-underflow-pop',
    kind: 'fault',
    description: 'STACK_UNDERFLOW: POP with SD = 0; R0 is unchanged.',
    source: 'LDI R0, 0x42\nPOP R0\nHLT\n',
  },
  {
    name: 'fault-stack-underflow-ret',
    kind: 'fault',
    description:
      'STACK_UNDERFLOW: RET with SD = 0 (a PUSH/POP pair first leaves the stack empty again).',
    source: 'PUSH R0\nPOP R1\nRET\nHLT\n',
  },
];

/** Every vector, in a fixed order. The exporter sorts fixtures by name anyway. */
export const VECTORS: readonly Vector[] = [...INSTRUCTION_VECTORS, ...FAULT_VECTORS];
