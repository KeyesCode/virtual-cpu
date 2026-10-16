import type { TraceEntry } from '@vcpu/cpu-core';
import { FLAG_MASKS, opcodeById, type OperandKind } from '@vcpu/shared';
import { hex, hexByte, hexBytes } from './format';

export const STAGES = ['FETCH', 'DECODE', 'EXECUTE', 'WRITEBACK'] as const;
export type Stage = (typeof STAGES)[number];

const OPERAND_LABEL: Record<OperandKind, string> = {
  reg: 'reg',
  regIndirect: 'reg-ind',
  imm8: 'imm8',
  addr8: 'addr8',
};

/**
 * One caption per stage for an executed instruction, read off its trace entry. This is a teaching
 * view of what the emulator did, not a model of hardware pipeline stages.
 */
export function describeStages(entry: TraceEntry): Record<Stage, string> {
  const fetch = `mem[${hex(entry.pc)}] → ${hexBytes(entry.bytes)}`;
  const instruction = entry.instruction;
  if (instruction === null || entry.fault !== null) {
    const code = entry.fault?.code ?? 'INVALID_OPCODE';
    return {
      FETCH: fetch,
      DECODE: instruction === null ? `fault: ${code}` : instruction.mnemonic,
      EXECUTE: instruction === null ? '—' : `fault: ${code}`,
      WRITEBACK: entry.cycles > 0 ? writeback(entry) : 'nothing retired',
    };
  }
  const info = opcodeById[instruction.id];
  const kinds = info.operands.map((operand) => OPERAND_LABEL[operand.kind]);
  return {
    FETCH: fetch,
    DECODE: [instruction.mnemonic, kinds.join(', ')].filter(Boolean).join(' '),
    EXECUTE: execute(entry),
    WRITEBACK: writeback(entry),
  };
}

function execute(entry: TraceEntry): string {
  const instruction = entry.instruction;
  if (instruction === null) return '—';
  const info = opcodeById[instruction.id];
  const ptr = info.operands.find((operand) => operand.kind === 'regIndirect');
  const access = entry.memoryWrites[0]?.address ?? entry.memoryReads[0]?.address;
  if (info.controlFlow === 'branch' && info.condition !== null) {
    const flagSet = (entry.flagsBefore & FLAG_MASKS[info.condition.flag]) !== 0;
    return `${info.condition.flag}=${flagSet ? '1' : '0'} → ${entry.branchTaken === true ? 'taken' : 'not taken'}`;
  }
  switch (info.controlFlow) {
    case 'halt':
      return 'halt';
    case 'jump':
      return `target = ${hex(entry.nextPc)}`;
    case 'call':
    case 'return':
      return `SP ${hex(spBefore(entry))} → ${hex(spAfter(entry))}`;
    default:
      break;
  }
  if (info.category === 'stack') return `SP ${hex(spBefore(entry))} → ${hex(spAfter(entry))}`;
  if (ptr !== undefined && access !== undefined) {
    const register = ptr.field === 'a' ? instruction.a : instruction.b;
    return `addr = R${String(register)} = ${hex(access)}`;
  }
  if (access !== undefined) return `addr = ${hex(access)}`;
  if (info.category === 'arithmetic' || info.category === 'logic') {
    const result = entry.registerChanges.find((change) => change.register.startsWith('R'));
    return result === undefined
      ? `ALU ${info.mnemonic} (flags only)`
      : `ALU → ${hex(result.after)}`;
  }
  if (info.id === 'NOP') return 'no operation';
  const moved = entry.registerChanges.find((change) => change.register.startsWith('R'));
  return moved === undefined ? 'value unchanged' : `value ${hex(moved.after)}`;
}

function writeback(entry: TraceEntry): string {
  const parts: string[] = [];
  for (const write of entry.memoryWrites) {
    parts.push(`mem[${hex(write.address)}] ← ${hexByte(write.after)}`);
  }
  for (const change of entry.registerChanges) {
    if (change.register === 'SD') continue;
    parts.push(`${change.register} ← ${hexByte(change.after)}`);
  }
  if (entry.controlTransferred) parts.push(`PC ← ${hex(entry.nextPc)}`);
  if (parts.length === 0) {
    return entry.flagChanges.length > 0
      ? `flags ${entry.flagChanges.map((f) => `${f.flag}=${f.after ? '1' : '0'}`).join(' ')}`
      : 'no change';
  }
  return parts.slice(0, 2).join(', ') + (parts.length > 2 ? ' …' : '');
}

function spBefore(entry: TraceEntry): number {
  return entry.registerChanges.find((change) => change.register === 'SP')?.before ?? 0xff;
}

function spAfter(entry: TraceEntry): number {
  return entry.registerChanges.find((change) => change.register === 'SP')?.after ?? spBefore(entry);
}
