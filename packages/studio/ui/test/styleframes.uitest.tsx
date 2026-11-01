import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StyleframesPanel } from '../src/components/panels/styleframes-panel';
import type { OpenPanel, StyleframesAnswer } from '../src/components/panels/types';

const frames = [
  { id: 'a', label: 'Serif display', comp: 'Intro', frame: 30, note: 'warm grade' },
  { id: 'b', label: 'Mono and neon', comp: 'Outro', frame: 12 },
  { id: 'c', label: 'Paper', comp: 'Intro', frame: 90 },
];

function panelOf(overrides: Partial<OpenPanel<'styleframes'>> = {}): OpenPanel<'styleframes'> {
  return { id: 'p1', panel: 'styleframes', data: { frames }, message: null, status: 'open', answer: null, openedAt: 0, ...overrides };
}

function setup(overrides: Partial<OpenPanel<'styleframes'>> = {}) {
  const onSubmit = vi.fn<(answer: StyleframesAnswer) => void>();
  const onDismiss = vi.fn();
  render(<StyleframesPanel panel={panelOf(overrides)} onSubmit={onSubmit} onDismiss={onDismiss} />);
  return { onSubmit, onDismiss };
}

/** The still is 1920 by 1080 in composition pixels, drawn 480 by 270 at the page's origin. */
function load(id: string) {
  const still = screen.getByTestId(`still-${id}`);
  const img = within(still).getByRole('img', { hidden: true });
  img.getBoundingClientRect = () => ({ left: 0, top: 0, right: 480, bottom: 270, width: 480, height: 270, x: 0, y: 0, toJSON() {} });
  fireEvent.load(img);
  return still;
}

function drag(still: HTMLElement, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(still, { clientX: from[0], clientY: from[1], button: 0, pointerId: 1 });
  fireEvent.pointerMove(still, { clientX: to[0], clientY: to[1], pointerId: 1 });
  fireEvent.pointerUp(still, { clientX: to[0], clientY: to[1], pointerId: 1 });
}

let width: PropertyDescriptor | undefined;
let height: PropertyDescriptor | undefined;
beforeEach(() => {
  width = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalWidth');
  height = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalHeight');
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 1920 });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => 1080 });
});
afterEach(() => {
  if (width) Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', width);
  if (height) Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', height);
});

