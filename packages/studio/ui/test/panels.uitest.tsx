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
      custom: stand('custom', { values: {} }),
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

  it('shows one title and one message in the host header, and a docked review the same', async () => {
    const { server } = await start();
    push(server, { type: 'panel', panel: panel({ panel: 'storyboard', id: 'p_2', message: 'Five shots.' }) });
    const sheet = await screen.findByTestId('panel-sheet');
    expect(within(sheet).getAllByRole('heading', { name: 'Storyboard' })).toHaveLength(1);
    expect(within(sheet).getAllByText('Five shots.')).toHaveLength(1);
    push(server, { type: 'panel', panel: panel({ panel: 'review', id: 'p_3', data: { comp: 'Intro' }, message: 'Notes on pacing?', openedAt: 2 }) });
    const dock = await screen.findByTestId('panel-dock');
    expect(within(dock).getAllByRole('heading', { name: 'Review' })).toHaveLength(1);
    expect(within(dock).getAllByText('Notes on pacing?')).toHaveLength(1);
  });

  it('covers the preview and the timeline with the sheet, and keeps the stepper in a row of its own above them', async () => {
    const { server } = await start();
    push(server, { type: 'panel', panel: panel({ panel: 'storyboard', id: 'p_2' }) });
    const sheet = await screen.findByTestId('panel-sheet');
    const preview = screen.getByLabelText('Preview');
    const timeline = screen.getByLabelText('Timeline');
    const column = sheet.parentElement!;
    expect(column.contains(preview)).toBe(true);
    expect(column.contains(timeline)).toBe(true);
    expect(preview.contains(sheet)).toBe(false);
    const stepper = screen.getByTestId('stage-stepper');
    expect(preview.contains(stepper)).toBe(false);
    expect(column.contains(stepper)).toBe(false);
  });

  it('shows an approved stage read-only from the stepper, with no way to answer it again', async () => {
    const { server, user } = await start();
    const answer = { shots: [{ id: 's1', frame: 0, what: 'a wide shot', moves: '', seconds: 3, transition: 'match-cut' }], removed: [], notes: [{ shot: 's1', text: 'hold it longer' }], approved: true };
    push(server, { type: 'panel', panel: panel({ panel: 'storyboard', id: 'p_2', message: 'Five shots.', status: 'submitted', answer: answer as never }) });
    expect(stage('Board')).toHaveAttribute('data-state', 'approved');
    // Nothing comes up by itself for an answered panel.
    expect(screen.queryByTestId('panel-sheet')).not.toBeInTheDocument();
    await user.click(stage('Board'));
    const sheet = await screen.findByTestId('panel-sheet');
    expect(within(sheet).getByRole('heading', { name: 'Storyboard' })).toBeInTheDocument();
    expect(within(sheet).getByText('Approved')).toBeInTheDocument();
    const view = within(sheet).getByTestId('answer-view');
    expect(view).toHaveTextContent('a wide shot, 3 s, then match cut');
    expect(view).toHaveTextContent('s1: hold it longer');
    expect(within(sheet).queryByTestId('stand-in-storyboard')).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /Send|Approve/ })).not.toBeInTheDocument();
    expect(stage('Board')).toHaveAttribute('aria-current', 'step');
    await user.click(stage('Board'));
    expect(screen.queryByTestId('panel-sheet')).not.toBeInTheDocument();
  });

  it('keeps every stage label only for the stage on show, so a narrow row stays short', async () => {
    const { server } = await start();
    push(server, { type: 'panel', panel: panel({ panel: 'storyboard', id: 'p_2' }) });
    await screen.findByTestId('panel-sheet');
    const labelOf = (name: string) => stage(name).querySelector('span:not([aria-hidden])')!;
    expect(labelOf('Board').className).not.toContain('hidden');
    expect(labelOf('Script').className).toContain('hidden');
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

const custom = (id: string, name: string, over: Partial<OpenPanel> = {}) =>
  panel({ panel: 'custom', id, data: { name, title: `Title ${name}`, blocks: [] }, openedAt: Number(id.slice(2)), ...over });

describe('where a panel is placed', () => {
  const agentColumn = () => screen.getByRole('region', { name: 'Agent' });
  const inspector = () => screen.getByRole('region', { name: 'Inspector' });

  it('shows a review beside the preview and the others as a sheet by default, and any kind where it is told', async () => {
    const { server } = await start();
    push(server, { type: 'panel', panel: panel({ panel: 'review', id: 'p_1', data: { comp: 'Intro' }, placement: 'sheet' }) });
    expect(await screen.findByTestId('panel-sheet')).toContainElement(screen.getByTestId('stand-in-review'));
    expect(screen.queryByTestId('panel-dock')).not.toBeInTheDocument();
    push(server, { type: 'panel', panel: panel({ panel: 'brief', id: 'p_2', placement: 'beside-preview', openedAt: 2 }) });
    const dock = await screen.findByTestId('panel-dock');
    expect(dock).toHaveAccessibleName('Brief');
    expect(within(dock).getByTestId('stand-in-brief')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-sheet')).not.toBeInTheDocument();
    expect(screen.getByTestId('preview-canvas')).toBeInTheDocument();
  });

  it('puts a panel placed left in a tab beside the agent, selected at once, and keeps the chat', async () => {
    const { server, user } = await start();
    expect(within(agentColumn()).queryByRole('tab')).not.toBeInTheDocument();
    push(server, { type: 'panel', panel: panel({ id: 'p_1', placement: 'left', message: 'Is this right?' }) });
    const tab = await within(agentColumn()).findByRole('tab', { name: 'Brief' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(within(agentColumn()).getByRole('tab', { name: 'Agent' })).toHaveAttribute('aria-selected', 'false');
    const frame = within(agentColumn()).getByTestId('panel-frame');
    expect(within(frame).getByTestId('stand-in-brief')).toBeInTheDocument();
    expect(within(frame).getByTestId('panel-message')).toHaveTextContent('Is this right?');
    expect(screen.queryByTestId('panel-sheet')).not.toBeInTheDocument();
    expect(stage('Brief')).toHaveAttribute('data-state', 'open');
    // The chat is still mounted under its own tab, so what was typed in it is kept.
    expect(screen.getByTestId('agent-panel')).toBeInTheDocument();
    await user.click(within(agentColumn()).getByRole('tab', { name: 'Agent' }));
    expect(within(agentColumn()).getByRole('tab', { name: 'Agent' })).toHaveAttribute('aria-selected', 'true');
    // The stage brings the tab back; answering closes it and the column is its own again.
    await user.click(stage('Brief'));
    expect(await within(agentColumn()).findByRole('tab', { name: 'Brief' })).toHaveAttribute('aria-selected', 'true');
    await user.click(within(agentColumn()).getByRole('button', { name: 'Send brief' }));
    expect(server.panelMessages).toEqual([{ type: 'panel.submit', id: 'p_1', answer: { purpose: 'p' } }]);
    push(server, { type: 'panel.closed', id: 'p_1', status: 'submitted', panel: panel({ status: 'submitted', answer: { purpose: 'p' } as never, placement: 'left' }) });
    await waitFor(() => expect(within(agentColumn()).queryByRole('tab')).not.toBeInTheDocument());
    expect(screen.getByTestId('agent-panel')).toBeVisible();
  });

  it('puts a panel placed right in a tab beside the inspector tabs, which stay', async () => {
    const { server, user } = await start();
    push(server, { type: 'panel', panel: panel({ id: 'p_1', placement: 'right' }) });
    const tab = await within(inspector()).findByRole('tab', { name: 'Brief' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(within(inspector()).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Props', 'Scene', 'Renders', 'Brief']);
    expect(within(inspector()).getByTestId('stand-in-brief')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-sheet')).not.toBeInTheDocument();
    // The inspector's own tabs still work, and the panel's tab can be gone back to.
    await user.click(within(inspector()).getByRole('tab', { name: 'Scene' }));
    expect(within(inspector()).getByRole('tab', { name: 'Scene' })).toHaveAttribute('aria-selected', 'true');
    await user.click(stage('Brief'));
    expect(within(inspector()).getByRole('tab', { name: 'Brief' })).toHaveAttribute('aria-selected', 'true');
    await user.click(within(inspector()).getByRole('button', { name: 'Back to the tabs' }));
    // Back to the inspector tab the person was on.
    expect(within(inspector()).getByRole('tab', { name: 'Scene' })).toHaveAttribute('aria-selected', 'true');
    expect(within(inspector()).getByRole('tab', { name: 'Brief' })).toBeInTheDocument();
  });

  it('opens a column that was folded away when a panel is placed in it', async () => {
    const { server, user } = await start();
    await user.click(screen.getByRole('button', { name: 'Hide the inspector' }));
    expect(screen.queryByRole('region', { name: 'Inspector' })).not.toBeInTheDocument();
    push(server, { type: 'panel', panel: panel({ id: 'p_1', placement: 'right' }) });
    expect(await within(screen.getByRole('region', { name: 'Inspector' })).findByRole('tab', { name: 'Brief' })).toBeInTheDocument();
  });

  it('keeps tabs for several panels in a column, and a sheet panel does not take over the tab', async () => {
    const { server } = await start();
    push(server, { type: 'panel', panel: custom('p_1', 'one', { placement: 'left' }) });
    push(server, { type: 'panel', panel: custom('p_2', 'two', { placement: 'left' }) });
    push(server, { type: 'panel', panel: panel({ panel: 'storyboard', id: 'p_3', openedAt: 3 }) });
    await screen.findByTestId('panel-sheet');
    const tabs = within(agentColumn()).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Agent', 'Title one', 'Title two']);
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true');
  });
});

describe('custom panels in the stepper', () => {
  const pills = () => screen.getAllByTestId('custom-pill');

  it('shows each custom panel as a pill after Deliver, not as a stage, and brings it back', async () => {
    const { server, user } = await start();
    push(server, { type: 'panel', panel: custom('p_1', 'one') });
    const sheet = await screen.findByTestId('panel-sheet');
    expect(within(sheet).getByRole('heading', { name: 'Title one' })).toBeInTheDocument();
    expect(Array.from(screen.getByTestId('stage-stepper').querySelectorAll('[data-stage]')).map((b) => b.getAttribute('data-state'))).toEqual(Array(7).fill('empty'));
    const nav = screen.getByTestId('stage-stepper');
    expect(nav.children[6]).toBe(stage('Deliver'));
    expect(pills().map((p) => [p.textContent, p.getAttribute('data-state')])).toEqual([['Title one', 'open']]);
    expect(nav.compareDocumentPosition(pills()[0]!) & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeTruthy();
    // Put away, then brought back from the pill.
    await user.click(screen.getByRole('button', { name: 'Put the panel away' }));
    expect(screen.queryByTestId('panel-sheet')).not.toBeInTheDocument();
    await user.click(pills()[0]!);
    expect(await screen.findByTestId('stand-in-custom')).toBeInTheDocument();
  });

  it('keeps several open when their names differ, and a new one with the same name takes the pill', async () => {
    const { server } = await start();
    push(server, { type: 'panel', panel: custom('p_1', 'one') });
    push(server, { type: 'panel', panel: custom('p_2', 'two') });
    expect(pills().map((p) => p.getAttribute('data-name'))).toEqual(['one', 'two']);
    push(server, { type: 'panel.closed', id: 'p_1', status: 'dismissed', panel: custom('p_1', 'one', { status: 'dismissed' }) });
    push(server, { type: 'panel', panel: custom('p_3', 'one') });
    await waitFor(() => expect(pills().map((p) => p.getAttribute('data-name'))).toEqual(['two', 'one']));
  });

  it('shows what was sent from its pill, read-only', async () => {
    const { server, user } = await start();
    const data = { name: 'one', title: 'Pick', blocks: [{ id: 'pick', type: 'choice', label: 'Which?', options: [{ id: 'a', label: 'Plain' }] }] };
    push(server, { type: 'panel', panel: custom('p_1', 'one', { data: data as never, status: 'submitted', answer: { values: { pick: 'a' } } as never }) });
    expect(pills()[0]).toHaveAttribute('data-state', 'answered');
    expect(screen.queryByTestId('panel-sheet')).not.toBeInTheDocument();
    await user.click(pills()[0]!);
    const sheet = await screen.findByTestId('panel-sheet');
    expect(within(sheet).getByText('Sent')).toBeInTheDocument();
    expect(within(sheet).getByTestId('answer-view')).toHaveTextContent('Which?Plain');
    expect(within(sheet).getByTestId('answer-view')).toHaveTextContent('plan/custom-one.json');
  });

  it('keeps the last three as pills and the older ones in a +n menu', async () => {
    const { server, user } = await start();
    for (const n of [1, 2, 3, 4, 5]) push(server, { type: 'panel', panel: custom(`p_${n}`, `n${n}`, { placement: 'right' }) });
    expect(pills().map((p) => p.getAttribute('data-name'))).toEqual(['n3', 'n4', 'n5']);
    await user.click(screen.getByTestId('custom-more'));
    expect(screen.getByTestId('custom-more')).toHaveTextContent('+2');
    await user.click(await screen.findByRole('menuitem', { name: 'Title n1' }));
    const inspector = screen.getByRole('region', { name: 'Inspector' });
    expect(within(inspector).getByRole('tab', { name: 'Title n1' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('the chat', () => {
  it('shows a message the studio sent the agent for the person as theirs', () => {
    const state = reduceChat(emptyChat, { kind: 'user', text: '[panel brief p_1 dismissed]' });
    expect(state.items).toMatchObject([{ kind: 'user', text: '[panel brief p_1 dismissed]', chips: [] }]);
  });
});
