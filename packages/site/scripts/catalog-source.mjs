// Reads facts out of a plugin's TypeScript source, for catalog.mjs: the public exports with their JSDoc and props, the
// Hexed genes, the VJ look kinds, the Paper lists, the Kinetic Typography faces. Regex scanning, not a TypeScript
// parse: it is meant for the way these plugins are written (one export per line, a JSDoc block directly above).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const plain = (s) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();

/** The JSDoc block that ends on line i - 1, as plain text; '' when there is none. */
function docAbove(lines, i) {
  if (i === 0 || !lines[i - 1].trim().endsWith('*/')) return '';
  let j = i - 1;
  while (j >= 0 && !lines[j].includes('/**')) j--;
  if (j < 0) return '';
  return lines
    .slice(j, i)
    .join('\n')
    .replace(/^\s*\/\*\*/, '')
    .replace(/\*\/\s*$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim();
}

/** First sentence and the rest of a doc comment. */
function split(doc) {
  const t = plain(doc);
  if (!t) return { summary: '', detail: '' };
  const m = t.match(/^.+?(?:[.!?](?=\s+[A-Z0-9])|$)/);
  const summary = (m?.[0] ?? t).trim();
  const detail = t.slice(summary.length).trim();
  return { summary: summary.charAt(0).toUpperCase() + summary.slice(1), detail };
}

/** The exported interfaces of one file: { Name: { extends: [..], props: [{ name, type, optional, doc }] } }. */
function interfacesIn(lines) {
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^export interface (\w+)(?:\s+extends\s+([\w, ]+?))?\s*\{\s*(.*)$/);
    if (!m) continue;
    const props = [];
    let doc = '';
    for (let j = i + 1; j < lines.length && !/^\}/.test(lines[j]); j++) {
      const line = lines[j];
      if (/^\s*\/\*\*/.test(line)) {
        const k = lines.findIndex((l, n) => n >= j && l.includes('*/'));
        doc = plain(docAbove(lines, k + 1) || '');
        j = k;
        continue;
      }
      const f = line.match(/^\s{2}(\w+)(\?)?:\s*(.*?);?\s*(?:\/\/.*)?$/);
      if (f) {
        props.push({ name: f[1], type: f[3].length > 70 ? `${f[3].slice(0, 67)}...` : f[3], optional: Boolean(f[2]), doc });
        doc = '';
      }
    }
    out[m[1]] = { extends: (m[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean), props };
  }
  return out;
}

/** The value exports of one file: { Name: { kind, summary, detail, sig } }. */
function exportsIn(lines, file) {
  const out = {};
  const tsx = file.endsWith('.tsx');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^export\s+(?:async\s+)?(function|const|class)\s+(\w+)/);
    if (!m) continue;
    const [, what, name] = m;
    let end = i + 1;
    while (end < Math.min(lines.length, i + 6) && !/^(export|\/\*\*|\/\/)/.test(lines[end])) end++;
    const sig = lines.slice(i, end).join(' ').slice(0, 320);
    let kind;
    if (what === 'class') kind = 'function';
    else if (what === 'function') {
      kind = /^[A-Z]/.test(name) && tsx ? 'component' : /\)\s*:\s*[^{]*\bEffect\b/.test(sig) ? 'effect' : 'function';
    } else if (/:\s*React\.FC\b/.test(sig)) kind = 'component';
    else if (/^export const \w+\s*(?::[^=]*)?=\s*(?!\(\s*\[)(?:async\s*)?(?:\([^=]*\)|\w+)\s*(?::[^=]+)?=>/.test(sig)) {
      kind = /^[A-Z]/.test(name) && tsx ? 'component' : /\bEffect\b/.test(sig.split('=>')[0]) ? 'effect' : 'function';
    } else kind = 'constant';
    out[name] = { kind, ...split(docAbove(lines, i)), sig, file };
  }
  return out;
}

