import { SCENES, WORKERS, speedUp } from '../data/speed.ts';
import { Sketch, roundedRect, type Diagram } from './sketch.ts';

/**
 * The drawings on the Speed page: a bar chart, a dot chart, a line chart and two bars, all drawn from `data/speed.ts`
 * with the same hand-sketched kit as the engine diagram (`sketch.ts`). Each builder returns data, and
 * `components/docs/speed-charts.tsx` draws it. Cobalt marks Kinetograph, ink is everything else.
 */

/** What a fill is painted with: the site's cobalt, the ink and muted ink of the figure, or its paper. */
export type Paint = 'accent' | 'ink' | 'muted' | 'paper';

export interface Fill {
  shape: 'rect' | 'dot';
  x: number;
  y: number;
  /** Rect size. */
  w?: number;
  h?: number;
  /** Dot radius. */
  r?: number;
  paint: Paint;
  opacity: number;
  /** Drawn over the strokes and under the labels, to keep a grid line out of a label. */
  cover?: boolean;
}

export interface Chart {
  width: number;
  height: number;
  /** Short name for the picture (the SVG title). */
  title: string;
  /** What the picture shows, in words, for a screen reader. */
  desc: string;
  /** Soft colour behind the strokes, drawn first. */
  fills: Fill[];
  /** Strokes and labels in ink. */
  ink: Diagram;
  /** Strokes and labels in cobalt. */
  accent: Diagram;
}

/** A rough width of Kalam text, enough to lay out a legend. The check script measures the real font. */
export function textWidth(text: string, size: number): number {
  return text.length * size * 0.5;
}

const x1 = (n: number) => `${n.toFixed(1)}\u00d7`;
const xi = (n: number) => `${n}\u00d7`;
const x2 = (n: number) => `${n.toFixed(2)}\u00d7`;
const sec = (n: number) => `${n.toFixed(2)} s`;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Paper behind a label, so a grid line does not run through its letters. */
function back(fills: Fill[], x: number, y: number, text: string, size: number, anchor: 'start' | 'middle' | 'end' = 'start'): void {
  const w = textWidth(text, size) + 8;
  const left = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x - 3;
  fills.push({ shape: 'rect', x: left, y: y - size * 0.85, w, h: size * 1.15, paint: 'paper', opacity: 0.92, cover: true });
}

function done(width: number, height: number, title: string, desc: string, fills: Fill[], ink: Sketch, accent: Sketch): Chart {
  return { width, height, title, desc, fills, ink: ink.build(width, height, desc), accent: accent.build(width, height, desc) };
}

/* ------------------------------------------------------------------ render time per scene */

/** Longest bar, in seconds. A longer one is cut with a break mark and keeps its number. */
const CAP = 60;

