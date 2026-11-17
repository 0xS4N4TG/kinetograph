// WebGPU through Dawn (KINETOGRAPH_WEBGPU=dawn), on the built CLI and the real addon: a frame drawn alone (a still, a worker that
// starts at it) is the frame of a sequence, whichever way it is drawn, for a stateless page, for a page that keeps GPU state
// from frame to frame (an animation-frame page and a React project that draws from an effect), and for a canvas drawn into a
// 2D canvas; errors are said with their frame and `--strict` fails. Needs the `webgpu` package (dawn.node, an optional dependency of the CLI:
// found by Node resolution, or KINETOGRAPH_DAWN_MODULE names its folder), the built addon and `npm run build`, and a GPU. Skipped, with the reason,
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
// A child that hangs (a GPU call that never returns) is killed and reported; spawnSync would otherwise block the test run for ever.
const SPAWN_TIMEOUT = 170_000;

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');
const fixtures = join(here, 'fixtures', 'dawn');
const dawnModule = process.env.KINETOGRAPH_DAWN_MODULE || 'webgpu';
const threeBuild = process.env.KINETOGRAPH_THREE_BUILD;

const missing = ((): string | null => {
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
// KINETOGRAPH_CHUNK=3: a worker takes 3 frames at a time, so four workers over 12 frames each start at a frame of their own (a jump).
const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args, '--offline'], { encoding: 'utf8', timeout: SPAWN_TIMEOUT, killSignal: 'SIGKILL', env: { ...env, KINETOGRAPH_CHUNK: '3' } });
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
    // Answered before the project is disposed: the process ends here (a device being destroyed at exit is not what is tested).
    console.log(JSON.stringify(out));
    process.exit(0);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, entry, strict ? 'strict' : 'loose', ...frames.map(String)], { encoding: 'utf8', timeout: SPAWN_TIMEOUT, killSignal: 'SIGKILL', env });
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
  it('finds the library from the CLI for a project that sits outside any node_modules, and names a library that does not load', () => {
    // `dir` is in the temporary folder: resolving "webgpu" from the project's bundle would not find it there.
    const page = join(dir, 'outside.html');
    cpSync(join(fixtures, 'stateless.html'), page);
    const found = spawnSync(process.execPath, [cli, 'still', page, '2', '--offline', '-o', join(dir, 'outside.png')], { encoding: 'utf8', timeout: SPAWN_TIMEOUT, killSignal: 'SIGKILL', env: { ...env, KINETOGRAPH_DAWN_MODULE: '' } });
    expect(found.status, found.stderr).toBe(0);
    const absent = spawnSync(process.execPath, [cli, 'still', page, '2', '--offline', '-o', join(dir, 'absent.png')], { encoding: 'utf8', timeout: SPAWN_TIMEOUT, killSignal: 'SIGKILL', env: { ...env, KINETOGRAPH_DAWN_MODULE: join(dir, 'no-such-webgpu') } });
    expect(absent.status).not.toBe(0);
    expect(absent.stderr).toMatch(/KINETOGRAPH_WEBGPU=dawn: KINETOGRAPH_DAWN_MODULE=.*no-such-webgpu cannot be loaded/);
    // The default provider does not look for the library, so it is not affected by it.
    const plain = spawnSync(process.execPath, [cli, 'still', page, '2', '--offline', '-o', join(dir, 'plain.png')], { encoding: 'utf8', timeout: SPAWN_TIMEOUT, killSignal: 'SIGKILL', env: { ...process.env, KINETOGRAPH_WEBGPU: '', KINETOGRAPH_DAWN_MODULE: join(dir, 'no-such-webgpu') } });
    expect(plain.status, plain.stderr).toBe(0);
  });

  it('says in `doctor` which backend and adapter Dawn gives, and that there is none when the backend has none', () => {
    const doctor = (extra: Record<string, string>) => spawnSync(process.execPath, [cli, 'doctor', '--json'], { encoding: 'utf8', timeout: SPAWN_TIMEOUT, killSignal: 'SIGKILL', env: { ...env, KINETOGRAPH_DAWN_MODULE: '', ...extra } });
    const found = JSON.parse(doctor({}).stdout);
    expect(found.dawn.ok, JSON.stringify(found.dawn)).toBe(true);
    expect(found.dawn.adapter.vendor).not.toBe('');
    expect(found.dawn.flags[0]).toMatch(/^backend=/);
    // The backend this platform does not have.
    const none = JSON.parse(doctor({ KINETOGRAPH_DAWN_BACKEND: process.platform === 'darwin' ? 'vulkan' : 'metal' }).stdout);
    expect(none.dawn.ok).toBe(false);
    expect(none.dawn.error).toMatch(/Dawn found no adapter/);
    // Not the provider: not mentioned.
    const plain = spawnSync(process.execPath, [cli, 'doctor', '--json'], { encoding: 'utf8', timeout: SPAWN_TIMEOUT, killSignal: 'SIGKILL', env: { ...process.env, KINETOGRAPH_WEBGPU: '' } });
    expect(JSON.parse(plain.stdout).dawn).toBeUndefined();
  });

  it('draws a stateless page the same alone, in a sequence and in four workers', () => {
    const { still, one, four } = hashes(join(fixtures, 'stateless.html'), [0, 3, 7], 9);
    expect(new Set(still).size).toBe(3);
    expect(one).toEqual(still);
    expect(four).toEqual(still);
  });

  it('runs the animation-frame callbacks once per frame on a page that reads the GPU back each frame: the wait for a readback does not run them again', () => {
    for (const frame of [0, 3]) {
      const out = join(dir, `readback-loop-${frame}.png`);
      const r = run(['still', join(fixtures, 'readback-loop.html'), String(frame), '-o', out]);
      expect(r.status, r.stderr).toBe(0);
      expect(decodePng(readFileSync(out)).data[0]).toBe(16 * (frame + 1));
    }
  });

  it('draws a page that keeps a feedback texture and advances particles in a compute pass the same alone and in a sequence', () => {
    const { still, one, four } = hashes(join(fixtures, 'stateful.html'), [0, 5, 8], 9);
    expect(new Set(still).size).toBe(3);
    expect(one).toEqual(still);
    expect(four).toEqual(still);
  });

  // Each frame of this page takes about 2.5 s (it waits on the map of the query results), and a frame after a jump replays those before it.
  it('draws a page that reads occlusion query results back, whose next frame depends on them, the same alone and in a sequence', { timeout: 600_000 }, () => {
    const { still, one, four } = hashes(join(fixtures, 'occlusion.html'), [3, 6, 9, 11], 12);
    // The background turns when the small square comes out from behind the large one: the frames are not all the same.
    expect(new Set(still).size).toBeGreaterThan(1);
    expect(one).toEqual(still);
    expect(four).toEqual(still);
  });

  it('draws a react-three-fiber style loop, whose animation-frame callbacks draw what the tree shows, the same alone, in a sequence and in four workers', () => {
    // A jump must run each skipped frame's callbacks with that frame's props, not those of the frame before the jump.
    const { still, one, four } = hashes(join(fixtures, 'react-raf-trail.tsx'), [0, 1, 5, 9], 12);
    expect(new Set(still).size).toBe(4);
    expect(one).toEqual(still);
    expect(four).toEqual(still);
  });

  it('draws a motion-blurred page that keeps GPU state the same alone, in a sequence and in four workers: a replayed frame has its sub-frames too', () => {
    // Each frame's sub-frames draw a step more into the feedback texture, so the frames a jump replays must be given theirs.
    const page = join(fixtures, 'react-blur-feedback.tsx');
    const { still, one, four } = hashes(page, [0, 5, 9], 12);
    expect(new Set(still).size).toBe(3);
    expect(one).toEqual(still);
    expect(four).toEqual(still);
    // Nothing is said of it, so `--strict` passes.
    const strict = run(['still', page, '5', '--strict', '-o', join(dir, 'blur-still-strict.png')]);
    expect(strict.status, strict.stderr).toBe(0);
  });

  it('draws a React project that draws from a layout effect and keeps a feedback texture the same alone and in a sequence', () => {
    const { still, one, four } = hashes(join(fixtures, 'react-feedback.tsx'), [0, 7, 11], 12);
    expect(new Set(still).size).toBe(3);
    expect(one).toEqual(still);
    expect(four).toEqual(still);
  });

  it.each(['pingpong-init.html', 'react-pingpong-init.tsx', 'storage-init.html', 'react-storage-init.tsx'])(
    'draws %s, whose ping-pong the page fills when it mounts, the same alone, in a sequence and in four workers',
    (name) => {
      // Nothing is read before it is written, so a frame jumped to cannot see by its textures or buffers alone that the frames before it are missing.
      const { still, one, four } = hashes(join(fixtures, name), [0, 5, 9], 12);
      expect(new Set(still).size).toBe(3);
      expect(one).toEqual(still);
      expect(four).toEqual(still);
    },
  );

  it('says a Dawn page whose state shows only after a jump landed was drawn without its frames before it, and draws the frames after it right', () => {
    // A ring of three textures that no frame reads before the third: a jump to frame 7 shows nothing of the state carried, frame 9 does.
    const ring = join(fixtures, 'react-lazy-ring.tsx');
    const sequence = hashes(ring, [9, 10], 12).one;
    const loose = drawInOrder(ring, [7, 8, 9, 10]);
    expect(loose.leftOut).toMatch(/the jump to frame 7 drew it without the frames before it: frames 7 to 8/);
    expect([loose.md5[9], loose.md5[10]]).toEqual(sequence);
    // --strict makes it an error, said with the frame it was seen in.
    const strict = drawInOrder(ring, [7, 8, 9, 10], true);
    expect(strict.errors[9]).toMatch(/the jump to frame 7 drew it without the frames before it/);
    // A page that carries nothing says nothing.
    expect(drawInOrder(join(fixtures, 'stateless.html'), [7, 8, 9]).leftOut).not.toMatch(/without the frames before it/);
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

  it('does not carry what one composition read of its earlier frames into the next one of the same process', () => {
    // One bundle, two renderers one after the other (a Studio that opens another composition): the stateful one flags its frames as history
    // dependent, which is nothing of the stateless one's. Wrongly carried, the stateless one is replayed from frame 0 for a jump to frame 7.
    const script = `
      import { pathToFileURL } from 'node:url';
      const dist = ${JSON.stringify(join(here, '..', 'dist'))} + '/';
      const { openSource } = await import(pathToFileURL(dist + 'source.js'));
      const entry = process.argv[1];
      const first = await openSource(entry, { offline: true, comp: 'Stateful' });
      for (let frame = 0; frame < 4; frame++) await first.frame(frame);
      first.dispose();
      const second = await openSource(entry, { offline: true, comp: 'Stateless', bundleFile: first.worker.bundleFile });
      await second.frame(7);
      console.log(JSON.stringify(globalThis.__kgDraws));
      process.exit(0);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, join(fixtures, 'react-two.tsx')], { encoding: 'utf8', timeout: SPAWN_TIMEOUT, killSignal: 'SIGKILL', env });
    expect(r.status, r.stderr).toBe(0);
    // The mount draws frame 0 and then the frame jumped to: nothing replays the frames between.
    expect(JSON.parse(r.stdout.trim().split('\n').pop()!)).toEqual([0, 7]);
  });

  it('says an error with the frame whose motion-blur sub-frame made it, not the frame after', () => {
    const page = join(fixtures, 'react-blur-error.tsx');
    // The sub-frames of frame 5 run the page's GPU calls again, after the frame's own reports were taken: their errors are said with frame 5.
    for (const frames of [[3, 4, 5, 6, 7], [3, 4, 5]]) {
      const strict = drawInOrder(page, frames, true);
      expect(Object.keys(strict.errors), `frames ${frames}`).toEqual(['5']);
      expect(strict.errors[5]).toMatch(/frame 5/);
      expect(strict.errors[5]).toMatch(/WebGPU \(Dawn\): GPUValidationError/);
    }
    expect(drawInOrder(page, [3, 4, 5, 6, 7]).leftOut).toMatch(/"firstFrame":5,"lastFrame":5/);
  });

  it('says an error the page did not catch with its frame, also when nothing waits for its device', () => {
    // Said by the library at the call that made it: it is the frame's own (it was not seen to arrive later, which is why errors are not scoped per frame).
    const page = join(fixtures, 'react-late-error.tsx');
    for (const frames of [[3, 4, 5, 6, 7], [3, 4, 5], [5]]) {
      const strict = drawInOrder(page, frames, true);
      expect(Object.keys(strict.errors), `frames ${frames}`).toEqual(['5']);
      expect(strict.errors[5]).toMatch(/frame 5/);
    }
  });

  it('says an error the page did not catch with its frame, and --strict fails on it', () => {
    const page = join(fixtures, 'validation-error.html');
    const warned = run(['still', page, '0', '-o', join(dir, 'err.png')]);
    expect(warned.status).toBe(0);
    expect(warned.stderr).toMatch(/WebGPU \(Dawn\): GPUValidationError/);
    // It is a WebGPU device's report, not a WebGL render target's.
    expect(warned.stderr).not.toMatch(/webgl|render target/i);
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
