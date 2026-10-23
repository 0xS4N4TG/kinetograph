// `<Video datamosh>` needs the clip's decoder to export motion vectors (crates/core/src/datamosh.rs). The engine draws a
// clip in any other codec plain; this tells the frame so, and `--strict` then stops the render.

import { setDatamoshCheck } from '@kinetograph/react';
import { probeMedia } from './media-utils.js';
import { reportUnsupported } from './unsupported.js';

/** The codecs whose FFmpeg decoder exports motion vectors: the same list as `VECTOR_CODECS` in crates/core/src/datamosh.rs. */
const VECTOR_CODECS = ['h264', 'mpeg4', 'mpeg2video', 'mpeg1video', 'h263', 'h263p', 'flv1'];

export function installDatamoshCheck(): void {
  setDatamoshCheck((src) => {
    let codec: string | undefined;
    try {
      codec = probeMedia(src, { cache: true }).videoCodec;
    } catch {
      // A file that cannot be read is the native stage's error, with its own message.
      return;
    }
    if (codec !== undefined && !VECTOR_CODECS.includes(codec)) {
      reportUnsupported('Video', 'datamosh', codec, 'the codec exports no motion vectors (H.264 and MPEG-4 do), so the clip is drawn without the datamosh');
    }
  });
}

installDatamoshCheck();
