// WebGPU through Dawn (Chrome's WebGPU library, the `webgpu` package's dawn.node), behind KINETOGRAPH_WEBGPU=dawn.
//
// The page gets Dawn's real GPUAdapter, GPUDevice, GPUBuffer, GPUTexture, ... objects. This file adds what dawn.node has no
// notion of (it has no canvas) and what the engine's rules ask of it:
//   - a canvas context: `configure`, `getCurrentTexture` (an offscreen texture of the canvas's size), and the pixels of
//     that texture read back at the end of a frame that is read (`flushDawnCanvases`) and handed to the addon as bytes
//     (`putCanvasPixels`), which the painter takes as they are;
//   - a fixed adapter: the WebGPU default limits and a fixed feature list on every machine, no `timestamp-query`;
//   - errors: an uncaptured error or a lost device becomes a frame warning (`takeDawnReports`), so `--strict` fails;
//   - the frame waits for the library's own promises (`requestDevice`, `mapAsync`, ...), which settle in real time;
//   - `copyExternalImageToTexture` from the engine's pictures (an image, a canvas, a video frame);
//   - what a frame read that an earlier frame wrote (`webgpu-dawn-carry.ts`), for the frame loop's replay.
//
// Nothing here reads the wall clock for a picture. Devices are destroyed by `releaseDawn` (a new scene, a disposed renderer).

import { createRequire } from 'node:module';
import { threadId } from 'node:worker_threads';
import { CANVAS_SOURCE, type CanvasCommand, type CanvasSource } from '@kinetographdev/scene';
import { addonFunction, hasAddonFunction } from '../addon.js';
import { lap, stamp } from '../profile.js';
import { trackCarry, carryDepends, startsCleared, untracked } from './webgpu-dawn-carry.js';

type Any = any; // Dawn's objects are native classes with no TypeScript surface here.

export const dawnRequested = (): boolean => process.env.KINETOGRAPH_WEBGPU === 'dawn';

interface Hooks {
  /** A frame waits for this promise (`trackPending`). */
  track<T>(work: Promise<T>): Promise<T>;
  /** The pixels of a canvas picture, straight RGBA8 (`rasterizeCanvas`). */
  rasterize(source: { width: number; height: number; commands: CanvasCommand[] }): Uint8Array | null;
}

/** The limits of every adapter and device: the WebGPU defaults. A page cannot ask for better. */
export const DAWN_LIMITS: Record<string, number> = {
  maxTextureDimension1D: 8192, maxTextureDimension2D: 8192, maxTextureDimension3D: 2048, maxTextureArrayLayers: 256,
  maxBindGroups: 4, maxBindGroupsPlusVertexBuffers: 24, maxBindingsPerBindGroup: 1000,
  maxDynamicUniformBuffersPerPipelineLayout: 8, maxDynamicStorageBuffersPerPipelineLayout: 4,
  maxSampledTexturesPerShaderStage: 16, maxSamplersPerShaderStage: 16, maxStorageBuffersPerShaderStage: 8,
  maxStorageTexturesPerShaderStage: 4, maxUniformBuffersPerShaderStage: 12, maxUniformBufferBindingSize: 65536,
  maxStorageBufferBindingSize: 134217728, minUniformBufferOffsetAlignment: 256, minStorageBufferOffsetAlignment: 256,
  maxVertexBuffers: 8, maxBufferSize: 268435456, maxVertexAttributes: 16, maxVertexBufferArrayStride: 2048,
  maxInterStageShaderVariables: 16, maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 32,
  maxComputeWorkgroupStorageSize: 16384, maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupSizeY: 256, maxComputeWorkgroupSizeZ: 64, maxComputeWorkgroupsPerDimension: 65535,
};
const ALIGNMENTS = new Set(['minUniformBufferOffsetAlignment', 'minStorageBufferOffsetAlignment']);

/**
 * The features every adapter offers: ones Metal, Vulkan and D3D12 all give. A host that lacks one is reported once and the
 * page gets the rest.
 */
export const DAWN_FEATURES = ['float32-filterable', 'depth32float-stencil8', 'indirect-first-instance', 'rg11b10ufloat-renderable', 'depth-clip-control'];

