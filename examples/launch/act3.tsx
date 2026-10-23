// Act 3, shots 10 to 12: no chrome, the logo-flicker, the end card.

import React from 'react';
import { AbsoluteFill, Easing, interpolate, random, staticFile, useCurrentFrame } from 'remotion';
import { measureText } from '@remotion/layout-utils';
import { FADE_END, LogoFlicker } from '@/components/snap-cn/logo-flicker';
import { Layer, glow, grain } from '@kinetographdev/core';
import { CLAMP, H, LEN, MONO, OUT, RED, RENDER_SECONDS, SANS, TITLE_GLOW, W } from './common.js';
import { pixels } from './looks.js';
import { spoken, spokenIn } from './sound-timing.js';

export { RENDER_SECONDS };


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

// ---- shot 10: "No Chromium. No screenshots. Just pixels." The words land in projected light, a pen strikes out the
//      first two phrases and rings the last in red; then the camera pushes into "pixels." until the screen's own
//      pixels show, each a block, then three stripes of red, green and blue ----
const S10_WORDS = spoken('10-pixels');
if (S10_WORDS.length !== 6) throw new Error(`10-pixels has ${S10_WORDS.length} words, the shot is laid out for 6`);
/** Frames each word lands (the voiceover's own word starts). */
export const S10_LAND = S10_WORDS.map((w) => w.from);
/** The two strike-outs and the red loop, each just after its phrase is spoken. */
export const S10_STRIKE = [[S10_WORDS[1]!.to + 1, S10_WORDS[1]!.to + 12], [S10_WORDS[3]!.to + 1, S10_WORDS[3]!.to + 12]] as const;
/** The loop draws as "pixels" is said, closing before the push (the take runs straight on into the end card). */
export const S10_CIRCLE = [S10_WORDS[5]!.from, Math.min(S10_WORDS[5]!.to + 6, LEN.s10 - 4)] as const;
/** The push into the pixels: from the loop's close to the end of the shot. */
export const S10_ZOOM = [Math.min(S10_CIRCLE[1] - 2, LEN.s10 - 6), LEN.s10] as const;
const S10_SIZE = 76;
const S10_TOP = 470;
const CREAM = '#f3efe8';

export const S10: React.FC = () => {
  const frame = useCurrentFrame();
  const text = S10_WORDS.map((w) => w.w.toLowerCase());
  const m = text.map((t) => measureText({ text: t, fontFamily: SANS, fontSize: S10_SIZE, fontWeight: '500', letterSpacing: `${-0.01 * S10_SIZE}px` }).width);
  const gap = S10_SIZE * 0.26;
  const total = m.reduce((a, b) => a + b, 0) + gap * (m.length - 1);
  const xs: number[] = [];
  let x = (W - total) / 2;
  for (const w of m) { xs.push(x); x += w + gap; }
  const runs: [number, number][] = [[0, 1], [2, 3], [4, 5]].map(([a, b]) => [xs[a!]!, xs[b!]! + m[b!]!]);
  const yc = S10_TOP + S10_SIZE * 0.53; // the middle of the lowercase letters
  const pen = Easing.bezier(0.45, 0, 0.35, 1);
  const strike = S10_STRIKE.map((r) => interpolate(frame, [...r], [0, 1], { ...CLAMP, easing: pen }));
  const circle = interpolate(frame, [...S10_CIRCLE], [0, 1], { ...CLAMP, easing: Easing.bezier(0.3, 0, 0.2, 1) });
  // the push: slow, then faster, as a lens racks in (an exponential in the zoom)
  const z = interpolate(frame, [...S10_ZOOM], [0, 1], { ...CLAMP, easing: Easing.in(Easing.cubic) });
  const zoom = Math.pow(70, z);
  const focus = { cx: xs[5]! + m[5]! * 0.3, cy: yc };
  return (
    <AbsoluteFill style={{ background: '#050505' }}>
      <Layer id="s10-grain" effects={[grain(0.06, { seed: 12, animate: true })]}>
      <Layer id="s10-screen" effects={[pixels({ zoom, ...focus }), glow({ radius: 18, intensity: 0.35 })]}>
        <AbsoluteFill style={{ background: 'radial-gradient(ellipse 60% 55% at 50% 48%, #141312 0%, #070707 60%, #030303 100%)' }} />
        {text.map((w, i) => {
          const t = interpolate(frame, [S10_LAND[i]!, S10_LAND[i]! + 5], [0, 1], { ...CLAMP, easing: OUT });
          const phrase = Math.floor(i / 2);
          const dim = phrase < 2 ? interpolate(strike[phrase]!, [0.3, 1], [1, 0.38], CLAMP) : 1;
          return (
            <span key={i} style={{ position: 'absolute', left: xs[i], top: S10_TOP, fontFamily: SANS, fontWeight: 500, fontSize: S10_SIZE, lineHeight: 1.2, letterSpacing: '-0.01em', color: CREAM, whiteSpace: 'pre', textShadow: TITLE_GLOW, opacity: t * dim, filter: `blur(${(1 - t) * 6}px)` }}>{w}</span>
          );
        })}
        <svg width={W} height={H} style={{ position: 'absolute', left: 0, top: 0 }}>
          <Pen pts={scrawl(runs[0]![0], runs[0]![1], yc, S10_SIZE * 0.31, 'k1')} progress={strike[0]!} width={6} color={CREAM} seed="k1" />
          <Pen pts={scrawl(runs[1]![0], runs[1]![1], yc, S10_SIZE * 0.31, 'k2')} progress={strike[1]!} width={6} color={CREAM} seed="k2" />
          <Pen pts={loop((runs[2]![0] + runs[2]![1]) / 2, yc, (runs[2]![1] - runs[2]![0]) / 2 + 56, S10_SIZE * 0.78, 'k3')} progress={circle} width={8} color={RED} seed="k3" />
        </svg>
      </Layer>
      </Layer>
    </AbsoluteFill>
  );
};

