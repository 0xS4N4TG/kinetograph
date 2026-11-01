import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StoryboardPanel } from '../src/components/panels/storyboard-panel';
import type { OpenPanel, Shot, StoryboardAnswer } from '../src/components/panels/types';

const shot = (id: string, frame: number, extra: Partial<Shot> = {}): Shot => ({
  id,
  frame,
  what: `what ${id}`,
  moves: `moves ${id}`,
  line: `line ${id}`,
  seconds: 2,
  transition: 'cut',
  ...extra,
});

function open(shots: Shot[], extra: Record<string, unknown> = {}): OpenPanel<'storyboard'> {
  return {
    id: 'p_1',
    panel: 'storyboard',
    data: { comp: 'Storyboard', shots, ...extra },
    message: null,
    status: 'open',
    answer: null,
    openedAt: 0,
  };
}

const three = () => [shot('s1', 0), shot('s2', 30), shot('s3', 60)];

function start(panel = open(three())) {
  const onSubmit = vi.fn<(answer: StoryboardAnswer) => void>();
  const onDismiss = vi.fn();
  const user = userEvent.setup();
  render(<StoryboardPanel panel={panel} onSubmit={onSubmit} onDismiss={onDismiss} />);
  const answer = (): StoryboardAnswer => onSubmit.mock.calls.at(-1)![0];
  return { user, onSubmit, onDismiss, answer };
}

const order = () => screen.getAllByRole('article').map((el) => el.getAttribute('data-shot'));

afterEach(() => vi.restoreAllMocks());

