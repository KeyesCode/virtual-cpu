import { assemble, formatDiagnostic } from '@vcpu/assembler';
import {
  FaultCode,
  INSTRUCTION_FORMATS,
  MEMORY_MAP,
  OPCODES,
  opcodeByByte,
  STACK_CAPACITY,
} from '@vcpu/shared';
import { Prng } from './prng.js';

/**
 * Seeded random VCPU-8 programs for the differential verification. Each program is assembly
 * source, assembled by `@vcpu/assembler`, and a function of its seed alone.
 *
 * The shapes are chosen so programs run long enough to matter instead of faulting on their first
 * bytes: straight-line ALU code with forward branches, memory and pointer traffic, bounded loops
 * (DEC/JNZ down-counters and INC/CMP/JC up-counters), CALL/RET and balanced PUSH/POP (up to a full
 * 64-byte stack), sequences built to end in a chosen fault, and about 5% raw random bytes for
 * encodings no assembler would write. Code stays in 0x00–0x7F and data stores in 0x80–0xBF,
 * except in a small self-modifying share of the memory programs. Every program ends in HLT unless
 * it faults, except a small share of loop programs that end in an endless loop on purpose:
 * anything that does not stop is cut off at `RANDOM_MAX_STEPS` on both sides, and the state at
 * the limit is compared like any other.
 */

export const SHAPE_WEIGHTS = {
  alu: 25,
  memory: 20,
  loop: 20,
  calls: 17,
  fault: 13,
  raw: 5,
} as const;
export type Shape = keyof typeof SHAPE_WEIGHTS;
export const SHAPES = Object.keys(SHAPE_WEIGHTS) as Shape[];

/** The step limit applied to every random program, on both sides. */
export const RANDOM_MAX_STEPS = 2000;

/** Share of memory programs that may store into their own code. */
export const SELF_MODIFYING_SHARE = 0.15;

/** Share of loop programs that end in an endless loop instead of HLT. */
export const ENDLESS_SHARE = 0.08;

const CODE_END = MEMORY_MAP.program.end + 1;
const DATA = MEMORY_MAP.data;

export interface RandomProgram {
  readonly seed: number;
  readonly shape: Shape;
  /** For fault programs, the fault the sequence was built to end in. */
  readonly targetFault: FaultCode | null;
  readonly selfModifying: boolean;
  /** Ends in an endless loop, so it runs to the step limit. */
  readonly endless: boolean;
  readonly source: string;
  /** All 256 bytes. */
  readonly image: readonly number[];
  /** Bytes of structured code from 0x00 (fault programs may also place bytes near 0xFF). */
  readonly codeBytes: number;
  readonly maxSteps: number;
}

const hex = (value: number): string => `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
const reg = (index: number): string => `R${String(index)}`;
const ALL_REGS = [0, 1, 2, 3, 4, 5, 6, 7] as const;

const RR_ALU = ['ADD', 'SUB', 'MUL', 'DIV', 'AND', 'OR', 'XOR', 'CMP', 'MOV'] as const;
const R_ALU = ['INC', 'DEC', 'NOT', 'SHL', 'SHR'] as const;
const CONDITIONAL = ['JZ', 'JNZ', 'JC', 'JNC'] as const;
const INVALID_OPCODES = Array.from({ length: 256 }, (_, b) => b).filter(
  (b) => opcodeByByte[b] === undefined,
);
const VALID_OPCODES = OPCODES.map((info) => info.opcode);

/** Emits assembly lines and counts the bytes they take. */
class Builder {
  readonly lines: string[] = [];
  size = 0;
  /** Bytes promised to code that closes the current construct (a loop tail, RET, HLT). */
  reserved = 0;
  #labels = 0;

  constructor(
    readonly rng: Prng,
    public limit: number,
  ) {}

  fits(bytes: number): boolean {
    return this.size + this.reserved + bytes <= this.limit;
  }

  op(text: string, length: number): void {
    this.lines.push(`        ${text}`);
    this.size += length;
  }

  label(prefix = 'L'): string {
    const name = `${prefix}${String(this.#labels)}`;
    this.#labels += 1;
    return name;
  }

  place(label: string): void {
    this.lines.push(`${label}:`);
  }

  comment(text: string): void {
    this.lines.push(`; ${text}`);
  }

  /** A register from `from`; the caller guarantees it is not empty. */
  pickReg(from: readonly number[]): number {
    return this.rng.pick(from);
  }

  /** A byte biased toward the values where flags change: 0, 1, the sign boundary and 0xFF. */
  value(): number {
    return this.rng.chance(0.4)
      ? this.rng.pick([0x00, 0x01, 0x02, 0x7f, 0x80, 0x81, 0xfe, 0xff])
      : this.rng.byte();
  }

  dataAddress(): number {
    return this.rng.int(DATA.start, DATA.end);
  }
}

