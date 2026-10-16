// The small pure helpers of `@remotion/timeline-utils`: how a looping sequence is drawn in pieces, where a canvas sits
// on the device's pixel grid, and how a volume reads. Checked against the published package
// (test/fixtures/timeline-utils.json).

// ---- loops ----

export type TimelineLoopDisplay = {
  durationInFrames: number;
  numberOfTimes: number;
  startOffset: number;
};

/** True when the loop shows more than one repeat, so its bar is drawn as tiles. */
export const shouldTileLoopDisplay = (loopDisplay: TimelineLoopDisplay | undefined): loopDisplay is TimelineLoopDisplay =>
  loopDisplay !== undefined && loopDisplay.numberOfTimes > 1;

export type LoopDisplaySegment = {
  loopIndex: number;
  absoluteOffsetInFrames: number;
  loopOffsetInFrames: number;
  durationInFrames: number;
};

/** The pieces of the visible range [offset, offset + duration) that fall in each repeat of a loop. */
export const getLoopDisplaySegments = ({
  displayDurationInFrames,
  displayOffsetInFrames,
  loopDurationInFrames,
}: {
  readonly displayDurationInFrames: number;
  readonly displayOffsetInFrames: number;
  readonly loopDurationInFrames: number;
}): LoopDisplaySegment[] => {
  if (
    !Number.isFinite(displayDurationInFrames) ||
    displayDurationInFrames <= 0 ||
    !Number.isFinite(displayOffsetInFrames) ||
    !Number.isFinite(loopDurationInFrames) ||
    loopDurationInFrames <= 0
  ) {
    return [];
  }
  const end = displayOffsetInFrames + displayDurationInFrames;
  const segments: LoopDisplaySegment[] = [];
  for (
    let loopIndex = Math.floor(displayOffsetInFrames / loopDurationInFrames);
    loopIndex <= Math.floor(end / loopDurationInFrames);
    loopIndex++
  ) {
    const loopStart = loopIndex * loopDurationInFrames;
    const start = Math.max(displayOffsetInFrames, loopStart);
    const durationInFrames = Math.min(end, loopStart + loopDurationInFrames) - start;
    if (durationInFrames <= 0) continue;
    segments.push({
      loopIndex,
      absoluteOffsetInFrames: start,
      loopOffsetInFrames: start - loopStart,
      durationInFrames,
    });
  }
  return segments;
};

/** The width of one repeat of a tiled loop; the whole width otherwise. */
export const getLoopDisplayWidth = ({
  visualizationWidth,
  loopDisplay,
}: {
  visualizationWidth: number;
  loopDisplay: TimelineLoopDisplay | undefined;
}): number =>
  shouldTileLoopDisplay(loopDisplay) ? visualizationWidth / loopDisplay.numberOfTimes : visualizationWidth;

// ---- device pixels ----

/**
 * The bitmap a canvas needs so that its left edge lands on the device's pixel grid: the size in device pixels, and how
 * far into the first pixel the content starts (a fraction of one).
 */
export const getDevicePixelAlignedCanvasLayout = ({
  cssWidth,
  cssHeight,
  containerLeft,
  devicePixelRatio,
}: {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly containerLeft: number;
  readonly devicePixelRatio: number;
}): { height: number; horizontalOffset: number; width: number } => {
  const left = containerLeft * devicePixelRatio;
  const horizontalOffset = cssWidth === 0 ? 0 : left - Math.floor(left);
  return {
    height: Math.ceil(cssHeight * devicePixelRatio),
    horizontalOffset,
    width: Math.ceil(cssWidth * devicePixelRatio + horizontalOffset),
  };
};

/** `position` moved down onto the pixel grid that starts `horizontalOffset` into the first pixel. */
export const snapCanvasPositionToDevicePixel = ({
  position,
  horizontalOffset,
}: {
  readonly position: number;
  readonly horizontalOffset: number;
}): number => Math.floor(position + horizontalOffset) - horizontalOffset;

// ---- frames and volume ----

const LAST_FRAME_EPSILON_IN_SECONDS = 1 / 1e6;

/** `timestamps` with none later than just before the end, so the last frame of a file can be asked for. */
export const clampTimestampsToDuration = ({
  timestamps,
  durationInSeconds,
}: {
  readonly timestamps: readonly number[];
  readonly durationInSeconds: number | null;
}): number[] => {
  if (durationInSeconds === null) return [...timestamps];
  const last = Math.max(0, durationInSeconds - LAST_FRAME_EPSILON_IN_SECONDS);
  return timestamps.map((timestamp) => Math.min(timestamp, last));
};

/** A loudness in dBFS as the Studio shows it. */
export const formatAverageAudioVolume = (volume: number | null): string => {
  if (volume === null) return 'Unavailable';
  return volume === -Infinity ? '−∞ dBFS (silent)' : `${volume.toFixed(1)} dBFS`;
};
