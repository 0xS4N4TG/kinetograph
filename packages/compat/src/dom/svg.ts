// SVG (docs/COMPAT.md §4.5): an `svg` is a box, its `viewBox` a group that maps onto it, and its shapes path layers.
// The conversion is done in TypeScript: rect, circle, ellipse, line, polyline and polygon become path data, a
// transform that is a rotation and a uniform scale becomes the layer transform, any other is baked into the path.

import type { Gradient, LayerJson, Paint, Stop, Transform } from '@kinetograph/scene';
import { parseColor } from '../css/index.js';
import type { Rgba } from '../css/types.js';
import { parseViewBox, type Box } from './box.js';
import type { Rect } from './paint.js';
import {
  applyAffine,
  IDENTITY,
  isIdentityAffine,
  multiply,
  parseSvgTransform,
  similarity,
  transformPath,
  type Affine,
} from './pathdata.js';
import { boxPath, NO_RADII } from './shapes.js';
import type { Report, StyledElement } from './tree.js';
import { hex, r3 } from './util.js';

/** SVG elements that are mapped. Others are reported. */
const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const QUIET = new Set(['defs', 'linearGradient', 'radialGradient', 'stop', 'title', 'desc', 'metadata']);

interface State {
  report: Report;
  svg: StyledElement;
  gradients: Map<string, StyledElement>;
  /** A map applied to path data in place of a layer transform (a non-uniform viewBox, a skew): the layers are flat. */
  baking: Affine | null;
  /** The size of the viewBox, for lengths in percent. */
  view: { width: number; height: number };
  viewId: string;
}

interface Paints {
  fill: string;
  fillOpacity: number;
  stroke: string;
  strokeOpacity: number;
  strokeWidth: number;
  color: Rgba;
  /** Whether a property of this kind is set from the presentation attributes, for reports. */
  linecap: string;
  linejoin: string;
  dash: string;
  fillRule: string;
  paintOrder: string;
}

const KEBAB = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** A presentation attribute: the `style` prop wins over the attribute, as in CSS. */
function attr(el: StyledElement, name: string): unknown {
  if (el.rawStyle[name] !== undefined) return el.rawStyle[name];
  return el.props[name] ?? el.props[KEBAB(name)];
}

function number(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(px)?\s*$/.exec(value);
    if (m) return Number(m[1]);
  }
  return null;
}

/** A length that may be a percentage of `of`. */
function lengthOf(value: unknown, of: number): number | null {
  if (typeof value === 'string') {
    const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+))%\s*$/.exec(value);
    if (m) return (Number(m[1]) / 100) * of;
  }
  return number(value);
}

function color(value: string, current: Rgba): Rgba | null {
  if (value.toLowerCase() === 'currentcolor') return current;
  return parseColor(value);
}

function paintsOf(el: StyledElement, parent: Paints): Paints {
  const out = { ...parent };
  const pick = (name: string): unknown => attr(el, name);
  const text = (name: string): string | undefined => {
    const v = pick(name);
    return typeof v === 'string' ? v.trim() : undefined;
  };
  const c = text('color');
  if (c !== undefined) out.color = parseColor(c) ?? out.color;
  const fill = pick('fill');
  if (typeof fill === 'string') out.fill = fill.trim();
  const stroke = pick('stroke');
  if (typeof stroke === 'string') out.stroke = stroke.trim();
  for (const [key, name] of [['fillOpacity', 'fillOpacity'], ['strokeOpacity', 'strokeOpacity']] as const) {
    const v = number(pick(name));
    if (v !== null) out[key] = Math.max(0, Math.min(1, v));
  }
  const width = number(pick('strokeWidth'));
  if (width !== null) out.strokeWidth = width;
  out.linecap = text('strokeLinecap') ?? out.linecap;
  out.linejoin = text('strokeLinejoin') ?? out.linejoin;
  out.dash = text('strokeDasharray') ?? out.dash;
  out.fillRule = text('fillRule') ?? out.fillRule;
  out.paintOrder = text('paintOrder') ?? out.paintOrder;
  return out;
}

// ---- gradients ----

