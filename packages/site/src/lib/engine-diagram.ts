import { Sketch, type Diagram, type Pt } from './sketch.ts';

export type { Diagram, DiagramLabel, DiagramPath } from './sketch.ts';

/**
 * The engine diagram: one data set, drawn by two renderers. `components/engine-diagram.tsx` draws it on the docs site
 * (interactive), and `scripts/engine-diagram.mjs` writes the static SVGs for the README. The drawing kit is shared
 * with the docs illustrations (`sketch.ts`).
 */

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
const H = 606;

const BOXES: Box[] = [
  { id: 'remotion', x: 30, y: 44, w: 200, h: 62, label: 'Remotion project', sub: 'TSX' },
  { id: 'hyperframes', x: 30, y: 130, w: 200, h: 62, label: 'HyperFrames page', sub: 'HTML' },
  { id: 'bundle', x: 290, y: 78, w: 130, h: 80, label: 'Bundle', sub: 'esbuild', step: 1 },
  { id: 'run', x: 502, y: 78, w: 220, h: 80, label: 'Run frame N', sub: 'React, GSAP', step: 2 },
  { id: 'layers', x: 778, y: 78, w: 250, h: 80, label: 'Layers + DOM islands', sub: 'Rect, Text, HTML, SVG', step: 3 },
  { id: 'layout', x: 793, y: 358, w: 220, h: 80, label: 'Lay out + paint', sub: 'Stylo, Taffy, Parley', step: 4 },
  { id: 'composite', x: 502, y: 358, w: 240, h: 80, label: 'Composite on the GPU', sub: 'wgpu, Skia', step: 5 },
  { id: 'encode', x: 290, y: 358, w: 130, h: 80, label: 'Encode', sub: 'FFmpeg', step: 6 },
  { id: 'mp4', x: 50, y: 358, w: 120, h: 80, label: 'MP4', icon: 'play' },
  { id: 'audio', x: 245, y: 504, w: 220, h: 70, label: 'Web Audio', sub: 'rendered offline' },
];

const GROUPS = [
  { id: 'node', x: 480, y: 28, w: 570, h: 180, label: 'In Node' },
  { id: 'rust', x: 480, y: 308, w: 570, h: 180, label: 'In the Rust addon' },
];

interface Arrow {
  pts: Pt[];
  dashed?: boolean;
  /** Rounds the corners of an elbow arrow. */
  r?: number;
}

const ARROWS: Arrow[] = [
  { pts: [[236, 84], [284, 112]] },
  { pts: [[236, 168], [284, 130]] },
  { pts: [[426, 118], [496, 118]] },
  { pts: [[728, 118], [772, 118]] },
  { pts: [[903, 166], [903, 352]] },
  { pts: [[787, 398], [748, 398]] },
  { pts: [[496, 398], [426, 398]] },
  { pts: [[284, 398], [176, 398]] },
  { pts: [[355, 498], [355, 444]] },
  { pts: [[355, 350], [355, 258], [612, 258], [612, 166]], dashed: true, r: 18 },
];

const ARROW_LABELS: { text: string; x: number; y: number; anchor: 'start' | 'middle' }[] = [
  { text: 'JSON', x: 922, y: 268, anchor: 'start' },
  { text: 'next frame', x: 483, y: 244, anchor: 'middle' },
];

let cached: Diagram | undefined;

export function buildDiagram(): Diagram {
  if (cached) return cached;
  const sk = new Sketch();

  for (const g of GROUPS) {
    sk.group(g.x, g.y, g.w, g.h);
    sk.label({ x: g.x + 22, y: g.y + 34, text: g.label, size: 22, weight: 700, anchor: 'start', tone: 'ink' });
  }

  for (const b of BOXES) {
    sk.rect(b.x, b.y, b.w, b.h);
    const cx = b.x + b.w / 2;
    const tall = b.h > 70;
    if (b.icon === 'play') {
      sk.poly([
        [cx - 9, b.y + 14],
        [cx - 9, b.y + 38],
        [cx + 12, b.y + 26],
      ]);
    }
    const y1 = b.icon ? b.y + 66 : b.sub ? (tall ? b.y + 38 : b.y + 28) : b.y + b.h / 2 + 8;
    sk.label({ x: cx, y: y1, text: b.label, size: 22, weight: 400, anchor: 'middle', tone: 'ink' });
    if (b.sub) sk.label({ x: cx, y: y1 + (tall ? 24 : 22), text: b.sub, size: 18, weight: 400, anchor: 'middle', tone: 'muted' });
    if (b.step) sk.label({ x: b.x + 10, y: b.y + b.h - 9, text: String(b.step), size: 16, weight: 700, anchor: 'start', tone: 'muted' });
  }

  for (const a of ARROWS) sk.arrow(a.pts, { dashed: a.dashed, r: a.r });

  for (const t of ARROW_LABELS) sk.label({ ...t, size: 20, weight: 400, tone: 'muted' });

  cached = sk.build(W, H, ALT);
  return cached;
}
