import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { findCommand } from '../src/commands/index.js';
import { callTool, createMcpServer, runCli, toArgv, toolCommands, toolName, type Runner } from '../src/mcp.js';
import { solidPng } from './helpers.js';

const command = (name: string) => findCommand(name.split(' '))!.command;

async function connect(runner: Runner): Promise<Client> {
  const server = createMcpServer(runner);
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe('the tool list', () => {
  it('has one tool per command except mcp', async () => {
    const client = await connect(async () => ({ stdout: '{}', stderr: '', code: 0 }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['audio_analyze', 'bench', 'compositions', 'doctor', 'effects', 'inspect', 'lint', 'onion', 'render', 'snapshot', 'still', 'strip'],
    );
    expect(toolCommands().map(toolName).sort()).toEqual(tools.map((t) => t.name).sort());
  });

  it('describes each tool\'s arguments from the command\'s spec', async () => {
    const client = await connect(async () => ({ stdout: '{}', stderr: '', code: 0 }));
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));

    const still = by.still!.inputSchema as { properties: Record<string, { type: string }>; required: string[] };
    expect(Object.keys(still.properties).sort()).toEqual(['comp', 'compat', 'entry', 'frame', 'output', 'props']);
    expect(still.properties.frame!.type).toBe('number');
    // The output of an image tool is optional (a temp file is used), a video's is not.
    expect(still.required.sort()).toEqual(['entry', 'frame']);
    expect((by.render!.inputSchema as { required: string[] }).required.sort()).toEqual(['entry', 'output']);
    expect((by.render!.inputSchema as { properties: Record<string, { type: string }> }).properties.draft!.type).toBe('boolean');

    expect(Object.keys((by.effects!.inputSchema as { properties: object }).properties)).toEqual([]);
    expect(Object.keys((by.audio_analyze!.inputSchema as { properties: object }).properties)).toEqual(
      expect.arrayContaining(['entry', 'range', 'scenes', 'comp', 'props']),
    );
    for (const t of tools) expect(t.description).toBeTruthy();
  });

  it('gives doctor the compat report\'s arguments, the entry optional', async () => {
    const client = await connect(async () => ({ stdout: '{}', stderr: '', code: 0 }));
    const { tools } = await client.listTools();
    const doctor = tools.find((t) => t.name === 'doctor')!.inputSchema as {
      properties: Record<string, { type: string }>;
      required?: string[];
    };
    expect(Object.keys(doctor.properties).sort()).toEqual(['comp', 'compare', 'compare-dir', 'compare-every', 'entry', 'props', 'range']);
    expect(doctor.properties.compare!.type).toBe('number');
    expect(doctor.required ?? []).toEqual([]);
  });
});

describe('toArgv', () => {
  it('builds the command line: positionals in order, long options, --json last', () => {
    expect(toArgv(command('still'), { entry: 'a.tsx', frame: 30, output: 'o.png', comp: 'Main' })).toEqual([
      'still', 'a.tsx', '30', '--output', 'o.png', '--comp', 'Main', '--json',
    ]);
    expect(toArgv(command('render'), { entry: 'a.tsx', output: 'o.mp4', draft: true, range: '0..9' })).toEqual([
      'render', 'a.tsx', '--output', 'o.mp4', '--range', '0..9', '--draft', '--json',
    ]);
    expect(toArgv(command('render'), { entry: 'a.tsx', output: 'o.mp4', draft: false })).not.toContain('--draft');
    expect(toArgv(command('doctor'), { entry: 'a.tsx', range: '0..30', compare: 4 })).toEqual([
      'doctor', 'a.tsx', '--range', '0..30', '--compare', '4', '--json',
    ]);
    expect(toArgv(command('audio analyze'), { entry: 'a.tsx' })).toEqual(['audio', 'analyze', 'a.tsx', '--json']);
    expect(toArgv(command('onion'), { entry: 'a.tsx', range: '0..30', count: 4 })).toEqual([
      'onion', 'a.tsx', '0..30', '--count', '4', '--json',
    ]);
  });
});

describe('callTool', () => {
  it('returns the JSON result as text, and the PNG as image content for still, strip and onion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kinetograph-mcp-test-'));
    const png = solidPng(2, 2, [1, 2, 3, 255]);
    let seen: string[] = [];
    const runner: Runner = async (argv) => {
      seen = argv;
      writeFileSync(argv[argv.indexOf('--output') + 1]!, png);
      return { stdout: JSON.stringify({ output: 'x', frame: 3 }), stderr: '', code: 0 };
    };
    const given = join(dir, 'still.png');
    const r = await callTool(command('still'), { entry: 'a.tsx', frame: 3, output: given }, runner);
    expect(r.isError).toBeUndefined();
    expect(r.content[0]).toMatchObject({ type: 'text' });
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ output: 'x', frame: 3 });
    expect(r.content[1]).toEqual({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });

    // No output given: a temp file is chosen, so an agent need not pick a path.
    for (const name of ['still', 'strip']) {
      const auto = await callTool(command(name), { entry: 'a.tsx', frame: 0 }, runner);
      const chosen = seen[seen.indexOf('--output') + 1]!;
      expect(chosen.endsWith(`${name}.png`)).toBe(true);
      expect(existsSync(chosen)).toBe(true);
      expect(auto.content).toHaveLength(2);
    }
  });

  it('returns no image for other tools, and marks { error } results as errors', async () => {
    const ok = await callTool(command('inspect'), { entry: 'a.tsx' }, async () => ({ stdout: '{"layers":[]}', stderr: '', code: 0 }));
    expect(ok.content).toHaveLength(1);
    const failed = await callTool(
      command('still'),
      { entry: 'a.tsx', frame: 99, output: join(tmpdir(), 'never.png') },
      async () => ({ stdout: '{"error":{"code":"FRAME_OUT_OF_RANGE","message":"nope"}}', stderr: '', code: 1 }),
    );
    expect(failed.isError).toBe(true);
    expect(failed.content).toHaveLength(1);
  });

  it('treats a failed check (exit 1 with a result) as a result, not an error', async () => {
    const r = await callTool(command('lint'), { entry: 'a.tsx' }, async () => ({ stdout: '{"ok":false,"issues":[]}', stderr: '', code: 1 }));
    expect(r.isError).toBeUndefined();
  });

  it('reports output that is not JSON from stderr', async () => {
    const r = await callTool(command('doctor'), {}, async () => ({ stdout: '', stderr: 'node: bad option', code: 9 }));
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('node: bad option');
  });

  it('runs through a client end to end', async () => {
    const client = await connect(async (argv) => ({ stdout: JSON.stringify({ argv }), stderr: '', code: 0 }));
    const result = await client.callTool({ name: 'compositions', arguments: { entry: 'p.tsx' } });
    const text = (result.content as { text: string }[])[0]!.text;
    expect(JSON.parse(text)).toEqual({ argv: ['compositions', 'p.tsx', '--json'] });
  });
});

describe('the real child process', () => {
  it('runs the built CLI with --json and parses its output', async () => {
    const result = await callTool(command('effects'), {}, runCli);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(Array.isArray(parsed.effects)).toBe(true);
    const failure = await callTool(command('compositions'), { entry: '/no/such.tsx' }, runCli);
    expect(failure.isError).toBe(true);
    expect(JSON.parse((failure.content[0] as { text: string }).text).error.code).toBe('ENTRY_NOT_FOUND');
  });
});
