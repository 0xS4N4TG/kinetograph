// WebGPU through Dawn (KINETOGRAPH_WEBGPU=dawn), on the built CLI and the real addon: a frame drawn alone (a still, a worker that
// starts at it) is the frame of a sequence, whichever way it is drawn, for a stateless page, for a page that keeps GPU state
// from frame to frame (an animation-frame page and a React project that draws from an effect), and for a canvas drawn into a
// 2D canvas; errors are said with their frame and `--strict` fails. Needs the `webgpu` package (dawn.node, not a dependency of
// the repo: KINETOGRAPH_DAWN_MODULE names its folder), the built addon and `npm run build`, and a GPU. Skipped, with the reason,
// where one is missing. Optional: KINETOGRAPH_THREE_BUILD, the folder of three.js's build (three.webgpu.js), adds a lit scene.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodePng } from '../src/png.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 30_000 });

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');
const fixtures = join(here, 'fixtures', 'dawn');
const dawnModule = process.env.KINETOGRAPH_DAWN_MODULE;
const threeBuild = process.env.KINETOGRAPH_THREE_BUILD;

const missing = ((): string | null => {
  if (!dawnModule) return 'KINETOGRAPH_DAWN_MODULE is not set (the folder of the "webgpu" package, dawn.node)';
  try {
    createRequire(import.meta.url)(dawnModule);
  } catch (error) {
    return `the "webgpu" package at ${dawnModule} cannot be loaded (${(error as Error).message.split('\n')[0]})`;
  }
  try {
    createRequire(import.meta.url)('@kinetographdev/native');
  } catch {
    return 'the native addon (@kinetographdev/native) is not built';
  }
  if (!existsSync(cli)) return 'the CLI is not built (npm run build)';
  return null;
})();

