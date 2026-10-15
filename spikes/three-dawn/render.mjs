// Spike 2 (docs/HANDOFF.md §4, docs/AUTHORING.md §9): does Three.js `WebGPURenderer` render headless on Dawn in Node?
//
// It renders a torus knot built in code and a glTF model (built here, exported with GLTFExporter, loaded back with
// GLTFLoader, so there is no third-party asset) into render targets, reads the pixels back, checks that they are not
// blank, writes PNGs and prints timings as JSON. It fails (exit code 1, `{ "error": ... }`) if the renderer is not on
// the WebGPU backend: `WebGPURenderer` silently falls back to WebGL2 when it finds no adapter, and WebGL2 does not
// exist in Node, so a fallback here means the Dawn wiring is wrong.
//
// Run on a machine with a GPU: `npm install && npm start`. See README.md.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { create, globals } from 'webgpu';

const SIZE = Number(process.env.SIZE ?? 512);
const SAMPLES = Number(process.env.SAMPLES ?? 0); // MSAA samples of the render target: try 4 once the plain run works
const TIMED_FRAMES = Number(process.env.FRAMES ?? 20);
const OUT_DIR = process.env.OUT_DIR ?? 'out';
const now = () => performance.now(); // a benchmark: the one place real time is read

class SpikeError extends Error {}
const check = (condition, message) => {
  if (!condition) throw new SpikeError(message);
};

// ---- Dawn as `navigator.gpu`, and the pieces of the DOM that Three.js and its addons touch ----

Object.assign(globalThis, globals); // GPUBufferUsage, GPUTextureUsage, GPUMapMode, ...
const gpu = create([]);
// Node has a `navigator` already; it just has no `gpu`.
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true });

// The renderer starts an animation loop on `self.requestAnimationFrame` when it initialises, and Node has neither.
// Every frame here is drawn by an explicit `render` call, so the loop is given a frame request that never fires.
globalThis.self ??= globalThis;
globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => {};

// GLTFExporter reads the buffers it builds through FileReader.
globalThis.FileReader ??= class FileReader {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buffer) => this.#done(buffer));
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((buffer) => {
      this.#done(`data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`);
    });
  }
  #done(result) {
    this.result = result;
    this.onloadend?.({ target: this });
    this.onload?.({ target: this });
  }
};

// There is no canvas in Node. The renderer is given a stand-in canvas and a stand-in GPUCanvasContext whose "current
// texture" is a plain offscreen texture, so it initialises; everything is drawn into render targets instead.
function offscreenCanvas(width, height) {
  let device;
  let format;
  let texture;
  const context = {
    configure(options) {
      device = options.device;
      format = options.format;
    },
    unconfigure() {},
    getCurrentTexture() {
      if (!texture || texture.width !== canvas.width || texture.height !== canvas.height) {
        texture?.destroy();
        texture = device.createTexture({
          size: [canvas.width, canvas.height],
          format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
        });
      }
      return texture;
    },
  };
  const canvas = {
    width,
    height,
    style: {},
    getContext: () => context,
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
  };
  return { canvas, context };
}

// ---- PNG output and pixel checks ----

