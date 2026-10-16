; 07-xor.asm — bitwise XOR: toggling bits, swapping registers, clearing a register
;
; Purpose:  XOR flips the bits selected by its second operand. Three XORs swap two
;           registers without a temporary, and XOR of a register with itself clears it.
; Expected: mem[0x80] = 0x5A XOR 0xFF = 0xA5 (every bit toggled).
;           XOR swap of R2 = 0x12 and R3 = 0x34: mem[0x81] = R2 = 0x34, mem[0x82] = R3 = 0x12.
;           R0 = 0 after XOR R0, R0. Final FLAGS: Z=1 C=0 N=0 V=0.
; Overflow: not possible; logic instructions always clear C and V.

        LDI R0, 0x5A        ; 0101 1010
        LDI R1, 0xFF
        XOR R0, R1          ; 1010 0101
        STORE [0x80], R0

        LDI R2, 0x12
        LDI R3, 0x34
        XOR R2, R3          ; R2 = 0x12 ^ 0x34 = 0x26
        XOR R3, R2          ; R3 = 0x34 ^ 0x26 = 0x12
        XOR R2, R3          ; R2 = 0x26 ^ 0x12 = 0x34
        STORE [0x81], R2
        STORE [0x82], R3

        XOR R0, R0          ; R0 ← 0, Z=1
        HLT
