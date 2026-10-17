// Act 3, shots 10 to 12: no chrome, the logo-flicker, the end card.

import React from 'react';
import { AbsoluteFill, Easing, interpolate, random, staticFile, useCurrentFrame } from 'remotion';
import { measureText } from '@remotion/layout-utils';
import { LogoFlicker } from '@/components/snap-cn/logo-flicker';
import { CLAMP, H, INK, MONO, OUT, PaperGround, RED, SANS, W } from './common.js';

/** Seconds this video took to render, filled in by the final render (until then the end card prints "N"). */
export const RENDER_SECONDS: number | null = null;

// ---- hand-drawn strokes ----
type Pt = [number, number];

/** Rounds each corner of a polyline by about 16 px, which is how a quick pen turns at the end of a stroke. */
const round = (pts: Pt[]): Pt[] => {
  const out: Pt[] = [pts[0]!];
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i]!, pts[i + 1]!];
    const k = Math.min(0.3, 16 / Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1])));
    out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k], [b[0] - (b[0] - a[0]) * k, b[1] - (b[1] - a[1]) * k]);
  }
  out.push(pts[pts.length - 1]!);
  return out;
};

/** Samples a polyline evenly (`n` points), with a wobble of `jitter` px across the line and a slow drift on top. */
function sample(pts: Pt[], n: number, jitter: number, seed: string): Pt[] {
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
  const total = lens[lens.length - 1]!;
  const out: Pt[] = [];
  let seg = 1;
  for (let k = 0; k < n; k++) {
    const d = (k / (n - 1)) * total;
    while (seg < pts.length - 1 && lens[seg]! < d) seg++;
    const u = (d - lens[seg - 1]!) / Math.max(1e-6, lens[seg]! - lens[seg - 1]!);
    const [a, b] = [pts[seg - 1]!, pts[seg]!];
    const wob = (random(`${seed}-w${k}`) - 0.5) * jitter + Math.sin(k * 0.21 + random(seed) * 6) * jitter * 0.6;
    out.push([a[0] + (b[0] - a[0]) * u + wob * 0.5, a[1] + (b[1] - a[1]) * u + wob]);
  }
  return out;
}

/** A pen stroke drawn on to `progress` (0 to 1): short round-capped segments whose width follows a pressure curve. */
const Pen: React.FC<{ pts: Pt[]; progress: number; width: number; color: string; seed: string }> = ({ pts, progress, width, color, seed }) => {
  const n = pts.length - 1;
  const upto = progress * n;
  const segs: React.ReactNode[] = [];
  for (let i = 0; i < n && i < upto; i++) {
    const t = i / n;
    const pressure = 0.5 + 0.5 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.92 + 0.04)), 0.55);
    const w = width * pressure * (0.88 + 0.24 * random(`${seed}-p${i}`));
    const end = Math.min(1, upto - i);
    const [a, b] = [pts[i]!, pts[i + 1]!];
    segs.push(<line key={i} x1={a[0]} y1={a[1]} x2={a[0] + (b[0] - a[0]) * end} y2={a[1] + (b[1] - a[1]) * end} stroke={color} strokeWidth={w} strokeLinecap="round" />);
  }
  return <g>{segs}</g>;
};

/** A scrawl across a word run: a snake of passes, each a little off the last, that sweeps right then left then right. */
function scrawl(x0: number, x1: number, yc: number, amp: number, seed: string): Pt[] {
  const r = (k: number) => (random(`${seed}-s${k}`) - 0.5) * amp * 0.18;
  const passes = 6;
  const way: Pt[] = [];
  for (let k = 0; k <= passes; k++) {
    const y = yc - amp + (2 * amp * k) / passes + r(k);
    const left = x0 - 8 + random(`${seed}-l${k}`) * 22;
    const right = x1 + 6 - random(`${seed}-r${k}`) * 22;
    way.push(k % 2 === 0 ? [left, y + amp * 0.12] : [right, y - amp * 0.12]);
  }
  way.push([x1 + 12, yc - amp * 0.25]);
  return sample(round(way), 150, 3, seed);
}

/** A loose loop around a box: starts bottom left, goes round once and overlaps its start, a little off round. */
function loop(cx: number, cy: number, rx: number, ry: number, seed: string): Pt[] {
  const pts: Pt[] = [];
  const N = 110;
  for (let k = 0; k < N; k++) {
    const u = k / (N - 1);
    const a = Math.PI * 0.62 + u * Math.PI * 2.16;
    const drift = 1 + 0.07 * Math.sin(u * 5.1 + 1) + (u - 0.5) * 0.08 + (random(`${seed}-r${k}`) - 0.5) * 0.012;
    const x = Math.cos(a) * rx * drift;
    const y = Math.sin(a) * ry * drift + u * 7;
    const rot = -0.05;
    pts.push([cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]);
  }
  return pts;
}

// ---- shot 10: no chrome, no screenshots, just pixels ----
const S10_WORDS = ['no', 'chrome.', 'no', 'screenshots.', 'just', 'pixels.'];
// Frames each word lands, matched to the voiceover (sound.tsx places it at VO_AT.s10, in the voice's own pauses).
export const S10_LAND = [1, 5, 17, 20, 37, 41];
/** The two strike-outs and the red loop, each just after its phrase is spoken. */
export const S10_STRIKE = [[10, 21], [27, 38]] as const;
export const S10_CIRCLE = [44, 59] as const;
const S10_SIZE = 76;
const S10_TOP = 470;

