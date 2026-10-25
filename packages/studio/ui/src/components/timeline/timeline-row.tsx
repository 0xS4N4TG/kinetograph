import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
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

/** What stands in for the rows while the timeline is being read, or when it could not be. */
export function TimelineNotice({
  children,
  progress,
  error,
  testId,
}: {
  children: string;
  /** 0 to 1, or null when the total is not known yet. */
  progress?: number | null;
  error?: boolean;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      role={error ? 'alert' : 'status'}
      className={cn('sticky left-0 flex max-w-lg flex-col gap-2 px-4 py-5 text-xs', error ? 'text-destructive' : 'text-muted-foreground')}
    >
      <p>{children}</p>
      {progress !== undefined && (
        <Progress value={progress === null ? 0 : Math.round(progress * 100)} aria-label="Timeline progress" className="h-1.5" />
      )}
    </div>
  );
}

interface RowProps {
  index: number;
  swatch: string;
  label: string;
  /** Dim text after the label: the component and the source line. */
  detail?: string;
  badge?: string;
  title: string;
  depth: number;
  selected: boolean;
  onSelect: (() => void) | undefined;
  laneWidth: number;
  children: ReactNode;
  'data-testid': string;
}

export function Row({ index, swatch, label, detail, badge, title, depth, selected, onSelect, laneWidth, children, ...rest }: RowProps) {
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
        <span className="text-muted-foreground w-4 shrink-0 text-right font-mono text-[10px] tabular-nums" aria-hidden="true">
          {index}
        </span>
        <span className={cn('size-2.5 shrink-0 rounded-[2px]', swatch)} aria-hidden="true" />
        <span className="truncate text-[11px] font-medium">{label}</span>
        {detail && <span className="text-muted-foreground/60 min-w-0 truncate text-[10px]">{detail}</span>}
        {badge && (
          <Badge variant="outline" className="text-muted-foreground ml-auto rounded-xs px-1 py-0 font-mono text-[9px]">
            {badge}
          </Badge>
        )}
      </div>
      <div data-lane className="relative h-full" style={{ width: laneWidth }}>
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
