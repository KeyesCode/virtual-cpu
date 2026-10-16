/** Every assembly mnemonic in ISA v1.0. LOAD and STORE each have two opcode variants. */
export const MNEMONICS = [
  'NOP',
  'HLT',
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
] as const;
export type Mnemonic = (typeof MNEMONICS)[number];

/**
 * One identifier per opcode byte. It equals the mnemonic, except the addressing-mode variants
 * of LOAD and STORE: `_ABS` takes an absolute address, `_IND` a register-indirect `[Rp]`.
 */
export const OPCODE_IDS = [
  'NOP',
  'HLT',
  'MOV',
  'LDI',
  'LOAD_ABS',
  'LOAD_IND',
  'STORE_ABS',
  'STORE_IND',
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
] as const;
export type OpcodeId = (typeof OPCODE_IDS)[number];

/** Instruction formats; the layouts are in `INSTRUCTION_FORMATS`. */
export const INSTRUCTION_FORMAT_NAMES = ['N', 'R', 'RR', 'RI', 'RA', 'A'] as const;
export type InstructionFormat = (typeof INSTRUCTION_FORMAT_NAMES)[number];

export type InstructionLength = 1 | 2 | 3;

/**
 * - `reg`: a register R0–R7, used by value.
 * - `regIndirect`: a register whose value is a memory address, written `[Rn]`.
 * - `imm8`: an 8-bit immediate byte.
 * - `addr8`: an 8-bit absolute address byte.
 */
export type OperandKind = 'reg' | 'regIndirect' | 'imm8' | 'addr8';

/**
 * Where an operand lives in the encoded instruction:
 * - `a`: high nibble of the register byte (byte 1).
 * - `b`: low nibble of the register byte (byte 1).
 * - `byte`: the trailing immediate or address byte (the instruction's last byte).
 */
export type OperandField = 'a' | 'b' | 'byte';

/**
 * What an operand means to the instruction. The role also fixes its placeholder in syntax
 * strings and encoding templates (`Rd`/`d`, `Rs`/`s`, `[Rp]`/`p`, `Ra`/`a`, `Rb`/`b`,
 * `imm8`/`ii`, `[addr8]`/`mm`, `addr8`/`mm`).
 */
export type OperandRole =
  | 'dest' // register written (and, for ALU ops, also read as the first operand)
  | 'src' // register read
  | 'ptr' // register holding a data address
  | 'lhs' // first compare operand
  | 'rhs' // second compare operand
  | 'imm' // immediate value
  | 'addr' // absolute data address
  | 'target'; // absolute jump/call target

export interface OperandSpec {
  readonly kind: OperandKind;
  readonly field: OperandField;
  readonly role: OperandRole;
}

/** FLAGS names, most-significant used bit first (bit 3 = Z … bit 0 = V). */
export const FLAG_NAMES = ['Z', 'C', 'N', 'V'] as const;
export type FlagName = (typeof FLAG_NAMES)[number];

/** Instruction group; it always matches the opcode's high nibble (0x0_ … 0x5_). */
export type InstructionCategory = 'system' | 'data' | 'arithmetic' | 'logic' | 'control' | 'stack';

/**
 * How the instruction chooses the next PC:
 * - `sequential`: PC + length.
 * - `halt`: PC unchanged; status becomes HALTED.
 * - `jump`: always the target.
 * - `branch`: the target if `condition` holds, else PC + length.
 * - `call`: pushes PC + length, then the target.
 * - `return`: the popped byte.
 */
export type ControlFlow = 'sequential' | 'halt' | 'jump' | 'branch' | 'call' | 'return';

/** A conditional branch is taken when FLAGS[flag] equals `value`. */
export interface BranchCondition {
  readonly flag: FlagName;
  readonly value: 0 | 1;
}

/** One row of the authoritative opcode table. */
export interface OpcodeInfo {
  /** The opcode byte (the instruction's first byte). */
  readonly opcode: number;
  readonly id: OpcodeId;
  readonly mnemonic: Mnemonic;
  /** Canonical assembly form with operand placeholders, e.g. `STORE [addr8], Rs`. */
  readonly syntax: string;
  readonly format: InstructionFormat;
  /** Encoded size in bytes, opcode included. Always equals the format's length. */
  readonly length: InstructionLength;
  /** Operands in assembly order (not encoding order). */
  readonly operands: readonly OperandSpec[];
  readonly category: InstructionCategory;
  readonly controlFlow: ControlFlow;
  /** Set only for `branch` instructions. */
  readonly condition: BranchCondition | null;
  /** Flags recomputed from the result. Listed in `FLAG_NAMES` order. */
  readonly flagsWritten: readonly FlagName[];
  /** Flags forced to 0. Listed in `FLAG_NAMES` order. Every other flag is unchanged. */
  readonly flagsCleared: readonly FlagName[];
  /** Data-memory reads (instruction fetches excluded). */
  readonly dataReads: 0 | 1;
  /** Data-memory writes. */
  readonly dataWrites: 0 | 1;
  /** Extra execute cycles beyond the timing model's single execute cycle (MUL, DIV). */
  readonly extraExecuteCycles: number;
  /** Estimated cycles when the instruction does not transfer control. */
  readonly baseCycles: number;
  /** Cycles added when control transfers (jump, taken branch, call, return); 0 otherwise. */
  readonly branchTakenPenalty: number;
  readonly description: string;
}

/** Fault codes. Every fault except PC_OVERFLOW on a sequential fall-through is precise. */
export const FaultCode = {
  INVALID_OPCODE: 'INVALID_OPCODE',
  MALFORMED_OPERAND: 'MALFORMED_OPERAND',
  INSTRUCTION_OVERRUN: 'INSTRUCTION_OVERRUN',
  PC_OVERFLOW: 'PC_OVERFLOW',
  DIVIDE_BY_ZERO: 'DIVIDE_BY_ZERO',
  STACK_OVERFLOW: 'STACK_OVERFLOW',
  STACK_UNDERFLOW: 'STACK_UNDERFLOW',
} as const;
export type FaultCode = (typeof FaultCode)[keyof typeof FaultCode];

/** CPU status. RUNNING and PAUSED are run-loop states; the step itself sees READY. */
export const CpuStatus = {
  READY: 'READY',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  HALTED: 'HALTED',
  FAULTED: 'FAULTED',
} as const;
export type CpuStatus = (typeof CpuStatus)[keyof typeof CpuStatus];
