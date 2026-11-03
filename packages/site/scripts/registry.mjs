#!/usr/bin/env node
// Builds the site's registry (public/r/) from the kinetograph-ui checkout: one item per template, component and taste
// that content/catalog.json lists, so `npx kinetograph add <name>` finds them at https://kinetograph.dev/r/<name>.json.
//
//   node scripts/registry.mjs [path/to/kinetograph-ui] [--out public/r]
//
// The checkout is the argument, else $KINETOGRAPH_UI, else the folder next to this repo (../kinetograph-ui). Needs the CLI
// built (npm run build -w kinetograph), because the items are written by its builder (packages/cli/src/registry/build.ts).
// Only files that git tracks in the checkout are used, so an item holds what its Source link shows.
//
// What each item is (the folders are those of kinetograph-ui, see docs/registry.md for the item format):
//   template   templates/<id>/        index.tsx stays, every other source file goes to scenes/ (what it imports from outside, to scenes/shared/), public/ becomes public/<kind>/<id>/.
//              A showcase piece (components/showcase/<piece>.tsx) is a template too; its index.tsx is cut from the folder's own.
//   component  one composition of components/<kind>/: the file that exports its schema becomes index.tsx, with the files it imports.
//   taste      tastes/<dir>/          sources keep their paths, textures and sounds go to public/, README.md becomes TASTE.md.
// Whatever an item imports from outside its folder (kit/, another taste) is copied under shared/ (scenes/shared/ in a template) and the imports are
// rewritten. A staticFile path that names a file of the item's public/ is rewritten to where the file installs.
// Files over 10 MB, links, and kinds the registry has no place for (python, shell) are left out and listed at the end.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SHOWCASE_COPY, TASTE_COPY } from './catalog-copy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const outDir = resolve(outArg >= 0 ? args.splice(outArg, 2)[1] : join(here, '../public/r'));
const ui = resolve(args[0] ?? process.env.KINETOGRAPH_UI ?? join(here, '../../../../kinetograph-ui'));
const catalogFile = join(here, '../content/catalog.json');
if (!existsSync(join(ui, 'templates'))) {
  console.error(`registry: no kinetograph-ui at ${ui}; pass its path or set KINETOGRAPH_UI.`);
  process.exit(1);
}
const cliBuild = join(here, '../../cli/dist/registry/build.js');
if (!existsSync(cliBuild)) {
  console.error('registry: the CLI is not built; run `npm run build -w kinetograph` first.');
  process.exit(1);
}
const { buildRegistry } = await import(pathToFileURL(cliBuild));
const { registryItemSchema } = await import(pathToFileURL(join(here, '../../cli/dist/registry/item.js')));

/** The oldest CLI that has `add`. */
const MIN_CLI = '0.3.0';
const ZOD = '4.6.7';
const MAX_BINARY = 10 * 1024 * 1024;

const CODE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const TEXT = new Set(['.md', '.mdx', '.json', '.css', '.txt', '.svg', '.html', '.glsl', '.frag', '.vert']);
const MEDIA = {
  images: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'],
  audio: ['.wav', '.mp3', '.m4a', '.ogg', '.flac', '.aac'],
  video: ['.mp4', '.mov', '.webm', '.m4v'],
  fonts: ['.woff2', '.woff', '.ttf', '.otf'],
};
const mediaKind = (file) => Object.entries(MEDIA).find(([, exts]) => exts.includes(extname(file).toLowerCase()))?.[0];
const ignoredFile = (name) => name.startsWith('.') || name === 'tsconfig.json' || name === 'google-fonts.d.ts' || name === 'package.json' || name === 'package-lock.json';

// Every file git tracks in the checkout (so untracked renders and local links never reach the registry).
const tracked = (() => {
  try {
    return new Set(execFileSync('git', ['-C', ui, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean));
  } catch {
    console.error('registry: git ls-files failed in the checkout; it must be a git checkout.');
    process.exit(1);
  }
})();
const abs = (p) => join(ui, p);
const isLink = (p) => lstatSync(abs(p)).isSymbolicLink();
const under = (dir) => [...tracked].filter((p) => p.startsWith(`${dir}/`)).sort();

const skipped = []; // { item, file, why }
const warnings = [];

/** The file an import resolves to (a tracked path), or undefined. */
function resolveImport(from, spec) {
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  const stem = base.replace(/\.(m?js|jsx)$/, '');
  for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (tracked.has(c) && !isLink(c)) return c;
  }
  return undefined;
}

