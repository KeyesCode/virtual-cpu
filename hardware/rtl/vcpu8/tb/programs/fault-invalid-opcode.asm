; fault-invalid-opcode.asm — a program that runs into a byte no instruction uses
;
; Targets:  brief §13 item 20 (invalid instruction handling): INVALID_OPCODE as a whole
;           program. It sums 5 + 4 + 3 + 2 + 1 into mem[0x80], then executes the byte 0xFF.
; Expected: FAULTED, INVALID_OPCODE at PC 0x0F. The faulting step retires nothing and writes
;           nothing: mem[0x80] = 15 (0x0F), R1 = 15, R0 = 0, Z = 1 from the last DEC.
; max-steps: 100

        LDI R0, 5
        LDI R1, 0
loop:   ADD R1, R0
        DEC R0
        JNZ loop
        STORE [0x80], R1
        .byte 0xFF          ; 0x0F: not an opcode
        HLT                 ; never reached