export function barsChart(): Chart {
  const W = 520;
  const X0 = 108;
  const PX = 4.3;
  const BAR = 16;
  const PITCH = 21;
  const GAP = 16;
  const TOP = 74;
  const ink = new Sketch();
  const acc = new Sketch();
  const fills: Fill[] = [];

  // Legend and column heads.
  let lx = 14;
  for (const [name, paint] of [['Kinetograph', 'accent'], ['HyperFrames', 'ink'], ['Remotion', 'muted']] as const) {
    fills.push({ shape: 'rect', x: lx, y: 12, w: 24, h: 13, paint, opacity: paint === 'accent' ? 0.45 : 0.1 });
    (paint === 'accent' ? acc : ink).rect(lx, 12, 24, 13, { w: 1.8, tone: paint === 'muted' ? 'muted' : undefined, dash: paint === 'muted' ? '5 4' : undefined });
    const label = { x: lx + 32, y: 26, text: name, size: 20, weight: 400 as const, anchor: 'start' as const, tone: 'ink' as const };
    (paint === 'accent' ? acc : ink).label(label);
    lx += 32 + textWidth(name, 20) + 22;
  }
  ink.say(14, 52, 'wall seconds, median');
  ink.say(W - 12, 52, 'faster by', { anchor: 'end' });

  const total = SCENES.reduce((h, s) => h + (s.hyperframes && s.remotion ? 3 : 2) * PITCH - 3, 0) + (SCENES.length - 1) * GAP;
  const bottom = TOP + total;

  // Grid and axis.
  for (const t of [20, 40, 60]) ink.line(X0 + t * PX, TOP - 8, X0 + t * PX, bottom + 4, { w: 1.2, dash: '5 6', tone: 'muted' });
  ink.line(X0, TOP - 8, X0, bottom + 4, { w: 2 });
  ink.line(X0, bottom + 4, X0 + CAP * PX + 8, bottom + 4, { w: 2 });
  for (const t of [0, 20, 40, 60]) ink.say(X0 + t * PX, bottom + 30, t ? `${t} s` : '0', { anchor: 'middle' });

  let y = TOP;
  for (const scene of SCENES) {
    const rows = [
      { run: scene.kinetograph, paint: 'accent' as const },
      ...(scene.hyperframes ? [{ run: scene.hyperframes, paint: 'ink' as const, ratio: scene.vsHyperframes }] : []),
      ...(scene.remotion ? [{ run: scene.remotion, paint: 'muted' as const, ratio: scene.vsRemotion }] : []),
    ];
    const height = rows.length * PITCH - 3;
    ink.label({ x: 14, y: y + height / 2 + 7, text: scene.id, size: 22, weight: 700, anchor: 'start', tone: 'ink' });
    rows.forEach((row, i) => {
      const by = y + i * PITCH;
      const cut = row.run.s > CAP;
      const w = Math.max((cut ? CAP : row.run.s) * PX, 3);
      const sk = row.paint === 'accent' ? acc : ink;
      fills.push({ shape: 'rect', x: X0, y: by, w, h: BAR, paint: row.paint, opacity: row.paint === 'accent' ? 0.45 : 0.1 });
      sk.rect(X0, by, w, BAR, { w: 1.8, tone: row.paint === 'muted' ? 'muted' : undefined, dash: row.paint === 'muted' ? '6 4' : undefined });
      if (cut) {
        // A break through the bar: paper over a gap, then two slanted strokes.
        const bx = X0 + w - 40;
        fills.push({ shape: 'rect', x: bx - 3, y: by - 3, w: 10, h: BAR + 6, paint: 'paper', opacity: 1 });
        ink.line(bx - 4, by + BAR + 3, bx + 3, by - 3, { w: 1.8 });
        ink.line(bx + 3, by + BAR + 3, bx + 10, by - 3, { w: 1.8 });
      }
      back(fills, X0 + w + 8, by + 13, sec(row.run.s), 17);
      sk.label({ x: X0 + w + 8, y: by + 13, text: sec(row.run.s), size: 17, weight: row.paint === 'accent' ? 700 : 400, anchor: 'start', tone: 'ink' });
      if ('ratio' in row && row.ratio) {
        acc.label({ x: W - 12, y: by + 14, text: x1(row.ratio.x), size: 19, weight: 700, anchor: 'end', tone: 'ink' });
      }
    });
    y += height + GAP;
  }

  const desc =
    `Horizontal bars, one group per scene, of render time in seconds for Kinetograph, HyperFrames and Remotion, with how many times faster Kinetograph is. ` +
    SCENES.map((s) => {
      const parts = [`${s.id}: Kinetograph ${sec(s.kinetograph.s)}`];
      if (s.hyperframes && s.vsHyperframes) parts.push(`HyperFrames ${sec(s.hyperframes.s)}, ${x1(s.vsHyperframes.x)} faster`);
      if (s.remotion && s.vsRemotion) parts.push(`Remotion ${sec(s.remotion.s)}, ${x1(s.vsRemotion.x)} faster`);
      return parts.join(', ');
    }).join('. ') +
    `. Bars are cut at ${CAP} seconds.`;
  return done(W, bottom + 46, 'Render time per scene', desc, fills, ink, acc);
}

/* ------------------------------------------------------------------ speed-up per scene */

const SPREAD_MIN = 1;
const SPREAD_MAX = 32;

