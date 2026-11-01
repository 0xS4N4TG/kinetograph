import { CheckIcon } from 'lucide-react';

import { STAGES, type Stage, type StageInfo } from '../../../../src/panels/stages.ts';
import { cn } from '@/lib/utils';

/**
 * The stages of making a video (Brief to Deliver) over the preview. A stage is empty, open (a panel waits: click to bring
 * it up) or approved. Deliver has no panel: it opens the export dialog.
 */
export function PanelStepper({
  stages,
  shown,
  onSelect,
  onDeliver,
}: {
  stages: Record<Stage, StageInfo>;
  /** The panel on show, whose stage is marked as current. */
  shown: string | null;
  onSelect(stage: Stage): void;
  onDeliver(): void;
}) {
  return (
    <nav
      aria-label="Stages"
      data-testid="stage-stepper"
      className="bg-card/90 border-border/60 shadow-panel pointer-events-auto flex items-center gap-0.5 rounded-full border p-1 backdrop-blur"
    >
      {STAGES.map(({ id, label }) => {
        const info = stages[id];
        const current = info.panelId !== null && info.panelId === shown;
        const clickable = info.state === 'open' || id === 'deliver';
        return (
          <button
            key={id}
            type="button"
            data-stage={id}
            data-state={info.state}
            aria-current={current ? 'step' : undefined}
            aria-disabled={!clickable}
            title={info.state === 'open' ? `${label}: waiting for you` : info.state === 'approved' ? `${label}: approved` : id === 'deliver' ? 'Export' : label}
            onClick={() => {
              if (id === 'deliver') onDeliver();
              else if (info.state === 'open') onSelect(id);
            }}
            className={cn(
              'focus-visible:ring-ring flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium outline-none focus-visible:ring-2',
              clickable ? 'hover:bg-accent cursor-pointer' : 'cursor-default',
              info.state === 'empty' && 'text-muted-foreground',
              info.state === 'open' && 'text-foreground',
              info.state === 'approved' && 'text-foreground',
              current && 'bg-accent',
            )}
          >
            {info.state === 'approved' ? (
              <CheckIcon aria-hidden className="text-success size-3" />
            ) : (
              <span
                aria-hidden
                className={cn('size-2 rounded-full border', info.state === 'open' ? 'bg-primary border-primary animate-pulse' : 'border-muted-foreground/50')}
              />
            )}
            {label}
          </button>
        );
      })}
    </nav>
  );
}
