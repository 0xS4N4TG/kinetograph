import rough from 'roughjs';
import type { Drawable } from 'roughjs/bin/core';

/**
 * The hand-sketched drawing kit shared by the engine diagram and the docs illustrations. Every shape comes from
 * roughjs with a fixed seed, so the strokes are the same on the server, in the browser and in the SVG files.
 * A diagram is data: it calls the methods of a `Sketch` and then `build()`s the result.
 */

export interface DiagramPath {
  d: string;
  /** Stroke width. */
  w: number;
  /** Stroke dash array, for the dashed group boxes and the loop arrow. */
  dash?: string;
  /** Muted ink for shading and quiet lines; the default is the main ink. */
  tone?: 'ink' | 'muted';
}

export interface DiagramLabel {
  x: number;
  y: number;
  text: string;
  size: number;
  weight: 300 | 400 | 700;
  anchor: 'start' | 'middle' | 'end';
  /** `ink` is the main colour, `muted` the secondary text. */
  tone: 'ink' | 'muted';
  /** Degrees; each label sits a little off the baseline, like handwriting. */
  rot: number;
  /** The widest the text may be, for the build script to check against the real font. */
  fit?: number;
}

export interface Diagram {
  width: number;
  height: number;
  /** Boxes, group boxes and arrows, in drawing order. */
  ink: DiagramPath[];
  labels: DiagramLabel[];
  alt: string;
}

export type Pt = [number, number];

export interface Stroke {
  /** Stroke width. */
  w?: number;
  dash?: string;
  tone?: 'ink' | 'muted';
  roughness?: number;
  bowing?: number;
}

export interface ArrowOptions extends Stroke {
  dashed?: boolean;
  /** Rounds the corners of an elbow arrow. */
  r?: number;
  /** `false` draws the line alone, where two arrows join. */
  head?: boolean;
}

export interface NodeOptions {
  title: string;
  sub?: string;
  step?: number;
  /** A thicker outline and a bold title, for the box the diagram is about. */
  bold?: boolean;
  dash?: string;
  tone?: 'ink' | 'muted';
}

const gen = rough.generator();

/** One decimal is plenty at this size, and keeps the paths short and the same everywhere. */
function round(d: string): string {
  return d.replace(/-?\d+\.\d+/g, (m) => String(Math.round(Number(m) * 10) / 10));
}

function toPaths(drawable: Drawable, dash?: string, tone?: 'ink' | 'muted'): DiagramPath[] {
  return gen.toPaths(drawable).map((p) => ({
    d: round(p.d),
    w: p.strokeWidth,
    ...(dash ? { dash } : {}),
    ...(tone === 'muted' ? { tone } : {}),
  }));
}

