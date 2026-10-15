// A small CSS selector matcher for `querySelector`, `matches` and `closest` on the host tree: type, `#id`, `.class`,
// `[attr]`, `[attr=value]` (with `~= ^= $= *= |=`), `:first-child`, `:last-child`, `:nth-child(n)`, `:not(…)`,
// `:scope`, `*`; the combinators space, `>`, `+`, `~`; and comma lists. Not CSS4; the full cascade is Stylo's, in Rust.

import type { HostElement } from './host.js';

export interface SelectorContext {
  parent(host: HostElement): HostElement | null;
  /** Child elements of `host`, in order (text left out). */
  children(host: HostElement): HostElement[];
  /** The value of an attribute as the DOM has it (`class` for `className`), or null. */
  attribute(host: HostElement, name: string): string | null;
  /** The host `:scope` stands for. */
  scope?: HostElement;
}

type Test = (host: HostElement, cx: SelectorContext) => boolean;

interface Compound {
  test: Test;
}
interface Complex {
  /** From right to left: the subject first, then what must stand to its left. */
  parts: { compound: Compound; combinator: ' ' | '>' | '+' | '~' | null }[];
}

class SelectorError extends SyntaxError {}

function parseCompound(source: string): Test {
  const tests: Test[] = [];
  let i = 0;
  const ident = (): string => {
    const m = /^-?[_a-zA-Z -￿][\w -￿-]*/.exec(source.slice(i));
    if (!m) throw new SelectorError(`bad selector "${source}"`);
    i += m[0].length;
    return m[0];
  };
  if (source[0] === '*') {
    i = 1;
  } else if (/[_a-zA-Z]/.test(source[0] ?? '')) {
    const tag = ident();
    tests.push((h) => h.type.toLowerCase() === tag.toLowerCase());
  }
  while (i < source.length) {
    const c = source[i]!;
    if (c === '#') {
      i++;
      const id = ident();
      tests.push((h, cx) => cx.attribute(h, 'id') === id);
    } else if (c === '.') {
      i++;
      const name = ident();
      tests.push((h, cx) => (cx.attribute(h, 'class') ?? '').split(/\s+/).includes(name));
    } else if (c === '[') {
      const end = source.indexOf(']', i);
      if (end === -1) throw new SelectorError(`bad selector "${source}"`);
      const m = /^\s*([^\s~|^$*=\]]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?\s*$/.exec(source.slice(i + 1, end));
      if (!m) throw new SelectorError(`bad selector "${source}"`);
      const [, name, op, dq, sq, bare] = m as unknown as [string, string, string | undefined, string | undefined, string | undefined, string | undefined];
      const want = dq ?? sq ?? bare ?? '';
      tests.push((h, cx) => {
        const have = cx.attribute(h, name);
        if (have === null) return false;
        switch (op) {
          case undefined: return true;
          case '=': return have === want;
          case '~=': return have.split(/\s+/).includes(want);
          case '|=': return have === want || have.startsWith(`${want}-`);
          case '^=': return want !== '' && have.startsWith(want);
          case '$=': return want !== '' && have.endsWith(want);
          case '*=': return want !== '' && have.includes(want);
          default: return false;
        }
      });
      i = end + 1;
    } else if (c === ':') {
      i++;
      const name = ident();
      if (name === 'first-child') tests.push((h, cx) => siblings(h, cx)[0] === h);
      else if (name === 'last-child') tests.push((h, cx) => siblings(h, cx).at(-1) === h);
      else if (name === 'only-child') tests.push((h, cx) => siblings(h, cx).length === 1);
      else if (name === 'scope') tests.push((h, cx) => cx.scope === h);
      else if (name === 'root') tests.push((h, cx) => cx.parent(h) === null);
      else if (name === 'nth-child' || name === 'not') {
        if (source[i] !== '(') throw new SelectorError(`bad selector "${source}"`);
        let depth = 0;
        let j = i;
        for (; j < source.length; j++) {
          if (source[j] === '(') depth++;
          else if (source[j] === ')' && --depth === 0) break;
        }
        const inner = source.slice(i + 1, j).trim();
        i = j + 1;
        if (name === 'not') {
          const list = parseSelectorList(inner);
          tests.push((h, cx) => !list.some((s) => matchesComplex(s, h, cx)));
        } else {
          const nth = parseNth(inner);
          tests.push((h, cx) => nth(siblings(h, cx).indexOf(h) + 1));
        }
      } else if (name === 'hover' || name === 'focus' || name === 'active' || name === 'visited' || name === 'checked' || name === 'disabled') {
        tests.push(() => false);
      } else {
        throw new SelectorError(`the pseudo-class :${name} is not supported by querySelector`);
      }
    } else {
      throw new SelectorError(`bad selector "${source}"`);
    }
  }
  return (h, cx) => tests.every((t) => t(h, cx));
}

