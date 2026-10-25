// p5.brush for a frame-driven render. p5.brush draws on a canvas with its own WebGL, and keeps state between calls
// (the seed, the active brush, fill and hatch settings, the transform). A frame that draws from that state is not a
// function of the frame number. So each frame this component reseeds, clears, draws inside push/pop (the state a
// frame sets is dropped when it ends) and flushes, which makes a frame the same alone and in sequence.
//
// `p5.brush` is a peer dependency, used through its standalone build, and is never patched.

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { continueRender, delayRender, useCurrentFrame, useVideoConfig } from 'remotion';
import * as brushModule from 'p5.brush/standalone';

/** The p5.brush standalone API (`brush.set`, `brush.line`, `brush.fill`, ...). p5.brush ships no types. */
export type Brush = Record<string, any>;

const brush = brushModule as unknown as Brush;

export interface BrushCanvasProps {
  /** Seeds p5.brush's random and noise generators at the start of every frame. */
  seed: number | string;
  /**
   * Draws the frame. `size` is the canvas size in pixels. Coordinates are p5.brush's own: the origin is the centre
   * of the canvas, y points down (as in p5's WEBGL mode), unless `origin="top-left"`.
   */
  draw: (brush: Brush, frame: number, size: { width: number; height: number }) => void;
  /** Canvas width in pixels. Default: the composition's width. */
  width?: number;
  /** Canvas height in pixels. Default: the composition's height. */
  height?: number;
  /** Where (0, 0) is. `'center'` is p5.brush's own; `'top-left'` translates so that (0, 0) is the top left corner. */
  origin?: 'center' | 'top-left';
  /** Paper colour for `brush.clear()`. Default: transparent. */
  background?: string;
  style?: CSSProperties;
}

/**
 * A canvas that p5.brush draws into: `brush.load(canvas)` (never `createCanvas`), then each frame `clear`, `seed`,
 * `noiseSeed`, `draw`, `render`.
 *
 * ```tsx
 * <BrushCanvas seed={7} background="#f4efe6" origin="top-left" draw={(b, frame) => {
 *   b.set('HB', '#2f2a26', 1.4);
 *   b.line(120, 140, 120 + frame * 10, 260);
 * }} />
 * ```
 */
export function BrushCanvas({ seed, draw, width, height, origin = 'center', background, style }: BrushCanvasProps) {
  const frame = useCurrentFrame();
  const config = useVideoConfig();
  const w = width ?? config.width;
  const h = height ?? config.height;
  const ref = useRef<HTMLCanvasElement>(null);
  // Held until the first frame is drawn, so a render never reads the canvas before p5.brush has put anything on it.
  const [handle] = useState(() => delayRender('p5.brush: loading'));

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    brush.load(canvas);
    if (background === undefined) brush.clear();
    else brush.clear(background);
    brush.seed(seed);
    brush.noiseSeed(seed);
    brush.push();
    try {
      if (origin === 'top-left') brush.translate(-w / 2, -h / 2);
      draw(brush, frame, { width: w, height: h });
      brush.render();
    } finally {
      brush.pop();
    }
    continueRender(handle);
  });

  return <canvas ref={ref} width={w} height={h} style={{ width: w, height: h, display: 'block', ...style }} />;
}
