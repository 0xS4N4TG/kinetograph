// `@remotion/timeline-utils`: the pure helpers, the waveform and the frame strip against values recorded from the
// published package (test/fixtures/timeline-utils.json; NaN and Infinity are stored as "__NaN__", "__Infinity__").

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAudioDecoder } from '../src/media-utils.js';
import * as tu from '../src/timeline-utils/index.js';
import { UnsupportedApiError } from '../src/unsupported.js';
import { fixture } from './helpers.js';

function revive(value: any): any {
  if (typeof value === 'string') {
    const m = /^__(NaN|Infinity|-Infinity)__$/.exec(value);
    return m ? Number(m[1]) : value;
  }
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v)]));
  return value;
}

const data = revive(fixture('timeline-utils.json'));

const sha = (bytes: Uint8Array) => createHash('sha1').update(bytes).digest('hex').slice(0, 16);
const f32 = (array: Float32Array) => ({ length: array.length, sha: sha(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)) });
const makePeaks = (n: number) =>
  Float32Array.from({ length: n }, (_, i) => Math.abs(Math.sin(i * 0.37)) * (0.2 + 0.8 * Math.abs(Math.sin(i * 0.011))));

afterEach(() => setAudioDecoder(null));

describe('exports', () => {
  it('are the published package\'s', () => {
    expect(Object.keys(tu).sort()).toEqual(data.exports);
    expect(tu.TARGET_SAMPLE_RATE).toBe(data.TARGET_SAMPLE_RATE);
    expect(tu.WEBCODECS_TIMESCALE).toBe(data.WEBCODECS_TIMESCALE);
  });
});

describe('loops, device pixels and text', () => {
  it('splits a visible range at the repeats of a loop', () => {
    expect(data.loopSegments.length).toBeGreaterThan(200);
    for (const c of data.loopSegments) expect(tu.getLoopDisplaySegments(c.args), JSON.stringify(c.args)).toEqual(c.result);
  });

  it('gives the width of a repeat and says when to tile', () => {
    for (const c of data.loopWidth) {
      const loopDisplay = c.loopDisplay ?? undefined;
      expect(tu.getLoopDisplayWidth({ visualizationWidth: c.visualizationWidth, loopDisplay })).toBe(c.width);
      expect(tu.shouldTileLoopDisplay(loopDisplay)).toBe(c.tile);
    }
  });

  it('aligns a canvas to the pixel grid and snaps positions on it', () => {
    for (const c of data.pixelLayout) expect(tu.getDevicePixelAlignedCanvasLayout(c.args), JSON.stringify(c.args)).toEqual(c.result);
    for (const c of data.snap) {
      expect(tu.snapCanvasPositionToDevicePixel({ position: c.position, horizontalOffset: c.horizontalOffset })).toBe(c.result);
    }
  });

  it('clamps timestamps below the end, and writes a volume', () => {
    for (const c of data.clamp) expect(tu.clampTimestampsToDuration(c), JSON.stringify(c)).toEqual(c.result);
    for (const c of data.formatVolume) {
      expect(tu.formatAverageAudioVolume(c.v === '-Infinity' ? -Infinity : c.v)).toBe(c.result);
    }
  });

  it('takes the volumes of the frames that show', () => {
    for (const c of data.visibleVolume) {
      const { volume, displayDurationInFrames, displayOffsetInFrames } = c;
      expect(tu.getVisibleWaveformVolume({ volume, displayDurationInFrames, displayOffsetInFrames }), JSON.stringify(c)).toEqual(c.result);
    }
  });
});

