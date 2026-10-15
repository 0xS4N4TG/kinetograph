#!/usr/bin/env node
// Records the Canvas 2D test cases of crates/dom/tests/canvas/*.js as the commands the engine draws.
//
//   node crates/dom/tools/canvas-cases.mjs
//
// Each `<name>.js` is the body of a function of `(ctx, W, H, canvas2)`: Canvas 2D calls on `ctx`, and `canvas2(w, h)`
// for a canvas of its own (to draw into another). `tests/canvas.rs` puts the same file in a `<script>` for Chrome,
// which draws the page the way Chrome does, and the commands this writes to `<name>.json` in the canvas's
// `data-kg-canvas` for the engine, which draws them natively: the test compares the two pictures. The case's size is
// its first line, `// size: 320 240`. Run this again after changing a case or the recorder (`npm run build -w
// packages/scene -w packages/compat` first); a test checks that the committed commands are the recorder's.
//
// Chrome is a test oracle here and nowhere else.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvasContext } from '../../../packages/scene/dist/index.js';
import { CanvasSurface } from '../../../packages/compat/dist/shim/canvas.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, '../tests/canvas');

/** The commands case `source` draws on a canvas of `width` x `height`. */
export function record(source, width, height) {
  const ctx = createCanvasContext({ size: () => ({ width, height }), fonts: () => ({ 'DM Sans': 'DMSans-Medium.ttf' }) });
  const canvas2 = (w, h) => new CanvasSurface(w, h);
  new Function('ctx', 'W', 'H', 'canvas2', source)(ctx, width, height, canvas2);
  return ctx.commands;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    const source = readFileSync(join(dir, file), 'utf8');
    const size = /^\/\/ size: (\d+) (\d+)/.exec(source);
    if (!size) throw new Error(`${file}: the first line must be "// size: <width> <height>"`);
    const commands = record(source, Number(size[1]), Number(size[2]));
    writeFileSync(join(dir, file.replace(/\.js$/, '.json')), `${JSON.stringify(commands)}\n`);
    console.log(`${file}: ${commands.length} commands`);
  }
}
