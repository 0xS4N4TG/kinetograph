// Shot 7's captions, in the Geronimo Stilton way (the look of jellysynth.com's projected captions): the voiceover
// writes itself on letter by letter in a mix of handwritten faces, a face per letter, so it reads as one restless
// hand; the key words break out in a big display face, with a small doodle drawn beside them. The words glow warm, like
// projected light, and each letter lands with a pink and cyan fringe.
//
// The text hangs off a tracked subject in the footage (`anchor`, from tools/track/track.mjs): a reticle sits on the
// subject, thin lines run from it to the text and off the frame, and a bracket rides the letter being written with
// the subject's coordinates beside it. Timed from the narrator's own word timestamps
// (tools/narration/voice/asr_narrator_final.json).

import React from 'react';
import { AbsoluteFill, interpolate, random, useCurrentFrame, useVideoConfig } from 'remotion';
import { loadFont as loadCaveat } from '@remotion/google-fonts/Caveat';
import { loadFont as loadShadows } from '@remotion/google-fonts/ShadowsIntoLight';
import { loadFont as loadIndie } from '@remotion/google-fonts/IndieFlower';
import { loadFont as loadGloria } from '@remotion/google-fonts/GloriaHallelujah';
import { loadFont as loadPatrick } from '@remotion/google-fonts/PatrickHand';
import { loadFont as loadGochi } from '@remotion/google-fonts/GochiHand';
import { loadFont as loadAbril } from '@remotion/google-fonts/AbrilFatface';
import { loadFont as loadArchivo } from '@remotion/google-fonts/ArchivoBlack';
import { CLAMP, MONO } from '../common.js';
import asr from '../tools/narration/voice/asr_narrator_final.json';

/** The hands, mixed a letter at a time. `k` evens out how big each reads at one size. */
const HANDS = [
  { family: loadCaveat('normal', { weights: ['700'] }).fontFamily, weight: 700, k: 1.18 },
  { family: loadShadows('normal', { weights: ['400'] }).fontFamily, weight: 400, k: 1.02 },
  { family: loadIndie('normal', { weights: ['400'] }).fontFamily, weight: 400, k: 0.98 },
  { family: loadGloria('normal', { weights: ['400'] }).fontFamily, weight: 400, k: 0.86 },
  { family: loadPatrick('normal', { weights: ['400'] }).fontFamily, weight: 400, k: 1.04 },
  { family: loadGochi('normal', { weights: ['400'] }).fontFamily, weight: 400, k: 1.0 },
];
/** The display faces an emphasis word breaks out in, taken in turn: a soft fat serif, and a heavy italic that streaks. */
const ABRIL = loadAbril('normal', { weights: ['400'] }).fontFamily;
const ARCHIVO = loadArchivo('normal', { weights: ['400'] }).fontFamily;

/** One voiceover line: its file, the shot frame it starts on, how its words split into pages (word counts), and the
 *  words that break out. */
export interface CaptionLine { file: string; at: number; split: number[]; hot: string[] }
export interface Point { x: number; y: number }

interface Spoken { text: string; from: number; to: number; hot: number; id: number }
interface Page { words: Spoken[]; from: number; to: number; index: number }

const ASR = asr as Record<string, { words: { w: string; s: number; e: number }[] }>;
const bare = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, '');

/** Every page of every line, in shot frames. A page stays up until the next starts, or 12 frames after its last word. */
export function pages(lines: CaptionLine[], fps: number): Page[] {
  const out: Page[] = [];
  let id = 1;
  let hot = 0;
  for (const line of lines) {
    const words = ASR[`voice/final_narrator/${line.file}.wav`]?.words;
    if (!words) throw new Error(`no word timestamps for voiceover line ${line.file}`);
    const said: Spoken[] = words.map((w, i) => ({
      text: w.w,
      from: line.at + Math.round(w.s * fps),
      to: line.at + Math.round(w.e * fps),
      hot: line.hot.includes(bare(w.w)) ? ++hot : 0,
      id: id + i,
    }));
    id += words.length;
    if (line.split.reduce((a, b) => a + b, 0) !== said.length) throw new Error(`split of ${line.file} does not cover its ${said.length} words`);
    let k = 0;
    for (const n of line.split) {
      const ws = said.slice(k, k + n);
      k += n;
      out.push({ words: ws, from: ws[0]!.from, to: ws[ws.length - 1]!.to + 12, index: out.length });
    }
  }
  out.forEach((p, i) => { const next = out[i + 1]; if (next && next.from < p.to) p.to = next.from; });
  return out;
}

