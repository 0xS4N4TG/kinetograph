// What a render target holds from one frame to the next (packages/cli/skills/kinetograph/references/SCENE.md, "glsl").
//
// A page draws into a framebuffer's texture once, then reads it for as long as it lives: Three.js prefilters an
// environment map into one when the scene is built (`PMREMGenerator.fromScene`) and samples it in every frame after. The
// recording starts each frame from an empty drawing buffer, and a texture a framebuffer drew in is what the ops that
// drew it left. So the ops that wrote a render target are carried into the frames after them, and a frame's recording
// opens with the ones its own ops read.
//
// A frame is then a function of its number only where the frames that fed a target were rendered: a target drawn at
// load or at mount, or overwritten before it is read, is the same however the frames are ordered or divided among
// processes; one a frame makes from what it held before (a trail, `dependsOnHistory`) or reads from what the frame
// before it wrote (`readsLastFrame`: a ping-pong that swaps its targets each frame) needs every frame before it
// rendered, and the frame loop renders the frames it skips when a frame shows that (packages/core/src/frame-loop.tsx).
// A target regenerated only at a frame K before the one before the frame asked for is not seen.
// Pure functions of the ops and what they name: nothing here reads the context.

import type { GlslDraw, GlslOp, GlslProgram, GlslTexture } from './types.js';

type Textures = Map<string, GlslTexture>;

/** The programs, buffers and textures the ops name, by id (the fields of a recording that are not ops). */
export interface Resources {
  programs: Map<string, GlslProgram>;
  buffers: Map<string, string>;
  textures: Map<string, GlslTexture>;
}

/**
 * The ops that wrote render targets in earlier frames, what they name, the targets that lost their oldest ops, and
 * which of the ops are the last frame's (a frame that reads what the frame before it wrote depends on that frame).
 */
export interface Carry extends Resources {
  ops: GlslOp[];
  lost: Set<string>;
  last: Set<GlslOp>;
}

export function emptyCarry(): Carry {
  return { ops: [], programs: new Map(), buffers: new Map(), textures: new Map(), lost: new Set(), last: new Set() };
}

/**
 * The most ops kept for one target, counting every op that writes it (a draw into a colour target and its depth buffer
 * counts for both). A loop that reads a target before it overwrites it (feedback, a pass that does not clear) grows by
 * its draws each frame; past this the op is dropped, all the targets it writes are named as lost, and the frames that
 * read them are reported as not drawn right (`carriedFor`).
 */
export const MAX_OPS_PER_TARGET = 1024;

/** Whether an op goes to the canvas: its drawing buffer, or its depth and stencil buffer. */
export function isCanvasOp(op: GlslOp): boolean {
  if (op.op === 'upload') return false;
  return op.target === undefined && (op.op === 'blit' || (op.outputs === undefined && op.depthStencil === undefined));
}

/** A part of a render target an op writes: `id@level` for colour, `id@ds` for the depth and stencil buffer. */
interface Write {
  id: string;
  key: string;
  /** Every texel of it is written, whatever it held. */
  whole: boolean;
}


const levelSize = (texture: GlslTexture | undefined, level: number): [number, number] | null =>
  texture?.width === undefined || texture.height === undefined ? null : [Math.max(1, texture.width >> level), Math.max(1, texture.height >> level)];

/** The depth and stencil buffer a draw or a clear writes. */
const depthStencilOf = (op: GlslOp): string | undefined => (op.op === 'draw' || op.op === 'clear' ? op.depthStencil : undefined);

/** The colour outputs of a draw or a clear, as `{ target, level }`. */
function colourOutputs(op: GlslOp): { target: string; level: number }[] {
  if (op.op === 'upload') return [{ target: op.target, level: 0 }];
  if (op.target !== undefined) return [{ target: op.target, level: op.level ?? 0 }];
  if (op.op === 'blit') return [];
  return (op.outputs ?? []).flatMap((o) => (o === null ? [] : [{ target: o.target, level: o.level ?? 0 }]));
}

/** Decodes base64 to bytes. */
const bytesOf = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64, 'base64'));

