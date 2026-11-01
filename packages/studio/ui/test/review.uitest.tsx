import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { CompositionInfo, InspectResult } from '../src/api';
import { ReviewView, type ReviewStore } from '../src/components/panels/review-view';
import { answerNotes, areaOfSelection, reviewSpan, sortNotes } from '../src/components/panels/review-model';
import type { OpenPanel } from '../src/components/panels/types';
import { Timeline } from '../src/components/timeline/timeline';
import { Player } from '../src/lib/player';
import { setReviewMarks, useReviewMarks } from '../src/lib/review-marks';
import type { FrameRange } from '../src/lib/selection';
import { inspectFor, intro, introTimeline, layer, outro } from './fixtures';

function panelOf(data: OpenPanel<'review'>['data']): OpenPanel<'review'> {
  return { id: 'p_1', panel: 'review', data, message: null, status: 'open', answer: null, openedAt: 0 };
}

/** A store with a real player (no server behind it) and the few things the review reads. */
function fakeStore(options: { comp?: CompositionInfo; inspect?: InspectResult | null; selectedLayers?: string[] } = {}) {
  const comp = options.comp ?? intro;
  const player = new Player({ requestFrame: () => 1, onImage: () => {} });
  player.setComposition(comp);
  const store: ReviewStore & { selected: FrameRange | null } = {
    comp,
    compositions: [intro, outro],
    selectComp: vi.fn(),
    player,
    inspect: options.inspect ?? null,
    selectedLayers: options.selectedLayers ?? [],
    selectedRange: null,
    selected: null,
    selectRange: vi.fn((range: FrameRange | null) => {
      store.selected = range;
    }),
  };
  return store;
}

function setup(data: OpenPanel<'review'>['data'] = { comp: 'Intro' }, store = fakeStore()) {
  const onSubmit = vi.fn();
  const onDismiss = vi.fn();
  const view = (s: ReviewStore) => <ReviewView panel={panelOf(data)} store={s} onSubmit={onSubmit} onDismiss={onDismiss} />;
  const utils = render(view(store));
  return { ...utils, store, onSubmit, onDismiss, rerenderWith: (s: ReviewStore) => utils.rerender(view(s)) };
}

const notes = () => screen.queryAllByTestId('review-note');

describe('review model', () => {
  it('sorts notes by frame and keeps the order of notes on the same frame', () => {
    const sorted = sortNotes([
      { uid: 1, frame: 40, text: 'c' },
      { uid: 2, frame: 10, text: 'a' },
      { uid: 3, frame: 10, text: 'b' },
    ]);
    expect(sorted.map((n) => n.text)).toEqual(['a', 'b', 'c']);
  });

  it('answers with trimmed notes, without the ids and the blank ones', () => {
    expect(answerNotes([
      { uid: 2, frame: 30, text: ' late ', box: { x: 1, y: 2, w: 3, h: 4 }, layer: 'Title' },
      { uid: 1, frame: 5, text: '   ' },
      { uid: 3, frame: 3, text: 'early' },
    ])).toEqual([
      { frame: 3, text: 'early' },
      { frame: 30, text: 'late', box: { x: 1, y: 2, w: 3, h: 4 }, layer: 'Title' },
    ]);
  });

  it('holds the range inside the composition', () => {
    expect(reviewSpan({ comp: 'Intro' }, 150)).toEqual([0, 149]);
    expect(reviewSpan({ comp: 'Intro', range: [20, 500] }, 150)).toEqual([20, 149]);
    expect(reviewSpan({ comp: 'Intro', range: [60, 20] }, 150)).toEqual([20, 60]);
  });

  it('takes the area and the name from the picked layers', () => {
    const inspect = inspectFor(intro, 0);
    inspect.layers = [layer('a', 'shape', { bounds: { x: 10, y: 20, width: 100, height: 50 } }), layer('b', 'shape', { bounds: { x: 200, y: 100, width: 40, height: 40 } })];
    const one = areaOfSelection(inspect, ['a'], intro);
    expect(one?.box).toEqual({ x: 10, y: 20, w: 100, h: 50 });
    expect(areaOfSelection(inspect, ['a', 'b'], intro)?.box).toEqual({ x: 10, y: 20, w: 230, h: 120 });
    expect(areaOfSelection(inspect, [], intro)).toBeNull();
    expect(areaOfSelection(null, ['a'], intro)).toBeNull();
  });
});

