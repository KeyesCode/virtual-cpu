import { assemble } from '@vcpu/assembler';
import { createCpu } from '@vcpu/cpu-core';
import { describe, expect, it } from 'vitest';
import { formatHexdump, formatRegisters } from './state.js';

describe('formatRegisters', () => {
  it('keeps its layout', () => {
    const cpu = createCpu();
    cpu.loadProgram(
      assemble('LDI R0, 30\nLDI R2, 0x81\nLDI R7, 0xFF\nCMP R0, R7\nPUSH R0\nHLT\n').bytes.image,
    );
    cpu.run();
    expect(formatRegisters(cpu.getState())).toMatchInlineSnapshot(`
      "Registers
        R0 = 0x1E (30)          R1 = 0x00 (0)           R2 = 0x81 (129, -127)   R3 = 0x00 (0)
        R4 = 0x00 (0)           R5 = 0x00 (0)           R6 = 0x00 (0)           R7 = 0xFF (255, -1)
        PC = 0x0D               SP = 0xFE               SD = 1                  IR = HLT
      Flags
        Z=0 C=1 N=0 V=0         FLAGS = 0x04"
    `);
  });
});

describe('formatHexdump', () => {
  it('blanks bytes outside the range', () => {
    const memory = Array.from({ length: 256 }, (_, i) => i);
    expect(formatHexdump(memory, { start: 0x1e, end: 0x21 })).toBe(
      [
        '        +0 +1 +2 +3 +4 +5 +6 +7 +8 +9 +A +B +C +D +E +F',
        '  0x10                                            1E 1F',
        '  0x20  20 21',
      ].join('\n'),
    );
  });
});
