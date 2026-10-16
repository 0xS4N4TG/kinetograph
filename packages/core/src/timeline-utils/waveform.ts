// The audio waveform half of `@remotion/timeline-utils` (what the Studio draws on an audio bar): peaks at 100 per
// second of sound, slicing them to what a bar shows, and drawing them as bars into a canvas. Checked against the
// published package (test/fixtures/timeline-utils.json).
//
// Loading differs from the published package in where the sound comes from: it reads a file the addon decodes
// (`@kinetograph/core/media-utils`' `readAudioData`: ffmpeg, 48 kHz, whole file at once), not a URL through
// mediabunny, so a source is a path, there is no worker, and the peaks of a file are there after one call.

import { parseColor } from '../colors.js';
import { readAudioData } from '../media-utils.js';
import { UnsupportedApiError } from '../unsupported.js';
import { getLoopDisplaySegments, type TimelineLoopDisplay } from './layout.js';
import type { CanvasLike, InputAudioTrackLike } from './types.js';

/** Peaks per second of sound. */
export const TARGET_SAMPLE_RATE = 100;

// ---- maxima: for each run of 2^n peaks, the largest, so the largest in a range is a few reads ----

export type WaveformMaxima = readonly Float32Array[];

const maximaCache = new WeakMap<Float32Array, { maxima: Float32Array[]; completedPeaks: number }>();

/** The levels above `peaks` (each half the length of the one below), filled up to the first `completedPeaks`. */
export function getWaveformMaxima(peaks: Float32Array, completedPeaks: number | null): WaveformMaxima {
  let entry = maximaCache.get(peaks);
  if (!entry) {
    const maxima: Float32Array[] = [];
    for (let length = peaks.length; length > 1; ) {
      length = Math.ceil(length / 2);
      maxima.push(new Float32Array(length));
    }
    entry = { maxima, completedPeaks: 0 };
    maximaCache.set(peaks, entry);
  }
  const completed = Math.min(peaks.length, Math.max(0, completedPeaks ?? peaks.length));
  if (completed <= entry.completedPeaks) return entry.maxima;
  let start = entry.completedPeaks;
  let end = completed;
  let below: Float32Array = peaks;
  for (const level of entry.maxima) {
    start = Math.floor(start / 2);
    end = Math.ceil(end / 2);
    for (let i = start; i < end; i++) level[i] = Math.max(below[i * 2] ?? 0, below[i * 2 + 1] ?? 0);
    below = level;
  }
  entry.completedPeaks = completed;
  return entry.maxima;
}

/** Floats a hair below a whole number are that number; a position computed from seconds is rarely exact. */
const nudge = (value: number) => (Number.isFinite(value) ? Number.EPSILON * Math.max(1, Math.abs(value)) * 4 : 0);
const floorNear = (value: number) => Math.floor(value + nudge(value));
const ceilNear = (value: number) => Math.ceil(value - nudge(value));

/** The largest peak in [from, to), read from the levels the way a segment tree is. */
export function getWaveformMaximum({
  peaks,
  maxima,
  from,
  to,
}: {
  readonly peaks: Float32Array;
  readonly maxima: WaveformMaxima;
  readonly from: number;
  readonly to: number;
}): number {
  if (to <= from) return 0;
  let start = Math.max(0, Math.min(peaks.length, floorNear(from)));
  let end = Math.max(0, Math.min(peaks.length, ceilNear(to)));
  let maximum = 0;
  let level: Float32Array = peaks;
  for (let n = 0; start < end; n++) {
    if (start % 2 === 1) maximum = Math.max(maximum, level[start++]!);
    if (end % 2 === 1) maximum = Math.max(maximum, level[--end]!);
    start = Math.floor(start / 2);
    end = Math.floor(end / 2);
    level = maxima[n]!;
  }
  return maximum;
}

// ---- drawing ----

export type WaveformVolume = number | readonly number[];

export type WaveformDrawRange = {
  readonly sourceStart: number;
  readonly sourceDuration: number;
  readonly displayStart: number;
  readonly displayDuration: number;
  readonly loop: boolean;
};

