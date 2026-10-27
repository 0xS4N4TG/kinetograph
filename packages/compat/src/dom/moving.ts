// Whether an island's CSS can start a transition or an animation on an element of its trees: the TS side of
// `crates/dom/src/moving.rs`. The engine replays an island's history only when its own check (`document::moves`)
// says something can move; this one says so in every case that one does, and more (it follows less: an escaped,
// non-ASCII or namespaced selector always counts), so a history it leaves out is one the engine would not read.

import type { RequestNode } from '../request/build.js';

const mentions = (css: string): boolean => css.includes('transition') || css.includes('animation') || css.includes('starting-style');

interface Present {
  classes: Set<string>;
  ids: Set<string>;
  tags: Set<string>;
}

/** What the engine wraps an island in (`document::build_root`). */
const WRAPPER_TAGS = ['html', 'head', 'body', 'div', 'style', 'kg-native'];

function presentIn(trees: readonly RequestNode[]): Present {
  const present: Present = { classes: new Set(), ids: new Set(), tags: new Set(WRAPPER_TAGS) };
  const walk = (node: RequestNode): void => {
    if (node.kind !== 'element') return;
    present.tags.add(node.tag.toLowerCase());
    const cls = node.attrs.class;
    if (cls !== undefined) for (const name of cls.split(/[\t\n\f\r ]+/)) if (name !== '') present.classes.add(name.toLowerCase());
    const id = node.attrs.id;
    if (id !== undefined) present.ids.add(id.toLowerCase());
    for (const child of node.children) walk(child);
  };
  for (const tree of trees) walk(tree);
  return present;
}

/** A `style` or a `<style>` element that mentions a transition or an animation. */
function inlineMoves(node: RequestNode, sheet: boolean): boolean {
  if (node.kind === 'text') return sheet && mentions(node.text);
  if (node.kind === 'native') return false;
  if (mentions(node.style)) return true;
  const attr = node.attrs.style;
  if (attr !== undefined && mentions(attr)) return true;
  return node.children.some((child) => inlineMoves(child, node.tag === 'style'));
}

/** Whether the island's sheets, `style`s or `<style>` elements can start a transition or an animation on an element of `trees`. */
export function islandMoves(stylesheets: readonly string[], trees: readonly RequestNode[]): boolean {
  if (trees.some((tree) => inlineMoves(tree, false))) return true;
  let present: Present | undefined;
  for (const sheet of stylesheets) {
    if (!mentions(sheet)) continue;
    present ??= presentIn(trees);
    if (sheetMoves(sheet, present)) return true;
  }
  return false;
}

const SKIPPED_AT_RULES = new Set(['keyframes', '-webkit-keyframes', '-moz-keyframes', 'font-face', 'property', 'page', 'counter-style', 'font-feature-values', 'font-palette-values']);

/** Thrown when the scan loses its place: the sheet counts as moving. */
class Lost extends Error {}

function sheetMoves(raw: string, present: Present): boolean {
  // Anything escaped or outside ASCII is not followed.
  if (raw.includes('\\') || /[^\x00-\x7f]/.test(raw)) return true;
  const css = stripComments(raw);
  let i = 0;

  type End = ';' | '{' | '}' | 'eof';
  const chunk = (): [string, End] => {
    const start = i;
    let depth = 0;
    while (i < css.length) {
      const c = css[i]!;
      if (c === '"' || c === "'") {
        i = skipString(css, i, c);
        continue;
      }
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
      else if (depth === 0 && (c === ';' || c === '{' || c === '}')) {
        const text = css.slice(start, i);
        i++;
        return [text, c];
      }
      i++;
    }
    return [css.slice(start), 'eof'];
  };

  const skipBlock = (): void => {
    for (;;) {
      const [, end] = chunk();
      if (end === '{') skipBlock();
      else if (end === '}') return;
      else if (end === 'eof') throw new Lost();
    }
  };

  // `inside`: whether the style rule the block belongs to can match an element (undefined: none).
  const rules = (inside: boolean | undefined, top: boolean): boolean => {
    for (;;) {
      const [raw, end] = chunk();
      const text = raw.trim();
      if (end === 'eof') {
        if (!top) throw new Lost();
        return declaration(text, inside);
      }
      if (end === '}') {
        if (top) throw new Lost();
        return declaration(text, inside);
      }
      if (end === ';') {
        if (text.startsWith('@')) {
          if (text.slice(1).toLowerCase().startsWith('import')) return true;
        } else if (declaration(text, inside)) return true;
        continue;
      }
      let found: boolean;
      if (text.startsWith('@')) {
        const name = /^[A-Za-z0-9_-]*/.exec(text.slice(1))![0].toLowerCase();
        if (name === 'starting-style') found = true;
        else if (SKIPPED_AT_RULES.has(name)) {
          skipBlock();
          found = false;
        } else found = rules(inside, false);
      } else found = rules(selectorsMatch(text, inside, present), false);
      if (found) return true;
    }
  };

  try {
    return rules(undefined, true);
  } catch (error) {
    if (error instanceof Lost) return true;
    throw error;
  }
}

