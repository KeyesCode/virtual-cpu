import { CpuStatus, MEMORY_SIZE, Op, OPCODE_IDS } from '@vcpu/shared';
import { describe, expect, it } from 'vitest';
import {
  CpuBusyError,
  type CpuObserver,
  createCpu,
  DEFAULT_MAX_INSTRUCTIONS,
  type MemoryReadEvent,
  type MemoryWriteEvent,
  ProgramLoadError,
} from '../cpu.js';
import { asm, image, load, program, reg, runProgram } from './helpers.js';

/** LDI R0, 10; LDI R1, 20; ADD R0, R1; HLT — the ISA doc's example, hand-encoded. */
const ADD_PROGRAM = [0x11, 0x00, 10, 0x11, 0x10, 20, 0x20, 0x01, 0x01];

/** R0 counts down from 5 while R1 accumulates and stores a running sum at 0x80. */
const LOOP_PROGRAM = program(
  asm.ldi(0, 5), // 0x00
  asm.ldi(1, 0), // 0x03
  asm.rr('ADD', 1, 0), // 0x06 loop:
  asm.storeAbs(0x80, 1), // 0x08
  asm.r('DEC', 0), // 0x0b
  asm.jump('JNZ', 0x06), // 0x0d
  asm.hlt(), // 0x0f
);

describe('the ticket example', () => {
  it('executes encoded bytes: R0 = 30, HALTED', () => {
    const cpu = createCpu();
    cpu.loadProgram(ADD_PROGRAM);
    expect(cpu.run()).toEqual({ executed: 4, stopReason: 'halted' });
    expect(reg(cpu.getState(), 0)).toBe(30);
    expect(cpu.getState().status).toBe(CpuStatus.HALTED);
  });
});

describe('reset state', () => {
  it('a new CPU is reset with zero memory', () => {
    const state = createCpu().getState();
    expect(state).toEqual({
      registers: [0, 0, 0, 0, 0, 0, 0, 0],
      pc: 0,
      sp: 0xff,
      sd: 0,
      flags: 0,
      ir: null,
      status: CpuStatus.READY,
      fault: null,
      memory: new Array<number>(MEMORY_SIZE).fill(0),
    });
  });

  it('reset() restores the loaded image, registers, metrics and trace', () => {
    const cpu = load(LOOP_PROGRAM);
    const initial = cpu.getState();
    const initialMetrics = cpu.getMetrics();
    cpu.run();
    expect(cpu.getState().memory[0x80]).toBe(15);
    cpu.reset();
    expect(cpu.getState()).toEqual(initial);
    expect(cpu.getMetrics()).toEqual(initialMetrics);
    expect(cpu.getExecutionTrace()).toEqual([]);
  });

  it('reset() undoes self-modifying code', () => {
    // STORE overwrites the LDI immediate at 0x05 before it runs.
    const code = program(asm.ldi(1, 0x44), asm.ldi(0, 0x11), asm.hlt());
    const selfModifying = program(asm.ldi(2, 0x99), asm.storeAbs(0x0b, 2), code);
    const cpu = runProgram(selfModifying);
    expect(reg(cpu.getState(), 0)).toBe(0x99);
    cpu.reset();
    expect(cpu.getState().memory[0x0b]).toBe(0x11);
    cpu.run();
    expect(reg(cpu.getState(), 0)).toBe(0x99);
  });
});