export function rounded(pts: Pt[], r: number): string {
  if (!r || pts.length < 3) return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ');
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const a = Math.min(r, Math.hypot(cx - px, cy - py) / 2);
    const b = Math.min(r, Math.hypot(nx - cx, ny - cy) / 2);
    const ax = cx + ((px - cx) / Math.hypot(px - cx, py - cy)) * a;
    const ay = cy + ((py - cy) / Math.hypot(px - cx, py - cy)) * a;
    const bx = cx + ((nx - cx) / Math.hypot(nx - cx, ny - cy)) * b;
    const by = cy + ((ny - cy) / Math.hypot(nx - cx, ny - cy)) * b;
    d += ` L${ax} ${ay} Q${cx} ${cy} ${bx} ${by}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  return `${d} L${lx} ${ly}`;
}

export function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  return (
    `M${x + r} ${y} L${x + w - r} ${y} Q${x + w} ${y} ${x + w} ${y + r} L${x + w} ${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} ` +
    `L${x + r} ${y + h} Q${x} ${y + h} ${x} ${y + h - r} L${x} ${y + r} Q${x} ${y} ${x + r} ${y} Z`
  );
}

const SKETCH = { roughness: 1.5, bowing: 1.3, strokeWidth: 2.2, stroke: '#000', fill: undefined as string | undefined };

export class Sketch {
  readonly ink: DiagramPath[] = [];
  readonly labels: DiagramLabel[] = [];
  private seed = 11;
  private n = 0;

  private next(): number {
    return (this.seed += 17);
  }

  private opts(s: Stroke = {}, base: { strokeWidth?: number; roughness?: number; bowing?: number } = {}) {
    return {
      ...SKETCH,
      ...base,
      seed: this.next(),
      ...(s.w !== undefined ? { strokeWidth: s.w } : {}),
      ...(s.roughness !== undefined ? { roughness: s.roughness } : {}),
      ...(s.bowing !== undefined ? { bowing: s.bowing } : {}),
    };
  }

  label(l: Omit<DiagramLabel, 'rot'>): void {
    this.labels.push({ ...l, rot: ((this.n++ * 7) % 5) * 0.45 - 0.9 });
  }

  /** Quiet text: 18 px muted by default. */
  say(x: number, y: number, text: string, o: Partial<Omit<DiagramLabel, 'x' | 'y' | 'text' | 'rot'>> = {}): void {
    this.label({ x, y, text, size: 18, weight: 400, anchor: 'start', tone: 'muted', ...o });
  }

  /** A rounded dashed outline round a part of the diagram. */
  group(x: number, y: number, w: number, h: number): void {
    this.ink.push(
      ...toPaths(gen.path(roundedRect(x, y, w, h, 22), this.opts({ w: 1.8, roughness: 1.3 })), '10 9'),
    );
  }

  rect(x: number, y: number, w: number, h: number, s: Stroke = {}): void {
    this.ink.push(...toPaths(gen.rectangle(x, y, w, h, this.opts(s)), s.dash, s.tone));
  }

  /** A pill or a rounded card. */
  pill(x: number, y: number, w: number, h: number, s: Stroke = {}): void {
    this.ink.push(...toPaths(gen.path(roundedRect(x, y, w, h, h / 2), this.opts(s)), s.dash, s.tone));
  }

  poly(pts: Pt[], s: Stroke = {}): void {
    this.ink.push(...toPaths(gen.polygon(pts, this.opts(s, { strokeWidth: 1.8, roughness: 1.1 })), s.dash, s.tone));
  }

  line(x1: number, y1: number, x2: number, y2: number, s: Stroke = {}): void {
    this.ink.push(...toPaths(gen.line(x1, y1, x2, y2, this.opts(s, { strokeWidth: 1.8, roughness: 1 })), s.dash, s.tone));
  }

  ellipse(cx: number, cy: number, w: number, h: number, s: Stroke = {}): void {
    this.ink.push(...toPaths(gen.ellipse(cx, cy, w, h, this.opts(s, { strokeWidth: 1.8, roughness: 1.1 })), s.dash, s.tone));
  }

  /** Pencil shading inside a closed path, in muted ink. */
  hatch(d: string): void {
    this.ink.push(
      ...toPaths(
        gen.path(d, { ...this.opts({}, { roughness: 1 }), stroke: 'none', fill: '#000', fillStyle: 'hachure', hachureGap: 5, fillWeight: 1.2 }),
        undefined,
        'muted',
      ),
    );
  }

  /** Round badge with a number, like the step circles of a loop. */
  badge(cx: number, cy: number, r: number, text: string): void {
    this.ellipse(cx, cy, r * 2, r * 2);
    this.label({ x: cx, y: cy + 6, text, size: 18, weight: 700, anchor: 'middle', tone: 'ink' });
  }

  /** A small folder outline, `w` wide. */
  folder(x: number, y: number, w = 30): void {
    const h = Math.round(w * 0.75);
    this.poly([
      [x, y + 3],
      [x, y + h],
      [x + w, y + h],
      [x + w, y + 7],
      [x + w / 2, y + 7],
      [x + w / 2 - 4, y + 1],
      [x + 3, y + 1],
    ]);
  }

  /** A box with a title, a second line in muted ink and a step number in its corner. */
  node(x: number, y: number, w: number, h: number, o: NodeOptions): void {
    this.rect(x, y, w, h, { w: o.bold ? 3.2 : undefined, dash: o.dash, tone: o.tone });
    const cx = x + w / 2;
    const ty = o.sub ? y + h / 2 - 2 : y + h / 2 + 8;
    this.label({ x: cx, y: ty, text: o.title, size: 22, weight: o.bold ? 700 : 400, anchor: 'middle', tone: 'ink', fit: w - 16 });
    if (o.sub) this.say(cx, ty + 24, o.sub, { anchor: 'middle', fit: w - 16 });
    if (o.step) this.say(x + 10, y + h - 9, String(o.step), { size: 16, weight: 700 });
  }

  /** A sketched arrow with an open head, along straight or elbow points. */
  arrow(pts: Pt[], a: ArrowOptions = {}): void {
    const dash = a.dashed ? '11 9' : a.dash;
    this.ink.push(
      ...toPaths(gen.path(rounded(pts, a.r ?? 0), this.opts({ ...a, w: a.w ?? 2, roughness: a.roughness ?? 1.2 })), dash, a.tone),
    );
    if (a.head === false) return;
    // Open arrowhead: two short strokes back from the tip.
    const [tx, ty] = pts[pts.length - 1];
    const [fx, fy] = pts[pts.length - 2];
    const ang = Math.atan2(ty - fy, tx - fx);
    for (const off of [-0.5, 0.5]) {
      const hx = tx - 14 * Math.cos(ang + off);
      const hy = ty - 14 * Math.sin(ang + off);
      this.ink.push(
        ...toPaths(gen.line(hx, hy, tx, ty, this.opts({ w: a.w ?? 2, roughness: 0.8, bowing: 0.6 })), undefined, a.tone),
      );
    }
  }

  build(width: number, height: number, alt: string): Diagram {
    return { width, height, ink: this.ink, labels: this.labels, alt };
  }
}
