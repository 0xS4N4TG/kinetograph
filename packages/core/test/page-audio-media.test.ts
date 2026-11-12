// A `<audio>` element is on the virtual clock (compat/shim/media.ts) and the soundtrack hears it (the MediaHost of
// page-audio.ts): `play()`, `pause()`, a seek and a change of `volume` or `playbackRate` reach the mix, `currentTime`
// and `paused` come from the element's own clock, and `ended` is sent once.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setDomAddon, setDomEnvironment } from '@kinetographdev/compat/dom';
import { installDeterminism, resetVirtualClock, setVirtualFrame, uninstallDeterminism } from '../src/determinism.js';
import { setAudioDecoder } from '../src/media-utils.js';
import { resetPageAudio, takePageAudioOps } from '../src/page-audio.js';
import '../src/web-install.js';

const g = globalThis as any;
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let audio: any;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'kg-page-audio-media-'));
  writeFileSync(join(dir, 'beep.wav'), 'not read: the decoder below answers');
  setDomEnvironment({ baseDir: dir });
  setDomAddon({ probeMedia: () => ({ width: 0, height: 0, durationInSeconds: 2 }) });
  setAudioDecoder(() => ({ sampleRate: 48000, channels: [new Float32Array(96000)] }));
  installDeterminism();
  resetVirtualClock();
  resetPageAudio();
  setVirtualFrame(0, 30);
  audio = g.document.createElement('audio');
  audio.src = 'beep.wav';
});
afterEach(() => {
  setAudioDecoder(null);
  uninstallDeterminism();
});

const media = () => takePageAudioOps().filter((o: any) => o.op === 'media') as any[];

describe('an <audio> element the page plays', () => {
  it('advances on the virtual clock and sends its play to the soundtrack from where it stands', async () => {
    await flush();
    await audio.play();
    expect(audio.paused).toBe(false);
    setVirtualFrame(15, 30);
    expect(audio.currentTime).toBeCloseTo(0.5, 6);
    const ops = media();
    expect(ops.filter((o) => o.action === 'play')).toHaveLength(1);
    expect(ops.find((o) => o.action === 'play')).toMatchObject({ offset: 0, loop: false, value: 1 });
  });

  it('is paused by pause() on both sides, and a seek while paused starts the next play there', async () => {
    await audio.play();
    media();
    setVirtualFrame(15, 30);
    audio.pause();
    expect(audio.paused).toBe(true);
    expect(media().map((o) => o.action)).toEqual(['pause']);
    setVirtualFrame(30, 30);
    expect(audio.currentTime).toBeCloseTo(0.5, 6);
    audio.currentTime = 1.25;
    expect(media()).toEqual([]);
    await audio.play();
    expect(media().find((o) => o.action === 'play')).toMatchObject({ offset: 1.25 });
  });

  it('sends a seek while it plays, and a new volume and playback rate', async () => {
    await audio.play();
    media();
    setVirtualFrame(15, 30);
    audio.currentTime = 1;
    expect(media().find((o) => o.action === 'play')).toMatchObject({ offset: 1 });
    audio.volume = 0.25;
    audio.playbackRate = 2;
    const ops = media();
    expect(ops.find((o) => o.action === 'volume')).toMatchObject({ value: 0.25 });
    expect(ops.find((o) => o.action === 'rate')).toMatchObject({ value: 2 });
    setVirtualFrame(30, 30);
    expect(audio.currentTime).toBeCloseTo(2, 6);
  });

  it('sends ended once, when the file has played out', async () => {
    let ended = 0;
    audio.addEventListener('ended', () => ended++);
    await audio.play();
    for (let frame = 1; frame <= 75; frame++) setVirtualFrame(frame, 30);
    expect(ended).toBe(1);
    expect(audio.paused).toBe(true);
    expect(audio.currentTime).toBeCloseTo(2, 6);
  });
});