/** The names a plugin's src/index.ts re-exports as values, each with the file it comes from. */
function publicNames(srcDir) {
  const index = read(join(srcDir, 'index.ts'));
  const names = [];
  for (const m of index.matchAll(/export\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    const from = join(srcDir, m[2].replace(/\.js$/, ''));
    for (const n of m[1].split(',').map((s) => s.trim()).filter(Boolean)) names.push({ name: n.replace(/\s+as\s+.*/, ''), from });
  }
  return names;
}

const sourceFiles = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && f !== 'index.ts').map((f) => join(dir, f)) : [];

/**
 * A plugin's public API from source: components, effects, functions and constants, each with its JSDoc summary, and for
 * a component or an effect taking an options interface, that interface's props. `unparsed` lists public names whose
 * definition was not found.
 */
export function readExports(pluginDir) {
  const srcDir = join(pluginDir, 'src');
  const defs = {};
  const interfaces = {};
  const files = [...sourceFiles(srcDir), ...sourceFiles(join(pluginDir, 'presets'))];
  const presetIndex = join(pluginDir, 'presets', 'index.ts');
  if (existsSync(presetIndex) && !files.includes(presetIndex)) files.push(presetIndex);
  for (const f of files) {
    const lines = read(f).split('\n');
    Object.assign(interfaces, interfacesIn(lines));
    for (const [n, d] of Object.entries(exportsIn(lines, f))) if (!defs[n] || f.startsWith(srcDir)) defs[n] = d;
  }
  const propsOf = (name, seen = new Set()) => {
    const i = interfaces[name];
    if (!i || seen.has(name)) return [];
    seen.add(name);
    return [...i.props, ...i.extends.flatMap((e) => propsOf(e, seen))];
  };
  const items = [];
  const unparsed = [];
  for (const { name } of publicNames(srcDir)) {
    const d = defs[name];
    if (!d) {
      unparsed.push(name);
      continue;
    }
    const typeName =
      d.kind === 'component'
        ? (d.sig.match(/React\.FC<(\w+)>/) ?? d.sig.match(/\}\s*:\s*(\w+)/) ?? d.sig.match(/\(\s*\w+\s*:\s*(\w+)/))?.[1]
        : d.kind === 'constant'
          ? undefined
          : d.sig.match(/\(\s*\w+\??\s*:\s*(\w+)/)?.[1];
    const used = typeName && interfaces[typeName] ? typeName : undefined;
    const props = used ? propsOf(used) : [];
    items.push({
      name,
      kind: d.kind,
      summary: d.summary,
      detail: d.detail,
      ...(props.length ? { propsOf: used, props } : {}),
    });
  }
  return { items, unparsed };
}

/** `'a', 'b'` strings of the first array literal after `marker` in src. */
function stringsAfter(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) return [];
  const eq = src.indexOf('=', at);
  const open = src.indexOf('[', marker.endsWith(':') && (eq < 0 || eq > src.indexOf('\n', at)) ? at : eq);
  const close = src.indexOf(']', open);
  return [...src.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/**
 * Hexed's genes by slot: ids from gene-ids.ts, the slot's note from SLOT_NOTES, and each gene's note from the comment
 * above it in genes.ts or motion.ts (`fallback` supplies a hand-written note where the source has none).
 */
export function readHexed(pluginDir, fallback = {}) {
  const src = join(pluginDir, 'src');
  const ids = read(join(src, 'gene-ids.ts'));
  const slotsSrc = read(join(src, 'slots.ts'));
  const order = stringsAfter(slotsSrc, 'export const SLOTS');
  const slotNotes = Object.fromEntries([...slotsSrc.matchAll(/^\s{2}(\w+):\s*'([^']*)',?$/gm)].map((m) => [m[1], m[2]]));
  const pools = { ISOLATE: 'isolate', GRADE: 'grade', SCREEN: 'screen', OPTICS: 'optics', DAMAGE: 'damage', MIRROR: 'mirror', CROP: 'crop', SHAKE: 'shake', FPS: 'fps' };
  const notes = {};
  for (const f of ['genes.ts', 'motion.ts']) {
    let slot = '';
    let pending = [];
    for (const line of read(join(src, f)).split('\n')) {
      const pool = line.match(/^export const (\w+)\b/)?.[1];
      if (pool) slot = pools[pool] ?? '';
      const c = line.match(/^\s*\/\/\s?(.*)$/);
      if (c) {
        if (!c[1].startsWith('----')) pending.push(c[1]);
        continue;
      }
      const id = line.match(/\bid:\s*'([^']+)'/)?.[1];
      if (id && slot && pending.length) notes[`${slot}/${id}`] = plain(pending.join(' ')).replace(/^./, (x) => x.toUpperCase());
      if (id || !/^\s*\{\s*$/.test(line)) pending = [];
    }
  }
  const slots = [];
  const genes = {};
  for (const slot of order) {
    const list = stringsAfter(ids, `  ${slot}:`).filter((g) => g !== 'none');
    genes[slot] = list;
    slots.push({
      slot,
      note: slotNotes[slot] ?? '',
      genes: list.map((id) => ({ id, note: notes[`${slot}/${id}`] ?? fallback[`${slot}/${id}`] ?? '' })),
    });
  }
  return { slots, missing: slots.flatMap((s) => s.genes.filter((g) => !g.note).map((g) => `${s.slot}/${g.id}`)) };
}

/** VJ's look kinds, each with the export that draws it (found in lookEffects' switch). */
export function readVj(pluginDir, exportsList) {
  const kinds = stringsAfter(read(join(pluginDir, 'src', 'schema.ts')), 'export const LOOK_KINDS');
  const looks = read(join(pluginDir, 'src', 'looks.ts'));
  const body = looks.slice(looks.indexOf('export function lookEffects'));
  const names = exportsList.map((e) => e.name).filter((n) => n !== 'lookEffects' && n !== 'switchOff');
  const out = kinds.map((kind) => {
    if (kind === 'none') return { kind, uses: '', summary: 'No look.' };
    const block = body.split(`case '${kind}'`)[1]?.split(/\n\s*case '/)[0] ?? '';
    let uses = '';
    let best = Infinity;
    for (const n of names) {
      const at = block.search(new RegExp(`\\b${n}\\(`));
      if (at >= 0 && at < best) [uses, best] = [n, at];
    }
    return { kind, uses, summary: exportsList.find((e) => e.name === uses)?.summary ?? '' };
  });
  return out;
}

/** Paper's lists: stock names, edge styles, page layouts, and the texture scans. */
export function readPaper(pluginDir) {
  const src = join(pluginDir, 'src');
  const schema = read(join(src, 'schema.ts'));
  return {
    stocks: stringsAfter(schema, 'export const STOCK_NAMES'),
    edges: stringsAfter(schema, 'export const EDGE_STYLES'),
    layouts: stringsAfter(read(join(src, 'layouts.ts')), 'export const LAYOUTS'),
    textures: [...read(join(pluginDir, 'textures', 'index.ts')).matchAll(/^\s{2}(\w+):\s*'data:/gm)].map((m) => m[1]),
  };
}

/** Kinetic Typography's faces, read from the font() calls in hands.tsx. */
export function readKinetic(pluginDir) {
  const src = read(join(pluginDir, 'src', 'hands.tsx'));
  const words = (s) => s.replace(/([a-z])([A-Z])/g, '$1 $2');
  const handsBlock = src.slice(src.indexOf('export const HANDS'), src.indexOf('];', src.indexOf('export const HANDS')));
  return {
    hands: [...handsBlock.matchAll(/font\('(\w+)'/g)].map((m) => words(m[1])),
    display: [...src.matchAll(/^export const (?:SERIF|HEAVY) = font\('(\w+)'/gm)].map((m) => words(m[1])),
  };
}

/** The id of every composition an effect folder's index registers. */
export const compositionIds = (src) => [...src.matchAll(/<Composition\b[\s\S]*?\bid=["'](\w+)["']/g)].map((m) => m[1]);
