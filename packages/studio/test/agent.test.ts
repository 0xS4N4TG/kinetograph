import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentBridge } from '../src/agent-bridge.js';
import { isInside, readTextFile, resolveInside, writeTextFile } from '../src/agent-fs.js';
import { availableAgents, onPath } from '../src/agent-presets.js';
import type { AgentEvent } from '../src/protocol.js';
import { api, cleanup, Client, start, stopAll, tempDir, tokenOf, until, writeProject } from './helpers.js';

// Starting a studio starts workers, which is slow on a busy machine.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const FAKE =fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));
const command = `node ${JSON.stringify(FAKE)}`;

afterEach(async () => {
  await stopAll();
  cleanup();
});

describe('the files an agent may touch', () => {
  it('accepts paths inside the project, absolute or relative', () => {
    const root = tempDir();
    writeFileSync(join(root, 'a.txt'), 'x');
    expect(resolveInside(root, 'a.txt')).toBe(join(root, 'a.txt'));
    expect(resolveInside(root, join(root, 'a.txt'))).toBe(join(root, 'a.txt'));
    expect(resolveInside(root, 'new/dir/b.txt')).toBe(join(root, 'new/dir/b.txt'));
  });

  it('refuses ../, absolute paths elsewhere and the empty path', () => {
    const root = tempDir();
    expect(() => resolveInside(root, '../x.txt')).toThrow(/outside the project/);
    expect(() => resolveInside(root, 'a/../../x.txt')).toThrow(/outside the project/);
    expect(() => resolveInside(root, '/etc/passwd')).toThrow(/outside the project/);
    expect(() => resolveInside(root, '')).toThrow();
    expect(() => resolveInside(root, 'a\0b')).toThrow();
  });

  it('refuses a symlink that leads out, and a sibling directory that shares the prefix', () => {
    const root = tempDir();
    const other = tempDir();
    writeFileSync(join(other, 'secret.txt'), 's');
    symlinkSync(other, join(root, 'link'));
    expect(() => resolveInside(root, 'link/secret.txt')).toThrow(/outside the project/);
    expect(isInside('/work/app', '/work/app-two/x')).toBe(false);
    expect(isInside('/work/app', '/work/app/x')).toBe(true);
  });

  it('refuses a dangling symlink to outside, a symlinked directory to outside, and writes through neither', async () => {
    const root = tempDir();
    const other = tempDir();
    symlinkSync(join(other, 'not-there.txt'), join(root, 'dangling.txt'));
    symlinkSync(other, join(root, 'dir'));
    expect(() => resolveInside(root, 'dangling.txt')).toThrow(/outside the project/);
    expect(() => resolveInside(root, 'dir/new.txt')).toThrow(/outside the project/);
    await expect(writeTextFile(root, 'dangling.txt', 'x')).rejects.toThrow(/outside the project/);
    await expect(writeTextFile(root, 'dir/new.txt', 'x')).rejects.toThrow(/outside the project/);
    expect(existsSync(join(other, 'not-there.txt'))).toBe(false);
    expect(existsSync(join(other, 'new.txt'))).toBe(false);
  });

  it('allows a normal new nested file and a symlink that stays inside', async () => {
    const root = tempDir();
    await writeTextFile(root, 'a/b/c.txt', 'ok');
    expect(readFileSync(join(root, 'a/b/c.txt'), 'utf8')).toBe('ok');
    symlinkSync(join(root, 'a'), join(root, 'alias'));
    expect(await readTextFile(root, 'alias/b/c.txt')).toBe('ok');
  });

  it('reads line ranges and writes new files', async () => {
    const root = tempDir();
    await writeTextFile(root, 'sub/f.txt', 'one\ntwo\nthree\nfour');
    expect(readFileSync(join(root, 'sub/f.txt'), 'utf8')).toBe('one\ntwo\nthree\nfour');
    expect(await readTextFile(root, 'sub/f.txt', 2, 2)).toBe('two\nthree');
    await expect(writeTextFile(root, '../evil.txt', 'x')).rejects.toThrow(/outside the project/);
  });
});

