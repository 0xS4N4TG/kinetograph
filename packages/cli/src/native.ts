import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type * as NativeApi from '@kinetographdev/native';
import type { SourceLocation } from '@kinetographdev/scene';
import { CliError } from './errors.js';

export type Native = typeof NativeApi;

/** The platform packages that carry the addon and `bin/ffmpeg`, by `process.platform-process.arch`. */
const PLATFORM_PACKAGES: Record<string, string> = {
  'darwin-arm64': 'darwin-arm64',
  'linux-x64': 'linux-x64-gnu',
  'win32-x64': 'win32-x64-msvc',
};

/**
 * The GPL `ffmpeg` program the platform package ships (`bin/ffmpeg`, `bin/ffmpeg.exe`), if this install has one. The
 * addon runs it for the encoders its own LGPL ffmpeg lacks (libx264, libx265); it is never linked.
 */
export function bundledFfmpeg(): string | undefined {
  const name = PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];
  if (!name) return undefined;
  try {
    const require = createRequire(import.meta.url);
    // The platform package is an optional dependency of the addon's package, so it is looked up from there.
    const nativeDir = path.dirname(require.resolve('@kinetographdev/native/package.json'));
    const pkg = createRequire(path.join(nativeDir, 'package.json')).resolve(`@kinetographdev/native-${name}/package.json`);
    const binary = path.join(path.dirname(pkg), 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    return existsSync(binary) ? binary : undefined;
  } catch {
    return undefined;
  }
}

let loaded: Native | undefined;

/**
 * The addon, loaded on first use so that commands that never render (`effects`, `doctor`, argument errors) work where
 * the addon's binary is missing. A CommonJS package, so it is loaded with `require`.
 */
export function native(): Native {
  if (loaded) return loaded;
  try {
    loaded = createRequire(import.meta.url)('@kinetographdev/native') as Native;
    loaded.setFfmpegPath?.(bundledFfmpeg() ?? null);
  } catch (error) {
    throw new CliError(
      'NATIVE_UNAVAILABLE',
      `cannot load @kinetographdev/native: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return loaded;
}

/** Tests put a stand-in addon here. */
export function setNativeForTests(stub: Native | undefined): void {
  loaded = stub;
}

// ---- InspectResult (packages/cli/skills/kinetograph/references/AUTHORING.md §3), which the addon returns as JSON text ----

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
  /** video, gif: the source time in seconds at the inspected frame (AUTHORING.md §11.1). */
  media?: { time: number };
  children?: InspectLayer[];
  /** The studio adds these (never the addon): what a person calls the layer, the component that drew it, the JSX that made it. */
  label?: string;
  component?: string;
  source?: SourceLocation;
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
