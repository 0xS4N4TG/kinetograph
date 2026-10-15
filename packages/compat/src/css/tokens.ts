// A small CSS value tokenizer (CSS Syntax Level 3, the parts a declaration value needs) and the helpers the parsers
// share. Internal parsers throw `CssError`; the public functions turn it into a `Diagnostic` (or `null`).

export class CssError extends Error {}

export function fail(reason: string): never {
  throw new CssError(reason);
}

export type Tok =
  | { type: 'ident'; text: string; name: string }
  | { type: 'number'; text: string; value: number; int: boolean }
  | { type: 'dimension'; text: string; value: number; unit: string }
  | { type: 'percent'; text: string; value: number }
  | { type: 'string'; text: string; str: string }
  | { type: 'hash'; text: string; str: string }
  | { type: 'url'; text: string; str: string }
  | { type: 'function'; text: string; name: string; args: Tok[] }
  | { type: 'comma'; text: string }
  | { type: 'slash'; text: string }
  | { type: 'delim'; text: string };

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENT_START = /[A-Za-z_\u0080-￿\\]/;
const IDENT_CHAR = /[A-Za-z0-9_\u0080-￿\\-]/;
const WHITESPACE = /\s/;

export function tokenize(src: string): Tok[] {
  let i = 0;

  const identAt = (at: number): boolean => {
    const c = src[at];
    if (c === undefined) return false;
    if (IDENT_START.test(c)) return true;
    if (c === '-') {
      const d = src[at + 1];
      return d !== undefined && (IDENT_START.test(d) || d === '-');
    }
    return false;
  };
  const numberAt = (at: number): boolean => {
    const c = src[at];
    if (c === undefined) return false;
    if (c >= '0' && c <= '9') return true;
    if (c === '.') return /\d/.test(src[at + 1] ?? '');
    if (c === '+' || c === '-') {
      const d = src[at + 1];
      return d !== undefined && (/\d/.test(d) || (d === '.' && /\d/.test(src[at + 2] ?? '')));
    }
    return false;
  };
  const readIdent = (): string => {
    let out = '';
    while (i < src.length && IDENT_CHAR.test(src[i]!)) {
      if (src[i] === '\\') {
        i++;
        if (i < src.length) out += src[i++];
      } else out += src[i++];
    }
    return out;
  };
  const readString = (quote: string): string => {
    i++;
    let out = '';
    while (i < src.length && src[i] !== quote) {
      if (src[i] === '\\' && i + 1 < src.length) i++;
      out += src[i++];
    }
    if (i >= src.length) fail('unterminated string');
    i++;
    return out;
  };

  const list = (closing: boolean): Tok[] => {
    const out: Tok[] = [];
    while (i < src.length) {
      const c = src[i]!;
      if (WHITESPACE.test(c)) {
        i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        i = end < 0 ? src.length : end + 2;
        continue;
      }
      const start = i;
      if (c === ')') {
        if (!closing) fail('unbalanced )');
        i++;
        return out;
      }
      if (c === '(') {
        i++;
        out.push({ type: 'function', text: '', name: '', args: list(true) });
        out[out.length - 1]!.text = src.slice(start, i);
        continue;
      }
      if (c === ',') {
        i++;
        out.push({ type: 'comma', text: ',' });
        continue;
      }
      if (c === '/') {
        i++;
        out.push({ type: 'slash', text: '/' });
        continue;
      }
      if (c === '"' || c === "'") {
        const str = readString(c);
        out.push({ type: 'string', text: src.slice(start, i), str });
        continue;
      }
      if (c === '#') {
        i++;
        const str = readIdent();
        out.push({ type: 'hash', text: src.slice(start, i), str });
        continue;
      }
      if (numberAt(i)) {
        NUMBER.lastIndex = i;
        const m = NUMBER.exec(src)!;
        i += m[0].length;
        const value = Number(m[0]);
        if (src[i] === '%') {
          i++;
          out.push({ type: 'percent', text: src.slice(start, i), value });
        } else if (identAt(i)) {
          const unit = readIdent().toLowerCase();
          out.push({ type: 'dimension', text: src.slice(start, i), value, unit });
        } else {
          out.push({ type: 'number', text: m[0], value, int: /^[+-]?\d+$/.test(m[0]) });
        }
        continue;
      }
      if (identAt(i)) {
        const name = readIdent();
        if (src[i] === '(') {
          i++;
          const lname = name.toLowerCase();
          if (lname === 'url') {
            out.push(readUrl(start));
          } else {
            const args = list(true);
            out.push({ type: 'function', text: src.slice(start, i), name: lname, args });
          }
        } else {
          out.push({ type: 'ident', text: name, name: name.toLowerCase() });
        }
        continue;
      }
      i++;
      out.push({ type: 'delim', text: c });
    }
    if (closing) fail('unclosed (');
    return out;
  };

  // `url(` has been consumed; reads a quoted or bare url and the closing paren.
  const readUrl = (start: number): Tok => {
    while (i < src.length && WHITESPACE.test(src[i]!)) i++;
    let str: string;
    if (src[i] === '"' || src[i] === "'") {
      str = readString(src[i]!);
      while (i < src.length && WHITESPACE.test(src[i]!)) i++;
      if (src[i] !== ')') fail('malformed url()');
      i++;
    } else {
      const end = src.indexOf(')', i);
      if (end < 0) fail('unclosed url(');
      str = src.slice(i, end).trim();
      i = end + 1;
    }
    return { type: 'url', text: src.slice(start, i), str };
  };

  return list(false);
}