describe('loadProgram', () => {
  it('accepts a byte array, a Uint8Array and an image with an origin', () => {
    const fromArray = createCpu();
    fromArray.loadProgram(ADD_PROGRAM);
    const fromTyped = createCpu();
    fromTyped.loadProgram(Uint8Array.from(ADD_PROGRAM));
    expect(fromTyped.getState()).toEqual(fromArray.getState());

    const withOrigin = createCpu();
    withOrigin.loadProgram({ origin: 0x80, bytes: [1, 2, 3] });
    expect(withOrigin.getState().memory.slice(0x7f, 0x84)).toEqual([0, 1, 2, 3, 0]);
    expect(withOrigin.getState().pc).toBe(0);
  });

  it('zero-fills memory left over from a previous program', () => {
    const cpu = load(new Array<number>(MEMORY_SIZE).fill(0xee));
    cpu.loadProgram([Op.HLT]);
    expect(cpu.getState().memory.slice(0, 3)).toEqual([Op.HLT, 0, 0]);
  });

  it('accepts exactly 256 bytes', () => {
    expect(() => {
      createCpu().loadProgram(new Array<number>(MEMORY_SIZE).fill(1));
    }).not.toThrow();
  });

  it.each([
    { name: '257 bytes', input: new Array<number>(MEMORY_SIZE + 1).fill(0) },
    { name: 'a byte of 256', input: [0, 256] },
    { name: 'a negative byte', input: [-1] },
    { name: 'a fractional byte', input: [1.5] },
    { name: 'an origin that overflows', input: { origin: 0xff, bytes: [1, 2] } },
    { name: 'an origin of 256', input: { origin: 256, bytes: [] } },
  ])('throws ProgramLoadError for $name', ({ input }) => {
    const cpu = createCpu();
    expect(() => {
      cpu.loadProgram(input);
    }).toThrow(ProgramLoadError);
  });

  it('names the problem and leaves the CPU unchanged when it throws', () => {
    const cpu = load(ADD_PROGRAM);
    cpu.step();
    const before = cpu.getState();
    let error: unknown;
    try {
      cpu.loadProgram([0, 300]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProgramLoadError);
    expect((error as ProgramLoadError).issues[0]).toMatch(/^bytes\.1: /);
    expect((error as ProgramLoadError).name).toBe('ProgramLoadError');
    expect(cpu.getState()).toEqual(before);

    expect(() => {
      cpu.loadProgram(null as unknown as number[]);
    }).toThrow(ProgramLoadError);
  });
});

describe('run()', () => {
  it('stops at the instruction limit without faulting and can continue', () => {
    const cpu = load(LOOP_PROGRAM);
    expect(cpu.run({ maxInstructions: 4 })).toEqual({ executed: 4, stopReason: 'limit' });
    expect(cpu.getState().status).toBe(CpuStatus.PAUSED);
    expect(cpu.getMetrics().instructions).toBe(4);
    expect(cpu.run()).toMatchObject({ stopReason: 'halted' });
    expect(cpu.getState().memory[0x80]).toBe(15);
  });

  it('maxInstructions 0 executes nothing', () => {
    const cpu = load(ADD_PROGRAM);
    expect(cpu.run({ maxInstructions: 0 })).toEqual({ executed: 0, stopReason: 'limit' });
    expect(cpu.getState().pc).toBe(0);
  });

  it('defaults to DEFAULT_MAX_INSTRUCTIONS, so an endless loop returns', () => {
    const cpu = load(asm.jump('JMP', 0x00), { traceCapacity: 0 });
    expect(cpu.run()).toEqual({ executed: DEFAULT_MAX_INSTRUCTIONS, stopReason: 'limit' });
  }, 30_000);

  it.each([-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])(
    'rejects maxInstructions %s',
    (maxInstructions) => {
      expect(() => load(ADD_PROGRAM).run({ maxInstructions })).toThrow(RangeError);
    },
  );

  it('on a HALTED CPU returns immediately', () => {
    const cpu = runProgram(ADD_PROGRAM);
    expect(cpu.run()).toEqual({ executed: 0, stopReason: 'halted' });
    expect(cpu.step()).toEqual({ status: CpuStatus.HALTED, entry: null });
  });

  it('shows status RUNNING to observers during the run', () => {
    const cpu = load(ADD_PROGRAM);
    const seen = new Set<string>();
    cpu.setObserver({
      beforeExecute: () => {
        seen.add(cpu.getState().status);
        return undefined;
      },
    });
    cpu.run();
    expect([...seen]).toEqual([CpuStatus.RUNNING]);
  });
});

describe('step()', () => {
  it('leaves READY and PAUSED as they are', () => {
    const cpu = load(LOOP_PROGRAM);
    expect(cpu.step().status).toBe(CpuStatus.READY);
    cpu.run({ maxInstructions: 1 });
    expect(cpu.step().status).toBe(CpuStatus.PAUSED);
  });
});

describe('pause()', () => {
  it('called from an observer stops run() after the current step', () => {
    const cpu = load(LOOP_PROGRAM);
    let count = 0;
    cpu.setObserver({
      beforeExecute: () => {
        count += 1;
        if (count === 3) {
          cpu.pause();
        }
        return undefined;
      },
    });
    expect(cpu.run()).toEqual({ executed: 3, stopReason: 'paused' });
    expect(cpu.getState().status).toBe(CpuStatus.PAUSED);
    // The request does not leak into the next run.
    cpu.setObserver(null);
    expect(cpu.run()).toMatchObject({ stopReason: 'halted' });
  });

  it('outside a run does nothing', () => {
    const cpu = load(ADD_PROGRAM);
    cpu.pause();
    expect(cpu.getState().status).toBe(CpuStatus.READY);
    expect(cpu.run()).toMatchObject({ stopReason: 'halted' });
  });
});

describe('CpuObserver', () => {
  it('beforeExecute sees every PC; "break" stops run() before that instruction', () => {
    const seen: number[] = [];
    const cpu = load(ADD_PROGRAM, {
      observer: {
        beforeExecute: ({ pc }) => {
          seen.push(pc);
          return pc === 0x06 ? 'break' : undefined;
        },
      },
    });
    expect(cpu.run()).toEqual({ executed: 2, stopReason: 'breakpoint' });
    expect(cpu.getState()).toMatchObject({ pc: 0x06, status: CpuStatus.PAUSED });
    expect(reg(cpu.getState(), 0)).toBe(10);

    // step() always executes, even at a breakpoint, so a debugger can continue past it.
    expect(cpu.step().entry?.instruction?.id).toBe('ADD');
    expect(cpu.run()).toMatchObject({ stopReason: 'halted' });
    expect(seen).toEqual([0x00, 0x03, 0x06, 0x06, 0x08]);
  });

  it('reports data reads and writes with the accessing instruction, never fetches', () => {
    const reads: MemoryReadEvent[] = [];
    const writes: MemoryWriteEvent[] = [];
    const cpu = load(
      program(
        asm.ldi(0, 0x42),
        asm.storeAbs(0x90, 0), // 0x03
        asm.loadAbs(1, 0x90), // 0x06
        asm.call(0x10), // 0x09
        asm.hlt(), // 0x0b
        [0, 0, 0, 0],
        asm.ret(), // 0x10
      ),
      {
        observer: {
          onMemoryRead: (event) => {
            reads.push(event);
            return undefined;
          },
          onMemoryWrite: (event) => {
            writes.push(event);
            return undefined;
          },
        },
      },
    );
    cpu.run();
    expect(writes).toEqual([
      { pc: 0x03, address: 0x90, value: 0x42, previous: 0 },
      { pc: 0x09, address: 0xff, value: 0x0b, previous: 0 },
    ]);
    expect(reads).toEqual([
      { pc: 0x06, address: 0x90, value: 0x42 },
      { pc: 0x10, address: 0xff, value: 0x0b },
    ]);
  });

  it('a memory hook returning "break" stops run() after the accessing instruction (watchpoint)', () => {
    const onWrite = load(LOOP_PROGRAM, {
      observer: { onMemoryWrite: ({ value }) => (value === 9 ? 'break' : undefined) },
    });
    expect(onWrite.run()).toEqual({ executed: 8, stopReason: 'watchpoint' });
    expect(onWrite.getState()).toMatchObject({ pc: 0x0b, status: CpuStatus.PAUSED });

    const onRead = load(program(asm.loadAbs(0, 0x80), asm.nop(), asm.hlt()), {
      observer: { onMemoryRead: () => 'break' },
    });
    expect(onRead.run()).toEqual({ executed: 1, stopReason: 'watchpoint' });
    // A watchpoint hit during step() does not leak into the next run().
    onRead.reset();
    onRead.step();
    onRead.setObserver(null);
    expect(onRead.run()).toMatchObject({ stopReason: 'halted' });
  });

  it('a fault on the same step takes priority over a watchpoint', () => {
    // STORE at 0xFD writes (watchpoint) and then raises the post-commit PC_OVERFLOW.
    const cpu = load(image({ 0x00: asm.jump('JMP', 0xfd), 0xfd: asm.storeAbs(0x80, 0) }), {
      observer: { onMemoryWrite: () => 'break' },
    });
    expect(cpu.run()).toEqual({ executed: 2, stopReason: 'faulted' });
  });

  it('keeps `this` for class-based observers', () => {
    class Counter implements CpuObserver {
      count = 0;
      beforeExecute(): undefined {
        this.count += 1;
        return undefined;
      }
    }
    const counter = new Counter();
    runProgram(ADD_PROGRAM, { observer: counter });
    expect(counter.count).toBe(4);
  });

  it('callbacks cannot re-enter the CPU, and the CPU recovers afterwards', () => {
    for (const reenter of ['step', 'run', 'reset', 'loadProgram'] as const) {
      const cpu = load(ADD_PROGRAM);
      cpu.setObserver({
        beforeExecute: () => {
          if (reenter === 'loadProgram') {
            cpu.loadProgram([]);
          } else {
            cpu[reenter]();
          }
          return undefined;
        },
      });
      expect(() => cpu.run()).toThrow(CpuBusyError);
      expect(() => cpu.step()).toThrow(CpuBusyError);
      expect(cpu.getState().status).toBe(CpuStatus.PAUSED);
      cpu.setObserver(null);
      expect(cpu.run()).toMatchObject({ stopReason: 'halted' });
    }
  });
});

describe('getState()', () => {
  it('returns a deep-frozen, serializable snapshot that does not track later changes', () => {
    const cpu = load(ADD_PROGRAM);
    cpu.step();
    const state = cpu.getState();
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.registers)).toBe(true);
    expect(Object.isFrozen(state.memory)).toBe(true);
    expect(Object.isFrozen(state.ir)).toBe(true);
    expect(() => {
      (state.registers as number[])[0] = 1;
    }).toThrow(TypeError);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    cpu.run();
    expect(reg(state, 0)).toBe(10);
  });

  it('IR holds the last retired instruction', () => {
    const cpu = load(ADD_PROGRAM);
    cpu.step();
    expect(cpu.getState().ir).toMatchObject({ id: 'LDI', address: 0, bytes: [0x11, 0x00, 10] });
  });
});

