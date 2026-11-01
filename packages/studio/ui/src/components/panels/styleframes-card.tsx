import { CheckIcon, MessageSquarePlusIcon, XIcon } from 'lucide-react';
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useBuildId } from '@/lib/studio-context';
import { cn } from '@/lib/utils';

import { frameSrc } from './frame-src';
import type { Box, Styleframe } from './types';

/** A note the person is writing: the box (when they drew one) is in composition pixels. */
export interface DraftNote {
  key: number;
  frame: string;
  text: string;
  box?: Box;
}

/** The address of a styleframe at the composition's own size (the studio's frame route, as `StudioApi.frameUrl` makes it). */
export function styleframeUrl(frame: Styleframe, build = 0): string {
  return frameSrc(frame.comp, frame.frame, 1, build);
}

/** Fewer displayed pixels than this between pointer down and up is a click, not a box. */
const CLICK_SLOP = 4;

export interface Drag {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The box between two corners, clamped to the picture and rounded to whole composition pixels. */
export function boxOf(drag: Drag, width: number, height: number): Box {
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
  const x0 = clamp(Math.min(drag.x0, drag.x1), width);
  const y0 = clamp(Math.min(drag.y0, drag.y1), height);
  const x1 = clamp(Math.max(drag.x0, drag.x1), width);
  const y1 = clamp(Math.max(drag.y0, drag.y1), height);
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
}

interface StyleframeCardProps {
  frame: Styleframe;
  /** The label shown as the letter: A, B, C. */
  letter: string;
  picked: boolean;
  notes: DraftNote[];
  /** The key of the note that should take the cursor (the one just drawn). */
  focusKey: number | null;
  onPick: () => void;
  onAddNote: (box?: Box) => void;
  onEditNote: (key: number, text: string) => void;
  onRemoveNote: (key: number) => void;
}

export function StyleframeCard({ frame, letter, picked, notes, focusKey, onPick, onAddNote, onEditNote, onRemoveNote }: StyleframeCardProps) {
  const build = useBuildId();
  const imageRef = useRef<HTMLImageElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [drag, setDrag] = useState<Drag | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  /** The pointer in composition pixels, from the picture's natural size; null until the picture has loaded. */
  const locate = (event: ReactPointerEvent): { x: number; y: number; size: { width: number; height: number }; scaleX: number } | null => {
    const img = imageRef.current;
    if (!img || img.naturalWidth === 0 || img.naturalHeight === 0) return null;
    const rect = img.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
      size: { width: img.naturalWidth, height: img.naturalHeight },
      scaleX,
    };
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
    if (!drag) return;
    const at = locate(event);
    if (at) setDrag({ ...drag, x1: at.x, y1: at.y });
  };

  const up = (event: ReactPointerEvent) => {
    if (!drag || !start.current) return;
    const at = locate(event);
    const end = at ? { ...drag, x1: at.x, y1: at.y } : drag;
    const moved = Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y);
    start.current = null;
    setDrag(null);
    if (moved < CLICK_SLOP || !at) return onPick();
    onAddNote(boxOf(end, at.size.width, at.size.height));
  };

  const natural = imageRef.current;
  const width = natural?.naturalWidth || 1;
  const height = natural?.naturalHeight || 1;
  const percent = (box: Box) => ({
    left: `${(box.x / width) * 100}%`,
    top: `${(box.y / height) * 100}%`,
    width: `${(box.w / width) * 100}%`,
    height: `${(box.h / height) * 100}%`,
  });
  const live = drag && natural ? boxOf(drag, width, height) : null;

  return (
    <section
      aria-label={`Styleframe ${letter}`}
      data-testid={`styleframe-${frame.id}`}
      className={cn('flex min-w-0 flex-col gap-2 rounded-lg border p-2 transition-colors', picked ? 'border-primary bg-primary/4' : 'border-border/60')}
    >
      <button
        type="button"
        role="radio"
        aria-checked={picked}
        aria-label={`Pick ${letter}`}
        onClick={onPick}
        className="flex min-w-0 cursor-pointer items-start gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-md border text-xs font-semibold',
            picked ? 'border-primary bg-primary text-primary-foreground' : 'border-input text-muted-foreground',
          )}
        >
          {picked ? <CheckIcon className="size-3.5" /> : letter}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{frame.label}</span>
          {/* The line is kept when there is no note, so the stills of all the cards start at the same height. */}
          <span className="text-muted-foreground block min-h-4 truncate text-xs" title={frame.note}>
            {frame.note}
          </span>
        </span>
      </button>

      <div
        data-testid={`still-${frame.id}`}
        className={cn('bg-muted relative touch-none select-none overflow-hidden rounded-md', state !== 'ready' && 'aspect-video')}
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
          src={styleframeUrl(frame, build)}
          alt={`${frame.label}: ${frame.comp} at frame ${frame.frame}`}
          draggable={false}
          onLoad={() => setState('ready')}
          onError={() => setState('error')}
          className={cn('block h-auto w-full', state !== 'ready' && 'invisible absolute inset-0 size-full')}
        />
        {state === 'loading' ? (
          <Skeleton data-testid="styleframe-skeleton" className="absolute inset-0 rounded-none" />
        ) : null}
        {state === 'error' ? (
          <div role="alert" className="text-muted-foreground absolute inset-0 flex items-center justify-center p-3 text-center text-xs">
            Could not draw {frame.comp} at frame {frame.frame}.
          </div>
        ) : null}
        {state === 'ready'
          ? notes.map((note, index) =>
              note.box ? (
                <div
                  key={note.key}
                  data-testid={`box-${frame.id}-${index + 1}`}
                  className="border-primary bg-primary/10 pointer-events-none absolute rounded-xs border-2"
                  style={percent(note.box)}
                >
                  <span className="bg-primary text-primary-foreground absolute -top-px -left-px rounded-br-sm px-1 text-[10px] leading-4 font-semibold">{index + 1}</span>
                </div>
              ) : null,
            )
          : null}
        {live ? <div className="border-primary bg-primary/15 pointer-events-none absolute rounded-xs border-2 border-dashed" style={percent(live)} /> : null}
      </div>

      <div className="flex flex-col gap-1.5">
        {notes.map((note, index) => (
          <div key={note.key} className="flex items-start gap-1.5">
            <span
              className={cn(
                'mt-1.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-[10px] font-semibold',
                note.box ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
              )}
              title={note.box ? `x ${note.box.x}, y ${note.box.y}, ${note.box.w} by ${note.box.h}` : 'A note on the whole frame'}
            >
              {index + 1}
            </span>
            <Textarea
              size="sm"
              aria-label={`Note ${index + 1} on ${letter}`}
              placeholder={note.box ? 'What about this area?' : 'A note on the whole frame'}
              value={note.text}
              autoFocus={note.key === focusKey}
              onChange={(event) => onEditNote(note.key, event.target.value)}
              className="min-w-0 flex-1"
            />
            <Button variant="ghost" size="icon-xs" aria-label={`Remove note ${index + 1} on ${letter}`} onClick={() => onRemoveNote(note.key)} className="mt-1">
              <XIcon />
            </Button>
          </div>
        ))}
        <Button variant="ghost" size="xs" onClick={() => onAddNote()} className="text-muted-foreground self-start">
          <MessageSquarePlusIcon /> Add note
        </Button>
        {notes.length === 0 ? <p className="text-muted-foreground text-xs">Drag on the frame to pin a note on an area.</p> : null}
      </div>
    </section>
  );
}
