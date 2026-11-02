import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/app';
import type { AgentEvent } from '../src/api';
import { moved } from '../src/components/agent/up-next';
import { MockServer } from './mock-server';

async function start() {
  const server = new MockServer();
  server.agent = { ...server.agent, home: '/Users/me' };
  const user = userEvent.setup();
  render(<App api={server} />);
  await waitFor(() => expect(server.frameRequests.length).toBeGreaterThan(0));
  await screen.findByTestId('agent-panel');
  return { server, user };
}

const say = (server: MockServer, event: AgentEvent) => act(() => server.send({ type: 'agent', event }));
const busy = (server: MockServer) => say(server, { kind: 'status', status: 'busy', command: 'fake --acp', image: true });
const ready = (server: MockServer) => say(server, { kind: 'status', status: 'ready', command: 'fake --acp', image: true });
const prompts = (server: MockServer) => server.agentMessages.filter((m) => m.type === 'agent.prompt');

describe('queueing messages while the agent works', () => {
  it('lets Send and Enter go through while busy, shows what the server queued, and the turn then sends it', async () => {
    const { server, user } = await start();
    await busy(server);
    const box = screen.getByLabelText('Message for the agent');
    expect(box).not.toBeDisabled();
    await user.type(box, 'first thing');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(prompts(server)).toHaveLength(1);
    // the server queues it and tells the window; the chat does not show it as said yet
    await say(server, { kind: 'queue', items: [{ id: 'q1', text: 'first thing', chips: [] }] });
    // collapsed: one slim bar with the first line
    expect(screen.getByTestId('queue-toggle')).toHaveTextContent('1 up next');
    expect(screen.getByTestId('queue-first')).toHaveTextContent('first thing');
    expect(screen.queryByTestId('chat-user')).toBeNull();
    expect(screen.getByTestId('queue-count')).toHaveTextContent('1');

    await user.type(box, 'second thing{Enter}');
    expect(prompts(server)).toHaveLength(2);
    await say(server, { kind: 'queue', items: [{ id: 'q1', text: 'first thing', chips: [] }, { id: 'q2', text: 'second thing', chips: [] }] });
    expect(screen.getByTestId('queue-toggle')).toHaveTextContent('2 up next');
    await user.click(screen.getByTestId('queue-toggle'));
    expect(screen.getAllByTestId('chat-queued')).toHaveLength(2);
    expect(screen.getByTestId('queue-count')).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: 'Send (2 queued)' })).toBeInTheDocument();

    // the turn ends: the server sends both as one prompt, shows each as the person's message, and empties the queue
    await say(server, { kind: 'user', text: 'first thing', chips: [] });
    await say(server, { kind: 'user', text: 'second thing', chips: [] });
    await say(server, { kind: 'queue', items: [] });
    expect(screen.queryByTestId('up-next')).toBeNull();
    expect(screen.queryByTestId('queue-count')).toBeNull();
    expect(screen.getAllByTestId('chat-user').map((e) => e.textContent)).toEqual(['first thing', 'second thing']);
  });

  it('removes a queued message by asking the server, and Stop leaves the queue alone', async () => {
    const { server, user } = await start();
    await busy(server);
    await say(server, { kind: 'queue', items: [{ id: 'q1', text: 'do this later', chips: ['Title · frame 0'] }] });
    await user.click(screen.getByTestId('queue-toggle'));
    expect(screen.getByTestId('queued-chips')).toHaveTextContent('Title · frame 0');
    await user.click(screen.getByRole('button', { name: /Remove queued message/ }));
    expect(server.agentMessages.at(-1)).toEqual({ type: 'agent.unqueue', id: 'q1' });
    // nothing is removed until the server says so
    expect(screen.getByTestId('chat-queued')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Stop/ }));
    expect(server.agentMessages.at(-1)).toEqual({ type: 'agent.cancel' });
    expect(screen.getByTestId('chat-queued')).toBeInTheDocument();
    await say(server, { kind: 'queue', items: [] });
    expect(screen.queryByTestId('chat-queued')).toBeNull();
  });

  it('shows the queue again after a reload: the history comes first, then the queue', async () => {
    const { server, user } = await start();
    await act(() => server.send({ type: 'agent.history', items: [{ kind: 'user', text: 'earlier', chips: [] }] }));
    await say(server, { kind: 'queue', items: [{ id: 'q3', text: 'still waiting', chips: [] }] });
    expect(screen.getByTestId('chat-user')).toHaveTextContent('earlier');
    expect(screen.getByTestId('queue-first')).toHaveTextContent('still waiting');
    await user.click(screen.getByTestId('queue-toggle'));
    expect(screen.getByTestId('chat-queued')).toHaveTextContent('still waiting');
    // a history alone (a new conversation) starts with an empty queue
    await act(() => server.send({ type: 'agent.history', items: [] }));
    expect(screen.queryByTestId('chat-queued')).toBeNull();
    await ready(server);
  });

  it('keeps a panel answer that the server sends in the same turn, in order, as its own message', async () => {
    const { server } = await start();
    await busy(server);
    await say(server, { kind: 'queue', items: [{ id: 'q1', text: 'tweak the title', chips: [] }] });
    await say(server, { kind: 'user', text: '[panel brief p_1 submitted] ok', chips: [] });
    await say(server, { kind: 'user', text: 'tweak the title', chips: [] });
    await say(server, { kind: 'queue', items: [] });
    expect(screen.getAllByTestId('chat-user').map((e) => e.textContent)).toEqual(['[panel brief p_1 submitted] ok', 'tweak the title']);
  });
});

