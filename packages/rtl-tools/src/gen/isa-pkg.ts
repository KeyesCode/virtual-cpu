import { fileURLToPath } from 'node:url';
import {
  CPU_STATUS_NUMBERS,
  type ControlFlow,
  FAULT_CODE_NUMBERS,
  FLAG_BITS,
  FLAG_NAMES,
  INSTRUCTION_FORMATS,
  ISA_VERSION,
  MEMORY_SIZE,
  NO_FAULT_NUMBER,
  OPCODES,
  type OpcodeInfo,
  REGISTER_COUNT,
  RESET_FLAGS,
  RESET_PC,
  RESET_REGISTER_VALUE,
  RESET_SD,
  RESET_SP,
  STACK_CAPACITY,
} from '@vcpu/shared';

/** The committed SystemVerilog package that `renderIsaPackage()` must reproduce byte for byte. */
export const ISA_PKG_PATH = fileURLToPath(
  new URL('../../../../hardware/rtl/vcpu8/core/vcpu8_isa_pkg.sv', import.meta.url),
);

/** Width of the fault-code and status buses (`FAULT_CODE_NUMBERS`, `CPU_STATUS_NUMBERS`). */
const CODE_BITS = 3;
/** Width of SD: it holds 0 … STACK_CAPACITY. */
const SD_BITS = 7;

/** `isa_fields(op)`: which register-byte fields an opcode uses. */
export const ISA_FIELDS = { NONE: 0, A: 1, AB: 2 } as const;

/** `isa_ctrl(op)`: how the next PC is chosen, one code per `ControlFlow`. */
export const ISA_CTRL = { SEQ: 0, HALT: 1, JUMP: 2, BRANCH: 3, CALL: 4, RET: 5 } as const;

const CTRL_OF: Readonly<Record<ControlFlow, keyof typeof ISA_CTRL>> = {
  sequential: 'SEQ',
  halt: 'HALT',
  jump: 'JUMP',
  branch: 'BRANCH',
  call: 'CALL',
  return: 'RET',
};

const FIELDS_OF = ['NONE', 'A', 'AB'] as const satisfies readonly (keyof typeof ISA_FIELDS)[];

const hex2 = (value: number): string => value.toString(16).toUpperCase().padStart(2, '0');
const bin = (value: number, width: number): string =>
  `${String(width)}'b${value.toString(2).padStart(width, '0')}`;
const dec = (value: number, width: number): string => `${String(width)}'d${String(value)}`;

function checkFits(name: string, value: number, width: number): number {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** width) {
    throw new RangeError(`${name} = ${String(value)} does not fit in ${String(width)} bits`);
  }
  return value;
}

/** The FLAGS bits an opcode may change (`flagsWritten ∪ flagsCleared`), bit 3 = Z … bit 0 = V. */
export function flagMask(info: OpcodeInfo): number {
  return [...info.flagsWritten, ...info.flagsCleared].reduce(
    (mask, flag) => mask | (1 << FLAG_BITS[flag]),
    0,
  );
}

/** `isa_cond(op)` = `{flag bit index[1:0], required value}`; 0 for an opcode without a condition. */
export function condCode(info: OpcodeInfo): number {
  return info.condition === null ? 0 : (FLAG_BITS[info.condition.flag] << 1) | info.condition.value;
}

const opName = (info: OpcodeInfo): string => `OP_${info.id}`;

interface LookupFunction {
  readonly name: string;
  readonly width: number;
  readonly doc: string;
  /** The value for one opcode, as a SystemVerilog expression. */
  readonly value: (info: OpcodeInfo) => string;
  /** The value for every byte that is not an opcode. */
  readonly invalid: string;
}