describe('slicing peaks', () => {
  it('matches the published slices, padding with silence past the file', () => {
    expect(f32(makePeaks(500))).toEqual(data.peaksSha);
    for (const c of data.slice) {
      const { waveformSampleRate, ...rest } = c.args;
      const result = tu.sliceWaveformPeaks({ ...rest, peaks: makePeaks(500), waveformSampleRate: waveformSampleRate ?? undefined });
      expect(f32(result), JSON.stringify(c.args)).toEqual(c.result);
    }
    expect(f32(tu.sliceWaveformPeaks({ durationInFrames: 30, fps: 30, peaks: new Float32Array(0), playbackRate: 1, startFrom: 0 }))).toEqual(data.sliceEmpty);
  });

  it('matches the published slices of the visible part, looped or not', () => {
    for (const c of data.sliceVisible) {
      const result = tu.sliceVisibleWaveformPeaks({ ...c.args, peaks: makePeaks(500), loopDisplay: c.args.loopDisplay ?? undefined });
      expect(f32(result), JSON.stringify(c.args)).toEqual(c.result);
    }
  });
});

describe('createWaveformPeakProcessor', () => {
  it('matches the published peaks, average volume and progress calls', () => {
    for (const c of data.processor) {
      const { totalPeaks, samplesPerPeak, channels, sampleRate, chunks, intervalMs } = c.args;
      const calls: any[] = [];
      let t = 0;
      const processor = tu.createWaveformPeakProcessor({
        totalPeaks,
        samplesPerPeak,
        progressIntervalInMs: intervalMs,
        now: () => (t += 1),
        onProgress: (p) =>
          calls.push({ completedPeaks: p.completedPeaks, totalPeaks: p.totalPeaks, final: p.final, averageVolume: p.averageVolume, peaks: f32(p.peaks.slice()) }),
      });
      let n = 0;
      for (const frames of chunks as number[]) {
        const floats = Float32Array.from({ length: frames * channels }, () => Math.sin(n++ * 0.7) * 0.5 + Math.cos(n * 0.013) * 0.25);
        processor.processSampleChunk(floats, channels, sampleRate);
      }
      processor.finalize();
      expect(Array.from(processor.peaks), JSON.stringify(c.args)).toEqual(c.peaks);
      expect(processor.averageVolume).toBe(c.averageVolume);
      expect(calls).toEqual(c.calls);
    }
  });
});

