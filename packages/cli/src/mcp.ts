import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { allOptions, type Command } from './commands/types.js';
import { commands } from './commands/index.js';

export interface ChildResult {
  stdout: string;
  stderr: string;
  code: number | null;
}
/** Runs the CLI with `argv`. A child process, so that the server never installs a project's determinism shim. */
export type Runner = (argv: string[]) => Promise<ChildResult>;

// Next to this file once built; when the sources run directly (vitest), the built copy.
const BESIDE = fileURLToPath(new URL('./cli.js', import.meta.url));
const CLI_JS = existsSync(BESIDE) ? BESIDE : fileURLToPath(new URL('../dist/cli.js', import.meta.url));

export const runCli: Runner = (argv) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_JS, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });

/** The commands that are tools: all but `mcp` itself and `studio`, which serves until it is stopped. */
export function toolCommands(): Command[] {
  return commands.filter((c) => c.name !== 'mcp' && c.name !== 'studio');
}

/** `audio analyze` → `audio_analyze`. */
export function toolName(command: Command): string {
  return command.name.replace(' ', '_');
}

/** Commands whose result is a PNG that the tool returns as image content. */
const IMAGE_TOOLS = new Set(['still', 'strip', 'onion']);

export function inputShape(command: Command): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const p of command.positionals) {
    const base = p.type === 'number' ? z.number() : z.string();
    shape[p.name] = (p.optional ? base.optional() : base).describe(p.description);
  }
  for (const o of allOptions(command)) {
    // Image tools write to a temp file when no output is given, so the agent need not choose a path.
    const optional = o.name !== 'output' || command.name !== 'render';
    const base = o.type === 'number' ? z.number() : o.type === 'boolean' ? z.boolean() : z.string();
    shape[o.name] = (optional ? base.optional() : base).describe(o.description);
  }
  return shape;
}

/** The CLI arguments for a tool call: positionals in order, then `--name value` for each option given. */
export function toArgv(command: Command, input: Record<string, unknown>): string[] {
  const argv = command.name.split(' ');
  for (const p of command.positionals) {
    if (input[p.name] !== undefined) argv.push(String(input[p.name]));
  }
  for (const o of allOptions(command)) {
    const value = input[o.name];
    if (value === undefined || value === null) continue;
    if (o.type === 'boolean') {
      if (value === true) argv.push(`--${o.name}`);
    } else {
      argv.push(`--${o.name}`, String(value));
    }
  }
  argv.push('--json');
  return argv;
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export async function callTool(command: Command, input: Record<string, unknown>, runner: Runner): Promise<{ content: Content[]; isError?: boolean }> {
  const args = { ...input };
  if (IMAGE_TOOLS.has(command.name) && args.output === undefined) {
    args.output = join(mkdtempSync(join(tmpdir(), 'kinetograph-mcp-')), `${command.name}.png`);
  }
  let result: ChildResult;
  try {
    result = await runner(toArgv(command, args));
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'SPAWN', message: String(error) } }) }] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    const text = result.stderr.trim() || result.stdout.trim() || `kinetograph exited with code ${result.code}`;
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'INTERNAL', message: text } }) }] };
  }
  // A failed check (lint errors, snapshot mismatches) exits 1 but is a result; only `error` objects are failures.
  const failed = typeof parsed === 'object' && parsed !== null && 'error' in parsed;
  const content: Content[] = [{ type: 'text', text: JSON.stringify(parsed, null, 2) }];
  if (!failed && IMAGE_TOOLS.has(command.name) && typeof args.output === 'string') {
    content.push({ type: 'image', data: readFileSync(args.output).toString('base64'), mimeType: 'image/png' });
  }
  return failed ? { isError: true, content } : { content };
}

export function createMcpServer(runner: Runner = runCli): McpServer {
  const version = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  const server = new McpServer({ name: 'kinetograph', version });
  for (const command of toolCommands()) {
    server.registerTool(
      toolName(command),
      { description: command.summary, inputSchema: inputShape(command) },
      async (input: Record<string, unknown>) => callTool(command, input, runner),
    );
  }
  return server;
}

/** Serves on stdio until the client closes it. */
export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = resolve;
    process.stdin.on('end', resolve);
  });
  await server.connect(transport);
  await closed;
}
