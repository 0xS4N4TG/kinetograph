// Interpolation and addition of CSS values for the Web Animations API (CSS Values 4 "Combining Values", CSS Transforms
// 1 and 2, Filter Effects 1, CSS Color 4). A value is taken apart into numbers with their units, colours and the text
// between them; two values with the same shape mix number by number (a length and a percentage through `calc()`),
// colour by colour (see css-color.ts). Transform lists pair their functions, as browsers do, and fall back to the
// decomposed matrices; filter lists pad the shorter one with each function's neutral value. Anything else is discrete:
// the first value up to half way, the second from there.

import { addColors, formatColor, mixColors, parseColor, type Color } from './css-color.js';

type Part = { kind: 'num'; value: number; unit: string } | { kind: 'color'; color: Color } | { kind: 'text'; text: string };

const COLOR_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color']);
const LENGTH_UNITS = new Set(['px', '%', 'em', 'rem', 'vw', 'vh', 'vmin', 'vmax', 'ch', 'ex', 'pt', 'pc', 'in', 'cm', 'mm', 'q', 'lh', 'svw', 'svh', 'dvw', 'dvh', 'lvw', 'lvh', 'cqw', 'cqh']);
const isIdentStart = (c: string) => /[a-zA-Z_-]/.test(c);
const isIdent = (c: string) => /[a-zA-Z0-9_-]/.test(c);

/** The parts of a value: numbers with units, colours, and text (whitespace kept as one space). */
function tokenize(text: string): Part[] {
  const parts: Part[] = [];
  const pushText = (t: string) => {
    const last = parts[parts.length - 1];
    if (last?.kind === 'text') last.text += t;
    else parts.push({ kind: 'text', text: t });
  };
  let i = 0;
  const s = text.trim().replace(/\s+/g, ' ');
  while (i < s.length) {
    const c = s[i]!;
    const prev = i > 0 ? s[i - 1]! : ' ';
    const number = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(s.slice(i));
    if (number && !isIdent(prev) && (c !== '-' && c !== '+' ? true : /[\d.]/.test(s[i + 1] ?? ''))) {
      let j = i + number[0].length;
      let unit = '';
      if (s[j] === '%') {
        unit = '%';
        j++;
      } else {
        while (j < s.length && /[a-zA-Z]/.test(s[j]!)) unit += s[j++];
      }
      parts.push({ kind: 'num', value: Number(number[0]), unit: unit.toLowerCase() });
      i = j;
      continue;
    }
    if (c === '#') {
      const hex = /^#[0-9a-fA-F]+/.exec(s.slice(i));
      const color = hex ? parseColor(hex[0]) : null;
      if (hex && color) {
        parts.push({ kind: 'color', color });
        i += hex[0].length;
        continue;
      }
    }
    if (isIdentStart(c) && !isIdent(prev)) {
      let j = i;
      while (j < s.length && isIdent(s[j]!)) j++;
      const word = s.slice(i, j);
      if (s[j] === '(' && COLOR_FUNCTIONS.has(word.toLowerCase())) {
        let depth = 0;
        let k = j;
        for (; k < s.length; k++) {
          if (s[k] === '(') depth++;
          else if (s[k] === ')' && --depth === 0) break;
        }
        const color = parseColor(s.slice(i, k + 1));
        if (color) {
          parts.push({ kind: 'color', color });
          i = k + 1;
          continue;
        }
      }
      const color = s[j] === '(' ? null : parseColor(word);
      if (color) parts.push({ kind: 'color', color });
      else pushText(word);
      i = j;
      continue;
    }
    pushText(c);
    i++;
  }
  return parts;
}

const fmt = (v: number): string => {
  const r = Number(v.toFixed(6));
  return String(Object.is(r, -0) ? 0 : r);
};

/** Two lengths of different units: `calc()` of their weighted sum. */
function lengthSum(a: number, ua: string, wa: number, b: number, ub: string, wb: number): string {
  if (ua === ub) return `${fmt(a * wa + b * wb)}${ua}`;
  return `calc(${fmt(a * wa)}${ua || 'px'} + ${fmt(b * wb)}${ub || 'px'})`;
}

