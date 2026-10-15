// Layout: the styled tree becomes boxes (docs/COMPAT.md §4.2, §4.4), each with the node `layoutDom` takes
// (§5.1). A box whose in-flow content is only text and inline elements is a text leaf; runs of text among block
// children get anonymous boxes of their own, as CSS makes anonymous blocks.

import type { LayerJson } from '@kinetograph/scene';
import type { LengthOrAuto, ParsedStyle, Rgba, TextShadow } from '../css/types.js';
import type { DomNode } from '../types.js';
import { defined, isMappedHtml, uaStyle } from './elements.js';
import { fontKeyOf, inherit, lineHeightMultiple, ROOT_INHERITED, type Inherited } from './style.js';
import { buildText, hasContent, type RunItem } from './text.js';
import type { Report, StyledElement, StyledNative, StyledNode } from './tree.js';
import { px, type LengthEnv } from './util.js';

// ---- the layout request (docs/COMPAT.md §5.1) ----

export type LayoutValue = number | { percent: number } | 'auto';

export interface DomLayoutNode {
  style: Record<string, unknown>;
  measure?:
    | { text: { text: string; font: string; size: number; lineHeight?: number; align?: string; whiteSpace?: string } }
    | { width: number; height: number };
  children?: DomLayoutNode[];
}

export interface DomLayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
  padding: [number, number, number, number];
  border: [number, number, number, number];
  children: DomLayoutBox[];
}

// ---- boxes ----

export interface TextContent {
  text: string;
  chars: ReturnType<typeof buildText>['chars'];
  /** The font key, or null when no family of the style is registered (reported). */
  font: string | null;
  size: number;
  /** A multiple of `size`. */
  lineHeight: number;
  color: Rgba;
  align: 'left' | 'center' | 'right';
  nowrap: boolean;
  shadows: TextShadow[];
}

export type Content =
  | { kind: 'none' }
  | { kind: 'text'; text: TextContent }
  | { kind: 'img' | 'video'; src: string; fit: 'fill' | 'contain' | 'cover' }
  | { kind: 'svg'; el: StyledElement }
  | { kind: 'native'; layer: LayerJson };

export interface Box {
  /** The layer id of the box's group (or, for an anonymous text box, of its text layer). */
  id: string;
  el: StyledElement | null;
  /** A box made for a run of text among block children. */
  anonymous: boolean;
  style: ParsedStyle;
  inh: Inherited;
  env: LengthEnv;
  display: 'block' | 'flex';
  /** The parent is a flex container. */
  flexItem: boolean;
  parent: Box | null;
  children: Box[];
  content: Content;
  layout: DomLayoutNode;
  /** Filled in by `place`. */
  rect?: DomLayoutBox;
}

export interface BuildContext {
  viewport: { width: number; height: number };
  fonts: Record<string, string>;
  report: Report;
  emitNative(node: Extract<DomNode, { kind: 'element' }>, path: string): LayerJson | null;
}

const effectiveCache = new WeakMap<StyledElement, ParsedStyle>();

/** Chrome's default style under the author's. */
function effectiveStyle(el: StyledElement, insideList: boolean): ParsedStyle {
  let style = effectiveCache.get(el);
  if (!style) {
    style = { ...defined(uaStyle(el.type, insideList)), ...defined(el.style) };
    effectiveCache.set(el, style);
  }
  return style;
}

const isAbsolute = (style: ParsedStyle): boolean => style.position === 'absolute' || style.position === 'fixed';

// ---- the style the layout takes ----

function value(length: LengthOrAuto | 'none' | undefined, env: LengthEnv): LayoutValue | undefined {
  if (length === undefined || length === 'auto' || length === 'none') return length === undefined ? undefined : 'auto';
  return length.unit === '%' ? { percent: length.value } : px(length, env);
}

const JUSTIFY = new Set(['flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly', 'start', 'end', 'stretch', 'normal']);
const ALIGN = new Set(['flex-start', 'flex-end', 'center', 'baseline', 'stretch', 'start', 'end', 'normal']);

