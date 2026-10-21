// `@kinetograph/compat/dom` (docs/ENGINE.md §1, §2): a DOM island is handed to the addon as an `IslandRequest`; Stylo,
// taffy and Parley style and lay it out, our compositor paints it, and the layers come back as scene JSON. Native
// (`kg-*`) elements inside the island are drawn here and put where Rust placed their boxes.

import type { CameraJson, LayerJson, Unsupported } from '@kinetograph/scene';
import { addonFunction } from '../addon.js';
import { getDomEnvironment, importedStylesheets, noteStylesheet, readLocalStylesheet } from '../environment.js';
import { buildIslandRequest, type IslandRequestJson } from '../request/build.js';
import { isDomElement } from '../request/tags.js';
import type { DomNode, IslandContext, IslandResult } from '../types.js';
import { fillNatives, nativeSize, overlaysSiblings } from './native.js';
import { historyFor, isWarming, noteTransitions, recordIsland } from './history.js';

export { isDomElement };
export { setDomAddon, hasAddonFunction, addonFunction } from '../addon.js';
export type { DomAddon } from '../addon.js';
export {
  setDomEnvironment,
  getDomEnvironment,
  registerStylesheet,
  noteStylesheet,
  noteStylesheetProblem,
  importedStylesheets,
  stylesheetNotes,
  resetStylesheets,
  setCssFontFaceHandler,
  setRemoteAssetResolver,
  resolveRemoteAsset,
  parseFontFaces,
  resolveProjectFile,
} from '../environment.js';
export type { DomEnvironment, CssFontFace } from '../environment.js';
export { buildIslandRequest, collectStyleElements, styleText } from '../request/build.js';
export type { IslandRequestJson, RequestNode, BuildOptions, BuiltRequest } from '../request/build.js';
export { styleToCss } from '../request/style.js';
export { attributesOf } from '../request/attrs.js';
export { nativeSize, overlaysSiblings } from './native.js';
export {
  clearHistory,
  resetTransitionWindow,
  setHistoryMode,
  transitionWindowSeconds,
} from './history.js';

/** What `renderDomIsland` returns (`IslandOutput` of `crates/dom/src/request.rs`). */
interface IslandOutputJson {
  layers: unknown[];
  unsupported?: Unsupported[];
  camera?: CameraJson | null;
  margin?: number | null;
  blendSpace?: 'linear' | 'srgb';
  /** In a pass: `layers` are written as changes from the island's first layers in the pass (`expand`). */
  delta?: boolean;
}

/** The pass in progress, or null (docs/SCENE.md, "Motion blur"). */
let samplePass: number | null = null;
let passes = 0;
/** The first layers each island drew in the pass, by path: the addon writes the later ones against them. */
const bases = new Map<string, unknown[]>();

/**
 * Marks the islands rendered from now to `endSamplePass()` as the renders of one frame: the frame itself and the
 * samples of its motion blur. The addon keeps an island's document between them and edits it from one render to the
 * next instead of building it again; each is drawn as if it were built afresh. A later render of an island gives back
 * what changed from its first, and shares the layers that did not with that first's.
 */
export function beginSamplePass(): void {
  passes = (passes % 0x7fffffff) + 1;
  samplePass = passes;
  bases.clear();
}

export function endSamplePass(): void {
  samplePass = null;
  bases.clear();
}

type Written = Record<string, unknown> & { $same?: number; $base?: number; children?: Written[] };

/** The layers the addon wrote as changes from `base` (`delta` of crates/dom/src/request.rs), sharing what is the same. */
function expand(layers: Written[], base: unknown[]): unknown[] {
  return layers.map((layer) => {
    if (typeof layer.$same === 'number') return base[layer.$same];
    if (typeof layer.$base !== 'number') return layer;
    const { $base: at, children, ...own } = layer;
    const theirs = (base[at] as { children: unknown[] }).children;
    return { ...own, children: expand(children ?? [], theirs) };
  });
}

/** `style`, `script` and friends draw nothing: an island that is only one of them needs no trip to Rust. */
const INVISIBLE = new Set(['style', 'script', 'link', 'meta', 'title', 'base', 'head', 'noscript', 'template']);