describe('the agents on offer', () => {
  it('lists a preset only when its program is on PATH, and puts --agent first', () => {
    const bin = tempDir();
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    expect(onPath('codex', bin)).toBe(true);
    expect(onPath('claude', bin)).toBe(false);
    expect(availableAgents(undefined, bin).map((a) => a.id)).toEqual(['codex']);
    expect(availableAgents('my-agent --acp', bin).map((a) => a.id)).toEqual(['custom', 'codex']);
    expect(availableAgents(undefined, '')).toEqual([]);
  });
});

/** A bridge on the fake agent in `cwd`, with the events it emits and a way to wait for one. */
function setup(cwd: string, options: { command?: string | null; viewer?: boolean } = {}) {
  const events: AgentEvent[] = [];
  const waiting: { match: (e: AgentEvent) => boolean; resolve: (e: AgentEvent) => void }[] = [];
  const bridge = new AgentBridge({
    cwd,
    command: options.command === undefined ? command : options.command,
    allowed: [command],
    hasViewer: () => options.viewer ?? true,
    version: 'test',
    emit: (event) => {
      events.push(event);
      for (const w of waiting.splice(0)) {
        if (w.match(event)) w.resolve(event);
        else waiting.push(w);
      }
    },
  });
  const next = (match: (e: AgentEvent) => boolean) =>
    new Promise<AgentEvent>((resolve, reject) => {
      const found = events.find(match);
      if (found) return resolve(found);
      waiting.push({ match, resolve });
      setTimeout(() => reject(new Error(`timed out; saw ${JSON.stringify(events.map((e) => e.kind))}`)), 15000);
    });
  return { bridge, events, next };
}

