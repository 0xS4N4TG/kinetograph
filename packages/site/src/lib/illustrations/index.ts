import type { Diagram } from '../sketch.ts';
import * as effectsChain from './effects-chain.ts';
import * as pipeline from './pipeline.ts';
import * as projectStructure from './project-structure.ts';
import * as pureFrame from './pure-frame.ts';
import * as renderOptions from './render-options.ts';
import * as renderPaths from './render-paths.ts';
import * as sequences from './sequences.ts';
import * as studioLoop from './studio-loop.ts';
import * as videoMatting from './video-matting.ts';

/** The docs illustrations, by file name in public/docs-media/illustrations. `scripts/illustrations.mjs` draws them. */
export const illustrations: Record<string, { title: string; build: (alt: string) => Diagram }> = {
  'effects-chain': effectsChain,
  pipeline,
  'project-structure': projectStructure,
  'pure-frame': pureFrame,
  'render-options': renderOptions,
  'render-paths': renderPaths,
  sequences,
  'studio-loop': studioLoop,
  'video-matting': videoMatting,
};
