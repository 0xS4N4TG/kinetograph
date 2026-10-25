// `navigator.gpu` and `GPUCanvasContext` that record instead of rasterising (packages/cli/skills/kinetograph/references/ENGINE.md,
// "WebGPU"). A page's WebGPU code runs against these objects; the render passes it submits to a canvas become the
// `webgpu` part of a `glsl` layer (`WebGpuContent`), and the renderer replays them on its own wgpu device with the page's
// own WGSL. Nothing here reads a clock or anything outside the calls.
//
// The slice drawn is what shader pages use: one device, uniform / storage / vertex / index buffers, WGSL modules, bind
// group layouts, render pipelines, bind groups, command encoders with render passes into the canvas's texture, `draw` and
// `drawIndexed`, `writeBuffer`. Textures, samplers, compute, queries and bundles are not recorded: the call throws
// `WebGpuUnsupportedError` and the frame reports it (`WebGpuContent.notes`).
//
// A buffer's bytes are shadowed here, and a submit snapshots the ones its passes read, so a frame's recording holds
// everything it needs and is the same whichever frames were drawn before it.

import type { WebGpuBindGroup, WebGpuBindingLayout, WebGpuCommand, WebGpuContent, WebGpuPass, WebGpuPipeline, GlslContent } from './types.js';
import { hashOf, toBase64 } from './webgl.js';

