// Writes content/catalog.json from the private kinetograph-effects checkout: its plugins and its reel components.
//   KINETOGRAPH_EFFECTS=/path/to/kinetograph-effects node scripts/catalog.mjs [--media] [--kinds]
// --kinds touches only the motion components (components/<kind>/ of the checkout, listed in KIND_DIRS): it keeps every plugin and
// every other component of the committed catalog.json as it is, replaces the kind components, and with --media cuts only their clips.
// Without the checkout it prints a message and leaves the committed catalog.json alone.
// --media also extracts the stills and clips named in catalog-copy.mjs to public/catalog/. A still is a frame of a render in
// the checkout's effects/<x>/out/ (or a png) as webp, 1280 px on the long side and under 250 KB. A clip is a cut of a render,
// 4 s by default and 6 s at most, as H.264 at 1280 px on the long side, no audio, at most about 1.5 MB, with its first frame as
// the poster. It needs ffmpeg, ffprobe, libx264 and cwebp. It clears public/catalog first and prints the media total.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_TEXT, EXPORT_NOTES, GENE_NOTES, PLUGIN_COPY, COMPONENT_COPY, KIND_COPY, KIND_DIRS } from './catalog-copy.mjs';
import { compositionIds, readCompositions, readExports, readHexed, readKinetic, readPaper, readVj } from './catalog-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.KINETOGRAPH_EFFECTS ?? join(here, '../../../../kinetograph-effects'));
const out = join(here, '../content/catalog.json');
const pub = join(here, '../public');
const withMedia = process.argv.includes('--media');
const kindsOnly = process.argv.includes('--kinds');
if (withMedia && !kindsOnly && existsSync(join(root, 'plugins'))) rmSync(join(pub, 'catalog'), { recursive: true, force: true });

if (!existsSync(join(root, 'plugins'))) {
  console.log(`catalog: no kinetograph-effects at ${root}; set KINETOGRAPH_EFFECTS. Keeping ${out}.`);
  process.exit(0);
}

/** Showrooms of a plugin: listed under the plugins they demo (folder names), never as components. */
const DEMOS = {
  'match-cut': { title: 'Match cut presets', plugins: ['paper'] },
  'paper-photo': { title: 'Paper photo effects', plugins: ['paper'] },
  'kinetic-type-demo': { title: 'Caption styles and hand captions', plugins: ['kinetic-typography'] },
  'vj-demo': { title: 'VJ looks and tracking', plugins: ['vj'] },
  'hexed-demo': { title: 'Hexed rolls', plugins: ['hexed'] },
  'plugin-ui-demo': { title: 'Studio panels', plugins: ['hexed', 'paper', 'vj', 'kinetic-typography'] },
};
/** Studies, not for sale. */
const EXCLUDED = new Set(['save-reel', 'cyberpunk-reel', 'lyric-reel', 'wish-reel', 'mikiwho-reel']);

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

/** An image's size, read from the webp on disk; a default when it is not extracted yet. */
function sizeOf(file) {
  if (!existsSync(file)) return { w: 1280, h: 720 };
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' })
    .trim().split(',').map(Number);
  return { w, h };
}
/**
 * One still: a media entry { from, at?, caption? } becomes public/catalog/<dest>.webp (extracted when --media is on).
 * Returns what the pages read: the src, the size, and where it came from, so the catalog says how to make it again.
 */
function still(entry, dest) {
  const file = join(pub, 'catalog', `${dest}.webp`);
  if (withMedia) {
    const src = join(root, entry.from);
    const [sw, sh] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src], { encoding: 'utf8' })
      .trim().split(',').map(Number);
    const scale = sh > sw ? 'scale=-2:1280' : 'scale=1280:-2';
    mkdirSync(dirname(file), { recursive: true });
    // This ffmpeg may have no webp encoder, so ffmpeg writes one scaled png frame and cwebp encodes it.
    const png = join(tmpdir(), `kg-catalog-${process.pid}.png`);
    const args = ['-v', 'error', '-y'];
    if (entry.at !== undefined) args.push('-ss', String(entry.at));
    args.push('-i', src, '-frames:v', '1', '-vf', scale, png);
    execFileSync('ffmpeg', args);
    for (const q of [80, 70, 60, 50, 40]) {
      execFileSync('cwebp', ['-quiet', '-q', String(q), png, '-o', file]);
      if (statSync(file).size <= 250 * 1024) break;
    }
    rmSync(png);
  }
  const { w, h } = sizeOf(file);
  return {
    src: `/catalog/${dest}.webp`,
    w,
    h,
    from: entry.from,
    ...(entry.at !== undefined ? { at: entry.at } : {}),
    ...(entry.caption ? { caption: entry.caption } : {}),
  };
}
const clipCache = new Map();
let mediaBytes = 0;
let clipCount = 0;
/**
 * One clip: a media entry { from, at?, len?, caption? } becomes public/catalog/<dest>.mp4 plus <dest>.webp, its first frame.
 * The same cut asked for twice is written once. Returns the poster's fields plus the video path and its length.
 */
