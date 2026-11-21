// WebGPU through Dawn (Chrome's WebGPU library, dawn.node from the addon's platform package), behind KINETOGRAPH_WEBGPU=dawn.
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
import { DawnBinaryError, loadDawnBinary } from './dawn-binary.js';
import { softwareChoice, swiftshaderIcd, useSwiftshader } from './dawn-software.js';
import { lap, stamp } from '../profile.js';
import { beginRewind, newCarry, trackCarry, carryNeedsReplay, startsCleared, stillCarries, untracked, useCarry, type Carry } from './webgpu-dawn-carry.js';

export { duringAnimationFrames } from './webgpu-dawn-carry.js';

type Any = any; // Dawn's objects are native classes with no TypeScript surface here.

export const dawnRequested = (): boolean => process.env.KINETOGRAPH_WEBGPU === 'dawn';

interface Hooks {
  /** A frame waits for this promise (`trackPending`). */
  track<T>(work: Promise<T>): Promise<T>;
  /** The same for the end of a read of the GPU's results, which is no reason for the frame's callbacks to run again (`trackReadback`). */
  trackReadback?<T>(work: Promise<T>): Promise<T>;
  /** The pixels of a canvas picture, straight RGBA8 (`rasterizeCanvas`). */
  rasterize(source: { width: number; height: number; commands: CanvasCommand[] }): Uint8Array | null;
}

/** What every adapter and device says about itself: not this machine's GPU. */
const FIXED_INFO = Object.freeze({ vendor: 'kinetograph', architecture: 'dawn', device: '', description: 'Kinetograph (Dawn)', subgroupMinSize: 0, subgroupMaxSize: 0 });

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
  maxStorageBuffersInVertexStage: 8, maxStorageBuffersInFragmentStage: 8, maxStorageTexturesInVertexStage: 4, maxStorageTexturesInFragmentStage: 4,
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

const CANVAS_FORMATS = new Set(['rgba8unorm', 'bgra8unorm', 'rgba16float']);
const RENDER_ATTACHMENT = 0x10;
const COPY_SRC = 0x01;

let dawn: { create(flags: string[]): Any; globals: Record<string, Any>; directory?: string } | null = null;
let hooks: Hooks | null = null;
let gpu: Any = null;

/**
 * What one renderer's pages made with the library: its devices, canvases and the pictures it put in the addon, the errors they raised and
 * what its frames read of each other. A thread can hold several renderers (a Studio's preview and a render started from it): each has
 * a scope, which the frame loop enters while it renders a frame (`enterDawnScope`), and releasing one leaves the others' alone.
 * Frames of two renderers do not overlap (the engine's clock and its page globals are the thread's).
 */
export class DawnScope {
  /** The copy of this module that made the scope: its hooks and its clock (the patched library is the process's, the copies' state is not). */
  readonly host = host;
  readonly devices = new Set<Any>();
  /** A rewind (`noteDawnRewind`) has not been settled yet. */
  rewinding = false;
  readonly reports = new Set<string>();
  readonly contexts = new Set<WeakRef<DawnCanvasContext>>();
  /** The keys of the pictures the addon holds for these canvases, which `releaseDawn` lets go (a frame is drawn some frames after it is made: not before). */
  readonly keys = new Set<string>();
  readonly carry: Carry = newCarry();
}

/** The frame's virtual time in milliseconds (the engine's `virtualNow`): what a resource's last write is dated by (`webgpu-dawn-carry.ts`). */
let clock: () => number = () => 0;

/**
 * What belongs to this copy of the module and not to the process: the hooks into its frame (`installDawn`) and its clock. A project
 * bundle carries its own copy of this module, while the library and the addon are the process's: a scope remembers its copy's.
 */
interface Host {
  hooks(): Hooks;
  clock(): number;
}
const host: Host = { hooks: () => hooks!, clock: () => clock() };

/**
 * The engine gives the clock itself: the page's `performance.now` is not it (a page can replace it, and once the engine's
 * determinism is uninstalled it is the real time).
 */
export function setDawnClock(now: () => number): void {
  clock = now;
}

/**
 * What every copy of this module in the process shares, because the library is patched once and the addon's store has one set of keys:
 * the scope that is current, the count of canvases (the addon's picture keys), the frames entered, and the adapter that was chosen.
 */
interface Shared {
  scope: DawnScope;
  canvases: number;
  entered: number;
  /** The adapter Dawn gave the first request of this process (`DawnAdapter`), which `doctor` says. */
  adapter: DawnAdapter | null;
}

const SHARED = Symbol.for('kinetograph.dawn.shared');
const defaultScope = new DawnScope();
const shared: Shared = ((globalThis as Any)[SHARED] ??= { scope: defaultScope, canvases: 0, entered: 0, adapter: null });
useCarry(defaultScope.carry);

export function createDawnScope(): DawnScope {
  return new DawnScope();
}

/** Makes `next` the scope of what runs now (a frame of its renderer); returns what puts the one before back. */
export function enterDawnScope(next: DawnScope): () => void {
  const was = shared.scope;
  const carry = useCarry(next.carry);
  shared.scope = next;
  shared.entered++;
  return () => {
    shared.entered--;
    shared.scope = was;
    useCarry(carry);
  };
}