/**
 * `timestamp-query` is offered (three.js's inspector and many pages ask for it) but is never the library's: a real timestamp
 * is real time, which a picture must not depend on. A timestamp query set is a stand-in, passes ignore their
 * `timestampWrites` and `resolveQuerySet` of one writes zeros (the engine's other recorder answers the same).
 */
const TIMESTAMP = 'timestamp-query';
const fakeQuerySets = new WeakSet<object>();

const CANVAS_FORMATS = new Set(['rgba8unorm', 'bgra8unorm', 'rgba16float']);
const RENDER_ATTACHMENT = 0x10;
const COPY_SRC = 0x01;

let dawn: { create(flags: string[]): Any; globals: Record<string, Any> } | null = null;
let hooks: Hooks | null = null;
let gpu: Any = null;
let patched = false;
const devices = new Set<Any>();
const reports = new Set<string>();

function report(what: string): void {
  reports.add(`WebGPU (Dawn): ${what}`);
}

/** What the library's devices and the canvases made since the last call report, each once (read with the WebGL reports). */
export function takeDawnReports(): string[] {
  const out = [...reports];
  reports.clear();
  return out;
}

function load(): NonNullable<typeof dawn> {
  if (dawn !== null) return dawn;
  const spec = process.env.KINETOGRAPH_DAWN_MODULE || 'webgpu';
  try {
    dawn = createRequire(import.meta.url)(spec);
  } catch (error) {
    throw new Error(`KINETOGRAPH_WEBGPU=dawn needs the "webgpu" package (dawn.node); set KINETOGRAPH_DAWN_MODULE to its folder (${(error as Error).message})`);
  }
  return dawn!;
}

function wrap(proto: Any, name: string, fn: (this: Any, original: (...args: Any[]) => Any, args: Any[]) => Any): void {
  const original = proto[name];
  if (typeof original !== 'function') return;
  Object.defineProperty(proto, name, { value: function (this: Any, ...args: Any[]) { return fn.call(this, original, args); }, writable: true, configurable: true });
}

/** The library's own `mapAsync`, which the readback uses: it is the engine's, not a page's await, so no frame waits on it. */
let nativeMapAsync: Any = null;

/** The Dawn globals under their WebGPU names, with this file's canvas context in place of dawn.node's. */
export function dawnGlobals(): Record<string, unknown> {
  return { ...load().globals, GPUCanvasContext: DawnCanvasContext };
}

/** The `navigator.gpu` of the page: Dawn's GPU object, its adapters fixed. Made once per thread. */
export function installDawn(h: Hooks): Any {
  hooks = h;
  const d = load();
  if (gpu === null) gpu = d.create([]);
  if (!patched) {
    patched = true;
    patchDawn(d.globals);
  }
  return gpu;
}

function patchDawn(g: Record<string, Any>): void {
  const track = <T,>(p: Promise<T>): Promise<T> => hooks!.track(p);
  // The page's own `await`s on the library: the frame is not read while one is open.
  for (const [cls, name] of [
    ['GPU', 'requestAdapter'], ['GPUDevice', 'createRenderPipelineAsync'], ['GPUDevice', 'createComputePipelineAsync'], ['GPUDevice', 'popErrorScope'],
    ['GPUQueue', 'onSubmittedWorkDone'], ['GPUBuffer', 'mapAsync'], ['GPUShaderModule', 'getCompilationInfo'],
  ] as const) {
    if (cls === 'GPUBuffer' && name === 'mapAsync') nativeMapAsync = g.GPUBuffer.prototype.mapAsync;
    wrap(g[cls].prototype, name, function (original, args) { return track(original.apply(this, args)); });
  }
  wrap(g.GPU.prototype, 'getPreferredCanvasFormat', () => 'rgba8unorm');
  wrap(g.GPU.prototype, 'requestAdapter', function (original, args) {
    return track((original.apply(this, args) as Promise<Any>).then((adapter) => (adapter === null ? null : fixedAdapter(adapter))));
  });
  wrap(g.GPUQueue.prototype, 'copyExternalImageToTexture', function (_original, [source, destination, size]) {
    copyExternalImage(this, source, destination, size);
  });
  wrap(g.GPUDevice.prototype, 'createQuerySet', function (original, [descriptor]) {
    if (descriptor?.type !== 'timestamp') return original.call(this, descriptor);
    const set = Object.create(g.GPUQuerySet.prototype, {
      type: { value: 'timestamp' }, count: { value: descriptor.count }, label: { value: descriptor.label ?? '', writable: true }, destroy: { value: () => undefined }, device: { value: this },
    });
    fakeQuerySets.add(set);
    return set;
  });
  for (const name of ['beginRenderPass', 'beginComputePass']) {
    wrap(g.GPUCommandEncoder.prototype, name, function (original, [descriptor]) {
      const writes = descriptor?.timestampWrites;
      if (writes === undefined || !fakeQuerySets.has(writes.querySet)) return original.call(this, descriptor);
      const { timestampWrites: _dropped, ...rest } = descriptor;
      return original.call(this, rest);
    });
  }
  wrap(g.GPUCommandEncoder.prototype, 'resolveQuerySet', function (original, [set, first, count, buffer, offset]) {
    if (!fakeQuerySets.has(set)) return original.call(this, set, first, count, buffer, offset);
    this.clearBuffer(buffer, offset, count * 8);
  });
  trackCarry(g, () => performance.now());
}

