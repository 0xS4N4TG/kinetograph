// `transform` onto the layer transform (docs/COMPAT.md §4.3): a list that reduces to one translation, rotations and
// one uniform scale, in the order the layer applies them (translate, rotateX, rotateY, rotate, scale).

import type { Length, TransformOp } from '../css/types.js';
import { px, type LengthEnv } from './util.js';

export interface ReducedTransform {
  tx: number;
  ty: number;
  tz: number;
  rotateX: number;
  rotateY: number;
  /** Degrees about z, clockwise. */
  rotation: number;
  scale: number;
}

const EPS = 1e-9;
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/** Expands a `matrix` / `matrix3d` into the translation and the rotation-and-uniform-scale it is, or null. */
function decompose(values: number[]): TransformOp[] | null {
  let a: number, b: number, c: number, d: number, e: number, f: number, z = 0;
  if (values.length === 6) {
    [a, b, c, d, e, f] = values as [number, number, number, number, number, number];
  } else if (values.length === 16) {
    const m = values;
    // No third row or column, no perspective.
    if (!near(m[2]!, 0) || !near(m[3]!, 0) || !near(m[6]!, 0) || !near(m[7]!, 0)) return null;
    if (!near(m[8]!, 0) || !near(m[9]!, 0) || !near(m[10]!, 1) || !near(m[11]!, 0) || !near(m[15]!, 1)) return null;
    a = m[0]!;
    b = m[1]!;
    c = m[4]!;
    d = m[5]!;
    e = m[12]!;
    f = m[13]!;
    z = m[14]!;
  } else {
    return null;
  }
  // A rotation and a uniform scale: [a c; b d] = s [cos -sin; sin cos].
  if (!near(a, d) || !near(b, -c)) return null;
  const s = Math.hypot(a, b);
  if (s < EPS) return null;
  const px = (value: number): Length => ({ unit: 'px', value });
  const ops: TransformOp[] = [{ op: 'translate', x: px(e), y: px(f), z: px(z) }];
  const angle = (Math.atan2(b, a) * 180) / Math.PI;
  if (!near(angle, 0)) ops.push({ op: 'rotate', axis: 'z', angle });
  if (!near(s, 1)) ops.push({ op: 'scale', x: s, y: s, z: 1 });
  return ops;
}

/**
 * The layer transform a `transform` list is, or why it cannot be one. `box` is the border box, which a percentage
 * in a `translate` is of.
 */
export function reduceTransform(
  list: readonly TransformOp[],
  box: { width: number; height: number },
  env: LengthEnv,
): ReducedTransform | { error: string } {
  const out: ReducedTransform = { tx: 0, ty: 0, tz: 0, rotateX: 0, rotateY: 0, rotation: 0, scale: 1 };
  // 0: translating, 1: rotateX seen, 2: rotateY seen, 3: rotate (z) seen, 4: scaled.
  let stage = 0;

  const expanded: TransformOp[] = [];
  for (const op of list) {
    if (op.op === 'matrix') {
      const parts = decompose(op.values);
      if (parts === null) return { error: 'a matrix that is not a translation, a rotation and a uniform scale' };
      expanded.push(...parts);
    } else {
      expanded.push(op);
    }
  }

  for (const op of expanded) {
    switch (op.op) {
      case 'translate':
        if (stage > 0) return { error: 'a translation after a rotation or a scale' };
        out.tx += px(op.x, env, box.width);
        out.ty += px(op.y, env, box.height);
        out.tz += px(op.z, env, 0);
        break;
      case 'rotate':
        if (op.axis === 'x') {
          if (stage > 1) return { error: 'rotateX after another rotation or a scale' };
          stage = 1;
          out.rotateX += op.angle;
        } else if (op.axis === 'y') {
          if (stage > 2) return { error: 'rotateY after a rotation about z or a scale' };
          stage = 2;
          out.rotateY += op.angle;
        } else {
          // A uniform scale and a turn about z commute, so they may come in either order.
          stage = Math.max(stage, 3);
          out.rotation += op.angle;
        }
        break;
      case 'scale': {
        if (!near(op.x, op.y)) return { error: 'a scale that is not uniform' };
        if (!near(op.z, 1) && !near(op.z, op.x)) return { error: 'a scale along z' };
        stage = 4;
        out.scale *= op.x;
        break;
      }
      case 'skew':
        return { error: 'skew' };
      case 'perspective':
        return { error: 'the perspective() function' };
      case 'matrix':
        break;
    }
  }
  if (!Number.isFinite(out.scale)) return { error: 'a scale that is not finite' };
  return out;
}

export function isIdentity(t: ReducedTransform): boolean {
  return t.tx === 0 && t.ty === 0 && t.tz === 0 && t.rotateX === 0 && t.rotateY === 0 && t.rotation === 0 && t.scale === 1;
}

/** Whether the pivot matters: the box turns or scales. */
export function needsPivot(t: ReducedTransform): boolean {
  return t.rotateX !== 0 || t.rotateY !== 0 || t.rotation !== 0 || t.scale !== 1;
}
