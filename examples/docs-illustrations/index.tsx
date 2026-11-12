// Three short loops for the docs, drawn by Kinetograph itself: the pipeline, a frame as a pure function, and
// Studio's loop. Each is 6 seconds at 30 fps and loops with no seam.
//
//   npx kinetograph render examples/docs-illustrations/index.tsx --comp Pipeline -o out/docs/pipeline.mp4
//   npx kinetograph render examples/docs-illustrations/index.tsx --comp PureFrame -o out/docs/pure-frame.mp4
//   npx kinetograph render examples/docs-illustrations/index.tsx --comp StudioLoop -o out/docs/studio-loop.mp4
// See render.sh for the sizes, the poster frames and the checks.

import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { DURATION, FPS, HEIGHT, WIDTH } from './kit';
import { Pipeline } from './pipeline';
import { PureFrame } from './pure-frame';
import { StudioLoop } from './studio-loop';

registerRoot(() => (
  <>
    <Composition id="Pipeline" component={Pipeline} durationInFrames={DURATION} fps={FPS} width={WIDTH} height={HEIGHT} />
    <Composition id="PureFrame" component={PureFrame} durationInFrames={DURATION} fps={FPS} width={WIDTH} height={HEIGHT} />
    <Composition id="StudioLoop" component={StudioLoop} durationInFrames={DURATION} fps={FPS} width={WIDTH} height={HEIGHT} />
  </>
));