const LOOKUP_FUNCTIONS: readonly LookupFunction[] = [
  {
    name: 'isa_valid',
    width: 1,
    doc: '1 for the opcodes of this ISA; every other byte is INVALID_OPCODE.',
    value: () => "1'b1",
    invalid: "1'b0",
  },
  {
    name: 'isa_len',
    width: 2,
    doc: 'Instruction length in bytes (1-3), opcode included; 0 for an invalid opcode.',
    value: (info) => dec(info.length, 2),
    invalid: "2'd0",
  },
  {
    name: 'isa_fields',
    width: 2,
    doc: 'Register-byte fields used: ISA_FIELDS_NONE (no register byte), _A (field b must be 0), _AB.',
    value: (info) => `ISA_FIELDS_${FIELDS_OF[INSTRUCTION_FORMATS[info.format].registerFields]}`,
    invalid: 'ISA_FIELDS_NONE',
  },
  {
    name: 'isa_flag_mask',
    width: 4,
    doc: 'FLAGS bits the instruction may change ({Z, C, N, V}): flagsWritten | flagsCleared.',
    value: (info) => bin(flagMask(info), 4),
    invalid: "4'b0000",
  },
  {
    name: 'isa_ctrl',
    width: 3,
    doc: 'Next-PC behaviour: ISA_CTRL_SEQ, _HALT, _JUMP, _BRANCH, _CALL or _RET.',
    value: (info) => `ISA_CTRL_${CTRL_OF[info.controlFlow]}`,
    invalid: 'ISA_CTRL_SEQ',
  },
  {
    name: 'isa_cond',
    width: 3,
    doc: 'Branch condition {flag bit index[1:0], value}: taken when flags[c[2:1]] == c[0]. 0 unless ISA_CTRL_BRANCH.',
    value: (info) => bin(condCode(info), 3),
    invalid: "3'b000",
  },
  {
    name: 'isa_data_read',
    width: 1,
    doc: '1 when the instruction reads one data byte (LOAD, POP, RET); fetches excluded.',
    value: (info) => `1'b${String(info.dataReads)}`,
    invalid: "1'b0",
  },
  {
    name: 'isa_data_write',
    width: 1,
    doc: '1 when the instruction writes one data byte (STORE, PUSH, CALL).',
    value: (info) => `1'b${String(info.dataWrites)}`,
    invalid: "1'b0",
  },
];

function vector(width: number): string {
  return width === 1 ? 'logic' : `logic [${String(width - 1)}:0]`;
}

function renderFunction(fn: LookupFunction, opcodes: readonly OpcodeInfo[], pad: number): string[] {
  const lines = [
    `  // ${fn.doc}`,
    `  function automatic ${vector(fn.width)} ${fn.name}(input logic [7:0] op);`,
    '    case (op)',
  ];
  for (const info of opcodes) {
    lines.push(`      ${`${opName(info)}:`.padEnd(pad)} ${fn.name} = ${fn.value(info)};`);
  }
  lines.push(`      ${'default:'.padEnd(pad)} ${fn.name} = ${fn.invalid};`);
  lines.push('    endcase', '  endfunction');
  return lines;
}

/**
 * Renders `hardware/rtl/vcpu8/core/vcpu8_isa_pkg.sv` from the `@vcpu/shared` ISA definition.
 * The output is deterministic: no timestamps, opcodes in byte order and a trailing newline. It uses
 * only localparams and functions that return logic vectors, so both Verilator and Yosys
 * `read_verilog -sv` accept it.
 */
