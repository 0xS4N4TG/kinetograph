import { MessageSquarePlusIcon, XIcon } from 'lucide-react';
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

import { frameSrc } from '../frame-src';
import { boxOf } from '../styleframes-card';
import type { Block, Box, PictureNote } from '../types';
import { FrameImage } from './picture';
import { BlockShell } from './shell';

type NotesBlockType = Extract<Block, { type: 'notes' }>;
type CompareBlockType = Extract<Block, { type: 'compare' }>;

/** Fewer displayed pixels than this between pointer down and up is a click, not a box. */
const CLICK_SLOP = 4;

interface Drag {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A picture to drag boxes on, each with a note under it; the same gesture as the styleframes. Boxes are in composition pixels. */
export function NotesBlock({ block, value, onChange }: { block: NotesBlockType; value: unknown; onChange(value: PictureNote[]): void }) {
  const notes = Array.isArray(value) ? (value as PictureNote[]) : [];
  const imageRef = useRef<HTMLImageElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [drag, setDrag] = useState<Drag | null>(null);
  const [focus, setFocus] = useState<number | null>(null);

  /** The pointer in composition pixels, from the picture's natural size; null until the picture has loaded. */
  const locate = (event: ReactPointerEvent) => {
    const img = imageRef.current;
    if (!img || img.naturalWidth === 0 || img.naturalHeight === 0) return null;
    const rect = img.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: (event.clientX - rect.left) * (img.naturalWidth / rect.width),
      y: (event.clientY - rect.top) * (img.naturalHeight / rect.height),
      width: img.naturalWidth,
      height: img.naturalHeight,
    };
  };
  const add = (box?: Box) => {
    setFocus(notes.length);
    onChange([...notes, { text: '', ...(box ? { box } : {}) }]);
  };
  const down = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    const at = locate(event);
    if (!at) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, y: event.clientY };
    setDrag({ x0: at.x, y0: at.y, x1: at.x, y1: at.y });
  };
  const move = (event: ReactPointerEvent) => {
    const at = drag && locate(event);
    if (drag && at) setDrag({ ...drag, x1: at.x, y1: at.y });
  };
  const up = (event: ReactPointerEvent) => {
    if (!drag || !start.current) return;
    const at = locate(event);
    const moved = Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y);
    const end = at ? { ...drag, x1: at.x, y1: at.y } : drag;
    start.current = null;
    setDrag(null);
    if (moved >= CLICK_SLOP && at) add(boxOf(end, at.width, at.height));
  };

  const natural = imageRef.current;
  const width = natural?.naturalWidth || 1;
  const height = natural?.naturalHeight || 1;
  const percent = (box: Box) => ({ left: `${(box.x / width) * 100}%`, top: `${(box.y / height) * 100}%`, width: `${(box.w / width) * 100}%`, height: `${(box.h / height) * 100}%` });
  const live = drag && natural ? boxOf(drag, width, height) : null;
  const src = frameSrc(block.still.comp, block.still.frame, 1);

  return (
    <BlockShell block={block}>
      <div
        data-testid={`picture-${block.id}`}
        className={cn('bg-muted relative touch-none overflow-hidden rounded-md select-none', state !== 'ready' && 'aspect-video')}
        style={{ cursor: state === 'ready' ? 'crosshair' : undefined }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => {
          start.current = null;
          setDrag(null);
        }}
      >
        <img
          ref={imageRef}
          src={src}
          alt={`${block.still.comp} at frame ${block.still.frame}`}
          draggable={false}
          onLoad={() => setState('ready')}
          onError={() => setState('error')}
          className={cn('block h-auto w-full', state !== 'ready' && 'invisible absolute inset-0 size-full')}
        />
        {state === 'loading' ? <Skeleton data-testid="frame-skeleton" className="absolute inset-0 rounded-none" /> : null}
        {state === 'error' ? (
          <div role="alert" className="text-muted-foreground absolute inset-0 flex items-center justify-center p-3 text-center text-xs">
            Could not draw {block.still.comp} at frame {block.still.frame}.
          </div>
        ) : null}
        {state === 'ready'
          ? notes.map((note, i) =>
              note.box ? (
                <div key={i} data-testid={`box-${block.id}-${i + 1}`} className="border-primary bg-primary/10 pointer-events-none absolute rounded-xs border-2" style={percent(note.box)}>
                  <span className="bg-primary text-primary-foreground absolute -top-px -left-px rounded-br-sm px-1 text-[10px] leading-4 font-semibold">{i + 1}</span>
                </div>
              ) : null,
            )
          : null}
        {live ? <div className="border-primary bg-primary/15 pointer-events-none absolute rounded-xs border-2 border-dashed" style={percent(live)} /> : null}
      </div>
      <div className="flex flex-col gap-1.5">
        {notes.map((note, i) => (
          <div key={i} className="flex items-start gap-1.5">
            <span
              className={cn('mt-1.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-[10px] font-semibold', note.box ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}
              title={note.box ? `x ${note.box.x}, y ${note.box.y}, ${note.box.w} by ${note.box.h}` : 'A note on the whole frame'}
            >
              {i + 1}
            </span>
            <Textarea
              size="sm"
              aria-label={`Note ${i + 1}`}
              placeholder={note.box ? 'What about this area?' : 'A note on the whole frame'}
              value={note.text}
              autoFocus={i === focus}
              onChange={(e) => onChange(notes.map((n, at) => (at === i ? { ...n, text: e.target.value } : n)))}
              className="min-w-0 flex-1"
            />
            <Button variant="ghost" size="icon-xs" aria-label={`Remove note ${i + 1}`} className="mt-1" onClick={() => onChange(notes.filter((_, at) => at !== i))}>
              <XIcon />
            </Button>
          </div>
        ))}
        <Button variant="ghost" size="xs" onClick={() => add()} className="text-muted-foreground self-start">
          <MessageSquarePlusIcon /> Add note
        </Button>
        {notes.length === 0 ? <p className="text-muted-foreground text-xs">Drag on the picture to pin a note on an area.</p> : null}
      </div>
    </BlockShell>
  );
}

/** Two pictures side by side (stacked in a narrow panel) and a pick between them. */
export function CompareBlock({ block, value, onChange }: { block: CompareBlockType; value: unknown; onChange(value: 'a' | 'b' | null): void }) {
  return (
    <BlockShell block={block}>
      <div role="radiogroup" aria-label={block.label ?? block.id} className="grid grid-cols-1 gap-2 @sm:grid-cols-2">
        {(['a', 'b'] as const).map((side) => {
          const s = block[side];
          const on = value === side;
          const name = `${side.toUpperCase()}${s.label ? `, ${s.label}` : ''}`;
          return (
            <button
              key={side}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={name}
              data-side={side}
              onClick={() => onChange(side)}
              className={cn(
                'focus-visible:ring-ring flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-lg border p-2 text-left outline-none transition-colors focus-visible:ring-2',
                on ? 'border-primary bg-primary/4' : 'border-border/60 hover:bg-accent/50',
              )}
            >
              <FrameImage comp={s.comp} frame={s.frame} alt={`${name}: ${s.comp} at frame ${s.frame}`} />
              <span className="flex items-center gap-2 text-sm font-medium">
                <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-md border text-xs font-semibold', on ? 'border-primary bg-primary text-primary-foreground' : 'border-input text-muted-foreground')}>
                  {side.toUpperCase()}
                </span>
                <span className="min-w-0 truncate">{s.label}</span>
              </span>
            </button>
          );
        })}
      </div>
    </BlockShell>
  );
}
