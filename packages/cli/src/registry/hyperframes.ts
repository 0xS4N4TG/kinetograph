// `kinetograph add hyperframes/<name>`: install a block or component from the HyperFrames community registry
// (github.com/heygen-com/hyperframes, `registry/`, Apache-2.0). Their registry is a folder of JSON and files read over
// https; this reads the same layout and lays the files out the way `hyperframes add` does for an HTML project. Items
// stay in their source: nothing is bundled here, everything is fetched when asked for and treated as data.

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { CliError } from '../errors.js';
import { isItemName, pathProblem } from './item.js';
import { download, MAX_FILE_BYTES, MAX_JSON_BYTES } from './source.js';

export const HYPERFRAMES_REPO = 'heygen-com/hyperframes';
/**
 * The registry commit installs read by default (the tip of `main` when this was written), so the same command gives the
 * same files next month. `--ref <commit|branch|tag>` or `KINETOGRAPH_HYPERFRAMES_REF` reads another; `--ref main` is
 * the latest.
 */
export const HYPERFRAMES_PINNED_REF = '75fe18c621be5297d7b09a788fabc75a3cd6c734';
export const HYPERFRAMES_CREDITS_FILE = 'HYPERFRAMES-CREDITS.md';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 60;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DOWNLOADS_AT_ONCE = 8;

/** The folder of each installable type under `registry/` (their `ITEM_TYPE_DIRS`; examples are whole projects, not added). */
export const HYPERFRAMES_TYPES = { block: 'blocks', component: 'components' } as const;
export type HyperframesType = keyof typeof HYPERFRAMES_TYPES;

/** The hosts a HyperFrames item's files may be fetched from: the registry's raw GitHub host and HeyGen's asset CDN. */
export const HYPERFRAMES_HOSTS = ['raw.githubusercontent.com', 'static.heygen.ai'] as const;

const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
/** Text that is printed or written to a credits file: control characters (terminal escapes, newlines) become spaces. */
const text = z.string().transform((value) => value.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim());
/** An id that is printed as it is: control characters are refused, not changed. */
const id = z.string().refine((value) => !CONTROL.test(value), 'has a control character');

const fileSchema = z.object({
  path: z.string(),
  target: z.string(),
  type: z.string().optional(),
  url: z.string().optional(),
});

const itemSchema = z.object({
  name: id,
  type: id,
  title: text.default(''),
  description: text.default(''),
  tags: z.array(text).optional(),
  author: text.optional(),
  authorUrl: text.optional(),
  license: text.optional(),
  deprecated: text.optional(),
  registryDependencies: z.array(z.string()).optional(),
  dimensions: z.object({ width: z.number(), height: z.number() }).optional(),
  duration: z.number().optional(),
  files: z.array(fileSchema).max(500),
});
export type HyperframesItem = z.infer<typeof itemSchema> & { kind: HyperframesType };

const manifestSchema = z.object({
  items: z.array(z.object({ name: id, type: id })),
});

export interface HyperframesListing {
  name: string;
  type: HyperframesType;
  title: string;
  description: string;
  tags: string[];
}

export interface HyperframesSource {
  readonly ref: string;
  /** `https://raw.githubusercontent.com/<repo>/<ref>/registry`. */
  readonly base: string;
  /** Block and component names with their type, from `registry.json` (cached for a day). */
  manifest(): Promise<{ name: string; type: HyperframesType }[]>;
  /** One item's `registry-item.json`, checked. */
  item(name: string): Promise<HyperframesItem>;
  /** The bytes of one of an item's files: beside the item, or at its https `url`. */
  file(item: HyperframesItem, file: HyperframesItem['files'][number]): Promise<Uint8Array>;
  /** Every item with its title and description (fetches them all once, then a day's cache). */
  index(progress?: (message: string) => void): Promise<HyperframesListing[]>;
  /** Where the item lives, for credits. */
  sourceUrl(item: HyperframesItem): string;
}

