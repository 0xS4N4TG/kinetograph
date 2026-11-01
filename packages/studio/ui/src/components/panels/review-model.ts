import type { InspectResult } from '@/api';
import { findLayer } from '@/lib/inspect';
import { readStored, writeStored } from '@/lib/persisted';
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

/**
 * The area and layer a note gets from the layers picked in the preview (a drag box or a click), in composition pixels.
 * A box dragged on the preview (`drawn`) is the area itself, and it stands alone when no layer lies inside it.
 */
export function areaOfSelection(
  inspect: InspectResult | null,
  selected: readonly string[],
  size: { width: number; height: number },
  drawn: Box | null = null,
): { box: Box; layer?: string } | null {
  const layers = inspect ? selected.map((id) => findLayer(inspect.layers, id)).filter((l) => l !== null) : [];
  const layer = layers.length > 0 ? layers.map(layerName).join(', ') : undefined;
  if (drawn) return { box: drawn, ...(layer ? { layer } : {}) };
  const rect = unionRect(
    layers.map((l) => layerRect(l)).filter((r) => r !== null),
    0,
    size.width,
    size.height,
  );
  if (!rect || !layer) return null;
  return { box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }, layer };
}

/** Where a review's unsent notes are kept in the browser: per project and panel. */
export const draftKey = (project: string, panelId: string) => `kg.review:${project}:${panelId}`;

/**
 * The notes kept for this review, or none. A draft belongs to the panel that was open when it was written (`openedAt`):
 * after a restart the same id can name another review.
 */
export function readDraft(key: string, openedAt: number): DraftNote[] {
  const stored = readStored(key) as { openedAt?: unknown; notes?: unknown } | undefined;
  if (!stored || stored.openedAt !== openedAt || !Array.isArray(stored.notes)) return [];
  return stored.notes.filter(
    (n): n is DraftNote => n !== null && typeof n === 'object' && Number.isFinite(n.uid) && Number.isFinite(n.frame) && typeof n.text === 'string',
  );
}

/** Keeps the notes; none removes the draft. */
export function writeDraft(key: string, openedAt: number, notes: readonly DraftNote[]): void {
  writeStored(key, notes.length > 0 ? { openedAt, notes } : undefined);
}
