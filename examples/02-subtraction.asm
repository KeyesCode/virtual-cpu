; 02-subtraction.asm — subtraction, borrow and two's complement
;
; Purpose:  SUB with and without a borrow. A negative result is stored in two's complement,
;           and C reports the borrow (the unsigned first operand was smaller).
; Expected: mem[0x80] = 50 − 20 = 30 (0x1E), with C=0.
;           mem[0x81] = 20 − 50 = −30 → 256 − 30 = 226 (0xE2), with C=1 (borrow) and N=1.
;           Final FLAGS (from the second SUB): Z=0 C=1 N=1 V=0. V stays 0 because both
;           operands are non-negative, so a signed overflow is impossible.
; Overflow: the second result wraps below zero: unsigned it reads 226, signed it reads −30.

        .equ OUT, 0x80
        .equ OUT_NEG, 0x81

        LDI R0, 50
        LDI R1, 20
        SUB R0, R1          ; R0 ← 30, no borrow
        STORE [OUT], R0

        LDI R2, 20
        LDI R3, 50
        SUB R2, R3          ; R2 ← 0xE2 (−30), borrow → C=1
        STORE [OUT_NEG], R2
        HLT
