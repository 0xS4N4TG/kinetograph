// `@remotion/shapes`: `make*` functions that return a path and its size, and
// components that draw it with `<Path>`. Written from the documented parameters
// and checked against values recorded from the published package
// (test/fixtures/shapes.json) for the plain shapes. The rounded variants
// (`cornerRadius`, `edgeRoundness`) are built the same way, as straight edges
// joined by curves whose control points sit on the corner; their exact numbers
// differ from the published package for polygons and stars, which shift the
// rounded outline by a fraction of a unit. `makeArrow`, `makeCallout` and
// `makeSpark` follow the published package step for step and match it exactly
// (test/fixtures/shapes-arrow-callout-spark.json).

import type { ReactNode } from 'react';
import { Path, type CommonProps } from '@kinetographdev/react';
import type { Paint, Stroke } from '@kinetographdev/scene';
import { getBoundingBox, parsePath, serializeInstructions, translatePath, type Instruction } from './paths.js';

export type { Instruction } from './paths.js';

export interface ShapeInfo {
  path: string;
  width: number;
  height: number;
  transformOrigin: string;
  instructions: Instruction[];
}

function result(path: string, width: number, height: number, transformOrigin: string): ShapeInfo {
  return { path, width, height, transformOrigin, instructions: parsePath(path) };
}

function positive(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`"${name}" must be a positive number, but got ${JSON.stringify(value)}`);
  }
  return value;
}

function checkRounding(cornerRadius: number | undefined, edgeRoundness: number | null | undefined): void {
  if (cornerRadius !== undefined && cornerRadius !== 0 && edgeRoundness !== undefined && edgeRoundness !== null) {
    throw new Error('"cornerRadius" and "edgeRoundness" cannot be specified at the same time.');
  }
}

interface Pt {
  x: number;
  y: number;
}

/** Closed polygon with straight edges, written as `M p0 L p1 … L p0`, with `Z` if asked. */
function straightPath(points: Pt[], close: boolean): string {
  const parts = [`M ${points[0]!.x} ${points[0]!.y}`];
  for (let i = 1; i < points.length; i++) parts.push(`L ${points[i]!.x} ${points[i]!.y}`);
  parts.push(`L ${points[0]!.x} ${points[0]!.y}`);
  if (close) parts.push('Z');
  return parts.join(' ');
}

/**
 * Corners rounded by `radius`: each edge runs to `radius` short of a corner and a
 * curve with both control points on the corner joins it to the next edge. Starts
 * at the second corner and ends on the first, as the published shapes do.
 */
function roundedCornersPath(points: Pt[], radius: number, close: boolean): string {
  const n = points.length;
  const toward = (from: Pt, to: Pt, distance: number): Pt => {
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const t = length === 0 ? 0 : Math.min(distance / length, 0.5);
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  };
  const parts: string[] = [];
  for (let k = 0; k < n; k++) {
    const i = (k + 1) % n;
    const corner = points[i]!;
    const before = toward(corner, points[(i + n - 1) % n]!, radius);
    const after = toward(corner, points[(i + 1) % n]!, radius);
    if (k === 0) parts.push(`M ${before.x} ${before.y}`);
    parts.push(`L ${before.x} ${before.y}`);
    parts.push(`C ${corner.x} ${corner.y} ${corner.x} ${corner.y} ${after.x} ${after.y}`);
  }
  if (close) parts.push('Z');
  return parts.join(' ');
}

/** Edges bent by `roundness` (0 straight): the outline runs through the edge midpoints, pulled towards each corner. */
function roundedEdgesPath(points: Pt[], roundness: number, close: boolean): string {
  const n = points.length;
  const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const parts: string[] = [];
  for (let k = 0; k < n; k++) {
    const corner = points[(k + 1) % n]!;
    const from = mid(points[k]!, corner);
    const to = mid(corner, points[(k + 2) % n]!);
    if (k === 0) parts.push(`M ${from.x} ${from.y}`);
    parts.push(
      `C ${from.x + roundness * (corner.x - from.x)} ${from.y + roundness * (corner.y - from.y)} ${to.x + roundness * (corner.x - to.x)} ${to.y + roundness * (corner.y - to.y)} ${to.x} ${to.y}`,
    );
  }
  if (close) parts.push('Z');
  return parts.join(' ');
}

function outline(points: Pt[], cornerRadius: number | undefined, edgeRoundness: number | null | undefined, close: boolean): string {
  checkRounding(cornerRadius, edgeRoundness);
  if (cornerRadius) return roundedCornersPath(points, cornerRadius, close);
  if (edgeRoundness !== undefined && edgeRoundness !== null) return roundedEdgesPath(points, edgeRoundness, close);
  return straightPath(points, close);
}

// ---- rect, circle, ellipse ----

export interface MakeRectOptions {
  width: number;
  height: number;
  cornerRadius?: number;
  edgeRoundness?: number | null;
}

