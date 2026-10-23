// Word-by-word captions: each word springs in with an overshoot, in its own font, with a thick outline, a few degrees
// of random tilt, and the key nouns blown up and coloured. At most three words are on screen, centred, with no box.
// The words come from a words.json (see captions/words.json and tools/captions/estimate-words.mjs): any file in that
// shape works, so timings from a speech-to-text run drop in unchanged.

import React from 'react';
import { AbsoluteFill, Audio, Sequence, interpolate, random, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { loadFont as loadComicNeue } from '@remotion/google-fonts/ComicNeue';
import { loadFont as loadBangers } from '@remotion/google-fonts/Bangers';
import { loadFont as loadPixelify } from '@remotion/google-fonts/PixelifySans';
import { loadFont as loadPirata } from '@remotion/google-fonts/PirataOne';
import { loadFont as loadBubbles } from '@remotion/google-fonts/RubikBubbles';
import { loadFont as loadLuckiest } from '@remotion/google-fonts/LuckiestGuy';
import { loadFont as loadMarker } from '@remotion/google-fonts/PermanentMarker';

export interface CaptionWord { text: string; start: number; end: number; emphasis?: boolean }
export interface CaptionLine { id: string; file: string; start: number; end: number }
/** `words.json`: either the bare array of words, or an object with `words` (and, optionally, the voiceover `lines`). */
export type CaptionFile = CaptionWord[] | { estimated?: boolean; words: CaptionWord[]; lines?: CaptionLine[]; duration?: number };

/** The font set, in cycling order. `k` evens out how big each face reads at the same size. */
const FONTS = [
  { family: loadComicNeue('normal', { weights: ['700'] }).fontFamily, weight: 700, k: 1.0 },
  { family: loadBangers('normal', { weights: ['400'] }).fontFamily, weight: 400, k: 0.92, spacing: 2 },
  { family: loadPixelify('normal', { weights: ['700'] }).fontFamily, weight: 700, k: 0.92 },
  { family: loadPirata('normal', { weights: ['400'] }).fontFamily, weight: 400, k: 1.5 },
  { family: loadBubbles('normal', { weights: ['400'] }).fontFamily, weight: 400, k: 0.9 },
  { family: loadLuckiest('normal', { weights: ['400'] }).fontFamily, weight: 400, k: 0.86 },
  { family: loadMarker('normal', { weights: ['400'] }).fontFamily, weight: 400, k: 1.05 },
];

const WHITE = '#FFFFFF';
/** Emphasis words take these in turn. */
const HOT = ['#FFE600', '#FF3DA5', '#35F2C8', '#FF7A1A'];

const MAX_WORDS = 3;
const BASE_SIZE = 150;
const EMPHASIS_SCALE = 1.4;

/** The words of a file, however it is shaped. */
export const wordsOf = (f: CaptionFile): CaptionWord[] => (Array.isArray(f) ? f : f.words);
export const linesOf = (f: CaptionFile): CaptionLine[] => (Array.isArray(f) ? [] : (f.lines ?? []));

interface Page { words: { w: CaptionWord; i: number }[]; start: number; end: number }

/** Pages of up to three words (two when one is an emphasis word, which is big): a page also ends at a comma, a stop or
 *  a gap in speech. A page stays up until the next starts, or a moment after its last word. */
export function paginate(words: CaptionWord[]): Page[] {
  const pages: Page[] = [];
  let cur: Page['words'] = [];
  const flush = () => { if (cur.length) { pages.push({ words: cur, start: cur[0].w.start, end: cur[cur.length - 1].w.end }); cur = []; } };
  words.forEach((w, i) => {
    const prev = cur[cur.length - 1]?.w;
    const limit = cur.some((c) => c.w.emphasis) || w.emphasis ? MAX_WORDS - 1 : MAX_WORDS;
    if (prev && (cur.length >= limit || w.start - prev.end > 0.35 || /[,.?!;:]$/.test(prev.text))) flush();
    cur.push({ w, i });
  });
  flush();
  return pages;
}

/** A thick outline from text-shadow, since `-webkit-text-stroke` and `paint-order` are not drawn: two rings of
 *  offset copies make a round outline, then a hard drop shadow and a soft one lift the word off the footage. */
function outline(r: number): string {
  const shadows: string[] = [];
  const ring = (radius: number, n: number, phase: number) => {
    for (let k = 0; k < n; k++) {
      const a = phase + (k / n) * Math.PI * 2;
      shadows.push(`${(Math.cos(a) * radius).toFixed(1)}px ${(Math.sin(a) * radius).toFixed(1)}px 0 #0A0A0A`);
    }
  };
  ring(r, 20, 0);
  ring(r * 0.55, 10, 0.3);
  shadows.push(`0 ${(r * 1.5).toFixed(1)}px 0 #0A0A0A`, `0 ${(r * 2.2).toFixed(1)}px ${(r * 2.4).toFixed(1)}px rgba(0,0,0,0.5)`);
  return shadows.join(', ');
}

const Word: React.FC<{ w: CaptionWord; index: number }> = ({ w, index }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const font = FONTS[index % FONTS.length];
  const born = Math.round(w.start * fps);
  const pop = spring({ frame: frame - born, fps, config: { damping: 7, stiffness: 190, mass: 0.7 } });
  const size = BASE_SIZE * font.k * (w.emphasis ? EMPHASIS_SCALE : 1);
  const tilt = (random(`tilt-${index}`) - 0.5) * 6; // within ±3 degrees
  const fill = w.emphasis ? HOT[index % HOT.length] : WHITE;
  const shown = w.text.replace(/[,.;:]+$/, '');
  return (
    <div style={{
      fontFamily: font.family, fontWeight: font.weight, fontSize: size, lineHeight: 1.05, letterSpacing: font.spacing ?? 0,
      color: fill, textShadow: outline(size * 0.055), whiteSpace: 'nowrap', padding: `0 ${size * 0.08}px`,
      // Scale from the centre; before its time the word is a point, so the page does not reflow as words arrive.
      transform: `rotate(${tilt.toFixed(2)}deg) scale(${pop})`,
      opacity: interpolate(frame - born, [0, 2], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
    }}>{shown}</div>
  );
};

/** The captions alone, over a transparent ground: put them over footage. Frames count from the start of the words. */
export const Captions: React.FC<{ file: CaptionFile }> = ({ file }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const pages = paginate(wordsOf(file));
  const at = pages.findIndex((p, k) => {
    const next = pages[k + 1];
    const hold = Math.min(p.end + 0.45, next ? next.start : Infinity);
    return t >= p.start && t < hold;
  });
  const page = pages[at];
  if (!page) return null;
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', padding: '0 110px' }}>
      <div key={at} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: '0 26px', maxWidth: 1700 }}>
        {page.words.map(({ w, i }) => <Word key={i} w={w} index={i} />)}
      </div>
    </AbsoluteFill>
  );
};

/** The voiceover of each line (`file.lines`), at the line's start. */
export const CaptionAudio: React.FC<{ file: CaptionFile; volume?: number }> = ({ file, volume = 0.9 }) => {
  const { fps } = useVideoConfig();
  return (
    <>
      {linesOf(file).map((l) => (
        <Sequence key={l.id} from={Math.round(l.start * fps)} durationInFrames={Math.ceil((l.end - l.start) * fps) + 2} layout="none">
          <Audio src={staticFile(l.file)} volume={volume} />
        </Sequence>
      ))}
    </>
  );
};
