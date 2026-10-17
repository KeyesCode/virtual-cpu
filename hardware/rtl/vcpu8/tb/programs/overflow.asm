; overflow.asm — ADD, SUB, MUL, INC and DEC at their 8-bit limits, and the branches on them
;
; Targets:  brief §13 item 19 (overflow behaviour). After each case the subroutine `flags`
;           turns C and Z into a byte with JNC and JNZ, so the branches on an overflow are both
;           taken and not taken. V and N have no branch in ISA 1.0; the lock-step compare checks
;           the whole FLAGS byte after every instruction instead. The order makes INC and DEC
;           run once with C = 0 and once with C = 1, so a carry out of either would show.
;           `flags` stores R0 and then (C << 1) | Z at R7 and R7 + 1. LDI, STORE, CALL, RET
;           and the branches leave FLAGS alone, and INC changes Z, N and V but never C.
; Expected: HALTED. mem[0x80..0x93], two bytes per case (result, C<<1 | Z):
;            1 ADD 0xF0 + 0x20 = 0x110 → 10 02 (unsigned carry)
;            2 ADD 0x70 + 0x10 = 0x80  → 80 00 (signed overflow, V=1 N=1)
;            3 ADD 0x80 + 0x80 = 0x100 → 00 03 (both, V=1)
;            4 SUB 0x10 − 0x20         → F0 02 (borrow, N=1)
;            5 SUB 0x80 − 0x01         → 7F 00 (signed overflow, V=1)
;            6 INC 0xFF                → 00 01 (wraps; C stays 0)
;            7 DEC 0x00                → FF 00 (wraps; C stays 0, N=1)
;            8 MUL 0x10 × 0x10 = 0x100 → 00 03 (high byte lost, C=V=1)
;            9 INC 0x7F                → 80 02 (V=1 N=1; C stays 1)
;           10 DEC 0x80                → 7F 02 (V=1; C stays 1)
;           Then 200 + 100 = 300 sets C and JC is taken: mem[0xA0] = 0x2C (0xEE if not).
;           The code ends at 0x7A, below the data it writes.
; max-steps: 300

        LDI R7, 0x80

        LDI R0, 0xF0        ; 1
        LDI R1, 0x20
        ADD R0, R1
        CALL flags
        LDI R0, 0x70        ; 2
        LDI R1, 0x10
        ADD R0, R1
        CALL flags
        LDI R0, 0x80        ; 3
        ADD R0, R0
        CALL flags
        LDI R0, 0x10        ; 4
        LDI R1, 0x20
        SUB R0, R1
        CALL flags
        LDI R0, 0x80        ; 5
        LDI R1, 0x01
        SUB R0, R1
        CALL flags
        LDI R0, 0xFF        ; 6
        INC R0
        CALL flags
        LDI R0, 0x00        ; 7
        DEC R0
        CALL flags
        LDI R0, 0x10        ; 8
        MUL R0, R0
        CALL flags
        LDI R0, 0x7F        ; 9
        INC R0
        CALL flags
        LDI R0, 0x80        ; 10
        DEC R0
        CALL flags

        LDI R0, 200
        LDI R1, 100
        ADD R0, R1          ; 300 → 0x2C, C=1
        JC carried
        LDI R0, 0xEE
carried:
        STORE [0xA0], R0
        HLT

; flags: mem[R7] ← R0, mem[R7 + 1] ← (C << 1) | Z; R7 ← R7 + 2. Clobbers R5.
flags:  LDI R5, 0
        JNC flags_z
        LDI R5, 2
flags_z:
        JNZ flags_store
        INC R5
flags_store:
        STORE [R7], R0
        INC R7
        STORE [R7], R5
        INC R7
        RET