interface BodyOptions {
  /** Registers the body may write. */
  readonly free: readonly number[];
  /** Relative weights of the item kinds. */
  readonly weights: Readonly<Record<'alu' | 'ldi' | 'mem' | 'branch' | 'nop', number>>;
  /** Most items to emit (the byte budget usually ends the body first). */
  readonly items: number;
  readonly selfModifying?: boolean;
  /** Nesting depth of forward-branch blocks. */
  readonly depth?: number;
}

function initRegisters(b: Builder, regs: readonly number[]): void {
  const count = b.rng.int(Math.min(3, regs.length), regs.length);
  for (const r of b.rng.shuffle(regs).slice(0, count)) {
    if (!b.fits(3)) return;
    b.op(`LDI ${reg(r)}, ${String(b.value())}`, 3);
  }
}

/** One ALU instruction, or LDI + DIV with a divisor that is usually non-zero. */
function aluItem(b: Builder, free: readonly number[]): void {
  const dest = b.pickReg(free);
  if (b.rng.chance(0.3)) {
    if (!b.fits(2)) return;
    b.op(`${b.rng.pick(R_ALU)} ${reg(dest)}`, 2);
    return;
  }
  const op = b.rng.pick(RR_ALU);
  const src = b.pickReg(ALL_REGS);
  if (op === 'DIV' && b.rng.chance(0.85)) {
    const divisor = b.pickReg(free);
    if (!b.fits(5)) return;
    b.op(`LDI ${reg(divisor)}, ${String(b.rng.int(1, 255))}`, 3);
    b.op(`DIV ${reg(dest)}, ${reg(divisor)}`, 2);
    return;
  }
  if (!b.fits(2)) return;
  b.op(`${op} ${reg(dest)}, ${reg(src)}`, 2);
}

/** One load or store: absolute, through a fresh pointer, or through a computed data pointer. */
function memItem(b: Builder, free: readonly number[], selfModifying: boolean): void {
  const value = b.pickReg(ALL_REGS);
  const store = b.rng.chance(0.5);
  const target =
    selfModifying && store && b.rng.chance(0.3) ? b.rng.int(0, CODE_END - 1) : b.dataAddress();
  const kind = b.rng.weighted({ absolute: 4, pointer: 4, computed: 2 });
  if (kind === 'absolute') {
    if (!b.fits(3)) return;
    if (store) {
      b.op(`STORE [${hex(target)}], ${reg(value)}`, 3);
    } else {
      // Loads may read anything, code and stack included.
      b.op(`LOAD ${reg(b.pickReg(free))}, [${hex(b.rng.byte())}]`, 3);
    }
    return;
  }
  const pointer = b.pickReg(free);
  if (kind === 'pointer') {
    if (!b.fits(5)) return;
    b.op(`LDI ${reg(pointer)}, ${hex(target)}`, 3);
  } else {
    // pointer ← 0x80 | (Rx & 0x3F): a data address that depends on the program's own values.
    const scratches = free.filter((r) => r !== pointer);
    if (scratches.length === 0 || !b.fits(14)) return;
    const scratch = b.pickReg(scratches);
    b.op(`MOV ${reg(pointer)}, ${reg(b.pickReg(ALL_REGS))}`, 2);
    b.op(`LDI ${reg(scratch)}, ${hex(DATA.size - 1)}`, 3);
    b.op(`AND ${reg(pointer)}, ${reg(scratch)}`, 2);
    b.op(`LDI ${reg(scratch)}, ${hex(DATA.start)}`, 3);
    b.op(`OR ${reg(pointer)}, ${reg(scratch)}`, 2);
  }
  if (store) {
    b.op(`STORE [${reg(pointer)}], ${reg(value)}`, 2);
  } else {
    b.op(`LOAD ${reg(b.pickReg(free))}, [${reg(pointer)}]`, 2);
  }
}

