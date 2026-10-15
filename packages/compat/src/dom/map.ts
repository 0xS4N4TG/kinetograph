// Map: laid-out boxes become layers (docs/COMPAT.md §4.2, §4.3, §5.2). Every number written is a constant: the DOM
// is read at the frame, and animation comes from the component rendering again.

import type { BlendMode, CameraJson, Effect, LayerJson, Mask, Transform } from '@kinetograph/scene';
import type { BackgroundImage, ParsedStyle, Rgba } from '../css/types.js';
import type { Box } from './box.js';
import {
  backgroundLayer,
  borderBox,
  boxShadowEffects,
  clipFor,
  colorString,
  contentBox,
  filterEffects,
  gradientFor,
  innerRadii,
  paddingBox,
  region,
  textShadowEffects,
  type BoxGeometry,
  type Rect,
} from './paint.js';
import { boxPath, boxShape, hasRadii, resolveRadii, shrinkRadii } from './shapes.js';
import { colorOf } from './style.js';
import { mapSvg } from './svg.js';
import { isIdentity, needsPivot, reduceTransform } from './transform.js';
import type { Report } from './tree.js';
import { constant, hex, plus, px, r3, snapUp, type LengthEnv } from './util.js';

export interface MapContext {
  report: Report;
  viewport: { width: number; height: number };
  /** The camera a `perspective` property asked for. */
  camera: CameraJson | null;
}

/** Where a box's parent's border box is in the island, and whether every ancestor is untransformed. */
interface Origin {
  x: number;
  y: number;
  exact: boolean;
}

const BLEND: Record<string, BlendMode> = {
  normal: 'normal',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color-dodge': 'colorDodge',
  'color-burn': 'colorBurn',
  'hard-light': 'hardLight',
  'soft-light': 'softLight',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};

const isPositioned = (b: Box): boolean => b.style.position === 'relative' || b.style.position === 'absolute' || b.style.position === 'fixed';

/** A `zIndex` applies to positioned boxes and to flex items. */
function zOf(b: Box): number | null {
  const z = b.style.zIndex;
  return typeof z === 'number' && (isPositioned(b) || b.flexItem) ? z : null;
}

function makesStackingContext(b: Box): boolean {
  const s = b.style;
  return (
    b.parent === null ||
    zOf(b) !== null ||
    (s.opacity !== undefined && s.opacity < 1) ||
    (s.transform?.length ?? 0) > 0 ||
    (s.filter?.length ?? 0) > 0 ||
    (s.mixBlendMode !== undefined && s.mixBlendMode !== 'normal') ||
    (s.clipPath !== undefined && s.clipPath !== 'none') ||
    (s.maskImage?.length ?? 0) > 0 ||
    s.transformStyle === 'preserve-3d' ||
    (s.perspective !== undefined && s.perspective !== 'none') ||
    s.position === 'fixed'
  );
}

/** The children in the order they paint (docs/COMPAT.md §5.2): below-zero z-indexes, in-flow boxes, positioned boxes
 *  in tree order, then above-zero z-indexes. */
function paintOrder(children: Box[]): Box[] {
  const neg: Box[] = [];
  const flow: Box[] = [];
  const zero: Box[] = [];
  const pos: Box[] = [];
  for (const child of children) {
    const z = zOf(child);
    if (z !== null && z < 0) neg.push(child);
    else if (z !== null && z > 0) pos.push(child);
    else if (z !== null || isPositioned(child)) zero.push(child);
    else flow.push(child);
  }
  const byZ = (a: Box, b: Box): number => zOf(a)! - zOf(b)!;
  return [...neg.sort(byZ), ...flow, ...zero, ...pos.sort(byZ)];
}

/** The boxes that take part in their stacking context's z ordering, not counting what is inside a nested context. */
function participants(box: Box, out: Box[] = []): Box[] {
  for (const child of box.children) {
    if (isPositioned(child) || zOf(child) !== null) out.push(child);
    if (!makesStackingContext(child)) participants(child, out);
  }
  return out;
}

