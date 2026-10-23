// Shot 7's captions: the voiceover word by word, big, timed from the narrator's own word timestamps
// (tools/narration/voice/asr_narrator_final.json). Each word springs in, tilted a few degrees, with a thick stepped
// outline; the key nouns are bigger and red. A page holds at most three words, centred, with no box. One face per
// voiceover line, from the pixel and dot-matrix type of jellysynth.com (Geist Pixel, Doto).
//
// The tracking is on the words themselves: each word gets a box that hunts for it and locks on, with an id tag,
// small blobs that hop across its letters, and a dashed link to the next word. An emphasis word's box inverts the
// picture behind it.

import React from 'react';
import { AbsoluteFill, random, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { loadFont } from '@kinetograph/core/fonts';
import { loadFont as loadDoto } from '@remotion/google-fonts/Doto';
import { loadFont as loadDMMono } from '@remotion/google-fonts/DMMono';
import { RED } from '../common.js';
import asr from '../tools/narration/voice/asr_narrator_final.json';

for (const v of ['Square', 'Circle', 'Line', 'Grid', 'Triangle']) {
  loadFont({ family: `Geist Pixel ${v}`, url: staticFile(`fonts/geist-pixel/GeistPixel-${v}.woff2`), weight: 500 });
}
const DOTO = loadDoto('normal', { weights: ['900'] }).fontFamily;
const TAG = loadDMMono('normal', { weights: ['500'] }).fontFamily;

export interface Face { family: string; weight: number; /** evens out how big each face reads at one size */ k: number; spacing?: number }
export const FACES = {
  square: { family: 'Geist Pixel Square', weight: 500, k: 1 },
  circle: { family: 'Geist Pixel Circle', weight: 500, k: 1 },
  doto: { family: DOTO, weight: 900, k: 1.08, spacing: -2 },
} satisfies Record<string, Face>;

/** One voiceover line on screen: its file, the shot frame it starts on, how its words split into pages (word
 *  counts, at most three each), its face, and the words to blow up. */
export interface CaptionLine { file: string; at: number; split: number[]; face: Face; hot: string[] }

export interface Spoken { text: string; from: number; to: number; hot: boolean; id: number }
interface Page { words: Spoken[]; face: Face; from: number; to: number }

const ASR = asr as Record<string, { words: { w: string; s: number; e: number }[] }>;
const bare = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, '');

/** The words of `line`, in shot frames. */
function spoken(line: CaptionLine, fps: number, first: number): Spoken[] {
  const words = ASR[`voice/final_narrator/${line.file}.wav`]?.words;
  if (!words) throw new Error(`no word timestamps for voiceover line ${line.file}`);
  return words.map((w, i) => ({
    text: w.w.replace(/[,.;:]+$/, ''),
    from: line.at + Math.round(w.s * fps),
    to: line.at + Math.round(w.e * fps),
    hot: line.hot.includes(bare(w.w)),
    id: first + i,
  }));
}

/** Every page of every line, each up until the next one starts or a third of a second after its last word. */
export function pages(lines: CaptionLine[], fps: number): Page[] {
  const out: Page[] = [];
  let id = 1;
  for (const line of lines) {
    const words = spoken(line, fps, id);
    id += words.length;
    if (line.split.reduce((a, b) => a + b, 0) !== words.length) throw new Error(`split of ${line.file} does not cover its ${words.length} words`);
    let k = 0;
    for (const n of line.split) {
      const ws = words.slice(k, k + n);
      k += n;
      out.push({ words: ws, face: line.face, from: ws[0]!.from, to: ws[ws.length - 1]!.to + 10 });
    }
  }
  out.forEach((p, i) => { const next = out[i + 1]; if (next && next.from < p.to) p.to = next.from; });
  return out;
}

const BASE = 150;
const HOT_SCALE = 1.34;
const GAP = 84;
/** The box sits this far outside the word. */
const PAD = 16;
/** Frames the box hunts before it locks. */
const LOCK = 7;
const INK = '#0A0A0A';
const WHITE = '#FFFFFF';

