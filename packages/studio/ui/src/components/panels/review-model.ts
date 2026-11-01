import type { InspectResult } from '@/api';
import { findLayer } from '@/lib/inspect';
import { layerName, layerRect, unionRect } from '@/lib/selection';

import type { Box, Note, ReviewRequest } from './types';

/** A note as it is edited: the answer's note plus an id of its own, since two notes can share a frame. */
export interface DraftNote extends Note {
  uid: number;
}

/** Notes in frame order; notes on the same frame keep the order they were added in. */
export function sortNotes<T extends Note & { uid?: number }>(notes: readonly T[]): T[] {
  return [...notes].sort((a, b) => a.frame - b.frame || (a.uid ?? 0) - (b.uid ?? 0));
}

/** The notes as the answer carries them: sorted, trimmed, and without the ones that say nothing. */
export function answerNotes(notes: readonly DraftNote[]): Note[] {
  return sortNotes(notes)
    .filter((n) => n.text.trim() !== '')
    .map(({ uid: _uid, text, ...rest }) => ({ ...rest, text: text.trim() }));
}

/** The frames the review covers: the request's range held inside the composition, or all of it. */
export function reviewSpan(request: ReviewRequest, duration: number): [number, number] {
  const last = Math.max(0, duration - 1);
  if (!request.range) return [0, last];
  const clamp = (n: number) => Math.min(last, Math.max(0, Math.round(n)));
  const a = clamp(request.range[0]);
  const b = clamp(request.range[1]);
  return [Math.min(a, b), Math.max(a, b)];
}

/** The area and layer a note gets from the layers picked in the preview (a drag box or a click), in composition pixels. */
export function areaOfSelection(inspect: InspectResult | null, selected: readonly string[], size: { width: number; height: number }): { box: Box; layer: string } | null {
  if (!inspect) return null;
  const layers = selected.map((id) => findLayer(inspect.layers, id)).filter((l) => l !== null);
  const rect = unionRect(
    layers.map((l) => layerRect(l)).filter((r) => r !== null),
    0,
    size.width,
    size.height,
  );
  if (!rect || layers.length === 0) return null;
  return {
    box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    layer: layers.map(layerName).join(', '),
  };
}
