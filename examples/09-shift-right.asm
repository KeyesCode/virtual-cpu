; 09-shift-right.asm — SHR halves a value and exposes bit 0 in C
;
; Purpose:  A logical SHR divides an unsigned value by two (rounding down). Since bit 0
;           lands in C, eight SHRs with JNC count the 1 bits of a byte (its population count).
; Expected: mem[0x80] = 200 >> 1 = 100 (0x64).
;           mem[0x81] = popcount(0xB5 = 1011 0101) = 5.
;           R0 = 0 (all bits shifted out), R1 = 5, R2 = 0.
;           Final FLAGS: Z=1 N=0 V=0 from the last DEC; C=1 is left by the last SHR
;           (it shifted out bit 7 of 0xB5), because INC and DEC never change C.
; Overflow: none; a right shift only loses bit 0, which goes to C.

        .equ VALUE, 0xB5

        LDI R3, 200
        SHR R3              ; 100
        STORE [0x80], R3

        LDI R0, VALUE       ; byte whose 1 bits are counted
        LDI R1, 0           ; count
        LDI R2, 8           ; bits left
loop:   SHR R0              ; C ← next bit
        JNC zero_bit
        INC R1
zero_bit:
        DEC R2
        JNZ loop
        STORE [0x81], R1
        HLT