/** The adapter the page sees: fixed features, limits and info, and a device that has the real adapter's but those. */
function fixedAdapter(real: Any): Any {
  const features = new Set<string>([TIMESTAMP]);
  for (const feature of DAWN_FEATURES) {
    if (real.features.has(feature)) features.add(feature);
    else report(`this machine's adapter lacks ${feature}, which every adapter offers here; a page that needs it fails to get a device`);
  }
  const info = Object.freeze({ vendor: 'kinetograph', architecture: 'dawn', device: '', description: 'Kinetograph (Dawn)', subgroupMinSize: 0, subgroupMaxSize: 0 });
  const requestDevice = async (descriptor: Any = {}): Promise<Any> => {
    for (const feature of descriptor?.requiredFeatures ?? []) {
      if (!features.has(feature)) throw new TypeError(`requestDevice: the feature ${feature} is not supported`);
    }
    const limits: Record<string, number> = {};
    for (const [name, wanted] of Object.entries<Any>(descriptor?.requiredLimits ?? {})) {
      if (wanted === undefined) continue;
      const have = DAWN_LIMITS[name];
      if (have === undefined) throw new TypeError(`requestDevice: ${name} is not a limit`);
      const better = ALIGNMENTS.has(name) ? wanted < have : wanted > have;
      if (!Number.isFinite(Number(wanted)) || better) throw new RangeError(`OperationError: requestDevice: the limit ${name} ${String(wanted)} is better than the WebGPU default (${have}), which every device here has`);
      limits[name] = wanted;
    }
    const device = await real.requestDevice({ label: descriptor?.label, requiredFeatures: [...(descriptor?.requiredFeatures ?? [])].filter((f) => f !== TIMESTAMP), requiredLimits: limits, defaultQueue: descriptor?.defaultQueue });
    watch(device);
    return device;
  };
  return new Proxy(real, {
    get(target, key) {
      if (key === 'features') return features;
      if (key === 'limits') return { ...DAWN_LIMITS };
      if (key === 'info') return info;
      if (key === 'isFallbackAdapter') return false;
      if (key === 'requestDevice') return (descriptor?: Any) => hooks!.track(requestDevice(descriptor));
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** An uncaptured error and a lost device are the frame's warnings. */
function watch(device: Any): void {
  devices.add(device);
  device.addEventListener('uncapturederror', (event: Any) => {
    const error = event.error;
    report(`${error?.constructor?.name ?? 'GPUError'}: ${String(error?.message ?? error).split('\n')[0]!.slice(0, 300)}`);
  });
  device.lost.then((info: Any) => {
    devices.delete(device);
    if (info.reason !== 'destroyed') report(`the device was lost (${info.reason}): ${String(info.message).split('\n')[0]}`);
  });
}

/** Destroys every device made, so a long render does not hold them (a scene that is replaced, a renderer that is disposed). */
export function releaseDawn(): void {
  for (const device of devices) {
    try {
      device.destroy();
    } catch {
      // a device that is already gone
    }
  }
  devices.clear();
  for (const ref of contexts) ref.deref()?.release();
  contexts.clear();
  if (hasAddonFunction('releaseCanvasPixels')) for (const key of keys) addonFunction('releaseCanvasPixels')(key);
  keys.clear();
}

/**
 * The frame loop goes back to an earlier frame. A page's own state (its script's variables, its devices) cannot be
 * rewound in this process, so a page whose GPU state carries from frame to frame (`webgpu-dawn-carry.ts`) shows the
 * state of the frames it already drew: said with the frame. Rendering forward (a sequence, a worker's chunk, a jump
 * ahead, in which the page's callbacks run for every skipped frame) is exact.
 */
export function noteDawnRewind(): void {
  if (carryDepends()) report('a jump back to an earlier frame on a page whose GPU state carries from frame to frame (a feedback texture, a storage buffer a pass advances) shows the state of the frames already drawn; render forward, or start a new process, for that frame');
}

/** Whether a frame read what an earlier frame wrote (a feedback texture, a storage buffer a pass advances). */
export function dawnDependsOnHistory(): boolean {
  return carryDepends();
}

// ----------------------------------------------------------------------------------------------------------------------
// The canvas

const contexts = new Set<WeakRef<DawnCanvasContext>>();

export interface DawnCanvasOptions {
  size: () => { width: number; height: number };
  canvas?: unknown;
}

/** The keys of the pictures the addon holds for this thread's canvases, which `releaseDawn` lets go (a frame is drawn some frames after it is made: not before). */
const keys = new Set<string>();
let canvasCount = 0;

/**
 * The canvas of a Dawn page. The painter takes its read-back as the bytes the texture holds (`putCanvasPixels`): an opaque or
 * premultiplied canvas of `rgba8unorm` or `bgra8unorm` is taken as it is, with that alpha and byte order, and no pass over
 * the pixels is made here. A display-p3 canvas and `rgba16float` are converted to straight-alpha sRGB RGBA8 first.
 */
export class DawnCanvasContext {
  readonly canvas: unknown;
  private config: { device: Any; format: string; usage: number; alphaMode: string; colorSpace: string; viewFormats: Any } | null = null;
  private texture: Any = null;
  private drawnThisFrame = false;
  /** The buffer the texture is copied to: kept from frame to frame while the size is the same. */
  private readback: { buffer: Any; size: number } | null = null;
  /** What the addon holds for this canvas: the key (this thread's, this canvas's) and the newest version put. */
  private readonly key = `dawn:${threadId}:${canvasCount++}`;
  private version = 0;
  /** The canvas as the last flush read it, null when nothing was drawn this frame. */
  picture: { width: number; height: number; source: CanvasSource } | null = null;

  constructor(private readonly options: DawnCanvasOptions) {
    this.canvas = options.canvas;
    contexts.add(new WeakRef(this));
    keys.add(this.key);
  }

  get drawn(): boolean {
    return this.picture !== null;
  }

  configure(configuration: Any): void {
    const { device } = configuration ?? {};
    if (!devices.has(device)) throw new TypeError("configure: 'device' is not a GPUDevice");
    const format = configuration.format;
    if (typeof format !== 'string' || !CANVAS_FORMATS.has(format)) throw new TypeError(`configure: the format ${String(format)} is not a canvas format`);
    const colorSpace = configuration.colorSpace ?? 'srgb';
    if (colorSpace !== 'srgb' && colorSpace !== 'display-p3') throw new TypeError(`configure: the colorSpace ${String(colorSpace)} is not srgb or display-p3`);
    const alphaMode = configuration.alphaMode ?? 'opaque';
    if (alphaMode !== 'opaque' && alphaMode !== 'premultiplied') throw new TypeError(`configure: the alphaMode ${String(alphaMode)} is not opaque or premultiplied`);
    this.dropTexture();
    this.config = { device, format, usage: configuration.usage ?? RENDER_ATTACHMENT, alphaMode, colorSpace, viewFormats: configuration.viewFormats ?? [] };
  }

  unconfigure(): void {
    this.dropTexture();
    this.config = null;
  }

  getConfiguration(): Any {
    return this.config === null ? null : { ...this.config };
  }

  getCurrentTexture(): Any {
    const config = this.config;
    if (config === null) {
      const error = new Error("getCurrentTexture: the canvas context is not configured");
      error.name = 'InvalidStateError';
      throw error;
    }
    const { width, height } = this.options.size();
    if (this.texture === null || this.texture.width !== width || this.texture.height !== height) {
      this.dropTexture();
      // A new texture is transparent black, as a canvas's is at the start of a frame.
      this.texture = config.device.createTexture({ label: 'canvas', size: [Math.max(1, width), Math.max(1, height)], format: config.format, usage: config.usage | COPY_SRC, viewFormats: config.viewFormats });
    }
    startsCleared(this.texture);
    this.drawnThisFrame = true;
    return this.texture;
  }

  /** The canvas's `width` or `height` was set: the texture is made again at the new size. */
  reset(): void {
    this.dropTexture();
  }

  /** The start of a frame's render: the canvas is a new one (a frame is a function of the frame, not of the frames before). */
  resetState(): void {
    this.dropTexture();
    this.drawnThisFrame = false;
    this.picture = null;
  }

  private dropTexture(): void {
    try {
      this.texture?.destroy();
    } catch {
      // the device is already destroyed
    }
    this.texture = null;
  }

  private dropReadback(): void {
    try {
      this.readback?.buffer.destroy();
    } catch {
      // the device is already destroyed
    }
    this.readback = null;
  }

  /** The device is gone (`releaseDawn`): the texture and the buffer went with it. */
  release(): void {
    this.dropTexture();
    this.readback = null;
    this.picture = null;
  }

  /** Reads the texture the page drew this frame back, and hands it to the addon. */
  async flush(): Promise<void> {
    const config = this.config;
    if (config === null || !this.drawnThisFrame || this.texture === null) return;
    const { device, format } = config;
    const width: number = this.texture.width;
    const height: number = this.texture.height;
    const wide = format === 'rgba16float';
    const rowBytes = width * (wide ? 8 : 4);
    const stride = Math.ceil(rowBytes / 256) * 256;
    if (this.readback === null || this.readback.size !== stride * height || !devices.has(device)) {
      this.dropReadback();
      this.readback = { buffer: device.createBuffer({ label: 'canvas readback', size: stride * height, usage: 0x01 | 0x08 /* MAP_READ | COPY_DST */ }), size: stride * height };
    }
    const { buffer } = this.readback;
    let t = stamp();
    try {
      untracked(() => {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: this.texture }, { buffer, bytesPerRow: stride, rowsPerImage: height }, [width, height, 1]);
        device.queue.submit([encoder.finish()]);
      });
      await nativeMapAsync.call(buffer, 0x01);
      t = lap('dawn_map', t);
      this.keep(new Uint8Array(buffer.getMappedRange()), width, height, stride, format, config.alphaMode, config.colorSpace);
      lap('dawn_keep', t);
      buffer.unmap();
    } catch (error) {
      this.dropReadback();
      throw error;
    }
  }

  /** Hands the mapped rows to the addon as they are, or converted to straight sRGB when the addon cannot take them so. */
  private keep(mapped: Uint8Array, width: number, height: number, stride: number, format: string, alphaMode: string, colorSpace: string): void {
    const direct = format !== 'rgba16float' && colorSpace === 'srgb';
    const rows = direct ? mapped : toStraightSrgb(mapped, width, height, stride, format, alphaMode, colorSpace);
    if (!hasAddonFunction('putCanvasPixels')) {
      // An addon without the call takes the straight-alpha pixels as text (the same pixels source an `ImageData` put on a 2D canvas has).
      const straight = direct ? toStraightSrgb(mapped, width, height, stride, format, alphaMode, colorSpace) : rows;
      const data = Buffer.from(straight.buffer, straight.byteOffset, straight.byteLength).toString('base64');
      this.picture = { width, height, source: { kind: 'pixels', width, height, data } };
      return;
    }
    const bytes = Buffer.from(rows.buffer, rows.byteOffset, rows.byteLength);
    const alpha = !direct ? 'straight' : alphaMode === 'premultiplied' ? 'premultiplied' : 'opaque';
    const changed = addonFunction('putCanvasPixels')(this.key, this.version + 1, width, height, direct ? stride : width * 4, direct && format === 'bgra8unorm', alpha, bytes);
    // The same picture as the last one put: that version is still the one to draw (its image is made already).
    if (changed) this.version += 1;
    this.picture = { width, height, source: { kind: 'stored', key: this.key, version: this.version } };
  }
}

/** Reads back every canvas drawn this frame: the frame loop awaits it before it reads the tree. */
export async function flushDawnCanvases(): Promise<void> {
  for (const ref of contexts) {
    const context = ref.deref();
    if (context === undefined) contexts.delete(ref);
    else await context.flush();
  }
}

/** The canvas's picture as the one command the painter draws a 2D canvas's pixels with, or null when it drew nothing. */
export function dawnCommandsOf(context: DawnCanvasContext): CanvasCommand[] | null {
  if (context.picture === null) return null;
  const { width, height, source } = context.picture;
  return [{ op: 'image', source, sx: 0, sy: 0, sw: width, sh: height, dx: 0, dy: 0, dw: width, dh: height, smooth: false } as CanvasCommand];
}

// ----------------------------------------------------------------------------------------------------------------------
// Pixels: what the texture holds to the straight-alpha sRGB bytes the engine's painter takes

const HALF = (() => {
  const table = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const sign = h & 0x8000 ? -1 : 1;
    const exp = (h >> 10) & 0x1f;
    const frac = h & 0x3ff;
    table[h] = exp === 0 ? sign * 2 ** -14 * (frac / 1024) : exp === 31 ? (frac === 0 ? sign * Infinity : NaN) : sign * 2 ** (exp - 15) * (1 + frac / 1024);
  }
  return table;
})();

const RECIPROCAL = Float32Array.from({ length: 256 }, (_, a) => (a === 0 ? 0 : 255 / a));
const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const DECODE = Float32Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));
const ENCODE = Uint8Array.from({ length: 4097 }, (_, i) => Math.round(Math.min(1, linearToSrgb(i / 4096)) * 255));

