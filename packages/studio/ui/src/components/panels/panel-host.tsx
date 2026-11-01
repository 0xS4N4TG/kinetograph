// Where the panels the agent opens are shown (docs/proposals/studio-panels.md): the stepper above the preview, and the open
// panel as a large sheet over the whole centre column, or, for a review, docked beside the preview so it stays in view.
// An approved stage shows its saved answer read-only in the sheet. The component for each kind comes from the registry;
// this only frames it, with the one title and message, and wires its answer to the socket.

import { ChevronDownIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';

import type { OpenPanel, PanelAnswer, PanelKind } from '@/api';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import { stageStates, type Stage } from '../../../../src/panels/stages.ts';
import { AnswerView } from './answer-view';
import { panelComponents } from './registry';
import type { PanelProps } from './types';

const TITLES: Record<PanelKind, string> = { brief: 'Brief', script: 'Script', storyboard: 'Storyboard', styleframes: 'Styleframes', review: 'Review' };

/**
 * Which panel is on show: a new one comes up by itself; the person can put it away and bring it back from the stepper.
 * `answered` is an approved stage's panel the person asked to look at, shown read-only.
 */
export function usePanelView(panels: OpenPanel[], delivered: boolean) {
  const stages = useMemo(() => stageStates(panels, delivered), [panels, delivered]);
  const [viewId, setViewId] = useState<string | null>(null);
  const [answeredId, setAnsweredId] = useState<string | null>(null);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const panel of panels) {
      if (panel.status === 'open' && !seen.current.has(panel.id)) {
        seen.current.add(panel.id);
        setViewId(panel.id);
        setAnsweredId(null);
      }
    }
  }, [panels]);
  const shown = panels.find((p) => p.id === viewId && p.status === 'open') ?? null;
  const answered = shown ? null : (panels.find((p) => p.id === answeredId && p.status === 'submitted') ?? null);
  return {
    stages,
    shown,
    answered,
    /** Whether anything has been asked yet: the stepper stays out of the way until then. */
    active: panels.length > 0,
    /** Brings up the open panel of a stage, or the saved answer of an approved one; again, puts it away. */
    select: (stage: Stage) => {
      const { panelId, approvedId } = stages[stage];
      if (panelId !== null) {
        setAnsweredId(null);
        setViewId((current) => (current === panelId ? null : panelId));
      } else if (approvedId !== null) {
        setViewId(null);
        setAnsweredId((current) => (current === approvedId ? null : approvedId));
      }
    },
    hide: () => {
      setViewId(null);
      setAnsweredId(null);
    },
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

/** A panel with its title, the agent's one-line message under it and, if the server refused an answer, why. */
function PanelFrame({ panel, error, onSubmit, onDismiss, onHide, className }: PanelFrameProps) {
  const Component = panelComponents[panel.panel] as ComponentType<PanelProps<PanelKind>>;
  const answered = panel.status === 'submitted';
  return (
    <div data-testid="panel-frame" data-panel={panel.panel} className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="flex h-11 shrink-0 items-center gap-2 px-4">
        <h2 className="text-sm font-semibold">{TITLES[panel.panel]}</h2>
        {answered && <Badge variant="success">Approved</Badge>}
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
        {answered ? (
          <AnswerView panel={panel} />
        ) : (
          <Component panel={panel} onSubmit={(answer) => onSubmit(panel.id, answer)} onDismiss={() => onDismiss(panel.id)} />
        )}
      </div>
    </div>
  );
}

/** The panel as a large sheet over the whole centre column, preview and timeline (every kind but an open review). */
export function PanelSheet(props: PanelFrameProps) {
  return (
    <div className="bg-card border-border/60 shadow-panel rounded-panel absolute inset-0 z-30 flex flex-col overflow-hidden border" data-testid="panel-sheet">
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