function stopsOf(def: StyledElement, alpha: number, current: Rgba, add: (property: string, value: unknown, reason: string) => void): Stop[] | null {
  const stops: Stop[] = [];
  let last = 0;
  for (const child of def.children) {
    if (child.kind !== 'element' || child.type !== 'stop') continue;
    const offsetRaw = attr(child, 'offset');
    let offset = typeof offsetRaw === 'string' && offsetRaw.trim().endsWith('%') ? Number.parseFloat(offsetRaw) / 100 : number(offsetRaw);
    if (offset === null) offset = 0;
    offset = Math.max(last, Math.max(0, Math.min(1, offset)));
    last = offset;
    const raw = attr(child, 'stopColor');
    const c = typeof raw === 'string' ? color(raw.trim(), current) : { r: 0, g: 0, b: 0, a: 1 };
    if (c === null) {
      add('stopColor', raw, 'not a colour');
      return null;
    }
    const opacity = number(attr(child, 'stopOpacity')) ?? 1;
    stops.push({ offset, color: hex(c, opacity * alpha) });
  }
  if (stops.length < 2) {
    if (stops.length === 1) stops.push({ ...stops[0]! });
    else return null;
  }
  return stops;
}

/** The scene gradient of `<linearGradient>` / `<radialGradient>` `def`, for a path whose user space is the layer's. */
function gradientOf(
  def: StyledElement,
  alpha: number,
  current: Rgba,
  state: State,
  add: (property: string, value: unknown, reason: string) => void,
): Gradient | null {
  if (attr(def, 'href') !== undefined || attr(def, 'xlinkHref') !== undefined) {
    add('href', attr(def, 'href') ?? attr(def, 'xlinkHref'), 'a gradient that inherits from another is not drawn');
    return null;
  }
  if (state.baking !== null) {
    add('fill', `url(#${def.props.id})`, 'a gradient on a shape whose transform is not a rotation and a uniform scale');
    return null;
  }
  const stops = stopsOf(def, alpha, current, add);
  if (stops === null) {
    add('stop', null, 'a gradient needs at least one stop');
    return null;
  }
  const user = attr(def, 'gradientUnits') === 'userSpaceOnUse';
  const matrix = typeof attr(def, 'gradientTransform') === 'string' ? parseSvgTransform(attr(def, 'gradientTransform') as string) : IDENTITY;
  if (matrix === null || similarity(matrix) === null) {
    add('gradientTransform', attr(def, 'gradientTransform'), 'only a rotation, a uniform scale and a translation');
    return null;
  }
  const spread = attr(def, 'spreadMethod');
  const extend: 'reflect' | 'repeat' | undefined = spread === 'reflect' ? 'reflect' : spread === 'repeat' ? 'repeat' : undefined;
  const coordinate = (name: string, fallback: string, along: number): number => {
    const raw = attr(def, name);
    const value = raw === undefined ? fallback : raw;
    if (typeof value === 'string' && value.trim().endsWith('%')) {
      const fraction = Number.parseFloat(value) / 100;
      return user ? fraction * along : fraction;
    }
    return number(value) ?? Number(fallback.replace('%', '')) / 100;
  };
  const fx = (x: number, y: number): [number, number] => applyAffine(matrix, x, y);
  const common = { stops, ...(extend ? { extend } : {}), ...(user ? {} : { units: 'box' as const }) };
  if (def.type === 'linearGradient') {
    const [x0, y0] = fx(coordinate('x1', '0%', state.view.width), coordinate('y1', '0%', state.view.height));
    const [x1, y1] = fx(coordinate('x2', '100%', state.view.width), coordinate('y2', '0%', state.view.height));
    return { type: 'linear', x0: r3(x0 * 1e3) / 1e3, y0: r3(y0 * 1e3) / 1e3, x1: r3(x1 * 1e3) / 1e3, y1: r3(y1 * 1e3) / 1e3, ...common };
  }
  const diagonal = Math.sqrt((state.view.width ** 2 + state.view.height ** 2) / 2);
  const cx = coordinate('cx', '50%', state.view.width);
  const cy = coordinate('cy', '50%', state.view.height);
  const focalX = attr(def, 'fx') === undefined ? cx : coordinate('fx', '50%', state.view.width);
  const focalY = attr(def, 'fy') === undefined ? cy : coordinate('fy', '50%', state.view.height);
  if (Math.abs(focalX - cx) > 1e-9 || Math.abs(focalY - cy) > 1e-9) {
    add('fx', null, 'a focal point apart from the centre is not drawn');
    return null;
  }
  const r = coordinate('r', '50%', diagonal);
  const [tx, ty] = fx(cx, cy);
  const scale = similarity(matrix)!.scale;
  return { type: 'radial', cx: r3(tx * 1e3) / 1e3, cy: r3(ty * 1e3) / 1e3, r: r3(r * scale * 1e3) / 1e3, ...common };
}