export function spreadChart(): Chart {
  const W = 520;
  const X0 = 40;
  const XW = 450;
  const DOT = 7;
  const STEP = 16;
  const at = (v: number) => X0 + (Math.log2(v / SPREAD_MIN) / Math.log2(SPREAD_MAX / SPREAD_MIN)) * XW;
  const ink = new Sketch();
  const acc = new Sketch();
  const fills: Fill[] = [];

  const lanes = [
    { title: 'vs HyperFrames', axis: 128, dots: SCENES.flatMap((s) => (s.vsHyperframes ? [{ id: s.id, v: s.vsHyperframes.x }] : [])) },
    { title: 'vs Remotion', axis: 290, dots: SCENES.flatMap((s) => (s.vsRemotion ? [{ id: s.id, v: s.vsRemotion.x }] : [])) },
  ];
  const tickY = 340;

  for (const t of [1, 2, 4, 8, 16, 32]) {
    ink.line(at(t), 46, at(t), tickY - 22, { w: t === 1 ? 2 : 1.2, dash: t === 1 ? undefined : '5 6', tone: t === 1 ? undefined : 'muted' });
    ink.say(at(t), tickY, xi(t), { anchor: 'middle', tone: 'ink' });
  }
  ink.say(X0 + XW / 2, tickY + 28, 'log scale, 1× is the same speed', { anchor: 'middle' });

  for (const lane of lanes) {
    back(fills, 14, lane.axis - 100, `${lane.title}, ${plural(lane.dots.length, 'scene')}`, 21);
    ink.label({ x: 14, y: lane.axis - 100, text: `${lane.title}, ${plural(lane.dots.length, 'scene')}`, size: 21, weight: 700, anchor: 'start', tone: 'ink' });
    ink.line(X0, lane.axis, X0 + XW, lane.axis, { w: 1.8 });
    // Dots that would touch stack upward.
    const sorted = [...lane.dots].sort((a, b) => a.v - b.v);
    const levels: number[][] = [];
    const placed = sorted.map((d) => {
      let k = levels.findIndex((xs) => xs.every((x) => Math.abs(x - at(d.v)) > DOT * 2 + 1));
      if (k < 0) k = levels.push([]) - 1;
      levels[k].push(at(d.v));
      return { ...d, x: at(d.v), y: lane.axis - DOT - 3 - k * STEP, k };
    });
    for (const p of placed) {
      fills.push({ shape: 'dot', x: p.x, y: p.y, r: DOT, paint: 'accent', opacity: 0.45 });
      acc.ellipse(p.x, p.y, DOT * 2, DOT * 2, { w: 1.8 });
    }
    const lo = placed[0];
    const hi = placed[placed.length - 1];
    back(fills, lo.x - 8, lane.axis + 24, `${lo.id} ${x1(lo.v)}`, 19);
    ink.say(lo.x - 8, lane.axis + 24, `${lo.id} ${x1(lo.v)}`, { size: 19, tone: 'ink' });
    const top = Math.min(...placed.filter((p) => p.x === hi.x).map((p) => p.y));
    back(fills, Math.min(hi.x, W - 14), top - 14, `${hi.id} ${x1(hi.v)}`, 19, hi.x > W - 110 ? 'end' : 'middle');
    acc.label({ x: Math.min(hi.x, W - 14), y: top - 14, text: `${hi.id} ${x1(hi.v)}`, size: 19, weight: 700, anchor: hi.x > W - 110 ? 'end' : 'middle', tone: 'ink' });
  }

  const desc =
    `Two rows of dots on a log scale from ${x1(SPREAD_MIN)} to ${x1(SPREAD_MAX)}, one dot per scene, for how many times faster Kinetograph is. ` +
    lanes
      .map((l) => `${l.title}, ${plural(l.dots.length, 'scene')}: ${[...l.dots].sort((a, b) => a.v - b.v).map((d) => `${d.id} ${x1(d.v)}`).join(', ')}`)
      .join('. ') +
    '.';
  return done(W, tickY + 44, 'Speed-up per scene', desc, fills, ink, acc);
}

/* ------------------------------------------------------------------ worker scaling */

