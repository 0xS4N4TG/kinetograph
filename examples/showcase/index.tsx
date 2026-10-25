// Kinetograph, shown by Kinetograph: a showcase video in the structure and
// pacing of a reference reel, made with nothing but the
// engine's own elements and effects (no photos, no DOM, no browser). Each shot
// is timed to a voiceover line (public/vo); the clock is in common.tsx.
//
//   npx kinetograph still examples/showcase/index.tsx 400 -o out/showcase-400.png
//   npx kinetograph strip examples/showcase/index.tsx -n 16 -o out/showcase-strip.png
//   npx kinetograph render examples/showcase/index.tsx -o out/showcase.mp4
//   npx kinetograph doctor examples/showcase/index.tsx

import React from 'react';
import { Audio, Composition, Sequence, registerRoot, staticFile } from 'remotion';
import { existsSync } from 'node:fs';
import { BACKDROP, DURATION, FPS, H, T, W, fr } from './common.js';
import { Shot1, Shot2, Shot3 } from './shots-a.js';
import { Shot4, Shot5, Shot6 } from './shots-b.js';
import { S7_LENGTH, Shot10, Shot7, Shot8, Shot9 } from './shots-c.js';
import './sound.js';

const shot = (from: number, to: number) => ({ from: fr(from), durationInFrames: fr(to) - fr(from) });

/** The voiceover lines; 09-speed.wav is recorded later, so its slot stays silent until the file exists. */
const VOICE: [string, number][] = [
  ['01-imagine', T.vo.imagine],
  ['02-this-is', T.vo.thisIs],
  ['03-react', T.vo.react],
  ['04-engine', T.vo.engine],
  ['05-type', T.vo.type],
  ['06-looks', T.vo.looks],
  ['07-camera', T.vo.camera],
  ['08-no-chrome', T.vo.noChrome],
  ['09-speed', T.vo.speed],
  ['10-outro', T.vo.outro],
];

export const Showcase: React.FC = () => (
  <>
    {/* Shot 2 starts under shot 1, which drains away in the pixel melt to show it. */}
    <Sequence {...shot(T.s2, T.s3)}>
      <Shot2 />
    </Sequence>
    <Sequence {...shot(T.s1, T.s2 + 1.3)}>
      <Shot1 />
    </Sequence>
    <Sequence {...shot(T.s3, T.s4)}>
      <Shot3 />
    </Sequence>
    <Sequence {...shot(T.s4, T.s5)}>
      <Shot4 />
    </Sequence>
    <Sequence {...shot(T.s5, T.s6)}>
      <Shot5 />
    </Sequence>
    <Sequence {...shot(T.s6, T.s7)}>
      <Shot6 />
    </Sequence>
    {/* The glow of shot 8 rises under the cards of shot 7 as they whip away, so it is below them. */}
    <Sequence {...shot(T.s8, T.s9)}>
      <Shot8 />
    </Sequence>
    <Sequence from={fr(T.s7)} durationInFrames={S7_LENGTH}>
      <Shot7 />
    </Sequence>
    <Sequence {...shot(T.s9, T.s10)}>
      <Shot9 />
    </Sequence>
    <Sequence {...shot(T.s10, T.end)}>
      <Shot10 />
    </Sequence>
    {VOICE.filter(([name]) => existsSync(staticFile(`vo/${name}.wav`))).map(([name, at]) => (
      <Sequence key={name} from={fr(at)}>
        <Audio src={staticFile(`vo/${name}.wav`)} />
      </Sequence>
    ))}
  </>
);

registerRoot(() => (
  <Composition id="Showcase" component={Showcase} durationInFrames={DURATION} fps={FPS} width={W} height={H} background={BACKDROP} />
));
