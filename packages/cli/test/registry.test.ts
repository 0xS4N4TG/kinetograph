import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { add } from '../src/commands/add.js';
import { run } from '../src/index.js';
import { addItems } from '../src/registry/install.js';
import { buildRegistry } from '../src/registry/build.js';
import { itemJsonSchema, registryItemSchema } from '../src/registry/item.js';
import { installCommand, spawnSpec } from '../src/registry/packages.js';
import { openRegistry } from '../src/registry/source.js';
import { toArgv } from '../src/mcp.js';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'kinetograph-registry-test-'));
const FIXTURE = join(import.meta.dirname, 'fixtures/registry-src');

async function cli(...argv: string[]): Promise<{ code: number; json: any; text: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (s) => void out.push(s), err: (s) => void err.push(s) });
  const text = out.join('');
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { code, json, text, err: err.join('') };
}

/** A project made by `kinetograph init`. */
async function project(): Promise<string> {
  const dir = join(scratch(), 'proj');
  expect((await cli('init', dir, '--json')).code).toBe(0);
  return dir;
}

const fileItem = (name: string, over: object = {}) => ({
  name,
  type: 'component',
  title: `Item ${name}`,
  description: 'A test item.',
  kinetograph: '0.1.0',
  files: [{ path: 'index.tsx', target: `src/components/${name}/index.tsx`, content: `export const ${name.replace(/-/g, '_')} = 1;\n` }],
  ...over,
});

/** A registry folder holding the given items as `<name>.json`. */
function registryOf(items: object[]): string {
  const dir = scratch();
  for (const item of items) writeFileSync(join(dir, `${(item as { name: string }).name}.json`), JSON.stringify(item));
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ items: items.map(({ name, type, title, description, access }: any) => ({ name, type, title, description, access })) }));
  return dir;
}

const tree = (dir: string): string[] => (readdirSync(dir, { recursive: true }) as string[]).map((f) => f.replaceAll('\\', '/')).sort();

let built: string;
beforeAll(() => {
  built = join(scratch(), 'r');
  buildRegistry(FIXTURE, built);
});

beforeEach(() => {
  process.env.KINETOGRAPH_REGISTRY = built;
});
afterEach(() => {
  delete process.env.KINETOGRAPH_REGISTRY;
});

describe('the registry builder', () => {
  it('turns the sample folder into items, an index, a schema and binary files', () => {
    expect(tree(built)).toEqual(['files', 'files/title-card', 'files/title-card/public', 'files/title-card/public/images', 'files/title-card/public/images/dot.png', 'index.json', 'schema.json', 'title-card.json']);
    const item = JSON.parse(readFileSync(join(built, 'title-card.json'), 'utf8'));
    expect(registryItemSchema.parse(item)).toBeTruthy();
    expect(item).toMatchObject({ name: 'title-card', type: 'component', access: 'free', kinetograph: '0.2.0', dependencies: { zod: '4.6.7' } });
    expect(item.files.map((f: any) => [f.path, f.target, 'content' in f ? 'content' : 'url'])).toEqual([
      ['index.tsx', 'src/components/title-card/index.tsx', 'content'],
      ['public/images/dot.png', 'public/images/title-card/dot.png', 'url'],
    ]);
    expect(item.files[1].url).toBe('files/title-card/public/images/dot.png');
    expect(item.files[1].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(readFileSync(join(built, 'index.json'), 'utf8')).items).toEqual([
      { name: 'title-card', type: 'component', title: 'Title card', description: expect.any(String), access: 'free' },
    ]);
  });

  it('builds the same bytes twice', () => {
    const again = join(scratch(), 'r');
    buildRegistry(FIXTURE, again);
    for (const file of ['title-card.json', 'index.json', 'schema.json']) expect(readFileSync(join(again, file))).toEqual(readFileSync(join(built, file)));
  });

  it('keeps docs/registry-item.schema.json equal to the schema in the code', () => {
    const committed = JSON.parse(readFileSync(join(import.meta.dirname, '../../../docs/registry-item.schema.json'), 'utf8'));
    expect(committed).toEqual(JSON.parse(JSON.stringify(itemJsonSchema())));
  });

  const author = (files: Record<string, string>, meta: object = {}): string => {
    const src = scratch();
    const dir = join(src, 'thing');
    mkdirSync(dir);
    writeFileSync(join(dir, 'item.json'), JSON.stringify({ name: 'thing', type: 'component', title: 'Thing', description: 'x', kinetograph: '0.1.0', ...meta }));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return src;
  };
  const GOOD = { 'index.tsx': "import { z } from 'zod';\nexport const thingSchema = z.object({});\nexport const Thing = () => null;\n" };

  it('refuses items that break the layout', () => {
    const out = join(scratch(), 'r');
    expect(() => buildRegistry(author(GOOD), out)).not.toThrow();
    expect(() => buildRegistry(author({ 'index.tsx': 'export const Thing = () => null;\n' }), out)).toThrow(/zod schema/);
    expect(() => buildRegistry(author({ 'other.tsx': 'x' }), out)).toThrow(/needs an index.tsx/);
    expect(() => buildRegistry(author({ ...GOOD, 'public/docs/a.txt': 'x' }), out)).toThrow(/assets go in public/);
    expect(() => buildRegistry(author(GOOD, { registryDependencies: ['missing'] }), out)).toThrow(/"missing", which is not in/);
    expect(() => buildRegistry(author(GOOD, { name: 'other' }), out)).toThrow(/folder and the name must match/);
    expect(() => buildRegistry(author({ 'index.tsx': 'export default 1' }, { type: 'template' }), out)).toThrow(/registerRoot/);
    expect(() => buildRegistry(author({ 'taste.json': '{}' }, { type: 'taste' }), out)).toThrow(/TASTE.md/);
  });
});

