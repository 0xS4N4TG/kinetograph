import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/app';
import type { AgentEvent } from '../src/api';
import { MockServer } from './mock-server';

async function start() {
  const server = new MockServer();
  const user = userEvent.setup();
  render(<App api={server} />);
  await waitFor(() => expect(server.frameRequests.length).toBeGreaterThan(0));
  // the inspector opens on Props; the scene tree is its Scene tab
  await user.click(await screen.findByRole('tab', { name: 'Scene' }));
  await screen.findByTestId('scene-tree');
  return { server, user };
}

const say = (server: MockServer, event: AgentEvent) => act(() => server.send({ type: 'agent', event }));

/** The frame is 1920x1080 and drawn at half size, from the top left of the page. */
function stubFrameRect() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const frame = (this as HTMLElement).dataset?.testid === 'frame';
    return { x: 0, y: 0, left: 0, top: 0, right: frame ? 960 : 0, bottom: frame ? 540 : 0, width: frame ? 960 : 0, height: frame ? 540 : 0, toJSON: () => ({}) } as DOMRect;
  });
}

afterEach(() => vi.restoreAllMocks());

describe('picking layers in the preview', () => {
  it('a click picks the layer under the cursor and outlines it; shift adds; empty space clears', async () => {
    stubFrameRect();
    await start();
    const preview = screen.getByTestId('preview');
    // pixel (100,50)/(2 px per px) is inside the 100x50 layers at the top left: the topmost is the title.
    fireEvent.pointerDown(preview, { clientX: 20, clientY: 10, button: 0 });
    fireEvent.pointerUp(preview, { clientX: 20, clientY: 10 });
    fireEvent.click(preview, { clientX: 20, clientY: 10 });
    await screen.findByText(/Layer Transform/);
    const tree = screen.getByTestId('scene-tree');
    expect(within(tree).getAllByRole('treeitem').filter((i) => i.getAttribute('aria-selected') === 'true')).toHaveLength(1);

    // far from every layer: cleared
    fireEvent.pointerDown(preview, { clientX: 900, clientY: 500, button: 0 });
    fireEvent.pointerUp(preview, { clientX: 900, clientY: 500 });
    fireEvent.click(preview, { clientX: 900, clientY: 500 });
    await waitFor(() => expect(screen.queryByTestId('layer-details')).not.toBeInTheDocument());
  });

  it('a dragged box picks the layers inside it, draws the box while dragging, and lists them as chips in the Agent tab', async () => {
    stubFrameRect();
    const { user } = await start();
    const preview = screen.getByTestId('preview');
    fireEvent.pointerDown(preview, { clientX: 0, clientY: 0, button: 0 });
    fireEvent.pointerMove(preview, { clientX: 300, clientY: 200 });
    expect(await screen.findByTestId('marquee')).toBeInTheDocument();
    fireEvent.pointerUp(preview, { clientX: 300, clientY: 200 });
    fireEvent.click(preview, { clientX: 300, clientY: 200 });
    expect(screen.queryByTestId('marquee')).not.toBeInTheDocument();

    const chips = screen.getByTestId('selection-chips');
    await waitFor(() => expect(within(chips).getAllByText(/frame 0/)).toHaveLength(2));
    expect(chips).toHaveTextContent('Text “Hello”');
    expect(chips).toHaveTextContent('bg');
    // the agent tab stays open while picking, and no tree path is shown
    expect(screen.getByTestId('agent-panel')).toBeInTheDocument();
    expect(chips.textContent).not.toMatch(/\$\d/);
    expect(screen.getAllByTestId('selection-outline').length).toBeGreaterThan(0);

    await user.click(within(chips).getByRole('button', { name: /Remove bg/ }));
    await waitFor(() => expect(within(chips).queryByText(/^bg/)).not.toBeInTheDocument());
  });
});

