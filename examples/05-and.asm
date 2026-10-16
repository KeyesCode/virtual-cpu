; 05-and.asm — bitwise AND for masking (and NOT to build a clearing mask)
;
; Purpose:  AND keeps only the bits set in both operands: use it to extract a field
;           or, with an inverted mask from NOT, to clear chosen bits.
; Expected: mem[0x80] = 0xB6 AND 0x0F = 0x06 (low nibble).
;           mem[0x81] = 0xB6 AND NOT 0x30 = 0xB6 AND 0xCF = 0x86 (bits 5 and 4 cleared).
;           mem[0x82] = 0xF0 AND 0x0F = 0x00, which sets Z.
;           R3 = NOT 0x30 = 0xCF. Final FLAGS (last AND): Z=1 C=0 N=0 V=0.
; Overflow: not possible; logic instructions always clear C and V.

        LDI R0, 0xB6        ; 1011 0110
        LDI R1, 0x0F        ; 0000 1111
        AND R0, R1          ; 0000 0110
        STORE [0x80], R0

        LDI R2, 0xB6
        LDI R3, 0x30        ; 0011 0000: the bits to clear
        NOT R3              ; 1100 1111
        AND R2, R3          ; 1000 0110
        STORE [0x81], R2

        LDI R4, 0xF0
        LDI R5, 0x0F
        AND R4, R5          ; no common bits → 0, Z=1
        STORE [0x82], R4
        HLT
