import { Sketch, type Diagram } from '../sketch.ts';

export const title = 'A TSX project';

/** The folder drawing of a TSX project, or of an HTML one (`init --html`), where `html/index.html` takes the place of `src/`. */
export function draw(html: boolean, alt: string): Diagram {
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

  // The HTML project has one file where src/ has five, so everything below it moves up by `dy`.
  const dy = html ? -94 : 0;
  sk.rect(20, 56, 560, 214 + dy);
  head(56, html ? 'html/' : 'src/', 'your code');
  rows(
    56 + 78,
    html
      ? [['index.html', 'the page and its timeline']]
      : [
          ['index.tsx', 'registerRoot and the compositions'],
          ['scenes/Title.tsx', 'the starter scene'],
          ['components/', 'pieces used by more than one scene'],
          ['lib/', 'helpers'],
          ['google-fonts.d.ts', 'types for font imports'],
        ],
  );

  sk.rect(20, 290 + dy, 560, 120);
  head(290 + dy, 'public/', 'read with staticFile()');
  ['images/', 'fonts/', 'audio/', 'video/'].forEach((name, i) => {
    sk.rect(43 + i * 132, 346 + dy, 118, 42, { w: 1.6, roughness: 1.1 });
    sk.label({ x: 43 + i * 132 + 59, y: 374 + dy, text: name, size: 20, weight: 400, anchor: 'middle', tone: 'ink', fit: 104 });
  });

  sk.group(20, 430 + dy, 560, 158);
  head(430 + dy, 'out/', 'everything the commands write');
  rows(430 + dy + 78, [
    ['stills/', 'from still'],
    ['sheets/', 'from strip and onion'],
    ['renders/', 'from render'],
  ]);

  (html ? ['package.json', '.gitignore'] : ['package.json', 'tsconfig.json', '.gitignore']).forEach((name, i) =>
    sk.say(26 + i * 166, 626 + dy, name, { size: 20 }),
  );
  return sk.build(600, 662 + dy, alt);
}

export const build = (alt: string): Diagram => draw(false, alt);
