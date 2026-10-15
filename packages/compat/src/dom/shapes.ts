// Box outlines: the rectangle of a border box with CSS's corner radii, as a scene shape or as path data.

import type { ShapeGeometry } from '@kinetograph/scene';
import type { Corners } from '../css/types.js';
import { px, r3, type LengthEnv } from './util.js';

/** `[horizontal, vertical]` radius of each corner. */
export interface Radii {
  tl: [number, number];
  tr: [number, number];
  br: [number, number];
  bl: [number, number];
}

export const NO_RADII: Radii = { tl: [0, 0], tr: [0, 0], br: [0, 0], bl: [0, 0] };

/** The radii of a `w` x `h` box in px, scaled down together when two on a side would overlap (CSS's rule). */
export function resolveRadii(corners: Corners | undefined, w: number, h: number, env: LengthEnv): Radii {
  if (corners === undefined) return NO_RADII;
  const at = (i: number): [number, number] => [
    Math.max(0, px(corners[i]![0], env, w)),
    Math.max(0, px(corners[i]![1], env, h)),
  ];
  const radii: Radii = { tl: at(0), tr: at(1), br: at(2), bl: at(3) };
  const sides = [
    [w, radii.tl[0] + radii.tr[0]],
    [h, radii.tr[1] + radii.br[1]],
    [w, radii.bl[0] + radii.br[0]],
    [h, radii.tl[1] + radii.bl[1]],
  ] as const;
  let factor = 1;
  for (const [length, sum] of sides) {
    if (sum > length && sum > 0) factor = Math.min(factor, length / sum);
  }
  if (factor < 1) {
    for (const key of ['tl', 'tr', 'br', 'bl'] as const) radii[key] = [radii[key][0] * factor, radii[key][1] * factor];
  }
  return radii;
}

/** The radii of the same box shrunk by `d` on every side (an inner edge, or the centre line of a border). */
export function shrinkRadii(radii: Radii, d: number): Radii {
  const shrink = ([h, v]: [number, number]): [number, number] => [Math.max(0, h - d), Math.max(0, v - d)];
  return { tl: shrink(radii.tl), tr: shrink(radii.tr), br: shrink(radii.br), bl: shrink(radii.bl) };
}

export function hasRadii(radii: Radii): boolean {
  return [radii.tl, radii.tr, radii.br, radii.bl].some(([h, v]) => h > 0 && v > 0);
}

const fmt = (n: number): string => String(r3(n));

/** Path data of the rectangle `(x, y, w, h)` with `radii`, clockwise from the top edge. */
export function boxPath(x: number, y: number, w: number, h: number, radii: Radii): string {
  const { tl, tr, br, bl } = radii;
  const corner = (r: [number, number], toX: number, toY: number): string =>
    r[0] > 0 && r[1] > 0 ? `A${fmt(r[0])} ${fmt(r[1])} 0 0 1 ${fmt(toX)} ${fmt(toY)}` : `L${fmt(toX)} ${fmt(toY)}`;
  return [
    `M${fmt(x + tl[0])} ${fmt(y)}`,
    `L${fmt(x + w - tr[0])} ${fmt(y)}`,
    corner(tr, x + w, y + tr[1]),
    `L${fmt(x + w)} ${fmt(y + h - br[1])}`,
    corner(br, x + w - br[0], y + h),
    `L${fmt(x + bl[0])} ${fmt(y + h)}`,
    corner(bl, x, y + h - bl[1]),
    `L${fmt(x)} ${fmt(y + tl[1])}`,
    corner(tl, x + tl[0], y),
    'Z',
  ].join(' ');
}

/**
 * The scene shape of a `w` x `h` box at the layer's origin: a `rect`, a `roundedRect` for one circular radius on all
 * four corners, else a `path`.
 */
export function boxShape(w: number, h: number, radii: Radii): ShapeGeometry {
  if (!hasRadii(radii)) return { kind: 'rect', width: r3(w), height: r3(h) };
  const [first, ...rest] = [radii.tl, radii.tr, radii.br, radii.bl];
  const uniform = first![0] === first![1] && rest.every((r) => r[0] === first![0] && r[1] === first![1]);
  if (uniform) return { kind: 'roundedRect', width: r3(w), height: r3(h), radius: r3(first![0]) };
  return { kind: 'path', d: boxPath(0, 0, w, h, radii) };
}
