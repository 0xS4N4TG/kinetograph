// The URLs the Chrome page asks its driver for (docs/COMPAT.md §6.2). The driver's local server answers them: files
// by path, and the picture of a video or GIF at a moment, which it decodes with the addon's `videoFrame`.

/** A URL as it is; anything else is a file path, which the driver resolves against the project. */
export function fileUrl(src: string): string {
  if (/^(https?:|data:|blob:)/i.test(src)) return src;
  return `/@file?path=${encodeURIComponent(src)}`;
}

export interface VideoMoment {
  src: string;
  /** The clip's frame, `(frame - from) * playbackRate` (docs/SCENE.md "video", rule 1): fractional on sub-frames. */
  n: number;
  /** The scene's frame rate: a clip's frame is a scene frame. */
  fps: number;
  trimBefore: number;
  trimAfter: number | null;
  loop: boolean;
}

/** The picture a `video` layer would show: the driver applies the time rules of SCENE.md and decodes it. */
export function videoUrl(moment: VideoMoment): string {
  const query = new URLSearchParams({
    src: moment.src,
    n: String(moment.n),
    fps: String(moment.fps),
    trimBefore: String(moment.trimBefore),
    loop: moment.loop ? '1' : '0',
  });
  if (moment.trimAfter !== null) query.set('trimAfter', String(moment.trimAfter));
  return `/@video?${query.toString()}`;
}

/** The picture a `gif` layer shows `time` seconds in (SCENE.md "gif"); `loop` wraps `time` round the animation. */
export function gifUrl(src: string, time: number, loop: boolean): string {
  return `/@gif?${new URLSearchParams({ src, time: String(time), loop: loop ? '1' : '0' }).toString()}`;
}
