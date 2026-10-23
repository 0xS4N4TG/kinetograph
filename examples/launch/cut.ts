// The cut, derived from the narration. The voiceover is ONE take (public/vo/take.wav), played whole from TAKE_AT; it
// is never cut or re-spaced, so the picture is timed to it: each shot that opens on a line starts LEAD frames before
// that line's first word (and never before the last line's last word ends), and runs to the next shot. The take's
// word times are tools/narration/voice/asr_narrator_final.json, written by tools/narration/lines.mjs.

import asr from './tools/narration/voice/asr_narrator_final.json';

const FPS = 30;
type Line = { at: number; words: { w: string; s: number; e: number }[] };
const LINES = asr as unknown as Record<string, Line> & { take: { dur: number } };
const line = (file: string): Line => {
  const l = LINES[`voice/final_narrator/${file}.wav`];
  if (!l) throw new Error(`no voiceover line ${file}`);
  return l;
};

/** Frames of the leader before the first shot of film. */
const LEADER = 26;
/** Frames a shot starts before the first word of its line. */
const LEAD = 3;
/** Frames the first line starts into shot 2. */
const OPEN = 4;
/** Frames the end card holds after the last word. */
const TAIL = 75;

/** The film frame the take starts on. */
export const TAKE_AT = LEADER + OPEN - Math.round(line('02-1891').at * FPS);
/** The take's length in frames. */
export const TAKE_FRAMES = Math.ceil(LINES.take.dur * FPS);

/** The film frame a line's first word starts on, and its last word ends on. */
export const lineFrom = (file: string): number => TAKE_AT + Math.round(line(file).at * FPS);
export const lineTo = (file: string): number => { const l = line(file); return TAKE_AT + Math.round((l.at + l.words[l.words.length - 1]!.e) * FPS); };
/** The film frame word `i` of a line starts on. */
const wordFrom = (file: string, i: number): number => { const l = line(file); return TAKE_AT + Math.round((l.at + l.words[i]!.s) * FPS); };

/** Frames shot 10 holds after "pixels" before shot 11's flicker takes over. */
const S10_SETTLE = 8;

/** The shots in cut order with the line each opens on (shot 1 is the leader). Shot 11 is placed by hand below: it
 *  flickers through the pause after "Just pixels." and lands the name on "Kinetograph."; the end card follows on
 *  "Motion pictures". */
const OPENS: [string, string][] = [
  ['s02', '02-1891'], ['s03', '03-today'], ['s04', '04-you-dont'], ['s05', '05-render'], ['s07', '07a-your'],
  ['m1', '07c-text'], ['m2', 'm2-iso'], ['m3', 'm3-shaders'], ['m4', 'm4-canvas'], ['m5', 'm5-glass'],
  ['s08', '08-remotion'], ['s09', '09-film'], ['s10', '10-pixels'], ['s12', '12-end'],
];
const order = Object.keys(LINES).filter((k) => k.startsWith('voice/')).map((k) => k.slice('voice/final_narrator/'.length, -4));
const starts: Record<string, number> = { s01: 0 };
OPENS.forEach(([shot, file], i) => {
  const before = order.indexOf(file) - 1;
  const floor = i === 0 ? LEADER : lineTo(order[before]!) + 1;
  starts[shot] = i === 0 ? LEADER : Math.max(floor, lineFrom(file) - LEAD);
});
starts.s11 = lineTo('10-pixels') + S10_SETTLE;
starts.s12 = wordFrom('12-end', 1) - LEAD;
const end = lineTo('12-end') + TAIL;
const next = (shot: string): number => {
  const i = OPENS.findIndex(([s]) => s === shot);
  if (shot === 's10') return starts.s11!;
  if (shot === 's11') return starts.s12!;
  return shot === 's01' ? LEADER : i === OPENS.length - 1 ? end : starts[OPENS[i + 1]![0]]!;
};

/** Frames of each shot at 30 fps, in cut order. Shot 6, the burn, lies over the cut from shot 5 into shot 7 and takes
 *  no time of its own. */
export const LEN = {
  s01: LEADER, s02: next('s02') - starts.s02!, s03: next('s03') - starts.s03!, s04: next('s04') - starts.s04!,
  s05: next('s05') - starts.s05!, s06: 27, s07: next('s07') - starts.s07!, m1: next('m1') - starts.m1!,
  m2: next('m2') - starts.m2!, m3: next('m3') - starts.m3!, m4: next('m4') - starts.m4!, m5: next('m5') - starts.m5!,
  s08: next('s08') - starts.s08!, s09: next('s09') - starts.s09!, s10: next('s10') - starts.s10!, s11: next('s11') - starts.s11!,
  s12: next('s12') - starts.s12!,
} as const;