function report(owner: DawnScope, what: string): void {
  owner.reports.add(`WebGPU (Dawn): ${what}`);
}

/** What the library's devices and the canvases made since the last call report, each once (read with the WebGL reports). */
export function takeDawnReports(): string[] {
  settleRewind();
  const out = [...shared.scope.reports];
  shared.scope.reports.clear();
  return out;
}

/**
 * How the host finds the library (`setDawnLoader`): the CLI resolves the platform package from its own install, where a bundle in a project's
 * cache would look from the project. It sits on `globalThis` because the host's copy of this module is not the project bundle's.
 */
const LOADER = Symbol.for('kinetograph.dawn.loader');

export function setDawnLoader(fn: (() => unknown) | null): void {
  (globalThis as Any)[LOADER] = fn;
}

/** The one message for a library that is missing, has no binary for this platform or does not load: what failed, and what to do. */
export function dawnLoadMessage(error: unknown, override?: string): string {
  const e = error as NodeJS.ErrnoException;
  const first = String(e?.message ?? e).split('\n')[0]!;
  const head = 'KINETOGRAPH_WEBGPU=dawn: ';
  const unset = 'Unset KINETOGRAPH_WEBGPU to use the built-in WebGPU.';
  if (override) return `${head}KINETOGRAPH_DAWN_MODULE=${override} cannot be loaded (${first}). ${unset}`;
  if (error instanceof DawnBinaryError) return `${head}${first}. ${unset}`;
  if (e?.code === 'ERR_DLOPEN_FAILED') {
    const linux = process.platform === 'linux' ? ' (Linux needs glibc 2.34 or newer; musl, as on Alpine, is not supported)' : '';
    return `${head}the Dawn binary (${process.platform}-${process.arch}) cannot be loaded on this system${linux}: ${first}. ${unset}`;
  }
  return `${head}Dawn cannot be loaded (${first}). ${unset}`;
}

function load(): NonNullable<typeof dawn> {
  if (dawn !== null) return dawn;
  const override = process.env.KINETOGRAPH_DAWN_MODULE || undefined;
  let found: Any;
  try {
    found = override ? createRequire(import.meta.url)(override) : typeof (globalThis as Any)[LOADER] === 'function' ? (globalThis as Any)[LOADER]() : loadDawnBinary();
  } catch (error) {
    throw new Error(dawnLoadMessage(error, override));
  }
  if (typeof found?.create !== 'function' || found.globals === undefined) throw new Error(dawnLoadMessage(new Error('it is not Dawn for Node: it has no create() and globals'), override));
  dawn = found;
  return dawn!;
}

function wrap(proto: Any, name: string, fn: (this: Any, original: (...args: Any[]) => Any, args: Any[]) => Any): void {
  const original = proto[name];
  if (typeof original !== 'function') return;
  Object.defineProperty(proto, name, { value: function (this: Any, ...args: Any[]) { return fn.call(this, original, args); }, writable: true, configurable: true });
}

/**
 * What patching the library left, kept on the library itself (it is the process's, whichever copy of this module asks): the mark that it
 * is patched, so that a second copy (a second project's bundle) does not patch it again, the library's own `mapAsync`, which the
 * readback uses (the engine's, not a page's await, so no frame waits on it), and the timestamp stand-ins.
 */
const PATCHED = Symbol.for('kinetograph.dawn.patched');
interface Patch {
  nativeMapAsync: Any;
  fakeQuerySets: WeakSet<object>;
  /** The library's own `requestAdapter`, before this file's: `describeDawn` asks it. */
  requestAdapter: Any;
}
const patchOf = (g: Record<string, Any>): Patch | undefined => (g.GPUDevice.prototype as Any)[PATCHED];

/** The Dawn globals under their WebGPU names, with this file's canvas context in place of dawn.node's. */
export function dawnGlobals(): Record<string, unknown> {
  return { ...load().globals, GPUCanvasContext: DawnCanvasContext };
}

/** The `navigator.gpu` of the page: Dawn's GPU object, its adapters fixed. Made once per thread. */
export function installDawn(h: Hooks): Any {
  hooks = h;
  const d = load();
  if (gpu === null) gpu = createGpu(d);
  // Once per library: every copy of this module in the process (each project bundle has one) shares the patched classes, which look up the
  // copy that is current (`shared.scope.host`) at each call. Patched again, each call would pass through every copy's layer and each copy's hooks.
  if (patchOf(d.globals) === undefined) {
    const patch: Patch = { nativeMapAsync: null, fakeQuerySets: new WeakSet(), requestAdapter: d.globals.GPU.prototype.requestAdapter };
    Object.defineProperty(d.globals.GPUDevice.prototype, PATCHED, { value: patch });
    patchDawn(d.globals, patch);
  }
  // What runs outside a frame (the project's own module code) belongs to the project loaded last, as the page globals do.
  if (shared.entered === 0) {
    shared.scope = defaultScope;
    useCarry(defaultScope.carry);
  }
  return gpu;
}

