; full-stack.asm — fill all 64 bytes of the stack, then drain it
;
; Targets:  brief §13 item 16 (stack operations) at the limit: SD reaches STACK_CAPACITY (64)
;           without faulting. PUSH stores 64, 63, …, 1 into 0xFF down to 0xC0 (SP = 0xBF,
;           SD = 64), then 64 POPs read them back as 1, 2, …, 64 and add them as a 16-bit sum
;           (JNC skips the high-byte increment).
; Expected: HALTED. mem[0x80] = 0x20, mem[0x81] = 0x08 (1 + … + 64 = 2080 = 0x0820).
;           SP = 0xFF, SD = 0. The popped bytes stay in memory: mem[0xC0] = 0x01 … mem[0xFF] =
;           0x40. R0 = 64 (the last value popped), R3 = 0.
; max-steps: 1000

        LDI R0, 64
fill:   PUSH R0
        DEC R0
        JNZ fill
        ; SD = 64: one more PUSH would fault with STACK_OVERFLOW.
        LDI R3, 64          ; pops left
        LDI R1, 0           ; sum, low byte
        LDI R2, 0           ; sum, high byte
drain:  POP R0
        ADD R1, R0
        JNC no_carry
        INC R2
no_carry:
        DEC R3
        JNZ drain
        STORE [0x80], R1
        STORE [0x81], R2
        HLT
