// The frame strip half of `@remotion/timeline-utils` (the row of thumbnails on a video bar): a cache of decoded
// frames, the timestamp slots a strip of a given width needs, and drawing frames into them. Checked against the
// published package (test/fixtures/timeline-utils.json).
//
// What needs the file's pictures decoded to WebCodecs `VideoFrame`s (`extractFrames`, a resize that builds a new frame,
// and a strip with a slot no cached frame covers) is exported and throws `UnsupportedApiError`: the addon decodes
// video inside the renderer, to layers, and has no call that hands a picture to JavaScript.

import { UnsupportedApiError } from '../unsupported.js';
import { snapCanvasPositionToDevicePixel } from './layout.js';
import type { CanvasLike, Context2DLike, VideoFrameLike } from './types.js';

const PACKAGE = '@remotion/timeline-utils';

const noFrames = (api: string) =>
  new UnsupportedApiError(
    PACKAGE,
    api,
    'the addon decodes video inside the renderer and has no call that returns a picture to JavaScript',
  );

/** WebCodecs counts time in microseconds. */
export const WEBCODECS_TIMESCALE = 1_000_000;
/** How far from a slot's timestamp, in microseconds, a frame may be and still be drawn there. */
const MAX_TIME_DEVIATION = WEBCODECS_TIMESCALE * 0.05;

// ---- the cache of frames ----

export type FrameDatabaseKey = string & { __brand: 'FrameDatabaseKey' };

const KEY_SEPARATOR = '|';
const MAX_CACHE_SIZE_BYTES = 10 * 1024 * 1024;

export const makeFrameDatabaseKey = (src: string, timestamp: number): FrameDatabaseKey =>
  `${src}${KEY_SEPARATOR}${timestamp}` as FrameDatabaseKey;

export const getFrameDatabaseKeyPrefix = (src: string): string => `${src}${KEY_SEPARATOR}`;

export const getTimestampFromFrameDatabaseKey = (key: FrameDatabaseKey): number => {
  const parts = key.split(KEY_SEPARATOR);
  return Number(parts[parts.length - 1]);
};

type FrameEntry = {
  frame: VideoFrameLike;
  /** Order of use, not a time: the least recently used frame has the least. */
  lastUsed: number;
  size: number;
};

export const frameDatabase = new Map<FrameDatabaseKey, FrameEntry>();
export const aspectRatioCache = new Map<string, number>();

let totalCacheSize = 0;
let uses = 0;

export const getAspectRatioFromCache = (src: string): number | null => aspectRatioCache.get(src) || null;

function evictLeastRecentlyUsed(): void {
  while (totalCacheSize > MAX_CACHE_SIZE_BYTES && frameDatabase.size > 0) {
    let oldest: FrameDatabaseKey | undefined;
    let oldestUse = Infinity;
    for (const [key, entry] of frameDatabase) {
      if (entry.lastUsed < oldestUse) {
        oldestUse = entry.lastUsed;
        oldest = key;
      }
    }
    if (!oldest) break;
    const entry = frameDatabase.get(oldest)!;
    totalCacheSize -= entry.size;
    entry.frame.close();
    frameDatabase.delete(oldest);
  }
}

/** Keeps `frame` under `key` (closing the one that was there), and drops the least recently used past 10 MiB. */
export const addFrameToCache = (key: FrameDatabaseKey, frame: VideoFrameLike): void => {
  const existing = frameDatabase.get(key);
  if (existing) {
    totalCacheSize -= existing.size;
    existing.frame.close();
  }
  const size = frame.allocationSize();
  totalCacheSize += size;
  frameDatabase.set(key, { frame, lastUsed: uses++, size });
  evictLeastRecentlyUsed();
};

// ---- slots: the timestamps a strip is made of ----

type Slots = Map<number, number | undefined>;

/** How long, in microseconds, one thumbnail of a strip covers. */
export const getDurationOfOneFrame = ({
  visualizationWidth,
  aspectRatio,
  segmentDuration,
  frameHeight,
}: {
  visualizationWidth: number;
  aspectRatio: number;
  segmentDuration: number;
  frameHeight: number;
}): number => {
  const framesInWidth = visualizationWidth / (frameHeight * aspectRatio);
  return (segmentDuration / framesInWidth) * WEBCODECS_TIMESCALE;
};

/** A fraction of one half or more rounds up. */
const roundHalfUp = (value: number) => (value % 1 >= 0.49999999 ? Math.ceil(value) : Math.floor(value));

