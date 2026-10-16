; 14-fibonacci.asm — the first ten Fibonacci numbers
;
; Purpose:  Iterate F(n+2) = F(n) + F(n+1), keeping two terms in registers and writing
;           each term through a pointer.
; Expected: mem[0x80..0x89] = 00 01 01 02 03 05 08 0D 15 22
;           (0, 1, 1, 2, 3, 5, 8, 13, 21, 34).
;           R0 = F(10) = 55 (0x37), R1 = F(11) = 89 (0x59), R2 = 0x8A, R3 = 0, R4 = 89.
;           Final FLAGS: Z=1 N=0 V=0 from the last DEC; C=0 from the last ADD (34 + 55).
; Overflow: none here. F(13) = 233 is the largest term that fits; F(14) = 377 wraps to
;           121 (0x79) with C=1.

        .equ OUT, 0x80
        .equ COUNT, 10

        LDI R0, 0           ; a = F(n)
        LDI R1, 1           ; b = F(n+1)
        LDI R2, OUT         ; output pointer
        LDI R3, COUNT       ; terms left
loop:   STORE [R2], R0
        INC R2
        MOV R4, R0
        ADD R4, R1          ; F(n+2) = a + b
        MOV R0, R1          ; a ← b
        MOV R1, R4          ; b ← F(n+2)
        DEC R3
        JNZ loop
        HLT
