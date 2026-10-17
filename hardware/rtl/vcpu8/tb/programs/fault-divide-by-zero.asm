; fault-divide-by-zero.asm — a loop whose divisor counts down to zero
;
; Targets:  brief §13 item 20 (invalid instruction handling): DIVIDE_BY_ZERO as a whole
;           program. It stores 120 / 4, 120 / 3, 120 / 2 and 120 / 1, then divides by 0.
; Expected: FAULTED, DIVIDE_BY_ZERO at PC 0x09 (the DIV). mem[0x80..0x83] = 1E 28 3C 78.
;           R0 = 120 (0x78, reloaded by LDI and left alone by the faulting DIV), R1 = 0,
;           R7 = 0x84. Z = 1 from the DEC that reached 0.
; max-steps: 100

        LDI R7, 0x80
        LDI R1, 4           ; divisor
loop:   LDI R0, 120
        DIV R0, R1
        STORE [R7], R0
        INC R7
        DEC R1
        JMP loop
