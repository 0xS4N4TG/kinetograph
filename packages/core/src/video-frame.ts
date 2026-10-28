// `onVideoFrame` of `<Video>`, `<OffthreadVideo>` and `<Html5Video>` (packages/cli/skills/kinetograph/references/AUTHORING.md
// §7.1): Remotion hands the project each shown frame as a `CanvasImageSource`. Here the frame is a `VideoFramePicture`
// that names the file and the instant the video layer shows at that composition frame (the clip rules of SCENE.md,
// "video"); the renderer decodes it, with the same decoder as a video layer, when a canvas draws or reads it.

import { setVideoFrameDelivery } from '@kinetographdev/react';
import { VideoFramePicture, videoClipTime } from '@kinetographdev/scene';
import { probeMedia } from './media-utils.js';

export function installVideoFrameDelivery(): void {
  setVideoFrameDelivery(({ src, clip }, callback) => {
    let info;
    try {
      info = probeMedia(src, { cache: true });
    } catch (error) {
      throw new Error(`onVideoFrame: cannot read the video ${JSON.stringify(src)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const { time, end } = videoClipTime(clip, info.durationInSeconds);
    const frame = new VideoFramePicture(src, time, info.width, info.height, end);
    // After every effect of the frame has run (a canvas ref the project's own effect sets up is there), and before the
    // frame loop reads the tree. A handler that throws is a page error, as in a browser.
    void Promise.resolve().then(() => callback(frame));
  });
}

installVideoFrameDelivery();
