import { Sketch, type Diagram } from '../sketch.ts';

export const title = 'Three render paths';

const ROWS = [
  { name: 'Remotion', write: ['You write', 'TSX, React'], browser: true },
  { name: 'HyperFrames', write: ['You write', 'HTML page, GSAP'], browser: true },
  { name: 'Kinetograph', write: ['You write', 'TSX or HTML page'], browser: false },
];

export function build(alt: string): Diagram {
  const sk = new Sketch();
  ROWS.forEach((row, i) => {
    const top = 20 + i * 150;
    const y = top + 46;
    sk.label({ x: 30, y: top + 24, text: row.name, size: 24, weight: 700, anchor: 'start', tone: 'ink' });
    sk.node(30, y, 170, 84, { title: row.write[0], sub: row.write[1] });
    if (row.browser) {
      sk.node(246, y, 190, 84, { title: 'A browser draws', sub: 'every frame', dash: '7 6', tone: 'muted' });
      // A small browser window in the corner of the box.
      sk.rect(329, y + 6, 24, 14, { w: 1.5, roughness: 0.9, tone: 'muted' });
      sk.line(329, y + 11, 353, y + 11, { w: 1.4, roughness: 0.6, tone: 'muted' });
    } else {
      sk.node(246, y, 190, 84, { title: 'Rust compositor', sub: 'draws on the GPU', bold: true });
      sk.pill(452, top + 2, 140, 34);
      sk.say(522, top + 26, 'no browser', { size: 20, weight: 700, anchor: 'middle', tone: 'ink' });
    }
    sk.node(482, y, 110, 84, { title: 'Video' });
    sk.arrow([[206, y + 42], [240, y + 42]]);
    sk.arrow([[442, y + 42], [476, y + 42]]);
    if (i < 2) sk.line(30, top + 142, 592, top + 142, { w: 1.3, dash: '8 8', tone: 'muted' });
  });
  sk.say(30, 20 + 2 * 150 + 46 + 84 + 30, 'Runs Remotion and HyperFrames projects as they are.');
  return sk.build(620, 504, alt);
}
