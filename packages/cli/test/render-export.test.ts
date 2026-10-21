// `render`'s export options on the real addon and the built CLI: every codec writes a file ffprobe reads back with the
// right codec and size, --scale draws at the scaled size, bad combinations are refused, and --concurrency gives the same
// pictures as a single thread whatever the codec and scale. Needs the built addon and `npm run build`, a GPU, and
// ffmpeg and ffprobe; skipped where one is missing.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const ready = addon && haveFfmpeg && existsSync(cli) && existsSync(join(here, '..', 'dist', 'export-options.js'));

// No motion blur and no shaders: a frame is the same whichever worker draws it.
const PROJECT = `
import { AbsoluteFill, Audio, Composition, Sequence, registerRoot, staticFile, useCurrentFrame } from 'remotion';

const Box = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: '#102030' }}>
      <div style={{ position: 'absolute', left: frame % 50, top: 8, width: 12, height: 12, background: 'rgb(240,80,40)' }} />
      <div style={{ position: 'absolute', left: 4, top: 22, width: 4 + (frame % 30), height: 6, background: '#6cf' }} />
    </AbsoluteFill>
  );
};
const Main = () => (
  <>
    <Box />
    <Sequence from={5} durationInFrames={30}><Audio src={staticFile('tone.wav')} /></Sequence>
  </>
);
registerRoot(() => <Composition id="Main" component={Main} width={64} height={36} fps={30} durationInFrames={90} />);
`;

function wav(seconds: number, rate = 48000): Buffer {
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

// Paints which React build the project's bundle loaded: React and the bundle read the same NODE_ENV.
const MODE = `
import { AbsoluteFill, Composition, registerRoot } from 'remotion';
const Main = () => <AbsoluteFill style={{ background: process.env.NODE_ENV === 'production' ? '#00ff00' : '#ff0000' }} />;
registerRoot(() => <Composition id="Mode" component={Main} width={64} height={36} fps={30} durationInFrames={130} />);
`;

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinetograph-export-'));
  writeFileSync(join(dir, 'package.json'), '{"name":"p","private":true}');
  writeFileSync(join(dir, 'index.tsx'), PROJECT);
  writeFileSync(join(dir, 'mode.tsx'), MODE);
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'tone.wav'), wav(3));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(output: string, extra: string[], entry = 'index.tsx') {
  return spawnSync('node', [cli, 'render', join(dir, entry), '-o', join(dir, output), ...extra], { encoding: 'utf8' });
}
function render(output: string, extra: string[], entry = 'index.tsx'): void {
  const r = run(output, extra, entry);
  expect(r.stderr + r.stdout).not.toMatch(/error/i);
  expect(r.status).toBe(0);
}

interface Stream { codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string; nb_frames?: string }
function probe(file: string): Stream[] {
  const out = spawnSync('ffprobe', ['-v', 'error', '-count_packets', '-show_streams', '-of', 'json', join(dir, file)], { encoding: 'utf8' }).stdout;
  return (JSON.parse(out) as { streams: Stream[] }).streams;
}
const video = (file: string): Stream => probe(file).find((s) => s.codec_type === 'video')!;
const audio = (file: string): Stream | undefined => probe(file).find((s) => s.codec_type === 'audio');

/** One md5 per decoded video frame. */
function frames(file: string): string[] {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', join(dir, file), '-map', '0:v', '-f', 'framemd5', '-'], { encoding: 'utf8' }).stdout;
  return out.split('\n').filter((l) => l !== '' && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim());
}

