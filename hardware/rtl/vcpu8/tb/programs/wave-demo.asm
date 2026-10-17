; wave-demo.asm — a short program for looking at the RTL in GTKWave
;
; Purpose:  Fifteen instructions that between them take every path through the control FSM:
;           1-byte (FETCH → DECODE → EXECUTE → WRITEBACK: RET, HLT), 2-byte (+ OPERAND1: ADD,
;           DEC, JNZ, CALL, PUSH, POP) and 3-byte (+ OPERAND1 → OPERAND2: LDI, STORE, LOAD)
;           instructions, a memory write and a memory read, a branch taken and the same branch
;           not taken, a CALL and a RET through the stack, and the stop in HALTED.
; Run:      make -C hardware/rtl/vcpu8 wave     (writes build/waves/wave-demo.fst)
; Expected: R0 = 0x10, R1 = 0x20, R2 = 0x10, R3 = 0, R4 = 0x10; mem[0x80] = 0x10.
;           SP = 0xFF and SD = 0 again; the stack bytes stay in memory: mem[0xFF] = 0x17
;           (CALL's return address) and mem[0xFE] = 0x10 (PUSH R2). PC = 0x17, at the HLT.
;           Final FLAGS: Z=1 (the last DEC, 1 → 0) C=1 (the ADD; DEC leaves C alone) N=0 V=0.
;           15 instructions retire in 78 clock cycles.
;
; Cycles to look at, by the value of the `cycle` signal (cycle N starts at 10 × (N + 2) ns);
; docs/hardware/simulation-guide.md walks through the ADD, the taken JNZ and the CALL:
;            0–5    LDI R0, 0xF0       the 3-byte path: FETCH, DECODE, OPERAND1, OPERAND2, EXECUTE,
;                                      WRITEBACK; retire pulses in cycle 6
;           12–16   ADD R0, R1         0xF0 + 0x20 = 0x10 with carry: R0 ← 10 and FLAGS 04 (C)
;           17–22   STORE [0x80], R0   mem_we high in WRITEBACK (22): [80] ← 10
;           23–28   LOAD R2, [0x80]    address 80 in EXECUTE, the byte arrives in WRITEBACK (28)
;           40–44   JNZ loop (taken)   Z = 0: PC goes from 0x13 back to 0x11 in cycle 45
;           50–54   JNZ loop (not taken) Z = 1: PC goes on to 0x15
;           55–59   CALL stash         [FF] ← 17 in WRITEBACK, SP FF → FE, PC → 0x18
;           70–73   RET                the 1-byte path; reads 17 back from FF, PC → 0x17
;           74–77   HLT                then HALTED from cycle 78 on

        LDI R0, 0xF0        ; 0x00
        LDI R1, 0x20        ; 0x03
        ADD R0, R1          ; 0x06: R0 = 0x10, C = 1
        STORE [0x80], R0    ; 0x08
        LOAD R2, [0x80]     ; 0x0B
        LDI R3, 2           ; 0x0E: two passes round the loop
loop:   DEC R3              ; 0x11
        JNZ loop            ; 0x13: taken once, then falls through
        CALL stash          ; 0x15: pushes 0x17
        HLT                 ; 0x17

stash:  PUSH R2             ; 0x18
        POP R4              ; 0x1A
        RET                 ; 0x1C