describe('kinetograph add', () => {
  it('installs the sample component into an init-ed project', async () => {
    const dir = await project();
    const r = await cli('add', 'title-card', '--dir', dir, '--json');
    expect(r.code).toBe(0);
    expect(r.json.added).toEqual([
      {
        name: 'title-card',
        type: 'component',
        title: 'Title card',
        written: ['src/components/title-card/index.tsx', 'public/images/title-card/dot.png'],
        skipped: [],
      },
    ]);
    expect(readFileSync(join(dir, 'src/components/title-card/index.tsx'), 'utf8')).toBe(readFileSync(join(FIXTURE, 'title-card/index.tsx'), 'utf8'));
    expect(readFileSync(join(dir, 'public/images/title-card/dot.png'))).toEqual(readFileSync(join(FIXTURE, 'title-card/public/images/dot.png')));
    expect(r.json.next[0]).toBe("title-card: import { titleCardSchema, TitleCard } from '../components/title-card';   // from a file in src/scenes/");
    const text = (await cli('add', 'title-card', '--dir', dir)).text;
    expect(text).toContain('skipped  src/components/title-card/index.tsx');
  });

  it('works from inside the project and from a folder below it', async () => {
    const dir = await project();
    const r = await cli('add', 'title-card', '--dir', join(dir, 'src/scenes'), '--json');
    expect(r.json.project.endsWith('proj')).toBe(true);
    expect(existsSync(join(dir, 'src/components/title-card/index.tsx'))).toBe(true);
  });

  it('installs registryDependencies first, each item once', async () => {
    const registry = registryOf([
      fileItem('top', { registryDependencies: ['middle', 'leaf'] }),
      fileItem('middle', { registryDependencies: ['leaf'] }),
      fileItem('leaf'),
    ]);
    process.env.KINETOGRAPH_REGISTRY = registry;
    const dir = await project();
    const r = await cli('add', 'top', 'leaf', '--dir', dir, '--json');
    expect(r.code).toBe(0);
    expect(r.json.added.map((a: any) => a.name)).toEqual(['leaf', 'middle', 'top']);
    expect(r.json.added.map((a: any) => a.written.length)).toEqual([1, 1, 1]);
    expect((await cli('add', 'leaf', 'middle', 'top', '--dir', await project(), '--json')).json.added.map((a: any) => a.name)).toEqual(['leaf', 'middle', 'top']);
  });

  it('refuses a loop of registryDependencies', async () => {
    process.env.KINETOGRAPH_REGISTRY = registryOf([fileItem('a', { registryDependencies: ['b'] }), fileItem('b', { registryDependencies: ['a'] })]);
    const dir = await project();
    const r = await cli('add', 'a', '--dir', dir, '--json');
    expect(r.code).toBe(1);
    expect(r.json.error.message).toContain('a -> b -> a');
    expect(existsSync(join(dir, 'src/components/a'))).toBe(false);
  });

  it('never overwrites a file unless --overwrite is given', async () => {
    const dir = await project();
    await cli('add', 'title-card', '--dir', dir, '--json');
    const file = join(dir, 'src/components/title-card/index.tsx');
    writeFileSync(file, '// mine\n');
    const kept = await cli('add', 'title-card', '--dir', dir, '--json');
    expect(kept.json.added[0].written).toEqual([]);
    expect(kept.json.added[0].skipped).toEqual(['src/components/title-card/index.tsx', 'public/images/title-card/dot.png']);
    expect(readFileSync(file, 'utf8')).toBe('// mine\n');
    const replaced = await cli('add', 'title-card', '--dir', dir, '--json', '--overwrite');
    expect(replaced.json.added[0].written).toHaveLength(2);
    expect(readFileSync(file, 'utf8')).toContain('titleCardSchema');
  });

  it('says a paid item is not published yet, and writes nothing', async () => {
    process.env.KINETOGRAPH_REGISTRY = registryOf([
      { name: 'pro-pack', type: 'template', title: 'Pro Pack', description: 'x', kinetograph: '0.1.0', access: 'paid', files: [] },
      fileItem('free-one', { registryDependencies: ['pro-pack'] }),
    ]);
    const dir = await project();
    const direct = await cli('add', 'pro-pack', '--dir', dir, '--json');
    expect(direct.code).toBe(1);
    expect(direct.json.error).toEqual({ code: 'NOT_PUBLISHED', message: 'Pro Pack is not published yet.' });
    const viaDependency = await cli('add', 'free-one', '--dir', dir, '--json');
    expect(viaDependency.json.error.message).toBe('Pro Pack is not published yet.');
    expect(existsSync(join(dir, 'src/components/free-one'))).toBe(false);
    expect((await cli('add', 'pro-pack', '--dir', dir)).err).toBe('error: Pro Pack is not published yet.\n');
  });

  it('lists the index, by type if asked', async () => {
    process.env.KINETOGRAPH_REGISTRY = registryOf([
      fileItem('a-comp'),
      fileItem('a-template', { type: 'template', title: 'A template' }),
      { ...fileItem('a-taste', { type: 'taste' }), access: 'paid' },
    ]);
    const all = await cli('add', '--list', '--json');
    expect(all.json.items.map((i: any) => i.name)).toEqual(['a-comp', 'a-template', 'a-taste']);
    const templates = await cli('add', '--list', '--type', 'template', '--json');
    expect(templates.json.items.map((i: any) => i.name)).toEqual(['a-template']);
    expect((await cli('add', '--list')).text).toMatch(/^a-taste {5}taste {6}Item a-taste {2}\(not published yet\)$/m);
    expect((await cli('add', '--list', '--type', 'nope', '--json')).json.error.code).toBe('INVALID_ARG');
  });

  it('needs an item name, and a valid one', async () => {
    expect((await cli('add', '--json')).json.error.code).toBe('INVALID_ARG');
    const bad = await cli('add', '../x', '--json');
    expect(bad.json.error.code).toBe('INVALID_ARG');
    expect((await cli('add', 'no-such-item', '--dir', await project(), '--json')).json.error.code).toBe('NOT_FOUND');
  });

  it('says to run init outside a project', async () => {
    const r = await cli('add', 'title-card', '--dir', scratch(), '--json');
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('NOT_A_PROJECT');
    expect(r.json.error.message).toContain('npx kinetograph init');
  });

  it('is a tool over MCP with the names as a list', () => {
    expect(toArgv(add, { name: ['a', 'b'], yes: true })).toEqual(['add', 'a', 'b', '--yes', '--json']);
  });

  it('refuses an item that needs a newer CLI', async () => {
    process.env.KINETOGRAPH_REGISTRY = registryOf([fileItem('future', { kinetograph: '99.0.0' })]);
    const r = await cli('add', 'future', '--dir', await project(), '--json');
    expect(r.json.error.code).toBe('CLI_TOO_OLD');
  });
});