/** A `zIndex` that would reach out of a box that is not a stacking context to interleave with boxes outside it. */
function checkStacking(box: Box, report: Report): void {
  if (makesStackingContext(box)) {
    const all = participants(box);
    for (const p of all) {
      const z = zOf(p);
      if (z === null || z === 0 || p.parent === box) continue;
      // `p` sorts among the participants of `box`; it is painted inside its non-context parent chain instead. That
      // only matters if a participant outside that chain could interleave with it.
      let top = p;
      while (top.parent !== box && top.parent !== null) top = top.parent;
      const inside = new Set<Box>();
      const collect = (b: Box): void => {
        inside.add(b);
        b.children.forEach(collect);
      };
      collect(top);
      if (all.some((other) => !inside.has(other))) {
        report.add(p.el ?? box.el!, p.el?.type ?? 'div', 'zIndex', z, 'a z-index inside a box that is not a stacking context would interleave with boxes outside it');
      }
    }
  }
  for (const child of box.children) checkStacking(child, report);
}

// ---- geometry of a box ----

function geometryOf(box: Box): BoxGeometry {
  const rect = box.rect!;
  const style = box.style;
  const env = box.env;
  return {
    width: rect.width,
    height: rect.height,
    border: rect.border,
    padding: rect.padding,
    radii: resolveRadii(style.borderRadius, rect.width, rect.height, env),
  };
}

function currentOf(box: Box): Rgba {
  return box.inh.color;
}

/** The layer id plus a suffix. */
const sub = (box: Box, suffix: string): string => `${box.id}.${suffix}`;

// ---- the group of a box ----

function mapBox(box: Box, mc: MapContext, parent: Origin): LayerJson | null {
  const rect = box.rect!;
  if (box.anonymous) return textLayer(box, box.id, rect, 0, 0);
  if (box.content.kind === 'native') return placeNative(box, rect);

  const el = box.el!;
  const { report } = mc;
  const style = box.style;
  const geom = geometryOf(box);
  const border = borderBox(geom);
  const env = box.env;
  const current = currentOf(box);
  const visible = box.inh.visible;
  const bad = (property: string, value: unknown, reason: string): void => report.add(el, el.type, property, value, reason);
  const badPaint = (property: string, value: string, reason: string): void => bad(property, value, reason);

  const layers: LayerJson[] = [];

  // ---- the group's own fields ----
  const fields: {
    transform?: Transform;
    opacity?: number;
    blendMode?: BlendMode;
    effects?: Effect[];
    clip?: ReturnType<typeof clipFor>;
    mask?: Mask;
    preserve3d?: boolean;
  } = {};

  let opacity = style.opacity ?? 1;
  if (style.filter && style.filter.length > 0) {
    const f = filterEffects(style.filter, env, current);
    if (f.effects.length > 0) fields.effects = f.effects;
    opacity *= f.opacity;
  }
  if (opacity !== 1) fields.opacity = r3(Math.max(0, Math.min(1, opacity)) * 1e3) / 1e3;
  if (style.mixBlendMode !== undefined && style.mixBlendMode !== 'normal') {
    const mode = BLEND[style.mixBlendMode];
    if (mode) fields.blendMode = mode;
    else bad('mixBlendMode', style.mixBlendMode, 'not a blend mode the engine has');
  }
  if (style.clipPath !== undefined && style.clipPath !== 'none') {
    if ('fillRule' in style.clipPath && style.clipPath.fillRule === 'evenodd') {
      bad('clipPath', 'evenodd', 'a clip with the even-odd fill rule is not drawn');
    }
    fields.clip = clipFor(style.clipPath, border, env);
  }

  // The transform: the box's place and the CSS transform about its origin.
  const origin = transformOf(box, rect, fields, mc);
  const here: Origin = {
    x: parent.x + rect.x,
    y: parent.y + rect.y,
    exact: parent.exact && origin.plain,
  };

  // perspective -> the scene's camera
  if (style.perspective !== undefined && style.perspective !== 'none') {
    cameraOf(box, here, mc);
  }
  if (style.transformStyle === 'preserve-3d') {
    fields.preserve3d = true;
    if (fields.effects || fields.clip || fields.blendMode) {
      bad('transformStyle', 'preserve-3d', 'a 3D group cannot also have a filter, a clip-path or a blend mode');
    }
  }

  // ---- what the box paints ----
  if (visible) paintBackground(box, geom, layers, badPaint);

  // ---- its content ----
  const content: LayerJson[] = [];
  const own = ownContent(box, geom, mc);
  if (own !== null) content.push(own);
  for (const child of paintOrder(box.children)) {
    const mapped = mapBox(child, mc, { x: here.x, y: here.y, exact: here.exact });
    if (mapped !== null) content.push(mapped);
  }

  let body: LayerJson[] = content;
  const clipsContent = ['hidden', 'clip', 'auto'].includes(style.overflowX ?? 'visible') || ['hidden', 'clip', 'auto'].includes(style.overflowY ?? 'visible');
  if (style.overflowX === 'scroll' || style.overflowY === 'scroll') {
    bad('overflow', 'scroll', 'a scroll container draws scroll bars');
  }
  if (clipsContent && content.length > 0) {
    const padding = region(geom, 'padding-box');
    body = [
      {
        id: sub(box, 'content'),
        type: 'group',
        clip: { kind: 'path', d: boxPath(padding.rect.x, padding.rect.y, padding.rect.w, padding.rect.h, padding.radii) },
        children: content,
      },
    ];
  }

  // A picture as the mask is a sibling that mattes everything the box paints.
  const maskImage = style.maskImage;
  let result: LayerJson[] = [...layers, ...body];
  if (maskImage && maskImage.length > 0) {
    const masked = maskOf(box, geom, maskImage, badPaint);
    if (masked !== null) {
      if ('gradient' in masked) {
        fields.mask = masked;
      } else {
        result = [
          masked.layer,
          { id: sub(box, 'masked'), type: 'group', matte: { layer: masked.layer.id, mode: 'alpha' }, children: result },
        ];
      }
    }
  }

  const children = result;
  if (children.length === 0) return null;
  return { id: box.id, type: 'group', ...fields, children } as LayerJson;
}

