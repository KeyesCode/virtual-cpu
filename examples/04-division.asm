; 04-division.asm — unsigned division with a remainder
;
; Purpose:  DIV gives the floor of the unsigned quotient. There is no remainder instruction,
;           so the remainder is rebuilt as dividend − quotient × divisor.
; Expected: 200 ÷ 7: mem[0x80] = quotient 28 (0x1C), mem[0x81] = remainder 4.
;           R0 = 28, R1 = 7, R2 = 4, R3 = 28 × 7 = 196 (0xC4).
;           Final FLAGS (from SUB 200 − 196): Z=0 C=0 N=0 V=0.
; Overflow: none; DIV can never overflow and always clears C and V. DIV by zero would
;           fault with DIVIDE_BY_ZERO instead of producing a result.

        .equ QUOTIENT, 0x80
        .equ REMAINDER, 0x81

        LDI R0, 200         ; dividend
        LDI R1, 7           ; divisor
        MOV R2, R0          ; keep a copy of the dividend
        DIV R0, R1          ; R0 ← floor(200 / 7) = 28
        MOV R3, R0
        MUL R3, R1          ; R3 ← 28 × 7 = 196
        SUB R2, R3          ; R2 ← 200 − 196 = 4
        STORE [QUOTIENT], R0
        STORE [REMAINDER], R2
        HLT
