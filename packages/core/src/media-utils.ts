// `@remotion/media-utils` (packages/cli/skills/kinetograph-markup/references/AUTHORING.md §11.3): `getVideoMetadata`, read
// from the file's header by the addon's `probeMedia`. Nothing is decoded.
//
// The addon is found the way `layout-utils` finds `layoutText`: the host hands it over with `setMediaProbe`, and
// failing that it is looked up when first needed (a project that never probes a file does not need the addon).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolveCachedRemoteFile } from '@kinetographdev/compat/dom';
import { imageSizeOfBytes, projectFileOf, remoteMessage } from '@kinetographdev/compat/shim';
import type { MediaInfo } from '@kinetographdev/native';
import { mediaParserAddon } from './media-parser/addon.js';

export type ProbeMedia = (path: string, baseDir?: string) => MediaInfo;

export interface VideoMetadata {
  durationInSeconds: number;
  width: number;
  height: number;
  aspectRatio: number;
  isRemote: false;
  /** Not in Remotion's: the stream's average frame rate. */
  fps: number | null;
}

let probeOverride: ProbeMedia | null = null;
let probeNative: ProbeMedia | null = null;

/** Sets the addon's `probeMedia` (the host does, as with `setLayoutText`; tests pass a stub, `null` goes back). */
export function setMediaProbe(fn: ProbeMedia | null): void {
  probeOverride = fn;
  cached.clear();
}

// Answers kept for callers that ask every frame (a GIF's duration walks all its pictures); a new probe empties it.
const cached = new Map<string, MediaInfo>();

/**
 * The addon's `probeMedia`, found when first needed: from here, then from the working directory. A bundle in a
 * project's cache may sit where neither reaches it; the host then calls `setMediaProbe(native.probeMedia)`.
 */
function loadNative(): ProbeMedia {
  const failures: string[] = [];
  for (const base of [import.meta.url, pathToFileURL(`${process.cwd()}/`).href]) {
    try {
      return (createRequire(base)('@kinetographdev/native') as { probeMedia: ProbeMedia }).probeMedia;
    } catch (error) {
      failures.push(error instanceof Error ? error.message.split('\n')[0]! : String(error));
    }
  }
  throw new Error(
    `Media cannot be probed: @kinetographdev/native could not be loaded (${failures.join('; ')}). ` +
      'Build the addon, or pass its probeMedia to setMediaProbe() from @kinetographdev/core/media-utils.',
  );
}