describe('npm dependencies', () => {
  const withDeps = (): string => registryOf([fileItem('needs-zod', { dependencies: { zod: '4.6.7', react: '^19.0.0' } })]);

  it('only prints the command with --json and no --yes', async () => {
    process.env.KINETOGRAPH_REGISTRY = withDeps();
    const dir = await project();
    const r = await cli('add', 'needs-zod', '--dir', dir, '--json');
    expect(r.code).toBe(0);
    expect(r.json.dependencies).toEqual({ missing: { zod: '4.6.7', react: '^19.0.0' }, manager: 'npm', command: 'npm install zod@4.6.7 react@^19.0.0', status: 'not-run' });
    expect(existsSync(join(dir, 'node_modules'))).toBe(false);
    const text = (await cli('add', 'needs-zod', '--dir', dir, '--overwrite')).text;
    expect(text).toContain('not installed (pass --yes to install them); run: npm install zod@4.6.7 react@^19.0.0');
  });

  const options = (dir: string, over: object) => ({ names: ['needs-zod'], dir, registry: openRegistry({ spec: withDeps() }), overwrite: false, yes: false, ...over });

  it('asks first, and runs the project\'s package manager only on a yes', async () => {
    const dir = await project();
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    const asked: string[] = [];
    const ran: unknown[] = [];
    const no = await addItems(options(dir, { confirm: async (q: string) => (asked.push(q), false), runInstall: async (c: unknown) => void ran.push(c) }));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('pnpm add zod@4.6.7 react@^19.0.0');
    expect(no.dependencies.status).toBe('declined');
    expect(ran).toEqual([]);
    const yes = await addItems(options(dir, { overwrite: true, confirm: async () => true, runInstall: async (c: unknown) => void ran.push(c) }));
    expect(yes.dependencies.status).toBe('installed');
    expect(ran).toEqual([{ command: 'pnpm', args: ['add', 'zod@4.6.7', 'react@^19.0.0'] }]);
  });

  it('--yes installs without asking; a failed install is reported', async () => {
    const dir = await project();
    const ran: unknown[] = [];
    const ok = await addItems(options(dir, { yes: true, runInstall: async (c: unknown) => void ran.push(c) }));
    expect(ok.dependencies.status).toBe('installed');
    expect(ran).toEqual([{ command: 'npm', args: ['install', 'zod@4.6.7', 'react@^19.0.0'] }]);
    const bad = await addItems(options(dir, { yes: true, overwrite: true, runInstall: async () => Promise.reject(new Error('npm exited with code 1')) }));
    expect(bad.dependencies).toMatchObject({ status: 'failed', error: 'npm exited with code 1' });
  });

  it('leaves out packages the project already lists', async () => {
    const dir = await project();
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    manifest.dependencies.zod = '^4.0.0';
    manifest.devDependencies.react = '19.0.0';
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    const r = await addItems(options(dir, {}));
    expect(r.dependencies).toMatchObject({ missing: {}, status: 'none' });
    expect(r.dependencies.command).toBeUndefined();
  });
});