/** Display P3 (transfer of sRGB) to sRGB, in place, on straight-alpha RGBA8; out-of-gamut values are clipped. */
function p3ToSrgb(rgba: Uint8Array): void {
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const r = DECODE[rgba[i]!]!, g = DECODE[rgba[i + 1]!]!, b = DECODE[rgba[i + 2]!]!;
    const lr = 1.2249401 * r - 0.2249404 * g;
    const lg = -0.0420569 * r + 1.0420571 * g;
    const lb = -0.0196376 * r - 0.0786361 * g + 1.0982735 * b;
    rgba[i] = ENCODE[Math.round(Math.min(1, Math.max(0, lr)) * 4096)]!;
    rgba[i + 1] = ENCODE[Math.round(Math.min(1, Math.max(0, lg)) * 4096)]!;
    rgba[i + 2] = ENCODE[Math.round(Math.min(1, Math.max(0, lb)) * 4096)]!;
  }
}

export function toStraightSrgb(src: Uint8Array, width: number, height: number, stride: number, format: string, alphaMode: string, colorSpace: string): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const premultiplied = alphaMode === 'premultiplied';
  if (format === 'rgba16float') {
    const half = new Uint16Array(src.buffer, src.byteOffset, src.byteLength >> 1);
    const clamp = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);
    for (let y = 0; y < height; y++) {
      let s = (y * stride) >> 1;
      let o = y * width * 4;
      for (let x = 0; x < width; x++, s += 4, o += 4) {
        const a = premultiplied ? clamp(HALF[half[s + 3]!]!) : 1;
        const k = premultiplied ? (a > 0 ? 1 / a : 0) : 1;
        out[o] = Math.round(clamp(HALF[half[s]!]! * k) * 255);
        out[o + 1] = Math.round(clamp(HALF[half[s + 1]!]! * k) * 255);
        out[o + 2] = Math.round(clamp(HALF[half[s + 2]!]! * k) * 255);
        out[o + 3] = Math.round(a * 255);
      }
    }
  } else {
    const swap = format === 'bgra8unorm';
    const src32 = new Uint32Array(src.buffer, src.byteOffset, src.byteLength >> 2);
    const out32 = new Uint32Array(out.buffer);
    for (let y = 0; y < height; y++) {
      const row = (y * stride) >> 2;
      const o32 = y * width;
      for (let x = 0; x < width; x++) {
        let w = src32[row + x]!;
        if (!premultiplied) w |= 0xff000000;
        else {
          const a = w >>> 24;
          if (a !== 255) {
            if (a === 0) { out32[o32 + x] = 0; continue; }
            const k = RECIPROCAL[a]!;
            const c0 = Math.min(255, ((w & 255) * k + 0.5) | 0);
            const c1 = Math.min(255, (((w >>> 8) & 255) * k + 0.5) | 0);
            const c2 = Math.min(255, (((w >>> 16) & 255) * k + 0.5) | 0);
            w = (c0 | (c1 << 8) | (c2 << 16) | (a << 24)) >>> 0;
          }
        }
        // bgra8unorm holds blue first: swap the two ends so the bytes are r, g, b, a.
        out32[o32 + x] = swap ? ((w & 0xff00ff00) | ((w & 255) << 16) | ((w >>> 16) & 255)) >>> 0 : w;
      }
    }
  }
  if (colorSpace === 'display-p3') p3ToSrgb(out);
  return out;
}

