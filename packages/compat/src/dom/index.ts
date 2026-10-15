// `@kinetograph/compat/dom` (docs/COMPAT.md §4, §5): a DOM island parsed (`css`), laid out by the addon's
// `layoutDom` and mapped onto plain layers. Parse, layout and map are separate steps so that the mapping can be
// tested from `ParsedStyle` values (`mapStyledIsland`).

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { CameraJson, LayerJson, Unsupported } from '@kinetograph/scene';
import { parseStyle } from '../css/index.js';
import type { DomNode, IslandContext, IslandResult } from '../types.js';
import { buildIsland, place, type BuildContext, type DomLayoutBox, type DomLayoutNode } from './box.js';
import { isDomElement } from './elements.js';
import { mapRoot, type MapContext } from './map.js';
import { parseTree, Report, type StyledElement } from './tree.js';

export { isDomElement };
export type { StyledElement, StyledNode, StyledNative, StyledText } from './tree.js';

/** The addon's `layoutDom`: a `DomLayoutRequest` as JSON in, a `DomLayoutBox` as JSON out (docs/COMPAT.md §5.1). */
export type LayoutDom = (requestJson: string) => string;

let layoutOverride: LayoutDom | null = null;
let layoutNative: LayoutDom | null = null;

/** Hands over the addon's `layoutDom` (the host does, as with `setLayoutText`; tests pass a stub, `null` goes back). */
export function setLayoutDom(fn: LayoutDom | null): void {
  layoutOverride = fn;
}

/**
 * The addon's `layoutDom`, found when first needed (a project with no DOM elements does not need the addon): from
 * here, then from the working directory. A bundle in a project's cache may sit where neither reaches it; the host
 * then calls `setLayoutDom(native.layoutDom)`.
 */
function loadNative(): LayoutDom {
  const failures: string[] = [];
  for (const base of [import.meta.url, pathToFileURL(`${process.cwd()}/`).href]) {
    try {
      return (createRequire(base)('@kinetograph/native') as { layoutDom: LayoutDom }).layoutDom;
    } catch (error) {
      failures.push(error instanceof Error ? error.message.split('\n')[0]! : String(error));
    }
  }
  throw new Error(
    `DOM elements cannot be laid out: @kinetograph/native could not be loaded (${failures.join('; ')}). ` +
      'Build the addon, or pass its layoutDom to setLayoutDom() from @kinetograph/compat/dom.',
  );
}

function layoutDom(requestJson: string): string {
  if (layoutOverride) return layoutOverride(requestJson);
  layoutNative ??= loadNative();
  return layoutNative(requestJson);
}

/** Lays out the island's boxes (one `layoutDom` call) and returns the root's `DomLayoutBox`. */
function lay(root: DomLayoutNode, context: IslandContext): DomLayoutBox {
  const request = {
    root,
    available: { width: context.viewport.width, height: context.viewport.height },
    fonts: context.fonts,
  };
  return JSON.parse(layoutDom(JSON.stringify(request))) as DomLayoutBox;
}

/**
 * Lays out and maps an island whose styles are parsed: the part of `mapDomIsland` after `parseStyle`. `report` holds
 * what `parseTree` has already reported (nothing, from hand-built trees).
 */
export function mapStyledIsland(root: StyledElement, context: IslandContext, report = new Report()): IslandResult {
  const build: BuildContext = {
    viewport: context.viewport,
    fonts: context.fonts,
    report,
    emitNative: (node, path) => context.emitNative(node, path),
  };
  const box = buildIsland(root, build);
  if (box === null) return { layers: [], unsupported: report.items, camera: null };

  place(box, lay(box.layout, context));
  const mc: MapContext = { report, viewport: context.viewport, camera: null };
  const layer = mapRoot(box, mc);
  const layers: LayerJson[] = [];
  if (layer !== null) {
    // The island is laid out in the composition's box already: a flex layout around it must not place it again.
    layers.push({ ...layer, layoutItem: { position: 'absolute' } } as LayerJson);
  }
  const camera: CameraJson | null = mc.camera;
  return { layers, unsupported: report.items as Unsupported[], camera };
}

export function mapDomIsland(root: DomNode, context: IslandContext): IslandResult {
  if (root.kind !== 'element' || !isDomElement(root.type)) {
    throw new Error('mapDomIsland needs a DOM element as the root of an island');
  }
  const styled = parseTree(root, context.path, {
    parseStyle,
    claimId: context.claimId ?? (() => true),
  }) as StyledElement;
  return mapStyledIsland(styled, context);
}
