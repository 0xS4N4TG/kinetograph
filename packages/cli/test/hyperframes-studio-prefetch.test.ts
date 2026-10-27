// The studio downloads what a project newly needs without a restart: a dependency added in a sub-composition file, or in
// a local module a page imports, is fetched on the next preview or rebuild; what is cached is not asked for again.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundleProject } from '../src/bundle.js';
import { useLockFile, type FetchResponse } from '../src/hyperframes/deps.js';
import { setBeforePlan } from '../src/hyperframes/entry.js';
import { prefetchBeforePlan, setPrefetchDebounce } from '../src/prefetch.js';

const BODIES: Record<string, string> = {
  'https://esm.sh/one.js': 'export const one = 1;\n',
  'https://esm.sh/two.js': 'export const two = 2;\n',
  'https://esm.sh/three.js': 'export const three = 3;\n',
};
const requested: string[] = [];
const fetchImpl = async (url: string): Promise<FetchResponse> => {
  requested.push(url);
  const body = BODIES[url];
  return {
    ok: body !== undefined,
    status: body === undefined ? 404 : 200,
    headers: { get: () => null },
    arrayBuffer: async () => new TextEncoder().encode(body ?? '').buffer as ArrayBuffer,
  };
};

const INDEX = `<!doctype html><html><body>
<div id="root" data-composition-id="main" data-width="320" data-height="180" data-duration="1">
  <div id="card" data-composition-id="card" data-composition-src="sub.html" data-start="0" data-duration="1"></div>
</div></body></html>`;
const sub = (script: string): string =>
  `<template><div data-composition-id="card" data-width="320" data-height="180"><p>hi</p></div>${script}</template>`;

let dir: string;
let index: string;
let tick = 0;
const saved = process.env.KINETOGRAPH_CDN_CACHE;

/** Writes a file with a modification time that is certainly different from its last (the file system's clock is coarse). */
function write(file: string, text: string): void {
  writeFileSync(file, text);
  const when = new Date(Date.now() + 10_000 * ++tick);
  utimesSync(file, when, when);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kg-studio-prefetch-'));
  process.env.KINETOGRAPH_CDN_CACHE = join(dir, 'cache');
  index = join(dir, 'index.html');
  requested.length = 0;
  setPrefetchDebounce(0);
  write(index, INDEX);
  write(join(dir, 'sub.html'), sub(''));
});
afterEach(() => {
  setBeforePlan(null);
  useLockFile(null);
  setPrefetchDebounce(150);
  if (saved === undefined) delete process.env.KINETOGRAPH_CDN_CACHE;
  else process.env.KINETOGRAPH_CDN_CACHE = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe('the studio download step', () => {
  it('runs once, then again only when a file of the project changed, and fetches only what is new', async () => {
    await prefetchBeforePlan(index, { fetchImpl });
    expect(requested).toEqual([]);
    await prefetchBeforePlan(index, { fetchImpl });
    expect(requested).toEqual([]);

    // An import is added to the sub-composition: no restart, the next call downloads it.
    write(join(dir, 'sub.html'), sub(`<script type="module">import { one } from "https://esm.sh/one.js"; window.one = one;</script>`));
    await prefetchBeforePlan(index, { fetchImpl });
    expect(requested).toEqual(['https://esm.sh/one.js']);

    // Nothing changed: the network is not touched.
    await prefetchBeforePlan(index, { fetchImpl });
    expect(requested).toEqual(['https://esm.sh/one.js']);

    // A second import joins the first: only the new one is fetched.
    write(
      join(dir, 'sub.html'),
      sub(`<script type="module">import { one } from "https://esm.sh/one.js"; import { two } from "https://esm.sh/two.js"; window.x = one + two;</script>`),
    );
    await prefetchBeforePlan(index, { fetchImpl });
    expect(requested).toEqual(['https://esm.sh/one.js', 'https://esm.sh/two.js']);
  });

  it('follows a local module the page imports: an import added to it is fetched', async () => {
    write(join(dir, 'mod.js'), `export const value = 1;\n`);
    write(join(dir, 'sub.html'), sub(`<script type="module" src="./mod.js"></script>`));
    await prefetchBeforePlan(index, { fetchImpl });
    expect(requested).toEqual([]);

    write(join(dir, 'mod.js'), `import { three } from "https://esm.sh/three.js";\nexport const value = three;\n`);
    await prefetchBeforePlan(index, { fetchImpl });
    expect(requested).toEqual(['https://esm.sh/three.js']);
  });

  it('coalesces calls that arrive together into one run', async () => {
    write(join(dir, 'sub.html'), sub(`<script type="module">import "https://esm.sh/one.js";</script>`));
    await Promise.all([prefetchBeforePlan(index, { fetchImpl }), prefetchBeforePlan(index, { fetchImpl }), prefetchBeforePlan(index, { fetchImpl })]);
    expect(requested).toEqual(['https://esm.sh/one.js']);
  });

  it('a rebuild downloads the new dependency first (the hook the studio sets), where without it the build fails', async () => {
    await prefetchBeforePlan(index, { fetchImpl });
    mkdirSync(join(dir, 'cache'), { recursive: true });
    write(join(dir, 'sub.html'), sub(`<script type="module">import { one } from "https://esm.sh/one.js"; window.one = one;</script>`));
    await expect(bundleProject(index)).rejects.toThrow(/not available|not cached/);
    setBeforePlan((entry) => prefetchBeforePlan(entry, { fetchImpl }));
    await bundleProject(index);
    expect(requested).toEqual(['https://esm.sh/one.js']);
  });
});
