import { CpuStatus, FaultCode, lookupOpcode, Op, STACK_CAPACITY } from '@vcpu/shared';
import { describe, expect, it } from 'vitest';
import type { Cpu } from '../cpu.js';
import { architectural, asm, image, load, program, reg } from './helpers.js';

/** Runs until the next instruction is the one expected to fault, without executing it. */
function runTo(cpu: Cpu, pc: number): void {
  cpu.setObserver({ beforeExecute: (event) => (event.pc === pc ? 'break' : undefined) });
  expect(cpu.run().stopReason).toBe('breakpoint');
  cpu.setObserver(null);
}

/** A loop that pushes `count` bytes, then falls through to `next` at 0x09. */
function fillStack(count: number, next: number[]): number[] {
  return program(asm.ldi(1, count), asm.push(1), asm.r('DEC', 1), asm.jump('JNZ', 3), next);
}

interface PreciseCase {
  readonly name: string;
  readonly code: FaultCode;
  /** Memory image; the faulting instruction is at `at`. */
  readonly memory: number[];
  readonly at: number;
}

const PRECISE_CASES: readonly PreciseCase[] = [
  {
    name: 'INVALID_OPCODE (0xFF)',
    code: FaultCode.INVALID_OPCODE,
    memory: program(asm.ldi(0, 1), [0xff]),
    at: 3,
  },
  {
    name: 'MALFORMED_OPERAND (register field 8)',
    code: FaultCode.MALFORMED_OPERAND,
    memory: program(asm.ldi(0, 1), [Op.MOV, 0x80]),
    at: 3,
  },
  {
    name: 'INSTRUCTION_OVERRUN (LDI at 0xFE)',
    code: FaultCode.INSTRUCTION_OVERRUN,
    memory: image({ 0x00: program(asm.ldi(0, 1), asm.jump('JMP', 0xfe)), 0xfe: [Op.LDI, 0x00] }),
    at: 0xfe,
  },
  {
    name: 'PC_OVERFLOW (CALL at 0xFE)',
    code: FaultCode.PC_OVERFLOW,
    memory: image({ 0x00: program(asm.ldi(0, 1), asm.jump('JMP', 0xfe)), 0xfe: asm.call(0x00) }),
    at: 0xfe,
  },
  {
    name: 'DIVIDE_BY_ZERO',
    code: FaultCode.DIVIDE_BY_ZERO,
    memory: program(asm.ldi(0, 9), asm.rr('DIV', 0, 1), asm.hlt()),
    at: 3,
  },
  {
    name: 'STACK_OVERFLOW (PUSH)',
    code: FaultCode.STACK_OVERFLOW,
    memory: fillStack(STACK_CAPACITY, asm.push(0)),
    at: 9,
  },
  {
    name: 'STACK_OVERFLOW (CALL)',
    code: FaultCode.STACK_OVERFLOW,
    memory: fillStack(STACK_CAPACITY, asm.call(0x00)),
    at: 9,
  },
  {
    name: 'STACK_UNDERFLOW (POP)',
    code: FaultCode.STACK_UNDERFLOW,
    memory: program(asm.ldi(0, 1), asm.pop(0)),
    at: 3,
  },
  {
    name: 'STACK_UNDERFLOW (RET)',
    code: FaultCode.STACK_UNDERFLOW,
    memory: program(asm.ldi(0, 1), asm.ret()),
    at: 3,
  },
];

