; 08-shift-left.asm — SHL multiplies by two; bit 7 falls into C
;
; Purpose:  Each SHL doubles an unsigned value. The bit shifted out of bit 7 goes to C,
;           which is how a program detects that the doubled value no longer fits.
; Expected: mem[0x80] = 3 << 3 = 3 × 8 = 24 (0x18).
;           mem[0x81] = 0xC1 << 1 = 0x182 → 0x82, with C=1 (old bit 7) and N=1.
;           Final FLAGS: Z=0 C=1 N=1 V=0.
; Overflow: 0xC1 × 2 = 386 does not fit; the lost 0x100 is the carry.

        LDI R0, 3
        SHL R0              ; 6
        SHL R0              ; 12
        SHL R0              ; 24
        STORE [0x80], R0

        LDI R1, 0xC1        ; 1100 0001
        SHL R1              ; 1000 0010, C ← 1
        STORE [0x81], R1
        HLT
