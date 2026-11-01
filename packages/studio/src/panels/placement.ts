// Where a panel is shown. No Node, no DOM: the server, the UI and the tests use it.

import type { OpenPanel, PanelKind, Placement } from './types.js';

export const PLACEMENTS: readonly Placement[] = ['sheet', 'left', 'right', 'beside-preview'];

/** A review stays beside the preview so that it can be watched while the person writes notes; every other kind is a sheet. */
export const defaultPlacement = (kind: PanelKind): Placement => (kind === 'review' ? 'beside-preview' : 'sheet');

export const placementOf = (panel: Pick<OpenPanel, 'panel' | 'placement'>): Placement => panel.placement ?? defaultPlacement(panel.panel);

/** The name of a panel's plan file without ".json": the kind, or custom-<name> for a custom panel. */
export const planFileOf = (panel: Pick<OpenPanel, 'panel' | 'data'>): string =>
  panel.panel === 'custom' ? `custom-${(panel.data as { name: string }).name}` : panel.panel;
