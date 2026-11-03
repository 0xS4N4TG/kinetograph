#!/usr/bin/env node
// Kinetograph's render of each effect: the same compositions as oracle.mjs, frame 0, one renderer for all of them.
//
//   node scripts/remotion-effects/kinetograph.mjs <dir> <outDir> [backends=webgl2,webgpu,2d] [id,id,...]
//
// Writes <outDir>/k-<id>-<backend>.png and <outDir>/report-<backends>.json (the failures and what was left out). The
// backend is KINETOGRAPH_PREFERRED_EFFECT_BACKEND: with a fallback to the effect's next implementation, as in a render.
// Run `npm run build` first.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cli = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'packages', 'cli', 'dist');
const { openSource } = await import(pathToFileURL(join(cli, 'source.js')).href);
const { FrameDrawer } = await import(pathToFileURL(join(cli, 'frame-drawer.js')).href);
const { newRenderer } = await import(pathToFileURL(join(cli, 'commands', 'types.js')).href);

const dir = resolve(process.argv[2]);
const outDir = resolve(process.argv[3]);
const backends = (process.argv[4] ?? 'webgl2,webgpu,2d').split(',');
const only = process.argv[5]?.split(',');
const { effects } = JSON.parse(readFileSync(join(dir, 'effects.json'), 'utf8'));
mkdirSync(outDir, { recursive: true });

const renderer = newRenderer();
const report = [];
const warn = console.warn;
for (const id of only ?? ['none', ...Object.keys(effects)]) {
  for (const backend of backends) {
    if (id !== 'none' && !(effects[id]?.impls ?? []).includes(backend)) continue;
    process.env.KINETOGRAPH_PREFERRED_EFFECT_BACKEND = backend;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const source = await openSource(join(dir, 'src', 'index.tsx'), { comp: id });
      const drawer = new FrameDrawer(source, { renderer: () => renderer, progress: () => {}, strict: false });
      writeFileSync(join(outDir, `k-${id}-${backend}.png`), await drawer.png(0));
      report.push({ id, backend, ok: true, warnings, leftOut: drawer.report().leftOut ?? [] });
      source.dispose();
    } catch (error) {
      report.push({ id, backend, ok: false, error: String(error.message).slice(0, 400), warnings });
    }
    console.warn = warn;
  }
}
writeFileSync(join(outDir, `report-${backends.join('-')}.json`), JSON.stringify(report, null, 1));
console.log(`${report.filter((r) => r.ok).length} rendered, ${report.filter((r) => !r.ok).length} failed`);
process.exit(0);
