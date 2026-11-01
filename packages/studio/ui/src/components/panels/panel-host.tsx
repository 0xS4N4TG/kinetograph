// Where the panels the agent opens are shown (docs/proposals/studio-panels.md): the stepper over the preview, and the open
// panel as a large sheet over it, or, for a review, docked beside it so the preview stays in view. The component for each
// kind comes from the registry; this only frames it and wires its answer to the socket.

import { ChevronDownIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';

import type { OpenPanel, PanelAnswer, PanelKind } from '@/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import { stageStates, type Stage } from '../../../../src/panels/stages.ts';
import { panelComponents } from './registry';
import type { PanelProps } from './types';

const TITLES: Record<PanelKind, string> = { brief: 'Brief', script: 'Script', storyboard: 'Storyboard', styleframes: 'Styleframes', review: 'Review' };

/** Which panel is on show: a new one comes up by itself; the person can put it away and bring it back from the stepper. */
export function usePanelView(panels: OpenPanel[], delivered: boolean) {
  const stages = useMemo(() => stageStates(panels, delivered), [panels, delivered]);
  const [viewId, setViewId] = useState<string | null>(null);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const panel of panels) {
      if (panel.status === 'open' && !seen.current.has(panel.id)) {
        seen.current.add(panel.id);
        setViewId(panel.id);
      }
    }
  }, [panels]);
  const shown = panels.find((p) => p.id === viewId && p.status === 'open') ?? null;
  return {
    stages,
    shown,
    /** Whether anything has been asked yet: the stepper stays out of the way until then. */
    active: panels.length > 0,
    /** Brings up the open panel of a stage; again, puts it away. */
    select: (stage: Stage) => {
      const id = stages[stage].panelId;
      if (id !== null) setViewId((current) => (current === id ? null : id));
    },
    hide: () => setViewId(null),
  };
}

export interface PanelFrameProps {
  panel: OpenPanel;
  error?: string;
  onSubmit(id: string, answer: PanelAnswer[PanelKind]): boolean;
  onDismiss(id: string): boolean;
  onHide(): void;
  className?: string;
}

/** A panel with its title, the agent's one-line message above it and, if the server refused an answer, why. */
function PanelFrame({ panel, error, onSubmit, onDismiss, onHide, className }: PanelFrameProps) {
  const Component = panelComponents[panel.panel] as ComponentType<PanelProps<PanelKind>>;
  return (
    <div data-testid="panel-frame" data-panel={panel.panel} className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="flex h-11 shrink-0 items-center gap-2 px-4">
        <h2 className="text-sm font-semibold">{TITLES[panel.panel]}</h2>
        <div className="flex-1" />
        <Hint label="Put away (reopen from the stages)">
          <Button variant="ghost" size="icon-sm" aria-label="Put the panel away" onClick={onHide}>
            <ChevronDownIcon />
          </Button>
        </Hint>
      </div>
      {panel.message && (
        <p data-testid="panel-message" className="text-muted-foreground shrink-0 px-4 pb-2 text-sm">
          {panel.message}
        </p>
      )}
      {error && (
        <Alert variant="error" className="mx-4 mb-2 w-auto shrink-0">
          {error}
        </Alert>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Component panel={panel} onSubmit={(answer) => onSubmit(panel.id, answer)} onDismiss={() => onDismiss(panel.id)} />
      </div>
    </div>
  );
}

/** The open panel as a large sheet over the preview (every kind but the review). */
export function PanelSheet(props: PanelFrameProps) {
  return (
    <div className="bg-card border-border/60 shadow-panel rounded-panel absolute inset-x-4 top-14 bottom-4 z-30 flex flex-col overflow-hidden border" data-testid="panel-sheet">
      <PanelFrame {...props} />
    </div>
  );
}

/** The review panel as a column beside the preview, which stays in view. */
export function PanelDock(props: PanelFrameProps) {
  return (
    <section
      aria-label="Review"
      data-testid="panel-dock"
      className="bg-card border-border/60 shadow-panel rounded-panel ml-3 flex min-h-0 w-80 shrink-0 flex-col overflow-hidden border"
    >
      <PanelFrame {...props} />
    </section>
  );
}
