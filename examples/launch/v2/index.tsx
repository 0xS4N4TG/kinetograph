// The launch film's v2 scenes, registered next to `launch` in ../index.tsx. Each is its own composition so it can be
// rendered and judged alone; `v2` plays them in order for preview.
//
// Scene list:
//   v2-captions  word-by-word animated captions over footage with a blob-tracking overlay.
//   v2-receipts  a collage of thermal-printed receipts with dithered photos.
//   v2-datamosh  TODO: a native datamosh engine effect is being built on another branch; add the scene when it lands.

import React from 'react';
import { Composition } from 'remotion';
import { FPS, H, W } from '../common.js';
import { CAPTIONS_FRAMES, CaptionsScene, captionsDefaults } from './captions-scene.js';

export const V2Compositions: React.FC = () => (
  <>
    <Composition id="v2-captions" component={CaptionsScene} width={W} height={H} fps={FPS} durationInFrames={CAPTIONS_FRAMES} defaultProps={captionsDefaults} />
  </>
);
