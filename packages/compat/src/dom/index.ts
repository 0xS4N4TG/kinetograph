// `@kinetograph/compat/dom` (docs/COMPAT.md §4, §5): a DOM island laid out by
// the addon's `layoutDom` and mapped onto plain layers. Stream 2.

import type { IslandContext, IslandResult, DomNode } from '../types.js';

/** The addon's `layoutDom`: a `DomLayoutRequest` as JSON in, a `DomLayoutBox` as JSON out (docs/COMPAT.md §5.1). */
export type LayoutDom = (requestJson: string) => string;

/** Hands over the addon's `layoutDom` (the host does, as with `setLayoutText`; tests pass a stub, `null` goes back). */
export function setLayoutDom(_fn: LayoutDom | null): void {
  throw new Error('not implemented: setLayoutDom (docs/COMPAT.md §5.1)');
}

/** The DOM element types the reconciler accepts as host elements (docs/COMPAT.md §4.1, §4.5). */
export function isDomElement(_type: string): boolean {
  throw new Error('not implemented: isDomElement (docs/COMPAT.md §4.1)');
}

export function mapDomIsland(_root: DomNode, _context: IslandContext): IslandResult {
  throw new Error('not implemented: mapDomIsland (docs/COMPAT.md §2)');
}