/** `src`, or for an http(s) URL the file `fetch-deps` downloaded and locked for it; a URL that is not cached is an error. */
function remoteOrLocal(src: string): string {
  if (!/^https?:\/\//i.test(src)) return src;
  const cached = resolveCachedRemoteFile(src);
  if (cached === null) throw new Error(`Cannot read ${src}: remote files are not supported, download it and use staticFile() instead`);
  return cached;
}

/** What the addon reads from the header of the video or GIF at `src`; with `cache`, read once per `src`. */
export function probeMedia(src: string, options: { cache?: boolean } = {}): MediaInfo {
  if (options.cache) {
    let info = cached.get(src);
    if (info === undefined) {
      info = probeMedia(src);
      cached.set(src, info);
    }
    return info;
  }
  if (typeof src !== 'string' || src === '') throw new TypeError(`src must be a file path, but got ${JSON.stringify(src)}`);
  const path = remoteOrLocal(src);
  if (probeOverride) return probeOverride(path);
  probeNative ??= loadNative();
  return probeNative(path);
}

/**
 * How long a browser says a video is: the container's length, which is the longest of its streams, so a sound that runs
 * past the last picture counts (`probeMedia` gives the picture's). The picture's when the container says nothing longer.
 */
function containerDuration(src: string, videoSeconds: number): number {
  try {
    const container = mediaParserAddon().probeStreams(remoteOrLocal(src)).durationInSeconds;
    return container != null && container > videoSeconds ? container : videoSeconds;
  } catch {
    return videoSeconds;
  }
}

/** The duration, size and frame rate of a local video, read from its header. */
export async function getVideoMetadata(src: string): Promise<VideoMetadata> {
  const info = probeMedia(src);
  return {
    durationInSeconds: info.kind === 'video' ? containerDuration(src, info.durationInSeconds) : info.durationInSeconds,
    width: info.width,
    height: info.height,
    aspectRatio: info.width / info.height,
    isRemote: false,
    fps: info.fps ?? null,
  };
}

// ---- Audio data (packages/cli/skills/kinetograph-markup/references/AUTHORING.md §11.7) ----
//
// `getAudioData` and its hooks decode the whole file once with the addon's `decodeAudio` (ffmpeg: any file with an
// audio stream, video files included) at 48 kHz, or the `sampleRate` of `getAudioData`, and keep it per `src` and rate
// (Remotion 4.0.540 does; before, a second rate got the data of the first). Decoding is synchronous, so
// `useAudioData` has the data on the first frame it is called in, and every frame of a render sees the same samples.

/** The addon's `decodeAudio`: the first audio stream of a file as planar float at `sampleRate`, or null. */
export type DecodeAudio = (path: string, sampleRate: number) => { sampleRate: number; channels: Float32Array[] } | null;

/** The rate audio data is decoded at (Remotion's is the browser's `AudioContext` rate, usually 48 kHz too). */
export const AUDIO_DATA_SAMPLE_RATE = 48000;

/** As `@remotion/media-utils`' `MediaUtilsAudioData`. */
export interface MediaUtilsAudioData {
  /** One array per channel, samples in -1..1. */
  channelWaveforms: Float32Array[];
  sampleRate: number;
  durationInSeconds: number;
  numberOfChannels: number;
  /** The same for the same file; a cache key. */
  resultId: string;
  isRemote: boolean;
}

let decodeOverride: DecodeAudio | null = null;
let decodeNative: DecodeAudio | null = null;
const audioCache = new Map<string, MediaUtilsAudioData>();
const cacheKey = (src: string, sampleRate: number) => `${sampleRate}:${src}`;

/** Sets the addon's `decodeAudio` (the host does, as with `setMediaProbe`; tests pass a stub, `null` goes back). */
export function setAudioDecoder(fn: DecodeAudio | null): void {
  decodeOverride = fn;
  audioCache.clear();
  windows.clear();
}

function loadNativeDecoder(): DecodeAudio {
  const failures: string[] = [];
  for (const base of [import.meta.url, pathToFileURL(`${process.cwd()}/`).href]) {
    try {
      return (createRequire(base)('@kinetographdev/native') as { decodeAudio: DecodeAudio }).decodeAudio;
    } catch (error) {
      failures.push(error instanceof Error ? error.message.split('\n')[0]! : String(error));
    }
  }
  throw new Error(
    `Audio cannot be decoded: @kinetographdev/native could not be loaded (${failures.join('; ')}). ` +
      'Build the addon, or pass its decodeAudio to setAudioDecoder() from @kinetographdev/core/media-utils.',
  );
}

/** The decoded samples of `src` at `sampleRate`, once per file and rate. */
export function readAudioData(src: string, sampleRate: number = AUDIO_DATA_SAMPLE_RATE): MediaUtilsAudioData {
  if (typeof src !== 'string' || src === '') throw new TypeError(`src must be a file path, but got ${JSON.stringify(src)}`);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new TypeError(`sampleRate must be a positive number, but got ${sampleRate}`);
  const known = audioCache.get(cacheKey(src, sampleRate));
  if (known) return known;
  let decode = decodeOverride;
  if (!decode) decode = decodeNative ??= loadNativeDecoder();
  const pcm = decode(remoteOrLocal(src), sampleRate);
  if (pcm === null || pcm.channels.length === 0) throw new Error(`${src} has no audio stream`);
  const length = pcm.channels[0]!.length;
  const data: MediaUtilsAudioData = {
    channelWaveforms: pcm.channels,
    sampleRate: pcm.sampleRate,
    durationInSeconds: length / pcm.sampleRate,
    numberOfChannels: pcm.channels.length,
    resultId: sampleRate === AUDIO_DATA_SAMPLE_RATE ? `kinetograph-audio:${src}` : `kinetograph-audio:${sampleRate}:${src}`,
    isRemote: false,
  };
  audioCache.set(cacheKey(src, sampleRate), data);
  return data;
}

/** The samples of the audio (or video's sound) at `src`, at `sampleRate` (48000 by default). `requestInit` is not needed. */
export async function getAudioData(src: string, options?: { sampleRate?: number }): Promise<MediaUtilsAudioData> {
  return readAudioData(src, options?.sampleRate);
}

/** As Remotion's hook, but the data is there on the first call (Remotion's is null until it has loaded). */
export function useAudioData(src: string): MediaUtilsAudioData | null {
  return readAudioData(src);
}

const windows = new Map<string, MediaUtilsAudioData>();

/**
 * Remotion's windowed hook, for long files: the audio is cut into windows of `windowInSeconds`, and the data is the
 * window of the current frame with the one before and the one after (up to three windows, as its documentation says), with
 * `dataOffsetInSeconds` where that slice starts in the file. `visualizeAudio` scales by the loudest sample of the data it
 * is given, so the slice matters: it is the slice's, not the whole file's. The file is decoded whole here anyway.
 */
export function useWindowedAudioData(options: {
  src: string;
  frame: number;
  fps: number;
  windowInSeconds: number;
}): { audioData: MediaUtilsAudioData | null; dataOffsetInSeconds: number } {
  const whole = readAudioData(options.src);
  const rate = whole.sampleRate;
  const window = options.windowInSeconds;
  const current = Math.floor(options.frame / options.fps / window);
  const length = whole.channelWaveforms[0]!.length;
  const start = Math.min(length, Math.max(0, Math.floor((current - 1) * window * rate)));
  const end = Math.min(length, Math.ceil((current + 2) * window * rate));
  if (start === 0 && end === length) return { audioData: whole, dataOffsetInSeconds: 0 };
  const key = `${whole.resultId}:${start}:${end}`;
  let slice = windows.get(key);
  if (slice === undefined) {
    // The slices are views, but keep the map small over a long session.
    if (windows.size >= 16) windows.clear();
    slice = {
      ...whole,
      channelWaveforms: whole.channelWaveforms.map((channel) => channel.subarray(start, end)),
      durationInSeconds: (end - start) / rate,
      resultId: `${whole.resultId}@${start}-${end}`,
    };
    windows.set(key, slice);
  }
  return { audioData: slice, dataOffsetInSeconds: start / rate };
}

/** How long the audio at `src` plays, from its decoded samples. */
export async function getAudioDurationInSeconds(src: string): Promise<number> {
  return readAudioData(src).durationInSeconds;
}

/** In-place radix-2 FFT; `re.length` is a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  const twiddles = twiddlesOf(n);
  for (let size = 2; size <= n; size <<= 1) {
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const wr = twiddles.cos[k * step]!;
        const wi = twiddles.sin[k * step]!;
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b]! * wr - im[b]! * wi;
        const ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
}

const twiddleTables = new Map<number, { cos: Float64Array; sin: Float64Array }>();

/** cos and sin of -2*pi*k/n for k below n/2, kept per size. */
function twiddlesOf(n: number): { cos: Float64Array; sin: Float64Array } {
  let table = twiddleTables.get(n);
  if (table === undefined) {
    table = { cos: new Float64Array(n / 2), sin: new Float64Array(n / 2) };
    for (let k = 0; k < n / 2; k++) {
      table.cos[k] = Math.cos((-2 * Math.PI * k) / n);
      table.sin[k] = Math.sin((-2 * Math.PI * k) / n);
    }
    twiddleTables.set(n, table);
  }
  return table;
}

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

/** A sample as 16-bit audio: 0x7fff for full scale up, 0x8000 for full scale down. */
const toInt16 = (x: number): number => (x > 0 ? x * 0x7fff : x * 0x8000);

// The loudest 16-bit sample of a waveform (1 for silence), found once: every frame divides by it.
const peaks = new WeakMap<Float32Array, number>();

function peakOf(waveform: Float32Array): number {
  let peak = peaks.get(waveform);
  if (peak === undefined) {
    peak = 0;
    for (let i = 0; i < waveform.length; i++) peak = Math.max(peak, Math.abs(toInt16(waveform[i]!)));
    peak ||= 1;
    peaks.set(waveform, peak);
  }
  return peak;
}

/**
 * Three passes of a three-point mean over the bins, the ends kept. The first pass reads the bins as they were; the
 * next two update in place, so each point sees its left neighbour already smoothed, as Remotion's does.
 */
function smoothen(bins: number[]): number[] {
  const out = bins.slice();
  let source = bins;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < bins.length - 1; i++) out[i] = (source[i - 1]! + source[i]! + source[i + 1]!) / 3;
    source = out;
  }
  return out;
}

