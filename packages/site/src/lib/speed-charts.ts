import { WORKERS, speedUp } from '../data/speed.ts';
import { Sketch, type Diagram } from './sketch.ts';

/**
 * The drawings on the Speed page that are SVG: worker scaling, the lanes of one render and where a frame's time goes
 * (the per-video bars are HTML, in `components/docs/speed-charts.tsx`). Drawn from `data/speed.ts`.
 *
 * Only the frame is hand-sketched, with the kit of the engine diagram (`sketch.ts`): the axis lines and the rule
 * under a legend. The data is crisp: square rects, straight polylines, round markers. Words are Kalam, numbers mono.
 * Two text sizes, `WORD` and `NOTE`; cobalt marks Kinetograph, ink is everything else.
 */

/** What a mark is painted with: the site's cobalt, the ink and muted ink of the figure, or its paper. */
export type Paint = 'accent' | 'ink' | 'muted' | 'paper';

export type Mark =
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill?: Paint | 'hatch'; opacity?: number; stroke?: Paint; sw?: number; dash?: string }
  | { t: 'dot'; x: number; y: number; r: number; fill: Paint; stroke?: Paint; sw?: number }
  | { t: 'line'; pts: [number, number][]; stroke: Paint; sw: number; dash?: string; opacity?: number }
  | { t: 'text'; x: number; y: number; text: string; size: number; anchor?: 'start' | 'middle' | 'end'; paint: Paint; bold?: boolean; mono?: boolean };

export interface Chart {
  width: number;
  height: number;
  /** Short name for the picture (the SVG title). */
  title: string;
  /** What the picture shows, in words, for a screen reader. */
  desc: string;
  marks: Mark[];
  /** The hand-sketched frame: axis lines and rules, in ink. */
  frame: Diagram;
}

export const WORD = 20;
export const NOTE = 18;

const x2 = (n: number) => `${n.toFixed(2)}×`;
const sec = (n: number) => `${n.toFixed(2)} s`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function done(width: number, height: number, title: string, desc: string, marks: Mark[], frame: Sketch): Chart {
  return { width, height, title, desc, marks, frame: frame.build(width, height, desc) };
}

/** A hand-sketched rule, for under a legend. */
export function ruleDiagram(): Diagram {
  const sk = new Sketch();
  sk.line(2, 4, 518, 4, { w: 1.8, roughness: 0.9 });
  return sk.build(520, 8, '');
}

/* ------------------------------------------------------------------ worker scaling */

