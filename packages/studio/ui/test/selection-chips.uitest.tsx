import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import type { InspectResult } from '../src/api';
import { AgentPanel } from '../src/components/agent/agent-panel';
import { buildChatContext } from '../src/lib/chat-context';
import { emptyChat } from '../src/lib/chat';
import { selectionChips } from '../src/lib/chips';
import type { InspectLayer } from '../src/lib/inspect';
import { chipText, ellipsizeMiddle, rangeLabel } from '../src/lib/selection';
import type { Chat } from '../src/lib/use-chat';
import { intro, introTimeline, layer } from './fixtures';

const shape = (n: number): InspectLayer => layer(`s${n}`, 'shape', { label: 'Shape', ...(n > 1 ? { ordinal: n } : {}) } as Partial<InspectLayer>);
const text = (id: string): InspectLayer => layer(id, 'text', { label: `Title ${id}` } as Partial<InspectLayer>);
const many = (n: number): InspectLayer[] => Array.from({ length: n }, (_, i) => shape(i + 1));

const chat: Chat = {
  state: emptyChat,
  send: () => true,
  unqueue: () => undefined,
  take: () => undefined,
  requeue: () => undefined,
  sendNow: () => undefined,
  answer: () => undefined,
  stop: () => undefined,
  restart: () => undefined,
  chooseAgent: () => undefined,
  loadInfo: async () => null,
};

function Host({ layers, range = null }: { layers: InspectLayer[]; range?: { start: number; end: number } | null }) {
  const [selected, setSelected] = useState(layers.map((l) => l.id));
  const inspect = { frame: 0, layers } as unknown as InspectResult;
  return (
    <AgentPanel
      comp={intro}
      project={{ entry: '/work/scene.tsx', cwd: '/work', version: '0', buildId: 1, buildError: null }}
      inspect={inspect}
      selectedLayers={selected}
      selectLayers={setSelected}
      lastImage={() => null}
      range={range}
      chat={chat}
      timeline={null}
    />
  );
}

describe('the frame wording', () => {
  it('a span of one frame, or of none, is "frame N"', () => {
    expect(rangeLabel({ start: 0, end: 0 }, 30)).toBe('frame 0');
    expect(rangeLabel({ start: 12, end: 12 }, 30)).toBe('frame 12');
    expect(rangeLabel({ start: 30, end: 75 }, 30)).toBe('0:01.0–0:02.5 (frames 30–75)');
  });

  it('cuts a long name in the middle, keeping both ends', () => {
    const name = 'A very long layer name that goes on and on, ending in Shape 8';
    const cut = ellipsizeMiddle(name, 24);
    expect(cut).toHaveLength(24);
    expect(cut.startsWith('A very')).toBe(true);
    expect(cut.endsWith('Shape 8')).toBe(true);
    expect(chipText({ id: 'x', type: 'shape', label: name } as unknown as InspectLayer, 3)).toContain('…');
  });
});

describe('the chips', () => {
  it('one chip per layer up to three; more fold a kind with many layers into one', () => {
    const three = selectionChips(many(3), many(3).map((l) => l.id), 'showcase', ' · frame 0');
    expect(three.map((c) => c.kind)).toEqual(['layer', 'layer', 'layer']);
    const layers = [...many(28), text('a'), text('b')];
    const chips = selectionChips(layers, layers.map((l) => l.id), 'showcase', ' · frame 0');
    expect(chips.map((c) => c.text)).toEqual(['28 shapes in showcase · frame 0', 'a', 'b']);
    expect(chips[0]!.ids).toHaveLength(28);
  });
});

describe('the selection chips in the prompt box', () => {
  it('draws three chips and "+N more" for many different layers, and the popover lists all of them with Clear all', async () => {
    const user = userEvent.setup();
    const layers = Array.from({ length: 7 }, (_, i) => (i % 2 ? shape(i + 1) : text(`t${i}`)));
    // 4 texts + 3 shapes: texts fold (4), shapes stay single => 1 group + 3 layers = 4 chips
    render(<Host layers={layers} />);
    const area = screen.getByTestId('selection-chips');
    expect(within(area).getAllByTestId(/^chip-(group|layer)$/)).toHaveLength(3);
    const more = within(area).getByTestId('chip-more');
    expect(more).toHaveTextContent('+1 more');
    await user.click(more);
    const pop = await screen.findByTestId('chip-popover');
    expect(pop).toHaveTextContent('7 selected');
    expect(within(pop).getByText(/4 texts in Intro/)).toBeInTheDocument();
    // a group opens to its layers
    await user.click(within(pop).getByRole('button', { name: /^4 texts/ }));
    expect(within(pop).getByText('Title t0 · frame 0')).toBeInTheDocument();
    await user.click(within(pop).getByRole('button', { name: 'Remove Title t0 · frame 0' }));
    expect(screen.getByTestId('chip-popover')).toHaveTextContent('6 selected');
    await user.click(within(pop).getByRole('button', { name: 'Clear all' }));
    expect(within(screen.getByTestId('selection-chips')).queryByTestId('chip-more')).toBeNull();
    expect(screen.getByTestId('selection-chips')).toHaveTextContent('Nothing selected');
  });

  it('shows 30 shapes as one chip that scrolls rather than grows, and names the frame as "frame 0"', async () => {
    const user = userEvent.setup();
    render(<Host layers={many(30)} range={{ start: 0, end: 0 }} />);
    const area = screen.getByTestId('selection-chips');
    expect(within(area).getAllByTestId('chip-group')).toHaveLength(1);
    expect(area).toHaveTextContent('30 shapes in Intro · frame 0');
    expect(area).not.toHaveTextContent('0:00.0');
    expect(area.className).toMatch(/max-h-/);
    expect(area.className).toMatch(/overflow-y-auto/);
    await user.click(within(area).getByRole('button', { name: /^30 shapes/ }));
    await user.click(within(await screen.findByTestId('chip-popover')).getByRole('button', { name: /Remove 30 shapes/ }));
    expect(screen.queryByTestId('chip-group')).toBeNull();
  });
});

describe('the context for many layers', () => {
  const base = { entry: '/repo/index.tsx', cwd: '/repo', comp: { ...intro, id: 'showcase' }, frame: 0, timeline: introTimeline };

  it('folds 28 shapes into one line with the first 20 names, and keeps the other layers in full', () => {
    const layers = [...many(28), text('a')];
    const out = buildChatContext({ ...base, layers });
    expect(out).toContain('Selected layers (29)');
    const line = out.split('\n').find((l) => l.startsWith('28 shapes'))!;
    expect(line).toContain('in showcase at frame 0');
    expect(line).toContain('Shape, Shape 2');
    expect(line).toContain('and 8 more');
    expect(line).not.toContain('Shape 28');
    expect(out).toContain('1. "Title a", a text layer');
    expect(out.split('\n').length).toBeLessThan(10);
  });

  it('leaves a handful of layers as one full line each, and caps a long tail of different ones', () => {
    const few = buildChatContext({ ...base, layers: many(5) });
    expect(few.split('\n').filter((l) => /^\d+\. /.test(l))).toHaveLength(5);
    const mixed: InspectLayer[] = Array.from({ length: 30 }, (_, i) => layer(`k${i}`, `kind${i}`, { label: `Thing ${i}` } as Partial<InspectLayer>));
    const out = buildChatContext({ ...base, layers: mixed });
    expect(out.split('\n').filter((l) => /^\d+\. /.test(l))).toHaveLength(20);
    expect(out).toContain('and 10 more: Thing 20');
  });
});
