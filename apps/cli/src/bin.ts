import { runCli } from './index.js';

const result = runCli(process.argv.slice(2));
if (result.stdout) console.log(result.stdout);
if (result.stderr) console.error(result.stderr);
process.exitCode = result.exitCode;
