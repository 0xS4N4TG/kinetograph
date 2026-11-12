// A page's AudioContext (page-audio.ts): on the virtual clock, recorded for the mix, and an AnalyserNode answered from
// the sound itself so a spectrum is a function of the frame.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDeterminism, resetVirtualClock, setVirtualFrame, uninstallDeterminism } from '../src/determinism.js';
import { installPageAudio, pageAudioNotes, resetPageAudio, takePageAudioOps } from '../src/page-audio.js';

const g = globalThis as any;

beforeEach(() => {
  installDeterminism();
  resetVirtualClock();
  resetPageAudio();
  installPageAudio();
});
afterEach(() => uninstallDeterminism());

/** A context with a 1 kHz sine into an analyser (fftSize 2048), started at frame 0. */
function sineAnalyser(smoothing = 0.8) {
  setVirtualFrame(0, 30);
  const ctx = new g.AudioContext();
  const osc = ctx.createOscillator();
  osc.frequency.value = 1000;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = smoothing;
  osc.connect(analyser);
  analyser.connect(ctx.destination);
  osc.start(0);
  return { ctx, analyser };
}

describe('AudioContext', () => {
  it('runs on the virtual clock with no gesture, and records what the page calls', () => {
    setVirtualFrame(0, 30);
    const ctx = new g.AudioContext();
    expect(ctx.state).toBe('running');
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    setVirtualFrame(45, 30);
    expect(ctx.currentTime).toBe(1.5);
    gain.gain.setValueAtTime(0.5, ctx.currentTime);
    expect(gain.gain.value).toBe(0.5);
    const ops = takePageAudioOps();
    expect(ops.map((o) => [o.op, o.seq, o.t])).toEqual([
      ['new', 0, 0],
      ['connect', 1, 0],
      ['param', 2, 1.5],
    ]);
    expect(takePageAudioOps()).toEqual([]);
  });

  it('says what the mix cannot play instead of going quiet', () => {
    setVirtualFrame(0, 30);
    const ctx = new g.AudioContext();
    ctx.createWaveShaper().connect(ctx.destination);
    expect(pageAudioNotes().map((n) => n.property)).toEqual(['createWaveShaper']);
    expect(() => ctx.createBuffer(1, 10, 48000)).toThrow(/not supported/);
  });

  it('fires ended on the virtual clock when a source has played out', () => {
    setVirtualFrame(0, 30);
    const ctx = new g.AudioContext();
    const osc = ctx.createOscillator();
    let ended = -1;
    osc.onended = () => (ended = ctx.currentTime);
    osc.start(0);
    osc.stop(1);
    setVirtualFrame(29, 30);
    expect(ended).toBe(-1);
    setVirtualFrame(30, 30);
    expect(ended).toBe(1);
  });
});

describe('AnalyserNode', () => {
  it('has the spectrum of what plays: a 1 kHz sine peaks at its bin', () => {
    const { analyser } = sineAnalyser(0);
    setVirtualFrame(10, 30);
    const db = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(db);
    const peak = db.indexOf(Math.max(...db));
    expect(peak).toBe(Math.round(1000 / (48000 / 2048)));
    expect(db[peak]).toBeGreaterThan(-20);
    expect(db[peak + 20]).toBeLessThan(-80);
    const bytes = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(bytes);
    expect(bytes[peak]).toBe(255);
    expect(bytes[peak + 20]).toBe(0);
  });

  it('has the time domain data of the samples before the frame, and silence before the sound starts', () => {
    const { analyser } = sineAnalyser();
    const floats = new Float32Array(2048);
    setVirtualFrame(0, 30);
    analyser.getFloatTimeDomainData(floats);
    expect(Math.max(...floats.map(Math.abs))).toBe(0);
    setVirtualFrame(30, 30);
    analyser.getFloatTimeDomainData(floats);
    // sample (48000 - 1) of a 1 kHz sine: the last of the window
    expect(floats[2047]).toBeCloseTo(Math.sin((2 * Math.PI * 1000 * 47999) / 48000), 3);
  });

  it('gives the same data at a frame whether or not the frames before it were read (smoothing included)', () => {
    const { analyser } = sineAnalyser(0.8);
    const every = new Uint8Array(1024);
    for (let f = 0; f <= 20; f++) {
      setVirtualFrame(f, 30);
      analyser.getByteFrequencyData(every);
    }
    const { analyser: other } = sineAnalyser(0.8);
    const jumped = new Uint8Array(1024);
    setVirtualFrame(20, 30);
    other.getByteFrequencyData(jumped);
    expect([...jumped]).toEqual([...every]);
  });
});
