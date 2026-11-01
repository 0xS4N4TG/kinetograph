import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScriptPanel } from '../src/components/panels/script-panel';
import { lineSeconds, overrun, totalSeconds } from '../src/components/panels/script-math';
import type { OpenPanel, ScriptAnswer, ScriptDraft } from '../src/components/panels/types';

function open(data: ScriptDraft & { targetSeconds?: number }): OpenPanel<'script'> {
  return { id: 'p1', panel: 'script', data, message: null, status: 'open', answer: null, openedAt: 0 };
}

function setup(data: ScriptDraft & { targetSeconds?: number }) {
  const onSubmit = vi.fn<(answer: ScriptAnswer) => void>();
  const onDismiss = vi.fn();
  render(<ScriptPanel panel={open(data)} onSubmit={onSubmit} onDismiss={onDismiss} />);
  const sent = () => onSubmit.mock.calls.at(-1)![0];
  return { onSubmit, onDismiss, sent };
}

const five = 'one two three four five';

describe('estimate math', () => {
  it('estimates from words at the rate, default 2.5 words/s', () => {
    expect(lineSeconds({ id: 'a', text: five }, 2.5)).toEqual({ seconds: 2, estimated: true });
    expect(lineSeconds({ id: 'a', text: five }, 5)).toEqual({ seconds: 1, estimated: true });
    expect(lineSeconds({ id: 'a', text: '   ' }, 2.5).seconds).toBe(0);
  });

  it('prefers the line own seconds', () => {
    expect(lineSeconds({ id: 'a', text: five, seconds: 4.2 }, 2.5)).toEqual({ seconds: 4.2, estimated: false });
  });

  it('totals and flags an overrun', () => {
    const lines = [
      { id: 'a', text: five },
      { id: 'b', text: five, seconds: 3 },
    ];
    expect(totalSeconds(lines, 2.5)).toBe(5);
    expect(overrun(5, 4)).toBe(1);
    expect(overrun(5, undefined)).toBeNull();
  });
});