/** A thick outline in hard steps, from offset copies (no blur), which suits pixel type; then a drop shadow. */
function outline(r: number): string {
  const s: string[] = [];
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    s.push(`${(Math.cos(a) * r).toFixed(1)}px ${(Math.sin(a) * r).toFixed(1)}px 0 ${INK}`);
  }
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + 0.2;
    s.push(`${(Math.cos(a) * r * 0.5).toFixed(1)}px ${(Math.sin(a) * r * 0.5).toFixed(1)}px 0 ${INK}`);
  }
  s.push(`0 ${(r * 1.6).toFixed(1)}px 0 ${INK}`, `0 ${(r * 2.4).toFixed(1)}px ${(r * 2.6).toFixed(1)}px rgba(0,0,0,0.45)`);
  return s.join(', ');
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Corner ticks of a box, heavier than its edge. */
const Ticks: React.FC = () => (
  <>
    {([['top', 'left'], ['top', 'right'], ['bottom', 'left'], ['bottom', 'right']] as const).map(([v, h]) => (
      <div key={v + h} style={{
        position: 'absolute', [v]: -3, [h]: -3, width: 18, height: 18,
        [`border${v === 'top' ? 'Top' : 'Bottom'}`]: `4px solid ${WHITE}`, [`border${h === 'left' ? 'Left' : 'Right'}`]: `4px solid ${WHITE}`,
      }} />
    ))}
  </>
);

/** Small blobs on the letters: each holds a spot for a few frames, then hops to another. */
const Blobs: React.FC<{ id: number; t: number }> = ({ id, t }) => (
  <>
    {[0, 1].map((k) => {
      const hop = Math.floor((t + k * 5) / 9);
      const x = 8 + random(`bx-${id}-${k}-${hop}`) * 84;
      const y = 22 + random(`by-${id}-${k}-${hop}`) * 56;
      const s = 16 + random(`bs-${id}-${k}-${hop}`) * 18;
      return (
        <div key={k} style={{ position: 'absolute', left: `${x}%`, top: `${y}%`, width: s, height: s, marginLeft: -s / 2, marginTop: -s / 2, border: `1.5px solid ${WHITE}` }}>
          <div style={{ position: 'absolute', left: s / 2 - 0.75, top: -6, width: 1.5, height: s + 12, background: WHITE }} />
          <div style={{ position: 'absolute', top: s / 2 - 0.75, left: -6, height: 1.5, width: s + 12, background: WHITE }} />
        </div>
      );
    })}
  </>
);

/** The tracking box of one word: `t` frames since the word began. It starts wide and off-centre and steps in, two
 *  frames at a time, then locks and only jitters. */
const Track: React.FC<{ w: Spoken; t: number; frame: number; last: boolean; scale: number }> = ({ w, t, frame, last, scale }) => {
  if (t < 0) return null;
  const locked = t >= LOCK;
  const step = Math.floor(t / 2);
  const wide = locked ? 0 : 1 - step / Math.ceil(LOCK / 2);
  const dx = (random(`hx-${w.id}-${step}`) - 0.5) * 70 * wide + (random(`jx-${w.id}-${frame}`) - 0.5) * 2.4;
  const dy = (random(`hy-${w.id}-${step}`) - 0.5) * 40 * wide + (random(`jy-${w.id}-${frame}`) - 0.5) * 2.4;
  const grow = PAD + 46 * wide;
  const conf = (0.9 + random(`c-${w.id}-${Math.floor(frame / 4)}`) * 0.09).toFixed(2);
  return (
    // the box follows the word's bounce (its scale), not its tilt: a tracker sees an upright box
    <div style={{ position: 'absolute', left: -grow + dx, right: -grow - dx, top: -grow * 0.6 + dy, bottom: -grow * 0.6 - dy, transform: `scale(${scale.toFixed(4)})` }}>
      <div style={{ position: 'absolute', inset: 0, border: `2px ${locked ? 'solid' : 'dashed'} ${WHITE}` }} />
      {locked && <Ticks />}
      {locked && <Blobs id={w.id} t={t} />}
      <div style={{
        position: 'absolute', left: -2, bottom: '100%', marginBottom: 6, padding: '3px 8px', whiteSpace: 'pre',
        fontFamily: TAG, fontWeight: 500, fontSize: 17, letterSpacing: 0.5,
        background: locked ? WHITE : 'rgba(0,0,0,0.55)', color: locked ? INK : WHITE,
      }}>{locked ? `ID ${pad2(w.id)}  ${w.text.toUpperCase()}  ${conf}` : `SCAN ${pad2(w.id)}`}</div>
      {/* the dashed link to the next word, with a node where it meets this box */}
      {locked && !last && (
        <div style={{ position: 'absolute', left: '100%', top: '50%', width: GAP - 2 * PAD + 6, borderTop: `2px dashed ${WHITE}`, opacity: 0.8 }}>
          <div style={{ position: 'absolute', left: -4, top: -5, width: 8, height: 8, background: WHITE }} />
        </div>
      )}
    </div>
  );
};

