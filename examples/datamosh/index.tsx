// Datamosh on footage: the look of a video whose keyframe was dropped. The old picture stays on screen and the new
// shot's motion pushes it around, so pixels smear and melt along the movement.
//
// It is an engine feature of `<Video>` (docs/AUTHORING.md, "Datamosh"): the clip's own H.264 motion vectors move a held
// picture, frame by frame, deterministically. Three shots, 3 s each, 1920x1080 at 30 fps:
//
//   0-90     the transition mosh: the clouds shot is held and the pig's motion drags its pixels around, then the
//            pig plays as it is (the keyframe comes back)
//   90-180   the same clip moshed against itself: the picture one frame before the window is melted by what follows
//   180-270  `mix` 0, 0.5 and 1 side by side: how much of the new shot's detail rides on the old colour
//
// The two clips are the launch film's pool clips (copied into public/).
//
//   npx kinetograph still examples/datamosh/index.tsx 20 -o out/datamosh-20.png
//   npx kinetograph strip examples/datamosh/index.tsx -n 12 -o out/datamosh-strip.png
//   npx kinetograph render examples/datamosh/index.tsx -o out/datamosh.mp4

import React from 'react';
import { Composition, Sequence, registerRoot, staticFile } from 'remotion';
import { Rect, Video } from '@kinetograph/core';

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const SHOT = 90;

const CLOUDS = staticFile('clip-clouds.mp4');
const PIG = staticFile('clip-pig.mp4');

/** The pig's motion moves the clouds: frames 0 to 45 of the shot are the held clouds picture, melted. */
const Transition: React.FC = () => (
  <>
    <Video id="clouds" src={CLOUDS} width={WIDTH} height={HEIGHT} fit="cover" trimBefore={60} />
    <Sequence from={30}>
      <Video
        id="pig"
        src={PIG}
        width={WIDTH}
        height={HEIGHT}
        fit="cover"
        datamosh={{ from: 0, to: 45, hold: { src: CLOUDS, frame: 90 }, mix: 0.2 }}
      />
    </Sequence>
  </>
);

/** One clip against itself: the picture before the window, moved by the motion after it. */
const Self: React.FC = () => (
  <Video
    id="pig-self"
    src={PIG}
    width={WIDTH}
    height={HEIGHT}
    fit="cover"
    trimBefore={50}
    datamosh={{ from: 5, to: 70, mix: 0 }}
  />
);

const TILE_W = 640;
const TILE_H = 360;

/** The same transition at three residual weights. */
const Mix: React.FC = () => (
  <>
    <Rect width={WIDTH} height={HEIGHT} fill="#101014" />
    {[0, 0.5, 1].map((mix, i) => (
      <Video
        key={mix}
        id={`mix-${mix}`}
        src={PIG}
        x={i * TILE_W}
        y={(HEIGHT - TILE_H) / 2}
        width={TILE_W}
        height={TILE_H}
        fit="cover"
        trimBefore={30}
        datamosh={{ from: 0, to: SHOT, hold: { src: CLOUDS, frame: 90 }, mix }}
      />
    ))}
  </>
);

const Datamosh: React.FC = () => (
  <>
    <Sequence from={0} durationInFrames={SHOT} name="transition">
      <Transition />
    </Sequence>
    <Sequence from={SHOT} durationInFrames={SHOT} name="self">
      <Self />
    </Sequence>
    <Sequence from={2 * SHOT} durationInFrames={SHOT} name="mix">
      <Mix />
    </Sequence>
  </>
);

registerRoot(() => (
  <Composition
    id="Datamosh"
    component={Datamosh}
    durationInFrames={3 * SHOT}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
    background="#000000"
  />
));