describe('trace', () => {
  it('records one entry per step with sequence numbers, and every entry is frozen', () => {
    const cpu = runProgram(LOOP_PROGRAM);
    const trace = cpu.getExecutionTrace();
    expect(trace).toHaveLength(cpu.getMetrics().instructions);
    expect(trace.map((e) => e.sequence)).toEqual(trace.map((_, i) => i));
    expect(trace.every((e) => Object.isFrozen(e) && Object.isFrozen(e.registerChanges))).toBe(true);
    expect(trace[2]).toMatchObject({
      pc: 0x06,
      nextPc: 0x08,
      bytes: asm.rr('ADD', 1, 0),
      registerChanges: [{ register: 'R1', before: 0, after: 5 }],
      flagsBefore: 0,
      flagsAfter: 0,
      flagChanges: [],
      branchTaken: null,
      controlTransferred: false,
      cycles: 3,
      status: CpuStatus.RUNNING,
      fault: null,
    });
    const lastDec = trace.findLast((e) => e.instruction?.id === 'DEC');
    expect(lastDec?.flagChanges).toEqual([{ flag: 'Z', before: false, after: true }]);
    expect(trace.at(-1)).toMatchObject({ status: CpuStatus.HALTED, nextPc: 0x0f });
  });

  it('keeps only the newest traceCapacity entries', () => {
    const cpu = runProgram(LOOP_PROGRAM, { traceCapacity: 4 });
    const trace = cpu.getExecutionTrace();
    expect(trace).toHaveLength(4);
    expect(trace.at(-1)?.instruction?.id).toBe('HLT');
    expect(trace[0]?.sequence).toBe(cpu.getMetrics().instructions - 4);
  });

  it('traceCapacity 0 disables the trace; step() still returns its entry', () => {
    const cpu = load(LOOP_PROGRAM, { traceCapacity: 0 });
    expect(cpu.step().entry?.instruction?.id).toBe('LDI');
    cpu.run();
    expect(cpu.getExecutionTrace()).toEqual([]);
    expect(cpu.getState().memory[0x80]).toBe(15);
  });

  it('a fault with the trace disabled is still recorded in the state', () => {
    const cpu = load(program(asm.nop(), asm.pop(0)), { traceCapacity: 0 });
    expect(cpu.run()).toEqual({ executed: 2, stopReason: 'faulted' });
    expect(cpu.getState().fault).toMatchObject({ code: 'STACK_UNDERFLOW', pc: 1 });
    expect(cpu.getExecutionTrace()).toEqual([]);
  });

  it('rejects an invalid traceCapacity', () => {
    expect(() => createCpu({ traceCapacity: -5 })).toThrow(RangeError);
  });
});

