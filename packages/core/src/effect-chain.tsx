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
//
// A script may read the pixels of the picture it is given (`ctx.drawImage(source)`, then `getImageData`): the tile effect,
// the 2D brightness and contrast, the outline's polygons. Those pixels are made by the renderer from the layer `source`
// is the picture of, and that layer is in a tree that is not committed while the effect runs. So the effect is run, the
// read finds the layer unknown (`LayerPicturesNotReady`), the stage waits (`delayRender`) and draws nothing for now, and after
// the commit the layer is emitted from the tree as it stands, kept for the frame (`Reader`), and the stage is run
// again; the read then hands the layer to the addon with the commands (`renderCanvas`), which draws it as the child of a
// canvas pass, as the frame will. Only the pixels a script reads come back to JS. What is kept is a function of the
// frame's tree, which is checked at each commit: a tree that changed after the read (an earlier stage that finished, data
// that arrived) is emitted and read again.

import { createContext, useContext, useEffect, useId, useReducer, useRef, type CSSProperties, type ReactNode } from 'react';
import { canvasEnvironment, LayerPicturesNotReady, rasterizeCanvas, setLayerPictures, webgpuDeviceInfo, type LayerPictures } from '@kinetographdev/compat/shim';
import { emitLayerOf, Layer, TimelineContext, type EmittedLayer } from '@kinetographdev/react';
import {
  createCanvasContext,
  createGpuCanvasContext,
  createWebGLContext,
  GPUDeviceShim,
  internSources,
  layerPicture,
  type CanvasContext2D,
  type CanvasPass,
  type GPUCanvasContextShim,
  type GlslPass,
  WebGpuUnsupportedError,
  type WebGLContext,
} from '@kinetographdev/scene';
import { continueRender, delayRender } from './assets.js';
import type { Backend, EffectDefinition, EffectDescriptor, EffectImplementation, EffectsOutputSize, EffectsProp } from './effects.js';
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

  /** `canvas.ownerDocument`: effects make their helper canvases with `target.ownerDocument.createElement('canvas')`. */
  get ownerDocument(): unknown {
    return (globalThis as { document?: unknown }).document;
  }

  /** The recording device of a WebGPU effect (`gpuDevice` of `apply`): one for the canvas, made on first use. */
  gpuDevice(): GPUDeviceShim {
    return (this.device ??= new GPUDeviceShim({ rasterize: rasterizeCanvas, info: webgpuDeviceInfo }));
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
        // A texture made of a canvas (the outline's polygon mask) is the canvas drawn by the addon.
        rasterize: rasterizeCanvas,
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
    if (this.kind === '2d') {
      const { commands, sources } = internSources((this.context as CanvasContext2D).commands);
      return { canvas: { width, height, commands, ...(sources !== undefined && { sources }) } };
    }
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

/**
 * What a stage drew: its pass, a request for WebGPU (drawn without), the message of a promise that rejected (drawn
 * without), or that it waits for the picture of a layer it reads (run again once the layer is known).
 */
type Outcome = { pass: Pass } | { webgpu: true } | { failed: string } | { waiting: true };
/** A stage whose function returned a promise: what it has recorded so far, and its outcome once the promise settles. */
type Pending = { pending: Promise<Outcome>; partial: Pass };

function outcomeOfError(error: unknown): Outcome {
  if (error instanceof WebGpuUnsupportedError) return { webgpu: true };
  if (error instanceof LayerPicturesNotReady) return { waiting: true };
  return { failed: error instanceof Error ? error.message : String(error) };
}

/** The order `auto` tries an effect's backends in: Remotion's. */
const AUTO_ORDER: readonly Backend[] = ['webgpu', 'webgl2', '2d'];

/** Remotion's `validatePreferredEffectBackend`, with its message. */
export function validatePreferredEffectBackend(value: unknown): Backend | 'auto' {
  if (value !== 'auto' && value !== 'webgpu' && value !== 'webgl2' && value !== '2d') {
    throw new TypeError(`preferredEffectBackend must be "auto", "webgpu", "webgl2" or "2d", got ${String(value)}`);
  }
  return value;
}

/** Remotion's `PreferredEffectBackendContext` (`Internals`): a provider sets the backend to try first for the effects below it. */
export const PreferredEffectBackendContext = createContext<Backend | 'auto' | null>(null);

/**
 * The backend to try first. `KINETOGRAPH_PREFERRED_EFFECT_BACKEND` is an override for the machine; else, as in Remotion, the
 * nearest `PreferredEffectBackendContext`, then `window.remotion_preferredEffectBackend` (what `--preferred-effect-backend`
 * sets), else `auto`.
 */
export function preferredEffectBackend(fromContext: Backend | 'auto' | null = null): Backend | 'auto' {
  const global = (globalThis as { window?: { remotion_preferredEffectBackend?: unknown } }).window?.remotion_preferredEffectBackend;
  return validatePreferredEffectBackend(process.env.KINETOGRAPH_PREFERRED_EFFECT_BACKEND ?? fromContext ?? global ?? 'auto');
}

/** The implementations of an effect in the order to try them: the preferred backend first, then the rest as `auto` has them. */
function implementationsOf(definition: EffectDefinition<unknown, unknown>, preferred: Backend | 'auto'): { backend: Backend; implementation: EffectImplementation<unknown, unknown> }[] {
  const all = definition.implementations ?? { [definition.backend]: definition };
  const order = preferred === 'auto' ? AUTO_ORDER : [preferred, ...AUTO_ORDER.filter((b) => b !== preferred)];
  return order.flatMap((backend) => (all[backend] === undefined ? [] : [{ backend, implementation: all[backend] as EffectImplementation<unknown, unknown> }]));
}

/** Runs one implementation of an effect on a fresh canvas. */
function runImplementation(
  effect: EffectDescriptor<unknown>,
  { backend, implementation }: { backend: Backend; implementation: EffectImplementation<unknown, unknown> },
  source: EffectSource,
  width: number,
  height: number,
): Outcome | Pending {
  const { params } = effect;
  const target = new RecordingCanvas(width, height);
  try {
    const state = implementation.setup(target);
    let result: unknown;
    try {
      // Every picture here is a canvas as the DOM holds it (row 0 on top), which is what `flipSourceY` says to a WebGL effect.
      result = implementation.apply({ source: source as never, target, state, params, width, height, gpuDevice: backend === 'webgpu' ? target.gpuDevice() : null, flipSourceY: backend !== 'webgpu' });
    } catch (error) {
      implementation.cleanup(state);
      throw error;
    }
    if (isThenable(result)) {
      const pending = Promise.resolve(result)
        .then((): Outcome => ({ pass: target.pass() }), outcomeOfError)
        .finally(() => implementation.cleanup(state))
        .catch(outcomeOfError);
      return { partial: target.pass(), pending };
    }
    implementation.cleanup(state);
  } catch (error) {
    if (error instanceof WebGpuUnsupportedError) return { webgpu: true };
    throw error;
  }
  return { pass: target.pass() };
}

/** Throws unless the item of `effects` is what `createEffect` returned. */
function assertEffect(effect: EffectDescriptor<unknown>): void {
  const { definition } = effect;
  if (typeof definition?.apply !== 'function' || typeof definition.setup !== 'function' || typeof definition.cleanup !== 'function') {
    throw new TypeError('An item of `effects` is not an effect: make one with an effect function such as the ones createEffect() returns.');
  }
}

/**
 * Runs one effect on a fresh canvas. An effect with several backends runs the one it prefers; one that can't draw
 * (a WebGPU call that isn't drawn, or an error) hands the frame to the next, and only the last one's failure is the effect's.
 */
function runEffect(effect: EffectDescriptor<unknown>, source: EffectSource, width: number, height: number, preferred: Backend | 'auto'): Outcome | Pending {
  const { definition } = effect;
  const candidates = implementationsOf(definition, preferred);
  const attempt = (index: number): Outcome | Pending => {
    const last = index === candidates.length - 1;
    let result: Outcome | Pending;
    try {
      result = runImplementation(effect, candidates[index]!, source, width, height);
    } catch (error) {
      // A read of a layer that is not known yet is not the backend's failure: the stage is run again, on the same one.
      if (error instanceof LayerPicturesNotReady) return { waiting: true };
      if (last) throw error;
      return fallback(index, error instanceof Error ? error.message : String(error), attempt);
    }
    if (last) return result;
    if ('pending' in result) {
      return {
        partial: result.partial,
        pending: result.pending.then((outcome) => {
          if (!('webgpu' in outcome) && !('failed' in outcome)) return outcome;
          const next = fallback(index, 'failed' in outcome ? outcome.failed : 'a WebGPU call that is not drawn', attempt);
          return 'pending' in next ? next.pending : next;
        }),
      };
    }
    return 'webgpu' in result ? fallback(index, 'a WebGPU call that is not drawn', attempt) : result;
  };
  const fallback = (index: number, why: string, again: (i: number) => Outcome | Pending): Outcome | Pending => {
    const from = candidates[index]!.backend;
    const to = candidates[index + 1]!.backend;
    warnOnce(`effect.${definition.type}.${from}`, `Effect "${definition.label}" can't draw with ${from} (${why}); it draws with ${to}.`);
    return again(index + 1);
  };
  return attempt(0);
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
    if (error instanceof LayerPicturesNotReady) return { waiting: true };
    throw error;
  }
  cleanup?.();
  return { pass: canvas.pass() };
}

