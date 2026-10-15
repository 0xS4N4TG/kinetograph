// `@remotion/shapes`: `make*` functions that return a path and its size, and
// components that draw it with `<Path>`. Written from the documented parameters
// and checked against values recorded from the published package
// (test/fixtures/shapes.json) for the plain shapes. The rounded variants
// (`cornerRadius`, `edgeRoundness`) are built the same way, as straight edges
// joined by curves whose control points sit on the corner; their exact numbers
// differ from the published package for polygons and stars, which shift the
// rounded outline by a fraction of a unit.

import type { ReactNode } from 'react';
import { Path, type CommonProps } from '@kinetograph/react';
import type { Paint, Stroke } from '@kinetograph/scene';
import { getBoundingBox, parsePath, translatePath, type Instruction } from './paths.js';

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
