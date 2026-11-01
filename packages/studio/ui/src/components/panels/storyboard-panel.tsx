import { PlusIcon, TriangleAlertIcon } from 'lucide-react';
import { useMemo, useRef, useState, type PointerEvent } from 'react';

import { createApi } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import { ShotCard, TransitionChip } from './storyboard-card';
import type { PanelProps, Shot, Storyboard, StoryboardAnswer } from './types';

/** The length of a shot added by hand, seconds. */
const NEW_SHOT_SECONDS = 2;
const THUMB_HEIGHT = 120;

/** The brief's target length, when the agent put it in the panel's data (`targetSeconds`). */
function targetOf(data: Storyboard): number | null {
  const target = (data as Storyboard & { targetSeconds?: unknown }).targetSeconds;
  return typeof target === 'number' && Number.isFinite(target) && target > 0 ? target : null;
}

/** A length without trailing noise: 12, 12.5, 12.35. */
const fmt = (seconds: number): string => String(Math.round(seconds * 100) / 100);

function nextId(used: Iterable<string>): string {
  const taken = new Set(used);
  let n = 1;
  for (const id of taken) {
    const m = /^s(\d+)$/.exec(id);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  while (taken.has(`s${n}`)) n++;
  return `s${n}`;
}

/**
 * The storyboard panel (docs/proposals/studio-panels.md): one card per shot with a still of its frame, edited in place,
 * reordered by drag or by the move buttons, and approved or sent back.
 */
export function StoryboardPanel({ panel, onSubmit, onDismiss }: PanelProps<'storyboard'>) {
  const { comp } = panel.data;
  const target = targetOf(panel.data);
  const originalIds = useMemo(() => new Set(panel.data.shots.map((s) => s.id)), [panel.data.shots]);
  const api = useMemo(() => createApi(), []);
  const [shots, setShots] = useState<Shot[]>(() => panel.data.shots.map((s) => ({ ...s })));
  const [removed, setRemoved] = useState<string[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null);
  const cards = useRef(new Map<string, HTMLElement>());

  const total = shots.reduce((sum, s) => sum + s.seconds, 0);
  const over = target !== null && total > target + 1e-9 ? total - target : 0;

  const patch = (id: string, change: Partial<Shot>) => setShots((all) => all.map((s) => (s.id === id ? { ...s, ...change } : s)));

  const moveTo = (from: number, to: number) =>
    setShots((all) => {
      if (from === to || to < 0 || to >= all.length) return all;
      const next = [...all];
      next.splice(to, 0, next.splice(from, 1)[0]!);
      return next;
    });

  const remove = (id: string) => {
    setShots((all) => all.filter((s) => s.id !== id));
    // A shot added here was never the agent's, so only the agent's own shots are reported as removed.
    if (originalIds.has(id)) setRemoved((all) => [...all, id]);
    setNotes(({ [id]: _gone, ...rest }) => rest);
  };

  const addAfter = (index: number) => {
    const neighbour = shots[index] ?? shots[shots.length - 1];
    const shot: Shot = {
      id: nextId([...shots.map((s) => s.id), ...removed, ...originalIds]),
      frame: neighbour?.frame ?? 0,
      what: 'something here',
      moves: '',
      seconds: NEW_SHOT_SECONDS,
      transition: 'cut',
    };
    setShots((all) => [...all.slice(0, index + 1), shot, ...all.slice(index + 1)]);
  };

  // Dragging: the handle captures the pointer, and the card whose centre is nearest to it is where the shot will land.
  const overIndex = (x: number, y: number): number => {
    let best = 0;
    let bestDistance = Infinity;
    shots.forEach((s, i) => {
      const r = cards.current.get(s.id)?.getBoundingClientRect();
      if (!r) return;
      const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    });
    return best;
  };
  const dragStart = (e: PointerEvent<HTMLButtonElement>, id: string, index: number) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id, over: index });
  };
  const dragMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (drag) setDrag({ ...drag, over: overIndex(e.clientX, e.clientY) });
  };
  const dragEnd = () => {
    if (drag) moveTo(shots.findIndex((s) => s.id === drag.id), drag.over);
    setDrag(null);
  };

  const submit = (approved: boolean) => {
    const answer: StoryboardAnswer = {
      shots,
      removed,
      notes: shots.flatMap((s) => (notes[s.id]?.trim() ? [{ shot: s.id, text: notes[s.id]!.trim() }] : [])),
      approved,
    };
    onSubmit(answer);
  };

  return (
    <section aria-label="Storyboard" className="flex h-full min-h-0 flex-col gap-3 p-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">Storyboard</h2>
        <span data-testid="total" className="text-sm text-muted-foreground tabular-nums">
          {shots.length} {shots.length === 1 ? 'shot' : 'shots'}, {fmt(total)} s{target !== null && ` of ${fmt(target)} s`}
        </span>
        {over > 0 && (
          <Badge variant="warning" data-testid="overrun">
            <TriangleAlertIcon />
            {fmt(over)} s over the brief
          </Badge>
        )}
        <span className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => addAfter(shots.length - 1)}>
          <PlusIcon />
          Add shot
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {shots.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">No shots. Add one to start the board.</p>
        ) : (
          <ol className="flex flex-wrap items-stretch gap-y-4">
            {shots.map((shot, i) => (
              <li key={shot.id} className="flex items-stretch">
                <ShotCard
                  shot={shot}
                  index={i}
                  count={shots.length}
                  thumbnail={api.thumbnailUrl(comp, shot.frame, THUMB_HEIGHT, 0)}
                  note={notes[shot.id] ?? ''}
                  dragging={drag?.id === shot.id}
                  dropTarget={drag !== null && drag.over === i && drag.id !== shot.id}
                  registerRef={(el) => {
                    if (el) cards.current.set(shot.id, el);
                    else cards.current.delete(shot.id);
                  }}
                  onChange={(change) => patch(shot.id, change)}
                  onNote={(text) => setNotes((all) => ({ ...all, [shot.id]: text }))}
                  onMove={(delta) => moveTo(i, i + delta)}
                  onRemove={() => remove(shot.id)}
                  onAddAfter={() => addAfter(i)}
                  onDragStart={(e) => dragStart(e, shot.id, i)}
                  onDragMove={dragMove}
                  onDragEnd={dragEnd}
                  onDragCancel={() => setDrag(null)}
                />
                {i < shots.length - 1 && <TransitionChip index={i} shot={shot} onChange={(transition) => patch(shot.id, { transition })} />}
              </li>
            ))}
          </ol>
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
        <Button variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
        <Button variant="outline" onClick={() => submit(false)}>
          Rework and show me again
        </Button>
        <Button disabled={shots.length === 0} onClick={() => submit(true)}>
          Approve
        </Button>
      </footer>
    </section>
  );
}