/** The timestamps (microseconds) of the thumbnails that cover `visualizationWidth`, one more than fits. */
export const calculateTimestampSlots = ({
  visualizationWidth,
  fromSeconds,
  segmentDuration,
  aspectRatio,
  frameHeight,
}: {
  visualizationWidth: number;
  fromSeconds: number;
  segmentDuration: number;
  aspectRatio: number;
  frameHeight: number;
}): number[] => {
  const framesFit = Math.ceil(visualizationWidth / (frameHeight * aspectRatio));
  const oneFrame = getDurationOfOneFrame({ visualizationWidth, aspectRatio, segmentDuration, frameHeight });
  const slots: number[] = [];
  for (let i = 0; i < framesFit + 1; i++) {
    const target = fromSeconds * WEBCODECS_TIMESCALE + oneFrame * (i + 0.5);
    slots.push((Math.round(roundHalfUp(target / oneFrame)) - 1) * oneFrame);
  }
  return slots;
};

/** Adds an empty slot to `filledSlots` for each timestamp the strip needs that it does not have yet. */
export const ensureSlots = ({
  filledSlots,
  naturalWidth,
  fromSeconds,
  toSeconds,
  aspectRatio,
  frameHeight,
}: {
  filledSlots: Slots;
  naturalWidth: number;
  fromSeconds: number;
  toSeconds: number;
  aspectRatio: number;
  frameHeight: number;
}): void => {
  const slots = calculateTimestampSlots({
    visualizationWidth: naturalWidth,
    fromSeconds,
    segmentDuration: toSeconds - fromSeconds,
    aspectRatio,
    frameHeight,
  });
  for (const timestamp of slots) {
    if (!filledSlots.has(timestamp)) filledSlots.set(timestamp, undefined);
  }
};

// ---- drawing ----

type Layout = {
  ctx: Context2DLike;
  filledSlots: Slots;
  segmentDuration: number;
  fromSeconds: number;
  devicePixelRatio: number;
  frameHeight: number;
  horizontalOffset: number;
};

/** Draws `frame` in the slot at `timestamp` and records the timestamp of the frame that fills it. */
export const drawSlot = ({
  frame,
  ctx,
  filledSlots,
  visualizationWidth,
  timestamp,
  segmentDuration,
  fromSeconds,
  devicePixelRatio,
  frameHeight,
  horizontalOffset,
}: Layout & { frame: VideoFrameLike; visualizationWidth: number; timestamp: number }): void => {
  const oneFrame = getDurationOfOneFrame({
    visualizationWidth,
    aspectRatio: frame.displayWidth / frame.displayHeight,
    segmentDuration,
    frameHeight,
  });
  const index = (timestamp - fromSeconds * WEBCODECS_TIMESCALE) / oneFrame;
  const thumbnailWidth = frame.displayWidth / devicePixelRatio;
  const left = snapCanvasPositionToDevicePixel({ horizontalOffset, position: index * thumbnailWidth });
  const right = snapCanvasPositionToDevicePixel({ horizontalOffset, position: index * thumbnailWidth + thumbnailWidth });
  ctx.drawImage(frame, left, 0, right - left, frame.displayHeight / devicePixelRatio);
  filledSlots.set(timestamp, frame.timestamp);
};

/** Fills each slot from the cached frame of `src` nearest to it, unless the slot already has a nearer one. */
export const fillWithCachedFrames = ({
  ctx,
  naturalWidth,
  filledSlots,
  src,
  segmentDuration,
  fromSeconds,
  devicePixelRatio,
  frameHeight,
  horizontalOffset,
}: Layout & { naturalWidth: number; src: string }): void => {
  const prefix = getFrameDatabaseKeyPrefix(src);
  const keys = [...frameDatabase.keys()].filter((key) => key.startsWith(prefix));
  for (const timestamp of [...filledSlots.keys()]) {
    let best: FrameDatabaseKey | undefined;
    let bestDistance = Infinity;
    for (const key of keys) {
      const distance = Math.abs(getTimestampFromFrameDatabaseKey(key) - timestamp);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = key;
      }
    }
    const entry = best === undefined ? undefined : frameDatabase.get(best);
    if (!entry) continue;
    const current = filledSlots.get(timestamp);
    if (current && Math.abs(current - timestamp) <= Math.abs(entry.frame.timestamp - timestamp)) continue;
    entry.lastUsed = uses++;
    drawSlot({
      ctx,
      frame: entry.frame,
      filledSlots,
      visualizationWidth: naturalWidth,
      timestamp,
      segmentDuration,
      fromSeconds,
      devicePixelRatio,
      frameHeight,
      horizontalOffset,
    });
  }
};