/** Whether two number parts can be combined: the same unit, a length with a length, or a bare 0 with a length. */
function compatible(a: Extract<Part, { kind: 'num' }>, b: Extract<Part, { kind: 'num' }>): boolean {
  if (a.unit === b.unit) return true;
  const len = (p: typeof a) => LENGTH_UNITS.has(p.unit) || (p.unit === '' && p.value === 0);
  return len(a) && len(b);
}

/** Two values part by part, or null when their shapes differ. */
function combineParts(a: Part[], b: Part[], wa: number, wb: number, colors: (x: Color, y: Color) => Color): string | null {
  if (a.length !== b.length) return null;
  let out = '';
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.kind !== y.kind) return null;
    if (x.kind === 'text') {
      if (x.text !== (y as typeof x).text) return null;
      out += x.text;
    } else if (x.kind === 'color') {
      out += formatColor(colors(x.color, (y as typeof x).color));
    } else {
      const yy = y as typeof x;
      if (!compatible(x, yy)) return null;
      const ux = x.unit === '' && x.value === 0 ? yy.unit : x.unit;
      const uy = yy.unit === '' && yy.value === 0 ? x.unit : yy.unit;
      out += lengthSum(x.value, ux, wa, yy.value, uy, wb);
    }
  }
  return out;
}

// ---- transforms ----

interface Fn {
  name: string;
  args: Array<{ value: number; unit: string }>;
}

function parseTransform(text: string): Fn[] | null {
  const t = text.trim();
  if (t === 'none' || t === '') return [];
  const out: Fn[] = [];
  const re = /([a-zA-Z0-9]+)\(([^)]*)\)/g;
  let rest = t;
  for (const m of t.matchAll(re)) {
    rest = rest.replace(m[0], '');
    const args = m[2]!.split(/\s*,\s*|\s+/).filter(Boolean).map((a) => {
      const n = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-zA-Z%]*)$/i.exec(a);
      return n ? { value: Number(n[1]), unit: n[2]!.toLowerCase() } : null;
    });
    if (args.some((a) => a === null)) return null;
    out.push({ name: m[1]!, args: args as Fn['args'] });
  }
  return rest.trim() === '' ? out : null;
}

/** The common primitive of two transform functions (CSS Transforms 2, "Transform function primitives"), as each
 *  written in it, or null when they have none. */
function primitives(a: Fn, b: Fn): [Fn, Fn] | null {
  if (a.name === b.name) return [a, b];
  const family = (f: Fn) => (/^translate/.test(f.name) ? 'translate' : /^scale/.test(f.name) ? 'scale' : /^skew/.test(f.name) ? 'skew' : f.name === 'rotate' || f.name === 'rotateZ' ? 'rotate' : null);
  const fa = family(a);
  if (fa === null || fa !== family(b)) return null;
  if (fa === 'rotate') return [{ name: 'rotate', args: a.args }, { name: 'rotate', args: b.args }];
  const three = [a, b].some((f) => f.name.endsWith('3d') || f.name.endsWith('Z'));
  const zero = { value: fa === 'scale' ? 1 : 0, unit: '' };
  const expand = (f: Fn): Fn['args'] => {
    const n = f.name;
    const v = f.args;
    if (n.endsWith('X')) return [v[0]!, zero, zero];
    if (n.endsWith('Y')) return [zero, v[0]!, zero];
    if (n.endsWith('Z')) return [zero, zero, v[0]!];
    if (n.endsWith('3d')) return [v[0]!, v[1]!, v[2]!];
    return [v[0]!, v[1] ?? (fa === 'scale' ? v[0]! : zero), zero];
  };
  const name = three ? `${fa}3d` : fa;
  const cut = (args: Fn['args']) => (three ? args : args.slice(0, 2));
  return [{ name, args: cut(expand(a)) }, { name, args: cut(expand(b)) }];
}

