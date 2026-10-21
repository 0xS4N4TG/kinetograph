// `<Artifact>`: a file a Remotion render writes next to the video (a frame's thumbnail, a text or binary file made by
// the composition). It records itself when it is rendered (`artifacts.ts`) and `kinetograph render` writes the files that
// were recorded in the frames it rendered into the folder of the video. It draws nothing.

import { useTimeline } from '@kinetograph/react';
import type { ReactNode } from 'react';
import { assertValidArtifactFilename, recordArtifact } from './artifacts.js';

const Thumbnail = Symbol('Thumbnail');

export type DownloadBehavior = { type: 'play-in-browser' } | { type: 'download'; fileName: string | null };

export interface ArtifactProps {
  /** The file's name in the render's output. */
  filename: string;
  /** Text, binary data, or `Artifact.Thumbnail` for the picture of this frame. */
  content: string | Uint8Array | typeof Thumbnail;
  downloadBehavior?: DownloadBehavior | null;
}

function ArtifactComponent({ filename, content }: ArtifactProps): ReactNode {
  const { absoluteFrame } = useTimeline();
  assertValidArtifactFilename(filename);
  if (typeof content !== 'string' && !(content instanceof Uint8Array) && content !== Thumbnail) {
    throw new Error(`<Artifact filename=${JSON.stringify(filename)}> content must be a string, a Uint8Array or Artifact.Thumbnail.`);
  }
  recordArtifact({ filename, content: content === Thumbnail ? 'thumbnail' : content, frame: Math.round(absoluteFrame) });
  return null;
}

export const Artifact = Object.assign(ArtifactComponent, { Thumbnail } as { Thumbnail: typeof Thumbnail });