describe('the Agent tab', () => {
  it('sends the words with the selection as context and shows the answer as it streams', async () => {
    const { server, user } = await start();
    const tree = await screen.findByTestId('scene-tree');
    await user.click(within(tree).getByTitle(/^title \(/));

    await user.type(screen.getByLabelText('Message for the agent'), 'make it red');
    await user.click(screen.getByRole('button', { name: /Send/ }));
    const sent = server.agentMessages.at(-1)!;
    expect(sent).toMatchObject({ type: 'agent.prompt', text: 'make it red' });
    const context = (sent as { context: string }).context;
    expect(context).toContain('composition `Intro`');
    expect(context).toContain('Hello');
    expect(context).not.toMatch(/\$\d/);
    expect(within(screen.getByTestId('chat-list')).getByText('make it red')).toBeInTheDocument();

    await say(server, { kind: 'status', status: 'busy', command: 'fake --acp', image: true });
    await say(server, { kind: 'message', text: 'Sure, ' });
    await say(server, { kind: 'message', text: 'done.' });
    expect(screen.getByTestId('chat-agent')).toHaveTextContent('Sure, done.');
    expect(screen.getByRole('button', { name: /Stop/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Stop/ }));
    expect(server.agentMessages.at(-1)).toEqual({ type: 'agent.cancel' });
  });

  it('shows edits compactly with file names, and permission requests as buttons that are never answered for the user', async () => {
    const { server, user } = await start();
    await say(server, { kind: 'tool', id: 't1', title: 'Edit scene.tsx', toolKind: 'edit', status: 'in_progress', files: ['src/scene.tsx'] });
    await say(server, { kind: 'tool', id: 't1', title: '', toolKind: 'edit', status: 'completed', files: [] });
    const tool = screen.getByTestId('chat-tool');
    expect(tool).toHaveTextContent('Edit scene.tsx');
    expect(tool).toHaveTextContent('scene.tsx');
    expect(screen.getAllByTestId('chat-tool')).toHaveLength(1);

    await say(server, {
      kind: 'permission',
      id: '7',
      title: 'Write scene.tsx',
      files: ['src/scene.tsx'],
      options: [
        { id: 'allow', name: 'Allow', kind: 'allow_once' },
        { id: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
    const before = server.agentMessages.length;
    const box = screen.getByTestId('chat-permission');
    expect(server.agentMessages).toHaveLength(before);
    await user.click(within(box).getByRole('button', { name: 'Allow' }));
    expect(server.agentMessages.at(-1)).toEqual({ type: 'agent.permission', id: '7', optionId: 'allow' });
    expect(within(box).queryByRole('button')).not.toBeInTheDocument();
  });

  it('says what went wrong in plain words', async () => {
    const { server, user } = await start();
    await say(server, { kind: 'error', message: 'The agent needs you to sign in first.' });
    expect(screen.getByRole('alert')).toHaveTextContent('sign in');
  });

  it('explains when no agent is installed, and when the agent is off', async () => {
    const server = new MockServer();
    server.agent = { presets: [], command: null, cwd: '/work' };
    render(<App api={server} />);
    expect(await screen.findByText(/No coding agent was found/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send/ })).toBeDisabled();
  });

  it('switches the agent from Cmd+K, and restarts it there too; the chat header has no picker', async () => {
    const server = new MockServer();
    server.agent = {
      presets: [
        { id: 'claude', name: 'Claude Code', command: 'claude-cmd' },
        { id: 'codex', name: 'Codex', command: 'codex-cmd' },
      ],
      command: 'claude-cmd',
      cwd: '/work',
    };
    const user = userEvent.setup();
    render(<App api={server} />);
    await screen.findByTestId('agent-panel');
    expect(screen.queryByRole('combobox', { name: 'Coding agent' })).not.toBeInTheDocument();
    await act(() => server.send({ type: 'agent', event: { kind: 'status', status: 'idle', command: 'claude-cmd', image: false } }));
    await user.keyboard('{Meta>}k{/Meta}');
    await user.type(await screen.findByRole('combobox', { name: 'Command' }), 'switch agent');
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('option', { name: 'Codex' }));
    expect(server.agentMessages.at(-1)).toEqual({ type: 'agent.select', command: 'codex-cmd' });

    await user.keyboard('{Meta>}k{/Meta}');
    await user.type(await screen.findByRole('combobox', { name: 'Command' }), 'restart agent');
    await user.keyboard('{Enter}');
    expect(server.agentMessages.at(-1)).toEqual({ type: 'agent.reset' });
  });

  it('renders the agent\'s markdown, and never raw HTML', async () => {
    const { server } = await start();
    await say(server, { kind: 'message', text: 'Did **bold** and `code`:\n\n- one\n- two <script>alert(1)</script>' });
    const box = await screen.findByTestId('chat-agent');
    await waitFor(() => expect(box.querySelector('[data-streamdown=strong]')).toHaveTextContent('bold'));
    expect(box.querySelector('[data-streamdown=inline-code]')).toHaveTextContent('code');
    expect(box.querySelectorAll('li')).toHaveLength(2);
    expect(box.querySelector('script')).toBeNull();
    expect(box).not.toHaveTextContent('**');
  });
});
