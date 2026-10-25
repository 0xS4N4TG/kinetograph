// CSS of a HyperFrames page, rewritten for the engine: a mounted composition's rules are scoped to the composition
// (HyperFrames scopes them the same way, so two compositions can both style `.title`), the page's `html` and `body`
// rules apply to the two wrapper elements the runtime builds, and Google Fonts imports become font loads.

import postcss, { type AtRule, type Node, type Rule } from 'postcss';

const escapeAttr = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `[data-composition-id="id"]`. */
export const compositionSelector = (id: string): string => `[data-composition-id="${escapeAttr(id)}"]`;

const GLOBAL_AT_RULES = new Set(['keyframes', '-webkit-keyframes', 'font-face', 'property', 'counter-style']);

function inGlobalAtRule(rule: Rule): boolean {
  for (let node: Node['parent'] = rule.parent; node; node = node.parent) {
    if (node.type === 'atrule' && GLOBAL_AT_RULES.has((node as AtRule).name.toLowerCase())) return true;
  }
  return false;
}

/** A rule inside another rule (CSS nesting) already has its parent's scope. */
function nestedInRule(rule: Rule): boolean {
  for (let node: Node['parent'] = rule.parent; node; node = node.parent) if (node.type === 'rule') return true;
  return false;
}

function rewriteRules(css: string, selector: (selector: string) => string): string {
  let root: postcss.Root;
  try {
    root = postcss.parse(css);
  } catch {
    return css;
  }
  root.walkRules((rule) => {
    if (inGlobalAtRule(rule) || nestedInRule(rule)) return;
    rule.selectors = rule.selectors.map(selector);
  });
  return root.toResult({ map: false }).css;
}

/**
 * The rules of a mounted composition scoped to it. A selector that already names the composition's root stays; `html`,
 * `body` and `:root` alone are the composition's own box; any other gets the composition's selector in front. Rules
 * written for the root's id (`#root { … }`) apply to the host, which takes the root's place.
 */
