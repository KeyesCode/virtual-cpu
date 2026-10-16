; 16-array-sum.asm — sum a byte array into a 16-bit total
;
; Purpose:  Walk an array with a pointer (LOAD R4, [R2]) and add each element. The sum
;           outgrows 8 bits, so every carry out of the low byte (ADD sets C, JNC skips)
;           increments a high byte: a 16-bit sum built from 8-bit adds.
; Expected: data = 200, 100, 50, 150, 75, 25, 220, 10 (at 0xA0), total 830 = 0x033E.
;           mem[0x80] = low byte 0x3E (62), mem[0x81] = high byte 0x03 (three carries).
;           R0 = 0x3E, R1 = 3, R2 = 0xA8, R3 = 0, R4 = 10.
;           Final FLAGS: Z=1 N=0 V=0 from the last DEC; C=0 from the last ADD (52 + 10).
; Overflow: the low byte wraps three times: 200 + 100, 244 + 75 and 88 + 220 each carry.

        .equ COUNT, 8
        .equ SUM_LO, 0x80
        .equ SUM_HI, 0x81

        LDI R0, 0           ; low byte of the sum
        LDI R1, 0           ; high byte of the sum
        LDI R2, data        ; element pointer
        LDI R3, COUNT       ; elements left
loop:   LOAD R4, [R2]
        ADD R0, R4
        JNC no_carry
        INC R1              ; carry into the high byte
no_carry:
        INC R2
        DEC R3
        JNZ loop
        STORE [SUM_LO], R0
        STORE [SUM_HI], R1
        HLT

        .org 0xA0
data:   .byte 200, 100, 50, 150, 75, 25, 220, 10
