import { useRef, type ComponentProps, type MouseEvent } from 'react';

import { cn } from '@/lib/utils';

/** Card with a cursor-following glow (21st.dev "spotlight card" pattern). */
export function SpotlightCard({ className, children, ...props }: ComponentProps<'div'>) {
  const ref = useRef<HTMLDivElement>(null);
  const onMove = (event: MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--x', `${event.clientX - rect.left}px`);
    el.style.setProperty('--y', `${event.clientY - rect.top}px`);
  };
  return (
    <div
      ref={ref}
      onMouseMove={onMove}
      className={cn('group bg-card/60 relative overflow-hidden rounded-2xl border p-6', className)}
      {...props}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-px opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: 'radial-gradient(360px circle at var(--x) var(--y), oklch(1 0 0 / 9%), transparent 70%)' }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}

/** Endlessly scrolling row (21st.dev "marquee"). Content is duplicated for a seamless loop. */
export function Marquee({ items, className }: { items: string[]; className?: string }) {
  const row = (
    <div className="flex shrink-0 animate-marquee gap-4">
      {items.map((item) => (
        <span key={item} className="bg-card/60 text-muted-foreground rounded-full border px-4 py-1.5 font-mono text-xs whitespace-nowrap">
          {item}
        </span>
      ))}
    </div>
  );
  return (
    <div
      className={cn('flex gap-4 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_15%,black_85%,transparent)]', className)}
    >
      {row}
      {row}
    </div>
  );
}

/** Shimmering gradient text. */
export function ShimmerText({ children, className }: { children: string; className?: string }) {
  return (
    <span
      className={cn(
        'animate-shimmer bg-[linear-gradient(110deg,oklch(0.6_0_0),oklch(0.99_0_0)_40%,oklch(0.6_0_0)_60%)] bg-[length:200%_100%] bg-clip-text text-transparent',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Faint grid with a radial fade, used behind the hero. */
export function GridBackground({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,oklch(1_0_0/6%)_1px,transparent_1px),linear-gradient(to_bottom,oklch(1_0_0/6%)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)]',
        className,
      )}
    />
  );
}
