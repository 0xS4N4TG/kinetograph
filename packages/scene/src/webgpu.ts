// `navigator.gpu` and `GPUCanvasContext` that record instead of rasterising (packages/cli/skills/kinetograph-markup/references/ENGINE.md,
// "WebGPU"). A page's WebGPU code runs against these objects; the render passes it submits to a canvas become the
// `webgpu` part of a `glsl` layer (`WebGpuContent`), and the renderer replays them on its own wgpu device with the page's
// own WGSL. Nothing here reads a clock or anything outside the calls.
//
// The slice drawn is what shader pages use: one device, uniform / storage / vertex / index buffers, WGSL modules, bind
// group layouts, render and compute pipelines, bind groups, command encoders with render passes into the canvas's texture
// or into a 2D texture and compute passes (`dispatchWorkgroups`), `draw` and `drawIndexed`, `writeBuffer`, and textures:
// `createTexture` (storage textures included), `createView`, `createSampler`, `writeTexture`, `copyExternalImageToTexture`,
// `copyBufferToTexture`, `copyTextureToTexture`; a depth attachment (`depth16unorm`, `depth24plus`, `depth32float`) with depth
// state and comparison samplers; multisampled passes; render bundles (their commands run in the pass that executes them). Indirect calls, the stencil, several colour
// attachments and reading anything back are not recorded: the call throws `WebGpuUnsupportedError` and the frame reports it
// (`WebGpuContent.notes`). Query sets are accepted and measure nothing (`webgpu-queries.ts`).
//
// A buffer's bytes are shadowed here, and a submit snapshots the ones its passes only read, so a frame's recording holds
// everything it needs and is the same whichever frames were drawn before it. A buffer a pass writes (a read-write storage
// binding) and a texture are not shadowed: each is the steps that wrote it, in order (a render or compute pass, a
// `writeBuffer`, a `writeTexture`, a copy), which the device keeps for as long as a later frame may read the result. A step
// that writes a whole level or buffer drops the earlier steps that only it made visible, so the log of a page that redraws
// its textures every frame stays as long as one frame; a frame's recording holds only the steps its picture depends on, and
// reports (`WebGpuContent.impure`) the ones that an earlier frame made.

import type {
  CanvasSource,
  GlslContent,
  WebGpuBindEntry,
  WebGpuBindGroup,
  WebGpuBindingLayout,
  WebGpuCommand,
  WebGpuComputeCommand,
  WebGpuComputePipeline,
  WebGpuContent,
  WebGpuDepthState,
  WebGpuPass,
  WebGpuPipeline,
  WebGpuSampler,
  WebGpuSource,
  WebGpuStep,
  WebGpuTexture,
} from './types.js';
import { pictureOf } from './canvas.js';
import { ErrorScopes, GPUErrorShim, GPUValidationErrorShim, MAX_ERRORS, reporting } from './webgpu-errors.js';
import { checkTimestampWrites, GPUQuerySetShim, OcclusionQueries, queryIn, type QuerySetDescriptor } from './webgpu-queries.js';
import { hashOf, LAYER_SOURCE, toBase64 } from './webgl.js';

/** Thrown by a call the engine does not draw. The message starts with "unsupported:". */
export class WebGpuUnsupportedError extends Error {
  override name = 'WebGpuUnsupportedError';
  constructor(what: string) {
    super(`unsupported: ${what} (packages/cli/skills/kinetograph-markup/references/ENGINE.md, "WebGPU")`);
  }
}

/** The method a `<video>` answers `copyExternalImageToTexture` with: the file and the instant its frame is of. */
export const VIDEO_FRAME: unique symbol = Symbol.for('kinetograph.videoFrame');

export interface VideoFrameSource {
  /** The path the renderer opens, as the page's `src` names it in the project. */
  src: string;
  /** Seconds after the first picture (`video.currentTime`). */
  time: number;
  width: number;
  height: number;
}

export const GPU_BUFFER_USAGE = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
export const GPU_TEXTURE_USAGE = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
export const GPU_SHADER_STAGE = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
export const GPU_MAP_MODE = { READ: 1, WRITE: 2 };
export const GPU_COLOR_WRITE = { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 };

/** The globals a WebGPU page reads (`GPUBufferUsage.UNIFORM`). */
export const GPU_GLOBALS: Record<string, unknown> = {
  GPUBufferUsage: GPU_BUFFER_USAGE,
  GPUTextureUsage: GPU_TEXTURE_USAGE,
  GPUShaderStage: GPU_SHADER_STAGE,
  GPUMapMode: GPU_MAP_MODE,
  GPUColorWrite: GPU_COLOR_WRITE,
};

/** The most a buffer may hold, and the most all of them together may. */
const MAX_BUFFER_SIZE = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
/**
 * The most all the textures of a device may hold, all levels together (the renderer refuses a frame over the same,
 * `webgpu::max_texture_bytes`): three of the biggest textures the device's limits allow (`rgba32float` with every
 * level), 4 GiB at the default 8192. WebGPU itself has no such cap (Chrome made 4 GiB of textures on the M4 without an
 * error); the renderer keeps one because each worker makes a frame's textures anew.
 */
export const maxTextureBytes = (maxTextureDimension2D: number): number => 64 * maxTextureDimension2D * maxTextureDimension2D;
/** The most steps a device keeps for later frames. */
const MAX_STEPS = 4096;
/** The most dispatches, and the most workgroups all of them launch, in what a frame's picture depends on (the renderer refuses a frame over the same). */
const MAX_DISPATCHES = 4096;
const MAX_WORKGROUPS = 2 ** 26;

/** The WebGPU default limits. */
const LIMITS: Record<string, number> = {
  maxTextureDimension1D: 8192,
  maxTextureDimension2D: 8192,
  maxTextureDimension3D: 2048,
  maxTextureArrayLayers: 256,
  maxBindGroups: 4,
  maxBindGroupsPlusVertexBuffers: 24,
  maxBindingsPerBindGroup: 1000,
  maxDynamicUniformBuffersPerPipelineLayout: 8,
  maxDynamicStorageBuffersPerPipelineLayout: 4,
  maxSampledTexturesPerShaderStage: 16,
  maxSamplersPerShaderStage: 16,
  maxStorageBuffersPerShaderStage: 8,
  maxStorageTexturesPerShaderStage: 4,
  maxUniformBuffersPerShaderStage: 12,
  maxUniformBufferBindingSize: 65536,
  maxStorageBufferBindingSize: 134217728,
  minUniformBufferOffsetAlignment: 256,
  minStorageBufferOffsetAlignment: 256,
  maxVertexBuffers: 8,
  maxBufferSize: MAX_BUFFER_SIZE,
  maxVertexAttributes: 16,
  maxVertexBufferArrayStride: 2048,
  maxInterStageShaderVariables: 16,
  maxColorAttachments: 8,
  maxColorAttachmentBytesPerSample: 32,
  maxComputeWorkgroupStorageSize: 16384,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupSizeY: 256,
  maxComputeWorkgroupSizeZ: 64,
  maxComputeWorkgroupsPerDimension: 65535,
};

const CANVAS_FORMATS = new Set(['rgba8unorm', 'bgra8unorm', 'rgba16float']);

type Sample = 'float' | 'unfilterable-float' | 'uint' | 'sint' | 'depth';

interface FormatInfo {
  /** The bytes of a texel. */
  bytes: number;
  /** How a shader samples it. */
  sample: Sample;
  /** The storage access a storage texture of the format may have (the optional formats and features are not offered). */
  storage: 'none' | 'write' | 'readwrite';
}

const format = (bytes: number, sample: Sample, storage: FormatInfo['storage'] = 'none'): FormatInfo => ({ bytes, sample, storage });

/** The texture formats that are drawn (WebGPU's table, without the optional features and the stencil and compressed formats). */
const FORMATS: Record<string, FormatInfo> = {
  r8unorm: format(1, 'float'),
  r8uint: format(1, 'uint'),
  r8sint: format(1, 'sint'),
  rg8unorm: format(2, 'float'),
  rg8uint: format(2, 'uint'),
  rg8sint: format(2, 'sint'),
  rgba8unorm: format(4, 'float', 'write'),
  'rgba8unorm-srgb': format(4, 'float'),
  rgba8snorm: format(4, 'float', 'write'),
  rgba8uint: format(4, 'uint', 'write'),
  rgba8sint: format(4, 'sint', 'write'),
  bgra8unorm: format(4, 'float'),
  'bgra8unorm-srgb': format(4, 'float'),
  rgb10a2unorm: format(4, 'float'),
  r16uint: format(2, 'uint'),
  r16sint: format(2, 'sint'),
  r16float: format(2, 'float'),
  rg16uint: format(4, 'uint'),
  rg16sint: format(4, 'sint'),
  rg16float: format(4, 'float'),
  rgba16uint: format(8, 'uint', 'write'),
  rgba16sint: format(8, 'sint', 'write'),
  rgba16float: format(8, 'float', 'write'),
  r32uint: format(4, 'uint', 'readwrite'),
  r32sint: format(4, 'sint', 'readwrite'),
  r32float: format(4, 'unfilterable-float', 'readwrite'),
  rg32uint: format(8, 'uint', 'write'),
  rg32sint: format(8, 'sint', 'write'),
  rg32float: format(8, 'unfilterable-float', 'write'),
  rgba32uint: format(16, 'uint', 'write'),
  rgba32sint: format(16, 'sint', 'write'),
  rgba32float: format(16, 'unfilterable-float', 'write'),
  depth16unorm: format(2, 'depth'),
  depth24plus: format(4, 'depth'),
  depth32float: format(4, 'depth'),
};
/** The depth formats (without stencil): a render pass's depth attachment, and a texture a shader samples as depth. */
const DEPTH_FORMATS = new Set(['depth16unorm', 'depth24plus', 'depth32float']);
const COMPARE_FUNCTIONS = new Set(['never', 'less', 'equal', 'less-equal', 'greater', 'not-equal', 'greater-equal', 'always']);
const FORMAT_NAMES = Object.keys(FORMATS).join(', ');
/** The formats a picture may be copied into. */
const PICTURE_FORMATS = new Set(['rgba8unorm', 'rgba8unorm-srgb', 'bgra8unorm', 'bgra8unorm-srgb']);

type Bytes = Uint8Array;

function asBytes(data: unknown, dataOffset: number | undefined, size: number | undefined): Bytes {
  if (ArrayBuffer.isView(data)) {
    const unit = (data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
    const start = data.byteOffset + (dataOffset ?? 0) * unit;
    const length = size === undefined ? data.byteLength - (dataOffset ?? 0) * unit : size * unit;
    return new Uint8Array(data.buffer, start, length);
  }
  if (data instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer)) {
    const start = dataOffset ?? 0;
    return new Uint8Array(data, start, size === undefined ? data.byteLength - start : size);
  }
  throw new TypeError('data is not an ArrayBuffer or a view of one');
}

function range(name: string, ok: boolean): void {
  if (!ok) throw new RangeError(`OperationError: ${name} is out of range`);
}

/** A whole number from `min` up, as the numbers of a descriptor must be. */
function whole(call: string, name: string, value: unknown, min = 0): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new RangeError(`OperationError: ${call}: ${name} ${String(value)} is not a whole number from ${min}`);
  return n;
}

// ---- resources ----

class GpuObject {
  label: string;
  constructor(label: unknown) {
    this.label = typeof label === 'string' ? label : '';
  }
}

/** What a recorded frame is made of, kept apart for each step so that a step brings what it uses. */
interface Tables {
  modules: Map<string, string>;
  layouts: Map<string, WebGpuBindingLayout[]>;
  pipelines: Map<string, WebGpuPipeline>;
  computePipelines: Map<string, WebGpuComputePipeline>;
  buffers: Map<string, string>;
  gpuBuffers: Map<string, { size: number }>;
  bindGroups: Map<string, WebGpuBindGroup>;
  samplers: Map<string, WebGpuSampler>;
  blobs: Map<string, string>;
}

function newTables(): Tables {
  return { modules: new Map(), layouts: new Map(), pipelines: new Map(), computePipelines: new Map(), buffers: new Map(), gpuBuffers: new Map(), bindGroups: new Map(), samplers: new Map(), blobs: new Map() };
}

/** Bytes written into a texture: an id made from the content, so that the same bytes are kept once. */
function blobOf(tables: Tables, bytes: Bytes): string {
  const base64 = toBase64(bytes);
  const id = `d${hashOf(base64)}${bytes.length.toString(16)}`;
  tables.blobs.set(id, base64);
  return id;
}

export class GPUBufferShim extends GpuObject {
  readonly size: number;
  readonly usage: number;
  /** `mapped` from `createBuffer({ mappedAtCreation })` until `unmap`; no buffer is mapped otherwise (`mapAsync` is not available). */
  mapState: 'mapped' | 'unmapped' = 'unmapped';
  /** What `getMappedRange` gave out, which `unmap` copies into the buffer and detaches. */
  private mapping: ArrayBuffer | null = null;
  /** The bytes as the queue has them (shadow of the GPU's) until a pass writes the buffer; after that, the bytes it was given by then. */
  readonly data: Bytes;
  version = 0;
  /** Set once a pass writes the buffer (`device.promote`): `B<n>`, the id of its steps; its contents are then the steps that wrote it. */
  gpuId: string | null = null;
  readonly uid: number;
  private snapshotted: { version: number; id: string } | null = null;
  private destroyed = false;
  constructor(
    private readonly device: GPUDeviceShim,
    descriptor: { size: number; usage: number; label?: string; mappedAtCreation?: boolean },
  ) {
    super(descriptor.label);
    const size = Number(descriptor.size);
    if (!Number.isInteger(size) || size < 0 || size > MAX_BUFFER_SIZE) throw new RangeError(`createBuffer: size ${descriptor.size} is not supported (at most ${MAX_BUFFER_SIZE} bytes)`);
    if (size > device.limits.maxBufferSize!) throw new RangeError(`OperationError: createBuffer: size ${size} is over the device's maxBufferSize ${device.limits.maxBufferSize}`);
    if (!Number.isInteger(Number(descriptor.usage)) || Number(descriptor.usage) <= 0 || Number(descriptor.usage) > 1023) throw new RangeError(`OperationError: createBuffer: usage ${String(descriptor.usage)} is not a combination of GPUBufferUsage flags`);
    device.reserve(size);
    this.uid = device.nextBufferId();
    this.size = size;
    this.usage = Number(descriptor.usage);
    this.data = new Uint8Array(size);
    if (descriptor.mappedAtCreation) {
      if (size % 4 !== 0) throw new RangeError('OperationError: createBuffer: a buffer mapped at creation has a size that is a multiple of 4');
      this.mapState = 'mapped';
    }
  }
  /** The id of the bytes now in the buffer, which `into` then holds (base64). */
  snapshot(into: Map<string, string>): string {
    if (this.snapshotted === null || this.snapshotted.version !== this.version) {
      const base64 = toBase64(this.data);
      this.snapshotted = { version: this.version, id: `b${hashOf(base64)}` };
      into.set(this.snapshotted.id, base64);
    } else if (!into.has(this.snapshotted.id)) {
      into.set(this.snapshotted.id, toBase64(this.data));
    }
    return this.snapshotted.id;
  }
  write(offset: number, bytes: Bytes): void {
    this.data.set(bytes, offset);
    this.version += 1;
  }
  /** The buffer's bytes are made by the GPU: no snapshot stands for it. */
  get gpu(): boolean {
    return this.gpuId !== null;
  }
  /** The key the log tracks the buffer by. */
  get key(): string {
    return `B${this.uid}`;
  }
  mapAsync(): never {
    throw new WebGpuUnsupportedError('buffer.mapAsync; reading a buffer back');
  }
  /** The whole buffer, to write: only a buffer made with `mappedAtCreation` is mapped. */
  getMappedRange(offset = 0, size?: number): ArrayBuffer {
    if (this.mapState !== 'mapped') throw new DOMException('OperationError: getMappedRange: the buffer is not mapped', 'OperationError');
    if (offset !== 0 || (size !== undefined && size !== this.size)) throw new WebGpuUnsupportedError('buffer.getMappedRange of part of the buffer; map the whole of it');
    this.mapping ??= new ArrayBuffer(this.size);
    return this.mapping;
  }
  /** What was written into the mapped range becomes the buffer's bytes, and the range is detached, as in a browser. */
  unmap(): void {
    if (this.mapState !== 'mapped') return;
    this.mapState = 'unmapped';
    if (this.mapping !== null) {
      this.write(0, new Uint8Array(this.mapping));
      structuredClone(this.mapping, { transfer: [this.mapping] });
      this.mapping = null;
    }
  }
  destroy(): void {
    if (!this.destroyed) {
      this.destroyed = true;
      this.device.release(this.size);
      if (this.gpu) this.device.forget(this);
    }
  }
}

export class GPUShaderModuleShim extends GpuObject {
  readonly code: string;
  readonly id: string;
  /** The `group:binding` of each binding the WGSL writes. */
  readonly written: Map<string, 'buffer' | 'texture'>;
  /** The groups the WGSL names. */
  readonly groups: Set<number>;
  constructor(descriptor: { code: string; label?: string }) {
    super(descriptor.label);
    if (typeof descriptor.code !== 'string') throw new TypeError('createShaderModule: code must be a string');
    this.code = descriptor.code;
    this.id = `m${hashOf(descriptor.code)}`;
    this.written = writtenBindings(descriptor.code);
    this.groups = new Set([...descriptor.code.matchAll(/@group\(\s*(\d+)\s*\)/g)].map((m) => Number(m[1])));
  }
  getCompilationInfo(): Promise<{ messages: unknown[] }> {
    return Promise.resolve({ messages: [] });
  }
}

export class GPUBindGroupLayoutShim extends GpuObject {
  /** `auto:<pipeline>:<index>` for a layout a pipeline made, else the id made from its entries. */
  readonly id: string;
  /** Of an automatic layout: the bindings of the group its pipeline's shader writes, read from the WGSL. */
  readonly written: Map<number, 'buffer' | 'texture'>;
  constructor(readonly entries: WebGpuBindingLayout[], auto?: { pipeline: string; index: number; written: Map<number, 'buffer' | 'texture'> }) {
    super('');
    this.id = auto === undefined ? `l${hashOf(JSON.stringify(entries))}` : `auto:${auto.pipeline}:${auto.index}`;
    this.written = auto?.written ?? new Map();
  }
  /** Whether the shader writes what is bound at `binding`. */
  writes(binding: number): 'buffer' | 'texture' | null {
    if (this.id.startsWith('auto:')) return this.written.get(binding) ?? null;
    const entry = this.entries.find((e) => e.binding === binding);
    if (entry === undefined) return null;
    if (entry.type === 'storage') return 'buffer';
    if (entry.type === 'storage-texture' && entry.access !== 'read-only') return 'texture';
    return null;
  }
}