export function workersChart(): Chart {
  const W = 520;
  const X0 = 110;
  const STEP = 75;
  const BASE = 256;
  const PY = 17.3;
  const pts = WORKERS.points;
  const wx = (n: number) => X0 + (n - 1) * STEP;
  const sy = (s: number) => BASE - s * PY;
  const ink = new Sketch();
  const acc = new Sketch();
  const fills: Fill[] = [];
  const one = pts[0].s;

  for (const t of [4, 8, 12]) {
    ink.line(X0 - 10, sy(t), wx(6) + 14, sy(t), { w: 1.2, dash: '5 6', tone: 'muted' });
    ink.say(X0 - 20, sy(t) + 6, `${t} s`, { anchor: 'end' });
  }
  ink.line(X0 - 10, BASE, wx(6) + 14, BASE, { w: 2 });
  ink.line(X0 - 10, sy(12) - 8, X0 - 10, BASE, { w: 2 });
  ink.say(X0 - 20, BASE + 6, '0', { anchor: 'end' });

  // Ideal: the time of one worker divided by the workers, faint.
  for (let n = 1; n < 6; n++) ink.line(wx(n), sy(one / n), wx(n + 1), sy(one / (n + 1)), { w: 1.8, dash: '7 7', tone: 'muted' });
  ink.say(wx(3) + 4, sy(one / 3) - 16, 'ideal (time ÷ workers)', { size: 19 });

  // Measured.
  for (let i = 0; i + 1 < pts.length; i++) acc.line(wx(pts[i].workers), sy(pts[i].s), wx(pts[i + 1].workers), sy(pts[i + 1].s), { w: 3.2 });
  for (const p of pts) {
    fills.push({ shape: 'dot', x: wx(p.workers), y: sy(p.s), r: 7, paint: 'accent', opacity: 0.5 });
    acc.ellipse(wx(p.workers), sy(p.s), 14, 14, { w: 2 });
    back(fills, wx(p.workers) + (p.workers === 1 ? 12 : 0), sy(p.s) - (p.workers === 1 ? 9 : 15), sec(p.s), 19, p.workers === 1 ? 'start' : 'middle');
    acc.label({ x: wx(p.workers) + (p.workers === 1 ? 12 : 0), y: sy(p.s) - (p.workers === 1 ? 9 : 15), text: sec(p.s), size: 19, weight: 700, anchor: p.workers === 1 ? 'start' : 'middle', tone: 'ink' });
    ink.label({ x: wx(p.workers), y: BASE + 30, text: String(p.workers), size: 20, weight: 400, anchor: 'middle', tone: 'ink' });
    acc.label({ x: wx(p.workers), y: BASE + 64, text: x2(speedUp(p.s)), size: 20, weight: 700, anchor: 'middle', tone: 'ink' });
  }
  ink.say(8, BASE + 30, 'workers', { size: 19 });
  ink.say(8, BASE + 64, 'speed-up', { size: 19 });

  const desc =
    `A line chart of render time in seconds against the number of workers on the ${WORKERS.scene} scene, ${WORKERS.frames} frames at ${WORKERS.size}. ` +
    `Measured: ${pts.map((p) => `${plural(p.workers, 'worker')} ${sec(p.s)}, ${speedUp(p.s).toFixed(2)} times faster than one`).join('; ')}. ` +
    `A faint dashed line shows the ideal, the time of one worker divided by the workers, which would keep falling.`;
  return done(W, BASE + 80, 'Render time against workers', desc, fills, ink, acc);
}

/* ------------------------------------------------------------------ why not 4x */

export function lanesChart(): Chart {
  const W = 520;
  const X0 = 124;
  const L = 316;
  const LANE = 14;
  const LGAP = 5;
  const pts = WORKERS.points;
  const one = pts[0].s;
  const four = pts.find((p) => p.workers === 4)!.s;
  const ink = new Sketch();
  const acc = new Sketch();
  const fills: Fill[] = [];
  const block = 4 * LANE + 3 * LGAP;

  // 1 worker.
  const ya = 20;
  ink.label({ x: 14, y: ya + 22, text: '1 worker', size: 22, weight: 700, anchor: 'start', tone: 'ink' });
  fills.push({ shape: 'rect', x: X0, y: ya, w: L, h: 30, paint: 'accent', opacity: 0.45 });
  acc.rect(X0, ya, L, 30, { w: 2 });
  ink.label({ x: X0 + L + 8, y: ya + 22, text: sec(one), size: 19, weight: 700, anchor: 'start', tone: 'ink' });

  // 4 workers, ideal: a quarter each.
  const yb = ya + 30 + 36;
  ink.label({ x: 14, y: yb + 22, text: '4 workers', size: 22, weight: 700, anchor: 'start', tone: 'ink' });
  ink.say(14, yb + 46, 'in theory');
  for (let i = 0; i < 4; i++) {
    const y = yb + i * (LANE + LGAP);
    fills.push({ shape: 'rect', x: X0, y, w: L / 4, h: LANE, paint: 'accent', opacity: 0.25 });
    ink.rect(X0, y, L / 4, LANE, { w: 1.6, dash: '5 4', tone: 'muted' });
  }
  ink.say(X0 + L / 4 + 10, yb + block / 2 + 6, 'a quarter each');

  // 4 workers, measured: every lane runs as long as the whole render took.
  const yc = yb + block + 36;
  const wl = (L * four) / one;
  const rw = wl * WORKERS.replayShare;
  ink.label({ x: 14, y: yc + 22, text: '4 workers', size: 22, weight: 700, anchor: 'start', tone: 'ink' });
  ink.say(14, yc + 46, 'measured');
  for (let i = 0; i < 4; i++) {
    const y = yc + i * (LANE + LGAP);
    fills.push({ shape: 'rect', x: X0 + rw, y, w: wl - rw, h: LANE, paint: 'accent', opacity: 0.45 });
    ink.hatch(roundedRect(X0, y, rw, LANE, 1));
    ink.rect(X0, y, rw, LANE, { w: 1.6 });
    acc.rect(X0 + rw, y, wl - rw, LANE, { w: 1.8 });
  }
  ink.label({ x: X0 + wl + 8, y: yc + block / 2 + 7, text: sec(four), size: 19, weight: 700, anchor: 'start', tone: 'ink' });

  // Key.
  const yk = yc + block + 34;
  const pct = `${Math.round(WORKERS.replayShare * 100)}%`;
  ink.hatch(roundedRect(14, yk - 4, 28, 16, 1));
  ink.rect(14, yk - 4, 28, 16, { w: 1.6 });
  ink.label({ x: 54, y: yk + 10, text: 'Replays the frames other workers drew', size: 20, weight: 400, anchor: 'start', tone: 'ink' });
  ink.say(54, yk + 34, `${pct} of a worker’s time`);
  const y2 = yk + 62;
  fills.push({ shape: 'rect', x: 14, y: y2 - 4, w: 28, h: 16, paint: 'accent', opacity: 0.45 });
  acc.rect(14, y2 - 4, 28, 16, { w: 1.8 });
  ink.label({ x: 54, y: y2 + 10, text: 'Draws its own frames', size: 20, weight: 400, anchor: 'start', tone: 'ink' });
  ink.say(54, y2 + 34, `each frame takes ${WORKERS.slowCoreFactor.toFixed(1)}× longer on the slow cores`);
  ink.say(W - 12, y2 + 64, 'Lane lengths are to scale; the split inside is a sketch.', { anchor: 'end', size: 17 });

  const desc =
    `Three rows of bars for the ${WORKERS.scene} scene. One worker takes ${sec(one)}. Four workers, in theory, each draw a quarter of the frames. ` +
    `Four workers, measured, each run ${sec(four)}, and each of those runs is ${pct} replaying frames that other workers drew, ` +
    `then drawing its own frames, which take ${WORKERS.slowCoreFactor.toFixed(1)} times longer each on the slow cores.`;
  return done(W, y2 + 88, 'Why four workers are not four times faster', desc, fills, ink, acc);
}

