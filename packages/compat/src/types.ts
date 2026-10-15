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
  /** Seconds (frame / fps): the clock CSS animations and transitions read. Default 0. */
  time?: number;
  /** Where relative `src` and `url()` resolve, then `publicDir`. Default: the DOM environment's. */
  baseDir?: string;
  publicDir?: string;
  /** Document-wide CSS: imported files, then every `<style>` element of the tree. Default: the imported ones. */
  stylesheets?: readonly string[];
}

export interface IslandResult {
  layers: LayerJson[];
  unsupported: Unsupported[];
  /** From a `perspective` property (docs/COMPAT.md §4.3). */
  camera: CameraJson | null;
  /** The least scene `margin` (pixels) the island needs, for the blurs that reach past their layers (docs/ENGINE.md §2). */
  margin?: number;
  /** The scene's `blendSpace` the island is painted for (ENGINE.md §2). */
  blendSpace?: 'linear' | 'srgb';
}