/**
 * What the WGSL of a module says about its bindings, by a scan of the text (a layout: 'auto' pipeline has no entries to
 * read them from): the bindings a shader writes, as `group:binding`. An attribute order of `@group @binding` or the
 * reverse, and `var<storage, read_write>` or a `texture_storage_2d<format, write | read_write>`.
 */
function writtenBindings(code: string): Map<string, 'buffer' | 'texture'> {
  const found = new Map<string, 'buffer' | 'texture'>();
  const attrs = String.raw`@(?:group\(\s*(\d+)\s*\)\s*@binding\(\s*(\d+)\s*\)|binding\(\s*(\d+)\s*\)\s*@group\(\s*(\d+)\s*\))`;
  const buffer = new RegExp(`${attrs}\\s*var\\s*<\\s*storage\\s*,\\s*read_write\\s*>`, 'g');
  const texture = new RegExp(`${attrs}\\s*var\\s+\\w+\\s*:\\s*texture_storage_2d\\s*<\\s*\\w+\\s*,\\s*(?:write|read_write)\\s*>`, 'g');
  for (const [re, kind] of [[buffer, 'buffer'], [texture, 'texture']] as const) {
    for (const m of code.matchAll(re)) found.set(`${m[1] ?? m[4]}:${m[2] ?? m[3]}`, kind);
  }
  return found;
}

/**
 * The `@workgroup_size` of the compute entry point `entryPoint` (the only one, when it is not named), if it is written
 * with number literals; null when the module does not say, or says it with a constant or an override.
 */
function workgroupSize(code: string, entryPoint: string | undefined): [number, number, number] | null {
  const found: { name: string; size: [number, number, number] | null }[] = [];
  for (const m of code.matchAll(/((?:@\w+(?:\([^)]*\))?\s*)+)fn\s+(\w+)/g)) {
    if (!/@compute\b/.test(m[1]!)) continue;
    const args = /@workgroup_size\(([^)]*)\)/.exec(m[1]!)?.[1];
    let size: [number, number, number] | null = null;
    if (args !== undefined) {
      const parts = args.split(',').map((x) => x.trim()).filter((x) => x !== '');
      const numbers = parts.map((x) => (/^\d+[ui]?$/.test(x) ? Number(x.replace(/[ui]$/, '')) : NaN));
      if (numbers.length >= 1 && numbers.length <= 3 && numbers.every((n) => Number.isInteger(n) && n >= 0)) size = [numbers[0]!, numbers[1] ?? 1, numbers[2] ?? 1];
    }
    found.push({ name: m[2]!, size });
  }
  const entry = entryPoint === undefined ? (found.length === 1 ? found[0] : undefined) : found.find((f) => f.name === entryPoint);
  return entry?.size ?? null;
}

export class GPUPipelineLayoutShim extends GpuObject {
  constructor(readonly layouts: GPUBindGroupLayoutShim[]) {
    super('');
  }
}

export class GPURenderPipelineShim extends GpuObject {
  readonly id: string;
  constructor(
    readonly descriptor: WebGpuPipeline,
    readonly modules: GPUShaderModuleShim[],
    readonly layouts: GPUBindGroupLayoutShim[] | null,
  ) {
    super('');
    this.id = `p${hashOf(JSON.stringify(descriptor))}`;
  }
  getBindGroupLayout(index: number): GPUBindGroupLayoutShim {
    if (this.layouts !== null) {
      const layout = this.layouts[index];
      if (layout === undefined) throw new RangeError(`getBindGroupLayout: no bind group ${index}`);
      return layout;
    }
    return autoLayout(this.id, index, this.modules);
  }
}

/** The layout a `layout: 'auto'` pipeline has for group `index`. */
function autoLayout(pipeline: string, index: number, modules: GPUShaderModuleShim[]): GPUBindGroupLayoutShim {
  if (!Number.isInteger(index) || index < 0 || index >= 4) throw new RangeError(`OperationError: getBindGroupLayout: no bind group ${String(index)}`);
  const written = new Map<number, 'buffer' | 'texture'>();
  for (const module of modules) {
    for (const [key, kind] of module.written) {
      const [group, binding] = key.split(':').map(Number);
      if (group === index) written.set(binding!, kind);
    }
  }
  return new GPUBindGroupLayoutShim([], { pipeline, index, written });
}

export class GPUComputePipelineShim extends GpuObject {
  readonly id: string;
  constructor(
    readonly descriptor: WebGpuComputePipeline,
    readonly module: GPUShaderModuleShim,
    readonly layouts: GPUBindGroupLayoutShim[] | null,
    readonly workgroupSize: [number, number, number] | null,
  ) {
    super('');
    this.id = `c${hashOf(JSON.stringify(descriptor))}`;
  }
  getBindGroupLayout(index: number): GPUBindGroupLayoutShim {
    if (this.layouts !== null) {
      const layout = this.layouts[index];
      if (layout === undefined) throw new RangeError(`getBindGroupLayout: no bind group ${index}`);
      return layout;
    }
    return autoLayout(this.id, index, [this.module]);
  }
}

/** What `createSampler` made: the descriptor with the defaults left out, so that the same sampler has the same id. */
export class GPUSamplerShim extends GpuObject {
  readonly id: string;
  constructor(readonly descriptor: WebGpuSampler) {
    super('');
    this.id = `s${hashOf(JSON.stringify(descriptor))}`;
  }
}

/** A range of the levels and array layers of a texture: what a shader binds, and what a pass draws into. */
export class GPUTextureViewShim extends GpuObject {
  constructor(
    readonly texture: GPUTextureShim,
    readonly baseMip: number,
    readonly mips: number,
    readonly baseLayer = 0,
    readonly layers = 1,
    /** `2d-array` is a view of an array (of one layer or more); `2d` is one layer; `cube` is six layers (a multiple of six for `cube-array`). */
    readonly dimension: '2d' | '2d-array' | 'cube' | 'cube-array' = '2d',
  ) {
    super('');
  }
  /** The `levelKey` of each level and layer the view holds. */
  keys(): string[] {
    const keys: string[] = [];
    for (let level = this.baseMip; level < this.baseMip + this.mips; level += 1) {
      for (let layer = this.baseLayer; layer < this.baseLayer + this.layers; layer += 1) keys.push(levelKey(this.texture, level, layer));
    }
    return keys;
  }
  /** Whether the view holds this level and layer of its texture. */
  holds(texture: GPUTextureShim, mip: number, layer: number): boolean {
    return this.texture === texture && mip >= this.baseMip && mip < this.baseMip + this.mips && layer >= this.baseLayer && layer < this.baseLayer + this.layers;
  }
}

type SamplerDescriptor = {
  addressModeU?: string;
  addressModeV?: string;
  addressModeW?: string;
  magFilter?: string;
  minFilter?: string;
  mipmapFilter?: string;
  lodMinClamp?: number;
  lodMaxClamp?: number;
  compare?: string;
  maxAnisotropy?: number;
  label?: string;
};

const ADDRESS_MODES = new Set(['clamp-to-edge', 'repeat', 'mirror-repeat']);
const FILTERS = new Set(['nearest', 'linear']);

type BindResource = { buffer: GPUBufferShim; offset?: number; size?: number } | GPUTextureViewShim | GPUSamplerShim;

export class GPUBindGroupShim extends GpuObject {
  constructor(
    readonly layout: GPUBindGroupLayoutShim,
    readonly entries: ({ binding: number; buffer: GPUBufferShim; offset: number; size: number } | { binding: number; view: GPUTextureViewShim } | { binding: number; sampler: GPUSamplerShim })[],
  ) {
    super('');
  }
}

export class GPUCommandBufferShim extends GpuObject {
  constructor(readonly items: EncodedItem[]) {
    super('');
  }
}

// ---- textures ----

/** A rectangle `width` x `height` at `x`, `y`: every number whole, and the rectangle inside `bounds`. */
function rectIn(call: string, what: string, bounds: { width: number; height: number }, x: number, y: number, width: number, height: number): void {
  if (x + width > bounds.width || y + height > bounds.height) {
    throw new RangeError(`OperationError: ${call}: the ${what} ${x},${y} ${width} x ${height} is outside the ${bounds.width} x ${bounds.height} it is in`);
  }
}

function sizeOf(call: string, value: unknown): { width: number; height: number; depth: number } {
  if (Array.isArray(value)) {
    return { width: whole(call, 'width', value[0], 0), height: whole(call, 'height', value[1] ?? 1, 0), depth: whole(call, 'depthOrArrayLayers', value[2] ?? 1, 0) };
  }
  const v = (value ?? {}) as { width?: unknown; height?: unknown; depthOrArrayLayers?: unknown };
  if (v.width === undefined) throw new TypeError(`${call}: size needs a width`);
  return { width: whole(call, 'width', v.width, 0), height: whole(call, 'height', v.height ?? 1, 0), depth: whole(call, 'depthOrArrayLayers', v.depthOrArrayLayers ?? 1, 0) };
}

function originOf(call: string, value: unknown): { x: number; y: number; z: number } {
  if (value === undefined || value === null) return { x: 0, y: 0, z: 0 };
  if (Array.isArray(value)) return { x: whole(call, 'origin x', value[0] ?? 0, 0), y: whole(call, 'origin y', value[1] ?? 0, 0), z: whole(call, 'origin z', value[2] ?? 0, 0) };
  const v = value as { x?: unknown; y?: unknown; z?: unknown };
  return { x: whole(call, 'origin x', v.x ?? 0, 0), y: whole(call, 'origin y', v.y ?? 0, 0), z: whole(call, 'origin z', v.z ?? 0, 0) };
}

/** `1 + floor(log2(max side))`: the most levels a texture of this size has. */
function mostMips(width: number, height: number): number {
  return 32 - Math.clz32(Math.max(width, height, 1));
}

/**
 * A 2D texture or an array of them (`depthOrArrayLayers`), or the canvas's texture of this frame (`canvas` set). The
 * canvas's may only be drawn into by a render pass; the others are what the steps that wrote them make.
 */
export class GPUTextureShim extends GpuObject {
  readonly dimension = '2d';
  readonly uid: number;
  readonly bytes: number;
  destroyed = false;
  constructor(
    readonly device: GPUDeviceShim,
    readonly canvas: GPUCanvasContextShim | null,
    readonly width: number,
    readonly height: number,
    readonly format: string,
    readonly usage: number,
    readonly mipLevelCount: number,
    label?: string,
    /** 1, or 4 for a multisampled texture: one a pass draws into and resolves into another. */
    readonly sampleCount = 1,
    readonly depthOrArrayLayers = 1,
  ) {
    super(label);
    this.uid = canvas === null ? device.nextTextureId() : 0;
    this.bytes = 0;
    if (canvas === null) {
      let total = 0;
      for (let level = 0; level < mipLevelCount; level += 1) total += Math.max(1, width >> level) * Math.max(1, height >> level) * (FORMATS[format]?.bytes ?? 4);
      this.bytes = total * sampleCount * depthOrArrayLayers;
      device.reserveTexture(total * depthOrArrayLayers);
    }
  }
  get id(): string {
    return `t${this.uid}`;
  }
  /** The size of level `level`. */
  extent(level: number): { width: number; height: number } {
    return { width: Math.max(1, this.width >> level), height: Math.max(1, this.height >> level) };
  }
  get texelBytes(): number {
    return FORMATS[this.format]?.bytes ?? 4;
  }
  createView(descriptor: { format?: string; dimension?: string; aspect?: string; baseMipLevel?: number; mipLevelCount?: number; baseArrayLayer?: number; arrayLayerCount?: number } = {}): GPUTextureViewShim {
    const d = descriptor ?? {};
    if (d.format !== undefined && d.format !== this.format) throw this.device.unsupported(`a texture view of format ${d.format} on a ${this.format} texture`);
    const dimension = d.dimension ?? (this.depthOrArrayLayers > 1 ? '2d-array' : '2d');
    if (dimension !== '2d' && dimension !== '2d-array' && dimension !== 'cube' && dimension !== 'cube-array') throw this.device.unsupported(`a texture view of dimension ${dimension}`);
    const isCube = dimension === 'cube' || dimension === 'cube-array';
    if (isCube && this.width !== this.height) throw new TypeError(`createView: a ${dimension} view needs a square texture, this one is ${this.width} x ${this.height}`);
    if (d.aspect !== undefined && d.aspect !== 'all' && !(d.aspect === 'depth-only' && DEPTH_FORMATS.has(this.format))) throw this.device.unsupported(`a texture view of the aspect ${d.aspect}`);
    const baseLayer = whole('createView', 'baseArrayLayer', d.baseArrayLayer ?? 0, 0);
    if (baseLayer >= this.depthOrArrayLayers) throw new RangeError(`OperationError: createView: baseArrayLayer ${baseLayer} of a texture with ${this.depthOrArrayLayers} layers`);
    const layers = d.arrayLayerCount === undefined ? (dimension === '2d' ? 1 : dimension === 'cube' ? 6 : this.depthOrArrayLayers - baseLayer) : whole('createView', 'arrayLayerCount', d.arrayLayerCount, 1);
    if (baseLayer + layers > this.depthOrArrayLayers) throw new RangeError(`OperationError: createView: layers ${baseLayer}..${baseLayer + layers} of a texture with ${this.depthOrArrayLayers}`);
    if (dimension === '2d' && layers !== 1) throw new RangeError('OperationError: createView: a 2d view has one layer; use dimension 2d-array for more');
    if (dimension === 'cube' && layers !== 6) throw new RangeError(`OperationError: createView: a cube view has six layers, not ${layers}`);
    if (dimension === 'cube-array' && layers % 6 !== 0) throw new RangeError(`OperationError: createView: a cube-array view has a multiple of six layers, not ${layers}`);
    const base = whole('createView', 'baseMipLevel', d.baseMipLevel ?? 0, 0);
    if (base >= this.mipLevelCount) throw new RangeError(`OperationError: createView: baseMipLevel ${base} of a texture with ${this.mipLevelCount} levels`);
    const count = d.mipLevelCount === undefined ? this.mipLevelCount - base : whole('createView', 'mipLevelCount', d.mipLevelCount, 1);
    if (base + count > this.mipLevelCount) throw new RangeError(`OperationError: createView: levels ${base}..${base + count} of a texture with ${this.mipLevelCount}`);
    return new GPUTextureViewShim(this, base, count, baseLayer, layers, dimension);
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.canvas === null) {
      this.device.releaseTexture(this.bytes);
      this.device.forget(this);
    }
  }
}

// ---- encoding ----

/** A level and layer of a texture a render pass draws into, with the colour it is cleared to (null: loaded). */
interface ColorAttachment {
  texture: GPUTextureShim | null;
  mip: number;
  /** The array layer of `texture` that is drawn into. */
  layer: number;
  clear: [number, number, number, number] | null;
  /** The texture a multisampled `texture` resolves into when the pass ends. */
  resolve?: { texture: GPUTextureShim; mip: number; layer: number };
}

/** What a render pass draws into: the canvas, or one level of a texture (and, for several colour attachments, `more`). */
interface Attachment extends ColorAttachment {
  context: GPUCanvasContextShim | null;
  /** The colour attachments after the first, which are always textures of the first one's size. */
  more?: ColorAttachment[];
  /** The depth attachment: a level of a depth texture, cleared to `clear` (null: loaded). */
  depth?: { texture: GPUTextureShim; mip: number; layer: number; clear: number | null; readOnly: boolean };
  /** A pass with no colour attachment: only `depth` is drawn into. */
  depthOnly?: true;
}

type PassCommand =
  | { c: 'pipeline'; pipeline: GPURenderPipelineShim }
  | { c: 'bind'; index: number; group: GPUBindGroupShim; offsets?: number[] }
  | { c: 'vertex'; slot: number; buffer: GPUBufferShim; offset: number; size?: number }
  | { c: 'index'; buffer: GPUBufferShim; format: string; offset: number; size?: number }
  | Exclude<WebGpuCommand, { c: 'pipeline' | 'bind' | 'vertex' | 'index' }>;

interface TextureRegion {
  texture: GPUTextureShim;
  mip: number;
  layer: number;
  x: number;
  y: number;
}

type ComputeRecord =
  | { c: 'pipeline'; pipeline: GPUComputePipelineShim }
  | { c: 'bind'; index: number; group: GPUBindGroupShim; offsets?: number[] }
  | { c: 'dispatch'; x: number; y: number; z: number };

type EncodedItem =
  | { kind: 'pass'; attachment: Attachment; commands: PassCommand[] }
  | { kind: 'compute'; commands: ComputeRecord[] }
  | { kind: 'copy'; source: GPUBufferShim; sourceOffset: number; target: GPUBufferShim; targetOffset: number; size: number }
  | { kind: 'clear'; buffer: GPUBufferShim; offset: number; size: number }
  | { kind: 'bufferToTexture'; buffer: GPUBufferShim; offset: number; bytesPerRow: number; rowsPerImage: number; to: TextureRegion; width: number; height: number; layers: number }
  | { kind: 'textureToTexture'; from: TextureRegion; to: TextureRegion; width: number; height: number; layers: number };

/** What a render pass or bundle has bound, so that a draw is checked as the spec does. A bundle starts with nothing; `executeBundles` leaves a pass with nothing. */
class RenderState {
  pipeline: GPURenderPipelineShim | null = null;
  readonly groups = new Set<number>();
  readonly vertex = new Set<number>();
  index = false;
  clear(): void {
    this.pipeline = null;
    this.groups.clear();
    this.vertex.clear();
    this.index = false;
  }
  check(call: string, indexed: boolean): void {
    const pipeline = this.pipeline;
    if (pipeline === null) throw new Error(`OperationError: ${call}: no pipeline is set`);
    (pipeline.layouts ?? []).forEach((_, index) => {
      if (!this.groups.has(index)) throw new Error(`OperationError: ${call}: bind group ${index} is not set`);
    });
    pipeline.descriptor.vertex.buffers?.forEach((buffer, slot) => {
      if (buffer.attributes.length > 0 && !this.vertex.has(slot)) throw new Error(`OperationError: ${call}: the vertex buffer in slot ${slot} is not set`);
    });
    if (indexed && !this.index) throw new Error(`OperationError: ${call}: no index buffer is set`);
  }
}

