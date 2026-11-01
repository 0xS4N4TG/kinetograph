import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { CompositionInfo, InspectResult } from '../src/api';
import { ReviewView, type ReviewStore } from '../src/components/panels/review-view';
import { answerNotes, areaOfSelection, draftKey, reviewSpan, sortNotes, writeDraft } from '../src/components/panels/review-model';
import type { OpenPanel } from '../src/components/panels/types';
import { Timeline } from '../src/components/timeline/timeline';
import { Player } from '../src/lib/player';
import { getMarqueeBox, setMarqueeBox } from '../src/lib/marquee-box';
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

function setup(data: OpenPanel<'review'>['data'] = { comp: 'Intro' }, store = fakeStore(), draft?: string) {
  const onSubmit = vi.fn();
  const onDismiss = vi.fn();
  const view = (s: ReviewStore) => <ReviewView panel={panelOf(data)} store={s} draftKey={draft} onSubmit={onSubmit} onDismiss={onDismiss} />;
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

  it('takes a drawn box, alone when no layer lies inside it and over the layers when one does', () => {
    const inspect = inspectFor(intro, 0);
    inspect.layers = [layer('a', 'shape', { bounds: { x: 10, y: 20, width: 100, height: 50 } })];
    const drawn = { x: 500, y: 400, w: 200, h: 100 };
    expect(areaOfSelection(inspect, [], intro, drawn)).toEqual({ box: drawn });
    expect(areaOfSelection(null, [], intro, drawn)).toEqual({ box: drawn });
    expect(areaOfSelection(inspect, ['a'], intro, drawn)).toEqual({ box: drawn, layer: 'a' });
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

    it('ties a note to a box drawn over empty space, with a box and no layer', async () => {
      const user = userEvent.setup();
      const store = withSelection();
      setMarqueeBox(null);
      const { onSubmit } = setup({ comp: 'Intro' }, store);
      act(() => setMarqueeBox({ box: { x: 600, y: 300, w: 120, h: 80 }, selection: '' }));
      expect(screen.getByRole('button', { name: /Tied to the box/ })).toHaveAttribute('aria-pressed', 'true');
      await user.keyboard('n');
      await user.keyboard('empty here');
      await user.click(screen.getByRole('button', { name: 'Request changes' }));
      expect(onSubmit).toHaveBeenCalledWith({ verdict: 'changes', notes: [{ frame: 0, text: 'empty here', box: { x: 600, y: 300, w: 120, h: 80 } }] });
      act(() => setMarqueeBox(null));
    });

    it('keeps a drawn box and the layer inside it together, and forgets the box when the selection moves on', async () => {
      const user = userEvent.setup();
      const store = withSelection();
      setMarqueeBox(null);
      const { onSubmit, rerenderWith } = setup({ comp: 'Intro' }, store);
      act(() => setMarqueeBox({ box: { x: 90, y: 190, w: 340, h: 120 }, selection: 'title' }));
      rerenderWith({ ...store, selectedLayers: ['title'] });
      await user.keyboard('n');
      await user.keyboard('both');
      await user.click(screen.getByRole('button', { name: 'Request changes' }));
      expect(onSubmit).toHaveBeenCalledWith({ verdict: 'changes', notes: [{ frame: 0, text: 'both', box: { x: 90, y: 190, w: 340, h: 120 }, layer: 'title' }] });
      rerenderWith({ ...store, selectedLayers: [] });
      expect(getMarqueeBox()).toBeNull();
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

describe('the unsent notes', () => {
  const key = draftKey('/work/entry.ts', 'p_1');
  const clearStorage = () => window.localStorage.removeItem(key);

  it('are kept in the browser and come back when the panel shows again', async () => {
    clearStorage();
    const user = userEvent.setup();
    const first = setup({ comp: 'Intro' }, fakeStore(), key);
    first.store.player.seek(40);
    await user.keyboard('n');
    await user.keyboard('slow start');
    first.unmount();

    const again = setup({ comp: 'Intro' }, fakeStore(), key);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toHaveAttribute('data-frame', '40');
    expect(within(notes()[0]!).getByRole('textbox')).toHaveValue('slow start');
    // a new note does not reuse the id of the restored one
    await user.click(screen.getByRole('button', { name: /Add note/ }));
    expect(notes()).toHaveLength(2);
    again.unmount();
    clearStorage();
  });

  it('are read once the project is known', async () => {
    writeDraft(key, 0, [{ uid: 4, frame: 7, text: 'kept' }]);
    const store = fakeStore();
    const view = (draft?: string) => <ReviewView panel={panelOf({ comp: 'Intro' })} store={store} draftKey={draft} onSubmit={() => {}} onDismiss={() => {}} />;
    const { rerender, unmount } = render(view());
    expect(notes()).toHaveLength(0);
    rerender(view(key));
    expect(notes()).toHaveLength(1);
    expect(window.localStorage.getItem(key)).toContain('kept');
    unmount();
    clearStorage();
  });

  it('are not mixed into another review that has the same id', () => {
    writeDraft(key, 111, [{ uid: 1, frame: 7, text: 'old review' }]);
    const { unmount } = setup({ comp: 'Intro' }, fakeStore(), key);
    expect(notes()).toHaveLength(0);
    unmount();
    clearStorage();
  });

  it('go when the review is sent or dismissed, and stay when it is only put away', async () => {
    clearStorage();
    const user = userEvent.setup();
    const sent = setup({ comp: 'Intro' }, fakeStore(), key);
    await user.keyboard('n');
    await user.keyboard('one');
    expect(window.localStorage.getItem(key)).toContain('one');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(window.localStorage.getItem(key)).toBeNull();
    sent.unmount();

    const dismissed = setup({ comp: 'Intro' }, fakeStore(), key);
    await user.keyboard('n');
    await user.keyboard('two');
    expect(window.localStorage.getItem(key)).toContain('two');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(window.localStorage.getItem(key)).toBeNull();
    dismissed.unmount();
  });

  it('are dropped from the browser when every note is deleted', async () => {
    clearStorage();
    const user = userEvent.setup();
    const { unmount } = setup({ comp: 'Intro' }, fakeStore(), key);
    await user.keyboard('n');
    expect(window.localStorage.getItem(key)).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Delete the note' }));
    expect(window.localStorage.getItem(key)).toBeNull();
    unmount();
  });
});