describe('metrics', () => {
  it('counts instructions, opcodes, data accesses, fetches, branches and estimated cycles', () => {
    const cpu = runProgram(LOOP_PROGRAM);
    const metrics = cpu.getMetrics();
    // LDI ×2, then 5 × (ADD, STORE, DEC, JNZ), then HLT.
    expect(metrics.instructions).toBe(2 + 5 * 4 + 1);
    expect(metrics.opcodeCounts).toMatchObject({
      LDI: 2,
      ADD: 5,
      STORE_ABS: 5,
      DEC: 5,
      JNZ: 5,
      HLT: 1,
    });
    expect(Object.keys(metrics.opcodeCounts).sort()).toEqual([...OPCODE_IDS].sort());
    expect(metrics.memoryReads).toBe(0);
    expect(metrics.memoryWrites).toBe(5);
    expect(metrics.fetchedBytes).toBe(2 * 3 + 5 * (2 + 3 + 2 + 2) + 1);
    expect(metrics).toMatchObject({ branchesTaken: 4, branchesNotTaken: 1 });
    // LDI 4, ADD 3, STORE 5, DEC 3, JNZ 3 (+1 when taken), HLT 2.
    expect(metrics.estimatedCycles).toBe(2 * 4 + 5 * (3 + 5 + 3 + 3) + 4 + 2);
    const traced = cpu.getExecutionTrace().reduce((sum, e) => sum + e.cycles, 0);
    expect(traced).toBe(metrics.estimatedCycles);
  });

  it('counts the same with the trace disabled', () => {
    const withReads = program(asm.call(0x04), asm.hlt(), [0], asm.loadAbs(0, 0x80), asm.ret());
    for (const code of [LOOP_PROGRAM, withReads]) {
      const traced = runProgram(code).getMetrics();
      const untraced = runProgram(code, { traceCapacity: 0 }).getMetrics();
      expect(untraced).toEqual(traced);
    }
    expect(runProgram(withReads, { traceCapacity: 0 }).getMetrics().memoryReads).toBe(2);
  });

  it('returns frozen snapshots', () => {
    const metrics = runProgram(ADD_PROGRAM).getMetrics();
    expect(Object.isFrozen(metrics)).toBe(true);
    expect(Object.isFrozen(metrics.opcodeCounts)).toBe(true);
  });
});

