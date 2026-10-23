// Spike 1: what it costs JavaScript to hand a frame's scene to the addon.
//
//   node crates/node/spike/handoff.mjs <scene.json> [--frame N] [--runs K]
//
// Prints one JSON object. Always measured, on the CPU (no GPU is opened):
//   stringifyMs     JSON.stringify of the parsed scene, which is what the frame
//                   loop pays to turn its scene object into the string
//   validateSceneMs validateScene on that string: parsing and validating
// Only with KINETOGRAPH_GPU_TESTS=1 (opens a GPU; run it on the M4, on a
// release build: `npm run build:release -w @kinetographdev/native`):
//   bench           Renderer.bench on the string, frame mode: the stages
//                   handoff (parse, validate, swap into the renderer),
//                   resolve, raster, composite, readback and total
// The cost of a frame from the scene object to pixels is
// stringify + bench.stages.handoff + bench.stages.total.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const native = require('../index.js');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : Number(args[i + 1]);
};
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!file) {
  console.error('usage: node handoff.mjs <scene.json> [--frame N] [--runs K]');
  process.exit(2);
}
const frame = option('--frame', 0);
const runs = option('--runs', 10);
if (!Number.isInteger(frame) || frame < 0 || !Number.isInteger(runs) || runs < 1) {
  console.error('--frame must be a whole number from 0 and --runs at least 1');
  process.exit(2);
}

const path = resolve(file);
const baseDir = dirname(path);
const scene = JSON.parse(readFileSync(path, 'utf8'));

const stats = (samples) => ({
  mean: samples.reduce((a, b) => a + b, 0) / samples.length,
  min: Math.min(...samples),
  max: Math.max(...samples),
});
const timed = (fn) => {
  const started = performance.now();
  fn();
  return performance.now() - started;
};
// One warm-up, then `runs` timed runs.
const measure = (fn) => {
  fn();
  return stats(Array.from({ length: runs }, () => timed(fn)));
};

const json = JSON.stringify(scene);
const result = {
  scene: path,
  version: native.version(),
  frame,
  runs,
  sceneBytes: Buffer.byteLength(json),
  layers: Array.isArray(scene.layers) ? scene.layers.length : null,
  stringifyMs: measure(() => JSON.stringify(scene)),
  validateSceneMs: measure(() => native.validateScene(json, baseDir)),
};

if (process.env.KINETOGRAPH_GPU_TESTS === '1') {
  const renderer = new native.Renderer();
  result.bench = renderer.bench(json, { frame, runs }, baseDir);
} else {
  result.bench = 'skipped: set KINETOGRAPH_GPU_TESTS=1 to open a GPU and run Renderer.bench';
}

console.log(JSON.stringify(result, null, 2));
