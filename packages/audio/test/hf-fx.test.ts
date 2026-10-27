import { describe, expect, it } from 'vitest';
import { renderAudio, type AudioClipTimeline } from '../src/index.js';
import { parseFxChain, FxChainError } from '../src/hf-fx/chain.js';
import { parseFxLanes } from '../src/hf-fx/automation.js';
import { chainLatencySamples, chainTailSeconds, reverbImpulse, runFxChain } from '../src/hf-fx/graph.js';
import { peakBetween, sine, writeWav } from './helpers.js';

const RATE = 48000;
const FPS = 30;
const chain = (...nodes: object[]): string => JSON.stringify({ version: 1, nodes });
const lanes = (...l: object[]): string => JSON.stringify({ version: 1, lanes: l });
const impulse = (length: number, at: number, value = 0.5): Float32Array[] =>
  [0, 1].map(() => {
    const a = new Float32Array(length);
    a[at] = value;
    return a;
  });
const nonZero = (a: Float32Array): number[] => [...a].flatMap((v, i) => (Math.abs(v) > 0.01 ? [i] : []));

describe('HyperFrames effect chains', () => {
  it('reads a chain as HyperFrames does: defaults, clamping, bypass, and refusing what it refuses', () => {
    const parsed = parseFxChain(chain({ type: 'peaking', id: 'n1', params: { gain: 99, frequency: 'x' } }, { type: 'gain', enabled: false }));
    expect(parsed.nodes[0]!.params).toEqual({ frequency: 1000, gain: 40, q: 1 });
    expect(parsed.nodes[1]!.enabled).toBe(false);
    expect(() => parseFxChain('{"version":2,"nodes":[]}')).toThrow(FxChainError);
    expect(() => parseFxChain(chain({ type: 'wobble' }))).toThrow(/unknown effect type: wobble/);
    expect(() => parseFxChain('not json')).toThrow(/not valid JSON/);
  });

  it('binds lanes to the chain: clamped to the range, a lane on a missing node or an enum dropped', () => {
    const c = parseFxChain(chain({ type: 'peaking', id: 'n1' }, { type: 'highpass', id: 'n2' }));
    const read = parseFxLanes(
      lanes(
        { target: 'fx.n1.gain', points: [{ t: 1, v: 99 }, { t: 0, v: -3 }] },
        { target: 'fx.n9.gain', points: [{ t: 0, v: 1 }] },
        { target: 'fx.n2.poles', points: [{ t: 0, v: 1 }] },
        { target: 'volume', points: [{ t: 0, v: 1 }] },
      ),
      c,
    );
    expect(read).toEqual([{ target: 'fx.n1.gain', points: [{ t: 0, v: -3 }, { t: 1, v: 40 }] }]);
    expect(() => parseFxLanes(lanes({ target: 'pan', points: [] }), c)).toThrow(/unreadable target/);
  });

  it('runs a gain stage exactly and leaves an empty chain alone', async () => {
    const input = [sine(440, 0.5, 0.2, RATE), sine(440, 0.25, 0.2, RATE)];
    const out = await runFxChain(input, RATE, parseFxChain(chain({ type: 'gain', params: { gain: -6 } })), [], { scheduledAt: 0, elapsed: 0 });
    const k = Math.pow(10, -6 / 20);
    for (const i of [100, 5000, 9000]) {
      expect(out[0]![i]).toBeCloseTo(input[0]![i]! * k, 6);
      expect(out[1]![i]).toBeCloseTo(input[1]![i]! * k, 6);
    }
    const same = await runFxChain(input, RATE, parseFxChain(chain({ type: 'gain', enabled: false })), [], { scheduledAt: 0, elapsed: 0 });
    expect(same).toBe(input);
  });

  it('repeats a delay as Chrome does: the first echo at the delay time, each later one a render quantum after it', async () => {
    for (const ms of [2, 180]) {
      const c = parseFxChain(chain({ type: 'delay', params: { time: ms, feedback: 0.5, mix: 1 } }));
      const out = await runFxChain(impulse(RATE, 1000), RATE, c, [], { scheduledAt: 0, elapsed: 0 });
      const T = (ms * RATE) / 1000;
      expect(nonZero(out[0]!).slice(0, 3)).toEqual([1000 + T, 1000 + 2 * T + 128, 1000 + 3 * T + 256]);
      expect(out[0]![1000 + T]).toBeCloseTo(0.5, 3);
      expect(out[0]![1000 + 2 * T + 128]).toBeCloseTo(0.25, 3);
    }
  });

  it('trims a true-peak limiter\'s lookahead, so the output lines up with the input', async () => {
    const c = parseFxChain(chain({ type: 'truepeak', params: { ceiling: 0, lookahead: 3 } }));
    expect(chainLatencySamples(c, RATE)).toBe(144 + 16);
    const out = await runFxChain(impulse(RATE / 10, 1000, 0.25), RATE, c, [], { scheduledAt: 0, elapsed: 0 });
    expect(out[0]!.length).toBe(RATE / 10);
    expect(out[0]![1000]).toBeCloseTo(0.25, 5);
  });

  it('holds the oversampled saturation to Chrome\'s latency: 128 frames at 2x, 192 at 4x', async () => {
    for (const [oversample, latency] of [
      [2, 128],
      [4, 192],
    ] as const) {
      const c = parseFxChain(chain({ type: 'saturate', params: { type: 'hard', threshold: 0, oversample } }));
      const out = await runFxChain(impulse(4096, 1000, 0.25), RATE, c, [], { scheduledAt: 0, elapsed: 0 });
      let peak = 0;
      for (let i = 0; i < out[0]!.length; i++) if (Math.abs(out[0]![i]!) > Math.abs(out[0]![peak]!)) peak = i;
      expect(peak).toBe(1000 + latency);
    }
  });

  it('drives a knob with a lane on the lane clock', async () => {
    const c = parseFxChain(chain({ type: 'gain', id: 'n1', params: { gain: 0 } }));
    const l = parseFxLanes(lanes({ target: 'fx.n1.gain', points: [{ t: 1, v: 0 }, { t: 2, v: -20 }] }), c);
    const ones = [0, 1].map(() => new Float32Array(RATE).fill(0.5));
    // The pass starts 1.5 s into the lane: half way down the ramp.
    const out = await runFxChain(ones, RATE, c, l, { scheduledAt: 0, elapsed: 1.5 });
    expect(out[0]![0]).toBeCloseTo(0.5 * Math.pow(10, -10 / 20), 3);
    expect(out[0]![RATE - 1]).toBeCloseTo(0.5 * Math.pow(10, -20 / 20), 3);
  });

  it('runs a worklet effect while a render has replaced setTimeout with the frame clock', async () => {
    const g = globalThis as { setTimeout: typeof setTimeout };
    const real = g.setTimeout;
    // The determinism shim's timers fire only when a frame advances; one that never fires stands in for it.
    g.setTimeout = (() => 0) as unknown as typeof setTimeout;
    try {
      const c = parseFxChain(chain({ type: 'limiter', params: { limit: -6 } }));
      const out = await runFxChain(impulse(RATE / 10, 100), RATE, c, [], { scheduledAt: 0, elapsed: 0 });
      expect(out[0]!.length).toBe(RATE / 10);
      expect(g.setTimeout).not.toBe(real);
    } finally {
      g.setTimeout = real;
    }
  });

  it('builds the same reverb impulse every time, at unit energy, as long as its room', () => {
    const a = reverbImpulse(RATE, 0.7, 0.5);
    expect(a).toEqual(reverbImpulse(RATE, 0.7, 0.5));
    expect(a.length).toBe(Math.floor(RATE * (0.6 + 0.7 * 2.6)));
    expect(a.reduce((s, v) => s + v * v, 0)).toBeCloseTo(1, 4);
    const c = parseFxChain(chain({ type: 'reverb', params: { size: 0.7 } }, { type: 'delay', params: { time: 5000, feedback: 0.95 } }));
    expect(chainTailSeconds(c, [])).toBe(5);
  });
});

