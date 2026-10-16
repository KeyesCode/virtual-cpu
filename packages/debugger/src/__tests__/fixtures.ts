import { assemble } from '@vcpu/assembler';
import { createDebugSession, type DebugSession, type DebugSessionOptions } from '../index.js';

/** Fibonacci F(0)…F(9) into 0x80…0x89; F(5) = 5 lands at 0x85. */
export const FIBONACCI = `; Fibonacci numbers into 0x80 onwards
        .equ OUT, 0x80
        LDI R0, 0           ; F(n-2)
        LDI R1, 1           ; F(n-1)
        LDI R4, OUT         ; write pointer
        STORE [R4], R0
        INC R4
        STORE [R4], R1
        INC R4
        LDI R3, 8           ; terms left
loop:   MOV R2, R0
        ADD R2, R1          ; R2 = F(n)
        STORE [R4], R2
        INC R4
        MOV R0, R1
        MOV R1, R2
        DEC R3
        JNZ loop
        HLT
`;

/** Subroutine calls and stack traffic: CALL, RET, PUSH, POP. */
export const STACK = `
        LDI R0, 3
        LDI R1, 4
        PUSH R0
        PUSH R1
        CALL sum
        POP R2
        POP R3
        STORE [0x90], R0
        HLT
sum:    PUSH R1
        ADD R0, R1
        POP R1
        RET
`;

/** Reads a table with LOAD, keeps the maximum, then sets every flag path with SUB and SHL. */
export const ARRAY_MAX = `
        LDI R1, table
        LDI R2, 5           ; count
        LDI R0, 0           ; max
next:   LOAD R3, [R1]
        CMP R3, R0
        JC skip
        MOV R0, R3
skip:   INC R1
        DEC R2
        JNZ next
        STORE [0xA0], R0
        LDI R5, 0x80
        SHL R5
        SUB R6, R5
        HLT
table:  .byte 7, 200, 3, 255, 9
`;

/** Ends in a precise DIVIDE_BY_ZERO fault. */
export const DIVIDE_BY_ZERO = `
        LDI R0, 9
        LDI R1, 0
        STORE [0x80], R0
        DIV R0, R1
        HLT
`;

/** Runs off the end of memory: a post-commit PC_OVERFLOW after INC at 0xFE. */
export const PC_OVERFLOW = `
        JMP last
        .org 0xFE
last:   INC R0
`;

/** Rewrites its own HLT into a NOP, then loops back over it once. */
export const SELF_MODIFYING = `
        LDI R0, 0           ; NOP opcode
        LDI R1, 2
again:  STORE [patch], R0
        DEC R1
        JNZ again
patch:  HLT
        HLT
`;

export interface Fixture {
  readonly name: string;
  readonly source: string;
}

const examples = import.meta.glob('../../../../examples/*.asm', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The inline fixtures plus every `examples/*.asm` in the repository. */
export const PROGRAMS: readonly Fixture[] = [
  { name: 'fibonacci (fixture)', source: FIBONACCI },
  { name: 'stack (fixture)', source: STACK },
  { name: 'array max (fixture)', source: ARRAY_MAX },
  { name: 'divide by zero (fixture)', source: DIVIDE_BY_ZERO },
  { name: 'pc overflow (fixture)', source: PC_OVERFLOW },
  { name: 'self-modifying (fixture)', source: SELF_MODIFYING },
  ...Object.entries(examples).map(([path, source]) => ({
    name: path.slice(path.lastIndexOf('/') + 1),
    source,
  })),
];

/** Assembles `source` (which must be valid) into a debug session with its source map. */
export function sessionFor(
  source: string,
  options: Omit<DebugSessionOptions, 'program' | 'sourceMap'> = {},
): DebugSession {
  const result = assemble(source);
  if (!result.ok) {
    throw new Error(`Fixture does not assemble: ${JSON.stringify(result.diagnostics)}`);
  }
  return createDebugSession({
    program: result.bytes.image,
    sourceMap: result.sourceMap,
    ...options,
  });
}

/** The address of the instruction on the 1-based source line whose text starts with `text`. */
export function addressOf(source: string, text: string): number {
  const result = assemble(source);
  for (const entry of result.sourceMap.values()) {
    if (entry.text === text) {
      return entry.address;
    }
  }
  throw new Error(`No instruction \`${text}\` in the fixture`);
}

/** The 1-based line number of the first line containing `text`. */
export function lineOf(source: string, text: string): number {
  const index = source.split('\n').findIndex((line) => line.includes(text));
  if (index < 0) {
    throw new Error(`No line contains \`${text}\``);
  }
  return index + 1;
}