/**
 * The clip-space xy of the vertices a draw reads, when they can be known: the vertex shader assigns `gl_Position` once,
 * as `vec4(a, 1.0)`, `vec4(a.xy, z, 1.0)` or the like, with `a` a float attribute that advances per vertex and a z that
 * stays inside the clip volume (a literal, or the attribute's own third component). Null otherwise (a matrix, a uniform).
 */
function clipPositions(draw: GlslDraw, res: Resources): [number, number][] | null {
  const vertex = res.programs.get(draw.program)?.vertex;
  const found = vertex?.match(/gl_Position\s*=\s*vec4\(\s*([A-Za-z_]\w*)(?:\.xyz?)?\s*(?:,\s*([-\d.]+)\s*)?,\s*1(?:\.0*)?\s*\)\s*;/);
  if (vertex === undefined || found === null || found === undefined || vertex.split('gl_Position').length !== 2) return null;
  const literal = found[2] === undefined ? undefined : Number(found[2]);
  if (literal !== undefined && !(Math.abs(literal) <= 1)) return null;
  const attribute = draw.attributes[found[1]!];
  const data = attribute === undefined ? undefined : res.buffers.get(attribute.buffer);
  if (attribute === undefined || data === undefined || attribute.type !== 'f32' || attribute.size < 2 || (attribute.divisor ?? 0) !== 0) return null;
  const bytes = bytesOf(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stride = attribute.stride || attribute.size * 4;
  // With no literal, the attribute is a vec3 and its z is clipped where it leaves [-1, 1] (a vec2 one has z 0).
  const zAt = literal === undefined && attribute.size >= 3;
  const at = (vertex: number): [number, number] | null => {
    const offset = (attribute.offset ?? 0) + vertex * stride;
    if (offset + (zAt ? 12 : 8) > bytes.byteLength) return null;
    return zAt && !(Math.abs(view.getFloat32(offset + 8, true)) <= 1) ? null : [view.getFloat32(offset, true), view.getFloat32(offset + 4, true)];
  };
  const order: number[] = [];
  if (draw.indices === undefined) for (let i = 0; i < draw.count; i++) order.push(draw.first + i);
  else {
    const index = res.buffers.get(draw.indices.buffer);
    const size = { u8: 1, u16: 2, u32: 4 }[draw.indices.type];
    if (index === undefined) return null;
    const raw = bytesOf(index);
    const indexView = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < draw.count; i++) {
      const place = draw.indices.offset + (draw.first + i) * size;
      if (place + size > raw.byteLength) return null;
      order.push(size === 1 ? indexView.getUint8(place) : size === 2 ? indexView.getUint16(place, true) : indexView.getUint32(place, true));
    }
  }
  const out: [number, number][] = [];
  for (const vertex of order) {
    const point = at(vertex);
    if (point === null) return null;
    out.push(point);
  }
  return out;
}

/** The corners of the triangles a draw of `count` vertices makes in `mode`, or null for a mode that is not triangles. */
function triangles(mode: GlslDraw['mode'], points: Point[]): Point[][] | null {
  const out: Point[][] = [];
  if (mode === 'triangles') for (let i = 0; i + 2 < points.length; i += 3) out.push([points[i]!, points[i + 1]!, points[i + 2]!]);
  else if (mode === 'triangleStrip') for (let i = 0; i + 2 < points.length; i++) out.push(i % 2 === 0 ? [points[i]!, points[i + 1]!, points[i + 2]!] : [points[i + 1]!, points[i]!, points[i + 2]!]);
  else if (mode === 'triangleFan') for (let i = 1; i + 1 < points.length; i++) out.push([points[0]!, points[i]!, points[i + 1]!]);
  else return null;
  return out;
}

type Point = [number, number];

