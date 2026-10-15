// `@kinetograph/compat/dom` (docs/ENGINE.md §1, §2): a DOM island is handed to the addon as an `IslandRequest`; Stylo,
// taffy and Parley style and lay it out, our compositor paints it, and the layers come back as scene JSON. Native
// (`kg-*`) elements inside the island are drawn here and put where Rust placed their boxes.
//
// The Phase 5 TypeScript mapping is still in `legacy.ts`; `KINETOGRAPH_DOM_MAPPER=legacy` selects it.

import type { CameraJson, LayerJson, Unsupported } from '@kinetograph/scene';
import { addonFunction } from '../addon.js';
import { getDomEnvironment, importedStylesheets, noteStylesheet, readLocalStylesheet } from '../environment.js';
import { buildIslandRequest, type IslandRequestJson } from '../request/build.js';
import { isDomElement } from '../request/tags.js';
import type { DomNode, IslandContext, IslandResult } from '../types.js';
import { fillNatives, nativeSize } from './native.js';
import { mapLegacyIsland } from './legacy.js';

export { isDomElement };
export { mapLegacyIsland, mapStyledIsland, setLayoutDom } from './legacy.js';
export type { LayoutDom } from './legacy.js';
export type { StyledElement, StyledNode, StyledNative, StyledText } from './tree.js';
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
  parseFontFaces,
  resolveProjectFile,
} from '../environment.js';
export type { DomEnvironment, CssFontFace } from '../environment.js';
export { buildIslandRequest, collectStyleElements, styleText } from '../request/build.js';
export type { IslandRequestJson, RequestNode, BuildOptions, BuiltRequest } from '../request/build.js';
export { styleToCss } from '../request/style.js';
export { attributesOf } from '../request/attrs.js';
export { nativeSize } from './native.js';

/** What `renderDomIsland` returns (`IslandOutput` of `crates/dom/src/request.rs`). */
interface IslandOutputJson {
  layers: unknown[];
  unsupported?: Unsupported[];
  camera?: CameraJson | null;
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
  if (process.env.KINETOGRAPH_DOM_MAPPER === 'legacy') return mapLegacyIsland(root, context);
  if (INVISIBLE.has(root.type)) return { layers: [], unsupported: [], camera: null };

  const { request, natives } = requestFor(root, context);
  const output = JSON.parse(addonFunction('renderDomIsland')(JSON.stringify(request))) as IslandOutputJson;

  const placed = fillNatives(output.layers, (path) => {
    const node = natives.get(path);
    return node === undefined ? null : context.emitNative(node, path);
  });
  // The island is laid out in the composition's box already: a flex layout around it must not place it again.
  const layers = placed.map((layer) => (layer.layoutItem === undefined ? ({ ...layer, layoutItem: { position: 'absolute' } } as LayerJson) : layer));
  return { layers, unsupported: output.unsupported ?? [], camera: output.camera ?? null };
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
