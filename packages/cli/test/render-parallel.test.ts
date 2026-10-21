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
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'tone.wav'), wav(3));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function render(output: string, extra: string[]): void {
  const run = spawnSync('node', [cli, 'render', join(dir, 'index.tsx'), '-o', join(dir, output), ...extra], { encoding: 'utf8' });
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

  it('refuses a concurrency that is not a whole number of at least 1', () => {
    const run = spawnSync('node', [cli, 'render', join(dir, 'index.tsx'), '-o', join(dir, 'x.mp4'), '--concurrency', '0'], { encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr + run.stdout).toContain('--concurrency');
  });
});
