import { Sketch, type Diagram } from '../sketch.ts';

export const title = 'Commands and the stages they run';

const COL0 = 214;
const COLW = 92;
const STAGES = ['Bundle', 'Run', 'Draw', 'Encode'];

// `to` is the last stage a command goes through: 1 is run, 2 is draw, 3 is encode.
const COMMANDS = [
  { cmd: 'doctor', note: 'a report', to: 1, bar: 'every frame, no GPU' },
  { cmd: 'still', note: 'one PNG', to: 2, bar: 'one frame' },
  { cmd: 'strip', note: 'frames on one sheet', to: 2, bar: 'n frames' },
  { cmd: 'onion', note: 'a blended range', to: 2, bar: 'a range' },
  { cmd: 'render --sequence', note: 'an image per frame', to: 2, bar: 'every frame' },
  { cmd: 'render', note: 'MP4 with audio', to: 3, bar: 'every frame' },
];

export function build(alt: string): Diagram {
  const sk = new Sketch();
  STAGES.forEach((name, i) =>
    sk.label({ x: COL0 + COLW * i + COLW / 2, y: 34, text: name, size: 22, weight: 700, anchor: 'middle', tone: 'ink' }),
  );
  sk.line(20, 50, 580, 50, { w: 2, roughness: 0.8 });
  // Column guides run in the gaps between the bars, so they never cross a label.
  for (let i = 1; i < 4; i++) {
    const x = COL0 + COLW * i;
    sk.line(x, 60, x, 70, { w: 1.3, dash: '6 7', tone: 'muted' });
    for (let r = 0; r < COMMANDS.length; r++) sk.line(x, 68 + r * 66 + 46, x, 68 + r * 66 + 70, { w: 1.3, dash: '6 7', tone: 'muted' });
  }

  COMMANDS.forEach((c, i) => {
    const y = 68 + i * 66;
    sk.label({ x: 20, y: y + 22, text: c.cmd, size: 22, weight: 700, anchor: 'start', tone: 'ink' });
    sk.say(20, y + 44, c.note);
    const w = COLW * (c.to + 1) - 8;
    sk.rect(COL0 + 4, y + 4, w, 40);
    sk.say(COL0 + 4 + w / 2, y + 30, c.bar, { anchor: 'middle', tone: 'ink', fit: w - 12 });
  });
  sk.say(20, 500, 'Draw is the Rust GPU compositor. Run doctor before a long render.');
  return sk.build(600, 524, alt);
}
