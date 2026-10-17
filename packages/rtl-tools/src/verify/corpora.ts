import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble, formatDiagnostic } from '@vcpu/assembler';
import { ExpectationSchema, FixtureSchemaV1, parseMemoryHex } from '@vcpu/shared';
import { z } from 'zod';
import { generateProgram } from '../random/generator.js';

/** The repository root; case origins are written relative to it. */
export const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
/** hardware/rtl/vcpu8, where the make targets run and build/ lives. */
export const HW_DIR = join(REPO, 'hardware', 'rtl', 'vcpu8');

/** The corpora, in the order `verify` runs them. */
export const CORPORA = ['fixtures', 'examples', 'programs', 'regressions', 'random'] as const;
export type Corpus = (typeof CORPORA)[number];

export const CORPUS_DIRS = {
  fixtures: join(REPO, 'fixtures', 'v1'),
  examples: join(REPO, 'examples'),
  programs: join(HW_DIR, 'tb', 'programs'),
  regressions: join(HW_DIR, 'tb', 'regressions'),
} as const satisfies Record<Exclude<Corpus, 'random'>, string>;

/** Step limit of a directed program without a `; max-steps: N` header line. */
export const DEFAULT_PROGRAM_MAX_STEPS = 10_000;

/** One program to run on both CPUs. */
export interface VerifyCase {
  /** `<corpus>/<name>`, unique across corpora. */
  readonly name: string;
  readonly corpus: Corpus;
  readonly image: readonly number[];
  /** Applied to the reference and the RTL alike. */
  readonly maxSteps: number;
  /** Random programs only. */
  readonly seed: number | null;
  /** The random program's shape, if any. */
  readonly shape: string | null;
  /** The assembly source, when there is one. */
  readonly source: string | null;
  /** The file it came from (relative to the repository root), or the generator call. */
  readonly origin: string;
}

/** A case not built yet: `load` assembles or generates it and throws if it cannot. */
export interface PendingCase {
  readonly name: string;
  readonly corpus: Corpus;
  load(): VerifyCase;
}

/** The format of `case.json` in a saved failure or a committed regression. */
export const CASE_FORMAT = 'vcpu8-verify-case/1';
export const CaseFileSchema = z.object({
  format: z.literal(CASE_FORMAT),
  name: z.string(),
  corpus: z.enum(CORPORA),
  seed: z.number().int().nullable(),
  shape: z.string().nullable(),
  maxSteps: z.number().int().min(1),
  origin: z.string(),
  /** Saved failures only: the runner that failed, so a replay uses the same (mutant) RTL. */
  sim: z.string().optional(),
  /** Regressions only: the case it was promoted from and the runner it first failed on. */
  promotedFrom: z.string().optional(),
  foundOn: z.string().optional(),
  firstMismatch: z.string().optional(),
});
export type CaseFile = z.output<typeof CaseFileSchema>;

function assembleCase(
  name: string,
  corpus: Corpus,
  file: string,
  maxSteps: (source: string) => number,
): VerifyCase {
  const source = readFileSync(file, 'utf8');
  const result = assemble(source);
  if (!result.ok) {
    const errors = result.diagnostics
      .filter((d) => d.severity === 'error')
      .map((d) => formatDiagnostic(d, source));
    throw new Error(`${file} does not assemble:\n${errors.join('\n')}`);
  }
  return {
    name,
    corpus,
    image: Array.from(result.bytes.image),
    maxSteps: maxSteps(source),
    seed: null,
    shape: null,
    source,
    origin: relative(REPO, file),
  };
}

function files(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((file) => file.endsWith(suffix))
    .sort();
}

