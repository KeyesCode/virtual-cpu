; fault-malformed-operand.asm — a program that writes a malformed ADD into RAM and runs it
;
; Targets:  brief §13 item 20 (invalid instruction handling): MALFORMED_OPERAND as a whole
;           program. After a well-formed ADD it stores the bytes 0x20 0x08 (ADD with field
;           b = 8: there is no R8) at 0x90 and jumps there.
; Expected: FAULTED, MALFORMED_OPERAND at PC 0x90. R0 = 7 + 9 = 16 (0x10) = mem[0x80];
;           mem[0x90..0x91] = 20 08. The faulting ADD changes no register or flag.
; max-steps: 100

        LDI R0, 7
        LDI R1, 9
        ADD R0, R1
        STORE [0x80], R0
        LDI R2, 0x20        ; ADD
        STORE [0x90], R2
        LDI R2, 0x08        ; register byte: field a = R0, field b = 8
        STORE [0x91], R2
        JMP 0x90