describe('ReviewView', () => {
  it('shows the ask and the range, and starts the range on mount', () => {
    const store = fakeStore();
    setup({ comp: 'Intro', range: [30, 90], ask: 'Is the pacing right?' }, store);
    expect(screen.getByTestId('review-ask')).toHaveTextContent('Is the pacing right?');
    expect(screen.getByTestId('review-range')).toHaveTextContent('Frames 30 to 90');
    expect(store.player.getState().frame).toBe(30);
    expect(store.player.getState().loop).toBe(true);
    expect(store.selected).toEqual({ start: 30, end: 90 });
  });

  it('switches the studio to the composition it is about', () => {
    const store = fakeStore();
    store.comp = outro;
    setup({ comp: 'Intro' }, store);
    expect(store.selectComp).toHaveBeenCalledWith('Intro');
  });

  it('does not switch when the studio already shows it', () => {
    const { store } = setup();
    expect(store.selectComp).not.toHaveBeenCalled();
  });

  it('adds a note at the current frame with N, sorted by frame', async () => {
    const user = userEvent.setup();
    const { store } = setup();
    store.player.seek(90);
    await user.keyboard('n');
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toHaveAttribute('data-frame', '90');
    expect(within(notes()[0]!).getByRole('textbox')).toHaveFocus();
    await user.keyboard('too slow');
    act(() => store.player.seek(12));
    await user.click(screen.getByRole('button', { name: /Add note/ }));
    expect(notes().map((n) => n.getAttribute('data-frame'))).toEqual(['12', '90']);
    expect(within(notes()[1]!).getByRole('textbox')).toHaveValue('too slow');
    expect(within(notes()[1]!).getByText('00:03.00')).toBeInTheDocument();
  });

  it('does not add a note when N is typed into a note', async () => {
    const user = userEvent.setup();
    setup();
    await user.keyboard('n');
    await user.keyboard('nnn');
    expect(notes()).toHaveLength(1);
    expect(within(notes()[0]!).getByRole('textbox')).toHaveValue('nnn');
  });

  it('edits and deletes a note', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: /Add note/ }));
    await user.type(screen.getByRole('textbox'), 'hook lands late');
    expect(screen.getByRole('textbox')).toHaveValue('hook lands late');
    await user.click(screen.getByRole('button', { name: 'Delete the note' }));
    expect(notes()).toHaveLength(0);
    expect(screen.getByText(/No notes yet/)).toBeInTheDocument();
  });

  it('seeks to a note when its time is clicked', async () => {
    const user = userEvent.setup();
    const { store } = setup();
    store.player.seek(45);
    await user.keyboard('n');
    act(() => store.player.seek(0));
    expect(store.player.getState().frame).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Go to 00:01.15' }));
    expect(store.player.getState().frame).toBe(45);
  });

  it('keeps playback inside the range: back to the start past the end', () => {
    const { store } = setup({ comp: 'Intro', range: [30, 60] });
    act(() => {
      store.player.play();
      store.player.seek(61);
    });
    expect(store.player.getState().frame).toBe(30);
    expect(store.player.getState().playing).toBe(true);
    act(() => store.player.pause());
  });

  it('shows the notes as marks for the timeline and clears them when it closes', async () => {
    const user = userEvent.setup();
    const seen: number[][] = [];
    const store = fakeStore();
    const { unmount } = setup({ comp: 'Intro' }, store);
    store.player.seek(20);
    await user.keyboard('n');
    function Probe() {
      const marks = useReviewMarks();
      seen.push(marks?.frames ?? []);
      return null;
    }
    render(<Probe />);
    expect(seen.at(-1)).toEqual([20]);
    unmount();
    expect(seen.at(-1)).toEqual([]);
  });

  describe('answers', () => {
    it('approves with the notes in frame order', async () => {
      const user = userEvent.setup();
      const { store, onSubmit } = setup();
      store.player.seek(80);
      await user.keyboard('n');
      await user.keyboard('end is flat');
      act(() => store.player.seek(5));
      await user.click(screen.getByRole('button', { name: /Add note/ }));
      await user.keyboard('start sooner');
      await user.click(screen.getByRole('button', { name: 'Approve' }));
      expect(onSubmit).toHaveBeenCalledWith({
        verdict: 'approved',
        notes: [
          { frame: 5, text: 'start sooner' },
          { frame: 80, text: 'end is flat' },
        ],
      });
    });

    it('asks for changes, which needs a note', async () => {
      const user = userEvent.setup();
      const { onSubmit } = setup();
      const changes = screen.getByRole('button', { name: 'Request changes' });
      expect(changes).toBeDisabled();
      await user.click(screen.getByRole('button', { name: /Add note/ }));
      await user.keyboard('cut it');
      expect(changes).toBeEnabled();
      await user.click(changes);
      expect(onSubmit).toHaveBeenCalledWith({ verdict: 'changes', notes: [{ frame: 0, text: 'cut it' }] });
    });

    it('dismisses', async () => {
      const user = userEvent.setup();
      const { onDismiss, onSubmit } = setup();
      await user.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(onDismiss).toHaveBeenCalledOnce();
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe('areas', () => {
    function withSelection() {
      const inspect = inspectFor(intro, 0);
      inspect.layers = [layer('title', 'shape', { bounds: { x: 100, y: 200, width: 300, height: 80 } })];
      return fakeStore({ inspect });
    }

    it('ties a note to the layer picked after the panel opened', async () => {
      const user = userEvent.setup();
      const store = withSelection();
      const { onSubmit, rerenderWith } = setup({ comp: 'Intro' }, store);
      expect(screen.getByText(/drag a box/)).toBeInTheDocument();
      rerenderWith({ ...store, selectedLayers: ['title'] });
      const tie = screen.getByRole('button', { name: /Tied to/ });
      expect(tie).toHaveAttribute('aria-pressed', 'true');
      await user.keyboard('n');
      await user.keyboard('too small');
      expect(within(notes()[0]!).getByTestId('review-note-area')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Request changes' }));
      expect(onSubmit).toHaveBeenCalledWith({
        verdict: 'changes',
        notes: [{ frame: 0, text: 'too small', box: { x: 100, y: 200, w: 300, h: 80 }, layer: 'title' }],
      });
    });

    it('leaves the area off when the tie is switched off or removed', async () => {
      const user = userEvent.setup();
      const store = withSelection();
      const { rerenderWith } = setup({ comp: 'Intro' }, store);
      rerenderWith({ ...store, selectedLayers: ['title'] });
      await user.click(screen.getByRole('button', { name: /Tied to/ }));
      await user.keyboard('n');
      expect(screen.queryByTestId('review-note-area')).toBeNull();
      await user.click(screen.getByRole('button', { name: /Tie to/ }));
      await user.keyboard('{Escape}');
      await user.click(screen.getByRole('button', { name: /Add note/ }));
      expect(screen.getAllByTestId('review-note-area')).toHaveLength(1);
      await user.click(screen.getByRole('button', { name: 'Remove the area' }));
      expect(screen.queryByTestId('review-note-area')).toBeNull();
    });
  });
});

describe('timeline marks', () => {
  it('draws a mark on the ruler for each note of the open review, on its composition only', () => {
    const player = new Player({ requestFrame: () => 1, onImage: () => {} });
    player.setComposition(intro);
    const timeline = (
      <Timeline
        comp={intro}
        status={{ state: 'ready', data: introTimeline, refreshing: null }}
        player={player}
        selectedLayers={[]}
        onSelectLayers={() => {}}
        selectedRange={null}
        onSelectRange={() => {}}
        expanded={false}
        onExpandedChange={() => {}}
        details={false}
        onDetailsChange={() => {}}
      />
    );
    render(timeline);
    expect(screen.queryAllByTestId('review-mark')).toHaveLength(0);
    act(() => setReviewMarks({ comp: 'Intro', frames: [10, 80] }));
    expect(screen.getAllByTestId('review-mark')).toHaveLength(2);
    act(() => setReviewMarks({ comp: 'Outro', frames: [10] }));
    expect(screen.queryAllByTestId('review-mark')).toHaveLength(0);
    act(() => setReviewMarks(null));
  });
});
