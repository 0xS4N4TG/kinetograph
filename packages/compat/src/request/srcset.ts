// `srcset` and `sizes` as HTML parses them ("parse a srcset attribute", "parse a sizes attribute"), and the candidate
// Chrome draws at device pixel ratio 1. Checked against Chrome for Testing: no-space separators (`a.png 1x,b.png 2x`),
// commas inside a URL, parenthesised junk, `w` descriptors measured against `sizes` (default `100vw`).

export interface SrcsetCandidate {
  url: string;
  /** A `w` descriptor. */
  width?: number;
  /** An `x` descriptor. */
  density?: number;
}

const SPACE = /[\t\n\f\r ]/;
const FLOAT = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER = /^\d+$/;

/** The image candidates of a `srcset`; one with a bad or duplicated descriptor is dropped, as the spec says. */
export function parseSrcset(input: string): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  const length = input.length;
  let pos = 0;
  for (;;) {
    while (pos < length && (SPACE.test(input[pos]!) || input[pos] === ',')) pos++;
    if (pos >= length) return out;
    const start = pos;
    while (pos < length && !SPACE.test(input[pos]!)) pos++;
    let url = input.slice(start, pos);
    const descriptors: string[] = [];
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      while (pos < length && SPACE.test(input[pos]!)) pos++;
      let current = '';
      let state: 'in' | 'paren' | 'after' = 'in';
      for (; ; pos++) {
        const c = input[pos];
        if (state === 'in') {
          if (c === undefined) {
            if (current !== '') descriptors.push(current);
            break;
          }
          if (SPACE.test(c)) {
            if (current !== '') {
              descriptors.push(current);
              current = '';
              state = 'after';
            }
          } else if (c === ',') {
            pos++;
            if (current !== '') descriptors.push(current);
            break;
          } else if (c === '(') {
            current += c;
            state = 'paren';
          } else {
            current += c;
          }
        } else if (state === 'paren') {
          if (c === undefined) {
            descriptors.push(current);
            break;
          }
          current += c;
          if (c === ')') state = 'in';
        } else {
          if (c === undefined) break;
          if (!SPACE.test(c)) {
            state = 'in';
            pos--;
          }
        }
      }
    }
    let error = false;
    let width: number | undefined;
    let density: number | undefined;
    let height: number | undefined;
    for (const d of descriptors) {
      const kind = d.at(-1);
      const value = d.slice(0, -1);
      if (kind === 'w' && INTEGER.test(value) && width === undefined && density === undefined) {
        width = Number(value);
        if (width <= 0) error = true;
      } else if (kind === 'x' && FLOAT.test(value) && width === undefined && density === undefined && height === undefined) {
        density = Number(value);
        if (density < 0) error = true;
      } else if (kind === 'h' && INTEGER.test(value) && height === undefined && density === undefined) {
        height = Number(value);
        if (height <= 0) error = true;
      } else {
        error = true;
      }
    }
    if (height !== undefined && width === undefined) error = true;
    if (!error && url !== '') out.push({ url, ...(width !== undefined ? { width } : {}), ...(density !== undefined ? { density } : {}) });
  }
}

/** A `sizes` length in pixels: `px`, `em`/`rem` (16 px), `vw`, `vh`; null for anything else. */
function lengthPx(text: string, viewport: { width: number; height: number }): number | null {
  const m = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|em|rem|vw|vh)?$/i.exec(text.trim());
  if (m === null) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  if (unit === '') return n === 0 ? 0 : null;
  if (unit === 'px') return n;
  if (unit === 'em' || unit === 'rem') return n * 16;
  return (n * (unit === 'vw' ? viewport.width : viewport.height)) / 100;
}

/** A media condition of a `sizes` entry: width features (`min-`/`max-`), `and`, `not`, `or`. */
function mediaMatches(condition: string, viewport: { width: number; height: number }): boolean {
  const c = condition.trim().toLowerCase();
  if (c.startsWith('not ')) return !mediaMatches(c.slice(4), viewport);
  if (/\)\s+or\s+\(/.test(c)) return c.split(/\s+or\s+/).some((part) => mediaMatches(part, viewport));
  return c.split(/\s+and\s+/).every((part) => {
    const m = /^\(\s*(min-|max-)?(width|height)\s*:\s*([^)]+)\)$/.exec(part.trim());
    if (m === null) return false;
    const size = m[2] === 'width' ? viewport.width : viewport.height;
    const value = lengthPx(m[3]!, viewport);
    if (value === null) return false;
    return m[1] === 'min-' ? size >= value : m[1] === 'max-' ? size <= value : size === value;
  });
}

/** The source size `sizes` gives at `viewport`: the first entry whose condition holds; `100vw` when none does. */
export function sourceSize(sizes: string | undefined, viewport: { width: number; height: number }): number {
  for (const entry of (sizes ?? '').split(',')) {
    const text = entry.trim();
    if (text === '') continue;
    const m = /^(.*?)\s*((?:-?(?:\d+(?:\.\d+)?|\.\d+))(?:px|em|rem|vw|vh)?)$/i.exec(text);
    if (m === null) continue;
    const size = lengthPx(m[2]!, viewport);
    if (size === null || size < 0) continue;
    if (m[1]!.trim() === '' || mediaMatches(m[1]!, viewport)) return size;
  }
  return viewport.width;
}

/**
 * The URL Chrome draws for an `<img srcset sizes src>` at device pixel ratio 1: each candidate's density (an `x`
 * descriptor, `w` over the source size, else 1), `src` added as 1x when the set has no 1x and no `w` candidate, then
 * the smallest density that is at least 1, else the largest. Null when there is no candidate.
 */
export function srcsetCandidate(
  srcset: string,
  src?: string,
  sizes?: string,
  viewport: { width: number; height: number } = { width: 1920, height: 1080 },
): string | null {
  const parsed = parseSrcset(srcset);
  const hasWidth = parsed.some((c) => c.width !== undefined);
  const size = hasWidth ? sourceSize(sizes, viewport) : viewport.width;
  const candidates = parsed.map((c) => ({ url: c.url, density: c.width !== undefined ? c.width / size : (c.density ?? 1) }));
  if (src !== undefined && src !== '' && !hasWidth && !candidates.some((c) => c.density === 1)) candidates.push({ url: src, density: 1 });
  if (candidates.length === 0) return null;
  // Of two with the same density the first written is kept.
  const sorted = candidates
    .filter((c, i) => candidates.findIndex((o) => o.density === c.density) === i)
    .sort((a, b) => a.density - b.density);
  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i]!.density;
    const mean = Math.sqrt(current * sorted[i + 1]!.density);
    if (1 > current || 1 >= mean) continue;
    return sorted[i]!.url;
  }
  return sorted.at(-1)!.url;
}
