import { Sketch, type Diagram } from '../sketch.ts';

export const title = 'The Studio loop';

export function build(alt: string): Diagram {
  const sk = new Sketch();
  const w = 256;
  const h = 96;
  sk.node(20, 24, w, h, { title: 'Preview', sub: 'the engine draws every frame', step: 1 });
  sk.node(324, 24, w, h, { title: 'You mark up', sub: 'pin, box, pen or a time range', step: 2 });
  sk.node(324, 232, w, h, { title: 'Agent edits code', sub: 'your coding agent edits files', step: 3 });
  sk.node(20, 232, w, h, { title: 'Engine redraws', sub: 'the frame is drawn again', step: 4 });
  sk.arrow([[282, 72], [318, 72]]);
  sk.arrow([[452, 126], [452, 226]]);
  sk.arrow([[318, 280], [282, 280]]);
  sk.arrow([[148, 226], [148, 126]]);
  sk.say(300, 184, 'repeat until it looks right', { size: 20, anchor: 'middle' });
  sk.say(300, 372, 'Each mark carries its frame and the layers under it.', { anchor: 'middle' });
  return sk.build(600, 396, alt);
}
