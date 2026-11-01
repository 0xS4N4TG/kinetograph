import { CheckIcon } from 'lucide-react';

import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import { cn } from '@/lib/utils';
import { STAGES, type CustomPill, type Stage, type StageInfo } from '../../../../src/panels/stages.ts';

/** Custom panels shown as pills of their own; the rest go in a "+n" menu. */
const PILLS_SHOWN = 3;

function Dot({ state }: { state: 'empty' | 'open' | 'approved' }) {
  return state === 'approved' ? (
    <CheckIcon aria-hidden className="text-success size-3" />
  ) : (
    <span aria-hidden className={cn('size-2 rounded-full border', state === 'open' ? 'bg-primary border-primary animate-pulse' : 'border-muted-foreground/50')} />
  );
}

/**
 * The stages of making a video (Brief to Deliver), in a row of its own above the preview. A stage is empty, open (a panel
 * waits: click to bring it up) or approved (click to see its saved answer). Deliver has no panel: it opens the export
 * dialog. When the row is narrow, only the stage on show keeps its label. Custom panels are not stages: they follow
 * Deliver as pills of their own (the last three, and a "+n" menu for the rest), so they can be brought back.
 */
export function PanelStepper({
  stages,
  extras = [],
  shown,
  onSelect,
  onSelectExtra,
  onDeliver,
}: {
  stages: Record<Stage, StageInfo>;
  /** The custom panels, oldest first. */
  extras?: CustomPill[];
  /** The panel on show (open or answered), whose stage is marked as current. */
  shown: string | null;
  onSelect(stage: Stage): void;
  /** Brings up a custom panel by its panel id. */
  onSelectExtra?(id: string): void;
  onDeliver(): void;
}) {
  const visible = extras.slice(-PILLS_SHOWN);
  const more = extras.slice(0, -PILLS_SHOWN);
  const pill = (extra: CustomPill) => {
    const current = shown === extra.id;
    return (
      <button
        key={extra.id}
        type="button"
        data-testid="custom-pill"
        data-name={extra.name}
        data-state={extra.state}
        aria-current={current ? 'step' : undefined}
        title={extra.state === 'open' ? `${extra.title}: waiting for you` : `${extra.title}: sent, click to see it`}
        onClick={() => onSelectExtra?.(extra.id)}
        className={cn(
          'hover:bg-accent focus-visible:ring-ring flex max-w-32 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium outline-none focus-visible:ring-2',
          current && 'bg-accent',
        )}
      >
        <Dot state={extra.state === 'open' ? 'open' : 'approved'} />
        <span className="truncate">{extra.title}</span>
      </button>
    );
  };
  return (
    <nav
      aria-label="Stages"
      data-testid="stage-stepper"
      className="bg-card border-border/60 shadow-panel flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full border p-1 [scrollbar-width:none]"
    >
      {STAGES.map(({ id, label }) => {
        const info = stages[id];
        const current = shown !== null && (info.panelId === shown || info.approvedId === shown);
        const clickable = info.state !== 'empty' || id === 'deliver';
        return (
          <button
            key={id}
            type="button"
            data-stage={id}
            data-state={info.state}
            aria-label={label}
            aria-current={current ? 'step' : undefined}
            aria-disabled={!clickable}
            title={info.state === 'open' ? `${label}: waiting for you` : info.state === 'approved' ? `${label}: approved, click to see it` : id === 'deliver' ? 'Export' : label}
            onClick={() => {
              if (id === 'deliver') onDeliver();
              else if (info.state !== 'empty') onSelect(id);
            }}
            className={cn(
              'focus-visible:ring-ring flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium outline-none focus-visible:ring-2',
              clickable ? 'hover:bg-accent cursor-pointer' : 'cursor-default',
              info.state === 'empty' && 'text-muted-foreground',
              info.state === 'open' && 'text-foreground',
              info.state === 'approved' && 'text-foreground',
              current && 'bg-accent',
            )}
          >
            <Dot state={info.state} />
            <span className={cn(!current && 'hidden @min-[34rem]:inline')}>{label}</span>
          </button>
        );
      })}
      {extras.length > 0 && <span aria-hidden className="bg-border mx-1 h-4 w-px shrink-0" />}
      {more.length > 0 && (
        <Menu>
          <MenuTrigger
            aria-label={`${more.length} more panels`}
            data-testid="custom-more"
            className="hover:bg-accent text-muted-foreground focus-visible:ring-ring shrink-0 cursor-pointer rounded-full px-2 py-1 text-xs font-medium outline-none focus-visible:ring-2"
          >
            +{more.length}
          </MenuTrigger>
          <MenuPopup align="end">
            {more.map((extra) => (
              <MenuItem key={extra.id} onClick={() => onSelectExtra?.(extra.id)}>
                <Dot state={extra.state === 'open' ? 'open' : 'approved'} />
                {extra.title}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      )}
      {visible.map(pill)}
    </nav>
  );
}