/** What a render pass and a render bundle encoder share: the commands that bind state and draw, recorded in order. */
abstract class RenderCommands extends GpuObject {
  protected readonly commands: PassCommand[] = [];
  protected readonly state = new RenderState();
  protected ended = false;
  constructor(protected readonly kind: string, readonly device: GPUDeviceShim) {
    super('');
  }
  protected add(command: PassCommand): void {
    if (this.ended) throw new Error(`InvalidStateError: the ${this.kind} has ended`);
    this.commands.push(command);
  }
  /** Checks of a bind group against what the pass draws into. */
  protected checkGroup(_group: GPUBindGroupShim): void {}
  setBindGroup(index: number, group: GPUBindGroupShim | null, offsets?: unknown, start?: number, length?: number): void {
    if (group === null) return;
    this.checkGroup(group);
    let list: number[] | undefined;
    if (Array.isArray(offsets)) list = offsets.map(Number);
    else if (offsets !== undefined && offsets !== null) list = Array.from((offsets as Uint32Array).subarray(start ?? 0, (start ?? 0) + (length ?? (offsets as Uint32Array).length)));
    this.state.groups.add(index);
    this.add(list === undefined || list.length === 0 ? { c: 'bind', index, group } : { c: 'bind', index, group, offsets: list });
  }
  setVertexBuffer(slot: number, buffer: GPUBufferShim | null, offset = 0, size?: number): void {
    if (buffer === null) return;
    boundRange('setVertexBuffer', buffer.size, offset, size, 4);
    this.state.vertex.add(slot);
    this.add(size === undefined ? { c: 'vertex', slot, buffer, offset } : { c: 'vertex', slot, buffer, offset, size });
  }
  setIndexBuffer(buffer: GPUBufferShim, format: string, offset = 0, size?: number): void {
    boundRange('setIndexBuffer', buffer.size, offset, size, format === 'uint16' ? 2 : 4);
    this.state.index = true;
    this.add(size === undefined ? { c: 'index', buffer, format, offset } : { c: 'index', buffer, format, offset, size });
  }
  draw(vertices: number, instances = 1, first = 0, firstInstance = 0): void {
    this.state.check('draw', false);
    this.add({ c: 'draw', vertices, instances, first, firstInstance });
  }
  drawIndexed(indices: number, instances = 1, first = 0, base = 0, firstInstance = 0): void {
    this.state.check('drawIndexed', true);
    this.add({ c: 'drawIndexed', indices, instances, first, base, firstInstance });
  }
  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  insertDebugMarker(): void {}
}

export class GPURenderPassEncoderShim extends RenderCommands {
  constructor(private readonly encoder: GPUCommandEncoderShim, private readonly attachment: Attachment, private readonly occlusion: OcclusionQueries) {
    super('render pass', encoder.device);
  }
  setPipeline(pipeline: GPURenderPipelineShim): void {
    const texture = this.attachment.texture;
    const depth = this.attachment.depth;
    const target = pipeline.descriptor.fragment?.targets[0];
    if (this.attachment.depthOnly && pipeline.descriptor.fragment?.targets.some((t) => t !== null)) {
      throw new RangeError('OperationError: setPipeline: the pipeline draws colour and the pass has no colour attachment');
    }
    if (texture !== null && target && target.format !== texture.format) {
      throw new RangeError(`OperationError: setPipeline: the pipeline draws ${target.format} and the pass draws into a ${texture.format} texture`);
    }
    // With several colour attachments the pipeline's targets are the pass's formats, slot for slot.
    const more = this.attachment.more;
    if (more !== undefined) {
      const formats = [texture!, ...more.map((m) => m.texture!)].map((t) => t.format);
      const targets = pipeline.descriptor.fragment?.targets ?? [];
      if (targets.length !== formats.length || targets.some((t, i) => (t?.format ?? null) !== formats[i])) {
        throw new RangeError(`OperationError: setPipeline: the pipeline draws ${targets.map((t) => t?.format ?? 'nothing').join(', ') || 'no colour'} and the pass draws into ${formats.join(', ')}`);
      }
    }
    const samples = texture?.sampleCount ?? depth?.texture.sampleCount ?? 1;
    if ((pipeline.descriptor.samples ?? 1) !== samples) {
      throw new RangeError(`OperationError: setPipeline: the pipeline has ${pipeline.descriptor.samples ?? 1} samples and the pass draws into ${samples}`);
    }
    const state = pipeline.descriptor.depth;
    if ((state?.format ?? null) !== (depth?.texture.format ?? null)) {
      throw new RangeError(`OperationError: setPipeline: the pipeline has ${state ? `a ${state.format} depth state` : 'no depth state'} and the pass has ${depth ? `a ${depth.texture.format} depth attachment` : 'no depth attachment'}`);
    }
    if (state?.write && depth?.readOnly) throw new RangeError('OperationError: setPipeline: the pipeline writes depth and the pass depth attachment is read-only');
    this.state.pipeline = pipeline;
    this.add({ c: 'pipeline', pipeline });
  }
  protected override checkGroup(group: GPUBindGroupShim): void {
    const texture = this.attachment.texture;
    const written = texture === null ? [] : [this.attachment, ...(this.attachment.more ?? [])];
    for (const entry of group.entries) {
      if ('view' in entry && written.some((a) => entry.view.holds(a.texture!, a.mip, a.layer))) {
        throw new RangeError('OperationError: setBindGroup: a pass samples the level of the texture it draws into');
      }
      const depth = this.attachment.depth;
      if ('view' in entry && depth && !depth.readOnly && entry.view.holds(depth.texture, depth.mip, depth.layer)) {
        throw new RangeError('OperationError: setBindGroup: a pass samples the level of the depth texture it writes');
      }
    }
  }
  setViewport(x: number, y: number, width: number, height: number, minDepth = 0, maxDepth = 1): void {
    this.add({ c: 'viewport', x, y, width, height, minDepth, maxDepth });
  }
  setScissorRect(x: number, y: number, width: number, height: number): void {
    const { texture, depth, depthOnly } = this.attachment;
    const bounds = depthOnly ? depth!.texture.extent(depth!.mip) : texture === null ? null : texture.extent(this.attachment.mip);
    if (bounds !== null) rectIn('setScissorRect', 'rectangle', bounds, whole('setScissorRect', 'x', x), whole('setScissorRect', 'y', y), whole('setScissorRect', 'width', width), whole('setScissorRect', 'height', height));
    this.add({ c: 'scissor', x, y, width, height });
  }
  setBlendConstant(color: unknown): void {
    const [r, g, b, a] = colorOf(color);
    this.add({ c: 'blend', color: [r, g, b, a] });
  }
  setStencilReference(): void {}
  drawIndirect(): never {
    throw this.encoder.device.unsupported('renderPass.drawIndirect');
  }
  drawIndexedIndirect(): never {
    throw this.encoder.device.unsupported('renderPass.drawIndexedIndirect');
  }
  /**
   * Runs the bundles' commands here, in order, as if the pass had recorded them; then, as the spec says, the pipeline, bind
   * groups and vertex and index buffers are unset (the viewport, scissor and blend constant are not).
   */
  executeBundles(bundles: Iterable<GPURenderBundleShim>): void {
    const list = [...bundles];
    const { context, texture, depth, more } = this.attachment;
    const formats = context !== null ? [context.getConfiguration()!.format] : texture === null ? [] : [texture, ...(more ?? []).map((m) => m.texture!)].map((t) => t.format);
    const samples = texture?.sampleCount ?? depth?.texture.sampleCount ?? 1;
    for (const bundle of list) {
      if (!(bundle instanceof GPURenderBundleShim)) throw new TypeError("executeBundles: a bundle is not a GPURenderBundle");
      const made = bundle.descriptor;
      if (made.colorFormats.join() !== formats.join()) throw new RangeError(`OperationError: executeBundles: the bundle draws ${made.colorFormats.join(', ') || 'no colour'} and the pass draws ${formats.join(', ') || 'no colour'}`);
      if ((made.depthStencilFormat ?? null) !== (depth?.texture.format ?? null)) throw new RangeError(`OperationError: executeBundles: the bundle has ${made.depthStencilFormat ?? 'no'} depth format and the pass has ${depth?.texture.format ?? 'no depth attachment'}`);
      if (made.sampleCount !== samples) throw new RangeError(`OperationError: executeBundles: the bundle has ${made.sampleCount} samples and the pass draws into ${samples}`);
      if (depth?.readOnly && !made.depthReadOnly) throw new RangeError('OperationError: executeBundles: the pass depth attachment is read-only and the bundle is not');
    }
    for (const bundle of list) this.commands.push(...bundle.commands);
    this.state.clear();
  }
  beginOcclusionQuery(index: number): void {
    this.occlusion.begin(index);
  }
  endOcclusionQuery(): void {
    this.occlusion.end();
  }
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.occlusion.finish();
    this.encoder.finishPass({ kind: 'pass', attachment: this.attachment, commands: this.commands });
  }
}

/** What `createRenderBundleEncoder` takes, with the defaults: the formats and samples a pass must have to run the bundle. */
interface BundleDescriptor {
  colorFormats: string[];
  depthStencilFormat: string | null;
  sampleCount: number;
  depthReadOnly: boolean;
}

/** A render bundle: the commands of an encoder that finished. `executeBundles` runs them in a pass; nothing of it is drawn alone. */
export class GPURenderBundleShim extends GpuObject {
  constructor(readonly commands: PassCommand[], readonly descriptor: BundleDescriptor, label: unknown) {
    super(label);
  }
}

/** Records the commands of a bundle, checked against the formats and samples it was made for. */
export class GPURenderBundleEncoderShim extends RenderCommands {
  constructor(device: GPUDeviceShim, private readonly descriptor: BundleDescriptor, private readonly bundleLabel: unknown) {
    super('render bundle encoder', device);
  }
  setPipeline(pipeline: GPURenderPipelineShim): void {
    if (!(pipeline instanceof GPURenderPipelineShim)) throw new TypeError("setPipeline: 'pipeline' is not a GPURenderPipeline");
    const made = this.descriptor;
    const targets = (pipeline.descriptor.fragment?.targets ?? []).filter((t) => t !== null).map((t) => t!.format);
    if (targets.join() !== made.colorFormats.join()) throw new RangeError(`OperationError: setPipeline: the pipeline draws ${targets.join(', ') || 'no colour'} and the bundle draws ${made.colorFormats.join(', ') || 'no colour'}`);
    if ((pipeline.descriptor.samples ?? 1) !== made.sampleCount) throw new RangeError(`OperationError: setPipeline: the pipeline has ${pipeline.descriptor.samples ?? 1} samples and the bundle has ${made.sampleCount}`);
    const depth = pipeline.descriptor.depth;
    if ((depth?.format ?? null) !== made.depthStencilFormat) throw new RangeError(`OperationError: setPipeline: the pipeline has ${depth ? `a ${depth.format} depth state` : 'no depth state'} and the bundle has ${made.depthStencilFormat ?? 'no depth format'}`);
    if (depth?.write && made.depthReadOnly) throw new RangeError('OperationError: setPipeline: the pipeline writes depth and the bundle depth is read-only');
    this.state.pipeline = pipeline;
    this.add({ c: 'pipeline', pipeline });
  }
  drawIndirect(): never {
    throw this.device.unsupported('renderBundle.drawIndirect');
  }
  drawIndexedIndirect(): never {
    throw this.device.unsupported('renderBundle.drawIndexedIndirect');
  }
  finish(descriptor?: { label?: string }): GPURenderBundleShim {
    if (this.ended) throw new Error('InvalidStateError: the render bundle encoder has finished');
    this.ended = true;
    return new GPURenderBundleShim(this.commands, this.descriptor, descriptor?.label ?? this.bundleLabel);
  }
}

/** The most a dynamic offset list may hold, and the byte range of each binding it moves. */
function dynamicOffsets(call: string, group: GPUBindGroupShim, list: number[] | undefined): number[] {
  const moving = group.layout.id.startsWith('auto:') ? [] : group.layout.entries.filter((e) => e.dynamicOffset);
  const given = list ?? [];
  if (moving.length !== given.length) throw new RangeError(`OperationError: ${call}: the layout has ${moving.length} dynamic offsets and ${given.length} were given`);
  moving.forEach((layout, n) => {
    const offset = given[n]!;
    if (!Number.isInteger(offset) || offset < 0 || offset % 256 !== 0) throw new RangeError(`OperationError: ${call}: the dynamic offset ${String(offset)} is not a multiple of 256`);
    const entry = group.entries.find((e) => e.binding === layout.binding);
    if (entry && 'buffer' in entry && entry.offset + offset + entry.size > entry.buffer.size) {
      throw new RangeError(`OperationError: ${call}: the dynamic offset ${offset} moves binding ${layout.binding} past the end of its buffer`);
    }
  });
  return given;
}

/**
 * A compute pass: a pipeline, bind groups and dispatches, recorded to be replayed in submit order. Checked as the spec
 * does where the page can be told (a dispatch past the device's limit, a group the pipeline's layout does not have, a
 * texture or buffer used as a write and as anything else in one dispatch).
 */
export class GPUComputePassEncoderShim extends GpuObject {
  private readonly commands: ComputeRecord[] = [];
  private ended = false;
  private pipeline: GPUComputePipelineShim | null = null;
  private readonly groups = new Map<number, { group: GPUBindGroupShim; offsets: number[] }>();
  constructor(private readonly encoder: GPUCommandEncoderShim) {
    super('');
  }
  private add(command: ComputeRecord): void {
    if (this.ended) throw new Error('InvalidStateError: the compute pass has ended');
    this.commands.push(command);
  }
  setPipeline(pipeline: GPUComputePipelineShim): void {
    if (!(pipeline instanceof GPUComputePipelineShim)) throw new TypeError("setPipeline: 'pipeline' is not a GPUComputePipeline");
    this.pipeline = pipeline;
    this.add({ c: 'pipeline', pipeline });
  }
  setBindGroup(index: number, group: GPUBindGroupShim | null, offsets?: unknown, start?: number, length?: number): void {
    const max = this.encoder.device.limits.maxBindGroups!;
    if (!Number.isInteger(index) || index < 0 || index >= max) throw new RangeError(`OperationError: setBindGroup: the index ${String(index)} is not from 0 to ${max - 1}`);
    if (group === null) {
      this.groups.delete(index);
      return;
    }
    if (!(group instanceof GPUBindGroupShim)) throw new TypeError("setBindGroup: 'bindGroup' is not a GPUBindGroup");
    let list: number[] | undefined;
    if (Array.isArray(offsets)) list = offsets.map(Number);
    else if (offsets !== undefined && offsets !== null) list = Array.from((offsets as Uint32Array).subarray(start ?? 0, (start ?? 0) + (length ?? (offsets as Uint32Array).length)));
    const given = dynamicOffsets('setBindGroup', group, list);
    this.groups.set(index, { group, offsets: given });
    this.add(given.length === 0 ? { c: 'bind', index, group } : { c: 'bind', index, group, offsets: given });
  }
  dispatchWorkgroups(x: number, y = 1, z = 1): void {
    const call = 'dispatchWorkgroups';
    const device = this.encoder.device;
    if (this.pipeline === null) throw new Error(`InvalidStateError: ${call} before setPipeline`);
    const dims = [x, y, z].map((n, i) => whole(call, ['workgroupCountX', 'workgroupCountY', 'workgroupCountZ'][i]!, n, 0));
    const max = device.limits.maxComputeWorkgroupsPerDimension!;
    if (dims.some((n) => n > max)) throw new RangeError(`OperationError: ${call}(${dims.join(', ')}): a dimension is over the device's maxComputeWorkgroupsPerDimension ${max}`);
    this.checkBindings(call);
    this.add({ c: 'dispatch', x: dims[0]!, y: dims[1]!, z: dims[2]! });
  }
  dispatchWorkgroupsIndirect(): never {
    throw this.encoder.device.unsupported('computePass.dispatchWorkgroupsIndirect');
  }
  /** Every group the pipeline's layout names is set and fits it; no resource is written and used again in one dispatch. */
  private checkBindings(call: string): void {
    const pipeline = this.pipeline!;
    const auto = pipeline.layouts === null;
    if (!auto) {
      pipeline.layouts!.forEach((layout, index) => {
        const set = this.groups.get(index);
        if (set === undefined) throw new Error(`OperationError: ${call}: bind group ${index} is not set`);
        if (set.group.layout.id !== layout.id) throw new TypeError(`${call}: bind group ${index} was made with a different layout than the pipeline's`);
      });
    }
    for (const [index, { group }] of this.groups) {
      if (auto && group.layout.id.startsWith('auto:') && group.layout.id !== `auto:${pipeline.id}:${index}`) {
        throw new TypeError(`${call}: bind group ${index} was made with the automatic layout of another pipeline`);
      }
    }
    // One dispatch is one usage scope, of the groups the pipeline uses.
    const levels = new Map<string, { users: number; writers: number }>();
    const ranges = new Map<string, { start: number; end: number; write: boolean }[]>();
    for (const [index, { group, offsets }] of this.groups) {
      if (auto ? !pipeline.module.groups.has(index) : index >= pipeline.layouts!.length) continue;
      let moving = 0;
      for (const entry of group.entries) {
        const writes = group.layout.writes(entry.binding);
        if ('view' in entry) {
          for (const key of entry.view.keys()) {
            const seen = levels.get(key) ?? { users: 0, writers: 0 };
            seen.users += 1;
            if (writes === 'texture') seen.writers += 1;
            levels.set(key, seen);
          }
        } else if ('buffer' in entry) {
          const dynamic = !group.layout.id.startsWith('auto:') && group.layout.entries.find((l) => l.binding === entry.binding)?.dynamicOffset === true;
          const shift = dynamic ? (offsets[moving++] ?? 0) : 0;
          const list = ranges.get(entry.buffer.key) ?? [];
          list.push({ start: entry.offset + shift, end: entry.offset + shift + entry.size, write: writes === 'buffer' });
          ranges.set(entry.buffer.key, list);
        }
      }
    }
    for (const [key, seen] of levels) {
      if (seen.writers > 0 && seen.users > 1) throw new RangeError(`OperationError: ${call}: the texture level ${key} is written as a storage texture and bound again in one dispatch`);
    }
    for (const list of ranges.values()) {
      for (let a = 0; a < list.length; a += 1) {
        for (let b = a + 1; b < list.length; b += 1) {
          if ((list[a]!.write || list[b]!.write) && list[a]!.start < list[b]!.end && list[b]!.start < list[a]!.end) {
            throw new RangeError(`OperationError: ${call}: a buffer range is written as a storage buffer and bound again in one dispatch`);
          }
        }
      }
    }
  }
  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  insertDebugMarker(): void {}
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.encoder.finishPass({ kind: 'compute', commands: this.commands });
  }
}

