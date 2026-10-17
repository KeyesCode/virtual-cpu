import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * GTKWave translate filter files for hardware/rtl/vcpu8/tb/wave/: each maps a signal's value,
 * written in hex as GTKWave shows it, to a name. They are generated from the enums and constants of
 * the RTL packages, so the names in the waveform viewer are the RTL's own; `wave-check` fails when
 * a committed file no longer matches.
 */

const CORE_DIR = fileURLToPath(new URL('../../../../hardware/rtl/vcpu8/core/', import.meta.url));

/** The committed filter files, by default. */
export const WAVE_FILTERS_DIR = fileURLToPath(
  new URL('../../../../hardware/rtl/vcpu8/tb/wave/', import.meta.url),
);

interface FilterSource {
  /** The file in tb/wave/. */
  readonly file: string;
  /** The package under core/. */
  readonly pkg: string;
  /** `typedef enum … } <name>;` to read the members of, or null for package-level constants. */
  readonly enumType: string | null;
  /** The prefix the constants share; it is dropped from the names. */
  readonly prefix: string;
}

const FILTER_SOURCES: readonly FilterSource[] = [
  { file: 'fsm_state.txt', pkg: 'vcpu8_types_pkg.sv', enumType: 'fsm_state_t', prefix: 'FSM_' },
  { file: 'alu_op.txt', pkg: 'vcpu8_types_pkg.sv', enumType: 'alu_op_t', prefix: 'ALU_' },
  { file: 'status.txt', pkg: 'vcpu8_isa_pkg.sv', enumType: null, prefix: 'STATUS_' },
  { file: 'fault_code.txt', pkg: 'vcpu8_isa_pkg.sv', enumType: null, prefix: 'FAULT_' },
];

/** `PREFIX_NAME = <width>'d<value>` pairs in `text`, as [value, NAME] sorted by value. */
function namedValues(text: string, prefix: string): [number, string][] {
  const pattern = new RegExp(`\\b${prefix}(\\w+)\\s*=\\s*\\d+'d(\\d+)`, 'g');
  return [...text.matchAll(pattern)]
    .map((match): [number, string] => [Number(match[2]), match[1] ?? ''])
    .sort((a, b) => a[0] - b[0]);
}

/** The names of an enum or a constant family, by value, read from the package source. */
export function readNames(source: FilterSource, coreDir = CORE_DIR): [number, string][] {
  let text = readFileSync(join(coreDir, source.pkg), 'utf8');
  if (source.enumType !== null) {
    const block = new RegExp(`typedef enum[^{]*\\{([^}]*)\\}\\s*${source.enumType}\\s*;`).exec(
      text,
    );
    if (block === null) throw new Error(`${source.pkg} has no enum ${source.enumType}`);
    text = block[1] ?? '';
  }
  const names = namedValues(text, source.prefix);
  if (names.length === 0) throw new Error(`${source.pkg} has no ${source.prefix}* values`);
  return names;
}

/** Every filter file's name and contents: one `<hex value> <NAME>` line per value. */
export function renderWaveFilters(coreDir = CORE_DIR): { file: string; text: string }[] {
  return FILTER_SOURCES.map((source) => ({
    file: source.file,
    text: readNames(source, coreDir)
      .map(([value, name]) => `${value.toString(16).toUpperCase()} ${name}\n`)
      .join(''),
  }));
}

/** The name `file`'s filter gives `value`, for tables; the hex value when it has none. */
export function filterName(file: string, value: number, coreDir = CORE_DIR): string {
  const source = FILTER_SOURCES.find((candidate) => candidate.file === file);
  if (source === undefined) throw new Error(`no filter ${file}`);
  const found = readNames(source, coreDir).find(([v]) => v === value);
  return found === undefined ? value.toString(16).toUpperCase() : found[1];
}
