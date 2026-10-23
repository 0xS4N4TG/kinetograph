// Renders React with DOM elements through a fake DOM island renderer, and keeps what was sent to it: the request is
// the tree the CSS engine would be asked to lay out (packages/cli/skills/kinetograph/references/ENGINE.md §10.1).

import type { ReactNode } from 'react';
import { afterEach, beforeEach } from 'vitest';
import { setDomAddon } from '@kinetograph/compat/dom';
import { createSceneRoot, TimelineContext, type RenderedTree } from '@kinetograph/react';
import { timeline } from './scene-harness.js';

/** The island requests sent since the last `renderDom`, in order. Fill it from a `describe` with `useFakeDom()`. */
export const sent: any[] = [];

/** The fake addon answers every island with an empty group, and `unsupported` for each tag in `unsupportedTags`. */
export function useFakeDom(unsupportedTags: string[] = []): void {
  beforeEach(() => {
    sent.length = 0;
    setDomAddon({
      renderDomIsland(json: string) {
        const request = JSON.parse(json);
        sent.push(request);
        const unsupported: unknown[] = [];
        const visit = (node: any): void => {
          if (node.kind !== 'element') return;
          if (unsupportedTags.includes(node.tag)) {
            unsupported.push({ path: node.path, element: node.tag, property: null, value: null, reason: 'fake' });
          }
          node.children.forEach(visit);
        };
        visit(request.root);
        // A native element is a placeholder at the corner of its box, as the painter leaves it.
        const natives: unknown[] = [];
        const place = (node: any): void => {
          if (node.kind === 'native') natives.push({ type: 'native', path: node.path, x: 0, y: 0, width: node.width ?? 0, height: node.height ?? 0 });
          if (node.kind === 'element') node.children.forEach(place);
        };
        place(request.root);
        return JSON.stringify({ layers: [{ id: request.path, type: 'group', children: natives }], unsupported, camera: null });
      },
    });
  });
  afterEach(() => setDomAddon(null));
}

/** Renders `node` at `frame` of a 1000 x 800, 30 fps, 90 frame composition. */
export function renderDom(node: ReactNode, frame = 0): RenderedTree {
  const root = createSceneRoot({ viewport: { width: 1000, height: 800 } });
  try {
    return root.render(<TimelineContext.Provider value={timeline(frame)}>{node}</TimelineContext.Provider>);
  } finally {
    root.unmount();
  }
}

/** A request node as `tag`, its `style` if it has one, and its children. */
export function summary(node: any): unknown {
  if (node.kind === 'text') return node.text;
  if (node.kind === 'native') return { native: node.path };
  return {
    tag: node.tag,
    ...(node.style ? { style: node.style } : {}),
    ...(node.children.length ? { children: node.children.map(summary) } : {}),
  };
}