/**
 * What a chain keeps for the scripts that read the pixels of its layers: the layers as they stand in the committed tree
 * (`emitLayerOf`), the ones asked for and not known yet, and the `delayRender` that holds the frame until they are.
 */
interface Reader {
  /** The host element of each layer of the chain, by id (set when the layer is committed), and the refs that set them. */
  hosts: Map<string, unknown>;
  refs: Map<string, (host: unknown) => void>;
  /** The layers served: their emitted tree and its JSON, to see that it changed. */
  pictures: Map<string, { emitted: EmittedLayer; json: string }>;
  /** The layers a script asked for that are not in `pictures`. */
  wanted: Set<string>;
  /** The layers that could not be found in the tree, with why. */
  missing: Map<string, string>;
  /** The open `delayRender` that holds the frame while `wanted` is not empty. */
  handle: number | null;
  /** True while the chain's stages run in a render: a read then needs no update to be committed. */
  rendering: boolean;
  /** Moves on when what is served changes: a stage that read it is read again. */
  version: number;
  /** How many times what is served changed in a frame: a tree that never settles is not followed forever. */
  refreshes: number;
  /** The frame, as the scene draws it, and the label the hold carries. */
  frame: number;
  fps: number;
  durationInFrames: number;
  label: string;
  /** Schedules a render (and so a commit and its effects). */
  poke: () => void;
}