/** The frame letter `k` of `n` in a word appears: the word writes itself across its spoken time. */
const letterAt = (w: Spoken, k: number, n: number) => w.from + ((w.to - w.from) * k) / Math.max(1, n);

const CREAM = '#FFF4E2';
const SIZE = 124;
const GLOW = '0 0 10px rgba(255,236,210,0.55), 0 0 28px rgba(255,214,170,0.28)';

/** Lands over 6 frames: a little big, with a pink and cyan fringe that closes up. */
function landing(t: number): { scale: number; opacity: number; fringe: string } {
  const a = interpolate(t, [0, 6], [1, 0], CLAMP);
  const off = 5 * a;
  return {
    scale: interpolate(t, [0, 3], [1.3, 1], CLAMP),
    opacity: interpolate(t, [0, 1.5], [0, 1], CLAMP),
    fringe: `${-off}px 0 0 rgba(255,70,160,${(0.85 * a).toFixed(3)}), ${off}px 0 0 rgba(70,255,220,${(0.85 * a).toFixed(3)}), `,
  };
}

/** The bracket on the letter being written, with the subject's coordinates in small type. */
const Bracket: React.FC<{ at: Point }> = ({ at }) => (
  <div style={{ position: 'absolute', left: -5, right: -5, top: '8%', bottom: '-4%', border: `1.5px solid ${CREAM}`, boxShadow: '0 0 6px rgba(255,236,210,0.5)' }}>
    <div style={{ position: 'absolute', left: -4, top: -4, width: 6, height: 6, background: CREAM }} />
    <div style={{ position: 'absolute', right: -4, bottom: -4, width: 6, height: 6, background: CREAM }} />
    <div style={{ position: 'absolute', left: '100%', top: -18, marginLeft: 8, fontFamily: MONO, fontSize: 13, color: CREAM, whiteSpace: 'pre', letterSpacing: 0.5, opacity: 0.9 }}>
      {`x: ${Math.round(at.x)}  y: ${Math.round(at.y)}`}
    </div>
  </div>
);

/** A little flower, drawn on stroke by stroke, beside a word that broke out. */
const Doodle: React.FC<{ t: number; seed: number }> = ({ t, seed }) => {
  const draw = interpolate(t, [0, 10], [0, 1], CLAMP);
  const petals = [0, 1, 2, 3, 4].map((i) => {
    const a = (i / 5) * Math.PI * 2 + seed;
    const x = Math.cos(a) * 15, y = Math.sin(a) * 15;
    return `M0 0 Q${(x * 0.2 - y * 0.6).toFixed(1)} ${(y * 0.2 + x * 0.6).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)} Q${(x * 0.2 + y * 0.6).toFixed(1)} ${(y * 0.2 - x * 0.6).toFixed(1)} 0 0`;
  });
  return (
    <svg width={60} height={60} viewBox="-30 -30 60 60" style={{ position: 'absolute', right: -52, top: -30, overflow: 'visible' }}>
      {petals.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="#FF8FC8" strokeWidth={2.4} strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - interpolate(draw, [i / 6, (i + 1) / 6], [0, 1], CLAMP)} />
      ))}
      <circle r={3.5 * interpolate(draw, [0.8, 1], [0, 1], CLAMP)} fill="#FFE27A" />
    </svg>
  );
};

