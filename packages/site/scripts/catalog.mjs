// Writes content/catalog.json from the kinetograph-ui checkout: its plugins, components, templates and tastes.
//   KINETOGRAPH_UI=/path/to/kinetograph-ui node scripts/catalog.mjs [--media] [--missing] [--kinds] [--templates] [--tastes]
// --missing, with --media, cuts only the clips and stills that are not in public/catalog yet and keeps the others as they are.
// The checkout defaults to the folder next to this repo (../kinetograph-ui).
// --kinds touches only the motion components (components/<kind>/ of the checkout, listed in KIND_DIRS): it keeps everything else of the
// committed catalog.json as it is, replaces the kind components, and with --media cuts only their clips.
// --templates does the same for the templates (templates/<id>/ and the pieces in components/showcase, see SHOWCASE_COPY).
// --tastes does the same for the tastes (tastes/<dir>/ of the checkout, listed in TASTE_COPY).
// Without the checkout it prints a message and leaves the committed catalog.json alone.
// --media also extracts the stills and clips named in catalog-copy.mjs to public/catalog/. A still is a frame of a render in
// the checkout's templates/<x>/out/ (or a png) as webp, 1280 px on the long side and under 250 KB. A clip is a cut of a render,
// 4 s by default and 6 s at most, as H.264 at 1280 px on the long side, no audio, at most about 1.5 MB, with its first frame as
// the poster. It needs ffmpeg, ffprobe, libx264 and cwebp. It clears public/catalog first and prints the media total.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_TEXT, EXPORT_NOTES, GENE_NOTES, PLUGIN_COPY, TEMPLATE_COPY, KIND_COPY, KIND_DIRS, SHOWCASE_COPY, TASTE_COPY } from './catalog-copy.mjs';
import { compositionIds, readCompositions, readExports, readHexed, readKinetic, readPaper, readVj } from './catalog-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.KINETOGRAPH_UI ?? join(here, '../../../../kinetograph-ui'));
const out = join(here, '../content/catalog.json');
const pub = join(here, '../public');
const withMedia = process.argv.includes('--media');
const kindsOnly = process.argv.includes('--kinds');
const tastesOnly = process.argv.includes('--tastes');
const templatesOnly = process.argv.includes('--templates');
if (withMedia && !kindsOnly && !tastesOnly && !templatesOnly && !process.argv.includes('--missing') && existsSync(join(root, 'plugins'))) rmSync(join(pub, 'catalog'), { recursive: true, force: true });

if (!existsSync(join(root, 'plugins'))) {
  console.log(`catalog: no kinetograph-ui at ${root}; set KINETOGRAPH_UI. Keeping ${out}.`);
  process.exit(0);
}

/** Showrooms of a plugin: listed under the plugins they demo (folder names), never as templates. */
const DEMOS = {
  'match-cut': { title: 'Match cut presets', plugins: ['paper'] },
  'paper-photo': { title: 'Paper photo effects', plugins: ['paper'] },
  'kinetic-type-demo': { title: 'Caption styles and hand captions', plugins: ['kinetic-typography'] },
  'vj-demo': { title: 'VJ looks and tracking', plugins: ['vj'] },
  'hexed-demo': { title: 'Hexed rolls', plugins: ['hexed'] },
  'plugin-ui-demo': { title: 'Studio panels', plugins: ['hexed', 'paper', 'vj', 'kinetic-typography'] },
};
/** Folders of templates/ that stay off the site. */
const EXCLUDED = new Set(['mikiwho-reel', 'inside', 'cyberpunk-reel', 'wish-reel', 'lyric-reel', 'looks-demo', 'papercut-demo']);

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