/** Every committed fixture, run with its own `maxInstructions`. */
export function fixtureCases(dir: string = CORPUS_DIRS.fixtures): PendingCase[] {
  return files(dir, '.json')
    .filter((file) => file !== 'fixture.schema.json')
    .map((file) => {
      const base = file.slice(0, -'.json'.length);
      const name = `fixtures/${base}`;
      return {
        name,
        corpus: 'fixtures',
        load: () => {
          const path = join(dir, file);
          const fixture = FixtureSchemaV1.parse(JSON.parse(readFileSync(path, 'utf8')));
          return {
            name,
            corpus: 'fixtures',
            image: fixture.initial.memory,
            maxSteps: fixture.maxInstructions,
            seed: null,
            shape: null,
            source: fixture.source,
            origin: relative(REPO, path),
          };
        },
      };
    });
}

/** Every `examples/*.asm`, assembled fresh, run with its `.expect.json` `maxInstructions`. */
export function exampleCases(dir: string = CORPUS_DIRS.examples): PendingCase[] {
  return files(dir, '.asm').map((file) => {
    const base = file.slice(0, -'.asm'.length);
    const name = `examples/${base}`;
    return {
      name,
      corpus: 'examples',
      load: () =>
        assembleCase(name, 'examples', join(dir, file), () => {
          const expectation = ExpectationSchema.parse(
            JSON.parse(readFileSync(join(dir, `${base}.expect.json`), 'utf8')),
          );
          return expectation.maxInstructions;
        }),
    };
  });
}

/** The step limit a directed program asks for in a `; max-steps: N` line, or the default. */
export function programMaxSteps(source: string): number {
  const match = /^;\s*max-steps:\s*(\d+)\s*$/m.exec(source);
  return match?.[1] === undefined ? DEFAULT_PROGRAM_MAX_STEPS : Number(match[1]);
}

/** Every `*.asm` in the directed-program directory (`tb/programs/`). */
export function programCases(dir: string = CORPUS_DIRS.programs): PendingCase[] {
  return files(dir, '.asm').map((file) => {
    const name = `programs/${file.slice(0, -'.asm'.length)}`;
    return {
      name,
      corpus: 'programs',
      load: () => assembleCase(name, 'programs', join(dir, file), programMaxSteps),
    };
  });
}

/** Reads a saved case directory: `case.json`, `program.hex` and, if present, `program.asm`. */
export function readCaseDir(dir: string): {
  file: CaseFile;
  image: number[];
  source: string | null;
} {
  const file = CaseFileSchema.parse(JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')));
  const image = parseMemoryHex(readFileSync(join(dir, 'program.hex'), 'utf8'));
  const asm = join(dir, 'program.asm');
  return { file, image, source: existsSync(asm) ? readFileSync(asm, 'utf8') : null };
}

/** Every promoted regression: one directory per case under `tb/regressions/`. */
export function regressionCases(dir: string = CORPUS_DIRS.regressions): PendingCase[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((caseName) => {
      const name = `regressions/${caseName}`;
      return {
        name,
        corpus: 'regressions',
        load: () => {
          const caseDir = join(dir, caseName);
          const { file, image, source } = readCaseDir(caseDir);
          return {
            name,
            corpus: 'regressions',
            image,
            maxSteps: file.maxSteps,
            seed: file.seed,
            shape: file.shape,
            source,
            origin: relative(REPO, caseDir),
          };
        },
      };
    });
}

/** The random program for one seed. */
export function randomCase(seed: number): PendingCase {
  const name = `random/s${String(seed)}`;
  return {
    name,
    corpus: 'random',
    load: () => {
      const program = generateProgram(seed);
      return {
        name,
        corpus: 'random',
        image: program.image,
        maxSteps: program.maxSteps,
        seed,
        shape: program.shape,
        source: program.source,
        origin: `generateProgram(${String(seed)})`,
      };
    },
  };
}

/** Seeds `seed` … `seed + count - 1`, generated one at a time as they are needed. */
export function* randomCases(seed: number, count: number): Generator<PendingCase> {
  for (let i = 0; i < count; i += 1) {
    yield randomCase(seed + i);
  }
}

/** A case name as a directory name: `random/s17` → `random-s17`. */
export function caseDirName(name: string): string {
  return basename(name.replaceAll('/', '-'));
}
