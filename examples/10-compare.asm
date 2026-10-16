; 10-compare.asm — CMP sets flags like SUB without changing a register
;
; Purpose:  Unsigned comparisons with CMP and the conditional jumps. After CMP Ra, Rb:
;           Z=1 means Ra = Rb; C=1 (borrow) means Ra < Rb unsigned. Signed order is N XOR V.
; Expected: mem[0x80] = 1 because 10 < 20 (CMP borrows, C=1).
;           mem[0x81] = 1 because 42 = 42 (Z=1).
;           mem[0x82] = 1 because 0x90 ≥ 0x10 unsigned (C=0). Read as signed, 0x90 is −112,
;           which is less than 16: the result 0x80 has N=1 and V=0, so N XOR V = 1.
;           Registers are unchanged by CMP: R0 = 10, R1 = 20, R4 = 0x90, R5 = 0x10.
;           Final FLAGS (last CMP): Z=0 C=0 N=1 V=0.
; Overflow: none; CMP writes no register.

        LDI R7, 1           ; the byte written for "true"

        LDI R0, 10
        LDI R1, 20
        CMP R0, R1          ; 10 − 20 borrows → C=1
        JNC not_below
        STORE [0x80], R7
not_below:
        LDI R2, 42
        LDI R3, 42
        CMP R2, R3          ; equal → Z=1
        JNZ not_equal
        STORE [0x81], R7
not_equal:
        LDI R4, 0x90
        LDI R5, 0x10
        CMP R4, R5          ; 0x90 − 0x10 = 0x80: no borrow, N=1
        JC below
        STORE [0x82], R7
below:  HLT
