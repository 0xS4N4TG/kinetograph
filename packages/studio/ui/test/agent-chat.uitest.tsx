import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { App } from '../src/app';
import type { AgentEvent } from '../src/api';
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
    const queued = screen.getByTestId('chat-queued');
    expect(queued).toHaveTextContent('Queued');
    expect(queued).toHaveTextContent('first thing');
    expect(screen.queryByTestId('chat-user')).toBeNull();
    expect(screen.getByTestId('queue-count')).toHaveTextContent('1');

    await user.type(box, 'second thing{Enter}');
    expect(prompts(server)).toHaveLength(2);
    await say(server, { kind: 'queue', items: [{ id: 'q1', text: 'first thing', chips: [] }, { id: 'q2', text: 'second thing', chips: [] }] });
    expect(screen.getAllByTestId('chat-queued')).toHaveLength(2);
    expect(screen.getByTestId('queue-count')).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: 'Send (2 queued)' })).toBeInTheDocument();

    // the turn ends: the server sends both as one prompt, shows each as the person's message, and empties the queue
    await say(server, { kind: 'user', text: 'first thing', chips: [] });
    await say(server, { kind: 'user', text: 'second thing', chips: [] });
    await say(server, { kind: 'queue', items: [] });
    expect(screen.queryByTestId('chat-queue')).toBeNull();
    expect(screen.queryByTestId('queue-count')).toBeNull();
    expect(screen.getAllByTestId('chat-user').map((e) => e.textContent)).toEqual(['first thing', 'second thing']);
  });

  it('removes a queued message by asking the server, and Stop leaves the queue alone', async () => {
    const { server, user } = await start();
    await busy(server);
    await say(server, { kind: 'queue', items: [{ id: 'q1', text: 'do this later', chips: ['Title · frame 0'] }] });
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
    const { server } = await start();
    await act(() => server.send({ type: 'agent.history', items: [{ kind: 'user', text: 'earlier', chips: [] }] }));
    await say(server, { kind: 'queue', items: [{ id: 'q3', text: 'still waiting', chips: [] }] });
    expect(screen.getByTestId('chat-user')).toHaveTextContent('earlier');
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