function clip(entry, dest) {
  const at = entry.at ?? 0;
  const len = Math.min(entry.len ?? 4, 6);
  const key = `${entry.from}|${at}|${len}`;
  let hit = clipCache.get(key);
  if (!hit) {
    const file = join(pub, 'catalog', `${dest}.mp4`);
    const poster = still({ from: entry.from, at }, dest);
    if (withMedia) {
      const src = join(root, entry.from);
      const portrait = poster.h > poster.w;
      mkdirSync(dirname(file), { recursive: true });
      // A kind clip (entry.kb) is held to that size: it steps down in quality, then in width, and is capped at 30 fps.
      const cap = (entry.kb ?? 1536) * 1024;
      const widths = entry.kb ? [1280, 960, 800] : [1280];
      const crfs = entry.kb ? [28, 31, 34, 37, 40, 43, 46, 49] : [26, 29, 32, 35, 38, 41];
      encode: for (const width of widths) {
        const vf = portrait ? `scale=-2:${width}` : `scale=${width}:-2`;
        for (const crf of crfs) {
          execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-i', src, '-t', String(len), '-an', ...(entry.kb ? ['-r', '30'] : []), '-vf', vf,
            '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file]);
          if (statSync(file).size <= cap) break encode;
        }
      }
      mediaBytes += statSync(file).size + statSync(join(pub, 'catalog', `${dest}.webp`)).size;
      clipCount++;
    }
    hit = { poster, video: `/catalog/${dest}.mp4`, len };
    clipCache.set(key, hit);
  }
  return { ...hit.poster, video: hit.video, len: hit.len, ...(entry.caption ? { caption: entry.caption } : {}) };
}
/** For a preset with no hand-written line: the genes it sets, skipping the slots it leaves at none. */
function genesLine(file) {
  const g = JSON.parse(read(file));
  const set = Object.entries(g)
    .filter(([, v]) => v && typeof v === 'object' && v.gene && v.gene !== 'none')
    .map(([slot, v]) => `${slot} ${v.gene}`);
  return set.length ? `Sets ${set.join(', ')}.` : '';
}
/** A plugin's presets: the json files under presets/, with a line and a still where one is chosen. */
function presetsOf(d, c) {
  const found = [];
  const walk = (p) => {
    if (!existsSync(p)) return;
    for (const e of readdirSync(p, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(p, e.name));
      else if (e.name.endsWith('.json')) found.push({ name: e.name.replace(/\.json$/, ''), file: join(p, e.name) });
    }
  };
  walk(join(root, 'plugins', d, 'presets'));
  return found
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, file }) => {
      const m = c?.media.presets?.[name];
      return { name, line: c?.presetLines?.[name] ?? genesLine(file), image: m ? still(m, `plugins/${d}/preset-${name}`) : null };
    });
}

