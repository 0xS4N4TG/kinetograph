// A page picks LINEAR for a half-float texture only when `getExtension('OES_texture_half_float_linear')` answers (the fluid
// simulation does, for shading, bloom and sunrays), and the replay then filters it. A 2 x 1 RGBA16F texture (black, white)
// is stretched over the canvas: with the filter honoured the quarter points are grey ramps, with NEAREST they are black and white.
// Needs the built addon and `npm run build`, and a GPU.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 });

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

const PAGE = `<!doctype html>
<html><body style="margin: 0">
<div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="64" data-height="8" data-fps="30" style="position: relative; width: 64px; height: 8px; background: #000">
  <canvas id="gl" width="64" height="8" style="position: absolute; left: 0; top: 0"></canvas>
</div>
<script>
const gl = document.getElementById('gl').getContext('webgl2');
const filter = gl.getExtension('OES_texture_half_float_linear') ? gl.LINEAR : gl.NEAREST;
const compile = (type, source) => {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
};
const program = gl.createProgram();
gl.attachShader(program, compile(gl.VERTEX_SHADER, '#version 300 es\\nin vec2 p; out vec2 uv; void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }'));
gl.attachShader(program, compile(gl.FRAGMENT_SHADER, '#version 300 es\\nprecision highp float; in vec2 uv; uniform sampler2D tex; out vec4 o; void main() { o = vec4(texture(tex, uv).rgb, 1.0); }'));
gl.linkProgram(program);
gl.useProgram(program);
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
// Half floats: 0 and 1.
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 2, 1, 0, gl.RGBA, gl.HALF_FLOAT, new Uint16Array([0, 0, 0, 0x3c00, 0x3c00, 0x3c00, 0x3c00, 0x3c00]));
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.viewport(0, 0, 64, 8);
gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
</script></body></html>`;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kg-half-linear-'));
  writeFileSync(join(dir, 'index.html'), PAGE);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const pixel = (file: string, x: number, y: number): number[] => {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' }).stdout;
  return [...out.subarray(0, 3)];
};

describe.skipIf(!ready)('a half-float texture with a linear filter', () => {
  it('is offered the extension, and a still shows the interpolated grey', () => {
    const still = join(dir, 'still.png');
    const out = spawnSync(process.execPath, [cli, 'still', join(dir, 'index.html'), '0', '-o', still], { encoding: 'utf8' });
    expect(out.status, out.stderr).toBe(0);
    // The centre of pixel 24 is u = 0.383, 0.77 of the way from the black texel's centre to the white one's (68 of 255); pixel 40 is 0.77 of the way back (195).
    const [low, high] = [pixel(still, 24, 4)[0]!, pixel(still, 40, 4)[0]!];
    expect(Math.abs(low - 68), `x=24 is ${low}`).toBeLessThanOrEqual(8);
    expect(Math.abs(high - 195), `x=40 is ${high}`).toBeLessThanOrEqual(8);
  });
});
