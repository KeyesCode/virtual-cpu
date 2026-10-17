; fault-stack-overflow.asm — unbounded recursion
;
; Targets:  brief §13 item 20 (invalid instruction handling): STACK_OVERFLOW as a whole
;           program. `count` increments R0 and calls itself; each CALL pushes 0x07.
; Expected: FAULTED, STACK_OVERFLOW at PC 0x05 (the 65th CALL). R0 = 65 (0x41). SD = 64,
;           SP = 0xBF, and mem[0xC0..0xFF] are all 0x07. The faulting CALL pushes nothing.
; max-steps: 200

        LDI R0, 0
count:  INC R0
        CALL count
