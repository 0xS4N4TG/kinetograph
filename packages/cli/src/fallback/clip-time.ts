// The time rules of a `video` layer (docs/SCENE.md "video", rules 1 to 4), for the Chrome page's `<Video>`: the page
// sends the clip's frame and the clip's trims, this finds the second of the file to decode. Rule 5, which picture is
// the one at that second, is the addon's `videoFrame`, the same code the video layer's decoder runs.

export interface ClipMoment {
  /** The clip's frame `(frame - from) * playbackRate` (rule 1); fractional on a motion-blur sub-frame. */
  n: number;
  /** The scene's frame rate. */
  fps: number;
  trimBefore: number;
  trimAfter: number | null;
  loop: boolean;
}

/** Half a millisecond: less than any frame is long, more than a tick of any container's time base. */
const BEFORE_END = 0.0005;

/**
 * Seconds after the stream's first picture that the clip shows at `moment`. `durationInSeconds` is the stream's. A
 * time at the clip's end is moved just before it, since the clip shows the last picture *before* its end (rule 5) and
 * `videoFrame` takes the end to be the stream's.
 */
export function clipSourceTime(moment: ClipMoment, durationInSeconds: number): number {
  const { fps, trimBefore, trimAfter } = moment;
  // 2. The clip's length in scene frames.
  const end = trimAfter === null ? durationInSeconds : trimAfter / fps;
  const length = end * fps - trimBefore;
  // 3. Wrapped (modulo, so frames before `from` wrap too) or clamped into the clip.
  let n = moment.n;
  if (moment.loop) {
    n = length > 0 ? ((n % length) + length) % length : 0;
  } else {
    n = Math.min(Math.max(n, 0), Math.max(length, 0));
  }
  // 4. Seconds from the first picture.
  const seconds = (trimBefore + n) / fps;
  return seconds >= end ? Math.max(0, end - BEFORE_END) : seconds;
}

/** A GIF's time: `loop` wraps it round the animation, else the last picture is held (the addon holds it). */
export function gifSourceTime(time: number, durationInSeconds: number, loop: boolean): number {
  if (!loop || durationInSeconds <= 0) return time;
  return ((time % durationInSeconds) + durationInSeconds) % durationInSeconds;
}