describe('the ACP bridge against a fake agent', () => {
  it('starts the agent, sends the prompt with context and picture, and streams the answer', async () => {
    const root = tempDir();
    const { bridge, events, next } = setup(root);
    await bridge.prompt('make it red', 'layer: Headline', { data: 'AAAA', mimeType: 'image/png' });
    const text = events.filter((e) => e.kind === 'message').map((e) => (e as { text: string }).text).join('');
    expect(text).toContain('make it red');
    expect(text).toContain('layer: Headline');
    expect(text).toContain('images: 1');
    expect(events.some((e) => e.kind === 'done' && e.stopReason === 'end_turn')).toBe(true);
    expect(events.find((e) => e.kind === 'status' && e.status === 'ready')).toMatchObject({ image: true });
    await next((e) => e.kind === 'status' && e.status === 'ready');
    await bridge.close();
  });

  it('forwards what a tool call did: its input, output, diff and how long it took', async () => {
    const root = tempDir();
    process.env.FAKE_AGENT_CWD = root;
    try {
      const { bridge, events } = setup(root);
      await bridge.prompt('use tools', '');
      const tools = events.filter((e): e is Extract<AgentEvent, { kind: 'tool' }> => e.kind === 'tool');
      const run = tools.filter((t) => t.id === 'c1');
      expect(run[0]).toMatchObject({ toolKind: 'execute', status: 'in_progress', input: { command: `cd ${root} && ls`, description: 'List files' } });
      expect(run[0]!.ms).toBeUndefined();
      expect(run.at(-1)).toMatchObject({ status: 'completed', output: 'a.txt\nb.txt' });
      expect(run.at(-1)!.ms).toBeGreaterThanOrEqual(25);
      const edit = tools.find((t) => t.id === 'c2')!;
      expect(edit).toMatchObject({ toolKind: 'edit', files: ['a.txt'], diffs: [{ path: 'a.txt', added: 2, removed: 1, lines: [' one', '-two', '+2', '+three'] }] });
      await bridge.close();
    } finally {
      delete process.env.FAKE_AGENT_CWD;
    }
  });

  it('leaves the picture out when the agent does not take images', async () => {
    const root = tempDir();
    process.env.FAKE_AGENT_IMAGE = '0';
    try {
      const { bridge, events } = setup(root);
      await bridge.prompt('hi', '', { data: 'AAAA', mimeType: 'image/png' });
      const text = events.filter((e) => e.kind === 'message').map((e) => (e as { text: string }).text).join('');
      expect(text).toContain('images: 0');
      await bridge.close();
    } finally {
      delete process.env.FAKE_AGENT_IMAGE;
    }
  });

  it('waits for the user before an edit, then writes the file inside the project and refuses to read outside it', async () => {
    const root = tempDir();
    process.env.FAKE_AGENT_CWD = root;
    try {
      const { bridge, events, next } = setup(root);
      const turn = bridge.prompt('please edit', '');
      const asked = (await next((e) => e.kind === 'permission')) as Extract<AgentEvent, { kind: 'permission' }>;
      expect(asked.files).toEqual(['notes.txt']);
      expect(asked.options.map((o) => o.id)).toEqual(['allow', 'deny']);
      // Nothing is approved on its own: the file does not exist while the question is open.
      await new Promise((r) => setTimeout(r, 200));
      expect(existsSync(join(root, 'notes.txt'))).toBe(false);
      bridge.answerPermission(asked.id, 'allow');
      await turn;
      expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('hello\n');
      expect(events.find((e) => e.kind === 'tool' && e.status === 'completed')).toMatchObject({ files: ['notes.txt'] });
      const text = events.filter((e) => e.kind === 'message').map((e) => (e as { text: string }).text).join('');
      expect(text).toContain('outside read refused');
      await bridge.close();
    } finally {
      delete process.env.FAKE_AGENT_CWD;
    }
  });

  it('does not write when the user denies, or when nobody is there to ask', async () => {
    const root = tempDir();
    process.env.FAKE_AGENT_CWD = root;
    try {
      const denied = setup(root);
      const turn = denied.bridge.prompt('edit it', '');
      const asked = (await denied.next((e) => e.kind === 'permission')) as Extract<AgentEvent, { kind: 'permission' }>;
      denied.bridge.answerPermission(asked.id, 'deny');
      await turn;
      expect(existsSync(join(root, 'notes.txt'))).toBe(false);
      await denied.bridge.close();

      const alone = setup(root, { viewer: false });
      await alone.bridge.prompt('edit it', '');
      expect(alone.events.some((e) => e.kind === 'permission')).toBe(false);
      expect(existsSync(join(root, 'notes.txt'))).toBe(false);
      await alone.bridge.close();
    } finally {
      delete process.env.FAKE_AGENT_CWD;
    }
  });

  it('says in plain words that no agent is chosen, that a program is missing, and that it crashed', async () => {
    const root = tempDir();
    const none = setup(root, { command: null });
    await none.bridge.prompt('hi', '');
    expect(none.events.find((e) => e.kind === 'error')).toMatchObject({ message: expect.stringContaining('No coding agent is chosen') });

    const missing = setup(root, { command: 'definitely-not-installed-agent-xyz' });
    await missing.bridge.prompt('hi', '');
    const error = missing.events.find((e) => e.kind === 'error') as Extract<AgentEvent, { kind: 'error' }>;
    expect(error.message).toMatch(/not installed|could not be started/);
    expect(error.message).not.toMatch(/\bat .*\.(js|ts):\d+/);

    const crashing = setup(root);
    await crashing.bridge.prompt('crash now', '');
    expect(crashing.events.find((e) => e.kind === 'error')).toMatchObject({ message: expect.stringMatching(/stopped/) });
    await crashing.bridge.close();
  });

  it('asks the user to sign in when the agent says so', async () => {
    const root = tempDir();
    process.env.FAKE_AGENT_AUTH = '1';
    try {
      const { bridge, events } = setup(root);
      await bridge.prompt('hi', '');
      expect(events.find((e) => e.kind === 'error')).toMatchObject({ message: expect.stringContaining('sign in') });
    } finally {
      delete process.env.FAKE_AGENT_AUTH;
    }
  });

  it('refuses a command that is not one of the choices', async () => {
    const root = tempDir();
    mkdirSync(root, { recursive: true });
    const { bridge, events } = setup(root);
    await bridge.select('rm -rf /');
    expect(bridge.currentCommand).toBe(command);
    expect(events.find((e) => e.kind === 'error')).toBeDefined();
    await bridge.close();
  });
});

