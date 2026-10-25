import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentBridge } from '../src/agent-bridge.js';
import { isInside, readTextFile, resolveInside, writeTextFile } from '../src/agent-fs.js';
import { availableAgents, onPath } from '../src/agent-presets.js';
import type { AgentEvent } from '../src/protocol.js';
import { api, cleanup, Client, start, stopAll, tempDir, writeProject } from './helpers.js';

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
    const info = await api(server, '/api/agent');
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

  it('refuses an agent command that is not on offer', async () => {
    const { dir, entry } = writeProject('agent2');
    const server = await start(entry, { agent: command, agentCwd: dir });
    const client = await Client.connect(server);
    client.send({ type: 'agent.select', command: 'touch /tmp/pwned' });
    await client.waitForMessage('agent', (m) => m.event.kind === 'error');
    client.close();
  });
});