describe('starting the package manager', () => {
  const install = (manager: 'npm' | 'pnpm' | 'yarn' | 'bun', packages: Record<string, string> = { zod: '4.6.7', react: '>=19 <20' }) => installCommand(manager, packages);

  it('runs it directly, with the argument array, on macOS and Linux', () => {
    expect(spawnSpec(install('pnpm'), 'darwin')).toEqual({ command: 'pnpm', args: ['add', 'zod@4.6.7', 'react@>=19 <20'], shell: false });
    expect(spawnSpec(install('npm'), 'linux')).toMatchObject({ command: 'npm', shell: false });
  });

  it('uses bun.exe, and the .cmd shims of npm, pnpm and yarn, on Windows', () => {
    expect(spawnSpec(install('bun'), 'win32')).toEqual({ command: 'bun.exe', args: ['add', 'zod@4.6.7', 'react@>=19 <20'], shell: false });
    for (const manager of ['npm', 'pnpm', 'yarn'] as const) {
      const spec = spawnSpec(install(manager), 'win32');
      expect(spec.command).toBe(`${manager}.cmd`);
      // Node will not start a .cmd without a shell; every argument is quoted, so a range's < > | mean nothing to it.
      expect(spec).toMatchObject({ shell: true });
      expect(spec.args.at(-1)).toBe('"react@>=19 <20"');
    }
  });

  it('refuses an argument with a shell metacharacter on Windows', () => {
    for (const bad of ['1" & calc & "', '1.0.0%PATH%', '1;rm', '$(x)', '1\n2', '!x']) {
      expect(() => spawnSpec(install('npm', { zod: bad }), 'win32'), bad).toThrow(/not installing/);
    }
  });
});

