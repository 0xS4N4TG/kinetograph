// Markup mode: marks the person draws on the preview (a pin, a box, a pen stroke) or on the timeline (a range), each with a
// comment, sent to the agent as one numbered list plus the frames they were drawn on. Everything is stored in composition
// pixels on the frame it was drawn on (a range in frames), so it lines up at any zoom and pan.

import { createContext, useContext, useSyncExternalStore } from 'react';

import type { InspectLayer } from '@/lib/inspect';
import { hitTest } from '@/lib/inspect';
import { boxSelect, layerName, type Rect } from '@/lib/selection';

export type MarkTool = 'pin' | 'box' | 'pen' | 'eraser' | 'range';

/** The pen's colours: red, amber, green, blue. The name is what the agent is told. */
export const COLORS = [
  { name: 'red', hex: '#ef4444' },
  { name: 'amber', hex: '#f59e0b' },
  { name: 'green', hex: '#22c55e' },
  { name: 'blue', hex: '#3b82f6' },
] as const;

export type Point = [number, number];

export type Geometry =
  | { type: 'pin'; x: number; y: number }
  | { type: 'box'; x: number; y: number; width: number; height: number }
  | { type: 'pen'; points: Point[] }
  | { type: 'range' };

export interface Note {
  id: number;
  comp: string;
  /** The frame it was drawn on (the first, for a range). */
  frame: number;
  /** The last frame of a range; the same as `frame` for a mark on the picture. */
  endFrame: number;
  geom: Geometry;
  /** A colour of `COLORS`. */
  color: string;
  text: string;
  /** The names of the layers under the mark when it was drawn. */
  layers: string[];
  /** `draft`: its comment bubble is open and it was not kept yet; `queued`: in the tray; `sent`: the agent has it. */
  status: 'draft' | 'queued' | 'sent';
  /** The person says it is dealt with: greyed, and not sent. */
  resolved: boolean;
  /** The number it had in the message it was sent in. */
  sentNo?: number;
}

export interface MarkupState {
  active: boolean;
  tool: MarkTool;
  color: string;
  notes: Note[];
  /** The note whose comment bubble is open. */
  openId: number | null;
  /** A request to send notes (`ids`, or null for every note in the tray); `n` counts them so asking twice is seen. */
  request: { n: number; ids: number[] | null } | null;
  /** Notes are being sent (the pictures are made and stored first). */
  busy: boolean;
  /** Why the last send failed, in plain words. */
  problem: string | null;
}

const initial: MarkupState = { active: false, tool: 'pin', color: COLORS[0].hex, notes: [], openId: null, request: null, busy: false, problem: null };

export type NewMark = Pick<Note, 'comp' | 'frame' | 'geom'> & Partial<Pick<Note, 'endFrame' | 'color' | 'layers'>>;

/** The notes and the mode, outside React so the preview, the timeline and the agent column share them. */
export class MarkupStore {
  private state: MarkupState = initial;
  private nextId = 1;
  private readonly listeners = new Set<() => void>();

