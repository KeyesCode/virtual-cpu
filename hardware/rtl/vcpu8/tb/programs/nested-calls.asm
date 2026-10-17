; nested-calls.asm — CALL and RET five deep, with work on the way in and on the way out
;
; Targets:  brief §13 item 18 (nested calls). examples/19-subroutines.asm nests only two deep.
;           main calls depth1, which calls depth2, then depth3, then depth4; every level logs
;           its number through the shared subroutine `log`, so the deepest call (depth4 → log)
;           has five return addresses on the stack (SD = 5, SP = 0xFA).
;           On the way in each level doubles R1 and logs 1, 2, 3, 4; on the way out it adds 1
;           to R1 (depth4 excepted) and logs 0x14, 0x13, 0x12, 0x11.
; Expected: HALTED at the HLT (0x08). mem[0x80..0x87] = 01 02 03 04 14 13 12 11, R7 = 0x88
;           (the log pointer). R1 = 3 × 2⁴ + 3 = 51 (0x33): depth4 does not add 1. R0 = 0x11.
;           SP = 0xFF and SD = 0 again.
; max-steps: 200

        LDI R7, 0x80        ; log pointer
        LDI R1, 3           ; the value each level doubles
        CALL depth1
        HLT

; log: mem[R7] ← R0, R7 ← R7 + 1
log:    STORE [R7], R0
        INC R7
        RET

depth1: ADD R1, R1
        LDI R0, 1
        CALL log
        CALL depth2
        INC R1
        LDI R0, 0x11
        CALL log
        RET

depth2: ADD R1, R1
        LDI R0, 2
        CALL log
        CALL depth3
        INC R1
        LDI R0, 0x12
        CALL log
        RET

depth3: ADD R1, R1
        LDI R0, 3
        CALL log
        CALL depth4
        INC R1
        LDI R0, 0x13
        CALL log
        RET

depth4: ADD R1, R1
        LDI R0, 4
        CALL log
        LDI R0, 0x14
        CALL log
        RET