/** A conditional (or unconditional, so dead) forward branch over a short block. */
function branchItem(b: Builder, options: BodyOptions): void {
  const depth = options.depth ?? 0;
  if (depth >= 2 || !b.fits(4)) return;
  const skip = b.label();
  b.op(`${b.rng.chance(0.85) ? b.rng.pick(CONDITIONAL) : 'JMP'} ${skip}`, 2);
  body(b, { ...options, items: b.rng.int(1, 4), depth: depth + 1 });
  b.place(skip);
}

function body(b: Builder, options: BodyOptions): void {
  for (let i = 0; i < options.items && b.fits(2); i += 1) {
    switch (b.rng.weighted(options.weights)) {
      case 'alu':
        aluItem(b, options.free);
        break;
      case 'ldi':
        if (b.fits(3)) b.op(`LDI ${reg(b.pickReg(options.free))}, ${String(b.value())}`, 3);
        break;
      case 'mem':
        memItem(b, options.free, options.selfModifying ?? false);
        break;
      case 'branch':
        branchItem(b, options);
        break;
      case 'nop':
        b.op('NOP', 1);
        break;
    }
  }
}

const ALU_WEIGHTS = { alu: 70, ldi: 8, mem: 0, branch: 18, nop: 4 } as const;
const MEM_WEIGHTS = { alu: 35, ldi: 6, mem: 42, branch: 14, nop: 3 } as const;
const LOOP_WEIGHTS = { alu: 55, ldi: 5, mem: 25, branch: 12, nop: 3 } as const;

function halt(b: Builder): void {
  b.reserved -= 1;
  b.op('HLT', 1);
}

function aluProgram(b: Builder): void {
  b.reserved = 1;
  initRegisters(b, ALL_REGS);
  body(b, { free: ALL_REGS, weights: ALU_WEIGHTS, items: 60 });
  halt(b);
}

function memoryProgram(b: Builder, selfModifying: boolean): void {
  b.reserved = 1;
  initRegisters(b, ALL_REGS);
  body(b, { free: ALL_REGS, weights: MEM_WEIGHTS, items: 50, selfModifying });
  halt(b);
}

/** A bounded loop whose counter registers the body never writes; it may hold one inner loop. */
function loop(b: Builder, free: readonly number[], depth: number): void {
  const down = b.rng.chance(0.65);
  const counter = b.pickReg(free);
  const limits = free.filter((r) => r !== counter);
  const limit = limits.length === 0 ? counter : b.pickReg(limits);
  const inner = limits.filter((r) => down || r !== limit);
  const iterations = depth === 0 ? b.rng.int(1, 10) : b.rng.int(1, 5);
  const setup = down ? 3 : 6;
  const tail = down ? 4 : 6;
  if (!b.fits(setup + tail + 2) || inner.length === 0) return;
  const top = b.label();
  if (down) {
    b.op(`LDI ${reg(counter)}, ${String(iterations)}`, 3);
  } else {
    b.op(`LDI ${reg(counter)}, 0`, 3);
    b.op(`LDI ${reg(limit)}, ${String(iterations)}`, 3);
  }
  b.place(top);
  b.reserved += tail;
  const save = b.limit;
  b.limit = Math.min(b.limit, b.size + b.reserved + b.rng.int(6, 30));
  body(b, { free: inner, weights: LOOP_WEIGHTS, items: b.rng.int(2, 8) });
  if (depth === 0 && b.rng.chance(0.3)) loop(b, inner, depth + 1);
  b.limit = save;
  b.reserved -= tail;
  if (down) {
    b.op(`DEC ${reg(counter)}`, 2);
    b.op(`JNZ ${top}`, 2);
  } else {
    // CMP sets C when counter < limit (unsigned), so JC loops `iterations` times.
    b.op(`INC ${reg(counter)}`, 2);
    b.op(`CMP ${reg(counter)}, ${reg(limit)}`, 2);
    b.op(`JC ${top}`, 2);
  }
}

