; 06-or.asm — bitwise OR for setting bits
;
; Purpose:  OR sets every bit that is set in either operand, e.g. to combine two nibbles
;           or to switch on a flag bit.
; Expected: mem[0x80] = 0x50 OR 0x0A = 0x5A.
;           mem[0x81] = 0x01 OR 0x80 = 0x81; bit 7 is now set, so N=1.
;           Final FLAGS (last OR): Z=0 C=0 N=1 V=0.
; Overflow: not possible; logic instructions always clear C and V.

        LDI R0, 0x50        ; 0101 0000
        LDI R1, 0x0A        ; 0000 1010
        OR R0, R1           ; 0101 1010
        STORE [0x80], R0

        LDI R2, 0x01
        LDI R3, 0x80
        OR R2, R3           ; 1000 0001 → N=1
        STORE [0x81], R2
        HLT
