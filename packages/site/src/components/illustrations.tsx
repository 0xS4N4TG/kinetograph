import { useEffect, useRef } from 'react';

/**
 * Toile-style line illustrations drawn on <canvas>: the first Kinetograph (Edison and Dickson's 1891 motion-picture
 * camera), with a hand-cranked reel, running film and swaying foliage. All procedural, no assets.
 */

const CREAM = '#f7f4ec';
const COBALT = '#2238c4';

/** Small deterministic PRNG so the foliage is identical on every load. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Stem {
  x: number; // base, 0..1 of width
  y: number; // base, 0..1 of height
  angle: number; // radians, 0 is straight up
  bend: number; // curvature per unit length
  length: number; // 0..1 of height
  phase: number;
  leaves: { at: number; side: 1 | -1; size: number; tilt: number }[];
}

function makeStems(side: 1 | -1, seed: number): Stem[] {
  const r = rng(seed);
  const stems: Stem[] = [];
  const count = 15;
  for (let i = 0; i < count; i++) {
    const leaves: Stem['leaves'] = [];
    const n = 9 + Math.floor(r() * 7);
    for (let k = 0; k < n; k++) {
      leaves.push({ at: 0.14 + (k / n) * 0.86, side: k % 2 ? 1 : -1, size: 0.6 + r() * 0.7, tilt: 0.7 + r() * 0.5 });
    }
    stems.push({
      x: side === 1 ? r() * 0.2 : 1 - r() * 0.2,
      y: 0.78 + r() * 0.3,
      angle: side * (0.08 + r() * 0.55) * -1,
      bend: side * (0.1 + r() * 0.5) * -1 * (r() > 0.5 ? 1 : 0.4),
      length: 0.28 + r() * 0.5,
      phase: r() * Math.PI * 2,
      leaves,
    });
  }
  return stems;
}

/** Draw one pointed leaf (two arcs) with a midrib and a few veins, outlined in cream. */
function leaf(ctx: CanvasRenderingContext2D, x: number, y: number, dir: number, len: number) {
  const w = len * 0.34;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(dir);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(len * 0.5, -w, len, 0);
  ctx.quadraticCurveTo(len * 0.5, w, 0, 0);
  ctx.closePath();
  ctx.fillStyle = COBALT;
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(len * 0.92, 0);
  for (let k = 1; k <= 3; k++) {
    const px = len * (0.18 + k * 0.2);
    ctx.moveTo(px, 0);
    ctx.lineTo(px + len * 0.12, -w * 0.55);
    ctx.moveTo(px, 0);
    ctx.lineTo(px + len * 0.12, w * 0.55);
  }
  ctx.stroke();
  ctx.restore();
}

function drawFoliage(ctx: CanvasRenderingContext2D, stems: Stem[], w: number, h: number, t: number, unit: number) {
  ctx.strokeStyle = CREAM;
  ctx.lineWidth = Math.max(1, unit * 1.1);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of stems) {
    const steps = 22;
    const total = s.length * h;
    const pts: { x: number; y: number; a: number }[] = [];
    let x = s.x * w;
    let y = s.y * h;
    let a = s.angle;
    for (let i = 0; i <= steps; i++) {
      pts.push({ x, y, a });
      const sway = Math.sin(t * 0.9 + s.phase + i * 0.16) * 0.012 * (i / steps) * 2.4;
      a += s.bend / steps + sway;
      x += Math.sin(a) * (total / steps);
      y -= Math.cos(a) * (total / steps);
    }
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    for (const l of s.leaves) {
      const p = pts[Math.min(steps, Math.round(l.at * steps))]!;
      const len = unit * 20 * l.size;
      leaf(ctx, p.x, p.y, p.a - Math.PI / 2 + l.side * l.tilt, len);
    }
  }
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.quadraticCurveTo(x, y, x, y + r);
  ctx.quadraticCurveTo(x, y, x - r, y);
  ctx.quadraticCurveTo(x, y, x, y - r);
  ctx.fillStyle = CREAM;
  ctx.fill();
}

