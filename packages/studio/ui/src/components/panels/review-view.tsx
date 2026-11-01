import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckIcon, MessageSquarePlusIcon, SquareDashedIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { clock } from '@/lib/format';
import { useFrame } from '@/lib/player-hooks';
import { getMarqueeBox, setMarqueeBox, useMarqueeBox } from '@/lib/marquee-box';
import { setReviewMarks } from '@/lib/review-marks';
import type { Studio } from '@/studio';

import { areaOfSelection, answerNotes, reviewSpan, sortNotes, type DraftNote } from './review-model';
import { ReviewNote } from './review-note';
import type { PanelProps } from './types';

/** What the review needs of the store: the composition and playhead, the picked layers, and the range shown on the timeline. */
export type ReviewStore = Pick<Studio, 'comp' | 'compositions' | 'selectComp' | 'player' | 'inspect' | 'selectedLayers' | 'selectedRange' | 'selectRange'>;

interface ReviewViewProps extends PanelProps<'review'> {
  store: ReviewStore;
}

/** The keys that type into a field or drive a control keep their meaning: N adds a note only from the page itself. */
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, button, [role=slider], [role=tab], [role=menu], [role=dialog]') !== null);
}

/** The time under the playhead, on its own so only this re-renders with the frame. */
function PlayheadReadout({ store, fps }: { store: ReviewStore; fps: number }) {
  const frame = useFrame(store.player);
  return <span className="font-mono tabular-nums">{clock(frame, fps)}</span>;
}

/**
 * The review: a narrow column of notes beside the preview. The preview stays in view and keeps playing; the panel only
 * switches the studio to the composition, keeps playback inside the range, and reads the playhead and the picked layers.
 */