const IMPORT = /(\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"\n]*|\.{1,2})\2/g;
const specsOf = (src) => [...src.matchAll(IMPORT)].map((m) => m[3]);
const bareSpecs = (src) =>
  [...src.matchAll(/^(?:import|export)\b[^;'"]*?\bfrom\s*(['"])([^'".][^'"\n]*)\1|^import\s*(['"])([^'".][^'"\n]*)\3/gm)].map((m) => m[2] ?? m[4]);

/** The files `entries` import, transitively, as tracked paths. Specifiers that name nothing tracked are warned about. */
function closure(entries, item) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!CODE.has(extname(file))) continue;
    for (const spec of specsOf(readFileSync(abs(file), 'utf8'))) {
      const target = resolveImport(file, spec);
      if (target) queue.push(target);
      else warnings.push(`${item}: ${file} imports "${spec}", which is not a tracked file`);
    }
  }
  return seen;
}

/** `src` with every relative import rewritten for a file that moved from `oldPath` to `newPath` (`moved`: old path -> new path). */
function rewriteImports(src, oldPath, newPath, moved, item) {
  return src.replace(IMPORT, (whole, lead, quote, spec) => {
    const target = resolveImport(oldPath, spec);
    const next = target && moved.get(target);
    if (!next) return whole;
    let rel;
    if (/\.(m?js|jsx)$/.test(spec)) rel = posix.relative(posix.dirname(newPath), next).replace(/\.(tsx?|jsx?)$/, '.js');
    else if (extname(spec) === '' || spec.endsWith('/')) {
      const viaIndex = /^index\.tsx?$/.test(posix.basename(next)) && !/\/?index(\.tsx?)?$/.test(spec) && posix.basename(target).startsWith('index.') && !spec.match(/index$/);
      rel = posix.relative(posix.dirname(newPath), viaIndex ? posix.dirname(next) : next.replace(/\.(tsx?|jsx?)$/, ''));
    } else rel = posix.relative(posix.dirname(newPath), next);
    if (rel === '') rel = '.';
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return `${lead}${quote}${rel}${quote}`;
  });
}

/**
 * A staged item: `files` maps a path inside the item to { text } or { from } (a tracked binary). Source files carry
 * `old`, the tracked path they came from, so imports can be rewritten once every file has its place.
 */
function stage(name) {
  return { name, files: new Map(), assets: new Map(), deps: {} };
}
function put(st, path, entry) {
  if (st.files.has(path)) throw new Error(`${st.name}: two files want ${path}`);
  st.files.set(path, entry);
}

/**
 * Rewrites the staticFile paths in `text`: a string that starts with the first path segment of one of the item's assets
 * (`photos/`, `cutout.png`) gets `<kind>/<name>/` in front, because that is where the file installs.
 */
function rewriteAssets(text, tops) {
  let out = text;
  for (const [top, newTop] of tops) {
    const re = top.endsWith('/') ? new RegExp(`(['"\`])${top.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g') : new RegExp(`(['"\`])${top.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\1)`, 'g');
    out = out.replace(re, (_, q) => `${q}${newTop}`);
  }
  return out;
}

/** The mapping from first public/ segment to its new place, for the assets staged under public/<kind>/<name>/. */
function assetTops(st) {
  const tops = new Map();
  for (const [path, entry] of st.files) {
    if (!path.startsWith('public/') || !entry.from) continue;
    const kind = path.split('/')[1];
    const publicRel = entry.publicRel;
    const first = publicRel.split('/')[0];
    const top = publicRel.includes('/') ? `${first}/` : first;
    const mapped = `${kind}/${st.name}/${top}`;
    if (tops.has(top) && tops.get(top) !== mapped) warnings.push(`${st.name}: ${top} holds files of two kinds; only one is rewritten`);
    else tops.set(top, mapped);
  }
  return tops;
}

/** Writes the staged item into `dir` as an authoring folder (item.json and its files). */
function writeStage(st, meta, dir) {
  const folder = join(dir, st.name);
  mkdirSync(folder, { recursive: true });
  const deps = { ...st.deps };
  for (const [path, entry] of st.files) {
    const file = join(folder, path);
    mkdirSync(dirname(file), { recursive: true });
    if (entry.text !== undefined) {
      writeFileSync(file, entry.text);
      for (const spec of bareSpecs(entry.text)) {
        if (/^(react|remotion|node:.*|@remotion\/.*|@kinetographdev\/.*|react\/.*|remotion\/.*)$/.test(spec)) continue;
        if (spec === 'zod' || spec.startsWith('zod/')) deps.zod = ZOD;
        else warnings.push(`${st.name}: imports "${spec}", which no dependency covers`);
      }
    } else writeFileSync(file, readFileSync(abs(entry.from)));
  }
  writeFileSync(join(folder, 'item.json'), JSON.stringify({ ...meta, name: st.name, kinetograph: MIN_CLI, access: 'free', ...(Object.keys(deps).length ? { dependencies: deps } : {}) }, null, 2));
}

/** Common step: place source files (old -> new), rewrite imports and assets, and stage the result. */
function emitSources(st, sources, moved, tops) {
  for (const [old, next] of moved) {
    if (!sources.has(old)) continue;
    let text = readFileSync(abs(old), 'utf8');
    if (CODE.has(extname(old))) text = rewriteImports(text, old, next, moved, st.name);
    if (CODE.has(extname(old)) && tops.size) text = rewriteAssets(text, tops);
    put(st, next, { text, old });
  }
}

/** Source files that are left out of an item's folder because they are tooling, not content. */
const TOOLING = /(^|\/)(out|reference|tools|node_modules|demo[\w-]*)(\/|$)/;

// ---------------------------------------------------------------------------------------------------------------------

function stageTemplate(id, meta) {
  const st = stage(id);
  const root = `templates/${id}`;
  const sources = new Set();
  const moved = new Map();
  for (const old of under(root)) {
    const rel = old.slice(root.length + 1);
    if (rel.startsWith('public/') || TOOLING.test(rel) || ignoredFile(basename(rel)) || basename(rel) === 'README.md') continue;
    if (isLink(old)) {
      skipped.push({ item: id, file: old, why: 'a link' });
      continue;
    }
    if (CODE.has(extname(rel)) || TEXT.has(extname(rel))) {
      sources.add(old);
      moved.set(old, rel === 'index.tsx' ? 'index.tsx' : `scenes/${rel}`);
    } else if (mediaKind(rel)) {
      // A picture beside the sources (grid-reel's stills/): it installs to public/ like the rest.
      addAssetAt(st, old, rel);
    } else skipped.push({ item: id, file: old, why: `no place for ${extname(rel)} files` });
  }
  stagePublicAt(st, root);
  finishSources(st, sources, moved, root, 'scenes/shared');
  return { st, meta };
}

/** Adds `old` as public/<kind>/<rel> in the authoring folder; the builder installs it at public/<kind>/<id>/<rel>. */
function addAssetAt(st, old, rel) {
  const kind = mediaKind(old);
  if (!kind) return skipped.push({ item: st.name, file: old, why: `no public/ folder for ${extname(old)} files` });
  if (isLink(old)) return skipped.push({ item: st.name, file: old, why: 'a link' });
  const size = statSync(abs(old)).size;
  if (size > MAX_BINARY) return skipped.push({ item: st.name, file: old, why: `over 10 MB (${(size / 1048576).toFixed(1)} MB)` });
  put(st, `public/${kind}/${rel}`, { from: old, publicRel: rel });
}

function stagePublicAt(st, root) {
  for (const old of under(`${root}/public`)) {
    const rel = old.slice(`${root}/public/`.length);
    if (basename(rel).startsWith('.') || basename(rel) === 'CREDITS.md' || basename(rel) === 'SOURCES.md') continue;
    if (TEXT.has(extname(old).toLowerCase()) || CODE.has(extname(old))) {
      skipped.push({ item: st.name, file: old, why: 'a data file in public/, which has no folder to install to' });
      continue;
    }
    addAssetAt(st, old, rel);
  }
}

/** Adds what the sources import from outside `root` under shared/, then writes every source with its imports fixed. */
function finishSources(st, sources, moved, root, shared = 'shared') {
  const outside = closure([...sources].filter((f) => CODE.has(extname(f))), st.name);
  for (const f of outside) {
    if (moved.has(f) || f.startsWith(`${root}/`)) continue;
    if (!sources.has(f)) sources.add(f);
    moved.set(f, `${shared}/${f}`);
  }
  // A template whose whole scene is index.tsx still keeps its scenes in scenes/: the scene moves there and index.tsx imports it.
  if (shared.startsWith('scenes') && [...moved.values()].every((p) => !p.startsWith('scenes/'))) {
    const entry = [...moved].find(([, to]) => to === 'index.tsx')?.[0];
    if (entry) {
      moved.set(entry, `scenes/${st.name}.tsx`);
      put(st, 'index.tsx', { text: `// The scene in scenes/ calls registerRoot; importing it registers the compositions.\nimport './scenes/${st.name}.js';\n` });
    }
  }
  const tops = assetTops(st);
  emitSources(st, sources, moved, tops);
}

// ---------------------------------------------------------------------------------------------------------------------

/** For a kind folder: composition id -> the file that exports its schema, and the <Composition> element's source. */
function compositionsOf(kind) {
  const dir = `components/${kind}`;
  const found = new Map();
  for (const file of under(dir).filter((f) => /\.tsx$/.test(f) && posix.dirname(f) === dir)) {
    const src = readFileSync(abs(file), 'utf8');
    if (!/<Composition\b/.test(src)) continue;
    const imports = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)].map((m) => ({
      names: m[1].split(',').map((n) => n.trim().replace(/^type\s+/, '')).filter(Boolean).map((n) => ({ text: n, local: n.split(/\s+as\s+/).pop() })),
      from: m[2],
      whole: m[0],
    }));
    for (const m of src.matchAll(/<Composition\b([\s\S]*?)\/>/g)) {
      const id = m[1].match(/\bid=["'](\w+)["']/)?.[1];
      const schema = m[1].match(/\bschema=\{(\w+)\}/)?.[1] ?? (/\{\.\.\.\w+\}/.test(m[1]) ? src.match(/\bschema:\s*(\w+)/)?.[1] : undefined);
      const from = imports.find((i) => i.names.some((n) => n.local === schema))?.from;
      if (id && from && !found.has(id)) found.set(id, { file: resolveImport(file, from), element: m[0], registrar: file, src, imports });
    }
  }
  return found;
}

function stageComponent(id, meta, kind, compId) {
  const st = stage(id);
  const comp = compositionsOf(kind).get(compId);
  if (!comp?.file) throw new Error(`${id}: no file found for composition ${compId} in components/${kind}`);
  const root = `components/${kind}`;
  const files = closure([comp.file], id);
  const sources = new Set();
  const moved = new Map();
  for (const f of files) {
    sources.add(f);
    moved.set(f, f === comp.file ? 'index.tsx' : f.startsWith(`${root}/`) ? f.slice(root.length + 1) : `shared/${f}`);
  }
  // Assets named by a literal in the sources and found in the kind's public/ (a link into the shared photo set is followed).
  const literals = new Set();
  for (const f of sources) for (const m of readFileSync(abs(f), 'utf8').matchAll(/(['"`])([\w][\w./-]*\.(?:jpg|jpeg|png|webp|wav|mp3|m4a|mp4))\1/g)) literals.add(m[2]);
  for (const lit of literals) {
    const candidate = join(abs(root), 'public', lit);
    if (!existsSync(candidate)) continue;
    const real = relative(ui, realpathSync(candidate));
    if (!tracked.has(real)) continue;
    addAssetAt(st, real, lit);
  }
  const tops = assetTops(st);
  emitSources(st, sources, moved, tops);
  return { st, meta };
}

/** A showcase piece: a template whose index.tsx is the folder's own, cut down to one composition. */
function stageShowcase(id, meta, compId) {
  const st = stage(id);
  const comp = compositionsOf('showcase').get(compId);
  if (!comp?.file) throw new Error(`${id}: no file found for composition ${compId} in components/showcase`);
  const root = 'components/showcase';
  const files = closure([comp.file], id);
  const sources = new Set(files);
  const moved = new Map();
  for (const f of files) moved.set(f, f.startsWith(`${root}/`) ? `scenes/${f.slice(root.length + 1)}` : `scenes/shared/${f}`);
  // Photos named in the piece's defaults are in the shared photo set, which is not copied per item.
  const words = new Set(comp.element.match(/\b[A-Za-z_]\w*\b/g));
  const wanted = comp.imports
    .filter((i) => i.from.startsWith('.'))
    .map((i) => ({ ...i, kept: i.names.filter((n) => words.has(n.local)) }))
    .filter((i) => i.kept.length)
    .map((i) => {
      const target = resolveImport(comp.registrar, i.from);
      const to = target && moved.get(target);
      if (!to) throw new Error(`${id}: index.tsx imports ${i.from}, which is not in the item`);
      const rel = posix.relative('.', to).replace(/\.(tsx?|jsx?)$/, '.js');
      return `import { ${i.kept.map((n) => n.text).join(', ')} } from './${rel}';`;
    });
  const index = [
    "import React from 'react';",
    "import { Composition, registerRoot } from 'remotion';",
    ...wanted,
    '',
    'registerRoot(() => (',
    '  <>',
    `    ${comp.element.replace(/\n\s*/g, '\n      ')}`,
    '  </>',
    '));',
    '',
  ].join('\n');
  put(st, 'index.tsx', { text: index });
  emitSources(st, sources, moved, new Map());
  return { st, meta };
}

function stageTaste(id, meta, dir) {
  const st = stage(id);
  const root = `tastes/${dir}`;
  const sources = new Set();
  const moved = new Map();
  for (const old of under(root)) {
    const rel = old.slice(root.length + 1);
    if (TOOLING.test(rel) || ignoredFile(basename(rel))) continue;
    if (isLink(old)) {
      skipped.push({ item: id, file: old, why: 'a link' });
      continue;
    }
    if (rel === 'README.md' || rel.startsWith('public/')) continue; // README.md becomes TASTE.md; public/ is staged below
    if (CODE.has(extname(rel)) || TEXT.has(extname(rel))) {
      sources.add(old);
      moved.set(old, rel);
    } else if (mediaKind(rel)) {
      addAssetAt(st, old, rel);
    } else skipped.push({ item: id, file: old, why: `no place for ${extname(rel)} files` });
  }
  stagePublicAt(st, root);
  const notes = [...st.files.keys()]
    .filter((p) => p.startsWith('public/'))
    .map((p) => {
      const [, kind, ...rest] = p.split('/');
      return `public/${kind}/${id}/${rest.join('/')}`;
    });
  // The note: README.md, else TASTES.md, else SKILL.md, with where the installed files are.
  const noteSource = ['README.md', 'TASTES.md', 'SKILL.md'].map((n) => `${root}/${n}`).find((p) => tracked.has(p));
  // A taste with no note of its own gets the catalog's sentence and its row of tastes/README.md.
  const row = readFileSync(abs('tastes/README.md'), 'utf8').split('\n').find((l) => l.startsWith(`| [\`${dir}/\`]`));
  const [, , look = '', use = ''] = row ? row.split('|').map((c) => c.trim()) : [];
  const noteText = noteSource
    ? readFileSync(abs(noteSource), 'utf8').replace(/\s*$/, '\n')
    : `# ${meta.title}\n\n${meta.description}\n${look ? `\nLook: ${look}\n` : ''}${use ? `\nUse it for: ${use}\n` : ''}`;
  const folders = [...new Set(notes.map((n) => n.split('/').slice(0, 4).join('/')))];
  const where = [
    '',
    '## Installed with `kinetograph add`',
    '',
    `The code is in \`src/tastes/${id}/\`.${folders.length ? ' The pictures and sounds the code reads are in:' : ''}`,
    ...folders.map((f) => `- \`${f}/\``),
    ...(folders.length ? ['', 'Where a component takes a `base` path for its textures, it defaults to the textures folder above (relative to `public/`).'] : []),
    '',
  ].join('\n');
  put(st, 'TASTE.md', { text: noteText + where });
  // Texture folders: `base` defaults like 'archive-textures' point at where the textures install.
  const textureRoot = notes.find((n) => /\/textures\//.test(n));
  const baseTo = textureRoot ? `${textureRoot.split('/').slice(1, 3).join('/')}/textures` : undefined;
  finishSources(st, sources, moved, root);
  if (baseTo) {
    for (const [path, entry] of st.files) {
      if (entry.text !== undefined && CODE.has(extname(path))) entry.text = entry.text.replace(/(\bbase\??\s*[:=]\s*)'[\w-]*textures'/g, `$1'${baseTo}'`);
    }
  }
  return { st, meta };
}

// ---------------------------------------------------------------------------------------------------------------------

const catalog = JSON.parse(readFileSync(catalogFile, 'utf8'));
const propsOf = (c) => (c.props ?? []).map(({ name, type, doc }) => ({ name, type, ...(doc ? { doc } : {}) }));
const showcaseIds = new Map(Object.keys(SHOWCASE_COPY).map((comp) => [comp.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase(), comp]));

const work = mkdtempSync(join(tmpdir(), 'kg-registry-'));
const built = [];
const failed = [];
function run(label, fn) {
  try {
    const { st, meta } = fn();
    writeStage(st, meta, work);
    built.push(st.name);
  } catch (error) {
    failed.push(`${label}: ${error.message}`);
  }
}

for (const t of catalog.templates) {
  const meta = { type: 'template', title: t.title, description: t.description, props: propsOf(t) };
  if (t.source.startsWith('templates/')) run(t.id, () => stageTemplate(t.id, meta));
  else run(t.id, () => stageShowcase(t.id, meta, showcaseIds.get(t.id) ?? t.compositions[0]));
}
for (const c of catalog.components) {
  run(c.id, () => stageComponent(c.id, { type: 'component', title: c.title, description: c.description, props: propsOf(c) }, c.category, c.compositions[0]));
}
for (const t of catalog.tastes) {
  run(t.id, () => stageTaste(t.id, { type: 'taste', title: t.title, description: t.description }, TASTE_COPY[t.id].dir));
}
for (const item of readdirSync(work)) {
  const file = join(work, item, 'item.json');
  const meta = JSON.parse(readFileSync(file, 'utf8'));
  if (!meta.props?.length) delete meta.props;
  writeFileSync(file, JSON.stringify(meta, null, 2));
}

rmSync(outDir, { recursive: true, force: true });
let result;
try {
  result = buildRegistry(work, outDir);
} catch (error) {
  console.error(`registry: ${error.message}`);
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}
rmSync(work, { recursive: true, force: true });

// Check every written item against the CLI's own schema and its size limit.
let bytes = 0;
let binaries = 0;
for (const item of result.items) {
  const file = join(outDir, `${item.name}.json`);
  const size = statSync(file).size;
  bytes += size;
  if (size > 4 * 1024 * 1024) failed.push(`${item.name}: ${(size / 1048576).toFixed(1)} MB of JSON is over the 4 MB limit of the CLI`);
  registryItemSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}
for (const f of result.written.filter((w) => w.startsWith('files/'))) {
  bytes += statSync(join(outDir, f)).size;
  binaries++;
}

const count = (type) => result.items.filter((i) => i.type === type).length;
console.log(`registry: ${result.items.length} items (${count('template')} templates, ${count('component')} components, ${count('taste')} tastes), ${binaries} binary files, ${(bytes / 1048576).toFixed(1)} MB -> ${outDir}`);
for (const w of [...new Set(warnings)]) console.log(`  warning: ${w}`);
for (const f of failed) console.log(`  FAILED ${f}`);
if (skipped.length) {
  console.log(`registry: ${skipped.length} files left out:`);
  for (const s of skipped) console.log(`  ${s.item}: ${s.file} (${s.why})`);
}
if (failed.length) process.exitCode = 1;