/** Draws `frame` in every slot within 50 ms of it that it fits better than the frame already there. */
export const fillFrameWhereItFits = ({
  frame,
  filledSlots,
  ctx,
  visualizationWidth,
  segmentDuration,
  fromSeconds,
  devicePixelRatio,
  frameHeight,
  horizontalOffset,
}: Layout & { frame: VideoFrameLike; visualizationWidth: number }): void => {
  for (const slot of [...filledSlots.keys()]) {
    if (Math.abs(slot - frame.timestamp) > MAX_TIME_DEVIATION) continue;
    const filled = filledSlots.get(slot);
    if (filled && Math.abs(filled - slot) <= Math.abs(filled - frame.timestamp)) continue;
    drawSlot({
      ctx,
      frame,
      filledSlots,
      visualizationWidth,
      timestamp: slot,
      segmentDuration,
      fromSeconds,
      devicePixelRatio,
      frameHeight,
      horizontalOffset,
    });
  }
};

// ---- decoding ----

type ExtractFramesOptions = {
  track: { width: number; height: number };
  container: string;
  durationInSeconds: number | null;
};

export type ExtractFramesTimestampsInSecondsFn = (options: ExtractFramesOptions) => Promise<number[]> | number[];

export type ExtractFramesProps = {
  src: string;
  timestampsInSeconds: number[] | ExtractFramesTimestampsInSecondsFn;
  /** Called with each picture; mediabunny's `VideoSample`. */
  onVideoSample: (sample: any) => void;
  signal?: AbortSignal;
  repeatLastFrame?: boolean;
};

/** Decodes the pictures of a video at the given times. Not supported (see the top of this file). */
export async function extractFrames(_props: ExtractFramesProps): Promise<void> {
  throw noFrames('extractFrames()');
}

/** `frame` scaled by `scale`. A scale of 1 is the frame itself; any other builds a `VideoFrame`, which does not exist here. */
export const resizeVideoFrame = ({ frame, scale }: { frame: VideoFrameLike; scale: number }): VideoFrameLike => {
  if (scale === 1) return frame;
  throw new UnsupportedApiError(
    PACKAGE,
    'resizeVideoFrame() with a scale other than 1',
    'there is no VideoFrame class to build the resized frame with',
  );
};

export type RenderFrameStripToCanvasOptions = {
  readonly canvas: CanvasLike;
  readonly src: string;
  readonly fromSeconds: number;
  readonly toSeconds: number;
  readonly width: number;
  readonly frameHeight: number;
  readonly devicePixelRatio: number;
  readonly horizontalOffset: number;
  readonly signal?: AbortSignal;
};

/**
 * Draws the thumbnails of `src` from `fromSeconds` to `toSeconds` into `canvas`, as many as fit `width`, from the
 * frames in the cache (`addFrameToCache`). Frames that are not cached would have to be decoded, which is not supported,
 * so a strip with a slot the cache cannot fill, or for a file whose aspect ratio is not cached, throws.
 */
export const renderFrameStripToCanvas = async ({
  canvas,
  src,
  fromSeconds,
  toSeconds,
  width,
  frameHeight,
  devicePixelRatio,
  horizontalOffset,
  signal,
}: RenderFrameStripToCanvasOptions): Promise<void> => {
  const drawingWidth = Math.max(1, width);
  const naturalWidth = Math.max(1, Math.ceil(width + horizontalOffset));
  const naturalHeight = Math.max(1, Math.ceil(frameHeight));
  const segmentDuration = toSeconds - fromSeconds;
  canvas.width = naturalWidth;
  canvas.height = naturalHeight;
  if (segmentDuration <= 0 || signal?.aborted) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get 2d context');
  ctx.clearRect(0, 0, naturalWidth, naturalHeight);
  ctx.setTransform(1, 0, 0, 1, horizontalOffset, 0);

  // The aspect ratio of a file is known from a frame of it, which has to be decoded once.
  const aspectRatio = getAspectRatioFromCache(src);
  if (aspectRatio === null) throw noFrames('renderFrameStripToCanvas() for a file with no cached frames');
  const filledSlots: Slots = new Map();
  ensureSlots({ filledSlots, naturalWidth: drawingWidth, fromSeconds, toSeconds, aspectRatio, frameHeight });
  fillWithCachedFrames({
    ctx,
    naturalWidth: drawingWidth,
    filledSlots,
    src,
    segmentDuration,
    fromSeconds,
    devicePixelRatio,
    frameHeight,
    horizontalOffset,
  });
  if ([...filledSlots.values()].some((value) => value === undefined)) {
    throw noFrames('renderFrameStripToCanvas() for frames that are not in the cache');
  }
};
