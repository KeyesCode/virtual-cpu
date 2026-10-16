import { createInterface } from 'node:readline';
import { DEFAULT_MAX_INSTRUCTIONS } from '@vcpu/cpu-core';
import { createDebugSession, DEFAULT_HISTORY_CAPACITY } from '@vcpu/debugger';
import { HELP_OPTION, parseCommandLine, parseCount, singleFile } from '../args.js';
import { createDebugRepl, REPL_HELP } from '../debug/repl.js';
import { type CliIo, ExitCode, println, UsageError } from '../io.js';
import { loadProgram } from '../program.js';
import type { Command } from './command.js';

const PROMPT = '(vcpu) ';

const help = `Usage: pnpm cpu debug <file.asm|file.bin> [--max-instructions N] [--history N]

Opens an interactive debugger on a program. Commands are read one per line from stdin, so a
script can be piped in:  printf 'break 0x1A\\nrun\\nregs\\nquit\\n' | pnpm cpu debug prog.asm

Options:
      --max-instructions <N>  Instruction limit for each "run" (default ${String(DEFAULT_MAX_INSTRUCTIONS)})
      --history <N>           Steps "back" can undo (default ${String(DEFAULT_HISTORY_CAPACITY)}; 0 disables)
  -h, --help                  Show this help

${REPL_HELP}

Exit codes: 0 after quit or end of input, 1 assembly errors, 64 usage error.`;

async function run(args: readonly string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseCommandLine(args, {
    ...HELP_OPTION,
    'max-instructions': { type: 'string' },
    history: { type: 'string' },
  });
  if (values.help === true) {
    println(io.stdout, help);
    return ExitCode.OK;
  }
  const file = singleFile(positionals, 'the <file.asm|file.bin> to debug');
  const maxInstructions =
    values['max-instructions'] === undefined
      ? DEFAULT_MAX_INSTRUCTIONS
      : parseCount(values['max-instructions'], '--max-instructions');
  const historyCapacity =
    values.history === undefined
      ? DEFAULT_HISTORY_CAPACITY
      : parseCount(values.history, '--history');
  if (io.stdin === undefined) throw new UsageError('debug needs an input stream');

  const program = loadProgram(io, file);
  const session = createDebugSession({
    program: program.bytes,
    sourceMap: program.sourceMap,
    historyCapacity,
  });
  const repl = createDebugRepl(session, { hasSource: program.kind === 'asm', maxInstructions });

  // On a terminal readline edits lines and draws the prompt; otherwise (a pipe) the prompt and
  // each command are echoed so the output reads as a transcript.
  const interactive = (io.stdin as { isTTY?: boolean }).isTTY === true && io.terminal !== undefined;
  const lines = createInterface({
    input: io.stdin,
    ...(interactive ? { output: io.terminal, terminal: true } : { terminal: false }),
  });
  lines.setPrompt(PROMPT);
  const prompt = (): void => {
    if (interactive) lines.prompt();
    else io.stdout(PROMPT);
  };

  println(io.stdout, `VCPU-8 debugger: ${file}. Type "help" for commands.`);
  println(io.stdout, repl.location());
  prompt();
  let quit = false;
  for await (const line of lines) {
    if (!interactive) println(io.stdout, line);
    const result = repl.execute(line);
    if (result.output !== '') println(io.stdout, result.output);
    if (result.quit) {
      quit = true;
      break;
    }
    prompt();
  }
  lines.close();
  // End of input left a prompt waiting on its line.
  if (!quit) println(io.stdout);
  return ExitCode.OK;
}

export const debugCommand: Command = {
  name: 'debug',
  synopsis: 'debug <file.asm|file.bin>',
  summary: 'Step through a program interactively',
  help,
  run,
};
