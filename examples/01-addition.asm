; 01-addition.asm — add two 8-bit numbers
;
; Purpose:  The smallest useful program: load two immediates and ADD them.
; Expected: R0 = 10 + 20 = 30 (0x1E), R1 = 20. FLAGS Z=0 C=0 N=0 V=0.
;           HLT does not advance PC, so the CPU halts with PC = 0x08 (the HLT itself).
; Overflow: none. 30 fits in 8 bits; ADD would set C if the unsigned sum passed 255,
;           and V if two same-signed operands gave a result of the other sign.

        LDI R0, 10      ; 0x00: R0 ← 10
        LDI R1, 20      ; 0x03: R1 ← 20
        ADD R0, R1      ; 0x06: R0 ← R0 + R1 = 30
        HLT             ; 0x08
