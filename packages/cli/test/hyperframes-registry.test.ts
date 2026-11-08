import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/index.js';
import {
  addHyperframes,
  filterListing,
  HYPERFRAMES_PINNED_REF,
  hyperframesName,
  mergeCredits,
  openHyperframes,
  remapTarget,
  resolveHyperframes,
  type HyperframesAdded,
} from '../src/registry/hyperframes.js';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'kinetograph-hf-test-'));
const BASE = `https://raw.githubusercontent.com/heygen-com/hyperframes/${HYPERFRAMES_PINNED_REF}/registry`;
const CDN = 'https://static.heygen.ai/hyperframes/font.woff2';

const item = (name: string, type: string, over: object = {}, files?: object[]) => ({
  name,
  type: `hyperframes:${type}`,
  title: name.toUpperCase(),
  description: `The ${name} item.`,
  files: files ?? [{ path: `${name}.html`, target: type === 'block' ? `compositions/${name}.html` : `compositions/components/${name}.html`, type: 'hyperframes:composition' }],
  ...over,
});

/** A served registry: URL -> body. */
function served(): Map<string, string | Uint8Array> {
  const files = new Map<string, string | Uint8Array>();
  const put = (path: string, body: string | Uint8Array): void => void files.set(`${BASE}/${path}`, body);
  put('registry.json', JSON.stringify({ name: 'hyperframes', items: [
    { name: 'card', type: 'hyperframes:block' },
    { name: 'glow', type: 'hyperframes:component' },
    { name: 'loop-a', type: 'hyperframes:component' },
    { name: 'loop-b', type: 'hyperframes:component' },
    { name: 'starter', type: 'hyperframes:example' },
  ] }));
  put('blocks/card/registry-item.json', JSON.stringify(item('card', 'block', {
    author: 'Jane Doe',
    authorUrl: 'https://example.com/jane',
    license: 'Apache-2.0 AND OFL-1.1',
    dimensions: { width: 1920, height: 1080 },
    duration: 4,
    tags: ['title', 'text'],
    registryDependencies: ['glow'],
  }, [
    { path: 'card.html', target: 'compositions/card.html', type: 'hyperframes:composition' },
    { path: 'assets/font.woff2', url: CDN, target: 'assets/font.woff2', type: 'hyperframes:asset' },
    { path: 'assets/Font-OFL.txt', target: 'assets/Font-OFL.txt', type: 'hyperframes:asset' },
  ])));
  put('blocks/card/card.html', '<div data-composition-id="card"></div>');
  put('blocks/card/assets/Font-OFL.txt', 'SIL Open Font License');
  files.set(CDN, new Uint8Array([1, 2, 3, 4]));
  put('components/glow/registry-item.json', JSON.stringify(item('glow', 'component', { tags: ['effect'] })));
  put('components/glow/glow.html', '<div class="glow"></div>');
  put('components/loop-a/registry-item.json', JSON.stringify(item('loop-a', 'component', { registryDependencies: ['loop-b'] })));
  put('components/loop-b/registry-item.json', JSON.stringify(item('loop-b', 'component', { registryDependencies: ['loop-a'] })));
  return files;
}

function mockFetch(files: Map<string, string | Uint8Array>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const body = files.get(url);
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(typeof body === 'string' ? body : Buffer.from(body), { status: 200 });
  };
  return Object.assign(impl, { calls }) as typeof fetch & { calls: string[] };
}

