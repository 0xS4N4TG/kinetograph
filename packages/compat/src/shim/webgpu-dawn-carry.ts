// What a frame of a Dawn page reads that an earlier frame wrote.
//
// A Dawn device keeps its textures and buffers between frames, so a frame that reads what the frame before wrote (a
// feedback texture, a storage buffer a compute pass advances) is not a function of the frame alone: a jump to it, or a
// worker that starts at it, has to replay the frames before it on a fresh device. The frame loop does that when
// `dawnDependsOnHistory()` says so (the same hook as the WebGL render targets').
//
// The rule is conservative: when in doubt the page is called history dependent, which costs speed and never correctness.
// Each texture and buffer has the epoch (the frame's virtual time) of its last write. A frame history-depends when
//   - it reads a resource that nothing wrote yet but that something can write (a feedback texture's first read), or
//   - it reads a resource written in an earlier frame and the resource is written again after that read (a ping-pong,
//     an accumulation, a particle buffer). A resource that is written once and read for ever (a mip chain, a baked
//     texture, a vertex buffer) is not, and neither is one written in the frame before every read of it (a uniform
//     buffer, a shadow map).
// Not seen: a write by a fragment shader to a storage binding in a render pass, and a CPU write whose bytes depend on an
// earlier frame's page state that a replay of the page's callbacks would not make.

type Any = any;

interface State {
  /** The epoch of the last write, -Infinity when nothing wrote it yet. */
  written: number;
  /** Read in an epoch after the one it was written in. */
  stale: boolean;
  /** The epoch it was made in: what a resource holds in the frame that made it is zero, whichever frames came before. */
  born: number;
}

const states = new WeakMap<object, State>();
const views = new WeakMap<object, Any>();
const groups = new WeakMap<object, { buffers: Any[]; textures: Any[] }>();
const computePasses = new WeakSet<object>();
let flagged = false;
let paused = 0;
let now: () => number = () => 0;

const BUFFER_STORAGE = 0x0080;
const BUFFER_COPY_DST = 0x0008;
const BUFFER_MAP_WRITE = 0x0002;
const BUFFER_QUERY_RESOLVE = 0x0200;
const TEXTURE_COPY_DST = 0x02;
const TEXTURE_STORAGE = 0x08;
const TEXTURE_ATTACHMENT = 0x10;

const writable = (resource: Any): boolean => {
  const usage: number = resource.usage ?? 0;
  return 'size' in resource && !('width' in resource)
    ? (usage & (BUFFER_STORAGE | BUFFER_COPY_DST | BUFFER_MAP_WRITE | BUFFER_QUERY_RESOLVE)) !== 0
    : (usage & (TEXTURE_COPY_DST | TEXTURE_STORAGE | TEXTURE_ATTACHMENT)) !== 0;
};

function stateOf(resource: Any): State {
  let state = states.get(resource);
  if (state === undefined) {
    state = { written: -Infinity, stale: false, born: -Infinity };
    states.set(resource, state);
  }
  return state;
}

function read(resource: Any): void {
  if (paused > 0 || resource == null || typeof resource !== 'object') return;
  const state = stateOf(resource);
  if (state.written === -Infinity) {
    if (state.born < now() && writable(resource)) flagged = true;
  } else if (state.written < now()) {
    state.stale = true;
  }
}

function write(resource: Any): void {
  if (paused > 0 || resource == null || typeof resource !== 'object') return;
  const state = stateOf(resource);
  if (state.stale) flagged = true;
  state.written = now();
}

/** A resource that starts the frame cleared (the canvas's texture): what it holds is not from an earlier frame. */
export function startsCleared(resource: Any): void {
  stateOf(resource).written = now();
}

export function carryDepends(): boolean {
  return flagged;
}

/** Runs the engine's own use of a resource (the canvas's readback), which is not the page's. */
export function untracked<T>(work: () => T): T {
  paused++;
  try {
    return work();
  } finally {
    paused--;
  }
}

export function resetCarry(): void {
  flagged = false;
}

function wrap(proto: Any, name: string, before: (this: Any, args: Any[]) => void): void {
  const original = proto?.[name];
  if (typeof original !== 'function') return;
  Object.defineProperty(proto, name, { value: function (this: Any, ...args: Any[]) { before.call(this, args); return original.apply(this, args); }, writable: true, configurable: true });
}

const textureOf = (view: Any): Any => views.get(view) ?? view;

