// Motion-blur helpers (AUTHORING.md §5.3). The frame loop asks which sub-frame
// times a frame needs (`collectMotionTimes`), renders the composition at each,
// and hands the trees back to `attachMotionFrames`, which writes
// `motionBlur.frames` (§4.5) so a layer's own animated props blur too.

import type { Keyframe, KeyframeEasing, LayerJson, MotionBlurJson, Num } from './types.js';

/** Defaults of SCENE.md, "Motion blur". */
const DEFAULT_SAMPLES = 8;
const DEFAULT_SHUTTER = 0.5;
const MIN_SAMPLES = 2;
const MAX_SAMPLES = 64;
const MAX_SHUTTER = 2;

function ease(easing: KeyframeEasing | undefined, t: number): number {
  switch (easing) {
    case 'easeIn':
      return t * t * t;
    case 'easeOut':
      return 1 - (1 - t) ** 3;
    case 'easeInOut':
      return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    default:
      return t;
  }
}

/** An animatable number at `frame`, by SCENE.md's rules: the first value holds before the first keyframe and the last
 *  after the last, `easing` shapes the segment that starts at a keyframe, two keyframes on one frame make a step. */
export function evalNum(value: Num, frame: number): number {
  if (typeof value === 'number') return value;
  const keys: Keyframe[] = value;
  if (keys.length === 0) throw new Error('a keyframe list needs at least one keyframe');
  // The last keyframe at or before `frame`.
  let next = 0;
  while (next < keys.length && (keys[next] as Keyframe).frame <= frame) next += 1;
  if (next === 0) return (keys[0] as Keyframe).value;
  const a = keys[next - 1] as Keyframe;
  const b = keys[next];
  if (b === undefined) return a.value;
  const t = (frame - a.frame) / (b.frame - a.frame);
  return a.value + (b.value - a.value) * ease(a.easing, t);
}

/**
 * The sub-frame times of one blurred layer at `frame`: `t_i = frame + shutter * ((i + 0.5) / samples - 0.5)` for `i`
 * in `0..samples`, the shutter cut into equal slots centred on the frame with each sample in the middle of its slot
 * (SCENE.md, "Motion blur"). `shutter` is clamped to 0..2; `samples` is a whole number from 2 to 64.
 */
export function motionTimes(frame: number, samples: number, shutter: number): number[] {
  if (!Number.isInteger(samples) || samples < MIN_SAMPLES || samples > MAX_SAMPLES) {
    throw new RangeError(`motion blur samples must be a whole number from ${MIN_SAMPLES} to ${MAX_SAMPLES}, got ${samples}`);
  }
  const open = Math.min(Math.max(shutter, 0), MAX_SHUTTER);
  const times: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    times.push(frame + open * ((i + 0.5) / samples - 0.5));
  }
  return times;
}

/** The sub-frame times of `layer`'s own `motionBlur` at `frame`, or null when it has none or its shutter is closed. */
function timesOf(layer: LayerJson, frame: number): number[] | null {
  const mb = layer.motionBlur;
  if (mb === undefined) return null;
  const shutter = Math.min(Math.max(evalNum(mb.shutter ?? DEFAULT_SHUTTER, frame), 0), MAX_SHUTTER);
  // A closed shutter is exactly the layer without motion blur, and does not stop its children's (SCENE.md).
  if (shutter === 0) return null;
  try {
    return motionTimes(frame, mb.samples ?? DEFAULT_SAMPLES, shutter);
  } catch (error) {
    throw new RangeError(`layer "${layer.id}": ${(error as Error).message}`);
  }
}

/**
 * The distinct sub-frame times, sorted, that any outermost `motionBlur` layer needs at `frame`. A `motionBlur` inside
 * a blurred layer is ignored by the renderer (its samples are already the average), so it asks for nothing.
 */
export function collectMotionTimes(layers: LayerJson[], frame: number): number[] {
  const times = new Set<number>();
  const visit = (list: LayerJson[]): void => {
    for (const layer of list) {
      const own = timesOf(layer, frame);
      if (own !== null) {
        for (const t of own) times.add(t);
      } else if (layer.type === 'group') {
        visit(layer.children);
      }
    }
  };
  visit(layers);
  return [...times].sort((a, b) => a - b);
}

/** `layer` and its subtree without any `motionBlur`: a sub-frame copy is already one sample, and the renderer ignores
 *  its own `motionBlur`, so dropping it keeps the JSON small. */
function withoutMotionBlur(layer: LayerJson): LayerJson {
  const { motionBlur: _dropped, ...rest } = layer;
  if (rest.type === 'group') {
    return { ...rest, children: rest.children.map(withoutMotionBlur) };
  }
  return rest;
}

/** Every layer of a tree by id (ids are unique across a scene), nested layers included. */
function indexById(layers: LayerJson[], into = new Map<string, LayerJson>()): Map<string, LayerJson> {
  for (const layer of layers) {
    into.set(layer.id, layer);
    if (layer.type === 'group') indexById(layer.children, into);
  }
  return into;
}

/**
 * New layers with `motionBlur.frames` filled for every outermost blurred layer: `frames[i]` is the layer as the tree
 * rendered at `motionTimes(...)[i]` has it, matched by id and type. A layer missing from that tree (or of another
 * type there) becomes a copy of itself with opacity 0, so it contributes nothing at that sub-frame. Layers off the
 * path to a blurred layer are shared with the input, not copied; the input is not changed.
 */
export function attachMotionFrames(
  layers: LayerJson[],
  frame: number,
  treesAt: ReadonlyMap<number, LayerJson[]>,
): LayerJson[] {
  const indexes = new Map<number, Map<string, LayerJson>>();
  const lookup = (time: number): Map<string, LayerJson> => {
    let index = indexes.get(time);
    if (index === undefined) {
      const tree = treesAt.get(time);
      if (tree === undefined) {
        throw new Error(`attachMotionFrames: no tree was rendered at sub-frame time ${time} (frame ${frame})`);
      }
      index = indexById(tree);
      indexes.set(time, index);
    }
    return index;
  };

  const attach = (list: LayerJson[]): LayerJson[] => {
    let changed = false;
    const out = list.map((layer) => {
      const times = timesOf(layer, frame);
      if (times !== null) {
        const frames = times.map((time) => {
          const there = lookup(time).get(layer.id);
          if (there !== undefined && there.type === layer.type) return withoutMotionBlur(there);
          return { ...withoutMotionBlur(layer), opacity: 0 };
        });
        changed = true;
        const motionBlur: MotionBlurJson = { ...layer.motionBlur, frames };
        return { ...layer, motionBlur };
      }
      if (layer.type === 'group') {
        const children = attach(layer.children);
        if (children !== layer.children) {
          changed = true;
          return { ...layer, children };
        }
      }
      return layer;
    });
    return changed ? out : list;
  };
  return attach(layers);
}