const cross = (o: Point, a: Point, b: Point): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Whether `p` is in the triangle (edges included); a triangle with no area holds nothing. */
function inTriangle(p: Point, [a, b, c]: Point[]): boolean {
  if (cross(a!, b!, c!) === 0) return false;
  const d1 = cross(a!, b!, p), d2 = cross(b!, c!, p), d3 = cross(c!, a!, p);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/**
 * Whether the triangles hold the whole clip square `[-1, 1]^2`, shown exactly for the two shapes a pass draws: one
 * triangle that holds the four corners, or two that share an edge and make a convex quad that holds them (the union of
 * the two is then the quad, and a convex shape holds the square when it holds its corners). Anything else is not shown.
 */
function coversClipSquare(tris: Point[][]): boolean {
  const corners: Point[] = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  if (tris.length === 1) return corners.every((p) => inTriangle(p, tris[0]!));
  if (tris.length !== 2) return false;
  const [t, u] = tris as [Point[], Point[]];
  const same = (p: Point, q: Point) => p[0] === q[0] && p[1] === q[1];
  const shared = t.filter((p) => u.some((q) => same(p, q)));
  if (shared.length !== 2) return false;
  const [a, b] = shared as [Point, Point];
  const c = t.find((p) => !shared.some((q) => same(p, q)));
  const d = u.find((p) => !shared.some((q) => same(p, q)));
  if (c === undefined || d === undefined) return false;
  // The other corners are on opposite sides of the shared edge, and the shared edge's ends on opposite sides of the line between them.
  if (!(cross(a, b, c) * cross(a, b, d) < 0) || !(cross(c, d, a) * cross(c, d, b) < 0)) return false;
  return corners.every((p) => inTriangle(p, t) || inTriangle(p, u));
}

/**
 * Whether a draw writes every texel of the level: nothing blends, masks, clips, tests or discards, its viewport holds
 * the level, and its triangles hold the whole clip square, none of them culled. Shown from the draw's own data: a vertex
 * shader that is anything but `gl_Position = vec4(attribute, ..., 1.0)` is not read, so the draw is not counted.
 */
function overwrites(draw: GlslDraw, size: [number, number], res: Resources): boolean {
  const [x, y, w, h] = draw.viewport;
  if (draw.blend !== undefined || !(draw.colorMask ?? [true]).every(Boolean) || draw.scissor !== undefined || draw.depth !== undefined || draw.stencil !== undefined) return false;
  if (x > 0 || y > 0 || x + w < size[0] || y + h < size[1] || (draw.instances ?? 1) !== 1) return false;
  if (/\bdiscard\b/.test(res.programs.get(draw.program)?.fragment ?? 'discard')) return false;
  const points = clipPositions(draw, res);
  const tris = points === null ? null : triangles(draw.mode, points);
  if (tris === null || !coversClipSquare(tris)) return false;
  if (draw.cull === undefined) return true;
  // Counter-clockwise is front unless `front` says clockwise; a triangle of the face that is culled does not draw.
  const front = draw.cull.front === 'CW' ? -1 : 1;
  return tris.every(([a, b, c]) => {
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    const facing = Math.sign(area) * front;
    return draw.cull!.face === 'FRONT' ? facing < 0 : draw.cull!.face === 'BACK' ? facing > 0 : false;
  });
}

/**
 * What the op writes. A draw counts as writing all of its target when `overwrites` shows it; a clear of colour, a blit
 * or a `texSubImage2D` that covers the level, and a clear of a whole depth or stencil buffer do.
 */
function writesOf(op: GlslOp, res: Resources): Write[] {
  const out: Write[] = [];
  for (const { target, level } of colourOutputs(op)) {
    const size = levelSize(res.textures.get(target), level);
    let whole = false;
    if (op.op === 'clear') whole = op.color !== undefined;
    else if (op.op === 'blit') {
      const [x0, y0, x1, y1] = op.to;
      whole = op.aspect === undefined && op.scissor === undefined && size !== null && Math.min(x0, x1) <= 0 && Math.min(y0, y1) <= 0 && Math.max(x0, x1) >= size[0] && Math.max(y0, y1) >= size[1];
    } else if (op.op === 'upload') whole = size !== null && op.x <= 0 && op.y <= 0 && op.x + op.width >= size[0] && op.y + op.height >= size[1];
    else whole = size !== null && overwrites(op, size, res);
    out.push({ id: target, key: `${target}@${level}`, whole });
  }
  const buffer = depthStencilOf(op);
  if (buffer !== undefined) {
    const kind = res.textures.get(buffer)?.format;
    const whole = op.op === 'clear' && (kind === 'depth' ? op.depth !== undefined : kind === 'stencil' ? op.stencil !== undefined : op.depth !== undefined && op.stencil !== undefined);
    out.push({ id: buffer, key: `${buffer}@ds`, whole });
  }
  return out;
}

/** A part of a texture an op reads: `key` (`id@level`, or `id@ds`) for a blit, which reads one level or the depth and stencil; none for a sampler, which may take any. */
interface Read {
  id: string;
  key?: string;
}

/** What an op samples or blits from; the faces of a cube map for the cube. */
function readsOf(op: GlslOp, textures: Textures): Read[] {
  const faces = (id: string): string[] => {
    const texture = textures.get(id);
    return texture?.cube === true && texture.targets !== undefined ? texture.targets : [id];
  };
  if (op.op === 'draw') return Object.values(op.units).flatMap((u) => faces(u.texture).map((id) => ({ id })));
  if (op.op !== 'blit' || op.src === undefined) return [];
  const level = op.aspect === undefined ? `${op.srcLevel ?? 0}` : 'ds';
  return faces(op.src).map((id) => ({ id, key: `${id}@${level}` }));
}

/** Every part of a texture a read may take: each level of colour, and the depth and stencil. */
const partsOf = (id: string, textures: Textures): string[] => [...Array.from({ length: textures.get(id)?.levels ?? 1 }, (_, level) => `${id}@${level}`), `${id}@ds`];

/** The parts of a texture the read may take. */
const partsRead = (read: Read, textures: Textures): string[] => (read.key !== undefined ? [read.key] : partsOf(read.id, textures));

/** Whether the read may take the part `key`. */
const takes = (read: Read, key: string): boolean => (read.key !== undefined ? read.key === key : key.startsWith(`${read.id}@`));

/** Whether the op can be played again in a later frame: it writes a render target, and reads nothing that is the frame's own (the canvas, a child layer). */
function carriable(op: GlslOp, textures: Textures): boolean {
  if (isCanvasOp(op) || (op.op === 'blit' && op.src === undefined) || (op.op === 'upload' && op.layer !== undefined)) return false;
  return !readsOf(op, textures).some((r) => textures.get(r.id)?.layer !== undefined);
}

/**
 * The ops for the next frame to carry: the render-target ops of `done` joined to those before, less what a later op
 * overwrote before anything read it, and with no more than `MAX_OPS_PER_TARGET` of the ops that write one target (an
 * op over the cap goes, and every target it writes is named in `lost`).
 */
export function carryOn(carried: GlslOp[], done: GlslOp[], res: Resources): { ops: GlslOp[]; lost: string[]; last: Set<GlslOp> } {
  const fresh = done.filter((op) => carriable(op, res.textures));
  const ops = [...carried, ...fresh];
  // Walking back: a part is dead from the op that overwrites all of it until an op that reads it.
  const dead = new Set<string>();
  const counts = new Map<string, number>();
  const lost = new Set<string>();
  const keep: GlslOp[] = [];
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]!;
    const writes = writesOf(op, res);
    if (writes.length > 0 && writes.every((w) => dead.has(w.key))) continue;
    const owners = [...new Set(writes.map((w) => w.id))];
    if (owners.some((id) => (counts.get(id) ?? 0) >= MAX_OPS_PER_TARGET)) {
      for (const id of owners) lost.add(id);
      continue;
    }
    for (const id of owners) counts.set(id, (counts.get(id) ?? 0) + 1);
    keep.push(op);
    for (const w of writes) if (w.whole) dead.add(w.key);
    for (const read of readsOf(op, res.textures)) for (const key of [...dead]) if (takes(read, key)) dead.delete(key);
  }
  const kept = new Set(keep);
  return { ops: keep.reverse(), lost: [...lost], last: new Set(fresh.filter((op) => kept.has(op))) };
}

