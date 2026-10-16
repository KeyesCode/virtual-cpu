import { CPU_NAME } from '@vcpu/shared';

export const COMMANDS = ['assemble', 'run', 'debug', 'disassemble', 'benchmark'] as const;

export function usage(): string {
  return [
    `${CPU_NAME} command-line interface`,
    '',
    'Usage: pnpm cpu <command> <file> [options]',
    '',
    'Commands:',
    '  assemble <file.asm>      Assemble a source file into machine code',
    '  run <file>               Run a program and print the final CPU state',
    '  debug <file>             Step through a program interactively',
    '  disassemble <file.bin>   Turn machine code back into assembly',
    '  benchmark <file>         Measure execution performance',
    '',
    'Options:',
    '  -h, --help               Show this help',
  ].join('\n');
}

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Parses argv (without the node and script paths) and returns what the process should print. */
export function runCli(argv: readonly string[]): CliResult {
  // `pnpm cpu -- <args>` forwards a literal `--`; drop it.
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const [command] = args;

  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    return { exitCode: 0, stdout: usage(), stderr: '' };
  }
  if ((COMMANDS as readonly string[]).includes(command)) {
    return { exitCode: 1, stdout: '', stderr: `cpu ${command}: not implemented yet` };
  }
  return { exitCode: 2, stdout: '', stderr: `Unknown command: ${command}\n\n${usage()}` };
}
