// RN-Skia's `useVideo`: the frames of a video file as `SkImage`s. The picture is the one the file shows at the time of
// the frame being rendered (times `playbackSpeed`, from `seek`, looping), decoded by the engine's own video decoder on
// the CPU (the addon's `readCanvasPicture`, as `onVideoFrame` reads a frame), so a frame is a pure function of the
// file and the frame number.

import { addonFunction, getDomEnvironment, hasAddonFunction } from '@kinetographdev/compat/dom';
import { useTimeline } from '@kinetographdev/react';
import { reportUnsupported } from '../unsupported.js';
import { skiaAddon } from './addon.js';
import { projectFile, SkImage } from './objects.js';
import { unwrap, useDerived, type SharedValue } from './shared-value.js';

export interface UseVideoOptions {
  paused?: SharedValue<boolean> | boolean;
  looping?: SharedValue<boolean> | boolean;
  /** Milliseconds into the file to start at (RN-Skia seeks to it once). */
  seek?: SharedValue<number | null> | number | null;
  volume?: SharedValue<number> | number;
  playbackSpeed?: SharedValue<number> | number;
}

export interface UseVideoResult {
  currentFrame: SharedValue<SkImage | null>;
  /** Milliseconds into the file. */
  currentTime: SharedValue<number>;
  /** Milliseconds. */
  duration: number;
  framerate: number;
  size: { width: number; height: number };
  rotation: 0 | 90 | 180 | 270;
}

interface Probe {
  width: number;
  height: number;
  durationInSeconds: number;
  fps?: number;
  rotation?: number;
}

/** The pictures read last, by file and time: a frame reads `currentFrame` as often as it likes for one decode. */
const recent = new Map<string, SkImage | null>();
/** Fewer than the addon keeps (`FRAME_KEEP`, 16), so a kept picture's bytes are always still there. */
const RECENT = 4;

/** The picture of `src` at `time` seconds, straight-alpha RGBA read on the CPU, as an `SkImage`. */
function pictureAt(src: string, time: number, size: { width: number; height: number }): SkImage | null {
  const key = `${src}\u0000${time}`;
  if (recent.has(key)) return recent.get(key)!;
  const picture = readPicture(src, time, size);
  recent.set(key, picture);
  while (recent.size > RECENT) recent.delete(recent.keys().next().value!);
  return picture;
}

function readPicture(src: string, time: number, size: { width: number; height: number }): SkImage | null {
  const { width, height } = size;
  const request = {
    width,
    height,
    commands: [{ op: 'image', source: { kind: 'video', src, time }, dx: 0, dy: 0, dw: width, dh: height }],
    baseDir: getDomEnvironment().baseDir,
    rect: { x: 0, y: 0, width, height },
  };
  const rgba = addonFunction('readCanvasPicture')(JSON.stringify(request));
  if (rgba === null) return null;
  // A picture lives for its frame: the addon keeps only the last few, so a long video does not fill memory.
  const id = skiaAddon().putFrameData(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
  return new SkImage({ pixels: id, width, height, colorType: 'rgba8888', alphaType: 'unpremul' }, size);
}

/** RN-Skia's `useVideo(source, options)`, with the frame's time in place of the wall clock. */
export function useVideo(source: string | null | undefined, options: UseVideoOptions = {}): UseVideoResult {
  const { frame, config } = useTimeline();
  const file = source === null || source === undefined ? null : projectFile(source, 'video');
  const probe: Probe | null = file === null ? null : (addonFunction('probeMedia')(file, getDomEnvironment().baseDir) as unknown as Probe);
  const duration = probe ? probe.durationInSeconds * 1000 : 0;
  const volume = unwrap(options.volume);
  if (typeof volume === 'number' && volume > 0) {
    reportUnsupported('SkiaCanvas', 'useVideo.volume', String(volume), "a Skia video's sound is not played; add an <Audio> of the file for it");
  }
  if (file !== null && !hasAddonFunction('readCanvasPicture')) {
    throw new Error('useVideo needs an addon with readCanvasPicture: rebuild @kinetographdev/native');
  }
  const currentTime = useDerived(() => {
    const seek = (unwrap(options.seek) as number | null | undefined) ?? 0;
    if (unwrap(options.paused) === true) return seek;
    const speed = (unwrap(options.playbackSpeed) as number | undefined) ?? 1;
    const t = seek + (frame / config.fps) * 1000 * speed;
    if (duration <= 0) return 0;
    // RN-Skia loops by default; without looping the last picture stays.
    if (unwrap(options.looping) === false) return Math.min(Math.max(0, t), duration);
    return ((t % duration) + duration) % duration;
  });
  const currentFrame = useDerived(() =>
    file === null || probe === null ? null : pictureAt(file, currentTime.value / 1000, { width: probe.width, height: probe.height }),
  );
  const rotation = ((((probe?.rotation ?? 0) % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  return {
    currentFrame,
    currentTime,
    duration,
    framerate: probe?.fps ?? 0,
    size: { width: probe?.width ?? 0, height: probe?.height ?? 0 },
    rotation,
  };
}

