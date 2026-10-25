import type { ReactNode } from 'react';
import { ChevronRightIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { indent } from '@/lib/tree';
import { cn } from '@/lib/utils';

/** Width of the sticky label column, px. */
export const LABEL_WIDTH = 288;
/** Height of a row, px: big enough to hit. */
export const ROW_HEIGHT = 36;

export function EmptyRow({ children }: { children: string }) {
  return <div className="text-muted-foreground sticky left-0 h-9 px-3 py-2 text-xs">{children}</div>;
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
  swatch: string;
  label: string;
  /** Folded instances: the count after the name. */
  count?: number;
  /** Details mode: the grey line under the name (component, file:line). */
  detail?: string;
  /** Details mode: the kind tag. */
  badge?: string;
  title: string;
  depth: number;
  /** Chevron state; undefined when there is nothing to open. */
  expanded: boolean | undefined;
  onToggle?: () => void;
  selected: boolean;
  /** The playhead is inside one of the row's bars. */
  current: boolean;
  onSelect: () => void;
  laneWidth: number;
  children: ReactNode;
  'data-testid': string;
}

export function Row({ swatch, label, count, detail, badge, title, depth, expanded, onToggle, selected, current, onSelect, laneWidth, children, ...rest }: RowProps) {
  return (
    <div {...rest} data-selected={selected || undefined} data-current={current || undefined} className={cn('flex border-b border-white/[0.04]', selected && 'bg-nle-blue/10')} style={{ height: ROW_HEIGHT }}>
      <div
        className={cn(
          'sticky left-0 z-40 flex shrink-0 items-center border-r border-white/10 pr-2 text-xs',
          selected ? 'bg-[#1f3047] text-white shadow-[inset_3px_0_0_var(--nle-blue)]' : 'bg-[#1b1b20] hover:bg-[#22222a]',
          indent(depth),
        )}
        style={{ width: LABEL_WIDTH }}
      >
        {expanded === undefined ? (
          <span className="size-6 shrink-0" aria-hidden="true" />
        ) : (
          <button
            type="button"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
            aria-expanded={expanded}
            data-testid="row-toggle"
            onClick={(event) => {
              event.stopPropagation();
              onToggle?.();
            }}
            className="text-muted-foreground hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-white/10"
          >
            <ChevronRightIcon className={cn('size-4 transition-transform', expanded && 'rotate-90')} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          title={title}
          aria-pressed={selected}
          data-testid="row-select"
          onClick={onSelect}
          className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-inset"
        >
          <span className={cn('size-3 shrink-0 rounded-[3px]', swatch, current && 'ring-2 ring-white/70')} aria-hidden="true" />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className={cn('truncate text-[12px] font-medium', current && 'text-white')}>{label}</span>
              {count !== undefined && count > 1 && (
                <span data-testid="row-count" className="text-muted-foreground shrink-0 font-mono text-[10px]">
                  {`×${count}`}
                </span>
              )}
            </span>
            {detail && <span className="text-muted-foreground/70 truncate text-[10px]">{detail}</span>}
          </span>
          {badge && (
            <Badge variant="outline" className="text-muted-foreground ml-auto shrink-0 rounded-xs px-1 py-0 font-mono text-[9px]">
              {badge}
            </Badge>
          )}
        </button>
      </div>
      <div data-lane className="relative h-full" style={{ width: laneWidth }}>
        {children}
      </div>
    </div>
  );
}

/** A clip: a rounded block with its name, from frame `from` to `to` (exclusive). */
export function Bar({
  from,
  to,
  pxPerFrame,
  className,
  title,
  onClick,
  children,
}: {
  from: number;
  to: number;
  pxPerFrame: number;
  className: string;
  title?: string;
  onClick?: () => void;
  children?: string;
}) {
  return (
    <div
      data-testid="bar"
      title={title}
      onClick={onClick}
      className={cn(
        'absolute inset-y-1.5 cursor-pointer overflow-hidden rounded-md px-2 text-[11px] leading-[22px] font-medium whitespace-nowrap shadow-xs',
        className,
      )}
      style={{ left: from * pxPerFrame, width: Math.max(4, (to - from) * pxPerFrame) }}
    >
      {children}
    </div>
  );
}