/** Patches the library's classes so that every use of a texture or a buffer is seen. `clock` is the frame's epoch. */
export function trackCarry(g: Record<string, Any>, clock: () => number): void {
  now = clock;
  const wrapResult = (proto: Any, name: string, after: (this: Any, result: Any, args: Any[]) => void): void => {
    const original = proto[name];
    Object.defineProperty(proto, name, { value: function (this: Any, ...args: Any[]) { const result = original.apply(this, args); after.call(this, result, args); return result; }, writable: true, configurable: true });
  };
  wrapResult(g.GPUDevice.prototype, 'createTexture', (texture) => {
    stateOf(texture).born = now();
  });
  wrapResult(g.GPUTexture.prototype, 'createView', function (view) { views.set(view, this); });
  wrapResult(g.GPUDevice.prototype, 'createBindGroup', (group, [descriptor]) => {
    const buffers: Any[] = [];
    const textures: Any[] = [];
    for (const entry of descriptor.entries ?? []) {
      const resource = entry.resource;
      if (resource?.buffer !== undefined) buffers.push(resource.buffer);
      else if (views.has(resource)) textures.push(views.get(resource));
      else if (resource?.size !== undefined && resource?.usage !== undefined) buffers.push(resource);
    }
    groups.set(group, { buffers, textures });
  });
  wrapResult(g.GPUDevice.prototype, 'createBuffer', (buffer, [descriptor]) => {
    stateOf(buffer).born = now();
    if (descriptor?.mappedAtCreation) write(buffer);
  });
  wrap(g.GPUBuffer.prototype, 'mapAsync', function ([mode]) {
    if (((mode as number) & 0x02) !== 0) write(this);
  });
  wrapResult(g.GPUCommandEncoder.prototype, 'beginRenderPass', (_pass, [descriptor]) => {
    for (const attachment of descriptor.colorAttachments ?? []) {
      if (attachment == null) continue;
      const texture = textureOf(attachment.view);
      if (attachment.loadOp === 'load') read(texture);
      if (attachment.storeOp !== 'discard') write(texture);
      if (attachment.resolveTarget) write(textureOf(attachment.resolveTarget));
    }
    const depth = descriptor.depthStencilAttachment;
    if (depth) {
      const texture = textureOf(depth.view);
      if (depth.depthLoadOp === 'load' || depth.stencilLoadOp === 'load') read(texture);
      if (depth.depthStoreOp === 'store' || depth.stencilStoreOp === 'store') write(texture);
    }
  });
  wrapResult(g.GPUCommandEncoder.prototype, 'beginComputePass', (pass) => {
    computePasses.add(pass);
  });
  const bind = function (this: Any, [, group]: Any[]): void {
    const used = group && groups.get(group);
    if (!used) return;
    const compute = computePasses.has(this);
    for (const buffer of used.buffers) {
      read(buffer);
      if (compute && ((buffer.usage ?? 0) & BUFFER_STORAGE) !== 0) write(buffer);
    }
    for (const texture of used.textures) {
      read(texture);
      if (compute && ((texture.usage ?? 0) & TEXTURE_STORAGE) !== 0) write(texture);
    }
  };
  for (const cls of ['GPURenderPassEncoder', 'GPUComputePassEncoder', 'GPURenderBundleEncoder']) wrap(g[cls].prototype, 'setBindGroup', bind);
  for (const cls of ['GPURenderPassEncoder', 'GPURenderBundleEncoder']) {
    wrap(g[cls].prototype, 'setVertexBuffer', function ([, buffer]) { read(buffer); });
    wrap(g[cls].prototype, 'setIndexBuffer', function ([buffer]) { read(buffer); });
    wrap(g[cls].prototype, 'drawIndirect', function ([buffer]) { read(buffer); });
    wrap(g[cls].prototype, 'drawIndexedIndirect', function ([buffer]) { read(buffer); });
  }
  wrap(g.GPUComputePassEncoder.prototype, 'dispatchWorkgroupsIndirect', function ([buffer]) { read(buffer); });
  const copies = g.GPUCommandEncoder.prototype;
  wrap(copies, 'copyBufferToBuffer', function ([from, , to]) { read(from); write(to); });
  wrap(copies, 'copyBufferToTexture', function ([from, to]) { read(from.buffer); write(to.texture); });
  wrap(copies, 'copyTextureToBuffer', function ([from, to]) { read(from.texture); write(to.buffer); });
  wrap(copies, 'copyTextureToTexture', function ([from, to]) { read(from.texture); write(to.texture); });
  wrap(copies, 'clearBuffer', function ([buffer]) { write(buffer); });
  wrap(copies, 'resolveQuerySet', function ([, , , buffer]) { write(buffer); });
  wrap(g.GPUQueue.prototype, 'writeBuffer', function ([buffer]) { write(buffer); });
  wrap(g.GPUQueue.prototype, 'writeTexture', function ([destination]) { write(destination.texture); });
}