/** CSS math functions and the substitution functions: not evaluated in this pass. */
const UNSUPPORTED_FUNCTIONS = new Set([
  'calc', '-webkit-calc', '-moz-calc', 'min', 'max', 'clamp', 'round', 'mod', 'rem', 'abs', 'sign', 'sin', 'cos', 'tan',
  'asin', 'acos', 'atan', 'atan2', 'pow', 'sqrt', 'hypot', 'log', 'exp', 'var', 'env', 'attr',
]);
const CSS_WIDE = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);

function rejectFunctions(toks: Tok[]): void {
  for (const t of toks) {
    if (t.type !== 'function') continue;
    if (t.name === '') fail('parenthesised groups are not supported');
    if (UNSUPPORTED_FUNCTIONS.has(t.name)) fail(`${t.name.replace(/^-(webkit|moz)-/, '')}() is not supported`);
    rejectFunctions(t.args);
  }
}

/** Tokenises a declaration value: `!important` dropped, `calc()`/`var()`/`env()`/`attr()` and CSS-wide keywords refused. */
export function lex(value: string): Tok[] {
  const toks = tokenize(value.replace(/\s*!\s*important\s*$/i, ''));
  if (toks.length === 0) fail('empty value');
  rejectFunctions(toks);
  const first = toks[0]!;
  if (toks.length === 1 && first.type === 'ident' && CSS_WIDE.has(first.name)) {
    fail(`the CSS-wide keyword \`${first.name}\` is not supported`);
  }
  return toks;
}

/** Splits at top-level commas; an empty segment is an error. */
export function splitCommas(toks: Tok[]): Tok[][] {
  const out: Tok[][] = [[]];
  for (const t of toks) {
    if (t.type === 'comma') out.push([]);
    else out[out.length - 1]!.push(t);
  }
  if (out.some((s) => s.length === 0)) fail('empty item in a comma-separated list');
  return out;
}

/** Whether `t` is an identifier named one of `names` (lowercase). */
export const isKw = (t: Tok | undefined, ...names: string[]): boolean =>
  t !== undefined && t.type === 'ident' && names.includes(t.name);

/** The lowercase name of an identifier token, `''` for any other token. */
export const nameOf = (t: Tok | undefined): string => (t !== undefined && t.type === 'ident' ? t.name : '');

export const isLengthLike = (t: Tok | undefined): boolean =>
  t !== undefined && (t.type === 'number' || t.type === 'dimension' || t.type === 'percent');

/** The one token a single-keyword or single-value property holds. */
export function single(toks: Tok[]): Tok {
  if (toks.length !== 1) fail(`expected one value, found ${toks.length}`);
  return toks[0]!;
}

/** The keyword of a one-keyword value, checked against the allowed set. */
export function keyword<T extends string>(toks: Tok[], allowed: readonly T[]): T {
  const t = single(toks);
  if (t.type !== 'ident') fail(`expected one of ${allowed.join(', ')}, found ${t.text}`);
  const name = (t as Extract<Tok, { type: 'ident' }>).name;
  if (!(allowed as readonly string[]).includes(name)) fail(`\`${t.text}\` is not one of ${allowed.join(', ')}`);
  return name as T;
}