export function workersChart(): Chart {
  const W = 520;
  const AXIS = 56;
  const wx = (n: number) => 114 + (n - 1) * 72;
  const BASE = 250;
  const PY = 16;
  const sy = (s: number) => BASE - s * PY;
  const pts = WORKERS.points;
  const one = pts[0].s;
  const frame = new Sketch();
  const marks: Mark[] = [];

  marks.push({ t: 'text', x: 8, y: 22, text: 'wall seconds', size: NOTE, paint: 'muted' });
  for (const t of [4, 8]) marks.push({ t: 'line', pts: [[AXIS, sy(t)], [W - 12, sy(t)]], stroke: 'muted', sw: 1, opacity: 0.4 });
  for (const t of [0, 4, 8]) marks.push({ t: 'text', x: AXIS - 10, y: sy(t) + 6, text: String(t), size: NOTE, anchor: 'end', paint: 'muted', mono: true });
  frame.line(AXIS, sy(12.5), AXIS, BASE, { w: 2, roughness: 0.7 });
  frame.line(AXIS, BASE, W - 8, BASE, { w: 2, roughness: 0.7 });

  // Ideal: the time of one worker divided by the workers.
  marks.push({ t: 'line', pts: [1, 2, 3, 4, 5, 6].map((n) => [wx(n), sy(one / n)] as [number, number]), stroke: 'muted', sw: 1.5, dash: '5 5' });
  marks.push({ t: 'text', x: wx(3) + 12, y: sy(one / 3) - 14, text: 'ideal: time ÷ workers', size: NOTE, paint: 'muted' });

  // Measured.
  marks.push({ t: 'line', pts: pts.map((p) => [wx(p.workers), sy(p.s)] as [number, number]), stroke: 'accent', sw: 2.5 });
  for (const p of pts) {
    marks.push({ t: 'dot', x: wx(p.workers), y: sy(p.s), r: 5, fill: 'accent', stroke: 'paper', sw: 2 });
    marks.push({ t: 'text', x: wx(p.workers), y: sy(p.s) - 14, text: p.s.toFixed(2), size: NOTE, anchor: 'middle', paint: 'accent', bold: true, mono: true });
    marks.push({ t: 'text', x: wx(p.workers), y: BASE + 28, text: String(p.workers), size: NOTE, anchor: 'middle', paint: 'ink', mono: true });
    marks.push({ t: 'text', x: wx(p.workers), y: BASE + 60, text: x2(speedUp(p.s)), size: NOTE, anchor: 'middle', paint: 'accent', bold: true, mono: true });
  }
  marks.push({ t: 'text', x: 8, y: BASE + 28, text: 'workers', size: NOTE, paint: 'muted' });
  marks.push({ t: 'text', x: 8, y: BASE + 60, text: 'speed-up', size: NOTE, paint: 'muted' });
  marks.push({ t: 'line', pts: [[8, BASE + 40], [W - 12, BASE + 40]], stroke: 'muted', sw: 1, opacity: 0.4 });

  const desc =
    `A line chart of render time in seconds against the number of workers on ${WORKERS.video}, ${WORKERS.frames} frames at ${WORKERS.size}. ` +
    `Measured: ${pts.map((p) => `${plural(p.workers, 'worker')} ${sec(p.s)}, ${speedUp(p.s).toFixed(2)} times faster than one`).join('; ')}. ` +
    `A dashed line shows the ideal, the time of one worker divided by the workers, which keeps falling.`;
  return done(W, BASE + 80, 'Render time against workers', desc, marks, frame);
}

/* ------------------------------------------------------------------ one render, by worker */

export function lanesChart(): Chart {
  const W = 520;
  const X0 = 118;
  const L = 300;
  const TIME = W - 12;
  const BAR = 20;
  const LANE = 10;
  const LGAP = 4;
  const pts = WORKERS.points;
  const one = pts[0].s;
  const four = pts.find((p) => p.workers === 4)!.s;
  const frame = new Sketch();
  const marks: Mark[] = [];
  const name = (y: number, text: string, sub?: string) => {
    marks.push({ t: 'text', x: 8, y: y + 15, text, size: WORD, paint: 'ink', bold: true });
    if (sub) marks.push({ t: 'text', x: 8, y: y + 15 + 22, text: sub, size: NOTE, paint: 'muted' });
  };

  // 1 worker.
  const ya = 12;
  name(ya, '1 worker');
  marks.push({ t: 'rect', x: X0, y: ya, w: L, h: BAR, fill: 'accent' });
  marks.push({ t: 'text', x: TIME, y: ya + 15, text: sec(one), size: NOTE, anchor: 'end', paint: 'ink', mono: true, bold: true });

  // 4 workers, ideal: the whole film in a quarter of the time.
  const yb = ya + BAR + 40;
  name(yb, '4 workers', 'ideal');
  marks.push({ t: 'rect', x: X0, y: yb, w: L / 4, h: BAR, stroke: 'muted', sw: 1.5, dash: '4 3' });
  marks.push({ t: 'text', x: TIME, y: yb + 15, text: '÷ 4', size: NOTE, anchor: 'end', paint: 'muted', mono: true });

  // 4 workers, measured: four lanes, each as long as the whole render took.
  const yc = yb + BAR + 40;
  const block = 4 * LANE + 3 * LGAP;
  const wl = (L * four) / one;
  const rw = wl * WORKERS.replayShare;
  name(yc, '4 workers', 'measured');
  for (let i = 0; i < 4; i++) {
    const y = yc + i * (LANE + LGAP);
    marks.push({ t: 'rect', x: X0, y, w: rw, h: LANE, fill: 'hatch', stroke: 'muted', sw: 1 });
    marks.push({ t: 'rect', x: X0 + rw, y, w: wl - rw, h: LANE, fill: 'accent' });
  }
  marks.push({ t: 'text', x: TIME, y: yc + block / 2 + 6, text: sec(four), size: NOTE, anchor: 'end', paint: 'ink', mono: true, bold: true });

  // One light time scale under the three rows.
  const ys = yc + block + 20;
  frame.line(X0, ys, X0 + L, ys, { w: 1.6, roughness: 0.6 });
  for (const t of [0, 4, 8, one]) {
    const x = X0 + (t / one) * L;
    marks.push({ t: 'line', pts: [[x, ys], [x, ys + 5]], stroke: 'muted', sw: 1 });
    marks.push({ t: 'text', x, y: ys + 24, text: t === one ? sec(t) : `${t} s`, size: NOTE, anchor: 'middle', paint: 'muted', mono: true });
  }

  const pct = `${Math.round(WORKERS.replayShare * 100)}%`;
  const desc =
    `Three bars on one time scale from 0 to ${sec(one)} for ${WORKERS.video}. One worker takes ${sec(one)}. Four workers, in theory, take a quarter of that. ` +
    `Four workers, measured, take ${sec(four)}, and each of their four lanes is ${pct} replaying frames that other workers drew, then drawing its own frames, ` +
    `each ${WORKERS.slowCoreFactor.toFixed(1)} times slower on the slow cores.`;
  return done(W, ys + 36, 'One render, by worker', desc, marks, frame);
}

