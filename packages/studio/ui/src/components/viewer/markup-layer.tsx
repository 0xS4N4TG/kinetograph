// Markup mode on the preview: an overlay in the frame that takes a pin, a box or a pen stroke, the numbered markers of the
// notes on this frame, and the comment bubble next to a mark. Geometry is in composition pixels, so it lines up at any zoom.

import { createPortal } from 'react-dom';
import { ArrowLeftRightIcon, EraserIcon, MapPinIcon, PencilLineIcon, SquareDashedIcon, Trash2Icon, type LucideIcon } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import type { CompositionInfo, InspectResult } from '@/api';
import { Hint } from '@/components/ui/hint';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { COLORS, layersUnder, markBounds, nearStroke, numberOf, simplify, useMarkup, useMarkupStore, visibleAt, type Geometry, type MarkTool, type Note, type Point } from '@/lib/markup';
import type { Player } from '@/lib/player';
import { useFrame } from '@/lib/player-hooks';
import { cn } from '@/lib/utils';

const TOOLS: { id: MarkTool; label: string; hint: string; icon: LucideIcon }[] = [
  { id: 'pin', label: 'Pin', hint: 'Click to drop a pin', icon: MapPinIcon },
  { id: 'box', label: 'Box', hint: 'Drag a box', icon: SquareDashedIcon },
  { id: 'pen', label: 'Pen', hint: 'Draw freehand', icon: PencilLineIcon },
  { id: 'eraser', label: 'Eraser', hint: 'Click a pen stroke to remove it', icon: EraserIcon },
  { id: 'range', label: 'Range', hint: 'Drag on the timeline ruler', icon: ArrowLeftRightIcon },
];

/** The tools of markup mode, as a pill under the preview's tools. */
export function MarkupToolbar() {
  const store = useMarkupStore();
  const markup = useMarkup();
  if (!store || !markup.active) return null;
  return (
    <div className="bg-card/80 border-border/60 pointer-events-auto flex items-center gap-0.5 rounded-full border p-1 shadow-sm backdrop-blur-md" role="toolbar" aria-label="Markup tools" data-testid="markup-toolbar">
      {TOOLS.map(({ id, label, hint, icon: Icon }) => (
        <Hint key={id} label={`${label}: ${hint}`}>
          <Button
            variant={markup.tool === id ? 'secondary' : 'ghost'}
            size="icon-sm"
            aria-label={label}
            aria-pressed={markup.tool === id}
            onClick={() => store.setTool(id)}
            className={cn('rounded-full', markup.tool === id && 'bg-accent text-accent-foreground')}
          >
            <Icon />
          </Button>
        </Hint>
      ))}
      <span className="bg-border mx-1 h-4 w-px" aria-hidden="true" />
      {COLORS.map(({ name, hex }) => (
        <button
          key={hex}
          type="button"
          aria-label={`Colour ${name}`}
          aria-pressed={markup.color === hex}
          onClick={() => store.setColor(hex)}
          className={cn('focus-visible:ring-ring flex size-6 items-center justify-center rounded-full outline-none focus-visible:ring-2')}
        >
          <span className={cn('size-3.5 rounded-full ring-offset-1 ring-offset-transparent transition-shadow motion-reduce:transition-none', markup.color === hex && 'ring-foreground/80 ring-2')} style={{ background: hex }} />
        </button>
      ))}
      <span className="bg-border mx-1 h-4 w-px" aria-hidden="true" />
      <Hint label="Leave markup (Esc)">
        <Button variant="ghost" size="sm" onClick={() => store.setActive(false)} className="rounded-full px-2.5 text-xs">
          Done
        </Button>
      </Hint>
    </div>
  );
}

type Draw = { kind: 'box'; from: { x: number; y: number }; to: { x: number; y: number } } | { kind: 'pen'; points: Point[] };

interface LayerProps {
  comp: CompositionInfo;
  player: Player;
  inspect: InspectResult | null;
  /** Screen pixels per composition pixel. */
  scale: number;
  /** Where the comment bubble is drawn: the preview's own box, which does not clip it. */
  host: HTMLElement | null;
  /** Changes whenever the picture moves on screen (zoom, pan, window size), so the bubble follows. */
  viewKey: string;
}

