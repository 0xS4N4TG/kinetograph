import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnswerView } from '../src/components/panels/answer-view';
import { CustomPanel } from '../src/components/panels/custom-panel';
import type { Block, CustomAnswer, CustomDraft, OpenPanel } from '../src/components/panels/types';

const blocks: Block[] = [
  { id: 'intro', type: 'heading', text: 'Pick the end card' },
  { id: 'why', type: 'text', text: 'First **bold** words.\n\nSecond paragraph.', help: 'Read this first' },
  { id: 'still', type: 'still', comp: 'End', frame: 12, caption: 'The current card' },
  { id: 'clip', type: 'clip', comp: 'End', from: 10, to: 40, caption: 'The reveal' },
  {
    id: 'pick',
    type: 'choice',
    label: 'Which card?',
    required: true,
    options: [
      { id: 'a', label: 'Plain', still: { comp: 'End', frame: 40 } },
      { id: 'b', label: 'Loud', text: 'with a flash', still: { comp: 'End', frame: 90 } },
    ],
  },
  { id: 'tags', type: 'choice', label: 'Mood', multiple: true, options: [{ id: 'calm', label: 'Calm' }, { id: 'bold', label: 'Bold' }, { id: 'odd', text: 'Odd' }] },
  { id: 'speed', type: 'slider', label: 'Logo speed', min: 0.5, max: 2, value: 1, unit: 'x' },
  { id: 'note', type: 'input', label: 'Anything else?', placeholder: 'Say it' },
  { id: 'long', type: 'input', label: 'Longer', multiline: true, value: 'start' },
  { id: 'todo', type: 'list', label: 'To do', items: ['one', 'two'], editable: true },
  { id: 'fixed', type: 'list', label: 'Fixed', items: ['alpha'] },
  { id: 'grid', type: 'table', label: 'Ratings', columns: ['Shot', 'Score'], rows: [['1', '3'], ['2', '']], editable: true },
  { id: 'marks', type: 'notes', label: 'Marks', still: { comp: 'End', frame: 40 } },
  { id: 'ab', type: 'compare', label: 'Which is better?', a: { comp: 'End', frame: 1, label: 'Old' }, b: { comp: 'End', frame: 2 } },
];

const draftOf = (over: Partial<CustomDraft> = {}): CustomDraft => ({ name: 'end-card', title: 'Pick the end card', blocks, ...over });
const panelOf = (over: Partial<OpenPanel<'custom'>> = {}): OpenPanel<'custom'> => ({ id: 'p1', panel: 'custom', data: draftOf(), message: null, status: 'open', answer: null, openedAt: 0, ...over });

function setup(over: Partial<OpenPanel<'custom'>> = {}) {
  const onSubmit = vi.fn<(answer: CustomAnswer) => void>();
  const onDismiss = vi.fn();
  render(<CustomPanel panel={panelOf(over)} onSubmit={onSubmit} onDismiss={onDismiss} />);
  return { onSubmit, onDismiss, user: userEvent.setup() };
}
/** Moves the fake clock and lets React render what the timers set. */
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const block = (id: string) => screen.getByTestId(`block-${id}`);
const send = () => screen.getByRole('button', { name: 'Send' });

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