const Word: React.FC<{ w: Spoken; face: Face; last: boolean }> = ({ w, face, last }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame - w.from;
  const pop = spring({ frame: t, fps, config: { damping: 10, stiffness: 210, mass: 0.6 } });
  const size = BASE * face.k * (w.hot ? HOT_SCALE : 1);
  const tilt = (random(`tilt-${w.id}`) - 0.5) * 6; // within ±3 degrees
  const box = -PAD;
  return (
    <div style={{ position: 'relative', margin: `0 ${GAP / 2}px` }}>
      {/* an emphasis word inverts the picture inside its box, under the word */}
      {w.hot && t >= LOCK && <div style={{ position: 'absolute', left: box, right: box, top: box * 0.6, bottom: box * 0.6, background: WHITE, mixBlendMode: 'difference', transform: `scale(${pop.toFixed(4)})` }} />}
      <div style={{
        position: 'relative', zIndex: 1, fontFamily: face.family, fontWeight: face.weight, fontSize: size, lineHeight: 1, letterSpacing: face.spacing ?? 0,
        color: w.hot ? RED : WHITE, textShadow: outline(size * 0.045), whiteSpace: 'nowrap',
        // Before its time the word is a point, so the page does not reflow as words arrive.
        transform: `rotate(${tilt.toFixed(2)}deg) scale(${pop.toFixed(4)})`, opacity: t >= 0 ? 1 : 0,
      }}>{w.text}</div>
      <Track w={w} t={t} frame={frame} last={last} scale={pop} />
    </div>
  );
};

/** The captions of `lines`, over a transparent ground, in shot frames. */
export const Captions: React.FC<{ lines: CaptionLine[] }> = ({ lines }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const page = pages(lines, fps).find((p) => frame >= p.from && frame < p.to);
  if (!page) return null;
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {page.words.map((w, i) => <Word key={w.id} w={w} face={page.face} last={i === page.words.length - 1} />)}
      </div>
    </AbsoluteFill>
  );
};

/** The tracker's readout in the corner: how many words it holds and the frame. */
export const TrackHud: React.FC<{ lines: CaptionLine[] }> = ({ lines }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const page = pages(lines, fps).find((p) => frame >= p.from && frame < p.to);
  const held = page ? page.words.filter((w) => frame - w.from >= LOCK).length : 0;
  return (
    <div style={{ position: 'absolute', left: 40, top: 34, color: WHITE, fontFamily: TAG, fontWeight: 500, fontSize: 18, letterSpacing: 1, whiteSpace: 'pre', textShadow: '0 0 6px rgba(0,0,0,0.7)' }}>
      {`TRK:TEXT   LOCK ${held}/${page?.words.length ?? 0}   F${String(frame).padStart(4, '0')}`}
    </div>
  );
};

/** The frame each word's box locks, for the sound. */
export const lockFrames = (lines: CaptionLine[], fps: number): number[] =>
  pages(lines, fps).flatMap((p) => p.words.map((w) => w.from + LOCK).filter((f) => f < p.to));
