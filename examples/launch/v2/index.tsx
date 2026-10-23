// The launch film's v2 scenes, registered next to `launch` in ../index.tsx. Each is its own composition so it can be
// rendered and judged alone; `v2` plays them in order for preview.
//
// Scene list:
//   v2-captions  word-by-word animated captions over footage with a blob-tracking overlay.
//   v2-receipts  a collage of thermal-printed receipts with dithered photos.
//   v2-datamosh  TODO: a native datamosh engine effect is being built on another branch; add the scene here (and
//                to the `v2` series below) when it lands. No code yet.

import React from 'react';
import { AbsoluteFill, Composition, Sequence, Series, interpolate, useCurrentFrame } from 'remotion';
import { CLAMP, FPS, H, W } from '../common.js';
import { CAPTIONS_FRAMES, CaptionsScene, captionsDefaults } from './captions-scene.js';
import { RECEIPTS_FRAMES, ReceiptsScene } from './receipts-scene.js';

/** A short white flash over the cut between the scenes: up in 2 frames, down in 4. */
const CUT = 6;
const CutFlash: React.FC = () => {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{ background: '#FFFFFF', opacity: interpolate(frame, [0, 2, CUT - 1], [0, 0.85, 0], CLAMP) }} />;
};

/** The scenes in order, for preview. */
const V2: React.FC = () => (
  <AbsoluteFill>
    <Series>
      <Series.Sequence durationInFrames={CAPTIONS_FRAMES}><CaptionsScene /></Series.Sequence>
      <Series.Sequence durationInFrames={RECEIPTS_FRAMES}><ReceiptsScene /></Series.Sequence>
    </Series>
    <Sequence from={CAPTIONS_FRAMES - 2} durationInFrames={CUT}><CutFlash /></Sequence>
  </AbsoluteFill>
);

export const V2Compositions: React.FC = () => (
  <>
    <Composition id="v2-captions" component={CaptionsScene} width={W} height={H} fps={FPS} durationInFrames={CAPTIONS_FRAMES} defaultProps={captionsDefaults} />
    <Composition id="v2-receipts" component={ReceiptsScene} width={W} height={H} fps={FPS} durationInFrames={RECEIPTS_FRAMES} />
    <Composition id="v2" component={V2} width={W} height={H} fps={FPS} durationInFrames={CAPTIONS_FRAMES + RECEIPTS_FRAMES} />
  </>
);