export function makeRect({ width, height, cornerRadius = 0, edgeRoundness = null }: MakeRectOptions): ShapeInfo {
  positive('width', width);
  positive('height', height);
  checkRounding(cornerRadius, edgeRoundness);
  const origin = `${width / 2} ${height / 2}`;
  if (edgeRoundness !== null) {
    const corners = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
    return result(roundedEdgesPath(corners, edgeRoundness, true), width, height, origin);
  }
  if (cornerRadius > 0) {
    const r = Math.min(cornerRadius, width / 2, height / 2);
    const path =
      `M ${width - r} 0 L ${width - r} 0 a ${r} ${r} 0 0 1 ${r} ${r} L ${width} ${height - r} a ${r} ${r} 0 0 1 ${-r} ${r} ` +
      `L ${r} ${height} a ${r} ${r} 0 0 1 ${-r} ${-r} L 0 ${r} a ${r} ${r} 0 0 1 ${r} ${-r} Z`;
    return result(path, width, height, origin);
  }
  return result(`M 0 0 L ${width} 0 L ${width} ${height} L 0 ${height} L 0 0 Z`, width, height, origin);
}

export function makeCircle({ radius }: { radius: number }): ShapeInfo {
  positive('radius', radius);
  const path = `M ${radius} 0 a ${radius} ${radius} 0 1 1 0 ${radius * 2} a ${radius} ${radius} 0 1 1 0 ${-radius * 2} Z`;
  return result(path, radius * 2, radius * 2, `${radius} ${radius}`);
}

export function makeEllipse({ rx, ry }: { rx: number; ry: number }): ShapeInfo {
  positive('rx', rx);
  positive('ry', ry);
  // The two ends of the arc are a unit apart, so the large arc is the whole ellipse bar a sliver.
  return result(`M ${rx} 0 a ${rx} ${ry} 0 1 0 1 0 Z`, rx * 2, ry * 2, `${rx} ${ry}`);
}

// ---- triangle ----

export type TriangleDirection = 'up' | 'right' | 'down' | 'left';

export interface MakeTriangleOptions {
  length: number;
  direction: TriangleDirection;
  cornerRadius?: number;
  edgeRoundness?: number | null;
}

export function makeTriangle({ length, direction, cornerRadius, edgeRoundness }: MakeTriangleOptions): ShapeInfo {
  positive('length', length);
  const h = (length * Math.sqrt(3)) / 2;
  const centroid = (2 / 3) * h;
  let points: Pt[];
  let width: number;
  let height: number;
  let origin: string;
  switch (direction) {
    case 'up':
      points = [{ x: length / 2, y: 0 }, { x: 0, y: h }, { x: length, y: h }];
      [width, height, origin] = [length, h, `${length / 2} ${centroid}`];
      break;
    case 'down':
      points = [{ x: 0, y: 0 }, { x: length, y: 0 }, { x: length / 2, y: h }];
      [width, height, origin] = [length, h, `${length / 2} ${h - centroid}`];
      break;
    case 'right':
      points = [{ x: 0, y: 0 }, { x: 0, y: length }, { x: h, y: length / 2 }];
      [width, height, origin] = [h, length, `${h - centroid} ${length / 2}`];
      break;
    case 'left':
      points = [{ x: h, y: 0 }, { x: h, y: length }, { x: 0, y: length / 2 }];
      [width, height, origin] = [h, length, `${centroid} ${length / 2}`];
      break;
    default:
      throw new TypeError(`"direction" must be "up", "right", "down" or "left", but got ${JSON.stringify(direction)}`);
  }
  return result(outline(points, cornerRadius, edgeRoundness, true), width, height, origin);
}

// ---- polygon and star ----

/**
 * A rounded polygon or star no longer reaches the corners of the box it was laid out in, so (as in the
 * published package) it is moved to the top left of the box of the outline it ended up with, and that box is
 * its size.
 */
function fitted(path: string, width: number, height: number, origin: string, rounded: boolean): ShapeInfo {
  if (!rounded) return result(path, width, height, origin);
  const box = getBoundingBox(path);
  return result(translatePath(path, -box.x1, -box.y1), box.width, box.height, origin);
}

/** Points on a circle of `radius` around (cx, cy), starting at the top and going clockwise. */
function onCircle(cx: number, cy: number, radius: number, angle: number): Pt {
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
}