/** The transform fields of a box's group; `plain` is false when the box turns, scales or is moved in 3D. */
function transformOf(
  box: Box,
  rect: NonNullable<Box['rect']>,
  fields: { transform?: Transform },
  mc: MapContext,
): { plain: boolean } {
  const style = box.style;
  const { report } = mc;
  const el = box.el!;
  const list = style.transform ?? [];
  let x = rect.x;
  let y = rect.y;
  const transform: Transform = {};
  let plain = true;

  if (list.length > 0) {
    const reduced = reduceTransform(list, { width: rect.width, height: rect.height }, box.env);
    if ('error' in reduced) {
      report.add(el, el.type, 'transform', JSON.stringify(list), `cannot be a layer transform: ${reduced.error}`);
    } else if (!isIdentity(reduced)) {
      x += reduced.tx;
      y += reduced.ty;
      if (needsPivot(reduced)) {
        plain = false;
        // The origin is a point of the box; a group has no box to take a fraction of, so it is the anchor.
        const o = style.transformOrigin;
        const ox = o ? px(o[0], box.env, rect.width) : rect.width / 2;
        const oy = o ? px(o[1], box.env, rect.height) : rect.height / 2;
        if (o && o[2].value !== 0) report.add(el, el.type, 'transformOrigin', 'z offset', 'the z offset of the origin is not drawn');
        transform.anchorX = r3(ox);
        transform.anchorY = r3(oy);
        x += ox;
        y += oy;
        if (reduced.scale !== 1) transform.scale = r3(reduced.scale * 1e6) / 1e6;
        if (reduced.rotation !== 0) transform.rotation = r3(reduced.rotation * 1e3) / 1e3;
        if (reduced.rotateX !== 0) transform.rotateX = r3(reduced.rotateX * 1e3) / 1e3;
        if (reduced.rotateY !== 0) transform.rotateY = r3(reduced.rotateY * 1e3) / 1e3;
      }
      if (reduced.tz !== 0) transform.z = r3(reduced.tz);
    }
  }
  if (x !== 0) transform.x = r3(x);
  if (y !== 0) transform.y = r3(y);
  if (Object.keys(transform).length > 0) fields.transform = transform;
  return { plain };
}

