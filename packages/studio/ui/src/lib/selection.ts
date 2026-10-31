// Picking layers in the preview: by click, by dragging a box, and with shift to add. Plus the names the chat shows for
// them. Layers may carry a readable `label`, a `component` and a `source` position (all optional: a project built
// outside the studio has none), so every name falls back to what the layer itself shows.

import { relativePath } from '@/lib/agent-message';
import type { InspectLayer } from '@/lib/inspect';
import { displayName } from '@/lib/names';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SourcePosition {
  file: string;
  line: number;
}

type Extras = { label?: unknown; component?: unknown; source?: unknown };

/** Where a layer is drawn, in composition pixels. */
export function layerRect(layer: InspectLayer): Rect | null {
  return layer.bounds ?? layer.box ?? null;
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The corners of a drag as a rectangle with positive size. */
export function rectFrom(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/**
 * The layers a dragged box picks: those with at least half of their area inside it. Groups are skipped (their bounds
 * span everything in them); the layers inside a group are picked on their own. Topmost first.
 */
export function boxSelect(layers: InspectLayer[], box: Rect): string[] {
  const picked: string[] = [];
  const visit = (list: InspectLayer[]) => {
    for (const layer of [...list].reverse()) {
      if (layer.children && layer.children.length > 0) {
        visit(layer.children);
        continue;
      }
      const rect = layerRect(layer);
      if (!rect) continue;
      const area = rect.width * rect.height;
      // A line or a point has no area: it counts when it lies inside the box.
      const covered = area > 0 ? overlap(rect, box) / area : overlap({ ...rect, width: rect.width || 0.01, height: rect.height || 0.01 }, box) > 0 ? 1 : 0;
      if (covered >= 0.5) picked.push(layer.id);
    }
  };
  visit(layers);
  return picked;
}

/** The selection after a click on `hit` (null: empty space): shift toggles the layer, a plain click replaces everything. */
export function clickSelection(current: string[], hit: string | null, shift: boolean): string[] {
  if (hit === null) return shift ? current : [];
  if (!shift) return [hit];
  return current.includes(hit) ? current.filter((id) => id !== hit) : [...current, hit];
}

/** The selection after a dragged box picked `picked`: shift adds to what was selected, a plain drag replaces it. */
export function boxResult(current: string[], picked: string[], shift: boolean): string[] {
  if (!shift) return picked;
  return [...current, ...picked.filter((id) => !current.includes(id))];
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const snippet = (text: string, max = 30) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The name to show for a layer: its label, else its text, its file, an id the author chose, or its kind. Never a tree path. */
export function layerName(layer: InspectLayer): string {
  const { label } = layer as Extras;
  // A text or a picture says which it is; a label, a chosen id or the kind is numbered among its siblings ("Card 2").
  if (typeof label !== 'string' || label === '') {
    if (layer.text?.text) return `${capital(layer.type)} “${snippet(layer.text.text)}”`;
    if (layer.src) return `${capital(layer.type)} ${layer.src.split('/').pop()}`;
  }
  return displayName(layer as InspectLayer & { label?: string; ordinal?: number });
}

/** The position in the project's source that made the layer, when the studio knows it. */
export function layerSource(layer: InspectLayer): SourcePosition | null {
  const { source } = layer as Extras;
  if (typeof source === 'string') {
    const match = /^(.*?):(\d+)(?::\d+)?$/.exec(source);
    return match ? { file: match[1]!, line: Number(match[2]) } : null;
  }
  if (source && typeof source === 'object') {
    const { file, line } = source as { file?: unknown; line?: unknown };
    if (typeof file === 'string' && typeof line === 'number') return { file, line };
  }
  return null;
}

export function layerComponent(layer: InspectLayer): string | null {
  const { component } = layer as Extras;
  return typeof component === 'string' && component !== '' ? component : null;
}

/** "Headline text · frame 120 · shots-a.tsx:48": what a chip says about a layer. */
export function chipText(layer: InspectLayer, frame: number, cwd = '', span?: string): string {
  const parts = [layerName(layer), span ?? `frame ${frame}`];
  const source = layerSource(layer);
  if (source) parts.push(`${relativePath(source.file, cwd).split('/').pop()}:${source.line}`);
  return parts.join(' · ');
}

/**
 * After the project changed, finds each selected layer again: a layer that is gone is looked up by the name it had, and
 * is replaced when exactly one layer has that name now. Ids that are still there, and names that are not unique, stay.
 */
export function remapSelection(ids: string[], names: ReadonlyMap<string, string>, layers: InspectLayer[]): string[] {
  const all: InspectLayer[] = [];
  const walk = (list: InspectLayer[]) => {
    for (const layer of list) {
      all.push(layer);
      if (layer.children) walk(layer.children);
    }
  };
  walk(layers);
  const present = new Set(all.map((l) => l.id));
  const next: string[] = [];
  for (const id of ids) {
    let use = id;
    if (!present.has(id)) {
      const name = names.get(id);
      const same = name === undefined ? [] : all.filter((l) => layerName(l) === name);
      if (same.length === 1) use = same[0]!.id;
    }
    if (!next.includes(use)) next.push(use);
  }
  return next;
}

/** The smallest rectangle holding all of `rects`, grown by `pad` and cut to `0,0,width,height`; null for none. */
export function unionRect(rects: Rect[], pad: number, width: number, height: number): Rect | null {
  if (rects.length === 0) return null;
  const x0 = Math.max(0, Math.min(...rects.map((r) => r.x)) - pad);
  const y0 = Math.max(0, Math.min(...rects.map((r) => r.y)) - pad);
  const x1 = Math.min(width, Math.max(...rects.map((r) => r.x + r.width)) + pad);
  const y1 = Math.min(height, Math.max(...rects.map((r) => r.y + r.height)) + pad);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

// A span of time picked on the timeline, next to the layers picked in the preview. Frames are whole numbers and both
// ends are inside the span (`{ start: 30, end: 75 }` is 46 frames).

export interface FrameRange {
  start: number;
  end: number;
}

/** The span between two frames (in either order), snapped to whole frames and held inside a composition of `duration` frames. */
export function makeRange(a: number, b: number, duration: number): FrameRange | null {
  if (duration <= 0) return null;
  const clamp = (n: number) => Math.min(duration - 1, Math.max(0, Math.floor(n)));
  return { start: Math.min(clamp(a), clamp(b)), end: Math.max(clamp(a), clamp(b)) };
}

/** The smallest span holding `range` and the span `a`..`b`; `range` null starts a new one. */
export function extendRange(range: FrameRange | null, a: number, b: number, duration: number): FrameRange | null {
  const next = makeRange(a, b, duration);
  if (!next || !range) return next;
  return { start: Math.min(range.start, next.start), end: Math.max(range.end, next.end) };
}

/** `range` cut to a composition of `duration` frames (it may have got shorter); null when nothing is left. */
export function clampRange(range: FrameRange | null, duration: number): FrameRange | null {
  return range ? makeRange(range.start, range.end, duration) : null;
}

/** A frame as `m:ss.s`: frame 30 at 30 fps is `0:01.0`. */
export function rangeStamp(frame: number, fps: number): string {
  const tenths = Math.round((frame / fps) * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** `0:01.0–0:02.5 (frames 30–75)`. */
export function rangeLabel(range: FrameRange, fps: number): string {
  return `${rangeStamp(range.start, fps)}–${rangeStamp(range.end, fps)} (frames ${range.start}–${range.end})`;
}

/** The frames a contact sheet of the span is made of: up to `count`, evenly across it, first and last included. */
export function contactFrames(range: FrameRange, count = 8): number[] {
  const n = Math.min(count, range.end - range.start + 1);
  if (n <= 1) return [range.start];
  return Array.from({ length: n }, (_, i) => Math.round(range.start + (i * (range.end - range.start)) / (n - 1)));
}

/** Whether `ranges` (inclusive pairs) touch the span. */
export function touchesRange(ranges: readonly (readonly [number, number])[], range: FrameRange): boolean {
  return ranges.some(([a, b]) => a <= range.end && b >= range.start);
}