describe('ScriptPanel', () => {
  it('shows est. only for estimated lines, and the total', () => {
    setup({
      lines: [
        { id: 'a', text: five },
        { id: 'b', text: five, seconds: 3 },
      ],
    });
    const rows = screen.getAllByTestId('script-line');
    expect(within(rows[0]!).getByTestId('line-seconds')).toHaveTextContent('2.0sest.');
    expect(within(rows[1]!).getByTestId('line-seconds')).toHaveTextContent('3.0s');
    expect(within(rows[1]!).queryByText('est.')).toBeNull();
    expect(screen.getByTestId('script-total')).toHaveTextContent('5.0s total');
  });

  it('uses the draft rate', () => {
    setup({ lines: [{ id: 'a', text: five }], rate: 5 });
    expect(screen.getByTestId('line-seconds')).toHaveTextContent('1.0s');
  });

  it('shows the difference against the target, with an overrun flag', () => {
    const { unmount } = render(
      <ScriptPanel
        panel={open({ lines: [{ id: 'a', text: five }], targetSeconds: 1.5 } as ScriptDraft)}
        onSubmit={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByTestId('script-total')).toHaveTextContent('0.5s over');
    unmount();
    render(
      <ScriptPanel
        panel={open({ lines: [{ id: 'a', text: five }], targetSeconds: 5 } as ScriptDraft)}
        onSubmit={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByTestId('script-total')).toHaveTextContent('3.0s under');
  });

  it('shows no difference without a target', () => {
    setup({ lines: [{ id: 'a', text: five }] });
    expect(screen.getByTestId('script-total')).not.toHaveTextContent(/over|under/);
  });

  it('puts edits, insert, remove and move in the answer, and recomputes the total', async () => {
    const user = userEvent.setup();
    const { sent } = setup({
      lines: [
        { id: 'a', text: 'first' },
        { id: 'b', text: 'second', seconds: 2 },
        { id: 'c', text: 'third' },
      ],
    });
    // Editing a line with its own seconds drops them: the words no longer match the voiceover.
    fireEvent.change(screen.getByLabelText('Line 2'), { target: { value: 'second line here now' } });
    expect(screen.getAllByTestId('line-seconds')[1]).toHaveTextContent('1.6sest.');

    await user.click(screen.getByLabelText('Insert a line below line 1'));
    fireEvent.change(screen.getByLabelText('Line 2'), { target: { value: 'inserted' } });
    await user.click(screen.getByLabelText('Remove line 4'));
    await user.click(screen.getByLabelText('Move line 3 up'));
    await user.click(screen.getByText('Approve'));

    const answer = sent();
    expect(answer.lines.map((l) => l.text)).toEqual(['first', 'second line here now', 'inserted']);
    expect(answer.lines.map((l) => l.id)).toEqual(['a', 'b', expect.stringMatching(/^line-new-/)]);
    expect(answer.lines[1]!.seconds).toBeUndefined();
  });

  it('disables move at the ends', () => {
    setup({ lines: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }] });
    expect(screen.getByLabelText('Move line 1 up')).toBeDisabled();
    expect(screen.getByLabelText('Move line 2 down')).toBeDisabled();
  });

  it('adds a line to an empty script', async () => {
    const user = userEvent.setup();
    const { sent } = setup({ lines: [] });
    await user.click(screen.getByText('Add a line'));
    fireEvent.change(screen.getByLabelText('Line 1'), { target: { value: 'hello' } });
    await user.click(screen.getByText('Approve'));
    expect(sent().lines.map((l) => l.text)).toEqual(['hello']);
  });

  it('collects notes per line, drops empty ones and those of removed lines', async () => {
    const user = userEvent.setup();
    const { sent } = setup({
      lines: [
        { id: 'a', text: 'one' },
        { id: 'b', text: 'two' },
        { id: 'c', text: 'three' },
      ],
    });
    await user.click(screen.getByLabelText('Comment on line 1'));
    await user.type(screen.getByLabelText('Note on line 1'), 'punchier');
    await user.click(screen.getByLabelText('Comment on line 2'));
    await user.type(screen.getByLabelText('Note on line 2'), 'cut this');
    await user.click(screen.getByLabelText('Comment on line 3'));
    await user.type(screen.getByLabelText('Note on line 3'), '   ');
    await user.click(screen.getByLabelText('Remove line 2'));
    await user.click(screen.getByText('Approve'));
    expect(sent().notes).toEqual([{ line: 'a', text: 'punchier' }]);
  });

  it('approves with approved: true and rewrites with approved: false', async () => {
    const user = userEvent.setup();
    const { onSubmit, sent } = setup({ lines: [{ id: 'a', text: 'one' }] });
    await user.click(screen.getByText('Approve'));
    expect(sent().approved).toBe(true);
    await user.click(screen.getByText('Rewrite and show me again'));
    expect(sent().approved).toBe(false);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('dismisses without submitting', async () => {
    const user = userEvent.setup();
    const { onSubmit, onDismiss } = setup({ lines: [{ id: 'a', text: 'one' }] });
    await user.click(screen.getByText('Dismiss'));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('renders the track name and a tick per beat, and keeps it in the answer unless unchecked', async () => {
    const user = userEvent.setup();
    const { sent } = setup({
      lines: [{ id: 'a', text: five }],
      track: { src: 'assets/music/night-drive.mp3', beats: [0.5, 1, 1.5, 2, 4] },
    });
    expect(screen.getByText('night-drive.mp3')).toBeInTheDocument();
    expect(screen.getByText('5 beats')).toBeInTheDocument();
    expect(screen.getAllByTestId('beat-tick')).toHaveLength(5);
    expect(screen.getAllByTestId('beat-tick')[4]).toHaveStyle({ left: '100%' });

    await user.click(screen.getByText('Approve'));
    expect(sent().track).toEqual({ src: 'assets/music/night-drive.mp3', beats: [0.5, 1, 1.5, 2, 4] });

    await user.click(screen.getByLabelText('Keep this track'));
    await user.click(screen.getByText('Approve'));
    expect(sent().track).toBeUndefined();
  });

  describe('playing the track', () => {
    /** jsdom plays nothing: play and pause move `paused` and send the events a browser would. */
    const pausedBefore = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'paused');
    function fakeMedia(playResult: () => Promise<void> = () => Promise.resolve()) {
      const state = new WeakMap<HTMLMediaElement, boolean>();
      Object.defineProperty(HTMLMediaElement.prototype, 'paused', { configurable: true, get() { return state.get(this) ?? true; } });
      const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
        const result = playResult();
        void result.then(() => {
          state.set(this, false);
          this.dispatchEvent(new Event('play'));
        }, () => {});
        return result;
      });
      const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
        state.set(this, true);
        this.dispatchEvent(new Event('pause'));
      });
      return { play, pause };
    }
    afterEach(() => {
      vi.restoreAllMocks();
      if (pausedBefore) Object.defineProperty(HTMLMediaElement.prototype, 'paused', pausedBefore);
    });
    const track = { src: 'assets/music/night-drive.mp3', beats: [1, 2] };

    it('points the player at the studio route for the file, and fetches nothing before the first play', () => {
      setup({ lines: [{ id: 'a', text: five }], track });
      const audio = document.querySelector('audio')!;
      expect(new URL(audio.getAttribute('src')!, 'http://studio.test').pathname).toBe('/api/panels/script/audio');
      expect(new URL(audio.getAttribute('src')!, 'http://studio.test').searchParams.get('path')).toBe('assets/music/night-drive.mp3');
      expect(audio.getAttribute('preload')).toBe('none');
    });

    it('plays and pauses with one button, and stops when the panel goes away', async () => {
      const { play, pause } = fakeMedia();
      const user = userEvent.setup();
      const { unmount } = render(<ScriptPanel panel={open({ lines: [{ id: 'a', text: five }], track })} onSubmit={() => {}} onDismiss={() => {}} />);
      await user.click(screen.getByRole('button', { name: 'Play night-drive.mp3' }));
      expect(play).toHaveBeenCalledOnce();
      await user.click(await screen.findByRole('button', { name: 'Pause night-drive.mp3' }));
      expect(pause).toHaveBeenCalledOnce();
      expect(screen.getByRole('button', { name: 'Play night-drive.mp3' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Play night-drive.mp3' }));
      pause.mockClear();
      unmount();
      expect(pause).toHaveBeenCalledOnce();
    });

    it('says so when the file cannot be played', async () => {
      fakeMedia(() => Promise.reject(new Error('NotSupported')));
      const user = userEvent.setup();
      setup({ lines: [{ id: 'a', text: five }], track });
      await user.click(screen.getByRole('button', { name: 'Play night-drive.mp3' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('could not be played');
    });

    it('has no play button without a track', () => {
      setup({ lines: [{ id: 'a', text: five }] });
      expect(screen.queryByRole('button', { name: /^Play / })).toBeNull();
    });
  });

  it('has no track section without a track', () => {
    setup({ lines: [{ id: 'a', text: 'one' }] });
    expect(screen.queryByTestId('beat-strip')).toBeNull();
    expect(screen.queryByText('Keep this track')).toBeNull();
  });
});