const repoReadme = read(join(root, 'templates/README.md'));
/** The templates README's bullet for `<id>`, minus its name. */
function bulletFor(id) {
  const lines = repoReadme.split('\n');
  const i = lines.findIndex((l) => l.startsWith(`- \`${id}\`:`));
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
/** Whether to write `file` now: with --media, and with --templates or --missing only when it is not there yet (committed clips stay as they are). */
const missingOnly = templatesOnly || process.argv.includes('--missing');
const cut = (file) => withMedia && !(missingOnly && existsSync(file));
/**
 * One still: a media entry { from, at?, caption? } becomes public/catalog/<dest>.webp (extracted when --media is on).
 * Returns what the pages read: the src, the size, and where it came from, so the catalog says how to make it again.
 */
function still(entry, dest) {
  const file = join(pub, 'catalog', `${dest}.webp`);
  if (cut(file)) {
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
  const len = Math.min(entry.len ?? 4, entry.max ?? 6);
  const key = `${entry.from}|${at}|${len}`;
  let hit = clipCache.get(key);
  if (!hit) {
    const file = join(pub, 'catalog', `${dest}.mp4`);
    const poster = still({ from: entry.from, at }, dest);
    if (cut(file)) {
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
      source: `plugins/${d}`,
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

  // Templates: demos go under the plugins they import, the rest are templates.
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
  for (const id of dirs(join(root, 'templates'))) {
    if (EXCLUDED.has(id)) continue;
    const dir = join(root, 'templates', id);
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
      skipped.push(id); // nothing to render: no entry file
      continue;
    }
    const heading = readme.match(/^#\s+(.+)$/m)?.[1];
    const c = TEMPLATE_COPY[id];
    if (!c) console.log(`catalog: no copy for template ${id}; its description comes from its README`);
    templates.push({
      id,
      title: c?.title ?? (heading && heading !== id ? heading.replace(/\s*\(.*\)\s*$/, '') : titleCase(id)),
      description: c?.description ?? (firstParagraph(readme) || bulletFor(id) || leadingComment(index)),
      change: c?.change ?? [],
      plugins: importedPlugins(dir).map((d) => byDir[d].name),
      compositions: compositionIds(index),
      hero: c?.media?.hero ? clip(c.media.hero, `components/${id}/hero`) : null,
      source: `templates/${id}`,
    });
  }
  return { plugins, templates, skipped };
}

/**
 * A prop's doc as the site shows it: the checkout's comments sometimes say what a number was measured against or whose chart
 * palette it follows. That never goes on the site, so those parentheses and sentences are dropped and the rest is kept.
 */
function cleanDoc(doc) {
  const t = doc
    .replace(/\s*\([^()]*\b(?:reference|bklit)\b[^()]*\)/gi, '')
    .replace(/\bbklit\s+/gi, '')
    .replace(/\bthe reference (curve|spacing)\b/gi, 'the default $1')
    .split(/(?<=\.)\s+/)
    .filter((sentence) => !/\breference\b/i.test(sentence))
    .join(' ')
    .trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
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
    // KIND_COPY's order decides, not where the file registers them.
    const order = (c) => Object.keys(KIND_COPY).indexOf(c.id);
    for (const { id: compId, props } of readCompositions(dir).sort((a, b) => order(a) - order(b))) {
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
        source: `components/${kind}`,
        props: props.map((p) => ({ ...p, doc: cleanDoc(p.doc) })),
      });
    }
  }
  return found;
}

/**
 * The device and product pieces of components/showcase, listed as templates: one entry per composition the folder registers and
 * SHOWCASE_COPY has copy for, in SHOWCASE_COPY's order. A piece whose render is missing gets no media.
 */
function buildShowcase() {
  const dir = join(root, 'components/showcase');
  const order = (c) => Object.keys(SHOWCASE_COPY).indexOf(c.id);
  const found = [];
  for (const { id: compId, props } of readCompositions(dir).sort((a, b) => order(a) - order(b))) {
    const c = SHOWCASE_COPY[compId];
    if (!c) {
      console.log(`catalog: no copy for showcase/${compId}; left out`);
      continue;
    }
    const id = compId.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase();
    const from = `components/showcase/out/${c.preview}`;
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
      props: props.map((p) => ({ ...p, doc: cleanDoc(p.doc) })),
      source: 'components/showcase',
    });
  }
  return found;
}

/** The tastes: one entry per TASTE_COPY row whose tastes/<dir> and demo render exist; the rest are left out with a message. */
function buildTastes() {
  const found = [];
  for (const [id, c] of Object.entries(TASTE_COPY)) {
    const hasKit = existsSync(join(root, 'tastes', c.dir));
    const hasRender = existsSync(join(root, c.src));
    if (!hasKit || !hasRender) {
      console.log(`catalog: taste ${id} left out (${hasKit ? 'no render ' + c.src : 'no tastes/' + c.dir})`);
      continue;
    }
    found.push({ id, title: c.title, description: c.description, hero: clip({ from: c.src, at: c.at, len: c.len, kb: 300 }, `tastes/${id}/hero`), source: `tastes/${c.dir}` });
  }
  return found;
}

let plugins, components, templates, skipped;
const tastes = buildTastes();
const kinds = tastesOnly || templatesOnly ? [] : buildKinds();
const showcase = tastesOnly || kindsOnly ? [] : buildShowcase();
if (tastesOnly) {
  ({ plugins, components, templates } = JSON.parse(readFileSync(out, 'utf8')));
  skipped = [];
} else if (kindsOnly || templatesOnly) {
  // Everything else stays as committed. --kinds replaces the kind components; --templates the templates, the showcase pieces last.
  const kept = JSON.parse(readFileSync(out, 'utf8'));
  plugins = kept.plugins;
  // A catalog from before templates had their own list has the scenes and the showcase pieces among its components: drop them.
  const keptComponents = kept.components.filter((c) => c.category && c.category !== 'showcase');
  components = kindsOnly ? kinds : keptComponents;
  templates = kindsOnly ? (kept.templates ?? []) : [...buildCore().templates, ...showcase];
  skipped = [];
} else {
  ({ plugins, templates, skipped } = buildCore());
  templates.push(...showcase);
  components = kinds;
}

writeFileSync(out, JSON.stringify({ plugins, components, templates, tastes }, null, 2) + '\n');
console.log(`catalog: ${plugins.length} plugins, ${components.length} components, ${templates.length} templates, ${tastes.length} tastes -> ${out}`);
if (withMedia) console.log(`catalog: ${clipCount} clips, ${(mediaBytes / 1048576).toFixed(1)} MB of media added (clips and their posters, presets not counted)`);
if (skipped.length) console.log(`catalog: skipped without index.tsx: ${skipped.join(', ')}`);
