import { describe, expect, it, vi } from 'vitest';

import { PreviewAudio } from '../src/lib/audio';
import { Player, type PlayerAudio } from '../src/lib/player';

const comp = { id: 'A', width: 64, height: 36, fps: 30, durationInFrames: 90, defaultProps: {} };

/** A sound whose clock a test moves by hand. */
function fakeAudio() {
  const calls: string[] = [];
  let heard: number | null = null;
  const audio: PlayerAudio = {
    start: (s) => {
      calls.push(`start ${s.toFixed(2)}`);
      heard = s;
    },
    stop: () => {
      calls.push('stop');
      heard = null;
    },
    time: () => heard,
    snippet: (s) => calls.push(`snippet ${s.toFixed(2)}`),
  };
  return { audio, calls, set: (t: number) => (heard = t) };
}

function setup() {
  const sound = fakeAudio();
  let now = 0;
  const frames: number[] = [];
  const player = new Player({
    audio: sound.audio,
    requestFrame: (args) => {
      frames.push(args.frame);
      return frames.length;
    },
    onImage: () => {},
    now: () => now,
    schedule: () => 1,
    cancelSchedule: () => {},
  });
  player.setComposition(comp);
  return { player, sound, frames, tick: (ms: number) => (now += ms) };
}

describe('the player with sound', () => {
  it('follows the audio clock, not the wall clock, and skips frames rather than lagging', () => {
    const { player, sound, tick } = setup();
    player.play();
    expect(sound.calls).toContain('start 0.00');
    // The wall clock says 1 s passed; the sound says 0.5 s: the frame is 15, not 30.
    tick(1000);
    sound.set(0.5);
    player.handleFrame({ header: { requestId: 1 } } as never);
    expect(player.getState().frame).toBe(15);
    // The sound ran on a second while no frame was ready: the next frame jumps, it does not step.
    sound.set(1.5);
    player.handleFrame({ header: { requestId: 2 } } as never);
    expect(player.getState().frame).toBe(45);
  });

  it('plays from the playhead on play, seek, and loop; stops on pause', () => {
    const { player, sound } = setup();
    player.seek(30);
    player.play();
    expect(sound.calls.at(-1)).toBe('start 1.00');
    player.seek(60);
    expect(sound.calls.at(-1)).toBe('start 2.00');
    player.pause();
    expect(sound.calls.at(-1)).toBe('stop');
  });

  it('plays a short snippet while scrubbing, none when stepping or seeking at rest', () => {
    const { player, sound } = setup();
    player.seek(15);
    expect(sound.calls.filter((c) => c.startsWith('snippet'))).toEqual([]);
    player.beginScrub();
    player.seek(30);
    expect(sound.calls.at(-1)).toBe('snippet 1.00');
  });
});

describe('PreviewAudio', () => {
  function fakeContext() {
    const log: string[] = [];
    const param = () => ({ value: 1, setValueAtTime: () => {}, linearRampToValueAtTime: () => {} });
    const node = () => ({ connect: (n: unknown) => n, disconnect: () => {}, gain: param() });
    const ctx = {
      currentTime: 0,
      state: 'running',
      outputLatency: 0,
      destination: {},
      resume: async () => {},
      createGain: node,
      createBufferSource: () => ({
        ...node(),
        buffer: null,
        start: (when: number, offset: number) => log.push(`start ${offset}`),
        stop: () => log.push('stop'),
      }),
      decodeAudioData: async () => ({ duration: 3 }),
    };
    return { ctx: ctx as unknown as AudioContext, log, raw: ctx };
  }

  it('is silent and unavailable without sound, and keeps the mute choice per viewer', async () => {
    const { ctx } = fakeContext();
    const audio = new PreviewAudio({ createContext: () => ctx });
    expect(audio.getState()).toEqual({ available: false, muted: false });
    expect(await audio.load(async () => null)).toBe(true);
    expect(audio.getState().available).toBe(false);
    audio.setMuted(true);
    expect(new PreviewAudio({ createContext: () => ctx }).getState().muted).toBe(true);
    expect(window.localStorage.getItem('kg.audio.muted')).toBe('1');
  });

  it('runs a clock off the context from where it started, and a newer load wins', async () => {
    const { ctx, raw, log } = fakeContext();
    const audio = new PreviewAudio({ createContext: () => ctx });
    const slow = audio.load(() => new Promise((resolve) => setTimeout(() => resolve(new ArrayBuffer(100)), 20)));
    const fast = audio.load(async () => new ArrayBuffer(100));
    expect(await fast).toBe(true);
    expect(await slow).toBe(false);
    expect(audio.getState().available).toBe(true);
    expect(audio.time()).toBeNull();
    raw.currentTime = 10;
    audio.start(1.5);
    raw.currentTime = 10.25;
    expect(audio.time()).toBeCloseTo(1.75, 5);
    expect(log).toContain('start 1.5');
    audio.stop();
    expect(audio.time()).toBeNull();
  });

  it('throttles snippets', async () => {
    const { ctx, log } = fakeContext();
    let now = 0;
    const audio = new PreviewAudio({ createContext: () => ctx, now: () => now });
    await audio.load(async () => new ArrayBuffer(100));
    audio.snippet(1);
    now = 20;
    audio.snippet(1.1);
    now = 100;
    audio.snippet(1.2);
    expect(log.filter((l) => l.startsWith('start'))).toEqual(['start 1', 'start 1.2']);
    vi.useRealTimers();
  });
});
