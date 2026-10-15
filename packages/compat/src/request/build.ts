// The DOM island a frame holds as the JSON the addon takes (docs/ENGINE.md §2, `crates/dom/src/request.rs`):
// tags, attributes, `style` as CSS text, text, and native `kg-*` elements as boxes. Pure: no addon, no clock.

import type { DomNode } from '../types.js';
import { attributesOf, styleOf } from './attrs.js';
import { parseHtmlFragment } from './html.js';
import { isDomElement } from './tags.js';

/** `DomNode` of `crates/dom/src/request.rs`. */
export type RequestNode =
  | { kind: 'element'; tag: string; path: string; attrs: Record<string, string>; style: string; children: RequestNode[] }
  | { kind: 'text'; text: string }
  | { kind: 'native'; path: string; width?: number; height?: number };

/** `IslandRequest` of `crates/dom/src/request.rs`. */
export interface IslandRequestJson {
  root: RequestNode;
  stylesheets: string[];
  viewport: { width: number; height: number };
  fonts: Record<string, string>;
  baseDir: string;
  publicDir?: string;
  time: number;
  path: string;
}

type ElementNode = Extract<DomNode, { kind: 'element' }>;

export interface BuildOptions {
  /** The island root's host-tree path (`$0.2`). */
  path: string;
  viewport: { width: number; height: number };
  fonts: Record<string, string>;
  baseDir: string;
  publicDir?: string;
  /** Seconds. */
  time: number;
  /** Document-wide CSS: imported files, then every `<style>` element of the tree, in order. */
  stylesheets: readonly string[];
  /** The box a native element takes inside the island (its layer's width and height). */
  nativeSize?(node: ElementNode): { width?: number; height?: number };
  /** The text of a local `<link rel="stylesheet" href>`; null when it is not a local file. */
  readStylesheet?(href: string): string | null;
}

export interface BuiltRequest {
  request: IslandRequestJson;
  /** The native elements of the island by path: `emitNative` makes their layers. */
  natives: Map<string, ElementNode>;
}

/** The text a `<style>` element holds: its text children, or `dangerouslySetInnerHTML.__html`. */
export function styleText(node: ElementNode): string {
  const html = node.props.dangerouslySetInnerHTML?.__html;
  if (typeof html === 'string') return html;
  return node.children.map((child) => (child.kind === 'text' ? child.text : '')).join('');
}

/**
 * Every `<style>` element's text in the tree, in document order. Native elements are searched too: a `<style>` in one
 * island applies to all of them, as in a document. `children` is a host tree (the reconciler's).
 */
export function collectStyleElements(nodes: readonly DomNode[]): string[] {
  const out: string[] = [];
  const visit = (list: readonly DomNode[]): void => {
    for (const node of list) {
      if (node.kind !== 'element') continue;
      if (node.type === 'style') {
        const text = styleText(node);
        if (text.trim() !== '') out.push(text);
      } else {
        visit(node.children);
      }
    }
  };
  visit(nodes);
  return out;
}

/** The island whose root is `root`, which sits at `options.path`. */
export function buildIslandRequest(root: ElementNode, options: BuildOptions): BuiltRequest {
  const natives = new Map<string, ElementNode>();
  const extra: string[] = [];

  const element = (node: ElementNode, path: string, insideSvg: boolean): RequestNode => {
    const svg = insideSvg || node.type === 'svg';
    const props = node.props;
    const attrs = attributesOf(props, svg);
    if (node.type === 'link') {
      const rel = String(props.rel ?? '').toLowerCase();
      const href = props.href;
      if (rel.split(/\s+/).includes('stylesheet') && typeof href === 'string') {
        const css = options.readStylesheet?.(href) ?? null;
        if (css !== null) extra.push(css);
      }
    }
    const out: RequestNode = { kind: 'element', tag: node.type, path, attrs, style: styleOf(props), children: [] };
    if (node.type === 'style' || node.type === 'script') return out;
    const html = props.dangerouslySetInnerHTML?.__html;
    const source: DomNode[] = typeof html === 'string' ? parseHtmlFragment(html, svg) : node.children;
    out.children = children(source, path, svg);
    return out;
  };

  const children = (nodes: readonly DomNode[], parent: string, insideSvg: boolean): RequestNode[] => {
    const out: RequestNode[] = [];
    let index = 0;
    for (const child of nodes) {
      if (child.kind === 'text') {
        out.push({ kind: 'text', text: child.text });
        continue;
      }
      const path = `${parent}.${index++}`;
      if (isDomElement(child.type)) {
        out.push(element(child, path, insideSvg));
      } else {
        natives.set(path, child);
        const size = options.nativeSize?.(child) ?? {};
        const native: RequestNode = { kind: 'native', path };
        if (size.width !== undefined) native.width = size.width;
        if (size.height !== undefined) native.height = size.height;
        out.push(native);
      }
    }
    return out;
  };

  const rootNode = element(root, options.path, false);
  const request: IslandRequestJson = {
    root: rootNode,
    stylesheets: [...options.stylesheets, ...extra],
    viewport: { width: options.viewport.width, height: options.viewport.height },
    fonts: options.fonts,
    baseDir: options.baseDir,
    time: options.time,
    path: options.path,
  };
  if (options.publicDir !== undefined) request.publicDir = options.publicDir;
  return { request, natives };
}