const CLIPPING_COLOR = '#FF7F50';
/** How much of the bar's height full scale takes. */
const WAVEFORM_HEIGHT_SCALE = 0.8;
/** The quietest level that shows, in dB; a bar is empty there and full at 0. */
const MIN_VISIBLE_DECIBELS = -37;

/** [r, g, b, a] bytes of a CSS colour; a colour that does not parse is black, as an ignored `fillStyle` leaves it. */
function colorBytes(color: string): [number, number, number, number] {
  const c = parseColor(color);
  return c ? [c.r, c.g, c.b, c.a] : [0, 0, 0, 255];
}

/** The volume at one bar: a number is the same everywhere; a list is spread over the bars, one value per frame. */
function volumeAtBar(barIndex: number, numBars: number, volume: WaveformVolume): number {
  if (typeof volume === 'number') return volume;
  if (volume.length === 0) return 1;
  if (volume.length === 1 || numBars <= 1) return volume[0]!;
  return volume[Math.round((barIndex / (numBars - 1)) * (volume.length - 1))] ?? 1;
}

const smoothstep = (t: number) => t * t * (3 - 2 * t);
const wrap = (value: number, period: number) => ((value % period) + period) % period;

/**
 * Draws `peaks` into `canvas` as one vertical bar per pixel column, in `color`, loud parts above full scale in a
 * clipping colour. `range` says which peaks the bar shows and for how long (in peaks, as the sliced `peaks`' indices);
 * `width` is how many columns the waveform spans, starting `horizontalOffset` into the first.
 */
