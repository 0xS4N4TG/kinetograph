// RN-Skia's offscreen drawing: `Skia.Surface.Make` / `MakeOffscreen` (a canvas to draw on, and a snapshot of it as a
// picture), `drawAsImage` and `drawAsPicture` (an element drawn into a picture). What is drawn is recorded here and
// rasterised by the addon on the CPU when the picture is drawn, so a snapshot is the same on every machine.

import type { ReactNode } from 'react';
import { renderNodes } from './host.js';
import { SkImage, SkPicture, SkRecordingCanvas, type SkRect } from './objects.js';

/** A surface: a canvas of `width` by `height` whose drawing a snapshot keeps. */
export class SkSurface {
  private readonly canvas = new SkRecordingCanvas();
  constructor(
    private readonly w: number,
    private readonly h: number,
  ) {}
  getCanvas(): SkRecordingCanvas {
    return this.canvas;
  }
  width(): number {
    return this.w;
  }
  height(): number {
    return this.h;
  }
  /** Every call is recorded as it is made; there is nothing to send. */
  flush(): void {}
  /** What was drawn so far, as a picture; `bounds` keeps that part of it. */
  makeImageSnapshot(bounds?: SkRect): SkImage {
    const ops = [...this.canvas.ops];
    const area = bounds ?? { x: 0, y: 0, width: this.w, height: this.h };
    if (bounds) ops.unshift({ op: 'translate', x: -bounds.x, y: -bounds.y });
    const size = { width: Math.max(1, Math.round(area.width)), height: Math.max(1, Math.round(area.height)) };
    return new SkImage({ picture: { ops }, ...size }, size);
  }
  dispose(): void {}
}

const make = (width: number, height: number): SkSurface | null =>
  width >= 1 && height >= 1 && width <= 16384 && height <= 16384 ? new SkSurface(Math.round(width), Math.round(height)) : null;

export const SurfaceFactory = {
  /** A surface, or null for a size of no area. */
  Make: make,
  /** RN-Skia's GPU surface: the same here, rasterised on the CPU so the pixels do not depend on the machine. */
  MakeOffscreen: make,
  MakeNull: make,
};

/** `element` (Skia components) drawn into a picture `size` large. */
export function drawAsImage(element: ReactNode, size: { width: number; height: number }): SkImage {
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  return new SkImage({ nodes: renderNodes(element), width, height }, { width, height });
}

/** `element` (Skia components) recorded as a picture. */
export function drawAsPicture(element: ReactNode, bounds?: SkRect): SkPicture {
  return new SkPicture([{ op: 'drawNodes', nodes: renderNodes(element) }], bounds);
}