/** The identity function of `f`'s kind, for a list that has none to pair with it. */
function identityOf(f: Fn): Fn {
  if (f.name === 'matrix') return { name: 'matrix', args: [1, 0, 0, 1, 0, 0].map((value) => ({ value, unit: '' })) };
  const one = /^scale/.test(f.name);
  return { name: f.name, args: f.args.map((a) => ({ value: one ? 1 : 0, unit: one ? '' : a.unit })) };
}

function formatFn(f: Fn): string {
  return `${f.name}(${f.args.map((a) => `${fmt(a.value)}${a.unit}`).join(', ')})`;
}

function mixArgs(a: Fn, b: Fn, wa: number, wb: number): string {
  const args = a.args.map((x, i) => {
    const y = b.args[i]!;
    const ux = x.unit === '' && x.value === 0 ? y.unit : x.unit;
    const uy = y.unit === '' && y.value === 0 ? x.unit : y.unit;
    return lengthSum(x.value, ux, wa, y.value, uy, wb);
  });
  return `${a.name}(${args.join(', ')})`;
}

type M2 = [number, number, number, number, number, number];
const deg = (a: { value: number; unit: string }) => (a.unit === 'rad' ? (a.value * 180) / Math.PI : a.unit === 'turn' ? a.value * 360 : a.unit === 'grad' ? a.value * 0.9 : a.value);
const mulM = (a: M2, b: M2): M2 => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];

/** A 2D transform list as one matrix, or null when it holds a percentage or a 3D function. */
function matrixOf(list: Fn[]): M2 | null {
  let m: M2 = [1, 0, 0, 1, 0, 0];
  for (const f of list) {
    if (f.args.some((a) => a.unit === '%' || (a.unit !== '' && a.unit !== 'px' && !['deg', 'rad', 'turn', 'grad'].includes(a.unit)))) return null;
    const v = f.args.map((a) => a.value);
    const r = (x: number) => (x * Math.PI) / 180;
    let t: M2;
    switch (f.name) {
      case 'matrix': t = v as M2; break;
      case 'translate': t = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0]; break;
      case 'translateX': t = [1, 0, 0, 1, v[0] ?? 0, 0]; break;
      case 'translateY': t = [1, 0, 0, 1, 0, v[0] ?? 0]; break;
      case 'scale': t = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]; break;
      case 'scaleX': t = [v[0] ?? 1, 0, 0, 1, 0, 0]; break;
      case 'scaleY': t = [1, 0, 0, v[0] ?? 1, 0, 0]; break;
      case 'rotate': case 'rotateZ': { const a = r(deg(f.args[0] ?? { value: 0, unit: '' })); t = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]; break; }
      case 'skew': t = [1, Math.tan(r(deg(f.args[1] ?? { value: 0, unit: '' }))), Math.tan(r(deg(f.args[0] ?? { value: 0, unit: '' }))), 1, 0, 0]; break;
      case 'skewX': t = [1, 0, Math.tan(r(deg(f.args[0]!))), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan(r(deg(f.args[0]!))), 0, 1, 0, 0]; break;
      default: return null;
    }
    m = mulM(m, t);
  }
  return m;
}

interface Decomposed { tx: number; ty: number; sx: number; sy: number; angle: number; m: [number, number, number, number] }

/** CSS Transforms 1, "Decomposing a 2D matrix". */
function decompose(mat: M2): Decomposed | null {
  let [r0x, r0y, r1x, r1y] = [mat[0], mat[1], mat[2], mat[3]];
  let sx = Math.hypot(r0x, r0y);
  let sy = Math.hypot(r1x, r1y);
  const det = r0x * r1y - r0y * r1x;
  if (det < 0) {
    if (r0x < r1y) sx = -sx;
    else sy = -sy;
  }
  if (sx) {
    r0x /= sx;
    r0y /= sx;
  }
  if (sy) {
    r1x /= sy;
    r1y /= sy;
  }
  let angle = Math.atan2(r0y, r0x);
  if (angle) {
    const sn = -r0y;
    const cs = r0x;
    const [m11, m12, m21, m22] = [r0x, r0y, r1x, r1y];
    r0x = cs * m11 + sn * m21;
    r0y = cs * m12 + sn * m22;
    r1x = -sn * m11 + cs * m21;
    r1y = -sn * m12 + cs * m22;
  }
  angle = (angle * 180) / Math.PI;
  return { tx: mat[4], ty: mat[5], sx, sy, angle, m: [r0x, r0y, r1x, r1y] };
}