function paintFor(
  value: string,
  opacity: number,
  current: Rgba,
  state: State,
  add: (property: string, value: unknown, reason: string) => void,
  property: 'fill' | 'stroke',
): Paint | undefined | null {
  if (value === 'none') return undefined;
  const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)\s*(.*)$/.exec(value);
  if (url) {
    const def = state.gradients.get(url[1]!);
    if (!def) {
      add(property, value, `no gradient with the id "${url[1]}"`);
      return null;
    }
    if (property === 'stroke') {
      add('stroke', value, 'a stroke takes a colour, not a gradient');
      return null;
    }
    return gradientOf(def, opacity, current, state, add);
  }
  const c = color(value, current);
  if (c === null) {
    add(property, value, 'not a colour');
    return null;
  }
  return hex(c, opacity);
}

// ---- elements as path data ----

/** The path data of a shape element, or null (reported) when it cannot be made. */
function pathData(el: StyledElement, state: State, add: (property: string, value: unknown, reason: string) => void): string | null {
  const num = (name: string, along: number, fallback = 0): number | null => {
    const raw = attr(el, name);
    if (raw === undefined) return fallback;
    const v = lengthOf(raw, along);
    if (v === null) add(name, raw, 'not a length in px');
    return v;
  };
  const { width: vw, height: vh } = state.view;
  switch (el.type) {
    case 'path': {
      const d = attr(el, 'd');
      if (typeof d !== 'string' || d.trim() === '') {
        add('d', d, 'a path needs path data');
        return null;
      }
      return d;
    }
    case 'rect': {
      const x = num('x', vw);
      const y = num('y', vh);
      const w = num('width', vw);
      const h = num('height', vh);
      if (x === null || y === null || w === null || h === null) return null;
      let rx = attr(el, 'rx') === undefined ? null : num('rx', vw);
      let ry = attr(el, 'ry') === undefined ? null : num('ry', vh);
      if (rx === null && ry === null) {
        rx = 0;
        ry = 0;
      } else {
        rx ??= ry;
        ry ??= rx;
      }
      rx = Math.min(Math.max(0, rx!), w / 2);
      ry = Math.min(Math.max(0, ry!), h / 2);
      return boxPath(x, y, w, h, { tl: [rx, ry], tr: [rx, ry], br: [rx, ry], bl: [rx, ry] });
    }
    case 'circle': {
      const cx = num('cx', vw);
      const cy = num('cy', vh);
      const r = num('r', Math.sqrt((vw * vw + vh * vh) / 2));
      if (cx === null || cy === null || r === null) return null;
      return ellipsePath(cx, cy, r, r);
    }
    case 'ellipse': {
      const cx = num('cx', vw);
      const cy = num('cy', vh);
      const rx = num('rx', vw);
      const ry = num('ry', vh);
      if (cx === null || cy === null || rx === null || ry === null) return null;
      return ellipsePath(cx, cy, rx, ry);
    }
    case 'line': {
      const x1 = num('x1', vw);
      const y1 = num('y1', vh);
      const x2 = num('x2', vw);
      const y2 = num('y2', vh);
      if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
      return `M${r3(x1)} ${r3(y1)} L${r3(x2)} ${r3(y2)}`;
    }
    default: {
      const raw = attr(el, 'points');
      const points = typeof raw === 'string' ? raw.trim().split(/[\s,]+/).filter((s) => s !== '').map(Number) : null;
      if (points === null || points.length < 2 || points.length % 2 !== 0 || points.some((n) => !Number.isFinite(n))) {
        add('points', raw, 'not a list of coordinate pairs');
        return null;
      }
      const parts = points.map((v, i) => (i % 2 === 0 ? `${i === 0 ? 'M' : 'L'}${r3(v)}` : String(r3(v))));
      const d: string[] = [];
      for (let i = 0; i < parts.length; i += 2) d.push(`${parts[i]} ${parts[i + 1]}`);
      return el.type === 'polygon' ? `${d.join(' ')} Z` : d.join(' ');
    }
  }
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  return `M${r3(cx - rx)} ${r3(cy)} A${r3(rx)} ${r3(ry)} 0 1 0 ${r3(cx + rx)} ${r3(cy)} A${r3(rx)} ${r3(ry)} 0 1 0 ${r3(cx - rx)} ${r3(cy)} Z`;
}

// ---- the walk ----

function gradientsIn(el: StyledElement, out: Map<string, StyledElement>): void {
  for (const child of el.children) {
    if (child.kind !== 'element') continue;
    if ((child.type === 'linearGradient' || child.type === 'radialGradient') && typeof child.props.id === 'string') {
      out.set(child.props.id, child);
    }
    gradientsIn(child, out);
  }
}

