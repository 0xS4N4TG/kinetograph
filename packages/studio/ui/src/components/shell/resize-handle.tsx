import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

import { cn } from '@/lib/utils';

interface ResizeHandleProps {
  /** `vertical` is a bar between side-by-side panels (drag left and right); `horizontal` sits between stacked ones. */
  orientation: 'vertical' | 'horizontal';
  /** The panel's size, px, now; the drag moves it from here. */
  size: number;
  /** +1 when dragging towards the end (right, down) grows the panel, -1 when it shrinks it. */
  direction: 1 | -1;
  min: number;
  max: number;
  onResize(size: number): void;
  /** Double click: back to the default. */
  onReset?(): void;
  label: string;
  className?: string;
}

/** A strip in the gutter between two panels: drag to resize (Shift: coarser), arrow keys too, double click to reset. */
export function ResizeHandle({ orientation, size, direction, min, max, onResize, onReset, label, className }: ResizeHandleProps) {
  const from = useRef<{ at: number; size: number } | null>(null);
  const horizontal = orientation === 'horizontal';
  const clamp = (value: number) => Math.min(max, Math.max(min, value));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button > 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    from.current = { at: horizontal ? event.clientY : event.clientX, size };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = from.current;
    if (!start) return;
    const delta = (horizontal ? event.clientY : event.clientX) - start.at;
    onResize(clamp(start.size + delta * direction));
  };
  const end = () => {
    from.current = null;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = horizontal ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    const index = keys.indexOf(event.key);
    if (index < 0) return;
    event.preventDefault();
    const step = event.shiftKey ? 80 : 16;
    // The first key points towards the start (left, up).
    onResize(clamp(size + (index === 0 ? -1 : 1) * direction * step));
  };

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={Math.round(size)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className={cn(
        'group/handle relative z-10 shrink-0 touch-none outline-none select-none',
        horizontal ? 'h-3 cursor-row-resize' : 'w-3 cursor-col-resize',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'bg-foreground/0 group-hover/handle:bg-foreground/25 group-focus-visible/handle:bg-ring group-active/handle:bg-foreground/40 absolute rounded-full transition-colors',
          horizontal ? 'inset-x-[30%] top-1/2 h-[3px] -translate-y-1/2' : 'inset-y-[30%] left-1/2 w-[3px] -translate-x-1/2',
        )}
      />
    </div>
  );
}
