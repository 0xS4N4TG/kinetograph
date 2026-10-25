// The fonts a HyperFrames page gets without asking for them. HyperFrames embeds 18 families in its renderer and gives a
// page that names one of them (or an operating-system font it maps to one) that family's files, under the name the page
// used (Apache-2.0, heygen-com/hyperframes: packages/parsers/src/fontAliases.ts for the map, packages/core/src/fonts/
// deterministicFonts.ts for the faces and for which CSS it reads). Here the same families come from Google Fonts through
// the font cache, which `kinetograph fetch-deps` fills; a render reads the cache and never downloads a font.
//
// Every family in this table is under the SIL Open Font License or Apache 2.0. `Arial`, `Helvetica` and the other
// sans-serif system names are Inter, as they are in HyperFrames (so a page lays out as it does there), not a metric
// clone of Arial. Operating-system fonts are never read.

import postcss from 'postcss';

/**
 * HyperFrames' bundled families: the Google Fonts family name and the weights it has. HyperFrames embeds 400, 700 (and 900
 * for some) and adds the other weights of the family from Google Fonts, so a page's `font-weight: 600` is the family's 600;
 * these are all the weights Google serves of each (normal style), asked for in one request that `fetch-deps` caches.
 */
export const BUNDLED: Record<string, { family: string; weights: string[] }> = {
  inter: { family: 'Inter', weights: ['100', '200', '300', '400', '500', '600', '700', '800', '900'] },
  montserrat: { family: 'Montserrat', weights: ['100', '200', '300', '400', '500', '600', '700', '800', '900'] },
  outfit: { family: 'Outfit', weights: ['100', '200', '300', '400', '500', '600', '700', '800', '900'] },
  nunito: { family: 'Nunito', weights: ['200', '300', '400', '500', '600', '700', '800', '900'] },
  oswald: { family: 'Oswald', weights: ['200', '300', '400', '500', '600', '700'] },
  'league-gothic': { family: 'League Gothic', weights: ['400'] },
  'archivo-black': { family: 'Archivo Black', weights: ['400'] },
  'space-mono': { family: 'Space Mono', weights: ['400', '700'] },
  'ibm-plex-mono': { family: 'IBM Plex Mono', weights: ['100', '200', '300', '400', '500', '600', '700'] },
  'jetbrains-mono': { family: 'JetBrains Mono', weights: ['100', '200', '300', '400', '500', '600', '700', '800'] },
  'eb-garamond': { family: 'EB Garamond', weights: ['400', '500', '600', '700', '800'] },
  'playfair-display': { family: 'Playfair Display', weights: ['400', '500', '600', '700', '800', '900'] },
  'source-code-pro': { family: 'Source Code Pro', weights: ['200', '300', '400', '500', '600', '700', '800', '900'] },
  'noto-sans-jp': { family: 'Noto Sans JP', weights: ['100', '200', '300', '400', '500', '600', '700', '800', '900'] },
  roboto: { family: 'Roboto', weights: ['100', '300', '400', '500', '700', '900'] },
  'open-sans': { family: 'Open Sans', weights: ['300', '400', '500', '600', '700', '800'] },
  lato: { family: 'Lato', weights: ['100', '300', '400', '700', '900'] },
  poppins: { family: 'Poppins', weights: ['100', '200', '300', '400', '500', '600', '700', '800', '900'] },
};

const SANS = 'inter';
const MONO = 'jetbrains-mono';
const SERIF = 'eb-garamond';

/** Lower-cased family name to a key of `BUNDLED`: the families themselves, then the names HyperFrames maps to one. */
export const FONT_ALIASES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(BUNDLED).map(([slug, f]) => [f.family.toLowerCase(), slug])),
  'helvetica neue': SANS, helvetica: SANS, arial: SANS, 'helvetica bold': SANS,
  futura: 'montserrat', 'din alternate': 'montserrat', 'arial black': 'montserrat',
  'bebas neue': 'league-gothic', 'courier new': MONO, courier: MONO, garamond: SERIF,
  'noto sans japanese': 'noto-sans-jp', 'segoe ui': 'roboto',
  'sf pro': SANS, 'sf pro display': SANS, 'sf pro text': SANS, 'sf pro rounded': SANS, avenir: SANS, 'avenir next': SANS,
  'lucida grande': SANS, geneva: SANS, optima: SANS,
  verdana: SANS, tahoma: SANS, 'trebuchet ms': SANS, calibri: SANS, candara: SANS, corbel: SANS, 'lucida sans': SANS, 'lucida sans unicode': SANS,
  'noto sans': SANS, 'dejavu sans': SANS, 'liberation sans': SANS,
  'sf mono': MONO, menlo: MONO, monaco: MONO, consolas: MONO, 'lucida console': MONO, 'lucida sans typewriter': MONO,
  'andale mono': MONO, 'dejavu sans mono': MONO, 'liberation mono': MONO,
  georgia: SERIF, palatino: SERIF, 'palatino linotype': SERIF, 'book antiqua': SERIF, cambria: SERIF, times: SERIF,
  'times new roman': SERIF, 'dejavu serif': SERIF, 'liberation serif': SERIF,
};