function recompose(d: Decomposed): M2 {
  const a = (d.angle * Math.PI) / 180;
  let m: M2 = [d.m[0], d.m[1], d.m[2], d.m[3], 0, 0];
  m = mulM([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0], m);
  m = mulM([1, 0, 0, 1, d.tx, d.ty], m);
  return mulM(m, [d.sx, 0, 0, d.sy, 0, 0]);
}

/** CSS Transforms 1, "Interpolation of decomposed 2D matrix values". */
function mixMatrices(ma: M2, mb: M2, p: number): string {
  const a = decompose(ma)!;
  const b = decompose(mb)!;
  if ((a.sx < 0 && b.sy < 0) || (a.sy < 0 && b.sx < 0)) {
    a.sx = -a.sx;
    a.sy = -a.sy;
    a.angle += a.angle < 0 ? 180 : -180;
  }
  if (!a.angle) a.angle = 360;
  if (!b.angle) b.angle = 360;
  if (Math.abs(a.angle - b.angle) > 180) {
    if (a.angle > b.angle) a.angle -= 360;
    else b.angle -= 360;
  }
  const l = (x: number, y: number) => x + (y - x) * p;
  const d: Decomposed = {
    tx: l(a.tx, b.tx), ty: l(a.ty, b.ty), sx: l(a.sx, b.sx), sy: l(a.sy, b.sy), angle: l(a.angle, b.angle),
    m: [l(a.m[0], b.m[0]), l(a.m[1], b.m[1]), l(a.m[2], b.m[2]), l(a.m[3], b.m[3])],
  };
  return `matrix(${recompose(d).map(fmt).join(', ')})`;
}

function interpolateTransform(a: string, b: string, p: number): string | null {
  const la = parseTransform(a);
  const lb = parseTransform(b);
  if (la === null || lb === null) return null;
  if (la.length === 0 && lb.length === 0) return 'none';
  const A = la.length === 0 ? lb.map(identityOf) : la;
  const B = lb.length === 0 ? la.map(identityOf) : lb;
  const out: string[] = [];
  const n = Math.min(A.length, B.length);
  let i = 0;
  for (; i < n; i++) {
    const pair = primitives(A[i]!, B[i]!);
    if (pair === null || pair[0].args.length !== pair[1].args.length) break;
    out.push(mixArgs(pair[0], pair[1], 1 - p, p));
  }
  if (i === A.length && i === B.length) return out.join(' ');
  // The rest pairs function by function where the shorter list is padded with identities, else through matrices.
  const restA = A.slice(i);
  const restB = B.slice(i);
  const pad = restA.length !== restB.length && i === n;
  if (pad && (restA.length === 0 || restB.length === 0)) {
    const longer = restA.length === 0 ? restB : restA;
    for (const f of longer) out.push(restA.length === 0 ? mixArgs(identityOf(f), f, 1 - p, p) : mixArgs(f, identityOf(f), 1 - p, p));
    return out.join(' ');
  }
  const ma = matrixOf(restA);
  const mb = matrixOf(restB);
  if (ma === null || mb === null) return null;
  out.push(mixMatrices(ma, mb, p));
  return out.join(' ');
}

function accumulateTransform(under: string, value: string): string | null {
  const a = parseTransform(under);
  const b = parseTransform(value);
  if (a === null || b === null) return null;
  if (a.length === 0) return value;
  if (b.length === 0) return under;
  if (a.length === b.length) {
    const pairs = a.map((f, i) => primitives(f, b[i]!));
    if (pairs.every((x) => x !== null && x[0].args.length === x[1].args.length)) {
      return (pairs as Array<[Fn, Fn]>)
        .map(([x, y]) => {
          const scale = /^scale/.test(x.name);
          return `${x.name}(${x.args.map((arg, i) => lengthSum(arg.value - (scale ? 1 : 0), arg.unit, 1, y.args[i]!.value, y.args[i]!.unit, 1)).join(', ')})`;
        })
        .join(' ');
    }
  }
  return `${under} ${value}`;
}

