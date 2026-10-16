; 03-multiplication.asm — unsigned 8-bit multiply and its overflow
;
; Purpose:  MUL keeps the low byte of the unsigned product and sets C and V when the
;           high byte would have been non-zero.
; Expected: mem[0x80] = 12 × 10 = 120 (0x78), C=0 V=0.
;           mem[0x81] = low byte of 20 × 13 = 260 (0x104) = 0x04, C=1 V=1.
;           Final FLAGS (from the second MUL): Z=0 C=1 N=0 V=1.
; Overflow: 260 does not fit in 8 bits; the 0x100 is lost and only C/V record it.

        .equ OUT, 0x80
        .equ OUT_WRAPPED, 0x81

        LDI R0, 12
        LDI R1, 10
        MUL R0, R1          ; R0 ← 120
        STORE [OUT], R0

        LDI R2, 20
        LDI R3, 13
        MUL R2, R3          ; 260 → R2 ← 0x04, C=1 V=1
        STORE [OUT_WRAPPED], R2
        HLT
