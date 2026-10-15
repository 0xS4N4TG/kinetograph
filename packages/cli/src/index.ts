// kinetograph: the agent CLI and MCP server (docs/AUTHORING.md §9).

import { createRequire } from 'node:module';
import { parseCommandArgs, usage } from './args.js';
import { allOptions, type Context } from './commands/types.js';
import { commands, findCommand } from './commands/index.js';
import { CliError, toErrorObject } from './errors.js';

export { createMcpServer, toolCommands, toolName } from './mcp.js';
export { bundleProject, resolveSpecifier, syntheticEntry } from './bundle.js';
export { CliError } from './errors.js';
export type { InspectLayer, InspectResult } from './native.js';

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const processIo: Io = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

function help(): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  return [
    'kinetograph: a video engine for agents',
    '',
    'usage: kinetograph <command> [entry] [options]    (kinetograph <command> --help for a command)',
    '',
    ...commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    '',
    'An entry is a project file (.tsx, .ts, .jsx, .js) or a .json scene. Every command takes --json.',
  ].join('\n');
}

/**
 * Runs the CLI with `argv` (without `node` and the script) and returns the exit code. Results go to `io.out` (text, or
 * one JSON object with `--json`); progress and plain errors to `io.err`.
 */
export async function run(argv: string[], io: Io = processIo): Promise<number> {
  const asJson = argv.includes('--json');
  const fail = (error: unknown): number => {
    const { code, message } = toErrorObject(error);
    if (asJson) io.out(`${JSON.stringify({ error: { code, message } })}\n`);
    else io.err(`error: ${message}\n`);
    return 1;
  };

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    io.out(`${help()}\n`);
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    io.out(`${(createRequire(import.meta.url)('../package.json') as { version: string }).version}\n`);
    return 0;
  }

  const found = findCommand(argv);
  if (!found) return fail(new CliError('INVALID_ARG', `unknown command "${argv[0]}"; kinetograph --help lists the commands`));
  const { command, rest } = found;
  const spec = { name: command.name, positionals: command.positionals, options: allOptions(command) };
  if (rest.includes('--help') || rest.includes('-h')) {
    io.out(`${command.summary}\n${usage(spec)}\n`);
    return 0;
  }

  try {
    const args = parseCommandArgs(spec, rest);
    const context: Context = { progress: (message) => (args.json ? undefined : io.err(`${message}\n`)) };
    const result = await command.run(args, context);
    // The MCP server owns stdout (it is the protocol) and has returned only because the client went away.
    if (command.name !== 'mcp') io.out(`${args.json ? JSON.stringify(result.data) : result.text}\n`);
    return result.exitCode ?? 0;
  } catch (error) {
    return fail(error);
  }
}
