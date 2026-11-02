import rough from 'roughjs';
import type { Drawable } from 'roughjs/bin/core';

/**
 * The engine diagram: one data set, drawn by two renderers. `components/engine-diagram.tsx` draws it on the docs site
 * (interactive), and `scripts/engine-diagram.mjs` writes the static SVGs for the README. Every shape comes from
 * roughjs with a fixed seed, so the strokes are the same on the server, in the browser and in the SVG files.
 */

export interface DiagramPath {
  d: string;
  /** Stroke width. */
  w: number;
  /** Stroke dash array, for the dashed group boxes and the loop arrow. */
  dash?: string;
}

export interface DiagramLabel {
  x: number;
  y: number;
  text: string;
  size: number;
  weight: 300 | 400 | 700;
  anchor: 'start' | 'middle';
  /** `ink` is the main colour, `muted` the secondary text. */
  tone: 'ink' | 'muted';
  /** Degrees; each label sits a little off the baseline, like handwriting. */
  rot: number;
  /** The box this label belongs to, so a highlighted box can put a halo behind its text. */
  node?: string;
}

export interface DiagramStep {
  node: string;
  title: string;
  caption: string;
}

export interface Diagram {
  width: number;
  height: number;
  /** Boxes, group boxes and arrows, in drawing order. */
  ink: DiagramPath[];
  /** The pale yellow wash of each stage box, by box id; drawn only for the active step. */
  wash: Record<string, string>;
  /** The thin yellow hatching over the wash. */
  hatch: Record<string, DiagramPath[]>;
  /** A box's own outline, so the active one can be redrawn in dark ink over the wash. */
  outline: Record<string, DiagramPath[]>;
  labels: DiagramLabel[];
  steps: DiagramStep[];
  alt: string;
}

/** One sentence per step, from "How one frame is made" in content/docs/internals/engine.mdx. */
export const STEPS: DiagramStep[] = [
  {
    node: 'bundle',
    title: 'Bundle',
    caption:
      'The CLI bundles the project with esbuild, and imports of remotion point at @kinetographdev/core, so a Remotion project runs unchanged.',
  },
  {
    node: 'run',
    title: 'Run frame N',
    caption: 'Date, timers and Math.random follow the frame number, then React renders the component tree for that frame.',
  },
  {
    node: 'layers',
    title: 'Layers + DOM islands',
    caption:
      "Kinetograph's own elements become scene layers, and each run of plain HTML and SVG becomes a DOM island that goes to the addon as JSON.",
  },
  {
    node: 'layout',
    title: 'Lay out + paint',
    caption: 'Stylo works out the styles, Taffy lays out the boxes, Parley shapes the text, and the result is painted into scene layers.',
  },
  {
    node: 'composite',
    title: 'Composite on the GPU',
    caption: 'wgpu draws the layer tree, with Skia for vector shapes, text and Canvas 2D, and WGSL passes for effects.',
  },
  {
    node: 'encode',
    title: 'Encode',
    caption: 'Each finished frame goes to FFmpeg on another thread while the GPU draws the next one, and offline audio is mixed in at the end.',
  },
];

export const ALT =
  'Diagram of how Kinetograph makes a frame. A Remotion project (TSX) and a HyperFrames page (HTML) go into a bundle step with esbuild. ' +
  'In Node, the project runs for frame N (React, GSAP), then splits into layers and DOM islands. That goes as JSON to the Rust addon, ' +
  'which lays out and paints (Stylo, Taffy, Parley) and composites on the GPU (wgpu, Skia). FFmpeg encodes each frame to an MP4, ' +
  'with Web Audio rendered offline as a side input. A dashed arrow loops back from the encoder to run the next frame.';

interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  sub?: string;
  step?: number;
  icon?: 'play';
}

const W = 1080;
const H = 690;

