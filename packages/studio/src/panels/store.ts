// The panels the server keeps (docs/proposals/studio-panels.md, "Rules"): in memory, for as long as the studio runs, so
// a window that reloads gets them back. One panel per kind waits at a time, and one per name for the custom ones. Plan files are the lasting record.

import { defaultPlacement } from './placement.js';
import type { OpenPanel, PanelAnswer, PanelDraft, PanelKind, Placement } from './types.js';

/** Closed panels kept besides the open ones, for the stepper and the reviews' order. */
const KEEP_CLOSED = 60;

export class PanelStore {
  private panels: OpenPanel[] = [];
  private next = 1;

  /** Opens a panel; the one of the same kind (and, for a custom panel, of the same name) that waited is dismissed and returned. */
  open<K extends PanelKind>(
    kind: K,
    data: PanelDraft[K],
    message: string | null,
    now = Date.now(),
    placement: Placement = defaultPlacement(kind),
  ): { panel: OpenPanel<K>; replaced: OpenPanel | null } {
    const sameName = (p: OpenPanel) => kind !== 'custom' || (p.data as { name?: string }).name === (data as { name?: string }).name;
    const replaced = this.panels.find((p) => p.panel === kind && p.status === 'open' && sameName(p)) ?? null;
    if (replaced) replaced.status = 'dismissed';
    const panel: OpenPanel<K> = { id: `p_${this.next++}`, panel: kind, data, message, status: 'open', answer: null, openedAt: now, placement };
    this.panels.push(panel as OpenPanel);
    const closed = this.panels.filter((p) => p.status !== 'open');
    for (const old of closed.slice(0, Math.max(0, closed.length - KEEP_CLOSED))) this.panels.splice(this.panels.indexOf(old), 1);
    return { panel, replaced };
  }

  /** Adds an already answered panel, read back from its plan file when the studio starts (no one is told). */
  restore<K extends PanelKind>(kind: K, data: PanelDraft[K], answer: PanelAnswer[K], now = Date.now()): OpenPanel<K> {
    const { panel } = this.open(kind, data, null, now);
    panel.status = 'submitted';
    panel.answer = answer;
    return panel;
  }

  get(id: string): OpenPanel | undefined {
    return this.panels.find((p) => p.id === id);
  }

  /** Closes an open panel as submitted (with its answer) or dismissed; undefined when it is not open. */
  close(id: string, status: 'submitted' | 'dismissed', answer: PanelAnswer[PanelKind] | null = null): OpenPanel | undefined {
    const panel = this.get(id);
    if (!panel || panel.status !== 'open') return undefined;
    panel.status = status;
    panel.answer = status === 'submitted' ? answer : null;
    return panel;
  }

  /** What a window is sent when it connects: the open panels and the submitted ones, oldest first. */
  shown(): OpenPanel[] {
    return this.panels.filter((p) => p.status !== 'dismissed');
  }
}