export interface HyperframesOptions {
  ref?: string;
  fetch?: typeof fetch;
  cacheDir?: string;
  /** For tests. */
  now?: () => number;
}

const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

export function hyperframesRef(ref?: string): string {
  const chosen = ref ?? process.env.KINETOGRAPH_HYPERFRAMES_REF ?? '';
  const value = chosen === '' ? HYPERFRAMES_PINNED_REF : chosen;
  if (!REF_PATTERN.test(value) || value.includes('..')) throw new CliError('INVALID_ARG', `"${value}" is not a commit, branch or tag name`);
  return value;
}

/** The URL of a file hosted off the registry: https, on an allowed host, no credentials in it and no port. */
function checkFileUrl(name: string, path: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError('INVALID_ITEM', `${name}/${path}: "${short(value)}" is not a URL`);
  }
  if (url.protocol !== 'https:') throw new CliError('INSECURE_URL', `${name}/${path}: ${short(value)} is not an https URL`);
  if (url.username !== '' || url.password !== '' || url.port !== '' || !(HYPERFRAMES_HOSTS as readonly string[]).includes(url.hostname)) {
    throw new CliError('UNSAFE_URL', `${name}/${path}: ${short(value)} is not on an allowed host (${HYPERFRAMES_HOSTS.join(', ')})`);
  }
  return url;
}

const short = (value: string): string => value.replace(/[^\x20-\x7e]/g, '?').slice(0, 120);

const segments = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

function parseJson(bytes: Uint8Array, from: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new CliError('REGISTRY_ERROR', `${from} is not valid JSON`);
  }
}