/**
 * The carried ops the frame's ops need, in order: those that wrote what a frame op reads, or writes over in part, and
 * what those read in turn. `incomplete` names the targets the frame reads that lost their oldest ops (`lost`), whose
 * contents are then not what the page drew.
 */
export function carriedFor(carried: GlslOp[], lost: Set<string>, frame: GlslOp[], res: Resources): { ops: GlslOp[]; incomplete: string[] } {
  if (carried.length === 0) return { ops: [], incomplete: [] };
  const ops = [...carried, ...frame];
  // Walking back: a part of a texture is wanted from an op that reads it until the op that overwrites all of it.
  const wanted = new Set<string>();
  const needed: GlslOp[] = [];
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]!;
    const writes = writesOf(op, res);
    const root = i >= carried.length;
    if (!root && !writes.some((w) => wanted.has(w.key))) continue;
    if (!root) needed.push(op);
    for (const w of writes) {
      if (w.whole) wanted.delete(w.key);
      else wanted.add(w.key);
    }
    for (const read of readsOf(op, res.textures)) for (const key of partsRead(read, res.textures)) wanted.add(key);
  }
  // What is still wanted after the oldest carried op was produced before it.
  const incomplete = [...lost].filter((id) => [...wanted].some((key) => key.startsWith(`${id}@`)));
  return { ops: needed.reverse(), incomplete };
}

