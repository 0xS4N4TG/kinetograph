// A HyperFrames page whose module script imports through an import map (a CDN module and a relative one), on the real
// addon and the built CLI: the pre-download step is seeded from a stand-in network, `doctor` finds nothing unsupported,
// and a still shows what the modules drew. Needs the built addon and `npm run build`, a GPU; skipped where one is missing.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readLock } from '@kinetographdev/core/lock';
import { decodePng } from '../src/png.js';
import { prefetchHyperframes } from '../src/hyperframes/prefetch.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 });

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'dist', 'cli.js');
const addon = (() => {
  try {
    createRequire(import.meta.url)('@kinetographdev/native');
    return true;
  } catch {
    return false;
  }
})();
const ready = addon && existsSync(cli);

const FILES: Record<string, string> = {
  'https://esm.sh/palette@1.0.0': `export * from "/v135/palette@1.0.0/es2022/palette.mjs";\n`,
  'https://esm.sh/v135/palette@1.0.0/es2022/palette.mjs': `export const color = "rgb(0, 170, 0)";\n`,
};

let dir: string;
let project: string;
const cache = () => join(dir, 'cache');
const env = () => ({ ...process.env, KINETOGRAPH_CDN_CACHE: cache() });
const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: env() });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kg-hf-mod-'));
  project = join(dir, 'project');
  mkdirSync(join(project, 'js'), { recursive: true });
  writeFileSync(
    join(project, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:#fff}#box{position:absolute;left:20px;top:20px;width:100px;height:100px}</style>
<script type="importmap">{"imports":{"palette":"https://esm.sh/palette@1.0.0"}}</script>
<script type="module">
  import { color } from "palette";
  import { place } from "./js/place.js";
  const box = document.getElementById("box");
  box.style.background = color;
  place(box);
</script>
</head><body><div id="root" data-composition-id="main" data-width="200" data-height="150" data-duration="1"><div id="box"></div></div></body></html>`,
  );
  writeFileSync(join(project, 'js', 'place.js'), `export const place = (el) => { el.style.left = "50px"; };\n`);
  // The stand-in network fills the cache once; every later run finds all of it there.
  process.env.KINETOGRAPH_CDN_CACHE = cache();
  await prefetchHyperframes(join(project, 'index.html'), {
    fetchImpl: async (url) => {
      const body = FILES[url];
      return body === undefined
        ? { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }
        : { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer };
    },
  });
  delete process.env.KINETOGRAPH_CDN_CACHE;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!ready)('a page with module scripts and an import map', () => {
  it('locks the downloaded modules beside the entry', () => {
    expect(Object.keys(readLock(join(project, 'kinetograph.lock.json')).files).sort()).toEqual(Object.keys(FILES).sort());
  });

  it('is clean in doctor, with the downloads already done', () => {
    const out = run(['doctor', project, '--offline', '--json']);
    expect(out.status).toBe(0);
    const report = JSON.parse(out.stdout) as { unsupported?: unknown[]; error?: string };
    expect(report.error).toBeUndefined();
    expect(report.unsupported ?? []).toEqual([]);
  });

  it('draws what the modules set, from the cache alone', () => {
    const png = join(dir, 'still.png');
    const out = run(['still', project, '0', '-o', png, '--offline']);
    expect(out.status, out.stderr).toBe(0);
    const image = decodePng(readFileSync(png));
    const at = (x: number, y: number) => [...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
    // The box moved from left 20px to 50px by the relative module, and was coloured by the CDN module.
    expect(at(100, 70)).toEqual([0, 170, 0]);
    expect(at(30, 70)).toEqual([255, 255, 255]);
  });
});