// ----------------------------------------------------------------------------------------------------------------------
// copyExternalImageToTexture from the engine's pictures

function pictureBytes(source: Any): { rgba: Uint8Array; width: number; height: number } {
  const picture = (source as { [key: symbol]: () => Any } | null)?.[CANVAS_SOURCE as symbol]?.();
  if (!picture) throw new Error(`copyExternalImageToTexture from ${source?.constructor?.name ?? typeof source} is not available here; use an image, an ImageBitmap, ImageData, a canvas or a video`);
  const { source: s, width, height } = picture;
  if (s.kind === 'pixels') return { rgba: new Uint8Array(Buffer.from(s.data, 'base64')), width: s.width, height: s.height };
  const rgba = hooks!.rasterize({ width, height, commands: [{ op: 'image', source: s, sx: 0, sy: 0, sw: width, sh: height, dx: 0, dy: 0, dw: width, dh: height, smooth: false } as CanvasCommand] });
  if (rgba === null) throw new Error('copyExternalImageToTexture: the pixels of this picture need the native addon');
  return { rgba, width, height };
}

function copyExternalImage(queue: Any, source: Any, destination: Any, size: Any): void {
  const { rgba, width, height } = pictureBytes(source.source);
  const origin = source.origin ?? [0, 0];
  const ox = Array.isArray(origin) ? origin[0] ?? 0 : origin.x ?? 0;
  const oy = Array.isArray(origin) ? origin[1] ?? 0 : origin.y ?? 0;
  const copy = Array.isArray(size) ? size : [size.width, size.height ?? 1, size.depthOrArrayLayers ?? 1];
  const [w, h] = [copy[0] as number, (copy[1] ?? 1) as number];
  const bytes = new Uint8Array(w * h * 4);
  const premultiply = destination.premultipliedAlpha === true;
  for (let y = 0; y < h; y++) {
    const sy = source.flipY ? oy + h - 1 - y : oy + y;
    for (let x = 0; x < w; x++) {
      const si = ((sy * width) + ox + x) * 4;
      const di = (y * w + x) * 4;
      if (sy < 0 || sy >= height || ox + x >= width) continue;
      const a = rgba[si + 3]!;
      bytes[di] = premultiply ? Math.round((rgba[si]! * a) / 255) : rgba[si]!;
      bytes[di + 1] = premultiply ? Math.round((rgba[si + 1]! * a) / 255) : rgba[si + 1]!;
      bytes[di + 2] = premultiply ? Math.round((rgba[si + 2]! * a) / 255) : rgba[si + 2]!;
      bytes[di + 3] = a;
    }
  }
  const format: string = destination.texture.format;
  const swap = format.startsWith('bgra');
  if (swap) for (let i = 0; i < bytes.length; i += 4) [bytes[i], bytes[i + 2]] = [bytes[i + 2]!, bytes[i]!];
  queue.writeTexture({ texture: destination.texture, mipLevel: destination.mipLevel ?? 0, origin: destination.origin ?? [0, 0, 0], aspect: destination.aspect }, bytes, { bytesPerRow: w * 4, rowsPerImage: h }, [w, h, copy[2] ?? 1]);
}
