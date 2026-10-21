// `render --concurrency N` against `render` on the real addon and the built CLI: the decoded frames and the decoded
// audio must be identical. Needs the built addon and `npm run build` (the CLI's dist), a GPU, and ffmpeg to decode;
// skipped where one is missing.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodePng } from './helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 });

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');
const addon = (() => {
  try {
    createRequire(import.meta.url)('@kinetograph/native');
    return true;
  } catch {
    return false;
  }
})();
const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ready = addon && haveFfmpeg && existsSync(cli) && existsSync(join(here, '..', 'dist', 'render-worker.js'));

const PROJECT = `
import { AbsoluteFill, Audio, Composition, Sequence, registerRoot, staticFile, useCurrentFrame } from 'remotion';

// A frame must not depend on which frames the worker drew before it, so this moves with the frame number alone.
const Box = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: '#102030' }}>
      <div style={{ position: 'absolute', left: frame % 50, top: 8, width: 12, height: 12, background: 'rgb(240,80,40)', opacity: 0.5 + (frame % 7) / 14 }} />
      <div style={{ position: 'absolute', left: 4, top: 22, width: 4 + (frame % 30), height: 6, background: '#6cf' }} />
    </AbsoluteFill>
  );
};
const Main = () => (
  <>
    <Box />
    <Sequence from={20} durationInFrames={90}><Audio src={staticFile('tone.wav')} /></Sequence>
  </>
);
registerRoot(() => <Composition id="Main" component={Main} width={64} height={36} fps={30} durationInFrames={200} />);
`;

// CSS transitions (docs/ENGINE.md §7.12): a frame's look depends on the frames before it, which a worker that starts a
// chunk on its own has to reach by replaying them. The levels change at frames 55, 100 and 150 and each fade takes a
// second (30 frames), so chunk starts land before, inside and after a fade.
const FADES = `
import { AbsoluteFill, Composition, registerRoot, useCurrentFrame } from 'remotion';

const Fade = () => {
  const frame = useCurrentFrame();
  const level = frame >= 150 ? 3 : frame >= 100 ? 2 : frame >= 55 ? 1 : 0;
  return (
    <AbsoluteFill style={{ background: '#102030' }}>
      <div style={{ position: 'absolute', left: 4, top: 4, width: 40, height: 12, background: '#f84', opacity: [0.1, 0.9, 0.3, 1][level], transition: 'opacity 1s linear' }} />
      <div style={{ position: 'absolute', left: 4, top: 20, width: 12 + level * 12, height: 10, background: '#6cf', transition: 'width 0.5s ease-out' }} />
    </AbsoluteFill>
  );
};
registerRoot(() => <Composition id="Fade" component={Fade} width={64} height={36} fps={30} durationInFrames={200} />);
`;

// A picture drawn after a canvas with a shadow. The canvas is drawn in runs through the image renderer, one of them of
// solid paths only, and that run once emptied the renderer's image atlas while the pictures drawn before it still
// counted as uploaded: the picture came out blank on a renderer that had drawn the canvas before it, and not on a new
// one. So a frame depended on the frames its worker had drawn, and `--concurrency N` (and the tail of a split chunk)
// differed from a sequential render on the frames after a canvas.
const CARDS = `
import { AbsoluteFill, Composition, registerRoot, staticFile, useCurrentFrame } from 'remotion';
import { Canvas, Image, Layer } from '@kinetograph/core';

const draw = (ctx: any) => {
  ctx.fillStyle = '#203040';
  ctx.fillRect(0, 0, 64, 36);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = '#e8d8c0';
  ctx.fillRect(14, 8, 30, 16);
  ctx.restore();
};

const Cards = () => {
  const frame = useCurrentFrame();
  const canvas = Math.floor(frame / 4) % 2 === 1;
  return (
    <AbsoluteFill style={{ background: '#102030' }}>
      {canvas ? (
        <Canvas id="shadow" width={64} height={36} draw={draw} />
      ) : (
        <Layer id="pic" x={frame % 4}>
          <Image src={staticFile('pic.png')} width={64} height={36} />
        </Layer>
      )}
    </AbsoluteFill>
  );
};
registerRoot(() => <Composition id="Cards" component={Cards} width={64} height={36} fps={30} durationInFrames={24} />);
`;