/** The layer transform and opacity every element shares, and the path data transform that is left over. */
function placement(
  el: StyledElement,
  state: State,
  add: (property: string, value: unknown, reason: string) => void,
): { transform?: Transform; baking: Affine | null; matrix: Affine } | null {
  const raw = attr(el, 'transform');
  let own: Affine = IDENTITY;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = parseSvgTransform(raw);
    if (parsed === null) {
      add('transform', raw, 'not an SVG transform list');
      return null;
    }
    own = parsed;
  }
  if (state.baking !== null) {
    return { baking: multiply(state.baking, own), matrix: own };
  }
  if (isIdentityAffine(own)) return { baking: null, matrix: own };
  const s = similarity(own);
  if (s === null) return { baking: own, matrix: own };
  const transform: Transform = {};
  if (s.x !== 0) transform.x = r3(s.x);
  if (s.y !== 0) transform.y = r3(s.y);
  if (Math.abs(s.rotation) > 1e-9) transform.rotation = r3(s.rotation * 1e3) / 1e3;
  if (Math.abs(s.scale - 1) > 1e-9) transform.scale = r3(s.scale * 1e6) / 1e6;
  return { transform, baking: null, matrix: own };
}

function walk(el: StyledElement, paints: Paints, state: State, id: string, chain: string): LayerJson | null {
  const { report } = state;
  const add = (property: string, value: unknown, reason: string): void => report.add(el, chain, property, value, reason);

  if (QUIET.has(el.type)) return null;
  const isGroup = el.type === 'g';
  if (!isGroup && !SHAPES.has(el.type)) {
    report.add(el, chain, null, null, 'this SVG element is not drawn natively');
    return null;
  }
  report.diagnostics(el, chain);
  if (attr(el, 'display') === 'none') return null;
  const visibility = attr(el, 'visibility');
  const hidden = visibility === 'hidden' || visibility === 'collapse';

  const mine = paintsOf(el, paints);
  const placed = placement(el, state, add);
  if (placed === null) return null;
  const opacity = number(attr(el, 'opacity'));
  const common: { transform?: Transform; opacity?: number } = {};
  if (placed.transform) common.transform = placed.transform;
  if (opacity !== null && opacity !== 1) common.opacity = Math.max(0, Math.min(1, opacity));

  if (isGroup) {
    const inner: State = { ...state, baking: placed.baking };
    if (hidden) return null;
    const children = walkChildren(el, mine, inner, id, chain);
    if (children.length === 0) return null;
    return { id, type: 'group', ...common, children } as LayerJson;
  }
  if (hidden) return null;

  // ---- a shape ----
  const d = pathData(el, state, add);
  if (d === null) return null;
  let data = d;
  let strokeScale = 1;
  if (placed.baking !== null) {
    const baked = transformPath(d, placed.baking);
    if (baked === null) {
      add('d', d, 'the path data does not parse');
      return null;
    }
    data = baked;
    const s = similarity(placed.baking);
    if (s) strokeScale = s.scale;
    else if (mine.stroke !== 'none') add('stroke', mine.stroke, 'a stroke under a transform that is not a rotation and a uniform scale');
  }

  const fillValue = el.type === 'line' ? 'none' : mine.fill;
  const fill = paintFor(fillValue, mine.fillOpacity, mine.color, { ...state, baking: placed.baking }, add, 'fill');
  if (fill === null) return null;
  const strokePaint = paintFor(mine.stroke, mine.strokeOpacity, mine.color, state, add, 'stroke');
  if (strokePaint === null) return null;

  if (mine.fillRule === 'evenodd' && fill !== undefined) add('fillRule', 'evenodd', 'only the non-zero fill rule is drawn');
  if (strokePaint !== undefined && mine.strokeWidth > 0) {
    if (mine.linecap !== 'butt') add('strokeLinecap', mine.linecap, 'only butt caps are drawn');
    if (mine.linejoin !== 'miter') add('strokeLinejoin', mine.linejoin, 'only miter joins are drawn');
    if (mine.dash !== 'none') add('strokeDasharray', mine.dash, 'dashes are not drawn');
  }
  if (mine.paintOrder !== 'normal') add('paintOrder', mine.paintOrder, 'only the default paint order is drawn');

  const layer: Record<string, unknown> = { id, type: 'shape', shape: { kind: 'path', d: data } };
  if (fill !== undefined) layer.fill = fill;
  if (strokePaint !== undefined && mine.strokeWidth > 0) {
    layer.stroke = { color: strokePaint, width: r3(mine.strokeWidth * strokeScale) };
  }
  if (fill === undefined && layer.stroke === undefined) return null;
  Object.assign(layer, common);
  return layer as unknown as LayerJson;
}

