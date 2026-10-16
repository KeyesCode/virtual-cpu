import { CpuStatus, type OpcodeId } from '@vcpu/shared';
import { describe, expect, it } from 'vitest';
import { asm, C, FLAG_PREAMBLES, image, load, program, reg, runProgram, Z } from '../helpers.js';

describe('JMP addr8', () => {
  it('sets PC to the target, skipping code', () => {
    // 0x00 JMP 0x05; 0x02 LDI R0, 1 (skipped); 0x05 HLT
    const cpu = runProgram(program(asm.jump('JMP', 0x05), asm.ldi(0, 1), asm.hlt()));
    expect(cpu.getState()).toMatchObject({ pc: 0x05, status: CpuStatus.HALTED });
    expect(reg(cpu.getState(), 0)).toBe(0);
  });

  it('is a control transfer, not a conditional branch', () => {
    const cpu = load(program(asm.jump('JMP', 0x02), asm.hlt()));
    const { entry } = cpu.step();
    expect(entry).toMatchObject({ branchTaken: null, controlTransferred: true, cycles: 4 });
    expect(cpu.getMetrics()).toMatchObject({ branchesTaken: 0, branchesNotTaken: 0 });
  });

  it('may target its own address (a tight loop)', () => {
    const cpu = load(asm.jump('JMP', 0x00));
    expect(cpu.run({ maxInstructions: 10 })).toEqual({ executed: 10, stopReason: 'limit' });
    expect(cpu.getState().pc).toBe(0);
  });

  it('leaves FLAGS unchanged', () => {
    const preamble = FLAG_PREAMBLES.ZCV;
    const at = preamble.code.length;
    const state = runProgram(program(preamble.code, asm.jump('JMP', at + 2), asm.hlt())).getState();
    expect(state.flags).toBe(preamble.flags);
  });
});

/**
 * For each conditional branch: a flag-setting prologue that makes the condition true or false,
 * then `Jcc taken; LDI R0, 1; HLT; taken: LDI R0, 2; HLT`.
 */
const SET_Z = program(asm.ldi(6, 1), asm.ldi(7, 1), asm.rr('SUB', 6, 7)); // Z=1 C=0
const SET_C = program(asm.ldi(6, 0), asm.ldi(7, 1), asm.rr('SUB', 6, 7)); // Z=0 C=1

describe.each([
  { id: 'JZ', whenTrue: SET_Z, whenFalse: SET_C },
  { id: 'JNZ', whenTrue: SET_C, whenFalse: SET_Z },
  { id: 'JC', whenTrue: SET_C, whenFalse: SET_Z },
  { id: 'JNC', whenTrue: SET_Z, whenFalse: SET_C },
] satisfies { id: OpcodeId; whenTrue: number[]; whenFalse: number[] }[])(
  '$id addr8',
  ({ id, whenTrue, whenFalse }) => {
    const build = (prologue: number[]): number[] => {
      const taken = prologue.length + 2 + 3 + 1;
      return program(
        prologue,
        asm.jump(id, taken),
        asm.ldi(0, 1),
        asm.hlt(),
        asm.ldi(0, 2),
        asm.hlt(),
      );
    };

    it('branches when the condition holds', () => {
      const cpu = runProgram(build(whenTrue));
      expect(reg(cpu.getState(), 0)).toBe(2);
      const entry = cpu.getExecutionTrace().find((e) => e.instruction?.id === id);
      expect(entry).toMatchObject({ branchTaken: true, controlTransferred: true, cycles: 4 });
      expect(cpu.getMetrics()).toMatchObject({ branchesTaken: 1, branchesNotTaken: 0 });
    });

    it('falls through to PC + 2 otherwise', () => {
      const cpu = runProgram(build(whenFalse));
      expect(reg(cpu.getState(), 0)).toBe(1);
      const entry = cpu.getExecutionTrace().find((e) => e.instruction?.id === id);
      expect(entry).toMatchObject({ branchTaken: false, controlTransferred: false, cycles: 3 });
      expect(entry?.nextPc).toBe(whenFalse.length + 2);
      expect(cpu.getMetrics()).toMatchObject({ branchesTaken: 0, branchesNotTaken: 1 });
    });

    it('leaves FLAGS unchanged', () => {
      for (const prologue of [whenTrue, whenFalse]) {
        const cpu = runProgram(build(prologue));
        const flagsAfterPrologue = cpu
          .getExecutionTrace()
          .find((e) => e.instruction?.id === id)?.flagsBefore;
        expect(cpu.getState().flags).toBe(flagsAfterPrologue);
      }
    });
  },
);