function loopProgram(b: Builder, endless: boolean): void {
  b.reserved = endless ? 2 : 1;
  initRegisters(b, ALL_REGS);
  const loops = b.rng.int(1, 3);
  for (let i = 0; i < loops; i += 1) {
    loop(b, ALL_REGS, 0);
    body(b, { free: ALL_REGS, weights: ALU_WEIGHTS, items: b.rng.int(0, 3) });
  }
  if (!endless) {
    halt(b);
    return;
  }
  // Spin forever on a block that keeps computing, so the state at the step limit is not trivial.
  const spin = b.label('spin');
  b.place(spin);
  body(b, { free: ALL_REGS, weights: LOOP_WEIGHTS, items: b.rng.int(1, 4) });
  b.reserved -= 2;
  b.op(`JMP ${spin}`, 2);
}

/** PUSH, a stack-neutral block, POP (perhaps into another register). */
function pushPop(b: Builder, free: readonly number[]): void {
  if (!b.fits(6)) return;
  b.op(`PUSH ${reg(b.pickReg(ALL_REGS))}`, 2);
  b.reserved += 2;
  body(b, { free, weights: ALU_WEIGHTS, items: b.rng.int(0, 3), depth: 1 });
  b.reserved -= 2;
  b.op(`POP ${reg(b.pickReg(free))}`, 2);
}

/** Push `count` bytes in a loop, then pop them all: up to a full 64-byte stack. */
function stackFill(b: Builder): void {
  if (!b.fits(20)) return;
  const count = b.rng.chance(0.3) ? STACK_CAPACITY : b.rng.int(1, STACK_CAPACITY);
  const counter = b.pickReg(ALL_REGS);
  const others = ALL_REGS.filter((r) => r !== counter);
  const push = b.label();
  const pop = b.label();
  b.op(`LDI ${reg(counter)}, ${String(count)}`, 3);
  b.place(push);
  b.op(`PUSH ${reg(b.pickReg(others))}`, 2);
  b.op(`INC ${reg(b.pickReg(others))}`, 2);
  b.op(`DEC ${reg(counter)}`, 2);
  b.op(`JNZ ${push}`, 2);
  b.op(`LDI ${reg(counter)}, ${String(count)}`, 3);
  b.place(pop);
  b.op(`POP ${reg(b.pickReg(others))}`, 2);
  b.op(`DEC ${reg(counter)}`, 2);
  b.op(`JNZ ${pop}`, 2);
}

/**
 * main calls functions fn0..fnK-1 and halts; fnI may call fnJ only for J > I, so calls nest at
 * most K deep and never recurse. Each body may hold balanced PUSH/POP pairs; main may also fill
 * the stack in a loop and drain it again.
 */
function callsProgram(b: Builder): void {
  const functions = b.rng.int(1, 4);
  const names = Array.from({ length: functions }, (_, i) => `fn${String(i)}`);
  const mainBudget = b.rng.int(36, 64);
  b.limit = mainBudget;
  b.reserved = 1;
  initRegisters(b, ALL_REGS);
  const calls = b.rng.int(1, 4);
  for (let i = 0; i < calls; i += 1) {
    if (b.rng.chance(0.25)) stackFill(b);
    if (b.rng.chance(0.4)) pushPop(b, ALL_REGS);
    body(b, { free: ALL_REGS, weights: ALU_WEIGHTS, items: b.rng.int(0, 3) });
    if (b.fits(2)) b.op(`CALL ${b.rng.pick(names)}`, 2);
  }
  halt(b);

  const share = Math.floor((CODE_END - b.size) / functions);
  names.forEach((name, i) => {
    b.limit = b.size + share;
    b.reserved = 1;
    b.place(name);
    const callees = names.slice(i + 1);
    const items = b.rng.int(1, 4);
    for (let k = 0; k < items; k += 1) {
      if (b.rng.chance(0.3)) pushPop(b, ALL_REGS);
      body(b, { free: ALL_REGS, weights: MEM_WEIGHTS, items: b.rng.int(1, 3) });
      if (callees.length > 0 && b.rng.chance(0.6) && b.fits(2)) {
        b.op(`CALL ${b.rng.pick(callees)}`, 2);
      }
    }
    b.reserved -= 1;
    b.op('RET', 1);
  });
}

