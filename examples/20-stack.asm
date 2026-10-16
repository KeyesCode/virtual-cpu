; 20-stack.asm — PUSH and POP reverse an array
;
; Purpose:  The stack is last in, first out: push five bytes, then pop them back into
;           memory and they come out reversed. The stack starts at SP = 0xFF and grows
;           down; each PUSH writes mem[SP] and then decrements SP.
; Expected: data = 1 2 3 4 5 (at 0xA0); mem[0x80..0x84] = 05 04 03 02 01.
;           The pushes left mem[0xFB..0xFF] = 05 04 03 02 01 (1 was pushed first, at 0xFF).
;           After the pops SP = 0xFF again. R0 = 0x85, R1 = 0, R2 = 1.
;           Final FLAGS: Z=1 C=0 N=0 V=0 (from the last DEC).
; Overflow: none. More than 64 pushes would fault with STACK_OVERFLOW, and a POP from an
;           empty stack with STACK_UNDERFLOW.

        .equ OUT, 0x80
        .equ COUNT, 5

        LDI R0, data        ; source pointer
        LDI R1, COUNT
push_loop:
        LOAD R2, [R0]
        PUSH R2
        INC R0
        DEC R1
        JNZ push_loop

        LDI R0, OUT         ; destination pointer
        LDI R1, COUNT
pop_loop:
        POP R2
        STORE [R0], R2
        INC R0
        DEC R1
        JNZ pop_loop
        HLT

        .org 0xA0
data:   .byte 1, 2, 3, 4, 5