describe('what a registry may not do', () => {
  const unsafeTargets = ['../evil.txt', 'src/../../evil.txt', '/etc/evil.txt', 'C:/evil.txt', 'src\\..\\evil.txt', 'package.json', 'node_modules/x/index.js', '.git/hooks/pre-commit', 'src', 'out/evil.txt', 'src//x.ts', './src/x.ts'];

  it.each(unsafeTargets)('rejects the target %s and writes nothing', async (target) => {
    process.env.KINETOGRAPH_REGISTRY = registryOf([
      fileItem('sneaky', {
        files: [
          { path: 'index.tsx', target: 'src/components/sneaky/index.tsx', content: 'ok' },
          { path: 'x', target, content: 'evil' },
        ],
      }),
    ]);
    const dir = await project();
    const before = tree(dir);
    const r = await cli('add', 'sneaky', '--dir', dir, '--json');
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('UNSAFE_TARGET');
    expect(tree(dir)).toEqual(before);
    expect(existsSync(join(dir, '..', 'evil.txt'))).toBe(false);
  });

  it('rejects a path inside the item that leaves it', async () => {
    process.env.KINETOGRAPH_REGISTRY = registryOf([fileItem('sneaky', { files: [{ path: '../x', target: 'src/components/sneaky/x.ts', content: 'x' }] })]);
    const r = await cli('add', 'sneaky', '--dir', await project(), '--json');
    expect(r.json.error.code).toBe('UNSAFE_TARGET');
  });

  it('rejects two files with one target', async () => {
    const files = [
      { path: 'a.ts', target: 'src/components/dup/a.ts', content: '1' },
      { path: 'b.ts', target: 'src/components/dup/a.ts', content: '2' },
    ];
    process.env.KINETOGRAPH_REGISTRY = registryOf([fileItem('dup', { files })]);
    expect((await cli('add', 'dup', '--dir', await project(), '--json')).json.error.message).toContain('two files install to');
  });

  it('does not write through a symbolic link in the project', async () => {
    const dir = await project();
    const elsewhere = scratch();
    rmSync(join(dir, 'src/components'), { recursive: true });
    symlinkSync(elsewhere, join(dir, 'src/components'));
    const r = await cli('add', 'title-card', '--dir', dir, '--json');
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('UNSAFE_TARGET');
    expect(r.json.error.message).toContain('symbolic link');
    expect(readdirSync(elsewhere)).toEqual([]);

    // A link as the file itself is refused too, even with --overwrite.
    const dir2 = await project();
    const victim = join(scratch(), 'victim.txt');
    writeFileSync(victim, 'keep');
    mkdirSync(join(dir2, 'src/components/title-card'), { recursive: true });
    symlinkSync(victim, join(dir2, 'src/components/title-card/index.tsx'));
    expect((await cli('add', 'title-card', '--dir', dir2, '--json', '--overwrite')).json.error.code).toBe('UNSAFE_TARGET');
    expect(readFileSync(victim, 'utf8')).toBe('keep');
  });

  it('does not read files outside a registry folder', async () => {
    const registry = registryOf([]);
    const secret = join(scratch(), 'secret.txt');
    writeFileSync(secret, 'secret');
    symlinkSync(secret, join(registry, 'linked.bin'));
    const asset = (url: string) => ({ path: 'a.bin', target: 'public/images/leak/a.bin', url });
    for (const [url, code] of [['../secret.txt', 'UNSAFE_PATH'], [secret, 'UNSAFE_PATH'], ['linked.bin', 'UNSAFE_PATH'], ['http://example.com/a.bin', 'INSECURE_URL'], ['https://example.com/a.bin', 'UNSAFE_URL'], ['//example.com/a.bin', 'UNSAFE_URL'], ['file:///etc/passwd', 'INSECURE_URL']] as const) {
      writeFileSync(join(registry, 'leak.json'), JSON.stringify(fileItem('leak', { files: [asset(url)] })));
      process.env.KINETOGRAPH_REGISTRY = registry;
      const dir = await project();
      const r = await cli('add', 'leak', '--dir', dir, '--json');
      expect(r.json.error.code, url).toBe(code);
      expect(existsSync(join(dir, 'public/images/leak'))).toBe(false);
    }
  });

  it('checks a download against its sha256', async () => {
    const registry = registryOf([]);
    writeFileSync(join(registry, 'a.bin'), 'abc');
    writeFileSync(join(registry, 'sum.json'), JSON.stringify(fileItem('sum', { files: [{ path: 'a.bin', target: 'public/images/sum/a.bin', url: 'a.bin', sha256: '0'.repeat(64) }] })));
    process.env.KINETOGRAPH_REGISTRY = registry;
    const dir = await project();
    expect((await cli('add', 'sum', '--dir', dir, '--json')).json.error.code).toBe('CHECKSUM');
    expect(existsSync(join(dir, 'public/images/sum'))).toBe(false);
  });
});

