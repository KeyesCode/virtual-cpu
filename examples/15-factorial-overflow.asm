; 15-factorial-overflow.asm — n! for n = 1..6, and where 8 bits run out
;
; Purpose:  A running product with MUL. MUL sets C when the true product does not fit in
;           8 bits; JNC skips the overflow bookkeeping otherwise. The loop counter uses
;           INC/DEC, which never change C, so the carry of the last MUL survives to the end.
; Expected: mem[0x80..0x85] = 1! … 6! = 01 02 06 18 78 D0.
;           6! = 720 = 0x2D0 wraps to 0xD0 (208) with C=1 from MUL (120 × 6).
;           mem[0x88] = 6, the first n whose factorial overflowed.
;           R0 = 0xD0, R1 = 7, R2 = 0x86, R3 = 0.
;           Final FLAGS: C=1 (from the MUL); Z=1 N=0 V=0 (from the last DEC).
; Overflow: 5! = 120 is the largest factorial that fits in 8 bits; 6! = 720 does not.

        .equ OUT, 0x80
        .equ WRAPPED_AT, 0x88
        .equ N, 6

        LDI R0, 1           ; running product
        LDI R1, 1           ; n
        LDI R2, OUT         ; output pointer
        LDI R3, N           ; iterations left
loop:   MUL R0, R1          ; R0 ← low byte of R0 × n
        JNC fits
        STORE [WRAPPED_AT], R1
fits:   STORE [R2], R0
        INC R2
        INC R1
        DEC R3
        JNZ loop
        HLT
