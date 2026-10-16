; 19-subroutines.asm — CALL and RET, including a nested call
;
; Purpose:  sum_squares computes R2 ← R0² + R1² by calling square twice, so calls nest
;           two deep. CALL pushes the return address (the byte after the CALL) and RET pops it.
; Expected: R0 = 3, R1 = 4: mem[0x80] = 9 + 16 = 25 (0x19). R2 = 25, R3 = 16.
;           The stack is empty again (SP = 0xFF), but popped bytes stay in memory:
;           mem[0xFF] = 0x08 (return from sum_squares into main) and mem[0xFE] = 0x19
;           (the second return from square; it overwrote the first one, 0x13).
;           HLT is at 0x0B. Final FLAGS (ADD 9 + 16): Z=0 C=0 N=0 V=0.
; Overflow: none. square only fits for inputs up to 15 (15² = 225).

        LDI R0, 3           ; 0x00
        LDI R1, 4           ; 0x03
        CALL sum_squares    ; 0x06: pushes 0x08
        STORE [0x80], R2    ; 0x08
        HLT                 ; 0x0B

; square: R3 ← R3 × R3
square: MUL R3, R3          ; 0x0C
        RET                 ; 0x0E

; sum_squares: R2 ← R0² + R1² (clobbers R3)
sum_squares:
        MOV R3, R0          ; 0x0F
        CALL square         ; 0x11: pushes 0x13
        MOV R2, R3          ; 0x13
        MOV R3, R1          ; 0x15
        CALL square         ; 0x17: pushes 0x19
        ADD R2, R3          ; 0x19
        RET                 ; 0x1B