describe('over https', () => {
  const answer = (routes: Record<string, { body?: string | Uint8Array; status?: number; headers?: Record<string, string> }>) => {
    const seen: string[] = [];
    const fetch = (async (url: URL | string) => {
      const key = String(url);
      seen.push(key);
      const route = routes[key];
      if (!route) return new Response('missing', { status: 404 });
      return new Response((route.body ?? '') as BodyInit, { status: route.status ?? 200, headers: route.headers });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, seen };
  };

  it('refuses a registry or a file that is not https', async () => {
    process.env.KINETOGRAPH_REGISTRY = 'http://example.com/r';
    const r = await cli('add', 'title-card', '--json');
    expect(r.json.error.code).toBe('INSECURE_URL');
    expect(() => openRegistry({ spec: 'ftp://example.com/r' })).toThrow(/https URL or a folder/);

    const { fetch, seen } = answer({
      'https://example.test/r/plain.json': { body: JSON.stringify(fileItem('plain', { files: [{ path: 'a.bin', target: 'public/images/plain/a.bin', url: 'http://example.test/a.bin' }] })) },
    });
    const dir = await project();
    await expect(addItems({ names: ['plain'], dir, registry: openRegistry({ spec: 'https://example.test/r', fetch }), overwrite: false, yes: false })).rejects.toMatchObject({ code: 'INSECURE_URL' });
    expect(seen).toEqual(['https://example.test/r/plain.json']);
  });

  it('refuses a file url on another origin: host, port or scheme', async () => {
    for (const url of ['https://cdn.example.test/a.bin', 'https://example.test:8443/a.bin', '//evil.test/a.bin', 'https://example.test.evil.test/a.bin', 'https://user@evil.test/a.bin']) {
      const { fetch, seen } = answer({
        'https://example.test/r/other.json': { body: JSON.stringify(fileItem('other', { files: [{ path: 'a.bin', target: 'public/images/other/a.bin', url }] })) },
      });
      const dir = await project();
      await expect(addItems({ names: ['other'], dir, registry: openRegistry({ spec: 'https://example.test/r', fetch }), overwrite: false, yes: false }), url).rejects.toMatchObject({ code: 'UNSAFE_URL' });
      expect(seen, url).toEqual(['https://example.test/r/other.json']);
      expect(existsSync(join(dir, 'public/images/other'))).toBe(false);
    }
  });

  it('refuses a redirect to http', async () => {
    const { fetch } = answer({ 'https://example.test/r/hop.json': { status: 302, headers: { location: 'http://example.test/hop.json' } } });
    await expect(openRegistry({ spec: 'https://example.test/r', fetch }).readJson('hop')).rejects.toMatchObject({ code: 'INSECURE_URL' });
  });

  it('installs from an https registry, files relative to the item', async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const { fetch } = answer({
      'https://example.test/r/pic.json': {
        body: JSON.stringify(fileItem('pic', { files: [{ path: 'a.bin', target: 'public/images/pic/a.bin', url: 'files/pic/a.bin' }] })),
      },
      'https://example.test/r/files/pic/a.bin': { body: bytes },
    });
    const dir = await project();
    const r = await addItems({ names: ['pic'], dir, registry: openRegistry({ spec: 'https://example.test/r/', fetch }), overwrite: false, yes: false });
    expect(r.added[0]!.written).toEqual(['public/images/pic/a.bin']);
    expect(readFileSync(join(dir, 'public/images/pic/a.bin'))).toEqual(Buffer.from(bytes));
  });

  it('stops a download over the size limit', async () => {
    const { fetch } = answer({ 'https://example.test/r/big.json': { body: '{}', headers: { 'content-length': String(5 * 1024 * 1024) } } });
    await expect(openRegistry({ spec: 'https://example.test/r', fetch }).readJson('big')).rejects.toMatchObject({ code: 'TOO_LARGE' });
    const streamed = answer({ 'https://example.test/r/big2.json': { body: new Uint8Array(5 * 1024 * 1024) } });
    await expect(openRegistry({ spec: 'https://example.test/r', fetch: streamed.fetch }).readJson('big2')).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });
});