describe('CustomPanel blocks', () => {
  it('draws a heading, markdown-lite text, a still and a clip', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Pick the end card', level: 3 })).toBeInTheDocument();
    const text = block('why');
    expect(within(text).getAllByText(/./, { selector: 'p' }).map((p) => p.textContent)).toEqual(['First bold words.', 'Second paragraph.', 'Read this first']);
    expect(text.querySelector('strong')).toHaveTextContent('bold');
    // Not HTML: markup in the text stays text.
    const still = within(block('still')).getByRole('img', { hidden: true });
    expect(still).toHaveAttribute('src', '/api/frame?comp=End&frame=12&scale=0.5&format=jpeg');
    expect(within(block('still')).getByText('The current card')).toBeInTheDocument();
    expect(within(block('still')).getByTestId('frame-skeleton')).toBeInTheDocument();
    fireEvent.load(still);
    expect(within(block('still')).queryByTestId('frame-skeleton')).not.toBeInTheDocument();
    const clip = within(block('clip')).getByRole('img', { hidden: true });
    expect(clip).toHaveAttribute('src', '/api/frame?comp=End&frame=10&scale=0.5&format=jpeg');
    expect(within(block('clip')).getByText('The reveal')).toBeInTheDocument();
  });

  it('keeps text as text', () => {
    setup({ data: draftOf({ blocks: [{ id: 't', type: 'text', text: '<b>x</b> and **y**' }] }) });
    expect(block('t').querySelector('b')).toBeNull();
    expect(block('t')).toHaveTextContent('<b>x</b> and y');
  });

  it('plays a clip in place: steps through its frames once each has loaded, and scrubs', async () => {
    vi.useFakeTimers();
    try {
      setup();
      const clip = block('clip');
      const img = within(clip).getByRole('img', { hidden: true });
      fireEvent.load(img);
      fireEvent.click(within(clip).getByRole('button', { name: 'Play' }));
      expect(within(clip).getByRole('button', { name: 'Pause' })).toBeInTheDocument();
      // 30 fps shown at about 6 a second: every fifth frame, a fifth of a second apart.
      await advance(200);
      expect(within(clip).getByRole('img', { hidden: true })).toHaveAttribute('src', '/api/frame?comp=End&frame=15&scale=0.5&format=jpeg');
      // The next picture is not asked for until this one has loaded.
      await advance(1000);
      expect(within(clip).getByRole('img', { hidden: true })).toHaveAttribute('src', '/api/frame?comp=End&frame=15&scale=0.5&format=jpeg');
      fireEvent.load(within(clip).getByRole('img', { hidden: true }));
      await advance(200);
      expect(within(clip).getByRole('img', { hidden: true })).toHaveAttribute('src', '/api/frame?comp=End&frame=20&scale=0.5&format=jpeg');
      fireEvent.click(within(clip).getByRole('button', { name: 'Pause' }));
      expect(within(clip).getByRole('button', { name: 'Play' })).toBeInTheDocument();
      fireEvent.change(within(clip).getByRole('slider', { hidden: true }), { target: { value: '30' } });
      expect(within(clip).getByRole('img', { hidden: true })).toHaveAttribute('src', '/api/frame?comp=End&frame=30&scale=0.5&format=jpeg');
    } finally {
      vi.useRealTimers();
    }
  });

  it('picks one option, or several with multiple, and shows the pictures with skeletons', async () => {
    const { onSubmit, user } = setup();
    const pick = block('pick');
    expect(within(pick).getAllByRole('img', { hidden: true }).map((i) => i.getAttribute('src'))).toEqual([
      '/api/frame?comp=End&frame=40&scale=0.5&format=jpeg',
      '/api/frame?comp=End&frame=90&scale=0.5&format=jpeg',
    ]);
    expect(within(pick).getAllByTestId('frame-skeleton')).toHaveLength(2);
    expect(within(pick).getByText('with a flash')).toBeInTheDocument();
    await user.click(within(pick).getByRole('radio', { name: 'Plain' }));
    await user.click(within(pick).getByRole('radio', { name: 'Loud' }));
    expect(within(pick).getByRole('radio', { name: 'Plain' })).toHaveAttribute('aria-checked', 'false');
    expect(within(pick).getByRole('radio', { name: 'Loud' })).toHaveAttribute('aria-checked', 'true');
    const tags = block('tags');
    await user.click(within(tags).getByRole('checkbox', { name: 'Bold' }));
    await user.click(within(tags).getByRole('checkbox', { name: 'Calm' }));
    await user.click(within(tags).getByRole('checkbox', { name: 'Bold' }));
    await user.click(within(tags).getByRole('checkbox', { name: 'Odd' }));
    await user.click(send());
    const values = onSubmit.mock.calls[0]![0].values;
    expect(values.pick).toBe('b');
    expect(values.tags).toEqual(['calm', 'odd']);
  });

  it('moves a slider, and types into a line and a text area', async () => {
    const { onSubmit, user } = setup();
    expect(screen.getByTestId('value-speed')).toHaveTextContent('1.00 x');
    const range = within(block('speed')).getByRole('slider', { hidden: true });
    fireEvent.change(range, { target: { value: '1.25' } });
    expect(screen.getByTestId('value-speed')).toHaveTextContent('1.25 x');
    await user.type(screen.getByPlaceholderText('Say it'), 'faster');
    const long = screen.getByLabelText('Longer');
    expect(long).toHaveValue('start');
    await user.type(long, '!');
    await user.click(within(block('pick')).getByRole('radio', { name: 'Plain' }));
    await user.click(send());
    const values = onSubmit.mock.calls[0]![0].values;
    expect(values.speed).toBe(1.25);
    expect(values.note).toBe('faster');
    expect(values.long).toBe('start!');
  });

  it('edits a list: add, change, remove and reorder; a fixed list is only shown', async () => {
    const { onSubmit, user } = setup();
    const list = block('todo');
    await user.click(within(list).getByRole('button', { name: 'Add item' }));
    await user.type(within(list).getByLabelText('To do, item 3'), 'three');
    await user.click(within(list).getByRole('button', { name: 'Move item 3 up' }));
    await user.click(within(list).getByRole('button', { name: 'Remove item 1' }));
    await user.click(within(list).getByRole('button', { name: 'Add item' })); // left blank: not sent
    expect(within(list).getByRole('button', { name: 'Move item 1 up' })).toBeDisabled();
    expect(within(block('fixed')).getByText('alpha')).toBeInTheDocument();
    expect(within(block('fixed')).queryByRole('textbox')).not.toBeInTheDocument();
    await user.click(within(block('pick')).getByRole('radio', { name: 'Plain' }));
    await user.click(send());
    expect(onSubmit.mock.calls[0]![0].values.todo).toEqual(['three', 'two']);
    expect(onSubmit.mock.calls[0]![0].values.fixed).toEqual(['alpha']);
  });

  it('edits a table: cells, add a row, remove a row', async () => {
    const { onSubmit, user } = setup();
    const grid = block('grid');
    await user.type(within(grid).getByLabelText('Ratings, row 2, Score'), '5');
    await user.click(within(grid).getByRole('button', { name: 'Add row' }));
    await user.type(within(grid).getByLabelText('Ratings, row 3, Shot'), '3');
    await user.click(within(grid).getByRole('button', { name: 'Remove row 1' }));
    await user.click(within(block('pick')).getByRole('radio', { name: 'Plain' }));
    await user.click(send());
    expect(onSubmit.mock.calls[0]![0].values.grid).toEqual([['2', '5'], ['3', '']]);
  });

  it('pins notes on a picture: a box and a whole-frame note', async () => {
    const { onSubmit, user } = setup();
    const marks = block('marks');
    const picture = within(marks).getByTestId('picture-marks');
    const img = within(picture).getByRole('img', { hidden: true });
    img.getBoundingClientRect = () => ({ left: 0, top: 0, right: 480, bottom: 270, width: 480, height: 270, x: 0, y: 0, toJSON() {} });
    fireEvent.load(img);
    fireEvent.pointerDown(picture, { clientX: 10, clientY: 20, button: 0, pointerId: 1 });
    fireEvent.pointerMove(picture, { clientX: 110, clientY: 120, pointerId: 1 });
    fireEvent.pointerUp(picture, { clientX: 110, clientY: 120, pointerId: 1 });
    expect(within(picture).getByTestId('box-marks-1')).toBeInTheDocument();
    await user.type(within(marks).getByLabelText('Note 1'), 'the logo');
    await user.click(within(marks).getByRole('button', { name: 'Add note' }));
    await user.type(within(marks).getByLabelText('Note 2'), 'overall');
    await user.click(within(marks).getByRole('button', { name: 'Add note' })); // blank: not sent
    await user.click(within(block('pick')).getByRole('radio', { name: 'Plain' }));
    await user.click(send());
    // 480 by 270 shown is a quarter of 1920 by 1080: the box is in composition pixels.
    expect(onSubmit.mock.calls[0]![0].values.marks).toEqual([{ text: 'the logo', box: { x: 40, y: 80, w: 400, h: 400 } }, { text: 'overall' }]);
  });

  it('compares two pictures and takes a pick', async () => {
    const { onSubmit, user } = setup();
    const ab = block('ab');
    expect(within(ab).getAllByRole('img', { hidden: true }).map((i) => i.getAttribute('src'))).toEqual([
      '/api/frame?comp=End&frame=1&scale=0.5&format=jpeg',
      '/api/frame?comp=End&frame=2&scale=0.5&format=jpeg',
    ]);
    await user.click(within(ab).getByRole('radio', { name: 'A, Old' }));
    await user.click(within(ab).getByRole('radio', { name: 'B' }));
    expect(within(ab).getByRole('radio', { name: 'B' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(block('pick')).getByRole('radio', { name: 'Plain' }));
    await user.click(send());
    expect(onSubmit.mock.calls[0]![0].values.ab).toBe('b');
  });
});

describe('CustomPanel answers', () => {
  it('sends a value for every input block, from the values the agent gave, and none for the display blocks', async () => {
    const { onSubmit, user } = setup();
    await user.click(within(block('pick')).getByRole('radio', { name: 'Plain' }));
    await user.click(send());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toEqual({
      values: {
        pick: 'a',
        tags: [],
        speed: 1,
        note: '',
        long: 'start',
        todo: ['one', 'two'],
        fixed: ['alpha'],
        grid: [['1', '3'], ['2', '']],
        marks: [],
        ab: null,
      },
    });
  });

  it('keeps the button off until each required block has a value, and says what is missing', async () => {
    const { onSubmit, user } = setup({
      data: draftOf({
        submitLabel: 'Done',
        blocks: [
          { id: 'one', type: 'input', label: 'Name', required: true },
          { id: 'two', type: 'choice', label: 'Kind', required: true, options: [{ id: 'a', label: 'A' }] },
          { id: 'three', type: 'input', label: 'Optional' },
        ],
      }),
    });
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('2 blocks need a value.');
    await user.type(screen.getByLabelText('Name'), '  ');
    expect(done).toBeDisabled();
    await user.type(screen.getByLabelText('Name'), 'x');
    expect(screen.getByRole('status')).toHaveTextContent('Kind needs a value.');
    expect(done).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'A' }));
    expect(done).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await user.click(done);
    expect(onSubmit).toHaveBeenCalledWith({ values: { one: '  x', two: 'a', three: '' } });
  });

  it('starts from the values the agent gave and counts them as filled', () => {
    setup({ data: draftOf({ blocks: [{ id: 'c', type: 'choice', required: true, value: 'a', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] }) });
    expect(screen.getByRole('radio', { name: 'A' })).toHaveAttribute('aria-checked', 'true');
    expect(send()).toBeEnabled();
  });

  it('dismisses', async () => {
    const { onDismiss, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe('the answer view of a custom panel', () => {
  it('shows what was sent, read-only, with the plan file named', () => {
    const answer: CustomAnswer = {
      values: {
        pick: 'b',
        tags: ['calm', 'odd'],
        speed: 1.25,
        note: 'faster',
        todo: ['three', 'two'],
        grid: [['2', '5']],
        marks: [{ text: 'the logo', box: { x: 1, y: 2, w: 3, h: 4 } }],
        ab: 'a',
      },
    };
    render(<AnswerView panel={panelOf({ status: 'submitted', answer }) as OpenPanel} />);
    const view = screen.getByTestId('answer-view');
    expect(within(view).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(view).queryByRole('button')).not.toBeInTheDocument();
    const row = (label: string) => within(view).getByText(label).nextElementSibling!.textContent;
    expect(row('Which card?')).toBe('Loud');
    expect(row('Mood')).toBe('Calm, Odd');
    expect(row('Logo speed')).toBe('1.25 x');
    expect(row('Anything else?')).toBe('faster');
    expect(row('To do')).toBe('- three\n- two');
    expect(row('Ratings')).toBe('2 | 5');
    expect(row('Marks')).toBe('1. the logo (on an area)');
    expect(row('Which is better?')).toBe('A, Old');
    expect(view).toHaveTextContent('Saved in plan/custom-end-card.json.');
  });
});
