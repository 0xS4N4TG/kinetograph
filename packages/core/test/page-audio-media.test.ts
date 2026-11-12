// A `<audio>` element is on the virtual clock (compat/shim/media.ts) and the soundtrack hears it (the MediaHost of
// page-audio.ts): `play()`, `pause()`, a seek and a change of `volume` or `playbackRate` reach the mix, `currentTime`
// and `paused` come from the element's own clock, and `ended` is sent once.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setDomAddon, setDomEnvironment } from '@kinetographdev/compat/dom';
import { armPageInput, setPageInput } from '@kinetographdev/compat/shim';
import { installDeterminism, resetVirtualClock, setVirtualFrame, stepAnimationFrames, uninstallDeterminism } from '../src/determinism.js';
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

describe('the order inside a frame', () => {
  it('is the scripted input, then the video frame callbacks, then the animation frames, also when a jump steps through frames', async () => {
    const video = g.document.createElement('video');
    video.src = 'beep.wav';
    const button = g.document.createElement('button');
    button.id = 'go';
    g.document.body.appendChild(button);
    const log: string[] = [];
    const again = (): void => {
      video.requestVideoFrameCallback(() => {
        log.push('video');
        again();
      });
      g.requestAnimationFrame(() => log.push('raf'));
    };
    button.addEventListener('click', () => {
      log.push('input');
      video.play();
      again();
    });
    setPageInput([{ frame: 3, type: 'click', selector: '#go' }]);
    armPageInput();
    await flush();
    // A jump from frame 0 to 6 plays the frames between: the click comes due at 3, though nothing else is pending before it.
    setVirtualFrame(0, 30);
    stepAnimationFrames(1, 6, 30);
    setVirtualFrame(6, 30);
    await flush();
    expect(log.slice(0, 3)).toEqual(['input', 'video', 'raf']);
    button.remove();
  });
});