let cacheDir: string;
beforeEach(() => {
  cacheDir = scratch();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const open = (files = served(), extra: object = {}) => {
  const fetch = mockFetch(files);
  return { fetch, source: openHyperframes({ fetch, cacheDir, ...extra }) };
};

describe('fetching HyperFrames items', () => {
  it('reads the registry at the pinned commit, and an item with its files', async () => {
    const { fetch, source } = open();
    expect(source.ref).toBe(HYPERFRAMES_PINNED_REF);
    expect(await source.manifest()).toEqual([
      { name: 'card', type: 'block' },
      { name: 'glow', type: 'component' },
      { name: 'loop-a', type: 'component' },
      { name: 'loop-b', type: 'component' },
    ]);
    const card = await source.item('card');
    expect(card).toMatchObject({ kind: 'block', author: 'Jane Doe', license: 'Apache-2.0 AND OFL-1.1' });
    expect(fetch.calls).toEqual([`${BASE}/registry.json`, `${BASE}/blocks/card/registry-item.json`]);
    expect(Buffer.from(await source.file(card, card.files[0]!)).toString()).toContain('data-composition-id="card"');
    // a file with a url comes from there, not from the registry
    expect([...(await source.file(card, card.files[1]!))]).toEqual([1, 2, 3, 4]);
    expect(fetch.calls.at(-1)).toBe(CDN);
    expect(source.sourceUrl(card)).toBe(`https://github.com/heygen-com/hyperframes/tree/${HYPERFRAMES_PINNED_REF}/registry/blocks/card`);
  });

  it('reads another commit when asked', async () => {
    const files = new Map<string, string | Uint8Array>([[`https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry/registry.json`, JSON.stringify({ items: [] })]]);
    const { source } = open(files, { ref: 'main' });
    expect(await source.manifest()).toEqual([]);
    expect(() => openHyperframes({ ref: '../x' })).toThrow(/not a commit/);
  });

  it('refuses a name it does not have, a bad name, an unsafe path and a non-https asset', async () => {
    const files = served();
    files.set(`${BASE}/components/glow/registry-item.json`, JSON.stringify(item('glow', 'component', {}, [{ path: 'glow.html', target: '../evil.html' }])));
    files.set(`${BASE}/components/loop-a/registry-item.json`, JSON.stringify(item('loop-a', 'component', {}, [{ path: 'a.png', target: 'assets/a.png', url: 'http://cdn.example.com/a.png' }])));
    const { source } = open(files);
    await expect(source.item('nothing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(source.item('Bad Name')).rejects.toMatchObject({ code: 'INVALID_ARG' });
    await expect(source.item('starter')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(source.item('glow')).rejects.toMatchObject({ code: 'UNSAFE_TARGET' });
    await expect(source.item('loop-a')).rejects.toMatchObject({ code: 'INSECURE_URL' });
  });

  it('caches the manifest for a day, and uses a stale copy when the network fails', async () => {
    let time = 1_000_000;
    const files = served();
    const { fetch, source } = open(files, { now: () => time });
    await source.manifest();
    await source.manifest();
    expect(fetch.calls.filter((u) => u.endsWith('registry.json'))).toHaveLength(1);
    time += 23 * 3600_000;
    await source.manifest();
    expect(fetch.calls.filter((u) => u.endsWith('registry.json'))).toHaveLength(1);
    time += 2 * 3600_000;
    await source.manifest();
    expect(fetch.calls.filter((u) => u.endsWith('registry.json'))).toHaveLength(2);
    // offline after the cache is stale: the old copy answers
    time += 48 * 3600_000;
    files.clear();
    expect(await source.manifest()).toHaveLength(4);
  });

  it('builds a listing with descriptions and filters it', async () => {
    const { source } = open();
    const index = await source.index();
    expect(index.map((i) => i.name)).toEqual(['card', 'glow', 'loop-a', 'loop-b']);
    expect(filterListing(index, 'block').map((i) => i.name)).toEqual(['card']);
    expect(filterListing(index, undefined, 'effect glow').map((i) => i.name)).toEqual(['glow']);
    expect(filterListing(index, undefined, 'title text').map((i) => i.name)).toEqual(['card']);
  });

  it('reads the hyperframes/ and hf/ prefixes', () => {
    expect(hyperframesName('hyperframes/aurora')).toBe('aurora');
    expect(hyperframesName('hf/aurora')).toBe('aurora');
    expect(hyperframesName('hyperframes')).toBe('');
    expect(hyperframesName('title-card')).toBeUndefined();
    expect(hyperframesName('hyperframes-x/aurora')).toBeUndefined();
  });
});

describe('dependencies', () => {
  it('installs registryDependencies first, each once', async () => {
    const { source } = open();
    expect((await resolveHyperframes(source, ['card', 'glow'])).map((i) => i.name)).toEqual(['glow', 'card']);
  });

  it('refuses a loop', async () => {
    const { source } = open();
    await expect(resolveHyperframes(source, ['loop-a'])).rejects.toThrow(/loop: loop-a -> loop-b -> loop-a/);
  });
});

describe('writing', () => {
  const project = (): string => {
    const dir = scratch();
    writeFileSync(join(dir, 'index.html'), '<div data-composition-id="main"></div>');
    return dir;
  };

  it('lays blocks and components out the way HyperFrames does, with assets and licence files', async () => {
    const dir = project();
    const { source } = open();
    const result = await addHyperframes({ names: ['card'], dir, source, overwrite: false });
    expect(result.project).toBe(dir);
    expect(result.added.map((a) => [a.name, a.written])).toEqual([
      ['glow', ['compositions/components/glow.html']],
      ['card', ['compositions/card.html', 'assets/font.woff2', 'assets/Font-OFL.txt']],
    ]);
    expect(readFileSync(join(dir, 'compositions/card.html'), 'utf8')).toContain('data-composition-id="card"');
    expect([...readFileSync(join(dir, 'assets/font.woff2'))]).toEqual([1, 2, 3, 4]);
    expect(readFileSync(join(dir, 'assets/Font-OFL.txt'), 'utf8')).toBe('SIL Open Font License');
    expect(result.added[1]!.licences).toEqual(['assets/Font-OFL.txt']);
    expect(result.next[0]).toContain('data-composition-src="compositions/card.html"');
  });

  it('refuses to overwrite, writing nothing, unless told to', async () => {
    const dir = project();
    mkdirSync(join(dir, 'compositions'));
    writeFileSync(join(dir, 'compositions/card.html'), 'mine');
    const { source } = open();
    await expect(addHyperframes({ names: ['card'], dir, source, overwrite: false })).rejects.toMatchObject({ code: 'EXISTS', message: expect.stringContaining('compositions/card.html') });
    expect(existsSync(join(dir, 'compositions/components/glow.html'))).toBe(false);
    expect(existsSync(join(dir, 'HYPERFRAMES-CREDITS.md'))).toBe(false);
    expect(readFileSync(join(dir, 'compositions/card.html'), 'utf8')).toBe('mine');
    await addHyperframes({ names: ['card'], dir, source, overwrite: true });
    expect(readFileSync(join(dir, 'compositions/card.html'), 'utf8')).toContain('composition-id');
  });

  it('leaves a file that already holds the same bytes, so installing again is not an error', async () => {
    const dir = project();
    const { source } = open();
    await addHyperframes({ names: ['glow'], dir, source, overwrite: false });
    const again = await addHyperframes({ names: ['card'], dir, source, overwrite: false });
    expect(again.added.find((a) => a.name === 'glow')).toMatchObject({ written: [], unchanged: ['compositions/components/glow.html'] });
  });

  it('follows the paths in hyperframes.json', async () => {
    const dir = project();
    writeFileSync(join(dir, 'hyperframes.json'), JSON.stringify({ paths: { blocks: 'scenes', components: 'parts', assets: 'media' } }));
    const { source } = open();
    const result = await addHyperframes({ names: ['card'], dir, source, overwrite: false });
    expect(result.added.flatMap((a) => a.written)).toEqual(['parts/glow.html', 'scenes/card.html', 'media/font.woff2', 'media/Font-OFL.txt']);
    expect(remapTarget('compositions/x.html', 'block', { blocks: 'b', components: 'c', assets: 'a' })).toBe('b/x.html');
  });

  it('stops before writing when a download fails', async () => {
    const dir = project();
    const files = served();
    files.delete(CDN);
    const { source } = open(files);
    await expect(addHyperframes({ names: ['card'], dir, source, overwrite: false })).rejects.toMatchObject({ code: 'NETWORK' });
    expect(existsSync(join(dir, 'compositions'))).toBe(false);
  });
});

describe('credits', () => {
  it('names each item with author, licence, licence files and source, and adds to an existing file', async () => {
    const dir = scratch();
    const { source } = open();
    await addHyperframes({ names: ['card'], dir, source, overwrite: false });
    const text = readFileSync(join(dir, 'HYPERFRAMES-CREDITS.md'), 'utf8');
    expect(text).toContain('HeyGen');
    expect(text).toContain('## card');
    expect(text).toContain('- Author: Jane Doe (https://example.com/jane)');
    expect(text).toContain('- Licence: Apache-2.0 AND OFL-1.1');
    expect(text).toContain('- Licence files: assets/Font-OFL.txt');
    expect(text).toContain(`- Source: https://github.com/heygen-com/hyperframes/tree/${HYPERFRAMES_PINNED_REF}/registry/blocks/card`);
    expect(text).toContain('## glow');
    expect(text).toContain('- Author: not given');
    expect(text).toContain('not given by the item (the HyperFrames repository is Apache-2.0)');
  });

  it('keeps earlier entries and replaces a repeated one', () => {
    const entry = (name: string, license: string): HyperframesAdded => ({ name, type: 'block', title: name, license, source: `https://x/${name}`, written: [], unchanged: [], licences: [] });
    const first = mergeCredits(undefined, [entry('a', 'MIT'), entry('b', 'ISC')]);
    const second = mergeCredits(first, [entry('b', 'Apache-2.0'), entry('c', 'MIT')]);
    expect(second.match(/^## /gm)).toHaveLength(3);
    expect(second).toContain('- Licence: MIT');
    expect(second).toContain('- Licence: Apache-2.0');
    expect(second).not.toContain('ISC');
  });
});

describe('the add command', () => {
  async function cli(...argv: string[]): Promise<{ code: number; json: any; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, { out: (s) => void out.push(s), err: (s) => void err.push(s) });
    let json: any;
    try {
      json = JSON.parse(out.join(''));
    } catch {
      json = undefined;
    }
    return { code, json, err: err.join('') };
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch(served()));
    process.env.KINETOGRAPH_HYPERFRAMES_CACHE = cacheDir;
  });
  afterEach(() => {
    delete process.env.KINETOGRAPH_HYPERFRAMES_CACHE;
  });

  it('installs hyperframes/<name> and hf/<name>', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'index.html'), '<div></div>');
    const a = await cli('add', 'hyperframes/glow', '--dir', dir, '--json');
    expect(a.json.added[0]).toMatchObject({ name: 'glow', written: ['compositions/components/glow.html'] });
    const b = await cli('add', 'hf/glow', '--dir', dir, '--json');
    expect(b.code).toBe(0);
    expect(b.json.added[0].unchanged).toEqual(['compositions/components/glow.html']);
    expect(existsSync(join(dir, 'HYPERFRAMES-CREDITS.md'))).toBe(true);
  });

  it('refuses to overwrite and says how', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'index.html'), '<div></div>');
    mkdirSync(join(dir, 'compositions/components'), { recursive: true });
    writeFileSync(join(dir, 'compositions/components/glow.html'), 'mine');
    const refused = await cli('add', 'hyperframes/glow', '--dir', dir, '--json');
    expect(refused.code).toBe(1);
    expect(refused.json.error).toMatchObject({ code: 'EXISTS' });
    expect((await cli('add', 'hyperframes/glow', '--dir', dir, '--overwrite', '--json')).code).toBe(0);
  });

  it('lists and searches', async () => {
    const all = await cli('add', 'hyperframes', '--list', '--json');
    expect(all.json.items.map((i: any) => i.name)).toEqual(['card', 'glow', 'loop-a', 'loop-b']);
    const found = await cli('add', 'hyperframes', '--search', 'effect', '--json');
    expect(found.json.items.map((i: any) => i.name)).toEqual(['glow']);
    const blocks = await cli('add', 'hyperframes', '--list', '--type', 'block', '--json');
    expect(blocks.json.items.map((i: any) => i.name)).toEqual(['card']);
  });

  it('does not mix with Kinetograph registry items', async () => {
    const r = await cli('add', 'hyperframes/glow', 'title-card', '--json');
    expect(r.json.error.code).toBe('INVALID_ARG');
    const ref = await cli('add', 'title-card', '--ref', 'main', '--json');
    expect(ref.json.error.code).toBe('INVALID_ARG');
  });
});