const FAULT_TARGETS = Object.values(FaultCode);

/** A malformed register byte for an opcode that has one. */
function malformedRegisterByte(b: Builder, fields: 1 | 2): number {
  const bad = b.rng.int(8, 15);
  const good = b.rng.int(0, 7);
  if (fields === 2) {
    return b.rng.chance(0.5) ? (bad << 4) | b.rng.int(0, 15) : (good << 4) | bad;
  }
  return b.rng.chance(0.5) ? (bad << 4) | b.rng.int(0, 15) : (good << 4) | b.rng.int(1, 15);
}

/** A short ALU prefix, then a sequence that ends in `target`. */
function faultProgram(b: Builder, target: FaultCode): void {
  b.limit = b.rng.int(24, 72);
  b.reserved = 12;
  initRegisters(b, ALL_REGS);
  body(b, { free: ALL_REGS, weights: ALU_WEIGHTS, items: b.rng.int(0, 10) });
  b.reserved = 0;
  b.limit = CODE_END;
  const r = b.pickReg(ALL_REGS);
  const s = b.pickReg(ALL_REGS.filter((x) => x !== r));
  const far: string[] = [];
  switch (target) {
    case FaultCode.DIVIDE_BY_ZERO:
      b.op(`LDI ${reg(s)}, 0`, 3);
      b.op(`DIV ${reg(r)}, ${reg(s)}`, 2);
      break;
    case FaultCode.STACK_UNDERFLOW:
      if (b.rng.chance(0.5)) {
        b.op(`PUSH ${reg(r)}`, 2);
        b.op(`POP ${reg(s)}`, 2);
        b.op(`POP ${reg(r)}`, 2);
      } else {
        b.op('RET', 1);
      }
      break;
    case FaultCode.STACK_OVERFLOW:
      if (b.rng.chance(0.5)) {
        const top = b.label();
        b.op(`LDI ${reg(r)}, ${String(STACK_CAPACITY + 1)}`, 3);
        b.place(top);
        b.op(`PUSH ${reg(s)}`, 2);
        b.op(`DEC ${reg(r)}`, 2);
        b.op(`JNZ ${top}`, 2);
      } else {
        // Unbounded recursion: the 65th CALL overflows.
        const rec = b.label('rec');
        b.place(rec);
        b.op(`INC ${reg(r)}`, 2);
        b.op(`CALL ${rec}`, 2);
      }
      break;
    case FaultCode.INVALID_OPCODE: {
      const opcode = b.rng.pick(INVALID_OPCODES);
      if (b.rng.chance(0.5)) {
        b.op(`.byte ${hex(opcode)}`, 1);
      } else {
        // Write the bad byte into the data region and jump to it.
        const address = b.dataAddress();
        b.op(`LDI ${reg(r)}, ${hex(opcode)}`, 3);
        b.op(`STORE [${hex(address)}], ${reg(r)}`, 3);
        b.op(`JMP ${hex(address)}`, 2);
      }
      break;
    }
    case FaultCode.MALFORMED_OPERAND: {
      const info = b.rng.pick(
        OPCODES.filter((o) => INSTRUCTION_FORMATS[o.format].registerFields > 0),
      );
      const fields = INSTRUCTION_FORMATS[info.format].registerFields as 1 | 2;
      const bytes = [info.opcode, malformedRegisterByte(b, fields)];
      if (info.length === 3) bytes.push(b.rng.byte());
      b.op(`.byte ${bytes.map(hex).join(', ')}`, bytes.length);
      break;
    }
    case FaultCode.INSTRUCTION_OVERRUN: {
      // An instruction that starts at 0xFE or 0xFF and would run past 0xFF.
      const at = b.rng.chance(0.5) ? 0xfe : 0xff;
      const longest = OPCODES.filter((o) => o.length > 0x100 - at);
      const info = b.rng.pick(longest);
      const bytes = [info.opcode, ...(at === 0xfe ? [b.rng.byte()] : [])];
      const label = b.label('edge');
      b.op(`JMP ${label}`, 2);
      far.push(
        `        .org ${hex(at)}`,
        `${label}:`,
        `        .byte ${bytes.map(hex).join(', ')}`,
      );
      break;
    }
    case FaultCode.PC_OVERFLOW: {
      const label = b.label('edge');
      b.op(`JMP ${label}`, 2);
      const variant = b.rng.pick(['nop', 'ldi', 'call'] as const);
      if (variant === 'nop') {
        // A 1-byte instruction at 0xFF: it retires, then PC would be 0x100 (post-commit).
        far.push(`        .org 0xFF`, `${label}:`, `        NOP`);
      } else if (variant === 'ldi') {
        far.push(`        .org 0xFD`, `${label}:`, `        LDI ${reg(r)}, ${String(b.value())}`);
      } else {
        // CALL at 0xFE would push 0x100: a precise PC_OVERFLOW (design decision D1).
        far.push(`        .org 0xFE`, `${label}:`, `        CALL 0x00`);
      }
      break;
    }
  }
  b.op('HLT', 1);
  b.lines.push(...far);
}

