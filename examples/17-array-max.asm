; 17-array-max.asm — the largest element of a byte array, and its index
;
; Purpose:  A linear search with CMP. CMP max, x borrows (C=1) exactly when x > max
;           unsigned, so JNC skips the update otherwise.
; Expected: data = 23, 77, 5, 140, 99, 201, 12, 64 (at 0xA0).
;           mem[0x80] = max 201 (0xC9), mem[0x81] = its index 5.
;           R0 = 0xC9, R1 = 5, R2 = 0xA8, R3 = 8, R4 = 64, R5 = 0.
;           Final FLAGS: Z=1 N=0 V=0 from the last DEC; C=0 from the last CMP (201 vs 64).
; Overflow: none. The comparison is unsigned; for signed bytes, test N XOR V instead of C.

        .equ COUNT, 8

        LOAD R0, [data]     ; max ← first element
        LDI R1, 0           ; index of max
        LDI R2, data        ; element pointer
        LDI R3, 0           ; current index
        LDI R5, COUNT       ; elements left
loop:   LOAD R4, [R2]
        CMP R0, R4          ; borrow when R4 > max
        JNC not_bigger
        MOV R0, R4
        MOV R1, R3
not_bigger:
        INC R2
        INC R3
        DEC R5
        JNZ loop
        STORE [0x80], R0
        STORE [0x81], R1
        HLT

        .org 0xA0
data:   .byte 23, 77, 5, 140, 99, 201, 12, 64