export const S10: React.FC = () => {
  const frame = useCurrentFrame();
  const m = S10_WORDS.map((text) => measureText({ text, fontFamily: SANS, fontSize: S10_SIZE, fontWeight: '500', letterSpacing: `${-0.01 * S10_SIZE}px` }).width);
  const gap = S10_SIZE * 0.26;
  const total = m.reduce((a, b) => a + b, 0) + gap * (m.length - 1);
  const xs: number[] = [];
  let x = (W - total) / 2;
  for (const w of m) { xs.push(x); x += w + gap; }
  const runs: [number, number][] = [[0, 1], [2, 3], [4, 5]].map(([a, b]) => [xs[a!]!, xs[b!]! + m[b!]!]);
  const yc = S10_TOP + S10_SIZE * 0.53; // the middle of the lowercase letters
  const pen = Easing.bezier(0.45, 0, 0.35, 1);
  const strike = [
    interpolate(frame, [...S10_STRIKE[0]], [0, 1], { ...CLAMP, easing: pen }),
    interpolate(frame, [...S10_STRIKE[1]], [0, 1], { ...CLAMP, easing: pen }),
  ];
  const circle = interpolate(frame, [...S10_CIRCLE], [0, 1], { ...CLAMP, easing: Easing.bezier(0.3, 0, 0.2, 1) });
  return (
    <AbsoluteFill>
      <PaperGround />
      {S10_WORDS.map((w, i) => {
        const t = interpolate(frame, [S10_LAND[i]!, S10_LAND[i]! + 4], [0, 1], CLAMP);
        const phrase = Math.floor(i / 2);
        const dim = phrase < 2 ? interpolate(strike[phrase]!, [0.3, 1], [1, 0.45], CLAMP) : 1;
        return (
          <span key={i} style={{ position: 'absolute', left: xs[i], top: S10_TOP, fontFamily: SANS, fontWeight: 500, fontSize: S10_SIZE, lineHeight: 1, letterSpacing: '-0.01em', color: INK, whiteSpace: 'pre', opacity: t * dim, filter: `blur(${(1 - t) * 6}px)` }}>{w}</span>
        );
      })}
      <svg width={W} height={H} style={{ position: 'absolute', left: 0, top: 0 }}>
        <Pen pts={scrawl(runs[0]![0], runs[0]![1], yc, S10_SIZE * 0.31, 'k1')} progress={strike[0]!} width={6.5} color={INK} seed="k1" />
        <Pen pts={scrawl(runs[1]![0], runs[1]![1], yc, S10_SIZE * 0.31, 'k2')} progress={strike[1]!} width={6.5} color={INK} seed="k2" />
        <Pen pts={loop((runs[2]![0] + runs[2]![1]) / 2, yc, (runs[2]![1] - runs[2]![0]) / 2 + 56, S10_SIZE * 0.78, 'k3')} progress={circle} width={8} color={RED} seed="k3" />
      </svg>
    </AbsoluteFill>
  );
};

// ---- shot 11: snapcn's logo-flicker over stills of this film itself (public/self, rendered from frames.tsx), then the name ----
const SELF = ['s01-2', 's01-8', 's01-14', 's02-66', 's03-60', 's04-22', 's05-30', 's05-70', 's08-40', 's08-200', 's09-60', 's09-150', 's10-70']
  .map((n) => staticFile(`self/${n}.jpg`));

export const S11: React.FC = () => (
  <LogoFlicker images={SELF} brandName="kinetograph" logoSrc={staticFile('brand/kinetograph-mark.png')} mode="dark" fontFamily={SANS} background={INK} />
);

// ---- shot 12: end card ----
// Frames the tagline words land, matched to the voiceover (sound.tsx places it at VO_AT.s12).
export const S12_TAG = [23, 32, 48, 55];
export const S12_URL = 80;

export const S12: React.FC<{ renderSeconds?: number | null }> = ({ renderSeconds = RENDER_SECONDS }) => {
  const frame = useCurrentFrame();
  const land = interpolate(frame, [6, 14], [0, 1], { ...CLAMP, easing: OUT });
  const dot = interpolate(frame, [12, 22], [0, 1], { ...CLAMP, easing: Easing.out(Easing.back(2.2)) });
  const fade = (a: number, b: number) => interpolate(frame, [a, b], [0, 1], CLAMP);
  const words = ['write', 'remotion.', 'render', 'native.'];
  const urlT = interpolate(frame, [S12_URL, S12_URL + 8], [0, 1], { ...CLAMP, easing: OUT });
  return (
    <AbsoluteFill>
      <PaperGround />
      <div style={{ position: 'absolute', left: 0, right: 0, top: 300, textAlign: 'center', fontFamily: SANS, color: INK }}>
        <div style={{ fontWeight: 700, fontSize: 210, letterSpacing: '-0.05em', lineHeight: 1, opacity: land, transform: `scale(${1.05 - 0.05 * land})`, filter: `blur(${(1 - land) * 10}px)` }}>
          kinetograph<span style={{ color: RED, display: 'inline-block', transform: `scale(${dot})`, transformOrigin: '50% 85%' }}>.</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 50 * 0.26, fontSize: 50, fontWeight: 500, marginTop: 34, letterSpacing: '-0.01em' }}>
          {words.map((w, i) => {
            const t = fade(S12_TAG[i]!, S12_TAG[i]! + 4);
            return <span key={i} style={{ opacity: t, filter: `blur(${(1 - t) * 6}px)` }}>{w}</span>;
          })}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 36, marginTop: 110, opacity: urlT, transform: `translateY(${(1 - urlT) * 14}px)` }}>kinetograph.dev</div>
        <div style={{ fontFamily: MONO, fontSize: 22, marginTop: 120, color: '#7a7670', opacity: fade(S12_URL + 16, S12_URL + 24) }}>
          this video was rendered by kinetograph in {renderSeconds ?? 'N'} s
        </div>
      </div>
    </AbsoluteFill>
  );
};
