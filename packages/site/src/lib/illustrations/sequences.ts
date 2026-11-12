import { Sketch, type Diagram } from '../sketch.ts';

export const title = 'Sequences on a timeline';

const X0 = 30;
const PX = 4.5;
const x = (frame: number) => X0 + frame * PX;

export function build(alt: string): Diagram {
  const sk = new Sketch();
  sk.say(X0, 26, 'frames of the composition');
  sk.line(x(0), 68, x(120), 68, { w: 1.8 });
  for (const f of [0, 30, 60, 90, 120]) {
    sk.line(x(f), 68, x(f), 78, { w: 1.8, roughness: 0.6 });
    sk.say(x(f), 58, String(f), { anchor: f === 0 ? 'start' : f === 120 ? 'end' : 'middle' });
  }

  sk.label({ x: X0, y: 112, text: 'Composition', size: 22, weight: 700, anchor: 'start', tone: 'ink' });
  sk.say(x(120), 112, 'durationInFrames={120}', { anchor: 'end' });
  sk.rect(x(0), 124, 120 * PX, 40);

  sk.say(X0, 214, '<Sequence from={30} durationInFrames={60}>', { size: 20, tone: 'ink' });
  sk.rect(x(30), 226, 60 * PX, 40);

  sk.say(X0, 316, '<Sequence from={20} durationInFrames={30}>', { size: 20, tone: 'ink' });
  sk.rect(x(50), 328, 30 * PX, 40, { w: 3.2 });
  sk.say(x(50) + 90, 354, 'nested', { anchor: 'middle', size: 20 });

  // The playhead: frame 50 of the composition, as each Sequence counts it.
  const px = x(50);
  sk.line(px, 80, px, 124 - 4, { dash: '6 6', w: 1.6, roughness: 0.6 });
  sk.line(px, 160, px, 192, { dash: '6 6', w: 1.6, roughness: 0.6 });
  sk.line(px, 266, px, 294, { dash: '6 6', w: 1.6, roughness: 0.6 });
  sk.badge(px, 144, 17, '50');
  sk.badge(px, 246, 17, '20');
  sk.badge(px + 24, 348, 15, '0');

  [
    'Frame 50 of the composition is frame 20 in the',
    'first Sequence and frame 0 in the nested one.',
    'Each Sequence counts from its own start, and',
    'from is relative to its parent.',
  ].forEach((line, i) => sk.say(X0, 424 + i * 28, line, { size: 20, tone: 'ink' }));
  return sk.build(600, 540, alt);
}