function layoutStyle(
  style: ParsedStyle,
  display: 'block' | 'flex',
  env: LengthEnv,
  report: (property: string, value: unknown, reason: string) => void,
): Record<string, unknown> {
  const out: Record<string, unknown> = { display };
  if (style.position !== undefined) out.position = style.position === 'fixed' ? 'absolute' : style.position;
  const sides = (name: string, sides: readonly [LengthOrAuto, LengthOrAuto, LengthOrAuto, LengthOrAuto] | undefined): void => {
    if (sides !== undefined) out[name] = sides.map((s) => value(s, env));
  };
  sides('inset', style.inset);
  sides('margin', style.margin);
  if (style.padding) out.padding = style.padding.map((s) => value(s, env));
  for (const key of ['width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight'] as const) {
    const v = value(style[key], env);
    if (v !== undefined) out[key] = v;
  }
  if (style.aspectRatio !== undefined) out.aspectRatio = style.aspectRatio;
  if (style.boxSizing !== undefined) out.boxSizing = style.boxSizing;
  if (style.borderWidth !== undefined) {
    // A side with no style has no width.
    out.borderWidth = style.borderWidth.map((w, i) => {
      const s = style.borderStyle?.[i];
      return s === 'none' || s === 'hidden' ? 0 : px(w, env);
    });
  }
  for (const key of ['flexDirection', 'flexWrap', 'flexGrow', 'flexShrink'] as const) {
    if (style[key] !== undefined) out[key] = style[key];
  }
  if (style.flexBasis !== undefined) out.flexBasis = style.flexBasis === 'content' ? 'auto' : value(style.flexBasis, env);
  const justify = style.justifyContent === 'left' ? 'flex-start' : style.justifyContent === 'right' ? 'flex-end' : style.justifyContent;
  if (justify !== undefined) {
    if (JUSTIFY.has(justify)) out.justifyContent = justify;
    else report('justifyContent', justify, 'not supported');
  }
  for (const key of ['alignItems', 'alignSelf'] as const) {
    const v = style[key];
    if (v === undefined) continue;
    if (v === 'auto' && key === 'alignSelf') out[key] = 'auto';
    else if (ALIGN.has(v)) out[key] = v;
    else report(key, v, 'not supported');
  }
  if (style.alignContent !== undefined) {
    if (JUSTIFY.has(style.alignContent)) out.alignContent = style.alignContent;
    else report('alignContent', style.alignContent, 'not supported');
  }
  if (style.rowGap !== undefined) out.rowGap = value(style.rowGap, env);
  if (style.columnGap !== undefined) out.columnGap = value(style.columnGap, env);
  for (const [key, axis] of [['overflowX', style.overflowX], ['overflowY', style.overflowY]] as const) {
    if (axis !== undefined) out[key] = axis;
  }
  return out;
}

// ---- building ----

interface Scope {
  ctx: BuildContext;
  insideList: boolean;
}

/** `10` and `'10px'` are 10; anything else is null. */
function pixels(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = /^\s*(-?\d*\.?\d+)(px)?\s*$/.exec(v);
    if (m) return Number(m[1]);
  }
  return null;
}

/** A child of a box, in the order CSS lays it out. */
type Item = { kind: 'run'; nodes: StyledNode[] } | { kind: 'child'; node: StyledElement | StyledNative };

function isInlineLevel(node: StyledNode, flexParent: boolean, insideList: boolean): boolean {
  if (node.kind === 'text') return true;
  if (node.kind === 'native') return false;
  if (node.type === 'br') return true;
  if (!isMappedHtml(node.type) || flexParent) return false;
  const style = effectiveStyle(node, insideList);
  return (style.display ?? 'block') === 'inline' && !isAbsolute(style);
}

function isHidden(node: StyledNode, insideList: boolean): boolean {
  return node.kind === 'element' && isMappedHtml(node.type) && effectiveStyle(node, insideList).display === 'none';
}

/** Splits the children into runs of inline content and the boxes between them. */
function partition(nodes: StyledNode[], flexParent: boolean, insideList: boolean): Item[] {
  const items: Item[] = [];
  let run: StyledNode[] = [];
  const flush = (): void => {
    if (run.length > 0) items.push({ kind: 'run', nodes: run });
    run = [];
  };
  for (const node of nodes) {
    if (isHidden(node, insideList)) continue;
    if (isInlineLevel(node, flexParent, insideList)) run.push(node);
    else {
      flush();
      items.push({ kind: 'child', node: node as StyledElement | StyledNative });
    }
  }
  flush();
  return items;
}