/**
 * The spectrum at one moment, as Remotion 4.0.542 gives it. The documentation says little about it (values 0 to 1,
 * low frequencies first), so this follows what the published package does, found by calling it on test signals: the
 * first channel's `2 * numberOfSamples` samples from `numberOfSamples` before the moment (from the start of the file when
 * that is earlier; silence past its end), as 16-bit integers, go through a plain FFT with no window function, the
 * magnitudes of its lower half are smoothed (`smoothen`) and divided by `numberOfSamples` and by the loudest 16-bit sample
 * of the whole channel. A constant signal reads 2 in the first bin; nothing is clamped.
 */
function spectrumAt(audioData: MediaUtilsAudioData, seconds: number, numberOfSamples: number): number[] {
  const waveform = audioData.channelWaveforms[0]!;
  const size = numberOfSamples * 2;
  if (waveform.length < size) throw new TypeError(`Audio data is not big enough to provide ${size} bars.`);
  const start = Math.max(0, Math.floor(seconds * audioData.sampleRate) - numberOfSamples);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const end = Math.min(waveform.length, start + size);
  // The samples go into 16-bit integers, which drop what is after the point and wrap what is past full scale.
  for (let i = start; i < end; i++) re[i - start] = (Math.trunc(Math.fround(toInt16(waveform[i]!))) << 16) >> 16;
  fft(re, im);
  const magnitudes: number[] = [];
  for (let k = 0; k < numberOfSamples; k++) magnitudes.push(Math.hypot(re[k]!, im[k]!));
  const peak = peakOf(waveform);
  return smoothen(magnitudes).map((m) => m / numberOfSamples / peak);
}

