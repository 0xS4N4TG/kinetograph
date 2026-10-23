// v2-captions: the narration as word-by-word captions over footage with a blob-tracking overlay.
// Placeholder footage: pool/clip-pig.mp4 (looped), with its blobs from blobs/clip-pig.json.

import React from 'react';
import { AbsoluteFill, Video, staticFile, useCurrentFrame } from 'remotion';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';
import { FPS, H, W } from '../common.js';
import wordsFile from '../captions/words.json';
import pigBlobs from '../blobs/clip-pig.json';
import { BlobOverlay, type BlobData } from './blobs.js';
import { CaptionAudio, Captions, type CaptionFile } from './captions.js';


export const CAPTIONS_FILE = wordsFile as CaptionFile;
export const CAPTIONS_FRAMES = Math.ceil((wordsFile as { duration: number }).duration * FPS);

export interface CaptionsSceneProps {
  /** A words.json (any timings in the same shape). */
  file: CaptionFile;
  /** The footage under the captions, and the blobs analysed from it (tools/blobs/analyse.mjs). */
  clip: string;
  blobs: BlobData;
}

export const captionsDefaults: CaptionsSceneProps = { file: CAPTIONS_FILE, clip: 'pool/clip-pig.mp4', blobs: pigBlobs as BlobData };

export const CaptionsScene: React.FC<Partial<CaptionsSceneProps>> = (props) => {
  const { file, clip, blobs } = { ...captionsDefaults, ...props };
  const frame = useCurrentFrame();
  const mono = loadMono('normal', { weights: ['500'] }).fontFamily; // on first use, see captions.tsx
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      <Video src={staticFile(clip)} loop muted width={W} height={H} fit="cover" />
      {/* the footage loops, and so do its blobs */}
      <BlobOverlay data={blobs} frame={frame % blobs.frames} width={W} height={H} mono={mono} />
      <Captions file={file} />
      <CaptionAudio file={file} />
    </AbsoluteFill>
  );
};
