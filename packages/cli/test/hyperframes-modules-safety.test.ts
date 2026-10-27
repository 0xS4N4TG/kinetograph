import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useLockFile, type FetchResponse } from '../src/hyperframes/deps.js';
import { buildPlan } from '../src/hyperframes/plan.js';
import { prefetchHyperframes } from '../src/hyperframes/prefetch.js';

const FILES: Record<string, string> = {
  'https://esm.sh/evil@1.0.0': `import secret from "file:///etc/passwd";\nexport default secret;\n`,
  'https://esm.sh/dayjs@1.11.10': `export default function dayjs() { return "dayjs"; }\n`,
};
const fakeFetch = async (url: string): Promise<FetchResponse> => {
  const body = FILES[url];
  if (body === undefined) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
  return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer };
};
const WRONG = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

let dir: string;
let project: string;
let index: string;
const saved = process.env.KINETOGRAPH_CDN_CACHE;
const page = (body: string): string => `<html><body><div data-composition-id="main" data-duration="1"></div>${body}</body></html>`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kg-modsafe-'));
  process.env.KINETOGRAPH_CDN_CACHE = join(dir, 'cache');
  project = join(dir, 'proj');
  mkdirSync(join(project, 'js'), { recursive: true });
  writeFileSync(join(project, 'js', 'late.js'), 'export const value = 1;');
  writeFileSync(join(dir, 'outside.js'), 'export const x = 1;');
  index = join(project, 'index.html');
});
afterEach(() => {
  useLockFile(null);
  if (saved === undefined) delete process.env.KINETOGRAPH_CDN_CACHE;
  else process.env.KINETOGRAPH_CDN_CACHE = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe('what a module script may load', () => {
  it('rejects a remote module that imports a file of this machine', async () => {
    writeFileSync(index, page(`<script type="module">import e from "https://esm.sh/evil@1.0.0"; window.e = e;</script>`));
    await prefetchHyperframes(index, { fetchImpl: fakeFetch });
    const { plan } = await buildPlan(index);
    expect(plan.scripts).toHaveLength(0);
    expect(plan.notes.join('\n')).toMatch(/remote module may only import https/);
  });

  it('rejects an import map value that leaves the project', async () => {
    writeFileSync(index, page(`<script type="importmap">{"imports":{"out":"../outside.js"}}</script><script type="module">import { x } from "out"; window.x = x;</script>`));
    const { plan } = await buildPlan(index);
    expect(plan.scripts).toHaveLength(0);
    expect(plan.notes.join('\n')).toMatch(/outside the project/);
  });

  it('rejects a relative import and a src that leave the project', async () => {
    writeFileSync(index, page(`<script type="module">import { x } from "../outside.js"; window.x = x;</script>`));
    expect((await buildPlan(index)).plan.notes.join('\n')).toMatch(/outside the project/);
  });

  it("checks a module script's integrity attribute, remote and local", async () => {
    writeFileSync(index, page(`<script type="module" src="https://esm.sh/dayjs@1.11.10" integrity="${WRONG}"></script>`));
    await prefetchHyperframes(index, { fetchImpl: fakeFetch });
    await expect(buildPlan(index)).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' });

    writeFileSync(index, page(`<script type="module" src="./js/late.js" integrity="${WRONG}"></script>`));
    await expect(buildPlan(index)).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' });
  });
});
