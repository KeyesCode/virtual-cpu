; 12-countdown.asm — a countdown loop with DEC and JNZ
;
; Purpose:  The basic counted loop: DEC sets Z when the counter reaches zero and JNZ loops
;           until then. Each value is written through a pointer register (STORE [R1], R0),
;           and a NOP stands in for one tick of work per iteration.
; Expected: mem[0x80..0x8A] = 10 9 8 7 6 5 4 3 2 1 0.
;           R0 = 0, R1 = 0x8A. Final FLAGS (last DEC, 1 → 0): Z=1 C=0 N=0 V=0.
; Overflow: none.

        .equ START, 10
        .equ OUT, 0x80

        LDI R0, START       ; counter
        LDI R1, OUT         ; output pointer
loop:   STORE [R1], R0
        INC R1
        NOP                 ; one tick of "work"
        DEC R0
        JNZ loop
        STORE [R1], R0      ; the final 0
        HLT