/** The chain each layer id belongs to: how a read of `layerPicture(id)` finds the tree it is in. */
const readers = new Map<string, Reader>();
/** How many reads were answered: a stage that read one is kept for the version it read. */
let served = 0;
/** A tree that changes after every read is followed this many times a frame, then taken as it is. */
const MAX_REFRESHES = 4;

/** Asks for the layers of a chain: an `ids` read of `layerPicture`, from `getImageData` of a canvas that drew them. */
function layerPicturesOf(ids: readonly string[]): LayerPictures {
  const layers: LayerPictures['layers'] = [];
  const waiting: string[] = [];
  let first: Reader | undefined;
  let camera: unknown = null;
  let margin: number | undefined;
  let blendSpace: 'srgb' | undefined;
  for (const id of ids) {
    const reader = readers.get(id);
    if (reader === undefined) throw new Error(`getImageData of the picture of the layer "${id}": no effect has it, so there is nothing to read`);
    first ??= reader;
    const reason = reader.missing.get(id);
    if (reason !== undefined) throw new Error(`getImageData of the picture of the layer "${id}": ${reason}`);
    const picture = reader.pictures.get(id);
    if (picture === undefined) {
      waiting.push(id);
      reader.wanted.add(id);
      if (reader.handle === null) {
        reader.handle = delayRender(reader.label);
        // Out of a render (an effect that reads after an await) nothing commits unless one is asked for.
        if (!reader.rendering) reader.poke();
      }
      continue;
    }
    for (const layer of picture.emitted.layers) if (!layers.some((l) => l.id === layer.id)) layers.push(layer);
    camera ??= picture.emitted.camera;
    margin = Math.max(margin ?? 0, picture.emitted.margin ?? 0) || undefined;
    blendSpace ??= picture.emitted.blendSpace;
  }
  if (waiting.length > 0) throw new LayerPicturesNotReady(waiting);
  served += 1;
  const { frame, fps, durationInFrames } = first!;
  return { layers, frame, fps, durationInFrames, ...(camera !== null && { camera }), ...(margin !== undefined && { margin }), ...(blendSpace !== undefined && { blendSpace }) };
}

