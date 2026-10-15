// `@remotion/media-utils` (docs/AUTHORING.md §11.3): `getVideoMetadata`, read
// from the file's header by the addon's `probeMedia`. Stream 2.

import type { MediaInfo } from '@kinetograph/native';

export type ProbeMedia = (path: string, baseDir?: string) => MediaInfo;

export interface VideoMetadata {
  durationInSeconds: number;
  width: number;
  height: number;
  aspectRatio: number;
  isRemote: false;
  /** Not in Remotion's: the stream's average frame rate. */
  fps: number | null;
}

/** Sets the addon's `probeMedia` (the host does, as with `setLayoutText`; tests pass a stub, `null` goes back). */
export function setMediaProbe(_fn: ProbeMedia | null): void {
  throw new Error('not implemented: setMediaProbe (docs/AUTHORING.md §11.3)');
}

export function getVideoMetadata(_src: string): Promise<VideoMetadata> {
  throw new Error('not implemented: getVideoMetadata (docs/AUTHORING.md §11.3)');
}