describe('StoryboardPanel', () => {
  it('shows the shots in order with a still of each one\'s frame from the board composition', () => {
    start();
    expect(order()).toEqual(['s1', 's2', 's3']);
    const srcs = screen.getAllByRole('img').map((img) => img.getAttribute('src')!);
    expect(srcs).toHaveLength(3);
    [0, 30, 60].forEach((frame, i) => {
      const url = new URL(srcs[i]!, 'http://studio.test');
      expect(url.pathname).toBe('/api/thumbnail');
      expect(url.searchParams.get('comp')).toBe('Storyboard');
      expect(url.searchParams.get('frame')).toBe(String(frame));
    });
    expect(screen.getByLabelText('What is on screen in shot 2')).toHaveValue('what s2');
    expect(screen.getByLabelText('What moves in shot 2')).toHaveValue('moves s2');
    expect(screen.getByLabelText('Script line of shot 2')).toHaveValue('line s2');
    expect(screen.getByLabelText('Length of shot 2 in seconds')).toHaveValue(2);
    // a chip sits under each card but the last, and the cards lay out in a grid of their own columns
    expect(screen.getAllByTestId('transition-chip')).toHaveLength(2);
  });

  it('shows the transition as a chip with its name, sized to its text, that is still the select', async () => {
    const { user } = start();
    const chip = screen.getAllByTestId('transition-chip')[0]!;
    expect(chip).toHaveTextContent('cut');
    expect(chip.className).toContain('w-fit');
    expect(chip.parentElement?.tagName).toBe('LI');
    await user.selectOptions(within(chip).getByRole('combobox', { name: 'Transition after shot 1' }), 'match-cut');
    expect(chip).toHaveTextContent('match cut');
    expect(screen.queryByRole('heading', { name: 'Storyboard' })).not.toBeInTheDocument();
  });

  it('reorders with the move buttons and reports the new order', async () => {
    const { user, answer } = start();
    await user.click(screen.getByRole('button', { name: 'Move shot 1 right' }));
    expect(order()).toEqual(['s2', 's1', 's3']);
    await user.click(screen.getByRole('button', { name: 'Move shot 3 left' }));
    expect(order()).toEqual(['s2', 's3', 's1']);
    expect(screen.getByRole('button', { name: 'Move shot 1 left' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move shot 3 right' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(answer().shots.map((s) => s.id)).toEqual(['s2', 's3', 's1']);
  });

  it('reorders by dragging a card\'s handle onto another', () => {
    const rects: Record<string, number> = { s1: 0, s2: 300, s3: 600 };
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const x = rects[this.getAttribute('data-shot') ?? ''] ?? 0;
      return { x, y: 0, left: x, top: 0, right: x + 256, bottom: 200, width: 256, height: 200, toJSON: () => ({}) } as DOMRect;
    });
    const { onSubmit } = start();
    const handle = screen.getByRole('button', { name: 'Drag shot 1' });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 700, clientY: 100 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 700, clientY: 100 });
    expect(order()).toEqual(['s2', 's3', 's1']);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onSubmit.mock.calls[0]![0].shots.map((s) => s.id)).toEqual(['s2', 's3', 's1']);
  });

  /** Cards 300 px apart along x by their place in the grid, as in the drag test, and by their place for the offsets. */
  function layOut() {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const x = ({ s1: 0, s2: 300, s3: 600 } as Record<string, number>)[this.getAttribute('data-shot') ?? ''] ?? 0;
      return { x, y: 0, left: x, top: 0, right: x + 256, bottom: 200, width: 256, height: 200, toJSON: () => ({}) } as DOMRect;
    });
  }
  const slot = (el: HTMLElement) => (el.parentElement ? Array.from(el.parentElement.children).indexOf(el) * 300 : 0);
  function stubOffsets() {
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
      return this.tagName === 'LI' ? slot(this) : 0;
    });
  }
  function stubAnimate() {
    const animate = vi.fn(() => ({ onfinish: null, oncancel: null, cancel() {} }));
    Object.defineProperty(Element.prototype, 'animate', { configurable: true, writable: true, value: animate });
    return animate;
  }
  function stubReducedMotion(reduce: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduce && query.includes('reduce'), media: query }));
  }
  afterEach(() => {
    delete (Element.prototype as { animate?: unknown }).animate;
    vi.unstubAllGlobals();
  });

  it('lifts the grabbed card under the pointer and puts it back in place on release', () => {
    layOut();
    start();
    const handle = screen.getByRole('button', { name: 'Drag shot 1' });
    const li = screen.getByRole('article', { name: 'Shot 1' }).parentElement!;
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    expect(screen.getByRole('article', { name: 'Shot 1' }).className).toContain('scale-[1.03]');
    expect(li.style.zIndex).toBe('20');
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 60, clientY: 90 });
    expect(li.style.transform).toBe('translate(50px, 80px)');
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 60, clientY: 90 });
    expect(li.style.transform).toBe('');
    expect(li.style.zIndex).toBe('');
    expect(screen.getByRole('article', { name: 'Shot 1' }).className).not.toContain('scale-[1.03]');
  });

  it('goes back to the old order on Escape and on pointer cancel', () => {
    layOut();
    const { onSubmit } = start();
    const handle = screen.getByRole('button', { name: 'Drag shot 1' });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 700, clientY: 100 });
    expect(order()).toEqual(['s2', 's3', 's1']);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(order()).toEqual(['s1', 's2', 's3']);
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 700, clientY: 100 });
    expect(order()).toEqual(['s1', 's2', 's3']);

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400, clientY: 100 });
    expect(order()).toEqual(['s2', 's1', 's3']);
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    expect(order()).toEqual(['s1', 's2', 's3']);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onSubmit.mock.calls[0]![0].shots.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('slides the cards that moved when the order changes, and not when reduced motion is asked for', async () => {
    stubOffsets();
    const animate = stubAnimate();
    stubReducedMotion(false);
    const { user } = start();
    await user.click(screen.getByRole('button', { name: 'Move shot 1 right' }));
    expect(order()).toEqual(['s2', 's1', 's3']);
    // s2 was at 300 and is now at 0, s1 the other way round; s3 stayed
    const slid = animate.mock.calls.map((c) => (c as unknown as [Keyframe[]])[0]!.map((k) => k.transform));
    expect(slid).toHaveLength(2);
    expect(slid).toContainEqual(['translate(300px, 0px)', 'translate(0px, 0px)']);
    expect(slid).toContainEqual(['translate(-300px, 0px)', 'translate(0px, 0px)']);
  });

  it('changes the order at once with no animation under prefers-reduced-motion, and the drag still works', async () => {
    layOut();
    stubOffsets();
    const animate = stubAnimate();
    stubReducedMotion(true);
    const { user } = start();
    await user.click(screen.getByRole('button', { name: 'Move shot 1 right' }));
    await user.click(screen.getByRole('button', { name: 'Add a shot after shot 1' }));
    expect(order()).toEqual(['s2', 's4', 's1', 's3']);
    const handle = screen.getByRole('button', { name: 'Drag shot 1' });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 40, clientY: 50 });
    // still the same card, wherever the order put it, and it follows the pointer
    const grabbed = document.querySelector<HTMLElement>('[data-shot="s2"]')!.parentElement!;
    expect(grabbed.style.transform).toMatch(/^translate\(/);
    expect(order()).toContain('s2');
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 40, clientY: 50 });
    expect(animate).not.toHaveBeenCalled();
  });

  it('shows a skeleton over each still until it has loaded, and keeps the image element', () => {
    start();
    const card = screen.getByRole('article', { name: 'Shot 1' });
    const img = within(card).getByRole('img');
    expect(card.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(card.querySelector('[data-slot="skeleton"]')!.className).toContain('motion-reduce:animate-none');
    fireEvent.load(img);
    expect(card.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(within(card).getByRole('img')).toBe(img);
  });

  it('records a removed shot, and a shot added here and removed again is not reported', async () => {
    const { user, answer } = start();
    await user.click(screen.getByRole('button', { name: 'Remove shot 2' }));
    expect(order()).toEqual(['s1', 's3']);
    await user.click(screen.getByRole('button', { name: 'Add a shot after shot 1' }));
    const added = order()[1]!;
    expect(added).not.toBe('s2');
    await user.click(screen.getByRole('button', { name: 'Remove shot 2' }));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(answer().removed).toEqual(['s2']);
    expect(answer().shots.map((s) => s.id)).toEqual(['s1', 's3']);
  });

  it('adds an empty shot with a new id and the neighbour\'s frame', async () => {
    const { user, answer } = start();
    await user.click(screen.getByRole('button', { name: 'Add a shot after shot 2' }));
    expect(order()).toEqual(['s1', 's2', 's4', 's3']);
    const added = screen.getByRole('article', { name: 'Shot 3' });
    expect(within(added).getByLabelText('What is on screen in shot 3')).toHaveValue('something here');
    await user.click(screen.getByRole('button', { name: 'Add shot' }));
    expect(order().slice(-1)).toEqual(['s5']);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const [, , s4, , s5] = answer().shots;
    expect(s4).toMatchObject({ id: 's4', frame: 30, what: 'something here', moves: '' });
    expect(s5).toMatchObject({ id: 's5', frame: 60 });
  });

  it('puts edits, transitions and comments in the answer', async () => {
    const { user, answer } = start();
    const what = screen.getByLabelText('What is on screen in shot 1');
    await user.clear(what);
    await user.type(what, 'a wide');
    const length = screen.getByLabelText('Length of shot 2 in seconds');
    await user.clear(length);
    await user.type(length, '3.5');
    await user.selectOptions(screen.getByLabelText('Transition after shot 1'), 'other');
    await user.type(screen.getByLabelText('Transition note for shot 1'), 'spin');
    await user.click(screen.getByRole('button', { name: 'Comment on shot 3' }));
    await user.type(screen.getByLabelText('Your comment on shot 3'), '  too slow ');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const a = answer();
    expect(a.shots[0]).toMatchObject({ id: 's1', what: 'a wide', transition: 'other', transitionNote: 'spin' });
    expect(a.shots[1]!.seconds).toBe(3.5);
    expect(a.notes).toEqual([{ shot: 's3', text: 'too slow' }]);
    expect(a.removed).toEqual([]);
  });

  it('totals the lengths and flags an overrun of the brief\'s target', async () => {
    const { user } = start(open(three(), { targetSeconds: 5 }));
    expect(screen.getByTestId('total')).toHaveTextContent('3 shots, 6 s of 5 s');
    expect(screen.getByTestId('overrun')).toHaveTextContent('1 s over');
    await user.click(screen.getByRole('button', { name: 'Remove shot 3' }));
    expect(screen.getByTestId('total')).toHaveTextContent('2 shots, 4 s of 5 s');
    expect(screen.queryByTestId('overrun')).toBeNull();
  });

  it('shows only the total when no target is known', () => {
    start();
    expect(screen.getByTestId('total')).toHaveTextContent('3 shots, 6 s');
    expect(screen.getByTestId('total')).not.toHaveTextContent('of');
    expect(screen.queryByTestId('overrun')).toBeNull();
  });

  it('approves, sends back for rework, or dismisses', async () => {
    const { user, onSubmit, onDismiss, answer } = start();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(answer().approved).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Rework and show me again' }));
    expect(answer().approved).toBe(false);
    expect(onSubmit).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
