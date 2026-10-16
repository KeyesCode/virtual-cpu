; 18-memory-copy.asm — copy a block of memory with two pointers
;
; Purpose:  memcpy: LOAD through a source pointer, STORE through a destination pointer,
;           advance both, count down.
; Expected: the 6 bytes "VCPU-8" at 0xA0 are copied to 0x80:
;           mem[0x80..0x85] = 56 43 50 55 2D 38, and the source is unchanged.
;           R0 = 0xA6, R1 = 0x86, R2 = 0, R3 = '8' (0x38).
;           Final FLAGS: Z=1 C=0 N=0 V=0 (from the last DEC).
; Overflow: none.

        .equ DEST, 0x80
        .equ COUNT, 6

        LDI R0, source      ; source pointer
        LDI R1, DEST        ; destination pointer
        LDI R2, COUNT       ; bytes left
loop:   LOAD R3, [R0]
        STORE [R1], R3
        INC R0
        INC R1
        DEC R2
        JNZ loop
        HLT

        .org 0xA0
source: .byte 'V', 'C', 'P', 'U', '-', '8'
