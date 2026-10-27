import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLock } from '@kinetographdev/core/lock';
import { useLockFile, type FetchResponse } from '../src/hyperframes/deps.js';
import { mergeImportMaps, parseImportMap, resolveImport } from '../src/hyperframes/modules.js';
import { prefetchHyperframes } from '../src/hyperframes/prefetch.js';
import { buildPlan } from '../src/hyperframes/plan.js';

const BASE = 'file:///project/index.html';

describe('import maps', () => {
  const map = parseImportMap(
    JSON.stringify({
      imports: {
        gsap: 'https://esm.sh/gsap@3.12.5',
        'lodash/': 'https://esm.sh/lodash-es@4.17.21/',
        'lodash/fp': 'https://esm.sh/lodash-es@4.17.21/fp.js',
        './lib/util.js': './vendor/util-v2.js',
        shared: '/shared/index.js',
      },
      scopes: {
        'https://esm.sh/': { gsap: 'https://esm.sh/gsap@3.11.0' },
        'https://esm.sh/v135/': { gsap: 'https://esm.sh/gsap@3.9.0' },
        '/deep/': { shared: './deep-shared.js' },
      },
    }),
    BASE,
  );

  it('maps an exact bare name', () => {
    expect(resolveImport('gsap', BASE, map)).toBe('https://esm.sh/gsap@3.12.5');
  });

  it('maps a trailing-slash key as a prefix, and the longest key wins', () => {
    expect(resolveImport('lodash/debounce.js', BASE, map)).toBe('https://esm.sh/lodash-es@4.17.21/debounce.js');
    expect(resolveImport('lodash/fp', BASE, map)).toBe('https://esm.sh/lodash-es@4.17.21/fp.js');
  });

  it('resolves values and URL-like keys against the page', () => {
    expect(resolveImport('shared', BASE, map)).toBe('file:///shared/index.js');
    expect(resolveImport('./lib/util.js', BASE, map)).toBe('file:///project/vendor/util-v2.js');
  });

  it('prefers the most specific scope that holds the referrer, then outer scopes, then the top level', () => {
    expect(resolveImport('gsap', 'https://esm.sh/v135/x.mjs', map)).toBe('https://esm.sh/gsap@3.9.0');
    expect(resolveImport('gsap', 'https://esm.sh/other.mjs', map)).toBe('https://esm.sh/gsap@3.11.0');
    expect(resolveImport('gsap', 'https://cdn.example.com/a.js', map)).toBe('https://esm.sh/gsap@3.12.5');
    expect(resolveImport('shared', 'file:///deep/a/b.js', map)).toBe('file:///project/deep-shared.js');
    // A scope that has no entry for the name falls through to the next.
    expect(resolveImport('lodash/x.js', 'https://esm.sh/v135/x.mjs', map)).toBe('https://esm.sh/lodash-es@4.17.21/x.js');
  });

  it('resolves URLs and relative or root-relative paths against the importer, bare names that are unmapped not at all', () => {
    expect(resolveImport('/v135/gsap@3.12.5/es2022/gsap.mjs', 'https://esm.sh/gsap@3.12.5', map)).toBe('https://esm.sh/v135/gsap@3.12.5/es2022/gsap.mjs');
    expect(resolveImport('./b.js', 'https://cdn.example.com/lib/a.js', map)).toBe('https://cdn.example.com/lib/b.js');
    expect(resolveImport('../c.js', 'https://cdn.example.com/lib/a.js', map)).toBe('https://cdn.example.com/c.js');
    expect(resolveImport('https://unpkg.com/x/y.js', BASE, map)).toBe('https://unpkg.com/x/y.js');
    expect(() => resolveImport('nope', BASE, map)).toThrow(/bare specifier "nope".*import map/);
  });

  it('reports what it ignores and keeps the first mapping when maps are merged', () => {
    const problems: string[] = [];
    const bad = parseImportMap(JSON.stringify({ imports: { a: 5, 'p/': 'https://x.test/p', b: 'https://x.test/b.js' } }), BASE, problems);
    expect(bad.imports).toEqual({ b: 'https://x.test/b.js' });
    expect(problems).toHaveLength(2);
    expect(parseImportMap('{oops', BASE, problems).imports).toEqual({});
    const merged = parseImportMap('{"imports":{"x":"https://a.test/x.js"}}', BASE);
    mergeImportMaps(merged, parseImportMap('{"imports":{"x":"https://b.test/x.js","y":"https://b.test/y.js"}}', BASE));
    expect(merged.imports).toEqual({ x: 'https://a.test/x.js', y: 'https://b.test/y.js' });
  });
});

// ---- a page that imports gsap from esm.sh through an import map, plus a relative module ----

const FILES: Record<string, string> = {
  'https://esm.sh/gsap@3.12.5': `export * from "/v135/gsap@3.12.5/es2022/gsap.mjs";\nexport { default } from "/v135/gsap@3.12.5/es2022/gsap.mjs";\n`,
  'https://esm.sh/v135/gsap@3.12.5/es2022/gsap.mjs': `import { helper } from "./helper.mjs";\nexport * from "./helper.mjs";\nexport const gsap = { version: "3.12.5", helped: helper() };\nexport default gsap;\n`,
  'https://esm.sh/v135/gsap@3.12.5/es2022/helper.mjs': `export const helper = () => "helped";\nexport const unused = 1;\n`,
  'https://esm.sh/dayjs@1.11.10': `export default function dayjs() { return "dayjs"; }\n`,
};

const ok = (body: string): FetchResponse => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
});
const fakeFetch = async (url: string): Promise<FetchResponse> => {
  const body = FILES[url];
  if (body === undefined) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
  return ok(body);
};

