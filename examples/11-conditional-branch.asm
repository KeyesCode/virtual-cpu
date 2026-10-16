; 11-conditional-branch.asm — if/else with conditional jumps
;
; Purpose:  Two if/else shapes. (1) Absolute value of a signed byte: there is no
;           "jump if negative", so SHL a copy to move the sign bit into C and use JNC.
;           Negation is two's complement: NOT, then INC. (2) A zero test with OR R, R
;           (sets Z and N without changing R) and JZ, with a JMP over the else branch.
; Expected: mem[0x80] = |−25| = 25 (0x19). −25 is stored as 0xE7; NOT gives 0x18, INC 0x19.
;           mem[0x81] = 0x11 (the "is zero" branch ran; the 0xEE branch was skipped).
;           R0 = 0x19, R1 = 0xE7 << 1 = 0xCE, R2 = 0, R3 = 0x11.
;           Final FLAGS (from OR R2, R2): Z=1 C=0 N=0 V=0.
; Overflow: |−128| is the one value this cannot represent: NOT 0x80 + 1 = 0x80 again.

        LDI R0, -25         ; 0xE7
        MOV R1, R0
        SHL R1              ; C ← sign bit of R0
        JNC positive
        NOT R0              ; negate: one's complement…
        INC R0              ; …plus one
positive:
        STORE [0x80], R0

        LDI R2, 0
        OR R2, R2           ; Z ← (R2 = 0)
        JZ is_zero
        LDI R3, 0xEE        ; else branch: skipped
        JMP done
is_zero:
        LDI R3, 0x11
done:   STORE [0x81], R3
        HLT
