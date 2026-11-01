import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { App } from '../src/app';
import type { OpenPanel } from '../src/api';
import { reduceChat, emptyChat } from '../src/lib/chat';
import { MockServer } from './mock-server';

// The panels themselves are other components' work: the host is tested with stand-ins that answer and dismiss.
vi.mock('../src/components/panels/registry', () => {
  const stand =
    (name: string, answer: unknown) =>
    ({ panel, onSubmit, onDismiss }: { panel: OpenPanel; onSubmit: (answer: never) => void; onDismiss: () => void }) => (
      <div data-testid={`stand-in-${name}`}>
        {name} {panel.id}
        <button onClick={() => onSubmit(answer as never)}>Send {name}</button>
        <button onClick={onDismiss}>Close {name}</button>
      </div>
    );
  return {
    panelComponents: {
      brief: stand('brief', { purpose: 'p' }),
      script: stand('script', { approved: true }),
      storyboard: stand('storyboard', { approved: true }),
      styleframes: stand('styleframes', { approved: true }),
      review: stand('review', { verdict: 'approved', notes: [] }),
    },
  };
});

const panel = (over: Partial<OpenPanel>): OpenPanel => ({ id: 'p_1', panel: 'brief', data: {}, message: null, status: 'open', answer: null, openedAt: 1, ...over }) as OpenPanel;

async function start() {
  const server = new MockServer();
  const user = userEvent.setup();
  render(<App api={server} />);
  await waitFor(() => expect(server.frameRequests.length).toBeGreaterThan(0));
  return { server, user };
}
const push = (server: MockServer, message: Parameters<MockServer['send']>[0]) => act(() => server.send(message));
const stage = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

describe('the panel host', () => {
  it('shows nothing until a panel is opened', async () => {
    await start();
    expect(screen.queryByTestId('stage-stepper')).not.toBeInTheDocument();
    expect(screen.queryByTestId('panel-sheet')).not.toBeInTheDocument();
  });

  it('shows the registry component of an open panel as a sheet over the preview, with the message above it', async () => {
    const { server } = await start();
    push(server, { type: 'panel', panel: panel({ id: 'p_7', message: 'Is this right?' }) });
    const sheet = await screen.findByTestId('panel-sheet');
    expect(within(sheet).getByTestId('stand-in-brief')).toHaveTextContent('brief p_7');
    expect(within(sheet).getByTestId('panel-message')).toHaveTextContent('Is this right?');
    expect(screen.getByTestId('preview-canvas')).toBeInTheDocument();
    expect(stage('Brief')).toHaveAttribute('data-state', 'open');
    expect(stage('Board')).toHaveAttribute('data-state', 'empty');
  });

  it('sends panel.submit with the answer, and closes when the server confirms, leaving the stage approved', async () => {
    const { server, user } = await start();
    push(server, { type: 'panel', panel: panel({}) });
    await user.click(await screen.findByRole('button', { name: 'Send brief' }));
    expect(server.panelMessages).toEqual([{ type: 'panel.submit', id: 'p_1', answer: { purpose: 'p' } }]);
    // The sheet stays until the server says so.
    expect(screen.getByTestId('panel-sheet')).toBeInTheDocument();
    push(server, { type: 'panel.closed', id: 'p_1', status: 'submitted', panel: panel({ status: 'submitted', answer: { purpose: 'p' } as never }) });
    await waitFor(() => expect(screen.queryByTestId('panel-sheet')).not.toBeInTheDocument());
    expect(stage('Brief')).toHaveAttribute('data-state', 'approved');
  });

  it('sends panel.dismiss, and drops a panel the server replaced', async () => {
    const { server, user } = await start();
    push(server, { type: 'panel', panel: panel({}) });
    await user.click(await screen.findByRole('button', { name: 'Close brief' }));
    expect(server.panelMessages).toEqual([{ type: 'panel.dismiss', id: 'p_1' }]);
    push(server, { type: 'panel.closed', id: 'p_1', status: 'dismissed', panel: panel({ status: 'dismissed' }) });
    await waitFor(() => expect(screen.queryByTestId('panel-sheet')).not.toBeInTheDocument());
    expect(screen.queryByTestId('stage-stepper')).not.toBeInTheDocument();
  });

  it('puts a panel away and brings it back from the stepper', async () => {
    const { server, user } = await start();
    push(server, { type: 'panel', panel: panel({ panel: 'storyboard', id: 'p_2' }) });
    await screen.findByTestId('panel-sheet');
    await user.click(screen.getByRole('button', { name: 'Put the panel away' }));
    expect(screen.queryByTestId('panel-sheet')).not.toBeInTheDocument();
    expect(stage('Board')).toHaveAttribute('data-state', 'open');
    await user.click(stage('Board'));
    expect(await screen.findByTestId('stand-in-storyboard')).toBeInTheDocument();
    // Clicking a stage that waits for nothing does nothing.
    await user.click(stage('Style'));
    expect(screen.getByTestId('stand-in-storyboard')).toBeInTheDocument();
  });

  it('docks a review beside the preview instead of covering it', async () => {
    const { server } = await start();
    push(server, { type: 'panel', panel: panel({ panel: 'review', id: 'p_3', data: { comp: 'Intro' } }) });
    const dock = await screen.findByTestId('panel-dock');
    expect(within(dock).getByTestId('stand-in-review')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-sheet')).not.toBeInTheDocument();
    expect(screen.getByTestId('preview-canvas')).toBeInTheDocument();
    expect(stage('Animatic')).toHaveAttribute('data-state', 'open');
  });

  it('shows why an answer was refused, and starts from nothing when the socket comes back', async () => {
    const { server } = await start();
    push(server, { type: 'panel', panel: panel({}) });
    await screen.findByTestId('panel-sheet');
    push(server, { type: 'panel.error', id: 'p_1', message: 'the answer is not valid: audience must be text' });
    expect(await screen.findByRole('alert')).toHaveTextContent('audience must be text');
    // A reconnect: hello, then only the panels the server still keeps.
    push(server, { type: 'hello', version: '0.1.0', buildId: 1, buildError: null });
    await waitFor(() => expect(screen.queryByTestId('panel-sheet')).not.toBeInTheDocument());
  });
});

describe('the chat', () => {
  it('shows a message the studio sent the agent for the person as theirs', () => {
    const state = reduceChat(emptyChat, { kind: 'user', text: '[panel brief p_1 dismissed]' });
    expect(state.items).toMatchObject([{ kind: 'user', text: '[panel brief p_1 dismissed]', chips: [] }]);
  });
});
