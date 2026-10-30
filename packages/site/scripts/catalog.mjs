// Writes content/catalog.json from the private kinetograph-effects checkout: its plugins and its reel templates.
//   KINETOGRAPH_EFFECTS=/path/to/kinetograph-effects node scripts/catalog.mjs
// Without the checkout it prints a message and leaves the committed catalog.json alone.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.KINETOGRAPH_EFFECTS ?? join(here, '../../../../kinetograph-effects'));
const out = join(here, '../content/catalog.json');

if (!existsSync(join(root, 'plugins'))) {
  console.log(`catalog: no kinetograph-effects at ${root}; set KINETOGRAPH_EFFECTS. Keeping ${out}.`);
  process.exit(0);
}

/** Showrooms of a plugin: listed under the plugins they demo (folder names), never as templates. */
const DEMOS = {
  'match-cut': { title: 'Match cut presets', plugins: ['paper'] },
  'paper-photo': { title: 'Paper photo effects', plugins: ['paper'] },
  'kinetic-type-demo': { title: 'Hand captions', plugins: ['kinetic-typography'] },
  'vj-demo': { title: 'VJ looks and tracking', plugins: ['vj'] },
  'hexed-demo': { title: 'Hexed rolls', plugins: ['hexed'] },
  'plugin-ui-demo': { title: 'Studio panels', plugins: ['hexed', 'paper', 'vj'] },
};
/** Studies, not for sale. */
const EXCLUDED = new Set(['save-reel']);

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const dirs = (p) => readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const plain = (s) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
/** The first sentence, without parentheses that name files and without a trailing ", see <file>". */
const brief = (s) => {
  const t = plain(s).replace(/\s*\([^)]*(?:\/|\.tsx?)[^)]*\)/g, '').replace(/,? see \S+\.\w+/g, '');
  const first = (t.match(/.+?(?:[.!?](?=\s+[A-Z0-9])|$)/) ?? [''])[0].trim();
  return first.charAt(0).toUpperCase() + first.slice(1);
};
const titleCase = (s) =>
  s.split(/[-_ ]/).filter(Boolean).map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ');

/** The first paragraph of a markdown file, skipping headings and fenced code. */
function firstParagraph(md) {
  const para = [];
  let fence = false;
  for (const line of md.split('\n')) {
    if (line.startsWith('```')) fence = !fence;
    if (fence || line.startsWith('```') || line.startsWith('#')) {
      if (para.length) break;
      continue;
    }
    if (!line.trim()) {
      if (para.length) break;
      continue;
    }
    para.push(line.trim());
  }
  return brief(para.join(' '));
}

/** The leading `//` comment block of a source file, as a paragraph. */
function leadingComment(src) {
  const lines = [];
  for (const line of src.split('\n')) {
    if (!line.startsWith('//')) break;
    lines.push(line.replace(/^\/\/ ?/, ''));
  }
  return firstParagraph(lines.join('\n'));
}

const repoReadme = read(join(root, 'README.md'));
/** The repo README's bullet for `effects/<id>/`, minus its path. */
function bulletFor(id) {
  const lines = repoReadme.split('\n');
  const i = lines.findIndex((l) => l.startsWith(`- \`effects/${id}/\`:`));
  if (i < 0) return '';
  const text = [lines[i].replace(/^- `[^`]*`:\s*/, '')];
  for (let j = i + 1; j < lines.length && /^ {2}\S/.test(lines[j]); j++) text.push(lines[j].trim());
  return brief(text.join(' '));
}

// Plugins.
const pluginDirs = dirs(join(root, 'plugins'));
const pluginNames = Object.fromEntries(pluginDirs.map((d) => [d, JSON.parse(read(join(root, 'plugins', d, 'package.json'))).name]));
const plugins = pluginDirs.map((d) => {
  const pkg = JSON.parse(read(join(root, 'plugins', d, 'package.json')));
  const k = pkg.kinetograph ?? {};
  const readme = read(join(root, 'plugins', d, 'README.md'));
  const components = k.components ?? [...new Set([...readme.matchAll(/`<([A-Z]\w*)>`/g)].map((m) => m[1]))];
  return {
    name: pkg.name,
    title: k.title ?? titleCase(pkg.name.replace(/^@[^/]+\//, '')),
    description: k.description ?? firstParagraph(readme) ?? pkg.description ?? '',
    components,
    hasPanel: Boolean(k.panel),
    hasTools: Boolean(k.tools),
    hasSkill: Boolean(k.skill),
    demos: [],
  };
});
const byDir = Object.fromEntries(pluginDirs.map((d, i) => [d, plugins[i]]));

// Effects: demos go under the plugins they import, the rest are templates.
function sources(dir) {
  const found = [];
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      if (['node_modules', 'out', 'public', 'reference'].includes(e.name)) continue;
      const full = join(p, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(tsx?|mjs)$/.test(e.name)) found.push(full);
    }
  };
  walk(dir);
  return found;
}
function importedPlugins(dir) {
  const used = new Set();
  for (const f of sources(dir)) {
    const src = read(f);
    for (const d of pluginDirs) {
      if (src.includes(`plugins/${d}/`) || src.includes(`'${pluginNames[d]}'`)) used.add(d);
    }
  }
  return [...used];
}

const templates = [];
const skipped = [];
for (const id of dirs(join(root, 'effects'))) {
  if (EXCLUDED.has(id)) continue;
  const dir = join(root, 'effects', id);
  const readme = read(join(dir, 'README.md'));
  const index = read(join(dir, 'index.tsx'));
  if (DEMOS[id]) {
    for (const d of DEMOS[id].plugins) byDir[d].demos.push({ id, title: DEMOS[id].title });
    continue;
  }
  if (!index) {
    skipped.push(id); // nothing to render: a reference folder only
    continue;
  }
  const heading = readme.match(/^#\s+(.+)$/m)?.[1];
  templates.push({
    id,
    title: heading && heading !== id ? heading.replace(/\s*\(.*\)\s*$/, '') : titleCase(id),
    description: firstParagraph(readme) || bulletFor(id) || leadingComment(index),
    plugins: importedPlugins(dir).map((d) => byDir[d].name),
  });
}

writeFileSync(out, JSON.stringify({ plugins, templates }, null, 2) + '\n');
console.log(`catalog: ${plugins.length} plugins, ${templates.length} templates -> ${out}`);
if (skipped.length) console.log(`catalog: skipped without index.tsx: ${skipped.join(', ')}`);