describe('determinism', () => {
  const WORKLOAD = image({
    0x00: program(
      asm.ldi(0, 7),
      asm.ldi(1, 13),
      asm.ldi(2, 0x80),
      asm.rr('MUL', 1, 0), // loop at 0x09
      asm.storeInd(2, 1),
      asm.r('INC', 2),
      asm.push(1),
      asm.call(0x40),
      asm.pop(4),
      asm.r('DEC', 0),
      asm.jump('JNZ', 0x09),
      asm.hlt(),
    ),
    0x40: program(
      asm.mov(3, 1),
      asm.rr('XOR', 3, 0),
      asm.r('SHR', 3),
      asm.rr('ADD', 5, 3),
      asm.ret(),
    ),
  });

  it('the same program on two CPUs ends in identical state, metrics and trace', () => {
    const first = runProgram(WORKLOAD);
    const second = runProgram(WORKLOAD);
    expect(first.getState().status).toBe(CpuStatus.HALTED);
    expect(second.getState()).toEqual(first.getState());
    expect(second.getMetrics()).toEqual(first.getMetrics());
    expect(second.getExecutionTrace()).toEqual(first.getExecutionTrace());
  });

  it('reset() and rerun reproduces the run; stepping equals running', () => {
    const cpu = runProgram(WORKLOAD);
    const state = cpu.getState();
    const trace = cpu.getExecutionTrace();
    cpu.reset();
    cpu.run();
    expect(cpu.getState()).toEqual(state);
    expect(cpu.getExecutionTrace()).toEqual(trace);

    const stepped = load(WORKLOAD);
    while (stepped.step().entry !== null) {
      // keep stepping until HALTED
    }
    expect(stepped.getState()).toEqual(state);
  });
});