/** The request for an island and where the `readStylesheet` of `<link>` and fonts of `<style>` come from. */
export function requestFor(root: Extract<DomNode, { kind: 'element' }>, context: IslandContext) {
  const environment = getDomEnvironment();
  const publicDir = context.publicDir ?? environment.publicDir;
  const stylesheets = context.stylesheets ?? importedStylesheets();
  for (const css of stylesheets) noteStylesheet(css);
  return buildIslandRequest(root, {
    path: context.path,
    viewport: context.viewport,
    fonts: context.fonts,
    baseDir: context.baseDir ?? environment.baseDir,
    ...(publicDir !== undefined ? { publicDir } : {}),
    time: context.time ?? 0,
    stylesheets,
    nativeSize,
    nativeOverlay: overlaysSiblings,
    readStylesheet: (href) => {
      const css = readLocalStylesheet(href);
      if (css !== null) noteStylesheet(css);
      return css;
    },
  });
}

export function mapDomIsland(root: DomNode, context: IslandContext): IslandResult {
  if (root.kind !== 'element' || !isDomElement(root.type)) {
    throw new Error('mapDomIsland needs a DOM element as the root of an island');
  }
  if (INVISIBLE.has(root.type)) return { layers: [], unsupported: [], camera: null };

  const { request, natives } = requestFor(root, context);
  // A CSS transition needs the island's earlier states (docs/ENGINE.md §7.12).
  noteTransitions(request.root, request.stylesheets);
  const history = historyFor(request.path, request.time);
  recordIsland(request.path, request.time, request.root);
  if (history.length > 0) request.history = history;
  if (isWarming()) return { layers: [], unsupported: [], camera: null };
  const json = JSON.stringify(request);
  const output = JSON.parse(
    samplePass === null ? addonFunction('renderDomIsland')(json) : addonFunction('renderDomIsland')(json, samplePass),
  ) as IslandOutputJson;
  let drawn = output.layers;
  if (output.delta) {
    const base = bases.get(request.path);
    if (base === undefined) throw new Error(`renderDomIsland wrote island ${request.path} as changes from a render it did not make`);
    drawn = expand(drawn as Written[], base);
  } else if (samplePass !== null) {
    bases.set(request.path, drawn);
  }

  const placed = fillNatives(drawn, (path) => {
    const node = natives.get(path);
    return node === undefined ? null : context.emitNative(node, path);
  });
  // The island is laid out in the composition's box already: a flex layout around it must not place it again.
  const layers = placed.map((layer) => (layer.layoutItem === undefined ? ({ ...layer, layoutItem: { position: 'absolute' } } as LayerJson) : layer));
  return {
    layers,
    unsupported: output.unsupported ?? [],
    camera: output.camera ?? null,
    ...(typeof output.margin === 'number' && output.margin > 0 ? { margin: output.margin } : {}),
    ...(output.blendSpace === 'srgb' ? { blendSpace: 'srgb' as const } : {}),
  };
}

export type { IslandRequestJson as IslandRequest };

/**
 * The size of `text` set in a `span` with `style`, on a page with no stylesheets: `white-space: pre` and out of flow,
 * as Remotion's `measureText` sets it. Null when the addon cannot answer.
 */
export function measureSpan(text: string, style: Record<string, unknown>, fonts: Record<string, string>): { width: number; height: number } | null {
  const span: DomNode = { kind: 'element', type: 'span', props: { style: { whiteSpace: 'pre', ...style } }, children: [{ kind: 'text', text }] };
  const root: DomNode = { kind: 'element', type: 'div', props: { style: { position: 'absolute', left: 0, top: 0 } }, children: [span] };
  const { request } = requestFor(root as Extract<DomNode, { kind: 'element' }>, {
    path: '$0',
    viewport: { width: 4096, height: 4096 },
    fonts,
    emitNative: () => null,
    time: 0,
    stylesheets: [],
  });
  const boxes = JSON.parse(addonFunction('domLayoutBoxes')(JSON.stringify(request))) as Record<string, { width: number; height: number }>;
  const box = boxes['$0.0'];
  return box === undefined ? null : { width: box.width, height: box.height };
}
