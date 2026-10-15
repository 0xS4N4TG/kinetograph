import { createRequire } from 'node:module';
import type * as NativeApi from '@kinetograph/native';
import { CliError } from './errors.js';

export type Native = typeof NativeApi;

let loaded: Native | undefined;

/**
 * The addon, loaded on first use so that commands that never render (`effects`, `doctor`, argument errors) work where
 * the addon's binary is missing. A CommonJS package, so it is loaded with `require`.
 */
export function native(): Native {
  if (loaded) return loaded;
  try {
    loaded = createRequire(import.meta.url)('@kinetograph/native') as Native;
  } catch (error) {
    throw new CliError(
      'NATIVE_UNAVAILABLE',
      `cannot load @kinetograph/native: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return loaded;
}

/** Tests put a stand-in addon here. */
export function setNativeForTests(stub: Native | undefined): void {
  loaded = stub;
}

// ---- InspectResult (docs/AUTHORING.md §3), which the addon returns as JSON text ----

export interface InspectLayer {
  id: string;
  type: string;
  opacity: number;
  blendMode: string;
  transform: {
    x: number; y: number; scale: number; rotation: number; anchorX: number; anchorY: number;
    rotateX: number; rotateY: number; z: number;
  };
  matrix: [number, number, number, number, number, number];
  box: { x: number; y: number; width: number; height: number } | null;
  bounds: { x: number; y: number; width: number; height: number } | null;
  effects: string[];
  clip: string | null;
  clipBounds: { x: number; y: number; width: number; height: number } | null;
  mask: boolean;
  matte: { layer: string; mode: string } | null;
  matteSource: boolean;
  motionBlur: { samples: number; shutter: number } | null;
  text?: {
    text: string; font: string; size: number; width: number; height: number; maxWidth: number | null;
    lines: { text: string; top: number; bottom: number; baseline: number }[];
  };
  src?: string;
  children?: InspectLayer[];
}

export interface InspectResult {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  frame: number;
  margin: number;
  camera: { perspective: number; x: number; y: number } | null;
  layers: InspectLayer[];
}
