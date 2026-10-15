// `@remotion/media-utils` (docs/AUTHORING.md §11.3): `getVideoMetadata`, read
// from the file's header by the addon's `probeMedia`. Nothing is decoded.
//
// The addon is found the way `layout-utils` finds `layoutText`: the host hands it over with `setMediaProbe`, and
// failing that it is looked up when first needed (a project that never probes a file does not need the addon).

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { MediaInfo } from '@kinetograph/native';

export type ProbeMedia = (path: string, baseDir?: string) => MediaInfo;

export interface VideoMetadata {
  durationInSeconds: number;
  width: number;
  height: number;
  aspectRatio: number;
  isRemote: false;
  /** Not in Remotion's: the stream's average frame rate. */
  fps: number | null;
}

let probeOverride: ProbeMedia | null = null;
let probeNative: ProbeMedia | null = null;

/** Sets the addon's `probeMedia` (the host does, as with `setLayoutText`; tests pass a stub, `null` goes back). */
export function setMediaProbe(fn: ProbeMedia | null): void {
  probeOverride = fn;
  cached.clear();
}

// Answers kept for callers that ask every frame (a GIF's duration walks all its pictures); a new probe empties it.
const cached = new Map<string, MediaInfo>();

/**
 * The addon's `probeMedia`, found when first needed: from here, then from the working directory. A bundle in a
 * project's cache may sit where neither reaches it; the host then calls `setMediaProbe(native.probeMedia)`.
 */
function loadNative(): ProbeMedia {
  const failures: string[] = [];
  for (const base of [import.meta.url, pathToFileURL(`${process.cwd()}/`).href]) {
    try {
      return (createRequire(base)('@kinetograph/native') as { probeMedia: ProbeMedia }).probeMedia;
    } catch (error) {
      failures.push(error instanceof Error ? error.message.split('\n')[0]! : String(error));
    }
  }
  throw new Error(
    `Media cannot be probed: @kinetograph/native could not be loaded (${failures.join('; ')}). ` +
      'Build the addon, or pass its probeMedia to setMediaProbe() from @kinetograph/core/media-utils.',
  );
}

/** What the addon reads from the header of the video or GIF at `src`; with `cache`, read once per `src`. */
export function probeMedia(src: string, options: { cache?: boolean } = {}): MediaInfo {
  if (options.cache) {
    let info = cached.get(src);
    if (info === undefined) {
      info = probeMedia(src);
      cached.set(src, info);
    }
    return info;
  }
  if (typeof src !== 'string' || src === '') throw new TypeError(`src must be a file path, but got ${JSON.stringify(src)}`);
  if (/^https?:\/\//i.test(src)) {
    throw new Error(`Cannot read ${src}: remote files are not supported, download it and use staticFile() instead`);
  }
  if (probeOverride) return probeOverride(src);
  probeNative ??= loadNative();
  return probeNative(src);
}

/** The duration, size and frame rate of a local video, read from its header. */
export async function getVideoMetadata(src: string): Promise<VideoMetadata> {
  const info = probeMedia(src);
  return {
    durationInSeconds: info.durationInSeconds,
    width: info.width,
    height: info.height,
    aspectRatio: info.width / info.height,
    isRemote: false,
    fps: info.fps ?? null,
  };
}