function walkChildren(el: StyledElement, paints: Paints, state: State, id: string, chain: string): LayerJson[] {
  const out: LayerJson[] = [];
  let index = 0;
  for (const child of el.children) {
    if (child.kind !== 'element') continue;
    const childId = `${id}.${index++}`;
    const layer = walk(child, paints, state, childId, `${chain.split(' > ')[0]} > ${child.type}`);
    if (layer !== null) out.push(layer);
  }
  return out;
}

const INITIAL: Paints = {
  fill: 'black',
  fillOpacity: 1,
  stroke: 'none',
  strokeOpacity: 1,
  strokeWidth: 1,
  color: { r: 0, g: 0, b: 0, a: 1 },
  linecap: 'butt',
  linejoin: 'miter',
  dash: 'none',
  fillRule: 'nonzero',
  paintOrder: 'normal',
};

/**
 * The `<node>.view` group of an `svg` laid out at `content` (the box's content rectangle): the `viewBox` mapped onto
 * it, and the drawing inside.
 */
export function mapSvg(svg: StyledElement, content: Rect, box: Box, report: Report): LayerJson | null {
  const add = (property: string, value: unknown, reason: string): void => report.add(svg, 'svg', property, value, reason);
  const view = parseViewBox(svg.props.viewBox) ?? { x: 0, y: 0, width: content.w, height: content.h };
  const viewId = `${box.id}.view`;
  const gradients = new Map<string, StyledElement>();
  gradientsIn(svg, gradients);

  // preserveAspectRatio
  const raw = typeof svg.props.preserveAspectRatio === 'string' ? svg.props.preserveAspectRatio.trim() : 'xMidYMid meet';
  const [alignRaw, mode = 'meet'] = raw.split(/\s+/).filter((s) => s !== 'defer');
  const align = alignRaw ?? 'xMidYMid';
  if (!/^(none|x(Min|Mid|Max)Y(Min|Mid|Max))$/.test(align) || (mode !== 'meet' && mode !== 'slice')) {
    add('preserveAspectRatio', raw, 'not a preserveAspectRatio value');
    return null;
  }
  const sx = content.w / view.width;
  const sy = content.h / view.height;

  let baking: Affine | null = null;
  const transform: Transform = {};
  let clip: LayerJson['clip'];
  if (align === 'none') {
    if (Math.abs(sx - sy) > 1e-9 * Math.max(sx, sy)) {
      baking = [sx, 0, 0, sy, content.x - view.x * sx, content.y - view.y * sy];
    } else {
      placeUniform(transform, sx, 0, 0, content, view);
    }
  } else {
    const s = mode === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
    const slackX = content.w - view.width * s;
    const slackY = content.h - view.height * s;
    const ox = align.includes('XMid') ? slackX / 2 : align.includes('XMax') ? slackX : 0;
    const oy = align.includes('YMid') ? slackY / 2 : align.includes('YMax') ? slackY : 0;
    placeUniform(transform, s, ox, oy, content, view);
    if (mode === 'slice') {
      // The part of the viewBox that falls inside the box, in the group's own coordinates.
      clip = {
        kind: 'path',
        d: boxPath(view.x - ox / s, view.y - oy / s, content.w / s, content.h / s, NO_RADII),
      };
    }
  }

  const state: State = {
    report,
    svg,
    gradients,
    baking,
    view: { width: view.width, height: view.height },
    viewId,
  };
  // The svg element's own presentation attributes are the inherited defaults of what is inside it.
  const paints = paintsOf(svg, { ...INITIAL, color: box.inh.color });
  const children = walkChildren(svg, paints, state, viewId, 'svg');
  if (children.length === 0) return null;
  const layer: Record<string, unknown> = { id: viewId, type: 'group', children };
  if (Object.keys(transform).length > 0) layer.transform = transform;
  if (clip) layer.clip = clip;
  return layer as unknown as LayerJson;
}

/** The view group's transform for a uniform scale `s` and an alignment offset (`ox`, `oy`) inside `content`. */
function placeUniform(
  transform: Transform,
  s: number,
  ox: number,
  oy: number,
  content: Rect,
  view: { x: number; y: number },
): void {
  // p -> (content + offset) + s (p - view.min): the matrix is translate(x, y) scale(s) translate(-anchor).
  const x = content.x + ox;
  const y = content.y + oy;
  if (x !== 0) transform.x = r3(x);
  if (y !== 0) transform.y = r3(y);
  if (Math.abs(s - 1) > 1e-9) transform.scale = r3(s * 1e6) / 1e6;
  if (view.x !== 0) transform.anchorX = r3(view.x);
  if (view.y !== 0) transform.anchorY = r3(view.y);
}
