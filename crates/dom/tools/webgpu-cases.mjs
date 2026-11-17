#!/usr/bin/env node
// Records the WebGPU test cases of crates/dom/tests/webgpu/*.js as the recording the engine draws.
//
//   node crates/dom/tools/webgpu-cases.mjs
//
// Each `<name>.js` is the body of an async function of `(device, context, format, W, H)`: WebGPU calls on a configured
// device and canvas context. `tests/webgpu.rs` puts the same file in a `<script>` for Chrome (headless, SwiftShader
// adapter), which draws it with a real WebGPU device, and the recording this writes to `<name>.json` goes in the
// canvas's `data-kg-webgl` for the engine, which replays it on wgpu: the test compares the two pictures. The case's size is
// its first line, `// size: 64 64`. Run this again after changing a case or the recorder
// (`npm run build -w packages/scene` first).
//
// Chrome is a test oracle here and nowhere else.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGpu, createGpuCanvasContext, GPU_GLOBALS } from '../../../packages/scene/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, '../tests/webgpu');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

/** The recording case `source` makes on a canvas of `width` x `height`. */
export async function record(source, width, height) {
  Object.assign(globalThis, GPU_GLOBALS);
  const adapter = await createGpu().requestAdapter();
  const device = await adapter.requestDevice();
  const context = createGpuCanvasContext({ size: () => ({ width, height }) });
  const format = 'rgba8unorm';
  context.configure({ device, format, alphaMode: 'premultiplied' });
  await new AsyncFunction('device', 'context', 'format', 'W', 'H', source)(device, context, format, width, height);
  return context.content();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    const source = readFileSync(join(dir, file), 'utf8');
    const size = /^\/\/ size: (\d+) (\d+)/.exec(source);
    if (!size) throw new Error(`${file}: the first line must be "// size: <width> <height>"`);
    const content = await record(source, Number(size[1]), Number(size[2]));
    writeFileSync(join(dir, file.replace(/\.js$/, '.json')), `${JSON.stringify(content)}\n`);
    console.log(`${file}: ${content.webgpu.passes.length} steps${content.webgpu.notes?.length ? `, notes ${JSON.stringify(content.webgpu.notes)}` : ''}`);
  }
}