/**
 * The items of an inline run as text-run items, reporting what an inline element does that a text layer cannot
 * (docs/COMPAT.md §4.4: only `color` and `opacity` may change).
 */
function runItems(nodes: StyledNode[], parent: Inherited, parentOpacity: number, scope: Scope, out: RunItem[]): void {
  const { ctx } = scope;
  for (const node of nodes) {
    if (node.kind === 'text') {
      out.push({ kind: 'text', text: node.text, style: { color: parent.color, opacity: parentOpacity } });
      continue;
    }
    if (node.kind === 'native') continue;
    if (node.type === 'br') {
      out.push({ kind: 'br' });
      continue;
    }
    const style = effectiveStyle(node, scope.insideList);
    const inh = inherit(style, parent, ctx.viewport);
    if (inh.visible) {
      ctx.report.diagnostics(node);
      checkInline(node, style, parent, inh, ctx.report);
    }
    runItems(node.children, inh, parentOpacity * (style.opacity ?? 1), scope, out);
  }
}

const INLINE_OK = new Set(['display', 'color', 'opacity', 'visibility']);

function checkInline(el: StyledElement, style: ParsedStyle, parent: Inherited, inh: Inherited, report: Report): void {
  const bad = (property: string, v: unknown): void =>
    report.add(el, el.type, property, v, 'an inline element in a text block may change only color and opacity');
  if (inh.fontSize !== parent.fontSize) bad('fontSize', inh.fontSize);
  if (inh.fontWeight !== parent.fontWeight) bad('fontWeight', inh.fontWeight);
  if (inh.fontStyle !== parent.fontStyle) bad('fontStyle', inh.fontStyle);
  if (inh.fontFamily !== parent.fontFamily) bad('fontFamily', inh.fontFamily.join(', '));
  if (inh.lineHeight !== parent.lineHeight) bad('lineHeight', JSON.stringify(inh.lineHeight));
  if (inh.textTransform !== parent.textTransform) bad('textTransform', inh.textTransform);
  if (inh.textShadow !== parent.textShadow) bad('textShadow', JSON.stringify(inh.textShadow));
  for (const [key, v] of Object.entries(style)) {
    if (v === undefined || INLINE_OK.has(key)) continue;
    // The inherited text properties were compared above (or are not set differently).
    if (['fontSize', 'fontWeight', 'fontStyle', 'fontFamily', 'lineHeight', 'textTransform', 'textShadow', 'textAlign', 'whiteSpace'].includes(key)) continue;
    if (key === 'textDecoration' && v === 'none') continue;
    bad(key, v);
  }
}

function emptyBox(
  id: string,
  el: StyledElement | null,
  parent: Box | null,
  style: ParsedStyle,
  inh: Inherited,
  display: 'block' | 'flex',
  scope: Scope,
  anonymous: boolean,
): Box {
  return {
    id,
    el,
    anonymous,
    style,
    inh,
    env: { fontSize: inh.fontSize, viewport: scope.ctx.viewport },
    display,
    flexItem: parent?.display === 'flex',
    parent,
    children: [],
    content: { kind: 'none' },
    layout: { style: {} },
  };
}

/** The text of a run for a box with the style `inh`: the content, its layout measure. */
function textOf(items: RunItem[], inh: Inherited, report: Report, at: { el: StyledElement | null; path: string; type: string }, ctx: BuildContext): TextContent | null {
  const preLine = inh.whiteSpace === 'pre-line';
  const nowrap = inh.whiteSpace === 'nowrap';
  if (inh.whiteSpace !== 'normal' && !preLine && !nowrap) {
    report.add(at, at.type, 'whiteSpace', inh.whiteSpace, 'only normal, nowrap and pre-line are drawn');
  }
  if (inh.textAlign === 'justify') report.add(at, at.type, 'textAlign', 'justify', 'justified text is not drawn');
  const built = buildText(items, { transform: inh.textTransform, preLine, block: { color: inh.color, opacity: 1 } });
  if (built.text === '') return null;
  const font = fontKeyOf(inh, ctx.fonts);
  if (font === null) {
    report.add(
      at,
      at.type,
      'fontFamily',
      inh.fontFamily.join(', '),
      `none of the families is a registered font at weight ${inh.fontWeight} ${inh.fontStyle} (registered: ${Object.keys(ctx.fonts).join(', ') || 'none'})`,
    );
  }
  return {
    text: built.text,
    chars: built.chars,
    font,
    size: inh.fontSize,
    lineHeight: lineHeightMultiple(inh),
    color: inh.color,
    align: inh.textAlign === 'center' ? 'center' : inh.textAlign === 'right' ? 'right' : 'left',
    nowrap,
    shadows: inh.textShadow,
  };
}

