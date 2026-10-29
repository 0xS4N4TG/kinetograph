import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

import type { CompositionInfo } from '@/api';
import { cn } from '@/lib/utils';

const HEIGHT = 40;
const TILE = Math.round(HEIGHT * (16 / 9));

interface RangeGripProps {
  which: 'start' | 'end';
  value: number;
  last: number;
  onMove(frame: number): void;
  /** The frame under a pointer event. */
  frameAt(event: PointerEvent): number;
  style: CSSProperties;
  className?: string;
}

/** A chunky grip at one end of a span: drag it, or focus it and use the arrow keys (Shift for ten frames). */
export function RangeGrip({ which, value, last, onMove, frameAt, style, className }: RangeGripProps) {
  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 10 : 1;
    if (event.key === 'ArrowLeft') onMove(Math.max(0, value - step));
    else if (event.key === 'ArrowRight') onMove(Math.min(last, value + step));
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <div
      role="slider"
      aria-label={which === 'start' ? 'Range start' : 'Range end'}
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={value}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => event.buttons === 1 && onMove(frameAt(event))}
      className={cn(
        'bg-primary focus-visible:ring-ring absolute inset-y-0 z-10 flex w-3.5 cursor-ew-resize touch-none items-center justify-center outline-none focus-visible:ring-2',
        which === 'start' ? 'rounded-l-xl' : 'rounded-r-xl',
        className,
      )}
      style={style}
    >
      <span className="bg-primary-foreground/70 h-4 w-[2px] rounded-full" />
    </div>
  );
}

interface TrimBarProps {
  comp: CompositionInfo;
  /** First and last frame of the span, inclusive. */
  start: number;
  end: number;
  onChange(start: number, end: number): void;
  /** The address of a small picture of a frame; none draws plain tiles. */
  thumbnailUrl?: (frame: number, height: number) => string | null;
}

/**
 * A trim bar like a selected clip: a filmstrip of the whole composition, the span at full brightness inside a primary
 * outline with chunky grips at both ends, the rest dimmed. Drag a grip, or focus it and use the arrow keys.
 */
export function TrimBar({ comp, start, end, onChange, thumbnailUrl }: TrimBarProps) {
  const bar = useRef<HTMLDivElement>(null);
  const last = Math.max(1, comp.durationInFrames - 1);
  const pct = (frame: number) => (frame / last) * 100;
  const frameAt = (event: PointerEvent) => {
    const rect = bar.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(last, Math.max(0, Math.round(((event.clientX - rect.left) / rect.width) * last)));
  };
  const count = 8;

  const grip = (which: 'start' | 'end') => {
    const value = which === 'start' ? start : end;
    const move = (frame: number) => (which === 'start' ? onChange(Math.min(frame, end), end) : onChange(start, Math.max(frame, start)));
    return (
      <RangeGrip
        which={which}
        value={value}
        last={last}
        onMove={move}
        frameAt={frameAt}
        style={{ left: `calc(${pct(value)}% - ${(pct(value) / 100) * 14}px)` }}
      />
    );
  };

  const a = pct(start);
  const b = pct(end);
  return (
    <div ref={bar} data-testid="trim-bar" className="relative w-full select-none" style={{ height: HEIGHT }}>
      <div className="absolute inset-0 flex overflow-hidden rounded-xl" aria-hidden="true">
        {Array.from({ length: count }, (_, i) => {
          const frame = Math.min(last, Math.floor(((i + 0.5) / count) * comp.durationInFrames));
          const src = thumbnailUrl?.(frame, HEIGHT * 2);
          return (
            <div key={i} className="bg-muted relative h-full min-w-0 flex-1" style={{ maxWidth: TILE * 2 }}>
              {src && <img src={src} alt="" loading="lazy" draggable={false} className="size-full object-cover" onError={(event) => { event.currentTarget.style.display = 'none'; }} />}
            </div>
          );
        })}
        {/* the parts outside the span are dimmed */}
        <div className="bg-card/70 absolute inset-y-0 left-0" style={{ width: `${a}%` }} />
        <div className="bg-card/70 absolute inset-y-0 right-0" style={{ width: `${100 - b}%` }} />
      </div>
      <div className="border-primary pointer-events-none absolute inset-y-0 rounded-xl border-2" style={{ left: `${a}%`, width: `${Math.max(0, b - a)}%` }} />
      {grip('start')}
      {grip('end')}
    </div>
  );
}
