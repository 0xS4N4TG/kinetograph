import { afterEach, describe, expect, it } from 'vitest';
import {
  AUDIO_DATA_SAMPLE_RATE,
  type MediaUtilsAudioData,
  getAudioData,
  getAudioDurationInSeconds,
  getWaveformPortion,
  setAudioDecoder,
  useAudioData,
  useWindowedAudioData,
  visualizeAudio,
} from '../src/media-utils.js';
import { setRemoteStylesheetResolver } from '@kinetographdev/compat/dom';
import { NodeFontFace, installFontFace } from '../src/font-face.js';
import { clearFonts, getFonts } from '../src/font-registry.js';
import { fixture } from './helpers.js';

const RATE = AUDIO_DATA_SAMPLE_RATE;

/** `seconds` of a sine at `hz` and `amplitude`, in both channels. */
function sine(hz: number, seconds: number, amplitude = 1): Float32Array[] {
  const samples = Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / RATE));
  return [samples, samples.slice()];
}

interface SignalSpec {
  seconds: number;
  sampleRate?: number;
  channels: { seed?: number; parts: { kind: string; hz?: number; amp: number }[]; impulses?: [number, number][] }[];
}

/** The synthetic AudioData of a fixture spec (the recording script has the same generator). */
function signalOf(spec: SignalSpec): MediaUtilsAudioData {
  const rate = spec.sampleRate ?? 48000;
  const n = Math.round(rate * spec.seconds);
  const channelWaveforms = spec.channels.map((ch) => {
    const a = new Float32Array(n);
    let seed = ch.seed ?? 1;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      let x = 0;
      for (const part of ch.parts) {
        if (part.kind === 'sine') x += part.amp * Math.sin(2 * Math.PI * part.hz! * t);
        else if (part.kind === 'noise') {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          x += part.amp * ((seed / 4294967296) * 2 - 1);
        } else if (part.kind === 'dc') x += part.amp;
        else if (part.kind === 'ramp') x += (t / spec.seconds) * part.amp * Math.sin(2 * Math.PI * part.hz! * t);
      }
      a[i] = x;
    }
    for (const [pos, amp] of ch.impulses ?? []) a[pos] = amp;
    return a;
  });
  return { channelWaveforms, sampleRate: rate, durationInSeconds: n / rate, numberOfChannels: channelWaveforms.length, resultId: 'fixture', isRemote: false };
}

function serve(files: Record<string, Float32Array[]>) {
  const calls: string[] = [];
  setAudioDecoder((path, sampleRate) => {
    calls.push(path);
    const channels = files[path];
    if (!channels) throw new Error(`IO: no such file ${path}`);
    return channels.length ? { sampleRate, channels } : null;
  });
  return calls;
}

afterEach(() => {
  setAudioDecoder(null);
  setRemoteStylesheetResolver(null);
});

describe('getAudioData and its hooks', () => {
  it('decode a file once and report Remotion’s fields', async () => {
    const calls = serve({ 'tone.wav': sine(440, 2) });
    const data = await getAudioData('tone.wav');
    expect(data.sampleRate).toBe(RATE);
    expect(data.numberOfChannels).toBe(2);
    expect(data.durationInSeconds).toBeCloseTo(2, 6);
    expect(data.isRemote).toBe(false);
    expect(useAudioData('tone.wav')).toBe(data);
    expect(useWindowedAudioData({ src: 'tone.wav', frame: 10, fps: 30, windowInSeconds: 1 })).toEqual({ audioData: data, dataOffsetInSeconds: 0 });
    expect(await getAudioDurationInSeconds('tone.wav')).toBeCloseTo(2, 6);
    expect(calls).toEqual(['tone.wav']);
  });

  it('decode once per sample rate and give each rate its own data (Remotion 4.0.540)', async () => {
    const calls: string[] = [];
    setAudioDecoder((path, sampleRate) => {
      calls.push(`${path}@${sampleRate}`);
      return { sampleRate, channels: [new Float32Array(sampleRate)] };
    });
    const at48 = await getAudioData('tone.wav');
    const at22 = await getAudioData('tone.wav', { sampleRate: 22050 });
    expect(at48.sampleRate).toBe(RATE);
    expect(at22.sampleRate).toBe(22050);
    expect(at22.durationInSeconds).toBe(1);
    expect(at22.resultId).not.toBe(at48.resultId);
    expect(await getAudioData('tone.wav', { sampleRate: 22050 })).toBe(at22);
    expect(await getAudioData('tone.wav', { sampleRate: RATE })).toBe(at48);
    expect(calls).toEqual([`tone.wav@${RATE}`, 'tone.wav@22050']);
    await expect(getAudioData('tone.wav', { sampleRate: 0 })).rejects.toThrow(/sampleRate/);
  });

  it('fail clearly for a file with no sound and for a URL', async () => {
    serve({ 'silent.mp4': [] });
    await expect(getAudioData('silent.mp4')).rejects.toThrow(/no audio stream/);
    await expect(getAudioData('https://example.com/a.mp3')).rejects.toThrow(/remote files/);
  });
});

