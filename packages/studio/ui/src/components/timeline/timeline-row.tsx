import type { ReactNode } from 'react';
import { ChevronRightIcon } from 'lucide-react';

import type { LucideIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { indent } from '@/lib/tree';
import { cn } from '@/lib/utils';

/** Width of the sticky label column, px. */
export const LABEL_WIDTH = 248;
/** Space between the label column and time 0, px: the first clip and the 00:00 tick sit inside the panel. */
export const LANE_INSET = 14;
/** Height of a row, px: roomy enough to hit. */
export const ROW_HEIGHT = 48;

export function EmptyRow({ children }: { children: string }) {
  return <div className="text-muted-foreground sticky left-0 px-4 py-3 text-sm">{children}</div>;
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
      className={cn('sticky left-0 flex max-w-lg flex-col gap-2.5 px-4 py-4 text-sm', error ? 'text-destructive-foreground' : 'text-muted-foreground')}
    >
      <p>{children}</p>
      {progress !== undefined && <Progress value={progress === null ? 0 : Math.round(progress * 100)} aria-label="Timeline progress" />}
    </div>
  );
}

interface RowProps {
  icon: LucideIcon;
  /** The icon tile's colours. */
  tile: string;
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

export function Row({ icon: Icon, tile, label, count, detail, badge, title, depth, expanded, onToggle, selected, current, onSelect, laneWidth, children, ...rest }: RowProps) {
  return (
    <div {...rest} data-selected={selected || undefined} data-current={current || undefined} className="group/row flex" style={{ height: ROW_HEIGHT }}>
      <div
        className={cn(
          'bg-card sticky left-0 z-40 flex shrink-0 items-center pr-2 text-sm',
          selected && 'text-foreground',
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
            className="text-muted-foreground hover:text-foreground hover:bg-accent flex size-6 shrink-0 items-center justify-center rounded-md"
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
          className="focus-visible:ring-ring flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset"
        >
          <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-md', tile, current && 'ring-foreground/30 ring-2')} aria-hidden="true">
            <Icon className="size-3.5" />
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className={cn('truncate text-[13px] font-medium', !current && !selected && 'text-foreground/85')}>{label}</span>
              {count !== undefined && count > 1 && (
                <span data-testid="row-count" className="text-muted-foreground shrink-0 font-mono text-[11px]">
                  {`×${count}`}
                </span>
              )}
            </span>
            {detail && <span className="text-muted-foreground truncate text-[11px]">{detail}</span>}
          </span>
          {badge && (
            <Badge variant="outline" className="text-muted-foreground ml-auto shrink-0 rounded-full px-1.5 font-mono text-[10px]">
              {badge}
            </Badge>
          )}
        </button>
      </div>
      <div aria-hidden="true" className="shrink-0" style={{ width: LANE_INSET }} />
      <div data-lane className="relative h-full" style={{ width: laneWidth }}>
        {children}
      </div>
    </div>
  );
}

/** The height of a clip's thumbnail, px: the bar's inner height. */
export const THUMB_HEIGHT = 24;
/** A clip narrower than this shows no thumbnail, px. */
export const THUMB_MIN_BAR = 64;

/** A clip: a rounded block with its name, from frame `from` to `to` (exclusive), and a picture of its first frame. */
export function Bar({
  from,
  to,
  pxPerFrame,
  className,
  title,
  onClick,
  thumbnail,
  icon: Icon,
  tile,
  word,
  selected,
  children,
}: {
  icon?: LucideIcon;
  tile?: string;
  /** "Text", "Shape": shown before the name. */
  word?: string;
  selected?: boolean;
  from: number;
  to: number;
  pxPerFrame: number;
  className: string;
  title?: string;
  onClick?: () => void;
  /** The address of the picture of the clip's first frame. */
  thumbnail?: string | null;
  children?: string;
}) {
  const width = Math.max(4, (to - from) * pxPerFrame);
  const showThumb = thumbnail && width >= THUMB_MIN_BAR;
  return (
    <div
      data-testid="bar"
      title={title}
      onClick={onClick}
      className={cn(
        'absolute inset-y-1.5 flex cursor-pointer items-center gap-2 rounded-[10px] border pr-3 pl-1.5 text-xs font-medium whitespace-nowrap',
        selected ? 'border-primary ring-primary z-10 ring-[1.5px]' : 'overflow-hidden',
        className,
      )}
      style={{ left: from * pxPerFrame, width }}
    >
      {showThumb && (
        <img
          data-testid="bar-thumbnail"
          src={thumbnail}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className="h-full max-w-[45%] shrink-0 rounded-md object-cover"
          style={{ height: THUMB_HEIGHT }}
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
      )}
      {Icon && !showThumb && (
        <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-md', tile)} aria-hidden="true">
          <Icon className="size-3.5" />
        </span>
      )}
      <span className="truncate">
        {word && <span className="text-muted-foreground font-normal">{word}: </span>}
        {children}
      </span>
    </div>
  );
}
