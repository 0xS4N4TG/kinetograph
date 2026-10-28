#!/usr/bin/env node
// Records the WebGL test cases of crates/dom/tests/webgl/*.js as the recording the engine draws.
//
//   node crates/dom/tools/webgl-cases.mjs
//
// Each `<name>.js` is the body of a function of `(gl, W, H)`: WebGL calls on `gl` (WebGL 2 when a shader is
// `#version 300 es`). `tests/webgl.rs` puts the same
// file in a `<script>` for Chrome, which draws it with a real WebGL context, and the recording this writes to
// `<name>.json` goes in the canvas's `data-kg-webgl` for the engine, which runs the shaders natively: the test
// compares the two pictures. The case's size is its first line, `// size: 96 64`. Run this again after changing a case
// or the recorder (`npm run build -w packages/scene` first).
//
// Chrome is a test oracle here and nowhere else.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebGLContext } from '../../../packages/scene/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, '../tests/webgl');

/** The recording case `source` makes on a drawing buffer of `width` x `height`, with the context attributes of its second line (`// attributes: {...}`). */
export function record(source, width, height) {
  const line = source.split('\n')[1] ?? '';
  const attributes = line.startsWith('// attributes: ') ? JSON.parse(line.slice('// attributes: '.length)) : {};
  const gl = createWebGLContext({ size: () => ({ width, height }), version: source.includes('#version 300 es') ? 2 : 1, attributes });
  new Function('gl', 'W', 'H', source)(gl, width, height);
  return gl.content();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    const source = readFileSync(join(dir, file), 'utf8');
    const size = /^\/\/ size: (\d+) (\d+)/.exec(source);
    if (!size) throw new Error(`${file}: the first line must be "// size: <width> <height>"`);
    const content = record(source, Number(size[1]), Number(size[2]));
    writeFileSync(join(dir, file.replace(/\.js$/, '.json')), `${JSON.stringify(content)}\n`);
    console.log(`${file}: ${content.ops.length} ops`);
  }
}
