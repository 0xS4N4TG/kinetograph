// `<HtmlInCanvas>`: Remotion's way to run a canvas program over live HTML (Chrome's `drawElementImage`). The HTML is a
// child, the canvas shows it, `onPaint` / `onInit` / `effects` may change what is shown. Kinetograph has no browser
// canvas, so `isHtmlInCanvasSupported()` is false (a project can pick another path from it) and the component shows
// its children as the CSS engine draws them, which is what the canvas shows when nothing paints over it. An
// `onPaint`, `onInit` or enabled effect is not run, and a warning says so.

import type { CSSProperties, ReactNode } from 'react';
import { assertValidPixelDensity, warnEffects, type EffectsOutputSize, type EffectsProp } from './effects.js';
import { croppedStyle, Sequenced, splitCrop, splitTiming, type CropProps, type SequenceTimingProps } from './sequenced.js';
import { warnOnce } from './warn.js';

/** The message a project shows, or Remotion throws, where `<HtmlInCanvas>` cannot run its canvas program. */
export const HTML_IN_CANVAS_UNSUPPORTED_MESSAGE =
  'HTML in Canvas needs a browser canvas that can draw an element (Chrome 149 or newer with Canvas Draw Element enabled), and Kinetograph has none: <HtmlInCanvas> shows its children as they are, without onPaint, onInit or effects.';

/** Always false: there is no canvas that can draw an element. */
export function isHtmlInCanvasSupported(): boolean {
  return false;
}

/** Always false, for the same reason. */
export function isHtmlInCanvasNestingSupported(): boolean {
  return false;
}

export function getHtmlInCanvasUnsupportedMessage(): string {
  return HTML_IN_CANVAS_UNSUPPORTED_MESSAGE;
}

/** What `onPaint` and `onInit` are handed in the browser. Nothing here calls them. */
export interface HtmlInCanvasOnPaintParams {
  readonly canvas: unknown;
  readonly element: unknown;
  readonly elementImage: unknown;
  readonly pixelDensity: number;
}

export type HtmlInCanvasOnPaint = (params: HtmlInCanvasOnPaintParams) => void | Promise<void>;
export type HtmlInCanvasOnInitCleanup = () => void;
export type HtmlInCanvasOnInit = (params: HtmlInCanvasOnPaintParams) => HtmlInCanvasOnInitCleanup | Promise<HtmlInCanvasOnInitCleanup>;
export type HtmlInCanvasPixelDensity = number;

export interface HtmlInCanvasProps extends SequenceTimingProps, CropProps {
  /** The canvas's size in CSS pixels: whole numbers above 0. */
  width: number;
  height: number;
  children: ReactNode;
  effects?: EffectsProp;
  effectsOutputSize?: EffectsOutputSize;
  onPaint?: HtmlInCanvasOnPaint;
  onInit?: HtmlInCanvasOnInit;
  pixelDensity?: HtmlInCanvasPixelDensity;
  style?: CSSProperties;
}

function assertDimensions(width: unknown, height: unknown): void {
  if (typeof width !== 'number' || typeof height !== 'number') {
    throw new Error(`HtmlInCanvas: \`width\` and \`height\` must be numbers. Received width=${String(width)}, height=${String(height)}.`);
  }
  if (!Number.isInteger(width) || width <= 0) throw new Error(`HtmlInCanvas: \`width\` must be a positive integer. Received: ${String(width)}.`);
  if (!Number.isInteger(height) || height <= 0) throw new Error(`HtmlInCanvas: \`height\` must be a positive integer. Received: ${String(height)}.`);
}

function HtmlInCanvasComponent(props: HtmlInCanvasProps): ReactNode {
  const [timing, withoutTiming] = splitTiming(props);
  const [crop, { width, height, children, effects, onPaint, onInit, pixelDensity, style }] = splitCrop(withoutTiming);
  assertDimensions(width, height);
  assertValidPixelDensity('HtmlInCanvas', pixelDensity);
  if (onPaint !== undefined || onInit !== undefined) {
    warnOnce('<HtmlInCanvas>.paint', '<HtmlInCanvas> does not run onPaint or onInit: they draw on a browser canvas. Its children are shown as they are.');
  }
  warnEffects('<HtmlInCanvas>', effects);
  // The canvas clips what it shows to its own size.
  return (
    <Sequenced timing={timing} component="<HtmlInCanvas>" defaultName="<HtmlInCanvas>">
      <div style={{ width, height, overflow: 'hidden', ...croppedStyle('<HtmlInCanvas />', crop, style) }}>{children}</div>
    </Sequenced>
  );
}

export const HtmlInCanvas = Object.assign(HtmlInCanvasComponent, {
  isSupported: isHtmlInCanvasSupported,
  isNestingSupported: isHtmlInCanvasNestingSupported,
});