/**
 * Whether the frame's own ops make a render target from what it held before the frame: a write that does not cover the
 * target (a sprite, a blend, a scissor, a depth test) when nothing wrote all of it earlier in the frame, or a read of a
 * target the frame also writes before it has written all of it. A frame of ops that only read targets, or that start
 * each target with a clear or a covering draw, is the same whatever frames came before it.
 */
export function dependsOnHistory(frame: GlslOp[], res: Resources): boolean {
  // Only the ops that write a target make one; the ops that go to the canvas read, and what they read counts.
  const written = new Set(frame.flatMap((op) => writesOf(op, res).map((w) => w.key)));
  const whole = new Set<string>();
  for (const op of frame) {
    for (const read of readsOf(op, res.textures)) for (const key of partsRead(read, res.textures)) if (written.has(key) && !whole.has(key)) return true;
    const writes = writesOf(op, res);
    if (writes.some((w) => !w.whole && !whole.has(w.key))) return true;
    for (const w of writes) if (w.whole) whole.add(w.key);
  }
  return false;
}

/** Whether the frame's ops need an op that the frame before it wrote: they read a target last written then and do not cover it first. */
export function readsLastFrame(carry: Carry, frame: GlslOp[], res: Resources): boolean {
  return carry.last.size > 0 && carriedFor(carry.ops, carry.lost, frame, res).ops.some((op) => carry.last.has(op));
}

/** The ids of the programs, buffers and textures the ops name (the textures with the faces of the cube maps among them). */
export function namedBy(ops: GlslOp[], textures: Textures): { programs: Set<string>; buffers: Set<string>; textures: Set<string> } {
  const named = { programs: new Set<string>(), buffers: new Set<string>(), textures: new Set<string>() };
  const addTexture = (id: string): void => {
    named.textures.add(id);
    for (const face of textures.get(id)?.targets ?? []) named.textures.add(face);
  };
  for (const op of ops) {
    if (op.op === 'draw') {
      named.programs.add(op.program);
      for (const a of Object.values(op.attributes)) if (a.constant === undefined) named.buffers.add(a.buffer);
      if (op.indices !== undefined) named.buffers.add(op.indices.buffer);
      for (const u of Object.values(op.units)) addTexture(u.texture);
    }
    if (op.op === 'blit' && op.src !== undefined) addTexture(op.src);
    for (const { target } of colourOutputs(op)) addTexture(target);
    const buffer = depthStencilOf(op);
    if (buffer !== undefined) addTexture(buffer);
  }
  return named;
}

/** The entries of `from` (the first map that has each) the ids name. */
export function pick<V>(ids: Set<string>, ...from: Map<string, V>[]): Map<string, V> {
  const out = new Map<string, V>();
  for (const id of ids) {
    const found = from.find((m) => m.has(id));
    if (found !== undefined) out.set(id, found.get(id)!);
  }
  return out;
}
