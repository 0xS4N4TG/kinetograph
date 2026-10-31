import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CliError } from './errors.js';
import { allOptions, type Command } from './commands/types.js';
import { commands } from './commands/index.js';
import { findPlugins, loadPluginTools, mcpToolName, type PluginTool } from './plugins.js';

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

/** The commands that are tools: all but `mcp` itself, `studio`, which serves until it is stopped, and `fetch-deps`, which downloads (a person runs it). */
export function toolCommands(): Command[] {
  return commands.filter((c) => c.name !== 'mcp' && c.name !== 'studio' && c.name !== 'fetch-deps');
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
    const base = o.multiple ? z.array(z.string()) : o.type === 'number' ? z.number() : o.type === 'boolean' ? z.boolean() : z.string();
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
    } else if (o.multiple && Array.isArray(value)) {
      for (const v of value) argv.push(`--${o.name}`, String(v));
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

/** A plugin's tool under its MCP name. */
export interface LoadedPluginTool {
  name: string;
  tool: PluginTool;
}

/** The tools of the plugins the project at `dir` depends on. A plugin whose tools fail to load is skipped; `onError` hears why. */
export async function loadProjectTools(dir: string, onError: (message: string) => void = () => undefined): Promise<LoadedPluginTool[]> {
  const out: LoadedPluginTool[] = [];
  for (const plugin of findPlugins(dir)) {
    try {
      for (const tool of await loadPluginTools(plugin)) out.push({ name: mcpToolName(plugin, tool), tool });
    } catch (error) {
      onError(`kinetograph: the tools of ${plugin.name} did not load, skipped: ${(error as Error).message}`);
    }
  }
  return out;
}

/** A running studio the MCP server can reach. */
export interface StudioTarget {
  /** `http://127.0.0.1:3000`; any query (the token the studio opens with) is ignored. */
  url: string;
  token: string;
}

interface LiveProps {
  comp: string | null;
  props: Record<string, unknown>;
}

async function studioFetch(target: StudioTarget, init: RequestInit = {}): Promise<LiveProps> {
  const url = new URL('/api/live-props', target.url);
  const headers = new Headers(init.headers);
  headers.set('x-studio-token', target.token);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(url, { ...init, headers });
  const body = (await response.json().catch(() => ({}))) as LiveProps & { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `the studio answered ${response.status}`);
  return body;
}

const text = (value: unknown): { content: Content[] } => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const failure = (error: unknown): { isError: true; content: Content[] } => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: { code: 'STUDIO', message: (error as Error).message } }) }],
});

function addStudioTools(server: McpServer, target: StudioTarget): void {
  server.registerTool(
    'studio_get_props',
    {
      description: 'The composition the open Studio window previews and the props it shows now: { comp, props }. comp is null when no window is open.',
      inputSchema: {},
    },
    async () => {
      try {
        return text(await studioFetch(target));
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    'studio_set_props',
    {
      description:
        'Sets the props the open Studio window previews; the preview re-renders at once. Use it to try values; write the chosen ones into the code or a preset at the end. Returns { comp, props }.',
      inputSchema: {
        comp: z.string().optional().describe('The composition id; default: the one the window shows'),
        props: z.record(z.string(), z.unknown()).describe('The props to set'),
        merge: z.boolean().optional().describe('Shallow-merge over the props shown now (default true); false replaces them'),
      },
    },
    async ({ comp, props, merge }: { comp?: string; props: Record<string, unknown>; merge?: boolean }) => {
      try {
        const now = await studioFetch(target);
        const id = comp ?? now.comp;
        if (id === null) throw new Error('no Studio window is open on a composition; pass comp');
        // The props shown now are of the composition on screen; another composition starts from nothing.
        const base = merge === false || id !== now.comp ? {} : now.props;
        return text(await studioFetch(target, { method: 'PUT', body: JSON.stringify({ comp: id, props: { ...base, ...props } }) }));
      } catch (error) {
        return failure(error);
      }
    },
  );
}

export function createMcpServer(runner: Runner = runCli, plugins: LoadedPluginTool[] = [], studio?: StudioTarget): McpServer {
  const version = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  const server = new McpServer({ name: 'kinetograph', version });
  for (const command of toolCommands()) {
    server.registerTool(
      toolName(command),
      { description: command.summary, inputSchema: inputShape(command) },
      async (input: Record<string, unknown>) => callTool(command, input, runner),
    );
  }
  if (studio) addStudioTools(server, studio);
  const taken = new Set(toolCommands().map(toolName));
  for (const { name, tool } of plugins) {
    if (taken.has(name)) {
      process.stderr.write(`kinetograph: the plugin tool ${name} is skipped: the name is taken\n`);
      continue;
    }
    taken.add(name);
    server.registerTool(
      name,
      { description: tool.description, inputSchema: tool.input as never },
      (async (input: unknown) => {
        try {
          const result = await tool.run(input);
          return { content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }] };
        } catch (error) {
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'TOOL', message: (error as Error).message } }) }] };
        }
      }) as never,
    );
  }
  return server;
}

/** Serves on stdio until the client closes it. */
export async function startMcpServer(studioUrl?: string): Promise<void> {
  const plugins = await loadProjectTools(process.cwd(), (message) => process.stderr.write(`${message}\n`));
  const token = process.env.KINETOGRAPH_STUDIO_TOKEN;
  if (studioUrl !== undefined && !token) throw new CliError('INVALID_ARG', '--studio needs the studio token in the environment variable KINETOGRAPH_STUDIO_TOKEN');
  const server = createMcpServer(runCli, plugins, studioUrl === undefined ? undefined : { url: studioUrl, token: token! });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = resolve;
    process.stdin.on('end', resolve);
  });
  await server.connect(transport);
  await closed;
}
