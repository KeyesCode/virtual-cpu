; fault-stack-underflow.asm — one POP more than there were PUSHes
;
; Targets:  brief §13 item 20 (invalid instruction handling): STACK_UNDERFLOW as a whole
;           program. It pushes 1, 2, 3 and pops in a loop that runs four times.
; Expected: FAULTED, STACK_UNDERFLOW at the POP (PC 0x13) on the fourth pass. R2 = 3 + 2 + 1
;           = 6, R3 = 1, R1 = 1 (the last value popped), R0 = 3. SP = 0xFF, SD = 0.
; max-steps: 100

        LDI R0, 1
        PUSH R0
        INC R0
        PUSH R0
        INC R0
        PUSH R0
        LDI R3, 4           ; one pop too many
        LDI R2, 0
loop:   POP R1
        ADD R2, R1
        DEC R3
        JNZ loop
        HLT                 ; never reached
