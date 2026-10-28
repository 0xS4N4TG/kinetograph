// The 2D matrices an SVG element's box goes through on its way to the page, for `getBoundingClientRect` and `getBBox`:
// a CSS `transform` (which wins over the `transform` attribute), a nested `<svg>`'s viewport, and an `<svg>`'s `viewBox`
// with its `preserveAspectRatio` (SVG 2, section 8.2). A matrix is `[a, b, c, d, e, f]` as in `matrix(...)`.

export type Affine = [number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** `a` after `b`: a point goes through `b` first. */
export function mulAffine(a: Affine, b: Affine): Affine {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/** A box's corners through `m`: the box around them, as a browser maps a box through a transform. */
export function mapBox(m: Affine, x: number, y: number, width: number, height: number): { x: number; y: number; width: number; height: number } {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [px, py] of [[x, y], [x + width, y], [x, y + height], [x + width, y + height]] as const) {
    const tx = m[0] * px + m[2] * py + m[4];
    const ty = m[1] * px + m[3] * py + m[5];
    x1 = Math.min(x1, tx);
    y1 = Math.min(y1, ty);
    x2 = Math.max(x2, tx);
    y2 = Math.max(y2, ty);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** A `viewBox` attribute, or null when it is missing or invalid (a width or height that is not positive). */
export function parseViewBox(value: string | null): [number, number, number, number] | null {
  if (value === null) return null;
  const v = value.trim().split(/[\s,]+/).map(Number);
  if (v.length !== 4 || !v.every(Number.isFinite) || v[2]! <= 0 || v[3]! <= 0) return null;
  return v as [number, number, number, number];
}

/**
 * The matrix from `viewBox` user space to a viewport of `width` by `height` at its origin, by `preserveAspectRatio`
 * (`xMidYMid meet` when missing or unknown; `none` stretches each axis).
 */
export function viewBoxMatrix(viewBox: [number, number, number, number], preserveAspectRatio: string | null, width: number, height: number): Affine {
  const [vx, vy, vw, vh] = viewBox;
  let sx = width / vw;
  let sy = height / vh;
  const words = (preserveAspectRatio ?? '').trim().split(/\s+/).filter((w) => w !== 'defer');
  const align = words[0] ?? 'xMidYMid';
  if (align === 'none') return [sx, 0, 0, sy, -vx * sx, -vy * sy];
  const known = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/.exec(align);
  const slice = words[1] === 'slice';
  const s = slice ? Math.max(sx, sy) : Math.min(sx, sy);
  sx = sy = s;
  const ax = known?.[1] ?? 'Mid';
  const ay = known?.[2] ?? 'Mid';
  const place = (at: string, room: number, used: number) => (at === 'Min' ? 0 : at === 'Mid' ? (room - used) / 2 : room - used);
  return [s, 0, 0, s, place(ax, width, vw * s) - vx * s, place(ay, height, vh * s) - vy * s];
}

/** An SVG length attribute (`x`, `width`): user units, or a percentage of `reference`; 0 when it is not a number. */
export function svgLength(value: string, reference: number): number {
  const v = value.trim();
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  return v.endsWith('%') ? (n / 100) * reference : n;
}

/** A length of a CSS transform or `transform-origin`: px or unitless, or a percentage of `reference`. NaN if neither. */
function cssLength(value: string, reference: number): number {
  const v = value.trim();
  if (v.endsWith('%')) return (parseFloat(v) / 100) * reference;
  if (/^-?[\d.]+(e-?\d+)?(px)?$/i.test(v)) return parseFloat(v);
  return NaN;
}

/** An angle in radians: deg (the default for a bare number), rad, grad or turn. */
function cssAngle(value: string): number {
  const v = value.trim();
  const n = parseFloat(v);
  if (v.endsWith('grad')) return (n * Math.PI) / 200;
  if (v.endsWith('rad')) return n;
  if (v.endsWith('turn')) return n * 2 * Math.PI;
  return (n * Math.PI) / 180;
}

/**
 * A computed CSS `transform` (a function list, or `none`) about `transform-origin`, as a 2D matrix. Percentages are of
 * the reference box (`transform-box`). Functions with no 2D part (`rotateX`, `perspective`) leave the matrix as it is;
 * a 3D function contributes its 2D part. Null for `none` or an empty value.
 */
export function cssTransformMatrix(transform: string | null, origin: string | null, box: { x: number; y: number; width: number; height: number }): Affine | null {
  if (transform === null || transform.trim() === '' || transform.trim() === 'none') return null;
  let m: Affine = IDENTITY;
  for (const [, name, raw] of transform.matchAll(/([\w-]+)\s*\(([^)]*)\)/g)) {
    const args = raw!.split(/\s*,\s*|\s+/).filter(Boolean);
    const len = (i: number, ref: number) => {
      const v = args[i] === undefined ? 0 : cssLength(args[i]!, ref);
      return Number.isFinite(v) ? v : 0;
    };
    const num = (i: number, fallback: number) => (args[i] === undefined ? fallback : parseFloat(args[i]!));
    let t: Affine | null = null;
    switch (name) {
      case 'matrix': if (args.length === 6) t = args.map(Number) as Affine; break;
      case 'matrix3d': if (args.length === 16) { const n = args.map(Number); t = [n[0]!, n[1]!, n[4]!, n[5]!, n[12]!, n[13]!]; } break;
      case 'translate': case 'translate3d': t = [1, 0, 0, 1, len(0, box.width), len(1, box.height)]; break;
      case 'translateX': t = [1, 0, 0, 1, len(0, box.width), 0]; break;
      case 'translateY': t = [1, 0, 0, 1, 0, len(0, box.height)]; break;
      case 'scale': case 'scale3d': { const x = num(0, 1); t = [x, 0, 0, num(1, x), 0, 0]; break; }
      case 'scaleX': t = [num(0, 1), 0, 0, 1, 0, 0]; break;
      case 'scaleY': t = [1, 0, 0, num(0, 1), 0, 0]; break;
      case 'rotate': case 'rotateZ': { const a = cssAngle(args[0] ?? '0'); t = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]; break; }
      case 'skew': t = [1, Math.tan(cssAngle(args[1] ?? '0')), Math.tan(cssAngle(args[0] ?? '0')), 1, 0, 0]; break;
      case 'skewX': t = [1, 0, Math.tan(cssAngle(args[0] ?? '0')), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan(cssAngle(args[0] ?? '0')), 0, 1, 0, 0]; break;
    }
    if (t !== null && t.every(Number.isFinite)) m = mulAffine(m, t);
  }
  const o = (origin ?? '0 0').trim().split(/\s+/);
  const keyword = (v: string | undefined, ref: number, low: string, high: string): number => {
    if (v === undefined || v === low) return 0;
    if (v === 'center') return ref / 2;
    if (v === high) return ref;
    const n = cssLength(v, ref);
    return Number.isFinite(n) ? n : 0;
  };
  const ox = box.x + keyword(o[0], box.width, 'left', 'right');
  const oy = box.y + keyword(o[1], box.height, 'top', 'bottom');
  return mulAffine(mulAffine([1, 0, 0, 1, ox, oy], m), [1, 0, 0, 1, -ox, -oy]);
}
