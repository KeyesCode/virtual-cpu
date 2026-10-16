import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { assemble, type AssembleResult, type SourceMapEntry } from '@vcpu/assembler';
import { MEMORY_SIZE } from '@vcpu/shared';
import { formatDiagnostics } from './format/diagnostics.js';
import { type CliIo, println, resolvePath, UsageError } from './io.js';

export type ProgramKind = 'asm' | 'bin';

/** A program ready to load into the CPU, from source or from raw bytes. */
export interface LoadedProgram {
  /** The path as the user typed it, for messages. */
  readonly file: string;
  readonly kind: ProgramKind;
  /** Bytes loaded at 0x00: the whole 256-byte image for source, the file's bytes for `.bin`. */
  readonly bytes: Uint8Array;
  /** The assembly, for `.asm` input only. */
  readonly assembly: AssembleResult | null;
  readonly sourceMap: ReadonlyMap<number, SourceMapEntry> | null;
}

/** The source did not assemble; its diagnostics were already printed to stderr. */
export class AssemblyFailed extends Error {
  override readonly name = 'AssemblyFailed';
}

/** `.asm` or `.bin`, from the extension; anything else is a usage error. */
export function programKind(file: string, accepted: readonly ProgramKind[]): ProgramKind {
  const extension = extname(file).toLowerCase();
  const kind = accepted.find((k) => `.${k}` === extension);
  if (kind === undefined) {
    const list = accepted.map((k) => `.${k}`).join(' or ');
    throw new UsageError(`${file}: expected a ${list} file`);
  }
  return kind;
}

export function readInput(io: CliIo, file: string): Buffer {
  try {
    return readFileSync(resolvePath(io, file));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = code === 'ENOENT' ? 'no such file' : code === 'EISDIR' ? 'is a directory' : code;
    throw new UsageError(`${file}: cannot read file (${reason ?? 'unknown error'})`);
  }
}

/** Assembles `file`, printing diagnostics to stderr; throws `AssemblyFailed` on any error. */
export function assembleFile(io: CliIo, file: string): { source: string; result: AssembleResult } {
  const source = readInput(io, file).toString('utf8');
  const result = assemble(source);
  if (result.diagnostics.length > 0) {
    println(io.stderr, formatDiagnostics(file, source, result.diagnostics));
  }
  if (!result.ok) {
    const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
    throw new AssemblyFailed(`${file}: ${String(errors)} error${errors === 1 ? '' : 's'}`);
  }
  return { source, result };
}

/** Raw machine code, loaded at 0x00. At most 256 bytes. */
export function readBinary(io: CliIo, file: string): Uint8Array {
  const bytes = new Uint8Array(readInput(io, file));
  if (bytes.length === 0) {
    throw new UsageError(`${file}: the file is empty`);
  }
  if (bytes.length > MEMORY_SIZE) {
    throw new UsageError(
      `${file}: ${String(bytes.length)} bytes does not fit in the ${String(MEMORY_SIZE)}-byte memory`,
    );
  }
  return bytes;
}

export function loadProgram(io: CliIo, file: string): LoadedProgram {
  const kind = programKind(file, ['asm', 'bin']);
  if (kind === 'bin') {
    return { file, kind, bytes: readBinary(io, file), assembly: null, sourceMap: null };
  }
  const { result } = assembleFile(io, file);
  return { file, kind, bytes: result.bytes.image, assembly: result, sourceMap: result.sourceMap };
}

/** The bytes a `.bin` holds for an assembly: address 0x00 through the last emitted byte. */
export function binaryImage(result: AssembleResult): Uint8Array {
  const last = result.bytes.ranges.at(-1);
  return result.bytes.image.slice(0, last === undefined ? 0 : last.end + 1);
}
