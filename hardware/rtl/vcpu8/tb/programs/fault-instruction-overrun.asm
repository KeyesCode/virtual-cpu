; fault-instruction-overrun.asm — a three-byte instruction that starts at 0xFE
;
; Targets:  brief §13 item 20 (invalid instruction handling): INSTRUCTION_OVERRUN as a whole
;           program. The bytes 0x11 0x00 at 0xFE are the start of `LDI R0, imm8`, whose
;           immediate would be at 0x100. (The assembler refuses to emit such an LDI, so it is
;           written with .byte.)
; Expected: FAULTED, INSTRUCTION_OVERRUN at PC 0xFE. R0 = 0x42 = mem[0x80]; the LDI at 0xFE
;           does not execute.
; max-steps: 100

        LDI R0, 0x42
        STORE [0x80], R0
        JMP edge

        .org 0xFE
edge:   .byte 0x11, 0x00