/**
 * The frequency spectrum at `frame`, as `@remotion/media-utils`' `visualizeAudio`: `numberOfSamples` (a power of two)
 * values, low frequencies first, each a bin of the first channel's spectrum at that moment (`spectrumAt`). `smoothing`
 * (default true) averages the frame before, the frame and the frame after. `optimizeFor` is accepted and changes nothing.
 */
export function visualizeAudio(options: {
  audioData: MediaUtilsAudioData;
  frame: number;
  fps: number;
  numberOfSamples: number;
  smoothing?: boolean;
  optimizeFor?: 'accuracy' | 'speed';
  dataOffsetInSeconds?: number;
}): number[] {
  const { audioData, frame, fps, numberOfSamples } = options;
  if (!isPowerOfTwo(numberOfSamples)) {
    throw new RangeError(`visualizeAudio: numberOfSamples must be a power of two, got ${String(numberOfSamples)}`);
  }
  if (!(fps > 0)) throw new RangeError(`visualizeAudio: fps must be above 0, got ${String(fps)}`);
  const offset = options.dataOffsetInSeconds ?? 0;
  const at = (f: number) => spectrumAt(audioData, f / fps - offset, numberOfSamples);
  if (options.smoothing === false) return at(frame);
  const frames = [at(frame - 1), at(frame), at(frame + 1)];
  return frames[1]!.map((_, i) => (frames[0]![i]! + frames[1]![i]! + frames[2]![i]!) / 3);
}

/** How `getWaveformPortion` writes its bars: 0..1, or alternating below and above 0 (-1..1) so that they draw as a line. */
export type SampleOutputRange = 'zero-to-one' | 'minus-one-to-one';

export interface WaveformBar {
  index: number;
  amplitude: number;
}

function validateChannel(channel: unknown, numberOfChannels: number): void {
  if (typeof channel !== 'number') throw new TypeError('"channel" must be a number');
  if (channel % 1 !== 0) throw new TypeError(`"channel" must an integer, got ${channel}`);
  if (Number.isNaN(channel)) throw new TypeError('The channel parameter is NaN.');
  if (channel < 0) throw new TypeError('"channel" cannot be negative');
  if (channel > numberOfChannels - 1) {
    throw new TypeError(`"channel" must be ${numberOfChannels - 1} or lower. The audio has ${numberOfChannels} channels`);
  }
}

