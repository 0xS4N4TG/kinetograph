import { afterEach, describe, expect, it } from 'vitest';
import {
  AUDIO_DATA_SAMPLE_RATE,
  getAudioData,
  getAudioDurationInSeconds,
  getWaveformPortion,
  setAudioDecoder,
  useAudioData,
  useWindowedAudioData,
  visualizeAudio,
} from '../src/media-utils.js';
import { NodeFontFace, installFontFace } from '../src/font-face.js';
import { clearFonts, getFonts } from '../src/font-registry.js';

const RATE = AUDIO_DATA_SAMPLE_RATE;

/** `seconds` of a sine at `hz` and `amplitude`, in both channels. */
function sine(hz: number, seconds: number, amplitude = 1): Float32Array[] {
  const samples = Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / RATE));
  return [samples, samples.slice()];
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

afterEach(() => setAudioDecoder(null));

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

  it('fail clearly for a file with no sound and for a URL', async () => {
    serve({ 'silent.mp4': [] });
    await expect(getAudioData('silent.mp4')).rejects.toThrow(/no audio stream/);
    await expect(getAudioData('https://example.com/a.mp3')).rejects.toThrow(/remote files/);
  });
});

describe('visualizeAudio', () => {
  it('puts a tone in its band, reads about 1 for a full-scale sine, and is the same on every call', () => {
    serve({ 'tone.wav': sine(3000, 1) });
    const audioData = useAudioData('tone.wav')!;
    const bands = visualizeAudio({ audioData, frame: 15, fps: 30, numberOfSamples: 16 });
    expect(bands).toHaveLength(16);
    // 16 bands over 0..24 kHz are 1.5 kHz each: 3 kHz is the start of band 2.
    const loudest = bands.indexOf(Math.max(...bands));
    expect(loudest).toBe(2);
    expect(bands[loudest]).toBeGreaterThan(0.8);
    expect(bands[loudest]).toBeLessThanOrEqual(1);
    expect(bands[10]).toBeLessThan(0.01);
    expect(visualizeAudio({ audioData, frame: 15, fps: 30, numberOfSamples: 16 })).toEqual(bands);
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
    expect(() => new NodeFontFace('Inter', 'url(https://fonts.example/inter.woff2)')).toThrow(/remote/);
  });
});