let dir: string;
let index: string;
const saved = process.env.KINETOGRAPH_CDN_CACHE;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kg-mod-'));
  process.env.KINETOGRAPH_CDN_CACHE = join(dir, 'cache');
  mkdirSync(join(dir, 'js'));
  index = join(dir, 'index.html');
  writeFileSync(
    index,
    `<!doctype html><html><head>
<script type="importmap">{"imports":{"gsap":"https://esm.sh/gsap@3.12.5","dayjs":"https://esm.sh/dayjs@1.11.10","app/":"./js/"}}</script>
<script type="module">
  import gsap, { helper } from "gsap";
  import dayjs from "dayjs";
  import { label } from "app/label.js";
  window.order = (window.order || []).concat("inline-module");
  const late = await import("./js/late.js");
  window.__result = { version: gsap.version, helped: gsap.helped, helper: helper(), day: dayjs(), label, late: late.value, url: import.meta.url };
</script>
<script type="module" src="./js/second.js"></script>
</head><body><div data-composition-id="main" data-width="320" data-height="180" data-duration="1"></div>
<script>window.order = (window.order || []).concat("classic");</script>
</body></html>`,
  );
  writeFileSync(join(dir, 'js', 'label.js'), `import { twice } from "./twice.js";\nexport const label = twice("label");\n`);
  writeFileSync(join(dir, 'js', 'twice.js'), `export const twice = (s) => s + s;\n`);
  writeFileSync(join(dir, 'js', 'late.js'), `export const value = "late";\n`);
  writeFileSync(join(dir, 'js', 'second.js'), `window.order = (window.order || []).concat("second-module");\nwindow.secondUrl = import.meta.url;\n`);
});
afterEach(() => {
  useLockFile(null);
  if (saved === undefined) delete process.env.KINETOGRAPH_CDN_CACHE;
  else process.env.KINETOGRAPH_CDN_CACHE = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe('module scripts', () => {
  it('downloads the whole import graph (re-exports, absolute /v135 paths) in the pre-pass and locks it', async () => {
    const requested: string[] = [];
    const result = await prefetchHyperframes(index, {
      fetchImpl: async (url) => {
        requested.push(url);
        return fakeFetch(url);
      },
    });
    expect(requested.sort()).toEqual(Object.keys(FILES).sort());
    expect(result.files.filter((f) => f.status === 'failed')).toEqual([]);
    const lock = readLock(join(dir, 'kinetograph.lock.json'));
    expect(Object.keys(lock.files).sort()).toEqual(Object.keys(FILES).sort());

    // Run again: everything is cached and the network is not touched.
    const again = await prefetchHyperframes(index, { fetchImpl: async () => { throw new Error('no network'); } });
    expect(again.fetched).toBe(0);
  });

  it('bundles each module into a classic script that runs after the classic ones, in order, with import.meta.url', async () => {
    await prefetchHyperframes(index, { fetchImpl: fakeFetch });
    const { plan, modules, importMap } = await buildPlan(index);
    expect(modules).toHaveLength(2);
    expect(importMap.imports.gsap).toBe('https://esm.sh/gsap@3.12.5');
    expect(plan.notes).toEqual([]);
    expect(plan.scripts.map((s) => s.file)).toEqual([index, index, join(dir, 'js', 'second.js')]);

    const sandbox: Record<string | symbol, unknown> = {};
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    for (const script of plan.scripts) new vm.Script(script.code, { filename: script.file }).runInContext(sandbox);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sandbox.__result).toEqual({
      version: '3.12.5',
      helped: 'helped',
      helper: 'helped',
      day: 'dayjs',
      label: 'labellabel',
      late: 'late',
      url: `file://${index}`,
    });
    // The classic script ran first even though a module is earlier in the document.
    expect(sandbox.order).toEqual(['classic', 'inline-module', 'second-module']);
    expect(sandbox.secondUrl).toBe(`file://${join(dir, 'js', 'second.js')}`);
    // An imported GSAP is left where the GSAP clock looks for it (this stub exports `gsap`).
    expect(vm.runInContext("globalThis[Symbol.for('kinetograph.gsap')]", sandbox)).toMatchObject({ version: '3.12.5' });
  });

  it('fails like a classic CDN script when the cache lacks a module (offline, nothing prefetched)', async () => {
    await expect(buildPlan(index)).rejects.toMatchObject({ code: 'SCRIPT_NOT_AVAILABLE' });
    await expect(buildPlan(index)).rejects.toThrow(/not cached/);
  });

  it('says so, and runs nothing, for a bare name the import map lacks', async () => {
    writeFileSync(
      index,
      `<html><body><div data-composition-id="main" data-duration="1"></div><script type="module">import x from "unmapped"; window.x = x;</script></body></html>`,
    );
    const { plan } = await buildPlan(index);
    expect(plan.scripts).toHaveLength(0);
    expect(plan.notes.join('\n')).toMatch(/bare specifier "unmapped"/);
  });

  it('the cache must still match the lock', async () => {
    await prefetchHyperframes(index, { fetchImpl: fakeFetch });
    useLockFile(null);
    const lockFile = join(dir, 'kinetograph.lock.json');
    const lock = JSON.parse((await import('node:fs')).readFileSync(lockFile, 'utf8'));
    lock.files['https://esm.sh/dayjs@1.11.10'].sha256 = '0'.repeat(64);
    writeFileSync(lockFile, JSON.stringify(lock));
    await expect(buildPlan(index)).rejects.toThrow(/kinetograph\.lock\.json/);
  });
});
