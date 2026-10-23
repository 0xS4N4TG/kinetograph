// SVG measurement for `getBBox`, `getTotalLength` and `getPointAtLength` (packages/cli/skills/kinetograph/references/ENGINE.md §1, "Readback"). Shapes are
// written as path data and handed to the path measuring functions of `@kinetograph/core/paths` (set with
// `setPathMeasure`; compat cannot import core). Lengths are in the element's own user units, before any transform.

export interface PathMeasure {
  getLength(d: string): number;
  getPointAtLength(d: string, length: number): { x: number; y: number } | null;
  getBoundingBox(d: string): { x1: number; y1: number; x2: number; y2: number; width: number; height: number };
}

let measure: PathMeasure | null = null;

/** Core hands over its `getLength`, `getPointAtLength` and `getBoundingBox` (they are Remotion's, ported). */
export function setPathMeasure(fn: PathMeasure | null): void {
  measure = fn;
}

export function pathMeasure(): PathMeasure {
  if (measure === null) throw new Error('SVG geometry is not available: @kinetograph/core has not handed over its path functions (setPathMeasure)');
  return measure;
}

const num = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
};

const points = (value: unknown): [number, number][] => {
  const numbers = String(value ?? '')
    .split(/[\s,]+/)
    .filter((s) => s !== '')
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) out.push([numbers[i]!, numbers[i + 1]!]);
  return out;
};

/** The path data of an SVG basic shape or path from its attributes, or null for an element with no geometry. */
export function shapePath(type: string, attr: (name: string) => unknown): string | null {
  switch (type) {
    case 'path':
      return typeof attr('d') === 'string' ? (attr('d') as string) : null;
    case 'rect': {
      const x = num(attr('x'));
      const y = num(attr('y'));
      const w = num(attr('width'));
      const h = num(attr('height'));
      let rx = num(attr('rx'), NaN);
      let ry = num(attr('ry'), NaN);
      if (Number.isNaN(rx) && Number.isNaN(ry)) {
        rx = 0;
        ry = 0;
      } else if (Number.isNaN(rx)) rx = ry;
      else if (Number.isNaN(ry)) ry = rx;
      rx = Math.min(Math.max(rx, 0), w / 2);
      ry = Math.min(Math.max(ry, 0), h / 2);
      if (rx === 0 || ry === 0) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return (
        `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}` +
        `H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
      );
    }
    case 'circle': {
      const cx = num(attr('cx'));
      const cy = num(attr('cy'));
      const r = num(attr('r'));
      return ellipsePath(cx, cy, r, r);
    }
    case 'ellipse':
      return ellipsePath(num(attr('cx')), num(attr('cy')), num(attr('rx')), num(attr('ry')));
    case 'line':
      return `M${num(attr('x1'))} ${num(attr('y1'))}L${num(attr('x2'))} ${num(attr('y2'))}`;
    case 'polyline':
    case 'polygon': {
      const p = points(attr('points'));
      if (p.length === 0) return null;
      return `M${p.map(([x, y]) => `${x} ${y}`).join('L')}${type === 'polygon' ? 'Z' : ''}`;
    }
    default:
      return null;
  }
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): string | null {
  if (!(rx > 0) || !(ry > 0)) return null;
  return `M${cx + rx} ${cy}A${rx} ${ry} 0 1 1 ${cx - rx} ${cy}A${rx} ${ry} 0 1 1 ${cx + rx} ${cy}Z`;
}

/** The geometry elements `getTotalLength` accepts. */
export const GEOMETRY_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