describe('precise faults', () => {
  it('cover every fault code', () => {
    const covered = new Set(PRECISE_CASES.map((c) => c.code));
    expect([...covered].sort()).toEqual(Object.values(FaultCode).sort());
  });

  it.each(PRECISE_CASES)('$name changes no architectural state', ({ code, memory, at }) => {
    const cpu = load(memory);
    runTo(cpu, at);
    const before = cpu.getState();
    const metricsBefore = cpu.getMetrics();
    expect(before.pc).toBe(at);

    const { status, entry } = cpu.step();
    const after = cpu.getState();

    expect(status).toBe(CpuStatus.FAULTED);
    expect(after.status).toBe(CpuStatus.FAULTED);
    expect(after.fault).toMatchObject({ code, pc: at });
    expect(after.fault?.detail).toEqual(expect.any(String));
    expect(architectural(after)).toEqual(architectural(before));
    expect(after.pc).toBe(at);
    expect(cpu.getMetrics()).toEqual(metricsBefore);
    expect(entry).toMatchObject({
      pc: at,
      nextPc: at,
      fault: { code, pc: at },
      registerChanges: [],
      flagChanges: [],
      memoryReads: [],
      memoryWrites: [],
      cycles: 0,
      controlTransferred: false,
      status: CpuStatus.FAULTED,
    });
  });

  it('report the decoded instruction when decoding got that far', () => {
    const div = load(program(asm.rr('DIV', 0, 1)));
    expect(div.step().entry?.instruction?.id).toBe('DIV');
    expect(div.getState().fault?.detail).toContain('divisor R1 is 0');

    const invalid = load([0xff]);
    expect(invalid.step().entry).toMatchObject({ instruction: null, bytes: [0xff] });

    const malformed = load([Op.MOV, 0x90]);
    expect(malformed.step().entry).toMatchObject({ instruction: null, bytes: [Op.MOV, 0x90] });
  });
});

describe('post-commit PC_OVERFLOW', () => {
  it('INC R0 at 0xFE: R0 is incremented, then the CPU faults with PC left at 0xFE', () => {
    const cpu = load(image({ 0x00: asm.jump('JMP', 0xfe), 0xfe: asm.r('INC', 0) }));
    runTo(cpu, 0xfe);
    const { entry } = cpu.step();
    const state = cpu.getState();
    expect(state).toMatchObject({
      status: CpuStatus.FAULTED,
      pc: 0xfe,
      fault: { code: FaultCode.PC_OVERFLOW, pc: 0xfe },
    });
    expect(reg(state, 0)).toBe(1);
    expect(state.ir?.id).toBe('INC');
    expect(entry).toMatchObject({ nextPc: 0xfe, cycles: 3, registerChanges: [{ register: 'R0' }] });
    expect(cpu.getMetrics().instructions).toBe(2);
  });

  it.each([
    { name: 'NOP at 0xFF', at: 0xff, code: asm.nop() },
    { name: 'LDI R0, 1 at 0xFD', at: 0xfd, code: asm.ldi(0, 1) },
    { name: 'STORE at 0xFD (the write lands)', at: 0xfd, code: asm.storeAbs(0x80, 1) },
    { name: 'PUSH at 0xFE (the push lands)', at: 0xfe, code: asm.push(1) },
    { name: 'JZ at 0xFE, not taken', at: 0xfe, code: asm.jump('JZ', 0x00) },
  ])('$name', ({ at, code }) => {
    const cpu = load(image({ 0x00: program(asm.ldi(1, 0x77), asm.jump('JMP', at)), [at]: code }));
    cpu.run();
    const state = cpu.getState();
    expect(state).toMatchObject({
      status: CpuStatus.FAULTED,
      pc: at,
      fault: { code: FaultCode.PC_OVERFLOW },
    });
    expect(cpu.getMetrics().instructions).toBe(3);
  });

  it('commits memory and stack effects before faulting', () => {
    const store = load(
      image({
        0x00: program(asm.ldi(1, 0x77), asm.jump('JMP', 0xfd)),
        0xfd: asm.storeAbs(0x80, 1),
      }),
    );
    store.run();
    expect(store.getState().memory[0x80]).toBe(0x77);

    const push = load(
      image({ 0x00: program(asm.ldi(1, 0x77), asm.jump('JMP', 0xfe)), 0xfe: asm.push(1) }),
    );
    push.run();
    // The PUSH wrote 0x77 at 0xFF — over the PUSH's own operand byte, which is ordinary memory.
    expect(push.getState()).toMatchObject({ sd: 1, sp: 0xfe });
    expect(push.getState().memory[0xff]).toBe(0x77);
  });

  it('does not apply when control transfers away from 0xFE / 0xFF', () => {
    const jmp = load(
      image({ 0x00: asm.jump('JMP', 0xfe), 0x10: asm.hlt(), 0xfe: asm.jump('JMP', 0x10) }),
    );
    jmp.run();
    expect(jmp.getState()).toMatchObject({ status: CpuStatus.HALTED, pc: 0x10, fault: null });

    const jnz = load(
      image({ 0x00: program(asm.jump('JMP', 0xfe)), 0x10: asm.hlt(), 0xfe: asm.jump('JNZ', 0x10) }),
    );
    jnz.run();
    expect(jnz.getState()).toMatchObject({ status: CpuStatus.HALTED, pc: 0x10, fault: null });

    // The first push lands on 0xFF, so occupy that slot, then write the RET there with STORE.
    const ret = load(
      image({
        0x00: program(
          asm.push(0),
          asm.ldi(2, Op.RET),
          asm.storeAbs(0xff, 2),
          asm.call(0x20),
          asm.hlt(),
        ),
        0x20: asm.jump('JMP', 0xff),
      }),
    );
    ret.run();
    expect(ret.getState()).toMatchObject({ status: CpuStatus.HALTED, pc: 0x0a, fault: null });
  });
});

