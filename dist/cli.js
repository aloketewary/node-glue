import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from './index.js';
const HELP = `Node Glue ${VERSION}

Usage:
  node-glue <command>

Commands:
  install     Resolve and materialize project dependencies
  ensure      Verify and repair project dependency state
  exec        Ensure project, then run a command
  doctor      Inspect project and repository state
  gc          Remove unreferenced package instances
`;
export function runCli(args = process.argv.slice(2)) {
    const command = args[0];
    if (command === undefined || command === '--help' || command === '-h') {
        console.log(HELP);
        return 0;
    }
    if (command === '--version' || command === '-v') {
        console.log(VERSION);
        return 0;
    }
    console.error(`Unknown command: ${command}`);
    console.error('Run "node-glue --help" for usage.');
    return 1;
}
const entrypoint = process.argv[1];
if (entrypoint !== undefined && fileURLToPath(import.meta.url) === resolve(entrypoint)) {
    process.exitCode = runCli();
}
//# sourceMappingURL=cli.js.map