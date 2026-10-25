// `navigator.gpu` and `GPUCanvasContext` that record instead of rasterising (packages/cli/skills/kinetograph/references/ENGINE.md,
// "WebGPU"). A page's WebGPU code runs against these objects; the render passes it submits to a canvas become the
// `webgpu` part of a `glsl` layer (`WebGpuContent`), and the renderer replays them on its own wgpu device with the page's
// own WGSL. Nothing here reads a clock or anything outside the calls.
//
// The slice drawn is what shader pages use: one device, uniform / storage / vertex / index buffers, WGSL modules, bind
// group layouts, render pipelines, bind groups, command encoders with render passes into the canvas's texture or into a
// 2D texture, `draw` and `drawIndexed`, `writeBuffer`, and textures: `createTexture`, `createView`, `createSampler`,
// `writeTexture`, `copyExternalImageToTexture`, `copyBufferToTexture`, `copyTextureToTexture`. Compute, queries, bundles,
// depth, multisampling and reading anything back are not recorded: the call throws `WebGpuUnsupportedError` and the frame
// reports it (`WebGpuContent.notes`).
//
// A buffer's bytes are shadowed here, and a submit snapshots the ones its passes read, so a frame's recording holds
// everything it needs and is the same whichever frames were drawn before it. A texture is not shadowed: it is the steps
// that wrote it, in order (a render pass into it, a `writeTexture`, a copy), which the device keeps for as long as a later
// frame may read the result. A step that writes a whole level drops the earlier steps that only it made visible, so the
// log of a page that redraws its textures every frame stays as long as one frame.

import type {
  CanvasSource,
  GlslContent,
  WebGpuBindEntry,
  WebGpuBindGroup,
  WebGpuBindingLayout,
  WebGpuCommand,
  WebGpuContent,
  WebGpuPass,
  WebGpuPipeline,
  WebGpuSampler,
  WebGpuSource,
  WebGpuStep,
  WebGpuTexture,
} from './types.js';
import { pictureOf } from './canvas.js';
import { hashOf, LAYER_SOURCE, toBase64 } from './webgl.js';