describe('renderAudio with HyperFrames effects', () => {
  const clip = (over: Partial<AudioClipTimeline> & { frames: [number, number]; volume?: number }): AudioClipTimeline => {
    const volumes = new Map<number, number>();
    for (let f = over.frames[0]; f <= over.frames[1]; f++) volumes.set(f, over.volume ?? 1);
    const { frames: _f, volume: _v, ...rest } = over;
    return { id: 'clip', src: 'clip.wav', from: over.frames[0], trimBefore: 0, trimAfter: null, playbackRate: 1, loop: false, muted: false, volumes, ...rest };
  };
  const fx = (over: Partial<NonNullable<AudioClipTimeline['hfFx']>>): NonNullable<AudioClipTimeline['hfFx']> => ({
    track: 'a',
    start: 1,
    end: 2,
    chain: null,
    automation: null,
    pre: 1,
    after: 1,
    group: null,
    master: null,
    ...over,
  });

  it('plays an element through its chain with `pre` ahead of it and `volume` after, and lets the tail ring on', async () => {
    const { dir } = writeWav(sine(440, 0.5, 1, RATE), RATE);
    const reverb = chain({ type: 'reverb', params: { size: 0.1, wet: 1, dry: 1 } });
    const pcm = await renderAudio({
      fps: FPS,
      first: 0,
      last: 149,
      baseDir: dir,
      clips: [clip({ frames: [30, 59], volume: 0.5, hfFx: fx({ chain: reverb, pre: 0.8, after: 0.5 }) })],
    });
    const ch = pcm.channels[0]!;
    expect(peakBetween(ch, RATE, 0, 0.99)).toBe(0);
    // The dry half: 0.5 * 0.8 * 0.5 at the peak, plus the room.
    expect(peakBetween(ch, RATE, 1.2, 1.9)).toBeGreaterThan(0.2);
    // A room of 0.86 s rings past the clip's end at 2 s, and stops at the end of the tail.
    expect(peakBetween(ch, RATE, 2.05, 2.5)).toBeGreaterThan(1e-3);
    expect(peakBetween(ch, RATE, 2.9, 5)).toBe(0);
  });

  it('cuts the tail after a fade-out (`after` 0)', async () => {
    const { dir } = writeWav(sine(440, 0.5, 1, RATE), RATE);
    const pcm = await renderAudio({
      fps: FPS,
      first: 0,
      last: 149,
      baseDir: dir,
      clips: [clip({ frames: [30, 59], hfFx: fx({ chain: chain({ type: 'reverb', params: { size: 0.5, wet: 1 } }), after: 0 }) })],
    });
    expect(peakBetween(pcm.channels[0]!, RATE, 2.01, 5)).toBe(0);
  });

  it('sums a group into its bus, runs the bus chain, then the fader; and the master over the mix', async () => {
    const { dir } = writeWav(sine(440, 0.5, 1, RATE), RATE);
    const group = { id: 'g', chain: chain({ type: 'gain', params: { gain: -6 } }), automation: null };
    const member = (track: string, frames: [number, number]): AudioClipTimeline => ({
      ...clip({ frames, hfFx: fx({ track, start: frames[0] / FPS, end: (frames[1] + 1) / FPS, group }) }),
      groupGains: new Map(Array.from({ length: frames[1] - frames[0] + 1 }, (_, i): [number, number] => [frames[0] + i, 0.5])),
    });
    const master = chain({ type: 'gain', params: { gain: -6 } });
    const pcm = await renderAudio({
      fps: FPS,
      first: 0,
      last: 89,
      baseDir: dir,
      clips: [member('a', [0, 29]), { ...member('b', [30, 59]), hfFx: { ...member('b', [30, 59]).hfFx!, master } }],
    });
    const k = Math.pow(10, -6 / 20);
    // Group: -6 dB, fader 0.5; master: another -6 dB.
    expect(peakBetween(pcm.channels[0]!, RATE, 0.1, 0.9)).toBeCloseTo(0.5 * k * 0.5 * k, 3);
    expect(peakBetween(pcm.channels[0]!, RATE, 1.1, 1.9)).toBeCloseTo(0.5 * k * 0.5 * k, 3);
  });

  it('stops on an unreadable chain, naming the element', async () => {
    const { dir } = writeWav(sine(440, 0.5, 1, RATE), RATE);
    await expect(
      renderAudio({ fps: FPS, first: 0, last: 29, baseDir: dir, clips: [clip({ frames: [0, 29], hfFx: fx({ track: 'vo', chain: '{"version":1,"nodes":[{"type":"nope"}]}' }) })] }),
    ).rejects.toThrow(/#vo .*unknown effect type: nope/);
  });

  it('is the same sound every time', async () => {
    const { dir } = writeWav(sine(440, 0.5, 1, RATE), RATE);
    const c = chain({ type: 'chorus', id: 'n1' }, { type: 'compressor', params: { threshold: -20 } }, { type: 'pitchshift', params: { semitones: 3 } });
    const render = () =>
      renderAudio({ fps: FPS, first: 0, last: 59, baseDir: dir, clips: [clip({ frames: [10, 39], hfFx: fx({ start: 10 / FPS, chain: c }) })] });
    const a = await render();
    const b = await render();
    expect(Buffer.from(a.channels[0]!.buffer).equals(Buffer.from(b.channels[0]!.buffer))).toBe(true);
  });
});