function measureOf(text: TextContent): NonNullable<DomLayoutNode['measure']> {
  if (text.font === null) return { width: 0, height: 0 };
  return {
    text: {
      text: text.text,
      font: text.font,
      size: text.size,
      lineHeight: text.lineHeight,
      ...(text.nowrap ? { whiteSpace: 'nowrap' } : {}),
    },
  };
}

function anonymousTextBox(
  parent: Box,
  nodes: StyledNode[],
  index: number,
  scope: Scope,
): Box | null {
  const items: RunItem[] = [];
  runItems(nodes, parent.inh, 1, scope, items);
  if (!hasContent(items)) return null;
  const at = { el: parent.el, path: parent.el?.path ?? '$', type: parent.el?.type ?? 'div' };
  const text = textOf(items, parent.inh, scope.ctx.report, at, scope.ctx);
  if (text === null) return null;
  const box = emptyBox(`${parent.id}.text${index}`, null, parent, {}, parent.inh, 'block', scope, true);
  box.content = { kind: 'text', text };
  box.layout = { style: { display: 'block' }, measure: measureOf(text) };
  return box;
}

/** The layer sizes of a native element inside the island: the layout measure of its box. */
function nativeBox(node: StyledNative, parent: Box, scope: Scope): Box | null {
  const { ctx } = scope;
  const layer = ctx.emitNative(node.node, node.path);
  if (layer === null) return null;
  const at = { path: node.path, type: node.node.type };
  const report = (property: string, v: unknown, reason: string): void => ctx.report.add(at, node.node.type, property, v, reason);
  const box = emptyBox(layer.id, null, parent, {}, parent.inh, 'block', scope, false);
  box.content = { kind: 'native', layer };
  const number = (v: unknown, name: string): number | null => {
    if (typeof v === 'number') return v;
    if (Array.isArray(v) && v.length > 0 && typeof v[0]?.value === 'number') {
      report(name, 'animated', 'the size of a native element in a DOM element is laid out once, so it cannot be animated');
      return v[0].value as number;
    }
    return null;
  };
  let size: { width: number; height: number } | null = null;
  const styleSize: Record<string, unknown> = {};
  switch (layer.type) {
    case 'text': {
      const maxWidth = number(layer.maxWidth, 'maxWidth');
      const fontSize = number(layer.size, 'size') ?? 16;
      box.layout.measure = {
        text: {
          text: layer.text,
          font: layer.font,
          size: fontSize,
          ...(layer.lineHeight !== undefined ? { lineHeight: number(layer.lineHeight, 'lineHeight') ?? 1 } : {}),
          ...(layer.align !== undefined ? { align: layer.align } : {}),
        },
      };
      if (maxWidth !== null) styleSize.width = maxWidth;
      break;
    }
    case 'shape': {
      const shape = layer.shape;
      if (shape.kind === 'path') {
        report('d', shape.d, 'the size of a path in a DOM element is not known, so it is laid out as 0 by 0');
        size = { width: 0, height: 0 };
      } else {
        size = { width: number(shape.width, 'width') ?? 0, height: number(shape.height, 'height') ?? 0 };
      }
      break;
    }
    case 'group': {
      const l = layer.layout;
      size = { width: number(l?.width, 'width') ?? 0, height: number(l?.height, 'height') ?? 0 };
      break;
    }
    default: {
      const w = number((layer as { width?: unknown }).width, 'width');
      const h = number((layer as { height?: unknown }).height, 'height');
      if (w === null || h === null) {
        report('width', null, 'a native element in a DOM element needs a width and a height to be laid out');
      }
      size = { width: w ?? 0, height: h ?? 0 };
    }
  }
  if (size !== null) box.layout.measure = size;
  box.layout.style = { display: 'block', ...styleSize };
  return box;
}