describe('a remote file the host has cached', () => {
  it('is decoded from the cache, under the URL it was asked for', async () => {
    const url = 'https://remotion.media/track.mp3';
    serve({ '/cache/track.mp3': sine(440, 1) });
    setRemoteStylesheetResolver((u) => (u === url ? '/cache/track.mp3' : null));
    const data = await getAudioData(url);
    expect(data.durationInSeconds).toBeCloseTo(1, 3);
    expect(data.resultId).toBe(`kinetograph-audio:${url}`);
    expect(useWindowedAudioData({ src: url, frame: 0, fps: 30, windowInSeconds: 10 }).audioData).toBe(data);
    await expect(getAudioData('https://remotion.media/other.mp3')).rejects.toThrow(/remote files/);
  });
});

describe('useWindowedAudioData (remotion.dev/docs/use-windowed-audio-data)', () => {
  it('gives the window of the frame with the one before and after, and where that slice starts in the file', () => {
    // 100 s of a quiet tone with one loud second at 50 s.
    const samples = Float32Array.from({ length: 100 * RATE }, (_, i) => (i >= 50 * RATE && i < 51 * RATE ? 0.9 : 0.1) * Math.sin(i / 10));
    serve({ 'long.wav': [samples] });
    const at = (seconds: number) => useWindowedAudioData({ src: 'long.wav', frame: seconds * 30, fps: 30, windowInSeconds: 10 });
    // Frame at 25 s is in window 2 (20 to 30 s): the data is 10 to 40 s.
    const near = at(25);
    expect(near.dataOffsetInSeconds).toBe(10);
    expect(near.audioData!.durationInSeconds).toBe(30);
    expect(near.audioData!.channelWaveforms[0]!.length).toBe(30 * RATE);
    // The first window has nothing before it: 0 to 20 s.
    expect(at(3).dataOffsetInSeconds).toBe(0);
    expect(at(3).audioData!.durationInSeconds).toBe(20);
    // The same slice for every frame of the window, and visualizeAudio scales by the loudest sample of the slice: the loud
    // second (50 s) is not in the slice of 25 s, so a quiet frame there is not made smaller by it.
    expect(at(25.5).audioData).toBe(near.audioData);
    const quiet = visualizeAudio({ audioData: near.audioData!, frame: 25 * 30, fps: 30, numberOfSamples: 32, dataOffsetInSeconds: near.dataOffsetInSeconds });
    const whole = visualizeAudio({ audioData: useAudioData('long.wav')!, frame: 25 * 30, fps: 30, numberOfSamples: 32 });
    expect(Math.max(...quiet)).toBeGreaterThan(Math.max(...whole) * 5);
  });
});