function stripComments(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const c = css[i]!;
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      out += ' ';
    } else if (c === '"' || c === "'") {
      const end = skipString(css, i, c);
      out += css.slice(i, end);
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function skipString(s: string, i: number, quote: string): number {
  i++;
  while (i < s.length && s[i] !== quote) {
    if (s[i] === '\\') i++;
    i++;
  }
  return i + 1;
}

function declaration(text: string, inside: boolean | undefined): boolean {
  const colon = text.indexOf(':');
  if (colon === -1) return false;
  const property = text.slice(0, colon).trim().toLowerCase();
  const moving = !property.startsWith('--') && (property.includes('transition') || property.includes('animation'));
  return moving && inside !== false;
}

function splitTop(text: string, sep: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      i = skipString(text, i, c);
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(text.slice(start));
  return parts;
}

function selectorsMatch(text: string, parent: boolean | undefined, present: Present): boolean {
  return splitTop(text, ',').some((selector) => selectorMatches(selector.trim(), parent, present));
}

const IDENT = /^[A-Za-z0-9_-]*/;

function selectorMatches(selector: string, parent: boolean | undefined, present: Present): boolean {
  if (selector === '') return true;
  // The rightmost compound starts after the last combinator outside brackets.
  let start = 0;
  let depth = 0;
  for (let i = 0; i < selector.length; ) {
    const c = selector[i]!;
    if (c === '"' || c === "'") {
      i = skipString(selector, i, c);
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && ' \t\n\r\f>+~'.includes(c)) start = i + 1;
    i++;
  }
  const compound = selector.slice(start);
  let nesting = false;
  for (let i = 0; i < compound.length; ) {
    const c = compound[i]!;
    if (c === '&') {
      nesting = true;
      i++;
    } else if (c === '*') i++;
    else if (c === '.' || c === '#') {
      const name = IDENT.exec(compound.slice(i + 1))![0];
      if (name === '') return true;
      const lower = name.toLowerCase();
      if (!(c === '.' ? present.classes : present.ids).has(lower)) return false;
      i += 1 + name.length;
    } else if (c === '[' || c === '(') {
      // Not followed: skipped with what it holds.
      let d = 0;
      while (i < compound.length) {
        const x = compound[i]!;
        if (x === '"' || x === "'") {
          i = skipString(compound, i, x);
          continue;
        }
        if (x === '[' || x === '(') d++;
        else if (x === ']' || x === ')') {
          d--;
          if (d === 0) {
            i++;
            break;
          }
        }
        i++;
      }
    } else if (c === ':') {
      i++;
      if (compound[i] === ':') i++;
      i += IDENT.exec(compound.slice(i))![0].length;
    } else if (i === 0 && /[A-Za-z_-]/.test(c)) {
      const name = IDENT.exec(compound)![0];
      if (compound[name.length] === '|') return true;
      if (!present.tags.has(name.toLowerCase())) return false;
      i = name.length;
    } else return true;
  }
  return !nesting || parent !== false;
}
