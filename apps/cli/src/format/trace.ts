import type { SourceMapEntry } from '@vcpu/assembler';
import type { TraceEntry } from '@vcpu/cpu-core';
import { instructionText } from '@vcpu/debugger';
import { bytesHex, hex } from './hex.js';

/** What one step changed, e.g. `R2 0x80→0x81  Z 0→1  [0x80] 0x00→0x01  branch taken`. */
export function traceEffects(entry: TraceEntry): string {
  const parts = [
    ...entry.registerChanges.map(
      (c) =>
        `${c.register} ${c.register === 'SD' ? String(c.before) : hex(c.before)}→${c.register === 'SD' ? String(c.after) : hex(c.after)}`,
    ),
    ...entry.flagChanges.map((c) => `${c.flag} ${c.before ? '1' : '0'}→${c.after ? '1' : '0'}`),
    ...entry.memoryReads.map((r) => `read [${hex(r.address)}]=${hex(r.value)}`),
    ...entry.memoryWrites.map((w) => `[${hex(w.address)}] ${hex(w.before)}→${hex(w.after)}`),
  ];
  if (entry.branchTaken !== null) parts.push(entry.branchTaken ? 'branch taken' : 'not taken');
  if (entry.fault !== null) parts.push(`FAULT ${entry.fault.code}: ${entry.fault.detail}`);
  else if (entry.status === 'HALTED') parts.push('halted');
  return parts.join('  ');
}

/**
 * One trace line: step number, address, bytes, assembly, then its effects.
 *
 *     #4     0x0C  41 20     STORE [R2], R0      [0x80] 0x00→0x00
 */
export function formatTraceEntry(entry: TraceEntry): string {
  const step = `#${String(entry.sequence)}`.padEnd(7);
  const text = instructionText(entry.bytes).padEnd(20);
  return `${step}${hex(entry.pc)}  ${bytesHex(entry.bytes).padEnd(10)}${text}${traceEffects(entry)}`.trimEnd();
}

/** `line 21: STORE [R2], R0`, or '' without a source map entry. */
export function formatSource(source: SourceMapEntry | null): string {
  return source === null ? '' : `line ${String(source.line)}: ${source.text}`;
}
