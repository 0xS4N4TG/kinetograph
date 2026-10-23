// Remotion's effect chain (`runEffectChain`) on recording canvases. In a browser each effect draws the picture of the
// canvas before it onto the next canvas, with a 2D or WebGL 2 context, and the last canvas replaces the element's
// picture. Here the pictures are layers and the canvases record (docs/SCENE.md, "Shader groups" and "Canvas passes"):
//
//   - the element's content is drawn as a layer, `<id>-src`;
//   - effect 1 is run on a recording canvas whose `source` is the picture of that layer (`layerPicture`); what it draws
//     is a group around the layer, with a `glsl` pass (WebGL 2: the recording replayed on the GPU with the effect's own
//     GLSL) or a `canvas` pass (2D: the commands drawn on a canvas that can draw the layer's picture);
//   - effect N is run the same way over the group effect N-1 made, and the last group is what the element shows.
//
// Every frame builds the chain anew, so a render is a pure function of the frame. The one thing that differs from the
// browser is the state of an effect: Remotion calls `setup(target)` once for a canvas and keeps the state from frame to
// frame, here `setup`, `apply` and `cleanup` run in that order for every frame, on a canvas that is empty at the start of
// it. An effect whose picture depends on what earlier frames left in its state would differ; one that is a function of
// its params and of what the frame brings (a shader, a filter) is the same.
//
// `webgpu` effects are not run: the picture is drawn without them and the frame reports it (`--strict` fails).

import { useId, type CSSProperties, type ReactNode } from 'react';
import { canvasEnvironment } from '@kinetograph/compat/shim';
import { Layer } from '@kinetograph/react';
import {
  createCanvasContext,
  createWebGLContext,
  layerPicture,
  type CanvasContext2D,
  type CanvasPass,
  type GlslPass,
  type WebGLContext,
} from '@kinetograph/scene';
import type { EffectDescriptor, EffectsOutputSize, EffectsProp } from './effects.js';
import { reportUnsupported } from './unsupported.js';
import { warnOnce } from './warn.js';

/** Whether a descriptor is disabled (Remotion bypasses it before the chain runs). */
function isDisabled(effect: EffectDescriptor<unknown>): boolean {
  return (effect.params as { disabled?: boolean } | undefined)?.disabled === true;
}

/** The effects of `effects` that are not disabled, in order. */
export function enabledEffects(effects: EffectsProp | undefined): EffectDescriptor<unknown>[] {
  return (effects ?? []).filter((effect) => !isDisabled(effect));
}

/** Thrown by a context request for WebGPU, which has no recording. The chain catches it and draws without the stage. */
class BackendUnsupported extends Error {
  override name = 'BackendUnsupported';
}

const GL_TYPE = /^(experimental-)?webgl2?$/;

/**
 * The canvas an effect (or `onPaint`) draws on: a recorder. Its first `getContext` decides what it is for good, as in a
 * browser: `2d` records commands, `webgl2` (or `webgl`) records the GL calls.
 */
export class RecordingCanvas {
  private context: CanvasContext2D | WebGLContext | null = null;
  private kind: string | null = null;

  constructor(
    public width: number,
    public height: number,
  ) {}

  getContext(type: string, attributes?: Record<string, unknown>): CanvasContext2D | WebGLContext | null {
    if (type === 'webgpu') throw new BackendUnsupported('a WebGPU context');
    const gl = GL_TYPE.test(type);
    if (type !== '2d' && !gl) return null;
    const kind = gl ? (type.endsWith('2') ? 'webgl2' : 'webgl') : '2d';
    if (this.context !== null) return this.kind === kind ? this.context : null;
    const size = (): { width: number; height: number } => ({ width: this.width, height: this.height });
    if (gl) {
      // The canvases of Remotion's pool are made like this, and upload with UNPACK_PREMULTIPLY_ALPHA_WEBGL set.
      const context = createWebGLContext({
        size,
        canvas: this,
        version: kind === 'webgl2' ? 2 : 1,
        attributes: { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, ...attributes },
      });
      (context as unknown as { pixelStorei(name: number, value: boolean): void }).pixelStorei(0x9241, true);
      this.context = context;
    } else {
      this.context = createCanvasContext({ size, canvas: this, ...canvasEnvironment() });
    }
    this.kind = kind;
    return this.context;
  }

  /** What was drawn, as the pass of a group: a canvas pass for a 2D context, a GLSL pass for a WebGL one, empty for none. */
  pass(): { glsl?: GlslPass; canvas?: CanvasPass } {
    const { width, height } = this;
    if (this.context === null) return { glsl: { width, height } };
    if (this.kind === '2d') return { canvas: { width, height, commands: (this.context as CanvasContext2D).commands } };
    return { glsl: { width, height, ...(this.context as WebGLContext).content() } };
  }
}

/** What an effect's `source` is: the picture of the layer before it. */
export type EffectSource = { readonly width: number; readonly height: number };