function extent(points: Pt[]): { minX: number; maxX: number; minY: number; maxY: number } {
  return {
    minX: Math.min(...points.map((p) => p.x)),
    maxX: Math.max(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
}

export interface MakePolygonOptions {
  points: number;
  radius: number;
  cornerRadius?: number;
  edgeRoundness?: number | null;
}

export function makePolygon({ points, radius, cornerRadius, edgeRoundness }: MakePolygonOptions): ShapeInfo {
  positive('radius', radius);
  if (!Number.isInteger(points) || points < 3) {
    throw new TypeError(`"points" must be an integer of at least 3, but got ${JSON.stringify(points)}`);
  }
  const raw: Pt[] = [];
  for (let i = 0; i < points; i++) raw.push(onCircle(0, 0, radius, -Math.PI / 2 + (i * 2 * Math.PI) / points));
  const { minX, maxX, minY, maxY } = extent(raw);
  const placed = raw.map((p) => ({ x: p.x - minX, y: p.y - minY }));
  const rounded = Boolean(cornerRadius) || (edgeRoundness !== undefined && edgeRoundness !== null);
  return fitted(outline(placed, cornerRadius, edgeRoundness, false), maxX - minX, maxY - minY, `${radius} ${radius}`, rounded);
}

export interface MakeStarOptions {
  points: number;
  innerRadius: number;
  outerRadius: number;
  cornerRadius?: number;
  edgeRoundness?: number | null;
}

export function makeStar({ points, innerRadius, outerRadius, cornerRadius, edgeRoundness }: MakeStarOptions): ShapeInfo {
  positive('innerRadius', innerRadius);
  positive('outerRadius', outerRadius);
  if (!Number.isInteger(points) || points < 2) {
    throw new TypeError(`"points" must be an integer of at least 2, but got ${JSON.stringify(points)}`);
  }
  const raw: Pt[] = [];
  for (let i = 0; i < points * 2; i++) {
    raw.push(onCircle(0, 0, i % 2 === 0 ? outerRadius : innerRadius, -Math.PI / 2 + (i * Math.PI) / points));
  }
  const { minX, maxX, minY, maxY } = extent(raw);
  // The star is placed so its top touches y = 0 and its middle is on the vertical centre line of its box.
  const placed = raw.map((p) => ({ x: p.x - minX, y: p.y - minY }));
  const width = maxX - minX;
  const height = maxY - minY;
  const rounded = Boolean(cornerRadius) || (edgeRoundness !== undefined && edgeRoundness !== null);
  return fitted(outline(placed, cornerRadius, edgeRoundness, true), width, height, `${outerRadius} ${outerRadius}`, rounded);
}

// ---- pie ----

export interface MakePieOptions {
  radius: number;
  /** 0 to 1: how much of the circle. */
  progress: number;
  closePath?: boolean;
  counterClockwise?: boolean;
  /** Radians the start is turned clockwise from the top. */
  rotation?: number;
}

const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

export function makePie({
  radius,
  progress,
  closePath = true,
  counterClockwise = false,
  rotation = 0,
}: MakePieOptions): ShapeInfo {
  positive('radius', radius);
  const c = radius;
  const sweep = counterClockwise ? 0 : 1;
  const direction = counterClockwise ? -1 : 1;
  const at = (angle: number): string => `${round5(c + radius * Math.sin(angle))} ${round5(c - radius * Math.cos(angle))}`;
  const start = at(rotation);
  const total = direction * progress * 2 * Math.PI;
  const parts = [`M ${start}`];
  if (progress > 0.5) {
    parts.push(`A ${radius} ${radius} 0 0 ${sweep} ${at(rotation + direction * Math.PI)}`);
    parts.push(`A ${radius} ${radius} 0 0 ${sweep} ${at(rotation + total)}`);
  } else {
    parts.push(`A ${radius} ${radius} 0 0 ${sweep} ${at(rotation + total)}`);
  }
  if (closePath) {
    if (progress > 0 && progress < 1) parts.push(`L ${c} ${c}`);
    parts.push('Z');
  }
  return result(parts.join(' '), radius * 2, radius * 2, `${radius} ${radius}`);
}

// ---- heart ----

export interface MakeHeartOptions {
  height: number;
  aspectRatio?: number;
  /** Moves the two control points that shape the bottom point, sideways, as a fraction of the width. */
  bottomRoundnessAdjustment?: number;
  /** Moves the cleft at the top down (positive) or up, as a fraction of the height. */
  depthAdjustment?: number;
}

export function makeHeart({
  height,
  aspectRatio = 1.1,
  bottomRoundnessAdjustment = 0,
  depthAdjustment = 0,
}: MakeHeartOptions): ShapeInfo {
  positive('height', height);
  positive('aspectRatio', aspectRatio);
  const w = height * aspectRatio;
  const h = height;
  const x = (u: number) => u * w;
  const y = (v: number) => v * h;
  // The control points are those of the 110 x 100 heart drawn by default, as fractions of its width.
  const u = (n: number) => n / 110;
  const bra = bottomRoundnessAdjustment;
  const path =
    `M ${x(0.5)} ${y(1)} ` +
    `C ${x(u(32) - bra)} ${y(0.69)} ${x(0)} ${y(0.6)} ${x(0)} ${y(0.25)} ` +
    `C ${x(0)} ${y(0.13)} ${x(u(13))} ${y(0)} ${x(0.25)} ${y(0)} ` +
    `C ${x(u(42))} ${y(0)} ${x(u(50))} ${y(0.07)} ${x(0.5)} ${y(0.17 + depthAdjustment)} ` +
    `C ${x(u(60))} ${y(0.07)} ${x(u(70))} ${y(0)} ${x(0.75)} ${y(0)} ` +
    `C ${x(u(97))} ${y(0)} ${x(1)} ${y(0.13)} ${x(1)} ${y(0.25)} ` +
    `C ${x(1)} ${y(0.6)} ${x(u(78) + bra)} ${y(0.69)} ${x(0.5)} ${y(1)} Z`;
  return result(path, w, h, `${w / 2} ${h / 2}`);
}

// ---- arrow ----

type Pair = [number, number];

/** The unit vector from `from` to `to` (the zero vector for equal points). */
function unitDirection(from: Pair, to: Pair): Pair {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.sqrt(dx * dx + dy * dy);
  return length === 0 ? [0, 0] : [dx / length, dy / length];
}

/** The closed outline through `points`, with the corners at `rounded` indices cut by `radius` and joined by a curve held at the corner. */
function arrowInstructions(points: Pair[], rounded: ReadonlySet<number>, radius: number): Instruction[] {
  const n = points.length;
  if (radius === 0) {
    return [
      { type: 'M', x: points[0]![0], y: points[0]![1] },
      ...points.slice(1).map(([x, y]): Instruction => ({ type: 'L', x, y })),
      { type: 'Z' },
    ];
  }
  // Corner 0 is always rounded, so the outline starts where it leaves that corner.
  const first = points[0]!;
  const leaving = unitDirection(first, points[1]!);
  const startX = first[0] + leaving[0] * radius;
  const startY = first[1] + leaving[1] * radius;
  const out: Instruction[] = [{ type: 'M', x: startX, y: startY }];
  const corner = ([x, y]: Pair, arriving: Pair, departing: Pair): Instruction[] => [
    { type: 'L', x: x - arriving[0] * radius, y: y - arriving[1] * radius },
    { type: 'C', cp1x: x, cp1y: y, cp2x: x, cp2y: y, x: x + departing[0] * radius, y: y + departing[1] * radius },
  ];
  for (let i = 1; i < n; i++) {
    const current = points[i]!;
    if (rounded.has(i)) {
      out.push(...corner(current, unitDirection(points[i - 1]!, current), unitDirection(current, points[(i + 1) % n]!)));
    } else {
      out.push({ type: 'L', x: current[0], y: current[1] });
    }
  }
  // Back to corner 0, which closes on the point the outline started from.
  const arriving = unitDirection(points[n - 1]!, first);
  out.push(
    { type: 'L', x: first[0] - arriving[0] * radius, y: first[1] - arriving[1] * radius },
    { type: 'C', cp1x: first[0], cp1y: first[1], cp2x: first[0], cp2y: first[1], x: startX, y: startY },
    { type: 'Z' },
  );
  return out;
}

export interface MakeArrowProps {
  /** The length along the direction the arrow points. Default 300. */
  length?: number;
  /** The width of the head at its widest. Default 185. */
  headWidth?: number;
  /** The length of the head. Default 120. */
  headLength?: number;
  /** The width of the shaft. Default 80. */
  shaftWidth?: number;
  /** Default `right`. */
  direction?: 'right' | 'left' | 'up' | 'down';
  /** Rounds the back corners and the three tips of the head. */
  cornerRadius?: number;
}

export function makeArrow({
  length = 300,
  headWidth = 185,
  headLength = 120,
  shaftWidth = 80,
  direction = 'right',
  cornerRadius = 0,
}: MakeArrowProps): ShapeInfo {
  if (length <= 0 || headWidth <= 0 || headLength <= 0 || shaftWidth <= 0) {
    throw new Error('All dimension parameters ("length", "headWidth", "headLength", "shaftWidth") must be positive numbers');
  }
  if (headWidth < shaftWidth) {
    throw new Error(`"headWidth" must be greater than or equal to "shaftWidth", got headWidth=${headWidth} and shaftWidth=${shaftWidth}`);
  }
  if (headLength > length) {
    throw new Error(`"headLength" must be less than or equal to "length", got headLength=${headLength} and length=${length}`);
  }
  const shaftTop = (headWidth - shaftWidth) / 2;
  const shaftBottom = shaftTop + shaftWidth;
  const shaftEnd = length - headLength;
  // Clockwise from the top left of the shaft, for an arrow that points right.
  const right: Pair[] = [
    [0, shaftTop],
    [shaftEnd, shaftTop],
    [shaftEnd, 0],
    [length, headWidth / 2],
    [shaftEnd, headWidth],
    [shaftEnd, shaftBottom],
    [0, shaftBottom],
  ];
  const horizontal = direction === 'right' || direction === 'left';
  let points: Pair[];
  if (direction === 'right') points = right;
  else if (direction === 'left') points = right.map(([x, y]): Pair => [length - x, y]);
  else if (direction === 'down') {
    points = [
      [shaftTop, 0],
      [shaftBottom, 0],
      [shaftBottom, shaftEnd],
      [headWidth, shaftEnd],
      [headWidth / 2, length],
      [0, shaftEnd],
      [shaftTop, shaftEnd],
    ];
  } else {
    points = [
      [shaftTop, length],
      [shaftBottom, length],
      [shaftBottom, headLength],
      [headWidth, headLength],
      [headWidth / 2, 0],
      [0, headLength],
      [shaftTop, headLength],
    ];
  }
  const width = horizontal ? length : headWidth;
  const height = horizontal ? headWidth : length;
  // The back corners and the three tips of the head are rounded; the inner corners where shaft meets head stay sharp.
  const rounded = new Set(horizontal ? [0, 2, 3, 4, 6] : [0, 1, 3, 4, 5]);
  const instructions = arrowInstructions(points, rounded, cornerRadius);
  return { path: serializeInstructions(instructions), instructions, width, height, transformOrigin: `${width / 2} ${height / 2}` };
}

// ---- callout ----

export interface MakeCalloutProps {
  /** The body's width. Default 500. */
  width?: number;
  /** The body's height. Default 200. */
  height?: number;
  /** How far the pointer sticks out. Default 40. */
  pointerLength?: number;
  /** The width of the pointer where it meets the body. Default 60. */
  pointerBaseWidth?: number;
  /** Where the pointer sits along its side, 0 to 1. Default 0.5. */
  pointerPosition?: number;
  /** Default `down`. */
  pointerDirection?: 'up' | 'down' | 'left' | 'right';
  edgeRoundness?: number | null;
  cornerRadius?: number;
}

/** A corner of the callout's outline, and whether `cornerRadius` rounds it (the pointer's corners stay sharp). */
interface OutlinePoint {
  point: Pair;
  round: boolean;
}

const samePoint = (a: Pair, b: Pair): boolean => a[0] === b[0] && a[1] === b[1];

/** The outline with repeated points merged (rounded only if both were) and closed on its first point. */
function closedOutline(points: OutlinePoint[]): OutlinePoint[] {
  const merged: OutlinePoint[] = [];
  for (const entry of points) {
    const previous = merged[merged.length - 1];
    if (previous && samePoint(previous.point, entry.point)) {
      merged[merged.length - 1] = { point: previous.point, round: previous.round && entry.round };
    } else {
      merged.push(entry);
    }
  }
  const first = merged[0]!;
  const last = merged[merged.length - 1]!;
  if (samePoint(first.point, last.point)) {
    const closing = { point: first.point, round: first.round && last.round };
    return [closing, ...merged.slice(1, -1), closing];
  }
  return [...merged, first];
}

/** `vector` shortened by `radius`. */
function shorten([x, y]: Pair, radius: number): Pair {
  const length = Math.sqrt(x * x + y * y);
  const factor = (length - radius) / length;
  return [x * factor, y * factor];
}

/** `vector` scaled to `length`. */
function scaleTo([x, y]: Pair, length: number): Pair {
  const factor = length / Math.sqrt(x * x + y * y);
  return [x * factor, y * factor];
}

/**
 * The path through a closed run of points (the first and last are the same) with straight edges, edges bent by
 * `edgeRoundness` (curves through the edge midpoints), or corners rounded by an arc of `cornerRadius`.
 */
function joinPoints(points: Pair[], edgeRoundness: number | null, cornerRadius: number): Instruction[] {
  return points.flatMap(([x, y], i): Instruction[] => {
    const previous = points[i === 0 ? points.length - 2 : i - 1]!;
    const next = points[i === points.length - 1 ? 1 : i + 1]!;
    const nextVector: Pair = [next[0] - x, next[1] - y];
    if (i === 0) {
      if (edgeRoundness !== null) return [{ type: 'M', x: (x + next[0]) / 2, y: (y + next[1]) / 2 }];
      if (cornerRadius !== 0) {
        const start = shorten(nextVector, cornerRadius);
        return [{ type: 'M', x: start[0] + x, y: start[1] + y }];
      }
      return [{ type: 'M', x, y }];
    }
    if (cornerRadius && edgeRoundness !== null) {
      throw new Error('"cornerRadius" and "edgeRoundness" cannot be specified at the same time.');
    }
    const previousVector: Pair = [x - previous[0], y - previous[1]];
    if (edgeRoundness === null) {
      if (cornerRadius === 0) return [{ type: 'L', x, y }];
      const along = scaleTo(previousVector, cornerRadius);
      const shortened = shorten(previousVector, cornerRadius);
      const out = scaleTo(nextVector, cornerRadius);
      return [
        { type: 'L', x: previous[0] + shortened[0], y: previous[1] + shortened[1] },
        {
          type: 'a',
          rx: cornerRadius,
          ry: cornerRadius,
          xAxisRotation: 0,
          dx: along[0] + out[0],
          dy: along[1] + out[1],
          largeArcFlag: false,
          sweepFlag: true,
        },
      ];
    }
    const from: Pair = [(x + previous[0]) / 2, (y + previous[1]) / 2];
    const to: Pair = [(x + next[0]) / 2, (y + next[1]) / 2];
    return [
      {
        type: 'C',
        cp1x: from[0] + previousVector[0] * edgeRoundness * 0.5,
        cp1y: from[1] + previousVector[1] * edgeRoundness * 0.5,
        cp2x: to[0] - nextVector[0] * edgeRoundness * 0.5,
        cp2y: to[1] - nextVector[1] * edgeRoundness * 0.5,
        x: to[0],
        y: to[1],
      },
    ];
  });
}

/** The callout's outline with its corners rounded by arcs: each rounded corner is cut `cornerRadius` short on both edges. */
function calloutArcs(points: OutlinePoint[], cornerRadius: number): Instruction[] {
  const unique = samePoint(points[0]!.point, points[points.length - 1]!.point) ? points.slice(0, -1) : points;
  const first = unique[0]!;
  const startDirection = first.round ? unitDirection(first.point, unique[1]!.point) : null;
  const start: Pair = startDirection
    ? [first.point[0] + startDirection[0] * cornerRadius, first.point[1] + startDirection[1] * cornerRadius]
    : first.point;
  const out: Instruction[] = [{ type: 'M', x: start[0], y: start[1] }];
  const arc = (point: Pair, incoming: Pair, outgoing: Pair): Instruction[] => [
    { type: 'L', x: point[0] - incoming[0] * cornerRadius, y: point[1] - incoming[1] * cornerRadius },
    {
      type: 'a',
      rx: cornerRadius,
      ry: cornerRadius,
      xAxisRotation: 0,
      dx: incoming[0] * cornerRadius + outgoing[0] * cornerRadius,
      dy: incoming[1] * cornerRadius + outgoing[1] * cornerRadius,
      largeArcFlag: false,
      sweepFlag: true,
    },
  ];
  for (let i = 1; i < unique.length; i++) {
    const current = unique[i]!;
    if (!current.round) {
      out.push({ type: 'L', x: current.point[0], y: current.point[1] });
      continue;
    }
    out.push(...arc(current.point, unitDirection(unique[i - 1]!.point, current.point), unitDirection(current.point, unique[(i + 1) % unique.length]!.point)));
  }
  if (first.round) {
    out.push(...arc(first.point, unitDirection(unique[unique.length - 1]!.point, first.point), startDirection!));
  }
  out.push({ type: 'Z' });
  return out;
}

function positiveNumber(name: string, value: unknown): void {
  if (typeof value !== 'number' || value <= 0) throw new Error(`"${name}" must be a positive number, got ${String(value)}`);
}

export function makeCallout({
  width = 500,
  height = 200,
  pointerLength = 40,
  pointerBaseWidth = 60,
  pointerPosition = 0.5,
  pointerDirection = 'down',
  edgeRoundness = null,
  cornerRadius = 0,
}: MakeCalloutProps): ShapeInfo {
  positiveNumber('width', width);
  positiveNumber('height', height);
  positiveNumber('pointerLength', pointerLength);
  positiveNumber('pointerBaseWidth', pointerBaseWidth);
  if (typeof pointerPosition !== 'number' || pointerPosition < 0 || pointerPosition > 1) {
    throw new Error(`"pointerPosition" must be a number between 0 and 1, got ${pointerPosition}`);
  }
  // Where the pointer's base sits along a side of `available` length: centred on `pointerPosition`, kept on the side.
  const base = (available: number) => {
    const center = available * pointerPosition;
    return { center, start: Math.max(0, center - pointerBaseWidth / 2), end: Math.min(available, center + pointerBaseWidth / 2) };
  };
  const along = base(width);
  const beside = base(height);
  const round = (x: number, y: number): OutlinePoint => ({ point: [x, y], round: true });
  const sharp = (x: number, y: number): OutlinePoint => ({ point: [x, y], round: false });
  const outlines = {
    up: [
      round(0, pointerLength),
      sharp(along.start, pointerLength),
      sharp(along.center, 0),
      sharp(along.end, pointerLength),
      round(width, pointerLength),
      round(width, height + pointerLength),
      round(0, height + pointerLength),
      round(0, pointerLength),
    ],
    down: [
      round(0, 0),
      round(width, 0),
      round(width, height),
      sharp(along.end, height),
      sharp(along.center, height + pointerLength),
      sharp(along.start, height),
      round(0, height),
      round(0, 0),
    ],
    left: [
      round(pointerLength, 0),
      round(width + pointerLength, 0),
      round(width + pointerLength, height),
      round(pointerLength, height),
      sharp(pointerLength, beside.end),
      sharp(0, beside.center),
      sharp(pointerLength, beside.start),
      round(pointerLength, 0),
    ],
    right: [
      round(0, 0),
      round(width, 0),
      sharp(width, beside.start),
      sharp(width + pointerLength, beside.center),
      sharp(width, beside.end),
      round(width, height),
      round(0, height),
      round(0, 0),
    ],
  };
  const points = closedOutline(outlines[pointerDirection]);
  const instructions: Instruction[] =
    edgeRoundness !== null || cornerRadius === 0
      ? [...joinPoints(points.map((entry) => entry.point), edgeRoundness, cornerRadius), { type: 'Z' }]
      : calloutArcs(points, cornerRadius);
  const horizontal = pointerDirection === 'left' || pointerDirection === 'right';
  const vertical = pointerDirection === 'up' || pointerDirection === 'down';
  const bodyX = pointerDirection === 'left' ? pointerLength : 0;
  const bodyY = pointerDirection === 'up' ? pointerLength : 0;
  return {
    width: horizontal ? width + pointerLength : width,
    height: vertical ? height + pointerLength : height,
    instructions,
    path: serializeInstructions(instructions),
    transformOrigin: `${bodyX + width / 2} ${bodyY + height / 2}`,
  };
}

// ---- spark ----

export interface MakeSparkProps {
  width: number;
  height: number;
  /** How far the four edges curve in between the points. Default 1. */
  edgeRoundness?: number;
  /** Rounds the four points. Default 0. */
  cornerRadius?: number;
}

/** The control-point offset of a quarter circle's cubic approximation. */
const KAPPA = 0.5522847498307936;
/** How far a rounded point's cap reaches, in radii, to draw its half circle with one cubic. */
const CAP_HANDLE = 4 / 3;

function cubic(cp1: Pair, cp2: Pair, to: Pair): Instruction {
  return { type: 'C', cp1x: cp1[0], cp1y: cp1[1], cp2x: cp2[0], cp2y: cp2[1], x: to[0], y: to[1] };
}

/** The half circle that rounds a point of the spark, bulging out towards `direction`. */
function sparkCap(from: Pair, to: Pair, radius: number, direction: 'top' | 'right' | 'bottom' | 'left'): Instruction {
  const reach = radius * CAP_HANDLE;
  const [dx, dy] = { top: [0, -reach], right: [reach, 0], bottom: [0, reach], left: [-reach, 0] }[direction];
  return cubic([from[0] + dx, from[1] + dy], [to[0] + dx, to[1] + dy], to);
}

/** The edge between two points of the spark, curving in. */
function sparkEdge(from: Pair, to: Pair, edgeRoundness: number, direction: 'top-right' | 'right-bottom' | 'bottom-left' | 'left-top'): Instruction {
  const handleX = Math.abs(to[0] - from[0]) * KAPPA * edgeRoundness;
  const handleY = Math.abs(to[1] - from[1]) * KAPPA * edgeRoundness;
  switch (direction) {
    case 'top-right':
      return cubic([from[0], from[1] + handleY], [to[0] - handleX, to[1]], to);
    case 'right-bottom':
      return cubic([from[0] - handleX, from[1]], [to[0], to[1] - handleY], to);
    case 'bottom-left':
      return cubic([from[0], from[1] - handleY], [to[0] + handleX, to[1]], to);
    case 'left-top':
      return cubic([from[0] + handleX, from[1]], [to[0], to[1] + handleY], to);
  }
}

export function makeSpark({ width, height, edgeRoundness = 1, cornerRadius = 0 }: MakeSparkProps): ShapeInfo {
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(Math.max(cornerRadius, 0), width / 2, height / 2);
  const top: Pair = [centerX, 0];
  const right: Pair = [width, centerY];
  const bottom: Pair = [centerX, height];
  const left: Pair = [0, centerY];
  // With a radius each point is two: where its two edges meet the cap that rounds it.
  const at = (point: Pair, rounded: Pair): Pair => (radius === 0 ? point : rounded);
  const topRight = at(top, [centerX + radius, radius]);
  const rightTop = at(right, [width - radius, centerY - radius]);
  const rightBottom = at(right, [width - radius, centerY + radius]);
  const bottomRight = at(bottom, [centerX + radius, height - radius]);
  const bottomLeft = at(bottom, [centerX - radius, height - radius]);
  const leftBottom = at(left, [radius, centerY + radius]);
  const leftTop = at(left, [radius, centerY - radius]);
  const topLeft = at(top, [centerX - radius, radius]);
  const caps = radius > 0;
  const instructions: Instruction[] = [
    { type: 'M', x: topRight[0], y: topRight[1] },
    sparkEdge(topRight, rightTop, edgeRoundness, 'top-right'),
    ...(caps ? [sparkCap(rightTop, rightBottom, radius, 'right')] : []),
    sparkEdge(rightBottom, bottomRight, edgeRoundness, 'right-bottom'),
    ...(caps ? [sparkCap(bottomRight, bottomLeft, radius, 'bottom')] : []),
    sparkEdge(bottomLeft, leftBottom, edgeRoundness, 'bottom-left'),
    ...(caps ? [sparkCap(leftBottom, leftTop, radius, 'left')] : []),
    sparkEdge(leftTop, topLeft, edgeRoundness, 'left-top'),
    ...(caps ? [sparkCap(topLeft, topRight, radius, 'top')] : []),
    { type: 'Z' },
  ];
  return { path: serializeInstructions(instructions), width, height, transformOrigin: `${centerX} ${centerY}`, instructions };
}

// ---- components ----

type SvgPaintProps = {
  fill?: Paint;
  /** A colour string as in SVG (with `strokeWidth`), or the engine's `{ color, width }`. */
  stroke?: Stroke | string;
  strokeWidth?: number;
};

type ShapeComponentProps<O> = O & SvgPaintProps & Omit<CommonProps, 'id'> & { id?: string };

function strokeOf(stroke: Stroke | string | undefined, strokeWidth: number | undefined): Stroke | undefined {
  if (stroke === undefined) return undefined;
  if (typeof stroke === 'string') return { color: stroke, width: strokeWidth ?? 1 };
  return stroke;
}

function draw(info: ShapeInfo, props: SvgPaintProps & CommonProps): ReactNode {
  const { fill, stroke, strokeWidth, ...common } = props;
  return <Path {...common} d={info.path} fill={fill} stroke={strokeOf(stroke, strokeWidth)} />;
}

export function Rect(props: ShapeComponentProps<MakeRectOptions>): ReactNode {
  const { width, height, cornerRadius, edgeRoundness, ...paint } = props;
  return draw(makeRect({ width, height, cornerRadius, edgeRoundness }), paint);
}
export function Circle(props: ShapeComponentProps<{ radius: number }>): ReactNode {
  const { radius, ...paint } = props;
  return draw(makeCircle({ radius }), paint);
}
export function Ellipse(props: ShapeComponentProps<{ rx: number; ry: number }>): ReactNode {
  const { rx, ry, ...paint } = props;
  return draw(makeEllipse({ rx, ry }), paint);
}
export function Triangle(props: ShapeComponentProps<MakeTriangleOptions>): ReactNode {
  const { length, direction, cornerRadius, edgeRoundness, ...paint } = props;
  return draw(makeTriangle({ length, direction, cornerRadius, edgeRoundness }), paint);
}
export function Star(props: ShapeComponentProps<MakeStarOptions>): ReactNode {
  const { points, innerRadius, outerRadius, cornerRadius, edgeRoundness, ...paint } = props;
  return draw(makeStar({ points, innerRadius, outerRadius, cornerRadius, edgeRoundness }), paint);
}
export function Polygon(props: ShapeComponentProps<MakePolygonOptions>): ReactNode {
  const { points, radius, cornerRadius, edgeRoundness, ...paint } = props;
  return draw(makePolygon({ points, radius, cornerRadius, edgeRoundness }), paint);
}
export function Pie(props: ShapeComponentProps<MakePieOptions>): ReactNode {
  const { radius, progress, closePath, counterClockwise, rotation, ...paint } = props;
  return draw(makePie({ radius, progress, closePath, counterClockwise, rotation }), paint);
}
export function Heart(props: ShapeComponentProps<MakeHeartOptions>): ReactNode {
  const { height, aspectRatio, bottomRoundnessAdjustment, depthAdjustment, ...paint } = props;
  return draw(makeHeart({ height, aspectRatio, bottomRoundnessAdjustment, depthAdjustment }), paint);
}
export function Arrow(props: ShapeComponentProps<MakeArrowProps>): ReactNode {
  const { length, headWidth, headLength, shaftWidth, direction, cornerRadius, ...paint } = props;
  return draw(makeArrow({ length, headWidth, headLength, shaftWidth, direction, cornerRadius }), paint);
}
export function Callout(props: ShapeComponentProps<MakeCalloutProps>): ReactNode {
  const { width, height, pointerLength, pointerBaseWidth, pointerPosition, pointerDirection, edgeRoundness, cornerRadius, ...paint } = props;
  return draw(makeCallout({ width, height, pointerLength, pointerBaseWidth, pointerPosition, pointerDirection, edgeRoundness, cornerRadius }), paint);
}
export function Spark(props: ShapeComponentProps<MakeSparkProps>): ReactNode {
  const { width, height, edgeRoundness, cornerRadius, ...paint } = props;
  return draw(makeSpark({ width, height, edgeRoundness, cornerRadius }), paint);
}
