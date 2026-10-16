/** Workspace package name. */
export const PACKAGE_NAME = '@vcpu/assembler';

export {
  assemble,
  AssembleOptionsSchema,
  type AssembleOptions,
  type AssembleResult,
} from './assembler.js';
export {
  formatDiagnostic,
  MESSAGES,
  type Diagnostic,
  type DiagnosticCode,
  type DiagnosticSeverity,
  type SourceLocation,
  type SourceSpan,
} from './diagnostics.js';
export {
  disassemble,
  DisassembleOptionsSchema,
  labelsFromSymbols,
  toAssemblySource,
  type DataReason,
  type DisassembleOptions,
  type DisassemblyLine,
} from './disassembler.js';
export { type AssemblerSymbol, type SymbolKind } from './pass1.js';
export { type AddressRange, type AssembledImage, type SourceMapEntry } from './pass2.js';
