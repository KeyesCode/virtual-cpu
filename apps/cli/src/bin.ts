import { main } from './index.js';

// `pnpm cpu` runs this from apps/cli; INIT_CWD is the directory pnpm was started in, so file
// arguments resolve where the user typed them.
process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.env.INIT_CWD ?? process.cwd(),
  stdin: process.stdin,
  terminal: process.stdout,
});
