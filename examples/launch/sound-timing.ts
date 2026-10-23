// Where things start in the cut, in frames at 30 fps, derived from LEN (shot 6, the burn, lies over the 5 to 7 cut).

import { LEN } from './common.js';
import { lineFrom } from './cut.js';
import asr from './tools/narration/voice/asr_narrator_final.json';

export const FPS = 30;
/** The shots in cut order (shot 6, the burn, is not in it: it lies over the cut from 5 into 7). */
const ORDER = ['s01', 's02', 's03', 's04', 's05', 's07', 'm1', 'm2', 'm3', 'm4', 'm5', 's08', 's09', 's10', 's11', 's12'] as const;
export const START = {} as Record<(typeof ORDER)[number], number>;
ORDER.reduce((at, shot) => ((START[shot] = at), at + LEN[shot]), 0);
export const BURN = START.s07;
export const TOTAL = START.s12 + LEN.s12;

/** The voiceover's lines: each a run of words of the one take (cut.ts), the shot its first word falls in, and the
 *  frame inside that shot it starts on. The words on screen are timed from these and the word timestamps in
 *  tools/narration/voice/asr_narrator_final.json. */
export const VO: { file: string; shot: keyof typeof START; at: number }[] = Object.keys(asr)
  .filter((k) => k.startsWith('voice/final_narrator/'))
  .map((k) => {
    const file = k.slice('voice/final_narrator/'.length, -'.wav'.length);
    const f = lineFrom(file);
    const shot = [...ORDER].reverse().find((s) => LEN[s] > 0 && START[s] <= f)!;
    return { file, shot, at: f - START[shot] };
  });

/** The shot frames each word of voiceover line `file` starts and ends on, from the narrator's word timestamps. */
export function spoken(file: string): { w: string; from: number; to: number }[] {
  const line = VO.find((v) => v.file === file);
  const words = (asr as Record<string, { words: { w: string; s: number; e: number }[] }>)[`voice/final_narrator/${file}.wav`]?.words;
  if (!line || !words) throw new Error(`no voiceover line ${file}`);
  return words.map((w) => ({ w: w.w, from: line.at + Math.round(w.s * FPS), to: line.at + Math.round(w.e * FPS) }));
}

/** spoken(), with the frames counted from the start of `shot` instead of the shot the line starts in. */
export function spokenIn(file: string, shot: keyof typeof START): { w: string; from: number; to: number }[] {
  const d = START[VO.find((v) => v.file === file)!.shot] - START[shot];
  return spoken(file).map((w) => ({ ...w, from: w.from + d, to: w.to + d }));
}