describe('the agent over the studio server', () => {
  it('offers the agents on GET /api/agent and runs a prompt sent on the WebSocket', async () => {
    const { dir, entry } = writeProject('agent');
    const server = await start(entry, { agent: command, agentCwd: dir });
    const info = await api(server, '/api/agent', { headers: { 'X-Studio-Token': tokenOf(server)! } });
    expect(info.json).toMatchObject({ command, cwd: dir });
    expect(info.json.presets[0]).toMatchObject({ id: 'custom', command });

    const client = await Client.connect(server);
    client.send({ type: 'agent.prompt', text: 'hello agent', context: 'layer: Title' });
    await client.waitForMessage('agent', (m) => m.event.kind === 'done');
    const said = client.messages('agent').map((m: any) => m.event).filter((e: any) => e.kind === 'message').map((e: any) => e.text).join('');
    expect(said).toContain('hello agent');
    expect(said).toContain('layer: Title');
    client.close();
  });

  describe('messages sent while the agent works', () => {
    const said = (c: Client) =>
      c
        .messages('agent')
        .flatMap((m: any) => (m.event.kind === 'message' ? [m.event.text] : []))
        .join('');
    const queues = (c: Client) => c.messages('agent').flatMap((m: any) => (m.event.kind === 'queue' ? [m.event.items.map((i: any) => i.text)] : []));
    const users = (c: Client) => c.messages('agent').flatMap((m: any) => (m.event.kind === 'user' ? [m.event.text] : []));

    it('queues them, shows the queue, and sends everything queued in the turn as one prompt when it ends', async () => {
      const { dir, entry } = writeProject('queue');
      const server = await start(entry, { agent: command, agentCwd: dir });
      const client = await Client.connect(server);
      client.send({ type: 'agent.prompt', text: 'slow first', context: '' });
      await client.waitForMessage('agent', (m) => m.event.kind === 'status' && m.event.status === 'busy');
      client.send({ type: 'agent.prompt', text: 'second', context: 'layer: A', chips: ['A'] });
      client.send({ type: 'agent.prompt', text: 'third', context: 'layer: B' });
      await until(() => queues(client), (q) => q.some((items) => items.length === 2));
      expect(queues(client)).toEqual([['second'], ['second', 'third']]);
      // not sent, not in the chat yet, and no refusal
      expect(said(client)).not.toContain('second');
      expect(client.messages('agent').some((m: any) => m.event.kind === 'error')).toBe(false);
      await until(() => said(client), (t) => t.includes('got: second'));
      // one prompt, joined with a blank line, with the newest message's selection
      expect(said(client)).toContain('got: second\n\nthird');
      expect(said(client)).toContain('layer: B');
      expect(said(client)).not.toContain('layer: A');
      expect(users(client)).toEqual(['slow first', 'second', 'third']);
      expect(queues(client).at(-1)).toEqual([]);
      client.close();
    });

    it('takes a message out of the queue, and Stop keeps the rest of it', async () => {
      const { dir, entry } = writeProject('unqueue');
      const server = await start(entry, { agent: command, agentCwd: dir });
      const client = await Client.connect(server);
      client.send({ type: 'agent.prompt', text: 'slow first', context: '' });
      await client.waitForMessage('agent', (m) => m.event.kind === 'status' && m.event.status === 'busy');
      client.send({ type: 'agent.prompt', text: 'drop me', context: '' });
      client.send({ type: 'agent.prompt', text: 'keep me', context: '' });
      await until(() => queues(client), (q) => q.some((items) => items.length === 2));
      const id = (client.messages('agent').find((m: any) => m.event.kind === 'queue' && m.event.items.length === 1) as any).event.items[0].id;
      client.send({ type: 'agent.unqueue', id });
      await until(() => queues(client), (q) => q.at(-1)?.join() === 'keep me');
      client.send({ type: 'agent.cancel' });
      await until(() => said(client), (t) => t.includes('got: keep me'));
      expect(said(client)).not.toContain('drop me');
      client.close();
    });

    it('keeps the queue when the window reloads, and sends the queue after the history', async () => {
      const { dir, entry } = writeProject('queue-reload');
      const server = await start(entry, { agent: command, agentCwd: dir });
      const first = await Client.connect(server);
      first.send({ type: 'agent.prompt', text: 'slow first', context: '' });
      await first.waitForMessage('agent', (m) => m.event.kind === 'status' && m.event.status === 'busy');
      first.send({ type: 'agent.prompt', text: 'later', context: '', chips: ['Title'] });
      await until(() => queues(first), (q) => q.length > 0);
      first.close();
      await new Promise((r) => setTimeout(r, 50));
      const again = await Client.connect(server);
      const history = await again.waitFor((r) => r.kind === 'json' && r.message.type === 'agent.history');
      const queue = await again.waitFor((r) => r.kind === 'json' && r.message.type === 'agent' && (r.message as any).event.kind === 'queue');
      expect(history.at).toBeLessThanOrEqual(queue.at);
      expect(queues(again)).toEqual([['later']]);
      expect((queue as any).message.event.items[0]).toMatchObject({ text: 'later', chips: ['Title'] });
      // the turn ends while it is the owner: the queued message goes out
      await until(() => said(again), (t) => t.includes('got: later'));
      again.close();
    });

    it('refuses more than twenty waiting messages in plain words', async () => {
      const { dir, entry } = writeProject('queue-cap');
      const server = await start(entry, { agent: command, agentCwd: dir });
      const client = await Client.connect(server);
      client.send({ type: 'agent.prompt', text: 'slow first', context: '' });
      await client.waitForMessage('agent', (m) => m.event.kind === 'status' && m.event.status === 'busy');
      for (let i = 0; i < 21; i++) client.send({ type: 'agent.prompt', text: `m${i}`, context: '' });
      await client.waitForMessage('agent', (m) => m.event.kind === 'error' && /Too many messages/.test(m.event.message));
      client.close();
    });
  });

  describe('pictures attached to a message', () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);
    const said = (c: Client) =>
      c
        .messages('agent')
        .flatMap((m: any) => (m.event.kind === 'message' ? [m.event.text] : []))
        .join('');
    const store = async (server: Awaited<ReturnType<typeof start>>, name: string): Promise<string> => {
      const r = await fetch(`${server.url.split('?')[0]}api/agent/image?name=${name}&token=${tokenOf(server)}`, { method: 'PUT', body: PNG });
      expect(r.status).toBe(201);
      return ((await r.json()) as { file: string }).file;
    };

    it('stores the file, hands the agent the picture and always names the paths', async () => {
      const { dir, entry } = writeProject('attach');
      const server = await start(entry, { agent: command, agentCwd: dir });
      const a = await store(server, 'a.png');
      const b = await store(server, 'b.png');
      expect(readFileSync(join(dir, 'public', 'refs', a))).toEqual(PNG);
      const client = await Client.connect(server);
      client.send({ type: 'agent.prompt', text: 'use these', context: '', attachments: [{ name: a, data: 'AAAA', mimeType: 'image/png' }, { name: b }] });
      await client.waitForMessage('agent', (m) => m.event.kind === 'done');
      // one picture block (the second came without data), and both paths named
      expect(said(client)).toContain('images: 1');
      expect(said(client)).toContain("Attached: public/refs/a.png, public/refs/b.png");
      expect(said(client)).toContain("staticFile('refs/a.png')");
      // the chat shows the person's own words and the picture names
      const user = client.messages('agent').map((m: any) => m.event).find((e: any) => e.kind === 'user');
      expect(user).toEqual({ kind: 'user', text: 'use these', chips: [], images: ['a.png', 'b.png'] });
      client.close();
    });

    it('names the paths even when the agent does not take images', async () => {
      process.env.FAKE_AGENT_IMAGE = '0';
      try {
        const { dir, entry } = writeProject('attach-noimg');
        const server = await start(entry, { agent: command, agentCwd: dir });
        const a = await store(server, 'a.png');
        const client = await Client.connect(server);
        client.send({ type: 'agent.prompt', text: 'look', context: '', attachments: [{ name: a, data: 'AAAA', mimeType: 'image/png' }] });
        await client.waitForMessage('agent', (m) => m.event.kind === 'done');
        expect(said(client)).toContain('images: 0');
        expect(said(client)).toContain('Attached: public/refs/a.png');
        client.close();
      } finally {
        delete process.env.FAKE_AGENT_IMAGE;
      }
    });

    it('writes paths relative to the agent when it runs above the project', async () => {
      const { dir, entry } = writeProject('attach-above');
      const server = await start(entry, { agent: command, agentCwd: join(dir, '..') });
      const a = await store(server, 'a.png');
      const client = await Client.connect(server);
      client.send({ type: 'agent.prompt', text: 'look', context: '', attachments: [{ name: a }] });
      await client.waitForMessage('agent', (m) => m.event.kind === 'done');
      expect(said(client)).toContain(`Attached: ${dir.split('/').pop()}/public/refs/a.png`);
      client.close();
    });

    it('lets a message that is only pictures through, and refuses names that are not stored pictures', async () => {
      const { dir, entry } = writeProject('attach-only');
      const server = await start(entry, { agent: command, agentCwd: dir });
      const a = await store(server, 'a.png');
      const client = await Client.connect(server);
      const errors = () => client.messages('agent').flatMap((m: any) => (m.event.kind === 'error' ? [m.event.message as string] : []));
      client.send({ type: 'agent.prompt', text: '', context: '', attachments: [{ name: '../../etc/passwd' }] });
      client.send({ type: 'agent.prompt', text: 'hi', context: '', attachments: [{ name: 'not-stored.png' }] });
      client.send({ type: 'agent.prompt', text: 'hi', context: '', attachments: Array.from({ length: 7 }, () => ({ name: a })) });
      await until(() => errors(), (e) => e.length === 3);
      expect(errors()[0]).toMatch(/not valid/);
      expect(errors()[1]).toMatch(/not stored in the project/);
      expect(errors()[2]).toMatch(/At most 6/);
      client.send({ type: 'agent.prompt', text: '', context: '', attachments: [{ name: a }] });
      await client.waitForMessage('agent', (m) => m.event.kind === 'done');
      expect(said(client)).toContain('Attached: public/refs/a.png');
      client.close();
    });

    it('keeps the pictures of a queued message, shows them in the queue and sends them when the turn ends', async () => {
      const { dir, entry } = writeProject('attach-queue');
      const server = await start(entry, { agent: command, agentCwd: dir });
      const a = await store(server, 'a.png');
      const b = await store(server, 'b.png');
      const client = await Client.connect(server);
      client.send({ type: 'agent.prompt', text: 'slow first', context: '' });
      await client.waitForMessage('agent', (m) => m.event.kind === 'status' && m.event.status === 'busy');
      client.send({ type: 'agent.prompt', text: 'with a', context: '', attachments: [{ name: a, data: 'AAAA', mimeType: 'image/png' }] });
      client.send({ type: 'agent.prompt', text: 'with b', context: '', attachments: [{ name: b, data: 'BBBB', mimeType: 'image/png' }] });
      await client.waitForMessage('agent', (m) => m.event.kind === 'queue' && m.event.items.length === 2);
      const queue = client.messages('agent').map((m: any) => m.event).filter((e: any) => e.kind === 'queue').at(-1);
      expect(queue.items.map((i: any) => i.images)).toEqual([['a.png'], ['b.png']]);
      await until(() => said(client), (t) => t.includes('got: with a'));
      expect(said(client)).toContain('images: 2');
      expect(said(client)).toContain('with a\n\nAttached: public/refs/a.png');
      expect(said(client)).toContain('with b\n\nAttached: public/refs/b.png');
      const users = client.messages('agent').map((m: any) => m.event).filter((e: any) => e.kind === 'user');
      expect(users.map((u: any) => u.images)).toEqual([undefined, ['a.png'], ['b.png']]);
      client.close();
    });

    it('keeps the pictures in the history a reloaded window gets', async () => {
      const { dir, entry } = writeProject('attach-history');
      const server = await start(entry, { agent: command, agentCwd: dir });
      const a = await store(server, 'a.png');
      const first = await Client.connect(server);
      first.send({ type: 'agent.prompt', text: 'see', context: '', attachments: [{ name: a }] });
      await first.waitForMessage('agent', (m) => m.event.kind === 'done');
      first.close();
      await new Promise((r) => setTimeout(r, 100));
      const again = await Client.connect(server);
      const history = (await again.waitFor((r) => r.kind === 'json' && r.message.type === 'agent.history')) as any;
      expect(history.message.items[0]).toEqual({ kind: 'user', text: 'see', chips: [], images: ['a.png'] });
      again.close();
    });
  });

  it('keeps the conversation when its window reloads, and replays it to the window that comes back', async () => {
    const { dir, entry } = writeProject('reload');
    const server = await start(entry, { agent: command, agentCwd: dir });
    const first = await Client.connect(server);
    first.send({ type: 'agent.prompt', text: 'hello again', context: '', chips: ['Title'] });
    await first.waitForMessage('agent', (m) => m.event.kind === 'done');
    first.close();
    await new Promise((r) => setTimeout(r, 100));

    const reloaded = await Client.connect(server);
    const replay: any = await reloaded.waitForMessage('agent.history', () => true);
    const items = replay.message.items as any[];
    expect(items[0]).toEqual({ kind: 'user', text: 'hello again', chips: ['Title'] });
    expect(items.some((i) => i.kind === 'event' && i.event.kind === 'message' && i.event.text.includes('hello again'))).toBe(true);
    expect(items.at(-1)).toMatchObject({ kind: 'event', event: { kind: 'done' } });
    // It owns the conversation now: it can go on with it.
    reloaded.send({ type: 'agent.prompt', text: 'and more', context: '' });
    await reloaded.waitForMessage('agent', (m) => m.event.kind === 'message' && m.event.text.includes('and more'));
    expect(reloaded.messages('agent').some((m: any) => m.event.kind === 'error')).toBe(false);
    // Starting over drops what was kept.
    reloaded.send({ type: 'agent.reset' });
    await new Promise((r) => setTimeout(r, 100));
    reloaded.close();
    await new Promise((r) => setTimeout(r, 100));
    const after = await Client.connect(server);
    const again: any = await after.waitForMessage('agent.history', () => true);
    expect(again.message.items).toEqual([]);
    after.close();
  });

  it('stops the agent and forgets the conversation when its window does not come back', async () => {
    const { dir, entry } = writeProject('gone');
    const server = await start(entry, { agent: command, agentCwd: dir, agentReclaimMs: 100 });
    const first = await Client.connect(server);
    first.send({ type: 'agent.prompt', text: 'bye', context: '' });
    await first.waitForMessage('agent', (m) => m.event.kind === 'done');
    first.close();
    await new Promise((r) => setTimeout(r, 400));
    const later = await Client.connect(server);
    await new Promise((r) => setTimeout(r, 200));
    expect(later.messages('agent.history')).toEqual([]);
    later.close();
  });

  it('refuses an agent command that is not on offer', async () => {
    const { dir, entry } = writeProject('agent2');
    const server = await start(entry, { agent: command, agentCwd: dir });
    const client = await Client.connect(server);
    client.send({ type: 'agent.select', command: 'touch /tmp/pwned' });
    await client.waitForMessage('agent', (m) => m.event.kind === 'error');
    client.close();
  });
});

