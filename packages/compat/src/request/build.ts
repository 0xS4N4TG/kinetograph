// The DOM island a frame holds as the JSON the addon takes (packages/cli/skills/kinetograph/references/ENGINE.md §2, `crates/dom/src/request.rs`):
// tags, attributes, `style` as CSS text, text, and native `kg-*` elements as boxes. Pure: no addon, no clock.

import type { DomNode } from '../types.js';
import { resolveRemoteAsset, sameOriginPath } from '../environment.js';
import { attributesOf, styleOf } from './attrs.js';
import { parseHtmlFragment } from './html.js';
import { srcsetCandidate } from './srcset.js';
import { isDomElement } from './tags.js';

export { parseSrcset, sourceSize, srcsetCandidate } from './srcset.js';

/** `DomNode` of `crates/dom/src/request.rs`. */
export type RequestNode =
  | { kind: 'element'; tag: string; path: string; attrs: Record<string, string>; style: string; children: RequestNode[] }
  | { kind: 'text'; text: string }
  | { kind: 'native'; path: string; width?: number; height?: number; overlay?: true };

/** `Snapshot` of `crates/dom/src/request.rs`: the island's tree as it was at `time` seconds. */
export interface IslandSnapshotJson {
  time: number;
  root: RequestNode;
}

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
  /**
   * Earlier states of the island, oldest first, for CSS transitions (packages/cli/skills/kinetograph/references/ENGINE.md §7.12). The frame loop fills it (history.ts): with
   * none, no transition runs and every value is its final one.
   */
  history?: IslandSnapshotJson[];
}

type ElementNode = Extract<DomNode, { kind: 'element' }>;

/** Attributes that name a file the engine reads: a remote one is read from where it was downloaded to. */
const FILE_ATTRIBUTES = new Set(['src', 'href', 'xlink:href', 'poster']);
const FILE_ELEMENTS = new Set(['img', 'video', 'source', 'image', 'input', 'use']);

/** `url(https://…)` in CSS text, each remote one replaced by its local file (a quoted path when it has a space or quote). */
export function localizeCssUrls(css: string, resolve: (url: string) => string | null = resolveRemoteAsset): string {
  if (!/https?:/i.test(css)) return css;
  return css.replace(/url\(\s*(['"]?)(https?:\/\/[^'")]+)\1\s*\)/gi, (whole, _quote: string, url: string) => {
    const local = resolve(url);
    return local === null ? whole : `url("${local.replace(/"/g, '%22')}")`;
  });
}

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
  /** Whether a native element lies over its siblings, at the corner of its containing block, instead of taking its box in the flow. */
  nativeOverlay?(node: ElementNode): boolean;
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
  // Each remote URL is looked up once per request.
  const remote = new Map<string, string | null>();
  const local = (url: string): string | null => {
    // A URL of the document's own origin (a script copied a resolved `el.src`) is the project file it names.
    const own = sameOriginPath(url);
    if (own !== null) return own;
    if (!remote.has(url)) remote.set(url, resolveRemoteAsset(url));
    return remote.get(url) ?? null;
  };

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
    // An `<img srcset>` is drawn as a browser at device pixel ratio 1 chooses: the candidate stands in for `src`.
    if (node.type === 'img' && attrs.srcset !== undefined) {
      const chosen = srcsetCandidate(attrs.srcset, attrs.src, attrs.sizes, options.viewport);
      if (chosen !== null) attrs.src = chosen;
    }
    if (FILE_ELEMENTS.has(node.type)) {
      for (const name of FILE_ATTRIBUTES) {
        const value = attrs[name];
        const found = value === undefined ? null : local(value);
        if (found !== null) attrs[name] = found;
      }
    }
    const out: RequestNode = { kind: 'element', tag: node.type, path, attrs, style: localizeCssUrls(styleOf(props), local), children: [] };
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
        if (options.nativeOverlay?.(child)) native.overlay = true;
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
