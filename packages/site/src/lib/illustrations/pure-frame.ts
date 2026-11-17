import { Sketch, type Diagram } from '../sketch.ts';

export const title = 'Same project and frame, same picture';

/** A tiny frame with a title bar and a smaller line, standing for a rendered picture. */
function picture(sk: Sketch, x: number, y: number, w: number, h: number) {
  sk.rect(x, y, w, h, { w: 2.4 });
  sk.line(x + 14, y + h * 0.36, x + w * 0.7, y + h * 0.36, { w: 4, roughness: 0.7 });
  sk.line(x + 14, y + h * 0.62, x + w * 0.46, y + h * 0.62, { w: 4, roughness: 0.7, tone: 'muted' });
}

export function build(alt: string): Diagram {
  const sk = new Sketch();
  sk.node(20, 24, 170, 66, { title: 'Project', sub: 'code, props, files' });
  sk.node(20, 120, 170, 66, { title: 'Frame number', sub: '42' });
  sk.arrow([[196, 57], [226, 57], [226, 105], [256, 105]], { r: 14 });
  sk.arrow([[196, 153], [226, 153], [226, 105]], { r: 14, head: false });
  sk.node(262, 66, 150, 78, { title: 'Render', sub: 'pure function', bold: true });
  sk.arrow([[418, 105], [452, 105]]);
  picture(sk, 458, 58, 122, 94);
  sk.say(519, 180, 'pixels', { anchor: 'middle' });

  sk.line(30, 216, 570, 216, { w: 1.3, dash: '8 8', tone: 'muted' });

  const xs = [30, 235, 440];
  ['first render', 'another worker', 'any order'].forEach((cap, i) => {
    picture(sk, xs[i], 252, 130, 84);
    sk.say(xs[i] + 65, 366, cap, { anchor: 'middle' });
  });
  for (const cx of [197, 402]) {
    sk.line(cx - 12, 288, cx + 12, 288, { w: 2.6, roughness: 0.6 });
    sk.line(cx - 12, 302, cx + 12, 302, { w: 2.6, roughness: 0.6 });
  }

  // No wall clock: a crossed-out circle.
  sk.ellipse(44, 420, 32, 32, { w: 2.2 });
  sk.line(33, 409, 55, 431, { w: 2.2, roughness: 0.6 });
  sk.say(76, 418, 'No wall clock. Date.now(), Math.random()', { size: 20, tone: 'ink' });
  sk.say(76, 446, 'and timers follow the frame.', { size: 20, tone: 'ink' });
  return sk.build(600, 476, alt);
}
