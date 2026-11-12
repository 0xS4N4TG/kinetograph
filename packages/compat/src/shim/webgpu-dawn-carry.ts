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
//   - the page reads occlusion query results back (a buffer resolved from an occlusion query set, or a copy of one, is mapped): an
//     object it draws is hidden or not by what the frame before drew, so the frame before has to be drawn, with its results read, or
//   - it reads a resource written in an earlier frame and the resource is written again after that read (a ping-pong,
//     an accumulation, a particle buffer). A resource that is written once and read for ever (a mip chain, a baked
//     texture, a vertex buffer) is not, and neither is one written in the frame before every read of it (a uniform
//     buffer, a shadow map), or
//   - it reads a resource written in an earlier frame and, in the same frame, GPU-writes a resource that had its last write
//     in an earlier frame or is made in this frame (`predicted`). This is the ping-pong the page filled when it mounted, which
//     a frame jumped to cannot tell from its textures alone: it reads the one the mount wrote and writes the other, and the
//     read of the other (which the rules above need) only comes in the frame after. The rule cannot tell that resource from a
//     static texture that is only read, so it is made from what a write is: a CPU write (`writeBuffer`, `writeTexture`, a
//     mapped range) is the page's own data, not what a GPU pass made from an earlier frame's; a copy of what the CPU wrote
//     this frame is too; a pass that clears an attachment the shaders cannot sample or copy (a depth buffer, a multisampled
//     colour target) overwrites it whole and nothing can read the old contents; the canvas starts every frame cleared. What is
//     left is a pass's, a compute shader's or a copy's write to a resource that held something: for a page that draws from an
//     animation-frame callback it is not acted on (a jump steps the callbacks), for one that draws from an effect it costs a
//     replay of the frames before a jump, when the page also reads a resource written in an earlier frame (a baked texture or a
//     vertex buffer counts) and keeps a render target or a buffer it writes every frame that a shader can read.
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
  /** What the last write put in it came from the CPU alone (a `writeBuffer`, a copy of such bytes), not from a pass of any frame. */
  fromCpu: boolean;
}

const states = new WeakMap<object, State>();
const views = new WeakMap<object, Any>();
const groups = new WeakMap<object, { buffers: Any[]; textures: Any[] }>();
const computePasses = new WeakSet<object>();
/** Buffers that hold occlusion query results, or a copy of them: what a page reads from one decides what it draws next. */
const occlusionResults = new WeakSet<object>();
/** Whether a render pipeline tests depth or stencil, so that what a depth attachment was loaded with can change the picture. */
const testsDepth = new WeakMap<object, boolean>();
/** A render pass that loaded a depth attachment: the texture and the epoch of its last write before the pass, until a pipeline that tests it is set. */
const loadedDepth = new WeakMap<object, { texture: Any; written: number }>();
let flagged = false;
/** The epoch of the last read of a resource written in an earlier epoch, and of the last GPU write of a resource that held something (`predicted`). */
let staleReadAt = -Infinity;
let carryWriteAt = -Infinity;
/** The third rule above: a frame read what an earlier frame wrote and wrote a resource that held something. Not part of `flagged`: a static page with a shadow map is one. */
let predicted = false;
let predictedOutside = false;
/** Flagged by something done outside an animation-frame callback (an effect, a render): what a replay of the skipped frames repeats. */
let flaggedOutside = false;
let inCallbacks = 0;
let paused = 0;
let now: () => number = () => 0;

const BUFFER_STORAGE = 0x0080;
const BUFFER_COPY_DST = 0x0008;
const BUFFER_MAP_WRITE = 0x0002;
const BUFFER_QUERY_RESOLVE = 0x0200;
const TEXTURE_COPY_SRC = 0x01;
const TEXTURE_COPY_DST = 0x02;
const TEXTURE_BINDING = 0x04;
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
    state = { written: -Infinity, stale: false, readEmpty: Infinity, born: -Infinity, fromCpu: false };
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
    noteStaleRead();
  }
}

/**
 * A write. `gpu` is a pass's, a compute shader's or a copy's (a CPU write is not what an earlier frame's pass made); `exempt` is one
 * that cannot carry (a clear of an attachment nothing can sample or copy).
 */