/** `samples` as `numberOfSamples` bars: each the mean absolute value of its block of samples. */
function waveformBars(samples: Float32Array, numberOfSamples: number, outputRange: SampleOutputRange, normalize: boolean): number[] {
  const blockSize = Math.floor(samples.length / numberOfSamples);
  if (blockSize === 0) return [];
  let bars: number[] = [];
  for (let i = 0; i < numberOfSamples; i++) {
    let sum = 0;
    for (let j = 0; j < blockSize; j++) sum += Math.abs(samples[blockSize * i + j]!);
    bars.push(sum / blockSize);
  }
  if (normalize) {
    const peak = Math.max(...bars);
    const multiplier = peak === 0 ? 0 : peak ** -1;
    bars = bars.map((bar) => bar * multiplier);
  }
  return outputRange === 'minus-one-to-one' ? bars.map((bar, i) => (i % 2 === 0 ? bar * -1 : bar)) : bars;
}

/**
 * The loudness of a stretch of the audio in `numberOfSamples` equal bars, as `@remotion/media-utils`'
 * `getWaveformPortion`: of one `channel` (the first by default), each bar's `amplitude` the mean absolute sample of its
 * block, scaled so that the loudest bar is 1 unless `normalize` is false. The stretch may reach outside the file
 * (silence there); `dataOffsetInSeconds` says where in the video the data starts.
 */
export function getWaveformPortion(options: {
  audioData: MediaUtilsAudioData;
  startTimeInSeconds: number;
  durationInSeconds: number;
  numberOfSamples: number;
  channel?: number;
  outputRange?: SampleOutputRange;
  dataOffsetInSeconds?: number;
  normalize?: boolean;
}): WaveformBar[] {
  const { audioData, startTimeInSeconds, durationInSeconds, numberOfSamples, channel = 0, outputRange = 'zero-to-one', dataOffsetInSeconds, normalize = true } = options;
  validateChannel(channel, audioData.numberOfChannels);
  const waveform = audioData.channelWaveforms[channel]!;
  const offset = dataOffsetInSeconds ?? 0;
  const startSample = Math.floor((startTimeInSeconds - offset) * audioData.sampleRate);
  const endSample = Math.floor((startTimeInSeconds - offset + durationInSeconds) * audioData.sampleRate);
  // Only the part of the stretch that lies outside the file is silence added; a negative index would count from the end.
  const before = Math.max(0, Math.min(endSample, 0) - startSample);
  const after = Math.max(0, endSample - Math.max(startSample, waveform.length));
  const inside = waveform.slice(Math.min(Math.max(startSample, 0), waveform.length), Math.min(Math.max(endSample, 0), waveform.length));
  const samples = new Float32Array(before + inside.length + after);
  samples.set(inside, before);
  return waveformBars(samples, numberOfSamples, outputRange, normalize).map((amplitude, index) => ({ index, amplitude }));
}

/**
 * The waveform around `frame`, as `@remotion/media-utils`' `visualizeAudioWaveform`: `numberOfSamples` values from -1 to 1
 * (alternating below and above 0) for the `windowInSeconds` centred on the frame's time, to draw as a line.
 */
export function visualizeAudioWaveform(options: {
  audioData: MediaUtilsAudioData;
  frame: number;
  fps: number;
  windowInSeconds: number;
  numberOfSamples: number;
  channel?: number;
  dataOffsetInSeconds?: number;
  normalize?: boolean;
}): number[] {
  const { audioData, frame, fps, windowInSeconds, numberOfSamples, channel, dataOffsetInSeconds, normalize = false } = options;
  if (windowInSeconds * audioData.sampleRate < numberOfSamples) {
    throw new TypeError(`${windowInSeconds}s audiodata does not have ${numberOfSamples} bars. Increase windowInSeconds or decrease numberOfSamples`);
  }
  return getWaveformPortion({
    audioData,
    startTimeInSeconds: frame / fps - windowInSeconds / 2,
    durationInSeconds: windowInSeconds,
    numberOfSamples,
    outputRange: 'minus-one-to-one',
    channel,
    dataOffsetInSeconds,
    normalize,
  }).map((bar) => bar.amplitude);
}

/** `getAudioDurationInSeconds` under its old name. */
export const getAudioDuration = getAudioDurationInSeconds;

// ---- Small helpers ----