// ---- filters ----

const FILTER_NEUTRAL: Record<string, string> = {
  blur: 'blur(0px)', brightness: 'brightness(1)', contrast: 'contrast(1)', grayscale: 'grayscale(0)', 'hue-rotate': 'hue-rotate(0deg)',
  invert: 'invert(0)', opacity: 'opacity(1)', saturate: 'saturate(1)', sepia: 'sepia(0)', 'drop-shadow': 'drop-shadow(0px 0px 0px transparent)',
};

function filterList(text: string): string[] | null {
  const t = text.trim();
  if (t === 'none') return [];
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '(') depth++;
    else if (t[i] === ')' && --depth === 0) {
      out.push(t.slice(start, i + 1).trim());
      start = i + 1;
    }
  }
  return t.slice(start).trim() === '' ? out : null;
}

const filterName = (f: string) => f.slice(0, f.indexOf('(')).trim();

function interpolateFilter(a: string, b: string, p: number): string | null {
  const la = filterList(a);
  const lb = filterList(b);
  if (la === null || lb === null) return null;
  if (la.length === 0 && lb.length === 0) return 'none';
  const n = Math.max(la.length, lb.length);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const fa = la[i] ?? FILTER_NEUTRAL[filterName(lb[i]!)];
    const fb = lb[i] ?? FILTER_NEUTRAL[filterName(la[i]!)];
    if (fa === undefined || fb === undefined || filterName(fa) !== filterName(fb)) return null;
    // `brightness(150%)` and `brightness(1.5)` are one value.
    const norm = (f: string) => f.replace(/([\d.]+)%/g, (_, v) => (filterName(f) === 'blur' || filterName(f) === 'drop-shadow' ? `${v}%` : String(Number(v) / 100)));
    const mixed = combineParts(tokenize(norm(fa)), tokenize(norm(fb)), 1 - p, p, (x, y) => mixColors(x, y, p));
    if (mixed === null) return null;
    out.push(mixed);
  }
  return out.join(' ');
}

// ---- lists of shadows ----

function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

/** A shadow with its colour last and every length given, so two shadows line up part by part. */
function normalShadow(s: string): string {
  const parts = tokenize(s);
  const color = parts.find((x) => x.kind === 'color');
  const inset = parts.some((x) => x.kind === 'text' && /\binset\b/.test(x.text));
  const nums = parts.filter((x): x is Extract<Part, { kind: 'num' }> => x.kind === 'num').map((x) => `${fmt(x.value)}${x.unit || 'px'}`);
  while (nums.length < 4) nums.push('0px');
  return `${inset ? 'inset ' : ''}${nums.join(' ')} ${color ? formatColor(color.color) : 'rgb(0, 0, 0)'}`;
}

function interpolateShadows(a: string, b: string, p: number, property: string): string | null {
  const la = a.trim() === 'none' ? [] : splitTop(a).map(normalShadow);
  const lb = b.trim() === 'none' ? [] : splitTop(b).map(normalShadow);
  if (la.length === 0 && lb.length === 0) return 'none';
  const zero = (s: string) => `${s.startsWith('inset') ? 'inset ' : ''}0px 0px 0px 0px transparent`;
  const n = Math.max(la.length, lb.length);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let x = la[i] ?? zero(lb[i]!);
    let y = lb[i] ?? zero(la[i]!);
    if (property === 'text-shadow') {
      // A text shadow has no spread.
      x = x.replace(/^((?:inset )?\S+ \S+ \S+) \S+/, '$1');
      y = y.replace(/^((?:inset )?\S+ \S+ \S+) \S+/, '$1');
    }
    const mixed = combineParts(tokenize(normalShadow(x)), tokenize(normalShadow(y)), 1 - p, p, (c, d) => mixColors(c, d, p));
    if (mixed === null) return null;
    out.push(property === 'text-shadow' ? mixed.replace(/^((?:inset )?\S+ \S+ \S+) \S+/, '$1') : mixed);
  }
  return out.join(', ');
}