const BOXES: Box[] = [
  { id: 'remotion', x: 30, y: 128, w: 200, h: 62, label: 'Remotion project', sub: 'TSX' },
  { id: 'hyperframes', x: 30, y: 214, w: 200, h: 62, label: 'HyperFrames page', sub: 'HTML' },
  { id: 'bundle', x: 290, y: 162, w: 130, h: 80, label: 'Bundle', sub: 'esbuild', step: 1 },
  { id: 'run', x: 502, y: 162, w: 220, h: 80, label: 'Run frame N', sub: 'React, GSAP', step: 2 },
  { id: 'layers', x: 778, y: 162, w: 250, h: 80, label: 'Layers + DOM islands', sub: 'Rect, Text, HTML, SVG', step: 3 },
  { id: 'layout', x: 793, y: 442, w: 220, h: 80, label: 'Lay out + paint', sub: 'Stylo, Taffy, Parley', step: 4 },
  { id: 'composite', x: 502, y: 442, w: 240, h: 80, label: 'Composite on the GPU', sub: 'wgpu, Skia', step: 5 },
  { id: 'encode', x: 290, y: 442, w: 130, h: 80, label: 'Encode', sub: 'FFmpeg', step: 6 },
  { id: 'mp4', x: 50, y: 442, w: 120, h: 80, label: 'MP4', icon: 'play' },
  { id: 'audio', x: 245, y: 588, w: 220, h: 70, label: 'Web Audio', sub: 'rendered offline' },
];

const GROUPS = [
  { id: 'node', x: 480, y: 112, w: 570, h: 180, label: 'In Node' },
  { id: 'rust', x: 480, y: 392, w: 570, h: 180, label: 'In the Rust addon' },
];

type Pt = [number, number];

interface Arrow {
  pts: Pt[];
  dashed?: boolean;
  /** Rounds the corners of an elbow arrow. */
  r?: number;
}

const ARROWS: Arrow[] = [
  { pts: [[236, 168], [284, 196]] },
  { pts: [[236, 252], [284, 214]] },
  { pts: [[426, 202], [496, 202]] },
  { pts: [[728, 202], [772, 202]] },
  { pts: [[903, 250], [903, 436]] },
  { pts: [[787, 482], [748, 482]] },
  { pts: [[496, 482], [426, 482]] },
  { pts: [[284, 482], [176, 482]] },
  { pts: [[355, 582], [355, 528]] },
  { pts: [[355, 434], [355, 342], [612, 342], [612, 250]], dashed: true, r: 18 },
];

const ARROW_LABELS: { text: string; x: number; y: number; anchor: 'start' | 'middle' }[] = [
  { text: 'JSON', x: 922, y: 352, anchor: 'start' },
  { text: 'next frame', x: 483, y: 328, anchor: 'middle' },
];

const gen = rough.generator();

/** One decimal is plenty at this size, and keeps the paths short and the same everywhere. */
function round(d: string): string {
  return d.replace(/-?\d+\.\d+/g, (m) => String(Math.round(Number(m) * 10) / 10));
}

function toPaths(drawable: Drawable, dash?: string): DiagramPath[] {
  return gen.toPaths(drawable).map((p) => ({ d: round(p.d), w: p.strokeWidth, ...(dash ? { dash } : {}) }));
}

function rounded(pts: Pt[], r: number): string {
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

function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  return (
    `M${x + r} ${y} L${x + w - r} ${y} Q${x + w} ${y} ${x + w} ${y + r} L${x + w} ${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} ` +
    `L${x + r} ${y + h} Q${x} ${y + h} ${x} ${y + h - r} L${x} ${y + r} Q${x} ${y} ${x + r} ${y} Z`
  );
}

const SKETCH = { roughness: 1.5, bowing: 1.3, strokeWidth: 2.2, stroke: '#000', fill: undefined as string | undefined };

let cached: Diagram | undefined;