/** A vertex or index buffer's range must be aligned, not empty and inside the buffer (the renderer refuses the same). */
function boundRange(call: string, length: number, offset: number, size: number | undefined, align: number): void {
  const end = size === undefined ? length : offset + size;
  if (!Number.isInteger(offset) || offset < 0 || offset % align !== 0) throw new RangeError(`OperationError: ${call}: the offset ${offset} is not a multiple of ${align}`);
  if (size !== undefined && (!Number.isInteger(size) || size % 4 !== 0)) throw new RangeError(`OperationError: ${call}: the size ${size} is not a multiple of 4`);
  if (!(offset < end)) throw new RangeError(`OperationError: ${call}: the range ${offset}..${end} is empty`);
  if (end > length) throw new RangeError(`OperationError: ${call}: the range ${offset}..${end} is outside a buffer of ${length} bytes`);
}

function colorOf(value: unknown): [number, number, number, number] {
  if (Array.isArray(value)) return [Number(value[0] ?? 0), Number(value[1] ?? 0), Number(value[2] ?? 0), Number(value[3] ?? 0)];
  const c = (value ?? {}) as { r?: number; g?: number; b?: number; a?: number };
  return [Number(c.r ?? 0), Number(c.g ?? 0), Number(c.b ?? 0), Number(c.a ?? 0)];
}

/** The rows from the first row of one layer to the first of the next in a copy of `depth` layers of `height` rows. */
function imageRows(call: string, rowsPerImage: unknown, height: number, depth: number): number {
  if (rowsPerImage === undefined) {
    if (depth > 1) throw new RangeError(`OperationError: ${call}: rowsPerImage is needed to copy more than one layer`);
    return height;
  }
  const rows = whole(call, 'rowsPerImage', rowsPerImage, 0);
  if (rows < height) throw new RangeError(`OperationError: ${call}: rowsPerImage ${rows} is less than the ${height} rows of a layer`);
  return rows;
}

/** `{ texture, mipLevel, origin }` of a copy, checked against the texture. */
function regionOf(call: string, what: string, info: { texture: GPUTextureShim; mipLevel?: number; origin?: unknown; aspect?: string }, width: number, height: number, depth: number, usage: number, usageName: string, depthFormat = false): TextureRegion {
  const texture = info?.texture;
  if (!(texture instanceof GPUTextureShim)) throw new TypeError(`${call}: ${what} texture is not a GPUTexture`);
  if (texture.canvas !== null) throw texture.device.unsupported(`${call} with the canvas's texture`);
  if (texture.destroyed) throw new Error(`OperationError: ${call}: the ${what} texture was destroyed`);
  if (texture.sampleCount > 1) throw new RangeError(`OperationError: ${call}: the ${what} texture is multisampled; resolve it into a texture first`);
  const isDepth = DEPTH_FORMATS.has(texture.format);
  if (isDepth && !depthFormat) throw texture.device.unsupported(`${call} with the ${texture.format} ${what} texture; a depth texture is written by a render pass or copied from another`);
  if ((texture.usage & usage) === 0) throw new RangeError(`OperationError: ${call}: the ${what} texture was made without GPUTextureUsage.${usageName}`);
  if (info.aspect !== undefined && info.aspect !== 'all' && !(isDepth && info.aspect === 'depth-only')) throw texture.device.unsupported(`${call} of the aspect ${info.aspect}`);
  const mip = whole(call, 'mipLevel', info.mipLevel ?? 0, 0);
  if (mip >= texture.mipLevelCount) throw new RangeError(`OperationError: ${call}: mip level ${mip} of a texture with ${texture.mipLevelCount}`);
  const origin = originOf(call, info.origin);
  if (origin.z + depth > texture.depthOrArrayLayers) throw new RangeError(`OperationError: ${call}: the layers ${origin.z}..${origin.z + depth} are outside the ${texture.depthOrArrayLayers} layers of the ${what} texture`);
  const extent = texture.extent(mip);
  rectIn(call, `${what} rectangle`, extent, origin.x, origin.y, width, height);
  if (isDepth && (origin.x !== 0 || origin.y !== 0 || width !== extent.width || height !== extent.height)) {
    throw new RangeError(`OperationError: ${call}: a copy of a depth texture covers the whole of the level (${extent.width} x ${extent.height} from 0, 0)`);
  }
  return { texture, mip, layer: origin.z, x: origin.x, y: origin.y };
}

export class GPUCommandEncoderShim extends GpuObject {
  private readonly items: EncodedItem[] = [];
  private finished = false;
  constructor(readonly device: GPUDeviceShim) {
    super('');
  }
  finishPass(item: EncodedItem): void {
    this.items.push(item);
  }
  beginRenderPass(descriptor: {
    colorAttachments: ({ view: GPUTextureViewShim; loadOp?: string; storeOp?: string; clearValue?: unknown; resolveTarget?: unknown } | null)[];
    depthStencilAttachment?: unknown;
    occlusionQuerySet?: unknown;
    timestampWrites?: unknown;
  }): GPURenderPassEncoderShim {
    const attachments = (descriptor.colorAttachments ?? []).filter((a) => a !== null && a !== undefined);
    if (descriptor.occlusionQuerySet) queryIn('beginRenderPass', descriptor.occlusionQuerySet, 'occlusion', 0);
    checkTimestampWrites('beginRenderPass', descriptor.timestampWrites);
    const occlusion = new OcclusionQueries((descriptor.occlusionQuerySet as GPUQuerySetShim | undefined) ?? null);
    if (attachments.length === 0) {
      if (!descriptor.depthStencilAttachment) throw new TypeError('beginRenderPass: a pass needs a colour attachment or a depth attachment');
      const depth = this.depthAttachment(descriptor.depthStencilAttachment, null, null)!;
      return new GPURenderPassEncoderShim(this, { context: null, texture: null, mip: 0, layer: 0, clear: null, depth, depthOnly: true }, occlusion);
    }
    const max = this.device.limits.maxColorAttachments!;
    if (attachments.length > max) throw new RangeError(`OperationError: beginRenderPass: ${attachments.length} colour attachments; the device allows ${max}`);
    const [first, ...rest] = attachments.map((a) => this.colorAttachment(a));
    if (rest.length > 0) {
      if (first!.context !== null || rest.some((c) => c.context !== null)) throw this.device.unsupported("the canvas's texture among several colour attachments; draw into textures of your own");
      for (const [n, c] of rest.entries()) {
        const same = (x: typeof c): boolean => x.texture!.width === first!.texture!.width && x.texture!.height === first!.texture!.height && x.texture!.sampleCount === first!.texture!.sampleCount;
        if (!same(c)) throw new RangeError(`OperationError: beginRenderPass: colour attachment ${n + 1} has another size or sample count than attachment 0`);
        for (const other of [first!, ...rest.slice(0, n)]) {
          if (other.texture === c.texture && other.mip === c.mip && other.layer === c.layer) throw new RangeError(`OperationError: beginRenderPass: colour attachment ${n + 1} is the level and layer that another attachment draws into`);
        }
      }
    }
    const { context, texture, mip, layer, clear, resolve } = first!;
    const depth = this.depthAttachment(descriptor.depthStencilAttachment, context !== null ? { width: texture!.width, height: texture!.height } : texture!.extent(mip), texture!.sampleCount);
    const more = rest.map(({ context: _context, ...attachment }) => attachment as ColorAttachment);
    const target = context !== null ? { context, texture: null, mip: 0, layer: 0, clear } : { context: null, texture, mip, layer, clear, ...(resolve ? { resolve } : {}) };
    return new GPURenderPassEncoderShim(this, { ...target, ...(more.length > 0 ? { more } : {}), ...(depth ? { depth } : {}) } as Attachment, occlusion);
  }
  /** One colour attachment of a pass, checked: the canvas's texture (`context`), or a level and layer of a texture. */
  private colorAttachment(attachment: { view: GPUTextureViewShim; loadOp?: string; clearValue?: unknown; resolveTarget?: unknown }): ColorAttachment & { context: GPUCanvasContextShim | null } {
    const view = attachment.view;
    if (!(view instanceof GPUTextureViewShim)) throw new TypeError('beginRenderPass: the colour attachment has no view');
    const clear = (attachment.loadOp ?? 'clear') === 'load' ? null : colorOf(attachment.clearValue);
    const texture = view.texture;
    if (texture.canvas !== null) return { context: texture.canvas, texture, mip: 0, layer: 0, clear };
    if (texture.destroyed) throw new Error('OperationError: beginRenderPass: the texture was destroyed');
    if ((texture.usage & GPU_TEXTURE_USAGE.RENDER_ATTACHMENT) === 0) throw new RangeError('OperationError: beginRenderPass: the texture was made without GPUTextureUsage.RENDER_ATTACHMENT');
    if (view.mips !== 1) throw new RangeError('OperationError: beginRenderPass: a colour attachment is one mip level');
    if (view.layers !== 1) throw new RangeError('OperationError: beginRenderPass: a colour attachment is one array layer');
    const resolveTarget = attachment.resolveTarget;
    let resolve: ColorAttachment['resolve'];
    if (resolveTarget) {
      if (!(resolveTarget instanceof GPUTextureViewShim)) throw new TypeError('beginRenderPass: the resolve target has no view');
      const to = resolveTarget.texture;
      if (texture.sampleCount === 1) throw new TypeError('OperationError: beginRenderPass: a resolve target needs a multisampled colour attachment');
      if (to.canvas !== null) throw this.device.unsupported("a resolve target that is the canvas's texture; resolve into a texture of your own");
      if (to.destroyed) throw new Error('OperationError: beginRenderPass: the resolve target was destroyed');
      if (to.sampleCount !== 1 || resolveTarget.mips !== 1 || resolveTarget.layers !== 1) throw new TypeError('OperationError: beginRenderPass: the resolve target is one level of a texture of one sample');
      if (to.format !== texture.format || to.extent(resolveTarget.baseMip).width !== texture.width || to.extent(resolveTarget.baseMip).height !== texture.height) {
        throw new RangeError('OperationError: beginRenderPass: the resolve target has the size and format of the colour attachment');
      }
      if ((to.usage & GPU_TEXTURE_USAGE.RENDER_ATTACHMENT) === 0) throw new RangeError('OperationError: beginRenderPass: the resolve target was made without GPUTextureUsage.RENDER_ATTACHMENT');
      resolve = { texture: to, mip: resolveTarget.baseMip, layer: resolveTarget.baseLayer };
    }
    return { context: null, texture, mip: view.baseMip, layer: view.baseLayer, clear, ...(resolve ? { resolve } : {}) };
  }
  /** A pass's `depthStencilAttachment`, checked against the colour attachment it goes with (size and samples). */
  private depthAttachment(a: unknown, color: { width: number; height: number } | null, samples: number | null): Attachment['depth'] {
    if (a === undefined || a === null) return undefined;
    const d = a as { view?: unknown; depthClearValue?: number; depthLoadOp?: string; depthStoreOp?: string; depthReadOnly?: boolean; stencilLoadOp?: string; stencilStoreOp?: string; stencilClearValue?: number; stencilReadOnly?: boolean };
    const view = d.view;
    if (!(view instanceof GPUTextureViewShim)) throw new TypeError('beginRenderPass: the depth attachment has no view');
    const texture = view.texture;
    if (texture.canvas !== null || !DEPTH_FORMATS.has(texture.format)) throw this.device.unsupported(`a depth attachment of ${texture.canvas !== null ? "the canvas's texture" : `format ${texture.format}`}; the depth formats are ${[...DEPTH_FORMATS].join(', ')} (stencil formats are not drawn)`);
    if (texture.destroyed) throw new Error('OperationError: beginRenderPass: the depth texture was destroyed');
    if ((texture.usage & GPU_TEXTURE_USAGE.RENDER_ATTACHMENT) === 0) throw new RangeError('OperationError: beginRenderPass: the depth texture was made without GPUTextureUsage.RENDER_ATTACHMENT');
    if (view.mips !== 1 || view.layers !== 1) throw new RangeError('OperationError: beginRenderPass: a depth attachment is one mip level and one array layer');
    const size = texture.extent(view.baseMip);
    if (color !== null && (size.width !== color.width || size.height !== color.height)) throw new RangeError(`OperationError: beginRenderPass: the depth attachment is ${size.width} x ${size.height} and the colour attachment ${color.width} x ${color.height}`);
    if (samples !== null && texture.sampleCount !== samples) throw new RangeError(`OperationError: beginRenderPass: the depth attachment has ${texture.sampleCount} samples and the colour attachment ${samples}`);
    const readOnly = d.depthReadOnly === true;
    if (readOnly) return { texture, mip: view.baseMip, layer: view.baseLayer, clear: null, readOnly };
    const load = d.depthLoadOp;
    if ((load !== 'load' && load !== 'clear') || (d.depthStoreOp !== 'store' && d.depthStoreOp !== 'discard')) throw new TypeError('beginRenderPass: a depth attachment that is not read-only needs depthLoadOp and depthStoreOp');
    if (load === 'clear') {
      const value = Number(d.depthClearValue);
      if (!(value >= 0 && value <= 1)) throw new TypeError(`beginRenderPass: depthClearValue ${String(d.depthClearValue)} is not from 0 to 1`);
      return { texture, mip: view.baseMip, layer: view.baseLayer, clear: value, readOnly };
    }
    return { texture, mip: view.baseMip, layer: view.baseLayer, clear: null, readOnly };
  }
  beginComputePass(descriptor?: { label?: string; timestampWrites?: unknown }): GPUComputePassEncoderShim {
    checkTimestampWrites('beginComputePass', descriptor?.timestampWrites);
    return new GPUComputePassEncoderShim(this);
  }
  copyBufferToBuffer(source: GPUBufferShim, sourceOffset: number, target: GPUBufferShim, targetOffset: number, size: number): void {
    this.items.push({ kind: 'copy', source, sourceOffset, target, targetOffset, size });
  }
  clearBuffer(buffer: GPUBufferShim, offset = 0, size?: number): void {
    this.items.push({ kind: 'clear', buffer, offset, size: size ?? buffer.size - offset });
  }
  copyBufferToTexture(
    source: { buffer: GPUBufferShim; offset?: number; bytesPerRow?: number; rowsPerImage?: number },
    destination: { texture: GPUTextureShim; mipLevel?: number; origin?: unknown; aspect?: string },
    copySize: unknown,
  ): void {
    const call = 'copyBufferToTexture';
    const size = sizeOf(call, copySize);
    const to = regionOf(call, 'destination', destination, size.width, size.height, size.depth, GPU_TEXTURE_USAGE.COPY_DST, 'COPY_DST');
    const buffer = source?.buffer;
    if (!(buffer instanceof GPUBufferShim)) throw new TypeError(`${call}: the source has no GPUBuffer`);
    if (buffer.gpu) throw this.device.unsupported(`${call} from a buffer a pass wrote; write the texture from a shader or with queue.writeTexture`);
    if ((buffer.usage & GPU_BUFFER_USAGE.COPY_SRC) === 0) throw new RangeError(`OperationError: ${call}: the buffer was made without GPUBufferUsage.COPY_SRC`);
    const texel = to.texture.texelBytes;
    const offset = whole(call, 'offset', source.offset ?? 0, 0);
    const rowBytes = size.width * texel;
    const bytesPerRow = source.bytesPerRow === undefined ? rowBytes : whole(call, 'bytesPerRow', source.bytesPerRow, 0);
    if ((size.height > 1 || size.depth > 1) && source.bytesPerRow === undefined) throw new RangeError(`OperationError: ${call}: bytesPerRow is needed to copy more than one row`);
    if ((size.height > 1 || size.depth > 1) && bytesPerRow % 256 !== 0) throw new RangeError(`OperationError: ${call}: bytesPerRow ${bytesPerRow} is not a multiple of 256`);
    if (bytesPerRow < rowBytes) throw new RangeError(`OperationError: ${call}: bytesPerRow ${bytesPerRow} is less than the ${rowBytes} bytes of a row`);
    if (offset % texel !== 0) throw new RangeError(`OperationError: ${call}: the offset ${offset} is not a multiple of the texel size ${texel}`);
    const rowsPerImage = imageRows(call, source.rowsPerImage, size.height, size.depth);
    if (size.width > 0 && size.height > 0 && size.depth > 0 && offset + ((size.depth - 1) * rowsPerImage + size.height - 1) * bytesPerRow + rowBytes > buffer.size) {
      throw new RangeError(`OperationError: ${call}: the copy reads past the ${buffer.size} bytes of the buffer`);
    }
    this.items.push({ kind: 'bufferToTexture', buffer, offset, bytesPerRow, rowsPerImage, to, width: size.width, height: size.height, layers: size.depth });
  }
  copyTextureToBuffer(): never {
    throw this.device.unsupported('encoder.copyTextureToBuffer; reading a texture back');
  }
  copyTextureToTexture(
    source: { texture: GPUTextureShim; mipLevel?: number; origin?: unknown; aspect?: string },
    destination: { texture: GPUTextureShim; mipLevel?: number; origin?: unknown; aspect?: string },
    copySize: unknown,
  ): void {
    const call = 'copyTextureToTexture';
    const size = sizeOf(call, copySize);
    const from = regionOf(call, 'source', source, size.width, size.height, size.depth, GPU_TEXTURE_USAGE.COPY_SRC, 'COPY_SRC', true);
    const to = regionOf(call, 'destination', destination, size.width, size.height, size.depth, GPU_TEXTURE_USAGE.COPY_DST, 'COPY_DST', true);
    const linear = (format: string): string => format.replace(/-srgb$/, '');
    if (linear(from.texture.format) !== linear(to.texture.format)) {
      throw new TypeError(`${call}: the formats ${from.texture.format} and ${to.texture.format} differ by more than -srgb`);
    }
    if (from.texture === to.texture && from.mip === to.mip && from.layer < to.layer + size.depth && to.layer < from.layer + size.depth) {
      throw new RangeError(`OperationError: ${call}: the source and the destination share a level and a layer of one texture`);
    }
    this.items.push({ kind: 'textureToTexture', from, to, width: size.width, height: size.height, layers: size.depth });
  }
  /** The results are zeros, written where a resolve would put them (a clear, in the queue's order, so a later read sees them). */
  resolveQuerySet(querySet: GPUQuerySetShim, firstQuery: number, queryCount: number, destination: GPUBufferShim, destinationOffset: number): void {
    const call = 'resolveQuerySet';
    if (!(querySet instanceof GPUQuerySetShim)) throw new TypeError(`${call}: the query set is not a GPUQuerySet`);
    if (!(destination instanceof GPUBufferShim)) throw new TypeError(`${call}: the destination is not a GPUBuffer`);
    const first = whole(call, 'firstQuery', firstQuery, 0);
    const count = whole(call, 'queryCount', queryCount, 0);
    const offset = whole(call, 'destinationOffset', destinationOffset, 0);
    if (querySet.destroyed) throw new Error(`OperationError: ${call}: the query set was destroyed`);
    if (first + count > querySet.count) throw new RangeError(`OperationError: ${call}: the query range ${first}..${first + count} is outside a set of ${querySet.count}`);
    if ((destination.usage & GPU_BUFFER_USAGE.QUERY_RESOLVE) === 0) throw new RangeError(`OperationError: ${call}: the destination was made without GPUBufferUsage.QUERY_RESOLVE`);
    if (offset % 256 !== 0) throw new RangeError(`OperationError: ${call}: destinationOffset ${offset} is not a multiple of 256`);
    if (offset + count * 8 > destination.size) throw new RangeError(`OperationError: ${call}: the ${count * 8} bytes of results run past the end of the ${destination.size} byte destination`);
    if (count > 0) this.items.push({ kind: 'clear', buffer: destination, offset, size: count * 8 });
  }
  /** `writeTimestamp` (the chromium-experimental call): accepted, and nothing is written. */
  writeTimestamp(querySet: GPUQuerySetShim, queryIndex: number): void {
    queryIn('writeTimestamp', querySet, 'timestamp', queryIndex);
  }
  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  insertDebugMarker(): void {}
  finish(): GPUCommandBufferShim {
    if (this.finished) throw new Error('InvalidStateError: the command encoder has finished');
    this.finished = true;
    return new GPUCommandBufferShim(this.items);
  }
}

