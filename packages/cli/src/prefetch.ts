// The step before frame 0 of `render`, `still`, `studio`, `doctor` and the other commands that open a project: what the
// project loads from the web is downloaded into the caches and pinned in `kinetograph.lock.json`, so the frames are
// drawn from disk. `--offline` (or `KINETOGRAPH_OFFLINE=1`, which render workers inherit) skips it: a file that is
// missing is then the error it was before this step existed.

import { statSync } from 'node:fs';
import { isHyperframesEntry } from './hyperframes/entry.js';
import { autoPrefetchHyperframes } from './hyperframes/prefetch.js';

export interface PrefetchEntryOptions {
  offline?: boolean;
  progress?: (message: string) => void;
}

/** Whether downloads are off for this process. */
export const isOffline = (offline?: boolean): boolean => offline === true || process.env.KINETOGRAPH_OFFLINE === '1';

/** Sets the process to offline (and its workers, which copy the environment). */
export function setOffline(offline: boolean): void {
  if (offline) process.env.KINETOGRAPH_OFFLINE = '1';
}

// The studio opens a project again for each preview: the step runs once for each version of the entry file.
const done = new Map<string, number>();

/** What a HyperFrames entry needs before it is read; a no-op for any other entry or when offline. */
export async function prefetchBeforePlan(entry: string, options: PrefetchEntryOptions = {}): Promise<void> {
  if (isOffline(options.offline) || !isHyperframesEntry(entry)) return;
  const version = statSync(entry).mtimeMs;
  if (done.get(entry) === version) return;
  await autoPrefetchHyperframes(entry, options.progress ?? (() => {}));
  done.set(entry, version);
}