/** A mono 16-bit WAV of a sine wave. */
function wav(seconds: number, rate = 44100): Buffer {
  const samples = Math.round(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 12000), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinetograph-parallel-'));
  writeFileSync(join(dir, 'package.json'), '{"name":"p","private":true}');
  writeFileSync(join(dir, 'index.tsx'), PROJECT);
  writeFileSync(join(dir, 'fades.tsx'), FADES);
  writeFileSync(join(dir, 'cards.tsx'), CARDS);
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'tone.wav'), wav(3));
  // A picture that is nowhere flat, so a blank one differs from it.
  const pic = new Uint8Array(64 * 36 * 4);
  for (let y = 0; y < 36; y++) for (let x = 0; x < 64; x++) pic.set([x * 4, y * 7, 255 - x * 3, 255], (y * 64 + x) * 4);
  writeFileSync(join(dir, 'public', 'pic.png'), encodePng(64, 36, pic));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function render(output: string, extra: string[], entry = 'index.tsx', env: Record<string, string> = {}): void {
  const run = spawnSync('node', [cli, 'render', join(dir, entry), '-o', join(dir, output), ...extra], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  expect(run.stderr + run.stdout).not.toMatch(/error/i);
  expect(run.status).toBe(0);
}

/** What the file decodes to: one md5 per video frame, and one for the audio. */
function decoded(file: string): { video: string[]; audio: string } {
  const path = join(dir, file);
  const video = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'framemd5', '-'], { encoding: 'utf8' }).stdout;
  const audio = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-vn', '-f', 'md5', '-'], { encoding: 'utf8' }).stdout.trim();
  return { video: video.split('\n').filter((l) => l !== '' && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim()), audio };
}

describe.skipIf(!ready)('render --concurrency', () => {
  it('decodes to the same frames and audio as a sequential render, whole and for ranges', () => {
    for (const range of [[], ['--range', '30..160'], ['--range', '60..=199']]) {
      render('seq.mp4', ['--concurrency', '1', ...range]);
      render('par.mp4', ['--concurrency', '3', ...range]);
      const seq = decoded('seq.mp4');
      const par = decoded('par.mp4');
      expect(seq.video.length).toBeGreaterThan(60);
      expect(par.video).toEqual(seq.video);
      expect(par.audio).toBe(seq.audio);
      expect(seq.audio).not.toBe('');
    }
  });

  it('gives CSS transitions the same history in every chunk, whether a chunk starts before, inside or after a fade', () => {
    render('fade-seq.mp4', ['--concurrency', '1'], 'fades.tsx');
    const seq = decoded('fade-seq.mp4');
    // The fades are in the frames at all: each frame of the first one differs from the last.
    expect(new Set(seq.video.slice(55, 86)).size).toBeGreaterThan(20);
    // Chunks of 60, then of 24 frames with every running chunk open to splitting, so starts fall in many places.
    for (const env of [{}, { KINETOGRAPH_CHUNK: '24', KINETOGRAPH_MINSPLIT: '2' }]) {
      render('fade-par.mp4', ['--concurrency', '3'], 'fades.tsx', env);
      expect(decoded('fade-par.mp4').video).toEqual(seq.video);
    }
  });

  it('draws a picture after a canvas with a shadow as a new renderer does, at any concurrency and for a frame alone', () => {
    // Lossless H.264, so that the decoded frames are a function of the pixels drawn and nothing else.
    const lossless = ['--encoder', 'libx264', '--crf', '0', '--pixel-format', 'yuv444p'];
    render('cards-seq.mp4', ['--concurrency', '1', ...lossless], 'cards.tsx');
    const seq = decoded('cards-seq.mp4').video;
    expect(seq).toHaveLength(24);
    // The pictures of frames 8 and 16 are those of frame 0 (one step on, `x` moving a pixel with the frame).
    expect(seq[8]).toBe(seq[0]);
    expect(seq[16]).toBe(seq[0]);
    expect(seq[4]).not.toBe(seq[0]);
    for (const env of [{}, { KINETOGRAPH_CHUNK: '4', KINETOGRAPH_MINSPLIT: '2' }, { KINETOGRAPH_CHUNK: '6', KINETOGRAPH_MINSPLIT: '2' }]) {
      render('cards-par.mp4', ['--concurrency', '3', ...lossless], 'cards.tsx', env);
      expect(decoded('cards-par.mp4').video).toEqual(seq);
    }
    // Each of these frames alone, in a process of its own, is the frame of the whole render.
    for (const frame of [0, 3, 4, 7, 8, 11, 12, 16, 20]) {
      render('cards-one.mp4', ['--range', `${frame}..=${frame}`, ...lossless], 'cards.tsx');
      expect(decoded('cards-one.mp4').video).toEqual([seq[frame]]);
    }
  });

  it('refuses a concurrency that is not a whole number of at least 1', () => {
    const run = spawnSync('node', [cli, 'render', join(dir, 'index.tsx'), '-o', join(dir, 'x.mp4'), '--concurrency', '0'], { encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr + run.stdout).toContain('--concurrency');
  });
});
