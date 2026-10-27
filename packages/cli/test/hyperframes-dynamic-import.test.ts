// `import()` of a specifier built at run time: the pre-download pass runs the page and downloads what it asks for, a
// render then answers from the cache, a specifier first seen in a render is fetched once, and `--offline` names it.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
// The page's DOM shim replaces the global timers once a project has run, so the test waits on the real ones.
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLock } from '@kinetographdev/core/lock';
import { useLockFile, type FetchResponse } from '../src/hyperframes/deps.js';
import { DYNAMIC_CONFIG, installDynamicImport, resetDynamicImports } from '../src/hyperframes/dynamic.js';
import { DYNAMIC_IMPORT } from '../src/hyperframes/modules.js';
import { buildPlan } from '../src/hyperframes/plan.js';
import { prefetchHyperframes } from '../src/hyperframes/prefetch.js';

vi.setConfig({ testTimeout: 120_000 });

const FILES: Record<string, string> = {
  'https://esm.sh/dayjs@1.11.10': `export default function dayjs() { return "dayjs"; }\n`,
  'https://esm.sh/locale/de.js': `import { shout } from "./shout.js";\nexport const hello = shout("hallo");\n`,
  'https://esm.sh/locale/shout.js': `export const shout = (s) => s.toUpperCase();\n`,
};

const ok = (body: string): FetchResponse => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
});
const fakeFetch = async (url: string): Promise<FetchResponse> => {
  const body = FILES[url];
  return body === undefined ? { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) } : ok(body);
};

const PAGE = `<!doctype html><html><head>
<script type="importmap">{"imports":{"dayjs":"https://esm.sh/dayjs@1.11.10","locale/":"https://esm.sh/locale/"}}</script>
<script type="module">
  const lang = "fr";
  const name = "dayjs";
  try {
    const local = await import(\`./locale/\${lang}.js\`);
    const day = await import(name);
    const remote = await import("locale/" + "de.js");
    window.__result = { hello: local.hello, day: day.default(), remote: remote.hello, url: import.meta.url };
  } catch (error) {
    window.__error = error.message;
  }
</script>
</head><body><div data-composition-id="main" data-width="320" data-height="180" data-duration="1"></div></body></html>`;

let dir: string;
let index: string;
const saved = { cache: process.env.KINETOGRAPH_CDN_CACHE, offline: process.env.KINETOGRAPH_OFFLINE };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kg-dyn-'));
  process.env.KINETOGRAPH_CDN_CACHE = join(dir, 'cache');
  delete process.env.KINETOGRAPH_OFFLINE;
  mkdirSync(join(dir, 'locale'));
  index = join(dir, 'index.html');
  writeFileSync(index, PAGE);
  writeFileSync(join(dir, 'locale', 'fr.js'), `export const hello = "bonjour";\n`);
  resetDynamicImports();
});
afterEach(() => {
  vi.unstubAllGlobals();
  useLockFile(null);
  for (const [key, value] of [['KINETOGRAPH_CDN_CACHE', saved.cache], ['KINETOGRAPH_OFFLINE', saved.offline]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete (globalThis as Record<symbol, unknown>)[DYNAMIC_CONFIG];
  rmSync(dir, { recursive: true, force: true });
});

/** Runs the plan's scripts as the runtime does (the host answers `import()`), and waits for the module to finish. */
async function runPage(): Promise<Record<string, unknown>> {
  const { plan, importMap } = await buildPlan(index);
  expect(plan.notes).toEqual([]);
  (globalThis as Record<symbol, unknown>)[DYNAMIC_CONFIG] = { importMap, root: dir, entry: index };
  installDynamicImport();
  const sandbox: Record<string | symbol, unknown> = {};
  sandbox.window = sandbox;
  sandbox[DYNAMIC_IMPORT] = (globalThis as Record<symbol, unknown>)[DYNAMIC_IMPORT];
  vm.createContext(sandbox);
  for (const script of plan.scripts) new vm.Script(script.code, { filename: script.file }).runInContext(sandbox);
  for (let i = 0; i < 300 && sandbox.__result === undefined && sandbox.__error === undefined; i++) await sleep(20);
  return sandbox;
}

describe('computed import()', () => {
  it('the pre-pass runs the page and downloads the specifiers it builds; a render then needs no network', async () => {
    const requested: string[] = [];
    const result = await prefetchHyperframes(index, {
      fetchImpl: async (url) => (requested.push(url), fakeFetch(url)),
    });
    expect(result.files.filter((f) => f.status === 'failed')).toEqual([]);
    // A bare specifier through the map, and a prefix built from two strings: both found by running the page.
    expect(requested.sort()).toEqual(Object.keys(FILES).sort());
    expect(Object.keys(readLock(join(dir, 'kinetograph.lock.json')).files).sort()).toEqual(Object.keys(FILES).sort());

    // The render: offline, and a network that must not be touched.
    process.env.KINETOGRAPH_OFFLINE = '1';
    vi.stubGlobal('fetch', async () => {
      throw new Error('no network in a render');
    });
    resetDynamicImports();
    const page = await runPage();
    expect(page.__error).toBeUndefined();
    expect(page.__result).toEqual({ hello: 'bonjour', day: 'dayjs', remote: 'HALLO', url: `file://${index}` });
  });

  it('with --offline, a specifier that was never downloaded is an error that names it', async () => {
    process.env.KINETOGRAPH_OFFLINE = '1';
    vi.stubGlobal('fetch', async () => {
      throw new Error('no network');
    });
    const page = await runPage();
    expect(page.__result).toBeUndefined();
    expect(String(page.__error)).toMatch(/import\("dayjs"\)/);
    expect(String(page.__error)).toMatch(/--offline/);
  });

  it('a specifier first seen in a render is fetched once and locked', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requested.push(String(url));
      return fakeFetch(String(url));
    });
    const page = await runPage();
    expect(page.__error).toBeUndefined();
    expect(page.__result).toMatchObject({ hello: 'bonjour', day: 'dayjs', remote: 'HALLO' });
    expect(requested.sort()).toEqual(Object.keys(FILES).sort());
    const lock = JSON.parse(readFileSync(join(dir, 'kinetograph.lock.json'), 'utf8')) as { files: Record<string, unknown> };
    expect(Object.keys(lock.files).sort()).toEqual(Object.keys(FILES).sort());
  });
});
