// Remotion's effect chain (`runEffectChain`) on recording canvases. In a browser each effect draws the picture of the
// canvas before it onto the next canvas, with a 2D or WebGL 2 context, and the last canvas replaces the element's
// picture. Here the pictures are layers and the canvases record (packages/cli/skills/kinetograph/references/SCENE.md, "Shader groups" and "Canvas passes"):
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
// A `webgpu` effect runs the same way over a recording canvas: its device is a recording one, the picture of the layer
// before it is a source for `queue.copyExternalImageToTexture`, and the passes it submits are the `webgpu` part of the
// group's `glsl` pass.
//
// A stage may be `async` (an effect's `apply`, `onInit`, `onPaint`): the frame is held with `delayRender` until the
// promise settles, the way the HyperFrames runtime holds it for `hf-seek`, and the stage's result is kept for the frame
// so the render that follows draws what it recorded. A rejection is reported for the frame and the stage is drawn without.

import { useContext, useId, useReducer, useRef, type CSSProperties, type ReactNode } from 'react';
import { canvasEnvironment, rasterizeCanvas } from '@kinetographdev/compat/shim';
import { Layer, TimelineContext } from '@kinetographdev/react';
import {
  createCanvasContext,
  createGpuCanvasContext,
  createWebGLContext,
  GPUDeviceShim,
  layerPicture,
  type CanvasContext2D,
  type CanvasPass,
  type GPUCanvasContextShim,
  type GlslPass,
  WebGpuUnsupportedError,
  type WebGLContext,
} from '@kinetographdev/scene';
import { continueRender, delayRender } from './assets.js';
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

const GL_TYPE = /^(experimental-)?webgl2?$/;

/**
 * The canvas an effect (or `onPaint`) draws on: a recorder. Its first `getContext` decides what it is for good, as in a
 * browser: `2d` records commands, `webgl2` (or `webgl`) records the GL calls.
 */
export class RecordingCanvas {
  private context: CanvasContext2D | WebGLContext | GPUCanvasContextShim | null = null;
  private kind: string | null = null;
  private device: GPUDeviceShim | null = null;

  constructor(
    public width: number,
    public height: number,
  ) {}

  /** The recording device of a WebGPU effect (`gpuDevice` of `apply`): one for the canvas, made on first use. */
  gpuDevice(): GPUDeviceShim {
    return (this.device ??= new GPUDeviceShim({ rasterize: rasterizeCanvas }));
  }

  getContext(type: string, attributes?: Record<string, unknown>): CanvasContext2D | WebGLContext | GPUCanvasContextShim | null {
    if (type === 'webgpu') {
      if (this.context !== null) return this.kind === 'webgpu' ? this.context : null;
      this.context = createGpuCanvasContext({ size: () => ({ width: this.width, height: this.height }), canvas: this });
      this.kind = 'webgpu';
      return this.context;
    }
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
    if (this.kind === 'webgpu') return { glsl: { width, height, ...(this.context as GPUCanvasContextShim).content() } };
    return { glsl: { width, height, ...(this.context as WebGLContext).content() } };
  }
}

/** What an effect's `source` is: the picture of the layer before it. */
export type EffectSource = { readonly width: number; readonly height: number };

type Pass = { glsl?: GlslPass; canvas?: CanvasPass };

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

/** What a stage drew: its pass, a request for WebGPU (drawn without), or the message of a promise that rejected (drawn without). */
type Outcome = { pass: Pass } | { webgpu: true } | { failed: string };
/** A stage whose function returned a promise: what it has recorded so far, and its outcome once the promise settles. */
type Pending = { pending: Promise<Outcome>; partial: Pass };

function outcomeOfError(error: unknown): Outcome {
  if (error instanceof WebGpuUnsupportedError) return { webgpu: true };
  return { failed: error instanceof Error ? error.message : String(error) };
}