// ---- the log of what was drawn ----

/**
 * One thing the queue did that the renderer replays: a render pass, an upload or a copy, with the tables it uses. A step
 * into the canvas belongs to a frame (`canvas`); the others stay for the frames after it, for as long as what they wrote
 * may be read.
 */
export interface LogStep {
  step: WebGpuStep;
  canvas: GPUCanvasContextShim | null;
  tables: Tables;
  /** Every texture the step names, for the recording's texture table. */
  textures: Set<GPUTextureShim>;
  /** Every buffer the GPU writes that the step names. */
  gpuBuffers?: Set<GPUBufferShim>;
  /** `<uid>:<mip>` of the texture levels, and `B<uid>` of the buffers, the step reads (a partial write reads what it leaves). */
  reads: Set<string>;
  /** What the step writes, and whether it wrote all of it. */
  writes: LogWrite[];
  /** The device's frame when the step was made. */
  frame?: number;
}

/** A texture level or a buffer a step writes: `whole` when nothing of what was there stays. */
export interface LogWrite {
  key: string;
  whole: boolean;
  owner: GPUTextureShim | GPUBufferShim;
}

const levelKey = (texture: GPUTextureShim, mip: number, layer: number): string => `${texture.uid}:${mip}:${layer}`;
/** `{ layer }` unless it is 0, which a recording leaves out. */
const layerOf = (layer: number): { layer?: number } => (layer === 0 ? {} : { layer });

// ---- the canvas ----

export interface GPUCanvasContextOptions {
  /** The canvas's bitmap size now. */
  size: () => { width: number; height: number };
  canvas?: unknown;
}

/**
 * `canvas.getContext('webgpu')`. `content()` is what the `glsl` layer is made of. Like a browser's canvas it presents once
 * a frame: the first submit after `resetState()` (the frame loop calls it before a frame) starts the drawing afresh.
 */
export class GPUCanvasContextShim {
  readonly canvas: unknown;
  private device: GPUDeviceShim | null = null;
  /** The device of the last `configure`, which keeps the drawing after an `unconfigure`. */
  private drawnBy: GPUDeviceShim | null = null;
  private format = 'rgba8unorm';
  private colorSpace: 'srgb' | 'display-p3' = 'srgb';
  private alphaMode = 'opaque';
  private stale = false;

  constructor(private readonly options: GPUCanvasContextOptions) {
    this.canvas = options.canvas;
  }

  configure(configuration: { device: GPUDeviceShim; format?: string; alphaMode?: string; colorSpace?: string; toneMapping?: unknown; usage?: number; viewFormats?: unknown }): void {
    const { device } = configuration;
    if (!(device instanceof GPUDeviceShim)) throw new TypeError("configure: 'device' is not a GPUDevice");
    const format = configuration.format;
    if (typeof format !== 'string' || !CANVAS_FORMATS.has(format)) throw new TypeError(`configure: the format ${String(format)} is not a canvas format`);
    const colorSpace = configuration.colorSpace ?? 'srgb';
    if (colorSpace !== 'srgb' && colorSpace !== 'display-p3') throw new TypeError(`configure: the colorSpace ${String(colorSpace)} is not srgb or display-p3`);
    // The video is SDR: an extended canvas is drawn as a standard one, its values clipped to 0..1 as the standard mode does.
    const toneMapping = (configuration.toneMapping as { mode?: string } | undefined)?.mode ?? 'standard';
    if (toneMapping === 'extended' && format === 'rgba16float') device.note('canvas toneMapping extended (drawn as standard: values above 1 are clipped, the video being SDR)');
    this.device = device;
    this.drawnBy = device;
    this.format = format;
    this.colorSpace = colorSpace;
    this.alphaMode = configuration.alphaMode ?? 'opaque';
    device.contexts.add(this);
  }

  unconfigure(): void {
    this.device = null;
  }

  getConfiguration(): { device: GPUDeviceShim; format: string; alphaMode: string; colorSpace: string } | null {
    return this.device === null ? null : { device: this.device, format: this.format, alphaMode: this.alphaMode, colorSpace: this.colorSpace };
  }

  getCurrentTexture(): GPUTextureShim {
    if (this.device === null) throw new Error('InvalidStateError: the canvas context is not configured');
    const { width, height } = this.options.size();
    return new GPUTextureShim(this.device, this, Math.max(1, width), Math.max(1, height), this.format, GPU_TEXTURE_USAGE.RENDER_ATTACHMENT | GPU_TEXTURE_USAGE.COPY_SRC, 1);
  }

  /** The device submitted a pass for this canvas: starts the frame's drawing if it is a new one. */
  begin(): void {
    if (!this.stale) return;
    this.stale = false;
    this.drawnBy?.dropFrameOf(this);
  }

  /** The recording: what the `glsl` layer holds. */
  content(): GlslContent {
    const device = this.drawnBy;
    const notes = device === null ? [] : [...device.notes];
    const errors = device === null ? [] : [...device.errors];
    const steps = device === null ? [] : device.liveStepsFor(this);
    const impure = device === null ? [] : device.carried(steps);
    const merged = newTables();
    const textures = new Map<GPUTextureShim, WebGpuTexture>();
    for (const s of steps) {
      for (const key of Object.keys(merged) as (keyof Tables)[]) {
        for (const [id, value] of s.tables[key] as Map<string, never>) (merged[key] as Map<string, unknown>).set(id, value);
      }
      for (const texture of s.textures) {
        if (!textures.has(texture)) textures.set(texture, { width: texture.width, height: texture.height, ...(texture.depthOrArrayLayers > 1 ? { layers: texture.depthOrArrayLayers } : {}), mips: texture.mipLevelCount, format: texture.format, ...(texture.sampleCount > 1 ? { samples: texture.sampleCount } : {}) });
      }
    }
    const webgpu: WebGpuContent = {
      modules: Object.fromEntries(merged.modules),
      layouts: Object.fromEntries(merged.layouts),
      pipelines: Object.fromEntries(merged.pipelines),
      buffers: Object.fromEntries(merged.buffers),
      bindGroups: Object.fromEntries(merged.bindGroups),
      passes: steps.map((s) => s.step),
    };
    if (merged.computePipelines.size > 0) webgpu.computePipelines = Object.fromEntries(merged.computePipelines);
    if (merged.gpuBuffers.size > 0) webgpu.gpuBuffers = Object.fromEntries(merged.gpuBuffers);
    if (impure.length > 0) webgpu.impure = impure;
    if (textures.size > 0) webgpu.textures = Object.fromEntries([...textures].map(([texture, described]) => [texture.id, described]));
    if (merged.samplers.size > 0) webgpu.samplers = Object.fromEntries(merged.samplers);
    if (merged.blobs.size > 0) webgpu.blobs = Object.fromEntries(merged.blobs);
    if (notes.length > 0) webgpu.notes = notes;
    if (errors.length > 0) webgpu.errors = errors;
    if (this.format === 'rgba16float') webgpu.canvasFormat = 'rgba16float';
    if (this.colorSpace === 'display-p3') webgpu.colorSpace = 'display-p3';
    return {
      premultipliedAlpha: this.alphaMode === 'premultiplied',
      alpha: this.alphaMode === 'premultiplied',
      programs: {},
      buffers: {},
      textures: {},
      ops: [],
      webgpu,
    };
  }

  /** Whether anything was drawn, or something was left out. */
  get drawn(): boolean {
    return (this.drawnBy?.hasPassFor(this) ?? false) || (this.drawnBy?.notes.size ?? 0) > 0 || (this.drawnBy?.errors.size ?? 0) > 0;
  }

  /** The frame loop calls this before each frame: the next submit starts a new drawing; a frame that draws nothing keeps the picture. */
  resetState(): void {
    this.stale = true;
    this.drawnBy?.frameStarted();
  }

  /** Empties the drawing (`canvas.width` was set). */
  reset(): void {
    this.stale = true;
    this.begin();
  }
}

// ---- queue, device, adapter ----

/** What the device needs from the page's environment. */
export interface GpuOptions {
  /** The pixels of a 2D canvas, as `copyExternalImageToTexture` of a canvas needs them: straight RGBA8, or null when they cannot be had. */
  rasterize?: (source: Extract<CanvasSource, { kind: 'canvas' }>) => Uint8Array | null;
}

/**
 * The features every adapter and device offers, whatever machine renders: those the replay implements. A project takes
 * the same code paths everywhere. `float32-filterable` needs the host's wgpu device to have it too (the renderer warns
 * once when it does not); query sets are accepted and measure nothing, so `timestamp-query` needs nothing of the host.
 */
const FEATURES = ['float32-filterable', 'timestamp-query'];

/** Limits where better means a smaller number. */
const ALIGNMENTS = new Set(['minUniformBufferOffsetAlignment', 'minStorageBufferOffsetAlignment']);

/** What `copyExternalImageToTexture` reads a source as: where its pixels come from, and how big it is. */
function externalSource(device: GPUDeviceShim, source: unknown, tables: Tables): { source: WebGpuSource; width: number; height: number } {
  const video = (source as { [VIDEO_FRAME]?: () => VideoFrameSource | null } | null | undefined)?.[VIDEO_FRAME]?.();
  if (video) {
    if (!(video.width > 0 && video.height > 0)) throw new RangeError('OperationError: copyExternalImageToTexture: the video has no size (is its file in the project?)');
    return { source: { video: { src: video.src, time: video.time } }, width: video.width, height: video.height };
  }
  const layer = (source as { [LAYER_SOURCE]?: () => { id: string; width: number; height: number } } | null | undefined)?.[LAYER_SOURCE]?.();
  if (layer !== undefined) return { source: { layer: layer.id }, width: layer.width, height: layer.height };
  const picture = pictureOf(source);
  if (picture === null) {
    const name = source === null || source === undefined ? String(source) : ((source as object).constructor?.name ?? typeof source);
    throw new WebGpuUnsupportedError(`copyExternalImageToTexture from ${name}; use an image, an ImageBitmap, ImageData, a canvas or a video`);
  }
  const s = picture.source;
  if (s.kind === 'src') return { source: { src: s.src }, width: picture.width, height: picture.height };
  if (s.kind === 'pixels') return { source: { pixels: { id: blobOf(tables, new Uint8Array(Buffer.from(s.data, 'base64'))), width: s.width, height: s.height } }, width: picture.width, height: picture.height };
  if (s.kind === 'video') return { source: { video: { src: s.src, time: s.time } }, width: picture.width, height: picture.height };
  if (s.kind === 'layer') throw new WebGpuUnsupportedError('copyExternalImageToTexture from a layer picture outside layerPicture()');
  if (s.kind === 'ref') throw new WebGpuUnsupportedError('copyExternalImageToTexture from a sources table entry (only a written scene holds one)');
  const pixels = device.options.rasterize?.(s) ?? null;
  if (pixels === null) throw new WebGpuUnsupportedError('copyExternalImageToTexture from a canvas here (the pixels of a canvas need the addon)');
  return { source: { pixels: { id: blobOf(tables, pixels), width: s.width, height: s.height } }, width: s.width, height: s.height };
}

export class GPUQueueShim extends GpuObject {
  constructor(private readonly device: GPUDeviceShim) {
    super('');
  }
  writeBuffer(buffer: GPUBufferShim, bufferOffset: number, data: unknown, dataOffset?: number, size?: number): void {
    if (!(buffer instanceof GPUBufferShim)) throw new TypeError("writeBuffer: 'buffer' is not a GPUBuffer");
    const bytes = asBytes(data, dataOffset, size);
    range('writeBuffer', Number.isInteger(bufferOffset) && bufferOffset >= 0 && bufferOffset + bytes.byteLength <= buffer.size && bufferOffset % 4 === 0 && bytes.byteLength % 4 === 0);
    if (buffer.gpu) this.device.writeGpuBuffer(buffer, bufferOffset, bytes);
    else buffer.write(bufferOffset, bytes);
  }
  submit(commandBuffers: GPUCommandBufferShim[]): void {
    for (const commandBuffer of commandBuffers) {
      for (const item of commandBuffer.items) {
        if (item.kind === 'copy') {
          range('copyBufferToBuffer', item.sourceOffset + item.size <= item.source.size && item.targetOffset + item.size <= item.target.size);
          this.device.copyBuffer(item);
        } else if (item.kind === 'clear') {
          range('clearBuffer', item.offset + item.size <= item.buffer.size);
          if (item.buffer.gpu) this.device.clearGpuBuffer(item.buffer, item.offset, item.size);
          else item.buffer.write(item.offset, new Uint8Array(item.size));
        } else if (item.kind === 'compute') {
          this.device.encodeCompute(item.commands);
        } else if (item.kind === 'bufferToTexture') {
          this.device.uploadFromBuffer(item);
        } else if (item.kind === 'textureToTexture') {
          for (let i = 0; i < item.layers; i += 1) this.device.copyTexture({ ...item.from, layer: item.from.layer + i }, { ...item.to, layer: item.to.layer + i }, item.width, item.height);
        } else {
          this.device.encodePass(item.attachment, item.commands);
        }
      }
    }
  }
  onSubmittedWorkDone(): Promise<void> {
    return Promise.resolve();
  }
  /** `writeTexture(destination, data, dataLayout, size)`: the bytes are copied now, in the queue's order. */
  writeTexture(
    destination: { texture: GPUTextureShim; mipLevel?: number; origin?: unknown; aspect?: string },
    data: unknown,
    dataLayout: { offset?: number; bytesPerRow?: number; rowsPerImage?: number },
    size: unknown,
  ): void {
    const call = 'writeTexture';
    const extent = sizeOf(call, size);
    const to = regionOf(call, 'destination', destination, extent.width, extent.height, extent.depth, GPU_TEXTURE_USAGE.COPY_DST, 'COPY_DST');
    const bytes = asBytes(data, undefined, undefined);
    const layout = dataLayout ?? {};
    const offset = whole(call, 'offset', layout.offset ?? 0, 0);
    const texel = to.texture.texelBytes;
    const rowBytes = extent.width * texel;
    if ((extent.height > 1 || extent.depth > 1) && layout.bytesPerRow === undefined) throw new RangeError(`OperationError: ${call}: bytesPerRow is needed to write more than one row`);
    const bytesPerRow = layout.bytesPerRow === undefined ? rowBytes : whole(call, 'bytesPerRow', layout.bytesPerRow, 0);
    if (bytesPerRow < rowBytes) throw new RangeError(`OperationError: ${call}: bytesPerRow ${bytesPerRow} is less than the ${rowBytes} bytes of a row`);
    const rowsPerImage = imageRows(call, layout.rowsPerImage, extent.height, extent.depth);
    if (extent.width === 0 || extent.height === 0 || extent.depth === 0) return;
    if (offset + ((extent.depth - 1) * rowsPerImage + extent.height - 1) * bytesPerRow + rowBytes > bytes.byteLength) {
      throw new RangeError(`OperationError: ${call}: the copy reads past the ${bytes.byteLength} bytes of the data`);
    }
    for (let i = 0; i < extent.depth; i += 1) this.device.uploadBytes({ ...to, layer: to.layer + i }, extent.width, extent.height, bytes, offset + i * rowsPerImage * bytesPerRow, bytesPerRow);
  }
  /** `copyExternalImageToTexture({ source, origin, flipY }, { texture, mipLevel, origin, premultipliedAlpha, colorSpace }, copySize)`. */
  copyExternalImageToTexture(
    source: { source: unknown; origin?: unknown; flipY?: boolean },
    destination: { texture: GPUTextureShim; mipLevel?: number; origin?: unknown; aspect?: string; premultipliedAlpha?: boolean; colorSpace?: string },
    copySize: unknown,
  ): void {
    const call = 'copyExternalImageToTexture';
    const extent = sizeOf(call, copySize);
    const to = regionOf(call, 'destination', destination, extent.width, extent.height, extent.depth, GPU_TEXTURE_USAGE.COPY_DST, 'COPY_DST');
    if (extent.depth !== 1) throw new RangeError(`OperationError: ${call}: the copy size has ${extent.depth} layers; it is one, the layer being the origin's z`);
    if ((to.texture.usage & GPU_TEXTURE_USAGE.RENDER_ATTACHMENT) === 0) throw new RangeError(`OperationError: ${call}: the destination texture was made without GPUTextureUsage.RENDER_ATTACHMENT`);
    if (!PICTURE_FORMATS.has(to.texture.format)) throw this.device.unsupported(`${call} into a ${to.texture.format} texture; use rgba8unorm, rgba8unorm-srgb, bgra8unorm or bgra8unorm-srgb`);
    if (destination.colorSpace !== undefined && destination.colorSpace !== 'srgb') throw this.device.unsupported(`${call} with the colorSpace ${destination.colorSpace}`);
    const tables = newTables();
    const read = externalSource(this.device, source?.source, tables);
    const origin = originOf(call, source?.origin);
    rectIn(call, 'source rectangle', read, origin.x, origin.y, extent.width, extent.height);
    if (extent.width === 0 || extent.height === 0) return;
    const step: WebGpuStep = {
      k: 'upload',
      texture: to.texture.id,
      ...(to.mip === 0 ? {} : { mip: to.mip }),
      ...layerOf(to.layer),
      x: to.x,
      y: to.y,
      width: extent.width,
      height: extent.height,
      source: read.source,
      ...(origin.x === 0 ? {} : { sx: origin.x }),
      ...(origin.y === 0 ? {} : { sy: origin.y }),
      ...(source?.flipY ? { flipY: true } : {}),
      ...(destination.premultipliedAlpha ? { premultiply: true } : {}),
    };
    this.device.append({ step, canvas: null, tables, textures: new Set([to.texture]), reads: new Set(), writes: this.device.writesOf(to, extent.width, extent.height) });
  }
}

