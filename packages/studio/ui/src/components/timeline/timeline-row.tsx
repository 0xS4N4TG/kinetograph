import type { ReactNode } from 'react';
import { EyeIcon, LockIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { indent } from '@/lib/tree';
import { cn } from '@/lib/utils';

/** Width of the sticky label column, px. */
export const LABEL_WIDTH = 264;

export function SectionLabel({ children }: { children: string }) {
  return (
    <div className="bg-secondary/50 text-muted-foreground sticky left-0 z-10 flex h-5 items-center border-b border-white/[0.06] px-2.5 text-[9px] font-semibold tracking-widest uppercase">
      {children}
    </div>
  );
}

export function EmptyRow({ children }: { children: string }) {
  return <div className="text-muted-foreground sticky left-0 h-7 px-2.5 py-1.5 text-xs">{children}</div>;
}

interface RowProps {
  index: number;
  swatch: string;
  label: string;
  badge?: string;
  title: string;
  depth: number;
  selected: boolean;
  onSelect: (() => void) | undefined;
  laneWidth: number;
  children: ReactNode;
  'data-testid': string;
}

export function Row({ index, swatch, label, badge, title, depth, selected, onSelect, laneWidth, children, ...rest }: RowProps) {
  return (
    <div
      {...rest}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-pressed={onSelect ? selected : undefined}
      title={title}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (onSelect && event.key === 'Enter') onSelect();
      }}
      className={cn(
        'group flex h-7 border-b border-white/[0.05] text-xs transition-colors odd:bg-[#17171b] even:bg-[#141418]',
        onSelect && 'hover:bg-white/[0.04] cursor-pointer',
        selected && 'bg-nle-blue/20 hover:bg-nle-blue/25',
      )}
    >
      <div
        className={cn(
          'sticky left-0 z-40 flex shrink-0 items-center gap-1.5 border-r border-white/10 pr-2',
          selected ? 'bg-[#1f3047] text-white shadow-[inset_2px_0_0_var(--nle-blue)]' : 'bg-[#1b1b20]',
          indent(depth),
        )}
        style={{ width: LABEL_WIDTH }}
      >
        <EyeIcon className="text-muted-foreground/70 size-3 shrink-0" aria-hidden="true" />
        <LockIcon className="text-muted-foreground/40 size-2.5 shrink-0" aria-hidden="true" />
        <span className="text-muted-foreground w-4 shrink-0 text-right font-mono text-[10px] tabular-nums" aria-hidden="true">
          {index}
        </span>
        <span className={cn('size-2.5 shrink-0 rounded-[2px]', swatch)} aria-hidden="true" />
        <span className="truncate text-[11px] font-medium">{label}</span>
        {badge && (
          <Badge variant="outline" className="text-muted-foreground ml-auto rounded-xs px-1 py-0 font-mono text-[9px]">
            {badge}
          </Badge>
        )}
      </div>
      <div className="relative h-full" style={{ width: laneWidth }}>
        {children}
      </div>
    </div>
  );
}

export function Bar({
  from,
  to,
  pxPerFrame,
  className,
  children,
}: {
  from: number;
  to: number;
  pxPerFrame: number;
  className: string;
  children?: string;
}) {
  return (
    <div
      className={cn(
        'absolute inset-y-1 overflow-hidden rounded-[3px] px-1.5 font-mono text-[10px] leading-[18px] font-medium whitespace-nowrap',
        className,
      )}
      style={{ left: from * pxPerFrame, width: Math.max(2, (to - from) * pxPerFrame) }}
    >
      {children}
    </div>
  );
}