function siblings(host: HostElement, cx: SelectorContext): HostElement[] {
  const parent = cx.parent(host);
  return parent === null ? [host] : cx.children(parent);
}

function parseNth(text: string): (n: number) => boolean {
  const t = text.replace(/\s+/g, '').toLowerCase();
  if (t === 'odd') return (n) => n % 2 === 1;
  if (t === 'even') return (n) => n % 2 === 0;
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(t);
  if (m) {
    const a = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : Number(m[1]);
    const b = m[2] ? Number(m[2]) : 0;
    return (n) => (a === 0 ? n === b : (n - b) / a >= 0 && Number.isInteger((n - b) / a));
  }
  const k = Number(t);
  if (Number.isInteger(k)) return (n) => n === k;
  throw new SelectorError(`bad :nth-child(${text})`);
}

function parseComplex(source: string): Complex {
  const parts: Complex['parts'] = [];
  // Split into compounds and combinators, outside of brackets and parentheses.
  const tokens: string[] = [];
  let current = '';
  let depth = 0;
  const flush = (): void => {
    if (current !== '') tokens.push(current);
    current = '';
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '[' || c === '(') depth++;
    if (c === ']' || c === ')') depth--;
    if (depth === 0 && /\s/.test(c)) {
      flush();
      tokens.push(' ');
    } else if (depth === 0 && (c === '>' || c === '+' || c === '~')) {
      flush();
      tokens.push(c);
    } else current += c;
  }
  flush();
  // Collapse whitespace around explicit combinators.
  const cleaned: string[] = [];
  for (const token of tokens) {
    if (token === ' ') {
      if (cleaned.length > 0 && !/^[>+~ ]$/.test(cleaned.at(-1)!)) cleaned.push(' ');
    } else if (/^[>+~]$/.test(token)) {
      if (cleaned.at(-1) === ' ') cleaned.pop();
      cleaned.push(token);
    } else cleaned.push(token);
  }
  if (cleaned.at(-1) === ' ') cleaned.pop();
  let pending = null as Complex['parts'][number]['combinator'];
  const ordered: { compound: Compound; combinator: Complex['parts'][number]['combinator'] }[] = [];
  for (const token of cleaned) {
    if (/^[>+~ ]$/.test(token)) pending = token as typeof pending;
    else {
      ordered.push({ compound: { test: parseCompound(token) }, combinator: pending });
      pending = null;
    }
  }
  if (ordered.length === 0) throw new SelectorError(`empty selector "${source}"`);
  // `combinator` of an entry relates it to the one before it; re-key so the subject comes first.
  for (let i = ordered.length - 1; i >= 0; i--) parts.push({ compound: ordered[i]!.compound, combinator: ordered[i]!.combinator });
  return { parts };
}

function splitList(source: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of source) {
    if (c === '[' || c === '(') depth++;
    if (c === ']' || c === ')') depth--;
    if (c === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += c;
  }
  out.push(current.trim());
  return out;
}

export function parseSelectorList(source: string): Complex[] {
  const list = splitList(source);
  if (list.some((s) => s === '')) throw new SelectorError(`"${source}" is not a valid selector`);
  return list.map(parseComplex);
}

function matchesComplex(complex: Complex, host: HostElement, cx: SelectorContext, index = 0): boolean {
  const part = complex.parts[index]!;
  if (!part.compound.test(host, cx)) return false;
  const next = complex.parts[index + 1];
  if (next === undefined) return true;
  switch (part.combinator) {
    case '>': {
      const parent = cx.parent(host);
      return parent !== null && matchesComplex(complex, parent, cx, index + 1);
    }
    case ' ': {
      for (let p = cx.parent(host); p !== null; p = cx.parent(p)) if (matchesComplex(complex, p, cx, index + 1)) return true;
      return false;
    }
    case '+': {
      const sibs = siblings(host, cx);
      const at = sibs.indexOf(host);
      return at > 0 && matchesComplex(complex, sibs[at - 1]!, cx, index + 1);
    }
    case '~': {
      const sibs = siblings(host, cx);
      for (let k = sibs.indexOf(host) - 1; k >= 0; k--) if (matchesComplex(complex, sibs[k]!, cx, index + 1)) return true;
      return false;
    }
    default:
      return false;
  }
}

/** Whether `host` matches the selector list; a bad selector throws a `SyntaxError`, as the DOM does. */
export function matches(host: HostElement, selector: string, cx: SelectorContext): boolean {
  return parseSelectorList(selector).some((s) => matchesComplex(s, host, cx));
}

/** The elements under `rootChildren` (descendants only, in document order) that match. */
export function queryAll(descendants: HostElement[], selector: string, cx: SelectorContext, first = false): HostElement[] {
  const list = parseSelectorList(selector);
  const out: HostElement[] = [];
  for (const host of descendants) {
    if (list.some((s) => matchesComplex(s, host, cx))) {
      out.push(host);
      if (first) break;
    }
  }
  return out;
}
