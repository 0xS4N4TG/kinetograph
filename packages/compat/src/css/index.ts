// `@kinetograph/compat/css` (docs/COMPAT.md §3): inline style values parsed
// into typed values, and a `Diagnostic` for anything that cannot be. Stream 1.

import type {
  BackgroundImage,
  BoxShadow,
  ClipShape,
  FilterOp,
  Length,
  ParsedStyle,
  Rgba,
  TransformOp,
} from './types.js';

export type * from './types.js';

export interface Diagnostic {
  property: string;
  value: string;
  reason: string;
}

export interface LengthContext {
  /** What a percentage is of, px. */
  percentOf: number;
  fontSize: number;
  rootFontSize: number;
  viewport: { width: number; height: number };
}

const todo = (name: string): never => {
  throw new Error(`not implemented: ${name} (docs/COMPAT.md §3)`);
};

export function parseStyle(_style: Record<string, unknown>): { style: ParsedStyle; unsupported: Diagnostic[] } {
  return todo('parseStyle');
}
export function parseColor(_value: string): Rgba | null {
  return todo('parseColor');
}
export function parseLength(_value: unknown): Length | null {
  return todo('parseLength');
}
export function parseTransform(_value: string): TransformOp[] | Diagnostic {
  return todo('parseTransform');
}
export function parseBoxShadow(_value: string): BoxShadow[] | Diagnostic {
  return todo('parseBoxShadow');
}
export function parseFilter(_value: string): FilterOp[] | Diagnostic {
  return todo('parseFilter');
}
export function parseClipPath(_value: string): ClipShape | Diagnostic {
  return todo('parseClipPath');
}
export function parseBackgroundImage(_value: string): BackgroundImage[] | Diagnostic {
  return todo('parseBackgroundImage');
}
export function resolveLength(_length: Length, _context: LengthContext): number {
  return todo('resolveLength');
}
