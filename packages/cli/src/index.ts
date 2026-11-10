// kinetograph: the agent CLI and MCP server (packages/cli/skills/kinetograph-markup/references/AUTHORING.md §9).

import { parseCommandArgs, usage } from './args.js';
import { allOptions, type Context } from './commands/types.js';
import { commands, findCommand } from './commands/index.js';
import { CliError, toErrorObject } from './errors.js';
import { withConsoleOnStderr } from './json-console.js';
import { beginNotices } from './update-notice.js';
import { cliVersion } from './version.js';

export { createMcpServer, toolCommands, toolName } from './mcp.js';
export { bundleProject, cacheDir, resolveSpecifier, syntheticEntry, watchProject } from './bundle.js';
export type { BundleResult, ProjectBuild } from './bundle.js';
export { CliError, toErrorObject } from './errors.js';
export { native } from './native.js';
export type { InspectLayer, InspectResult, Native } from './native.js';
export { bundlePanel, findPlugins, loadPluginTools, mcpToolName, pluginToolNames } from './plugins.js';
export type { PluginInfo, PluginTool } from './plugins.js';
export { renderSource } from './render-job.js';
export type { RenderJobOptions } from './render-job.js';
export { checkFrame, frameRange, isSceneFile, listCompositions, openSource, parseProps, projectRootOf } from './source.js';
export type { FrameOutput, OpenOptions, Source } from './source.js';

export { cliVersion };

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
  return argv.includes('--json') && argv[0] !== 'mcp' ? withConsoleOnStderr(io, () => runCommand(argv, io)) : runCommand(argv, io);
}

async function runCommand(argv: string[], io: Io): Promise<number> {
  const asJson = argv.includes('--json');
  // Update notices (update-notice.ts): to stderr, and in `notices` of a `--json` result. Not for `studio`, which serves
  // until it is stopped, or `mcp`, whose stderr no agent reads (the server puts them in its first tool result).
  let session: ReturnType<typeof beginNotices>;
  const notices = async (): Promise<string[]> => (await session?.collect().catch(() => undefined)) ?? [];
  const showNotices = (lines: string[]): void => lines.forEach((line) => io.err(`${line}\n`));
  const fail = async (error: unknown): Promise<number> => {
    const { code, message } = toErrorObject(error);
    const lines = await notices();
    if (asJson) io.out(`${JSON.stringify({ error: { code, message }, ...(lines.length > 0 ? { notices: lines } : {}) })}\n`);
    else io.err(`error: ${message}\n`);
    showNotices(lines);
    return 1;
  };

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    io.out(`${help()}\n`);
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    io.out(`${cliVersion()}\n`);
    return 0;
  }

  const found = findCommand(argv);
  if (!found) return await fail(new CliError('INVALID_ARG', `unknown command "${argv[0]}"; kinetograph --help lists the commands`));
  const { command, rest } = found;
  const spec = { name: command.name, positionals: command.positionals, options: allOptions(command) };
  if (rest.includes('--help') || rest.includes('-h')) {
    io.out(`${command.summary}\n${usage(spec)}\n`);
    return 0;
  }

  if (command.name !== 'mcp' && command.name !== 'studio') session = beginNotices(cliVersion());

  try {
    const args = parseCommandArgs(spec, rest);
    const context: Context = {
      progress: (message) => (args.json ? undefined : io.err(`${message}\n`)),
      announce: (data, text) => io.out(`${args.json ? JSON.stringify(data) : text}\n`),
    };
    const result = await command.run(args, context);
    // The MCP server owns stdout (it is the protocol) and has returned only because the client went away; the
    // studio has said what it had to (`announce`) and returns only when it is stopped.
    if (command.name !== 'mcp' && command.name !== 'studio') {
      const lines = await notices();
      const data = lines.length > 0 && !Array.isArray(result.data) ? { ...result.data, notices: lines } : result.data;
      io.out(`${args.json ? JSON.stringify(data) : result.text}\n`);
      showNotices(lines);
    }
    return result.exitCode ?? 0;
  } catch (error) {
    return await fail(error);
  }
}