describe('who may reach the agent', () => {
  const connect = async (server: Awaited<ReturnType<typeof start>>, options = {}, token?: string | null) => Client.connect(server, options, token);

  it('refuses a WebSocket without the token, with a wrong one, or from another origin', async () => {
    const { dir, entry } = writeProject('auth');
    const server = await start(entry, { agent: command, agentCwd: dir });
    expect(tokenOf(server)).toMatch(/^[0-9a-f]{64}$/);
    await expect(connect(server, {}, null)).rejects.toThrow();
    await expect(connect(server, {}, 'wrong')).rejects.toThrow();
    await expect(connect(server, { headers: { Origin: 'http://evil.example' } })).rejects.toThrow();
    (await connect(server, { headers: { Origin: new URL(server.url).origin } })).close();
  });

  it('refuses /api/agent without the token', async () => {
    const { dir, entry } = writeProject('auth2');
    const server = await start(entry, { agent: command, agentCwd: dir });
    expect((await api(server, '/api/agent')).status).toBe(403);
    expect((await api(server, '/api/agent', { headers: { 'X-Studio-Token': 'nope' } })).status).toBe(403);
    expect((await api(server, '/api/agent', { headers: { 'X-Studio-Token': tokenOf(server)! } })).status).toBe(200);
  });

  it('turns the agent off on an address other computers can reach, unless asked', async () => {
    const { dir, entry } = writeProject('remote');
    const off = await start(entry, { agent: command, agentCwd: dir, host: '0.0.0.0' });
    const headers = { 'X-Studio-Token': tokenOf(off)!, Host: 'localhost' };
    const info = await api(off, '/api/agent', { headers });
    expect(info.json.presets).toEqual([]);
    expect(info.json.disabled).toMatch(/--allow-remote-agent/);
    const client = await Client.connect(off);
    client.send({ type: 'agent.prompt', text: 'hi', context: '' });
    const error: any = await client.waitForMessage('agent', (m) => m.event.kind === 'error');
    expect(error.message.event.message).toMatch(/off/);
    client.close();

    const { dir: dir2, entry: entry2 } = writeProject('remote2');
    const on = await start(entry2, { agent: command, agentCwd: dir2, host: '0.0.0.0', allowRemoteAgent: true });
    const onInfo = await api(on, '/api/agent', { headers: { 'X-Studio-Token': tokenOf(on)! } });
    expect(onInfo.json.disabled).toBeUndefined();
    expect(onInfo.json.presets[0].command).toBe(command);
  });

  it('lets only the window that began the conversation answer, cancel or reset it', async () => {
    const { dir, entry } = writeProject('owner');
    const server = await start(entry, { agent: command, agentCwd: dir });
    const first = await Client.connect(server);
    const second = await Client.connect(server);
    first.send({ type: 'agent.prompt', text: 'hello', context: '' });
    await first.waitForMessage('agent', (m) => m.event.kind === 'done');
    // what the agent said went to the first window only
    expect(second.messages('agent').some((m: any) => m.event.kind === 'message')).toBe(false);
    second.send({ type: 'agent.prompt', text: 'steal', context: '' });
    const refused: any = await second.waitForMessage('agent', (m) => m.event.kind === 'error');
    expect(refused.message.event.message).toMatch(/Another studio window/);
    second.send({ type: 'agent.reset' });
    second.send({ type: 'agent.cancel' });
    await new Promise((r) => setTimeout(r, 200));
    expect(first.messages('agent').some((m: any) => m.event.kind === 'error')).toBe(false);
    first.close();
    second.close();
  });
});