  getState = (): MarkupState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  private set(patch: Partial<MarkupState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private edit(id: number, change: Partial<Note>): void {
    this.set({ notes: this.state.notes.map((n) => (n.id === id ? { ...n, ...change } : n)) });
  }

  setActive(active: boolean): void {
    if (active === this.state.active) return;
    // Leaving markup mode keeps the notes; a mark whose bubble is still open is dropped, as Esc in the bubble does.
    this.set(active ? { active } : { active, notes: this.state.notes.filter((n) => n.status !== 'draft'), openId: null });
  }
  toggle(): void {
    this.setActive(!this.state.active);
  }
  setTool(tool: MarkTool): void {
    this.set({ tool });
  }
  setColor(color: string): void {
    this.set({ color });
  }

  /** Starts a note for a mark just drawn, with its bubble open. A bubble still open for another mark keeps that one first. */
  add(mark: NewMark): Note {
    const kept = this.state.notes.map((n) => (n.status === 'draft' ? { ...n, status: 'queued' as const } : n));
    const note: Note = {
      id: this.nextId++,
      comp: mark.comp,
      frame: mark.frame,
      endFrame: mark.endFrame ?? mark.frame,
      geom: mark.geom,
      color: mark.color ?? this.state.color,
      text: '',
      layers: mark.layers ?? [],
      status: 'draft',
      resolved: false,
    };
    this.set({ notes: [...kept, note], openId: note.id });
    return note;
  }
  /** The comment as it is typed, so a bubble that closes by other means loses nothing. */
  setText(id: number, text: string): void {
    this.edit(id, { text });
  }
  /** Keeps the note with this comment (Enter in the bubble). */
  commit(id: number, text: string): void {
    this.edit(id, { text: text.trim(), status: this.get(id)?.status === 'sent' ? 'sent' : 'queued' });
    this.set({ openId: null });
  }
  /** Changes the comment of a note and closes the bubble; a note already sent goes back to the tray to be sent again. */
  update(id: number, text: string): void {
    const note = this.get(id);
    if (!note) return;
    this.edit(id, { text: text.trim(), ...(note.status === 'sent' ? { status: 'queued' as const } : {}) });
    this.set({ openId: null });
  }
  remove(id: number): void {
    this.set({ notes: this.state.notes.filter((n) => n.id !== id), openId: this.state.openId === id ? null : this.state.openId });
  }
  /** Esc in a bubble: a new mark is dropped, an old one just closes. */
  dismiss(id: number): void {
    if (this.get(id)?.status === 'draft') this.remove(id);
    else this.set({ openId: null });
  }
  open(id: number | null): void {
    this.set({ openId: id });
  }
  toggleResolved(id: number): void {
    const note = this.get(id);
    if (note) this.edit(id, { resolved: !note.resolved });
  }
  /** After sending: the notes stay on the picture in the sent style, with the numbers the message gave them. */
  markSent(numbered: { id: number; no: number }[]): void {
    const nos = new Map(numbered.map((n) => [n.id, n.no]));
    this.set({ notes: this.state.notes.map((n) => (nos.has(n.id) ? { ...n, status: 'sent' as const, sentNo: nos.get(n.id)! } : n)) });
  }
  clearSent(): void {
    this.set({ notes: this.state.notes.filter((n) => n.status !== 'sent') });
  }
  /** Asks for notes to be sent: these, or (no ids) all that are in the tray. Whoever holds the chat does it. */
  requestSend(ids?: number[]): void {
    this.set({ request: { n: (this.state.request?.n ?? 0) + 1, ids: ids ?? null }, problem: null });
  }
  setBusy(busy: boolean, problem: string | null = null): void {
    this.set({ busy, problem });
  }
  get(id: number): Note | undefined {
    return this.state.notes.find((n) => n.id === id);
  }
  reset(): void {
    this.set({ ...initial });
  }
}

export const MarkupContext = createContext<MarkupStore | null>(null);

/** The store the studio window shares, or null outside it (then markup is off). */
export function useMarkupStore(): MarkupStore | null {
  return useContext(MarkupContext);
}

const none: MarkupState = initial;
/** The markup state (an empty one without a store). */
export function useMarkup(): MarkupState {
  const store = useContext(MarkupContext);
  return useSyncExternalStore(store ? store.subscribe : noSubscribe, store ? store.getState : () => none);
}
const noSubscribe = () => () => undefined;

// ---- what is in the notes ----

/** Notes of one composition in time order (then in the order they were drawn). */
export function inTimeOrder(notes: Note[], comp: string): Note[] {
  return notes.filter((n) => n.comp === comp).sort((a, b) => a.frame - b.frame || a.id - b.id);
}

/** The notes the next message would carry: kept, not sent, not resolved. */
export function toSend(notes: Note[], comp: string): Note[] {
  return inTimeOrder(notes, comp).filter((n) => n.status === 'queued' && !n.resolved);
}

/** The number a note shows: its place among the notes to send, or the one it had when it was sent. */
export function numberOf(note: Note, notes: Note[]): number | null {
  if (note.status === 'sent') return note.sentNo ?? null;
  if (note.resolved) return null;
  const at = inTimeOrder(notes, note.comp).filter((n) => n.status !== 'sent' && !n.resolved).findIndex((n) => n.id === note.id);
  return at < 0 ? null : at + 1;
}

/** Whether a note's marker shows with the playhead on `frame`. */
export const visibleAt = (note: Note, frame: number): boolean => frame >= note.frame && frame <= note.endFrame;

// ---- geometry ----

/** The smallest rectangle around the points. */
export function boundsOf(points: Point[]): Rect {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Where a mark is on the picture, for placing its number and bubble: the rectangle around it (a pin is a point). */
export function markBounds(geom: Geometry): Rect | null {
  switch (geom.type) {
    case 'pin':
      return { x: geom.x, y: geom.y, width: 0, height: 0 };
    case 'box':
      return { x: geom.x, y: geom.y, width: geom.width, height: geom.height };
    case 'pen':
      return geom.points.length > 0 ? boundsOf(geom.points) : null;
    case 'range':
      return null;
  }
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** A freehand line with the points that do not matter left out (Ramer-Douglas-Peucker); `epsilon` is in the same pixels as the points. */
export function simplify(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points;
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    let far = -1;
    let farDistance = epsilon;
    for (let i = from + 1; i < to; i++) {
      const d = distanceToSegment(points[i]!, points[from]!, points[to]!);
      if (d > farDistance) {
        far = i;
        farDistance = d;
      }
    }
    if (far >= 0) {
      keep[far] = true;
      stack.push([from, far], [far, to]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Whether a point is within `reach` of a stroke (the eraser). */
export function nearStroke(points: Point[], x: number, y: number, reach: number): boolean {
  if (points.length === 1) return Math.hypot(points[0]![0] - x, points[0]![1] - y) <= reach;
  for (let i = 1; i < points.length; i++) if (distanceToSegment([x, y], points[i - 1]!, points[i]!) <= reach) return true;
  return false;
}

const MAX_LAYER_NAMES = 6;

/** The names of the layers under a mark: the one at a pin, those a box or a stroke's bounds mostly cover plus the one at its centre. */
export function layersUnder(layers: InspectLayer[], geom: Geometry): string[] {
  const byId = new Map<string, InspectLayer>();
  const walk = (list: InspectLayer[]) => {
    for (const layer of list) {
      byId.set(layer.id, layer);
      if (layer.children) walk(layer.children);
    }
  };
  walk(layers);
  const ids: string[] = [];
  const bounds = markBounds(geom);
  if (!bounds) return [];
  if (geom.type !== 'pin') ids.push(...boxSelect(layers, bounds));
  const centre = hitTest(layers, bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  if (centre && !ids.includes(centre.id)) ids.push(centre.id);
  const names: string[] = [];
  for (const id of ids) {
    const layer = byId.get(id);
    const name = layer ? layerName(layer) : null;
    if (name && !names.includes(name)) names.push(name);
  }
  return names.slice(0, MAX_LAYER_NAMES);
}

// ---- the message ----

/** `mm:ss.cc` for a frame: frame 120 at 30 fps is `00:04.00`. */
export function timecode(frame: number, fps: number): string {
  const hundredths = Math.round((frame / fps) * 100);
  const m = Math.floor(hundredths / 6000);
  const s = Math.floor((hundredths % 6000) / 100);
  const c = hundredths % 100;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

const round = (n: number) => Math.round(n);
const colorName = (hex: string) => COLORS.find((c) => c.hex === hex)?.name ?? hex;

/** A mark in words: `box 640,320 420x180`. */
export function describeMark(note: Note): string {
  const g = note.geom;
  switch (g.type) {
    case 'pin':
      return `pin ${round(g.x)},${round(g.y)}`;
    case 'box':
      return `box ${round(g.x)},${round(g.y)} ${round(g.width)}x${round(g.height)}`;
    case 'pen': {
      const b = boundsOf(g.points);
      return `${colorName(note.color)} pen stroke around ${round(b.x)},${round(b.y)} ${round(b.width)}x${round(b.height)}`;
    }
    case 'range':
      return 'range';
  }
}

/** The most frames that come with a picture of their own: what one message may carry. */
export const MAX_FRAME_IMAGES = 6;

/** The frames the pictures are made for: the first `max` distinct frames in time order, and the frames left without one. */
export function pictureFrames(notes: Note[], max = MAX_FRAME_IMAGES): { shown: number[]; left: number[] } {
  const frames = [...new Set(notes.map((n) => n.frame))];
  return { shown: frames.slice(0, max), left: frames.slice(max) };
}

/**
 * The one message: the notes in time order, each with its frame, time, mark, the layers under it and the comment, then
 * which picture shows which frame. `pictures` maps a frame to the name its picture was stored under.
 */
export function composeNotes(comp: string, fps: number, notes: Note[], pictures: ReadonlyMap<number, string>, left: number[] = []): string {
  const lines = notes.map((note, i) => {
    const span = note.endFrame > note.frame;
    const when = span
      ? `frames ${note.frame}-${note.endFrame} (${timecode(note.frame, fps)}-${timecode(note.endFrame, fps)})`
      : `frame ${note.frame} (${timecode(note.frame, fps)})`;
    const over = note.layers.length > 0 ? ` over ${note.layers.join(', ')}` : '';
    const picture = pictures.get(note.frame);
    return `${i + 1}. ${when}, ${describeMark(note)}${over}: ${note.text === '' ? '(no comment)' : note.text}${picture ? ` [${picture}]` : ''}`;
  });
  const head = `Markup notes on ${comp}: ${notes.length} in time order. Please fix them in order and say which you did.`;
  const how = pictures.size > 0 ? '\nEach frame with a mark is attached with the marks drawn on it: numbered pins and boxes, pen strokes in their colours.' : '';
  const more = left.length > 0 ? `\nOnly the first ${pictures.size} frames come with a picture; frames ${left.join(', ')} have none.` : '';
  return `${head}${how}${more}\n\n${lines.join('\n')}`;
}

/** The names of the pictures stored for a markup message: `markup-<stamp>-<n>.png`. */
export const pictureName = (stamp: number, n: number): string => `markup-${stamp}-${n}.png`;