describe('the frame strip', () => {
  const fakeFrame = (timestamp: number, displayWidth = 40, displayHeight = 20) => ({
    timestamp,
    displayWidth,
    displayHeight,
    closed: false,
    allocationSize: () => displayWidth * displayHeight * 4,
    close() {
      this.closed = true;
    },
  });
  const recorder = () => {
    const calls: any[] = [];
    return { calls, ctx: { drawImage: (frame: any, ...rest: number[]) => calls.push(['drawImage', frame.timestamp, ...rest]) } as any };
  };

  it('lays out the thumbnails of a strip as the published package does', () => {
    expect(data.slots.length).toBeGreaterThan(100);
    for (const c of data.slots) {
      expect(tu.getDurationOfOneFrame(c.args), JSON.stringify(c.args)).toBe(c.oneFrame);
      expect(tu.calculateTimestampSlots(c.args), JSON.stringify(c.args)).toEqual(c.slots);
    }
    const filledSlots = new Map<number, number | undefined>([
      [1000, undefined],
      [2000, 1990],
    ]);
    tu.ensureSlots({ filledSlots, naturalWidth: 200, fromSeconds: 0, toSeconds: 4, aspectRatio: 2, frameHeight: 20 });
    expect(JSON.parse(JSON.stringify([...filledSlots.entries()]))).toEqual(data.ensure[0]);
  });

  it('draws frames into slots where they fit best', () => {
    const layout = { visualizationWidth: 200, segmentDuration: 4, fromSeconds: 0, devicePixelRatio: 2, frameHeight: 20, horizontalOffset: 0.3 };
    const { calls, ctx } = recorder();
    const filledSlots = new Map<number, number | undefined>();
    tu.ensureSlots({ filledSlots, naturalWidth: 200, fromSeconds: 0, toSeconds: 4, aspectRatio: 2, frameHeight: 20 });
    const slots = [...filledSlots.keys()];
    tu.drawSlot({ frame: fakeFrame(slots[1]! + 5), ctx, filledSlots, timestamp: slots[1]!, ...layout });
    tu.fillFrameWhereItFits({ frame: fakeFrame(slots[2]! + 100), ctx, filledSlots, ...layout });
    tu.fillFrameWhereItFits({ frame: fakeFrame(slots[2]! + 40), ctx, filledSlots, ...layout });
    tu.fillFrameWhereItFits({ frame: fakeFrame(slots[2]! + 4000000), ctx, filledSlots, ...layout });
    expect(slots).toEqual(data.draw[0].slots);
    expect(calls).toEqual(data.draw[0].calls);
    expect(JSON.parse(JSON.stringify([...filledSlots.entries()]))).toEqual(data.draw[0].filled);
  });

  it('fills slots from the cached frames of the file, and only that file', () => {
    const layout = { naturalWidth: 200, segmentDuration: 4, fromSeconds: 0, devicePixelRatio: 2, frameHeight: 20, horizontalOffset: 0 };
    for (const t of [0, 1000000, 2000000, 3000000]) tu.addFrameToCache(tu.makeFrameDatabaseKey('s.mp4', t), fakeFrame(t));
    tu.addFrameToCache(tu.makeFrameDatabaseKey('other.mp4', 500000), fakeFrame(500000));
    const { calls, ctx } = recorder();
    const filledSlots = new Map<number, number | undefined>();
    tu.ensureSlots({ filledSlots, naturalWidth: 200, fromSeconds: 0, toSeconds: 4, aspectRatio: 2, frameHeight: 20 });
    tu.fillWithCachedFrames({ ctx, filledSlots, src: 's.mp4', ...layout });
    expect(calls).toEqual(data.fillCached.calls);
    expect(JSON.parse(JSON.stringify([...filledSlots.entries()]))).toEqual(data.fillCached.filled);
  });

  it('renders a strip of cached frames to a canvas, and refuses to decode what is not cached', async () => {
    tu.aspectRatioCache.set('strip.mp4', 2);
    for (const t of [0, 1000000, 2000000, 3000000, 4000000]) tu.addFrameToCache(tu.makeFrameDatabaseKey('strip.mp4', t), fakeFrame(t));
    const { calls, ctx } = recorder();
    const sizes: number[] = [];
    const canvas = {
      get width() { return sizes[0] ?? 0; },
      set width(v: number) { sizes[0] = v; },
      get height() { return sizes[1] ?? 0; },
      set height(v: number) { sizes[1] = v; },
      getContext: () => ({ ...ctx, clearRect() {}, setTransform() {} }),
    } as any;
    const options = { canvas, src: 'strip.mp4', fromSeconds: 0, toSeconds: 4, width: 100, frameHeight: 20, devicePixelRatio: 2, horizontalOffset: 0.5 };
    await tu.renderFrameStripToCanvas(options);
    expect(sizes).toEqual([101, 20]);
    expect(calls.length).toBeGreaterThan(0);
    // Another file has nothing cached: its pictures would have to be decoded.
    await expect(tu.renderFrameStripToCanvas({ ...options, src: 'nothing.mp4' })).rejects.toBeInstanceOf(UnsupportedApiError);
    // A strip that is empty, or already aborted, draws nothing and does not need them.
    await tu.renderFrameStripToCanvas({ ...options, src: 'nothing.mp4', toSeconds: 0 });
  });

  it('keeps 10 MiB of frames, least recently used out first, closing what it drops', async () => {
    vi.resetModules();
    const fresh = await import('../src/timeline-utils/index.js');
    const frames = Array.from({ length: 12 }, (_, i) => fakeFrame(i * 1000, 512, 512));
    frames.forEach((frame, i) => fresh.addFrameToCache(fresh.makeFrameDatabaseKey('big.mp4', i * 1000), frame));
    const kept = [...fresh.frameDatabase.keys()].map((key) => fresh.getTimestampFromFrameDatabaseKey(key));
    expect(kept).toEqual(data.cache.kept);
    expect(frames.map((f) => f.closed)).toEqual(data.cache.closed);
    // The frame under a key is replaced, and the one it replaces is closed.
    fresh.addFrameToCache(fresh.makeFrameDatabaseKey('big.mp4', 11000), fakeFrame(11000, 512, 512));
    expect(frames[11]!.closed).toBe(data.cache.replacedOldClosed);
  });

  it('builds and reads cache keys like the published package', () => {
    expect(tu.makeFrameDatabaseKey('clip.mp4', 1500000)).toBe(data.cache.key);
    expect(tu.getFrameDatabaseKeyPrefix('clip.mp4')).toBe(data.cache.prefix);
    expect(tu.getTimestampFromFrameDatabaseKey(tu.makeFrameDatabaseKey('clip.mp4', 1500000))).toBe(data.cache.timestamp);
    expect(tu.getTimestampFromFrameDatabaseKey(tu.makeFrameDatabaseKey('a|b.mp4', 42))).toBe(data.cache.timestampWithBar);
    tu.aspectRatioCache.set('known.mp4', 1.5);
    tu.aspectRatioCache.set('zero.mp4', 0);
    expect(tu.getAspectRatioFromCache('nope.mp4')).toBe(data.cache.aspectMissing);
    expect(tu.getAspectRatioFromCache('known.mp4')).toBe(data.cache.aspectKnown);
    expect(tu.getAspectRatioFromCache('zero.mp4')).toBe(data.cache.aspectZero);
  });

  it('exports what needs decoded pictures, and says so when called', async () => {
    await expect(tu.extractFrames({ src: 'a.mp4', timestampsInSeconds: [0], onVideoSample: () => {} })).rejects.toThrow(
      /@remotion\/timeline-utils: extractFrames\(\) is not supported by Kinetograph/,
    );
    const frame = fakeFrame(0);
    expect(tu.resizeVideoFrame({ frame, scale: 1 })).toBe(frame);
    expect(() => tu.resizeVideoFrame({ frame, scale: 0.5 })).toThrow(UnsupportedApiError);
  });
});