describe('moved', () => {
  it('moves one id to a place, and leaves the list alone for a place that is not there', () => {
    expect(moved(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(moved(['a', 'b', 'c'], 'a', 1)).toEqual(['b', 'a', 'c']);
    const ids = ['a', 'b'];
    expect(moved(ids, 'a', -1)).toBe(ids);
    expect(moved(ids, 'b', 2)).toBe(ids);
    expect(moved(ids, 'z', 0)).toBe(ids);
  });
});

describe('the Up next tray', () => {
  afterEach(() => vi.useRealTimers());
  const three: AgentEvent = {
    kind: 'queue',
    items: [
      { id: 'q1', text: 'make the title bigger\nand bolder\nthird line', chips: ['Title · frame 0', 'Logo · frame 0'] },
      { id: 'q2', text: 'slow the intro', chips: [] },
      { id: 'q3', text: 'warmer palette', chips: [], images: ['a.png'] },
    ],
  };
  const cards = () => screen.getAllByTestId('chat-queued').map((c) => c.textContent);

  it('is one slim bar when closed, with the count, the first line and the first thumbnails, and opens to a card each', async () => {
    const { server, user } = await start();
    await busy(server);
    await say(server, three);
    const bar = screen.getByTestId('queue-toggle');
    expect(bar).toHaveTextContent('3 up next');
    expect(bar).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('queue-first')).toHaveTextContent(/^make the title bigger$/);
    expect(screen.queryByTestId('chat-queued')).toBeNull();
    await user.click(bar);
    expect(bar).toHaveAttribute('aria-expanded', 'true');
    expect(cards()).toHaveLength(3);
    const first = screen.getAllByTestId('chat-queued')[0]!;
    // the first two lines, and the selection as its first chip plus the rest
    expect(first).toHaveTextContent('make the title bigger');
    expect(first).toHaveTextContent('and bolder');
    expect(first).not.toHaveTextContent('third line');
    expect(within(first).getByTestId('queued-chips')).toHaveTextContent('Title · frame 0 +1');
    expect(within(screen.getAllByTestId('chat-queued')[2]!).getByRole('img')).toHaveAttribute('src', '/api/agent/image?name=a.png');
  });

  it('puts a message back in the prompt box to edit it, with its pictures, and asks the server to take it out', async () => {
    const { server, user } = await start();
    await busy(server);
    await say(server, { kind: 'queue', items: [{ id: 'q9', text: 'tweak it', chips: [], images: ['a.png'] }] });
    await user.click(screen.getByTestId('queue-toggle'));
    await user.click(screen.getByRole('button', { name: /^Edit queued message/ }));
    expect(server.agentMessages.at(-1)).toEqual({ type: 'agent.unqueue', id: 'q9', take: true });
    // nothing moves until the server confirms with the message
    expect(screen.getByLabelText('Message for the agent')).toHaveValue('');
    const fetchMock = vi.fn(async () => new Response(new Blob(['pixels'], { type: 'image/png' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await say(server, { kind: 'unqueued', item: { id: 'q9', text: 'tweak it', chips: [], images: ['a.png'] } });
    await say(server, { kind: 'queue', items: [] });
    expect(screen.getByLabelText('Message for the agent')).toHaveValue('tweak it');
    await waitFor(() => expect(screen.getAllByTestId('image-chip')).toHaveLength(1));
    vi.unstubAllGlobals();
  });

  it('reorders by drag and by keyboard, sending the new order to the server', async () => {
    const { server, user } = await start();
    await busy(server);
    await say(server, three);
    await user.click(screen.getByTestId('queue-toggle'));
    // drag the last card onto the first
    const [c1, , c3] = screen.getAllByTestId('chat-queued');
    const data = { effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(c3!, { dataTransfer: data });
    fireEvent.dragOver(c1!, { dataTransfer: data });
    fireEvent.drop(c1!, { dataTransfer: data });
    expect(server.agentMessages.at(-1)).toEqual({ type: 'agent.requeue', order: ['q3', 'q1', 'q2'] });
    // the keyboard: the grip of the first card, arrow down
    const grips = screen.getAllByRole('button', { name: /^Move queued message/ });
    grips[0]!.focus();
    await user.keyboard('{ArrowDown}');
    expect(server.agentMessages.at(-1)).toEqual({ type: 'agent.requeue', order: ['q2', 'q1', 'q3'] });
    // the first card cannot go up: nothing is sent
    const before = server.agentMessages.length;
    await user.keyboard('{ArrowUp}');
    expect(server.agentMessages.length).toBe(before);
    // the server's answer is what the tray shows
    await say(server, { kind: 'queue', items: [three.items[2]!, three.items[0]!, three.items[1]!] });
    expect(cards()[0]).toContain('warmer palette');
  });

  it('removes one card, and Clear removes them all', async () => {
    const { server, user } = await start();
    await busy(server);
    await say(server, three);
    await user.click(screen.getByTestId('queue-toggle'));
    await user.click(screen.getAllByRole('button', { name: /^Remove queued message/ })[1]!);
    expect(server.agentMessages.at(-1)).toEqual({ type: 'agent.unqueue', id: 'q2' });
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    const gone = server.agentMessages.filter((m) => m.type === 'agent.unqueue').map((m: any) => m.id);
    expect(gone).toEqual(['q2', 'q1', 'q2', 'q3']);
  });

  it('"Send now" waits four seconds for an Undo, then stops the turn and sends that message next', async () => {
    const { server } = await start();
    await busy(server);
    await say(server, three);
    fireEvent.click(screen.getByTestId('queue-toggle'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(screen.getAllByRole('button', { name: /^Send now/ })[1]!);
    expect(screen.getByTestId('send-now-toast')).toHaveTextContent('Undo');
    act(() => void vi.advanceTimersByTime(3900));
    expect(server.agentMessages.some((m) => m.type === 'agent.sendnow')).toBe(false);
    act(() => void vi.advanceTimersByTime(200));
    expect(server.agentMessages.at(-1)).toEqual({ type: 'agent.sendnow', id: 'q2' });
    expect(screen.queryByTestId('send-now-toast')).toBeNull();
    // the rest are still queued
    expect(cards()).toHaveLength(3);
  });

  it('Undo within the four seconds sends nothing', async () => {
    const { server } = await start();
    await busy(server);
    await say(server, three);
    fireEvent.click(screen.getByTestId('queue-toggle'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(screen.getAllByRole('button', { name: /^Send now/ })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.queryByTestId('send-now-toast')).toBeNull();
    act(() => void vi.advanceTimersByTime(10_000));
    expect(server.agentMessages.some((m) => m.type === 'agent.sendnow')).toBe(false);
  });

  it('shows a waiting panel answer in the tray with its panel icon, and it cannot be edited, moved or removed', async () => {
    const { server, user } = await start();
    await busy(server);
    await say(server, {
      kind: 'queue',
      items: [
        { id: 'panel:p_1', text: '[panel brief p_1 submitted] ok', chips: [], panel: 'brief' },
        { id: 'q1', text: 'mine', chips: [] },
      ],
    });
    expect(screen.getByTestId('queue-toggle')).toHaveTextContent('2 up next');
    await user.click(screen.getByTestId('queue-toggle'));
    const panel = screen.getByTestId('chat-queued-panel');
    expect(within(panel).getByTestId('panel-mark')).toHaveAttribute('title', 'Panel answer: brief');
    expect(within(panel).queryByRole('button')).toBeNull();
    expect(panel).not.toHaveAttribute('draggable', 'true');
    // Clear leaves it alone
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(server.agentMessages.filter((m) => m.type === 'agent.unqueue').map((m: any) => m.id)).toEqual(['q1']);
  });
});

describe('tool calls in the chat', () => {
  const tool = (over: Partial<Extract<AgentEvent, { kind: 'tool' }>>): AgentEvent => ({ kind: 'tool', id: 't', title: '', toolKind: 'other', status: 'completed', files: [], ...over });

  it('one block per run of calls, open while the agent works and folded after, with the toggle left to the person', async () => {
    const { server, user } = await start();
    await busy(server);
    await say(server, tool({ id: 'a', toolKind: 'execute', status: 'in_progress', title: 'cd /work && npm test', input: { command: 'cd /work && npm test' } }));
    const group = screen.getByTestId('chat-tool-group');
    expect(within(group).getByTestId('tool-group-label')).toHaveTextContent('Ran 1 command');
    expect(within(group).getAllByRole('img', { name: 'running' })).toHaveLength(2);
    expect(within(group).getByTestId('tool-summary')).toHaveTextContent(/^npm test$/);
    await say(server, tool({ id: 'a', toolKind: 'execute', status: 'completed', ms: 1500 }));
    await say(server, tool({ id: 'b', toolKind: 'read', files: ['src/scene.tsx'] }));
    await say(server, tool({ id: 'c', toolKind: 'execute', input: { command: 'ls /Users/me/notes' } }));
    expect(screen.getAllByTestId('chat-tool-group')).toHaveLength(1);
    expect(screen.getByTestId('tool-group-label')).toHaveTextContent('Ran 2 commands · read 1 file');
    const rows = screen.getAllByTestId('chat-tool');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('1.5s');
    expect(rows[1]).toHaveTextContent('Readsrc/scene.tsx');
    expect(rows[2]).toHaveTextContent('ls ~/notes');
    // done: the block folds
    await say(server, { kind: 'done', stopReason: 'end_turn' });
    await ready(server);
    expect(screen.queryAllByTestId('chat-tool')).toHaveLength(0);
    expect(screen.getByTestId('tool-group-label')).toHaveTextContent('Ran 2 commands · read 1 file');
    await user.click(screen.getByRole('button', { name: /Ran 2 commands/ }));
    expect(screen.getAllByTestId('chat-tool')).toHaveLength(3);
    // a group the person opened stays as they left it when the next turn starts
    await busy(server);
    expect(screen.getAllByTestId('chat-tool')).toHaveLength(3);
  });

  it('a message between calls splits the groups; an earlier group folds once something follows it', async () => {
    const { server } = await start();
    await busy(server);
    await say(server, tool({ id: 'a', toolKind: 'read', files: ['a.ts'] }));
    expect(screen.getAllByTestId('chat-tool')).toHaveLength(1);
    await say(server, { kind: 'message', text: 'Looking.' });
    expect(screen.queryAllByTestId('chat-tool')).toHaveLength(0);
    await say(server, tool({ id: 'b', toolKind: 'search', input: { pattern: 'TODO' } }));
    expect(screen.getAllByTestId('chat-tool-group')).toHaveLength(2);
    expect(screen.getAllByTestId('chat-tool')).toHaveLength(1);
  });

  it('a row opens to the full command and its output without colour codes, a failure shows a red mark', async () => {
    const { server, user } = await start();
    await busy(server);
    await say(
      server,
      tool({
        id: 'a',
        toolKind: 'execute',
        status: 'failed',
        input: { command: 'cd /work && npm test -- --long-flag', description: 'Run the tests' },
        output: '\u001b[31mFAIL\u001b[0m a.test.ts\nexit 1',
      }),
    );
    const row = screen.getByTestId('chat-tool');
    expect(row).toHaveTextContent('Run the tests');
    expect(within(row).getByLabelText('failed')).toBeInTheDocument();
    expect(within(row).queryByTestId('chat-tool-detail')).toBeNull();
    await user.click(within(row).getByRole('button'));
    expect(within(row).getByTestId('tool-command')).toHaveTextContent('cd /work && npm test -- --long-flag');
    const output = within(row).getByTestId('tool-output');
    expect(output.textContent).toBe('FAIL a.test.ts\nexit 1');
    expect(output.className).toMatch(/max-h-/);
    expect(output.className).toMatch(/overflow-auto/);
  });

  it('shows an edit with its counts and a compact diff, and keeps the kind when an update leaves it out', async () => {
    const { server, user } = await start();
    await busy(server);
    await say(server, tool({ id: 'e', toolKind: 'edit', status: 'in_progress', files: ['src/scene.tsx'] }));
    await say(server, tool({ id: 'e', toolKind: 'other', status: 'completed', diffs: [{ path: 'src/scene.tsx', added: 2, removed: 1, lines: [' keep', '-old', '+new', '+newer'] }] }));
    const row = screen.getByTestId('chat-tool');
    expect(row).toHaveAttribute('data-kind', 'edit');
    expect(row).toHaveTextContent('Editsrc/scene.tsx+2 −1');
    await user.click(within(row).getByRole('button'));
    const diff = within(row).getByTestId('tool-diff');
    expect(within(diff).getByText('+new')).toBeInTheDocument();
    expect(within(diff).getByText('-old')).toBeInTheDocument();
  });

  it('shortens a long path in the middle, keeping the file name, with the whole path as the tooltip', async () => {
    const { server } = await start();
    await busy(server);
    const long = 'packages/studio/ui/src/components/agent/some/deeply/nested/directory/agent-panel.tsx';
    await say(server, tool({ id: 'r', toolKind: 'read', files: [long] }));
    const summary = screen.getByTestId('tool-summary');
    expect(summary.textContent).toContain('…');
    expect(summary.textContent!.endsWith('agent-panel.tsx')).toBe(true);
    expect(within(screen.getByTestId('chat-tool')).getByRole('button')).toHaveAttribute('title', long);
  });
});