function cameraOf(box: Box, here: Origin, mc: MapContext): void {
  const style = box.style;
  const el = box.el!;
  const rect = box.rect!;
  const perspective = px(style.perspective as { unit: 'px'; value: number }, box.env, 0);
  if (!(perspective > 0)) {
    mc.report.add(el, el.type, 'perspective', perspective, 'the perspective must be above 0');
    return;
  }
  if (!here.exact) {
    mc.report.add(el, el.type, 'perspective', perspective, 'the perspective origin is not known under a transformed box');
    return;
  }
  const o = style.perspectiveOrigin;
  const ox = o ? px(o[0], box.env, rect.width) : rect.width / 2;
  const oy = o ? px(o[1], box.env, rect.height) : rect.height / 2;
  const camera: CameraJson = { perspective: r3(perspective), x: r3(here.x + ox), y: r3(here.y + oy) };
  if (mc.camera === null) {
    mc.camera = camera;
  } else if (mc.camera.perspective !== camera.perspective || mc.camera.x !== camera.x || mc.camera.y !== camera.y) {
    mc.report.add(el, el.type, 'perspective', perspective, 'one camera serves the whole scene; a second, different perspective is not drawn');
  }
}

// ---- background, shadow and border ----

function paintBackground(
  box: Box,
  geom: BoxGeometry,
  layers: LayerJson[],
  bad: (property: string, value: string, reason: string) => void,
): void {
  const style = box.style;
  const env = box.env;
  const current = currentOf(box);
  const border = borderBox(geom);
  const fill = colorOf(style.backgroundColor, current);
  const hasFill = fill !== undefined && fill.a > 0;
  const hasBorder = geom.border.some((w) => w > 0);
  const images = style.backgroundImage ?? [];

  // ---- .bg: fill and shadows ----
  const shadows = boxShadowEffects(style.boxShadow ?? [], env, current);
  const effects: Effect[] = [];
  if (shadows.inset.length > 0) {
    if (hasFill && fill!.a === 1 && images.length === 0 && !hasBorder) effects.push(...shadows.inset);
    else bad('boxShadow', 'inset', 'an inset shadow is drawn only on an opaque colour box with no border and no background image');
  }
  if (shadows.outer.length > 0) {
    if (hasFill && fill!.a === 1) effects.push(...shadows.outer);
    else bad('boxShadow', 'drop', 'a shadow is drawn only under a box with an opaque background colour');
  }
  if (hasFill || effects.length > 0) {
    layers.push({
      id: sub(box, 'bg'),
      type: 'shape',
      shape: boxShape(geom.width, geom.height, geom.radii),
      ...(hasFill ? { fill: hex(fill!) } : {}),
      ...(effects.length > 0 ? { effects } : {}),
    });
  }

  // ---- .bg-N: gradients and pictures, the last one at the bottom ----
  if (images.length > 0) {
    const clipRegion = region(geom, (style.backgroundClip === 'text' ? 'border-box' : style.backgroundClip) ?? 'border-box');
    const originRegion = region(geom, style.backgroundOrigin ?? 'padding-box');
    const edge = style.borderColor?.[0];
    const edgeColor = edge === undefined ? current : edge === 'currentcolor' ? current : edge;
    const borderCovers =
      hasBorder && geom.border.every((w) => w === geom.border[0]) && edgeColor.a === 1 &&
      clipRegion.rect.w === border.w && originRegion.rect.x === geom.border[3];
    for (let i = images.length - 1; i >= 0; i -= 1) {
      const pick = <T,>(list: readonly T[] | undefined): T | undefined => (list && list.length > 0 ? list[i % list.length] : undefined);
      const layer = backgroundLayer(
        { image: images[i]!, size: pick(style.backgroundSize), position: pick(style.backgroundPosition), repeat: pick(style.backgroundRepeat) },
        {
          area: originRegion.rect,
          clip: clipRegion,
          env,
          current,
          bad,
          property: 'background',
          borderCovers,
          id: sub(box, `bg-${i}`),
        },
      );
      if (layer !== null) layers.push(layer);
    }
  }

  // ---- .border ----
  if (hasBorder) borderLayer(box, geom, layers, bad);
}