/** Thrown by a call the engine does not draw. The message starts with "unsupported:". */
export class WebGpuUnsupportedError extends Error {
  override name = 'WebGpuUnsupportedError';
  constructor(what: string) {
    super(`unsupported: ${what} (packages/cli/skills/kinetograph/references/ENGINE.md, "WebGPU")`);
  }
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

// ---- resources ----

class GpuObject {
  label: string;
  constructor(label: unknown) {
    this.label = typeof label === 'string' ? label : '';
  }
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

export class GPUBindGroupShim extends GpuObject {
  constructor(
    readonly layout: GPUBindGroupLayoutShim,
    readonly entries: { binding: number; buffer: GPUBufferShim; offset: number; size: number }[],
  ) {
    super('');
  }
}

export class GPUCommandBufferShim extends GpuObject {
  constructor(readonly items: EncodedItem[]) {
    super('');
  }
}

// ---- encoding ----

interface Attachment {
  context: GPUCanvasContextShim;
  clear: [number, number, number, number] | null;
}

type PassCommand =
  | { c: 'pipeline'; pipeline: GPURenderPipelineShim }
  | { c: 'bind'; index: number; group: GPUBindGroupShim; offsets?: number[] }
  | { c: 'vertex'; slot: number; buffer: GPUBufferShim; offset: number; size?: number }
  | { c: 'index'; buffer: GPUBufferShim; format: string; offset: number; size?: number }
  | Exclude<WebGpuCommand, { c: 'pipeline' | 'bind' | 'vertex' | 'index' }>;

type EncodedItem =
  | { kind: 'pass'; attachment: Attachment; commands: PassCommand[] }
  | { kind: 'copy'; source: GPUBufferShim; sourceOffset: number; target: GPUBufferShim; targetOffset: number; size: number }
  | { kind: 'clear'; buffer: GPUBufferShim; offset: number; size: number };

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
    this.add({ c: 'pipeline', pipeline });
  }
  setBindGroup(index: number, group: GPUBindGroupShim | null, offsets?: unknown, start?: number, length?: number): void {
    if (group === null) return;
    let list: number[] | undefined;
    if (Array.isArray(offsets)) list = offsets.map(Number);
    else if (offsets !== undefined && offsets !== null) list = Array.from((offsets as Uint32Array).subarray(start ?? 0, (start ?? 0) + (length ?? (offsets as Uint32Array).length)));
    this.add(list === undefined || list.length === 0 ? { c: 'bind', index, group } : { c: 'bind', index, group, offsets: list });
  }
  setVertexBuffer(slot: number, buffer: GPUBufferShim | null, offset = 0, size?: number): void {
    if (buffer === null) return;
    this.add(size === undefined ? { c: 'vertex', slot, buffer, offset } : { c: 'vertex', slot, buffer, offset, size });
  }
  setIndexBuffer(buffer: GPUBufferShim, format: string, offset = 0, size?: number): void {
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

function colorOf(value: unknown): [number, number, number, number] {
  if (Array.isArray(value)) return [Number(value[0] ?? 0), Number(value[1] ?? 0), Number(value[2] ?? 0), Number(value[3] ?? 0)];
  const c = (value ?? {}) as { r?: number; g?: number; b?: number; a?: number };
  return [Number(c.r ?? 0), Number(c.g ?? 0), Number(c.b ?? 0), Number(c.a ?? 0)];
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
    if (attachments.length !== 1) throw this.device.unsupported(`a render pass with ${attachments.length} colour attachments; one, the canvas's texture, is drawn`);
    if (descriptor.depthStencilAttachment) throw this.device.unsupported('a depth or stencil attachment');
    if (descriptor.occlusionQuerySet) throw this.device.unsupported('occlusion queries');
    const attachment = attachments[0]!;
    if (attachment.resolveTarget) throw this.device.unsupported('a resolve target (multisampling)');
    const view = attachment.view;
    if (!(view instanceof GPUTextureViewShim)) throw this.device.unsupported('a render pass into a texture that is not the canvas');
    const clear = (attachment.loadOp ?? 'clear') === 'load' ? null : colorOf(attachment.clearValue);
    return new GPURenderPassEncoderShim(this, { context: view.texture.context, clear });
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
  copyBufferToTexture(): never {
    throw this.device.unsupported('encoder.copyBufferToTexture');
  }
  copyTextureToBuffer(): never {
    throw this.device.unsupported('encoder.copyTextureToBuffer');
  }
  copyTextureToTexture(): never {
    throw this.device.unsupported('encoder.copyTextureToTexture');
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

// ---- the canvas ----

/** The canvas's texture of this frame. Only a render pass may draw into it. */
export class GPUTextureShim extends GpuObject {
  readonly dimension = '2d';
  readonly depthOrArrayLayers = 1;
  readonly mipLevelCount = 1;
  readonly sampleCount = 1;
  readonly usage = GPU_TEXTURE_USAGE.RENDER_ATTACHMENT | GPU_TEXTURE_USAGE.COPY_SRC;
  constructor(readonly context: GPUCanvasContextShim, readonly width: number, readonly height: number, readonly format: string) {
    super('');
  }
  createView(): GPUTextureViewShim {
    return new GPUTextureViewShim(this);
  }
  destroy(): void {}
}

export class GPUTextureViewShim extends GpuObject {
  constructor(readonly texture: GPUTextureShim) {
    super('');
  }
}

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
  private format = 'rgba8unorm';
  private alphaMode = 'opaque';
  private stale = false;
  private passes: WebGpuPass[] = [];
  private modules = new Map<string, string>();
  private layouts = new Map<string, WebGpuBindingLayout[]>();
  private pipelines = new Map<string, WebGpuPipeline>();
  private buffers = new Map<string, string>();
  private bindGroups = new Map<string, WebGpuBindGroup>();

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
    return new GPUTextureShim(this, Math.max(1, width), Math.max(1, height), this.format);
  }

  /** The device submitted a pass for this canvas: snapshots what it reads and keeps it. */
  record(clear: [number, number, number, number] | null, commands: PassCommand[]): void {
    this.begin();
    const out: WebGpuCommand[] = [];
    let pipeline: GPURenderPipelineShim | null = null;
    for (const command of commands) {
      switch (command.c) {
        case 'pipeline': {
          pipeline = command.pipeline;
          for (const module of pipeline.modules) this.modules.set(module.id, module.code);
          for (const layout of pipeline.layouts ?? []) this.layouts.set(layout.id, layout.entries);
          this.pipelines.set(pipeline.id, pipeline.descriptor);
          out.push({ c: 'pipeline', id: pipeline.id });
          break;
        }
        case 'bind': {
          const { group } = command;
          if (!group.layout.id.startsWith('auto:')) this.layouts.set(group.layout.id, group.layout.entries);
          const snapshot: WebGpuBindGroup = {
            layout: group.layout.id,
            entries: group.entries.map((e) => ({ binding: e.binding, buffer: e.buffer.snapshot(this.buffers), offset: e.offset, size: e.size })),
          };
          const id = `g${hashOf(JSON.stringify(snapshot))}`;
          this.bindGroups.set(id, snapshot);
          out.push(command.offsets === undefined ? { c: 'bind', index: command.index, group: id } : { c: 'bind', index: command.index, group: id, offsets: command.offsets });
          break;
        }
        case 'vertex':
          out.push({ ...command, buffer: command.buffer.snapshot(this.buffers) });
          break;
        case 'index':
          out.push({ ...command, buffer: command.buffer.snapshot(this.buffers) });
          break;
        default:
          out.push(command);
      }
    }
    this.passes.push({ clear, commands: out });
  }

  private begin(): void {
    if (!this.stale) return;
    this.stale = false;
    this.passes = [];
    this.modules.clear();
    this.layouts.clear();
    this.pipelines.clear();
    this.buffers.clear();
    this.bindGroups.clear();
  }

  /** The recording: what the `glsl` layer holds. */
  content(): GlslContent {
    const notes = this.device === null ? [] : [...this.device.notes];
    const webgpu: WebGpuContent = {
      modules: Object.fromEntries(this.modules),
      layouts: Object.fromEntries(this.layouts),
      pipelines: Object.fromEntries(this.pipelines),
      buffers: Object.fromEntries(this.buffers),
      bindGroups: Object.fromEntries(this.bindGroups),
      passes: this.passes,
    };
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
    return this.passes.length > 0 || (this.device?.notes.size ?? 0) > 0;
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
        } else {
          item.attachment.context.record(item.attachment.clear, item.commands);
        }
      }
    }
    void this.device;
  }
  onSubmittedWorkDone(): Promise<void> {
    return Promise.resolve();
  }
  writeTexture(): never {
    throw this.device.unsupported('queue.writeTexture');
  }
  copyExternalImageToTexture(): never {
    throw this.device.unsupported('queue.copyExternalImageToTexture');
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

  constructor() {
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
  createBuffer(descriptor: { size: number; usage: number; label?: string; mappedAtCreation?: boolean }): GPUBufferShim {
    return new GPUBufferShim(this, descriptor);
  }
  createShaderModule(descriptor: { code: string; label?: string }): GPUShaderModuleShim {
    return new GPUShaderModuleShim(descriptor);
  }
  createBindGroupLayout(descriptor: { entries: { binding: number; visibility: number; buffer?: { type?: string; hasDynamicOffset?: boolean }; sampler?: unknown; texture?: unknown; storageTexture?: unknown; externalTexture?: unknown }[]; label?: string }): GPUBindGroupLayoutShim {
    const entries: WebGpuBindingLayout[] = [];
    for (const e of descriptor.entries ?? []) {
      if (e.sampler || e.texture || e.storageTexture || e.externalTexture || !e.buffer) throw this.unsupported('a bind group layout with textures or samplers; only buffers are drawn');
      const type = e.buffer.type ?? 'uniform';
      if (!SHADER_BINDING_TYPES.has(type)) throw new TypeError(`createBindGroupLayout: buffer type ${type}`);
      const entry: WebGpuBindingLayout = { binding: e.binding, visibility: e.visibility, type: type as WebGpuBindingLayout['type'] };
      if (e.buffer.hasDynamicOffset) entry.dynamicOffset = true;
      entries.push(entry);
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
  createBindGroup(descriptor: { layout: GPUBindGroupLayoutShim; entries: { binding: number; resource: { buffer?: GPUBufferShim; offset?: number; size?: number } }[]; label?: string }): GPUBindGroupShim {
    const entries = [];
    for (const e of descriptor.entries ?? []) {
      const buffer = e.resource?.buffer;
      if (!(buffer instanceof GPUBufferShim)) throw this.unsupported('a bind group with textures or samplers; only buffers are drawn');
      const offset = e.resource.offset ?? 0;
      entries.push({ binding: e.binding, buffer, offset, size: e.resource.size ?? buffer.size - offset });
    }
    entries.sort((a, b) => a.binding - b.binding);
    return new GPUBindGroupShim(descriptor.layout, entries);
  }
  createCommandEncoder(): GPUCommandEncoderShim {
    return new GPUCommandEncoderShim(this);
  }
  createTexture(): never {
    throw this.unsupported('device.createTexture');
  }
  createSampler(): never {
    throw this.unsupported('device.createSampler');
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
    throw this.unsupported('device.importExternalTexture (video textures)');
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
  requestDevice(descriptor?: { requiredFeatures?: Iterable<string>; requiredLimits?: Record<string, number> }): Promise<GPUDeviceShim> {
    for (const feature of descriptor?.requiredFeatures ?? []) {
      if (!this.features.has(feature)) return Promise.reject(new TypeError(`requestDevice: the feature ${feature} is not supported`));
    }
    const device = new GPUDeviceShim();
    for (const feature of descriptor?.requiredFeatures ?? []) device.features.add(feature);
    return Promise.resolve(device);
  }
}

export class GPUShim {
  readonly wgslLanguageFeatures = new Set<string>();
  requestAdapter(): Promise<GPUAdapterShim> {
    return Promise.resolve(new GPUAdapterShim());
  }
  getPreferredCanvasFormat(): string {
    return 'rgba8unorm';
  }
}

/** `navigator.gpu`. */
export function createGpu(): GPUShim {
  return new GPUShim();
}

export function createGpuCanvasContext(options: GPUCanvasContextOptions): GPUCanvasContextShim {
  return new GPUCanvasContextShim(options);
}
