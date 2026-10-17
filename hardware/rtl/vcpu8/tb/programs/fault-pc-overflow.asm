; fault-pc-overflow.asm — straight-line code that runs off the end of memory
;
; Targets:  brief §13 item 20 (invalid instruction handling): PC_OVERFLOW as a whole program.
;           The code at 0xF8 doubles R0 twice, shifts it and increments it; the INC at 0xFE
;           ends at 0xFF, so its sequential next PC would be 0x100.
; Expected: FAULTED, PC_OVERFLOW at PC 0xFE. This fault is post-commit: the INC retires and
;           its result stays, R0 = 1 × 2 × 2 × 2 + 1 = 9, and PC stays 0xFE.
; max-steps: 100

        LDI R0, 1
        JMP tail

        .org 0xF8
tail:   ADD R0, R0          ; 0xF8: 2
        ADD R0, R0          ; 0xFA: 4
        SHL R0              ; 0xFC: 8
        INC R0              ; 0xFE: 9, then PC_OVERFLOW
