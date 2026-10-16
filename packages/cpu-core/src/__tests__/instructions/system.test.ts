import { CpuStatus } from '@vcpu/shared';
import { describe, expect, it } from 'vitest';
import { asm, FLAG_PREAMBLES, image, load, program, runProgram } from '../helpers.js';

describe('NOP', () => {
  it('advances PC by 1 and changes nothing else', () => {
    const cpu = load(program(FLAG_PREAMBLES.ZCV.code, asm.nop(), asm.hlt()));
    cpu.run({ maxInstructions: 3 });
    const before = cpu.getState();
    const { entry } = cpu.step();
    const after = cpu.getState();
    expect(after.pc).toBe(before.pc + 1);
    expect(after.registers).toEqual(before.registers);
    expect(after.flags).toBe(FLAG_PREAMBLES.ZCV.flags);
    expect(after.memory).toEqual(before.memory);
    expect(after.sp).toBe(before.sp);
    expect(entry?.registerChanges).toEqual([]);
    expect(entry?.flagChanges).toEqual([]);
    expect(entry?.cycles).toBe(2);
  });
});

describe('HLT', () => {
  it('halts without advancing PC', () => {
    const cpu = runProgram(program(asm.nop(), asm.hlt()));
    const state = cpu.getState();
    expect(state.status).toBe(CpuStatus.HALTED);
    expect(state.pc).toBe(0x01);
    expect(state.fault).toBeNull();
    expect(state.ir?.id).toBe('HLT');
    expect(cpu.getMetrics().instructions).toBe(2);
  });

  it('is legal at 0xFF (no PC_OVERFLOW, because PC does not advance)', () => {
    const cpu = load(image({ 0x00: asm.jump('JMP', 0xff), 0xff: asm.hlt() }));
    cpu.run();
    expect(cpu.getState()).toMatchObject({ status: CpuStatus.HALTED, pc: 0xff, fault: null });
  });

  it('keeps FLAGS', () => {
    const cpu = runProgram(program(FLAG_PREAMBLES.CN.code, asm.hlt()));
    expect(cpu.getState().flags).toBe(FLAG_PREAMBLES.CN.flags);
  });
});