export function drawBars({
  canvas,
  color,
  peaks,
  range,
  volume,
  width,
  horizontalOffset,
}: {
  readonly canvas: CanvasLike;
  readonly peaks: Float32Array;
  readonly range: WaveformDrawRange;
  readonly color: string;
  readonly volume: WaveformVolume;
  readonly width: number;
  readonly horizontalOffset: number;
}): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');
  const { height } = canvas;
  const w = canvas.width;
  if (w === 0 || height === 0 || width <= 0) return;
  ctx.clearRect(0, 0, w, height);

  const bar = colorBytes(color);
  const clipping = colorBytes(CLIPPING_COLOR);
  const imageData = ctx.createImageData(w, height);
  const { data } = imageData;
  const numBars = width;
  const fullScaleHalfBar = (height * WAVEFORM_HEIGHT_SCALE) / 2;
  const maxima = getWaveformMaxima(peaks, null);
  const { sourceStart, sourceDuration, displayStart, loop } = range;
  const peaksPerPixel = range.displayDuration / width;
  // Zoomed out (several peaks per column) a column is the largest of its peaks; zoomed in it is interpolated.
  const maximumWeight = smoothstep(Math.max(0, Math.min(1, peaksPerPixel - 1)));
  const firstSourcePeak = Math.max(0, floorNear(sourceStart));
  const lastSourcePeak = Math.min(peaks.length - 1, ceilNear(sourceStart + sourceDuration) - 1);
  const maximumOf = (from: number, to: number) => getWaveformMaximum({ peaks, maxima, from, to });
  const loopMaximum = loop && sourceDuration > 0 ? maximumOf(sourceStart, sourceStart + sourceDuration) : 0;
  const mid = height / 2;

  for (let x = 0; x < w; x++) {
    const barIndex = Math.max(0, Math.min(numBars - Number.EPSILON * Math.max(1, numBars), x - horizontalOffset));
    const from = displayStart + Math.max(0, Math.min(width, x - horizontalOffset)) * peaksPerPixel;
    const to = displayStart + Math.max(0, Math.min(width, x + 1 - horizontalOffset)) * peaksPerPixel;

    let peak = 0;
    if (to > from && loop && sourceDuration > 0) {
      const span = to - from;
      if (span >= sourceDuration) {
        peak = loopMaximum;
      } else if (maximumWeight > 0) {
        const loopFrom = wrap(from, sourceDuration);
        const loopTo = loopFrom + span;
        peak = maximumOf(sourceStart + loopFrom, sourceStart + Math.min(sourceDuration, loopTo));
        if (loopTo > sourceDuration) peak = Math.max(peak, maximumOf(sourceStart, sourceStart + loopTo - sourceDuration));
      }
    } else if (!loop && maximumWeight > 0) {
      peak = maximumOf(sourceStart + Math.max(0, from), sourceStart + Math.min(sourceDuration, to));
    }

    if (maximumWeight < 1 && to > from && (!loop || (sourceDuration > 0 && to - from < sourceDuration))) {
      const visibleFrom = loop ? from : Math.max(0, from);
      const visibleTo = loop ? to : Math.min(sourceDuration, to);
      let interpolated = 0;
      if (visibleTo > visibleFrom) {
        const center = visibleFrom + (visibleTo - visibleFrom) / 2;
        const sourcePosition = sourceStart + (loop ? wrap(center, sourceDuration) : center);
        if (sourcePosition >= 0 && sourcePosition < peaks.length && firstSourcePeak <= lastSourcePeak) {
          // Peak i is the sound from i to i + 1, so its middle is at i + 0.5.
          const position = sourcePosition - 0.5;
          const index = Math.floor(position);
          const at = (i: number) => peaks[Math.max(firstSourcePeak, Math.min(lastSourcePeak, i))]!;
          interpolated = at(index) + (at(index + 1) - at(index)) * (position - index);
        }
      }
      peak = interpolated + (peak - interpolated) * maximumWeight;
    }

    const scaledPeak = peak * volumeAtBar(barIndex, numBars, volume);
    const decibels = scaledPeak <= 0 ? MIN_VISIBLE_DECIBELS : 20 * Math.log10(scaledPeak);
    const visible = Math.max(0, (decibels - MIN_VISIBLE_DECIBELS) / -MIN_VISIBLE_DECIBELS);
    const halfBar = Math.max(0, Math.min(mid, visible * fullScaleHalfBar));
    if (halfBar === 0) continue;

    const top = Math.round(mid - halfBar);
    const bottom = Math.round(mid + halfBar);
    // Above full scale, the part of the bar beyond full scale (at least two pixels at each end) is drawn in the clipping colour.
    const clips = scaledPeak > 1;
    const bodyTop = clips ? Math.min(Math.max(top + 2, Math.round(mid - fullScaleHalfBar)), bottom) : top;
    const bodyBottom = clips ? Math.max(Math.min(bottom - 2, Math.round(mid + fullScaleHalfBar)), top) : bottom;
    for (let y = top; y < bottom; y++) data.set(y >= bodyTop && y < bodyBottom ? bar : clipping, (y * w + x) * 4);
  }
  ctx.putImageData(imageData, 0, 0);
}

// ---- slicing ----

/** The volume list for the frames that show: from `displayOffsetInFrames` for `displayDurationInFrames`. */
export function getVisibleWaveformVolume({
  displayDurationInFrames,
  displayOffsetInFrames,
  volume,
}: {
  readonly displayDurationInFrames: number;
  readonly displayOffsetInFrames: number;
  readonly volume: WaveformVolume;
}): WaveformVolume {
  if (!Array.isArray(volume)) return volume;
  if (!Number.isFinite(displayDurationInFrames) || displayDurationInFrames <= 0) return [];
  const start = Math.max(0, Math.floor(displayOffsetInFrames));
  const end = Math.min(volume.length, Math.ceil(displayOffsetInFrames + displayDurationInFrames));
  return volume.slice(start, end);
}

/**
 * The peaks a clip plays: from `startFrom` frames into the file for `durationInFrames` frames of the composition,
 * `playbackRate` times as much sound. Where the clip runs past the file the slice is padded with silence.
 */
