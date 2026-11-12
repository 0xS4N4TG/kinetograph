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
//   - it writes a resource that an earlier frame read while nothing had written it (the other texture of a ping-pong: a
//     frame jumped to reads the one the frame before wrote and writes the one an earlier frame read empty), or
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
  /** The first epoch it was read in while nothing had written it, Infinity when it was not. */
  readEmpty: number;
  /** The epoch it was made in: what a resource holds in the frame that made it is zero, whichever frames came before. */
  born: number;
}

const states = new WeakMap<object, State>();
const views = new WeakMap<object, Any>();
const groups = new WeakMap<object, { buffers: Any[]; textures: Any[] }>();
const computePasses = new WeakSet<object>();
/** Whether a render pipeline tests depth or stencil, so that what a depth attachment was loaded with can change the picture. */
const testsDepth = new WeakMap<object, boolean>();
/** A render pass that loaded a depth attachment: the texture and the epoch of its last write before the pass, until a pipeline that tests it is set. */
const loadedDepth = new WeakMap<object, { texture: Any; written: number }>();
let flagged = false;
/** Flagged by something done outside an animation-frame callback (an effect, a render): what a replay of the skipped frames repeats. */
let flaggedOutside = false;
let inCallbacks = 0;
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
    state = { written: -Infinity, stale: false, readEmpty: Infinity, born: -Infinity };
    states.set(resource, state);
  }
  return state;
}

function read(resource: Any): void {
  if (paused > 0 || resource == null || typeof resource !== 'object') return;
  const state = stateOf(resource);
  if (state.written === -Infinity) {
    if (writable(resource)) {
      if (state.born < now()) flag();
      state.readEmpty = Math.min(state.readEmpty, now());
    }
  } else if (state.written < now()) {
    state.stale = true;
  }
}

function write(resource: Any): void {
  if (paused > 0 || resource == null || typeof resource !== 'object') return;
  const state = stateOf(resource);
  if (state.stale || state.readEmpty < now()) flag();
  state.written = now();
}

/** A resource that starts the frame cleared (the canvas's texture): what it holds is not from an earlier frame. */
export function startsCleared(resource: Any): void {
  stateOf(resource).written = now();
}

function flag(): void {
  flagged = true;
  if (inCallbacks === 0) flaggedOutside = true;
}

/** Whether a frame read what an earlier frame wrote (by any page code: a jump back cannot rewind it, `noteDawnRewind`). */
export function carryDepends(): boolean {
  return flagged;
}

/**
 * Whether what carries was done outside the animation-frame callbacks. A jump runs those for the frames it skips
 * (`stepAnimationFrames`), so a page that draws from them has its state without a replay, and a replay would draw its frames twice;
 * a page that draws from effects (a React project) has its effects run only when a frame is rendered, so it is replayed.
 */
export function carryNeedsReplay(): boolean {
  return flaggedOutside;
}

/** Runs the animation-frame callbacks of a frame: what they do is not for a replay to repeat. */
export function duringAnimationFrames(work: () => void): void {
  inCallbacks++;
  try {
    work();
  } finally {
    inCallbacks--;
  }
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
  flaggedOutside = false;
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
  const noteDepthTest = (pipeline: Any, descriptor: Any): void => {
    const ds = descriptor?.depthStencil;
    const stencil = [ds?.stencilFront, ds?.stencilBack].some((face) => face !== undefined && (face.compare ?? 'always') !== 'always');
    testsDepth.set(pipeline, ds !== undefined && ((ds.depthCompare ?? 'always') !== 'always' || stencil));
  };
  wrapResult(g.GPUDevice.prototype, 'createRenderPipeline', (pipeline, [descriptor]) => noteDepthTest(pipeline, descriptor));
  const createAsync = g.GPUDevice.prototype.createRenderPipelineAsync;
  Object.defineProperty(g.GPUDevice.prototype, 'createRenderPipelineAsync', {
    value: function (this: Any, descriptor: Any) {
      return (createAsync.call(this, descriptor) as Promise<Any>).then((pipeline) => {
        noteDepthTest(pipeline, descriptor);
        return pipeline;
      });
    },
    writable: true,
    configurable: true,
  });
  wrap(g.GPURenderPassEncoder.prototype, 'setPipeline', function ([pipeline]) {
    const loaded = loadedDepth.get(this);
    if (loaded !== undefined && testsDepth.get(pipeline) === true) {
      loadedDepth.delete(this);
      // The read is of what the texture held when the pass began: the pass's own store has written it since.
      const state = stateOf(loaded.texture);
      if (loaded.written === -Infinity) state.readEmpty = Math.min(state.readEmpty, now());
      else if (loaded.written < now()) state.stale = true;
    }
  });
  wrapResult(g.GPUCommandEncoder.prototype, 'beginRenderPass', (pass, [descriptor]) => {
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
      // What the pass loads only matters once a pipeline that tests depth or stencil draws in it: a pass that draws a full-screen
      // quad with the test off (an output pass) loads a texture it does not read.
      if (depth.depthLoadOp === 'load' || depth.stencilLoadOp === 'load') loadedDepth.set(pass, { texture, written: stateOf(texture).written });
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