describe('drawBars', () => {
  const peaks = makePeaks(300);

  function canvasOf(width: number, height: number) {
    const state: { image: { data: Uint8ClampedArray } | null } = { image: null };
    const canvas = {
      width,
      height,
      getContext: () => ({
        clearRect() {},
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: (image: { data: Uint8ClampedArray }) => {
          state.image = image;
        },
      }),
    } as any;
    return { canvas, state };
  }

  it('draws the same pixels as the published package: zoomed in and out, looped, with volume and clipping', () => {
    for (const c of data.bars) {
      const { w, h, width, horizontalOffset, color, volume, range } = c.args;
      const { canvas, state } = canvasOf(w, h);
      tu.drawBars({ canvas, color, peaks, range, volume, width, horizontalOffset });
      expect(state.image !== null, JSON.stringify(c.args)).toBe(c.drawn);
      if (state.image) {
        expect(sha(new Uint8Array(state.image.data.buffer)), JSON.stringify(c.args)).toBe(c.sha);
        expect(state.image.data.reduce((n, v, i) => n + (i % 4 === 3 && v > 0 ? 1 : 0), 0)).toBe(c.litPixels);
      }
    }
  });

  it('draws into a canvas of the engine', async () => {
    await import('../src/web-install.js');
    const canvas = new (globalThis as any).OffscreenCanvas(40, 20);
    const ctx = canvas.getContext('2d');
    const put = vi.spyOn(ctx, 'putImageData');
    tu.drawBars({
      canvas,
      color: '#0b84f3',
      peaks,
      range: { sourceStart: 0, sourceDuration: 300, displayStart: 0, displayDuration: 300, loop: false },
      volume: 1,
      width: 40,
      horizontalOffset: 0,
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect((put.mock.calls[0]![0] as { data: Uint8ClampedArray }).data.some((v) => v > 0)).toBe(true);
  });
});

describe('loading peaks', () => {
  /** A decoder that answers with a constant 0.5 on two channels for `seconds`. */
  function decoderOf(seconds: number, level = 0.5, channels = 2) {
    const decode = vi.fn((_path: string, sampleRate: number) => ({
      sampleRate,
      channels: Array.from({ length: channels }, () => new Float32Array(Math.round(seconds * sampleRate)).fill(level)),
    }));
    setAudioDecoder(decode);
    return decode;
  }

  it('computes 100 peaks a second and the average volume in dBFS', async () => {
    decoderOf(1.5);
    const progress: { completedPeaks: number; final: boolean }[] = [];
    const result = await tu.loadWaveformPeaks('sound-a.wav', new AbortController().signal, { onProgress: (p) => progress.push(p) });
    expect(result.peaks).toHaveLength(150);
    expect(Array.from(result.peaks).every((p) => p === 0.5)).toBe(true);
    expect(result.averageVolume).toBeCloseTo(10 * Math.log10(0.25), 6);
    expect(result.maxima.length).toBeGreaterThan(0);
    expect(result.maxima[0]).toHaveLength(75);
    expect(progress.at(-1)).toMatchObject({ completedPeaks: 150, final: true });
  });

  it('reads a file once per sample rate, and answers the second call from the result', async () => {
    const decode = decoderOf(1);
    const first = await tu.loadWaveformPeaks('sound-b.wav', new AbortController().signal);
    const progress = vi.fn();
    const second = await tu.loadWaveformPeaks('sound-b.wav', new AbortController().signal, { onProgress: progress });
    expect(second).toBe(first);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ final: true, totalPeaks: 100 }));
    expect(decode).toHaveBeenCalledTimes(1);
    const coarse = await tu.loadWaveformPeaks('sound-b.wav', new AbortController().signal, { waveformSampleRate: 10 });
    expect(coarse.peaks).toHaveLength(10);
  });

  it('gives no peaks for a file without sound or an aborted load, and refuses a bad rate or a mediabunny track', async () => {
    setAudioDecoder(() => null);
    expect(await tu.loadWaveformPeaks('silent.mp4', new AbortController().signal)).toEqual({ peaks: new Float32Array(0), maxima: [], averageVolume: null });
    decoderOf(1);
    const controller = new AbortController();
    controller.abort();
    expect((await tu.loadWaveformPeaks('aborted.wav', controller.signal)).peaks).toHaveLength(0);
    await expect(tu.loadWaveformPeaks('x.wav', new AbortController().signal, { waveformSampleRate: 0 })).rejects.toThrow(/positive number/);
    await expect(tu.loadWaveformPeaks({ id: 1 }, new AbortController().signal)).rejects.toBeInstanceOf(UnsupportedApiError);
  });

  it('subscribes: one load for listeners of a file, the kept result for a later one, errors to all', async () => {
    const decode = decoderOf(1, 0.25, 1);
    const seen: [string, boolean, number | null][] = [];
    const listen = (name: string) =>
      tu.subscribeToWaveformPeaks({
        src: 'sub.wav',
        onPeaks: (peaks, final, averageVolume) => seen.push([`${name}:${peaks.length}`, final, averageVolume]),
        onError: () => seen.push([`${name}:error`, true, null]),
      });
    listen('a');
    const unsubscribed = listen('b');
    unsubscribed();
    await vi.waitFor(() => expect(seen.length).toBe(1));
    expect(seen[0]![0]).toBe('a:100');
    expect(seen[0]![2]).toBeCloseTo(10 * Math.log10(0.0625), 6);
    listen('c');
    expect(seen.map((s) => s[0])).toEqual(['a:100', 'c:100']);
    expect(decode).toHaveBeenCalledTimes(1);

    setAudioDecoder(() => {
      throw new Error('cannot open');
    });
    const errors: string[] = [];
    tu.subscribeToWaveformPeaks({ src: 'broken.wav', onPeaks: () => {}, onError: (e) => errors.push(e.message) });
    await vi.waitFor(() => expect(errors).toEqual(['cannot open']));
  });
});
