; random program, seed 262: shape fault
; built to end in MALFORMED_OPERAND
; max steps 2000 (both sides)

        LDI R6, 254
        LDI R5, 189
        LDI R1, 128
        LDI R7, 254
        LDI R2, 162
        LDI R0, 25
        JMP L0
        ADD R6, R2
        JZ L1
        CMP R3, R5
L1:
L0:
        JC L2
        CMP R5, R3
        JZ L3
        AND R5, R7
L3:
        JMP L4
        NOP
L4:
L2:
        MOV R3, R0
        SHL R2
        .byte 0x22, 0x39
        HLT