describe('StyleframesPanel', () => {
  it('asks for each frame of its composition at full size, with its label and note', () => {
    setup({ message: 'Three looks for the intro' });
    const srcs = screen.getAllByRole('img', { hidden: true }).map((img) => img.getAttribute('src'));
    expect(srcs).toEqual([
      '/api/frame?comp=Intro&frame=30&scale=1&format=jpeg',
      '/api/frame?comp=Outro&frame=12&scale=1&format=jpeg',
      '/api/frame?comp=Intro&frame=90&scale=1&format=jpeg',
    ]);
    expect(screen.getByText('Three looks for the intro')).toBeInTheDocument();
    expect(screen.getByText('Serif display')).toBeInTheDocument();
    expect(screen.getByText('warm grade')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Pick B' })).toBeInTheDocument();
  });

  it('picks one frame at a time, and picking again moves the pick', async () => {
    const { onSubmit } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Pick A' }));
    expect(screen.getByRole('radio', { name: 'Pick A' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('radio', { name: 'Pick C' }));
    expect(screen.getByRole('radio', { name: 'Pick A' })).toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onSubmit).toHaveBeenCalledWith({ pick: 'c', notes: [], approved: true });
  });

  it('picks a frame by clicking its still', () => {
    const { onSubmit } = setup();
    const still = load('b');
    fireEvent.pointerDown(still, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(still, { clientX: 101, clientY: 100, pointerId: 1 });
    expect(screen.getByRole('radio', { name: 'Pick B' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onSubmit).toHaveBeenCalledWith({ pick: 'b', notes: [], approved: true });
  });

  it('a mix clears the pick and goes out as the answer', async () => {
    const { onSubmit } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Pick A' }));
    await user.type(screen.getByLabelText('Or mix them'), "A's type, B's colours");
    expect(screen.getByRole('radio', { name: 'Pick A' })).toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onSubmit).toHaveBeenCalledWith({ pick: null, mix: "A's type, B's colours", notes: [], approved: true });
  });

  it('a drag draws a box in composition pixels and opens its note', async () => {
    const { onSubmit } = setup();
    const user = userEvent.setup();
    const still = load('a');
    // 480 px wide shows 1920: every displayed pixel is 4 composition pixels.
    drag(still, [50, 25], [150, 75]);
    expect(screen.getByTestId('box-a-1')).toBeInTheDocument();
    const note = screen.getByLabelText('Note 1 on A');
    expect(note).toHaveFocus();
    await user.type(note, 'Headline too small');
    await user.click(screen.getByRole('radio', { name: 'Pick A' }));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onSubmit).toHaveBeenCalledWith({
      pick: 'a',
      notes: [{ frame: 'a', text: 'Headline too small', box: { x: 200, y: 100, w: 400, h: 200 } }],
      approved: true,
    });
  });

  it('draws the box whichever way it is dragged and keeps it inside the picture', async () => {
    const { onSubmit } = setup();
    const user = userEvent.setup();
    const still = load('b');
    drag(still, [600, 300], [440, 200]);
    await user.type(screen.getByLabelText('Note 1 on B'), 'crop');
    await user.click(screen.getByRole('button', { name: 'Another round' }));
    expect(onSubmit).toHaveBeenCalledWith({ pick: null, notes: [{ frame: 'b', text: 'crop', box: { x: 1760, y: 800, w: 160, h: 280 } }], approved: false });
  });

  it('allows a note without a box, and keeps notes under their own frame', async () => {
    const { onSubmit } = setup();
    const user = userEvent.setup();
    const frameB = within(screen.getByTestId('styleframe-b'));
    await user.click(frameB.getByRole('button', { name: /Add note/ }));
    await user.type(frameB.getByLabelText('Note 1 on B'), 'Too busy overall');
    expect(within(screen.getByTestId('styleframe-a')).queryByLabelText('Note 1 on A')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Another round' }));
    expect(onSubmit).toHaveBeenCalledWith({ pick: null, notes: [{ frame: 'b', text: 'Too busy overall' }], approved: false });
  });

  it('edits and removes notes, and drops the empty ones', async () => {
    const { onSubmit } = setup();
    const user = userEvent.setup();
    const frameA = within(screen.getByTestId('styleframe-a'));
    await user.click(frameA.getByRole('button', { name: /Add note/ }));
    await user.type(frameA.getByLabelText('Note 1 on A'), 'first');
    await user.click(frameA.getByRole('button', { name: /Add note/ }));
    await user.type(frameA.getByLabelText('Note 2 on A'), 'second');
    await user.click(frameA.getByRole('button', { name: /Add note/ }));
    await user.clear(frameA.getByLabelText('Note 1 on A'));
    await user.type(frameA.getByLabelText('Note 1 on A'), 'first, reworded');
    await user.click(frameA.getByRole('button', { name: 'Remove note 2 on A' }));
    expect(frameA.getByLabelText('Note 2 on A')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Another round' }));
    expect(onSubmit).toHaveBeenCalledWith({ pick: null, notes: [{ frame: 'a', text: 'first, reworded' }], approved: false });
  });

  it('removing a boxed note takes its box off the frame', async () => {
    setup();
    const user = userEvent.setup();
    drag(load('a'), [10, 10], [60, 60]);
    expect(screen.getByTestId('box-a-1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove note 1 on A' }));
    expect(screen.queryByTestId('box-a-1')).not.toBeInTheDocument();
  });

  it('does not start a box before the picture has loaded', () => {
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 0 });
    setup();
    drag(screen.getByTestId('still-a'), [10, 10], [100, 100]);
    expect(screen.queryByLabelText('Note 1 on A')).not.toBeInTheDocument();
  });

  it('will not approve without a pick or a mix, but another round needs neither', async () => {
    const { onSubmit } = setup();
    const user = userEvent.setup();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    await user.type(screen.getByLabelText('Or mix them'), '   ');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Another round' }));
    expect(onSubmit).toHaveBeenCalledWith({ pick: null, notes: [], approved: false });
    await user.type(screen.getByLabelText('Or mix them'), 'B with A');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('dismisses', async () => {
    const { onDismiss, onSubmit } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('starts from the saved answer when the panel is reopened', () => {
    setup({
      status: 'submitted',
      answer: { pick: 'b', notes: [{ frame: 'b', text: 'kerning', box: { x: 10, y: 20, w: 30, h: 40 } }], approved: true },
    });
    expect(screen.getByRole('radio', { name: 'Pick B' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Note 1 on B')).toHaveValue('kerning');
  });

  it('shows a message in place of a frame that fails to draw', () => {
    setup();
    fireEvent.error(within(screen.getByTestId('still-c')).getByRole('img', { hidden: true }));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not draw Intro at frame 90.');
  });
});
