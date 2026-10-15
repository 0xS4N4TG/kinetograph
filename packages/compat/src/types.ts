// The types compat mode's streams share (docs/COMPAT.md §2, §6.1). Owned by the orchestrator.

import type { CameraJson, LayerJson, Unsupported } from '@kinetograph/scene';

export type { Unsupported };

/** A host node as the reconciler keeps it: the same shape as `@kinetograph/react`'s `HostNode`. */
export type DomNode =
  | { kind: 'element'; type: string; props: Record<string, any>; children: DomNode[] }
  | { kind: 'text'; text: string };

export interface IslandContext {
  /** The island root's host-tree index path (`$0.2`). */
  path: string;
  /** The composition's size: the box an island is laid out in. */
  viewport: { width: number; height: number };
  /** `getFonts()`: font key → file. */
  fonts: Record<string, string>;
  /** Emits a native (`kg-*`) element found inside the island, as the reconciler would at `path`. */
  emitNative(node: DomNode, path: string): LayerJson | null;
}

export interface IslandResult {
  layers: LayerJson[];
  unsupported: Unsupported[];
  /** From a `perspective` property (docs/COMPAT.md §4.3). */
  camera: CameraJson | null;
}

export type RenderPath = 'native' | 'chrome';
export type CompatMode = 'auto' | 'native' | 'chrome';

/** Inclusive frames drawn one way. */
export interface Run {
  first: number;
  last: number;
  path: RenderPath;
}
