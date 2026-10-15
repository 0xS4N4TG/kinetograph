// `<canvas>` and `getContext('2d')` in compat mode (docs/SCENE.md, "canvas"): the context records its calls
// (`createCanvasContext` of `@kinetograph/scene`) and the commands reach the renderer as a canvas layer. A canvas in
// the tree keeps its context with its host element; one that is not in the tree (`document.createElement('canvas')`,
// `OffscreenCanvas`) is a `CanvasSurface`. Everything a canvas needs of the engine (the fonts, the text engine, the
// pixels of what was drawn) is asked of the addon here, so the recorder itself is plain TypeScript.

import {
  CANVAS_SOURCE,
  CanvasContext2D,
  createCanvasContext,
  createWebGLContext,
  WebGLContext,
  WebGLUnsupportedError,
  type CanvasCommand,
  type CanvasContextOptions,
  type CanvasPicture,
} from '@kinetograph/scene';
import { addonFunction, hasAddonFunction } from '../addon.js';
import { getDomEnvironment } from '../environment.js';
import type { HostElement } from './host.js';

export { CANVAS_SOURCE, CanvasContext2D, WebGLContext };

let fontsOf: () => Record<string, string> = () => ({});

/** The host hands over the font registry (`getFonts`), which a canvas's `font` is matched against. */
export function setCanvasFonts(fonts: () => Record<string, string>): void {
  fontsOf = fonts;
}

/** The text engine and the pixels, from the addon when it has them. */
export function canvasEnvironment(fonts: () => Record<string, string> = () => fontsOf()): Pick<CanvasContextOptions, 'fonts' | 'measure' | 'readPixels'> {
  return {
    fonts,
    measure(text, font, size) {
      if (text === '' || !hasAddonFunction('layoutText')) return text === '' ? { width: 0, ascent: size * 0.8, descent: size * 0.2 } : null;
      try {
        const laid = addonFunction('layoutText')({ text, font, size, fonts: fonts() });
        const line = laid.lines?.[0];
        return { width: laid.width, ascent: line ? line.baseline - line.top : size * 0.8, descent: line ? line.bottom - line.baseline : size * 0.2 };
      } catch {
        return null;
      }
    },
    readPixels(commands, size, rect) {
      const rgba = renderCanvas(commands, size, 'rgba');
      const out = new Uint8ClampedArray(rect.width * rect.height * 4);
      // Pixels outside the canvas are transparent black.
      for (let y = 0; y < rect.height; y += 1) {
        const row = rect.y + y;
        if (row < 0 || row >= size.height) continue;
        const from = Math.max(0, rect.x);
        const to = Math.min(size.width, rect.x + rect.width);
        if (to <= from) continue;
        out.set(rgba.subarray((row * size.width + from) * 4, (row * size.width + to) * 4), (y * rect.width + (from - rect.x)) * 4);
      }
      return out;
    },
  };
}

/** What the addon draws of `commands` on a transparent canvas: straight-alpha RGBA, or a PNG. */
function renderCanvas(commands: CanvasCommand[], size: { width: number; height: number }, format: 'rgba' | 'png'): Uint8Array {
  const request = { width: size.width, height: size.height, commands, fonts: fontsOf(), baseDir: getDomEnvironment().baseDir, format };
  return addonFunction('renderCanvas')(JSON.stringify(request));
}

const DEFAULT_WIDTH = 300;
const DEFAULT_HEIGHT = 150;

