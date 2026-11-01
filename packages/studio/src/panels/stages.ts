// The stages of making a video that the panels support (docs/proposals/studio-panels.md, "The flow"), and where each
// stands given the panels the server has kept. No Node, no DOM: the stepper in the UI and the tests use it too.

import type { CustomDraft, OpenPanel, PanelKind } from './types.js';

export type Stage = 'brief' | 'script' | 'board' | 'style' | 'animatic' | 'build' | 'deliver';

export const STAGES: { id: Stage; label: string }[] = [
  { id: 'brief', label: 'Brief' },
  { id: 'script', label: 'Script' },
  { id: 'board', label: 'Board' },
  { id: 'style', label: 'Style' },
  { id: 'animatic', label: 'Animatic' },
  { id: 'build', label: 'Build' },
  { id: 'deliver', label: 'Deliver' },
];

export type StageState = 'empty' | 'open' | 'approved';

export interface StageInfo {
  state: StageState;
  /** The open panel to bring up, when the stage is open. */
  panelId: string | null;
  /** The approved panel to show read-only, when the stage is approved and nothing waits. */
  approvedId: string | null;
}

/** True for a submitted panel whose answer approves: a brief always does, the others say so in their answer. */
export function isApproved(panel: OpenPanel): boolean {
  if (panel.status !== 'submitted' || panel.answer === null) return false;
  switch (panel.panel) {
    case 'brief':
      return true;
    case 'review':
      return (panel.answer as { verdict?: unknown }).verdict === 'approved';
    default:
      return (panel.answer as { approved?: unknown }).approved === true;
  }
}

const KIND_OF: Partial<Record<Stage, PanelKind>> = { brief: 'brief', script: 'script', board: 'storyboard', style: 'styleframes' };

const state = (panels: OpenPanel[]): StageInfo => {
  const open = panels.findLast((p) => p.status === 'open');
  if (open) return { state: 'open', panelId: open.id, approvedId: null };
  const approved = panels.findLast(isApproved);
  return { state: approved ? 'approved' : 'empty', panelId: null, approvedId: approved?.id ?? null };
};

/**
 * Where each stage stands. A stage with its own panel (Brief, Script, Board, Style) is open while one waits and
 * approved once one was approved. The review panel serves two stages: reviews up to and including the first approved
 * one are the Animatic's, the ones after it the Build's. Deliver has no panel; `delivered` says an export has finished.
 */
export function stageStates(panels: OpenPanel[], delivered = false): Record<Stage, StageInfo> {
  const kept = panels.filter((p) => p.status !== 'dismissed').sort((a, b) => a.openedAt - b.openedAt);
  const of = (kind: PanelKind): OpenPanel[] => kept.filter((p) => p.panel === kind);
  const reviews = of('review');
  const firstApproved = reviews.findIndex(isApproved);
  const out = {} as Record<Stage, StageInfo>;
  for (const [stage, kind] of Object.entries(KIND_OF) as [Stage, PanelKind][]) out[stage] = state(of(kind));
  out.animatic = state(firstApproved === -1 ? reviews : reviews.slice(0, firstApproved + 1));
  out.build = firstApproved === -1 ? { state: 'empty', panelId: null, approvedId: null } : state(reviews.slice(firstApproved + 1));
  out.deliver = { state: delivered ? 'approved' : 'empty', panelId: null, approvedId: null };
  return out;
}

/** A custom panel in the stepper: not a stage, so it comes after Deliver as a pill of its own. */
export interface CustomPill {
  /** The panel to bring up: the latest one with this name. */
  id: string;
  name: string;
  title: string;
  /** 'open' waits for the person; 'answered' was sent and shows read-only. */
  state: 'open' | 'answered';
}

/** One pill per custom panel name, from its latest panel that was not dismissed, oldest name first. */
export function customPills(panels: OpenPanel[]): CustomPill[] {
  const latest = new Map<string, OpenPanel>();
  for (const panel of [...panels].sort((a, b) => a.openedAt - b.openedAt)) {
    if (panel.panel !== 'custom' || panel.status === 'dismissed') continue;
    const name = (panel.data as CustomDraft).name;
    latest.delete(name);
    latest.set(name, panel);
  }
  return [...latest.values()].map((p) => ({ id: p.id, name: (p.data as CustomDraft).name, title: (p.data as CustomDraft).title, state: p.status === 'open' ? 'open' : 'answered' }));
}