describe('fault priority (cpu-execution.md "Fault priority")', () => {
  it('an invalid opcode at 0xFF is INVALID_OPCODE, not an overrun', () => {
    const cpu = load(image({ 0x00: asm.jump('JMP', 0xff), 0xff: [0xff] }));
    cpu.run();
    expect(cpu.getState().fault?.code).toBe(FaultCode.INVALID_OPCODE);
  });

  it('11 90 at 0xFE is INSTRUCTION_OVERRUN: bounds are checked before the register byte', () => {
    const cpu = load(image({ 0x00: asm.jump('JMP', 0xfe), 0xfe: [Op.LDI, 0x90] }));
    cpu.run();
    expect(cpu.getState().fault?.code).toBe(FaultCode.INSTRUCTION_OVERRUN);
  });

  it('a CALL at 0xFE with a full stack is PC_OVERFLOW', () => {
    // Filling the stack overwrites 0xC0–0xFF, so the CALL is stored at 0xFE afterwards.
    const cpu = load(
      fillStack(
        STACK_CAPACITY,
        program(
          asm.ldi(2, Op.CALL),
          asm.storeAbs(0xfe, 2),
          asm.ldi(2, 0x00),
          asm.storeAbs(0xff, 2),
          asm.jump('JMP', 0xfe),
        ),
      ),
    );
    cpu.run();
    expect(cpu.getState()).toMatchObject({
      sd: STACK_CAPACITY,
      fault: { code: FaultCode.PC_OVERFLOW, pc: 0xfe },
    });
  });

  it('every byte that is not an opcode faults with INVALID_OPCODE', () => {
    let invalid = 0;
    for (let byte = 0; byte <= 0xff; byte += 1) {
      if (lookupOpcode(byte) !== undefined) {
        continue;
      }
      invalid += 1;
      const cpu = load([byte]);
      cpu.step();
      expect(cpu.getState().fault).toMatchObject({ code: FaultCode.INVALID_OPCODE, pc: 0 });
    }
    expect(invalid).toBe(256 - 30);
  });
});

describe('after a fault', () => {
  it('step() and run() do nothing until reset()', () => {
    const cpu = load(program(asm.pop(0)));
    cpu.step();
    const faulted = cpu.getState();
    expect(cpu.step()).toEqual({ status: CpuStatus.FAULTED, entry: null });
    expect(cpu.run()).toEqual({ executed: 0, stopReason: 'faulted' });
    expect(cpu.getState()).toEqual(faulted);
    expect(cpu.getExecutionTrace()).toHaveLength(1);

    cpu.reset();
    expect(cpu.getState()).toMatchObject({ status: CpuStatus.READY, fault: null, pc: 0 });
  });

  it('run() stops with stopReason "faulted"', () => {
    const cpu = load(program(asm.nop(), asm.nop(), [0xee]));
    expect(cpu.run()).toEqual({ executed: 3, stopReason: 'faulted' });
  });
});
