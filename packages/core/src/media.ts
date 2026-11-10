// `@remotion/media` (packages/cli/skills/kinetograph-markup/references/AUTHORING.md §11.3): its `<Audio>` and `<Video>` are this repo's, which take the same props.

import { AUDIO_DATA_SAMPLE_RATE } from './media-utils.js';

export { Audio } from '@kinetographdev/react';
export type { AudioProps } from '@kinetographdev/react';
// `<Video>` also takes Remotion's `effects` and `effectsOutputSize` (video.tsx).
export { Video } from './video.js';
export type { VideoProps } from './video.js';

// The names the package kept for the components it first shipped as experiments.
export { Audio as experimental_Audio } from '@kinetographdev/react';
export { Video as experimental_Video } from './video.js';

/** The rate the audio is mixed at: Remotion's 48 kHz, which is also the rate audio data is decoded at. */
export function getTargetSampleRate(): number {
  return AUDIO_DATA_SAMPLE_RATE;
}
