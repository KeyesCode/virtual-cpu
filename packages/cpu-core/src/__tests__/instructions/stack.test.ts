import { CpuStatus, FaultCode, RESET_SP, STACK_CAPACITY } from '@vcpu/shared';
import { describe, expect, it } from 'vitest';
import { asm, FLAG_PREAMBLES, load, program, reg, runProgram } from '../helpers.js';

describe('PUSH Rs', () => {
  it('writes mem[SP], then SP ← SP − 1 and SD ← SD + 1', () => {
    const cpu = load(program(asm.ldi(2, 0xaa), asm.push(2), asm.hlt()));
    cpu.step();
    const { entry } = cpu.step();
    expect(cpu.getState()).toMatchObject({ sp: 0xfe, sd: 1 });
    expect(cpu.getState().memory[0xff]).toBe(0xaa);
    expect(entry?.memoryWrites).toEqual([{ address: 0xff, before: 0, after: 0xaa }]);
    expect(entry?.registerChanges).toEqual([
      { register: 'SP', before: 0xff, after: 0xfe },
      { register: 'SD', before: 0, after: 1 },
    ]);
    expect(entry?.cycles).toBe(4);
  });

  it('leaves Rs and FLAGS unchanged', () => {
    const preamble = FLAG_PREAMBLES.ZCV;
    const state = runProgram(
      program(preamble.code, asm.ldi(0, 9), asm.push(0), asm.hlt()),
    ).getState();
    expect(state.flags).toBe(preamble.flags);
    expect(reg(state, 0)).toBe(9);
  });
});

describe('POP Rd', () => {
  it('SP ← SP + 1, Rd ← mem[SP], SD ← SD − 1; the byte stays in memory', () => {
    const cpu = load(program(asm.ldi(0, 0x5c), asm.push(0), asm.pop(3), asm.hlt()));
    cpu.run({ maxInstructions: 2 });
    const { entry } = cpu.step();
    const state = cpu.getState();
    expect(state).toMatchObject({ sp: 0xff, sd: 0 });
    expect(reg(state, 3)).toBe(0x5c);
    expect(state.memory[0xff]).toBe(0x5c);
    expect(entry?.memoryReads).toEqual([{ address: 0xff, value: 0x5c }]);
  });

  it('is last-in, first-out', () => {
    const state = runProgram(
      program(
        asm.ldi(0, 1),
        asm.ldi(1, 2),
        asm.ldi(2, 3),
        asm.push(0),
        asm.push(1),
        asm.push(2),
        asm.pop(5),
        asm.pop(6),
        asm.pop(7),
        asm.hlt(),
      ),
    ).getState();
    expect(state.registers.slice(5)).toEqual([3, 2, 1]);
  });

  it('does not set Z when popping 0, and keeps FLAGS', () => {
    for (const preamble of Object.values(FLAG_PREAMBLES)) {
      const state = runProgram(
        program(preamble.code, asm.ldi(0, 0), asm.push(0), asm.pop(1), asm.hlt()),
      ).getState();
      expect(state.flags).toBe(preamble.flags);
    }
  });
});

describe('stack depth bound', () => {
  // LDI R1, n; loop: PUSH R1; DEC R1; JNZ loop; HLT
  const pushLoop = (n: number): number[] =>
    program(asm.ldi(1, n), asm.push(1), asm.r('DEC', 1), asm.jump('JNZ', 3), asm.hlt());

  it(`holds exactly ${String(STACK_CAPACITY)} bytes, filling 0xC0–0xFF`, () => {
    const cpu = runProgram(pushLoop(STACK_CAPACITY));
    expect(cpu.getState()).toMatchObject({
      status: CpuStatus.HALTED,
      sd: STACK_CAPACITY,
      sp: 0xbf,
    });
  });

  it(`push number ${String(STACK_CAPACITY + 1)} faults with STACK_OVERFLOW at the PUSH`, () => {
    const cpu = runProgram(pushLoop(STACK_CAPACITY + 1));
    expect(cpu.getState()).toMatchObject({
      status: CpuStatus.FAULTED,
      sd: STACK_CAPACITY,
      sp: 0xbf,
      pc: 3,
      fault: { code: FaultCode.STACK_OVERFLOW, pc: 3 },
    });
    expect(cpu.getState().memory[0xbf]).toBe(0);
  });

  it('POP at depth 0 faults with STACK_UNDERFLOW', () => {
    const cpu = runProgram(program(asm.nop(), asm.pop(0), asm.hlt()));
    expect(cpu.getState()).toMatchObject({
      status: CpuStatus.FAULTED,
      pc: 1,
      sp: RESET_SP,
      sd: 0,
      fault: { code: FaultCode.STACK_UNDERFLOW, pc: 1 },
    });
  });

  it('keeps SP == 0xFF − SD after every step of a push/pop/call/ret workload', () => {
    const code = program(
      asm.ldi(1, 10),
      asm.push(1), // 0x03
      asm.call(0x10), // 0x05
      asm.r('DEC', 1), // 0x07
      asm.jump('JNZ', 0x03), // 0x09
      asm.hlt(), // 0x0b
      [0, 0, 0, 0],
      asm.push(1), // 0x10
      asm.pop(2),
      asm.pop(3), // pops the return address
      asm.push(3), // and puts it back
      asm.ret(),
    );
    const cpu = load(code);
    let steps = 0;
    while (cpu.getState().status === CpuStatus.READY) {
      cpu.step();
      steps += 1;
      const { sp, sd } = cpu.getState();
      expect(sp).toBe(RESET_SP - sd);
    }
    expect(cpu.getState().status).toBe(CpuStatus.HALTED);
    expect(cpu.getState().sd).toBe(10);
    expect(steps).toBeGreaterThan(50);
  });
});
