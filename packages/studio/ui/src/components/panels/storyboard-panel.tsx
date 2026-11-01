import { PlusIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useBuildId, useStudioContext } from '@/lib/studio-context';
import { cn } from '@/lib/utils';

import { cardScale, frameSrc } from './frame-src';
import { ShotCard, TransitionChip } from './storyboard-card';
import { currentOffset, fadeIn, slideFrom, type Offset } from './storyboard-motion';
import type { PanelProps, Shot, Storyboard, StoryboardAnswer } from './types';

/** The length of a shot added by hand, seconds. */
const NEW_SHOT_SECONDS = 2;
/** Dragging within this many px of the scroll area's top or bottom edge scrolls it, up to MAX_SCROLL px a frame. */
const SCROLL_EDGE = 72;
const MAX_SCROLL = 16;

/** One drag in flight. Kept in a ref: the pointer moves far more often than React needs to render. */
interface Drag {
  id: string;
  /** Where the grabbed shot is in the order right now. */
  index: number;
  /** The order when the drag began, to go back to on cancel. */
  snapshot: Shot[];
  /** The slots of the grid when the drag began, relative to the grid. */
  slots: { left: number; top: number; cx: number; cy: number }[];
  /** Where in the card it was grabbed. */
  grab: Offset;
  /** The pointer, in client coordinates. */
  pt: Offset;
  /** How far the card is moved from its place in the grid. */
  pos: Offset;
}