setLayerPictures(layerPicturesOf);

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
    warnOnce(`${component}.effects.webgpu`, `${component} draws without ${what} (${names}): it makes a WebGPU call that is not drawn (see /docs/compat/, "WebGPU").`);
    reportUnsupported(component.replace(/^<|>$/g, ''), 'effects', names, 'a WebGPU effect makes a call that is not drawn; the picture is drawn without it');
  };

  const active = runnable.length > 0 || paint !== undefined;

  // The outcome of each async stage of the frame being rendered, kept so the render that follows the promise's settling
  // draws it instead of running the stage again. A new frame (or other effects, or size) starts empty.
  const timeline = useContext(TimelineContext);
  const contextBackend = useContext(PreferredEffectBackendContext);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const kept = useRef<{ key: string; stages: Map<number, Outcome | Pending>; readAt: Map<number, number> } | null>(null);
  const key = `${timeline?.frame ?? 0}|${runnable.map((effect) => effect.effectKey).join(',')}|${width}x${height}|${pixelDensity}`;
  const readerRef = useRef<Reader | null>(null);
  const reader = (readerRef.current ??= {
    hosts: new Map(),
    refs: new Map(),
    pictures: new Map(),
    wanted: new Set(),
    missing: new Map(),
    handle: null,
    rendering: false,
    version: 0,
    refreshes: 0,
    frame: 0,
    fps: 30,
    durationInFrames: 1,
    label: '',
    poke: () => undefined,
  });
  reader.poke = rerender;
  reader.label = `${component} reading the pixels of its picture`;
  reader.frame = Math.max(0, Math.floor(timeline?.absoluteFrame ?? 0));
  reader.fps = timeline?.config.fps ?? 30;
  reader.durationInFrames = timeline?.config.durationInFrames ?? 1;
  if (kept.current === null || kept.current.key !== key) {
    kept.current = { key, stages: new Map(), readAt: new Map() };
    // What was served was the tree of another frame (or other effects).
    reader.pictures.clear();
    reader.missing.clear();
    reader.version += 1;
    reader.refreshes = 0;
  }
  const { stages, readAt } = kept.current;
  const outcomeOf = (stage: number, what: string, run: () => Outcome | Pending): Exclude<Outcome, { waiting: true }> => {
    const known = stages.get(stage);
    // A stage that read pixels is read again when what it read changed.
    if (known !== undefined && (readAt.get(stage) ?? reader.version) === reader.version) return 'pending' in known ? { pass: known.partial } : (known as Exclude<Outcome, { waiting: true }>);
    const before = served;
    const result = run();
    // It reads a layer that is not known yet: nothing is drawn for now, and it is run again once the layer is served.
    if ('waiting' in result) return { pass: { glsl: { width, height } } };
    if (!('pending' in result)) {
      if (served !== before) {
        stages.set(stage, result);
        readAt.set(stage, reader.version);
      }
      return result;
    }
    stages.set(stage, result);
    readAt.delete(stage);
    const handle = delayRender(`${component} ${what}`);
    void result.pending.then((outcome) => {
      if ('waiting' in outcome) stages.delete(stage);
      else stages.set(stage, outcome);
      rerender();
      continueRender(handle);
    });
    return { pass: result.partial };
  };

  // After the commit, the layers a script asked for are in the tree: emit them and serve them (see the header).
  useEffect(() => {
    if (reader.pictures.size === 0 && reader.wanted.size === 0) return;
    let changed = false;
    for (const id of new Set([...reader.wanted, ...reader.pictures.keys()])) {
      const asked = reader.wanted.has(id);
      if (!asked && reader.refreshes >= MAX_REFRESHES) continue;
      const host = reader.hosts.get(id);
      let emitted: EmittedLayer | null = null;
      let why = 'its layer is not in the tree';
      if (host !== undefined) {
        try {
          emitted = emitLayerOf(host);
        } catch (error) {
          why = `its layer could not be drawn (${error instanceof Error ? error.message : String(error)})`;
        }
      }
      if (emitted === null || !emitted.layers.some((layer) => layer.id === id)) {
        reader.pictures.delete(id);
        reader.missing.set(id, why);
        changed = true;
        continue;
      }
      const json = JSON.stringify(emitted);
      if (reader.pictures.get(id)?.json === json) continue;
      reader.pictures.set(id, { emitted, json });
      if (!asked) reader.refreshes += 1;
      changed = true;
    }
    reader.wanted.clear();
    if (changed) {
      reader.version += 1;
      rerender();
    }
    if (reader.handle !== null) {
      continueRender(reader.handle);
      reader.handle = null;
    }
  });
  useEffect(
    () => () => {
      for (const [id, owner] of readers) if (owner === reader) readers.delete(id);
      if (reader.handle !== null) continueRender(reader.handle);
      reader.handle = null;
    },
    [reader],
  );
  const reportFailed = (message: string, what: string, property: string): void => {
    warnOnce(`${component}.failed.${what}`, `${component} ${what} failed: ${message}. The picture is drawn without it.`);
    reportUnsupported(component.replace(/^<|>$/g, ''), property, 'error', `${what} threw, or returned a promise that rejected (${message}); the picture is drawn without it`);
  };

  /** A layer of the chain: found by its id for a script that reads its picture, and committed with a ref to its element. */
  const known = (id: string): ((host: unknown) => void) => {
    readers.set(id, reader);
    let ref = reader.refs.get(id);
    if (ref === undefined) {
      ref = (host: unknown) => {
        if (host === null || host === undefined) reader.hosts.delete(id);
        else reader.hosts.set(id, host);
      };
      reader.refs.set(id, ref);
    }
    return ref;
  };

  const render = (source: ReactNode): ReactNode => {
    const sourceId = `${base}-src`;
    reader.rendering = true;
    let node: ReactNode = (
      <Layer id={sourceId} ref={known(sourceId)}>
        {source}
      </Layer>
    );
    let before = sourceId;
    let count = 0;
    const stack = (pass: Pass): void => {
      const id = `${base}-${count++}`;
      node = (
        <Layer id={id} ref={known(id)} {...pass}>
          {node}
        </Layer>
      );
      before = id;
    };
    if (paint !== undefined) {
      const outcome = outcomeOf(0, 'onInit/onPaint', () => runPaint(paint, layerPicture(before, width, height), { width, height, cssWidth, cssHeight, pixelDensity }));
      if ('pass' in outcome) stack(outcome.pass);
      else if ('webgpu' in outcome) {
        warnOnce(`${component}.paint.webgpu`, `${component} draws without onInit and onPaint: they make a WebGPU call that is not drawn (see /docs/compat/, "WebGPU").`);
        reportUnsupported(component.replace(/^<|>$/g, ''), 'onPaint', 'webgpu', 'onInit and onPaint make a WebGPU call that is not drawn; the children are drawn without them');
      } else reportFailed(outcome.failed, 'onInit/onPaint', 'onPaint');
    }
    runnable.forEach((effect, index) => {
      // An effect that throws is drawn without, with the message reported for the frame (`--strict` fails on it).
      const outcome = outcomeOf(index + 1, `effect "${effect.definition.label}"`, () => {
        assertEffect(effect);
        // A setting that is not a backend is the project's mistake, not the effect's: it stops the frame.
        const preferred = preferredEffectBackend(contextBackend);
        try {
          return runEffect(effect, layerPicture(before, width, height), width, height, preferred);
        } catch (error) {
          return outcomeOfError(error);
        }
      });
      if ('pass' in outcome) stack(outcome.pass);
      else if ('webgpu' in outcome) reportSkipped([effect.definition.label], 'a WebGPU effect');
      else reportFailed(outcome.failed, `effect "${effect.definition.label}"`, 'effects');
    });
    reader.rendering = false;
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