const GENERIC = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
  'math', 'emoji', 'fangsong', '-apple-system', 'blinkmacsystemfont', 'inherit', 'initial', 'unset', 'revert', 'revert-layer',
]);

/** The names in a `font-family` value (quotes and `!important` removed), in order. */
export function parseFamilyList(value: string): string[] {
  const names: string[] = [];
  let current = '';
  let quote = '';
  let depth = 0;
  const flush = (): void => {
    const name = current.trim().replace(/\s*!important\s*$/i, '').trim();
    if (name !== '') names.push(name.replace(/^(['"])(.*)\1$/, '$2').replace(/\s+/g, ' '));
    current = '';
  };
  for (const c of value) {
    if (quote !== '') {
      if (c === quote) quote = '';
      current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (c === '(') {
      depth++;
      current += c;
    } else if (c === ')') {
      depth--;
      current += c;
    } else if (c === ',' && depth === 0) flush();
    else current += c;
  }
  flush();
  return names;
}

export interface FontUse {
  /** Every family name the page's CSS, inline styles and `data-font-family` attributes name. */
  families: Set<string>;
  /** The families the page declares itself (`@font-face`), which it supplies. */
  declared: Set<string>;
  /** `--custom: a, b` declarations, for `font-family: var(--custom)`. */
  custom: Map<string, string>;
  /** `font-family` values read and not yet settled (a `var()` may name a property declared later). */
  pending: string[];
}

export const emptyUse = (): FontUse => ({ families: new Set(), declared: new Set(), custom: new Map(), pending: [] });

function resolveVar(value: string, custom: Map<string, string>, depth = 0): string {
  const m = /^\s*var\(\s*(--[\w-]+)\s*(?:,([^)]*))?\)\s*$/.exec(value);
  if (!m || depth > 6) return value;
  return resolveVar(custom.get(m[1]!) ?? m[2] ?? '', custom, depth + 1);
}

/** Reads the font-family declarations of CSS text (`@font-face` rules count as declaring their family). */
export function noteCss(use: FontUse, css: string): void {
  let root: postcss.Root;
  try {
    root = postcss.parse(css);
  } catch {
    return;
  }
  root.walkDecls((decl) => {
    const prop = decl.prop.toLowerCase();
    if (prop.startsWith('--')) {
      use.custom.set(prop, decl.value);
      return;
    }
    if (prop !== 'font-family') return;
    const parent = decl.parent;
    if (parent?.type === 'atrule' && (parent as postcss.AtRule).name.toLowerCase() === 'font-face') {
      for (const name of parseFamilyList(decl.value)) use.declared.add(name.toLowerCase());
      return;
    }
    use.pending.push(decl.value);
  });
}

/** An inline `style` attribute or a `data-font-family` value. */
export function noteInline(use: FontUse, style: string): void {
  noteCss(use, `*{${style}}`);
}

export function noteFamilyValue(use: FontUse, value: string): void {
  use.pending.push(value);
}

/** Settles the `var()` references and gathers the names. */
export function finishUse(use: FontUse): void {
  for (const value of use.pending.splice(0)) {
    for (const name of parseFamilyList(resolveVar(value, use.custom))) use.families.add(name);
  }
}

export interface BundledUse {
  /** Google Fonts family name. */
  family: string;
  weights: string[];
  /** Names the page uses for it, other than its own. */
  as: string[];
}

/**
 * The bundled families the page's CSS asks for: a name in the table, not declared by the page and not loaded from
 * Google Fonts by a link (those load as the page says), with the other names that map to the same family.
 */
export function bundledUses(use: FontUse, linked: ReadonlySet<string>): BundledUse[] {
  const byFamily = new Map<string, BundledUse>();
  for (const name of use.families) {
    const lower = name.toLowerCase();
    if (GENERIC.has(lower) || use.declared.has(lower)) continue;
    const slug = FONT_ALIASES[lower];
    if (slug === undefined) continue;
    const bundled = BUNDLED[slug]!;
    if (linked.has(bundled.family.toLowerCase()) && lower === bundled.family.toLowerCase()) continue;
    const entry = byFamily.get(bundled.family) ?? { family: bundled.family, weights: bundled.weights, as: [] };
    if (lower !== bundled.family.toLowerCase() && !entry.as.includes(name)) entry.as.push(name);
    byFamily.set(bundled.family, entry);
  }
  return [...byFamily.values()];
}