// ---- the entry points ----

/**
 * The value `p` of the way from `a` to `b` for `property` (kebab-case). `p` may be outside 0..1 (an easing that
 * overshoots); colours and other bounded values are clamped where they are drawn.
 */
export function interpolateValue(property: string, a: string, b: string, p: number): string {
  if (p === 0) return a;
  if (p === 1) return b;
  const discrete = p < 0.5 ? a : b;
  if (a === b) return a;
  if (property === 'visibility') return a === 'visible' || b === 'visible' ? (p <= 0 ? a : p >= 1 ? b : 'visible') : discrete;
  let mixed: string | null = null;
  if (property === 'transform') mixed = interpolateTransform(a, b, p);
  else if (property === 'filter' || property === 'backdrop-filter') mixed = interpolateFilter(a, b, p);
  else if (property === 'box-shadow' || property === 'text-shadow') mixed = interpolateShadows(a, b, p, property);
  else mixed = combineParts(tokenize(a), tokenize(b), 1 - p, p, (x, y) => mixColors(x, y, p));
  if (mixed === null) return discrete;
  return clampValue(property, mixed);
}

const INTEGER_PROPERTIES = new Set(['z-index', 'order', 'orphans', 'widows', 'column-count']);
const UNIT_INTERVAL = new Set(['opacity', 'fill-opacity', 'stroke-opacity', 'stop-opacity', 'flood-opacity']);
const NON_NEGATIVE = /^(width|height|min-width|min-height|max-width|max-height|padding(-\w+)?|border(-\w+)?-width|border(-\w+)*-radius|font-size|line-height|gap|row-gap|column-gap|stroke-width|outline-width|flex-grow|flex-shrink|r|rx|ry)$/;
const NON_NEGATIVE_FILTERS = /(blur|brightness|contrast|grayscale|invert|opacity|saturate|sepia)\(([^)]*)\)/g;

/**
 * A value an easing took past its keyframes, brought into the property's range, as a browser does when it computes
 * the animated value (an opacity of 1.08 is 1; a negative width is 0, which would otherwise not parse at all).
 */
function clampValue(property: string, value: string): string {
  const number = /-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi;
  if (UNIT_INTERVAL.has(property)) return value.replace(number, (v) => fmt(Math.min(1, Math.max(0, Number(v)))));
  if (INTEGER_PROPERTIES.has(property)) return value.replace(number, (v) => String(Math.round(Number(v))));
  if (NON_NEGATIVE.test(property) && !value.includes('calc(')) return value.replace(number, (v) => fmt(Math.max(0, Number(v))));
  if (property === 'filter' || property === 'backdrop-filter') {
    return value.replace(NON_NEGATIVE_FILTERS, (whole, name: string, body: string) => `${name}(${body.replace(number, (v) => fmt(Math.max(0, Number(v))))})`);
  }
  return value;
}

/**
 * `value` combined with `under` by `composite` (`add` or `accumulate`; `replace` is `value`): numbers summed, colours
 * added, a transform list appended (`add`) or summed function by function (`accumulate`). A pair that cannot be
 * combined is `value`.
 */
export function compositeValue(property: string, under: string, value: string, composite: 'replace' | 'add' | 'accumulate'): string {
  if (composite === 'replace') return value;
  if (property === 'transform') {
    if (composite === 'add') return under.trim() === 'none' ? value : value.trim() === 'none' ? under : `${under} ${value}`;
    return accumulateTransform(under, value) ?? value;
  }
  if (property === 'filter' || property === 'backdrop-filter') {
    if (under.trim() === 'none') return value;
    if (value.trim() === 'none') return under;
    return `${under} ${value}`;
  }
  return combineParts(tokenize(under), tokenize(value), 1, 1, addColors) ?? value;
}