export function renderIsaPackage(): string {
  const opcodes = [...OPCODES].sort((x, y) => x.opcode - y.opcode);
  const [major, minor, patch] = ISA_VERSION.split('.').map(Number);
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new RangeError(`ISA_VERSION ${ISA_VERSION} is not MAJOR.MINOR.PATCH`);
  }
  const namePad = Math.max(...opcodes.map((info) => opName(info).length));
  const casePad = namePad + 1;

  const faults = Object.entries(FAULT_CODE_NUMBERS).sort(([, x], [, y]) => x - y);
  const statuses = Object.entries(CPU_STATUS_NUMBERS).sort(([, x], [, y]) => x - y);
  const codePad = Math.max(
    ...faults.map(([code]) => `FAULT_${code}`.length),
    ...statuses.map(([status]) => `STATUS_${status}`.length),
  );
  const fieldPad = Math.max(...Object.keys(ISA_FIELDS).map((k) => `ISA_FIELDS_${k}`.length));
  const ctrlPad = Math.max(...Object.keys(ISA_CTRL).map((k) => `ISA_CTRL_${k}`.length));

  const lines = [
    '// GENERATED FILE - DO NOT EDIT.',
    `// VCPU-8 ISA ${ISA_VERSION} constants for the RTL, rendered by @vcpu/rtl-tools`,
    '// (packages/rtl-tools/src/gen/isa-pkg.ts) from @vcpu/shared (packages/shared/src/isa).',
    '// Regenerate with `pnpm hardware:gen`; `make -C hardware/rtl/vcpu8 check-isa` and the',
    '// isa-pkg vitest test fail when this file drifts from the TypeScript ISA.',
    '',
    'package vcpu8_isa_pkg;',
    '',
    '  // A constants package: each module imports only the names it needs, so most are unused in',
    '  // any one compilation unit.',
    '  /* verilator lint_off UNUSEDPARAM */',
    '',
    '  // ISA version.',
    `  localparam int ISA_VERSION_MAJOR = ${String(major)};`,
    `  localparam int ISA_VERSION_MINOR = ${String(minor)};`,
    `  localparam int ISA_VERSION_PATCH = ${String(patch)};`,
    '',
    '  // Machine sizes.',
    `  localparam int MEMORY_SIZE    = ${String(MEMORY_SIZE)};`,
    `  localparam int REGISTER_COUNT = ${String(REGISTER_COUNT)};`,
    `  localparam int STACK_CAPACITY = ${String(STACK_CAPACITY)};`,
    `  localparam int OPCODE_COUNT   = ${String(opcodes.length)};`,
    '',
    `  // Opcode bytes (${String(opcodes.length)} opcodes, in byte order).`,
    ...opcodes.map(
      (info) =>
        `  localparam logic [7:0] ${opName(info).padEnd(namePad)} = 8'h${hex2(info.opcode)};`,
    ),
    '',
    '  // Fault codes (FAULT_CODE_NUMBERS); 0 = no fault.',
    `  localparam logic [${String(CODE_BITS - 1)}:0] ${'FAULT_NONE'.padEnd(codePad)} = ${dec(NO_FAULT_NUMBER, CODE_BITS)};`,
    ...faults.map(
      ([code, number]) =>
        `  localparam logic [${String(CODE_BITS - 1)}:0] ${`FAULT_${code}`.padEnd(codePad)} = ${dec(checkFits(code, number, CODE_BITS), CODE_BITS)};`,
    ),
    '',
    '  // CPU status (CPU_STATUS_NUMBERS). The RTL has one run state, reported as STATUS_READY.',
    ...statuses.map(
      ([status, number]) =>
        `  localparam logic [${String(CODE_BITS - 1)}:0] ${`STATUS_${status}`.padEnd(codePad)} = ${dec(checkFits(status, number, CODE_BITS), CODE_BITS)};`,
    ),
    '',
    '  // Reset values of the architectural state. Reset does not touch memory.',
    `  localparam logic [7:0] RESET_PC    = 8'h${hex2(RESET_PC)};`,
    `  localparam logic [7:0] RESET_SP    = 8'h${hex2(RESET_SP)};`,
    `  localparam logic [${String(SD_BITS - 1)}:0] RESET_SD    = ${dec(checkFits('RESET_SD', RESET_SD, SD_BITS), SD_BITS)};`,
    `  localparam logic [3:0] RESET_FLAGS = 4'h${checkFits('RESET_FLAGS', RESET_FLAGS, 4).toString(16).toUpperCase()};`,
    `  localparam logic [7:0] RESET_REG   = 8'h${hex2(RESET_REGISTER_VALUE)};`,
    '',
    "  // FLAGS bit positions; the 8-bit FLAGS byte reads {4'h0, Z, C, N, V}.",
    ...FLAG_NAMES.map((flag) => `  localparam int FLAG_${flag} = ${String(FLAG_BITS[flag])};`),
    '',
    '  // isa_fields() codes.',
    ...Object.entries(ISA_FIELDS).map(
      ([name, code]) =>
        `  localparam logic [1:0] ${`ISA_FIELDS_${name}`.padEnd(fieldPad)} = ${dec(code, 2)};`,
    ),
    '',
    '  // isa_ctrl() codes.',
    ...Object.entries(ISA_CTRL).map(
      ([name, code]) =>
        `  localparam logic [2:0] ${`ISA_CTRL_${name}`.padEnd(ctrlPad)} = ${dec(code, 3)};`,
    ),
  ];
  for (const fn of LOOKUP_FUNCTIONS) {
    lines.push('', ...renderFunction(fn, opcodes, casePad));
  }
  lines.push('', '  /* verilator lint_on UNUSEDPARAM */', '', 'endpackage');
  return `${lines.join('\n')}\n`;
}