function patchDawn(g: Record<string, Any>, patch: Patch): void {
  const track = <T,>(p: Promise<T>): Promise<T> => shared.scope.host.hooks().track(p);
  const trackReadback = <T,>(p: Promise<T>): Promise<T> => { const h = shared.scope.host.hooks(); return (h.trackReadback ?? h.track)(p); };
  // The page's own `await`s on the library: the frame is not read while one is open.
  for (const [cls, name] of [
    ['GPU', 'requestAdapter'], ['GPUDevice', 'createRenderPipelineAsync'], ['GPUDevice', 'createComputePipelineAsync'], ['GPUDevice', 'popErrorScope'],
    ['GPUQueue', 'onSubmittedWorkDone'], ['GPUBuffer', 'mapAsync'], ['GPUShaderModule', 'getCompilationInfo'],
  ] as const) {
    if (cls === 'GPUBuffer' && name === 'mapAsync') patch.nativeMapAsync = g.GPUBuffer.prototype.mapAsync;
    const hold = name === 'mapAsync' || name === 'onSubmittedWorkDone' ? trackReadback : track;
    wrap(g[cls].prototype, name, function (original, args) { return hold(original.apply(this, args)); });
  }
  wrap(g.GPU.prototype, 'getPreferredCanvasFormat', () => 'rgba8unorm');
  // One adapter policy on every machine, not the page's options (a page asks for 'low-power' or 'high-performance' by taste, and a host with two
  // GPUs would give each page another one): the best adapter of the backend `dawnFlags` names, else a software one. No adapter is `null`, as the
  // spec has it (a page may fall back to something else), and a frame warning that says why, which `--strict` fails.
  wrap(g.GPU.prototype, 'requestAdapter', function (original) {
    return track(chooseAdapter((options) => original.call(this, options)).then((chosen) => {
      if (chosen === null) {
        report(shared.scope, noAdapterMessage());
        return null;
      }
      noteAdapter(chosen);
      return fixedAdapter(chosen.adapter);
    }));
  });
  wrap(g.GPUQueue.prototype, 'copyExternalImageToTexture', function (_original, [source, destination, size]) {
    copyExternalImage(this, source, destination, size);
  });
  wrap(g.GPUDevice.prototype, 'createQuerySet', function (original, [descriptor]) {
    if (descriptor?.type !== 'timestamp') return original.call(this, descriptor);
    const set = Object.create(g.GPUQuerySet.prototype, {
      type: { value: 'timestamp' }, count: { value: descriptor.count }, label: { value: descriptor.label ?? '', writable: true }, destroy: { value: () => undefined }, device: { value: this },
    });
    patch.fakeQuerySets.add(set);
    return set;
  });
  for (const name of ['beginRenderPass', 'beginComputePass']) {
    wrap(g.GPUCommandEncoder.prototype, name, function (original, [descriptor]) {
      const writes = descriptor?.timestampWrites;
      if (writes === undefined || !patch.fakeQuerySets.has(writes.querySet)) return original.call(this, descriptor);
      const { timestampWrites: _dropped, ...rest } = descriptor;
      return original.call(this, rest);
    });
  }
  wrap(g.GPUCommandEncoder.prototype, 'resolveQuerySet', function (original, [set, first, count, buffer, offset]) {
    if (!patch.fakeQuerySets.has(set)) return original.call(this, set, first, count, buffer, offset);
    report(shared.scope, 'a timestamp query is a stand-in here: its results are zeros (a real timestamp is real time, which a picture must not depend on)');
    // A buffer that only query results go to (QUERY_RESOLVE, COPY_SRC) is zero and nothing else writes it; one that can be copied to is cleared.
    if (((buffer.usage ?? 0) & 0x08 /* COPY_DST */) !== 0) this.clearBuffer(buffer, offset, count * 8);
  });
  trackCarry(g, () => shared.scope.host.clock());
}

// ----------------------------------------------------------------------------------------------------------------------
// Which adapter: the backend and the adapter Dawn is asked for, and what it chose

/** The backend each platform's engine path uses (Metal, D3D12, Vulkan): named to Dawn, so that it does not pick another API that is also there (OpenGL ES, D3D11). */
const DEFAULT_BACKENDS: Record<string, string> = { darwin: 'metal', win32: 'd3d12', linux: 'vulkan' };

/**
 * The flags `create` of the library is given. The backend is the platform's own (KINETOGRAPH_DAWN_BACKEND replaces it: `metal`, `vulkan`,
 * `d3d12`, `d3d11`, `opengl`, `opengles`, `webgpu`, `null`), and KINETOGRAPH_DAWN_ADAPTER names one adapter, as the library lists them
 * when it is given a name it does not know.
 */
