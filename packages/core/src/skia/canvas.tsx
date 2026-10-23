// `<Canvas>` of RN-Skia and `<SkiaCanvas>` of `@remotion/skia`: the children are rendered into a tree of nodes (host.ts),
// drawn by Skia's CPU rasteriser in the addon (packages/cli/skills/kinetograph/references/AUTHORING.md §7.7), and the picture is an `<img>` of a PNG the
// addon wrote, which the layout and the compositor treat like any other image.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createElement, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { getDomEnvironment } from '@kinetograph/compat/dom';
import { TimelineContext, useTimeline } from '@kinetograph/react';
import { reportUnsupported } from '../unsupported.js';
import { skiaAddon } from './addon.js';
import { renderNodes } from './host.js';

export interface CanvasProps {
  children?: ReactNode;
  style?: CSSProperties & Record<string, unknown>;
  width?: number;
  height?: number;
  className?: string;
  /** Accepted as in RN-Skia, with no effect here: `opaque`, `onSize`, `colorSpace`, `mode`, `debug`, `ref`. */
  [other: string]: unknown;
}

const OUT_DIR = join(homedir(), '.cache', 'kinetograph', 'skia');

/** Size in pixels from `width`/`height`, else the style, else the composition. */
function pixels(value: unknown, fallback: number): number {
  return typeof value === 'number' && value > 0 ? Math.round(value) : fallback;
}

/** RN-Skia's `<Canvas>`; its size is `width` and `height`, else the style's, else the composition's. */
export function Canvas({ children, style, width, height, className }: CanvasProps): ReactElement {
  const timeline = useTimeline();
  const w = pixels(width ?? style?.width, timeline.config.width);
  const h = pixels(height ?? style?.height, timeline.config.height);
  // The children read the timeline through the outer renderer's context, which the inner renderer does not share.
  const nodes = renderNodes(createElement(TimelineContext.Provider, { value: timeline }, children));
  const request = { width: w, height: h, nodes, baseDir: getDomEnvironment().baseDir ?? '', outDir: OUT_DIR };
  const drawn = JSON.parse(skiaAddon().renderSkia(JSON.stringify(request))) as {
    path: string;
    unsupported: { element: string; property: string | null; reason: string }[];
  };
  for (const item of drawn.unsupported) reportUnsupported('SkiaCanvas', item.element + (item.property ? `.${item.property}` : ''), null, item.reason);
  return createElement('img', { src: drawn.path, width: w, height: h, className, style: { display: 'block', width: w, height: h, ...style } });
}

/** `@remotion/skia`'s `<SkiaCanvas width height>`. */
export function SkiaCanvas({ width, height, ...props }: CanvasProps & { width: number; height: number }): ReactElement {
  return createElement(Canvas, { width, height, ...props });
}

/** RN-Skia's `useCanvasRef()`: a ref object; nothing reads it back here. */
export function useCanvasRef(): { current: null } {
  return { current: null };
}