export function sliceWaveformPeaks({
  durationInFrames,
  fps,
  peaks,
  playbackRate,
  startFrom,
  waveformSampleRate = TARGET_SAMPLE_RATE,
}: {
  readonly peaks: Float32Array;
  readonly startFrom: number;
  readonly durationInFrames: number;
  readonly fps: number;
  readonly playbackRate: number;
  readonly waveformSampleRate?: number | undefined;
}): Float32Array {
  if (peaks.length === 0) return peaks;
  const startSeconds = startFrom / fps;
  const start = startSeconds * waveformSampleRate;
  const end = (startSeconds + (durationInFrames / fps) * playbackRate) * waveformSampleRate;
  const first = floorNear(start);
  const last = ceilNear(end);
  if (!Number.isFinite(first) || !Number.isFinite(last)) {
    return peaks.subarray(Math.max(0, first), Math.min(peaks.length, last));
  }
  if (first >= 0 && last <= peaks.length) return peaks.subarray(first, last);
  const slice = new Float32Array(Math.max(0, last - first));
  const from = Math.max(0, first);
  const to = Math.min(peaks.length, last);
  if (from < to) slice.set(peaks.subarray(from, to), from - first);
  return slice;
}

/** The peaks of the visible part of a clip's bar; for a looping clip, the pieces in each repeat, joined. */
export function sliceVisibleWaveformPeaks({
  displayDurationInFrames,
  displayOffsetInFrames,
  durationInFrames,
  fps,
  loopDisplay,
  peaks,
  playbackRate,
  startFrom,
  waveformSampleRate,
}: {
  readonly displayDurationInFrames: number;
  readonly displayOffsetInFrames: number;
  readonly durationInFrames: number;
  readonly fps: number;
  readonly loopDisplay: TimelineLoopDisplay | undefined;
  readonly peaks: Float32Array;
  readonly playbackRate: number;
  readonly startFrom: number;
  readonly waveformSampleRate?: number | undefined;
}): Float32Array {
  if (!loopDisplay || loopDisplay.durationInFrames <= 0) {
    return sliceWaveformPeaks({
      durationInFrames: Math.min(displayDurationInFrames, Math.max(0, durationInFrames - displayOffsetInFrames)),
      fps,
      peaks,
      playbackRate,
      startFrom: startFrom + displayOffsetInFrames * playbackRate,
      waveformSampleRate,
    });
  }
  const parts = getLoopDisplaySegments({
    displayDurationInFrames,
    displayOffsetInFrames,
    loopDurationInFrames: loopDisplay.durationInFrames,
  }).map((segment) =>
    sliceWaveformPeaks({
      durationInFrames: segment.durationInFrames,
      fps,
      peaks,
      playbackRate,
      startFrom: startFrom + segment.loopOffsetInFrames * playbackRate,
      waveformSampleRate,
    }),
  );
  if (parts.length === 1) return parts[0]!;
  const joined = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

// ---- computing the peaks ----

type Progress = {
  readonly peaks: Float32Array;
  readonly averageVolume: number | null;
  readonly completedPeaks: number;
  readonly totalPeaks: number;
  readonly final: boolean;
};

export function emitWaveformProgress({
  averageVolume,
  completedPeaks,
  final,
  onProgress,
  peaks,
  totalPeaks,
}: Progress & { readonly onProgress?: ((progress: Progress) => void) | undefined }): void {
  onProgress?.({ averageVolume, peaks, completedPeaks, totalPeaks, final });
}

/**
 * Takes interleaved samples in chunks and keeps the largest absolute sample of every `samplesPerPeak` frames as a
 * peak, and the mean power for `averageVolume` (dBFS). `onProgress` is called at most every `progressIntervalInMs` of
 * `now()`, and once more, `final`, from `finalize`.
 */
export function createWaveformPeakProcessor({
  totalPeaks,
  samplesPerPeak,
  onProgress,
  progressIntervalInMs,
  now,
}: {
  readonly totalPeaks: number;
  readonly samplesPerPeak: number;
  readonly onProgress?: (progress: Progress) => void;
  readonly progressIntervalInMs: number;
  readonly now: () => number;
}): {
  readonly peaks: Float32Array;
  readonly averageVolume: number | null;
  processSampleChunk: (floats: Float32Array, channels: number, sampleRate: number) => void;
  finalize: () => void;
} {
  const peaks = new Float32Array(totalPeaks);
  let energy = 0;
  let duration = 0;
  let peakIndex = 0;
  let peakMax = 0;
  let sampleInPeak = 0;
  let lastProgressAt = 0;
  let lastProgressPeak = 0;
  const averageVolume = () => (duration > 0 ? 10 * Math.log10(energy / duration) : null);

  const progress = (force: boolean) => {
    const timestamp = now();
    if (!force && peakIndex === lastProgressPeak && sampleInPeak === 0) return;
    if (!force && timestamp - lastProgressAt < progressIntervalInMs) return;
    lastProgressAt = timestamp;
    lastProgressPeak = peakIndex;
    emitWaveformProgress({
      averageVolume: force ? averageVolume() : null,
      peaks,
      completedPeaks: peakIndex,
      totalPeaks,
      final: force,
      onProgress,
    });
  };

  return {
    peaks,
    get averageVolume() {
      return averageVolume();
    },
    processSampleChunk(floats, channels, sampleRate) {
      const frames = Math.floor(floats.length / Math.max(1, channels));
      for (let frame = 0; frame < frames; frame++) {
        let framePeak = 0;
        let framePower = 0;
        for (let channel = 0; channel < channels; channel++) {
          const sample = Math.abs(floats[frame * channels + channel] ?? 0);
          framePower += sample * sample;
          if (sample > framePeak) framePeak = sample;
        }
        energy += framePower / channels / sampleRate;
        duration += 1 / sampleRate;
        if (framePeak > peakMax) peakMax = framePeak;
        if (++sampleInPeak >= samplesPerPeak) {
          if (peakIndex < totalPeaks) peaks[peakIndex] = peakMax;
          peakIndex++;
          peakMax = 0;
          sampleInPeak = 0;
        }
      }
      progress(false);
    },
    finalize() {
      if (sampleInPeak > 0 && peakIndex < totalPeaks) peaks[peakIndex++] = peakMax;
      progress(true);
    },
  };
}

export type WaveformResult = {
  readonly peaks: Float32Array;
  readonly maxima: WaveformMaxima;
  readonly averageVolume: number | null;
};

type LoadWaveformPeaksOptions = {
  readonly onProgress?: (progress: Progress & { readonly maxima: WaveformMaxima }) => void;
  readonly progressIntervalInMs?: number;
  readonly waveformSampleRate?: number;
};

const peaksCache = new Map<string, WaveformResult>();

function cacheKeyOf(src: string, waveformSampleRate: number): string {
  return `${waveformSampleRate}:url:${src}`;
}

function checkSource(src: string | InputAudioTrackLike): string {
  if (typeof src !== 'string') {
    throw new UnsupportedApiError(
      '@remotion/timeline-utils',
      'a mediabunny audio track as a waveform source',
      'only the path of a file can be loaded, because the sound is decoded by the addon, not by mediabunny',
    );
  }
  return src;
}

/** Frames per chunk fed to the processor. */
const CHUNK_FRAMES = 48000;

/**
 * The peaks of the sound in the file at `src` (a path; the first audio stream), `waveformSampleRate` per second, with
 * the levels for ranges and the average volume in dBFS. A file with no sound has none. Results are kept per file and
 * rate. `signal` stops a load between chunks. `onProgress` is called after each second of sound and when done;
 * `progressIntervalInMs` is accepted and not needed.
 */
export async function loadWaveformPeaks(
  src: string | InputAudioTrackLike,
  signal: AbortSignal,
  options?: LoadWaveformPeaksOptions,
): Promise<WaveformResult> {
  const waveformSampleRate = options?.waveformSampleRate ?? TARGET_SAMPLE_RATE;
  if (!Number.isFinite(waveformSampleRate) || waveformSampleRate <= 0) {
    throw new Error('The waveform sample rate must be a positive number.');
  }
  const path = checkSource(src);
  const key = cacheKeyOf(path, waveformSampleRate);
  const cached = peaksCache.get(key);
  if (cached) {
    options?.onProgress?.({
      peaks: cached.peaks,
      maxima: cached.maxima,
      averageVolume: cached.averageVolume,
      completedPeaks: cached.peaks.length,
      totalPeaks: cached.peaks.length,
      final: true,
    });
    return cached;
  }

  let audio;
  try {
    audio = readAudioData(path);
  } catch (error) {
    // A file with no sound has no peaks; any other failure is the caller's to see.
    if (error instanceof Error && /has no audio stream$/.test(error.message)) {
      return { peaks: new Float32Array(0), maxima: [], averageVolume: null };
    }
    throw error;
  }
  const totalPeaks = Math.ceil(audio.durationInSeconds * waveformSampleRate);
  const samplesPerPeak = Math.max(1, Math.floor(audio.sampleRate / waveformSampleRate));
  const processor = createWaveformPeakProcessor({
    totalPeaks,
    samplesPerPeak,
    onProgress: (progress) => options?.onProgress?.({ ...progress, maxima: getWaveformMaxima(progress.peaks, progress.completedPeaks) }),
    // Nothing here reads a clock, so `progressIntervalInMs` has nothing to measure: progress is reported after every
    // chunk, and again when done.
    progressIntervalInMs: 0,
    now: () => 0,
  });
  const channels = audio.channelWaveforms;
  const total = channels[0]?.length ?? 0;
  for (let start = 0; start < total; start += CHUNK_FRAMES) {
    if (signal.aborted) return { peaks: new Float32Array(0), maxima: [], averageVolume: null };
    const frames = Math.min(CHUNK_FRAMES, total - start);
    const interleaved = new Float32Array(frames * channels.length);
    channels.forEach((channel, c) => {
      for (let i = 0; i < frames; i++) interleaved[i * channels.length + c] = channel[start + i]!;
    });
    processor.processSampleChunk(interleaved, channels.length, audio.sampleRate);
  }
  processor.finalize();
  const result: WaveformResult = {
    peaks: processor.peaks,
    maxima: getWaveformMaxima(processor.peaks, null),
    averageVolume: processor.averageVolume,
  };
  peaksCache.set(key, result);
  return result;
}

// ---- subscribing ----

type Listener = {
  readonly onPeaks: (peaks: Float32Array, final: boolean, averageVolume: number | null) => void;
  readonly onError: (error: Error) => void;
};

const finished = new Map<string, WaveformResult>();
const inFlight = new Map<string, Set<Listener>>();

/**
 * Calls `onPeaks` with the peaks of the file at `src` as `final` peaks, once they are computed (again for a listener
 * that subscribes after, from the kept result), or `onError`. Listeners of the same file and rate share one load.
 * Returns what unsubscribes.
 */
export function subscribeToWaveformPeaks({
  src,
  waveformSampleRate = TARGET_SAMPLE_RATE,
  onPeaks,
  onError,
}: {
  readonly src: string | InputAudioTrackLike;
  readonly waveformSampleRate?: number | undefined;
  readonly onPeaks: (peaks: Float32Array, final: boolean, averageVolume: number | null) => void;
  readonly onError: (error: Error) => void;
}): () => void {
  const path = checkSource(src);
  const key = cacheKeyOf(path, waveformSampleRate);
  const done = finished.get(key);
  if (done) {
    onPeaks(done.peaks, true, done.averageVolume);
    return () => {};
  }
  const listener: Listener = { onPeaks, onError };
  const waiting = inFlight.get(key);
  if (waiting) {
    waiting.add(listener);
    return () => void waiting.delete(listener);
  }
  const listeners = new Set([listener]);
  inFlight.set(key, listeners);
  loadWaveformPeaks(path, new AbortController().signal, { waveformSampleRate }).then(
    (result) => {
      finished.set(key, result);
      inFlight.delete(key);
      for (const l of listeners) l.onPeaks(result.peaks, true, result.averageVolume);
    },
    (error: unknown) => {
      inFlight.delete(key);
      for (const l of listeners) l.onError(error instanceof Error ? error : new Error('Failed to load waveform peaks'));
    },
  );
  return () => void listeners.delete(listener);
}
