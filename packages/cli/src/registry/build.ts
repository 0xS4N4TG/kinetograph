// Turns a folder of items in the authoring layout (docs/registry.md) into static registry files: `<name>.json` for
// each item, `index.json`, `schema.json`, and `files/<name>/…` for binary assets. The output is a pure function of
// the input folder, so the site can serve it as it is.

import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { CliError } from '../errors.js';
import {
  ASSET_KINDS,
  itemJsonSchema,
  itemProblem,
  registryItemSchema,
  TYPE_FOLDERS,
  type RegistryFile,
  type RegistryIndex,
  type RegistryItem,
} from './item.js';
import { sha256 } from './source.js';

const SCHEMA_URL = 'https://kinetograph.dev/r/schema.json';
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx', '.css', '.txt', '.svg', '.html', '.glsl', '.frag', '.vert']);

/** What an author writes in `<item>/item.json`: the item without `files`, which are the other files in the folder. */
const authorSchema = registryItemSchema.omit({ files: true, $schema: true });

export interface BuildResult {
  items: RegistryItem[];
  /** Files written, relative to the output folder. */
  written: string[];
}

function fail(item: string, message: string): never {
  throw new CliError('BUILD', `${item}: ${message}`);
}

/** Every file under `dir`, as sorted relative posix paths. Dot files are skipped, links are an error. */
function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith('.')) continue;
    const rel = `${prefix}${entry.name}`;
    if (lstatSync(join(dir, entry.name)).isSymbolicLink()) throw new CliError('BUILD', `${join(dir, entry.name)} is a symbolic link`);
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), `${rel}/`));
    else out.push(rel);
  }
  return out;
}

/** The project path an item file installs to (docs/registry.md "Layout"). */
function targetOf(name: string, folder: string, rel: string): string {
  if (!rel.startsWith('public/')) return `src/${folder}/${name}/${rel}`;
  const [, kind, ...rest] = rel.split('/');
  if (!(ASSET_KINDS as readonly string[]).includes(kind!) || rest.length === 0) {
    fail(name, `"${rel}": assets go in public/<${ASSET_KINDS.join('|')}>/<file>, got "${rel}"`);
  }
  return `public/${kind}/${name}/${rest.join('/')}`;
}

function buildItem(srcDir: string, name: string, outDir: string, written: string[]): RegistryItem {
  const dir = join(srcDir, name);
  let meta: unknown;
  try {
    meta = JSON.parse(readFileSync(join(dir, 'item.json'), 'utf8'));
  } catch (error) {
    fail(name, `item.json is missing or not valid JSON (${(error as Error).message})`);
  }
  const parsed = authorSchema.safeParse(meta);
  if (!parsed.success) fail(name, `item.json: ${parsed.error.issues[0]!.path.join('.') || 'the file'}: ${parsed.error.issues[0]!.message}`);
  const author = parsed.data;
  if (author.name !== name) fail(name, `item.json names it "${author.name}"; the folder and the name must match`);
  const folder = TYPE_FOLDERS[author.type];

  const files: RegistryFile[] = [];
  for (const rel of walk(dir).filter((f) => f !== 'item.json')) {
    const bytes = readFileSync(join(dir, rel));
    const base = { path: rel, target: targetOf(name, folder, rel) };
    if (TEXT_EXTENSIONS.has(extname(rel).toLowerCase())) {
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes)) fail(name, `"${rel}" is not valid UTF-8 text`);
      files.push({ ...base, content: text });
    } else {
      const url = `files/${name}/${rel}`;
      mkdirSync(dirname(join(outDir, url)), { recursive: true });
      copyFileSync(join(dir, rel), join(outDir, url));
      written.push(url);
      files.push({ ...base, url, sha256: sha256(bytes) });
    }
  }
  checkShape(name, author.type, files);

  const item: RegistryItem = {
    $schema: SCHEMA_URL,
    name,
    type: author.type,
    title: author.title,
    description: author.description,
    kinetograph: author.kinetograph,
    access: author.access ?? 'free',
    ...(author.dependencies ? { dependencies: author.dependencies } : {}),
    ...(author.registryDependencies ? { registryDependencies: author.registryDependencies } : {}),
    ...(author.props ? { props: author.props } : {}),
    files,
  };
  const problem = itemProblem(item);
  if (problem !== undefined) fail(name, problem);
  return registryItemSchema.parse(item);
}

/** The layout rules of each type that a folder of files can break. */
function checkShape(name: string, type: RegistryItem['type'], files: RegistryFile[]): void {
  if (files.length === 0) fail(name, 'has no files');
  const text = (path: string): string | undefined => {
    const file = files.find((f) => f.path === path);
    return file && 'content' in file ? file.content : undefined;
  };
  if (type === 'component') {
    const entry = text('index.tsx') ?? text('index.ts');
    if (entry === undefined) fail(name, 'a component needs an index.tsx that exports the component and its zod schema');
    if (!/^export\s+(?:const|function)\s+\w*Schema\b/m.test(entry) && !/^export\s*\{[^}]*Schema\b/m.test(entry)) {
      fail(name, 'index.tsx must export the zod schema of its props (a name ending in "Schema")');
    }
  } else if (type === 'template') {
    const entry = text('index.tsx');
    if (entry === undefined || !entry.includes('registerRoot')) fail(name, 'a template needs an index.tsx that calls registerRoot');
    if (!files.some((f) => f.path.startsWith('scenes/'))) fail(name, 'a template keeps its scenes in scenes/');
  } else if (text('TASTE.md') === undefined) {
    fail(name, 'a taste needs a TASTE.md');
  }
}

/** Builds every item folder in `srcDir` into `outDir`. */
export function buildRegistry(srcDir: string, outDir: string): BuildResult {
  const names = readdirSync(srcDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
  if (names.length === 0) throw new CliError('BUILD', `no item folders in ${srcDir}`);
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  const items = names.map((name) => buildItem(srcDir, name, outDir, written));

  const known = new Set(items.map((i) => i.name));
  for (const item of items) {
    for (const dependency of item.registryDependencies ?? []) {
      if (!known.has(dependency)) fail(item.name, `registryDependencies names "${dependency}", which is not in ${srcDir}`);
    }
  }
  // A loop among registryDependencies would never finish installing.
  const state = new Map<string, 'open' | 'done'>();
  const visit = (name: string, stack: string[]): void => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'open') fail(name, `registryDependencies loop: ${[...stack, name].join(' -> ')}`);
    state.set(name, 'open');
    for (const dependency of items.find((i) => i.name === name)!.registryDependencies ?? []) visit(dependency, [...stack, name]);
    state.set(name, 'done');
  };
  for (const item of items) visit(item.name, []);

  const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  const put = (file: string, text: string): void => {
    writeFileSync(join(outDir, file), text);
    written.push(file);
  };
  for (const item of items) put(`${item.name}.json`, json(item));
  const index: RegistryIndex = {
    $schema: SCHEMA_URL,
    items: items.map(({ name, type, title, description, access }) => ({ name, type, title, description, access })),
  };
  put('index.json', json(index));
  put('schema.json', json(itemJsonSchema()));
  return { items, written: written.sort() };
}