function borderLayer(
  box: Box,
  geom: BoxGeometry,
  layers: LayerJson[],
  bad: (property: string, value: string, reason: string) => void,
): void {
  const style = box.style;
  const [t, r, b, l] = geom.border;
  if (!(t === r && r === b && b === l)) {
    bad('borderWidth', `${t} ${r} ${b} ${l}`, 'the four sides of a border must have the same width');
    return;
  }
  const styles = (style.borderStyle ?? []).filter((s, i) => geom.border[i]! > 0 && s !== 'none');
  if (styles.some((s) => s !== 'solid')) {
    bad('borderStyle', styles.find((s) => s !== 'solid') ?? '', 'only solid borders are drawn');
    return;
  }
  const colors = style.borderColor ?? [];
  const current = currentOf(box);
  const first = colors[0] === undefined ? current : colorOf(colors[0], current)!;
  for (let i = 1; i < 4; i += 1) {
    const c = colors[i] === undefined ? current : colorOf(colors[i], current)!;
    if (c.r !== first.r || c.g !== first.g || c.b !== first.b || c.a !== first.a) {
      bad('borderColor', 'sides differ', 'the four sides of a border must have the same colour');
      return;
    }
  }
  if (first.a === 0) return;
  const half = t / 2;
  const w = Math.max(0, geom.width - t);
  const h = Math.max(0, geom.height - t);
  layers.push({
    id: sub(box, 'border'),
    type: 'shape',
    shape: boxShape(w, h, shrinkRadii(geom.radii, half)),
    stroke: { color: hex(first), width: r3(t) },
    transform: { x: r3(half), y: r3(half) },
  });
}

// ---- masks ----

function maskOf(
  box: Box,
  geom: BoxGeometry,
  images: readonly BackgroundImage[],
  bad: (property: string, value: string, reason: string) => void,
): Mask | { layer: LayerJson } | null {
  const style = box.style;
  const env = box.env;
  if (images.length > 1) {
    bad('maskImage', `${images.length} layers`, 'only one mask layer is drawn');
    return null;
  }
  const image = images[0]!;
  const rect = borderBox(geom);
  const nonDefaultSize = style.maskSize?.some((s) => s !== 'cover' && s !== 'contain' && (s[0] !== 'auto' || s[1] !== 'auto'));
  const nonDefaultPosition = style.maskPosition?.some(([x, y]) => x.value !== 0 || y.value !== 0);
  if (image.kind !== 'url') {
    if (nonDefaultSize || nonDefaultPosition || style.maskSize?.some((s) => s === 'cover' || s === 'contain')) {
      bad('maskSize', 'sized', 'a gradient mask is drawn over the whole border box');
      return null;
    }
    const gradient = gradientFor(image, rect, { w: rect.w, h: rect.h }, env, currentOf(box), bad, 'maskImage');
    return gradient === null ? null : { gradient, mode: 'alpha' };
  }
  const layer = backgroundLayer(
    { image, size: style.maskSize?.[0], position: style.maskPosition?.[0], repeat: style.maskRepeat?.[0] },
    {
      area: rect,
      clip: { rect, radii: { tl: [0, 0], tr: [0, 0], br: [0, 0], bl: [0, 0] } },
      env,
      current: currentOf(box),
      bad,
      property: 'mask',
      borderCovers: false,
      id: sub(box, 'mask'),
    },
  );
  return layer === null ? null : { layer };
}