/* ------------------------------------------------------------------ where a frame's time goes */

export function frameChart(): Chart {
  const W = 520;
  const X0 = 12;
  const XW = W - 24;
  const PX = XW / WORKERS.frameMsTotal;
  const BAR = 32;
  const TOPY = 48;
  const opacities = [1, 0.6, 0.35, 0.18];
  const frame = new Sketch();
  const marks: Mark[] = [];

  frame.line(X0, TOPY - 12, X0 + XW, TOPY - 12, { w: 1.6, roughness: 0.6 });
  marks.push({ t: 'text', x: X0, y: 22, text: `${WORKERS.frameMsTotal.toFixed(1)} ms per frame, 1 worker`, size: WORD, paint: 'ink', bold: true });

  let x = X0;
  WORKERS.frameMs.forEach((seg, i) => {
    const w = seg.ms * PX;
    marks.push({ t: 'rect', x, y: TOPY, w: w - (i < 3 ? 2 : 0), h: BAR, fill: i < 3 ? 'accent' : 'ink', opacity: opacities[i] });
    x += w;
  });
  WORKERS.frameMs.forEach((seg, i) => {
    const y = TOPY + BAR + 32 + i * 32;
    marks.push({ t: 'rect', x: X0, y: y - 13, w: 20, h: 14, fill: i < 3 ? 'accent' : 'ink', opacity: opacities[i] });
    marks.push({ t: 'text', x: X0 + 32, y, text: seg.label, size: WORD, paint: 'ink' });
    marks.push({ t: 'text', x: X0 + XW, y, text: `${seg.ms.toFixed(1)} ms`, size: NOTE, anchor: 'end', paint: 'ink', mono: true, bold: true });
  });

  const desc =
    `One stacked bar of ${WORKERS.frameMsTotal.toFixed(1)} milliseconds, where a frame's time goes with one worker: ` +
    WORKERS.frameMs.map((s) => `${s.label.toLowerCase()} ${s.ms.toFixed(1)} milliseconds`).join(', ') +
    '.';
  return done(W, TOPY + BAR + 32 + 4 * 32 - 8, "Where a frame's time goes", desc, marks, frame);
}

/** For the check script: every SVG chart by name. */
export const charts = { workers: workersChart, lanes: lanesChart, frame: frameChart };