describe('visualizeAudio', () => {
  it('puts a tone in its bins and is the same on every call', () => {
    serve({ 'tone.wav': sine(3000, 1) });
    const audioData = useAudioData('tone.wav')!;
    const bands = visualizeAudio({ audioData, frame: 15, fps: 30, numberOfSamples: 16 });
    expect(bands).toHaveLength(16);
    // 16 bins over 0..24 kHz are 1.5 kHz each: 3 kHz is the start of bin 2.
    expect(bands.indexOf(Math.max(...bands))).toBe(2);
    expect(visualizeAudio({ audioData, frame: 15, fps: 30, numberOfSamples: 16 })).toEqual(bands);
  });

  // `how` of the fixture: the published package called on the synthetic signals of `signalOf`, on 63 cases (sizes,
  // frames at and past both ends of the file, other frame rates and sample rates, a second channel, an offset).
  it('gives what Remotion 4.0.542 gives', () => {
    const recorded = fixture('visualize-audio-4.0.542.json');
    for (const c of recorded.cases) {
      const spec = recorded.specs[c.spec];
      const audioData = signalOf(spec);
      const got = visualizeAudio({ audioData, ...c.args });
      expect(got, `${c.spec} ${JSON.stringify(c.args)}`).toHaveLength(c.result.length);
      for (let i = 0; i < got.length; i++) {
        if (Math.abs(got[i]! - c.result[i]) > 2e-5) expect.fail(`${c.spec} ${JSON.stringify(c.args)}: bin ${i} is ${got[i]}, Remotion gives ${c.result[i]}`);
      }
    }
  });

  // Remotion 4.0.539: a silent waveform used to give NaN in every band (a division by its peak, which was 0) and a waveform
  // of only negative samples a non-finite peak. Both are plain numbers now.
  it('gives zeros for silence and finite bands for a waveform of only negative samples (Remotion 4.0.539)', () => {
    const length = RATE;
    serve({
      'silence.wav': [new Float32Array(length), new Float32Array(length)],
      'negative.wav': [new Float32Array(length).fill(-0.5), new Float32Array(length).fill(-0.5)],
    });
    for (const smoothing of [true, false]) {
      const silence = visualizeAudio({ audioData: useAudioData('silence.wav')!, frame: 15, fps: 30, numberOfSamples: 16, smoothing });
      expect(silence).toEqual(new Array(16).fill(0));
      const negative = visualizeAudio({ audioData: useAudioData('negative.wav')!, frame: 15, fps: 30, numberOfSamples: 16, smoothing });
      expect(negative).toHaveLength(16);
      expect(negative.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
    }
  });

  it('is silent outside the file and rejects a band count that is not a power of two', () => {
    serve({ 'tone.wav': sine(440, 1) });
    const audioData = useAudioData('tone.wav')!;
    expect(visualizeAudio({ audioData, frame: 300, fps: 30, numberOfSamples: 8, smoothing: false }).every((v) => v === 0)).toBe(true);
    expect(() => visualizeAudio({ audioData, frame: 0, fps: 30, numberOfSamples: 12 })).toThrow(/power of two/);
  });
});

describe('getWaveformPortion', () => {
  it('gives the mean absolute level of each bar', () => {
    const quiet = sine(440, 1, 0.1)[0]!;
    const loud = sine(440, 1, 0.8)[0]!;
    const both = new Float32Array(quiet.length * 2);
    both.set(quiet);
    both.set(loud, quiet.length);
    serve({ 'two.wav': [both] });
    const bars = getWaveformPortion({ audioData: useAudioData('two.wav')!, startTimeInSeconds: 0, durationInSeconds: 2, numberOfSamples: 2, normalize: false });
    // The mean of |sin| is 2/π.
    expect(bars[0]!.amplitude).toBeCloseTo((0.1 * 2) / Math.PI, 3);
    expect(bars[1]!.amplitude).toBeCloseTo((0.8 * 2) / Math.PI, 3);
    expect(bars.map((b) => b.index)).toEqual([0, 1]);
    // Scaled so that the loudest bar is 1, unless asked not to, as Remotion's is.
    const scaled = getWaveformPortion({ audioData: useAudioData('two.wav')!, startTimeInSeconds: 0, durationInSeconds: 2, numberOfSamples: 2 });
    expect(scaled[1]!.amplitude).toBeCloseTo(1, 9);
    expect(scaled[0]!.amplitude).toBeCloseTo(0.1 / 0.8, 3);
  });
});

describe('FontFace in Node', () => {
  afterEach(() => clearFonts());

  it('registers a face added to document.fonts, keeping the file that covers basic Latin', async () => {
    installFontFace();
    const doc = (globalThis as unknown as { document: { fonts: Set<unknown> & { add(face: unknown): void } } }).document;
    const FontFaceCtor = (globalThis as unknown as { FontFace: typeof NodeFontFace }).FontFace;
    const latin = new FontFaceCtor('Inter', "url('/fonts/inter-latin.woff2') format('woff2')", { weight: '800', unicodeRange: 'U+0000-00FF, U+2000-206F' });
    const ext = new FontFaceCtor('Inter', 'url(/fonts/inter-latin-ext.woff2)', { weight: '800', unicodeRange: 'U+0100-02BA' });
    doc.fonts.add(await latin.load());
    doc.fonts.add(await ext.load());
    expect(getFonts()['Inter:800']).toBe('/fonts/inter-latin.woff2');
  });

  it('refuses sources it cannot read', () => {
    expect(() => new NodeFontFace('Inter', new ArrayBuffer(4))).toThrow(/url/);
    // A remote source is read, not refused: it is downloaded into the font cache (remote-fonts.test.ts).
    expect(new NodeFontFace('Inter', 'url(https://fonts.example/inter.woff2)').remote).toBe('https://fonts.example/inter.woff2');
  });
});