function moon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = CREAM;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + r * 0.42, y - r * 0.12, r * 0.86, 0, Math.PI * 2);
  ctx.fillStyle = COBALT;
  ctx.fill();
}

function reel(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, spin: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = COBALT;
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.72, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 6; i++) {
    const a = spin + (i * Math.PI) / 3;
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * r * 0.42, y + Math.sin(a) * r * 0.42, r * 0.17, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x, y, r * 0.12, 0, Math.PI * 2);
  ctx.fillStyle = CREAM;
  ctx.fill();
}

/** The camera, in a local coordinate system 100 wide, origin at the centre of the body. */
function drawCamera(ctx: CanvasRenderingContext2D, cx: number, cy: number, k: number, t: number) {
  const spin = t * 3.2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(k, k);
  ctx.lineWidth = 1.1;
  ctx.strokeStyle = CREAM;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // light beam from the lens: flicker like a projector lamp
  const flick = 0.1 + 0.05 * Math.sin(t * 24) + 0.03 * Math.sin(t * 9);
  const beam = ctx.createLinearGradient(54, 0, 400, 0);
  beam.addColorStop(0, `rgba(247,244,236,${flick * 2.4})`);
  beam.addColorStop(1, 'rgba(247,244,236,0)');
  ctx.beginPath();
  ctx.moveTo(54, -5);
  ctx.lineTo(400, -90);
  ctx.lineTo(400, 90);
  ctx.lineTo(54, 5);
  ctx.closePath();
  ctx.fillStyle = beam;
  ctx.fill();

  // tripod
  ctx.fillStyle = COBALT;
  const legs: [number, number, number, number][] = [
    [-22, 22, -44, 82],
    [22, 22, 44, 82],
    [0, 22, 4, 88],
  ];
  for (const [x1, y1, x2, y2] of legs) {
    ctx.beginPath();
    ctx.moveTo(x1 - 2.5, y1);
    ctx.lineTo(x1 + 2.5, y1);
    ctx.lineTo(x2 + 1.6, y2);
    ctx.lineTo(x2 - 1.6, y2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(-34, 22);
  ctx.lineTo(34, 22);
  ctx.lineTo(28, 30);
  ctx.lineTo(-28, 30);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // film running between the magazines (top)
  const top = -50;
  const pull = ((t * 26) % 6) / 6;
  ctx.beginPath();
  ctx.moveTo(-14, top + 10);
  ctx.bezierCurveTo(-14, -26, 12, -26, 12, top + 10);
  ctx.setLineDash([2.2, 2.2]);
  ctx.lineDashOffset = -pull * 4.4;
  ctx.lineWidth = 3.4;
  ctx.strokeStyle = CREAM;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = 1.1;

  // camera body
  ctx.fillStyle = COBALT;
  ctx.beginPath();
  ctx.roundRect(-38, -20, 76, 42, 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(-34, -16, 68, 34, 1);
  ctx.stroke();
  // wood-grain hatching, clipped to the body
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(-34, -16, 68, 34, 1);
  ctx.clip();
  ctx.lineWidth = 0.5;
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  for (let x = -70; x < 70; x += 3.2) {
    ctx.moveTo(x, 20);
    ctx.lineTo(x + 30, -18);
  }
  ctx.stroke();
  ctx.restore();
  // body plate with the maker's mark
  ctx.beginPath();
  ctx.roundRect(-16, -6, 32, 14, 1);
  ctx.fillStyle = COBALT;
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = CREAM;
  ctx.font = 'italic 6px "Iowan Old Style", Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText('KINETOGRAPH', 0, 3);

  // magazines on top
  ctx.fillStyle = COBALT;
  for (const mx of [-26, 0]) {
    ctx.beginPath();
    ctx.roundRect(mx - 3, -52, 32, 32, 3);
    ctx.fill();
    ctx.stroke();
  }
  reel(ctx, -14, -38, 12.5, spin);
  reel(ctx, 14, -38, 12.5, -spin);

  // lens barrel
  ctx.fillStyle = COBALT;
  ctx.beginPath();
  ctx.roundRect(38, -9, 12, 18, 1);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(50, -7);
  ctx.lineTo(60, -11);
  ctx.lineTo(60, 11);
  ctx.lineTo(50, 7);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(44, -9);
  ctx.lineTo(44, 9);
  ctx.moveTo(55, -9);
  ctx.lineTo(55, 9);
  ctx.stroke();

  // hand crank on the near side
  const ca = spin * 0.55;
  ctx.beginPath();
  ctx.arc(-38, 2, 6, 0, Math.PI * 2);
  ctx.fillStyle = COBALT;
  ctx.fill();
  ctx.stroke();
  const kx = -38 + Math.cos(ca) * 14;
  const ky = 2 + Math.sin(ca) * 14;
  ctx.beginPath();
  ctx.moveTo(-38, 2);
  ctx.lineTo(kx, ky);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.arc(kx, ky, 3.4, 0, Math.PI * 2);
  ctx.fillStyle = CREAM;
  ctx.fill();

  ctx.restore();
}

/** A strip of film with sprocket holes scrolling across the bottom, one tiny scene per frame. */
function drawFilmStrip(ctx: CanvasRenderingContext2D, w: number, y: number, fh: number, t: number) {
  const fw = fh * 1.28;
  const off = (t * fh * 1.1) % fw;
  ctx.save();
  ctx.lineWidth = 1.1;
  ctx.strokeStyle = CREAM;
  ctx.fillStyle = COBALT;
  ctx.beginPath();
  ctx.rect(-4, y, w + 8, fh);
  ctx.fill();
  ctx.stroke();
  const hole = fh * 0.09;
  for (let x = -fw - off + fw; x < w + fw; x += fw / 2) {
    for (const hy of [y + fh * 0.07, y + fh * 0.93 - hole]) {
      ctx.beginPath();
      ctx.roundRect(x, hy, hole * 1.4, hole, 1);
      ctx.stroke();
    }
  }
  let index = Math.floor((t * fh * 1.1) / fw);
  for (let x = -off; x < w + fw; x += fw) {
    const seed = (((index++ % 8) + 8) % 8) + 1;
    const fx = x + fw * 0.08;
    const fy = y + fh * 0.2;
    const iw = fw * 0.84;
    const ih = fh * 0.6;
    ctx.beginPath();
    ctx.rect(fx, fy, iw, ih);
    ctx.stroke();
    // each frame: the same little sun/hill scene, the sun a step further along (that's what motion is)
    const prog = (seed - 1) / 7;
    ctx.beginPath();
    ctx.arc(fx + iw * (0.15 + prog * 0.7), fy + ih * (0.62 - Math.sin(prog * Math.PI) * 0.42), ih * 0.13, 0, Math.PI * 2);
    ctx.fillStyle = CREAM;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(fx, fy + ih);
    ctx.quadraticCurveTo(fx + iw * 0.3, fy + ih * 0.5, fx + iw * 0.55, fy + ih * 0.75);
    ctx.quadraticCurveTo(fx + iw * 0.8, fy + ih * 0.55, fx + iw, fy + ih * 0.8);
    ctx.lineTo(fx + iw, fy + ih);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = COBALT;
  }
  ctx.restore();
}

function useCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => void) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let w = 0;
    let h = 0;
    let raf = 0;
    let visible = true;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (reduced) drawRef.current(ctx, w, h, 1.2);
    };
    const frame = (ms: number) => {
      if (visible && w > 0) drawRef.current(ctx, w, h, ms / 1000);
      raf = requestAnimationFrame(frame);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const io = new IntersectionObserver(([entry]) => (visible = entry?.isIntersecting ?? true));
    io.observe(canvas);
    if (!reduced) raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
    };
  }, []);

  return ref;
}

