import type { TraceEntry } from '@vcpu/cpu-core';
import { instructionText } from '@vcpu/debugger';
import { CpuStatus } from '@vcpu/shared';
import { hex, hexByte, hexBytes } from '../../lib/format';

/** What one item in the Changes column describes; it picks the colour. */
export type ChangeKind = 'register' | 'memory' | 'flag' | 'branch' | 'halt' | 'fault';

export interface Change {
  readonly kind: ChangeKind;
  readonly text: string;
}

/**
 * The Changes column for one step: registers (`R4 08→05`, SP included, SD left out as SP already
 * shows the push or pop), memory writes (`mem[0x85] 00→05`), flags (`Z 0→1`), then control flow
 * (`branch taken → 0x0C`, `not taken`, `jmp → 0x00`), a halt or a fault.
 */
export function describeChanges(entry: TraceEntry): readonly Change[] {
  const changes: Change[] = [];
  for (const change of entry.registerChanges) {
    if (change.register === 'SD') continue;
    changes.push({
      kind: 'register',
      text: `${change.register} ${hexByte(change.before)}→${hexByte(change.after)}`,
    });
  }
  for (const write of entry.memoryWrites) {
    changes.push({
      kind: 'memory',
      text: `mem[${hex(write.address)}] ${hexByte(write.before)}→${hexByte(write.after)}`,
    });
  }
  for (const change of entry.flagChanges) {
    changes.push({
      kind: 'flag',
      text: `${change.flag} ${change.before ? '1' : '0'}→${change.after ? '1' : '0'}`,
    });
  }
  if (entry.branchTaken === true) {
    changes.push({ kind: 'branch', text: `branch taken → ${hex(entry.nextPc)}` });
  } else if (entry.branchTaken === false) {
    changes.push({ kind: 'branch', text: 'not taken' });
  } else if (entry.controlTransferred && entry.instruction !== null) {
    changes.push({
      kind: 'branch',
      text: `${entry.instruction.mnemonic.toLowerCase()} → ${hex(entry.nextPc)}`,
    });
  }
  if (entry.fault !== null) {
    changes.push({ kind: 'fault', text: `fault ${entry.fault.code}` });
  } else if (entry.status === CpuStatus.HALTED) {
    changes.push({ kind: 'halt', text: 'halted' });
  }
  return changes;
}

export const CHANGE_TONE: Record<ChangeKind, string> = {
  register: 'text-amber',
  memory: 'text-orange',
  flag: 'text-accent-soft',
  branch: 'text-ok',
  halt: 'text-violet',
  fault: 'text-danger',
};

const textCache = new WeakMap<TraceEntry, string>();

/** The step's instruction as assembly, e.g. `JNZ 0x0C`; cached, as trace entries never change. */
export function entryText(entry: TraceEntry): string {
  let text = textCache.get(entry);
  if (text === undefined) {
    text = instructionText(entry.bytes);
    textCache.set(entry, text);
  }
  return text;
}

/** One trace-log line: step, address, bytes, instruction and changes in fixed columns. */
export function traceLine(entry: TraceEntry): string {
  const changes = describeChanges(entry)
    .map((change) => change.text)
    .join(', ');
  return [
    `#${String(entry.sequence)}`.padEnd(7),
    hex(entry.pc).padEnd(6),
    hexBytes(entry.bytes).padEnd(10),
    entryText(entry).padEnd(18),
    changes,
  ]
    .join('')
    .trimEnd();
}
