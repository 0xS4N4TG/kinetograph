// What only the three features together can show: one HyperFrames page that uploads a `<video>` to a WebGL texture every
// frame (the virtual media clock + `video: {src, time}` textures), starts an AudioContext whose analyser drives a bar when
// a click that arrives through `--input` (page audio + scripted input) plays the video and the tone, and reads an XML
// file with DOMParser (the XML parser) to colour a swatch. A still is the frame of a sequence at one and at four workers,
// and the soundtrack is the same in two renders and at four workers. Needs the built addon and `npm run build`, a GPU and ffmpeg.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 30_000 });

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');
const clip = join(here, 'fixtures', 'hf-webgl-video', 'clip.mp4');
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

const PAGE = `<!doctype html>
<html><head><style>
canvas, #swatch, #bar, #start { position: absolute; }
#start { left: 0; top: 0; width: 160px; height: 90px; background: #00f; }
</style></head><body style="margin: 0">
<div id="root" data-composition-id="main" data-start="0" data-duration="2" data-width="160" data-height="90" data-fps="30" style="position: relative; width: 160px; height: 90px; overflow: hidden; background: #000">
  <canvas id="gl" width="80" height="60" style="left: 0; top: 0"></canvas>
  <div id="swatch" style="left: 80px; top: 0; width: 80px; height: 60px; background: #222"></div>
  <div id="bar" style="left: 0; bottom: 0; height: 30px; width: 0; background: #f00"></div>
  <button id="start"></button>
</div>
<script>
// The XML file: parsed as XML, read through the tree, and an Element (a page that checks with instanceof).
fetch('scene.xml').then((r) => r.text()).then((text) => {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const swatch = doc.getElementsByTagName('swatch')[0];
  if (swatch instanceof Element) document.getElementById('swatch').style.background = swatch.getAttribute('color');
});

// The video, as a texture.
const video = document.createElement('video');
video.src = 'clip.mp4';
video.loop = true;
video.muted = true;
const gl = document.getElementById('gl').getContext('webgl');
const compile = (type, source) => {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
};
const program = gl.createProgram();
gl.attachShader(program, compile(gl.VERTEX_SHADER, 'attribute vec2 p; varying vec2 uv; void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }'));
gl.attachShader(program, compile(gl.FRAGMENT_SHADER, 'precision mediump float; varying vec2 uv; uniform sampler2D tex; void main() { gl_FragColor = texture2D(tex, uv); }'));
gl.linkProgram(program);
gl.useProgram(program);
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
const at = gl.getAttribLocation(program, 'p');
gl.enableVertexAttribArray(at);
gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

// The click starts the video and a tone whose analyser level is the bar's width.
document.getElementById('start').addEventListener('click', () => {
  document.getElementById('start').remove();
  video.play();
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
  osc.start(0.25);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const tick = () => {
    analyser.getByteFrequencyData(data);
    document.getElementById('bar').style.width = Math.max(...data) * 0.3 + 'px';
    if (video.readyState >= 2) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
</script></body></html>`;

let dir: string;
let page: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kg-webgl-pages-'));
  page = join(dir, 'index.html');
  writeFileSync(page, PAGE);
  writeFileSync(join(dir, 'scene.xml'), '<?xml version="1.0"?><scene><swatch color="#00ff00"/></scene>');
  copyFileSync(clip, join(dir, 'clip.mp4'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const input = JSON.stringify([{ frame: 0, type: 'click', selector: '#start' }]);
function run(args: string[], chunk?: string): void {
  const env = chunk === undefined ? process.env : { ...process.env, KINETOGRAPH_CHUNK: chunk };
  const out = spawnSync(process.execPath, [cli, ...args, '--input', input], { encoding: 'utf8', env });
  expect(out.status, out.stderr).toBe(0);
}
const md5 = (file: string) => createHash('md5').update(readFileSync(file)).digest('hex');
const soundtrack = (video: string): string => spawnSync('sh', ['-c', `ffmpeg -v error -i "${video}" -map 0:a -f s16le - | md5 -q`], { encoding: 'utf8' }).stdout.trim();
const pixel = (file: string, x: number, y: number): number[] => {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' }).stdout;
  return [...out.subarray(0, 3)];
};
/** The centre pixel of picture `n` of the clip, as ffmpeg decodes it. */
function clipFrame(n: number): number[] {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', clip, '-vf', 'format=rgb24,crop=1:1:32:18', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' }).stdout;
  return [...out.subarray(n * 3, n * 3 + 3)];
}
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= 6);

describe.skipIf(!ready)('a page with a video texture, an AudioContext analyser, scripted input and an XML file', () => {
  it('shows the video picture, the analyser bar and the XML colour, and a still is the sequence frame at 1 and 4 workers', () => {
    // Frame 40 is 1.33 s in: picture 16 of the looping clip (12 fps); the tone began at 0.25 s, so the bar is full.
    const still = join(dir, 'still-40.png');
    run(['still', page, '40', '-o', still]);
    expect(near(pixel(still, 40, 30), clipFrame(16)), `video ${pixel(still, 40, 30)} vs ${clipFrame(16)}`).toBe(true);
    expect(pixel(still, 100, 30)).toEqual([0, 255, 0]);
    expect(pixel(still, 20, 80)).toEqual([255, 0, 0]);
    // Frame 3 is before the tone: no bar.
    const early = join(dir, 'still-3.png');
    run(['still', page, '3', '-o', early]);
    expect(pixel(early, 20, 80)).toEqual([0, 0, 0]);
    for (const [workers, chunk] of [['1', '60'], ['4', '10']] as const) {
      const folder = join(dir, `seq${workers}`);
      run(['render', page, '--sequence', '-o', folder, '--concurrency', workers], chunk);
      const name = readdirSync(folder).find((n) => /-0*40\.png$/.test(n))!;
      expect(md5(join(folder, name)), `${workers} workers`).toBe(md5(still));
    }
  });

  it('has the same soundtrack bytes in two renders and at four workers', () => {
    const one = join(dir, 'one.mp4');
    run(['render', page, '-o', one, '--concurrency', '1']);
    const again = join(dir, 'again.mp4');
    run(['render', page, '-o', again, '--concurrency', '1']);
    const four = join(dir, 'four.mp4');
    run(['render', page, '-o', four, '--concurrency', '4'], '10');
    expect(soundtrack(one)).not.toBe('');
    expect(soundtrack(again)).toBe(soundtrack(one));
    expect(soundtrack(four)).toBe(soundtrack(one));
  });
});