const leftStems = makeStems(1, 11);
const rightStems = makeStems(-1, 29);
const sparkles = Array.from({ length: 26 }, (_, i) => {
  const r = rng(100 + i);
  return { x: r(), y: r() * 0.7, s: 0.5 + r() * 1.4, p: r() * 6 };
});

/** The hero illustration: a cobalt panel, framed foliage, moons, the camera and a strip of film. */
export function KinetographHero({ className }: { className?: string }) {
  const ref = useCanvas((ctx, w, h, t) => {
    const unit = Math.max(0.55, Math.min(w / 1300, h / 760));
    ctx.fillStyle = COBALT;
    ctx.fillRect(0, 0, w, h);

    // hatching sky
    ctx.save();
    ctx.strokeStyle = 'rgba(247,244,236,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = -h; x < w; x += 9 * unit + 2) {
      ctx.moveTo(x, h);
      ctx.lineTo(x + h * 0.6, 0);
    }
    ctx.stroke();
    ctx.restore();

    for (const s of sparkles) star(ctx, s.x * w, s.y * h, s.s * unit * 3.4 * (0.6 + 0.4 * Math.sin(t * 1.6 + s.p)));
    moon(ctx, w * 0.1, h * 0.14, 20 * unit + 6);
    moon(ctx, w * 0.9, h * 0.14, 20 * unit + 6);

    drawFoliage(ctx, leftStems, w, h, t, unit);
    drawFoliage(ctx, rightStems, w, h, t, unit);

    // glow behind the camera
    const gx = w * 0.5;
    const gy = h * 0.74;
    const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, h * 0.4);
    glow.addColorStop(0, 'rgba(247,244,236,0.16)');
    glow.addColorStop(1, 'rgba(247,244,236,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    const stripH = Math.max(34, h * 0.075);
    drawCamera(ctx, w * 0.5 - 10 * unit, h * 0.7 - stripH * 0.1, Math.min(h * 0.0036, w * 0.0033), t);
    drawFilmStrip(ctx, w, h - stripH - 14 * unit, stripH, t);
  });
  return <canvas ref={ref} className={className} aria-hidden />;
}