function buildCore() {
  // Plugins.
  const pluginDirs = dirs(join(root, 'plugins'));
  const pluginNames = Object.fromEntries(pluginDirs.map((d) => [d, JSON.parse(read(join(root, 'plugins', d, 'package.json'))).name]));
  const plugins = pluginDirs.map((d) => {
    const pkg = JSON.parse(read(join(root, 'plugins', d, 'package.json')));
    const k = pkg.kinetograph ?? {};
    const readme = read(join(root, 'plugins', d, 'README.md'));
    const pdir = join(root, 'plugins', d);
    const c = PLUGIN_COPY[d];
    if (!c) console.log(`catalog: no copy for plugin ${d}; its page will be thin`);
    // What the source states comes from the source, except an export summary: EXPORT_NOTES wins there, so a summary can be fixed here.
    const { items, unparsed } = readExports(pdir);
    if (unparsed.length) console.log(`catalog: ${d}: public names with no definition found: ${unparsed.join(', ')}`);
    const out = {
      slug: d,
      name: pkg.name,
      title: k.title ?? titleCase(pkg.name.replace(/^@[^/]+\//, '')),
      description: c?.summary ?? k.description ?? firstParagraph(readme) ?? pkg.description ?? '',
      components: items.filter((e) => e.kind === 'component').map((e) => e.name),
      hasPanel: Boolean(k.panel),
      hasTools: Boolean(k.tools),
      hasSkill: Boolean(k.skill),
      intro: c?.intro ?? '',
      // A feature with no media is text only (clip null). The clips are numbered by the features that have one.
      features: (() => {
        let n = 0;
        return (c?.features ?? []).map((f) => ({ title: f.title, text: f.text, clip: f.media ? clip(f.media, `plugins/${d}/feature-${++n}`) : null }));
      })(),
      exports: items.map((e) => ({ ...e, summary: EXPORT_NOTES[`${d}/${e.name}`] || e.summary || '' })),
      presets: presetsOf(d, c),
      presetNote: c?.presetNote ?? '',
      examples: c?.examples ?? [],
      studio: c?.studio ?? null,
      hero: c?.media.hero ? clip(c.media.hero, `plugins/${d}/hero`) : null,
      demos: [],
    };
    if (d === 'hexed') {
      const h = readHexed(pdir, GENE_NOTES);
      out.genes = h.slots;
      if (h.missing.length) console.log(`catalog: hexed genes with no note: ${h.missing.join(', ')}`);
    }
    if (d === 'vj') out.looks = readVj(pdir, out.exports);
    if (d === 'paper') Object.assign(out, readPaper(pdir));
    if (d === 'kinetic-typography') out.faces = readKinetic(pdir);
    return out;
  });
  const byDir = Object.fromEntries(pluginDirs.map((d, i) => [d, plugins[i]]));

  // Effects: demos go under the plugins they import, the rest are components.
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

  const components = [];
  const skipped = [];
  for (const id of dirs(join(root, 'effects'))) {
    if (EXCLUDED.has(id)) continue;
    const dir = join(root, 'effects', id);
    const readme = read(join(dir, 'README.md'));
    const index = read(join(dir, 'index.tsx'));
    if (DEMOS[id]) {
      // The stills belong to the first plugin the demo lists; the others list the demo by name only.
      const [first] = DEMOS[id].plugins;
      const clips = (PLUGIN_COPY[first]?.media.demos[id] ?? []).map((e, i) => clip(e, `plugins/${first}/demo-${id}-${i + 1}`));
      for (const d of DEMOS[id].plugins) {
        byDir[d].demos.push({ id, title: DEMOS[id].title, text: DEMO_TEXT[id] ?? '', compositions: compositionIds(index), clips: d === first ? clips : [] });
      }
      continue;
    }
    if (!index) {
      skipped.push(id); // nothing to render: a reference folder only
      continue;
    }
    const heading = readme.match(/^#\s+(.+)$/m)?.[1];
    const c = COMPONENT_COPY[id];
    if (!c) console.log(`catalog: no copy for component ${id}; its description comes from its README`);
    components.push({
      id,
      title: c?.title ?? (heading && heading !== id ? heading.replace(/\s*\(.*\)\s*$/, '') : titleCase(id)),
      description: c?.description ?? (firstParagraph(readme) || bulletFor(id) || leadingComment(index)),
      change: c?.change ?? [],
      plugins: importedPlugins(dir).map((d) => byDir[d].name),
      compositions: compositionIds(index),
      hero: c?.media?.hero ? clip(c.media.hero, `components/${id}/hero`) : null,
    });
  }
  return { plugins, components, skipped };
}

/**
 * The motion components: one entry per composition a components/<kind>/ folder registers and KIND_COPY has copy for, with the
 * kind as `category` and the props read from its zod schema. Maps are not in KIND_DIRS yet.
 */
function buildKinds() {
  const found = [];
  for (const kind of KIND_DIRS) {
    const dir = join(root, 'components', kind);
    if (!existsSync(join(dir, 'index.tsx'))) {
      console.log(`catalog: no components/${kind}/index.tsx; skipped`);
      continue;
    }
    for (const { id: compId, props } of readCompositions(dir)) {
      const c = KIND_COPY[compId];
      if (!c) {
        console.log(`catalog: no copy for ${kind}/${compId}; left out`);
        continue;
      }
      const id = compId.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase();
      const from = `components/${kind}/out/${c.preview}`;
      const hasPreview = existsSync(join(root, from));
      if (!hasPreview) console.log(`catalog: missing preview ${from}; ${id} has no media`);
      found.push({
        id,
        title: c.title,
        description: c.description,
        change: [],
        plugins: [],
        compositions: [compId],
        hero: hasPreview ? clip({ from, at: c.at, len: c.len, kb: 300 }, `components/${id}/hero`) : null,
        category: kind,
        props,
      });
    }
  }
  return found;
}

let plugins, components, skipped;
const kinds = buildKinds();
if (kindsOnly) {
  // Everything else stays as committed; the kind components replace the ones the last run wrote, in KIND_DIRS order after the rest.
  const kept = JSON.parse(readFileSync(out, 'utf8'));
  plugins = kept.plugins;
  components = [...kept.components.filter((c) => !c.category), ...kinds];
  skipped = [];
} else {
  ({ plugins, components, skipped } = buildCore());
  components.push(...kinds);
}

writeFileSync(out, JSON.stringify({ plugins, components }, null, 2) + '\n');
console.log(`catalog: ${plugins.length} plugins, ${components.length} components -> ${out}`);
if (withMedia) console.log(`catalog: ${clipCount} clips, ${(mediaBytes / 1048576).toFixed(1)} MB of media added (clips and their posters, presets not counted)`);
if (skipped.length) console.log(`catalog: skipped without index.tsx: ${skipped.join(', ')}`);