/** The pixel size of the image at `src`: a project file or a `data:` URL, from its header. */
export function imageSizeSync(src: string): { width: number; height: number } {
  if (typeof src !== 'string' || src === '') throw new TypeError(`src must be an image path, but got ${JSON.stringify(src)}`);
  if (/^https?:\/\//i.test(src)) throw new Error(remoteMessage('getImageDimensions', src));
  let bytes: Uint8Array;
  if (src.startsWith('data:')) {
    const comma = src.indexOf(',');
    const body = src.slice(comma + 1);
    bytes = src.slice(5, comma).endsWith(';base64') ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body));
  } else {
    const file = projectFileOf(src);
    if (file === null) throw new Error(`Cannot read the image at ${src}: it is not a file of the project`);
    bytes = readFileSync(file);
  }
  const size = imageSizeOfBytes(bytes);
  if (size === null) throw new Error(`Cannot read the size of the image at ${src}: it is not a PNG, JPEG, GIF, WebP, BMP or SVG`);
  return size;
}

/** The pixel size of the image at `src`: a project file or a `data:` URL, from its header. */
export async function getImageDimensions(src: string): Promise<{ width: number; height: number }> {
  return imageSizeSync(src);
}

/**
 * A smooth SVG path (`M x,y C … ` cubics) through `points`: each curve's control points lie along the line between the
 * points either side of its end, a fifth of that line's length away.
 */
export function createSmoothSvgPath({ points }: { points: { x: number; y: number }[] }): string {
  const SMOOTHING = 0.2;
  type Point = { x: number; y: number };
  // The control point beside `current`, along the line from `previous` to `next` (reversed for the arriving side).
  const controlPoint = (current: Point, previous: Point | undefined, next: Point | undefined, reverse: boolean): Point => {
    const from = previous ?? current;
    const to = next ?? current;
    const lengthX = to.x - from.x;
    const lengthY = to.y - from.y;
    const angle = Math.atan2(lengthY, lengthX) + (reverse ? Math.PI : 0);
    const length = Math.sqrt(lengthX ** 2 + lengthY ** 2) * SMOOTHING;
    return { x: current.x + Math.cos(angle) * length, y: current.y + Math.sin(angle) * length };
  };
  return points.reduce((path, current, i, all) => {
    if (i === 0) return `M ${current.x},${current.y}`;
    const previous = all[i - 1]!;
    const leaving = controlPoint(previous, all[i - 2], current, false);
    const arriving = controlPoint(current, previous, all[i + 1], true);
    return `${path} C ${leaving.x},${leaving.y} ${arriving.x},${arriving.y} ${current.x},${current.y}`;
  }, '');
}

/** What `audioBufferToDataUrl` reads of an `AudioBuffer`. */
export interface AudioBufferLike {
  numberOfChannels: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

/**
 * A 32-bit float WAV of `buffer` as a `data:audio/wav;base64,…` URL. Every channel is interleaved, frame by frame
 * (Remotion 4.0.539; before, any count but 2 wrote only the first channel under a header that said how many there were).
 */
export function audioBufferToDataUrl(buffer: AudioBufferLike): string {
  const { numberOfChannels, sampleRate } = buffer;
  let samples = buffer.getChannelData(0);
  if (numberOfChannels > 1) {
    const length = samples.length;
    const interleaved = new Float32Array(length * numberOfChannels);
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const source = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) interleaved[i * numberOfChannels + channel] = source[i]!;
    }
    samples = interleaved;
  }
  const bytesPerSample = 4;
  const blockAlign = numberOfChannels * bytesPerSample;
  const wav = new DataView(new ArrayBuffer(44 + samples.length * bytesPerSample));
  const text = (offset: number, value: string) => [...value].forEach((ch, i) => wav.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  wav.setUint32(4, 36 + samples.length * bytesPerSample, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  wav.setUint32(16, 16, true);
  wav.setUint16(20, 3, true); // IEEE float
  wav.setUint16(22, numberOfChannels, true);
  wav.setUint32(24, sampleRate, true);
  wav.setUint32(28, sampleRate * blockAlign, true);
  wav.setUint16(32, blockAlign, true);
  wav.setUint16(34, 32, true);
  text(36, 'data');
  wav.setUint32(40, samples.length * bytesPerSample, true);
  samples.forEach((sample, i) => wav.setFloat32(44 + i * bytesPerSample, sample, true));
  return `data:audio/wav;base64,${Buffer.from(wav.buffer).toString('base64')}`;
}
