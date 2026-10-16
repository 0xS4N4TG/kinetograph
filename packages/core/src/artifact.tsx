// `<Artifact>`: a file a Remotion render writes next to the video (a frame's thumbnail, a text or binary file made by
// the composition). Kinetograph's render produces the video and nothing else, so the component is accepted, draws
// nothing and says once that the file is not written.

import type { ReactNode } from 'react';
import { warnOnce } from './warn.js';

const Thumbnail = Symbol('Thumbnail');

export type DownloadBehavior = { type: 'play-in-browser' } | { type: 'download'; fileName: string | null };

export interface ArtifactProps {
  /** The file's name in the render's output. */
  filename: string;
  /** Text, binary data, or `Artifact.Thumbnail` for the picture of this frame. */
  content: string | Uint8Array | typeof Thumbnail;
  downloadBehavior?: DownloadBehavior | null;
}

function ArtifactComponent(_props: ArtifactProps): ReactNode {
  warnOnce('Artifact', "<Artifact> files are not written: Kinetograph's render produces the video and no other files.");
  return null;
}

export const Artifact = Object.assign(ArtifactComponent, { Thumbnail } as { Thumbnail: typeof Thumbnail });