describe('hostile items', () => {
  const project = (): string => {
    const dir = scratch();
    writeFileSync(join(dir, 'index.html'), '<div></div>');
    return dir;
  };
  const withFiles = (files: object[], over: object = {}) => {
    const served_ = served();
    served_.set(`${BASE}/components/glow/registry-item.json`, JSON.stringify(item('glow', 'component', over, files)));
    return open(served_);
  };

  it.each([
    ['package.json'],
    ['.github/workflows/x.yml'],
    ['.git/hooks/pre-commit'],
    ['compositions/.hidden.html'],
    ['compositions/node_modules/x.js'],
    ['compositions/components/package.json'],
    ['other/x.html'],
    ['models/../package.json'],
    ['lib/.hidden.js'],
    ['SUB/TEMPLATE.md'],
    ['src/index.ts'],
    ['index.html'],
    ['hyperframes.json'],
    ['compositions/package.json.'],
    ['compositions/package.json '],
    ['compositions/PACKAGE.JSON'],
    ['compositions/page.html:stream'],
    ['compositions/NODE_M~1/x.js'],
    ['compositions/PACKAGE~1.JSO'],
    ['compositions/x.html.'],
    ['compositions/a b.html'],
    ['compositions/a\\b.html'],
    ['assets/ünï.png'],
    ['assets/_x.png'],
  ])('refuses the target %s, writing nothing', async (target) => {
    const dir = project();
    const { source } = withFiles([{ path: 'glow.html', target }]);
    await expect(addHyperframes({ names: ['glow'], dir, source, overwrite: true })).rejects.toMatchObject({ code: 'UNSAFE_TARGET' });
    expect(existsSync(join(dir, 'HYPERFRAMES-CREDITS.md'))).toBe(false);
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('<div></div>');
  });

  describe('files an item puts at the project root', () => {
    const serve = (name: string, kind: 'block' | 'component', files: object[], html: string) => {
      const files_ = served();
      const dir = kind === 'block' ? 'blocks' : 'components';
      files_.set(`${BASE}/${dir}/${name}/registry-item.json`, JSON.stringify(item(name, kind, {}, files)));
      files_.set(`${BASE}/${dir}/${name}/${name}.html`, html);
      files_.set(`${BASE}/${dir}/${name}/TEMPLATE.md`, 'notes');
      files_.set(`${BASE}/${dir}/${name}/models/m.glb`, new Uint8Array([9, 9]));
      files_.set(`${BASE}/${dir}/${name}/lib/l.js`, 'var l;');
      const manifest = JSON.parse(files_.get(`${BASE}/registry.json`) as string);
      manifest.items.push({ name, type: `hyperframes:${kind}` });
      files_.set(`${BASE}/registry.json`, JSON.stringify(manifest));
      return open(files_).source;
    };
    const rooted = (name: string, kind: 'block' | 'component') => [
      { path: `${name}.html`, target: kind === 'block' ? `compositions/${name}.html` : `compositions/components/${name}.html` },
      { path: 'TEMPLATE.md', target: 'TEMPLATE.md' },
      { path: 'models/m.glb', target: 'models/m.glb' },
      { path: 'lib/l.js', target: 'lib/l.js' },
    ];
    const html = '<script src="lib/l.js"></script><script>loader.load("models/m.glb"); x = \'./models/m.glb\'; y = "other/models/m.glb"; z = "xmodels/m.glb";</script>';

    it('puts TEMPLATE.md in a folder named for the item, models under the assets folder, and lib beside the compositions', async () => {
      const dir = project();
      const source = serve('rooted-block', 'block', rooted('rooted-block', 'block'), html);
      const result = await addHyperframes({ names: ['rooted-block'], dir, source, overwrite: false });
      expect(result.added[0]!.written).toEqual(['compositions/rooted-block.html', 'compositions/rooted-block/TEMPLATE.md', 'assets/models/m.glb', 'compositions/lib/l.js']);
      expect(readFileSync(join(dir, 'compositions/rooted-block/TEMPLATE.md'), 'utf8')).toBe('notes');
      expect([...readFileSync(join(dir, 'assets/models/m.glb'))]).toEqual([9, 9]);
    });

    it('rewrites the references in the item\'s own files to the new paths, and only those', async () => {
      const dir = project();
      const source = serve('rooted-block', 'block', rooted('rooted-block', 'block'), html);
      await addHyperframes({ names: ['rooted-block'], dir, source, overwrite: false });
      const text = readFileSync(join(dir, 'compositions/rooted-block.html'), 'utf8');
      expect(text).toContain('loader.load("assets/models/m.glb")');
      expect(text).toContain("'./assets/models/m.glb'");
      expect(text).toContain('src="lib/l.js"');
      expect(text).toContain('"other/models/m.glb"');
      expect(text).toContain('"xmodels/m.glb"');
    });

    it('follows hyperframes.json, and places a component under the components folder', async () => {
      const dir = project();
      writeFileSync(join(dir, 'hyperframes.json'), JSON.stringify({ paths: { components: 'parts', assets: 'media' } }));
      const source = serve('rooted-part', 'component', rooted('rooted-part', 'component'), html);
      const result = await addHyperframes({ names: ['rooted-part'], dir, source, overwrite: false });
      expect(result.added[0]!.written).toEqual(['parts/rooted-part.html', 'parts/rooted-part/TEMPLATE.md', 'media/models/m.glb', 'parts/lib/l.js']);
      expect(readFileSync(join(dir, 'parts/rooted-part.html'), 'utf8')).toContain('loader.load("media/models/m.glb")');
    });
  });

  it('refuses a hyperframes.json that moves a folder onto a sensitive place', async () => {
    for (const blocks of ['.git', 'node_modules/x', '.github/workflows', 'package.json']) {
      const dir = project();
      writeFileSync(join(dir, 'hyperframes.json'), JSON.stringify({ paths: { components: blocks } }));
      const { source } = open();
      await expect(addHyperframes({ names: ['glow'], dir, source, overwrite: true })).rejects.toMatchObject({ code: 'UNSAFE_TARGET' });
      expect(existsSync(join(dir, 'HYPERFRAMES-CREDITS.md'))).toBe(false);
    }
  });

  it('refuses an asset url on a host that is not the registry or its CDN, before any request to it', async () => {
    for (const url of ['https://169.254.169.254/latest/meta-data', 'https://evil.example/a.png', 'https://localhost:8080/a.png', 'https://static.heygen.ai.evil.example/a.png', 'https://user@evil.example/a.png']) {
      const { fetch, source } = withFiles([{ path: 'a.png', target: 'assets/a.png', url }]);
      await expect(source.item('glow')).rejects.toMatchObject({ code: 'UNSAFE_URL' });
      expect(fetch.calls.some((c) => c.startsWith(url))).toBe(false);
    }
    const { source } = withFiles([{ path: 'a.png', target: 'assets/a.png', url: 'https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry/x.png' }]);
    await expect(source.item('glow')).resolves.toBeTruthy();
  });

  it('checks the host again after every redirect, and sends nothing to the new one', async () => {
    const files = served();
    const calls: { url: string; headers: unknown }[] = [];
    const redirecting = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push({ url, headers: init?.headers });
      if (url === CDN) return new Response(null, { status: 302, headers: { location: 'https://evil.example/stolen' } });
      if (url.startsWith('https://evil.example')) return new Response('secret', { status: 200 });
      const body = files.get(url);
      return body === undefined ? new Response('no', { status: 404 }) : new Response(typeof body === 'string' ? body : Buffer.from(body));
    }) as typeof fetch;
    const source = openHyperframes({ fetch: redirecting, cacheDir });
    const card = await source.item('card');
    await expect(source.file(card, card.files[1]!)).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    expect(calls.map((c) => c.url)).not.toContain('https://evil.example/stolen');
    for (const call of calls) expect(JSON.stringify(call.headers ?? {})).not.toMatch(/authorization/i);
  });

  it('refuses to write the credits file through a symbolic link, writing nothing', async () => {
    const dir = project();
    const outside = join(scratch(), 'victim.txt');
    writeFileSync(outside, 'precious');
    symlinkSync(outside, join(dir, 'HYPERFRAMES-CREDITS.md'));
    const { source } = open();
    await expect(addHyperframes({ names: ['glow'], dir, source, overwrite: true })).rejects.toMatchObject({ code: 'UNSAFE_TARGET' });
    expect(readFileSync(outside, 'utf8')).toBe('precious');
    expect(existsSync(join(dir, 'compositions/components/glow.html'))).toBe(false);
  });

  it('strips terminal escapes from what an item says about itself, and refuses them in a name or type', async () => {
    const files = served();
    const esc = '\x1b]0;pwned\x07\x1b[2J\u009b31m';
    files.set(`${BASE}/components/glow/registry-item.json`, JSON.stringify(item('glow', 'component', { title: `Glow${esc}`, description: `Nice${esc}\nline`, author: `Eve${esc}`, license: `MIT${esc}`, tags: [`fx${esc}`], deprecated: `old${esc}` })));
    const { source } = open(files);
    const glow = await source.item('glow');
    for (const text of [glow.title, glow.description, glow.author, glow.license, glow.deprecated, ...(glow.tags ?? [])]) expect(text).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(glow.title).toContain('Glow');
    expect((await source.index()).find((i) => i.name === 'glow')!.description).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);

    files.set(`${BASE}/components/glow/registry-item.json`, JSON.stringify(item('glow', 'component', {}, undefined)).replace('"name":"glow"', '"name":"glow\\u001b[2J"'));
    await expect(open(files).source.item('glow')).rejects.toMatchObject({ code: 'INVALID_ITEM' });
    files.set(`${BASE}/components/glow/registry-item.json`, JSON.stringify(item('glow', 'component', {})).replace('hyperframes:component', 'hyperframes:component\\u001b[2J'));
    await expect(open(files).source.item('glow')).rejects.toMatchObject({ code: 'INVALID_ITEM' });
  });
});
