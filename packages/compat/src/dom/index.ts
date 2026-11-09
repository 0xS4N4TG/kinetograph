// `@kinetographdev/compat/dom` (packages/cli/skills/kinetograph/references/ENGINE.md §1, §2): a DOM island is handed to the addon as an `IslandRequest`; Stylo,
// taffy and Parley style and lay it out, our compositor paints it, and the layers come back as scene JSON. Native
// (`kg-*`) elements inside the island are drawn here and put where Rust placed their boxes.

import type { CameraJson, LayerJson, Unsupported } from '@kinetographdev/scene';
import { addonFunction, hasAddonFunction } from '../addon.js';
import { fontFacesRegistered, getDomEnvironment, importedStylesheets, noteStylesheet, readLocalStylesheet } from '../environment.js';
import { buildIslandRequest, type IslandRequestJson } from '../request/build.js';
import { isDomElement } from '../request/tags.js';
import type { DomNode, IslandContext, IslandResult } from '../types.js';
import { fillNatives, nativeSize, overlaysSiblings } from './native.js';
import { historyFor, isWarming, noteTransitions, recordIsland } from './history.js';
import { islandMoves } from './moving.js';
import { lap, stamp } from '../profile.js';

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
export { editableRequest, islandEdits } from '../request/edits.js';
export type { ChangedElement, EditableRequest, NodeEditJson } from '../request/edits.js';
export { parseSrcset, sourceSize, srcsetCandidate } from '../request/srcset.js';
export type { IslandRequestJson, RequestNode, BuildOptions, BuiltRequest } from '../request/build.js';
export { styleToCss } from '../request/style.js';
export { attributesOf } from '../request/attrs.js';
export { nativeSize, overlaysSiblings } from './native.js';
export { lap, stamp } from '../profile.js';
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
  /** In a pass: `layers` are written as changes from the island's kept layers of that pass (`bases`, `expand`). */
  delta?: number;
}

/** The pass in progress, or null (packages/cli/skills/kinetograph/references/SCENE.md, "Motion blur"). */
let samplePass: number | null = null;
let passes = 0;
/** The pass before the one in progress, or null. */
let lastPass: number | null = null;

/**
 * The layers each island's renders are written against, by path (`Base` of crates/node/src/dom.rs): its first render
 * of a pass, or its last one written in full. The addon keeps the same ones, and writes the island's later renders in
 * the pass and in the next one as changes from them; a layer that did not change is the same object as here.
 */
const bases = new Map<string, { pass: number; layers: unknown[] }>();

/**
 * Marks the islands rendered from now to `endSamplePass()` as the renders of one frame: the frame itself and the
 * samples of its motion blur. The addon keeps an island's document between them, and from one frame to the next
 * (`breakSamplePasses`), and edits it from one render to the next instead of building it again; each is drawn as if it
 * were built afresh. A later render of an island, in the pass or the next, gives back what changed from its `bases`
 * entry, and shares the layers that did not with it.
 */
export function beginSamplePass(): void {
  dropQueue();
  if (typeof process !== 'undefined' && process.env?.KINETOGRAPH_NO_INCREMENTAL) breakSamplePasses();
  passes = (passes % 0x7fffffff) + 1;
  samplePass = passes;
  // As the addon does: the pass after the last keeps the bases the last made, any other none.
  if (lastPass !== null && samplePass === lastPass + 1) {
    for (const [path, base] of bases) if (base.pass !== lastPass) bases.delete(path);
  } else {
    bases.clear();
  }
}

/**
 * Says that the next pass does not follow the one before (a frame that is not the next one, a new scene): the addon
 * keeps an island's document from one pass to the next pass only when the numbers are in sequence, so this skips one.
 */
export function breakSamplePasses(): void {
  passes = (passes % 0x7fffffff) + 1;
}

export function endSamplePass(): void {
  dropQueue();
  lastPass = samplePass;
  samplePass = null;
}

/**
 * The pass in progress, for a readback of the frame's tree to pass on (`domLayoutBoxes`): the addon answers it from the
 * document the frame's render draws. Undefined outside a pass.
 */