/** A calmer, paper-coloured strip of rolling hills with trees, for the end of the page. */
export function KinetographLandscape({ className }: { className?: string }) {
  const trees = useRef(Array.from({ length: 9 }, (_, i) => ({ x: (i + 0.5) / 9 + (rng(40 + i)() - 0.5) * 0.05, s: 0.7 + rng(60 + i)() * 0.8 }))).current;
  const ref = useCanvas((ctx, w, h, t) => {
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = COBALT;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const hill = (base: number, amp: number, freq: number, phase: number, fill: string) => {
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 6) ctx.lineTo(x, base + Math.sin(x * freq + phase) * amp);
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.stroke();
    };
    hill(h * 0.5, h * 0.09, 0.006, 1, '#e9e8ef');
    hill(h * 0.64, h * 0.08, 0.008, 3, CREAM);
    for (const tr of trees) {
      const x = tr.x * w;
      const y = h * 0.6 + Math.sin(x * 0.008 + 3) * h * 0.08;
      const k = tr.s * Math.min(1, w / 1000) * (h / 200);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - 14 * k);
      ctx.stroke();
      ctx.fillStyle = COBALT;
      for (let i = 0; i < 4; i++) {
        const a = Math.sin(t + tr.x * 9 + i) * 0.6;
        ctx.beginPath();
        ctx.arc(x + a + (i - 1.5) * 4 * k, y - (20 + (i % 2) * 5) * k, 7 * k, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // the film road
    ctx.fillStyle = COBALT;
    ctx.fillRect(0, h * 0.82, w, h * 0.18);
    ctx.fillStyle = CREAM;
    const fw = Math.max(26, h * 0.1);
    const off = (t * 30) % (fw * 2);
    for (let x = -off; x < w; x += fw * 2) {
      ctx.fillRect(x, h * 0.9, fw, 2);
      ctx.beginPath();
      ctx.roundRect(x + fw * 0.4, h * 0.84, 7, 5, 1);
      ctx.fill();
    }
  });
  return <canvas ref={ref} className={className} aria-hidden />;
}