/** One word: plain words letter by letter in mixed hands; a hot word whole, in its display face. */
const Word: React.FC<{ w: Spoken; head: number | null; anchor: Point }> = ({ w, head, anchor }) => {
  const frame = useCurrentFrame();
  const letters = [...w.text];
  if (w.hot) {
    const t = frame - w.from;
    if (t < 0) return <span style={{ display: 'inline-block', width: 0 }} />;
    const l = landing(t);
    const serif = w.hot % 2 === 1;
    const size = SIZE * (serif ? 1.38 : 1.26);
    return (
      <span style={{ position: 'relative', display: 'inline-block', margin: '0 22px', verticalAlign: 'baseline' }}>
        {/* the heavy italic streaks in from the left */}
        {!serif && t < 8 && (
          <span style={{ position: 'absolute', left: 0, top: 0, fontFamily: ARCHIVO, fontSize: size, fontStyle: 'italic', color: CREAM, whiteSpace: 'nowrap',
            opacity: 0.35 * (1 - t / 8), filter: 'blur(6px)', transform: `translateX(${-40 + t * 5}px) scaleX(1.25)` }}>{w.text}</span>
        )}
        <span style={{
          display: 'inline-block', fontFamily: serif ? ABRIL : ARCHIVO, fontStyle: serif ? 'normal' : 'italic', fontSize: size, lineHeight: 1,
          color: CREAM, whiteSpace: 'nowrap', textShadow: l.fringe + GLOW, opacity: l.opacity,
          transform: `scale(${l.scale.toFixed(3)}) rotate(${((random(`r-${w.id}`) - 0.5) * 5).toFixed(2)}deg)`,
        }}>{w.text}</span>
        {serif && <Doodle t={t - 4} seed={w.id} />}
        {head === 0 && <Bracket at={anchor} />}
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-block', margin: '0 18px', whiteSpace: 'nowrap' }}>
      {letters.map((ch, k) => {
        const t = frame - letterAt(w, k, letters.length);
        const hand = HANDS[Math.floor(random(`h-${w.id}-${k}`) * HANDS.length)]!;
        const l = landing(t);
        const lift = (random(`y-${w.id}-${k}`) - 0.5) * 10;
        const tilt = (random(`t-${w.id}-${k}`) - 0.5) * 9;
        const big = 0.92 + random(`s-${w.id}-${k}`) * 0.18;
        return (
          <span key={k} style={{ position: 'relative', display: 'inline-block', verticalAlign: 'baseline' }}>
            <span style={{
              display: 'inline-block', fontFamily: hand.family, fontWeight: hand.weight, fontSize: SIZE * hand.k * big, lineHeight: 1,
              color: CREAM, textShadow: l.fringe + GLOW, opacity: t >= 0 ? l.opacity : 0,
              transform: `translateY(${lift.toFixed(1)}px) rotate(${tilt.toFixed(1)}deg) scale(${l.scale.toFixed(3)})`,
            }}>{ch}</span>
            {head === k && <Bracket at={anchor} />}
          </span>
        );
      })}
    </span>
  );
};

/** Where on the page the bracket is: the last letter that has appeared, as [word index, letter index]. */
function writeHead(page: Page, frame: number): [number, number] {
  let at: [number, number] = [0, 0];
  page.words.forEach((w, i) => {
    if (w.hot) { if (frame >= w.from) at = [i, 0]; return; }
    const n = [...w.text].length;
    for (let k = 0; k < n; k++) if (frame >= letterAt(w, k, n)) at = [i, k];
  });
  return at;
}

/** The reticle on the tracked subject: a box with ticks and an id, nudged a pixel or two each frame. */
const Reticle: React.FC<{ at: Point; frame: number }> = ({ at, frame }) => {
  const jx = (random(`rx-${frame}`) - 0.5) * 3, jy = (random(`ry-${frame}`) - 0.5) * 3;
  return (
    <div style={{ position: 'absolute', left: at.x - 46 + jx, top: at.y - 46 + jy, width: 92, height: 92, border: `1px solid rgba(255,244,226,0.75)`,
      boxShadow: '0 0 0 1px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(0,0,0,0.45)' }}>
      {[[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => (
        <div key={`${x}${y}`} style={{ position: 'absolute', left: x ? undefined : -2, right: x ? -2 : undefined, top: y ? undefined : -2, bottom: y ? -2 : undefined, width: 12, height: 12,
          [`border${y ? 'Bottom' : 'Top'}`]: `3px solid ${CREAM}`, [`border${x ? 'Right' : 'Left'}`]: `3px solid ${CREAM}`, filter: 'drop-shadow(0 0 1px rgba(0,0,0,0.8))' }} />
      ))}
      <div style={{ position: 'absolute', left: 0, top: '100%', marginTop: 6, fontFamily: MONO, fontSize: 13, color: CREAM, whiteSpace: 'pre', opacity: 0.85 }}>
        {`TRK 01  ${(0.91 + random(`c-${Math.floor(frame / 5)}`) * 0.08).toFixed(2)}`}
      </div>
    </div>
  );
};

/** A page's width on one line, roughly: the hands are about half an em a letter, the display faces a little more. */
function guessWidth(page: Page): number {
  return page.words.reduce((a, w) => a + 40 + [...w.text].length * (w.hot ? SIZE * (w.hot % 2 ? 1.38 : 1.26) * 0.58 : SIZE * 0.46), 0);
}

/** The text sits this far beside and above the subject, on the side it fits (or the side `anchor` names). */
const BESIDE = 90;
const ABOVE = 150;

/** The captions of `lines` over the footage. `anchor(frame)` is the tracked subject in frame pixels, or null when the
 *  tracker has nothing. The text hangs off the subject, or off `place(frame)` when given (a subject that jumps about,
 *  with the text kept still and the lines running to it). */
export const Captions: React.FC<{
  lines: CaptionLine[]; anchor: (frame: number) => (Point & { side?: 'left' | 'right' }) | null; width: number; height: number; top?: number;
  place?: (frame: number) => (Point & { side?: 'left' | 'right' }) | null;
}> = ({ lines, anchor, width, height, top = 160, place }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const page = pages(lines, fps).find((p) => frame >= p.from && frame < p.to);
  const subject = anchor(frame);
  const at = place ? place(frame) : subject;
  if (!page || !at || !subject) return null;
  // the block goes on the side where the page fits on one line, or the roomier side; its near edge is BESIDE the
  // subject and it grows up from its bottom, never above `top`
  const need = guessWidth(page);
  const roomOf = (sd: 'left' | 'right') => (sd === 'right' ? width - 60 - (at.x + BESIDE) : at.x - BESIDE - 60);
  const side = at.side ?? (roomOf('right') >= need ? 'right' : roomOf('left') >= need ? 'left' : roomOf('right') > roomOf('left') ? 'right' : 'left');
  const near = side === 'right' ? at.x + BESIDE : at.x - BESIDE;
  const room = roomOf(side);
  const rows = Math.max(1, Math.ceil(need / room));
  const bottom = Math.min(Math.max(height - (at.y - ABOVE), 160), height - top - rows * SIZE * 1.6);
  const [hw, hk] = writeHead(page, frame);
  // the lines: subject to the text's corner, and subject off the frame's edge, faint
  const cx = near + (side === 'right' ? 30 : -30), cy = height - bottom + 10;
  const edge = { x: subject.x < width / 2 ? width + 40 : -40, y: subject.y + (subject.y < height / 2 ? 260 : -260) };
  return (
    <AbsoluteFill>
      <svg width={width} height={height} style={{ position: 'absolute', left: 0, top: 0 }}>
        {/* a dark edge under the lines, so they read over white as well as dark */}
        <line x1={subject.x} y1={subject.y} x2={cx} y2={cy} stroke="#000" strokeWidth={3.2} strokeOpacity={0.3} />
        <line x1={subject.x} y1={subject.y} x2={edge.x} y2={edge.y} stroke="#000" strokeWidth={3} strokeOpacity={0.22} />
        <line x1={subject.x} y1={subject.y} x2={cx} y2={cy} stroke={CREAM} strokeWidth={1.2} strokeOpacity={0.6} />
        <line x1={subject.x} y1={subject.y} x2={edge.x} y2={edge.y} stroke={CREAM} strokeWidth={1} strokeOpacity={0.35} />
        <line x1={cx} y1={cy} x2={cx + (side === 'right' ? -260 : 260)} y2={cy - 40} stroke={CREAM} strokeWidth={1} strokeOpacity={0.3} />
      </svg>
      <Reticle at={subject} frame={frame} />
      <div style={{
        position: 'absolute', bottom, width: room, ...(side === 'right' ? { left: near } : { left: near - room }),
        display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: side === 'right' ? 'flex-start' : 'flex-end', rowGap: 4,
      }}>
        {page.words.map((w, i) => <Word key={w.id} w={w} head={i === hw ? hk : null} anchor={subject} />)}
      </div>
    </AbsoluteFill>
  );
};

/** When each word is written, for the sound: a pen across a plain word, a soft thump for one that breaks out. */
export const wordSpans = (lines: CaptionLine[], fps: number): { from: number; to: number; hot: boolean }[] =>
  pages(lines, fps).flatMap((p) => p.words.filter((w) => w.from < p.to).map((w) => ({ from: w.from, to: Math.min(w.to, p.to), hot: w.hot > 0 })));