export function scopeToComposition(css: string, compositionId: string, rootId?: string | null): string {
  const scope = compositionSelector(compositionId);
  const own = new RegExp(`\\[\\s*data-composition-id\\s*=\\s*(["'])${escapeRegExp(compositionId)}\\1\\s*\\]`, 'g');
  // The timing attributes a root selector may carry (`[data-composition-id="x"][data-start="0"]`) are the host's too.
  const timing = /\[\s*data-(?:start|duration)\s*=\s*(?:"[^"]*"|'[^']*')\s*\]/g;
  const rootIdToken = rootId ? new RegExp(`#${escapeRegExp(rootId)}(?![\\w-])`, 'g') : null;
  return rewriteRules(css, (selector) => {
    const text = selector.trim();
    if (text === '' || text === '*') return selector;
    if (/^(html|body|:root)$/i.test(text)) return scope;
    let rewritten = text;
    if (rootIdToken !== null) rewritten = rewritten.replace(rootIdToken, scope);
    own.lastIndex = 0;
    if (own.test(rewritten)) return rewritten.replace(timing, '');
    return `${scope} ${rewritten}`;
  });
}

/** The page's own `html` and `body` selectors, which match the runtime's wrapper elements. */
export function rewriteDocumentSelectors(css: string): string {
  return rewriteRules(css, (selector) =>
    selector.replace(/(^|[\s>+~,(])(html|body)(?![\w-])/gi, (_m, before: string, tag: string) => `${before}.kg-hf-${tag.toLowerCase()}`),
  );
}

export interface GoogleFontRequest {
  family: string;
  variants: string[];
}

/**
 * The families a Google Fonts CSS URL asks for, with their weights (`400`) and italic weights (`400i`):
 * `css2?family=Name:ital,wght@0,400;1,700&family=Other:wght@300..500`, or the older `css?family=Name:400,700italic`.
 */
export function parseGoogleFontsUrl(url: string): GoogleFontRequest[] {
  let parsed: URL;
  try {
    parsed = new URL(url, 'https://fonts.googleapis.com');
  } catch {
    return [];
  }
  if (parsed.hostname !== 'fonts.googleapis.com') return [];
  const out: GoogleFontRequest[] = [];
  for (const value of parsed.searchParams.getAll('family')) {
    const colon = value.indexOf(':');
    const family = (colon < 0 ? value : value.slice(0, colon)).replace(/\+/g, ' ').trim();
    if (family === '') continue;
    const spec = colon < 0 ? '' : value.slice(colon + 1);
    const variants = new Set<string>();
    const at = spec.indexOf('@');
    if (at >= 0) {
      const axes = spec.slice(0, at).split(',');
      const italAt = axes.indexOf('ital');
      const wghtAt = axes.indexOf('wght');
      for (const tuple of spec.slice(at + 1).split(';')) {
        const parts = tuple.split(',');
        const italic = italAt >= 0 && parts[italAt] === '1';
        const weight = wghtAt >= 0 ? parts[wghtAt] : '400';
        const range = /^(\d+)\.\.(\d+)$/.exec(weight ?? '');
        const weights = range
          ? Array.from({ length: Math.floor((Number(range[2]) - Number(range[1])) / 100) + 1 }, (_, i) => String(Number(range[1]) + i * 100))
          : [weight ?? '400'];
        for (const w of weights) variants.add(italic ? `${w}i` : w);
      }
    } else if (spec !== '') {
      for (const item of spec.split(',')) {
        const m = /^(\d+)?(italic)?$/.exec(item.trim());
        if (m) variants.add(`${m[1] ?? '400'}${m[2] ? 'i' : ''}`);
      }
    }
    if (variants.size === 0) variants.add('400');
    out.push({ family, variants: [...variants] });
  }
  return out;
}

/** `@import url(https://fonts.googleapis.com/…)` rules removed from the CSS, with the fonts they asked for. */
export function extractGoogleFontImports(css: string): { css: string; fonts: GoogleFontRequest[] } {
  const fonts: GoogleFontRequest[] = [];
  const rest = css.replace(/@import\s+(?:url\(\s*)?(['"]?)(https?:\/\/fonts\.googleapis\.com\/[^'")\s;]+)\1\s*\)?[^;]*;/gi, (_m, _q: string, url: string) => {
    fonts.push(...parseGoogleFontsUrl(url.replace(/&amp;/g, '&')));
    return '';
  });
  return { css: rest, fonts };
}

export interface CrossingRule {
  /** The `@media` conditions the rule is inside (all must hold), outermost first. */
  media?: string[];
  selector: string;
  declarations: [string, string][];
  specificity: [number, number, number];
  order: number;
}

/** `[ids, classes and attributes and pseudo-classes, types]` of one selector. */
export function specificityOf(selector: string): [number, number, number] {
  const bare = selector.replace(/\[[^\]]*\]/g, ' [a] ').replace(/"[^"]*"|'[^']*'/g, '');
  const ids = (bare.match(/#[\w-]+/g) ?? []).length;
  const pseudoElements = (bare.match(/::[\w-]+/g) ?? []).length;
  const classes = (bare.match(/\.[\w-]+|\[a\]|(?<!:):(?!:)[\w-]+/g) ?? []).length;
  const types = (bare.replace(/#[\w-]+|\.[\w-]+|\[a\]|::?[\w-]+(\([^)]*\))?/g, ' ').match(/(?:^|[\s>+~(,])([a-zA-Z][\w-]*)/g) ?? []).length + pseudoElements;
  return [ids, classes, types];
}

/**
 * The rules of top-level CSS whose selector has a combinator, so it can need an element above an `<svg>`:
 * one entry per selector of the rule. `first` numbers them from there on.
 */
export function crossingRules(css: string, first: number): CrossingRule[] {
  let root: postcss.Root;
  try {
    root = postcss.parse(css);
  } catch {
    return [];
  }
  const out: CrossingRule[] = [];
  let order = first;
  const walk = (container: postcss.Root | postcss.AtRule, media: string[]): void => {
    container.each((node) => {
      if (node.type === 'atrule' && (node as AtRule).name.toLowerCase() === 'media' && (node as AtRule).nodes) {
        // The rules of an `@media` count where the query holds; the runtime asks `matchMedia` of the composition's size.
        walk(node as AtRule, [...media, (node as AtRule).params.trim()]);
        return;
      }
      if (node.type !== 'rule') {
        order++;
        return;
      }
      const declarations: [string, string][] = [];
      node.each((child) => {
        if (child.type === 'decl') declarations.push([child.prop, child.value]);
      });
      for (const selector of (node as Rule).selectors) {
        const text = selector.trim();
        if (/\s|>|\+|~/.test(text) && !text.includes('::') && declarations.length > 0) {
          out.push({ ...(media.length > 0 ? { media } : {}), selector: text, declarations, specificity: specificityOf(text), order });
        }
      }
      order++;
    });
  };
  walk(root, []);
  return out;
}