export function openHyperframes(options: HyperframesOptions = {}): HyperframesSource {
  const ref = hyperframesRef(options.ref);
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cacheDir = options.cacheDir ?? process.env.KINETOGRAPH_HYPERFRAMES_CACHE ?? join(homedir(), '.cache', 'kinetograph', 'hyperframes-registry');
  const base = `https://raw.githubusercontent.com/${HYPERFRAMES_REPO}/${segments(ref)}/registry`;
  const cacheName = (key: string): string => join(cacheDir, `${ref.replace(/[^A-Za-z0-9._-]/g, '_')}-${key}.json`);

  /** A JSON value cached for a day; a stale copy is used when the network fails. */
  async function cached<T>(key: string, make: () => Promise<T>): Promise<T> {
    const file = cacheName(key);
    let stale: T | undefined;
    try {
      const entry = JSON.parse(readFileSync(file, 'utf8')) as { fetchedAt?: unknown; data?: T };
      if (typeof entry.fetchedAt === 'number' && entry.data !== undefined) {
        if (now() - entry.fetchedAt <= CACHE_TTL_MS) return entry.data;
        stale = entry.data;
      }
    } catch {
      // no cache, or an unreadable one: ask the network
    }
    try {
      const data = await make();
      try {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(file, JSON.stringify({ fetchedAt: now(), data }));
      } catch {
        // a cache that cannot be written is only a missed saving
      }
      return data;
    } catch (error) {
      if (stale !== undefined) return stale;
      throw error;
    }
  }

  const get = (path: string, limit: number, notFound?: string): Promise<Uint8Array> => download(new URL(`${base}/${path}`), limit, fetchImpl, notFound, HYPERFRAMES_HOSTS);

  const source: HyperframesSource = {
    ref,
    base,
    manifest: () =>
      cached('manifest', async () => {
        const parsed = manifestSchema.safeParse(parseJson(await get('registry.json', MAX_JSON_BYTES), 'registry.json'));
        if (!parsed.success) throw new CliError('REGISTRY_ERROR', 'registry.json is not a HyperFrames registry index');
        const out: { name: string; type: HyperframesType }[] = [];
        for (const entry of parsed.data.items) {
          const type = entry.type.replace(/^hyperframes:/, '');
          if ((type === 'block' || type === 'component') && isItemName(entry.name)) out.push({ name: entry.name, type });
        }
        return out;
      }),
    async item(name) {
      if (!isItemName(name)) throw new CliError('INVALID_ARG', `"${name}" is not an item name (lowercase letters, digits and hyphens)`);
      const entry = (await source.manifest()).find((e) => e.name === name);
      if (entry === undefined) throw new CliError('NOT_FOUND', `no block or component named "${name}" in the HyperFrames registry (\`add hyperframes --search ${name}\` looks for it)`);
      const path = `${HYPERFRAMES_TYPES[entry.type]}/${name}/registry-item.json`;
      const parsed = itemSchema.safeParse(parseJson(await get(path, MAX_JSON_BYTES, `${path} is not in the registry`), path));
      if (!parsed.success) throw new CliError('INVALID_ITEM', `${name} is not a valid HyperFrames item: ${parsed.error.issues[0]!.path.join('.') || 'the file'}: ${parsed.error.issues[0]!.message}`);
      if (parsed.data.name !== name) throw new CliError('INVALID_ITEM', `${path} describes an item named "${parsed.data.name}"`);
      const item: HyperframesItem = { ...parsed.data, kind: entry.type };
      for (const file of item.files) {
        const problem = pathProblem(file.path) ?? pathProblem(file.target);
        if (problem !== undefined) throw new CliError('UNSAFE_TARGET', `${name}: "${file.path}" -> "${file.target}" ${problem}`);
        if (file.url !== undefined) checkFileUrl(name, file.path, file.url);
      }
      return item;
    },
    async file(item, file) {
      if (file.url !== undefined) return download(checkFileUrl(item.name, file.path, file.url), MAX_FILE_BYTES, fetchImpl, undefined, HYPERFRAMES_HOSTS);
      return get(`${HYPERFRAMES_TYPES[item.kind]}/${item.name}/${segments(file.path)}`, MAX_FILE_BYTES, `${item.name}/${file.path} is not in the registry`);
    },
    index: (progress) =>
      cached('index', async () => {
        const entries = await source.manifest();
        const out: HyperframesListing[] = [];
        let next = 0;
        const worker = async (): Promise<void> => {
          for (;;) {
            const entry = entries[next++];
            if (entry === undefined) return;
            const item = await source.item(entry.name);
            out.push({ name: item.name, type: entry.type, title: item.title, description: item.description, tags: item.tags ?? [] });
            if (out.length % 50 === 0) progress?.(`read ${out.length} of ${entries.length} items`);
          }
        };
        await Promise.all(Array.from({ length: 12 }, worker));
        return out.sort((a, b) => a.name.localeCompare(b.name));
      }),
    sourceUrl: (item) => `https://github.com/${HYPERFRAMES_REPO}/tree/${segments(ref)}/registry/${HYPERFRAMES_TYPES[item.kind]}/${item.name}`,
  };
  return source;
}

/** `hyperframes/<name>` or `hf/<name>` gives the name; anything else gives undefined. `hyperframes` and `hf` alone give ''. */
export function hyperframesName(arg: string): string | undefined {
  const m = /^(?:hyperframes|hf)(?:\/(.*))?$/.exec(arg);
  return m === null ? undefined : (m[1] ?? '');
}