function write(resource: Any, gpu = false, exempt = false): void {
  if (paused > 0 || resource == null || typeof resource !== 'object') return;
  const state = stateOf(resource);
  if (state.stale || state.readEmpty < now()) flag();
  if (gpu && !exempt && ((state.written < now() && state.written !== -Infinity) || (state.written === -Infinity && state.born === now()))) noteCarryWrite();
  state.written = now();
  state.fromCpu = !gpu;
}

function noteStaleRead(): void {
  staleReadAt = now();
  notePredicted();
}

function noteCarryWrite(): void {
  carryWriteAt = now();
  notePredicted();
}

function notePredicted(): void {
  if (staleReadAt !== now() || carryWriteAt !== now()) return;
  predicted = true;
  if (inCallbacks === 0) predictedOutside = true;
}

/** Whether what a pass or a copy writes can be read by anything but a later pass that loads it (a shader samples it, a copy takes it). */
const readable = (texture: Any): boolean => ((texture.usage ?? 0) & (TEXTURE_BINDING | TEXTURE_STORAGE | TEXTURE_COPY_SRC)) !== 0;

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
  return flaggedOutside || predictedOutside;
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
  predicted = false;
  predictedOutside = false;
  staleReadAt = carryWriteAt = -Infinity;
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
    // The results come from the draws of the frame the page maps them in; it uses them in the next one, whichever way that is reached.
    if (occlusionResults.has(this) && paused === 0) {
      flagged = true;
      flaggedOutside = true;
    }
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
      if (attachment.storeOp !== 'discard') write(texture, true, attachment.loadOp === 'clear' && !readable(texture));
      if (attachment.resolveTarget) write(textureOf(attachment.resolveTarget), true);
    }
    const depth = descriptor.depthStencilAttachment;
    if (depth) {
      const texture = textureOf(depth.view);
      // What the pass loads only matters once a pipeline that tests depth or stencil draws in it: a pass that draws a full-screen
      // quad with the test off (an output pass) loads a texture it does not read.
      if (depth.depthLoadOp === 'load' || depth.stencilLoadOp === 'load') loadedDepth.set(pass, { texture, written: stateOf(texture).written });
      if (depth.depthStoreOp === 'store' || depth.stencilStoreOp === 'store') write(texture, true, depth.depthLoadOp !== 'load' && depth.stencilLoadOp !== 'load' && !readable(texture));
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
      if (compute && ((buffer.usage ?? 0) & BUFFER_STORAGE) !== 0) write(buffer, true);
    }
    for (const texture of used.textures) {
      read(texture);
      if (compute && ((texture.usage ?? 0) & TEXTURE_STORAGE) !== 0) write(texture, true);
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
  /** A copy: what the CPU wrote in this frame, copied, is still the CPU's. */
  const copy = (from: Any, to: Any): void => {
    read(from);
    const source = paused === 0 && from != null && typeof from === 'object' ? stateOf(from) : null;
    const cpu = source !== null && source.fromCpu && source.written === now();
    write(to, true, cpu);
    if (cpu && paused === 0) stateOf(to).fromCpu = true;
  };
  wrap(copies, 'copyBufferToBuffer', function ([from, , to]) {
    if (occlusionResults.has(from)) occlusionResults.add(to);
    copy(from, to);
  });
  wrap(copies, 'copyBufferToTexture', function ([from, to]) { copy(from.buffer, to.texture); });
  wrap(copies, 'copyTextureToBuffer', function ([from, to]) { copy(from.texture, to.buffer); });
  wrap(copies, 'copyTextureToTexture', function ([from, to]) { copy(from.texture, to.texture); });
  wrap(copies, 'clearBuffer', function ([buffer]) { write(buffer, true, true); });
  wrap(copies, 'resolveQuerySet', function ([set, , , buffer]) {
    if (set?.type === 'occlusion') occlusionResults.add(buffer);
    write(buffer, true);
  });
  wrap(g.GPUQueue.prototype, 'writeBuffer', function ([buffer]) { write(buffer); });
  wrap(g.GPUQueue.prototype, 'writeTexture', function ([destination]) { write(destination.texture); });
}