export function dawnFlags(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string[] {
  const backend = env.KINETOGRAPH_DAWN_BACKEND || DEFAULT_BACKENDS[platform];
  const adapter = env.KINETOGRAPH_DAWN_ADAPTER;
  return [...(backend ? [`backend=${backend}`] : []), ...(adapter ? [`adapter=${adapter}`] : [])];
}

/** The library lists the backends or the adapters it has when its flags name one it does not know: that list is the answer. */
function startError(error: unknown): Error {
  const flags = dawnFlags();
  return new Error(`KINETOGRAPH_WEBGPU=dawn: Dawn could not start with ${flags.length === 0 ? 'no flags' : flags.join(' ')}: ${String((error as Error).message).split('\n').map((line) => line.trim()).filter(Boolean).join('; ')}`);
}

function createGpu(d: NonNullable<typeof dawn>): Any {
  try {
    return d.create(dawnFlags());
  } catch (error) {
    throw startError(error);
  }
}

/** What Dawn chose, as `doctor` says it. */
export interface DawnAdapter {
  /** The backend Dawn was asked for (the flag), null when none was named. */
  backend: string | null;
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  /** The adapter runs on the CPU (lavapipe, SwiftShader, WARP): the one a host without a GPU has. */
  software: boolean;
  /** It was asked for with `forceFallbackAdapter`, after the best adapter was not there. */
  fallback: boolean;
}

const SOFTWARE = /llvmpipe|lavapipe|swiftshader|\bwarp\b|basic render|software|\bcpu\b/i;

/** The best adapter of the backend, else a software one, else null. */
async function chooseAdapter(request: (options: Any) => Promise<Any>): Promise<{ adapter: Any; fallback: boolean } | null> {
  try {
    const best = await request({ powerPreference: 'high-performance' });
    if (best !== null && best !== undefined) return { adapter: best, fallback: false };
    const software = await request({ forceFallbackAdapter: true });
    return software === null || software === undefined ? null : { adapter: software, fallback: true };
  } catch (error) {
    // The library finds its adapters when the first is asked for, and says so then (a backend or an adapter name it does not know).
    throw startError(error);
  }
}

function describeAdapter({ adapter, fallback }: { adapter: Any; fallback: boolean }): DawnAdapter {
  const info = adapter.info ?? {};
  const text = `${info.device ?? ''} ${info.description ?? ''} ${info.architecture ?? ''}`;
  return {
    backend: dawnFlags().find((flag) => flag.startsWith('backend='))?.slice('backend='.length) ?? null,
    vendor: String(info.vendor ?? ''), architecture: String(info.architecture ?? ''), device: String(info.device ?? ''), description: String(info.description ?? ''),
    software: fallback || info.isFallbackAdapter === true || SOFTWARE.test(text),
    fallback,
  };
}

/** The first adapter this process was given is kept for `doctor`, which says it once. */
function noteAdapter(chosen: { adapter: Any; fallback: boolean }): void {
  shared.adapter ??= describeAdapter(chosen);
}

function noAdapterMessage(): string {
  const flags = dawnFlags();
  const hint = process.platform === 'linux'
    ? 'on Linux that needs a Vulkan driver: a GPU\'s, or Mesa\'s lavapipe (the package mesa-vulkan-drivers) on a host without one'
    : process.platform === 'win32' ? 'on Windows a Direct3D 12 adapter: a GPU\'s, or WARP' : 'a Metal device';
  return `Dawn found no adapter (${flags.length === 0 ? 'no flags' : flags.join(' ')}; ${hint}); KINETOGRAPH_DAWN_BACKEND or KINETOGRAPH_DAWN_ADAPTER name another, and unsetting KINETOGRAPH_WEBGPU uses the built-in WebGPU`;
}

/** The adapter a page was given in this process, or null when none asked yet. */
export function dawnAdapter(): DawnAdapter | null {
  return shared.adapter;
}

export type DawnStatus = { ok: true; flags: string[]; adapter: DawnAdapter } | { ok: false; error: string };

/**
 * What `doctor` says of Dawn: the adapter this process was given, or the one it would be given, or why there is none (the library is
 * missing, has no binary here, found no adapter). Asks the library's own `requestAdapter`, not a page's.
 */
export async function describeDawn(): Promise<DawnStatus> {
  const flags = dawnFlags();
  try {
    if (shared.adapter !== null) return { ok: true, flags, adapter: shared.adapter };
    const d = load();
    const probe = createGpu(d);
    const request = patchOf(d.globals)?.requestAdapter ?? d.globals.GPU.prototype.requestAdapter;
    const chosen = await chooseAdapter((options) => request.call(probe, options));
    if (chosen === null) return { ok: false, error: `KINETOGRAPH_WEBGPU=dawn: ${noAdapterMessage()}` };
    return { ok: true, flags, adapter: describeAdapter(chosen) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** The adapter the page sees: fixed features, limits and info, and a device that has the real adapter's but those. */
function fixedAdapter(real: Any): Any {
  const adapterOwner = shared.scope;
  const features = new Set<string>([TIMESTAMP]);
  for (const feature of DAWN_FEATURES) {
    if (real.features.has(feature)) features.add(feature);
    else report(adapterOwner, `this machine's adapter lacks ${feature}, which every adapter offers here; a page that needs it fails to get a device`);
  }
  const requestDevice = async (descriptor: Any = {}): Promise<Any> => {
    // The scope of the frame that asks: an adapter may be got in one frame and a device asked of it in another.
    const owner = shared.scope;
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
    watch(device, owner);
    // `device.adapterInfo` is the real adapter's, which names this machine's GPU: the fixed one instead.
    try {
      Object.defineProperty(device, 'adapterInfo', { value: FIXED_INFO, configurable: true });
    } catch {
      // a library whose device cannot be given a property keeps its own
    }
    return device;
  };
  return new Proxy(real, {
    get(target, key) {
      if (key === 'features') return features;
      if (key === 'limits') return { ...DAWN_LIMITS };
      if (key === 'info') return FIXED_INFO;
      if (key === 'isFallbackAdapter') return false;
      if (key === 'requestDevice') return (descriptor?: Any) => shared.scope.host.hooks().track(requestDevice(descriptor));
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** An uncaptured error and a lost device are the frame's warnings. */
function watch(device: Any, owner: DawnScope): void {
  owner.devices.add(device);
  device.addEventListener('uncapturederror', (event: Any) => {
    const error = event.error;
    report(owner, `${error?.constructor?.name ?? 'GPUError'}: ${String(error?.message ?? error).split('\n')[0]!.slice(0, 300)}`);
  });
  device.lost.then((info: Any) => {
    owner.devices.delete(device);
    if (info.reason !== 'destroyed') report(owner, `the device was lost (${info.reason}): ${String(info.message).split('\n')[0]}`);
  });
}

/**
 * Destroys the devices of `owner` (a renderer's scope; by default the one of what runs now) and lets go of its canvases and pictures, so a
 * long render does not hold them (a scene that is replaced, a renderer that is disposed). What its frames read of each other
 * (`webgpu-dawn-carry.ts`) belonged to those devices. Another renderer's devices, canvases and pictures are not touched.
 */
export function releaseDawn(owner: DawnScope = shared.scope): void {
  for (const device of owner.devices) {
    try {
      device.destroy();
    } catch {
      // a device that is already gone
    }
  }
  owner.devices.clear();
  for (const ref of owner.contexts) ref.deref()?.release();
  owner.contexts.clear();
  if (hasAddonFunction('releaseCanvasPixels')) for (const key of owner.keys) addonFunction('releaseCanvasPixels')(key);
  owner.keys.clear();
  owner.reports.clear();
  owner.rewinding = false;
  Object.assign(owner.carry, newCarry());
}

/**
 * The frame loop goes back to an earlier frame: it starts the composition over (a new React tree, which runs its effects and so
 * makes the devices of a mount again) and replays the frames before it. That is exact for a device the page made again: its GPU state
 * starts from nothing, as a render from frame 0 does. A device the page kept (an HTML page's module script ran once, or a project made
 * a device at module scope) keeps what the frames already drawn left in it, and a rewind cannot undo that: when the frame uses
 * such a device whose state carried from frame to frame (`webgpu-dawn-carry.ts`) it shows the state of the frames already drawn, said
 * with the frame (an error under `--strict`). A page whose state does not carry (most) is exact either way.
 */
export function noteDawnRewind(): void {
  shared.scope.rewinding = true;
  beginRewind();
}

/** The end of a frame: a rewind is settled by whether the frame used a device that had carried state before it (the devices before it are kept to `releaseDawn`: a page may still use one). */
function settleRewind(): void {
  const scope = shared.scope;
  if (!scope.rewinding) return;
  scope.rewinding = false;
  if (stillCarries()) {
    report(scope, 'a jump back to an earlier frame on a page whose GPU state carries from frame to frame (a feedback texture, a storage buffer a pass advances) in a device the page keeps when its script runs again (an HTML page, or a device made at module scope) shows the state of the frames already drawn; render forward, or start a new process, for that frame');
  }
}

/** Whether a page of the renderer in the scope that is current has a Dawn device (its animation-frame loop may be drawing from the tree). */
export function dawnInUse(): boolean {
  return shared.scope.devices.size > 0;
}

/** Whether a frame read what an earlier frame wrote that only a replay of the frames before it makes (`carryNeedsReplay`). */
export function dawnDependsOnHistory(): boolean {
  return carryNeedsReplay();
}

// ----------------------------------------------------------------------------------------------------------------------
// The canvas

export interface DawnCanvasOptions {
  size: () => { width: number; height: number };
  canvas?: unknown;
}

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
  /** The texture holds transparent black for this frame: it is new, or `clear` ran since the frame began. */
  private cleared = false;
  /** The buffer the texture is copied to: kept from frame to frame while the size is the same. */
  private readback: { buffer: Any; size: number } | null = null;
  /** What the addon holds for this canvas: the key (this thread's, this canvas's) and the newest version put. */
  private readonly key = `dawn:${threadId}:${shared.canvases++}`;
  private version = 0;
  /** The canvas as the last flush read it, null when nothing was drawn this frame. */
  picture: { width: number; height: number; source: CanvasSource } | null = null;
  /** How the rows of that picture were handed over, for `pixels`. */
  private kept: { stride: number; format: string; alphaMode: string; colorSpace: string; direct: boolean } | null = null;

  /** The renderer's scope this canvas was made in: its device, its pictures, its reports. */
  private readonly scope = shared.scope;

  constructor(private readonly options: DawnCanvasOptions) {
    this.canvas = options.canvas;
    this.scope.contexts.add(new WeakRef(this));
    this.scope.keys.add(this.key);
  }

  get drawn(): boolean {
    return this.picture !== null;
  }

  /** The page drew this frame and the read-back that makes its pixels has not run yet. */
  get readPending(): boolean {
    return this.drawnThisFrame && this.picture === null;
  }

  configure(configuration: Any): void {
    const { device } = configuration ?? {};
    if (!this.scope.devices.has(device)) throw new TypeError("configure: 'device' is not a GPUDevice");
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
    // The texture is kept from frame to frame while the size and the configuration stay (a configuration or a size change drops it), and
    // cleared at the first use in a frame: a canvas starts every frame transparent black.
    if (this.texture !== null && !this.cleared && (config.usage & RENDER_ATTACHMENT) === 0) this.dropTexture();
    if (this.texture === null || this.texture.width !== width || this.texture.height !== height) {
      this.dropTexture();
      // A new texture is transparent black.
      this.texture = config.device.createTexture({ label: 'canvas', size: [Math.max(1, width), Math.max(1, height)], format: config.format, usage: config.usage | COPY_SRC, viewFormats: config.viewFormats });
      this.cleared = true;
    } else if (!this.cleared) {
      this.clear(config.device);
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
    this.cleared = false;
    this.drawnThisFrame = false;
    this.picture = null;
  }

  /** One pass that clears the kept texture to transparent black, the engine's own use of it (not the page's). */
  private clear(device: Any): void {
    untracked(() => {
      const encoder = device.createCommandEncoder();
      encoder.beginRenderPass({ colorAttachments: [{ view: this.texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] }).end();
      device.queue.submit([encoder.finish()]);
    });
    this.cleared = true;
  }

  private dropTexture(): void {
    try {
      this.texture?.destroy();
    } catch {
      // the device is already destroyed
    }
    this.texture = null;
    this.cleared = false;
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

  /**
   * Starts reading the texture the page drew this frame back: submits the copy to the read-back buffer and starts mapping it, and returns what
   * finishes the read-back (waits for the map, hands the rows to the addon), or null when there is nothing to read.
   */
  begin(): (() => Promise<void>) | null {
    const config = this.config;
    if (config === null || !this.drawnThisFrame || this.texture === null) return null;
    const { device, format } = config;
    const width: number = this.texture.width;
    const height: number = this.texture.height;
    const wide = format === 'rgba16float';
    const rowBytes = width * (wide ? 8 : 4);
    const stride = Math.ceil(rowBytes / 256) * 256;
    if (this.readback === null || this.readback.size !== stride * height || !this.scope.devices.has(device)) {
      this.dropReadback();
      this.readback = { buffer: device.createBuffer({ label: 'canvas readback', size: stride * height, usage: 0x01 | 0x08 /* MAP_READ | COPY_DST */ }), size: stride * height };
    }
    const { buffer } = this.readback;
    let t = stamp();
    let mapped: Promise<void>;
    try {
      untracked(() => {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: this.texture }, { buffer, bytesPerRow: stride, rowsPerImage: height }, [width, height, 1]);
        device.queue.submit([encoder.finish()]);
      });
      mapped = patchOf(dawn!.globals)!.nativeMapAsync.call(buffer, 0x01);
    } catch (error) {
      this.dropReadback();
      throw error;
    }
    return async () => {
      try {
        await mapped;
        t = lap('dawn_map', t);
        this.keep(new Uint8Array(buffer.getMappedRange()), width, height, stride, format, config.alphaMode, config.colorSpace);
        lap('dawn_keep', t);
        buffer.unmap();
      } catch (error) {
        this.dropReadback();
        throw error;
      }
    };
  }

  /** Reads the texture the page drew this frame back, and hands it to the addon. */
  async flush(): Promise<void> {
    await this.begin()?.();
  }

  /**
   * The pixels the page can read of this canvas now, straight-alpha sRGB RGBA8: what the last read-back left. A canvas drawn in this
   * frame has none yet (it is read back after the frame's scripts ran), which is said; one that was not drawn is transparent.
   */
  pixels(): { rgba: Uint8Array; width: number; height: number } {
    const picture = this.picture;
    if (picture === null) {
      if (this.readPending) throw new Error(READ_PENDING);
      const { width, height } = this.options.size();
      return { rgba: new Uint8Array(Math.max(1, width) * Math.max(1, height) * 4), width: Math.max(1, width), height: Math.max(1, height) };
    }
    const { width, height, source } = picture;
    if (source.kind === 'pixels') return { rgba: new Uint8Array(Buffer.from(source.data, 'base64')), width, height };
    const rows = hasAddonFunction('getCanvasPixels') && this.kept !== null ? addonFunction('getCanvasPixels')(this.key, this.version) : null;
    if (rows === null || rows === undefined) throw new Error('copyExternalImageToTexture: the pixels of this WebGPU canvas are gone (its read-back was released)');
    const { stride, format, alphaMode, colorSpace, direct } = this.kept!;
    const bytes = new Uint8Array(rows.buffer, rows.byteOffset, rows.byteLength);
    return { rgba: direct ? toStraightSrgb(bytes, width, height, stride, format, alphaMode, colorSpace) : bytes, width, height };
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
    this.kept = { stride, format, alphaMode, colorSpace, direct };
    const changed = addonFunction('putCanvasPixels')(this.key, this.version + 1, width, height, direct ? stride : width * 4, direct && format === 'bgra8unorm', alpha, bytes);
    // The same picture as the last one put: that version is still the one to draw (its image is made already).
    if (changed) this.version += 1;
    this.picture = { width, height, source: { kind: 'stored', key: this.key, version: this.version } };
  }
}

/**
 * Reads back every canvas drawn this frame: the frame loop awaits it before it reads the tree. The copies of all the canvases are
 * submitted before the first read-back is waited for, so the GPU works on them together; their rows are handed over in the order the
 * canvases were made.
 */
export async function flushDawnCanvases(): Promise<void> {
  const finishing: (() => Promise<void>)[] = [];
  let failure: unknown;
  try {
    const { contexts } = shared.scope;
    for (const ref of contexts) {
      const context = ref.deref();
      if (context === undefined) contexts.delete(ref);
      else {
        const finish = context.begin();
        if (finish !== null) finishing.push(finish);
      }
    }
  } catch (error) {
    failure = error;
  }
  // Every started read-back is finished (or its map awaited), also after a failure: a map nobody waits for is a rejection nobody handles.
  const results = await Promise.allSettled(finishing.map((finish) => finish()));
  if (failure !== undefined) throw failure;
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}

/** On the source a Dawn canvas names: the canvas, so that `copyExternalImageToTexture` can read its pixels. */
const DAWN_CANVAS = Symbol.for('kinetograph.dawnCanvas');

/**
 * What `drawImage` of a Dawn canvas names: its read-back, which is made after the page's scripts of the frame ran, so the source is
 * written when the tree is read (`toJSON`), with the picture the read-back left.
 */
export function dawnPictureSource(context: DawnCanvasContext, width: number, height: number): CanvasSource {
  return {
    kind: 'stored', key: '', version: 0, [DAWN_CANVAS]: context,
    toJSON: () => {
      if (context.picture !== null) return context.picture.source;
      if (context.readPending) throw new Error(READ_PENDING);
      return { kind: 'canvas', width, height, commands: [] };
    },
  } as CanvasSource;
}

const READ_PENDING = "a WebGPU canvas is read back after the scripts of a frame ran, so its pixels cannot be read in the frame they are drawn in (toDataURL, toBlob, getImageData, copyExternalImageToTexture of a canvas it was drawn on); drawImage of it is drawn from the read-back, and its pixels can be read in a later callback of the frame";

/** The commands that make a Dawn canvas's pixels, for `toDataURL` and `toBlob`: what the frame's read-back left. */
export function dawnReadCommands(context: DawnCanvasContext): CanvasCommand[] {
  const commands = dawnCommandsOf(context);
  if (commands !== null) return commands;
  if (context.readPending) throw new Error(READ_PENDING);
  return [];
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
  // A WebGPU canvas of this provider: what its read-back left, from the addon's store.
  const dawnCanvas = (s as { [key: symbol]: DawnCanvasContext | undefined })[DAWN_CANVAS];
  if (dawnCanvas !== undefined) return dawnCanvas.pixels();
  if (s.kind === 'pixels') return { rgba: new Uint8Array(Buffer.from(s.data, 'base64')), width: s.width, height: s.height };
  const rgba = shared.scope.host.hooks().rasterize({ width, height, commands: [{ op: 'image', source: s, sx: 0, sy: 0, sw: width, sh: height, dx: 0, dy: 0, dw: width, dh: height, smooth: false } as CanvasCommand] });
  if (rgba === null) throw new Error('copyExternalImageToTexture: the pixels of this picture need the native addon');
  return { rgba, width, height };
}

const operationError = (message: string): Error => Object.assign(new Error(message), { name: 'OperationError' });

/** The half-float bits of each byte value / 255 (what a float16 destination holds of a channel). */
const HALF_BITS = ((): Uint16Array => {
  const out = new Uint16Array(256);
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  for (let i = 0; i < 256; i++) {
    f32[0] = i / 255;
    const x = u32[0]!;
    const exp = ((x >> 23) & 0xff) - 127;
    if (x === 0) out[i] = 0;
    else if (exp < -14) out[i] = Math.round((i / 255) / 2 ** -24); // a half subnormal
    else out[i] = (((exp + 15) << 10) | (x & 0x7fffff) >> 13) + (((x & 0x1fff) > 0x1000 || ((x & 0x1fff) === 0x1000 && (x >> 13) & 1)) ? 1 : 0);
  }
  return out;
})();

/** How a copy of RGBA8 pixels is written into each destination format: the channels it has and its bytes per pixel. */
const COPY_FORMATS: Record<string, { bytes: number; encode(rect: Uint8Array, pixels: number): Uint8Array }> = {
  rgba8unorm: { bytes: 4, encode: (rect) => rect },
  'rgba8unorm-srgb': { bytes: 4, encode: (rect) => rect },
  bgra8unorm: { bytes: 4, encode: swapped },
  'bgra8unorm-srgb': { bytes: 4, encode: swapped },
  r8unorm: { bytes: 1, encode: (rect, n) => Uint8Array.from({ length: n }, (_, i) => rect[i * 4]!) },
  rg8unorm: { bytes: 2, encode: (rect, n) => Uint8Array.from({ length: n * 2 }, (_, i) => rect[(i >> 1) * 4 + (i & 1)]!) },
  r16float: { bytes: 2, encode: (rect, n) => halves(rect, n, 1) },
  rg16float: { bytes: 4, encode: (rect, n) => halves(rect, n, 2) },
  rgba16float: { bytes: 8, encode: (rect, n) => halves(rect, n, 4) },
  r32float: { bytes: 4, encode: (rect, n) => floats(rect, n, 1) },
  rg32float: { bytes: 8, encode: (rect, n) => floats(rect, n, 2) },
  rgba32float: { bytes: 16, encode: (rect, n) => floats(rect, n, 4) },
  rgb10a2unorm: {
    bytes: 4,
    encode: (rect, n) => {
      const out = new Uint32Array(n);
      for (let i = 0; i < n; i++) out[i] = (Math.round((rect[i * 4]! / 255) * 1023) | (Math.round((rect[i * 4 + 1]! / 255) * 1023) << 10) | (Math.round((rect[i * 4 + 2]! / 255) * 1023) << 20) | (Math.round((rect[i * 4 + 3]! / 255) * 3) << 30)) >>> 0;
      return new Uint8Array(out.buffer);
    },
  },
};

function swapped(rect: Uint8Array): Uint8Array {
  const out = new Uint8Array(rect.length);
  for (let i = 0; i < rect.length; i += 4) {
    out[i] = rect[i + 2]!;
    out[i + 1] = rect[i + 1]!;
    out[i + 2] = rect[i]!;
    out[i + 3] = rect[i + 3]!;
  }
  return out;
}

function halves(rect: Uint8Array, pixels: number, channels: number): Uint8Array {
  const out = new Uint16Array(pixels * channels);
  for (let i = 0; i < pixels; i++) for (let c = 0; c < channels; c++) out[i * channels + c] = HALF_BITS[rect[i * 4 + c]!]!;
  return new Uint8Array(out.buffer);
}

function floats(rect: Uint8Array, pixels: number, channels: number): Uint8Array {
  const out = new Float32Array(pixels * channels);
  for (let i = 0; i < pixels; i++) for (let c = 0; c < channels; c++) out[i * channels + c] = rect[i * 4 + c]! / 255;
  return new Uint8Array(out.buffer);
}

/** An unsigned integer the WebGPU way (a negative or fractional number is a TypeError, as the IDL's [EnforceRange] makes it). */
function unsigned(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new TypeError(`copyExternalImageToTexture: ${name} is not an unsigned integer (${String(value)})`);
  return value;
}

function copyExternalImage(queue: Any, source: Any, destination: Any, size: Any): void {
  const origin = source.origin ?? [0, 0];
  const ox = unsigned('origin.x', Array.isArray(origin) ? origin[0] ?? 0 : origin.x ?? 0);
  const oy = unsigned('origin.y', Array.isArray(origin) ? origin[1] ?? 0 : origin.y ?? 0);
  const copy = Array.isArray(size) ? size : [size.width, size.height ?? 1, size.depthOrArrayLayers ?? 1];
  const [w, h, layers] = [unsigned('copySize.width', copy[0]), unsigned('copySize.height', copy[1] ?? 1), unsigned('copySize.depthOrArrayLayers', copy[2] ?? 1)];
  const format: string = destination.texture.format;
  const encoding = COPY_FORMATS[format];
  if (encoding === undefined) throw new TypeError(`copyExternalImageToTexture: the destination format ${format} is not supported here (${Object.keys(COPY_FORMATS).join(', ')} are)`);
  const { rgba, width, height } = pictureBytes(source.source);
  // The source rectangle must lie inside the source, and a source is one image: the spec's OperationError, not a rectangle of zeros.
  if (ox + w > width || oy + h > height) throw operationError(`copyExternalImageToTexture: the source rectangle (${ox}, ${oy}) ${w}x${h} is outside the ${width}x${height} source`);
  if (layers > 1) throw operationError('copyExternalImageToTexture: copySize.depthOrArrayLayers is more than 1 (a source is one image)');
  const premultiply = destination.premultipliedAlpha === true;
  // The whole picture, as it is (no flip, no premultiplication, no origin): the pixels written are the pixels rasterised, not a copy of them.
  const rect = !source.flipY && !premultiply && ox === 0 && oy === 0 && w === width && h === height && rgba.length === w * h * 4 ? rgba : new Uint8Array(w * h * 4);
  for (let y = 0; y < h && rect !== rgba; y++) {
    const sy = source.flipY ? oy + h - 1 - y : oy + y;
    for (let x = 0; x < w; x++) {
      const si = ((sy * width) + ox + x) * 4;
      const di = (y * w + x) * 4;
      const a = rgba[si + 3]!;
      rect[di] = premultiply ? Math.round((rgba[si]! * a) / 255) : rgba[si]!;
      rect[di + 1] = premultiply ? Math.round((rgba[si + 1]! * a) / 255) : rgba[si + 1]!;
      rect[di + 2] = premultiply ? Math.round((rgba[si + 2]! * a) / 255) : rgba[si + 2]!;
      rect[di + 3] = a;
    }
  }
  queue.writeTexture({ texture: destination.texture, mipLevel: destination.mipLevel ?? 0, origin: destination.origin ?? [0, 0, 0], aspect: destination.aspect }, encoding.encode(rect, w * h), { bytesPerRow: w * encoding.bytes, rowsPerImage: h }, [w, h, 1]);
}