export function buildDiagram(): Diagram {
  if (cached) return cached;
  let seed = 11;
  const next = () => (seed += 17);
  const ink: DiagramPath[] = [];
  const hatch: Record<string, DiagramPath[]> = {};
  const wash: Record<string, string> = {};
  const outline: Record<string, DiagramPath[]> = {};
  const labels: DiagramLabel[] = [];
  let n = 0;
  const label = (l: Omit<DiagramLabel, 'rot'>) => labels.push({ ...l, rot: ((n++ * 7) % 5) * 0.45 - 0.9 });

  // Title and subtitle.
  label({ x: 30, y: 54, text: 'How Kinetograph makes a frame', size: 40, weight: 700, anchor: 'start', tone: 'ink' });
  label({ x: 30, y: 88, text: 'One pass per frame. No browser.', size: 23, weight: 300, anchor: 'start', tone: 'muted' });

  for (const g of GROUPS) {
    ink.push(
      ...toPaths(
        gen.path(roundedRect(g.x, g.y, g.w, g.h, 22), { ...SKETCH, seed: next(), roughness: 1.3, strokeWidth: 1.8 }),
        '10 9',
      ),
    );
    label({ x: g.x + 22, y: g.y + 34, text: g.label, size: 22, weight: 700, anchor: 'start', tone: 'ink' });
  }

  for (const b of BOXES) {
    const box = toPaths(gen.rectangle(b.x, b.y, b.w, b.h, { ...SKETCH, seed: next() }));
    ink.push(...box);
    if (b.step) {
      outline[b.id] = box;
      wash[b.id] = round(
        gen.toPaths(gen.rectangle(b.x, b.y, b.w, b.h, { roughness: 1.1, stroke: 'none', fill: '#000', fillStyle: 'solid', seed: next() }))[0].d,
      );
      hatch[b.id] = toPaths(
        gen.rectangle(b.x, b.y, b.w, b.h, {
          roughness: 1.1,
          stroke: 'none',
          fill: '#000',
          fillStyle: 'hachure',
          hachureAngle: -42,
          hachureGap: 15,
          fillWeight: 1.2,
          seed: next(),
        }),
      );
    }
    const cx = b.x + b.w / 2;
    const tall = b.h > 70;
    if (b.icon === 'play') {
      ink.push(
        ...toPaths(
          gen.polygon(
            [
              [cx - 9, b.y + 14],
              [cx - 9, b.y + 38],
              [cx + 12, b.y + 26],
            ],
            { ...SKETCH, seed: next(), strokeWidth: 1.8, roughness: 1.1 },
          ),
        ),
      );
    }
    const y1 = b.icon ? b.y + 66 : b.sub ? (tall ? b.y + 38 : b.y + 28) : b.y + b.h / 2 + 8;
    label({ x: cx, y: y1, text: b.label, size: 22, weight: 400, anchor: 'middle', tone: 'ink', node: b.id });
    if (b.sub) label({ x: cx, y: y1 + (tall ? 24 : 22), text: b.sub, size: 18, weight: 400, anchor: 'middle', tone: 'muted', node: b.id });
    if (b.step) label({ x: b.x + 10, y: b.y + b.h - 9, text: String(b.step), size: 16, weight: 700, anchor: 'start', tone: 'muted', node: b.id });
  }

  for (const a of ARROWS) {
    const dash = a.dashed ? '11 9' : undefined;
    ink.push(...toPaths(gen.path(rounded(a.pts, a.r ?? 0), { ...SKETCH, seed: next(), strokeWidth: 2, roughness: 1.2 }), dash));
    // Open arrowhead: two short strokes back from the tip.
    const [tx, ty] = a.pts[a.pts.length - 1];
    const [fx, fy] = a.pts[a.pts.length - 2];
    const ang = Math.atan2(ty - fy, tx - fx);
    for (const off of [-0.5, 0.5]) {
      const hx = tx - 14 * Math.cos(ang + off);
      const hy = ty - 14 * Math.sin(ang + off);
      ink.push(...toPaths(gen.line(hx, hy, tx, ty, { ...SKETCH, seed: next(), strokeWidth: 2, roughness: 0.8, bowing: 0.6 })));
    }
  }

  for (const t of ARROW_LABELS) label({ ...t, size: 20, weight: 400, tone: 'muted' });

  cached = { width: W, height: H, ink, wash, hatch, outline, labels, steps: STEPS, alt: ALT };
  return cached;
}
