// A page's AudioContext reaches the soundtrack and its AnalyserNode answers from the sound: a page that starts a 1 kHz
// tone on a click and draws the analyser's level as a bar. The same soundtrack bytes in two renders and at one and
// four workers; a still equals the frame of a sequence at one and four workers. Needs the built addon and
// `npm run build`, a GPU and ffmpeg.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 180_000 });

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');
const addon = (() => {
  try {
    createRequire(import.meta.url)('@kinetographdev/native');
    return true;
  } catch {
    return false;
  }
})();
const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ready = addon && haveFfmpeg && existsSync(join(here, '..', 'dist', 'hyperframes', 'entry.js'));

let dir: string;
let file: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kg-hf-audio-'));
  file = join(dir, 'index.html');
  writeFileSync(
    file,
    `<!doctype html><html><head><meta name="viewport" content="width=200, height=100"><style>
body { margin: 0; background: #000; }
#start { position: absolute; left: 0; top: 0; width: 200px; height: 100px; background: #00f; }
#bar { position: absolute; left: 0; bottom: 0; height: 20px; background: #f00; width: 0; }
</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="2" data-width="200" data-height="100" data-fps="30">
<button id="start"></button><div id="bar"></div></div>
<script>
document.getElementById('start').addEventListener('click', () => {
  document.getElementById('start').remove();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  osc.frequency.value = 1000;
  const gain = ctx.createGain();
  gain.gain.value = 0.5;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  osc.connect(gain);
  gain.connect(analyser);
  gain.connect(ctx.destination);
  // the tone starts a quarter second in
  osc.start(0.25);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const tick = () => {
    analyser.getByteFrequencyData(data);
    document.getElementById('bar').style.width = Math.max(...data) * 0.78 + 'px';
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
</script></body></html>`,
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const input = JSON.stringify([{ frame: 0, type: 'click', selector: '#start' }]);

function run(args: string[], chunk?: string): void {
  const env = chunk === undefined ? process.env : { ...process.env, KINETOGRAPH_CHUNK: chunk };
  const out = spawnSync(process.execPath, [cli, ...args, '--input', input], { encoding: 'utf8', env });
  expect(out.status, out.stderr).toBe(0);
}

const hash = (p: string): string => spawnSync('md5', ['-q', p], { encoding: 'utf8' }).stdout.trim();
const soundtrack = (video: string): string => spawnSync('sh', ['-c', `ffmpeg -v error -i "${video}" -map 0:a -f s16le - | md5 -q`], { encoding: 'utf8' }).stdout.trim();
const volume = (video: string): { mean: number; max: number } => {
  const log = spawnSync('ffmpeg', ['-i', video, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  return { mean: Number(/mean_volume: (-?[\d.]+)/.exec(log)![1]), max: Number(/max_volume: (-?[\d.]+)/.exec(log)![1]) };
};
const pixel = (png: string, x: number, y: number): number[] => {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', png, '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' }).stdout;
  return [...out.subarray(0, 3)];
};

describe.skipIf(!ready)('a page with an AudioContext', () => {
  it('puts its tone in the soundtrack from the frame it started, the same in two renders and at one and four workers', () => {
    const one = join(dir, 'one.mp4');
    run(['render', file, '-o', one, '--concurrency', '1']);
    // A sine at gain 0.5 peaks at -6 dB, and 0.25 s of the 2 s are silence before it
    const { mean, max } = volume(one);
    expect(max).toBeGreaterThan(-7);
    expect(max).toBeLessThan(-5);
    expect(mean).toBeLessThan(-9.2);
    expect(mean).toBeGreaterThan(-10.5);
    const again = join(dir, 'again.mp4');
    run(['render', file, '-o', again, '--concurrency', '1']);
    const four = join(dir, 'four.mp4');
    run(['render', file, '-o', four, '--concurrency', '4'], '10');
    expect(soundtrack(one)).not.toBe('');
    expect(soundtrack(again)).toBe(soundtrack(one));
    expect(soundtrack(four)).toBe(soundtrack(one));
  });

  it('draws the analyser from the sound at the frame: no bar before the tone, a bar after, a still equals the sequence at 1 and 4 workers', () => {
    const still = (frame: number): string => {
      const png = join(dir, `still-${frame}.png`);
      run(['still', file, String(frame), '-o', png]);
      return png;
    };
    expect(pixel(still(3), 100, 95)).toEqual([0, 0, 0]);
    expect(pixel(still(30), 100, 95)).toEqual([255, 0, 0]);
    for (const [workers, chunk] of [['1', '60'], ['4', '10']] as const) {
      const folder = join(dir, `seq${workers}`);
      run(['render', file, '--sequence', '-o', folder, '--concurrency', workers], chunk);
      for (const frame of [3, 30, 41]) {
        const name = readdirSync(folder).find((n) => new RegExp(`-0*${frame}\\.png$`).test(n))!;
        expect(hash(join(folder, name)), `frame ${frame}, ${workers} workers`).toBe(hash(still(frame)));
      }
    }
  });
});