/** The overlay. Shows the markers of the notes on this frame always, and takes marks while markup mode is on. */
export function MarkupLayer({ comp, player, inspect, scale, host, viewKey }: LayerProps) {
  const store = useMarkupStore();
  const markup = useMarkup();
  const frame = Math.floor(useFrame(player));
  const layerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [drawing, setDrawing] = useState<Draw | null>(null);
  const drawingRef = useRef<Draw | null>(null);
  const down = useRef<{ px: number; py: number; id: number } | null>(null);
  if (!store) return null;

  const notes = markup.notes.filter((n) => n.comp === comp.id && visibleAt(n, frame));
  const onPicture = notes.filter((n) => n.geom.type !== 'range');
  const ranges = notes.filter((n) => n.geom.type === 'range');
  const open = markup.openId === null ? null : (markup.notes.find((n) => n.id === markup.openId) ?? null);
  const capturing = markup.active;

  const toComp = (event: PointerEvent): { x: number; y: number } | null => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    const x = ((event.clientX - rect.left) / rect.width) * comp.width;
    const y = ((event.clientY - rect.top) / rect.height) * comp.height;
    return { x: Math.min(comp.width, Math.max(0, x)), y: Math.min(comp.height, Math.max(0, y)) };
  };
  const keep = (geom: Geometry) => store.add({ comp: comp.id, frame, geom, layers: inspect ? layersUnder(inspect.layers, geom) : [] });
  const erase = (at: { x: number; y: number }) => {
    const reach = 10 / Math.max(scale, 0.01);
    for (const note of store.getState().notes) {
      if (note.comp === comp.id && visibleAt(note, frame) && note.geom.type === 'pen' && nearStroke(note.geom.points, at.x, at.y, reach)) store.remove(note.id);
    }
  };
  const setDraw = (next: Draw | null) => {
    drawingRef.current = next;
    setDrawing(next);
  };

  const onDown = (event: PointerEvent) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    const at = toComp(event);
    if (!at) return;
    surfaceRef.current?.setPointerCapture?.(event.pointerId);
    down.current = { px: event.clientX, py: event.clientY, id: event.pointerId };
    if (markup.tool === 'box') setDraw({ kind: 'box', from: at, to: at });
    else if (markup.tool === 'pen') setDraw({ kind: 'pen', points: [[at.x, at.y]] });
    else if (markup.tool === 'eraser') erase(at);
  };
  const onMove = (event: PointerEvent) => {
    event.stopPropagation();
    if (!down.current) return;
    const at = toComp(event);
    if (!at) return;
    const now = drawingRef.current;
    if (now?.kind === 'box') setDraw({ ...now, to: at });
    else if (now?.kind === 'pen') setDraw({ kind: 'pen', points: [...now.points, [at.x, at.y]] });
    else if (markup.tool === 'eraser') erase(at);
  };
  const onUp = (event: PointerEvent) => {
    event.stopPropagation();
    const from = down.current;
    down.current = null;
    if (!from) return;
    const at = toComp(event);
    const now = drawingRef.current;
    setDraw(null);
    if (markup.tool === 'pin') {
      if (at && Math.hypot(event.clientX - from.px, event.clientY - from.py) < 6) keep({ type: 'pin', x: at.x, y: at.y });
    } else if (now?.kind === 'box') {
      const x = Math.min(now.from.x, now.to.x);
      const y = Math.min(now.from.y, now.to.y);
      const width = Math.abs(now.from.x - now.to.x);
      const height = Math.abs(now.from.y - now.to.y);
      // A box must be big enough on screen to mean it: a click is not a box.
      if (width * scale >= 6 && height * scale >= 6) keep({ type: 'box', x, y, width, height });
    } else if (now?.kind === 'pen') {
      const points = simplify(now.points, 1.5 / Math.max(scale, 0.01));
      if (points.length >= 2) keep({ type: 'pen', points });
    }
  };

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0" data-testid="markup-layer" onClick={(event) => event.stopPropagation()}>
      <svg className="absolute inset-0 size-full" viewBox={`0 0 ${comp.width} ${comp.height}`} preserveAspectRatio="none" aria-hidden="true">
        {onPicture.map((note) => (
          <Shape key={note.id} note={note} />
        ))}
        {drawing?.kind === 'box' && (
          <rect
            data-testid="markup-drawing"
            x={Math.min(drawing.from.x, drawing.to.x)}
            y={Math.min(drawing.from.y, drawing.to.y)}
            width={Math.abs(drawing.from.x - drawing.to.x)}
            height={Math.abs(drawing.from.y - drawing.to.y)}
            fill="none"
            stroke={markup.color}
            strokeWidth={2}
            strokeDasharray="5 3"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {drawing?.kind === 'pen' && (
          <polyline data-testid="markup-drawing" points={drawing.points.map((p) => p.join(',')).join(' ')} fill="none" stroke={markup.color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      {capturing && (
        <div
          ref={surfaceRef}
          data-testid="markup-surface"
          className={cn('pointer-events-auto absolute inset-0 touch-none', markup.tool === 'range' ? 'cursor-default' : 'cursor-crosshair')}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onClick={(event) => event.stopPropagation()}
        />
      )}
      {onPicture.map((note) => (
        <Marker key={note.id} note={note} number={numberOf(note, markup.notes)} comp={comp} open={() => store.open(note.id)} />
      ))}
      {ranges.length > 0 && (
        <div className="absolute top-2 left-2 flex flex-col gap-1">
          {ranges.map((note) => (
            <Marker key={note.id} note={note} number={numberOf(note, markup.notes)} comp={comp} open={() => store.open(note.id)} pill />
          ))}
        </div>
      )}
      {open && open.comp === comp.id && (
        <Bubble key={open.id} note={open} number={numberOf(open, markup.notes)} comp={comp} layer={layerRef} host={host} viewKey={viewKey} />
      )}
    </div>
  );
}

/** The mark itself, in the colour it was drawn in (greyer when resolved, fainter when sent). */
function Shape({ note }: { note: Note }) {
  const faded = note.resolved ? 0.35 : note.status === 'sent' ? 0.55 : 1;
  const g = note.geom;
  const color = note.resolved ? '#9ca3af' : note.color;
  if (g.type === 'box') {
    return <rect data-testid="markup-box" x={g.x} y={g.y} width={g.width} height={g.height} fill="none" stroke={color} strokeWidth={2} strokeDasharray={note.status === 'sent' ? '5 3' : undefined} opacity={faded} vectorEffect="non-scaling-stroke" />;
  }
  if (g.type === 'pen') {
    return <polyline data-testid="markup-stroke" points={g.points.map((p) => p.join(',')).join(' ')} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" opacity={faded} vectorEffect="non-scaling-stroke" />;
  }
  return null;
}

/** The numbered marker of a note: a pin, the corner of a box, the start of a stroke, or a pill for a range. */
function Marker({ note, number, comp, open, pill = false }: { note: Note; number: number | null; comp: CompositionInfo; open(): void; pill?: boolean }) {
  const at = markBounds(note.geom);
  const label = note.resolved ? '✓' : number === null ? '•' : String(number);
  const start = note.geom.type === 'pen' ? note.geom.points[0]! : at ? ([at.x, at.y] as const) : null;
  const sent = note.status === 'sent';
  const style = note.resolved ? undefined : sent ? { borderColor: note.color, color: note.color } : { background: note.color };
  return (
    <button
      type="button"
      data-testid="markup-marker"
      data-state={note.resolved ? 'resolved' : note.status}
      aria-label={`Note ${label}${sent ? ' (sent)' : ''}${note.resolved ? ' (resolved)' : ''}: ${note.text || 'no comment'}`}
      title={note.text || 'No comment'}
      onClick={open}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      style={{ ...(pill || !start ? {} : { left: `${(start[0] / comp.width) * 100}%`, top: `${(start[1] / comp.height) * 100}%` }), ...style }}
      className={cn(
        'pointer-events-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold shadow outline-none focus-visible:ring-2 focus-visible:ring-white',
        pill ? 'relative' : 'absolute -translate-x-1/2 -translate-y-1/2',
        sent ? 'border-2 bg-black/40' : note.resolved ? 'bg-muted-foreground/60 text-white' : 'text-white ring-2 ring-white/90',
        note.resolved && 'opacity-60',
      )}
    >
      {label}
      {pill && <span className="ml-1 font-normal">range</span>}
    </button>
  );
}

const BUBBLE_WIDTH = 272;

/** The comment bubble next to a mark: Enter keeps the note, Cmd/Ctrl+Enter sends it now, Esc closes. */
function Bubble({ note, number, comp, layer, host, viewKey }: { note: Note; number: number | null; comp: CompositionInfo; layer: React.RefObject<HTMLDivElement | null>; host: HTMLElement | null; viewKey: string }) {
  const store = useMarkupStore()!;
  const [text, setText] = useState(note.text);
  const [pos, setPos] = useState({ left: 12, top: 12 });
  const fresh = note.status === 'draft';

  useLayoutEffect(() => {
    const frame = layer.current?.getBoundingClientRect();
    const around = (host ?? layer.current?.parentElement)?.getBoundingClientRect();
    if (!frame || !around || frame.width === 0) return;
    const b = markBounds(note.geom) ?? { x: 0, y: 0, width: 0, height: 0 };
    const sx = frame.width / comp.width;
    const sy = frame.height / comp.height;
    const offsetX = frame.left - around.left;
    const offsetY = frame.top - around.top;
    const right = offsetX + (b.x + b.width) * sx + 14;
    const left = right + BUBBLE_WIDTH <= around.width - 8 ? right : Math.max(8, offsetX + b.x * sx - 14 - BUBBLE_WIDTH);
    const top = Math.max(8, Math.min(offsetY + b.y * sy - 8, around.height - 170));
    setPos((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
  }, [note.geom, comp.width, comp.height, viewKey, layer, host]);

  const keep = (send: boolean) => {
    if (fresh) store.commit(note.id, text);
    else store.update(note.id, text);
    if (send) store.requestSend([note.id]);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      store.dismiss(note.id);
    } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      keep(event.metaKey || event.ctrlKey);
    }
  };

  const bubble = (
    <div
      role="dialog"
      aria-label={`Comment on note ${number ?? ''}`}
      data-testid="markup-bubble"
      className="bg-popover text-popover-foreground border-border pointer-events-auto absolute z-30 flex flex-col gap-2 rounded-xl border p-2.5 shadow-lg"
      style={{ left: pos.left, top: pos.top, width: BUBBLE_WIDTH }}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
        <span className="size-2.5 rounded-full" style={{ background: note.color }} aria-hidden="true" />
        <span>
          Note {number ?? ''} · {note.endFrame > note.frame ? `frames ${note.frame}-${note.endFrame}` : `frame ${note.frame}`}
        </span>
        {note.layers.length > 0 && <span className="min-w-0 flex-1 truncate">· {note.layers.join(', ')}</span>}
      </div>
      <textarea
        autoFocus
        aria-label="Comment on this mark"
        value={text}
        rows={2}
        placeholder="What should change here?"
        onChange={(event) => {
          setText(event.target.value);
          store.setText(note.id, event.target.value);
        }}
        onKeyDown={onKeyDown}
        className="placeholder:text-muted-foreground/70 border-input bg-background focus-visible:border-ring focus-visible:ring-ring/20 block w-full resize-none rounded-lg border px-2 py-1.5 text-[13px] leading-snug outline-none focus-visible:ring-[3px]"
      />
      <div className="flex items-center gap-1.5">
        {!fresh && (
          <button type="button" aria-label="Delete this note" onClick={() => store.remove(note.id)} className="text-muted-foreground hover:text-destructive-foreground hover:bg-accent focus-visible:ring-ring rounded-md p-1.5 outline-none focus-visible:ring-2">
            <Trash2Icon className="size-3.5" aria-hidden="true" />
          </button>
        )}
        <span className="text-muted-foreground ml-auto flex items-center gap-1 text-[10px]">
          <Kbd>Enter</Kbd> add
        </span>
        <Button size="xs" variant="outline" className="rounded-full" onClick={() => keep(true)}>
          Send now <Kbd>{'⌘'}Enter</Kbd>
        </Button>
        <Button size="xs" className="rounded-full" onClick={() => keep(false)}>
          {fresh ? 'Add' : 'Save'}
        </Button>
      </div>
    </div>
  );
  return host ? createPortal(bubble, host) : bubble;
}
