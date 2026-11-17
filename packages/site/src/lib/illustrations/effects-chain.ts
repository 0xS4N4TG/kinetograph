import { Sketch, type Diagram } from '../sketch.ts';

export const title = 'The order of effects';

export function build(alt: string): Diagram {
  const sk = new Sketch();
  const bx = 30;
  const w = 300;
  const h = 64;
  const ys = [24, 130, 236, 342, 448, 554];
  sk.group(14, 112, 332, 204);
  sk.node(bx, ys[0], w, h, { title: 'Layer pixels', sub: 'before any cut' });
  sk.node(bx, ys[1], w, h, { title: 'colorCorrection()', sub: 'correct the colour', step: 1, bold: true });
  sk.node(bx, ys[2], w, h, { title: 'lut()', sub: 'apply the look', step: 2, bold: true });
  sk.node(bx, ys[3], w, h, { title: 'clip, mask, matte', sub: 'cut the layer' });
  sk.node(bx, ys[4], w, h, { title: 'opacity, blendMode', sub: 'blend it' });
  sk.node(bx, ys[5], w, h, { title: 'Composite', sub: 'with the layers below' });
  for (let i = 0; i < ys.length - 1; i++) sk.arrow([[bx + w / 2, ys[i] + h + 4], [bx + w / 2, ys[i + 1] - 4]]);
  sk.label({ x: 366, y: 224, text: 'effects={[ ... ]}', size: 20, weight: 700, anchor: 'start', tone: 'ink' });
  sk.say(366, 250, 'runs in array order');
  sk.label({ x: bx, y: 660, text: 'Colour first, look second.', size: 22, weight: 700, anchor: 'start', tone: 'ink' });
  sk.say(bx, 688, 'Swap them and the look lands on uncorrected colour.');
  return sk.build(560, 716, alt);
}