if (missing !== null) describe('WebGPU through Dawn, rendered', () => it.skip(`skipped: ${missing}`, () => {}));

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kg-dawn-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const env = { ...process.env, KINETOGRAPH_WEBGPU: 'dawn' };
const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args, '--offline'], { encoding: 'utf8', env });
/** Draws `frames` in the order given in one process (a jump back among them), as the PNG md5 of each and what the frames left out. */
function drawInOrder(entry: string, frames: number[], strict = false): { md5: Record<number, string>; errors: Record<number, string>; leftOut: string } {
  const script = `
    import { createHash } from 'node:crypto';
    import { pathToFileURL } from 'node:url';
    const dist = ${JSON.stringify(join(here, '..', 'dist'))} + '/';
    const { openSource } = await import(pathToFileURL(dist + 'source.js'));
    const { FrameDrawer } = await import(pathToFileURL(dist + 'frame-drawer.js'));
    const { native } = await import(pathToFileURL(dist + 'native.js'));
    const [entry, strict, ...frames] = process.argv.slice(1);
    const source = await openSource(entry, { offline: true });
    const drawer = new FrameDrawer(source, { renderer: () => new (native().Renderer)(), strict: strict === 'strict' });
    const out = { md5: {}, errors: {}, leftOut: '' };
    for (const frame of frames.map(Number)) {
      try { out.md5[frame] = createHash('md5').update(await drawer.png(frame)).digest('hex'); }
      catch (error) { out.errors[frame] = String(error.message); }
    }
    out.leftOut = JSON.stringify(drawer.report());
    source.dispose();
    console.log(JSON.stringify(out));
    process.exit(0);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, entry, strict ? 'strict' : 'loose', ...frames.map(String)], { encoding: 'utf8', env });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim().split('\n').pop()!);
}

const md5 = (file: string): string => createHash('md5').update(readFileSync(file)).digest('hex');

/** The md5 of frames `frames` drawn alone (stills), and of the same frames of a sequence rendered by 1 and by 4 workers. */
function hashes(entry: string, frames: number[], last: number): { still: string[]; one: string[]; four: string[] } {
  const name = entry.replace(/[^\w]/g, '_');
  const still = frames.map((frame) => {
    const out = join(dir, `${name}-still-${frame}.png`);
    const r = run(['still', entry, String(frame), '-o', out]);
    expect(r.status, r.stderr).toBe(0);
    return md5(out);
  });
  const sequence = (workers: number): string[] => {
    const out = join(dir, `${name}-seq-${workers}`);
    const r = run(['render', entry, '--sequence', '--range', `0..${last}`, '--concurrency', String(workers), '-o', out]);
    expect(r.status, r.stderr).toBe(0);
    const files = readdirSync(out).filter((f) => f.endsWith('.png')).sort();
    expect(files).toHaveLength(last);
    return frames.map((frame) => md5(join(out, files[frame]!)));
  };
  return { still, one: sequence(1), four: sequence(4) };
}

describe.skipIf(missing !== null)('WebGPU through Dawn, rendered', () => {
  it('draws a stateless page the same alone, in a sequence and in four workers', () => {
    const { still, one, four } = hashes(join(fixtures, 'stateless.html'), [0, 3, 7], 9);
    expect(new Set(still).size).toBe(3);
    expect(one).toEqual(still);
    expect(four).toEqual(still);
  });

  it('draws a page that keeps a feedback texture and advances particles in a compute pass the same alone and in a sequence', () => {
    const { still, one, four } = hashes(join(fixtures, 'stateful.html'), [0, 5, 8], 9);
    expect(new Set(still).size).toBe(3);
    expect(one).toEqual(still);
    expect(four).toEqual(still);
  });

  it('draws a React project that draws from a layout effect and keeps a feedback texture the same alone and in a sequence', () => {
    const { still, one, four } = hashes(join(fixtures, 'react-feedback.tsx'), [0, 7, 11], 12);
    expect(new Set(still).size).toBe(3);
    expect(one).toEqual(still);
    expect(four).toEqual(still);
  });

  it('shows a WebGPU canvas drawn into a 2D canvas with drawImage', () => {
    const out = join(dir, 'draw-image.png');
    expect(run(['still', join(fixtures, 'draw-image.html'), '0', '-o', out]).status).toBe(0);
    // The two canvases hold the same pixels: the page's orange (bgra8unorm, opaque) is the same orange in both (and black between).
    const image = decodePng(readFileSync(out));
    const at = (x: number, y: number): number[] => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
    expect(at(8, 8)).toEqual([255, 128, 0]);
    expect(at(40, 8)).toEqual([255, 128, 0]);
    expect(at(24, 8)).toEqual([0, 0, 0]);
  });

  it('goes back to an earlier frame exactly on a React project that runs its effects again, and says so on an HTML page whose script cannot', () => {
    const react = join(fixtures, 'react-feedback.tsx');
    const alone = hashes(react, [2], 12).still[0];
    expect(drawInOrder(react, [7, 2]).md5[2]).toBe(alone);
    // An HTML page's module script runs once: its device and its variables stay at frame 7, which is said, and fails under --strict.
    const html = join(fixtures, 'stateful.html');
    const back = drawInOrder(html, [7, 2]);
    expect(back.leftOut).toMatch(/a jump back to an earlier frame on a page whose GPU state carries/);
    expect(drawInOrder(html, [7, 2], true).errors[2]).toMatch(/--strict/);
    // A page that carries nothing is not touched by a jump back.
    expect(drawInOrder(join(fixtures, 'stateless.html'), [7, 2]).leftOut).not.toMatch(/jump back/);
  });

  it('says an error the page did not catch with its frame, and --strict fails on it', () => {
    const page = join(fixtures, 'validation-error.html');
    const warned = run(['still', page, '0', '-o', join(dir, 'err.png')]);
    expect(warned.status).toBe(0);
    expect(warned.stderr).toMatch(/WebGPU \(Dawn\): GPUValidationError/);
    const strict = run(['still', page, '0', '-o', join(dir, 'err2.png'), '--strict']);
    expect(strict.status).not.toBe(0);
    expect(strict.stderr).toMatch(/frame 0/);
    expect(strict.stderr).toMatch(/WebGPU \(Dawn\)/);
  });

  it.skipIf(!threeBuild || !existsSync(join(threeBuild ?? '', 'three.webgpu.js')))(
    `draws a lit three.js scene the same alone and in a sequence (needs KINETOGRAPH_THREE_BUILD, the folder with three.webgpu.js${threeBuild ? '' : ': not set, so skipped'})`,
    () => {
      // Copied: a project's files are read from inside its folder.
      cpSync(threeBuild!, join(dir, 'build'), { recursive: true });
      const page = join(dir, 'three.html');
      writeFileSync(
        page,
        `<!doctype html><html><head><style>body{margin:0;background:#000}</style><script type="importmap">{"imports":{"three":"./build/three.webgpu.js","three/webgpu":"./build/three.webgpu.js","three/tsl":"./build/three.tsl.js"}}</script></head>
<body><div id="kg-root" data-composition-id="main" data-width="128" data-height="72" data-duration="10" style="position:relative;width:128px;height:72px;overflow:hidden"><canvas id="c" width="128" height="72"></canvas>
<script type="module">
import * as THREE from 'three/webgpu';
const renderer = new THREE.WebGPURenderer({ canvas: document.getElementById('c'), antialias: false });
await renderer.init();
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x203040);
const camera = new THREE.PerspectiveCamera(50, 128 / 72, 0.1, 100); camera.position.set(0, 1.2, 3.2); camera.lookAt(0, 0, 0);
const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshStandardMaterial({ color: 0xff8844, roughness: 0.5 }));
scene.add(mesh, new THREE.DirectionalLight(0xffffff, 3), new THREE.AmbientLight(0x667788, 1));
let n = 0; renderer.setSize(128, 72, false);
renderer.setAnimationLoop(() => { mesh.rotation.y = n * 0.05; n += 1; renderer.render(scene, camera); });
</script></div></body></html>`,
      );
      const { still, one, four } = hashes(page, [0, 4, 8], 9);
      expect(new Set(still).size).toBe(3);
      expect(one).toEqual(still);
      expect(four).toEqual(still);
    },
  );
});