export function currentSamplePass(): number | undefined {
  return samplePass ?? undefined;
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
  const faces = fontFacesRegistered();
  for (const css of stylesheets) noteStylesheet(css);
  const built = buildIslandRequest(root, {
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
  // A font the page's CSS registered just now is not in the list the caller read before: never lay text out without it.
  if (fontFacesRegistered() !== faces && context.refreshFonts) built.request.fonts = context.refreshFonts();
  return built;
}

export function mapDomIsland(root: DomNode, context: IslandContext): IslandResult {
  let t = stamp();
  const prepared = prepare(root, context);
  t = lap('dom_prep', t);
  if (prepared === null) return { layers: [], unsupported: [], camera: null };
  const { request, natives, json } = prepared;
  const text = samplePass === null ? addonFunction('renderDomIsland')(json) : addonFunction('renderDomIsland')(json, samplePass, bases.get(request.path)?.pass);
  t = lap('dom_native', t);
  const output = JSON.parse(text) as IslandOutputJson;
  const result = assemble(output, request.path, (path) => {
    const node = natives.get(path);
    return node === undefined ? null : context.emitNative(node, path);
  });
  lap('dom_asm', t);
  return result;
}

/** The request for an island, or null when it draws nothing (an invisible root) or the addon is off (a warm-up). */
function prepare(root: DomNode, context: IslandContext) {
  if (root.kind !== 'element' || !isDomElement(root.type)) {
    throw new Error('mapDomIsland needs a DOM element as the root of an island');
  }
  if (INVISIBLE.has(root.type)) return null;
  const { request, natives } = requestFor(root, context);
  // A CSS transition needs the island's earlier states (packages/cli/skills/kinetograph/references/ENGINE.md §7.12).
  noteTransitions(request.root, request.stylesheets);
  const history = historyFor(request.path, request.time);
  recordIsland(request.path, request.time, request.root);
  // A history is only read when the island's CSS can move something (`islandMoves`, as the engine decides it): one
  // it would not read is not sent.
  if (history.length > 0 && islandMoves(request.stylesheets, [request.root, ...history.map((state) => state.root)])) request.history = history;
  if (isWarming()) return null;
  return { request, natives, json: JSON.stringify(request) };
}

/** An island's result from the addon's output; `emitNative` gives the layers of the native element at a path. */
function assemble(output: IslandOutputJson, path: string, emitNative: (path: string) => LayerJson | null): IslandResult {
  let drawn = output.layers;
  if (typeof output.delta === 'number') {
    const base = bases.get(path);
    if (base === undefined || base.pass !== output.delta) throw new Error(`renderDomIsland wrote island ${path} as changes from a render it did not make`);
    drawn = expand(drawn as Written[], base.layers);
    if (samplePass !== null && base.pass !== samplePass) bases.set(path, { pass: samplePass, layers: drawn });
  } else if (samplePass !== null) {
    bases.set(path, { pass: samplePass, layers: drawn });
  }
  const placed = fillNatives(drawn, emitNative);
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

/** An island render `startDomIsland` queued. */
export interface StartedIsland {
  /** Its result, as `mapDomIsland` gives it, once the addon has drawn it (and the ones started before it). */
  finish(): IslandResult;
}

interface Queued {
  ticket: number;
  path: string;
  natives: Map<string, LayerJson | null>;
  result: IslandResult | null;
}

/** The renders started in the pass, in the order the addon draws them. */
let queue: Queued[] = [];

/** Whether an island can be started now and finished later: in a pass, with an addon that queues renders. */
export function canStartDomIslands(): boolean {
  return samplePass !== null && hasAddonFunction('startDomIsland') && hasAddonFunction('finishDomIsland');
}

/**
 * `mapDomIsland` without waiting for the addon (`canStartDomIslands`): the render is queued behind the ones before it
 * and the caller goes on (the next motion-blur sub-frame renders while this one is drawn). The native elements inside
 * the island are emitted now, as the tree stands; the result comes from `finish()`.
 */
export function startDomIsland(root: DomNode, context: IslandContext): StartedIsland {
  let t = stamp();
  const prepared = prepare(root, context);
  t = lap('dom_prep', t);
  if (prepared === null) {
    const nothing: IslandResult = { layers: [], unsupported: [], camera: null };
    return { finish: () => nothing };
  }
  const { request, natives, json } = prepared;
  const ticket = addonFunction('startDomIsland')(json, samplePass ?? undefined, samplePass === null ? undefined : bases.get(request.path)?.pass);
  lap('dom_start', t);
  // In the queue before the islands its native elements start: finished in the order the addon draws them.
  const queued: Queued = { ticket, path: request.path, natives: new Map(), result: null };
  queue.push(queued);
  for (const [path, node] of natives) queued.natives.set(path, context.emitNative(node, path));
  return {
    finish() {
      while (queued.result === null) {
        const next = queue.shift();
        if (next === undefined) throw new Error(`island ${queued.path} was started in a pass that has ended`);
        let t = stamp();
        const text = addonFunction('finishDomIsland')(next.ticket);
        t = lap('dom_native', t);
        const output = JSON.parse(text) as IslandOutputJson;
        next.result = assemble(output, next.path, (path) => next.natives.get(path) ?? null);
        lap('dom_asm', t);
      }
      return queued.result;
    },
  };
}

/** Lets the addon finish what was started and not asked for (an error left it), so nothing waits in it. */
function dropQueue(): void {
  for (const left of queue) {
    try {
      addonFunction('finishDomIsland')(left.ticket);
    } catch {
      // The error belongs to a render nobody reads.
    }
  }
  queue = [];
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
