// What `parseMedia` reads a file with: the addon's `probeStreams` (the container's header, through FFmpeg) and
// `scanStreams` (every packet, for the "slow" fields), and `decodeAudio` for what `@remotion/webcodecs` makes of a
// track's sound. Found the way `media-utils` finds `probeMedia`: the host hands them over with `setMediaParserAddon`,
// and failing that they are looked up when first needed.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { AudioPcm, MediaStreams, StreamScan } from '@kinetograph/native';

export interface MediaParserAddon {
  probeStreams(path: string, baseDir?: string | null): MediaStreams;
  scanStreams(path: string, baseDir?: string | null): StreamScan[];
  decodeAudio(path: string, sampleRate: number, baseDir?: string | null): AudioPcm | null;
}

let override: MediaParserAddon | null = null;
let found: MediaParserAddon | null = null;

/** Sets the addon (the host does, as with `setMediaProbe`; tests pass a stub, `null` goes back). */
export function setMediaParserAddon(addon: MediaParserAddon | null): void {
  override = addon;
}

function load(): MediaParserAddon {
  const failures: string[] = [];
  for (const base of [import.meta.url, pathToFileURL(`${process.cwd()}/`).href]) {
    try {
      return createRequire(base)('@kinetograph/native') as MediaParserAddon;
    } catch (error) {
      failures.push(error instanceof Error ? error.message.split('\n')[0]! : String(error));
    }
  }
  throw new Error(
    `Media cannot be parsed: @kinetograph/native could not be loaded (${failures.join('; ')}). ` +
      'Build the addon, or pass it to setMediaParserAddon() from @kinetograph/core/media-parser.',
  );
}

export function mediaParserAddon(): MediaParserAddon {
  if (override) return override;
  found ??= load();
  return found;
}