/* ------------------------------------------------------------------ where a frame's time goes */

export function frameChart(): Chart {
  const W = 520;
  const X0 = 20;
  const XW = 480;
  const PX = XW / WORKERS.frameMsTotal;
  const BAR = 38;
  const TOPY = 54;
  const opacities = [0.6, 0.38, 0.22, 0.1];
  const paints: Paint[] = ['accent', 'accent', 'accent', 'ink'];
  const ink = new Sketch();
  const acc = new Sketch();
  const fills: Fill[] = [];

  ink.line(X0, TOPY - 14, X0 + XW, TOPY - 14, { w: 1.8, roughness: 0.6 });
  ink.line(X0, TOPY - 20, X0, TOPY - 8, { w: 1.8, roughness: 0.6 });
  ink.line(X0 + XW, TOPY - 20, X0 + XW, TOPY - 8, { w: 1.8, roughness: 0.6 });
  ink.label({ x: X0 + XW / 2, y: 26, text: `${WORKERS.frameMsTotal.toFixed(1)} ms per frame`, size: 22, weight: 700, anchor: 'middle', tone: 'ink' });

  let x = X0;
  WORKERS.frameMs.forEach((seg, i) => {
    const w = seg.ms * PX;
    fills.push({ shape: 'rect', x, y: TOPY, w, h: BAR, paint: paints[i], opacity: opacities[i] });
    (i < 3 ? acc : ink).rect(x, TOPY, w, BAR, { w: 2 });
    x += w;
  });
  WORKERS.frameMs.forEach((seg, i) => {
    const y = TOPY + BAR + 40 + i * 30;
    fills.push({ shape: 'rect', x: 20, y: y - 12, w: 26, h: 15, paint: paints[i], opacity: opacities[i] });
    (i < 3 ? acc : ink).rect(20, y - 12, 26, 15, { w: 1.6 });
    ink.label({ x: 58, y, text: seg.label, size: 20, weight: 400, anchor: 'start', tone: 'ink' });
    ink.label({ x: X0 + XW, y, text: `${seg.ms.toFixed(1)} ms`, size: 20, weight: 700, anchor: 'end', tone: 'ink' });
  });

  const desc =
    `One stacked bar of ${WORKERS.frameMsTotal.toFixed(1)} milliseconds, where a frame's time goes with one worker: ` +
    WORKERS.frameMs.map((s) => `${s.label.toLowerCase()} ${s.ms.toFixed(1)} milliseconds`).join(', ') +
    '.';
  return done(W, TOPY + BAR + 40 + 4 * 30, "Where a frame's time goes", desc, fills, ink, acc);
}

/** For the check script: every chart by name. */
export const charts = { bars: barsChart, spread: spreadChart, workers: workersChart, lanes: lanesChart, frame: frameChart };
