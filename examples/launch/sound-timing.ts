// Where things start in the cut, in frames at 30 fps, derived from LEN (shot 6, the burn, lies over the 5 to 7 cut).

import { LEN } from './common.js';
import asr from './tools/narration/voice/asr_narrator_final.json';

export const FPS = 30;
/** The shots in cut order (shot 6, the burn, is not in it: it lies over the cut from 5 into 7). */
const ORDER = ['s01', 's02', 's03', 's04', 's05', 's07', 'm1', 'm2', 'm3', 'm4', 'm5', 's08', 's09', 's10', 's11', 's12'] as const;
export const START = {} as Record<(typeof ORDER)[number], number>;
ORDER.reduce((at, shot) => ((START[shot] = at), at + LEN[shot]), 0);
export const BURN = START.s07;
export const TOTAL = START.s12 + LEN.s12;

/** The voiceover lines: file (public/vo/<file>.wav), shot, and the frame inside the shot where the line starts. They are
 *  pieces of one take in order; a gap between two is the take's own pause, lengthened where the picture needs time.
 *  The words on screen are timed from these and the word timestamps in tools/narration/voice/asr_narrator_final.json. */
export const VO: { file: string; shot: keyof typeof START; at: number }[] = [
  { file: '02-1891', shot: 's02', at: 4 },
  { file: '03-today', shot: 's03', at: 3 },
  { file: '04-you-dont', shot: 's04', at: 0 },
  { file: '05-render', shot: 's05', at: 4 },
  { file: '07a-your', shot: 's07', at: 4 },
  { file: '07b-write', shot: 's07', at: 62 },
  { file: '07c-text', shot: 'm1', at: 4 },
  { file: 'm1-3d', shot: 'm1', at: 40 },
  { file: 'm2-iso', shot: 'm2', at: 6 },
  { file: 'm3-shaders', shot: 'm3', at: 4 },
  { file: 'm4-canvas', shot: 'm4', at: 2 },
  { file: 'm5-glass', shot: 'm5', at: 2 },
  { file: '08-remotion', shot: 's08', at: 6 },
  { file: '09-film', shot: 's09', at: 14 },
  { file: '10-pixels', shot: 's10', at: 1 },
  { file: '12-end', shot: 's12', at: 6 },
];

/** The shot frames each word of voiceover line `file` starts and ends on, from the narrator's word timestamps. */
export function spoken(file: string): { w: string; from: number; to: number }[] {
  const line = VO.find((v) => v.file === file);
  const words = (asr as Record<string, { words: { w: string; s: number; e: number }[] }>)[`voice/final_narrator/${file}.wav`]?.words;
  if (!line || !words) throw new Error(`no voiceover line ${file}`);
  return words.map((w) => ({ w: w.w, from: line.at + Math.round(w.s * FPS), to: line.at + Math.round(w.e * FPS) }));
}