/** 1–128 random bytes from 0x00, each a valid opcode byte 40% of the time. */
function rawProgram(b: Builder): void {
  const length = b.rng.int(1, CODE_END);
  const bytes = Array.from({ length }, () =>
    b.rng.chance(0.4) ? b.rng.pick(VALID_OPCODES) : b.rng.byte(),
  );
  for (let i = 0; i < bytes.length; i += 16) {
    b.op(
      `.byte ${bytes
        .slice(i, i + 16)
        .map(hex)
        .join(', ')}`,
      Math.min(16, bytes.length - i),
    );
  }
}

/** Thrown when the generator writes something the assembler rejects: a generator bug. */
export class GeneratorError extends Error {
  override readonly name = 'GeneratorError';
}

/** The program for `seed`: always the same source and image for the same seed. */
export function generateProgram(seed: number): RandomProgram {
  const rng = new Prng(seed);
  const shape = rng.weighted(SHAPE_WEIGHTS);
  const b = new Builder(rng, CODE_END);
  let targetFault: FaultCode | null = null;
  let selfModifying = false;
  let endless = false;
  switch (shape) {
    case 'alu':
      aluProgram(b);
      break;
    case 'memory':
      selfModifying = rng.chance(SELF_MODIFYING_SHARE);
      memoryProgram(b, selfModifying);
      break;
    case 'loop':
      endless = rng.chance(ENDLESS_SHARE);
      loopProgram(b, endless);
      break;
    case 'calls':
      callsProgram(b);
      break;
    case 'fault':
      targetFault = rng.pick(FAULT_TARGETS);
      faultProgram(b, targetFault);
      break;
    case 'raw':
      rawProgram(b);
      break;
  }
  const header = [
    `; random program, seed ${String(seed)}: shape ${shape}`,
    ...(targetFault === null ? [] : [`; built to end in ${targetFault}`]),
    ...(selfModifying ? ['; may store into its own code'] : []),
    ...(endless ? ['; ends in an endless loop, cut off at the step limit'] : []),
    `; max steps ${String(RANDOM_MAX_STEPS)} (both sides)`,
    '',
  ];
  const source = `${[...header, ...b.lines].join('\n')}\n`;
  if (b.size > CODE_END) {
    throw new GeneratorError(
      `seed ${String(seed)}: ${String(b.size)} bytes of code overflow 0x00–0x7F\n${source}`,
    );
  }
  const result = assemble(source);
  if (!result.ok) {
    const errors = result.diagnostics.map((d) => formatDiagnostic(d, source));
    throw new GeneratorError(
      `seed ${String(seed)}: the generated program does not assemble:\n${errors.join('\n')}\n${source}`,
    );
  }
  return {
    seed,
    shape,
    targetFault,
    selfModifying,
    endless,
    source,
    image: Array.from(result.bytes.image),
    codeBytes: b.size,
    maxSteps: RANDOM_MAX_STEPS,
  };
}
