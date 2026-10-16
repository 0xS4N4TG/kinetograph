// Where things start in the cut, in frames at 30 fps, derived from LEN (shot 6, the burn, lies over the 5 to 7 cut).

import { LEN } from './common.js';

export const FPS = 30;
export const START = {
  s01: 0,
  s02: LEN.s01,
  s03: LEN.s01 + LEN.s02,
  s04: LEN.s01 + LEN.s02 + LEN.s03,
  s05: LEN.s01 + LEN.s02 + LEN.s03 + LEN.s04,
  s07: LEN.s01 + LEN.s02 + LEN.s03 + LEN.s04 + LEN.s05,
  s08: LEN.s01 + LEN.s02 + LEN.s03 + LEN.s04 + LEN.s05 + LEN.s07,
  s09: LEN.s01 + LEN.s02 + LEN.s03 + LEN.s04 + LEN.s05 + LEN.s07 + LEN.s08,
  s10: LEN.s01 + LEN.s02 + LEN.s03 + LEN.s04 + LEN.s05 + LEN.s07 + LEN.s08 + LEN.s09,
  s11: LEN.s01 + LEN.s02 + LEN.s03 + LEN.s04 + LEN.s05 + LEN.s07 + LEN.s08 + LEN.s09 + LEN.s10,
  s12: LEN.s01 + LEN.s02 + LEN.s03 + LEN.s04 + LEN.s05 + LEN.s07 + LEN.s08 + LEN.s09 + LEN.s10 + LEN.s11,
} as const;
export const BURN = START.s07;
export const TOTAL = START.s12 + LEN.s12;

/** The voiceover lines: file (public/vo/<file>.wav), shot, and the frame inside the shot where the line starts
 *  (with the words it lands on). Offsets for shots 10 and 12 are tied to the word frames in act3.tsx. */
export const VO: { file: string; shot: keyof typeof START; at: number }[] = [
  { file: '01-how', shot: 's01', at: 0 },
  { file: '02-question', shot: 's02', at: 4 },
  { file: '03-screenshot', shot: 's03', at: 3 },
  { file: '04-you-dont', shot: 's04', at: 26 },
  { file: '05-render', shot: 's05', at: 2 },
  { file: '07-your', shot: 's07', at: 6 },
  { file: '08-remotion', shot: 's08', at: 6 },
  { file: '09-numbers', shot: 's09', at: 8 },
  { file: '10-pixels', shot: 's10', at: 1 },
  { file: '12-end', shot: 's12', at: 6 },
];