/** `canvas.width` and `height` as the element gives them: the attribute when it is a whole number of pixels, else the default. */
export function bitmapSide(attribute: string | null, fallback: number): number {
  if (attribute === null) return fallback;
  const value = Number.parseInt(attribute, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export { DEFAULT_HEIGHT, DEFAULT_WIDTH };

const contexts = new WeakMap<object, CanvasContext2D>();
/** The WebGL contexts of canvases in the tree (docs/SCENE.md, "glsl"). */
const glContexts = new WeakMap<object, WebGLContext>();
/** Every context made, for `resetCanvasStates` (weakly: a canvas that is gone takes its context with it). */
const live = new Set<WeakRef<CanvasContext2D | WebGLContext>>();

/** The pixels of a canvas texture: the commands drawn on a transparent canvas, straight alpha. */
function rasterizeCanvas(source: { width: number; height: number; commands: CanvasCommand[] }): Uint8Array | null {
  if (!hasAddonFunction('renderCanvas')) return null;
  return renderCanvas(source.commands, source, 'rgba');
}

const WEBGL_TYPE = /^(experimental-)?webgl2?$/;

function newGlContext(type: string, size: () => { width: number; height: number }, canvas: unknown, attributes: unknown): WebGLContext {
  const context = createWebGLContext({
    size,
    canvas,
    version: type.endsWith('2') ? 2 : 1,
    attributes: typeof attributes === "object" && attributes !== null ? (attributes as Record<string, unknown>) : undefined,
    rasterize: rasterizeCanvas,
  });
  live.add(new WeakRef(context));
  return context;
}

/**
 * Puts every canvas context's state back to a new canvas's, keeping what is drawn (`CanvasContext2D.resetState`). The
 * frame loop does it before it renders a frame, so a canvas drawn again for each frame starts from the same state
 * whichever frame was rendered before, as a function of the frame has to.
 */
export function resetCanvasStates(): void {
  for (const ref of live) {
    const context = ref.deref();
    if (context === undefined) live.delete(ref);
    else context.resetState();
  }
}

/** The WebGL recording of the canvas on `host`, or null when nothing was drawn on it. */
export function glContentOf(host: object): ReturnType<WebGLContext['content']> | null {
  const context = glContexts.get(host);
  return context === undefined || !context.drawn ? null : context.content();
}

/**
 * The 2D context of the canvas whose host element is `host`, made on first use. `size` is the canvas's bitmap size,
 * read when it matters (it changes with `canvas.width`). WebGL and the other kinds of context are not available.
 */
export function contextOfHost(host: object, type: string, size: () => { width: number; height: number }, canvas: unknown, attributes?: unknown): CanvasContext2D | WebGLContext | null {
  return contextFor(contexts, glContexts, host, type, size, canvas, attributes);
}

function contextFor(
  store: WeakMap<object, CanvasContext2D>,
  glStore: WeakMap<object, WebGLContext>,
  key: object,
  type: string,
  size: () => { width: number; height: number },
  canvas: unknown,
  attributes?: unknown,
): CanvasContext2D | WebGLContext | null {
  if (type === 'webgpu') throw new WebGLUnsupportedError('canvas.getContext("webgpu"); WebGPU has no native port, use "webgl", "webgl2" or "2d"');
  if (WEBGL_TYPE.test(type)) {
    // A canvas has one kind of context for good, as in a browser.
    if (store.has(key)) return null;
    let gl = glStore.get(key);
    if (gl === undefined) {
      gl = newGlContext(type, size, canvas, attributes);
      glStore.set(key, gl);
    }
    return gl;
  }
  if (type !== '2d') return null;
  if (glStore.has(key)) return null;
  let context = store.get(key);
  if (context === undefined) {
    context = createCanvasContext({ size, canvas, ...canvasEnvironment() });
    store.set(key, context);
    live.add(new WeakRef(context));
  }
  return context;
}

/** The commands the canvas on `host` was drawn with, or null when nothing was drawn on it. */
export function canvasCommandsOf(host: object): CanvasCommand[] | null {
  const context = contexts.get(host);
  return context === undefined || context.commands.length === 0 ? null : context.commands;
}

/** `props` with the commands drawn on a `<canvas>` host written where the painter reads them. */
export function withCanvasCommands(host: HostElement, props: Record<string, any>): Record<string, any> {
  if (host.type !== 'canvas') return props;
  const gl = glContentOf(host);
  if (gl !== null) return { ...props, 'data-kg-webgl': JSON.stringify(gl) };
  const commands = canvasCommandsOf(host);
  return commands === null ? props : { ...props, 'data-kg-canvas': JSON.stringify(commands) };
}

/** What `drawImage` and `createPattern` read from the canvas on `host`: the commands so far, in its bitmap's size. */
export function canvasPictureOf(host: object, size: { width: number; height: number }): CanvasPicture | null {
  if (glContexts.has(host)) throw new WebGLUnsupportedError('drawing or sampling a WebGL canvas as a picture; draw into the shader\'s own canvas');
  if (!(size.width > 0 && size.height > 0)) return null;
  return { source: { kind: 'canvas', width: size.width, height: size.height, commands: [...(contexts.get(host)?.commands ?? [])] }, width: size.width, height: size.height };
}

/** Resets the context of the canvas on `host` (its `width` or `height` was set), which empties it. */
export function resetCanvasOf(host: object): void {
  contexts.get(host)?.reset();
  glContexts.get(host)?.reset();
}

// ---- canvases outside the tree ----

/** The PNG of the commands, as a `data:` URL. */
function pngDataUrl(commands: CanvasCommand[], size: { width: number; height: number }): string {
  if (!(size.width > 0 && size.height > 0)) return 'data:,';
  return `data:image/png;base64,${Buffer.from(renderCanvas(commands, size, 'png')).toString('base64')}`;
}

/** `canvas.toDataURL()` of the canvas drawn with `commands`. Only PNG is made: another type is PNG too, as a browser answers for one it cannot encode. */
export function canvasToDataUrl(commands: CanvasCommand[], size: { width: number; height: number }): string {
  return pngDataUrl(commands, size);
}

/** The bytes of `canvas.toBlob()`. */
export function canvasToBlob(commands: CanvasCommand[], size: { width: number; height: number }): Blob {
  const png = size.width > 0 && size.height > 0 ? renderCanvas(commands, size, 'png') : new Uint8Array();
  return new Blob([png as BlobPart], { type: 'image/png' });
}

/** A canvas that is not in the tree: `document.createElement('canvas')` (its element wraps one) and `OffscreenCanvas`. */
export class CanvasSurface {
  private widthValue: number;
  private heightValue: number;
  private readonly store = new WeakMap<object, CanvasContext2D>();
  private readonly glStore = new WeakMap<object, WebGLContext>();
  constructor(width: number = DEFAULT_WIDTH, height: number = DEFAULT_HEIGHT) {
    this.widthValue = Math.max(0, Math.floor(Number(width)) || 0);
    this.heightValue = Math.max(0, Math.floor(Number(height)) || 0);
  }
  private get context(): CanvasContext2D | undefined {
    return this.store.get(this);
  }
  get width(): number {
    return this.widthValue;
  }
  set width(value: number) {
    this.widthValue = Math.max(0, Math.floor(Number(value)) || 0);
    this.context?.reset();
  }
  get height(): number {
    return this.heightValue;
  }
  set height(value: number) {
    this.heightValue = Math.max(0, Math.floor(Number(value)) || 0);
    this.context?.reset();
  }
  getContext(type: string, attributes?: unknown): CanvasContext2D | WebGLContext | null {
    return contextFor(this.store, this.glStore, this, type, () => ({ width: this.widthValue, height: this.heightValue }), this, attributes);
  }
  private refuseGl(): void {
    if (this.glStore.has(this)) throw new WebGLUnsupportedError('reading or drawing a WebGL canvas as a picture (toDataURL, toBlob, drawImage)');
  }
  toDataURL(): string {
    this.refuseGl();
    return canvasToDataUrl(this.context?.commands ?? [], { width: this.widthValue, height: this.heightValue });
  }
  toBlob(callback: (blob: Blob | null) => void): void {
    this.refuseGl();
    callback(canvasToBlob(this.context?.commands ?? [], { width: this.widthValue, height: this.heightValue }));
  }
  [CANVAS_SOURCE](): CanvasPicture | null {
    this.refuseGl();
    const size = { width: this.widthValue, height: this.heightValue };
    if (!(size.width > 0 && size.height > 0)) return null;
    return { source: { kind: 'canvas', ...size, commands: [...(this.context?.commands ?? [])] }, ...size };
  }
}

/** `new OffscreenCanvas(w, h)`. */
export class OffscreenCanvasShim extends CanvasSurface {
  constructor(width: number, height: number) {
    super(width, height);
  }
  async convertToBlob(): Promise<Blob> {
    return canvasToBlob((this.getContext('2d') as CanvasContext2D | null)?.commands ?? [], { width: this.width, height: this.height });
  }
  transferToImageBitmap(): never {
    throw new Error('transferToImageBitmap is not available: draw the OffscreenCanvas with drawImage instead');
  }
}
