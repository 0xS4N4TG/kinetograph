// `@remotion/media` (packages/cli/skills/kinetograph/references/AUTHORING.md §11.3): its `<Audio>` and `<Video>` are this repo's, which take the same props.

import { AUDIO_DATA_SAMPLE_RATE } from './media-utils.js';

export { Audio, Video } from '@kinetographdev/react';
export type { AudioProps, VideoProps } from '@kinetographdev/react';

// The names the package kept for the components it first shipped as experiments.
export { Audio as experimental_Audio, Video as experimental_Video } from '@kinetographdev/react';

/** The rate the audio is mixed at: Remotion's 48 kHz, which is also the rate audio data is decoded at. */
export function getTargetSampleRate(): number {
  return AUDIO_DATA_SAMPLE_RATE;
}
