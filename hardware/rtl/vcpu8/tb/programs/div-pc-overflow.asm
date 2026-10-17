; div-pc-overflow.asm — a DIV in the last two bytes of memory
;
; Targets:  the iterative divider (DIV_IMPL=ITER, research/cpu/experiments/div-impl/): a DIV
;           whose sequential next PC is 0x100 must still commit its quotient and flags before
;           the post-commit PC_OVERFLOW, however many cycles it waits in EXECUTE. First an ADD
;           of 0x80 + 0x80 sets Z, C and V, so the DIV visibly changes every flag.
; Expected: FAULTED, PC_OVERFLOW at PC 0xFE. The DIV retires: R0 = 0xFF / 0x01 = 0xFF, with
;           N = 1 and Z = C = V = 0. R1 = 1, R2 = 0x00, and PC stays 0xFE.
; max-steps: 100

        LDI R0, 0xFF
        LDI R1, 1
        LDI R2, 0x80
        ADD R2, R2          ; 0x00: Z = C = V = 1
        JMP tail

        .org 0xFE
tail:   DIV R0, R1          ; 0xFE: 0xFF, N = 1, then PC_OVERFLOW
