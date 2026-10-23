// `<HtmlInCanvas>`: Remotion's way to run a canvas program over live HTML (Chrome's `drawElementImage`). The HTML is a
// child, the canvas shows it, `onPaint` / `onInit` / `effects` may change what is shown. Kinetograph has no browser
// canvas, but the program runs all the same on recording canvases (effect-chain.tsx): the children are drawn as a layer,
// `elementImage` is the picture of that layer, and what `onPaint` draws with it on a 2D, WebGL or WebGL 2 context
// replaces the picture. `onInit` runs before `onPaint` for every frame, and the cleanup it returns after it. A WebGPU
// context is not run (the children are shown, and the frame reports it). So `isHtmlInCanvasSupported()` is true;
// `isHtmlInCanvasNestingSupported()` (an `<HtmlInCanvas>` inside another) is false, as that is not tried.

import type { CSSProperties, ReactNode } from 'react';
import { assertValidPixelDensity, EffectsBox, hasEffects, type EffectsOutputSize, type EffectsProp } from './effects.js';
import { croppedStyle, Sequenced, splitCrop, splitTiming, type CropProps, type SequenceTimingProps } from './sequenced.js';

/** The message a project shows, or Remotion throws, where `<HtmlInCanvas>` cannot run its canvas program. */
export const HTML_IN_CANVAS_UNSUPPORTED_MESSAGE =
  'HTML in Canvas needs a browser canvas that can draw an element (Chrome 149 or newer with Canvas Draw Element enabled), and Kinetograph has none: <HtmlInCanvas> draws its onPaint, onInit and effects on recording canvases instead, which run 2D and WebGL contexts (not WebGPU).';

/** Always true: the element is drawn as a layer and its picture is handed to `onPaint` (a recording canvas, not Chrome's). */
export function isHtmlInCanvasSupported(): boolean {
  return true;
}

/** Always false: an `<HtmlInCanvas>` in the children of another is not tried. */
export function isHtmlInCanvasNestingSupported(): boolean {
  return false;
}

export function getHtmlInCanvasUnsupportedMessage(): string {
  return HTML_IN_CANVAS_UNSUPPORTED_MESSAGE;
}

/**
 * What `onPaint` and `onInit` are handed. `canvas` is a recorder: `getContext('2d')`, `getContext('webgl2')` and
 * `getContext('webgl')` work, `drawElementImage(elementImage, dx, dy[, dw, dh])` and `texElementImage2D` draw the
 * element. `element` has the size of the element (`clientWidth`, `offsetHeight`, `getBoundingClientRect()`), and
 * `elementImage` is its picture (`width`, `height`, `close()`).
 */
export interface HtmlInCanvasOnPaintParams {
  readonly canvas: any;
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
  effectsOutputSize?: EffectsOutputSize | null;
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
  const [crop, { width, height, children, effects, effectsOutputSize, onPaint, onInit, pixelDensity, style }] = splitCrop(withoutTiming);
  assertDimensions(width, height);
  assertValidPixelDensity('HtmlInCanvas', pixelDensity);
  const css = croppedStyle('<HtmlInCanvas />', crop, style);
  if (!hasEffects(effects) && onPaint === undefined && onInit === undefined) {
    // The canvas clips what it shows to its own size.
    return (
      <Sequenced timing={timing} component="<HtmlInCanvas>" defaultName="<HtmlInCanvas>">
        <div style={{ width, height, overflow: 'hidden', ...css }}>{children}</div>
      </Sequenced>
    );
  }
  return (
    <Sequenced timing={timing} component="<HtmlInCanvas>" defaultName="<HtmlInCanvas>">
      <EffectsBox
        component="<HtmlInCanvas>"
        effects={effects}
        effectsOutputSize={effectsOutputSize}
        width={width}
        height={height}
        pixelDensity={pixelDensity}
        paint={onPaint === undefined && onInit === undefined ? undefined : { onPaint: onPaint as never, onInit: onInit as never }}
        style={css ?? {}}
        source={(size) => (
          <div style={{ width, height, overflow: 'hidden', ...(size.width === width && size.height === height ? {} : { transform: `scale(${size.width / width}, ${size.height / height})`, transformOrigin: '0 0' }) }}>
            {children}
          </div>
        )}
      />
    </Sequenced>
  );
}

export const HtmlInCanvas = Object.assign(HtmlInCanvasComponent, {
  isSupported: isHtmlInCanvasSupported,
  isNestingSupported: isHtmlInCanvasNestingSupported,
});