/** The image or video of an `img` / `video`: its source and fit, and the size it asks for. */
function replacedBox(el: StyledElement, box: Box, scope: Scope): void {
  const { ctx } = scope;
  const style = box.style;
  const report = (property: string, v: unknown, reason: string): void => ctx.report.add(el, el.type, property, v, reason);
  let src = el.props.src;
  if (el.type === 'video' && typeof src !== 'string') {
    const source = el.children.find((c): c is StyledElement => c.kind === 'element' && c.type === 'source');
    src = source?.props.src;
  }
  if (typeof src !== 'string' || src === '') {
    report('src', src, `a${el.type === 'img' ? 'n' : ''} ${el.type} needs a src`);
    src = '';
  }
  let fit: 'fill' | 'contain' | 'cover' = 'fill';
  const objectFit = style.objectFit;
  if (objectFit === 'contain' || objectFit === 'cover' || objectFit === 'fill') fit = objectFit;
  else if (objectFit === 'scale-down') fit = 'contain';
  else if (objectFit === 'none') report('objectFit', 'none', 'the picture is not scaled; use fill, contain or cover');
  const position = style.objectPosition;
  if (position !== undefined && !(position[0].unit === '%' && position[0].value === 50 && position[1].unit === '%' && position[1].value === 50)) {
    report('objectPosition', 'not centred', 'only the centre is drawn');
  }
  box.content = { kind: el.type === 'video' ? 'video' : 'img', src, fit };

  const attrW = pixels(el.props.width);
  const attrH = pixels(el.props.height);
  const styled = (l: LengthOrAuto | undefined): boolean => l !== undefined && l !== 'auto';
  if (attrW !== null && attrH !== null) {
    box.layout.measure = { width: attrW, height: attrH };
    if (style.aspectRatio === undefined && (styled(style.width) !== styled(style.height) || (!styled(style.width) && !styled(style.height)))) {
      box.layout.style.aspectRatio = attrW / attrH;
    }
  } else if (styled(style.width) && styled(style.height)) {
    box.layout.measure = { width: 0, height: 0 };
  } else {
    report(
      'width',
      el.props.width ?? null,
      `the natural size of the ${el.type} is not known here; give the element a width and a height`,
    );
    box.layout.measure = { width: attrW ?? 0, height: attrH ?? 0 };
  }
}

function svgBox(el: StyledElement, box: Box, scope: Scope): void {
  const style = box.style;
  box.content = { kind: 'svg', el };
  const attrW = pixels(el.props.width);
  const attrH = pixels(el.props.height);
  const view = parseViewBox(el.props.viewBox);
  const styled = (l: LengthOrAuto | undefined): boolean => l !== undefined && l !== 'auto';
  const ratio = view ? view.width / view.height : null;
  let width = attrW;
  let height = attrH;
  if (width === null && height !== null && ratio !== null) width = height * ratio;
  if (height === null && width !== null && ratio !== null) height = width / ratio;
  if (width === null || height === null) {
    if (ratio !== null) {
      // An svg with a viewBox and no size fills its container's width.
      if (!styled(style.width)) box.layout.style.width = { percent: 100 };
      if (style.aspectRatio === undefined) box.layout.style.aspectRatio = ratio;
      box.layout.measure = { width: view!.width, height: view!.height };
      return;
    }
    width = width ?? 300;
    height = height ?? 150;
  }
  box.layout.measure = { width, height };
  void scope;
}

export function parseViewBox(value: unknown): { x: number; y: number; width: number; height: number } | null {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || parts[2]! <= 0 || parts[3]! <= 0) return null;
  return { x: parts[0]!, y: parts[1]!, width: parts[2]!, height: parts[3]! };
}