/** Runs one effect on a fresh canvas. */
function runEffect(effect: EffectDescriptor<unknown>, source: EffectSource, width: number, height: number): Outcome | Pending {
  const { definition, params } = effect;
  if (typeof definition?.apply !== 'function' || typeof definition.setup !== 'function' || typeof definition.cleanup !== 'function') {
    throw new TypeError('An item of `effects` is not an effect: make one with an effect function such as the ones createEffect() returns.');
  }
  const target = new RecordingCanvas(width, height);
  try {
    const state = definition.setup(target);
    let result: unknown;
    try {
      // Every picture here is a canvas as the DOM holds it (row 0 on top), which is what `flipSourceY` says to a WebGL effect.
      result = definition.apply({ source: source as never, target, state, params, width, height, gpuDevice: definition.backend === 'webgpu' ? target.gpuDevice() : null, flipSourceY: definition.backend !== 'webgpu' });
    } catch (error) {
      definition.cleanup(state);
      throw error;
    }
    if (isThenable(result)) {
      const pending = Promise.resolve(result)
        .then((): Outcome => ({ pass: target.pass() }), outcomeOfError)
        .finally(() => definition.cleanup(state))
        .catch(outcomeOfError);
      return { partial: target.pass(), pending };
    }
    definition.cleanup(state);
  } catch (error) {
    if (error instanceof WebGpuUnsupportedError) return { webgpu: true };
    throw error;
  }
  return { pass: target.pass() };
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
 * no `onPaint` the picture is drawn on a 2D context, as Remotion's default does. A stage that asks for WebGPU is
 * `webgpu`. A browser runs these between frames, here they are part of the frame: when one returns a promise, `onPaint`
 * waits for `onInit`'s, the cleanup for `onPaint`'s, and the frame for them all (the caller holds it).
 */
function runPaint(
  stage: PaintStage,
  picture: EffectSource,
  size: { width: number; height: number; cssWidth: number; cssHeight: number; pixelDensity: number },
): Outcome | Pending {
  const canvas = new RecordingCanvas(size.width, size.height);
  // The picture of the element is closed by `onPaint` in a browser; here there is nothing to release.
  const elementImage = Object.assign(picture, { close: () => undefined });
  const params: PaintParams = { canvas, element: elementOf(size.cssWidth, size.cssHeight), elementImage, pixelDensity: size.pixelDensity };
  let cleanup: (() => void) | undefined;
  const keepCleanup = (result: unknown): void => {
    if (typeof result !== 'function') throw new Error('HtmlInCanvas: when `onInit` is provided, it must return a cleanup function, or a Promise that resolves to one.');
    cleanup = result as () => void;
  };
  const paint = (): unknown => {
    if (stage.onPaint !== undefined) return stage.onPaint(params);
    const context = canvas.getContext('2d') as CanvasContext2D | null;
    if (context === null) throw new Error('Failed to acquire 2D context for <HtmlInCanvas> canvas');
    context.reset();
    context.drawElementImage(elementImage, 0, 0);
    return undefined;
  };
  const later = (work: Promise<unknown>): Pending => ({
    partial: canvas.pass(),
    pending: work
      .then((): Outcome => ({ pass: canvas.pass() }), outcomeOfError)
      .finally(() => cleanup?.())
      .catch(outcomeOfError),
  });
  try {
    if (stage.onInit !== undefined) {
      const init = stage.onInit(params) as unknown;
      if (isThenable(init)) {
        return later(
          Promise.resolve(init).then((done) => {
            keepCleanup(done);
            return paint();
          }),
        );
      }
      keepCleanup(init);
    }
    const result = paint();
    if (isThenable(result)) return later(Promise.resolve(result));
  } catch (error) {
    cleanup?.();
    if (error instanceof WebGpuUnsupportedError) return { webgpu: true };
    throw error;
  }
  cleanup?.();
  return { pass: canvas.pass() };
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
  const runnable = enabled;
  const reportSkipped = (labels: string[], what: string): void => {
    const names = labels.join(', ');
    warnOnce(`${component}.effects.webgpu`, `${component} draws without ${what} (${names}): it makes a WebGPU call that is not drawn (see /docs/known-issues/, "WebGPU").`);
    reportUnsupported(component.replace(/^<|>$/g, ''), 'effects', names, 'a WebGPU effect makes a call that is not drawn; the picture is drawn without it');
  };

  const active = runnable.length > 0 || paint !== undefined;

  // The outcome of each async stage of the frame being rendered, kept so the render that follows the promise's settling
  // draws it instead of running the stage again. A new frame (or other effects, or size) starts empty.
  const timeline = useContext(TimelineContext);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const kept = useRef<{ key: string; stages: Map<number, Outcome | Pending> } | null>(null);
  const key = `${timeline?.frame ?? 0}|${runnable.map((effect) => effect.effectKey).join(',')}|${width}x${height}|${pixelDensity}`;
  if (kept.current === null || kept.current.key !== key) kept.current = { key, stages: new Map() };
  const stages = kept.current.stages;
  const outcomeOf = (stage: number, what: string, run: () => Outcome | Pending): Outcome => {
    const known = stages.get(stage);
    if (known !== undefined) return 'pending' in known ? { pass: known.partial } : known;
    const result = run();
    if (!('pending' in result)) return result;
    stages.set(stage, result);
    const handle = delayRender(`${component} ${what}`);
    void result.pending.then((outcome) => {
      stages.set(stage, outcome);
      rerender();
      continueRender(handle);
    });
    return { pass: result.partial };
  };
  const reportFailed = (message: string, what: string, property: string): void => {
    warnOnce(`${component}.async.${what}`, `${component} ${what} rejected: ${message}. The picture is drawn without it.`);
    reportUnsupported(component.replace(/^<|>$/g, ''), property, 'async', `${what} returned a promise that rejected (${message}); the picture is drawn without it`);
  };

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
      const outcome = outcomeOf(0, 'onInit/onPaint', () => runPaint(paint, layerPicture(before, width, height), { width, height, cssWidth, cssHeight, pixelDensity }));
      if ('pass' in outcome) stack(outcome.pass);
      else if ('webgpu' in outcome) {
        warnOnce(`${component}.paint.webgpu`, `${component} draws without onInit and onPaint: they make a WebGPU call that is not drawn (see /docs/known-issues/, "WebGPU").`);
        reportUnsupported(component.replace(/^<|>$/g, ''), 'onPaint', 'webgpu', 'onInit and onPaint make a WebGPU call that is not drawn; the children are drawn without them');
      } else reportFailed(outcome.failed, 'onInit/onPaint', 'onPaint');
    }
    runnable.forEach((effect, index) => {
      const outcome = outcomeOf(index + 1, `effect "${effect.definition.label}"`, () => runEffect(effect, layerPicture(before, width, height), width, height));
      if ('pass' in outcome) stack(outcome.pass);
      else if ('webgpu' in outcome) reportSkipped([effect.definition.label], 'a WebGPU effect');
      else reportFailed(outcome.failed, `effect "${effect.definition.label}"`, 'effects');
    });
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