export function ReviewView({ panel, store, onSubmit, onDismiss }: ReviewViewProps) {
  const { data } = panel;
  const { player, comp, compositions, selectComp, selectRange, inspect, selectedLayers } = store;
  const fps = comp?.fps ?? 30;
  const duration = comp?.durationInFrames ?? 0;
  const [first, last] = useMemo(() => reviewSpan(data, duration), [data, duration]);

  const [notes, setNotes] = useState<DraftNote[]>([]);
  const nextUid = useRef(1);
  const [focusUid, setFocusUid] = useState<number | null>(null);

  // ---- show the composition and the range ----

  const switched = useRef(false);
  useEffect(() => {
    if (switched.current || compositions.length === 0) return;
    switched.current = true;
    if (comp?.id !== data.comp && compositions.some((c) => c.id === data.comp)) selectComp(data.comp);
  }, [compositions, comp?.id, data.comp, selectComp]);

  const onComp = comp?.id === data.comp;
  const missing = compositions.length > 0 && !compositions.some((c) => c.id === data.comp);
  const started = useRef(false);
  const loopBefore = useRef<boolean | null>(null);
  useEffect(() => {
    if (!onComp || started.current) return;
    started.current = true;
    loopBefore.current = player.getState().loop;
    player.setLoop(true);
    if (data.range) selectRange({ start: first, end: last });
    const frame = player.getState().frame;
    if (frame < first || frame > last) player.seek(first);
  }, [onComp, player, data.range, first, last, selectRange]);
  useEffect(
    () => () => {
      if (loopBefore.current !== null) player.setLoop(loopBefore.current);
      if (data.range && started.current) selectRange(null);
    },
    // Only at the end of the review.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Playback stays inside the range: past its end it goes back to the start (loop is on) or stops on the last frame.
  useEffect(() => {
    if (!onComp) return;
    return player.subscribe(() => {
      const s = player.getState();
      if (!s.playing) return;
      if (s.frame > last) {
        if (s.loop) player.seek(first);
        else {
          player.pause();
          player.seek(last);
        }
      } else if (s.frame < first && s.loop) player.seek(first);
    });
  }, [onComp, player, first, last]);

  // ---- notes ----

  const selectionKey = selectedLayers.join('\0');
  // The box last dragged on the preview counts while the selection is still what that drag picked.
  const marquee = useMarqueeBox();
  const drawn = marquee && marquee.selection === selectionKey ? marquee.box : null;
  const drawnKey = drawn ? `${drawn.x},${drawn.y},${drawn.w},${drawn.h}` : '';
  useEffect(() => {
    const last = getMarqueeBox();
    if (last && last.selection !== selectionKey) setMarqueeBox(null);
  }, [selectionKey]);
  const area = useMemo(() => (comp ? areaOfSelection(inspect, selectedLayers, comp, drawn) : null), [comp, inspect, selectedLayers, drawnKey]);
  /** Whether the next note takes the picked area; it switches on when the person picks something or draws a box. */
  const [tie, setTie] = useState(false);
  const firstSelection = useRef(true);
  useEffect(() => {
    if (firstSelection.current) {
      firstSelection.current = false;
      return;
    }
    setTie(selectedLayers.length > 0 || drawnKey !== '');
  }, [selectionKey, drawnKey]);

  const addNote = useCallback(() => {
    if (!comp) return;
    const frame = player.getState().frame;
    const uid = nextUid.current++;
    setNotes((all) => [...all, { uid, frame, text: '', ...(tie && area ? { box: area.box, ...(area.layer ? { layer: area.layer } : {}) } : {}) }]);
    setFocusUid(uid);
  }, [comp, player, tie, area]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'n' || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.defaultPrevented || typing(event.target)) return;
      event.preventDefault();
      addNote();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [addNote]);

  const sorted = useMemo(() => sortNotes(notes), [notes]);
  useEffect(() => {
    setReviewMarks({ comp: data.comp, frames: notes.map((n) => n.frame) });
    return () => setReviewMarks(null);
  }, [data.comp, notes]);

  const patch = (uid: number, change: Partial<DraftNote>) => setNotes((all) => all.map((n) => (n.uid === uid ? { ...n, ...change } : n)));
  const dropArea = (uid: number) =>
    setNotes((all) =>
      all.map((n) => {
        if (n.uid !== uid) return n;
        const { box: _box, layer: _layer, ...rest } = n;
        return rest;
      }),
    );
  const remove = (uid: number) => setNotes((all) => all.filter((n) => n.uid !== uid));

  const sendable = answerNotes(notes);

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-testid="review-panel">
      <div className="flex flex-col gap-1.5 px-4 pt-4 pb-3">
        {data.ask && (
          <p data-testid="review-ask" className="text-sm leading-snug">
            {data.ask}
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          <span className="font-mono text-[11px]">{data.comp}</span>
          {' · '}
          {data.range ? (
            <span data-testid="review-range">
              Frames {first} to {last} ({clock(first, fps)} to {clock(last, fps)}), playing on a loop.
            </span>
          ) : (
            <span>The whole composition.</span>
          )}
        </p>
        {missing && <p className="text-destructive-foreground text-xs">The composition {data.comp} is not in this project.</p>}
      </div>

      <div className="border-border/60 flex flex-col gap-2 border-y px-4 py-3">
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={!comp} onClick={addNote}>
            <MessageSquarePlusIcon />
            Add note
            <Kbd>N</Kbd>
          </Button>
          <span className="text-muted-foreground ml-auto text-xs">
            at <PlayheadReadout store={store} fps={fps} />
          </span>
        </div>
        {area && (
          <Button variant={tie ? 'secondary' : 'outline'} size="xs" aria-pressed={tie} onClick={() => setTie((on) => !on)} className="justify-start">
            <SquareDashedIcon />
            <span className="truncate">{tie ? `Tied to ${area.layer ?? 'the box'}` : `Tie to ${area.layer ?? 'the box'}`}</span>
          </Button>
        )}
        {!area && <p className="text-muted-foreground text-xs">Pick a layer or drag a box on the preview to tie the next note to that area.</p>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {sorted.length === 0 ? (
          <p className="text-muted-foreground text-sm">No notes yet. Play the range and press N where something should change.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Notes">
            {sorted.map((note) => (
              <ReviewNote
                key={note.uid}
                note={note}
                fps={fps}
                focus={note.uid === focusUid}
                onSeek={(frame) => player.seek(frame)}
                onText={(text) => patch(note.uid, { text })}
                onDropArea={() => dropArea(note.uid)}
                onDelete={() => remove(note.uid)}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="border-border/60 flex flex-wrap items-center gap-2 border-t px-4 py-3">
        <Button size="sm" onClick={() => onSubmit({ notes: sendable, verdict: 'approved' })}>
          <CheckIcon />
          Approve
        </Button>
        <Button size="sm" variant="outline" disabled={sendable.length === 0} onClick={() => onSubmit({ notes: sendable, verdict: 'changes' })}>
          Request changes
        </Button>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