/** The listing, filtered by type and by every word of `search` (against name, title, description and tags). */
export function filterListing(items: HyperframesListing[], type?: string, search?: string): HyperframesListing[] {
  const words = (search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (type !== undefined && item.type !== type) return false;
    const text = `${item.name} ${item.title} ${item.description} ${item.tags.join(' ')}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function describeListing(items: HyperframesListing[]): string {
  if (items.length === 0) return 'no items';
  const width = Math.max(...items.map((i) => i.name.length));
  return items.map((i) => `${i.name.padEnd(width)}  ${i.type.padEnd(9)}  ${i.description || i.title}`).join('\n');
}

/** The requested items and their `registryDependencies`, each once, dependencies first; a loop is refused. */
export async function resolveHyperframes(source: Pick<HyperframesSource, 'item'>, names: string[]): Promise<HyperframesItem[]> {
  const done = new Set<string>();
  const order: HyperframesItem[] = [];
  const stack: string[] = [];
  const visit = async (name: string): Promise<void> => {
    if (done.has(name)) return;
    if (stack.includes(name)) throw new CliError('INVALID_ITEM', `registryDependencies loop: ${[...stack.slice(stack.indexOf(name)), name].join(' -> ')}`);
    if (done.size >= MAX_ITEMS) throw new CliError('INVALID_ITEM', `more than ${MAX_ITEMS} items to install`);
    stack.push(name);
    const item = await source.item(name);
    for (const dependency of item.registryDependencies ?? []) await visit(dependency);
    stack.pop();
    done.add(name);
    order.push(item);
  };
  for (const name of names) await visit(name);
  return order;
}

/**
 * The folder of the HTML project to install into: the nearest folder at or above `dir` with a `hyperframes.json` or an
 * `index.html`; else, in a package.json project, its `html/` folder (what `init --html` makes); else `dir`.
 */
export function findHyperframesProject(dir: string): string {
  const start = resolve(dir);
  for (let current = start; ; current = dirname(current)) {
    if (existsSync(join(current, 'hyperframes.json')) || existsSync(join(current, 'index.html'))) return current;
    if (existsSync(join(current, 'package.json'))) return existsSync(join(current, 'html')) ? join(current, 'html') : start;
    if (dirname(current) === current) return start;
  }
}

/** `paths` from the project's `hyperframes.json` (`blocks`, `components`, `assets`), where a prefix is moved. */
function projectPaths(root: string): { blocks: string; components: string; assets: string } {
  const paths = { blocks: 'compositions', components: 'compositions/components', assets: 'assets' };
  const file = join(root, 'hyperframes.json');
  if (!existsSync(file)) return paths;
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new CliError('INVALID_ARG', `${file} is not valid JSON`);
  }
  const given = (config as { paths?: Record<string, unknown> } | null)?.paths;
  for (const key of ['blocks', 'components', 'assets'] as const) {
    const value = given?.[key];
    if (typeof value !== 'string') continue;
    const problem = pathProblem(value);
    if (problem !== undefined) throw new CliError('UNSAFE_TARGET', `hyperframes.json paths.${key} "${value}" ${problem}`);
    paths[key] = value;
  }
  return paths;
}

/** Where a file lands: its `target`, with the `compositions/`, `compositions/components/` or `assets/` prefix moved as the project's `hyperframes.json` says. */
export function remapTarget(target: string, kind: HyperframesType, paths: ReturnType<typeof projectPaths>): string {
  const moves: [string, string][] =
    kind === 'component'
      ? [['compositions/components/', paths.components], ['assets/', paths.assets]]
      : [['compositions/', paths.blocks], ['assets/', paths.assets]];
  for (const [from, to] of moves) if (target.startsWith(from)) return `${to}/${target.slice(from.length)}`;
  return target;
}

type Paths = ReturnType<typeof projectPaths>;

/**
 * Where a file of `item` lands. `remapTarget`, then three kinds of file that items put at the project root, which
 * `add` does not write there: `TEMPLATE.md` goes to `<compositions>/<item>/TEMPLATE.md`, `models/…` under the assets
 * folder, and `lib/…` beside the compositions (as the items that ship `compositions/lib/` do). Anything else is left
 * as it is, for `hyperframesTargetProblem` to refuse.
 */
export function placeTarget(target: string, item: { name: string; kind: HyperframesType }, paths: Paths): string {
  const moved = remapTarget(target, item.kind, paths);
  if (moved !== target) return moved;
  const folder = item.kind === 'component' ? paths.components : paths.blocks;
  if (target === 'TEMPLATE.md') return `${folder}/${item.name}/TEMPLATE.md`;
  if (target.startsWith('models/')) return `${paths.assets}/${target}`;
  if (target.startsWith('lib/')) return `${folder}/${target}`;
  return target;
}

const TEXT_FILE = /\.(html?|css|m?js)$/i;

/**
 * `text` with each path in `moves` that appears as a quoted (or `url(`) path, with or without a leading `./`, replaced
 * by where the file went. A longer path that merely ends in the old one (`other/models/a.glb`) is left alone.
 */
export function rewriteReferences(text: string, moves: [from: string, to: string][]): string {
  let out = text;
  for (const [from, to] of moves) {
    const pattern = new RegExp(`(["'\`(])(\\./)?${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
    out = out.replace(pattern, (_all, quote: string, dot: string | undefined) => `${quote}${dot ?? ''}${to}`);
  }
  return out;
}

/** Names that are never written, wherever they sit in a path. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FORBIDDEN_NAMES = new Set(['package.json', '.git', '.github', 'node_modules']);

/**
 * Why a file may not be written at `target` (already remapped), or undefined: it must be a safe relative path inside
 * the blocks, components or assets folder (or `compositions/`, `assets/`), with every segment made of letters, digits, ".", "_" and "-" (starting with a letter or digit, not ending in "."),
 * and none of them `package.json`, `.git`, `.github` or `node_modules`.
 */
export function hyperframesTargetProblem(target: string, paths: { blocks: string; components: string; assets: string }): string | undefined {
  const problem = pathProblem(target);
  if (problem !== undefined) return problem;
  const roots = new Set([paths.blocks, paths.components, paths.assets, 'compositions', 'assets']);
  if (![...roots].some((root) => target.startsWith(`${root}/`) && target.length > root.length + 1)) {
    return `is outside the ${[...roots].join(', ')} folders`;
  }
  for (const segment of target.split('/')) {
    // An allowlist, so Windows tricks (a trailing dot or space, `name:stream`, 8.3 short names like NODE_M~1) never get through.
    if (!SEGMENT.test(segment) || segment.endsWith('.')) return `has a segment ("${segment.replace(/[^\x20-\x7e]/g, '?')}") that is not letters, digits, "." "_" "-" and starts with a letter or digit`;
    if (FORBIDDEN_NAMES.has(segment.toLowerCase())) return `has a protected name ("${segment}")`;
  }
  return undefined;
}

export interface HyperframesAddOptions {
  /** Item names, without the `hyperframes/` prefix. */
  names: string[];
  dir: string;
  source: HyperframesSource;
  overwrite: boolean;
  progress?: (message: string) => void;
}

export interface HyperframesAdded {
  name: string;
  type: HyperframesType;
  title: string;
  author?: string;
  license?: string;
  source: string;
  written: string[];
  /** Files already in the project with the same bytes, left as they are. */
  unchanged: string[];
  /** Licence and notice files the item ships, among `written` and `unchanged`. */
  licences: string[];
  dimensions?: { width: number; height: number };
  duration?: number;
}

export interface HyperframesAddResult {
  project: string;
  ref: string;
  added: HyperframesAdded[];
  credits: string;
  warnings: string[];
  next: string[];
}

const LICENCE_FILE = /(^|[/._-])(licen[cs]es?|notice|copying|ofl|third-party)([._-]|$)/i;

/** Whether `target` is a file in the project (false when nothing is there). Refuses a link on its path, and a folder where a file goes. */
function existing(root: string, target: string): Uint8Array | undefined {
  const absolute = resolve(root, target);
  if (!absolute.startsWith(root + sep)) throw new CliError('UNSAFE_TARGET', `${target} leaves the project`);
  const parts = target.split('/');
  let current = root;
  for (const [i, part] of parts.entries()) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return undefined;
    }
    const where = parts.slice(0, i + 1).join('/');
    if (stat.isSymbolicLink()) throw new CliError('UNSAFE_TARGET', `${where} is a symbolic link; not writing through it`);
    if (i < parts.length - 1 && !stat.isDirectory()) throw new CliError('UNSAFE_TARGET', `${where} is a file, but ${target} needs it to be a folder`);
    if (i === parts.length - 1 && stat.isDirectory()) throw new CliError('UNSAFE_TARGET', `${target} is a folder, not a file`);
  }
  return readFileSync(absolute);
}

const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/** One item's section of the credits file. */
function creditsSection(entry: HyperframesAdded): string {
  const lines = [`## ${entry.name}`, '', `- Title: ${entry.title}`, `- Type: ${entry.type}`];
  lines.push(`- Author: ${entry.author ?? 'not given'}`);
  lines.push(`- Licence: ${entry.license ?? 'not given by the item (the HyperFrames repository is Apache-2.0)'}`);
  lines.push(`- Source: ${entry.source}`);
  if (entry.licences.length > 0) lines.push(`- Licence files: ${entry.licences.join(', ')}`);
  return lines.join('\n');
}

const CREDITS_HEAD = `# HyperFrames credits

These items come from the HyperFrames registry (https://github.com/${HYPERFRAMES_REPO}, Apache-2.0), made by HeyGen and its contributors. Each keeps the licence it ships with; the licence and notice files are installed beside it.`;

/** `existing` credits text with `entries` added; an item already listed has its section replaced. */
export function mergeCredits(existingText: string | undefined, entries: HyperframesAdded[]): string {
  const sections = new Map<string, string>();
  for (const part of (existingText ?? '').split(/^(?=## )/m)) {
    const m = /^## (\S+)/.exec(part);
    if (m !== null) sections.set(m[1]!, part.trimEnd());
  }
  for (const entry of entries) sections.set(entry.name, creditsSection(entry));
  return `${CREDITS_HEAD}\n\n${[...sections.values()].join('\n\n')}\n`;
}

export async function addHyperframes(options: HyperframesAddOptions): Promise<HyperframesAddResult> {
  const { source, overwrite } = options;
  const progress = options.progress ?? (() => undefined);
  const root = findHyperframesProject(options.dir);
  const items = await resolveHyperframes(source, options.names);
  const paths = projectPaths(root);
  const warnings: string[] = [];
  // Nothing is fetched or written for an item that wants to write outside its folders.
  for (const item of items) {
    for (const file of item.files) {
      const target = placeTarget(file.target, item, paths);
      const problem = hyperframesTargetProblem(target, paths);
      if (problem !== undefined) throw new CliError('UNSAFE_TARGET', `${item.name}: target "${file.target}"${target === file.target ? '' : ` (installs as "${target}")`} ${problem}`);
    }
  }
  // The credits file is written too: it must not be a link, nor sit in a link.
  const creditsBefore = existing(root, HYPERFRAMES_CREDITS_FILE);

  // Every download first, so a failure stops the install before anything is written.
  let total = 0;
  const plan = items.map((item) => ({ item, files: item.files.map((file) => ({ file, target: placeTarget(file.target, item, paths), data: undefined as Uint8Array | undefined })) }));
  const jobs = plan.flatMap(({ item, files }) => files.map((f) => ({ item, f })));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = jobs[next++];
      if (job === undefined) return;
      progress(`downloading ${job.item.name}/${job.f.file.path}`);
      job.f.data = await source.file(job.item, job.f.file);
      total += job.f.data.length;
      if (total > MAX_TOTAL_BYTES) throw new CliError('TOO_LARGE', `the items are larger than ${MAX_TOTAL_BYTES / 1024 / 1024} MB together`);
    }
  };
  await Promise.all(Array.from({ length: DOWNLOADS_AT_ONCE }, worker));

  // A file that moved is named by its new path in the item's own pages and scripts. `lib/` needs no rewrite: scripts
  // name it relative to the page, and the page and `lib/` moved together.
  for (const { item, files } of plan) {
    const moves = files
      .filter(({ file, target }) => target !== file.target && !file.target.startsWith('lib/') && remapTarget(file.target, item.kind, paths) === file.target)
      .map(({ file, target }): [string, string] => [file.target, target]);
    if (moves.length === 0) continue;
    for (const f of files) {
      if (!TEXT_FILE.test(f.target)) continue;
      const before = Buffer.from(f.data!).toString('utf8');
      const after = rewriteReferences(before, moves);
      if (after !== before) f.data = Buffer.from(after, 'utf8');
    }
  }

  // Decide every file before the first write. A file already there is an error unless it holds the same bytes.
  const planned = new Map<string, Uint8Array>();
  const refused: string[] = [];
  const decided = plan.map(({ item, files }) => ({
    item,
    files: files.map(({ target, data }) => {
      const bytes = data!;
      const before = planned.get(target) ?? existing(root, target);
      planned.set(target, bytes);
      if (before !== undefined && same(before, bytes)) return { target, bytes, action: 'unchanged' as const };
      if (before !== undefined && !overwrite) {
        refused.push(target);
        return { target, bytes, action: 'refused' as const };
      }
      return { target, bytes, action: 'write' as const };
    }),
  }));
  if (refused.length > 0) {
    const list = [...new Set(refused)];
    throw new CliError('EXISTS', `not overwriting ${list.length} existing file${list.length === 1 ? '' : 's'}: ${list.slice(0, 8).join(', ')}${list.length > 8 ? ', …' : ''}. Pass --overwrite to replace ${list.length === 1 ? 'it' : 'them'}.`);
  }

  const added: HyperframesAdded[] = [];
  for (const { item, files } of decided) {
    const entry: HyperframesAdded = {
      name: item.name,
      type: item.kind,
      title: item.title || item.name,
      ...(item.author !== undefined ? { author: item.authorUrl !== undefined ? `${item.author} (${item.authorUrl})` : item.author } : {}),
      ...(item.license !== undefined ? { license: item.license } : {}),
      source: source.sourceUrl(item),
      written: [],
      unchanged: [],
      licences: [],
      ...(item.dimensions !== undefined ? { dimensions: item.dimensions } : {}),
      ...(item.duration !== undefined ? { duration: item.duration } : {}),
    };
    for (const file of files) {
      if (file.action === 'write') {
        const absolute = join(root, file.target);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, file.bytes);
        entry.written.push(file.target);
      } else entry.unchanged.push(file.target);
      if (LICENCE_FILE.test(file.target.split('/').at(-1)!)) entry.licences.push(file.target);
    }
    if (item.deprecated !== undefined) warnings.push(`${item.name} is deprecated: ${item.deprecated}`);
    added.push(entry);
  }

  const creditsPath = join(root, HYPERFRAMES_CREDITS_FILE);
  const credits = mergeCredits(creditsBefore === undefined ? undefined : Buffer.from(creditsBefore).toString('utf8'), added);
  writeFileSync(creditsPath, credits);

  const steps = added
    .filter((a) => options.names.includes(a.name))
    .map((a) => {
      const file = a.written.concat(a.unchanged).find((t) => t.endsWith('.html'));
      if (a.type === 'block') {
        const size = a.dimensions !== undefined ? ` data-width="${a.dimensions.width}" data-height="${a.dimensions.height}"` : '';
        return `${a.name}: mount it with <div data-composition-id="${a.name}" data-composition-src="${file ?? ''}" data-start="0" data-duration="${a.duration ?? 5}"${size}></div>`;
      }
      return `${a.name}: paste the snippet in ${file ?? 'its html file'} into your composition`;
    });
  return { project: root, ref: source.ref, added, credits: creditsPath, warnings, next: steps };
}

export function describeHyperframesAdd(result: HyperframesAddResult): string {
  const lines: string[] = [];
  for (const item of result.added) {
    lines.push(`${item.title} (hyperframes/${item.name}, ${item.type}): ${item.written.length} file${item.written.length === 1 ? '' : 's'} written${item.unchanged.length > 0 ? `, ${item.unchanged.length} already there` : ''}`);
    for (const file of item.written) lines.push(`  wrote      ${file}`);
    for (const file of item.unchanged) lines.push(`  unchanged  ${file}`);
  }
  lines.push(`credits and licences: ${result.credits}`);
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  if (result.next.length > 0) lines.push('next:', ...result.next.map((step) => `  ${step}`));
  return lines.join('\n');
}
