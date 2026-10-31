// GET /api/audio and /api/waveform: with the stub engine for the routes (a fixture whose clip is a tone), and with the
// default engine for the mix itself (a tone file played by <Audio>). The mix is made from the timeline's own sweep.

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeWav, peaksOf } from '../src/audio-mix.js';
import type { StudioServer } from '../src/index.js';
import { api, cleanup, start, stopAll, tempDir, writeProject } from './helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

afterAll(async () => {
  await stopAll();
  cleanup();
});

const TONE = JSON.stringify(['tone.wav', 10, 0, null, 1, false, false]);
const withAudio = `&props=${encodeURIComponent('{"_audio":true}')}`;

/** The samples of a 16-bit mono PCM WAV. */
function samples(wav: Uint8Array): Int16Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  return new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + 44 + view.getUint32(40, true)));
}

describe('audio routes (stub engine)', () => {
  let studio: StudioServer;
  beforeAll(async () => {
    studio = await start(writeProject('Main').entry);
  });

  it('serves the mix as a WAV, cached per props', async () => {
    const r = await api(studio, `/api/audio?comp=Main${withAudio}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('audio/wav');
    expect(String.fromCharCode(...r.body.slice(0, 4))).toBe('RIFF');
    const pcm = samples(r.body);
    expect(pcm.length).toBe(8000 * 3);
    // Silent before frame 10, a tone after.
    expect(Math.max(...pcm.slice(0, 2000).map(Math.abs))).toBe(0);
    expect(Math.max(...pcm.slice(4000, 6000).map(Math.abs))).toBeGreaterThan(10000);
    const again = await api(studio, `/api/audio?comp=Main${withAudio}`);
    expect(Buffer.from(again.body).equals(Buffer.from(r.body))).toBe(true);
  });

  it('is 404 for a composition with no audio, 400 without comp, 404 for an unknown one', async () => {
    expect((await api(studio, '/api/audio?comp=Main')).status).toBe(404);
    expect((await api(studio, '/api/audio')).status).toBe(400);
    expect((await api(studio, '/api/audio?comp=Nope')).status).toBe(404);
  });

  it('the timeline lists the sound', async () => {
    const r = await api(studio, `/api/timeline?comp=Main${withAudio}`);
    expect(r.json.audio).toEqual([{ id: TONE, src: 'tone.wav', ranges: [[10, 39]] }]);
    expect((await api(studio, '/api/timeline?comp=Main')).json.audio).toEqual([]);
  });

  it('waveform: peaks of the mix or of one clip, in the buckets asked for', async () => {
    const mix = await api(studio, `/api/waveform?comp=Main&buckets=30${withAudio}`);
    expect(mix.status).toBe(200);
    expect(mix.json.peaks).toHaveLength(30);
    expect(mix.json.peaks.every((p: number) => p >= 0 && p <= 1)).toBe(true);
    expect(mix.json.peaks[0]).toBe(0);
    expect(Math.max(...mix.json.peaks)).toBeGreaterThan(0.4);

    const clip = await api(studio, `/api/waveform?comp=Main&clip=${encodeURIComponent(TONE)}&buckets=10${withAudio}`);
    expect(clip.json.peaks).toHaveLength(10);
    expect(clip.json).toMatchObject({ startFrame: 10, endFrame: 40 });
    expect(Math.min(...clip.json.peaks)).toBeGreaterThan(0.3);

    expect((await api(studio, `/api/waveform?comp=Main&clip=nope${withAudio}`)).status).toBe(404);
    expect((await api(studio, `/api/waveform?comp=Main&buckets=0${withAudio}`)).status).toBe(400);
    expect((await api(studio, '/api/waveform?comp=Main')).status).toBe(404);
  });

  it('refuses a request that does not come from the studio page', async () => {
    const r = await api(studio, `/api/audio?comp=Main${withAudio}`, { headers: { Origin: 'http://evil.example' } });
    expect(r.status).toBe(403);
    expect((await api(studio, '/api/waveform?comp=Main', { headers: { Origin: 'http://evil.example' } })).status).toBe(403);
  });

  it('a newer timeline request stops the sweep an older one is still making', async () => {
    const slow = (n: number) => `&props=${encodeURIComponent(JSON.stringify({ _frameMs: 20, n }))}`;
    const old = api(studio, `/api/timeline?comp=Main${slow(1)}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const started = Date.now();
    const fresh = await api(studio, `/api/timeline?comp=Main${slow(2)}`);
    expect(fresh.status).toBe(200);
    expect((await old).status).toBe(409);
    expect((await old).json.error.code).toBe('SUPERSEDED');
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe('peaks and WAV encoding', () => {
  it('peaksOf takes the loudest sample of each slice', () => {
    const channel = new Float32Array([0, 0.5, -0.9, 0.1, 0, 0, 0.2, -0.2]);
    expect(peaksOf([channel], 0, 8, 4).map((p) => +p.toFixed(2))).toEqual([0.5, 0.9, 0, 0.2]);
  });
  it('encodeWav writes a 16-bit stereo file', () => {
    const wav = encodeWav({ sampleRate: 8000, channels: [new Float32Array([0, 1, -1]), new Float32Array(3)] });
    const view = new DataView(wav.buffer);
    expect(wav.length).toBe(44 + 3 * 4);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getInt16(48, true)).toBe(32767);
    expect(view.getInt16(52, true)).toBe(-32768);
  });
});

const addon = (() => {
  try {
    createRequire(import.meta.url)('@kinetographdev/native');
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!addon)('audio with the default engine', () => {
  it('mixes an <Audio> tone file and onFrame synthesis with the code render uses', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
    // One second of 440 Hz, 8 kHz mono.
    const tone = new Float32Array(8000).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 8000));
    writeFileSync(join(dir, 'tone.wav'), encodeWav({ sampleRate: 8000, channels: [tone] }));
    const entry = join(dir, 'index.tsx');
    writeFileSync(
      entry,
      `import { Audio, Composition, Rect, Sequence, registerRoot } from 'remotion';
const Main = () => (
  <>
    <Rect id="bg" width={64} height={36} fill="#000" />
    <Sequence from={15} durationInFrames={30}><Audio src="tone.wav" /></Sequence>
  </>
);
const Quiet = () => <Rect id="bg" width={64} height={36} fill="#000" />;
registerRoot(() => (
  <>
    <Composition id="Main" component={Main} width={64} height={36} fps={30} durationInFrames={60} />
    <Composition id="Quiet" component={Quiet} width={64} height={36} fps={30} durationInFrames={10} />
  </>
));
`,
    );
    const studio = await start(entry, { engine: undefined });

    const timeline = await api(studio, '/api/timeline?comp=Main');
    expect(timeline.json.audio).toHaveLength(1);
    expect(timeline.json.audio[0].ranges).toEqual([[15, 44]]);

    const r = await api(studio, '/api/audio?comp=Main');
    expect(r.status).toBe(200);
    const view = new DataView(r.body.buffer, r.body.byteOffset);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48000);
    // 60 frames at 30 fps is two seconds of stereo 16-bit.
    expect(r.body.length).toBe(44 + 2 * 48000 * 4);

    const wave = await api(studio, '/api/waveform?comp=Main&buckets=60');
    // Silent for the first half second (frames 0..14), sound after.
    expect(Math.max(...wave.json.peaks.slice(0, 14))).toBe(0);
    expect(Math.max(...wave.json.peaks.slice(16, 44))).toBeGreaterThan(0.3);
    const id = timeline.json.audio[0].id;
    const clip = await api(studio, `/api/waveform?comp=Main&clip=${encodeURIComponent(id)}&buckets=20`);
    expect(clip.json).toMatchObject({ startFrame: 15, endFrame: 45 });
    expect(Math.max(...clip.json.peaks)).toBeGreaterThan(0.3);

    expect((await api(studio, '/api/audio?comp=Quiet')).status).toBe(404);
  });
});
