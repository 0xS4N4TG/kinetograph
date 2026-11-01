// Where the panels the agent opens are shown (docs/proposals/studio-panels.md): the stepper above the preview, and the open
// panel by its placement: a large sheet over the whole centre column, a column docked beside the preview so it stays in
// view (a review's default), or a tab in the left column (beside the agent chat) or the right one (beside the inspector).
// An approved stage shows its saved answer read-only in the sheet. The component for each kind comes from the registry;
// this only frames it, with the one title and message, and wires its answer to the socket.

import { ChevronDownIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';

import type { OpenPanel, PanelAnswer, PanelKind } from '@/api';
import type { CustomDraft } from './types';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import { placementOf } from '../../../../src/panels/placement.ts';
import { customPills, stageStates, type Stage } from '../../../../src/panels/stages.ts';
import { AnswerView } from './answer-view';
import { panelComponents } from './registry';
import type { PanelProps } from './types';

const TITLES: Record<PanelKind, string> = { brief: 'Brief', script: 'Script', storyboard: 'Storyboard', styleframes: 'Styleframes', review: 'Review', custom: 'Custom' };

/** The panel's title: the fixed kinds have one, a custom panel brings its own. */
export const titleOf = (panel: OpenPanel): string => (panel.panel === 'custom' ? (panel.data as CustomDraft).title : TITLES[panel.panel]);

export type Side = 'left' | 'right';
/** The panel shown in a column's tab (null: the column's own tabs), and a count that rises each time the column should open. */
export interface Focus {
  id: string | null;
  n: number;
}
const NONE: Focus = { id: null, n: 0 };

/**
 * Which panel is on show: a new one comes up by itself where its placement says; the person can put it away and bring it
 * back from the stepper. `answered` is an approved stage's panel the person asked to look at, shown read-only. A sheet or
 * a docked panel shows one at a time (`shown`); the panels placed in a column are all kept as tabs (`side`), and `focus`
 * says which tab is up.
 */
export function usePanelView(panels: OpenPanel[], delivered: boolean) {
  const stages = useMemo(() => stageStates(panels, delivered), [panels, delivered]);
  const extras = useMemo(() => customPills(panels), [panels]);
  const [viewId, setViewId] = useState<string | null>(null);
  const [answeredId, setAnsweredId] = useState<string | null>(null);
  const [focus, setFocusState] = useState<Record<Side, Focus>>({ left: NONE, right: NONE });
  const seen = useRef(new Set<string>());
  /** Puts a panel up in a column and asks for the column to open. */
  const raise = (side: Side, id: string) => setFocusState((all) => ({ ...all, [side]: { id, n: all[side].n + 1 } }));
  useEffect(() => {
    for (const panel of panels) {
      if (panel.status === 'open' && !seen.current.has(panel.id)) {
        seen.current.add(panel.id);
        const placement = placementOf(panel);
        if (placement === 'left' || placement === 'right') raise(placement, panel.id);
        else {
          setViewId(panel.id);
          setAnsweredId(null);
        }
      }
    }
  }, [panels]);
  const open = panels.filter((p) => p.status === 'open');
  const inColumn = (side: Side) => open.filter((p) => placementOf(p) === side);
  const side = { left: inColumn('left'), right: inColumn('right') };
  const shown = open.find((p) => p.id === viewId && ['sheet', 'beside-preview'].includes(placementOf(p))) ?? null;
  const answered = shown ? null : (panels.find((p) => p.id === answeredId && p.status === 'submitted') ?? null);
  /** The tab up in a column, or null for the column's own first tab (also when its panel has since closed). */
  const tabOf = (which: Side): string | null => side[which].find((p) => p.id === focus[which].id)?.id ?? null;
  /** Brings up an open panel where it lives, or the saved answer of a sent one; again, puts it away. */
  const bring = (panelId: string) => {
    const panel = panels.find((p) => p.id === panelId);
    if (!panel) return;
    if (panel.status === 'open') {
      const placement = placementOf(panel);
      setAnsweredId(null);
      if (placement === 'left' || placement === 'right') raise(placement, panel.id);
      else setViewId((current) => (current === panel.id ? null : panel.id));
    } else if (panel.status === 'submitted') {
      setViewId(null);
      setAnsweredId((current) => (current === panel.id ? null : panel.id));
    }
  };
  return {
    stages,
    extras,
    shown,
    answered,
    side,
    focus: { left: { id: tabOf('left'), n: focus.left.n }, right: { id: tabOf('right'), n: focus.right.n } },
    /** Chooses the tab up in a column (null: the column's own tabs) without asking for the column to open. */
    setTab: (which: Side, id: string | null) => setFocusState((all) => ({ ...all, [which]: { id, n: all[which].n } })),
    /** Whether anything has been asked yet: the stepper stays out of the way until then. */
    active: panels.length > 0,
    bring,
    /** Brings up the open panel of a stage, or the saved answer of an approved one. */
    select: (stage: Stage) => {
      const { panelId, approvedId } = stages[stage];
      const id = panelId ?? approvedId;
      if (id !== null) bring(id);
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
  /** What the button that puts the panel away says (a panel in a column goes back to the column's own tabs). */
  hideLabel?: string;
  className?: string;
}

/** A panel with its title, the agent's one-line message under it and, if the server refused an answer, why. */
export function PanelFrame({ panel, error, onSubmit, onDismiss, onHide, hideLabel = 'Put the panel away', className }: PanelFrameProps) {
  const Component = panelComponents[panel.panel] as ComponentType<PanelProps<PanelKind>>;
  const answered = panel.status === 'submitted';
  return (
    <div data-testid="panel-frame" data-panel={panel.panel} className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="flex h-11 shrink-0 items-center gap-2 px-4">
        <h2 className="min-w-0 truncate text-sm font-semibold">{titleOf(panel)}</h2>
        {answered && <Badge variant="success">{panel.panel === 'custom' ? 'Sent' : 'Approved'}</Badge>}
        <div className="flex-1" />
        <Hint label="Put away (reopen from the stages)">
          <Button variant="ghost" size="icon-sm" aria-label={hideLabel} onClick={onHide}>
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

/** A panel as a column beside the preview, which stays in view (a review's default). */
export function PanelDock(props: PanelFrameProps) {
  return (
    <section
      aria-label={titleOf(props.panel)}
      data-testid="panel-dock"
      className="bg-card border-border/60 shadow-panel rounded-panel ml-3 flex min-h-0 w-80 shrink-0 flex-col overflow-hidden border"
    >
      <PanelFrame {...props} />
    </section>
  );
}