// ---- shot 11: snapcn's logo-flicker over stills of this film and its 1927 footage, each through one of the film's
//      looks (public/self/v2-*, rendered from self-stills.tsx), then the name ----
const SELF = [
  'v2-veteran-iron', 'v2-s03', 'v2-hat-1bit', 'v2-m3', 'v2-s05-pass', 'v2-beard-iron', 'v2-crowd-vhs', 'v2-m4', 'v2-s05',
  'v2-veteran-rainbow', 'v2-m5', 'v2-veteran-crt', 'v2-s08', 'v2-hat-crt', 'v2-s10', 'v2-s09', 'v2-crowd-1bit', 'v2-pair-vhs',
].map((n) => staticFile(`self/${n}.jpg`));

/** The flicker's pace: its reveal lands as the narrator says "Kinetograph.", the first word of 12-end. */
export const S11_SPEED = Math.min(3, Math.max(0.75, FADE_END / (spokenIn('12-end', 's11')[0]!.from + 2)));

/** The logo: the name with its red full stop, set where the end card sets it, so the flicker resolves into the end
 *  card and the cut to shot 12 doesn't move it. */
const Wordmark: React.FC = () => (
  <div style={{ position: 'absolute', left: 0, right: 0, top: 300, textAlign: 'center', fontFamily: SANS, color: '#f3efe8' }}>
    <div style={{ fontWeight: 700, fontSize: 210, letterSpacing: '-0.05em', lineHeight: 1, textShadow: TITLE_GLOW }}>
      kinetograph<span style={{ color: RED }}>.</span>
    </div>
  </div>
);

export const S11: React.FC = () => (
  <LogoFlicker speed={S11_SPEED} images={SELF} reveal={<Wordmark />} mode="dark" fontFamily={SANS} background="#060606" />
);

// ---- shot 12: end card ----
// "Kinetograph. Motion pictures, written in code. Try it at kinetograph.dev." The tagline's words land on the
// voiceover's (words 2 to 6 of 12-end), the address on its own.
const S12_SAID = spokenIn('12-end', 's12');
export const S12_TAG = S12_SAID.slice(1, 6).map((w) => w.from);
/** The URL lands as it is spoken, just after "at" (the ASR leaves "kinetograph dot dev" out of its words). */
export const S12_URL = S12_SAID[S12_SAID.length - 1]!.to + 2;
const S12_WORDS = ['motion', 'pictures,', 'written', 'in', 'code.'];

export const S12: React.FC<{ renderSeconds?: number | null }> = ({ renderSeconds = RENDER_SECONDS }) => {
  const frame = useCurrentFrame();
  // the wordmark has already resolved out of shot 11's flicker; the light comes up under it
  const land = 1;
  const dot = 1;
  const light = interpolate(frame, [0, 12], [0, 1], { ...CLAMP, easing: OUT });
  const fade = (a: number, b: number) => interpolate(frame, [a, b], [0, 1], CLAMP);
  const words = S12_WORDS;
  const urlT = interpolate(frame, [S12_URL, S12_URL + 8], [0, 1], { ...CLAMP, easing: OUT });
  return (
    <AbsoluteFill style={{ background: '#060606' }}>
      {/* the projector's light on the screen: a warm pool, falling off to the dark */}
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse 62% 58% at 50% 46%, rgba(255,236,205,0.11) 0%, rgba(255,226,190,0.04) 45%, rgba(0,0,0,0) 75%)', opacity: light }} />
      <div style={{ position: 'absolute', left: 0, right: 0, top: 300, textAlign: 'center', fontFamily: SANS, color: '#f3efe8' }}>
        <div style={{ fontWeight: 700, fontSize: 210, letterSpacing: '-0.05em', lineHeight: 1, textShadow: TITLE_GLOW, opacity: land, transform: `scale(${1.05 - 0.05 * land})`, filter: `blur(${(1 - land) * 10}px)` }}>
          kinetograph<span style={{ color: RED, display: 'inline-block', transform: `scale(${dot})`, transformOrigin: '50% 85%' }}>.</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 28, fontSize: 30, fontWeight: 500, marginTop: 44, letterSpacing: '0.32em', textTransform: 'uppercase', color: '#c9c2b6' }}>
          {words.map((w, i) => {
            const t = fade(S12_TAG[i]!, S12_TAG[i]! + 4);
            return <span key={i} style={{ opacity: t, filter: `blur(${(1 - t) * 6}px)` }}>{w}</span>;
          })}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 34, marginTop: 110, color: '#f3efe8', opacity: urlT, transform: `translateY(${(1 - urlT) * 14}px)` }}>kinetograph.dev</div>
        <div style={{ fontFamily: MONO, fontSize: 20, marginTop: 120, color: '#6f6a62', opacity: fade(S12_URL + 16, S12_URL + 24) }}>
          this video was rendered by kinetograph in {renderSeconds ?? 'N'} s
        </div>
      </div>
    </AbsoluteFill>
  );
};