const SHADER_BINDING_TYPES = new Set(['uniform', 'storage', 'read-only-storage']);

export class GPUDeviceShim extends EventTarget {
  label = '';
  readonly features = new Set<string>();
  readonly limits: Record<string, number>;
  readonly queue: GPUQueueShim;
  /** Never settles: the device is not lost. */
  readonly lost: Promise<never> = new Promise(() => {});
  /** The canvases configured with this device. */
  readonly contexts = new Set<GPUCanvasContextShim>();
  /** What the page did that is not drawn. Kept for the life of the device: the picture is affected from then on. */
  readonly notes = new Set<string>();
  /** The invalid calls the page made (each threw), and a page may have caught: a frame reports them (`webgpu-errors.ts`). */
  readonly errors = new Set<string>();
  private readonly scopes = new ErrorScopes();
  private total = 0;
  private textureTotal = 0;
  private textureCount = 0;
  private bufferCount = 0;
  /** The number of the frame being drawn: it grows when the frame loop starts one after work was submitted. */
  private frame = 0;
  private worked = false;
  /** What the queue did, in order: the frame's passes into canvases, and the steps that wrote textures. */
  private steps: LogStep[] = [];

  constructor(readonly options: GpuOptions = {}, limits?: Record<string, number>) {
    super();
    this.limits = { ...(limits ?? LIMITS) };
    this.queue = new GPUQueueShim(this);
  }
  note(what: string): void {
    this.notes.add(what);
  }
  /** An error one of the device's checks is about to throw: kept for the frame's report and for the open error scope. */
  invalid(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.errors.size < MAX_ERRORS) this.errors.add(message);
    this.scopes.capture(message);
  }
  unsupported(what: string): WebGpuUnsupportedError {
    this.note(what);
    return new WebGpuUnsupportedError(what);
  }
  reserve(size: number): void {
    if (this.total + size > MAX_TOTAL_BYTES) throw new RangeError('createBuffer: the buffers together would exceed 1 GiB');
    this.total += size;
  }
  release(size: number): void {
    this.total = Math.max(0, this.total - size);
  }
  nextTextureId(): number {
    this.textureCount += 1;
    return this.textureCount;
  }
  nextBufferId(): number {
    this.bufferCount += 1;
    return this.bufferCount;
  }
  reserveTexture(size: number): void {
    const cap = maxTextureBytes(this.limits.maxTextureDimension2D ?? LIMITS.maxTextureDimension2D);
    if (this.textureTotal + size > cap) {
      throw new RangeError(`OperationError: createTexture: the textures together would exceed ${cap} bytes (all levels counted)`);
    }
    this.textureTotal += size;
  }
  releaseTexture(size: number): void {
    this.textureTotal = Math.max(0, this.textureTotal - size);
  }

  // ---- the log ----

  /** The steps a canvas's recording could hold: every step into a texture or a buffer, and the canvas's own passes, in order. */
  stepsFor(context: GPUCanvasContextShim): LogStep[] {
    return this.steps.filter((s) => s.canvas === null || s.canvas === context);
  }
  /**
   * The steps the picture of `context` depends on, in order: the canvas's passes, and, going back, the steps that wrote
   * what they read and were not written over since (a step that only part-writes a texture or a buffer depends on the one
   * before it). A step that wrote something nothing reads is left out.
   */
  liveStepsFor(context: GPUCanvasContextShim): LogStep[] {
    const candidates = this.stepsFor(context);
    // Nothing is drawn on the canvas yet: nothing stands for a picture, so every step is kept.
    if (!candidates.some((s) => s.canvas !== null)) return candidates;
    const live: LogStep[] = [];
    const needed = new Set<string>();
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const step = candidates[i]!;
      if (step.canvas === null && !step.writes.some((w) => needed.has(w.key))) continue;
      live.push(step);
      for (const w of step.writes) if (w.whole) needed.delete(w.key);
      for (const key of step.reads) needed.add(key);
    }
    return live.reverse();
  }
  hasPassFor(context: GPUCanvasContextShim): boolean {
    return this.steps.some((s) => s.canvas === context);
  }
  /**
   * What the live steps of a frame carry over from earlier frames: the passes into textures and compute passes that a
   * frame after the first made and this one still reads (what the first made is the page's setup). A frame that reads them is not the same drawn alone, or by another worker.
   */
  carried(steps: LogStep[]): string[] {
    let compute = 0;
    let render = 0;
    for (const s of steps) {
      // What the first frame made is the page's setup (it runs again, whichever frame is drawn first): not carried.
      if ((s.frame ?? 0) < 1 || (s.frame ?? 0) >= this.frame || s.canvas !== null) continue;
      if (s.step.k === 'compute') compute += 1;
      else if (s.step.k === 'render') render += 1;
    }
    if (compute + render === 0) return [];
    const what = [compute > 0 ? `${compute} compute pass${compute === 1 ? '' : 'es'}` : '', render > 0 ? `${render} render pass${render === 1 ? '' : 'es'} into a texture` : ''].filter((x) => x !== '');
    return [`the frame reads state made in earlier frames (${what.join(' and ')}); it is not the same drawn alone as in a sequence`];
  }
  /** A new frame of `context` starts: its passes of the last one go. */
  dropFrameOf(context: GPUCanvasContextShim): void {
    this.steps = this.steps.filter((s) => s.canvas !== context);
  }
  /** The frame loop is about to draw a frame: what is submitted from now on is of the next one (once, whatever the number of canvases). */
  frameStarted(): void {
    if (!this.worked) return;
    this.worked = false;
    this.frame += 1;
  }
  /**
   * A destroyed texture's (or buffer's) steps go, unless a step still held reads what they wrote: work that was
   * submitted before `destroy()` runs before it, as on a device (an effect that uploads, draws and destroys in one call).
   */
  forget(owner: GPUTextureShim | GPUBufferShim): void {
    const ownedOnly = (s: LogStep): boolean => s.writes.length > 0 && s.writes.every((w) => w.owner === owner);
    const readByOthers = (s: LogStep): boolean => s.writes.some((w) => this.steps.some((other) => other !== s && !ownedOnly(other) && other.reads.has(w.key)));
    this.steps = this.steps.filter((s) => !ownedOnly(s) || readByOthers(s));
  }
  append(entry: LogStep): void {
    entry.frame = this.frame;
    this.worked = true;
    // A part-write keeps what it does not write: it reads it.
    for (const w of entry.writes) if (!w.whole) entry.reads.add(w.key);
    this.steps.push(entry);
    if (entry.writes.some((w) => w.whole)) this.prune();
    let dispatches = 0;
    let workgroups = 0;
    for (const s of this.steps) {
      if (s.step.k !== 'compute') continue;
      for (const c of s.step.commands) {
        if (c.c === 'dispatch') {
          dispatches += 1;
          workgroups += c.x * c.y * c.z;
        }
      }
    }
    if (dispatches > MAX_DISPATCHES || workgroups > MAX_WORKGROUPS) {
      this.steps.splice(this.steps.lastIndexOf(entry), 1);
      throw new RangeError(`OperationError: the queued compute work is ${dispatches} dispatches and ${workgroups} workgroups; a frame may hold ${MAX_DISPATCHES} and ${MAX_WORKGROUPS} (overwrite what a pass writes every frame so that earlier frames' work is dropped)`);
    }
    if (this.steps.length > MAX_STEPS) {
      this.note(`more than ${MAX_STEPS} queued steps into textures and buffers (the oldest are dropped; clear or overwrite them each frame)`);
      this.steps.splice(0, this.steps.length - MAX_STEPS);
    }
  }
  /** What a write of `width` x `height` at a region of its level changes. */
  writesOf(to: TextureRegion, width: number, height: number): LogWrite[] {
    const extent = to.texture.extent(to.mip);
    return [{ key: levelKey(to.texture, to.mip, to.layer), whole: to.x === 0 && to.y === 0 && width === extent.width && height === extent.height, owner: to.texture }];
  }
  /**
   * Drops the steps whose results all a later step wrote over before anything read them: a step every write of which is
   * covered by a later, whole write of the same level or buffer, with no step between them that reads it. One pass from the
   * newest back is enough, since dropping a reader only frees what lies before it.
   */
  private prune(): void {
    for (let i = this.steps.length - 2; i >= 0; i -= 1) {
      const step = this.steps[i]!;
      if (step.canvas !== null || step.writes.length === 0) continue;
      if (step.writes.every((w) => this.overwritten(i, w.key))) this.steps.splice(i, 1);
    }
  }
  private overwritten(i: number, key: string): boolean {
    for (let j = i + 1; j < this.steps.length; j += 1) {
      const later = this.steps[j]!;
      if (later.reads.has(key)) return false;
      if (later.writes.some((w) => w.key === key && w.whole)) return true;
    }
    return false;
  }

  /** The buffer's bytes are made by the GPU from here on: what it holds now becomes the first step of its log. */
  promote(buffer: GPUBufferShim): void {
    if (buffer.gpu) return;
    buffer.gpuId = buffer.key;
    if (!buffer.data.some((b) => b !== 0)) return;
    this.writeGpuBuffer(buffer, 0, buffer.data, true);
  }
  /** `queue.writeBuffer` into a buffer the GPU writes. */
  writeGpuBuffer(buffer: GPUBufferShim, offset: number, bytes: Bytes, fromShadow = false): void {
    if (bytes.length === 0) return;
    const tables = newTables();
    tables.gpuBuffers.set(buffer.key, { size: buffer.size });
    const step: WebGpuStep = { k: 'writeBuffer', buffer: buffer.key, offset, data: blobOf(tables, bytes) };
    if (!fromShadow) buffer.write(offset, bytes);
    this.append({ step, canvas: null, tables, textures: new Set(), gpuBuffers: new Set([buffer]), reads: new Set(), writes: [{ key: buffer.key, whole: offset === 0 && bytes.length === buffer.size, owner: buffer }] });
  }
  clearGpuBuffer(buffer: GPUBufferShim, offset: number, size: number): void {
    if (size === 0) return;
    const tables = newTables();
    tables.gpuBuffers.set(buffer.key, { size: buffer.size });
    const step: WebGpuStep = { k: 'clearBuffer', buffer: buffer.key, offset, size };
    this.append({ step, canvas: null, tables, textures: new Set(), gpuBuffers: new Set([buffer]), reads: new Set(), writes: [{ key: buffer.key, whole: offset === 0 && size === buffer.size, owner: buffer }] });
  }
  /** `copyBufferToBuffer` as the queue runs it. */
  copyBuffer(item: Extract<EncodedItem, { kind: 'copy' }>): void {
    const { source, target, sourceOffset, targetOffset, size } = item;
    if (size === 0) return;
    if (!source.gpu && !target.gpu) {
      target.write(targetOffset, source.data.slice(sourceOffset, sourceOffset + size));
      return;
    }
    if (!source.gpu) {
      this.writeGpuBuffer(target, targetOffset, source.data.slice(sourceOffset, sourceOffset + size));
      return;
    }
    this.promote(target);
    const tables = newTables();
    tables.gpuBuffers.set(source.key, { size: source.size });
    tables.gpuBuffers.set(target.key, { size: target.size });
    const step: WebGpuStep = { k: 'copyBuffer', from: source.key, fromOffset: sourceOffset, to: target.key, toOffset: targetOffset, size };
    this.append({
      step,
      canvas: null,
      tables,
      textures: new Set(),
      gpuBuffers: new Set([source, target]),
      reads: new Set([source.key]),
      writes: [{ key: target.key, whole: targetOffset === 0 && size === target.size, owner: target }],
    });
  }

  /** What a bind group names, as the recording holds it: buffers by snapshot or by id, texture views, samplers. */
  private snapshotGroup(group: GPUBindGroupShim, tables: Tables, textures: Set<GPUTextureShim>, gpuBuffers: Set<GPUBufferShim>, reads: Set<string>, writes: Map<string, LogWrite>): string {
    if (!group.layout.id.startsWith('auto:')) tables.layouts.set(group.layout.id, group.layout.entries);
    const entries: WebGpuBindEntry[] = [];
    for (const e of group.entries) {
      const written = group.layout.writes(e.binding);
      if ('buffer' in e) {
        if (written === 'buffer') this.promote(e.buffer);
        const id = this.bufferId(e.buffer, tables, gpuBuffers, reads);
        if (written === 'buffer') writes.set(e.buffer.key, { key: e.buffer.key, whole: false, owner: e.buffer });
        entries.push({ binding: e.binding, buffer: id, offset: e.offset, size: e.size });
      } else if ('view' in e) {
        textures.add(e.view.texture);
        for (const key of e.view.keys()) {
          reads.add(key);
          if (written === 'texture') writes.set(key, { key, whole: false, owner: e.view.texture });
        }
        const v = e.view;
        entries.push({
          binding: e.binding,
          texture: { id: v.texture.id, baseMip: v.baseMip, mips: v.mips, ...(v.baseLayer === 0 ? {} : { baseLayer: v.baseLayer }), ...(v.layers === 1 ? {} : { layers: v.layers }), ...(v.dimension === '2d' ? {} : { dimension: v.dimension }) },
        });
      } else {
        tables.samplers.set(e.sampler.id, e.sampler.descriptor);
        entries.push({ binding: e.binding, sampler: e.sampler.id });
      }
    }
    const snapshot: WebGpuBindGroup = { layout: group.layout.id, entries };
    const id = `g${hashOf(JSON.stringify(snapshot))}`;
    tables.bindGroups.set(id, snapshot);
    return id;
  }
  /** The id a buffer goes by in a recording: a snapshot of its bytes, or, once the GPU writes it, its own. */
  private bufferId(buffer: GPUBufferShim, tables: Tables, gpuBuffers: Set<GPUBufferShim>, reads: Set<string>): string {
    if (!buffer.gpu) return buffer.snapshot(tables.buffers);
    tables.gpuBuffers.set(buffer.key, { size: buffer.size });
    gpuBuffers.add(buffer);
    reads.add(buffer.key);
    return buffer.key;
  }

  /** A render pass the queue ran: snapshots what it reads and adds it to the log. */
  encodePass(attachment: Attachment, commands: PassCommand[]): void {
    const canvas = attachment.context;
    if (canvas !== null) canvas.begin();
    const tables = newTables();
    const textures = new Set<GPUTextureShim>();
    const gpuBuffers = new Set<GPUBufferShim>();
    const reads = new Set<string>();
    const writes = new Map<string, LogWrite>();
    const out: WebGpuCommand[] = [];
    for (const command of commands) {
      switch (command.c) {
        case 'pipeline': {
          const { pipeline } = command;
          for (const module of pipeline.modules) tables.modules.set(module.id, module.code);
          for (const layout of pipeline.layouts ?? []) tables.layouts.set(layout.id, layout.entries);
          tables.pipelines.set(pipeline.id, pipeline.descriptor);
          out.push({ c: 'pipeline', id: pipeline.id });
          break;
        }
        case 'bind': {
          const id = this.snapshotGroup(command.group, tables, textures, gpuBuffers, reads, writes);
          out.push(command.offsets === undefined ? { c: 'bind', index: command.index, group: id } : { c: 'bind', index: command.index, group: id, offsets: command.offsets });
          break;
        }
        case 'vertex':
          out.push({ ...command, buffer: this.bufferId(command.buffer, tables, gpuBuffers, reads) });
          break;
        case 'index':
          out.push({ ...command, buffer: this.bufferId(command.buffer, tables, gpuBuffers, reads) });
          break;
        default:
          out.push(command);
      }
    }
    const target = attachment.texture;
    const pass: WebGpuPass = {
      k: 'render',
      ...(target === null ? {} : { target: { texture: target.id, mip: attachment.mip, ...layerOf(attachment.layer) } }),
      ...(attachment.depthOnly ? { depthOnly: true as const } : {}),
      ...(attachment.resolve ? { resolve: { texture: attachment.resolve.texture.id, mip: attachment.resolve.mip, ...layerOf(attachment.resolve.layer) } } : {}),
      clear: attachment.clear,
      ...(attachment.more ? { more: attachment.more.map((m) => ({ texture: m.texture!.id, mip: m.mip, ...layerOf(m.layer), clear: m.clear, ...(m.resolve ? { resolve: { texture: m.resolve.texture.id, mip: m.resolve.mip, ...layerOf(m.resolve.layer) } } : {}) })) } : {}),
      ...(attachment.depth ? { depth: { texture: attachment.depth.texture.id, mip: attachment.depth.mip, ...layerOf(attachment.depth.layer), clear: attachment.depth.clear, ...(attachment.depth.readOnly ? { readOnly: true } : {}) } } : {}),
      commands: out,
    };
    const all = [...writes.values()];
    if (attachment.depth) {
      const depth = attachment.depth;
      textures.add(depth.texture);
      const key = levelKey(depth.texture, depth.mip, depth.layer);
      if (depth.readOnly) reads.add(key);
      else all.push({ key, whole: depth.clear !== null, owner: depth.texture });
    }
    for (const a of target === null ? [] : [attachment, ...(attachment.more ?? [])]) {
      textures.add(a.texture!);
      all.push({ key: levelKey(a.texture!, a.mip, a.layer), whole: a.clear !== null, owner: a.texture! });
      // What the pass resolves into is replaced whole.
      if (a.resolve) {
        textures.add(a.resolve.texture);
        all.push({ key: levelKey(a.resolve.texture, a.resolve.mip, a.resolve.layer), whole: true, owner: a.resolve.texture });
      }
    }
    this.append({ step: pass, canvas, tables, textures, gpuBuffers, reads, writes: all });
  }

  /** A compute pass the queue ran: snapshots what it reads, and notes what it writes (how much of it is unknown, so it reads what it writes). */
  encodeCompute(commands: ComputeRecord[]): void {
    const tables = newTables();
    const textures = new Set<GPUTextureShim>();
    const gpuBuffers = new Set<GPUBufferShim>();
    const reads = new Set<string>();
    const writes = new Map<string, LogWrite>();
    const out: WebGpuComputeCommand[] = [];
    for (const command of commands) {
      switch (command.c) {
        case 'pipeline': {
          const { pipeline } = command;
          tables.modules.set(pipeline.module.id, pipeline.module.code);
          for (const layout of pipeline.layouts ?? []) tables.layouts.set(layout.id, layout.entries);
          tables.computePipelines.set(pipeline.id, pipeline.descriptor);
          out.push({ c: 'pipeline', id: pipeline.id });
          break;
        }
        case 'bind': {
          const id = this.snapshotGroup(command.group, tables, textures, gpuBuffers, reads, writes);
          out.push(command.offsets === undefined ? { c: 'bind', index: command.index, group: id } : { c: 'bind', index: command.index, group: id, offsets: command.offsets });
          break;
        }
        case 'dispatch':
          out.push(command);
          break;
      }
    }
    if (!out.some((c) => c.c === 'dispatch')) return;
    this.append({ step: { k: 'compute', commands: out }, canvas: null, tables, textures, gpuBuffers, reads, writes: [...writes.values()] });
  }

  /** `writeTexture`: rows of `bytes` from `offset`, `bytesPerRow` apart, packed. */
  uploadBytes(to: TextureRegion, width: number, height: number, bytes: Bytes, offset: number, bytesPerRow: number): void {
    const rowBytes = width * to.texture.texelBytes;
    const packed = new Uint8Array(rowBytes * height);
    for (let row = 0; row < height; row += 1) packed.set(bytes.subarray(offset + row * bytesPerRow, offset + row * bytesPerRow + rowBytes), row * rowBytes);
    const tables = newTables();
    const step: WebGpuStep = { k: 'upload', texture: to.texture.id, ...(to.mip === 0 ? {} : { mip: to.mip }), ...layerOf(to.layer), x: to.x, y: to.y, width, height, source: { raw: blobOf(tables, packed) } };
    this.append({ step, canvas: null, tables, textures: new Set([to.texture]), reads: new Set(), writes: this.writesOf(to, width, height) });
  }

  /** `copyBufferToTexture` as the queue runs it: the bytes the buffer holds now. */
  uploadFromBuffer(item: Extract<EncodedItem, { kind: 'bufferToTexture' }>): void {
    if (item.width === 0 || item.height === 0 || item.layers === 0) return;
    if (item.buffer.gpu) throw this.unsupported('copyBufferToTexture from a buffer a pass wrote; write the texture from a shader or with queue.writeTexture');
    for (let i = 0; i < item.layers; i += 1) this.uploadBytes({ ...item.to, layer: item.to.layer + i }, item.width, item.height, item.buffer.data, item.offset + i * item.rowsPerImage * item.bytesPerRow, item.bytesPerRow);
  }

  copyTexture(from: TextureRegion, to: TextureRegion, width: number, height: number): void {
    if (width === 0 || height === 0) return;
    const step: WebGpuStep = {
      k: 'copy',
      from: { texture: from.texture.id, ...(from.mip === 0 ? {} : { mip: from.mip }), ...layerOf(from.layer), x: from.x, y: from.y },
      to: { texture: to.texture.id, ...(to.mip === 0 ? {} : { mip: to.mip }), ...layerOf(to.layer), x: to.x, y: to.y },
      width,
      height,
    };
    this.append({ step, canvas: null, tables: newTables(), textures: new Set([from.texture, to.texture]), reads: new Set([levelKey(from.texture, from.mip, from.layer)]), writes: this.writesOf(to, width, height) });
  }

  createBuffer(descriptor: { size: number; usage: number; label?: string; mappedAtCreation?: boolean }): GPUBufferShim {
    return new GPUBufferShim(this, descriptor);
  }
  createShaderModule(descriptor: { code: string; label?: string }): GPUShaderModuleShim {
    return new GPUShaderModuleShim(descriptor);
  }
  createBindGroupLayout(descriptor: {
    entries: {
      binding: number;
      visibility: number;
      buffer?: { type?: string; hasDynamicOffset?: boolean };
      sampler?: { type?: string };
      texture?: { sampleType?: string; viewDimension?: string; multisampled?: boolean };
      storageTexture?: { access?: string; format?: string; viewDimension?: string };
      externalTexture?: unknown;
    }[];
    label?: string;
  }): GPUBindGroupLayoutShim {
    const entries: WebGpuBindingLayout[] = [];
    for (const e of descriptor.entries ?? []) {
      if (e.externalTexture) throw this.unsupported('a bind group layout with an external texture');
      const kinds = [e.buffer, e.sampler, e.texture, e.storageTexture].filter((k) => k !== undefined && k !== null).length;
      if (kinds !== 1) throw new TypeError('createBindGroupLayout: an entry has exactly one of buffer, sampler, texture and storageTexture');
      whole('createBindGroupLayout', 'binding', e.binding, 0);
      const visibility = whole('createBindGroupLayout', 'visibility', e.visibility, 0);
      if (visibility > 7) throw new RangeError(`OperationError: createBindGroupLayout: visibility ${visibility} is not a combination of GPUShaderStage flags`);
      if (e.storageTexture) {
        const access = e.storageTexture.access ?? 'write-only';
        const format = e.storageTexture.format;
        const info = typeof format === 'string' ? FORMATS[format] : undefined;
        if (!['write-only', 'read-only', 'read-write'].includes(access)) throw new TypeError(`createBindGroupLayout: storage texture access ${String(access)}`);
        if (info === undefined) throw new TypeError(`createBindGroupLayout: the storage texture format ${String(format)} is not one of ${FORMAT_NAMES}`);
        if (info.storage === 'none') throw new TypeError(`createBindGroupLayout: ${format} cannot be a storage texture (it needs an optional feature)`);
        if (access !== 'write-only' && info.storage !== 'readwrite') throw new TypeError(`createBindGroupLayout: a ${access} storage texture of ${format} needs an optional feature (r32float, r32uint and r32sint have it)`);
        if ((e.storageTexture.viewDimension ?? '2d') !== '2d') throw this.unsupported(`a storage texture of the view dimension ${e.storageTexture.viewDimension}`);
        if (visibility & GPU_SHADER_STAGE.VERTEX) throw new TypeError('createBindGroupLayout: a storage texture is not visible to the vertex stage');
        entries.push({ binding: e.binding, visibility, type: 'storage-texture', ...(access === 'write-only' ? {} : { access: access as 'read-only' | 'read-write' }), format: format! });
        continue;
      }
      if (e.texture) {
        const sampleType = e.texture.sampleType ?? 'float';
        if (!['float', 'unfilterable-float', 'sint', 'uint', 'depth'].includes(sampleType)) throw this.unsupported(`a texture binding of the sample type ${sampleType}`);
        const viewDimension = e.texture.viewDimension ?? '2d';
        if (!['2d', '2d-array', 'cube', 'cube-array'].includes(viewDimension)) throw this.unsupported(`a texture binding of the view dimension ${viewDimension}`);
        if (e.texture.multisampled) throw this.unsupported('a multisampled texture binding');
        entries.push({ binding: e.binding, visibility, type: 'texture', ...(sampleType === 'float' ? {} : { sampleType: sampleType as 'unfilterable-float' | 'sint' | 'uint' | 'depth' }), ...(viewDimension === '2d' ? {} : { viewDimension: viewDimension as 'cube' }) });
      } else if (e.sampler) {
        const type = e.sampler.type ?? 'filtering';
        if (type !== 'filtering' && type !== 'non-filtering' && type !== 'comparison') throw new TypeError(`createBindGroupLayout: sampler type ${type}`);
        entries.push({ binding: e.binding, visibility, type: 'sampler', ...(type === 'filtering' ? {} : { samplerType: type }) });
      } else {
        const type = e.buffer!.type ?? 'uniform';
        if (!SHADER_BINDING_TYPES.has(type)) throw new TypeError(`createBindGroupLayout: buffer type ${type}`);
        if (type === 'storage' && visibility & GPU_SHADER_STAGE.VERTEX) throw new TypeError('createBindGroupLayout: a read-write storage buffer is not visible to the vertex stage');
        const entry: WebGpuBindingLayout = { binding: e.binding, visibility, type: type as WebGpuBindingLayout['type'] };
        if (e.buffer!.hasDynamicOffset) entry.dynamicOffset = true;
        entries.push(entry);
      }
    }
    entries.sort((a, b) => a.binding - b.binding);
    for (let n = 1; n < entries.length; n += 1) {
      if (entries[n]!.binding === entries[n - 1]!.binding) throw new TypeError(`createBindGroupLayout: binding ${entries[n]!.binding} twice`);
    }
    for (const [stage, bit] of [['vertex', 1], ['fragment', 2], ['compute', 4]] as const) {
      const here = entries.filter((e) => (e.visibility & bit) !== 0);
      const buffers = here.filter((e) => e.type === 'storage' || e.type === 'read-only-storage').length;
      const images = here.filter((e) => e.type === 'storage-texture').length;
      if (buffers > this.limits.maxStorageBuffersPerShaderStage!) throw new RangeError(`OperationError: createBindGroupLayout: ${buffers} storage buffers in the ${stage} stage; the device allows ${this.limits.maxStorageBuffersPerShaderStage}`);
      if (images > this.limits.maxStorageTexturesPerShaderStage!) throw new RangeError(`OperationError: createBindGroupLayout: ${images} storage textures in the ${stage} stage; the device allows ${this.limits.maxStorageTexturesPerShaderStage}`);
    }
    return new GPUBindGroupLayoutShim(entries);
  }
  createPipelineLayout(descriptor: { bindGroupLayouts: GPUBindGroupLayoutShim[]; label?: string }): GPUPipelineLayoutShim {
    return new GPUPipelineLayoutShim([...(descriptor.bindGroupLayouts ?? [])]);
  }
  /** A pipeline's `depthStencil` as the depth state; the stencil must be left at its defaults (it is not drawn). */
  private depthState(value: unknown): WebGpuDepthState | undefined {
    if (value === undefined || value === null) return undefined;
    const d = value as { format?: string; depthWriteEnabled?: boolean; depthCompare?: string; stencilFront?: Record<string, string>; stencilBack?: Record<string, string>; stencilReadMask?: number; stencilWriteMask?: number; depthBias?: number; depthBiasSlopeScale?: number; depthBiasClamp?: number };
    const format = d.format as string;
    if (!DEPTH_FORMATS.has(format)) throw this.unsupported(`a depthStencil format ${String(format)}; the depth formats are ${[...DEPTH_FORMATS].join(', ')} (stencil formats are not drawn)`);
    for (const face of [d.stencilFront, d.stencilBack]) {
      for (const key of ['compare', 'failOp', 'depthFailOp', 'passOp']) {
        const op = face?.[key];
        if (op !== undefined && op !== (key === 'compare' ? 'always' : 'keep')) throw this.unsupported(`a stencil state (${key} ${op})`);
      }
    }
    if (d.depthWriteEnabled === undefined) throw new TypeError('createRenderPipeline: depthStencil.depthWriteEnabled is required for a depth format');
    if (d.depthCompare !== undefined && !COMPARE_FUNCTIONS.has(d.depthCompare)) throw new TypeError(`createRenderPipeline: depthCompare ${String(d.depthCompare)}`);
    if (d.depthCompare === undefined && d.depthWriteEnabled === true) throw new TypeError('createRenderPipeline: depthStencil.depthCompare is required when depth is written');
    const state: WebGpuDepthState = { format };
    if (d.depthWriteEnabled) state.write = true;
    if (d.depthCompare !== undefined && d.depthCompare !== 'always') state.compare = d.depthCompare;
    if (d.depthBias) state.bias = Number(d.depthBias);
    if (d.depthBiasSlopeScale) state.biasSlopeScale = Number(d.depthBiasSlopeScale);
    if (d.depthBiasClamp) state.biasClamp = Number(d.depthBiasClamp);
    return state;
  }
  createRenderPipeline(descriptor: {
    layout: 'auto' | GPUPipelineLayoutShim;
    vertex: { module: GPUShaderModuleShim; entryPoint?: string; buffers?: ({ arrayStride: number; stepMode?: string; attributes: { format: string; offset: number; shaderLocation: number }[] } | null)[]; constants?: object };
    fragment?: { module: GPUShaderModuleShim; entryPoint?: string; targets: ({ format: string; blend?: { color: object; alpha: object }; writeMask?: number } | null)[]; constants?: object };
    primitive?: { topology?: string; stripIndexFormat?: string; frontFace?: string; cullMode?: string; unclippedDepth?: boolean };
    depthStencil?: unknown;
    multisample?: { count?: number; alphaToCoverageEnabled?: boolean };
    label?: string;
  }): GPURenderPipelineShim {
    const depthState = this.depthState(descriptor.depthStencil);
    const samples = descriptor.multisample?.count ?? 1;
    if (samples !== 1 && samples !== 4) throw new RangeError(`OperationError: createRenderPipeline: multisample.count ${samples}; it is 1 or 4`);
    if (descriptor.multisample?.alphaToCoverageEnabled) throw this.unsupported('alphaToCoverage');
    for (const stage of [descriptor.vertex, descriptor.fragment]) {
      if (stage?.constants && Object.keys(stage.constants).length > 0) throw this.unsupported('pipeline-overridable constants');
      if (stage && !(stage.module instanceof GPUShaderModuleShim)) throw new TypeError('createRenderPipeline: module is not a GPUShaderModule');
    }
    const pipelineLayout = descriptor.layout === 'auto' || descriptor.layout === undefined ? null : descriptor.layout;
    const layouts = pipelineLayout === null ? null : pipelineLayout.layouts;
    const modules = [descriptor.vertex.module];
    const pipeline: WebGpuPipeline = {
      vertex: {
        module: descriptor.vertex.module.id,
        buffers: (descriptor.vertex.buffers ?? []).map((b) => ({
          stride: b?.arrayStride ?? 0,
          ...(b?.stepMode === 'instance' ? { stepMode: 'instance' as const } : {}),
          attributes: (b?.attributes ?? []).map((a) => ({ format: a.format, offset: a.offset, location: a.shaderLocation })),
        })),
      },
      primitive: {
        topology: descriptor.primitive?.topology ?? 'triangle-list',
        frontFace: descriptor.primitive?.frontFace ?? 'ccw',
        cullMode: descriptor.primitive?.cullMode ?? 'none',
      },
      ...(depthState ? { depth: depthState } : {}),
      ...(samples === 1 ? {} : { samples }),
    };
    if (descriptor.vertex.entryPoint !== undefined) pipeline.vertex.entryPoint = descriptor.vertex.entryPoint;
    if (descriptor.primitive?.stripIndexFormat !== undefined) pipeline.primitive.stripIndexFormat = descriptor.primitive.stripIndexFormat;
    if (layouts !== null) pipeline.layout = layouts.map((l) => l.id);
    if (descriptor.fragment) {
      modules.push(descriptor.fragment.module);
      pipeline.fragment = {
        module: descriptor.fragment.module.id,
        targets: descriptor.fragment.targets.map((t) =>
          t === null || t === undefined
            ? null
            : {
                format: t.format,
                ...(t.blend ? { blend: { color: t.blend.color as object, alpha: t.blend.alpha as object } } : {}),
                ...(t.writeMask !== undefined && t.writeMask !== 15 ? { writeMask: t.writeMask } : {}),
              },
        ),
      };
      if (descriptor.fragment.entryPoint !== undefined) pipeline.fragment.entryPoint = descriptor.fragment.entryPoint;
    }
    return new GPURenderPipelineShim(pipeline, modules, layouts);
  }
  createRenderPipelineAsync(descriptor: Parameters<GPUDeviceShim['createRenderPipeline']>[0]): Promise<GPURenderPipelineShim> {
    try {
      return Promise.resolve(this.createRenderPipeline(descriptor));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  createBindGroup(descriptor: { layout: GPUBindGroupLayoutShim; entries: { binding: number; resource: BindResource }[]; label?: string }): GPUBindGroupShim {
    const entries: GPUBindGroupShim['entries'] = [];
    for (const e of descriptor.entries ?? []) {
      const resource = e.resource;
      const layoutEntry = descriptor.layout.id.startsWith('auto:') ? undefined : descriptor.layout.entries.find((x) => x.binding === e.binding);
      if (resource instanceof GPUTextureViewShim) {
        if (resource.texture.canvas !== null) throw this.unsupported("a bind group with the canvas's texture; render into a texture of your own to sample it");
        if (resource.texture.destroyed) throw new Error('OperationError: createBindGroup: the texture was destroyed');
        if (resource.texture.sampleCount > 1) throw this.unsupported('a bind group with a multisampled texture; resolve it into a texture and sample that');
        const storage = layoutEntry?.type === 'storage-texture';
        const need = layoutEntry === undefined ? GPU_TEXTURE_USAGE.TEXTURE_BINDING | GPU_TEXTURE_USAGE.STORAGE_BINDING : storage ? GPU_TEXTURE_USAGE.STORAGE_BINDING : GPU_TEXTURE_USAGE.TEXTURE_BINDING;
        if ((resource.texture.usage & need) === 0) {
          throw new RangeError(`OperationError: createBindGroup: the texture was made without GPUTextureUsage.${storage ? 'STORAGE_BINDING' : layoutEntry === undefined ? 'TEXTURE_BINDING or STORAGE_BINDING' : 'TEXTURE_BINDING'}`);
        }
        if (storage) {
          if (resource.mips !== 1) throw new RangeError(`OperationError: createBindGroup: binding ${e.binding} is a storage texture and its view has ${resource.mips} levels; it takes one`);
          if (resource.dimension !== '2d') throw new RangeError(`OperationError: createBindGroup: binding ${e.binding} is a storage texture and its view is a ${resource.dimension} view; it takes a 2d one`);
          if (layoutEntry.format !== resource.texture.format) throw new TypeError(`createBindGroup: binding ${e.binding} is a storage texture of ${layoutEntry.format} and the view is of a ${resource.texture.format} texture`);
        } else if (layoutEntry?.type === 'texture') {
          if ((layoutEntry.viewDimension ?? '2d') !== resource.dimension) {
            throw new TypeError(`createBindGroup: binding ${e.binding} is a ${layoutEntry.viewDimension ?? '2d'} texture in the layout and the view is a ${resource.dimension} view`);
          }
          const sample = FORMATS[resource.texture.format]!.sample;
          const wanted = layoutEntry.sampleType ?? 'float';
          const fits = wanted === 'depth' ? sample === 'depth' : sample === 'depth' ? wanted === 'unfilterable-float' : wanted === 'float' ? sample === 'float' || (sample === 'unfilterable-float' && this.features.has('float32-filterable')) : wanted === 'unfilterable-float' ? sample === 'float' || sample === 'unfilterable-float' : sample === wanted;
          if (!fits) {
            throw new TypeError(
              `createBindGroup: binding ${e.binding} samples a ${resource.texture.format} texture as ${wanted}${sample === 'unfilterable-float' ? ' (a 32-bit float texture is read as unfilterable-float with a non-filtering sampler, unless the device has float32-filterable)' : ''}`,
            );
          }
        }
        entries.push({ binding: e.binding, view: resource });
      } else if (resource instanceof GPUSamplerShim) {
        if (layoutEntry?.type === 'sampler' && (layoutEntry.samplerType === 'comparison') !== (resource.descriptor.compare !== undefined)) {
          throw new TypeError(`createBindGroup: binding ${e.binding} is a ${layoutEntry.samplerType ?? 'filtering'} sampler in the layout and the sampler ${resource.descriptor.compare !== undefined ? 'compares' : 'does not compare'}`);
        }
        entries.push({ binding: e.binding, sampler: resource });
      } else {
        const buffer = (resource as { buffer?: unknown })?.buffer;
        if (!(buffer instanceof GPUBufferShim)) throw new TypeError('createBindGroup: a resource is not a buffer binding, a texture view or a sampler');
        const offset = (resource as { offset?: number }).offset ?? 0;
        const size = (resource as { size?: number }).size ?? buffer.size - offset;
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(size) || size <= 0 || offset + size > buffer.size) {
          throw new RangeError(`OperationError: createBindGroup: binding ${e.binding} names the bytes ${offset}..${offset + size} of a buffer of ${buffer.size}`);
        }
        if (layoutEntry !== undefined && ['uniform', 'storage', 'read-only-storage'].includes(layoutEntry.type)) {
          const flag = layoutEntry.type === 'uniform' ? GPU_BUFFER_USAGE.UNIFORM : GPU_BUFFER_USAGE.STORAGE;
          if ((buffer.usage & flag) === 0) throw new RangeError(`OperationError: createBindGroup: binding ${e.binding} is a ${layoutEntry.type} buffer in the layout and the buffer was made without GPUBufferUsage.${layoutEntry.type === 'uniform' ? 'UNIFORM' : 'STORAGE'}`);
          const align = layoutEntry.type === 'uniform' ? this.limits.minUniformBufferOffsetAlignment! : this.limits.minStorageBufferOffsetAlignment!;
          if (offset % align !== 0) throw new RangeError(`OperationError: createBindGroup: the offset ${offset} of binding ${e.binding} is not a multiple of ${align}`);
          const most = layoutEntry.type === 'uniform' ? this.limits.maxUniformBufferBindingSize! : this.limits.maxStorageBufferBindingSize!;
          if (size > most) throw new RangeError(`OperationError: createBindGroup: binding ${e.binding} is ${size} bytes; the device allows ${most}`);
        }
        entries.push({ binding: e.binding, buffer, offset, size });
      }
    }
    entries.sort((a, b) => a.binding - b.binding);
    // A layout the page made says what each binding holds; an automatic one is read by the renderer.
    if (!descriptor.layout.id.startsWith('auto:')) {
      const want = descriptor.layout.entries;
      for (const layout of want) {
        const entry = entries.find((x) => x.binding === layout.binding);
        const kind = layout.type === 'texture' || layout.type === 'storage-texture' ? 'view' : layout.type === 'sampler' ? 'sampler' : 'buffer';
        if (entry === undefined || !(kind in entry)) throw new TypeError(`createBindGroup: binding ${layout.binding} is a ${layout.type} in the layout and the entry is not`);
      }
      for (const entry of entries) {
        if (!want.some((layout) => layout.binding === entry.binding)) throw new TypeError(`createBindGroup: the layout has no binding ${entry.binding}`);
      }
    }
    return new GPUBindGroupShim(descriptor.layout, entries);
  }
  createCommandEncoder(): GPUCommandEncoderShim {
    return new GPUCommandEncoderShim(this);
  }
  createTexture(descriptor: { size: unknown; format: string; usage: number; dimension?: string; mipLevelCount?: number; sampleCount?: number; viewFormats?: Iterable<string>; label?: string }): GPUTextureShim {
    const call = 'createTexture';
    if ((descriptor.dimension ?? '2d') !== '2d') throw this.unsupported(`a ${descriptor.dimension} texture; only 2D textures are drawn`);
    const samples = descriptor.sampleCount ?? 1;
    if (samples !== 1 && samples !== 4) throw new RangeError(`OperationError: createTexture: sampleCount ${samples}; it is 1 or 4`);
    if (descriptor.viewFormats !== undefined && [...descriptor.viewFormats].length > 0) throw this.unsupported('viewFormats on a texture');
    const size = sizeOf(call, descriptor.size);
    if (size.depth < 1 || size.depth > this.limits.maxTextureArrayLayers!) throw new RangeError(`OperationError: ${call}: ${size.depth} array layers; a texture has 1 to ${this.limits.maxTextureArrayLayers}`);
    const format = descriptor.format;
    if (FORMATS[format] === undefined) throw this.unsupported(`a texture of format ${String(format)}; the formats drawn are ${FORMAT_NAMES}`);
    const max = this.limits.maxTextureDimension2D!;
    if (size.width < 1 || size.height < 1 || size.width > max || size.height > max) throw new RangeError(`OperationError: ${call}: ${size.width} x ${size.height}; the sides run from 1 to ${max}`);
    const mips = whole(call, 'mipLevelCount', descriptor.mipLevelCount ?? 1, 1);
    if (mips > mostMips(size.width, size.height)) throw new RangeError(`OperationError: ${call}: ${mips} mip levels for a ${size.width} x ${size.height} texture (at most ${mostMips(size.width, size.height)})`);
    const usage = whole(call, 'usage', descriptor.usage, 0);
    if (usage === 0 || usage > 31) throw new RangeError(`OperationError: ${call}: usage ${usage} is not a combination of GPUTextureUsage flags drawn here`);
    if (usage & GPU_TEXTURE_USAGE.STORAGE_BINDING && FORMATS[format]!.storage === 'none') {
      throw new TypeError(`OperationError: ${call}: ${format} cannot have GPUTextureUsage.STORAGE_BINDING (it needs an optional feature)`);
    }
    if (samples > 1) {
      if (size.depth !== 1) throw new RangeError(`OperationError: ${call}: a multisampled texture has one array layer`);
      if (mips !== 1) throw new RangeError(`OperationError: ${call}: a multisampled texture has one mip level`);
      if (usage & GPU_TEXTURE_USAGE.STORAGE_BINDING || (usage & GPU_TEXTURE_USAGE.RENDER_ATTACHMENT) === 0) {
        throw new TypeError(`OperationError: ${call}: a multisampled texture is a render attachment and has no STORAGE_BINDING`);
      }
    }
    return new GPUTextureShim(this, null, size.width, size.height, format, usage, mips, descriptor.label, samples, size.depth);
  }
  createSampler(descriptor: SamplerDescriptor = {}): GPUSamplerShim {
    const d = descriptor ?? {};
    const out: WebGpuSampler = {};
    if (d.compare !== undefined) {
      if (!COMPARE_FUNCTIONS.has(d.compare)) throw new TypeError(`createSampler: compare ${String(d.compare)}`);
      out.compare = d.compare;
    }
    for (const key of ['addressModeU', 'addressModeV', 'addressModeW'] as const) {
      const mode = d[key];
      if (mode === undefined) continue;
      if (!ADDRESS_MODES.has(mode)) throw new TypeError(`createSampler: ${key} ${String(mode)}`);
      if (mode !== 'clamp-to-edge') out[key] = mode;
    }
    for (const key of ['magFilter', 'minFilter', 'mipmapFilter'] as const) {
      const filter = d[key];
      if (filter === undefined) continue;
      if (!FILTERS.has(filter)) throw new TypeError(`createSampler: ${key} ${String(filter)}`);
      if (filter !== 'nearest') out[key] = filter;
    }
    const min = d.lodMinClamp === undefined ? 0 : Number(d.lodMinClamp);
    const max = d.lodMaxClamp === undefined ? 32 : Number(d.lodMaxClamp);
    if (!(Number.isFinite(min) && Number.isFinite(max) && min >= 0 && min <= max)) throw new RangeError(`OperationError: createSampler: lodMinClamp ${min} and lodMaxClamp ${max} are not a range from 0 up`);
    if (min !== 0) out.lodMinClamp = min;
    if (max !== 32) out.lodMaxClamp = max;
    const anisotropy = whole('createSampler', 'maxAnisotropy', d.maxAnisotropy ?? 1, 1);
    if (anisotropy > 16) throw new RangeError(`OperationError: createSampler: maxAnisotropy ${anisotropy} is more than 16`);
    if (anisotropy > 1) {
      if (out.magFilter !== 'linear' || out.minFilter !== 'linear' || out.mipmapFilter !== 'linear') throw new RangeError('OperationError: createSampler: maxAnisotropy above 1 needs linear magFilter, minFilter and mipmapFilter');
      out.maxAnisotropy = anisotropy;
    }
    return new GPUSamplerShim(out);
  }
  createComputePipeline(descriptor: { layout: 'auto' | GPUPipelineLayoutShim; compute: { module: GPUShaderModuleShim; entryPoint?: string; constants?: object }; label?: string }): GPUComputePipelineShim {
    const stage = descriptor?.compute;
    if (!stage || !(stage.module instanceof GPUShaderModuleShim)) throw new TypeError('createComputePipeline: compute.module is not a GPUShaderModule');
    if (stage.constants && Object.keys(stage.constants).length > 0) throw this.unsupported('pipeline-overridable constants');
    const layout = descriptor.layout === 'auto' || descriptor.layout === undefined ? null : descriptor.layout;
    if (layout !== null && !(layout instanceof GPUPipelineLayoutShim)) throw new TypeError("createComputePipeline: 'layout' is not 'auto' or a GPUPipelineLayout");
    const size = workgroupSize(stage.module.code, stage.entryPoint);
    if (size !== null) {
      const l = this.limits;
      if (size[0] > l.maxComputeWorkgroupSizeX! || size[1] > l.maxComputeWorkgroupSizeY! || size[2] > l.maxComputeWorkgroupSizeZ!) {
        throw new RangeError(`OperationError: createComputePipeline: workgroup_size(${size.join(', ')}) is over the device's ${l.maxComputeWorkgroupSizeX} x ${l.maxComputeWorkgroupSizeY} x ${l.maxComputeWorkgroupSizeZ}`);
      }
      if (size[0] * size[1] * size[2] > l.maxComputeInvocationsPerWorkgroup!) {
        throw new RangeError(`OperationError: createComputePipeline: workgroup_size(${size.join(', ')}) is ${size[0] * size[1] * size[2]} invocations; the device allows ${l.maxComputeInvocationsPerWorkgroup}`);
      }
    }
    const pipeline: WebGpuComputePipeline = { module: stage.module.id };
    if (stage.entryPoint !== undefined) pipeline.entryPoint = stage.entryPoint;
    if (layout !== null) pipeline.layout = layout.layouts.map((x) => x.id);
    return new GPUComputePipelineShim(pipeline, stage.module, layout === null ? null : layout.layouts, size);
  }
  createComputePipelineAsync(descriptor: Parameters<GPUDeviceShim['createComputePipeline']>[0]): Promise<GPUComputePipelineShim> {
    try {
      return Promise.resolve(this.createComputePipeline(descriptor));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  createQuerySet(descriptor: QuerySetDescriptor): GPUQuerySetShim {
    return new GPUQuerySetShim(descriptor, this.features.has('timestamp-query'));
  }
  createRenderBundleEncoder(descriptor: { colorFormats?: (string | null)[]; depthStencilFormat?: string; sampleCount?: number; depthReadOnly?: boolean; stencilReadOnly?: boolean; label?: string }): GPURenderBundleEncoderShim {
    const call = 'createRenderBundleEncoder';
    const colorFormats = (descriptor?.colorFormats ?? []).filter((f) => f !== null && f !== undefined) as string[];
    for (const format of colorFormats) {
      if (FORMATS[format] === undefined || DEPTH_FORMATS.has(format)) throw new TypeError(`${call}: ${String(format)} is not a colour format that is drawn (${FORMAT_NAMES})`);
    }
    if (colorFormats.length > this.limits.maxColorAttachments!) throw new RangeError(`OperationError: ${call}: ${colorFormats.length} colour formats; the device allows ${this.limits.maxColorAttachments}`);
    const depthStencilFormat = descriptor?.depthStencilFormat ?? null;
    if (depthStencilFormat !== null && !DEPTH_FORMATS.has(depthStencilFormat)) throw this.unsupported(`a bundle depthStencilFormat ${depthStencilFormat}; the depth formats are ${[...DEPTH_FORMATS].join(', ')} (stencil formats are not drawn)`);
    if (colorFormats.length === 0 && depthStencilFormat === null) throw new TypeError(`${call}: a bundle needs a colour format or a depth format`);
    const sampleCount = descriptor?.sampleCount ?? 1;
    if (sampleCount !== 1 && sampleCount !== 4) throw new RangeError(`OperationError: ${call}: sampleCount ${String(sampleCount)}; it is 1 or 4`);
    return new GPURenderBundleEncoderShim(this, { colorFormats, depthStencilFormat, sampleCount, depthReadOnly: descriptor?.depthReadOnly === true }, descriptor?.label);
  }
  importExternalTexture(): never {
    throw this.unsupported('device.importExternalTexture (video textures); copy the frame with queue.copyExternalImageToTexture');
  }
  pushErrorScope(filter: string): void {
    this.scopes.push(filter);
  }
  popErrorScope(): Promise<GPUErrorShim | null> {
    return this.scopes.pop();
  }
  destroy(): void {}
}

/**
 * The adapter has the WebGPU default limits and a fixed list of features (`FEATURES`), on every machine: the page cannot
 * ask for a better device, and the same project takes the same code paths wherever it is rendered.
 */
export class GPUAdapterShim {
  readonly features = new Set(FEATURES);
  readonly limits: Record<string, number> = { ...LIMITS };
  readonly info = { vendor: 'kinetograph', architecture: 'wgpu', device: '', description: 'Kinetograph' };
  readonly isFallbackAdapter = false;
  constructor(private readonly options: GpuOptions = {}) {}
  requestDevice(descriptor?: { requiredFeatures?: Iterable<string>; requiredLimits?: Record<string, number | undefined> }): Promise<GPUDeviceShim> {
    for (const feature of descriptor?.requiredFeatures ?? []) {
      if (!this.features.has(feature)) return Promise.reject(new TypeError(`requestDevice: the feature ${feature} is not supported`));
    }
    for (const [name, wanted] of Object.entries(descriptor?.requiredLimits ?? {})) {
      if (wanted === undefined) continue;
      const have = this.limits[name];
      if (have === undefined) return Promise.reject(new TypeError(`requestDevice: ${name} is not a limit`));
      const better = ALIGNMENTS.has(name) ? wanted < have : wanted > have;
      if (!Number.isFinite(Number(wanted)) || better) return Promise.reject(new RangeError(`OperationError: requestDevice: the limit ${name} ${String(wanted)} is better than the WebGPU default (${have}), which every device here has`));
    }
    const device = new GPUDeviceShim(this.options, this.limits);
    for (const feature of descriptor?.requiredFeatures ?? []) device.features.add(feature);
    return Promise.resolve(device);
  }
}

export class GPUShim {
  readonly wgslLanguageFeatures = new Set<string>();
  constructor(private readonly options: GpuOptions = {}) {}
  requestAdapter(): Promise<GPUAdapterShim> {
    return Promise.resolve(new GPUAdapterShim(this.options));
  }
  getPreferredCanvasFormat(): string {
    return 'rgba8unorm';
  }
}

/** `navigator.gpu`. */
export function createGpu(options: GpuOptions = {}): GPUShim {
  return new GPUShim(options);
}

export function createGpuCanvasContext(options: GPUCanvasContextOptions): GPUCanvasContextShim {
  return new GPUCanvasContextShim(options);
}

// An error a check throws is recorded on the device before it reaches the page (`webgpu-errors.ts`).
for (const [cls, deviceOf] of [
  [GPUDeviceShim, (self: GPUDeviceShim) => self],
  [GPUQueueShim, (self: GPUQueueShim) => (self as unknown as { device: GPUDeviceShim }).device],
  [GPUCommandEncoderShim, (self: GPUCommandEncoderShim) => self.device],
  [GPURenderPassEncoderShim, (self: GPURenderPassEncoderShim) => (self as unknown as { encoder: GPUCommandEncoderShim }).encoder.device],
  [RenderCommands, (self: RenderCommands) => self.device],
  [GPURenderBundleEncoderShim, (self: GPURenderBundleEncoderShim) => self.device],
  [GPUComputePassEncoderShim, (self: GPUComputePassEncoderShim) => (self as unknown as { encoder: GPUCommandEncoderShim }).encoder.device],
  [GPUTextureShim, (self: GPUTextureShim) => self.device],
  [GPUBufferShim, (self: GPUBufferShim) => (self as unknown as { device: GPUDeviceShim }).device],
] as const) {
  reporting(cls as { prototype: object }, deviceOf as never, (error) => error instanceof WebGpuUnsupportedError);
}

// The interfaces a page names (`x instanceof GPUTexture`, `GPUDevice.prototype`), under the WebGPU names.
Object.assign(GPU_GLOBALS, {
  GPU: GPUShim,
  GPUAdapter: GPUAdapterShim,
  GPUDevice: GPUDeviceShim,
  GPUQueue: GPUQueueShim,
  GPUBuffer: GPUBufferShim,
  GPUError: GPUErrorShim,
  GPUValidationError: GPUValidationErrorShim,
  GPUQuerySet: GPUQuerySetShim,
  GPUTexture: GPUTextureShim,
  GPUTextureView: GPUTextureViewShim,
  GPUSampler: GPUSamplerShim,
  GPUShaderModule: GPUShaderModuleShim,
  GPUBindGroup: GPUBindGroupShim,
  GPUBindGroupLayout: GPUBindGroupLayoutShim,
  GPUPipelineLayout: GPUPipelineLayoutShim,
  GPURenderPipeline: GPURenderPipelineShim,
  GPUComputePipeline: GPUComputePipelineShim,
  GPUCommandEncoder: GPUCommandEncoderShim,
  GPUCommandBuffer: GPUCommandBufferShim,
  GPURenderPassEncoder: GPURenderPassEncoderShim,
  GPUComputePassEncoder: GPUComputePassEncoderShim,
  GPURenderBundleEncoder: GPURenderBundleEncoderShim,
  GPURenderBundle: GPURenderBundleShim,
  GPUCanvasContext: GPUCanvasContextShim,
});