type Pass = { glsl?: GlslPass; canvas?: CanvasPass };

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

/** Runs one effect on a fresh canvas and returns the pass it drew, or null for a stage that asked for WebGPU. */
function runEffect(effect: EffectDescriptor<unknown>, source: EffectSource, width: number, height: number): Pass | null {
  const { definition, params } = effect;
  if (typeof definition?.apply !== 'function' || typeof definition.setup !== 'function' || typeof definition.cleanup !== 'function') {
    throw new TypeError('An item of `effects` is not an effect: make one with an effect function such as the ones createEffect() returns.');
  }
  const target = new RecordingCanvas(width, height);
  try {
    const state = definition.setup(target);
    try {
      // Every picture here is a canvas as the DOM holds it (row 0 on top), which is what `flipSourceY` says to a WebGL effect.
      definition.apply({ source: source as never, target, state, params, width, height, gpuDevice: null, flipSourceY: true });
    } finally {
      definition.cleanup(state);
    }
  } catch (error) {
    if (error instanceof BackendUnsupported) return null;
    throw error;
  }
  return target.pass();
}

/** The `HtmlInCanvas` stage that runs before the effects: `onInit`, then `onPaint`. */
export interface PaintStage {
  onPaint?: (params: PaintParams) => void | Promise<void>;
  onInit?: (params: PaintParams) => (() => void) | Promise<() => void>;
}

export interface PaintParams {
  readonly canvas: RecordingCanvas;
  readonly element: unknown;
  readonly elementImage: unknown;
  readonly pixelDensity: number;
}

/** The size of the element for `onPaint`'s `element`: the few fields of an `HTMLElement` that say how big it is. */
function elementOf(width: number, height: number): unknown {
  return {
    clientWidth: width,
    clientHeight: height,
    offsetWidth: width,
    offsetHeight: height,
    getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height }),
  };
}

/**
 * Runs `onInit` and then `onPaint` of an `<HtmlInCanvas>` on a fresh canvas, handing them the picture of the element,
 * and returns the pass they drew; then the cleanup `onInit` returned is called, as it is when the element goes. With
 * no `onPaint` the picture is drawn on a 2D context, as Remotion's default does. Null when a stage asks for WebGPU.
 *
 * A browser runs these between frames, here it is part of the frame: a function that is `async` records what it draws
 * before its first `await`, and a promise it returns is not waited for.
 */
function runPaint(
  component: string,
  stage: PaintStage,
  picture: EffectSource,
  size: { width: number; height: number; cssWidth: number; cssHeight: number; pixelDensity: number },
): Pass | null {
  const canvas = new RecordingCanvas(size.width, size.height);
  // The picture of the element is closed by `onPaint` in a browser; here there is nothing to release.
  const elementImage = Object.assign(picture, { close: () => undefined });
  const params: PaintParams = { canvas, element: elementOf(size.cssWidth, size.cssHeight), elementImage, pixelDensity: size.pixelDensity };
  const later = (name: string, result: PromiseLike<unknown>): void => {
    warnOnce(
      `${component}.async.${name}`,
      `${component} ${name} returned a promise: a frame is drawn from what ${name} did before its first await, and the rest is not waited for.`,
    );
    result.then(undefined, (error) => console.warn(`${component} ${name} failed after the frame was read: ${error instanceof Error ? error.message : String(error)}`));
  };
  let cleanup: (() => void) | undefined;
  try {
    if (stage.onInit !== undefined) {
      const result = stage.onInit(params);
      if (isThenable(result)) {
        later('onInit', result);
        result.then((done) => (typeof done === 'function' ? done() : undefined), () => undefined);
      } else if (typeof result === 'function') {
        cleanup = result;
      } else {
        throw new Error('HtmlInCanvas: when `onInit` is provided, it must return a cleanup function, or a Promise that resolves to one.');
      }
    }
    if (stage.onPaint !== undefined) {
      const result = stage.onPaint(params);
      if (isThenable(result)) later('onPaint', result);
    } else {
      const context = canvas.getContext('2d') as CanvasContext2D | null;
      if (context === null) throw new Error('Failed to acquire 2D context for <HtmlInCanvas> canvas');
      context.reset();
      context.drawElementImage(elementImage, 0, 0);
    }
  } catch (error) {
    if (!(error instanceof BackendUnsupported)) throw error;
    warnOnce(
      `${component}.paint.webgpu`,
      `${component} draws without onInit and onPaint: they ask for ${error.message}, and Kinetograph has no WebGPU. A '2d', 'webgl2' or 'webgl' context works.`,
    );
    reportUnsupported(component.replace(/^<|>$/g, ''), 'onPaint', 'webgpu', 'onInit and onPaint draw on a WebGPU context; the children are drawn without them');
    return null;
  } finally {
    cleanup?.();
  }
  return canvas.pass();
}

