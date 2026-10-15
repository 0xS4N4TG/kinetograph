/// <reference lib="dom" />
// `createSceneRoot` of the Chrome bundle (docs/COMPAT.md §6.2). In the Node bundle `@kinetograph/react`'s root turns
// the element tree into scene JSON; here it renders the same tree with React DOM, into the page's stage, and returns
// an empty tree. `@kinetograph/core`'s frame loop, which owns the virtual clock, the `delayRender` handles and the
// font waits, then drives the page exactly as it drives the reconciler, with no change.

import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

/** What the reconciler's root returns; nothing here is a layer, the page is the picture. */
export interface RenderedTree {
  layers: never[];
  camera: null;
  audio: never[];
  sequences: never[];
  unsupported: never[];
}

export interface SceneRoot {
  /** Renders `element` synchronously (effects flushed). A component that throws makes this throw. */
  render(element: ReactNode): RenderedTree;
  /** `render` without the tree (the frame loop reads it with `snapshot`). */
  update(element: ReactNode): void;
  snapshot(): RenderedTree;
  unmount(): void;
}

const EMPTY: RenderedTree = { layers: [], camera: null, audio: [], sequences: [], unsupported: [] };

export const STAGE_ID = 'kg-stage';

/** The element compositions are drawn in, if the page has one. */
export function findStage(): HTMLElement | null {
  return document.getElementById(STAGE_ID);
}

// The stage holds one root at a time. Finding the compositions renders the Root once and throws it away (nothing in it
// is drawn), so it must not take the stage from the roots that draw frames.
let stageTaken = false;

export function createSceneRoot(): SceneRoot {
  const stage = findStage();
  const useStage = stage !== null && !stageTaken;
  const container = useStage ? stage : document.createElement('div');
  if (useStage) stageTaken = true;

  // React 19 reports an error no boundary caught to `onUncaughtError` instead of throwing it, and unmounts the tree.
  const caught: { failure: { error: unknown } | null } = { failure: null };
  const root: Root = createRoot(container, {
    onUncaughtError: (error) => {
      caught.failure ??= { error };
    },
    onRecoverableError: () => {},
  });
  let mounted = true;

  function update(element: ReactNode): void {
    caught.failure = null;
    flushSync(() => root.render(element));
    const failure = caught.failure as { error: unknown } | null;
    if (failure) throw failure.error;
  }

  return {
    render(element) {
      update(element);
      return EMPTY;
    },
    update,
    snapshot: () => EMPTY,
    unmount() {
      if (!mounted) return;
      mounted = false;
      flushSync(() => root.unmount());
      if (useStage) stageTaken = false;
    },
  };
}
