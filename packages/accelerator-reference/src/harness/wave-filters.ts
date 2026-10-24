import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HW_DIR } from './report.js';

/**
 * GTKWave translate filter files for hardware/accelerators/matmul/tb/wave/: each maps a signal's
 * value, written in hex as GTKWave shows it, to a name. They are generated from the enums of
 * rtl/matmul_pkg.sv by `gen-wave-filters`, so the names in the waveform viewer are the RTL's own;
 * a Vitest test and `wave-check` fail when a committed file no longer matches.
 */

/** The matmul_pkg source the filters are read from, by default. */
export const MATMUL_PKG = join(HW_DIR, 'rtl', 'matmul_pkg.sv');

/** The committed filter files (and the rest of the waveform setup), by default. */
export const WAVE_DIR = join(HW_DIR, 'tb', 'wave');

interface FilterSource {
  /** The file in tb/wave/. */
  readonly file: string;
  /** `typedef enum … } <name>;` in matmul_pkg to read the members of. */
  readonly enumType: string;
}

const FILTER_SOURCES: readonly FilterSource[] = [
  { file: 'ctrl_state.txt', enumType: 'ctrl_state_t' },
  { file: 'error_code.txt', enumType: 'error_code_t' },
];

/** The filter files `renderWaveFilters` writes. */
export const WAVE_FILTER_FILES: readonly string[] = FILTER_SOURCES.map((source) => source.file);

/** The members of an enum of the package source, as [value, NAME] sorted by value. */
function enumNames(pkg: string, enumType: string): [number, string][] {
  const text = readFileSync(pkg, 'utf8');
  const block = new RegExp(`typedef enum[^{]*\\{([^}]*)\\}\\s*${enumType}\\s*;`).exec(text);
  if (block === null) throw new Error(`${pkg} has no enum ${enumType}`);
  const names = [...(block[1] ?? '').matchAll(/\b([A-Z][A-Z0-9_]*)\s*=\s*\d+'d(\d+)/g)]
    .map((match): [number, string] => [Number(match[2]), match[1] ?? ''])
    .sort((a, b) => a[0] - b[0]);
  if (names.length === 0)
    throw new Error(`${pkg}: enum ${enumType} has no NAME = <w>'d<n> members`);
  return names;
}

/** Every filter file's name and contents: one `<hex value> <NAME>` line per enum member. */
export function renderWaveFilters(pkg = MATMUL_PKG): { file: string; text: string }[] {
  return FILTER_SOURCES.map((source) => ({
    file: source.file,
    text: enumNames(pkg, source.enumType)
      .map(([value, name]) => `${value.toString(16).toUpperCase()} ${name}\n`)
      .join(''),
  }));
}

/** The name `file`'s filter gives `value`, for tables; the hex value when it has none. */
export function filterName(file: string, value: number, pkg = MATMUL_PKG): string {
  const source = FILTER_SOURCES.find((candidate) => candidate.file === file);
  if (source === undefined) throw new Error(`no filter ${file}`);
  if (Number.isNaN(value)) return 'x';
  const found = enumNames(pkg, source.enumType).find(([v]) => v === value);
  return found === undefined ? value.toString(16).toUpperCase() : found[1];
}
