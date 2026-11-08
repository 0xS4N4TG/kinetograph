import { Sketch, type Diagram } from '../sketch.ts';

export const title = 'A TSX project';

export function build(alt: string): Diagram {
  const sk = new Sketch();
  sk.label({ x: 24, y: 38, text: 'my-video/', size: 26, weight: 700, anchor: 'start', tone: 'ink' });

  const head = (y: number, name: string, note: string) => {
    sk.folder(38, y + 14);
    sk.label({ x: 80, y: y + 38, text: name, size: 26, weight: 700, anchor: 'start', tone: 'ink' });
    sk.say(564, y + 36, note, { anchor: 'end' });
  };
  const rows = (y: number, list: string[][]) =>
    list.forEach(([name, note], i) => {
      sk.label({ x: 58, y: y + i * 30, text: name, size: 20, weight: 400, anchor: 'start', tone: 'ink' });
      sk.say(250, y + i * 30, note, { fit: 316 });
    });

  sk.rect(20, 56, 560, 214);
  head(56, 'src/', 'your code');
  rows(56 + 78, [
    ['index.tsx', 'registerRoot and the compositions'],
    ['scenes/Title.tsx', 'the starter scene'],
    ['components/', 'pieces used by more than one scene'],
    ['lib/', 'helpers'],
    ['google-fonts.d.ts', 'types for font imports'],
  ]);

  sk.rect(20, 290, 560, 120);
  head(290, 'public/', 'read with staticFile()');
  ['images/', 'fonts/', 'audio/', 'video/'].forEach((name, i) => {
    sk.rect(43 + i * 132, 346, 118, 42, { w: 1.6, roughness: 1.1 });
    sk.label({ x: 43 + i * 132 + 59, y: 374, text: name, size: 20, weight: 400, anchor: 'middle', tone: 'ink', fit: 104 });
  });

  sk.group(20, 430, 560, 158);
  head(430, 'out/', 'everything the commands write');
  rows(430 + 78, [
    ['stills/', 'from still'],
    ['sheets/', 'from strip and onion'],
    ['renders/', 'from render'],
  ]);

  ['package.json', 'tsconfig.json', '.gitignore'].forEach((name, i) =>
    sk.say(26 + i * 166, 626, name, { size: 20 }),
  );
  sk.say(26, 662, 'With --html, html/index.html takes the place of src/.');
  return sk.build(600, 690, alt);
}