/** The box of an element, or null when it draws nothing (`display: none`, an element this mapping does not know). */
export function buildBox(el: StyledElement, parent: Box | null, scope: Scope): Box | null {
  const { ctx } = scope;
  if (!isMappedHtml(el.type)) {
    ctx.report.add(el, el.type, null, null, 'this element is not drawn natively');
    return null;
  }
  const insideList = scope.insideList;
  const style = effectiveStyle(el, insideList);
  const wanted = style.display ?? 'block';
  if (wanted === 'none') return null;
  // A flex item, an absolute box and the island's root are block-level whatever they asked for.
  const display: 'block' | 'flex' = wanted === 'flex' || wanted === 'inline-flex' ? 'flex' : 'block';

  const inh = inherit(style, parent?.inh ?? ROOT_INHERITED, ctx.viewport);
  const box = emptyBox(el.id, el, parent, style, inh, display, scope, false);
  if (inh.visible) {
    ctx.report.diagnostics(el);
    checkText(el, style, ctx.report);
  }
  box.layout.style = layoutStyle(style, display, box.env, (property, v, reason) => ctx.report.add(el, el.type, property, v, reason));

  if (el.type === 'img' || el.type === 'video') {
    replacedBox(el, box, scope);
    return box;
  }
  if (el.type === 'svg') {
    svgBox(el, box, scope);
    return box;
  }

  const inner: Scope = { ctx, insideList: insideList || el.type === 'ul' || el.type === 'ol' || el.type === 'li' };
  const items = partition(el.children, display === 'flex', inner.insideList);
  // Inline-blocks beside inline content would sit in one line; this layout would stack them.
  if (display === 'block' && items.some((i) => i.kind === 'run' && hasContent(runForCheck(i.nodes)))) {
    for (const item of items) {
      if (item.kind === 'child' && item.node.kind === 'element' && effectiveStyle(item.node, inner.insideList).display === 'inline-block') {
        ctx.report.add(item.node, item.node.type, 'display', 'inline-block', 'an inline-block next to text is laid out in the same line, which is not drawn');
      }
    }
  }

  if (display === 'block' && items.length === 1 && items[0]!.kind === 'run') {
    // The box is the text.
    const run: RunItem[] = [];
    runItems(items[0]!.nodes, inh, 1, inner, run);
    if (hasContent(run)) {
      const text = textOf(run, inh, ctx.report, { el, path: el.path, type: el.type }, ctx);
      if (text !== null) {
        box.content = { kind: 'text', text };
        box.layout.measure = measureOf(text);
      }
    }
    return box;
  }

  const children: Box[] = [];
  let anonymous = 0;
  for (const item of items) {
    if (item.kind === 'run') {
      const text = anonymousTextBox(box, item.nodes, anonymous, inner);
      if (text !== null) {
        anonymous += 1;
        children.push(text);
      }
    } else if (item.node.kind === 'native') {
      const native = nativeBox(item.node, box, inner);
      if (native !== null) children.push(native);
    } else {
      const child = buildBox(item.node, box, inner);
      if (child !== null) children.push(child);
    }
  }
  if (display === 'flex') {
    // `order` reorders both the layout and the painting.
    children.sort((a, b) => (a.style.order ?? 0) - (b.style.order ?? 0));
  }
  box.children = children;
  box.layout.children = children.map((c) => c.layout);
  return box;
}

function runForCheck(nodes: StyledNode[]): RunItem[] {
  return nodes.map((n): RunItem => (n.kind === 'text' ? { kind: 'text', text: n.text, style: { color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1 } } : { kind: 'br' }));
}

/** `letterSpacing`, `wordSpacing`, `textDecoration` and `backgroundClip: text` anywhere (docs/COMPAT.md §4.4). */
function checkText(el: StyledElement, style: ParsedStyle, report: Report): void {
  const bad = (property: string, v: unknown, reason: string): void => report.add(el, el.type, property, v, reason);
  const spacing = (name: 'letterSpacing' | 'wordSpacing'): void => {
    const v = style[name];
    if (v === undefined || v === 'normal') return;
    if (typeof v === 'object' && v.value === 0) return;
    bad(name, JSON.stringify(v), 'text spacing is not drawn');
  };
  spacing('letterSpacing');
  spacing('wordSpacing');
  if (style.textDecoration !== undefined && style.textDecoration !== 'none') {
    bad('textDecoration', style.textDecoration, 'text decorations are not drawn');
  }
  if (style.backgroundClip === 'text') bad('backgroundClip', 'text', 'gradient text is not drawn');
}

/** The root box of an island, laid out and ready to map. */
export function buildIsland(root: StyledElement, ctx: BuildContext): Box | null {
  return buildBox(root, null, { ctx, insideList: false });
}

/** Writes the layout's boxes onto the boxes. */
export function place(box: Box, rect: DomLayoutBox): void {
  box.rect = rect;
  box.children.forEach((child, i) => {
    const childRect = rect.children[i];
    if (childRect) place(child, childRect);
  });
}
