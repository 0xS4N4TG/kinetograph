// `transform` lists (CSS Transforms 1 and 2), `transform-origin`, `perspective` and `perspective-origin`.

import { type Tok, fail, isKw, isLengthLike, splitCommas } from './tokens.js';
import type { Length, TransformOp } from './types.js';
import { angleOf, lengthOf, numberOrPercent, numberOf, positionOf } from './values.js';

const ZERO: Length = { unit: 'px', value: 0 };

/** Splits a function's arguments at commas (functions in a transform list always use commas). */
function argsOf(t: Extract<Tok, { type: 'function' }>, min: number, max: number): Tok[] {
  if (t.args.length === 0) return fail(`${t.name}() needs arguments`);
  const segs = splitCommas(t.args);
  if (segs.some((s) => s.length !== 1)) return fail(`${t.name}() arguments are separated by commas`);
  if (segs.length < min || segs.length > max) {
    return fail(`${t.name}() takes ${min === max ? min : `${min} to ${max}`} argument${max === 1 ? '' : 's'}, found ${segs.length}`);
  }
  return segs.map((s) => s[0]!);
}

const rotateMatrix = (x: number, y: number, z: number, deg: number): number[] => {
  const len = Math.hypot(x, y, z);
  if (len === 0) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const [ux, uy, uz] = [x / len, y / len, z / len] as const;
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const t = 1 - c;
  // Column-major, as `matrix3d` takes it (CSS Transforms 2 §rotate3d).
  return [
    t * ux * ux + c, t * ux * uy + s * uz, t * ux * uz - s * uy, 0,
    t * ux * uy - s * uz, t * uy * uy + c, t * uy * uz + s * ux, 0,
    t * ux * uz + s * uy, t * uy * uz - s * ux, t * uz * uz + c, 0,
    0, 0, 0, 1,
  ];
};

function oneFunction(t: Tok): TransformOp[] {
  if (t.type !== 'function') return fail(`expected a transform function, found \`${t.text}\``);
  const len = (a: Tok): Length => lengthOf(a);
  switch (t.name) {
    case 'translate': {
      const a = argsOf(t, 1, 2);
      return [{ op: 'translate', x: len(a[0]!), y: a[1] ? len(a[1]) : ZERO, z: ZERO }];
    }
    case 'translatex': return [{ op: 'translate', x: len(argsOf(t, 1, 1)[0]!), y: ZERO, z: ZERO }];
    case 'translatey': return [{ op: 'translate', x: ZERO, y: len(argsOf(t, 1, 1)[0]!), z: ZERO }];
    case 'translatez': return [{ op: 'translate', x: ZERO, y: ZERO, z: lengthOf(argsOf(t, 1, 1)[0], { percent: false }) }];
    case 'translate3d': {
      const a = argsOf(t, 3, 3);
      return [{ op: 'translate', x: len(a[0]!), y: len(a[1]!), z: lengthOf(a[2], { percent: false }) }];
    }
    case 'scale': {
      const a = argsOf(t, 1, 2);
      const x = numberOrPercent(a[0]);
      return [{ op: 'scale', x, y: a[1] ? numberOrPercent(a[1]) : x, z: 1 }];
    }
    case 'scalex': return [{ op: 'scale', x: numberOrPercent(argsOf(t, 1, 1)[0]), y: 1, z: 1 }];
    case 'scaley': return [{ op: 'scale', x: 1, y: numberOrPercent(argsOf(t, 1, 1)[0]), z: 1 }];
    case 'scalez': return [{ op: 'scale', x: 1, y: 1, z: numberOrPercent(argsOf(t, 1, 1)[0]) }];
    case 'scale3d': {
      const a = argsOf(t, 3, 3);
      return [{ op: 'scale', x: numberOrPercent(a[0]), y: numberOrPercent(a[1]), z: numberOrPercent(a[2]) }];
    }
    case 'rotate':
    case 'rotatez': return [{ op: 'rotate', axis: 'z', angle: angleOf(argsOf(t, 1, 1)[0]) }];
    case 'rotatex': return [{ op: 'rotate', axis: 'x', angle: angleOf(argsOf(t, 1, 1)[0]) }];
    case 'rotatey': return [{ op: 'rotate', axis: 'y', angle: angleOf(argsOf(t, 1, 1)[0]) }];
    case 'rotate3d': {
      const a = argsOf(t, 4, 4);
      const [x, y, z] = [numberOf(a[0]), numberOf(a[1]), numberOf(a[2])] as const;
      const angle = angleOf(a[3]);
      // An axis along x, y or z (of any positive length) is the plain rotation; any other axis is a matrix.
      const axes = [[x, 'x'], [y, 'y'], [z, 'z']] as const;
      const nonzero = axes.filter(([v]) => v !== 0);
      if (nonzero.length === 1) {
        const [v, axis] = nonzero[0]!;
        return [{ op: 'rotate', axis, angle: v > 0 ? angle : -angle }];
      }
      return [{ op: 'matrix', values: rotateMatrix(x, y, z, angle) }];
    }
    case 'skew': {
      const a = argsOf(t, 1, 2);
      return [{ op: 'skew', x: angleOf(a[0]), y: a[1] ? angleOf(a[1]) : 0 }];
    }
    case 'skewx': return [{ op: 'skew', x: angleOf(argsOf(t, 1, 1)[0]), y: 0 }];
    case 'skewy': return [{ op: 'skew', x: 0, y: angleOf(argsOf(t, 1, 1)[0]) }];
    case 'matrix': return [{ op: 'matrix', values: argsOf(t, 6, 6).map((a) => numberOf(a)) }];
    case 'matrix3d': return [{ op: 'matrix', values: argsOf(t, 16, 16).map((a) => numberOf(a)) }];
    case 'perspective': {
      const [a] = argsOf(t, 1, 1);
      if (isKw(a, 'none')) return fail('perspective(none) is not supported');
      return [{ op: 'perspective', length: lengthOf(a, { percent: false, negative: false }) }];
    }
    default:
      return fail(`the transform function ${t.name}() is not supported`);
  }
}

/** A `transform` value; `none` is the empty list. */
export function transformOf(toks: Tok[]): TransformOp[] {
  if (toks.length === 1 && isKw(toks[0], 'none')) return [];
  return toks.flatMap(oneFunction);
}

/** `transform-origin`: x, y and z, with keywords as percentages. Edge offsets (`right 10px bottom`) are not supported. */
export function transformOriginOf(toks: Tok[]): [Length, Length, Length] {
  if (toks.length === 4) return fail('edge-offset positions (three or four values) are not supported');
  if (toks.length === 3) {
    const z = toks[2]!;
    if (!isLengthLike(z) || z.type === 'percent') return fail('edge-offset positions (three or four values) are not supported');
    const [x, y] = positionOf(toks.slice(0, 2));
    return [x, y, lengthOf(z, { percent: false })];
  }
  const [x, y] = positionOf(toks);
  return [x, y, ZERO];
}

export function perspectiveOf(toks: Tok[]): Length | 'none' {
  if (toks.length === 1 && isKw(toks[0], 'none')) return 'none';
  if (toks.length !== 1) return fail('expected a length or none');
  return lengthOf(toks[0], { percent: false, negative: false });
}