function encodePng(width, height, rgba) {
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = [];
  for (let y = 0; y < height; y++) {
    rows.push(Buffer.from([0]), Buffer.from(rgba.subarray(y * width * 4, (y + 1) * width * 4)));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The read-back rows are padded to 256 bytes (WebGPU's copy alignment); this returns them tightly packed. */
function unpad(data, width, height) {
  const tight = width * 4;
  const stride = Math.ceil(tight / 256) * 256;
  if (data.length === tight * height) return Uint8Array.from(data);
  check(data.length >= (height - 1) * stride + tight, `read-back is ${data.length} bytes, too small for ${width}x${height}`);
  const out = new Uint8Array(tight * height);
  for (let y = 0; y < height; y++) out.set(data.subarray(y * stride, y * stride + tight), y * tight);
  return out;
}

/** Not blank: enough pixels differ from the background, and the picture has many distinct colours. */
function pixelStats(rgba) {
  const background = rgba.slice(0, 4);
  const colours = new Set();
  let different = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (
      Math.abs(rgba[i] - background[0]) > 4 ||
      Math.abs(rgba[i + 1] - background[1]) > 4 ||
      Math.abs(rgba[i + 2] - background[2]) > 4
    ) {
      different++;
    }
    colours.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
  }
  return {
    background: Array.from(background),
    coveredFraction: different / (rgba.length / 4),
    distinctColours: colours.size,
  };
}

// ---- the scenes ----

async function main() {
  const THREE = await import('three/webgpu');
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');

  const adapter = await gpu.requestAdapter();
  check(adapter, 'Dawn found no GPU adapter');
  const adapterInfo = adapter.info
    ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description }
    : null;

  const { canvas } = offscreenCanvas(SIZE, SIZE);
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL: false });
  const initStarted = now();
  await renderer.init();
  const initMs = now() - initStarted;

  // The point of the spike: not the WebGL2 fallback.
  const backend = renderer.backend;
  check(backend?.isWebGPUBackend === true, `renderer is not on the WebGPU backend (backend: ${backend?.constructor?.name})`);
  check(backend.isWebGLBackend !== true, 'renderer fell back to the WebGL2 backend');
  check(typeof backend.device?.createRenderPipeline === 'function', 'the backend has no WebGPU device');

  renderer.setSize(SIZE, SIZE, false);
  const target = new THREE.RenderTarget(SIZE, SIZE, { type: THREE.UnsignedByteType, samples: SAMPLES });
  target.texture.colorSpace = THREE.SRGBColorSpace;

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, 0, 7);

  function lit(scene) {
    scene.background = new THREE.Color(0x10131a);
    scene.add(new THREE.HemisphereLight(0xbcd2ff, 0x2a1c14, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 3);
    key.position.set(4, 5, 6);
    scene.add(key);
    return scene;
  }

  // 1. A torus knot, built in code.
  const knotScene = lit(new THREE.Scene());
  const knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(1.5, 0.5, 220, 32),
    new THREE.MeshStandardMaterial({ color: 0xff7a3d, metalness: 0.5, roughness: 0.3 }),
  );
  knotScene.add(knot);

  // 2. A glTF model: build a small figure, export it as a .glb, load the bytes back.
  const figure = new THREE.Group();
  const part = (geometry, color, metalness, at) => {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, metalness, roughness: 0.4 }));
    mesh.position.set(...at);
    figure.add(mesh);
  };
  part(new THREE.BoxGeometry(1.6, 2, 1), 0x3fa7d6, 0.2, [0, -0.4, 0]);
  part(new THREE.SphereGeometry(0.7, 32, 16), 0xf4d35e, 0.1, [0, 1.3, 0]);
  part(new THREE.ConeGeometry(0.3, 0.9, 24), 0xee6352, 0.6, [-0.4, 2.2, 0]);
  part(new THREE.ConeGeometry(0.3, 0.9, 24), 0xee6352, 0.6, [0.4, 2.2, 0]);
  part(new THREE.CylinderGeometry(0.25, 0.25, 1.6, 24), 0x59cd90, 0.3, [-1.2, -0.4, 0]);
  part(new THREE.CylinderGeometry(0.25, 0.25, 1.6, 24), 0x59cd90, 0.3, [1.2, -0.4, 0]);
  const glb = await new GLTFExporter().parseAsync(figure, { binary: true });
  check(glb instanceof ArrayBuffer && glb.byteLength > 1000, 'GLTFExporter produced no .glb');
  const gltf = await new GLTFLoader().parseAsync(glb, '');
  let loadedMeshes = 0;
  gltf.scene.traverse((o) => {
    if (o.isMesh) loadedMeshes++;
  });
  check(loadedMeshes === 6, `the loaded glTF has ${loadedMeshes} meshes, expected 6`);
  const modelScene = lit(new THREE.Scene());
  gltf.scene.position.y = -0.4;
  modelScene.add(gltf.scene);

  mkdirSync(OUT_DIR, { recursive: true });
  const results = [];

  async function renderAndRead(scene) {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    const raw = await renderer.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE);
    return unpad(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), SIZE, SIZE);
  }

  for (const [name, scene, object, spin] of [
    ['torus-knot', knotScene, knot, 0.08],
    ['gltf-model', modelScene, gltf.scene, 0.1],
  ]) {
    // Frame 0 compiles the shaders and pipelines.
    object.rotation.set(0.3, 0, 0);
    const first = now();
    let pixels = await renderAndRead(scene);
    const firstFrameMs = now() - first;

    // Render only: the draw calls are queued, and the wait is for the GPU to finish them.
    const renderOnlyStarted = now();
    for (let f = 1; f <= TIMED_FRAMES; f++) {
      object.rotation.y = f * spin;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    }
    renderer.setRenderTarget(null);
    await backend.device.queue.onSubmittedWorkDone();
    const renderOnlyMs = (now() - renderOnlyStarted) / TIMED_FRAMES;

    // Render and read back every frame, as a layer in the compositor would be produced.
    const withReadbackStarted = now();
    for (let f = 1; f <= TIMED_FRAMES; f++) {
      object.rotation.y = f * spin;
      pixels = await renderAndRead(scene);
    }
    const withReadbackMs = (now() - withReadbackStarted) / TIMED_FRAMES;

    const stats = pixelStats(pixels);
    check(stats.coveredFraction > 0.02, `${name}: the picture is blank (${(stats.coveredFraction * 100).toFixed(2)}% differs from the background)`);
    check(stats.distinctColours > 50, `${name}: only ${stats.distinctColours} distinct colours`);
    const png = join(OUT_DIR, `${name}.png`);
    writeFileSync(png, encodePng(SIZE, SIZE, pixels));
    results.push({ name, png, firstFrameMs, renderOnlyMs, renderAndReadbackMs: withReadbackMs, ...stats });
  }

  const summary = {
    ok: true,
    backend: 'webgpu',
    three: THREE.REVISION,
    adapter: adapterInfo,
    size: SIZE,
    samples: SAMPLES,
    timedFrames: TIMED_FRAMES,
    initMs,
    gltf: { glbBytes: glb.byteLength, meshes: loadedMeshes },
    scenes: results,
  };

  renderer.dispose();
  target.dispose();
  // Dawn keeps the process alive while `navigator.gpu` is referenced (the webgpu README, "Lifetime").
  delete globalThis.navigator.gpu;
  return summary;
}

try {
  console.log(JSON.stringify(await main(), null, 2));
  process.exit(0);
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: { code: error instanceof SpikeError ? 'SPIKE_ASSERTION' : 'SPIKE_FAILED', message: error?.message ?? String(error) } }, null, 2));
  if (!(error instanceof SpikeError)) console.error(error);
  process.exit(1);
}