describe('branch conditions read only their own flag', () => {
  it.each([
    { preamble: FLAG_PREAMBLES.ZCV, taken: ['JZ', 'JC'], notTaken: ['JNZ', 'JNC'] },
    { preamble: FLAG_PREAMBLES.CN, taken: ['JNZ', 'JC'], notTaken: ['JZ', 'JNC'] },
  ] satisfies {
    preamble: { code: readonly number[]; flags: number };
    taken: OpcodeId[];
    notTaken: OpcodeId[];
  }[])('FLAGS $preamble.flags', ({ preamble, taken, notTaken }) => {
    expect(preamble.flags & (Z | C)).not.toBe(0);
    for (const id of [...taken, ...notTaken]) {
      const cpu = runProgram(
        image({
          0x00: program([...preamble.code], asm.jump(id, 0x20), asm.hlt()),
          0x20: asm.hlt(),
        }),
      );
      expect(cpu.getState().pc === 0x20).toBe((taken as readonly OpcodeId[]).includes(id));
    }
  });
});

describe('CALL addr8 / RET', () => {
  // 0x00 CALL 0x10; 0x02 HLT; … 0x10 LDI R0, 7; 0x13 RET
  const code = image({
    0x00: program(asm.call(0x10), asm.hlt()),
    0x10: program(asm.ldi(0, 7), asm.ret()),
  });

  it('CALL pushes PC + 2 and jumps; RET pops it back', () => {
    const cpu = load(code);
    const call = cpu.step().entry;
    expect(cpu.getState()).toMatchObject({ pc: 0x10, sp: 0xfe, sd: 1 });
    expect(cpu.getState().memory[0xff]).toBe(0x02);
    expect(call).toMatchObject({ controlTransferred: true, branchTaken: null, cycles: 5 });
    expect(call?.memoryWrites).toEqual([{ address: 0xff, before: 0, after: 0x02 }]);
    expect(call?.registerChanges).toEqual([
      { register: 'SP', before: 0xff, after: 0xfe },
      { register: 'SD', before: 0, after: 1 },
    ]);

    cpu.step();
    const ret = cpu.step().entry;
    expect(cpu.getState()).toMatchObject({ pc: 0x02, sp: 0xff, sd: 0 });
    expect(ret).toMatchObject({ controlTransferred: true, cycles: 4 });
    expect(ret?.memoryReads).toEqual([{ address: 0xff, value: 0x02 }]);

    cpu.step();
    expect(cpu.getState()).toMatchObject({ status: CpuStatus.HALTED, pc: 0x02 });
    expect(reg(cpu.getState(), 0)).toBe(7);
  });

  it('nests: three levels deep return in reverse order', () => {
    // main: CALL a; HLT   a: INC R0; CALL b; RET   b: INC R0; CALL c; RET   c: INC R0; RET
    const nested = image({
      0x00: program(asm.call(0x20), asm.hlt()),
      0x20: program(asm.r('INC', 0), asm.call(0x30), asm.ret()),
      0x30: program(asm.r('INC', 0), asm.call(0x40), asm.ret()),
      0x40: program(asm.r('INC', 0), asm.ret()),
    });
    const cpu = load(nested);
    let maxDepth = 0;
    cpu.setObserver({
      beforeExecute: () => {
        maxDepth = Math.max(maxDepth, cpu.getState().sd);
        return undefined;
      },
    });
    cpu.run();
    const state = cpu.getState();
    expect(state).toMatchObject({ status: CpuStatus.HALTED, pc: 0x02, sd: 0, sp: 0xff });
    expect(reg(state, 0)).toBe(3);
    expect(maxDepth).toBe(3);
    // Return addresses left in the stack region, deepest last: main→0x02, a→0x24, b→0x34.
    expect(state.memory.slice(0xfd)).toEqual([0x34, 0x24, 0x02]);
  });

  it('RET to an address that was STOREd over the return slot (stack is not protected)', () => {
    const tampered = image({
      0x00: program(asm.call(0x10), asm.hlt(), asm.hlt()),
      0x10: program(asm.ldi(1, 0x03), asm.storeAbs(0xff, 1), asm.ret()),
    });
    const cpu = runProgram(tampered);
    expect(cpu.getState()).toMatchObject({ status: CpuStatus.HALTED, pc: 0x03 });
  });

  it('leave FLAGS unchanged', () => {
    const preamble = FLAG_PREAMBLES.CN;
    const start = preamble.code.length;
    const code2 = image({
      0x00: program(preamble.code, asm.call(0x40), asm.hlt()),
      0x40: asm.ret(),
    });
    const cpu = runProgram(code2);
    expect(cpu.getState()).toMatchObject({ flags: preamble.flags, pc: start + 2 });
  });
});