describe('the kinetograph tools for the agent', () => {
  it('passes the kinetograph MCP server in session/new, with the studio address and token', async () => {
    const { dir, entry } = writeProject('Mcp');
    const studio = await start(entry, { agent: command, agentCwd: dir });
    const client = await Client.connect(studio);
    client.send({ type: 'agent.prompt', text: 'mcp', context: '' });
    const done = await client.waitFor((r) => r.kind === 'json' && r.message.type === 'agent' && r.message.event.kind === 'done', 20_000);
    expect(done).toBeTruthy();
    const said = client
      .messages('agent')
      .flatMap((m) => (m.type === 'agent' && m.event.kind === 'message' ? [m.event.text] : []))
      .join('');
    const params = JSON.parse(said) as { cwd: string; mcpServers: { name: string; command: string; args: string[]; env: { name: string; value: string }[] }[] };
    expect(params.cwd).toBe(dir);
    expect(params.mcpServers).toHaveLength(1);
    const server = params.mcpServers[0]!;
    expect(server.name).toBe('kinetograph');
    expect(server.command).toBe(process.execPath);
    expect(server.args[0]).toMatch(/cli\.js$/);
    expect(existsSync(server.args[0]!)).toBe(true);
    expect(server.args.slice(1, 3)).toEqual(['mcp', '--studio']);
    expect(server.args[3]).toBe(new URL(studio.url).origin);
    const agentToken = server.env[0]!.value;
    expect(server.env).toEqual([{ name: 'KINETOGRAPH_STUDIO_TOKEN', value: agentToken }]);
    expect(agentToken).not.toBe(tokenOf(studio));
    // That token reaches the live-props routes and nothing else.
    expect((await api(studio, '/api/live-props', { headers: { 'x-studio-token': agentToken } })).status).toBe(200);
    expect((await api(studio, '/api/agent', { headers: { 'x-studio-token': agentToken } })).status).toBe(403);
    await expect(Client.connect(studio, {}, agentToken)).rejects.toThrow(/403/);

    // The server it names works: its tools read and set the live props of this studio.
    const mcp = new McpClient({ name: 'e2e', version: '0.0.0' });
    await mcp.connect(
      new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: { ...(process.env as Record<string, string>), ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) },
        cwd: dir,
        stderr: 'ignore',
      }),
    );
    try {
      const names = (await mcp.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['studio_get_props', 'studio_set_props', 'still']));
      const set = await mcp.callTool({ name: 'studio_set_props', arguments: { comp: 'Short', props: { title: 'from agent' } } });
      expect(JSON.parse((set.content as { text: string }[])[0]!.text)).toEqual({ comp: 'Short', props: { title: 'from agent' } });
      await client.waitForMessage('props', (m) => m.comp === 'Short' && m.props.title === 'from agent');
      const got = await mcp.callTool({ name: 'studio_get_props', arguments: {} });
      expect(JSON.parse((got.content as { text: string }[])[0]!.text).props).toEqual({ title: 'from agent' });
    } finally {
      await mcp.close();
      client.close();
    }
  }, 60_000);
});
