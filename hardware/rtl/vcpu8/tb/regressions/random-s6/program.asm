; random program, seed 6: shape memory
; max steps 2000 (both sides)

        LDI R3, 64
        LDI R0, 255
        LDI R1, 64
        LDI R4, 161
        LDI R7, 228
        LDI R5, 177
        SHR R1
        LOAD R3, [0x9F]
        LDI R6, 0xBD
        STORE [R6], R7
        MOV R0, R4
        LDI R7, 0x3F
        AND R0, R7
        LDI R7, 0x80
        OR R0, R7
        LOAD R7, [R0]
        LOAD R1, [0xB4]
        CMP R2, R7
        JNZ L0
        SUB R2, R0
        LDI R4, 29
L0:
        LDI R3, 0x8A
        LOAD R6, [R3]
        STORE [0xB3], R6
        DEC R3
        ADD R7, R2
        LDI R3, 0x91
        LOAD R7, [R3]
        NOT R2
        MOV R3, R5
        LDI R0, 0x3F
        AND R3, R0
        LDI R0, 0x80
        OR R3, R0
        STORE [R3], R7
        MOV R5, R0
        SHR R4
        MOV R2, R0
        LDI R6, 0x3F
        AND R2, R6
        LDI R6, 0x80
        OR R2, R6
        LOAD R5, [R2]
        LOAD R5, [0x3B]
        JC L1
        ADD R7, R7
L1:
        MOV R0, R3
        LDI R3, 0x3F
        AND R0, R3
        LDI R3, 0x80
        OR R0, R3
        LOAD R6, [R0]
        HLT