export interface EffectChainOptions {
  /** `<Solid>`, `<CanvasImage>`, ...: what the messages call the component. */
  component: string;
  effects: EffectsProp | undefined;
  effectsOutputSize: EffectsOutputSize | null | undefined;
  /** The element's size in CSS pixels. */
  width: number;
  height: number;
  pixelDensity: number | undefined;
  paint?: PaintStage;
}

export interface EffectChain {
  /** Whether anything runs: with false, draw the element as without effects. */
  readonly active: boolean;
  /** The size of every canvas of the chain, in pixels. */
  readonly width: number;
  readonly height: number;
  /** The layers of the chain over `source`, which has to be drawn `width` x `height`, at the origin. Call once. */
  render(source: ReactNode): ReactNode;
}

/** Remotion's `validateDimension`. */
function validateDimension(amount: unknown, name: string): void {
  const where = 'on an effect-capable component';
  if (typeof amount !== 'number') throw new Error(`The "${name}" prop ${where} must be a number, but you passed a value of type ${typeof amount}`);
  if (Number.isNaN(amount)) throw new TypeError(`The "${name}" prop ${where} must not be NaN, but is NaN.`);
  if (!Number.isFinite(amount)) throw new TypeError(`The "${name}" prop ${where} must be finite, but is ${amount}.`);
  if (amount % 1 !== 0) throw new TypeError(`The "${name}" prop ${where} must be an integer, but is ${amount}.`);
  if (amount <= 0) throw new TypeError(`The "${name}" prop ${where} must be positive, but got ${amount}.`);
}

export function useEffectChain(options: EffectChainOptions): EffectChain {
  const { component, effects, effectsOutputSize, width: cssWidth, height: cssHeight, pixelDensity = 1, paint } = options;
  const base = `fx${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  if (effectsOutputSize) {
    validateDimension(effectsOutputSize.width, 'effectsOutputSize.width');
    validateDimension(effectsOutputSize.height, 'effectsOutputSize.height');
  }
  const width = effectsOutputSize?.width ?? Math.ceil(cssWidth * pixelDensity);
  const height = effectsOutputSize?.height ?? Math.ceil(cssHeight * pixelDensity);

  const enabled = enabledEffects(effects);
  const runnable = enabled.filter((effect) => effect.definition.backend !== 'webgpu');
  const skipped = enabled.filter((effect) => effect.definition.backend === 'webgpu');
  const reportSkipped = (labels: string[], what: string): void => {
    const names = labels.join(', ');
    warnOnce(
      `${component}.effects.webgpu`,
      `${component} draws without ${what} (${names}): it draws on a WebGPU device, which Kinetograph does not have. Effects with the 'webgl2' or '2d' backend run.`,
    );
    reportUnsupported(component.replace(/^<|>$/g, ''), 'effects', names, 'a WebGPU effect draws on a browser GPU device; the picture is drawn without it');
  };
  if (skipped.length > 0) reportSkipped(skipped.map((effect) => effect.definition.label), 'its WebGPU effects');

  const active = runnable.length > 0 || paint !== undefined;

  const render = (source: ReactNode): ReactNode => {
    const sourceId = `${base}-src`;
    let node: ReactNode = <Layer id={sourceId}>{source}</Layer>;
    let before = sourceId;
    let count = 0;
    const stack = (pass: Pass): void => {
      const id = `${base}-${count++}`;
      node = (
        <Layer id={id} {...pass}>
          {node}
        </Layer>
      );
      before = id;
    };
    if (paint !== undefined) {
      const painted = runPaint(component, paint, layerPicture(before, width, height), { width, height, cssWidth, cssHeight, pixelDensity });
      if (painted !== null) stack(painted);
    }
    for (const effect of runnable) {
      const pass = runEffect(effect, layerPicture(before, width, height), width, height);
      if (pass === null) {
        reportSkipped([effect.definition.label], 'a WebGPU effect');
        continue;
      }
      stack(pass);
    }
    return node;
  };
  return { active, width, height, render };
}

/** The box a chain's picture is shown in: `style` over the size, clipped to it as a canvas is. */
export function effectBoxStyle(width: number, height: number, style: CSSProperties | undefined): CSSProperties {
  // Positioned, so that the native layers of the chain lie at its corner.
  return { position: 'relative', width, height, overflow: 'hidden', ...style };
}

/** Scales the chain's pixels to the CSS box: nothing when they are the same size (the usual case). */
export function scaledToBox(chain: EffectChain, cssWidth: number, cssHeight: number, layers: ReactNode): ReactNode {
  if (chain.width === cssWidth && chain.height === cssHeight) return layers;
  return <div style={{ position: 'relative', width: chain.width, height: chain.height, transform: `scale(${cssWidth / chain.width}, ${cssHeight / chain.height})`, transformOrigin: '0 0' }}>{layers}</div>;
}
