#!/usr/bin/env node
// Remotion's own render of each effect, in Chrome: the oracle. One bundle and one browser for all of them.
//
//   node scripts/remotion-effects/oracle.mjs <dir> <outDir> [backends=webgl2,webgpu,2d] [id,id,...]
//
// Writes <outDir>/r-<id>-<backend>.png (frame 0, 960 x 540) for each backend the effect implements. Run from <dir>'s
// install: it imports @remotion/bundler and @remotion/renderer from there.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = resolve(process.argv[2]);
const outDir = resolve(process.argv[3]);
const backends = (process.argv[4] ?? 'webgl2,webgpu,2d').split(',');
const only = process.argv[5]?.split(',');
const require = createRequire(join(dir, 'package.json'));
const load = (name) => import(pathToFileURL(require.resolve(name)).href);
const { bundle } = await load('@remotion/bundler');
const { renderStill, selectComposition, openBrowser } = await load('@remotion/renderer');
const { effects } = JSON.parse(readFileSync(join(dir, 'effects.json'), 'utf8'));

mkdirSync(outDir, { recursive: true });
const serveUrl = await bundle({ entryPoint: join(dir, 'src', 'index.tsx'), publicDir: join(dir, 'public') });
const chromiumOptions = { gl: 'angle' };
const browser = await openBrowser('chrome', { chromiumOptions });
const report = [];
for (const id of only ?? ['none', ...Object.keys(effects)]) {
  for (const backend of backends) {
    if (id !== 'none' && !(effects[id]?.impls ?? []).includes(backend)) continue;
    try {
      const composition = await selectComposition({ serveUrl, id, puppeteerInstance: browser, chromiumOptions, preferredEffectBackend: backend });
      await renderStill({ composition, serveUrl, output: join(outDir, `r-${id}-${backend}.png`), frame: 0, puppeteerInstance: browser, chromiumOptions, preferredEffectBackend: backend, overwrite: true, logLevel: 'error' });
      report.push({ id, backend, ok: true });
    } catch (error) {
      report.push({ id, backend, ok: false, error: String(error.message).slice(0, 300) });
    }
  }
}
writeFileSync(join(outDir, 'oracle-report.json'), JSON.stringify(report, null, 1));
console.log(`${report.filter((r) => r.ok).length} rendered, ${report.filter((r) => !r.ok).length} failed`);
await browser.close({ silent: false });
process.exit(0);