// ---- content ----

/** The text, picture or drawing a box holds, in its content box. */
function ownContent(box: Box, geom: BoxGeometry, mc: MapContext): LayerJson | null {
  const rect = box.rect!;
  const content = contentBox(geom);
  switch (box.content.kind) {
    case 'text':
      if (!box.inh.visible) return null;
      return textLayer(box, sub(box, 'text'), rect, content.x, content.y, content.w);
    case 'img':
    case 'video': {
      if (!box.inh.visible) return null;
      const kind = box.content.kind;
      const c = region(geom, 'content-box');
      const layer: LayerJson =
        kind === 'img'
          ? { id: sub(box, 'img'), type: 'image', src: box.content.src, width: r3(content.w), height: r3(content.h) }
          : { id: sub(box, 'video'), type: 'video', src: box.content.src, width: r3(content.w), height: r3(content.h) };
      if (box.content.fit !== 'fill') layer.fit = box.content.fit;
      if (content.x !== 0 || content.y !== 0) layer.transform = { x: r3(content.x), y: r3(content.y) };
      if (hasRadii(c.radii)) {
        layer.clip = { kind: 'path', d: boxPath(0, 0, content.w, content.h, innerRadii(c.radii, [0, 0, 0, 0])) };
      }
      return layer;
    }
    case 'svg':
      return box.inh.visible ? mapSvg(box.content.el, content, box, mc.report) : null;
    default:
      return null;
  }
}

function textLayer(box: Box, id: string, rect: NonNullable<Box['rect']>, x: number, y: number, width?: number): LayerJson | null {
  const content = box.content;
  if (content.kind !== 'text' || content.text.font === null) return null;
  if (!box.inh.visible) return null;
  const t = content.text;
  const layer: Record<string, unknown> = {
    id,
    type: 'text',
    text: t.text,
    font: t.font,
    size: r3(t.size),
    color: hex(t.color),
    lineHeight: r3(t.lineHeight * 1e3) / 1e3,
  };
  const contentWidth = width ?? Math.max(0, rect.width - (box.anonymous ? 0 : 0));
  if (!t.nowrap) layer.maxWidth = Math.max(snapUp(contentWidth), 1 / 64);
  if (t.align !== 'left') layer.align = t.align;
  if (t.chars !== undefined) layer.chars = t.chars;
  if (t.shadows.length > 0) layer.effects = textShadowEffects(t.shadows, box.env, t.color);
  const at = box.anonymous ? { x: rect.x, y: rect.y } : { x, y };
  if (at.x !== 0 || at.y !== 0) layer.transform = { x: r3(at.x), y: r3(at.y) };
  return layer as unknown as LayerJson;
}

/** A native element, moved to where CSS put its box: its own `x` and `y` are an offset from there. */
function placeNative(box: Box, rect: NonNullable<Box['rect']>): LayerJson | null {
  if (box.content.kind !== 'native') return null;
  const layer = box.content.layer;
  const t: Transform = { ...(layer.transform ?? {}) };
  const anchorX = constant(t.anchorX, 0) ?? 0;
  const anchorY = constant(t.anchorY, 0) ?? 0;
  const x = plus(t.x, rect.x + anchorX);
  const y = plus(t.y, rect.y + anchorY);
  if (x === 0) delete t.x;
  else t.x = x;
  if (y === 0) delete t.y;
  else t.y = y;
  if (Object.keys(t).length === 0) return layer;
  return { ...layer, transform: t } as LayerJson;
}

// ---- the island ----

export interface Mapped {
  layers: LayerJson[];
}

export function mapRoot(root: Box, mc: MapContext): LayerJson | null {
  checkStacking(root, mc.report);
  const layer = mapBox(root, mc, { x: 0, y: 0, exact: true });
  return layer;
}

