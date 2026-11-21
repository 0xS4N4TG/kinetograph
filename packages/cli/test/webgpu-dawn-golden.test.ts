// Dawn's goldens (KINETOGRAPH_WEBGPU=dawn): each case of crates/dom/tests/webgpu/*.js, the calls the hand-written layer's tests run, is run on
// Dawn's real device through the built CLI and compared with crates/dom/tests/golden/dawn/<name>.png. They are a parallel set: Dawn's pictures
// differ slightly from the hand-written layer's (tests/golden/webgpu_*.png, untouched), so each has its own, recorded on the M4 (Metal)
// with `UPDATE_GOLDEN=1 npx vitest run webgpu-dawn-golden`. No channel of any pixel may differ by more than DAWN_GOLDEN_TOLERANCE (default 3:
// the same machine and backend give the same bytes, the slack is for a driver or Dawn update that moves a rounding).
// Skipped, with the reason, when dawn.node, the built addon or the built CLI is missing, or on a platform other than macOS (the goldens
// are Metal's: Vulkan and D3D12 need their own, see the PR notes).

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadDawnBinary } from '@kinetographdev/compat/shim';
import { decodePng } from '../src/png.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 });
// A child that hangs is killed and reported; spawnSync would otherwise block the test run for ever.
const SPAWN_TIMEOUT = 110_000;

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');
const cases = join(here, '..', '..', '..', 'crates', 'dom', 'tests', 'webgpu');
const goldens = join(here, '..', '..', '..', 'crates', 'dom', 'tests', 'golden', 'dawn');
const update = process.env.UPDATE_GOLDEN !== undefined;
const tolerance = Number(process.env.DAWN_GOLDEN_TOLERANCE ?? 3);

const missing = ((): string | null => {
  if (process.platform !== 'darwin') return `the goldens are Metal's (macOS); this is ${process.platform}`;
  try {
    if (process.env.KINETOGRAPH_DAWN_MODULE) createRequire(import.meta.url)(process.env.KINETOGRAPH_DAWN_MODULE);
    else loadDawnBinary(import.meta.url);
  } catch (error) {
    return `Dawn cannot be loaded (${(error as Error).message.split('\n')[0]})`;
  }
  try {
    createRequire(import.meta.url)('@kinetographdev/native');
  } catch {
    return 'the native addon (@kinetographdev/native) is not built';
  }
  if (!existsSync(cli)) return 'the CLI is not built (npm run build)';
  if (!existsSync(cases)) return `${cases} does not exist`;
  return null;
})();

if (missing !== null) describe('Dawn goldens', () => it.skip(`skipped: ${missing}`, () => {}));

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kg-dawn-golden-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The page of a case: its canvas, a Dawn device, and the calls (the same wrapper the hand-written layer's tests use). */
function pageOf(script: string): { html: string; w: number; h: number } {
  const size = /^\/\/ size: (\d+) (\d+)/.exec(script);
  if (size === null) throw new Error('the first line of a case is its size');
  const w = Number(size[1]);
  const h = Number(size[2]);
  const html = `<!doctype html><html><body style="margin:0"><div id="kg-root" data-composition-id="main" data-width="${w}" data-height="${h}" data-duration="1" style="position:relative;width:${w}px;height:${h}px"><canvas id="c" width="${w}" height="${h}" style="display:block"></canvas>
<script type="module">
const W = ${w}, H = ${h}, format = 'rgba8unorm';
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();
const context = document.getElementById('c').getContext('webgpu');
context.configure({ device, format, alphaMode: 'premultiplied' });
await (async function (device, context, format, W, H) {
${script}
})(device, context, format, W, H);
await device.queue.onSubmittedWorkDone();
</script></div></body></html>`;
  return { html, w, h };
}

const names = missing === null ? readdirSync(cases).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).sort() : [];

describe.skipIf(missing !== null)('Dawn goldens', () => {
  for (const name of names) {
    it(`${name} is its Dawn golden`, () => {
      const { html } = pageOf(readFileSync(join(cases, `${name}.js`), 'utf8'));
      const page = join(dir, `${name}.html`);
      const out = join(dir, `${name}.png`);
      writeFileSync(page, html);
      const r = spawnSync(process.execPath, [cli, 'still', page, '0', '--offline', '--strict', '-o', out], { encoding: 'utf8', timeout: SPAWN_TIMEOUT, killSignal: 'SIGKILL', env: { ...process.env, KINETOGRAPH_WEBGPU: 'dawn' } });
      expect(r.status, r.stderr).toBe(0);
      const golden = join(goldens, `${name}.png`);
      if (update) {
        mkdirSync(goldens, { recursive: true });
        copyFileSync(out, golden);
        return;
      }
      expect(existsSync(golden), `no golden ${golden} (UPDATE_GOLDEN=1 on the M4)`).toBe(true);
      const got = decodePng(readFileSync(out));
      const want = decodePng(readFileSync(golden));
      expect([got.width, got.height], `${name}: size changed`).toEqual([want.width, want.height]);
      let worst = 0;
      for (let i = 0; i < got.data.length; i++) worst = Math.max(worst, Math.abs(got.data[i]! - want.data[i]!));
      expect(worst, `${name}: a channel differs from the golden by ${worst} (tolerance ${tolerance})`).toBeLessThanOrEqual(tolerance);
    });
  }
});
