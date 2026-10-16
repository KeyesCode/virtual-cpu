import { Op } from '@vcpu/shared';
import { describe, expect, it } from 'vitest';
import {
  asm,
  FLAG_PREAMBLES,
  image,
  load,
  program,
  reg,
  runProgram,
  setRegisters,
} from '../helpers.js';

describe('MOV Rd, Rs', () => {
  it('copies Rs into Rd and leaves Rs', () => {
    const state = runProgram(program(setRegisters(0, 0x5a), asm.mov(0, 1), asm.hlt())).getState();
    expect(reg(state, 0)).toBe(0x5a);
    expect(reg(state, 1)).toBe(0x5a);
  });

  it('works for every register pair, R7 included', () => {
    for (let d = 0; d < 8; d += 1) {
      for (let s = 0; s < 8; s += 1) {
        const state = runProgram(
          program(asm.ldi(s, 0x40 + s), asm.mov(d, s), asm.hlt()),
        ).getState();
        expect(reg(state, d)).toBe(0x40 + s);
      }
    }
  });

  it('leaves FLAGS unchanged, even when moving 0', () => {
    for (const preamble of Object.values(FLAG_PREAMBLES)) {
      const state = runProgram(program(preamble.code, asm.mov(0, 1), asm.hlt())).getState();
      expect(state.flags).toBe(preamble.flags);
    }
  });
});

describe('LDI Rd, imm8', () => {
  it('loads the immediate byte, for 0x00 and 0xFF too', () => {
    const state = runProgram(program(asm.ldi(3, 0xff), asm.ldi(4, 0x00), asm.hlt())).getState();
    expect(reg(state, 3)).toBe(0xff);
    expect(reg(state, 4)).toBe(0x00);
  });

  it('advances PC by 3 and does not set Z for a zero', () => {
    const cpu = load(program(asm.ldi(0, 0), asm.hlt()));
    const { entry } = cpu.step();
    expect(cpu.getState().pc).toBe(3);
    expect(cpu.getState().flags).toBe(0);
    expect(entry?.flagChanges).toEqual([]);
  });

  it('leaves FLAGS unchanged', () => {
    for (const preamble of Object.values(FLAG_PREAMBLES)) {
      const state = runProgram(program(preamble.code, asm.ldi(0, 0), asm.hlt())).getState();
      expect(state.flags).toBe(preamble.flags);
    }
  });
});

describe('LOAD Rd, [addr8]', () => {
  it('reads the data byte and records the read', () => {
    const cpu = load(image({ 0x00: program(asm.loadAbs(2, 0x80), asm.hlt()), 0x80: [0x99] }));
    const { entry } = cpu.step();
    expect(reg(cpu.getState(), 2)).toBe(0x99);
    expect(entry?.memoryReads).toEqual([{ address: 0x80, value: 0x99 }]);
    expect(entry?.memoryWrites).toEqual([]);
    expect(cpu.getMetrics().memoryReads).toBe(1);
  });

  it('can read any address, including 0xFF and its own code', () => {
    const state = runProgram(
      program(asm.loadAbs(0, 0x00), asm.loadAbs(1, 0xff), asm.hlt()),
    ).getState();
    expect(reg(state, 0)).toBe(asm.loadAbs(0, 0)[0]);
    expect(reg(state, 1)).toBe(0x00);
  });

  it('leaves FLAGS unchanged when loading 0', () => {
    for (const preamble of Object.values(FLAG_PREAMBLES)) {
      const state = runProgram(program(preamble.code, asm.loadAbs(0, 0xf0), asm.hlt())).getState();
      expect(state.flags).toBe(preamble.flags);
    }
  });
});

describe('LOAD Rd, [Rp]', () => {
  it('reads mem[Rp]', () => {
    const state = runProgram(
      program(
        asm.ldi(1, 0x90),
        asm.ldi(2, 0x77),
        asm.storeAbs(0x90, 2),
        asm.loadInd(0, 1),
        asm.hlt(),
      ),
    ).getState();
    expect(reg(state, 0)).toBe(0x77);
  });

  it('uses the old pointer value when Rd = Rp', () => {
    const state = runProgram(
      program(
        asm.ldi(1, 0x90),
        asm.ldi(2, 0x33),
        asm.storeAbs(0x90, 2),
        asm.loadInd(1, 1),
        asm.hlt(),
      ),
    ).getState();
    expect(reg(state, 1)).toBe(0x33);
  });

  it('leaves FLAGS unchanged', () => {
    const preamble = FLAG_PREAMBLES.ZCV;
    const state = runProgram(program(preamble.code, asm.loadInd(0, 1), asm.hlt())).getState();
    expect(state.flags).toBe(preamble.flags);
  });
});

describe('STORE [addr8], Rs', () => {
  it('writes Rs and records the old and new byte', () => {
    const cpu = load(program(asm.ldi(5, 0xab), asm.storeAbs(0xa0, 5), asm.hlt()));
    cpu.step();
    const { entry } = cpu.step();
    expect(cpu.getState().memory[0xa0]).toBe(0xab);
    expect(entry?.memoryWrites).toEqual([{ address: 0xa0, before: 0x00, after: 0xab }]);
    expect(entry?.memoryReads).toEqual([]);
    expect(entry?.registerChanges).toEqual([]);
    expect(cpu.getMetrics().memoryWrites).toBe(1);
  });

  it('may overwrite code (unified memory)', () => {
    // STORE at 0x03 overwrites the HLT at 0x06 with a NOP, so execution falls through to HLT at 0x07.
    const code = program(asm.ldi(0, Op.NOP), asm.storeAbs(0x06, 0), asm.hlt(), asm.hlt());
    const cpu = runProgram(code);
    expect(cpu.getState().pc).toBe(0x07);
    expect(cpu.getMetrics().instructions).toBe(4);
  });

  it('leaves FLAGS unchanged', () => {
    const preamble = FLAG_PREAMBLES.CN;
    const state = runProgram(program(preamble.code, asm.storeAbs(0x80, 0), asm.hlt())).getState();
    expect(state.flags).toBe(preamble.flags);
  });
});

describe('STORE [Rp], Rs', () => {
  it('writes Rs to mem[Rp]', () => {
    const state = runProgram(
      program(asm.ldi(0, 0xb0), asm.ldi(1, 0x42), asm.storeInd(0, 1), asm.hlt()),
    ).getState();
    expect(state.memory[0xb0]).toBe(0x42);
  });

  it('stores the pointer itself when Rp = Rs', () => {
    const state = runProgram(program(asm.ldi(3, 0xb3), asm.storeInd(3, 3), asm.hlt())).getState();
    expect(state.memory[0xb3]).toBe(0xb3);
  });

  it('leaves FLAGS unchanged', () => {
    const preamble = FLAG_PREAMBLES.ZCV;
    const state = runProgram(program(preamble.code, asm.storeInd(0, 1), asm.hlt())).getState();
    expect(state.flags).toBe(preamble.flags);
  });
});
