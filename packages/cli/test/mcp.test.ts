import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { findCommand } from '../src/commands/index.js';
import { callTool, createMcpServer, loadProjectTools, runCli, toArgv, toolCommands, toolName, type Runner } from '../src/mcp.js';
import { solidPng, toolsProject } from './helpers.js';
import { fileURLToPath } from 'node:url';
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
      ['audio_analyze', 'bench', 'check', 'compositions', 'doctor', 'effects', 'inspect', 'lint', 'onion', 'plugins', 'render', 'snapshot', 'still', 'strip', 'track'],
    );
    expect(toolCommands().map(toolName).sort()).toEqual(tools.map((t) => t.name).sort());
  });

  it('describes each tool\'s arguments from the command\'s spec', async () => {
    const client = await connect(async () => ({ stdout: '{}', stderr: '', code: 0 }));
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));

    const still = by.still!.inputSchema as { properties: Record<string, { type: string }>; required: string[] };
    expect(Object.keys(still.properties).sort()).toEqual(['comp', 'dev-react', 'entry', 'frame', 'offline', 'output', 'props', 'strict']);
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

    // track: Detect Features and plane tracks; the repeatable options are lists.
    const track = by.track!.inputSchema as { properties: Record<string, { type: string }>; required: string[] };
    expect(track.required).toEqual(['video']);
    expect(track.properties.detect!.type).toBe('boolean');
    expect(track.properties['detect-threshold']!.type).toBe('number');
    for (const name of ['point', 'plane', 'plane-corners', 'detect-inside', 'detect-outside']) expect(track.properties[name]!.type).toBe('array');
  });

  it('gives doctor the compat report\'s arguments, the entry optional', async () => {
    const client = await connect(async () => ({ stdout: '{}', stderr: '', code: 0 }));
    const { tools } = await client.listTools();
    const doctor = tools.find((t) => t.name === 'doctor')!.inputSchema as {
      properties: Record<string, { type: string }>;
      required?: string[];
    };
    expect(Object.keys(doctor.properties).sort()).toEqual(['comp', 'entry', 'offline', 'props', 'range']);
    expect(doctor.properties.range!.type).toBe('string');
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
    expect(toArgv(command('doctor'), { entry: 'a.tsx', range: '0..30' })).toEqual([
      'doctor', 'a.tsx', '--range', '0..30', '--json',
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

describe('plugin tools', () => {
  const fixture = () => toolsProject(mkdtempSync(join(tmpdir(), 'kinetograph-mcp-plugins-')));

  it('registers them as <short>_<name> with their zod input as the schema, and skips a bad plugin', async () => {
    const skipped: string[] = [];
    const loaded = await loadProjectTools(fixture(), (m) => skipped.push(m));
    expect(loaded.map((t) => t.name)).toEqual(['dice_roll', 'dice_fail']);
    expect(skipped.map((m) => m.match(/of (\S+) did/)![1]).sort()).toEqual(['fx-bad', 'fx-shape']);

    const server = createMcpServer(async () => ({ stdout: '{}', stderr: '', code: 0 }), loaded);
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    const roll = tools.find((t) => t.name === 'dice_roll')!;
    expect(roll.description).toBe('Rolls dice.');
    const schema = roll.inputSchema as { properties: Record<string, { type: string; description?: string }>; required: string[] };
    expect(schema.properties.sides).toMatchObject({ type: 'integer', description: 'Sides on the die' });
    expect(schema.required).toEqual(['sides']);

    const ok = await client.callTool({ name: 'dice_roll', arguments: { sides: 6, count: 3 } });
    expect(JSON.parse((ok.content as { text: string }[])[0]!.text)).toEqual({ total: 18 });
    const failed = await client.callTool({ name: 'dice_fail', arguments: {} });
    expect(failed.isError).toBe(true);
    const invalid = await client.callTool({ name: 'dice_roll', arguments: { sides: 'x' } }).catch((e: unknown) => e);
    expect(invalid instanceof Error || (invalid as { isError?: boolean }).isError === true).toBe(true);
  });

  it('serves them over stdio from `node dist/cli.js mcp` in the project directory', async () => {
    const cliJs = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    if (!existsSync(cliJs)) return; // needs `npm run build`
    const dir = fixture();
    const transport = new StdioClientTransport({ command: process.execPath, args: [cliJs, 'mcp'], cwd: dir, stderr: 'ignore' });
    const client = new SdkClient({ name: 'e2e', version: '0.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['still', 'dice_roll', 'dice_fail']));
      const r = await client.callTool({ name: 'dice_roll', arguments: { sides: 4, count: 2 } });
      expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toEqual({ total: 8 });
    } finally {
      await client.close();
    }
  }, 60_000);
});

describe('studio tools', () => {
  async function withStudio(run: (client: Client, state: { live: { comp: string | null; props: Record<string, unknown> }; tokens: (string | undefined)[]; panels: { panel: string; data: unknown; message?: string }[]; answers: Record<string, unknown> }) => Promise<void>) {
    const state = {
      live: { comp: 'Hero' as string | null, props: { title: 'a', size: 1 } as Record<string, unknown> },
      tokens: [] as (string | undefined)[],
      panels: [] as { panel: string; data: unknown; message?: string }[],
      answers: {} as Record<string, unknown>,
    };
    const http = createServer((req, res) => {
      state.tokens.push(req.headers['x-studio-token'] as string | undefined);
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/api/panels' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        return req.on('end', () => {
          const opened = JSON.parse(body) as { panel: string; data: unknown; message?: string };
          if (opened.panel === 'storyboard' && !(opened.data as { comp?: string }).comp) return reply(400, { error: { message: 'the data for a storyboard panel is not valid: comp must be the board composition id' } });
          state.panels.push(opened);
          reply(201, { id: `p_${state.panels.length}`, status: 'open' });
        });
      }
      const one = /^\/api\/panels\/(p_\d+)$/.exec(req.url ?? '');
      if (one && req.method === 'GET') {
        const done = state.answers[one[1]!];
        return done ? reply(200, { id: one[1], panel: 'brief', status: 'submitted', answer: done }) : one[1] === 'p_1' ? reply(200, { id: 'p_1', panel: 'brief', status: 'open', answer: null }) : reply(404, { error: { message: `no panel "${one[1]}"` } });
      }
      if (req.url !== '/api/live-props') return reply(404, {});
      if (req.method === 'GET') return reply(200, state.live);
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const put = JSON.parse(body) as { comp: string; props: Record<string, unknown> };
        if (put.comp === 'Nope') return reply(400, { error: { message: 'no composition "Nope"' } });
        state.live = put;
        reply(200, put);
      });
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const { port } = http.address() as { port: number };
    const server = createMcpServer(async () => ({ stdout: '{}', stderr: '', code: 0 }), [], { url: `http://127.0.0.1:${port}/?token=ignored`, token: 'tok' });
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      await run(client, state);
    } finally {
      await new Promise((r) => http.close(r));
    }
  }
  const json = (r: Awaited<ReturnType<Client['callTool']>>) => JSON.parse((r.content as { text: string }[])[0]!.text);

  it('adds the studio tools only when a studio is given', async () => {
    const without = await (await connect(async () => ({ stdout: '{}', stderr: '', code: 0 }))).listTools();
    expect(without.tools.some((t) => t.name.startsWith('studio_'))).toBe(false);
    await withStudio(async (client) => {
      expect((await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith('studio_')).sort()).toEqual(['studio_get_props', 'studio_open_panel', 'studio_panel_result', 'studio_set_props']);
    });
  });

  it('reads the live props and sets them, merging by default, with the token', async () => {
    await withStudio(async (client, state) => {
      expect(json(await client.callTool({ name: 'studio_get_props', arguments: {} }))).toEqual({ comp: 'Hero', props: { title: 'a', size: 1 } });
      expect(json(await client.callTool({ name: 'studio_set_props', arguments: { props: { title: 'b' } } }))).toEqual({ comp: 'Hero', props: { title: 'b', size: 1 } });
      expect(json(await client.callTool({ name: 'studio_set_props', arguments: { props: { x: 2 }, merge: false } }))).toEqual({ comp: 'Hero', props: { x: 2 } });
      expect(state.live).toEqual({ comp: 'Hero', props: { x: 2 } });
      // Another composition does not inherit the props of the one on screen.
      expect(json(await client.callTool({ name: 'studio_set_props', arguments: { comp: 'Other', props: { y: 1 } } }))).toEqual({ comp: 'Other', props: { y: 1 } });
      expect(new Set(state.tokens)).toEqual(new Set(['tok']));
    });
  });

  it('reports the studio\'s error, and a missing window', async () => {
    await withStudio(async (client, state) => {
      const bad = await client.callTool({ name: 'studio_set_props', arguments: { comp: 'Nope', props: {} } });
      expect(bad.isError).toBe(true);
      expect(JSON.stringify(bad.content)).toContain('no composition');
      state.live = { comp: null, props: {} };
      const none = await client.callTool({ name: 'studio_set_props', arguments: { props: {} } });
      expect(none.isError).toBe(true);
    });
  });

  it('opens a panel at once and reads its result, with the token', async () => {
    await withStudio(async (client, state) => {
      const opened = await client.callTool({ name: 'studio_open_panel', arguments: { panel: 'brief', data: { purpose: 'an ad' }, message: 'Check this' } });
      expect(json(opened)).toEqual({ id: 'p_1', status: 'open' });
      expect(state.panels).toEqual([{ panel: 'brief', data: { purpose: 'an ad' }, message: 'Check this' }]);
      expect(json(await client.callTool({ name: 'studio_panel_result', arguments: { id: 'p_1' } }))).toEqual({ status: 'open' });
      state.answers.p_2 = { approved: true };
      expect(json(await client.callTool({ name: 'studio_panel_result', arguments: { id: 'p_2' } }))).toEqual({ status: 'submitted', answer: { approved: true } });
      expect(new Set(state.tokens)).toEqual(new Set(['tok']));
    });
  });

  it('says what is wrong with a panel, and that a panel is unknown', async () => {
    await withStudio(async (client) => {
      const bad = await client.callTool({ name: 'studio_open_panel', arguments: { panel: 'storyboard', data: { shots: [] } } });
      expect(bad.isError).toBe(true);
      expect(JSON.stringify(bad.content)).toContain('comp must be');
      expect((await client.callTool({ name: 'studio_panel_result', arguments: { id: 'p_9' } })).isError).toBe(true);
      expect((await client.callTool({ name: 'studio_open_panel', arguments: { panel: 'poem', data: {} } })).isError).toBe(true);
    });
  });

  it('tells the agent to end its turn and wait, in both panel tools', async () => {
    await withStudio(async (client) => {
      const tools = (await client.listTools()).tools;
      const open = tools.find((t) => t.name === 'studio_open_panel')!.description!;
      expect(open).toContain('end your turn');
      expect(open).toContain('[panel <kind> <id> submitted]');
      expect(open).toContain('studio_panel_result');
      expect(tools.find((t) => t.name === 'studio_panel_result')!.description).toContain('terminal');
    });
  });
});