function reorder<T>(all: T[], from: number, to: number): T[] {
  if (from === to || to < 0 || to >= all.length) return all;
  const next = [...all];
  next.splice(to, 0, next.splice(from, 1)[0]!);
  return next;
}

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
  const studio = useStudioContext();
  const build = useBuildId();
  /** The stills are drawn for the card (twice its size), not as the timeline's tiny thumbnails. */
  const scale = cardScale(studio?.compositions.find((c) => c.id === comp));
  const [shots, setShots] = useState<Shot[]>(() => panel.data.shots.map((s) => ({ ...s })));
  const [removed, setRemoved] = useState<string[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const items = useRef(new Map<string, HTMLLIElement>());
  const grid = useRef<HTMLOListElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  /** Where each card sat in the grid after the last commit (offsets ignore transforms), for sliding the ones that moved. */
  const placed = useRef<Map<string, Offset> | null>(null);
  const sliding = useRef(new Map<string, Animation>());
  /** A released card: where it was shown, so it can settle into its slot. */
  const settling = useRef<{ id: string; visual: Offset } | null>(null);

  const total = shots.reduce((sum, s) => sum + s.seconds, 0);
  const over = target !== null && total > target + 1e-9 ? total - target : 0;

  const patch = (id: string, change: Partial<Shot>) => setShots((all) => all.map((s) => (s.id === id ? { ...s, ...change } : s)));

  const moveTo = (from: number, to: number) => setShots((all) => reorder(all, from, to));

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

  // Dragging: the handle captures the pointer and the grabbed card follows it. The order changes live to the slot whose centre is
  // nearest the pointer, and the cards that make way slide (below), so the gap shows where the shot will land.
  const positionDragged = (grid: HTMLElement) => {
    const d = dragRef.current;
    const li = d && items.current.get(d.id);
    if (!d || !li) return;
    const o = grid.getBoundingClientRect();
    d.pos = { x: d.pt.x - o.left - d.grab.x - li.offsetLeft, y: d.pt.y - o.top - d.grab.y - li.offsetTop };
    li.style.transform = `translate(${d.pos.x}px, ${d.pos.y}px)`;
  };
  const update = () => {
    const d = dragRef.current;
    const g = grid.current;
    if (!d || !g) return;
    const o = g.getBoundingClientRect();
    const px = d.pt.x - o.left;
    const py = d.pt.y - o.top;
    let over = d.index;
    let best = Infinity;
    d.slots.forEach((s, i) => {
      const distance = Math.hypot(px - s.cx, py - s.cy);
      if (distance < best) {
        best = distance;
        over = i;
      }
    });
    if (over !== d.index) {
      const from = d.index;
      d.index = over;
      setShots((all) => reorder(all, from, over));
    }
    positionDragged(g);
  };
  const dragStart = (e: PointerEvent<HTMLButtonElement>, id: string, index: number) => {
    const g = grid.current;
    if (e.button !== 0 || dragRef.current || !g) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const o = g.getBoundingClientRect();
    const slots = shots.map((s) => {
      const r = cards.current.get(s.id)?.getBoundingClientRect();
      return r
        ? { left: r.left - o.left, top: r.top - o.top, cx: r.left - o.left + r.width / 2, cy: r.top - o.top + r.height / 2 }
        : { left: 0, top: 0, cx: Infinity, cy: Infinity };
    });
    sliding.current.get(id)?.cancel();
    const li = items.current.get(id);
    if (li) li.style.zIndex = '20';
    dragRef.current = {
      id,
      index,
      snapshot: shots,
      slots,
      grab: { x: e.clientX - o.left - slots[index]!.left, y: e.clientY - o.top - slots[index]!.top },
      pt: { x: e.clientX, y: e.clientY },
      pos: { x: 0, y: 0 },
    };
    setDragId(id);
  };
  const dragMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d) return;
    d.pt = { x: e.clientX, y: e.clientY };
    update();
  };
  /** Lets go of the card: it settles into its slot, or, cancelled, the order from before the drag comes back. */
  const dragEnd = (cancel: boolean) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    const li = items.current.get(d.id);
    if (li) settling.current = { id: d.id, visual: { x: li.offsetLeft + d.pos.x, y: li.offsetTop + d.pos.y } };
    if (cancel) setShots(d.snapshot);
    setDragId(null);
  };

  // Escape cancels, and dragging near the top or bottom edge of the scroll area scrolls it.
  useEffect(() => {
    if (!dragId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      dragEnd(true);
    };
    window.addEventListener('keydown', onKey, true);
    let frame = 0;
    let lastTop = scroller.current?.scrollTop ?? 0;
    const tick = () => {
      const d = dragRef.current;
      const sc = scroller.current;
      if (d && sc) {
        const r = sc.getBoundingClientRect();
        const near = (gap: number) => Math.min(Math.max(SCROLL_EDGE - gap, 0), SCROLL_EDGE) / SCROLL_EDGE;
        sc.scrollTop += (near(r.bottom - d.pt.y) - near(d.pt.y - r.top)) * MAX_SCROLL;
        if (sc.scrollTop !== lastTop) {
          lastTop = sc.scrollTop;
          update();
        }
      }
      frame = requestAnimationFrame(tick);
    };
    if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    };
  }, [dragId]);

  // After the order changes, from a drag, the move buttons, an add or a remove: the cards that moved slide from where they were
  // shown to their new slots (FLIP, on the Web Animations API), a new card eases in, and the grabbed card is kept under the
  // pointer. Nothing here runs when the user prefers reduced motion, so the order just changes. Keys are the shot ids, so the
  // elements, thumbnails included, are moved and never remounted.
  const idsKey = shots.map((s) => s.id).join('|');
  useLayoutEffect(() => {
    const next = new Map<string, Offset>();
    items.current.forEach((li, id) => next.set(id, { x: li.offsetLeft, y: li.offsetTop }));
    const d = dragRef.current;
    if (d && grid.current) positionDragged(grid.current);
    const settle = settling.current;
    settling.current = null;
    const play = (id: string, li: HTMLLIElement, from: Offset, then?: () => void) => {
      sliding.current.get(id)?.cancel();
      const a = slideFrom(li, from, () => {
        if (sliding.current.get(id) === a) sliding.current.delete(id);
        then?.();
      });
      if (a) sliding.current.set(id, a);
      else then?.();
    };
    next.forEach((to, id) => {
      const li = items.current.get(id)!;
      if (id === d?.id) return;
      if (settle?.id === id) {
        li.style.transform = '';
        play(id, li, { x: settle.visual.x - to.x, y: settle.visual.y - to.y }, () => {
          li.style.zIndex = '';
        });
        return;
      }
      const before = placed.current?.get(id);
      if (!placed.current) return;
      if (!before) return fadeIn(li);
      if (before.x === to.x && before.y === to.y) return;
      const inflight = sliding.current.has(id) ? currentOffset(li) : { x: 0, y: 0 };
      play(id, li, { x: before.x - to.x + inflight.x, y: before.y - to.y + inflight.y });
    });
    placed.current = next;
  }, [idsKey, dragId]);

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

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        {shots.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">No shots. Add one to start the board.</p>
        ) : (
          <ol ref={grid} className={cn('relative grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] items-start gap-3', dragId && 'select-none')}>
            {shots.map((shot, i) => (
              <li
                key={shot.id}
                ref={(el) => {
                  if (el) items.current.set(shot.id, el);
                  else items.current.delete(shot.id);
                }}
                className="relative flex min-w-0 flex-col gap-1.5"
              >
                <ShotCard
                  shot={shot}
                  index={i}
                  count={shots.length}
                  thumbnail={frameSrc(comp, shot.frame, scale, build)}
                  note={notes[shot.id] ?? ''}
                  dragging={dragId === shot.id}
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
                  onDragEnd={() => dragEnd(false)}
                  onDragCancel={() => dragEnd(true)}
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