describe.skipIf(!ready)('render export options', () => {
  it('runs the production React build, in the main thread and in the workers, unless --dev-react', () => {
    const colour = (file: string): number[] =>
      [...spawnSync('ffmpeg', ['-v', 'error', '-i', join(dir, file), '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { encoding: 'buffer' }).stdout];
    // 130 frames are three chunks, so two workers both draw. Red is the development build, green the production one.
    for (const concurrency of ['1', '2']) {
      render('mode-prod.mp4', ['--concurrency', concurrency], 'mode.tsx');
      render('mode-dev.mp4', ['--concurrency', concurrency, '--dev-react'], 'mode.tsx');
      expect(colour('mode-prod.mp4')[1]).toBeGreaterThan(200);
      expect(colour('mode-dev.mp4')[0]).toBeGreaterThan(200);
    }
  });

  it.each([
    ['h264', 'out-h264.mp4', 'h264'],
    ['h265', 'out-h265.mp4', 'hevc'],
    ['prores', 'out-prores.mov', 'prores'],
    ['vp9', 'out-vp9.webm', 'vp9'],
    ['gif', 'out-gif.gif', 'gif'],
  ])('--codec %s writes a %s file of the right size', (codec, file, name) => {
    render(file, ['--codec', codec, '--range', '0..20']);
    const v = video(file);
    expect([v.codec_name, v.width, v.height]).toEqual([name, 64, 36]);
  });

  it('infers vp9 from .webm and gif from .gif, and keeps H.264 for .mp4 and .mov', () => {
    render('infer.webm', ['--range', '0..10']);
    render('infer.gif', ['--range', '0..10']);
    render('infer.mov', ['--range', '0..10']);
    expect([video('infer.webm').codec_name, video('infer.gif').codec_name, video('infer.mov').codec_name]).toEqual(['vp9', 'gif', 'h264']);
  });

  it('--scale draws at the scaled size, rounding sides down to even; --draft is --scale 0.5', () => {
    render('half.mp4', ['--scale', '0.5', '--range', '0..10']);
    render('double.mp4', ['--scale', '2', '--range', '0..10']);
    render('odd.mp4', ['--scale', '0.3', '--range', '0..10']);
    render('draft.mp4', ['--draft', '--range', '0..10']);
    expect([video('half.mp4').width, video('half.mp4').height]).toEqual([32, 18]);
    expect([video('double.mp4').width, video('double.mp4').height]).toEqual([128, 72]);
    expect([video('odd.mp4').width, video('odd.mp4').height]).toEqual([18, 10]);
    expect(frames('draft.mp4')).toEqual(frames('half.mp4'));
    const both = run('x.mp4', ['--draft', '--scale', '2']);
    expect(both.status).not.toBe(0);
    expect(both.stderr).toContain('--draft is --scale 0.5');
  });

  it('refuses --crf with --video-bitrate, and values and combinations that make no sense, before rendering', () => {
    const cases: [string[], string][] = [
      [['--crf', '20', '--video-bitrate', '2M'], 'cannot be used together'],
      [['--crf', '99'], 'between 0 and 51'],
      [['--video-bitrate', 'fast'], '--video-bitrate'],
      [['--scale', '0'], '--scale'],
      [['--codec', 'av1'], 'unknown codec'],
      [['--codec', 'prores', '--crf', '20'], 'prores-profile'],
      [['--prores-profile', 'hq'], '--prores-profile'],
      [['--pixel-format', 'rgb24'], 'unknown pixel format'],
      [['--every-nth-frame', '2'], 'gif'],
      [['--audio-codec', 'pcm'], 'aac'],
      [['--audio-codec', 'mp3'], 'unknown audio codec'],
    ];
    for (const [flags, message] of cases) {
      const r = run(flags.includes('prores') ? 'bad.mov' : 'bad.mp4', flags);
      expect(r.status, flags.join(' ')).not.toBe(0);
      expect(r.stderr, flags.join(' ')).toContain(message);
    }
    expect(existsSync(join(dir, 'bad.mp4'))).toBe(false);
  });

  it('checks the extension against the codec', () => {
    for (const [codec, file] of [['prores', 'bad.mp4'], ['vp9', 'bad.mov'], ['gif', 'bad.mp4'], ['h264', 'bad.webm']]) {
      const r = run(file!, ['--codec', codec!]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`codec ${codec}`);
    }
  });

  it('--crf and --video-bitrate change the file size', () => {
    render('crf-lo.mp4', ['--codec', 'h264', '--crf', '5']);
    render('crf-hi.mp4', ['--codec', 'h264', '--crf', '45']);
    render('rate.mp4', ['--video-bitrate', '200k']);
    const size = (f: string): number => Number(spawnSync('stat', ['-f', '%z', join(dir, f)], { encoding: 'utf8' }).stdout);
    expect(size('crf-lo.mp4')).toBeGreaterThan(size('crf-hi.mp4'));
    expect(video('rate.mp4').codec_name).toBe('h264');
  });

  it('--pixel-format and --prores-profile reach the file', () => {
    render('p444.mp4', ['--pixel-format', 'yuv444p', '--range', '0..10']);
    render('p4444.mov', ['--codec', 'prores', '--prores-profile', '4444', '--range', '0..10']);
    render('p10.mp4', ['--codec', 'h265', '--pixel-format', 'yuv420p10le', '--range', '0..10']);
    expect(video('p444.mp4').pix_fmt).toBe('yuv444p');
    // ProRes 4444 is 10-bit in the file; ffprobe names what its decoder gives.
    expect(video('p4444.mov').pix_fmt).toMatch(/^yuv444p1[02]le$/);
    expect(video('p10.mp4').pix_fmt).toBe('yuv420p10le');
  });

  it('writes the audio codec the container takes, and --audio-bitrate sets its rate', () => {
    render('a-aac.mp4', ['--audio-bitrate', '320k']);
    render('a-pcm.mov', ['--audio-codec', 'pcm']);
    render('a-prores.mov', ['--codec', 'prores']);
    render('a-opus.webm', []);
    expect(audio('a-aac.mp4')!.codec_name).toBe('aac');
    expect(audio('a-pcm.mov')!.codec_name).toBe('pcm_s16le');
    expect(audio('a-prores.mov')!.codec_name).toBe('pcm_s16le');
    expect(audio('a-opus.webm')!.codec_name).toBe('opus');
    expect(audio('infer.gif')).toBeUndefined();
  });

  it('--every-nth-frame draws every nth frame of a gif', () => {
    render('nth.gif', ['--every-nth-frame', '3', '--range', '0..30']);
    const r = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=nb_read_frames,r_frame_rate', '-of', 'csv=p=0', join(dir, 'nth.gif')], { encoding: 'utf8' });
    expect(r.stdout.trim()).toMatch(/^10\/1,10$/);
    render('nth-par.gif', ['--every-nth-frame', '3', '--range', '0..30', '--concurrency', '3']);
    expect(frames('nth-par.gif')).toEqual(frames('nth.gif'));
  });

  it.each([
    ['prores', 'c.mov', ['--codec', 'prores', '--scale', '0.5']],
    ['h264 software, 4:4:4', 'c.mp4', ['--encoder', 'libx264', '--pixel-format', 'yuv444p', '--scale', '2']],
    ['vp9', 'c.webm', ['--scale', '0.5']],
    ['gif', 'c.gif', ['--scale', '2']],
  ])('--concurrency 1 and 3 give the same pictures: %s', (_name, file, flags) => {
    render(`seq-${file}`, [...flags!, '--concurrency', '1']);
    render(`par-${file}`, [...flags!, '--concurrency', '3']);
    const seq = frames(`seq-${file}`);
    expect(seq.length).toBe(90);
    expect(frames(`par-${file}`)).toEqual(seq);
  });
});
