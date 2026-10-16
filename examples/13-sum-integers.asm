; 13-sum-integers.asm — sum 1 + 2 + … + N with a top-tested loop
;
; Purpose:  A while loop: test the condition first (CMP + JZ exits), run the body,
;           then JMP back to the test.
; Expected: N = 10: mem[0x80] = 10 × 11 / 2 = 55 (0x37). R0 = 55, R1 = 0.
;           Final FLAGS (the exit test, CMP 0, 0): Z=1 C=0 N=0 V=0.
; Overflow: the sum fits in 8 bits only up to N = 22 (253); N = 23 gives 276, which
;           wraps to 20 (0x14) with C=1 on the ADD that crosses 255.

        .equ N, 10

        LDI R0, 0           ; sum
        LDI R1, N           ; i, counting down
        LDI R2, 0           ; zero, for the comparison
loop:   CMP R1, R2
        JZ done             ; while i ≠ 0
        ADD R0, R1
        DEC R1
        JMP loop
done:   STORE [0x80], R0
        HLT