/** Thrown by a call the engine does not draw. The message starts with "unsupported:". */
export class WebGpuUnsupportedError extends Error {
  override name = 'WebGpuUnsupportedError';
  constructor(what: string) {
    super(`unsupported: ${what} (packages/cli/skills/kinetograph/references/ENGINE.md, "WebGPU")`);
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
/** The most all the textures of a device may hold, all levels together (the renderer refuses a frame over the same). */
const MAX_TEXTURE_BYTES = 512 * 1024 * 1024;
/** The most steps a device keeps for later frames. */
const MAX_STEPS = 4096;

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

/** The bytes of a texel of each texture format that is drawn. */
const TEXEL_BYTES: Record<string, number> = {
  r8unorm: 1,
  rg8unorm: 2,
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  bgra8unorm: 4,
  'bgra8unorm-srgb': 4,
  rgba16float: 8,
};
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
  buffers: Map<string, string>;
  bindGroups: Map<string, WebGpuBindGroup>;
  samplers: Map<string, WebGpuSampler>;
  blobs: Map<string, string>;
}

function newTables(): Tables {
  return { modules: new Map(), layouts: new Map(), pipelines: new Map(), buffers: new Map(), bindGroups: new Map(), samplers: new Map(), blobs: new Map() };
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
  readonly mapState = 'unmapped';
  /** The bytes as the queue has them (shadow of the GPU's). */
  readonly data: Bytes;
  version = 0;
  private snapshotted: { version: number; id: string } | null = null;
  private destroyed = false;
  constructor(
    private readonly device: GPUDeviceShim,
    descriptor: { size: number; usage: number; label?: string; mappedAtCreation?: boolean },
  ) {
    super(descriptor.label);
    const size = Number(descriptor.size);
    if (!Number.isInteger(size) || size < 0 || size > MAX_BUFFER_SIZE) throw new RangeError(`createBuffer: size ${descriptor.size} is not supported (at most ${MAX_BUFFER_SIZE} bytes)`);
    device.reserve(size);
    this.size = size;
    this.usage = Number(descriptor.usage);
    this.data = new Uint8Array(size);
    if (descriptor.mappedAtCreation) throw new WebGpuUnsupportedError('createBuffer({ mappedAtCreation }); write the data with queue.writeBuffer');
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
  mapAsync(): never {
    throw new WebGpuUnsupportedError('buffer.mapAsync; reading a buffer back');
  }
  getMappedRange(): never {
    throw new WebGpuUnsupportedError('buffer.getMappedRange');
  }
  unmap(): void {}
  destroy(): void {
    if (!this.destroyed) {
      this.destroyed = true;
      this.device.release(this.size);
    }
  }
}

export class GPUShaderModuleShim extends GpuObject {
  readonly code: string;
  readonly id: string;
  constructor(descriptor: { code: string; label?: string }) {
    super(descriptor.label);
    if (typeof descriptor.code !== 'string') throw new TypeError('createShaderModule: code must be a string');
    this.code = descriptor.code;
    this.id = `m${hashOf(descriptor.code)}`;
  }
  getCompilationInfo(): Promise<{ messages: unknown[] }> {
    return Promise.resolve({ messages: [] });
  }
}

export class GPUBindGroupLayoutShim extends GpuObject {
  /** `auto:<pipeline>:<index>` for a layout a pipeline made, else the id made from its entries. */
  readonly id: string;
  constructor(readonly entries: WebGpuBindingLayout[], auto?: { pipeline: string; index: number }) {
    super('');
    this.id = auto === undefined ? `l${hashOf(JSON.stringify(entries))}` : `auto:${auto.pipeline}:${auto.index}`;
  }
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
    return new GPUBindGroupLayoutShim([], { pipeline: this.id, index });
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

/** A texture level range of a texture: what a shader binds, and what a pass draws into. */
export class GPUTextureViewShim extends GpuObject {
  constructor(
    readonly texture: GPUTextureShim,
    readonly baseMip: number,
    readonly mips: number,
  ) {
    super('');
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
 * A 2D texture, or the canvas's texture of this frame (`canvas` set). The canvas's may only be drawn into by a render
 * pass; the others are what the steps that wrote them make.
 */
export class GPUTextureShim extends GpuObject {
  readonly dimension = '2d';
  readonly depthOrArrayLayers = 1;
  readonly sampleCount = 1;
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
  ) {
    super(label);
    this.uid = canvas === null ? device.nextTextureId() : 0;
    this.bytes = 0;
    if (canvas === null) {
      let total = 0;
      for (let level = 0; level < mipLevelCount; level += 1) total += Math.max(1, width >> level) * Math.max(1, height >> level) * (TEXEL_BYTES[format] ?? 4);
      this.bytes = total;
      device.reserveTexture(total);
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
    return TEXEL_BYTES[this.format] ?? 4;
  }
  createView(descriptor: { format?: string; dimension?: string; aspect?: string; baseMipLevel?: number; mipLevelCount?: number; baseArrayLayer?: number; arrayLayerCount?: number } = {}): GPUTextureViewShim {
    const d = descriptor ?? {};
    if (d.format !== undefined && d.format !== this.format) throw this.device.unsupported(`a texture view of format ${d.format} on a ${this.format} texture`);
    if (d.dimension !== undefined && d.dimension !== '2d') throw this.device.unsupported(`a texture view of dimension ${d.dimension}`);
    if (d.aspect !== undefined && d.aspect !== 'all') throw this.device.unsupported(`a texture view of the aspect ${d.aspect}`);
    if ((d.baseArrayLayer ?? 0) !== 0 || (d.arrayLayerCount ?? 1) !== 1) throw new RangeError('OperationError: createView: a 2D texture has one layer');
    const base = whole('createView', 'baseMipLevel', d.baseMipLevel ?? 0, 0);
    if (base >= this.mipLevelCount) throw new RangeError(`OperationError: createView: baseMipLevel ${base} of a texture with ${this.mipLevelCount} levels`);
    const count = d.mipLevelCount === undefined ? this.mipLevelCount - base : whole('createView', 'mipLevelCount', d.mipLevelCount, 1);
    if (base + count > this.mipLevelCount) throw new RangeError(`OperationError: createView: levels ${base}..${base + count} of a texture with ${this.mipLevelCount}`);
    return new GPUTextureViewShim(this, base, count);
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

/** What a render pass draws into: the canvas, or one level of a texture. */
interface Attachment {
  context: GPUCanvasContextShim | null;
  texture: GPUTextureShim | null;
  mip: number;
  clear: [number, number, number, number] | null;
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
  x: number;
  y: number;
}

type EncodedItem =
  | { kind: 'pass'; attachment: Attachment; commands: PassCommand[] }
  | { kind: 'copy'; source: GPUBufferShim; sourceOffset: number; target: GPUBufferShim; targetOffset: number; size: number }
  | { kind: 'clear'; buffer: GPUBufferShim; offset: number; size: number }
  | { kind: 'bufferToTexture'; buffer: GPUBufferShim; offset: number; bytesPerRow: number; to: TextureRegion; width: number; height: number }
  | { kind: 'textureToTexture'; from: TextureRegion; to: TextureRegion; width: number; height: number };

export class GPURenderPassEncoderShim extends GpuObject {
  private readonly commands: PassCommand[] = [];
  private ended = false;
  constructor(private readonly encoder: GPUCommandEncoderShim, private readonly attachment: Attachment) {
    super('');
  }
  private add(command: PassCommand): void {
    if (this.ended) throw new Error('InvalidStateError: the render pass has ended');
    this.commands.push(command);
  }
  setPipeline(pipeline: GPURenderPipelineShim): void {
    const texture = this.attachment.texture;
    const target = pipeline.descriptor.fragment?.targets[0];
    if (texture !== null && target && target.format !== texture.format) {
      throw new RangeError(`OperationError: setPipeline: the pipeline draws ${target.format} and the pass draws into a ${texture.format} texture`);
    }
    this.add({ c: 'pipeline', pipeline });
  }
  setBindGroup(index: number, group: GPUBindGroupShim | null, offsets?: unknown, start?: number, length?: number): void {
    if (group === null) return;
    const texture = this.attachment.texture;
    for (const entry of group.entries) {
      if ('view' in entry && texture !== null && entry.view.texture === texture && this.attachment.mip >= entry.view.baseMip && this.attachment.mip < entry.view.baseMip + entry.view.mips) {
        throw new RangeError('OperationError: setBindGroup: a pass samples the level of the texture it draws into');
      }
    }
    let list: number[] | undefined;
    if (Array.isArray(offsets)) list = offsets.map(Number);
    else if (offsets !== undefined && offsets !== null) list = Array.from((offsets as Uint32Array).subarray(start ?? 0, (start ?? 0) + (length ?? (offsets as Uint32Array).length)));
    this.add(list === undefined || list.length === 0 ? { c: 'bind', index, group } : { c: 'bind', index, group, offsets: list });
  }
  setVertexBuffer(slot: number, buffer: GPUBufferShim | null, offset = 0, size?: number): void {
    if (buffer === null) return;
    boundRange('setVertexBuffer', buffer.size, offset, size, 4);
    this.add(size === undefined ? { c: 'vertex', slot, buffer, offset } : { c: 'vertex', slot, buffer, offset, size });
  }
  setIndexBuffer(buffer: GPUBufferShim, format: string, offset = 0, size?: number): void {
    boundRange('setIndexBuffer', buffer.size, offset, size, format === 'uint16' ? 2 : 4);
    this.add(size === undefined ? { c: 'index', buffer, format, offset } : { c: 'index', buffer, format, offset, size });
  }
  draw(vertices: number, instances = 1, first = 0, firstInstance = 0): void {
    this.add({ c: 'draw', vertices, instances, first, firstInstance });
  }
  drawIndexed(indices: number, instances = 1, first = 0, base = 0, firstInstance = 0): void {
    this.add({ c: 'drawIndexed', indices, instances, first, base, firstInstance });
  }
  setViewport(x: number, y: number, width: number, height: number, minDepth = 0, maxDepth = 1): void {
    this.add({ c: 'viewport', x, y, width, height, minDepth, maxDepth });
  }
  setScissorRect(x: number, y: number, width: number, height: number): void {
    const bounds = this.attachment.texture === null ? null : this.attachment.texture.extent(this.attachment.mip);
    if (bounds !== null) rectIn('setScissorRect', 'rectangle', bounds, whole('setScissorRect', 'x', x), whole('setScissorRect', 'y', y), whole('setScissorRect', 'width', width), whole('setScissorRect', 'height', height));
    this.add({ c: 'scissor', x, y, width, height });
  }
  setBlendConstant(color: unknown): void {
    const [r, g, b, a] = colorOf(color);
    this.add({ c: 'blend', color: [r, g, b, a] });
  }
  setStencilReference(): void {}
  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  insertDebugMarker(): void {}
  drawIndirect(): never {
    throw this.encoder.device.unsupported('renderPass.drawIndirect');
  }
  drawIndexedIndirect(): never {
    throw this.encoder.device.unsupported('renderPass.drawIndexedIndirect');
  }
  executeBundles(): never {
    throw this.encoder.device.unsupported('renderPass.executeBundles');
  }
  beginOcclusionQuery(): never {
    throw this.encoder.device.unsupported('renderPass.beginOcclusionQuery');
  }
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.encoder.finishPass({ kind: 'pass', attachment: this.attachment, commands: this.commands });
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

/** `{ texture, mipLevel, origin }` of a copy, checked against the texture. */
function regionOf(call: string, what: string, info: { texture: GPUTextureShim; mipLevel?: number; origin?: unknown; aspect?: string }, width: number, height: number, depth: number, usage: number, usageName: string): TextureRegion {
  const texture = info?.texture;
  if (!(texture instanceof GPUTextureShim)) throw new TypeError(`${call}: ${what} texture is not a GPUTexture`);
  if (texture.canvas !== null) throw texture.device.unsupported(`${call} with the canvas's texture`);
  if (texture.destroyed) throw new Error(`OperationError: ${call}: the ${what} texture was destroyed`);
  if ((texture.usage & usage) === 0) throw new RangeError(`OperationError: ${call}: the ${what} texture was made without GPUTextureUsage.${usageName}`);
  if (info.aspect !== undefined && info.aspect !== 'all') throw texture.device.unsupported(`${call} of the aspect ${info.aspect}`);
  const mip = whole(call, 'mipLevel', info.mipLevel ?? 0, 0);
  if (mip >= texture.mipLevelCount) throw new RangeError(`OperationError: ${call}: mip level ${mip} of a texture with ${texture.mipLevelCount}`);
  const origin = originOf(call, info.origin);
  if (origin.z + depth > 1) throw new RangeError(`OperationError: ${call}: a 2D texture has one layer`);
  rectIn(call, `${what} rectangle`, texture.extent(mip), origin.x, origin.y, width, height);
  return { texture, mip, x: origin.x, y: origin.y };
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
    if (attachments.length !== 1) throw this.device.unsupported(`a render pass with ${attachments.length} colour attachments; one, the canvas's texture or a 2D texture, is drawn`);
    if (descriptor.depthStencilAttachment) throw this.device.unsupported('a depth or stencil attachment');
    if (descriptor.occlusionQuerySet) throw this.device.unsupported('occlusion queries');
    const attachment = attachments[0]!;
    if (attachment.resolveTarget) throw this.device.unsupported('a resolve target (multisampling)');
    const view = attachment.view;
    if (!(view instanceof GPUTextureViewShim)) throw new TypeError('beginRenderPass: the colour attachment has no view');
    const clear = (attachment.loadOp ?? 'clear') === 'load' ? null : colorOf(attachment.clearValue);
    const texture = view.texture;
    if (texture.canvas !== null) return new GPURenderPassEncoderShim(this, { context: texture.canvas, texture: null, mip: 0, clear });
    if (texture.destroyed) throw new Error('OperationError: beginRenderPass: the texture was destroyed');
    if ((texture.usage & GPU_TEXTURE_USAGE.RENDER_ATTACHMENT) === 0) throw new RangeError('OperationError: beginRenderPass: the texture was made without GPUTextureUsage.RENDER_ATTACHMENT');
    if (view.mips !== 1) throw new RangeError('OperationError: beginRenderPass: a colour attachment is one mip level');
    return new GPURenderPassEncoderShim(this, { context: null, texture, mip: view.baseMip, clear });
  }
  beginComputePass(): never {
    throw this.device.unsupported('compute passes');
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
    if ((buffer.usage & GPU_BUFFER_USAGE.COPY_SRC) === 0) throw new RangeError(`OperationError: ${call}: the buffer was made without GPUBufferUsage.COPY_SRC`);
    const texel = to.texture.texelBytes;
    const offset = whole(call, 'offset', source.offset ?? 0, 0);
    const rowBytes = size.width * texel;
    const bytesPerRow = source.bytesPerRow === undefined ? rowBytes : whole(call, 'bytesPerRow', source.bytesPerRow, 0);
    if (size.height > 1 && source.bytesPerRow === undefined) throw new RangeError(`OperationError: ${call}: bytesPerRow is needed to copy more than one row`);
    if (size.height > 1 && bytesPerRow % 256 !== 0) throw new RangeError(`OperationError: ${call}: bytesPerRow ${bytesPerRow} is not a multiple of 256`);
    if (bytesPerRow < rowBytes) throw new RangeError(`OperationError: ${call}: bytesPerRow ${bytesPerRow} is less than the ${rowBytes} bytes of a row`);
    if (offset % texel !== 0) throw new RangeError(`OperationError: ${call}: the offset ${offset} is not a multiple of the texel size ${texel}`);
    if (size.width > 0 && size.height > 0 && offset + (size.height - 1) * bytesPerRow + rowBytes > buffer.size) {
      throw new RangeError(`OperationError: ${call}: the copy reads past the ${buffer.size} bytes of the buffer`);
    }
    this.items.push({ kind: 'bufferToTexture', buffer, offset, bytesPerRow, to, width: size.width, height: size.height });
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
    const from = regionOf(call, 'source', source, size.width, size.height, size.depth, GPU_TEXTURE_USAGE.COPY_SRC, 'COPY_SRC');
    const to = regionOf(call, 'destination', destination, size.width, size.height, size.depth, GPU_TEXTURE_USAGE.COPY_DST, 'COPY_DST');
    const linear = (format: string): string => format.replace(/-srgb$/, '');
    if (linear(from.texture.format) !== linear(to.texture.format)) {
      throw new TypeError(`${call}: the formats ${from.texture.format} and ${to.texture.format} differ by more than -srgb`);
    }
    if (from.texture === to.texture && from.mip === to.mip) throw new RangeError(`OperationError: ${call}: the source and the destination are one level of one texture`);
    this.items.push({ kind: 'textureToTexture', from, to, width: size.width, height: size.height });
  }
  resolveQuerySet(): never {
    throw this.device.unsupported('query sets');
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
  /** `<uid>:<mip>` of the levels the step reads. */
  reads: Set<string>;
  /** The level written, and whether the step wrote all of it. */
  writes: { texture: GPUTextureShim; mip: number; whole: boolean } | null;
}

const levelKey = (texture: GPUTextureShim, mip: number): string => `${texture.uid}:${mip}`;

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
    if (format === 'rgba16float') device.note('canvas format rgba16float (drawn as rgba8unorm, without extended range)');
    if (configuration.colorSpace !== undefined && configuration.colorSpace !== 'srgb') device.note(`canvas colorSpace ${String(configuration.colorSpace)} (drawn as srgb)`);
    this.device = device;
    this.drawnBy = device;
    this.format = format;
    this.alphaMode = configuration.alphaMode ?? 'opaque';
    device.contexts.add(this);
  }

  unconfigure(): void {
    this.device = null;
  }

  getConfiguration(): { device: GPUDeviceShim; format: string; alphaMode: string } | null {
    return this.device === null ? null : { device: this.device, format: this.format, alphaMode: this.alphaMode };
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
    const steps = device === null ? [] : device.stepsFor(this);
    const merged = newTables();
    const textures = new Map<GPUTextureShim, WebGpuTexture>();
    for (const s of steps) {
      for (const key of Object.keys(merged) as (keyof Tables)[]) {
        for (const [id, value] of s.tables[key] as Map<string, never>) (merged[key] as Map<string, unknown>).set(id, value);
      }
      for (const texture of s.textures) {
        if (!textures.has(texture)) textures.set(texture, { width: texture.width, height: texture.height, mips: texture.mipLevelCount, format: texture.format });
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
    if (textures.size > 0) webgpu.textures = Object.fromEntries([...textures].map(([texture, described]) => [texture.id, described]));
    if (merged.samplers.size > 0) webgpu.samplers = Object.fromEntries(merged.samplers);
    if (merged.blobs.size > 0) webgpu.blobs = Object.fromEntries(merged.blobs);
    if (notes.length > 0) webgpu.notes = notes;
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
    return (this.drawnBy?.hasPassFor(this) ?? false) || (this.drawnBy?.notes.size ?? 0) > 0;
  }

  /** The frame loop calls this before each frame: the next submit starts a new drawing; a frame that draws nothing keeps the picture. */
  resetState(): void {
    this.stale = true;
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
  if (s.kind === 'layer') throw new WebGpuUnsupportedError('copyExternalImageToTexture from a layer picture outside layerPicture()');
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
    buffer.write(bufferOffset, bytes);
  }
  submit(commandBuffers: GPUCommandBufferShim[]): void {
    for (const commandBuffer of commandBuffers) {
      for (const item of commandBuffer.items) {
        if (item.kind === 'copy') {
          range('copyBufferToBuffer', item.sourceOffset + item.size <= item.source.size && item.targetOffset + item.size <= item.target.size);
          item.target.write(item.targetOffset, item.source.data.slice(item.sourceOffset, item.sourceOffset + item.size));
        } else if (item.kind === 'clear') {
          range('clearBuffer', item.offset + item.size <= item.buffer.size);
          item.buffer.write(item.offset, new Uint8Array(item.size));
        } else if (item.kind === 'bufferToTexture') {
          this.device.uploadFromBuffer(item);
        } else if (item.kind === 'textureToTexture') {
          this.device.copyTexture(item.from, item.to, item.width, item.height);
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
    if (extent.height > 1 && layout.bytesPerRow === undefined) throw new RangeError(`OperationError: ${call}: bytesPerRow is needed to write more than one row`);
    const bytesPerRow = layout.bytesPerRow === undefined ? rowBytes : whole(call, 'bytesPerRow', layout.bytesPerRow, 0);
    if (bytesPerRow < rowBytes) throw new RangeError(`OperationError: ${call}: bytesPerRow ${bytesPerRow} is less than the ${rowBytes} bytes of a row`);
    if (extent.width === 0 || extent.height === 0) return;
    if (offset + (extent.height - 1) * bytesPerRow + rowBytes > bytes.byteLength) {
      throw new RangeError(`OperationError: ${call}: the copy reads past the ${bytes.byteLength} bytes of the data`);
    }
    this.device.uploadBytes(to, extent.width, extent.height, bytes, offset, bytesPerRow);
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
  readonly limits: Record<string, number> = { ...LIMITS };
  readonly queue: GPUQueueShim;
  /** Never settles: the device is not lost. */
  readonly lost: Promise<never> = new Promise(() => {});
  /** The canvases configured with this device. */
  readonly contexts = new Set<GPUCanvasContextShim>();
  /** What the page did that is not drawn. Kept for the life of the device: the picture is affected from then on. */
  readonly notes = new Set<string>();
  private total = 0;
  private textureTotal = 0;
  private textureCount = 0;
  /** What the queue did, in order: the frame's passes into canvases, and the steps that wrote textures. */
  private steps: LogStep[] = [];

  constructor(readonly options: GpuOptions = {}) {
    super();
    this.queue = new GPUQueueShim(this);
  }
  note(what: string): void {
    this.notes.add(what);
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
  reserveTexture(size: number): void {
    if (this.textureTotal + size > MAX_TEXTURE_BYTES) {
      throw new RangeError(`OperationError: createTexture: the textures together would exceed ${MAX_TEXTURE_BYTES} bytes (all levels counted)`);
    }
    this.textureTotal += size;
  }
  releaseTexture(size: number): void {
    this.textureTotal = Math.max(0, this.textureTotal - size);
  }

  // ---- the log ----

  /** The steps a canvas's recording holds: every step into a texture, and the canvas's own passes, in order. */
  stepsFor(context: GPUCanvasContextShim): LogStep[] {
    return this.steps.filter((s) => s.canvas === null || s.canvas === context);
  }
  hasPassFor(context: GPUCanvasContextShim): boolean {
    return this.steps.some((s) => s.canvas === context);
  }
  /** A new frame of `context` starts: its passes of the last one go. */
  dropFrameOf(context: GPUCanvasContextShim): void {
    this.steps = this.steps.filter((s) => s.canvas !== context);
  }
  /** A destroyed texture's steps go. */
  forget(texture: GPUTextureShim): void {
    this.steps = this.steps.filter((s) => s.writes?.texture !== texture);
  }
  append(entry: LogStep): void {
    this.steps.push(entry);
    this.prune();
    if (this.steps.length > MAX_STEPS) {
      this.note(`more than ${MAX_STEPS} queued steps into textures (the oldest are dropped; clear or overwrite a texture each frame)`);
      this.steps.splice(0, this.steps.length - MAX_STEPS);
    }
  }
  /** What a write of `width` x `height` at a region of its level changes. */
  writesOf(to: TextureRegion, width: number, height: number): LogStep['writes'] {
    const extent = to.texture.extent(to.mip);
    return { texture: to.texture, mip: to.mip, whole: to.x === 0 && to.y === 0 && width === extent.width && height === extent.height };
  }
  /**
   * Drops the steps whose result a later step wrote over before anything read it: a step writing a level that a later,
   * whole write replaces, with no step between them that reads the level. Repeats, since dropping a reader frees what it read.
   */
  private prune(): void {
    for (let changed = true; changed; ) {
      changed = false;
      for (let j = this.steps.length - 1; j > 0 && !changed; j -= 1) {
        const over = this.steps[j]!.writes;
        if (over === null || !over.whole) continue;
        const key = levelKey(over.texture, over.mip);
        if (this.steps[j]!.reads.has(key)) continue;
        for (let i = j - 1; i >= 0; i -= 1) {
          const earlier = this.steps[i]!;
          if (earlier.canvas !== null || earlier.writes === null || earlier.writes.texture !== over.texture || earlier.writes.mip !== over.mip) continue;
          let read = false;
          for (let k = i + 1; k < j && !read; k += 1) read = this.steps[k]!.reads.has(key);
          if (!read) {
            this.steps.splice(i, 1);
            changed = true;
            break;
          }
        }
      }
    }
  }

  /** A render pass the queue ran: snapshots what it reads and adds it to the log. */
  encodePass(attachment: Attachment, commands: PassCommand[]): void {
    const canvas = attachment.context;
    if (canvas !== null) canvas.begin();
    const tables = newTables();
    const textures = new Set<GPUTextureShim>();
    const reads = new Set<string>();
    const out: WebGpuCommand[] = [];
    let pipeline: GPURenderPipelineShim | null = null;
    for (const command of commands) {
      switch (command.c) {
        case 'pipeline': {
          pipeline = command.pipeline;
          for (const module of pipeline.modules) tables.modules.set(module.id, module.code);
          for (const layout of pipeline.layouts ?? []) tables.layouts.set(layout.id, layout.entries);
          tables.pipelines.set(pipeline.id, pipeline.descriptor);
          out.push({ c: 'pipeline', id: pipeline.id });
          break;
        }
        case 'bind': {
          const { group } = command;
          if (!group.layout.id.startsWith('auto:')) tables.layouts.set(group.layout.id, group.layout.entries);
          const entries: WebGpuBindEntry[] = [];
          for (const e of group.entries) {
            if ('buffer' in e) {
              entries.push({ binding: e.binding, buffer: e.buffer.snapshot(tables.buffers), offset: e.offset, size: e.size });
            } else if ('view' in e) {
              textures.add(e.view.texture);
              for (let level = e.view.baseMip; level < e.view.baseMip + e.view.mips; level += 1) reads.add(levelKey(e.view.texture, level));
              entries.push({ binding: e.binding, texture: { id: e.view.texture.id, baseMip: e.view.baseMip, mips: e.view.mips } });
            } else {
              tables.samplers.set(e.sampler.id, e.sampler.descriptor);
              entries.push({ binding: e.binding, sampler: e.sampler.id });
            }
          }
          const snapshot: WebGpuBindGroup = { layout: group.layout.id, entries };
          const id = `g${hashOf(JSON.stringify(snapshot))}`;
          tables.bindGroups.set(id, snapshot);
          out.push(command.offsets === undefined ? { c: 'bind', index: command.index, group: id } : { c: 'bind', index: command.index, group: id, offsets: command.offsets });
          break;
        }
        case 'vertex':
          out.push({ ...command, buffer: command.buffer.snapshot(tables.buffers) });
          break;
        case 'index':
          out.push({ ...command, buffer: command.buffer.snapshot(tables.buffers) });
          break;
        default:
          out.push(command);
      }
    }
    const target = attachment.texture;
    const pass: WebGpuPass = {
      k: 'render',
      ...(target === null ? {} : { target: { texture: target.id, mip: attachment.mip } }),
      clear: attachment.clear,
      commands: out,
    };
    if (target !== null) textures.add(target);
    this.append({ step: pass, canvas, tables, textures, reads, writes: target === null ? null : { texture: target, mip: attachment.mip, whole: attachment.clear !== null } });
  }

  /** `writeTexture`: rows of `bytes` from `offset`, `bytesPerRow` apart, packed. */
  uploadBytes(to: TextureRegion, width: number, height: number, bytes: Bytes, offset: number, bytesPerRow: number): void {
    const rowBytes = width * to.texture.texelBytes;
    const packed = new Uint8Array(rowBytes * height);
    for (let row = 0; row < height; row += 1) packed.set(bytes.subarray(offset + row * bytesPerRow, offset + row * bytesPerRow + rowBytes), row * rowBytes);
    const tables = newTables();
    const step: WebGpuStep = { k: 'upload', texture: to.texture.id, ...(to.mip === 0 ? {} : { mip: to.mip }), x: to.x, y: to.y, width, height, source: { raw: blobOf(tables, packed) } };
    this.append({ step, canvas: null, tables, textures: new Set([to.texture]), reads: new Set(), writes: this.writesOf(to, width, height) });
  }

  /** `copyBufferToTexture` as the queue runs it: the bytes the buffer holds now. */
  uploadFromBuffer(item: Extract<EncodedItem, { kind: 'bufferToTexture' }>): void {
    if (item.width === 0 || item.height === 0) return;
    this.uploadBytes(item.to, item.width, item.height, item.buffer.data, item.offset, item.bytesPerRow);
  }

  copyTexture(from: TextureRegion, to: TextureRegion, width: number, height: number): void {
    if (width === 0 || height === 0) return;
    const step: WebGpuStep = {
      k: 'copy',
      from: { texture: from.texture.id, ...(from.mip === 0 ? {} : { mip: from.mip }), x: from.x, y: from.y },
      to: { texture: to.texture.id, ...(to.mip === 0 ? {} : { mip: to.mip }), x: to.x, y: to.y },
      width,
      height,
    };
    this.append({ step, canvas: null, tables: newTables(), textures: new Set([from.texture, to.texture]), reads: new Set([levelKey(from.texture, from.mip)]), writes: this.writesOf(to, width, height) });
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
      storageTexture?: unknown;
      externalTexture?: unknown;
    }[];
    label?: string;
  }): GPUBindGroupLayoutShim {
    const entries: WebGpuBindingLayout[] = [];
    for (const e of descriptor.entries ?? []) {
      if (e.storageTexture || e.externalTexture) throw this.unsupported('a bind group layout with a storage texture or an external texture');
      const kinds = [e.buffer, e.sampler, e.texture].filter((k) => k !== undefined && k !== null).length;
      if (kinds !== 1) throw new TypeError('createBindGroupLayout: an entry has exactly one of buffer, sampler and texture');
      if (e.texture) {
        const sampleType = e.texture.sampleType ?? 'float';
        if (!['float', 'unfilterable-float', 'sint', 'uint'].includes(sampleType)) throw this.unsupported(`a texture binding of the sample type ${sampleType}`);
        if ((e.texture.viewDimension ?? '2d') !== '2d') throw this.unsupported(`a texture binding of the view dimension ${e.texture.viewDimension}`);
        if (e.texture.multisampled) throw this.unsupported('a multisampled texture binding');
        entries.push({ binding: e.binding, visibility: e.visibility, type: 'texture', ...(sampleType === 'float' ? {} : { sampleType: sampleType as 'unfilterable-float' | 'sint' | 'uint' }) });
      } else if (e.sampler) {
        const type = e.sampler.type ?? 'filtering';
        if (type === 'comparison') throw this.unsupported('a comparison sampler');
        if (type !== 'filtering' && type !== 'non-filtering') throw new TypeError(`createBindGroupLayout: sampler type ${type}`);
        entries.push({ binding: e.binding, visibility: e.visibility, type: 'sampler', ...(type === 'filtering' ? {} : { samplerType: 'non-filtering' as const }) });
      } else {
        const type = e.buffer!.type ?? 'uniform';
        if (!SHADER_BINDING_TYPES.has(type)) throw new TypeError(`createBindGroupLayout: buffer type ${type}`);
        const entry: WebGpuBindingLayout = { binding: e.binding, visibility: e.visibility, type: type as WebGpuBindingLayout['type'] };
        if (e.buffer!.hasDynamicOffset) entry.dynamicOffset = true;
        entries.push(entry);
      }
    }
    entries.sort((a, b) => a.binding - b.binding);
    return new GPUBindGroupLayoutShim(entries);
  }
  createPipelineLayout(descriptor: { bindGroupLayouts: GPUBindGroupLayoutShim[]; label?: string }): GPUPipelineLayoutShim {
    return new GPUPipelineLayoutShim([...(descriptor.bindGroupLayouts ?? [])]);
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
    if (descriptor.depthStencil) throw this.unsupported('a depth or stencil state in a render pipeline');
    if ((descriptor.multisample?.count ?? 1) > 1 || descriptor.multisample?.alphaToCoverageEnabled) throw this.unsupported('multisampled pipelines');
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
      if (resource instanceof GPUTextureViewShim) {
        if (resource.texture.canvas !== null) throw this.unsupported("a bind group with the canvas's texture; render into a texture of your own to sample it");
        if (resource.texture.destroyed) throw new Error('OperationError: createBindGroup: the texture was destroyed');
        if ((resource.texture.usage & GPU_TEXTURE_USAGE.TEXTURE_BINDING) === 0) throw new RangeError('OperationError: createBindGroup: the texture was made without GPUTextureUsage.TEXTURE_BINDING');
        entries.push({ binding: e.binding, view: resource });
      } else if (resource instanceof GPUSamplerShim) {
        entries.push({ binding: e.binding, sampler: resource });
      } else {
        const buffer = (resource as { buffer?: unknown })?.buffer;
        if (!(buffer instanceof GPUBufferShim)) throw new TypeError('createBindGroup: a resource is not a buffer binding, a texture view or a sampler');
        const offset = (resource as { offset?: number }).offset ?? 0;
        entries.push({ binding: e.binding, buffer, offset, size: (resource as { size?: number }).size ?? buffer.size - offset });
      }
    }
    entries.sort((a, b) => a.binding - b.binding);
    // A layout the page made says what each binding holds; an automatic one is read by the renderer.
    if (!descriptor.layout.id.startsWith('auto:')) {
      const want = descriptor.layout.entries;
      for (const layout of want) {
        const entry = entries.find((x) => x.binding === layout.binding);
        const kind = layout.type === 'texture' ? 'view' : layout.type === 'sampler' ? 'sampler' : 'buffer';
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
    if ((descriptor.sampleCount ?? 1) !== 1) throw this.unsupported('a multisampled texture');
    if (descriptor.viewFormats !== undefined && [...descriptor.viewFormats].length > 0) throw this.unsupported('viewFormats on a texture');
    const size = sizeOf(call, descriptor.size);
    if (size.depth !== 1) throw this.unsupported('a texture with more than one array layer (or a 3D texture)');
    const format = descriptor.format;
    if (TEXEL_BYTES[format] === undefined) throw this.unsupported(`a texture of format ${String(format)}; the formats drawn are ${Object.keys(TEXEL_BYTES).join(', ')}`);
    const max = this.limits.maxTextureDimension2D!;
    if (size.width < 1 || size.height < 1 || size.width > max || size.height > max) throw new RangeError(`OperationError: ${call}: ${size.width} x ${size.height}; the sides run from 1 to ${max}`);
    const mips = whole(call, 'mipLevelCount', descriptor.mipLevelCount ?? 1, 1);
    if (mips > mostMips(size.width, size.height)) throw new RangeError(`OperationError: ${call}: ${mips} mip levels for a ${size.width} x ${size.height} texture (at most ${mostMips(size.width, size.height)})`);
    const usage = whole(call, 'usage', descriptor.usage, 0);
    if (usage === 0 || usage > 31) throw new RangeError(`OperationError: ${call}: usage ${usage} is not a combination of GPUTextureUsage flags drawn here`);
    if (usage & GPU_TEXTURE_USAGE.STORAGE_BINDING) throw this.unsupported('a texture with GPUTextureUsage.STORAGE_BINDING');
    return new GPUTextureShim(this, null, size.width, size.height, format, usage, mips, descriptor.label);
  }
  createSampler(descriptor: SamplerDescriptor = {}): GPUSamplerShim {
    const d = descriptor ?? {};
    if (d.compare !== undefined) throw this.unsupported('a comparison sampler');
    const out: WebGpuSampler = {};
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
  createComputePipeline(): never {
    throw this.unsupported('compute pipelines');
  }
  createComputePipelineAsync(): Promise<never> {
    return Promise.reject(this.unsupported('compute pipelines'));
  }
  createQuerySet(): never {
    throw this.unsupported('query sets');
  }
  createRenderBundleEncoder(): never {
    throw this.unsupported('render bundles');
  }
  importExternalTexture(): never {
    throw this.unsupported('device.importExternalTexture (video textures); copy the frame with queue.copyExternalImageToTexture');
  }
  pushErrorScope(): void {}
  popErrorScope(): Promise<null> {
    return Promise.resolve(null);
  }
  destroy(): void {}
}

export class GPUAdapterShim {
  /** Offered so that a page that asks for them gets a device; nothing is drawn with them. */
  readonly features = new Set<string>(['float32-filterable', 'timestamp-query']);
  readonly limits: Record<string, number> = { ...LIMITS };
  readonly info = { vendor: 'kinetograph', architecture: 'wgpu', device: '', description: 'Kinetograph' };
  readonly isFallbackAdapter = false;
  constructor(private readonly options: GpuOptions = {}) {}
  requestDevice(descriptor?: { requiredFeatures?: Iterable<string>; requiredLimits?: Record<string, number> }): Promise<GPUDeviceShim> {
    for (const feature of descriptor?.requiredFeatures ?? []) {
      if (!this.features.has(feature)) return Promise.reject(new TypeError(`requestDevice: the feature ${feature} is not supported`));
    }
    const device = new GPUDeviceShim(this.options);
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
